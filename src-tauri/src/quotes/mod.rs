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

use chrono::{SecondsFormat, Utc};
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use thiserror::Error;
use tokio::{sync::Semaphore, task::JoinSet, time::timeout};

use crate::storage::CachedPublicQuote;

pub const ALLOWED_QUOTE_HOSTS: &[&str] = &["stooq.com", "query1.finance.yahoo.com"];
pub const MAX_QUOTE_SYMBOLS: usize = 50;
pub const QUOTE_TIMEOUT_SECS: u64 = 7;
pub const BATCH_QUOTE_TIMEOUT_SECS: u64 = 20;
pub const MAX_QUOTE_RESPONSE_BYTES: usize = 512 * 1024;
pub const MAX_CONCURRENT_QUOTE_REQUESTS: usize = 4;

const FIXED_SCALE: u32 = 8;
const FIXED_FACTOR: i128 = 100_000_000;

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
    let valid_symbols = validate_quote_symbols(symbols)?;
    let client = build_read_only_client()?;
    let now_utc = Arc::new(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));

    run_bounded_batch(
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

async fn run_bounded_batch<F, Fut>(
    symbols: Vec<String>,
    max_concurrency: usize,
    total_timeout: Duration,
    fetcher: F,
) -> Result<Vec<CachedPublicQuote>, QuoteError>
where
    F: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<CachedPublicQuote, QuoteError>> + Send + 'static,
{
    let semaphore = Arc::new(Semaphore::new(max_concurrency.max(1)));
    let fetcher = Arc::new(fetcher);
    let mut join_set = JoinSet::new();

    for (index, symbol) in symbols.into_iter().enumerate() {
        let permit_pool = Arc::clone(&semaphore);
        let fetcher = Arc::clone(&fetcher);
        join_set.spawn(async move {
            let _permit = permit_pool
                .acquire_owned()
                .await
                .map_err(|_| QuoteError::Network("quote concurrency limiter closed".to_string()))?;
            let result = fetcher(symbol).await;
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

    Ok(ordered_results.into_values().collect())
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
    // Stooq uses lowercase ticker with `.us` suffix for US equities and `-` for dots (e.g. brk-b.us).
    let stooq_ticker = format!("{}.us", symbol.to_ascii_lowercase().replace('.', "-"));
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
    let _header = lines
        .next()
        .ok_or_else(|| QuoteError::Parse("empty stooq CSV response".to_string()))?;
    let data_line = lines
        .next()
        .ok_or_else(|| QuoteError::Parse("missing stooq data row".to_string()))?;
    let cols: Vec<&str> = data_line.split(',').map(str::trim).collect();
    if cols.len() < 7 {
        return Err(QuoteError::Parse(
            "unexpected stooq CSV columns".to_string(),
        ));
    }

    let date_col = cols[1];
    let time_col = cols[2];
    let open_col = cols[3];
    let close_col = cols[6];

    if close_col.eq_ignore_ascii_case("N/D") || close_col.is_empty() {
        return Err(QuoteError::Parse(format!(
            "no delayed quote available on stooq for {requested_symbol}"
        )));
    }

    let close_fixed = parse_positive_fixed_decimal(close_col)?;
    let open_fixed = parse_positive_fixed_decimal(open_col).unwrap_or(close_fixed);
    let change_fixed = close_fixed
        .checked_sub(open_fixed)
        .ok_or_else(|| QuoteError::Parse("quote change overflow".to_string()))?;
    let change_pct_fixed = compute_change_pct_fixed(change_fixed, open_fixed)?;

    let as_of_utc = if date_col.len() == 10 && time_col.len() >= 8 && date_col != "N/D" {
        format!("{date_col}T{time_col}Z")
    } else {
        fallback_as_of_utc.to_string()
    };

    Ok(CachedPublicQuote {
        symbol: requested_symbol.to_string(),
        price: format_fixed(close_fixed, 4),
        change: format_fixed(change_fixed, 4),
        change_pct: format_fixed(change_pct_fixed, 2),
        currency: "USD".to_string(),
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
    let yahoo_ticker = symbol.replace('.', "-");
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
            .unwrap_or_else(|| "USD".to_string()),
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
    let half = denominator.abs() / 2;
    let adjusted = if (scaled >= 0) == (denominator > 0) {
        scaled.checked_add(if scaled >= 0 { half } else { -half })
    } else {
        scaled.checked_sub(if scaled >= 0 { half } else { -half })
    }
    .ok_or_else(|| QuoteError::Parse("fixed-point rounding overflow".to_string()))?;
    Ok(adjusted / denominator)
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
    fn parses_stooq_csv_and_yahoo_chart_responses_with_exact_fixed_point_math() {
        let stooq_csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-11-21,22:00:00,225.00,229.00,224.50,228.50,42100000\n";
        let quote =
            parse_stooq_csv_response("AAPL", stooq_csv, "2026-11-22T00:00:00.000Z").expect("parse");
        assert_eq!(quote.symbol, "AAPL");
        assert_eq!(quote.price, "228.5000");
        assert_eq!(quote.change, "3.5000");
        assert_eq!(quote.change_pct, "1.56");
        assert_eq!(quote.provider, "stooq.com");
        assert!(quote.delayed);

        // Exact decimal test without IEEE-754 drift (0.30 - 0.10 == 0.20 exactly, not 0.19999999999999998)
        let exact_csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nPENNY.US,2026-11-21,22:00:00,0.10,0.30,0.10,0.30,100\n";
        let exact = parse_stooq_csv_response("PENNY", exact_csv, "2026-11-22T00:00:00.000Z")
            .expect("exact parse");
        assert_eq!(exact.price, "0.3000");
        assert_eq!(exact.change, "0.2000");
        assert_eq!(exact.change_pct, "200.00");

        // Yahoo JSON including scientific notation number token
        let yahoo_json = r#"{"chart":{"result":[{"meta":{"regularMarketPrice":4.1525e2,"chartPreviousClose":410.0,"currency":"USD","regularMarketTime":1763760000}}]}}"#;
        let y_quote =
            parse_yahoo_chart_response("MSFT", yahoo_json, "2026-11-22T00:00:00.000Z").expect("y");
        assert_eq!(y_quote.symbol, "MSFT");
        assert_eq!(y_quote.price, "415.2500");
        assert_eq!(y_quote.change, "5.2500");
        assert_eq!(y_quote.change_pct, "1.28");
        assert_eq!(y_quote.provider, "query1.finance.yahoo.com");
        assert!(y_quote.delayed);
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
    async fn enforces_bounded_concurrency_and_total_batch_timeout() {
        let symbols: Vec<String> = (1..=12).map(|i| format!("SYM{i}")).collect();
        let active = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let active_clone = Arc::clone(&active);
        let max_clone = Arc::clone(&max_seen);
        let results = run_bounded_batch(
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

        assert_eq!(results.len(), 12);
        assert_eq!(results[0].symbol, "SYM1");
        assert_eq!(results[11].symbol, "SYM12");
        assert!(max_seen.load(Ordering::SeqCst) <= MAX_CONCURRENT_QUOTE_REQUESTS);

        // Total batch timeout aborts hung requests cleanly.
        let timed_out = run_bounded_batch(
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
}
