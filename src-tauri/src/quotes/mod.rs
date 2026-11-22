//! Optional, read-only delayed public market quote adapter.
//!
//! Security boundaries:
//! - Disabled by default; invoked only on explicit user opt-in / manual refresh.
//! - Strict HTTPS host allowlist (`stooq.com`, `query1.finance.yahoo.com`),
//!   with explicit custom ports rejected (`url.port().is_none()`) and redirects
//!   disabled so responses cannot escape the allowlist.
//! - Zero credentials, zero cookies, zero Authorization headers, zero account IDs.
//! - Strict ticker validation (`^[A-Z0-9][A-Z0-9.-]{0,9}$`, max 50 symbols per batch).
//! - Hard 512 KiB HTTP response body cap (streamed) to prevent OOM DoS.
//! - Bounded concurrency (4 concurrent requests) with per-request and total batch timeout.
//! - Exact `i128` fixed-point arithmetic (10^8 scale); zero `f32`/`f64` math.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::Arc,
    time::Duration,
};

use chrono::{
    Datelike, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, TimeDelta, Utc, Weekday,
};
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use thiserror::Error;
use tokio::{sync::Semaphore, task::JoinSet, time::timeout};

use crate::storage::{BenchmarkPricePoint, CachedPublicQuote, StoredBenchmarkSeries};

pub const ALLOWED_QUOTE_HOSTS: &[&str] = &["stooq.com", "query1.finance.yahoo.com"];
/// Strictly allowlisted read-only benchmark symbols and their isolated currency buckets.
pub const ALLOWED_BENCHMARK_SYMBOLS: &[(&str, &str)] = &[
    ("SPY", "USD"),
    ("QQQ", "USD"),
    ("2800.HK", "HKD"),
    ("510300.SS", "CNY"),
];
pub const MAX_BENCHMARK_POINTS: usize = 420;
pub const MAX_QUOTE_SYMBOLS: usize = 50;
pub const QUOTE_TIMEOUT_SECS: u64 = 7;
pub const BATCH_QUOTE_TIMEOUT_SECS: u64 = 20;
pub const MAX_QUOTE_RESPONSE_BYTES: usize = 512 * 1024;
pub const MAX_CONCURRENT_QUOTE_REQUESTS: usize = 4;

const FIXED_SCALE: u32 = 8;
const FIXED_FACTOR: i128 = 100_000_000;

const KNOWN_EXCHANGE_SUFFIXES: &[&str] = &[
    ".HK", ".SS", ".SZ", ".SI", ".T", ".L", ".TO", ".V", ".AX", ".DE", ".PA", ".SW", ".AS", ".MI",
    ".MC", ".BR", ".CO", ".ST", ".HE", ".OL", ".TW", ".TWO", ".KS", ".KQ", ".BO", ".NS", ".NZ",
    ".SA", ".MX", ".JK", ".BK", ".KL", ".TA", ".JO",
];

fn split_exchange_suffix(symbol: &str) -> Option<(&str, &str)> {
    let dot_idx = symbol.rfind('.')?;
    let suffix = &symbol[dot_idx..];
    if KNOWN_EXCHANGE_SUFFIXES.contains(&suffix) && dot_idx > 0 {
        Some((&symbol[..dot_idx], suffix))
    } else {
        None
    }
}

pub fn infer_currency_from_symbol(symbol: &str) -> &'static str {
    match split_exchange_suffix(symbol).map(|(_, suffix)| suffix) {
        Some(".HK") => "HKD",
        Some(".SS" | ".SZ") => "CNY",
        Some(".SI") => "SGD",
        Some(".T") => "JPY",
        Some(".L") => "GBP",
        Some(".TO" | ".V") => "CAD",
        Some(".AX") => "AUD",
        Some(".DE" | ".PA" | ".AS" | ".MI" | ".MC" | ".BR" | ".HE") => "EUR",
        Some(".SW") => "CHF",
        Some(".CO") => "DKK",
        Some(".ST") => "SEK",
        Some(".OL") => "NOK",
        Some(".TW" | ".TWO") => "TWD",
        Some(".KS" | ".KQ") => "KRW",
        Some(".BO" | ".NS") => "INR",
        Some(".NZ") => "NZD",
        Some(".SA") => "BRL",
        Some(".MX") => "MXN",
        Some(".JK") => "IDR",
        Some(".BK") => "THB",
        Some(".KL") => "MYR",
        Some(".TA") => "ILS",
        Some(".JO") => "ZAR",
        _ => "USD",
    }
}

/// Maps a normalized FolioHelm ticker to a Yahoo Finance chart symbol.
/// Preserves exchange suffixes (`.HK`, `.SS`, `.SZ`, `.SI`, etc.) and only converts
/// US share-class dots (e.g. `BRK.B` -> `BRK-B`). 5-digit leading-zero HK tickers
/// (e.g. `00700.HK`) are normalized to Yahoo's 4-digit HK convention (`0700.HK`).
pub fn map_yahoo_symbol(symbol: &str) -> String {
    if let Some((code, suffix)) = split_exchange_suffix(symbol) {
        let yahoo_code = if suffix == ".HK" && code.bytes().all(|b| b.is_ascii_digit()) {
            let stripped = code.trim_start_matches('0');
            if stripped.is_empty() {
                "0000".to_string()
            } else if stripped.len() >= 4 {
                stripped.to_string()
            } else {
                format!("{stripped:0>4}")
            }
        } else {
            code.replace('.', "-")
        };
        format!("{yahoo_code}{suffix}")
    } else {
        symbol.replace('.', "-")
    }
}

/// Maps a normalized FolioHelm ticker to a Stooq ticker and its native market currency.
pub fn map_stooq_symbol(symbol: &str) -> (String, &'static str) {
    let currency = infer_currency_from_symbol(symbol);
    if let Some((code, suffix)) = split_exchange_suffix(symbol) {
        let code_lower = code.to_ascii_lowercase().replace('.', "-");
        let stooq_ticker = match suffix {
            ".HK" => {
                let trimmed = code_lower.trim_start_matches('0');
                let hk_code = if trimmed.is_empty() { "0" } else { trimmed };
                format!("{hk_code}.hk")
            }
            ".SS" => format!("{code_lower}.ss"),
            ".SZ" => format!("{code_lower}.sz"),
            ".SI" => format!("{code_lower}.si"),
            ".T" => format!("{code_lower}.jp"),
            ".L" => format!("{code_lower}.uk"),
            ".DE" => format!("{code_lower}.de"),
            ".PA" => format!("{code_lower}.fr"),
            ".SW" => format!("{code_lower}.ch"),
            ".TO" | ".V" => format!("{code_lower}.ca"),
            ".AX" => format!("{code_lower}.au"),
            ".TW" | ".TWO" => format!("{code_lower}.tw"),
            ".KS" | ".KQ" => format!("{code_lower}.kr"),
            other => format!("{code_lower}{}", other.to_ascii_lowercase()),
        };
        (stooq_ticker, currency)
    } else {
        (
            format!("{}.us", symbol.to_ascii_lowercase().replace('.', "-")),
            "USD",
        )
    }
}

fn last_sunday_of_month(year: i32, month: u32) -> Option<NaiveDate> {
    let last_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28,
        _ => return None,
    };
    let mut date = NaiveDate::from_ymd_opt(year, month, last_day)?;
    while date.weekday() != Weekday::Sun {
        date = date.pred_opt()?;
    }
    Some(date)
}

/// Converts a Stooq Warsaw local timestamp (`YYYY-MM-DD`, `HH:MM:SS`) in CET (UTC+1) /
/// CEST (UTC+2) to an RFC 3339 UTC timestamp using standard EU DST transition rules.
pub fn stooq_warsaw_to_utc(date_col: &str, time_col: &str) -> Option<String> {
    let date = NaiveDate::parse_from_str(date_col.trim(), "%Y-%m-%d").ok()?;
    let time = NaiveTime::parse_from_str(time_col.trim(), "%H:%M:%S").ok()?;
    let local = NaiveDateTime::new(date, time);
    let year = date.year();
    let march_sun = last_sunday_of_month(year, 3)?;
    let oct_sun = last_sunday_of_month(year, 10)?;

    let dst_start_cest = NaiveDateTime::new(march_sun, NaiveTime::from_hms_opt(3, 0, 0)?);
    let dst_end_cest = NaiveDateTime::new(oct_sun, NaiveTime::from_hms_opt(2, 0, 0)?);

    let offset_hours = if local >= dst_start_cest && local < dst_end_cest {
        2
    } else {
        1
    };
    let utc_naive = local.checked_sub_signed(TimeDelta::hours(offset_hours))?;
    Some(
        utc_naive
            .and_utc()
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum QuoteError {
    #[error("no valid symbols requested")]
    EmptySymbols,
    #[error("too many symbols requested (max {MAX_QUOTE_SYMBOLS})")]
    TooManySymbols,
    #[error("invalid stock symbol rejected: {0}")]
    InvalidSymbol(String),
    #[error("unsupported public quote provider: {0}")]
    UnsupportedProvider(String),
    #[error("URL rejected by HTTPS allowlist policy: {0}")]
    DisallowedUrl(String),
    #[error("HTTP client initialization failed: {0}")]
    ClientInit(String),
    #[error("public quote response exceeded {limit} byte safety limit")]
    ResponseTooLarge { limit: usize },
    #[error("public quote batch timed out after {BATCH_QUOTE_TIMEOUT_SECS}s")]
    BatchTimeout,
    #[error("public quote request failed: {0}")]
    Network(String),
    #[error("public quote response could not be parsed: {0}")]
    Parse(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublicQuoteProvider {
    Stooq,
    Yahoo,
}

impl PublicQuoteProvider {
    pub fn parse(raw: &str) -> Result<Self, QuoteError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "stooq" | "stooq.com" => Ok(Self::Stooq),
            "yahoo" | "yahoo-finance" | "query1.finance.yahoo.com" => Ok(Self::Yahoo),
            other => Err(QuoteError::UnsupportedProvider(other.to_string())),
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Stooq => "stooq.com",
            Self::Yahoo => "query1.finance.yahoo.com",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicQuoteBatchResponseDto {
    pub quotes: Vec<CachedPublicQuote>,
    pub from_cache: bool,
    pub degraded_reason: Option<String>,
    pub provider: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicQuoteBatchOutcome {
    pub quotes: Vec<CachedPublicQuote>,
    pub failed_symbols: Vec<String>,
    pub last_error: Option<String>,
    pub timed_out: bool,
}

pub fn validate_quote_symbols(raw_symbols: &[String]) -> Result<Vec<String>, QuoteError> {
    if raw_symbols.is_empty() {
        return Err(QuoteError::EmptySymbols);
    }
    let mut normalized = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in raw_symbols {
        let sym = raw.trim().to_ascii_uppercase();
        if !is_valid_ticker(&sym) {
            return Err(QuoteError::InvalidSymbol(
                raw.trim().chars().take(20).collect(),
            ));
        }
        if seen.insert(sym.clone()) {
            normalized.push(sym);
            if normalized.len() > MAX_QUOTE_SYMBOLS {
                return Err(QuoteError::TooManySymbols);
            }
        }
    }
    if normalized.is_empty() {
        return Err(QuoteError::EmptySymbols);
    }
    Ok(normalized)
}

pub fn is_valid_ticker(symbol: &str) -> bool {
    let bytes = symbol.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 10
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
}

pub fn validate_allowlisted_https_url(raw_url: &str) -> Result<Url, QuoteError> {
    let parsed = Url::parse(raw_url).map_err(|_| QuoteError::DisallowedUrl(raw_url.to_string()))?;
    if parsed.scheme() != "https" {
        return Err(QuoteError::DisallowedUrl(
            "only HTTPS URLs are permitted".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(QuoteError::DisallowedUrl(
            "embedded URL credentials are forbidden".to_string(),
        ));
    }
    if parsed.port().is_some() {
        return Err(QuoteError::DisallowedUrl(
            "explicit custom ports are forbidden".to_string(),
        ));
    }
    let Some(host) = parsed.host_str() else {
        return Err(QuoteError::DisallowedUrl("URL host is missing".to_string()));
    };
    if !ALLOWED_QUOTE_HOSTS.contains(&host) {
        return Err(QuoteError::DisallowedUrl(format!(
            "host '{host}' is not in the read-only quote allowlist"
        )));
    }
    Ok(parsed)
}

fn build_read_only_client() -> Result<Client, QuoteError> {
    Client::builder()
        .timeout(Duration::from_secs(QUOTE_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(4))
        .redirect(Policy::none())
        .user_agent("FolioHelm-ReadOnlyQuotes/0.1")
        .build()
        .map_err(|error| QuoteError::ClientInit(error.to_string()))
}

pub async fn fetch_public_quotes(
    symbols: &[String],
    provider: PublicQuoteProvider,
) -> Result<Vec<CachedPublicQuote>, QuoteError> {
    fetch_public_quotes_partial(symbols, provider)
        .await
        .map(|outcome| outcome.quotes)
}

pub async fn fetch_public_quotes_partial(
    symbols: &[String],
    provider: PublicQuoteProvider,
) -> Result<PublicQuoteBatchOutcome, QuoteError> {
    let valid_symbols = validate_quote_symbols(symbols)?;
    let client = build_read_only_client()?;
    let now_utc = Arc::new(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));

    run_bounded_batch_outcome(
        valid_symbols,
        MAX_CONCURRENT_QUOTE_REQUESTS,
        Duration::from_secs(BATCH_QUOTE_TIMEOUT_SECS),
        move |symbol| {
            let client = client.clone();
            let now_utc = Arc::clone(&now_utc);
            async move {
                match provider {
                    PublicQuoteProvider::Stooq => {
                        fetch_stooq_symbol(&client, &symbol, &now_utc).await
                    }
                    PublicQuoteProvider::Yahoo => {
                        fetch_yahoo_symbol(&client, &symbol, &now_utc).await
                    }
                }
            }
        },
    )
    .await
}

async fn run_bounded_batch_outcome<F, Fut>(
    symbols: Vec<String>,
    max_concurrency: usize,
    total_timeout: Duration,
    fetcher: F,
) -> Result<PublicQuoteBatchOutcome, QuoteError>
where
    F: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<CachedPublicQuote, QuoteError>> + Send + 'static,
{
    let semaphore = Arc::new(Semaphore::new(max_concurrency.max(1)));
    let fetcher = Arc::new(fetcher);
    let mut join_set = JoinSet::new();

    for (index, symbol) in symbols.iter().enumerate() {
        let permit_pool = Arc::clone(&semaphore);
        let fetcher = Arc::clone(&fetcher);
        let sym = symbol.clone();
        join_set.spawn(async move {
            let _permit = permit_pool
                .acquire_owned()
                .await
                .map_err(|_| QuoteError::Network("quote concurrency limiter closed".to_string()))?;
            let result = fetcher(sym).await;
            Ok::<(usize, Result<CachedPublicQuote, QuoteError>), QuoteError>((index, result))
        });
    }

    let mut ordered_results: BTreeMap<usize, CachedPublicQuote> = BTreeMap::new();
    let mut last_error: Option<QuoteError> = None;

    let collect_future = async {
        while let Some(joined) = join_set.join_next().await {
            match joined {
                Ok(Ok((index, Ok(quote)))) => {
                    ordered_results.insert(index, quote);
                }
                Ok(Ok((_, Err(error)))) => {
                    last_error = Some(error);
                }
                Ok(Err(error)) => {
                    last_error = Some(error);
                }
                Err(join_error) => {
                    last_error = Some(QuoteError::Network(join_error.to_string()));
                }
            }
        }
    };

    let timed_out = timeout(total_timeout, collect_future).await.is_err();
    if timed_out {
        join_set.abort_all();
    }

    if ordered_results.is_empty() {
        if timed_out {
            return Err(QuoteError::BatchTimeout);
        }
        return Err(last_error.unwrap_or_else(|| {
            QuoteError::Network("no public quotes could be retrieved".to_string())
        }));
    }

    let mut failed_symbols = Vec::new();
    for (index, symbol) in symbols.into_iter().enumerate() {
        if !ordered_results.contains_key(&index) {
            failed_symbols.push(symbol);
        }
    }

    Ok(PublicQuoteBatchOutcome {
        quotes: ordered_results.into_values().collect(),
        failed_symbols,
        last_error: last_error.map(|e| e.to_string()),
        timed_out,
    })
}

async fn read_bounded_response_utf8(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, QuoteError> {
    if let Some(declared_len) = response.content_length() {
        if declared_len > max_bytes as u64 {
            return Err(QuoteError::ResponseTooLarge { limit: max_bytes });
        }
    }

    let mut buffer = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| QuoteError::Network(error.to_string()))?
    {
        let next_len = buffer
            .len()
            .checked_add(chunk.len())
            .ok_or(QuoteError::ResponseTooLarge { limit: max_bytes })?;
        if next_len > max_bytes {
            return Err(QuoteError::ResponseTooLarge { limit: max_bytes });
        }
        buffer.extend_from_slice(&chunk);
    }

    String::from_utf8(buffer)
        .map_err(|_| QuoteError::Parse("quote response was not valid UTF-8".to_string()))
}

/// Pure helper enforcing the bounded streaming body cap, shared with unit tests.
pub fn collect_bounded_chunks<'a, I>(chunks: I, max_bytes: usize) -> Result<String, QuoteError>
where
    I: IntoIterator<Item = &'a [u8]>,
{
    let mut buffer = Vec::new();
    for chunk in chunks {
        let next_len = buffer
            .len()
            .checked_add(chunk.len())
            .ok_or(QuoteError::ResponseTooLarge { limit: max_bytes })?;
        if next_len > max_bytes {
            return Err(QuoteError::ResponseTooLarge { limit: max_bytes });
        }
        buffer.extend_from_slice(chunk);
    }
    String::from_utf8(buffer)
        .map_err(|_| QuoteError::Parse("quote response was not valid UTF-8".to_string()))
}

async fn fetch_stooq_symbol(
    client: &Client,
    symbol: &str,
    fetched_at_utc: &str,
) -> Result<CachedPublicQuote, QuoteError> {
    let (stooq_ticker, _currency) = map_stooq_symbol(symbol);
    let url_str = format!("https://stooq.com/q/l/?s={stooq_ticker}&f=sd2t2ohlcv&h&e=csv");
    let url = validate_allowlisted_https_url(&url_str)?;

    let response = client
        .get(url)
        .header("Accept", "text/csv,text/plain")
        .send()
        .await
        .map_err(|error| QuoteError::Network(error.to_string()))?;

    if !response.status().is_success() {
        return Err(QuoteError::Network(format!(
            "stooq returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let body = read_bounded_response_utf8(response, MAX_QUOTE_RESPONSE_BYTES).await?;
    parse_stooq_csv_response(symbol, &body, fetched_at_utc)
}

pub fn parse_stooq_csv_response(
    requested_symbol: &str,
    body: &str,
    fallback_as_of_utc: &str,
) -> Result<CachedPublicQuote, QuoteError> {
    if body.len() > MAX_QUOTE_RESPONSE_BYTES {
        return Err(QuoteError::ResponseTooLarge {
            limit: MAX_QUOTE_RESPONSE_BYTES,
        });
    }
    let mut lines = body.lines().filter(|line| !line.trim().is_empty());
    let header_line = lines
        .next()
        .ok_or_else(|| QuoteError::Parse("empty stooq CSV response".to_string()))?;
    let headers: Vec<String> = header_line
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();

    let find_col = |names: &[&str]| -> Option<usize> {
        headers
            .iter()
            .position(|h| names.iter().any(|name| h == name))
    };

    let date_idx = find_col(&["date"]).unwrap_or(1);
    let time_idx = find_col(&["time"]);
    let close_idx = find_col(&["close"]).ok_or_else(|| {
        QuoteError::Parse("missing Close column in stooq CSV response".to_string())
    })?;
    let prev_idx = find_col(&["prev", "previous", "prev close", "previous close"]);

    struct ParsedStooqRow<'a> {
        date: &'a str,
        time: Option<&'a str>,
        close: i128,
        prev_close: Option<i128>,
    }

    let mut parsed_rows: Vec<ParsedStooqRow<'_>> = Vec::new();
    for line in lines {
        let cols: Vec<&str> = line.split(',').map(str::trim).collect();
        if cols.len() <= close_idx {
            continue;
        }
        let close_col = cols[close_idx];
        if close_col.eq_ignore_ascii_case("N/D") || close_col.is_empty() {
            continue;
        }
        let close_fixed = parse_positive_fixed_decimal(close_col)?;
        let prev_close = prev_idx
            .and_then(|idx| cols.get(idx).copied())
            .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("N/D"))
            .and_then(|v| parse_positive_fixed_decimal(v).ok());
        let date = cols.get(date_idx).copied().unwrap_or("");
        let time = time_idx.and_then(|idx| cols.get(idx).copied());
        parsed_rows.push(ParsedStooqRow {
            date,
            time,
            close: close_fixed,
            prev_close,
        });
    }

    if parsed_rows.is_empty() {
        return Err(QuoteError::Parse(format!(
            "no delayed quote available on stooq for {requested_symbol}"
        )));
    }

    // Order chronologically when multiple daily rows are returned so the latest bar is last.
    parsed_rows.sort_by(|a, b| {
        a.date
            .cmp(b.date)
            .then_with(|| a.time.unwrap_or("").cmp(b.time.unwrap_or("")))
    });

    let latest = parsed_rows
        .last()
        .ok_or_else(|| QuoteError::Parse("missing stooq data row".to_string()))?;
    let prior_row_close = if parsed_rows.len() >= 2 {
        Some(parsed_rows[parsed_rows.len() - 2].close)
    } else {
        None
    };

    // Never fabricate daily change from intraday (Close - Open): only compute daily change
    // when an explicit Previous Close column or a prior trading day's Close is available.
    let (change_fixed, change_pct_fixed) = match latest.prev_close.or(prior_row_close) {
        Some(prev_close_fixed) => {
            let change = latest
                .close
                .checked_sub(prev_close_fixed)
                .ok_or_else(|| QuoteError::Parse("quote change overflow".to_string()))?;
            let change_pct = compute_change_pct_fixed(change, prev_close_fixed)?;
            (change, change_pct)
        }
        None => (0, 0),
    };

    let as_of_utc = latest
        .time
        .filter(|t| !t.eq_ignore_ascii_case("N/D") && !t.is_empty())
        .and_then(|t| stooq_warsaw_to_utc(latest.date, t))
        .unwrap_or_else(|| fallback_as_of_utc.to_string());

    let (_, currency) = map_stooq_symbol(requested_symbol);

    Ok(CachedPublicQuote {
        symbol: requested_symbol.to_string(),
        price: format_fixed(latest.close, 4),
        change: format_fixed(change_fixed, 4),
        change_pct: format_fixed(change_pct_fixed, 2),
        currency: currency.to_string(),
        provider: PublicQuoteProvider::Stooq.code().to_string(),
        as_of_utc,
        delayed: true,
    })
}

async fn fetch_yahoo_symbol(
    client: &Client,
    symbol: &str,
    fetched_at_utc: &str,
) -> Result<CachedPublicQuote, QuoteError> {
    let yahoo_ticker = map_yahoo_symbol(symbol);
    let url_str = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}?interval=1d&range=2d"
    );
    let url = validate_allowlisted_https_url(&url_str)?;

    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| QuoteError::Network(error.to_string()))?;

    if !response.status().is_success() {
        return Err(QuoteError::Network(format!(
            "yahoo finance returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let body = read_bounded_response_utf8(response, MAX_QUOTE_RESPONSE_BYTES).await?;
    parse_yahoo_chart_response(symbol, &body, fetched_at_utc)
}

#[derive(Deserialize)]
struct YahooChartRoot {
    chart: YahooChartBody,
}

#[derive(Deserialize)]
struct YahooChartBody {
    result: Option<Vec<YahooChartResult>>,
}

#[derive(Deserialize)]
struct YahooChartResult {
    meta: YahooChartMeta,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YahooChartMeta {
    regular_market_price: Option<Box<RawValue>>,
    chart_previous_close: Option<Box<RawValue>>,
    previous_close: Option<Box<RawValue>>,
    currency: Option<String>,
    regular_market_time: Option<i64>,
}

fn parse_raw_json_positive_fixed(raw: Option<&RawValue>) -> Result<i128, QuoteError> {
    let Some(raw) = raw else {
        return Err(QuoteError::Parse("missing numeric JSON field".to_string()));
    };
    let token = raw.get().trim();
    if token.is_empty()
        || token == "null"
        || token.starts_with('"')
        || token.starts_with('{')
        || token.starts_with('[')
    {
        return Err(QuoteError::Parse(format!(
            "non-numeric JSON quote token: {token}"
        )));
    }
    parse_positive_fixed_decimal(token)
}

pub fn parse_yahoo_chart_response(
    requested_symbol: &str,
    body: &str,
    fallback_as_of_utc: &str,
) -> Result<CachedPublicQuote, QuoteError> {
    if body.len() > MAX_QUOTE_RESPONSE_BYTES {
        return Err(QuoteError::ResponseTooLarge {
            limit: MAX_QUOTE_RESPONSE_BYTES,
        });
    }
    let parsed: YahooChartRoot =
        serde_json::from_str(body).map_err(|error| QuoteError::Parse(error.to_string()))?;
    let meta = parsed
        .chart
        .result
        .and_then(|mut list| list.drain(..).next())
        .map(|item| item.meta)
        .ok_or_else(|| {
            QuoteError::Parse(format!("missing yahoo chart meta for {requested_symbol}"))
        })?;

    let price_fixed = parse_raw_json_positive_fixed(meta.regular_market_price.as_deref())
        .map_err(|_| QuoteError::Parse("invalid yahoo regularMarketPrice".to_string()))?;

    let prev_close_fixed = parse_raw_json_positive_fixed(meta.chart_previous_close.as_deref())
        .or_else(|_| parse_raw_json_positive_fixed(meta.previous_close.as_deref()))
        .unwrap_or(price_fixed);

    let change_fixed = price_fixed
        .checked_sub(prev_close_fixed)
        .ok_or_else(|| QuoteError::Parse("yahoo quote change overflow".to_string()))?;
    let change_pct_fixed = compute_change_pct_fixed(change_fixed, prev_close_fixed)?;

    let as_of_utc = meta
        .regular_market_time
        .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| fallback_as_of_utc.to_string());

    Ok(CachedPublicQuote {
        symbol: requested_symbol.to_string(),
        price: format_fixed(price_fixed, 4),
        change: format_fixed(change_fixed, 4),
        change_pct: format_fixed(change_pct_fixed, 2),
        currency: meta
            .currency
            .filter(|c| !c.trim().is_empty())
            .map(|c| c.trim().to_ascii_uppercase())
            .unwrap_or_else(|| infer_currency_from_symbol(requested_symbol).to_string()),
        provider: PublicQuoteProvider::Yahoo.code().to_string(),
        as_of_utc,
        delayed: true,
    })
}

/// Strictly parses a positive decimal string (including optional ASCII scientific
/// notation such as `4.1525e2`) into a `10^8`-scaled `i128`. Never uses `f32`/`f64`.
pub fn parse_positive_fixed_decimal(raw: &str) -> Result<i128, QuoteError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.is_ascii() {
        return Err(QuoteError::Parse(format!("invalid numeric quote: {raw}")));
    }
    if trimmed.starts_with('-') {
        return Err(QuoteError::Parse(format!(
            "non-positive quote rejected: {raw}"
        )));
    }
    let unsigned = trimmed.strip_prefix('+').unwrap_or(trimmed);

    let (mantissa, exp_opt) = match unsigned.find(['e', 'E']) {
        Some(pos) => (&unsigned[..pos], Some(&unsigned[pos + 1..])),
        None => (unsigned, None),
    };

    let exponent: i32 = if let Some(exp_str) = exp_opt {
        if exp_str.is_empty() {
            return Err(QuoteError::Parse(format!("invalid exponent: {raw}")));
        }
        let parsed_exp: i32 = exp_str
            .parse()
            .map_err(|_| QuoteError::Parse(format!("invalid exponent: {raw}")))?;
        if !(-32..=32).contains(&parsed_exp) {
            return Err(QuoteError::Parse(format!("exponent out of range: {raw}")));
        }
        parsed_exp
    } else {
        0
    };

    let mut parts = mantissa.split('.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next().unwrap_or("");
    if parts.next().is_some()
        || (int_part.is_empty() && frac_part.is_empty())
        || !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(QuoteError::Parse(format!("invalid numeric quote: {raw}")));
    }

    let mut digits = String::with_capacity(int_part.len() + frac_part.len());
    digits.push_str(int_part);
    digits.push_str(frac_part);
    let trimmed_digits = digits.trim_start_matches('0');
    if trimmed_digits.is_empty() {
        return Err(QuoteError::Parse(format!(
            "non-positive quote rejected: {raw}"
        )));
    }

    let frac_len = i32::try_from(frac_part.len())
        .map_err(|_| QuoteError::Parse(format!("quote precision overflow: {raw}")))?;
    let scale_shift = exponent - frac_len + FIXED_SCALE as i32;

    let value: i128 = if scale_shift >= 0 {
        let base: i128 = trimmed_digits
            .parse()
            .map_err(|_| QuoteError::Parse(format!("numeric quote overflow: {raw}")))?;
        let pow_shift = u32::try_from(scale_shift)
            .map_err(|_| QuoteError::Parse(format!("numeric quote overflow: {raw}")))?;
        let factor = 10_i128
            .checked_pow(pow_shift)
            .ok_or_else(|| QuoteError::Parse(format!("numeric quote overflow: {raw}")))?;
        base.checked_mul(factor)
            .ok_or_else(|| QuoteError::Parse(format!("numeric quote overflow: {raw}")))?
    } else {
        let drop_digits = usize::try_from(-scale_shift)
            .map_err(|_| QuoteError::Parse(format!("numeric quote underflow: {raw}")))?;
        if drop_digits > trimmed_digits.len() {
            // Smaller than half of 10^-8 -> rounds to 0, which is non-positive.
            return Err(QuoteError::Parse(format!(
                "non-positive quote after fixed-point scaling: {raw}"
            )));
        }
        let split_at = trimmed_digits.len() - drop_digits;
        let kept = &trimmed_digits[..split_at];
        let dropped = &trimmed_digits[split_at..];
        let mut base: i128 = if kept.is_empty() {
            0
        } else {
            kept.parse()
                .map_err(|_| QuoteError::Parse(format!("numeric quote overflow: {raw}")))?
        };
        if dropped.as_bytes().first().is_some_and(|&b| b >= b'5') {
            base = base
                .checked_add(1)
                .ok_or_else(|| QuoteError::Parse(format!("numeric quote overflow: {raw}")))?;
        }
        base
    };

    if value <= 0 {
        return Err(QuoteError::Parse(format!(
            "non-positive quote rejected: {raw}"
        )));
    }
    Ok(value)
}

fn fixed_div(numerator: i128, denominator: i128) -> Result<i128, QuoteError> {
    if denominator == 0 {
        return Err(QuoteError::Parse("division by zero".to_string()));
    }
    let scaled = numerator
        .checked_mul(FIXED_FACTOR)
        .ok_or_else(|| QuoteError::Parse("fixed-point division overflow".to_string()))?;
    let half = i128::try_from(denominator.unsigned_abs() / 2)
        .map_err(|_| QuoteError::Parse("fixed-point rounding overflow".to_string()))?;
    let adjusted = if (scaled >= 0) == (denominator > 0) {
        scaled.checked_add(if scaled >= 0 { half } else { -half })
    } else {
        scaled.checked_sub(if scaled >= 0 { half } else { -half })
    }
    .ok_or_else(|| QuoteError::Parse("fixed-point rounding overflow".to_string()))?;
    adjusted
        .checked_div(denominator)
        .ok_or_else(|| QuoteError::Parse("fixed-point division overflow".to_string()))
}

fn compute_change_pct_fixed(change_fixed: i128, base_fixed: i128) -> Result<i128, QuoteError> {
    if base_fixed <= 0 {
        return Ok(0);
    }
    let scaled_change = change_fixed
        .checked_mul(100)
        .ok_or_else(|| QuoteError::Parse("change percent overflow".to_string()))?;
    fixed_div(scaled_change, base_fixed)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkFetchResponseDto {
    pub series: Option<StoredBenchmarkSeries>,
    pub from_cache: bool,
    pub degraded_reason: Option<String>,
    pub provider: String,
}

/// Strictly validates that `raw_symbol` is in the read-only benchmark allowlist.
/// Never accepts arbitrary URLs, path segments, or non-benchmark tickers.
pub fn validate_benchmark_symbol(
    raw_symbol: &str,
) -> Result<(&'static str, &'static str), QuoteError> {
    let normalized = raw_symbol.trim().to_ascii_uppercase();
    for &(allowed, currency) in ALLOWED_BENCHMARK_SYMBOLS {
        if normalized == allowed {
            return Ok((allowed, currency));
        }
    }
    Err(QuoteError::InvalidSymbol(format!(
        "benchmark symbol '{}' is not in the read-only allowlist (SPY, QQQ, 2800.HK, 510300.SS)",
        raw_symbol.trim().chars().take(24).collect::<String>()
    )))
}

fn fixed_1e8_to_micros(value_1e8: i128) -> Result<i128, QuoteError> {
    let rounded = if value_1e8 >= 0 {
        value_1e8
            .checked_add(50)
            .ok_or_else(|| QuoteError::Parse("benchmark micro scaling overflow".to_string()))?
            / 100
    } else {
        value_1e8
            .checked_sub(50)
            .ok_or_else(|| QuoteError::Parse("benchmark micro scaling overflow".to_string()))?
            / 100
    };
    if rounded <= 0 {
        return Err(QuoteError::Parse(
            "non-positive benchmark close rejected".to_string(),
        ));
    }
    Ok(rounded)
}

/// Fetches daily historical closing prices for an allowlisted read-only benchmark symbol.
pub async fn fetch_benchmark_history(
    raw_symbol: &str,
    provider: PublicQuoteProvider,
) -> Result<StoredBenchmarkSeries, QuoteError> {
    let (symbol, currency) = validate_benchmark_symbol(raw_symbol)?;
    let client = build_read_only_client()?;
    let now = Utc::now();
    let as_of_utc = now.to_rfc3339_opts(SecondsFormat::Millis, true);

    match provider {
        PublicQuoteProvider::Stooq => {
            let (stooq_ticker, _) = map_stooq_symbol(symbol);
            let d2 = now.format("%Y%m%d");
            let d1 = (now - TimeDelta::days(400)).format("%Y%m%d");
            let url_str = format!("https://stooq.com/q/d/l/?s={stooq_ticker}&i=d&d1={d1}&d2={d2}");
            let url = validate_allowlisted_https_url(&url_str)?;
            let response = client
                .get(url)
                .header("Accept", "text/csv,text/plain")
                .send()
                .await
                .map_err(|error| QuoteError::Network(error.to_string()))?;
            if !response.status().is_success() {
                return Err(QuoteError::Network(format!(
                    "stooq history returned HTTP {}",
                    response.status().as_u16()
                )));
            }
            let body = read_bounded_response_utf8(response, MAX_QUOTE_RESPONSE_BYTES).await?;
            parse_stooq_history_csv(symbol, currency, &body, &as_of_utc)
        }
        PublicQuoteProvider::Yahoo => {
            let yahoo_ticker = map_yahoo_symbol(symbol);
            let url_str = format!(
                "https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}?interval=1d&range=1y"
            );
            let url = validate_allowlisted_https_url(&url_str)?;
            let response = client
                .get(url)
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|error| QuoteError::Network(error.to_string()))?;
            if !response.status().is_success() {
                return Err(QuoteError::Network(format!(
                    "yahoo history returned HTTP {}",
                    response.status().as_u16()
                )));
            }
            let body = read_bounded_response_utf8(response, MAX_QUOTE_RESPONSE_BYTES).await?;
            parse_yahoo_history_json(symbol, currency, &body, &as_of_utc)
        }
    }
}

pub fn parse_stooq_history_csv(
    symbol: &str,
    currency: &str,
    body: &str,
    as_of_utc: &str,
) -> Result<StoredBenchmarkSeries, QuoteError> {
    if body.len() > MAX_QUOTE_RESPONSE_BYTES {
        return Err(QuoteError::ResponseTooLarge {
            limit: MAX_QUOTE_RESPONSE_BYTES,
        });
    }
    let mut lines = body.lines().filter(|line| !line.trim().is_empty());
    let header = lines
        .next()
        .ok_or_else(|| QuoteError::Parse("empty stooq history CSV".to_string()))?;
    let headers: Vec<String> = header
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();
    let date_idx = headers
        .iter()
        .position(|h| h == "date")
        .ok_or_else(|| QuoteError::Parse("missing Date column in stooq history CSV".to_string()))?;
    let close_idx = headers.iter().position(|h| h == "close").ok_or_else(|| {
        QuoteError::Parse("missing Close column in stooq history CSV".to_string())
    })?;

    let mut by_date: BTreeMap<String, i128> = BTreeMap::new();
    for line in lines {
        let cols: Vec<&str> = line.split(',').map(str::trim).collect();
        if cols.len() <= date_idx || cols.len() <= close_idx {
            continue;
        }
        let date_str = cols[date_idx];
        let close_str = cols[close_idx];
        if date_str.len() != 10
            || NaiveDate::parse_from_str(date_str, "%Y-%m-%d").is_err()
            || close_str.is_empty()
            || close_str.eq_ignore_ascii_case("N/D")
        {
            continue;
        }
        if let Ok(fixed) = parse_positive_fixed_decimal(close_str) {
            if let Ok(micros) = fixed_1e8_to_micros(fixed) {
                by_date.insert(date_str.to_string(), micros);
            }
        }
    }

    if by_date.is_empty() {
        return Err(QuoteError::Parse(format!(
            "no valid daily history bars on stooq for {symbol}"
        )));
    }

    let mut points: Vec<BenchmarkPricePoint> = by_date
        .into_iter()
        .map(|(date, close_micros)| BenchmarkPricePoint { date, close_micros })
        .collect();
    if points.len() > MAX_BENCHMARK_POINTS {
        let start = points.len() - MAX_BENCHMARK_POINTS;
        points = points.split_off(start);
    }

    Ok(StoredBenchmarkSeries {
        symbol: symbol.to_string(),
        currency: currency.to_string(),
        provider: PublicQuoteProvider::Stooq.code().to_string(),
        as_of_utc: as_of_utc.to_string(),
        points,
    })
}

#[derive(Deserialize)]
struct YahooHistoryRoot {
    chart: YahooHistoryBody,
}

#[derive(Deserialize)]
struct YahooHistoryBody {
    result: Option<Vec<YahooHistoryResult>>,
}

#[derive(Deserialize)]
struct YahooHistoryResult {
    timestamp: Option<Vec<i64>>,
    indicators: Option<YahooHistoryIndicators>,
}

#[derive(Deserialize)]
struct YahooHistoryIndicators {
    quote: Option<Vec<YahooHistoryQuote>>,
}

#[derive(Deserialize)]
struct YahooHistoryQuote {
    close: Option<Vec<Option<Box<RawValue>>>>,
}

pub fn parse_yahoo_history_json(
    symbol: &str,
    currency: &str,
    body: &str,
    as_of_utc: &str,
) -> Result<StoredBenchmarkSeries, QuoteError> {
    if body.len() > MAX_QUOTE_RESPONSE_BYTES {
        return Err(QuoteError::ResponseTooLarge {
            limit: MAX_QUOTE_RESPONSE_BYTES,
        });
    }
    let parsed: YahooHistoryRoot =
        serde_json::from_str(body).map_err(|error| QuoteError::Parse(error.to_string()))?;
    let item = parsed
        .chart
        .result
        .and_then(|mut list| list.drain(..).next())
        .ok_or_else(|| QuoteError::Parse(format!("missing yahoo history result for {symbol}")))?;

    let timestamps = item.timestamp.unwrap_or_default();
    let closes = item
        .indicators
        .and_then(|ind| ind.quote)
        .and_then(|mut q| q.drain(..).next())
        .and_then(|q| q.close)
        .unwrap_or_default();

    let mut by_date: BTreeMap<String, i128> = BTreeMap::new();
    for (ts, close_opt) in timestamps.iter().zip(closes.iter()) {
        let Some(dt) = chrono::DateTime::from_timestamp(*ts, 0) else {
            continue;
        };
        let Ok(fixed) = parse_raw_json_positive_fixed(close_opt.as_deref()) else {
            continue;
        };
        let Ok(micros) = fixed_1e8_to_micros(fixed) else {
            continue;
        };
        let date = dt.format("%Y-%m-%d").to_string();
        by_date.insert(date, micros);
    }

    if by_date.is_empty() {
        return Err(QuoteError::Parse(format!(
            "no valid daily history bars on yahoo for {symbol}"
        )));
    }

    let mut points: Vec<BenchmarkPricePoint> = by_date
        .into_iter()
        .map(|(date, close_micros)| BenchmarkPricePoint { date, close_micros })
        .collect();
    if points.len() > MAX_BENCHMARK_POINTS {
        let start = points.len() - MAX_BENCHMARK_POINTS;
        points = points.split_off(start);
    }

    Ok(StoredBenchmarkSeries {
        symbol: symbol.to_string(),
        currency: currency.to_string(),
        provider: PublicQuoteProvider::Yahoo.code().to_string(),
        as_of_utc: as_of_utc.to_string(),
        points,
    })
}

fn format_fixed(value: i128, decimals: u32) -> String {
    let negative = value < 0;
    let abs = value.unsigned_abs();
    let shift = FIXED_SCALE.saturating_sub(decimals);
    let divisor = 10_u128.pow(shift);
    let rounded = (abs + divisor / 2) / divisor;
    let scale_pow = 10_u128.pow(decimals);
    let whole = rounded / scale_pow;
    let frac = rounded % scale_pow;
    let sign = if negative && rounded > 0 { "-" } else { "" };
    if decimals == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{frac:0width$}", width = decimals as usize)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn enforces_strict_https_allowlist_and_blocks_http_custom_ports_or_foreign_hosts() {
        assert!(validate_allowlisted_https_url(
            "https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv"
        )
        .is_ok());
        assert!(validate_allowlisted_https_url(
            "https://query1.finance.yahoo.com/v8/finance/chart/AAPL"
        )
        .is_ok());

        assert!(validate_allowlisted_https_url("http://stooq.com/q/l/?s=aapl.us").is_err());
        assert!(validate_allowlisted_https_url("https://stooq.com:8443/q/l/?s=aapl.us").is_err());
        assert!(
            validate_allowlisted_https_url("https://query1.finance.yahoo.com:8080/v8/chart")
                .is_err()
        );
        assert!(validate_allowlisted_https_url("https://evil.example.com/quote").is_err());
        assert!(
            validate_allowlisted_https_url("https://stooq.com@evil.example.com/quote").is_err()
        );
        assert!(validate_allowlisted_https_url("https://user:pass@stooq.com/q/l/").is_err());
    }

    #[test]
    fn validates_tickers_and_rejects_injection_or_oversized_batches() {
        let valid = validate_quote_symbols(&["aapl".into(), "BRK.B".into(), "AAPL".into()])
            .expect("valid symbols");
        assert_eq!(valid, vec!["AAPL", "BRK.B"]);

        assert!(validate_quote_symbols(&["AAPL&token=secret".into()]).is_err());
        assert!(validate_quote_symbols(&["../etc/passwd".into()]).is_err());

        let too_many: Vec<String> = (0..55).map(|i| format!("SYM{i}")).collect();
        assert!(matches!(
            validate_quote_symbols(&too_many),
            Err(QuoteError::TooManySymbols)
        ));
    }

    #[test]
    fn maps_non_us_and_us_symbols_accurately_for_yahoo_and_stooq() {
        assert_eq!(map_yahoo_symbol("AAPL"), "AAPL");
        assert_eq!(map_yahoo_symbol("BRK.B"), "BRK-B");
        assert_eq!(map_yahoo_symbol("00700.HK"), "0700.HK");
        assert_eq!(map_yahoo_symbol("09988.HK"), "9988.HK");
        assert_eq!(map_yahoo_symbol("600519.SS"), "600519.SS");
        assert_eq!(map_yahoo_symbol("000001.SZ"), "000001.SZ");
        assert_eq!(map_yahoo_symbol("D05.SI"), "D05.SI");
        assert_eq!(map_yahoo_symbol("7203.T"), "7203.T");
        assert_eq!(map_yahoo_symbol("HSBA.L"), "HSBA.L");

        assert_eq!(map_stooq_symbol("AAPL"), ("aapl.us".to_string(), "USD"));
        assert_eq!(map_stooq_symbol("BRK.B"), ("brk-b.us".to_string(), "USD"));
        assert_eq!(map_stooq_symbol("00700.HK"), ("700.hk".to_string(), "HKD"));
        assert_eq!(
            map_stooq_symbol("600519.SS"),
            ("600519.ss".to_string(), "CNY")
        );
        assert_eq!(
            map_stooq_symbol("000001.SZ"),
            ("000001.sz".to_string(), "CNY")
        );
        assert_eq!(map_stooq_symbol("D05.SI"), ("d05.si".to_string(), "SGD"));
        assert_eq!(map_stooq_symbol("7203.T"), ("7203.jp".to_string(), "JPY"));
        assert_eq!(map_stooq_symbol("HSBA.L"), ("hsba.uk".to_string(), "GBP"));
    }

    #[test]
    fn parses_stooq_csv_and_yahoo_chart_responses_with_exact_fixed_point_math() {
        // Single-row Stooq without Previous Close MUST NOT fabricate daily change from (Close - Open),
        // and converts Warsaw CET (UTC+1 in Nov) to real UTC.
        let stooq_csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-11-21,22:00:00,225.00,229.00,224.50,228.50,42100000\n";
        let quote =
            parse_stooq_csv_response("AAPL", stooq_csv, "2026-11-22T00:00:00.000Z").expect("parse");
        assert_eq!(quote.symbol, "AAPL");
        assert_eq!(quote.price, "228.5000");
        assert_eq!(quote.change, "0.0000");
        assert_eq!(quote.change_pct, "0.00");
        assert_eq!(quote.currency, "USD");
        assert_eq!(quote.as_of_utc, "2026-11-21T21:00:00.000Z");
        assert_eq!(quote.provider, "stooq.com");
        assert!(quote.delayed);

        // Non-US HK stock in summer CEST (UTC+2 in July) with Prev column uses HKD and exact baseline
        let hk_csv = "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\n700.HK,2026-07-15,10:08:00,382.00,386.00,379.00,384.00,1200000,380.00\n";
        let hk_quote =
            parse_stooq_csv_response("00700.HK", hk_csv, "2026-07-15T12:00:00.000Z").expect("hk");
        assert_eq!(hk_quote.symbol, "00700.HK");
        assert_eq!(hk_quote.currency, "HKD");
        assert_eq!(hk_quote.price, "384.0000");
        assert_eq!(hk_quote.change, "4.0000");
        assert_eq!(hk_quote.change_pct, "1.05");
        assert_eq!(hk_quote.as_of_utc, "2026-07-15T08:08:00.000Z");

        // Multi-row exact decimal test without IEEE-754 drift (0.30 - 0.10 == 0.20 exactly, not 0.19999999999999998)
        let exact_csv = "Date,Open,High,Low,Close,Volume\n2026-11-20,0.09,0.12,0.08,0.10,50\n2026-11-21,0.15,0.30,0.15,0.30,100\n";
        let exact = parse_stooq_csv_response("600519.SS", exact_csv, "2026-11-22T00:00:00.000Z")
            .expect("exact parse");
        assert_eq!(exact.currency, "CNY");
        assert_eq!(exact.price, "0.3000");
        assert_eq!(exact.change, "0.2000");
        assert_eq!(exact.change_pct, "200.00");

        // Yahoo JSON including scientific notation number token + currency fallback for non-US symbols
        let yahoo_json = r#"{"chart":{"result":[{"meta":{"regularMarketPrice":4.1525e2,"chartPreviousClose":410.0,"currency":"USD","regularMarketTime":1763760000}}]}}"#;
        let y_quote =
            parse_yahoo_chart_response("MSFT", yahoo_json, "2026-11-22T00:00:00.000Z").expect("y");
        assert_eq!(y_quote.symbol, "MSFT");
        assert_eq!(y_quote.price, "415.2500");
        assert_eq!(y_quote.change, "5.2500");
        assert_eq!(y_quote.change_pct, "1.28");
        assert_eq!(y_quote.provider, "query1.finance.yahoo.com");
        assert!(y_quote.delayed);

        let yahoo_sg_no_curr = r#"{"chart":{"result":[{"meta":{"regularMarketPrice":42.50,"chartPreviousClose":41.00,"regularMarketTime":1763760000}}]}}"#;
        let sg_quote =
            parse_yahoo_chart_response("D05.SI", yahoo_sg_no_curr, "2026-11-22T00:00:00.000Z")
                .expect("sg");
        assert_eq!(sg_quote.symbol, "D05.SI");
        assert_eq!(sg_quote.currency, "SGD");

        // fixed_div handles i128::MIN denominator without panicking
        assert!(fixed_div(1, i128::MIN).is_ok());
    }

    #[test]
    fn enforces_512kb_response_size_cap_against_oom_dos() {
        let oversized_chunk = vec![b'A'; MAX_QUOTE_RESPONSE_BYTES + 1];
        assert_eq!(
            collect_bounded_chunks([oversized_chunk.as_slice()], MAX_QUOTE_RESPONSE_BYTES),
            Err(QuoteError::ResponseTooLarge {
                limit: MAX_QUOTE_RESPONSE_BYTES
            })
        );

        let chunk_a = vec![b'X'; 300 * 1024];
        let chunk_b = vec![b'Y'; 300 * 1024];
        assert_eq!(
            collect_bounded_chunks(
                [chunk_a.as_slice(), chunk_b.as_slice()],
                MAX_QUOTE_RESPONSE_BYTES
            ),
            Err(QuoteError::ResponseTooLarge {
                limit: MAX_QUOTE_RESPONSE_BYTES
            })
        );

        let valid_body = b"Symbol,Date,Time,Open,High,Low,Close,Volume\n";
        assert!(collect_bounded_chunks([valid_body.as_slice()], MAX_QUOTE_RESPONSE_BYTES).is_ok());
    }

    #[tokio::test]
    async fn enforces_bounded_concurrency_partial_failures_and_total_batch_timeout() {
        let symbols: Vec<String> = (1..=12).map(|i| format!("SYM{i}")).collect();
        let active = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let active_clone = Arc::clone(&active);
        let max_clone = Arc::clone(&max_seen);
        let outcome = run_bounded_batch_outcome(
            symbols.clone(),
            MAX_CONCURRENT_QUOTE_REQUESTS,
            Duration::from_secs(5),
            move |symbol| {
                let active = Arc::clone(&active_clone);
                let max_seen = Arc::clone(&max_clone);
                async move {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(current, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(15)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(CachedPublicQuote {
                        symbol,
                        price: "100.0000".to_string(),
                        change: "1.0000".to_string(),
                        change_pct: "1.01".to_string(),
                        currency: "USD".to_string(),
                        provider: "stooq.com".to_string(),
                        as_of_utc: "2026-11-22T00:00:00.000Z".to_string(),
                        delayed: true,
                    })
                }
            },
        )
        .await
        .expect("batch succeeds");

        assert_eq!(outcome.quotes.len(), 12);
        assert!(outcome.failed_symbols.is_empty());
        assert_eq!(outcome.quotes[0].symbol, "SYM1");
        assert_eq!(outcome.quotes[11].symbol, "SYM12");
        assert!(max_seen.load(Ordering::SeqCst) <= MAX_CONCURRENT_QUOTE_REQUESTS);

        // Partial failure returns succeeded quotes AND accurately lists failed symbols.
        let partial = run_bounded_batch_outcome(
            vec!["AAPL".into(), "00700.HK".into(), "MSFT".into()],
            2,
            Duration::from_secs(2),
            |symbol| async move {
                if symbol == "00700.HK" {
                    return Err(QuoteError::Network("upstream 503".into()));
                }
                Ok(CachedPublicQuote {
                    symbol,
                    price: "200.0000".into(),
                    change: "0.0000".into(),
                    change_pct: "0.00".into(),
                    currency: "USD".into(),
                    provider: "stooq.com".into(),
                    as_of_utc: "2026-11-22T00:00:00.000Z".into(),
                    delayed: true,
                })
            },
        )
        .await
        .expect("partial batch succeeds");
        assert_eq!(partial.quotes.len(), 2);
        assert_eq!(partial.failed_symbols, vec!["00700.HK"]);
        assert!(partial
            .last_error
            .as_deref()
            .unwrap_or("")
            .contains("upstream 503"));

        // Total batch timeout aborts hung requests cleanly.
        let timed_out = run_bounded_batch_outcome(
            vec!["AAPL".to_string(), "MSFT".to_string()],
            2,
            Duration::from_millis(40),
            |_symbol| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Err(QuoteError::Network("never reached".to_string()))
            },
        )
        .await;
        assert_eq!(timed_out, Err(QuoteError::BatchTimeout));
    }

    #[test]
    fn enforces_read_only_benchmark_allowlist_and_parses_history_with_exact_i128_micros() {
        assert_eq!(validate_benchmark_symbol("spy"), Ok(("SPY", "USD")));
        assert_eq!(validate_benchmark_symbol("QQQ"), Ok(("QQQ", "USD")));
        assert_eq!(validate_benchmark_symbol("2800.HK"), Ok(("2800.HK", "HKD")));
        assert_eq!(
            validate_benchmark_symbol("510300.SS"),
            Ok(("510300.SS", "CNY"))
        );

        // Non-allowlisted symbols, arbitrary URLs, and injection attempts are rejected Fail-Closed.
        assert!(validate_benchmark_symbol("AAPL").is_err());
        assert!(validate_benchmark_symbol("https://evil.example/spy").is_err());
        assert!(validate_benchmark_symbol("SPY&token=leak").is_err());

        let stooq_hist = "Date,Open,High,Low,Close,Volume\n2026-11-19,20.00,20.40,19.90,20.25,1000\n2026-11-20,20.30,20.80,20.20,20.60,1200\n";
        let hk_series =
            parse_stooq_history_csv("2800.HK", "HKD", stooq_hist, "2026-11-22T00:00:00.000Z")
                .expect("parse stooq history");
        assert_eq!(hk_series.symbol, "2800.HK");
        assert_eq!(hk_series.currency, "HKD");
        assert_eq!(hk_series.points.len(), 2);
        assert_eq!(hk_series.points[0].date, "2026-11-19");
        assert_eq!(hk_series.points[0].close_micros, 20_250_000);
        assert_eq!(hk_series.points[1].close_micros, 20_600_000);

        let yahoo_hist = r#"{"chart":{"result":[{"timestamp":[1763510400,1763596800],"indicators":{"quote":[{"close":[580.125,null]}]}}]}}"#;
        let spy_series =
            parse_yahoo_history_json("SPY", "USD", yahoo_hist, "2026-11-22T00:00:00.000Z")
                .expect("parse yahoo history");
        assert_eq!(spy_series.symbol, "SPY");
        assert_eq!(spy_series.points.len(), 1);
        assert_eq!(spy_series.points[0].close_micros, 580_125_000);
    }
}
