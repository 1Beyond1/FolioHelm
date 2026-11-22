//! Optional, read-only delayed public market quote adapter.
//!
//! Security boundaries:
//! - Disabled by default; invoked only on explicit user opt-in / manual refresh.
//! - Strict HTTPS host allowlist (`stooq.com`, `query1.finance.yahoo.com`),
//!   with redirects disabled so responses cannot escape the allowlist.
//! - Zero credentials, zero cookies, zero Authorization headers, zero account IDs.
//! - Strict ticker validation (`^[A-Z0-9][A-Z0-9.-]{0,9}$`, max 50 symbols per batch).
//! - Request timeout <= 7 seconds; network failures gracefully fall back to the
//!   encrypted SQLite quote cache or CSV-imported baseline price.

use std::{collections::BTreeSet, time::Duration};

use chrono::{SecondsFormat, Utc};
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::storage::CachedPublicQuote;

pub const ALLOWED_QUOTE_HOSTS: &[&str] = &["stooq.com", "query1.finance.yahoo.com"];
pub const MAX_QUOTE_SYMBOLS: usize = 50;
pub const QUOTE_TIMEOUT_SECS: u64 = 7;

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
    let now_utc = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut results = Vec::new();
    let mut last_error: Option<QuoteError> = None;

    for symbol in &valid_symbols {
        let fetched = match provider {
            PublicQuoteProvider::Stooq => fetch_stooq_symbol(&client, symbol, &now_utc).await,
            PublicQuoteProvider::Yahoo => fetch_yahoo_symbol(&client, symbol, &now_utc).await,
        };
        match fetched {
            Ok(quote) => results.push(quote),
            Err(error) => last_error = Some(error),
        }
    }

    if results.is_empty() {
        return Err(last_error.unwrap_or_else(|| {
            QuoteError::Network("no public quotes could be retrieved".to_string())
        }));
    }
    Ok(results)
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
    let body = response
        .text()
        .await
        .map_err(|error| QuoteError::Network(error.to_string()))?;

    parse_stooq_csv_response(symbol, &body, fetched_at_utc)
}

pub fn parse_stooq_csv_response(
    requested_symbol: &str,
    body: &str,
    fallback_as_of_utc: &str,
) -> Result<CachedPublicQuote, QuoteError> {
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

    let close_price = parse_positive_decimal_str(close_col)?;
    let open_price = parse_positive_decimal_str(open_col).unwrap_or(close_price);
    let change = close_price - open_price;
    let change_pct = if open_price > 0.0 {
        (change / open_price) * 100.0
    } else {
        0.0
    };

    let as_of_utc = if date_col.len() == 10 && time_col.len() >= 8 && date_col != "N/D" {
        format!("{date_col}T{time_col}Z")
    } else {
        fallback_as_of_utc.to_string()
    };

    Ok(CachedPublicQuote {
        symbol: requested_symbol.to_string(),
        price: format!("{close_price:.4}"),
        change: format!("{change:.4}"),
        change_pct: format!("{change_pct:.2}"),
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
    let body = response
        .text()
        .await
        .map_err(|error| QuoteError::Network(error.to_string()))?;

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
    regular_market_price: Option<f64>,
    chart_previous_close: Option<f64>,
    previous_close: Option<f64>,
    currency: Option<String>,
    regular_market_time: Option<i64>,
}

pub fn parse_yahoo_chart_response(
    requested_symbol: &str,
    body: &str,
    fallback_as_of_utc: &str,
) -> Result<CachedPublicQuote, QuoteError> {
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

    let price_val = meta
        .regular_market_price
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| QuoteError::Parse("invalid yahoo regularMarketPrice".to_string()))?;

    let prev_close = meta
        .chart_previous_close
        .or(meta.previous_close)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(price_val);

    let change = price_val - prev_close;
    let change_pct = if prev_close > 0.0 {
        (change / prev_close) * 100.0
    } else {
        0.0
    };

    let as_of_utc = meta
        .regular_market_time
        .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| fallback_as_of_utc.to_string());

    Ok(CachedPublicQuote {
        symbol: requested_symbol.to_string(),
        price: format!("{price_val:.4}"),
        change: format!("{change:.4}"),
        change_pct: format!("{change_pct:.2}"),
        currency: meta.currency.unwrap_or_else(|| "USD".to_string()),
        provider: PublicQuoteProvider::Yahoo.code().to_string(),
        as_of_utc,
        delayed: true,
    })
}

fn parse_positive_decimal_str(raw: &str) -> Result<f64, QuoteError> {
    let val: f64 = raw
        .trim()
        .parse()
        .map_err(|_| QuoteError::Parse(format!("invalid numeric quote: {raw}")))?;
    if !val.is_finite() || val <= 0.0 {
        return Err(QuoteError::Parse(format!(
            "non-positive or non-finite quote: {raw}"
        )));
    }
    Ok(val)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_strict_https_allowlist_and_blocks_http_or_foreign_hosts() {
        assert!(validate_allowlisted_https_url(
            "https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv"
        )
        .is_ok());
        assert!(validate_allowlisted_https_url(
            "https://query1.finance.yahoo.com/v8/finance/chart/AAPL"
        )
        .is_ok());

        assert!(validate_allowlisted_https_url("http://stooq.com/q/l/?s=aapl.us").is_err());
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
    fn parses_stooq_csv_and_yahoo_chart_responses_deterministically() {
        let stooq_csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-11-21,22:00:00,225.00,229.00,224.50,228.50,42100000\n";
        let quote =
            parse_stooq_csv_response("AAPL", stooq_csv, "2026-11-22T00:00:00.000Z").expect("parse");
        assert_eq!(quote.symbol, "AAPL");
        assert_eq!(quote.price, "228.5000");
        assert_eq!(quote.change, "3.5000");
        assert_eq!(quote.provider, "stooq.com");
        assert!(quote.delayed);

        let yahoo_json = r#"{"chart":{"result":[{"meta":{"regularMarketPrice":415.25,"chartPreviousClose":410.0,"currency":"USD","regularMarketTime":1763760000}}]}}"#;
        let y_quote =
            parse_yahoo_chart_response("MSFT", yahoo_json, "2026-11-22T00:00:00.000Z").expect("y");
        assert_eq!(y_quote.symbol, "MSFT");
        assert_eq!(y_quote.price, "415.2500");
        assert_eq!(y_quote.change, "5.2500");
        assert_eq!(y_quote.provider, "query1.finance.yahoo.com");
        assert!(y_quote.delayed);
    }
}
