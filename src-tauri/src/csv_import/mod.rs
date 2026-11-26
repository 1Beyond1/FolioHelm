//! Safe, deterministic brokerage CSV parser & normalizer for FolioHelm.
//!
//! Supported formats:
//! - Charles Schwab Positions CSV & Transactions CSV
//! - Interactive Brokers (IBKR) Activity / Positions CSV (both multi-section and flat exports)
//! - Fidelity Positions CSV
//! - Vanguard Positions CSV
//! - Futu / Moomoo (富途) Positions CSV (EN / ZH)
//! - Tiger Brokers (老虎证券) Positions CSV (EN / ZH)
//! - Generic standard CSV (`symbol, quantity, average_cost, price, cash, currency, date, action`)
//!
//! Security guarantees:
//! - Hard byte limit (5 MiB) and row limit (10,000 rows) to prevent memory exhaustion.
//! - CSV formula injection sanitization (strips leading `=`, `+`, `-`, `@`, `\t`, `\r` on text cells).
//! - Exact fixed-point decimal arithmetic (10^8 scale via `i128`, zero IEEE-754 float math).
//! - Strict symbol validation (`^[A-Z0-9][A-Z0-9.-]{0,9}$`) and non-negative share quantities.
//! - Multi-currency fail-safe isolation: balances and market values are grouped per currency
//!   and NEVER summed across different currencies without verified FX rates.
//! - Deterministic SHA-256 fingerprint for idempotent imports (re-importing never doubles positions).

use std::collections::{BTreeMap, BTreeSet};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    evidence::encode_hex,
    storage::{
        StoredPortfolioHolding, StoredPortfolioSnapshot, StoredPortfolioTransaction,
        DEFAULT_ACCOUNT_ID,
    },
};

pub const MAX_CSV_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_CSV_ROWS: usize = 10_000;

const FIXED_SCALE: u32 = 8;
const FIXED_FACTOR: i128 = 100_000_000;

const SYMBOL_ALIASES: &[&str] = &[
    "symbol",
    "ticker",
    "code",
    "stock code",
    "contract",
    "代码",
    "股票代码",
    "标的",
    "标的代码",
    "合约代码",
];

const COMPANY_ALIASES: &[&str] = &[
    "description",
    "company",
    "name",
    "security description",
    "investment name",
    "fund name",
    "security name",
    "stock name",
    "contract name",
    "名称",
    "股票名称",
    "标的名称",
];

const QUANTITY_ALIASES: &[&str] = &[
    "quantity",
    "qty",
    "shares",
    "position",
    "holding qty",
    "holdings",
    "持有数量",
    "持仓数量",
    "持仓",
    "数量",
];

const PRICE_ALIASES: &[&str] = &[
    "price",
    "last",
    "last price",
    "share price",
    "current price",
    "latest price",
    "markprice",
    "mark price",
    "close price",
    "market price",
    "现价",
    "最新价",
    "市价",
    "收盘价",
];

const AVG_COST_ALIASES: &[&str] = &[
    "average_cost",
    "average cost",
    "average cost basis",
    "cost basis per share",
    "avg_cost",
    "avg cost",
    "avg price",
    "costbasisprice",
    "cost basis price",
    "cost price",
    "diluted cost",
    "cost/share",
    "成本价",
    "稀释成本价",
    "平均成本价",
    "平均成本",
    "持仓均价",
    "均价",
];

const COST_BASIS_ALIASES: &[&str] = &[
    "cost basis",
    "cost_basis",
    "costbasis",
    "cost basis total",
    "total cost basis",
    "总成本",
    "持仓成本",
];

const MARKET_VALUE_ALIASES: &[&str] = &[
    "market value",
    "market_value",
    "mkt val",
    "mkt val (market value)",
    "current value",
    "total value",
    "持仓市值",
    "参考市值",
    "市值",
];

const CURRENCY_ALIASES: &[&str] = &["currency", "ccy", "币种", "货币", "结算币种"];

const CASH_COL_ALIASES: &[&str] = &[
    "cash",
    "cash balance",
    "cash_balance",
    "现金",
    "现金余额",
    "可用现金",
    "账户现金",
];

const CASH_ROW_VALUE_ALIASES: &[&str] = &[
    "market value",
    "market_value",
    "mkt val",
    "mkt val (market value)",
    "current value",
    "total value",
    "amount",
    "cash",
    "price",
    "value",
    "市值",
    "持仓市值",
    "参考市值",
    "现金",
    "可用现金",
    "账户现金",
];

const SECURITY_TYPE_ALIASES: &[&str] = &[
    "asset category",
    "security type",
    "asset class",
    "type",
    "资产类别",
    "证券类型",
    "品种",
];

#[derive(Debug, Error, Eq, PartialEq)]
pub enum CsvImportError {
    #[error("CSV payload is empty")]
    EmptyInput,
    #[error("CSV file exceeds the 5 MB safety limit ({actual} bytes)")]
    FileTooLarge { actual: usize },
    #[error("CSV file exceeds the {MAX_CSV_ROWS} row safety limit")]
    TooManyRows,
    #[error(
        "could not detect a supported header row (Schwab, IBKR, Fidelity, Vanguard, Futu, Tiger, or standard CSV)"
    )]
    UnrecognizedFormat,
    #[error("invalid decimal value in row {row}, column '{column}': {value}")]
    InvalidDecimal {
        row: usize,
        column: String,
        value: String,
    },
    #[error("invalid symbol in row {row}: {value}")]
    InvalidSymbol { row: usize, value: String },
    #[error("negative holding quantity is not allowed in row {row} for {symbol}")]
    NegativeQuantity { row: usize, symbol: String },
    #[error("negative {column} is not allowed in row {row} for {symbol}")]
    NegativeValue {
        row: usize,
        column: String,
        symbol: String,
    },
    #[error("no valid holdings, cash balances, or transactions were found in the CSV")]
    NoUsableData,
    #[error("decimal arithmetic overflow while normalizing CSV data")]
    ArithmeticOverflow,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvColumnMappingDto {
    pub canonical_field: String,
    pub source_header: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvCurrencySubtotalDto {
    pub currency: String,
    /// Exact decimal string.
    pub holdings_value: String,
    /// Exact decimal string.
    pub cash: String,
    /// Exact decimal string (`holdings_value + cash` within this single currency).
    pub total_value: String,
    pub holdings_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportPreviewDto {
    pub detected_format: String,
    pub format_label_en: String,
    pub format_label_zh: String,
    pub column_mappings: Vec<CsvColumnMappingDto>,
    pub row_count: usize,
    pub skipped_rows: usize,
    pub already_imported: bool,
    pub warnings: Vec<String>,
    pub currency_subtotals: Vec<CsvCurrencySubtotalDto>,
    pub snapshot: StoredPortfolioSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvCommitResultDto {
    pub deduplicated: bool,
    pub evidence_sequence: Option<u64>,
    pub snapshot: StoredPortfolioSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DetectedFormat {
    SchwabPositions,
    SchwabTransactions,
    IbkrActivity,
    IbkrPositions,
    FidelityPositions,
    VanguardPositions,
    FutuPositions,
    TigerPositions,
    GenericStandard,
}

impl DetectedFormat {
    fn code(self) -> &'static str {
        match self {
            Self::SchwabPositions => "schwab_positions",
            Self::SchwabTransactions => "schwab_transactions",
            Self::IbkrActivity => "ibkr_activity",
            Self::IbkrPositions => "ibkr_positions",
            Self::FidelityPositions => "fidelity_positions",
            Self::VanguardPositions => "vanguard_positions",
            Self::FutuPositions => "futu_positions",
            Self::TigerPositions => "tiger_positions",
            Self::GenericStandard => "generic_csv",
        }
    }

    fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::SchwabPositions => ("Charles Schwab Positions CSV", "嘉信理财持仓 CSV"),
            Self::SchwabTransactions => ("Charles Schwab Transactions CSV", "嘉信理财交易流水 CSV"),
            Self::IbkrActivity => ("IBKR Activity Statement CSV", "盈透证券活动报表 CSV"),
            Self::IbkrPositions => ("IBKR Positions CSV", "盈透证券持仓 CSV"),
            Self::FidelityPositions => ("Fidelity Positions CSV", "富达 (Fidelity) 持仓 CSV"),
            Self::VanguardPositions => ("Vanguard Positions CSV", "先锋领航 (Vanguard) 持仓 CSV"),
            Self::FutuPositions => ("Futu / Moomoo Positions CSV", "富途 (Futu) 持仓 CSV"),
            Self::TigerPositions => ("Tiger Brokers Positions CSV", "老虎证券 (Tiger) 持仓 CSV"),
            Self::GenericStandard => ("Standard Portfolio CSV", "通用标准持仓 CSV"),
        }
    }
}

/// Parse, sanitize, and normalize a brokerage CSV without persisting it.
pub fn parse_and_preview_csv(
    raw_csv: &str,
    source_label: &str,
    already_imported: bool,
) -> Result<CsvImportPreviewDto, CsvImportError> {
    if raw_csv.is_empty() || raw_csv.trim().is_empty() {
        return Err(CsvImportError::EmptyInput);
    }
    if raw_csv.len() > MAX_CSV_BYTES {
        return Err(CsvImportError::FileTooLarge {
            actual: raw_csv.len(),
        });
    }

    let cleaned_input = raw_csv.strip_prefix('\u{feff}').unwrap_or(raw_csv);
    let rows = parse_csv_rows(cleaned_input)?;
    if rows.len() > MAX_CSV_ROWS {
        return Err(CsvImportError::TooManyRows);
    }

    let mut warnings = Vec::new();
    let safe_source_label = sanitize_text_cell(source_label, "filename", &mut warnings);

    let (format, mappings, holdings, transactions, cash_by_currency_fixed, skipped_rows) =
        if is_ibkr_multi_section(&rows) {
            parse_ibkr_multi_section(&rows, &mut warnings)?
        } else {
            parse_tabular_csv(&rows, &mut warnings)?
        };

    let has_any_cash = cash_by_currency_fixed.values().any(|&v| v != 0);
    if holdings.is_empty() && transactions.is_empty() && !has_any_cash {
        return Err(CsvImportError::NoUsableData);
    }

    let mut sorted_holdings = holdings;
    sorted_holdings.sort_by(|a, b| {
        a.symbol
            .cmp(&b.symbol)
            .then_with(|| a.currency.cmp(&b.currency))
    });
    let mut sorted_transactions = transactions;
    sorted_transactions.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| tx_action_replay_rank(&a.action).cmp(&tx_action_replay_rank(&b.action)))
            .then_with(|| a.symbol.cmp(&b.symbol))
            .then_with(|| a.action.cmp(&b.action))
            .then_with(|| a.quantity.cmp(&b.quantity))
    });

    let mut currency_set = BTreeSet::new();
    for h in &sorted_holdings {
        currency_set.insert(h.currency.clone());
    }
    for (curr, &amount) in &cash_by_currency_fixed {
        if amount != 0 {
            currency_set.insert(curr.clone());
        }
    }
    if currency_set.is_empty() {
        for t in &sorted_transactions {
            currency_set.insert(t.currency.clone());
        }
    }
    if currency_set.is_empty() {
        currency_set.insert("USD".to_string());
    }

    let currencies: Vec<String> = currency_set.into_iter().collect();
    let is_multi_currency = currencies.len() > 1;
    let primary_currency = if is_multi_currency {
        "MULTI".to_string()
    } else {
        currencies[0].clone()
    };

    let mut cash_by_currency: BTreeMap<String, String> = BTreeMap::new();
    for curr in &currencies {
        let amt = cash_by_currency_fixed.get(curr).copied().unwrap_or(0);
        cash_by_currency.insert(curr.clone(), format_fixed(amt, 2));
    }

    let cash_str = if is_multi_currency {
        warnings.push(format!(
            "Multi-currency CSV detected ({}): balances and valuations are isolated by currency with no FX conversion",
            currencies.join(", ")
        ));
        "0.00".to_string()
    } else {
        cash_by_currency
            .get(&primary_currency)
            .cloned()
            .unwrap_or_else(|| "0.00".to_string())
    };

    let currency_subtotals =
        compute_currency_subtotals(&currencies, &sorted_holdings, &cash_by_currency_fixed)?;

    let fingerprint = compute_snapshot_fingerprint(
        format.code(),
        &primary_currency,
        &cash_str,
        &cash_by_currency,
        &sorted_holdings,
        &sorted_transactions,
    );

    let (label_en, label_zh) = format.labels();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let short_fp = &fingerprint[..16];

    let snapshot = StoredPortfolioSnapshot {
        id: format!("csv-{short_fp}"),
        account_id: DEFAULT_ACCOUNT_ID.to_string(),
        fingerprint,
        source_format: format.code().to_string(),
        source_label: if safe_source_label.is_empty() {
            "imported.csv".to_string()
        } else {
            safe_source_label
        },
        imported_at_utc: now,
        account_label: "Local Portfolio (CSV + Paper)".to_string(),
        currency: primary_currency,
        cash: cash_str,
        cash_by_currency,
        currencies,
        is_multi_currency,
        holdings: sorted_holdings,
        transactions: sorted_transactions,
        warnings: warnings.clone(),
    };

    Ok(CsvImportPreviewDto {
        detected_format: format.code().to_string(),
        format_label_en: label_en.to_string(),
        format_label_zh: label_zh.to_string(),
        column_mappings: mappings,
        row_count: rows.len(),
        skipped_rows,
        already_imported,
        warnings,
        currency_subtotals,
        snapshot,
    })
}

/// Scopes a parsed `StoredPortfolioSnapshot` to a specific target account while keeping
/// the default account's deterministic fingerprint backward-compatible.
pub fn scope_snapshot_to_account(
    snapshot: &mut StoredPortfolioSnapshot,
    account_id: Option<&str>,
    account_label: Option<&str>,
) {
    let target_id = account_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_ACCOUNT_ID);
    snapshot.account_id = target_id.to_string();
    if let Some(label) = account_label.map(str::trim).filter(|s| !s.is_empty()) {
        snapshot.account_label = label.chars().filter(|c| !c.is_control()).take(80).collect();
    }
    if target_id != DEFAULT_ACCOUNT_ID {
        let mut hasher = Sha256::new();
        hasher.update(b"foliohelm/account-snapshot/v1|");
        hasher.update(target_id.as_bytes());
        hasher.update(b"|");
        hasher.update(snapshot.fingerprint.as_bytes());
        let scoped_fp = encode_hex(&hasher.finalize());
        let short_fp = &scoped_fp[..16];
        snapshot.id = format!("csv-{short_fp}");
        snapshot.fingerprint = scoped_fp;
    }
}

fn compute_currency_subtotals(
    currencies: &[String],
    holdings: &[StoredPortfolioHolding],
    cash_by_currency_fixed: &BTreeMap<String, i128>,
) -> Result<Vec<CsvCurrencySubtotalDto>, CsvImportError> {
    let mut out = Vec::with_capacity(currencies.len());
    for curr in currencies {
        let mut mv_sum: i128 = 0;
        let mut count = 0_usize;
        for h in holdings.iter().filter(|h| &h.currency == curr) {
            let qty = parse_decimal_fixed(&h.quantity, 0, "Quantity")?;
            let px = parse_decimal_fixed(&h.last_price, 0, "Price")?;
            let mv = fixed_mul(qty, px)?;
            mv_sum = mv_sum
                .checked_add(mv)
                .ok_or(CsvImportError::ArithmeticOverflow)?;
            count += 1;
        }
        let cash = cash_by_currency_fixed.get(curr).copied().unwrap_or(0);
        let total = mv_sum
            .checked_add(cash)
            .ok_or(CsvImportError::ArithmeticOverflow)?;
        out.push(CsvCurrencySubtotalDto {
            currency: curr.clone(),
            holdings_value: format_fixed(mv_sum, 2),
            cash: format_fixed(cash, 2),
            total_value: format_fixed(total, 2),
            holdings_count: count,
        });
    }
    Ok(out)
}

fn is_ibkr_multi_section(rows: &[Vec<String>]) -> bool {
    rows.iter().any(|row| {
        row.len() >= 4
            && matches!(
                row[0].trim().to_ascii_lowercase().as_str(),
                "positions" | "open positions" | "trades" | "cash report"
            )
            && row[1].trim().eq_ignore_ascii_case("header")
    })
}

type ParsedCsvResult = (
    DetectedFormat,
    Vec<CsvColumnMappingDto>,
    Vec<StoredPortfolioHolding>,
    Vec<StoredPortfolioTransaction>,
    BTreeMap<String, i128>,
    usize,
);

fn add_cash(
    map: &mut BTreeMap<String, i128>,
    currency: &str,
    amount: i128,
) -> Result<(), CsvImportError> {
    let entry = map.entry(currency.to_string()).or_insert(0);
    *entry = entry
        .checked_add(amount)
        .ok_or(CsvImportError::ArithmeticOverflow)?;
    Ok(())
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum IbkrTradeDiscriminator {
    Order,
    Trade,
    Untagged,
}

fn normalize_ibkr_discriminator(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '-' && *ch != '_')
        .collect::<String>()
        .to_ascii_lowercase()
}

fn parse_ibkr_multi_section(
    rows: &[Vec<String>],
    warnings: &mut Vec<String>,
) -> Result<ParsedCsvResult, CsvImportError> {
    let mut pos_headers: Option<Vec<String>> = None;
    let mut trade_headers: Option<Vec<String>> = None;
    let mut cash_headers: Option<Vec<String>> = None;
    let mut mappings = Vec::new();
    let mut holdings_map: BTreeMap<(String, String), HoldingAccumulator> = BTreeMap::new();
    let mut raw_trades: Vec<(IbkrTradeDiscriminator, StoredPortfolioTransaction)> = Vec::new();
    let mut cash_by_currency: BTreeMap<String, i128> = BTreeMap::new();
    let mut skipped_rows = 0_usize;

    for (idx, row) in rows.iter().enumerate() {
        let row_num = idx + 1;
        if row.len() < 3 {
            skipped_rows += 1;
            continue;
        }
        let section = row[0].trim().to_ascii_lowercase();
        let row_type = row[1].trim().to_ascii_lowercase();

        if row_type == "header" {
            let hdrs: Vec<String> = row[2..].iter().map(|s| s.trim().to_string()).collect();
            match section.as_str() {
                "positions" | "open positions" => {
                    collect_mappings(&hdrs, &mut mappings);
                    pos_headers = Some(hdrs);
                }
                "trades" => {
                    collect_mappings(&hdrs, &mut mappings);
                    trade_headers = Some(hdrs);
                }
                "cash report" => {
                    cash_headers = Some(hdrs);
                }
                _ => {}
            }
            continue;
        }

        if row_type != "data" {
            skipped_rows += 1;
            continue;
        }

        let values = &row[2..];
        match section.as_str() {
            "positions" | "open positions" => {
                let Some(headers) = pos_headers.as_ref() else {
                    skipped_rows += 1;
                    continue;
                };
                if let Some(discriminator) =
                    find_cell(headers, values, &["datadiscriminator", "header"])
                {
                    if discriminator.eq_ignore_ascii_case("total")
                        || discriminator.eq_ignore_ascii_case("subtotal")
                    {
                        skipped_rows += 1;
                        continue;
                    }
                }
                let raw_symbol = find_cell(headers, values, SYMBOL_ALIASES).unwrap_or("");
                if is_summary_or_blank_symbol(raw_symbol) {
                    skipped_rows += 1;
                    continue;
                }
                if is_option_row(headers, values, raw_symbol) {
                    warnings.push(format!(
                        "Skipped unsupported option/derivative row {row_num} ({})",
                        raw_symbol.trim().chars().take(32).collect::<String>()
                    ));
                    skipped_rows += 1;
                    continue;
                }
                let symbol = validate_symbol(raw_symbol, row_num)?;
                let qty_raw = find_cell(headers, values, QUANTITY_ALIASES).ok_or_else(|| {
                    CsvImportError::InvalidDecimal {
                        row: row_num,
                        column: "Quantity".into(),
                        value: String::new(),
                    }
                })?;
                if is_na_placeholder(qty_raw) {
                    skipped_rows += 1;
                    continue;
                }
                let qty_fixed = parse_decimal_fixed(qty_raw, row_num, "Quantity")?;
                if qty_fixed < 0 {
                    return Err(CsvImportError::NegativeQuantity {
                        row: row_num,
                        symbol,
                    });
                }
                if qty_fixed == 0 {
                    skipped_rows += 1;
                    continue;
                }

                let cost_price_opt = find_cell(headers, values, AVG_COST_ALIASES)
                    .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v));
                let cost_basis_opt = find_cell(headers, values, COST_BASIS_ALIASES)
                    .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v));
                let mark_price_opt = find_cell(headers, values, PRICE_ALIASES)
                    .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v));

                let last_price_fixed = match mark_price_opt {
                    Some(v) => {
                        let parsed = parse_decimal_fixed(v, row_num, "Close Price")?;
                        if parsed < 0 {
                            return Err(CsvImportError::NegativeValue {
                                row: row_num,
                                column: "last_price".into(),
                                symbol,
                            });
                        }
                        parsed
                    }
                    None => 0,
                };
                let avg_cost_fixed = if let Some(v) = cost_price_opt {
                    let parsed = parse_decimal_fixed(v, row_num, "Cost Price")?;
                    if parsed < 0 {
                        return Err(CsvImportError::NegativeValue {
                            row: row_num,
                            column: "average_cost".into(),
                            symbol,
                        });
                    }
                    parsed
                } else if let Some(v) = cost_basis_opt {
                    let basis = parse_decimal_fixed(v, row_num, "Cost Basis")?;
                    if basis < 0 {
                        return Err(CsvImportError::NegativeValue {
                            row: row_num,
                            column: "average_cost".into(),
                            symbol,
                        });
                    }
                    fixed_div(basis, qty_fixed)?
                } else {
                    last_price_fixed
                };
                let effective_last = if last_price_fixed > 0 {
                    last_price_fixed
                } else {
                    avg_cost_fixed
                };

                let company_raw = find_cell(headers, values, COMPANY_ALIASES).unwrap_or("");
                let company = sanitize_text_cell(company_raw, "Description", warnings);
                let currency = normalize_currency(
                    find_cell(headers, values, CURRENCY_ALIASES).unwrap_or("USD"),
                );

                accumulate_holding(
                    &mut holdings_map,
                    symbol,
                    company,
                    qty_fixed,
                    avg_cost_fixed,
                    effective_last,
                    currency,
                )?;
            }
            "trades" => {
                let Some(headers) = trade_headers.as_ref() else {
                    skipped_rows += 1;
                    continue;
                };
                let discriminator_kind = if let Some(raw_disc) =
                    find_cell(headers, values, &["datadiscriminator", "header"])
                {
                    match normalize_ibkr_discriminator(raw_disc).as_str() {
                        "subtotal" | "total" | "closedlot" | "washsale" => {
                            skipped_rows += 1;
                            continue;
                        }
                        "order" => IbkrTradeDiscriminator::Order,
                        "trade" => IbkrTradeDiscriminator::Trade,
                        _ => IbkrTradeDiscriminator::Untagged,
                    }
                } else {
                    IbkrTradeDiscriminator::Untagged
                };
                let raw_symbol = find_cell(headers, values, SYMBOL_ALIASES).unwrap_or("");
                if is_summary_or_blank_symbol(raw_symbol) {
                    skipped_rows += 1;
                    continue;
                }
                if is_option_row(headers, values, raw_symbol) {
                    warnings.push(format!(
                        "Skipped unsupported option/derivative row {row_num} ({})",
                        raw_symbol.trim().chars().take(32).collect::<String>()
                    ));
                    skipped_rows += 1;
                    continue;
                }
                let symbol = validate_symbol(raw_symbol, row_num)?;
                let qty_raw = find_cell(headers, values, QUANTITY_ALIASES).unwrap_or("0");
                let qty_fixed = if qty_raw.trim().is_empty() || is_na_placeholder(qty_raw) {
                    0
                } else {
                    parse_decimal_fixed(qty_raw, row_num, "Quantity")?
                };
                let price_raw = find_cell(headers, values, &["t. price", "trade price", "price"])
                    .unwrap_or("0");
                let price_fixed = if price_raw.trim().is_empty() || is_na_placeholder(price_raw) {
                    0
                } else {
                    parse_decimal_fixed(price_raw, row_num, "Price")?
                };
                let comm_raw =
                    find_cell(headers, values, &["comm/fee", "commission", "fees"]).unwrap_or("0");
                let comm_fixed = if comm_raw.trim().is_empty() || is_na_placeholder(comm_raw) {
                    0
                } else {
                    parse_decimal_fixed(comm_raw, row_num, "Comm/Fee").unwrap_or(0)
                };
                let proceeds_raw =
                    find_cell(headers, values, &["proceeds", "amount"]).unwrap_or("0");
                let proceeds_fixed =
                    if proceeds_raw.trim().is_empty() || is_na_placeholder(proceeds_raw) {
                        0
                    } else {
                        parse_decimal_fixed(proceeds_raw, row_num, "Proceeds").unwrap_or(0)
                    };
                let date_raw =
                    find_cell(headers, values, &["date/time", "date", "trade date"]).unwrap_or("");
                let date_sanitized = sanitize_text_cell(date_raw, "Date/Time", warnings);
                let date = normalize_transaction_date(&date_sanitized, row_num, warnings);
                let currency = normalize_currency(
                    find_cell(headers, values, CURRENCY_ALIASES).unwrap_or("USD"),
                );
                let action = if qty_fixed >= 0 { "BUY" } else { "SELL" };

                raw_trades.push((
                    discriminator_kind,
                    StoredPortfolioTransaction {
                        date,
                        action: action.to_string(),
                        symbol,
                        quantity: format_fixed_trimmed(qty_fixed.abs()),
                        price: format_fixed(price_fixed.abs(), 4),
                        amount: format_fixed(proceeds_fixed, 2),
                        fees: format_fixed(comm_fixed.abs(), 2),
                        currency,
                    },
                ));
            }
            "cash report" => {
                let Some(headers) = cash_headers.as_ref() else {
                    skipped_rows += 1;
                    continue;
                };
                let summary_label = find_cell(headers, values, &["currency summary", "field"])
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if summary_label.contains("ending cash") {
                    let raw_curr = find_cell(headers, values, CURRENCY_ALIASES).unwrap_or("USD");
                    if raw_curr
                        .trim()
                        .to_ascii_lowercase()
                        .contains("base currency")
                    {
                        // Skip IBKR converted base currency summary to prevent FX mixing.
                        skipped_rows += 1;
                        continue;
                    }
                    let row_currency = normalize_currency(raw_curr);
                    if let Some(total_raw) = find_cell(headers, values, &["total", "amount"])
                        .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v))
                    {
                        if let Ok(parsed) = parse_decimal_fixed(total_raw, row_num, "Ending Cash") {
                            cash_by_currency.insert(row_currency, parsed);
                        }
                    }
                }
            }
            _ => {
                skipped_rows += 1;
            }
        }
    }

    // Prefer canonical `Order` rows over child `Trade` execution rows for the same
    // `(symbol, date, currency, action)`; adopt `Trade` rows whenever no `Order` exists.
    let order_keys: BTreeSet<(String, String, String, String)> = raw_trades
        .iter()
        .filter(|(kind, _)| *kind == IbkrTradeDiscriminator::Order)
        .map(|(_, tx)| {
            (
                tx.symbol.clone(),
                tx.date.clone(),
                tx.currency.clone(),
                tx.action.clone(),
            )
        })
        .collect();
    let mut transactions = Vec::with_capacity(raw_trades.len());
    for (kind, tx) in raw_trades {
        if kind == IbkrTradeDiscriminator::Trade
            && order_keys.contains(&(
                tx.symbol.clone(),
                tx.date.clone(),
                tx.currency.clone(),
                tx.action.clone(),
            ))
        {
            skipped_rows += 1;
            continue;
        }
        transactions.push(tx);
    }

    if holdings_map.is_empty() && !transactions.is_empty() {
        replay_transactions_into_holdings(&transactions, &mut holdings_map, warnings)?;
    }

    Ok((
        DetectedFormat::IbkrActivity,
        dedup_mappings(mappings),
        finalize_holdings(holdings_map)?,
        transactions,
        cash_by_currency,
        skipped_rows,
    ))
}

fn parse_tabular_csv(
    rows: &[Vec<String>],
    warnings: &mut Vec<String>,
) -> Result<ParsedCsvResult, CsvImportError> {
    let (header_index, format) =
        locate_header_row(rows).ok_or(CsvImportError::UnrecognizedFormat)?;
    let initial_headers: Vec<String> = rows[header_index]
        .iter()
        .map(|s| s.trim().to_string())
        .collect();
    let initial_normalized: Vec<String> = initial_headers
        .iter()
        .map(|h| normalize_header(h))
        .collect();
    let mut active_headers = initial_headers;
    let mut in_secondary_tx_section = false;
    let mut mappings = Vec::new();
    collect_mappings(&active_headers, &mut mappings);

    let mut holdings_map: BTreeMap<(String, String), HoldingAccumulator> = BTreeMap::new();
    let mut transactions = Vec::new();
    let mut cash_by_currency: BTreeMap<String, i128> = BTreeMap::new();
    let mut pending_untagged_cash_rows: Vec<i128> = Vec::new();
    let mut pending_untagged_cash_cols: Vec<i128> = Vec::new();
    let mut skipped_rows = header_index;

    for (offset, row) in rows.iter().enumerate().skip(header_index + 1) {
        let row_num = offset + 1;
        if row.iter().all(|cell| cell.trim().is_empty()) {
            skipped_rows += 1;
            continue;
        }

        // Skip legal disclaimers and footer notes (e.g. Fidelity trailing disclosures).
        if is_disclaimer_or_footer_row(row) {
            skipped_rows += 1;
            continue;
        }

        // Handle Vanguard dual-table CSV (holdings table + blank line + transactions table)
        // and repeated holdings headers across multiple accounts.
        let row_normalized: Vec<String> = row.iter().map(|c| normalize_header(c)).collect();
        if row_normalized == initial_normalized {
            active_headers = row.iter().map(|s| s.trim().to_string()).collect();
            in_secondary_tx_section = false;
            skipped_rows += 1;
            continue;
        }
        if is_secondary_transaction_header(&row_normalized) {
            active_headers = row.iter().map(|s| s.trim().to_string()).collect();
            in_secondary_tx_section = true;
            collect_mappings(&active_headers, &mut mappings);
            skipped_rows += 1;
            continue;
        }

        let headers = &active_headers;
        let raw_symbol = find_cell(headers, row, SYMBOL_ALIASES).unwrap_or("");
        let symbol_lower = raw_symbol.trim().to_ascii_lowercase();
        let company_raw = find_cell(headers, row, COMPANY_ALIASES).unwrap_or("");

        let explicit_currency = find_cell(headers, row, CURRENCY_ALIASES)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(normalize_currency);

        // Cash rows (Schwab, Fidelity SPAXX/FCASH, Vanguard VMFXX, Futu/Tiger 现金)
        if is_cash_row(&symbol_lower, company_raw) {
            if in_secondary_tx_section {
                // Settlement/sweep transactions in a secondary table (e.g. Vanguard dual-table)
                // must not be double-counted on top of the holdings table cash balance.
                skipped_rows += 1;
                continue;
            }
            if let Some(val_raw) = find_cell(headers, row, CASH_ROW_VALUE_ALIASES) {
                if !val_raw.trim().is_empty() && !is_na_placeholder(val_raw) {
                    let parsed = parse_decimal_fixed(val_raw, row_num, "Cash")?;
                    if let Some(row_currency) = explicit_currency
                        .clone()
                        .or_else(|| infer_currency_from_cash_symbol(&symbol_lower))
                        .or_else(|| infer_currency_from_amount(val_raw))
                    {
                        add_cash(&mut cash_by_currency, &row_currency, parsed)?;
                    } else {
                        pending_untagged_cash_rows.push(parsed);
                    }
                }
            }
            continue;
        }

        // Optional explicit cash column on standard/Futu/Tiger CSV rows.
        // Defer untagged cash values until the row's own holding/transaction currency (or file
        // holding currency) is resolved so non-USD portfolios never get a ghost `USD` bucket.
        let mut row_cash_col: Option<(i128, Option<String>)> = None;
        if !in_secondary_tx_section {
            if let Some(cash_col) = find_cell(headers, row, CASH_COL_ALIASES) {
                if !cash_col.trim().is_empty() && !is_na_placeholder(cash_col) {
                    let parsed = parse_decimal_fixed(cash_col, row_num, "cash")?;
                    let tagged_curr = explicit_currency
                        .clone()
                        .or_else(|| infer_currency_from_amount(cash_col));
                    row_cash_col = Some((parsed, tagged_curr));
                }
            }
        }

        if is_summary_or_blank_symbol(raw_symbol) {
            if let Some((parsed, tagged_curr)) = row_cash_col {
                if let Some(curr) = tagged_curr {
                    if parsed > 0 && cash_by_currency.get(&curr).copied().unwrap_or(0) == 0 {
                        cash_by_currency.insert(curr, parsed);
                    }
                } else if parsed > 0 {
                    pending_untagged_cash_cols.push(parsed);
                }
            }
            skipped_rows += 1;
            continue;
        }

        if is_option_row(headers, row, raw_symbol) {
            if let Some((parsed, tagged_curr)) = row_cash_col {
                if let Some(curr) = tagged_curr {
                    if parsed > 0 && cash_by_currency.get(&curr).copied().unwrap_or(0) == 0 {
                        cash_by_currency.insert(curr, parsed);
                    }
                } else if parsed > 0 {
                    pending_untagged_cash_cols.push(parsed);
                }
            }
            warnings.push(format!(
                "Skipped unsupported option/derivative row {row_num} ({})",
                raw_symbol.trim().chars().take(32).collect::<String>()
            ));
            skipped_rows += 1;
            continue;
        }

        let is_transaction_row = in_secondary_tx_section
            || format == DetectedFormat::SchwabTransactions
            || find_cell(headers, row, &["action", "side", "transaction type"])
                .is_some_and(|v| !v.trim().is_empty());

        if is_transaction_row {
            let action_raw =
                find_cell(headers, row, &["action", "side", "transaction type"]).unwrap_or("");
            let mut action = sanitize_text_cell(action_raw, "Action", warnings);
            let date_raw =
                find_cell(headers, row, &["date", "trade date", "settlement date"]).unwrap_or("");
            let date_sanitized = sanitize_text_cell(date_raw, "Date", warnings);
            let date = normalize_transaction_date(&date_sanitized, row_num, warnings);
            let qty_raw = find_cell(headers, row, QUANTITY_ALIASES).unwrap_or("0");
            let price_raw = find_cell(
                headers,
                row,
                &["price", "trade price", "unit price", "share price"],
            )
            .unwrap_or("0");
            let fees_raw = find_cell(
                headers,
                row,
                &["fees & comm", "commissions and fees", "fees", "commission"],
            )
            .unwrap_or("0");
            let amount_raw = find_cell(
                headers,
                row,
                &["amount", "net amount", "principal amount", "proceeds"],
            )
            .unwrap_or("0");

            let qty_fixed = if qty_raw.trim().is_empty() || is_na_placeholder(qty_raw) {
                0
            } else {
                parse_decimal_fixed(qty_raw, row_num, "Quantity")?
            };
            let action_lower = action.to_lowercase();
            if qty_fixed < 0
                && !is_reverse_split_action(&action_lower)
                && (action_lower.contains("split") || action_lower.contains("拆股"))
            {
                action = format!("{action} (Reverse Split)");
            }
            let price_fixed = if price_raw.trim().is_empty() || is_na_placeholder(price_raw) {
                0
            } else {
                parse_decimal_fixed(price_raw, row_num, "Price")?
            };
            let fees_fixed = if fees_raw.trim().is_empty() || is_na_placeholder(fees_raw) {
                0
            } else {
                parse_decimal_fixed(fees_raw, row_num, "Fees")?
            };
            let amount_fixed = if amount_raw.trim().is_empty() || is_na_placeholder(amount_raw) {
                0
            } else {
                parse_decimal_fixed(amount_raw, row_num, "Amount")?
            };

            let symbol = validate_symbol(raw_symbol, row_num)?;
            let row_currency = explicit_currency
                .or_else(|| infer_currency_from_amount(price_raw))
                .or_else(|| infer_currency_from_amount(amount_raw))
                .or_else(|| infer_currency_from_symbol(&symbol))
                .unwrap_or_else(|| "USD".to_string());

            if let Some((parsed, tagged_curr)) = row_cash_col {
                let cash_curr = tagged_curr.unwrap_or_else(|| row_currency.clone());
                if parsed > 0 && cash_by_currency.get(&cash_curr).copied().unwrap_or(0) == 0 {
                    cash_by_currency.insert(cash_curr, parsed);
                }
            }

            transactions.push(StoredPortfolioTransaction {
                date,
                action,
                symbol,
                quantity: format_fixed_trimmed(qty_fixed.abs()),
                price: format_fixed(price_fixed.abs(), 4),
                amount: format_fixed(amount_fixed, 2),
                fees: format_fixed(fees_fixed.abs(), 2),
                currency: row_currency,
            });
            continue;
        }

        // Position row
        let symbol = validate_symbol(raw_symbol, row_num)?;
        let qty_raw = find_cell(headers, row, QUANTITY_ALIASES).ok_or_else(|| {
            CsvImportError::InvalidDecimal {
                row: row_num,
                column: "Quantity".into(),
                value: String::new(),
            }
        })?;
        if is_na_placeholder(qty_raw) {
            skipped_rows += 1;
            continue;
        }
        let qty_fixed = parse_decimal_fixed(qty_raw, row_num, "Quantity")?;
        if qty_fixed < 0 {
            return Err(CsvImportError::NegativeQuantity {
                row: row_num,
                symbol,
            });
        }
        if qty_fixed == 0 {
            skipped_rows += 1;
            continue;
        }

        let price_opt = find_cell(headers, row, PRICE_ALIASES)
            .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v));
        let avg_cost_opt = find_cell(headers, row, AVG_COST_ALIASES)
            .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v));
        let cost_basis_opt = find_cell(headers, row, COST_BASIS_ALIASES)
            .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v));
        let mkt_val_opt = find_cell(headers, row, MARKET_VALUE_ALIASES)
            .filter(|v| !v.trim().is_empty() && !is_na_placeholder(v));

        let last_price_fixed = if let Some(v) = price_opt {
            let parsed = parse_decimal_fixed(v, row_num, "Price")?;
            if parsed < 0 {
                return Err(CsvImportError::NegativeValue {
                    row: row_num,
                    column: "last_price".into(),
                    symbol,
                });
            }
            parsed
        } else if let Some(v) = mkt_val_opt {
            let mv = parse_decimal_fixed(v, row_num, "Market Value")?;
            if mv < 0 {
                return Err(CsvImportError::NegativeValue {
                    row: row_num,
                    column: "last_price".into(),
                    symbol,
                });
            }
            fixed_div(mv, qty_fixed)?
        } else {
            0
        };

        let avg_cost_fixed = if let Some(v) = avg_cost_opt {
            let parsed = parse_decimal_fixed(v, row_num, "Average Cost")?;
            if parsed < 0 {
                return Err(CsvImportError::NegativeValue {
                    row: row_num,
                    column: "average_cost".into(),
                    symbol,
                });
            }
            parsed
        } else if let Some(v) = cost_basis_opt {
            let basis = parse_decimal_fixed(v, row_num, "Cost Basis")?;
            if basis < 0 {
                return Err(CsvImportError::NegativeValue {
                    row: row_num,
                    column: "average_cost".into(),
                    symbol,
                });
            }
            fixed_div(basis, qty_fixed)?
        } else {
            last_price_fixed
        };

        let effective_last = if last_price_fixed > 0 {
            last_price_fixed
        } else {
            avg_cost_fixed
        };

        let row_currency = explicit_currency
            .or_else(|| price_opt.and_then(infer_currency_from_amount))
            .or_else(|| mkt_val_opt.and_then(infer_currency_from_amount))
            .or_else(|| avg_cost_opt.and_then(infer_currency_from_amount))
            .or_else(|| infer_currency_from_symbol(&symbol))
            .unwrap_or_else(|| "USD".to_string());

        if let Some((parsed, tagged_curr)) = row_cash_col {
            let cash_curr = tagged_curr.unwrap_or_else(|| row_currency.clone());
            if parsed > 0 && cash_by_currency.get(&cash_curr).copied().unwrap_or(0) == 0 {
                cash_by_currency.insert(cash_curr, parsed);
            }
        }

        let company = sanitize_text_cell(company_raw, "Description", warnings);

        accumulate_holding(
            &mut holdings_map,
            symbol,
            company,
            qty_fixed,
            avg_cost_fixed,
            effective_last,
            row_currency,
        )?;
    }

    if holdings_map.is_empty() && !transactions.is_empty() {
        replay_transactions_into_holdings(&transactions, &mut holdings_map, warnings)?;
    }

    if !pending_untagged_cash_rows.is_empty() || !pending_untagged_cash_cols.is_empty() {
        let mut inferred_currencies: BTreeSet<String> =
            holdings_map.keys().map(|(_, curr)| curr.clone()).collect();
        if inferred_currencies.is_empty() {
            for tx in &transactions {
                inferred_currencies.insert(tx.currency.clone());
            }
        }
        let fallback_currency = if inferred_currencies.len() == 1 {
            inferred_currencies
                .into_iter()
                .next()
                .unwrap_or_else(|| "USD".to_string())
        } else {
            "USD".to_string()
        };
        for amt in pending_untagged_cash_rows {
            add_cash(&mut cash_by_currency, &fallback_currency, amt)?;
        }
        for amt in pending_untagged_cash_cols {
            if amt > 0
                && cash_by_currency
                    .get(&fallback_currency)
                    .copied()
                    .unwrap_or(0)
                    == 0
            {
                cash_by_currency.insert(fallback_currency.clone(), amt);
            }
        }
    }

    Ok((
        format,
        dedup_mappings(mappings),
        finalize_holdings(holdings_map)?,
        transactions,
        cash_by_currency,
        skipped_rows,
    ))
}

struct HoldingAccumulator {
    symbol: String,
    company: String,
    quantity: i128,
    total_cost: i128,
    last_price: i128,
    currency: String,
}

fn accumulate_holding(
    map: &mut BTreeMap<(String, String), HoldingAccumulator>,
    symbol: String,
    company: String,
    qty_fixed: i128,
    avg_cost_fixed: i128,
    last_price_fixed: i128,
    currency: String,
) -> Result<(), CsvImportError> {
    let added_cost = fixed_mul(qty_fixed, avg_cost_fixed)?;
    let key = (symbol.clone(), currency.clone());
    if let Some(entry) = map.get_mut(&key) {
        entry.quantity = entry
            .quantity
            .checked_add(qty_fixed)
            .ok_or(CsvImportError::ArithmeticOverflow)?;
        entry.total_cost = entry
            .total_cost
            .checked_add(added_cost)
            .ok_or(CsvImportError::ArithmeticOverflow)?;
        if last_price_fixed > 0 {
            entry.last_price = last_price_fixed;
        }
        if entry.company.is_empty() && !company.is_empty() {
            entry.company = company;
        }
    } else {
        map.insert(
            key,
            HoldingAccumulator {
                symbol,
                company,
                quantity: qty_fixed,
                total_cost: added_cost,
                last_price: last_price_fixed,
                currency,
            },
        );
    }
    Ok(())
}

fn is_reverse_split_action(lower: &str) -> bool {
    lower.contains("reverse split")
        || lower.contains("reverse-split")
        || lower.contains("rev split")
        || lower.contains("share consolidation")
        || lower.contains("consolidation")
        || lower.contains("合股")
        || lower.contains("并股")
        || lower.contains("缩股")
}

fn tx_action_replay_rank(action: &str) -> u8 {
    let lower = action.to_lowercase();
    if is_reverse_split_action(&lower) {
        // Distinct rank so reverse splits / consolidations NEVER enter the forward-split add path.
        6
    } else if lower.contains("split") || lower.contains("拆股") {
        0
    } else if lower.contains("reinvest")
        || lower.contains("buy")
        || lower.contains("purchase")
        || lower.contains("买入")
    {
        1
    } else if lower.contains("sell")
        || lower.contains("sale")
        || lower.contains("redemption")
        || lower.contains("卖出")
    {
        2
    } else if lower.contains("dividend")
        || lower.contains("div")
        || lower.contains("interest")
        || lower.contains("股息")
        || lower.contains("分红")
    {
        3
    } else if lower.contains("fee")
        || lower.contains("comm")
        || lower.contains("tax")
        || lower.contains("withholding")
        || lower.contains("费用")
        || lower.contains("佣金")
    {
        4
    } else {
        5
    }
}

fn is_valid_calendar_date(year: i32, month: u32, day: u32) -> bool {
    if !(1900..=2100).contains(&year) || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    day <= max_day
}

fn parse_single_date_token(token: &str) -> Option<String> {
    let trimmed = token.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    // Strip trailing time components: "2026-01-05, 09:30:00", "2026-01-05 09:30:00", "2026-01-05T09:30:00Z"
    let date_part = trimmed.split([' ', ',', 'T']).next().unwrap_or("").trim();
    if date_part.is_empty() {
        return None;
    }

    // YYYYMMDD
    if date_part.len() == 8 && date_part.bytes().all(|b| b.is_ascii_digit()) {
        let y: i32 = date_part[0..4].parse().ok()?;
        let m: u32 = date_part[4..6].parse().ok()?;
        let d: u32 = date_part[6..8].parse().ok()?;
        if is_valid_calendar_date(y, m, d) {
            return Some(format!("{y:04}-{m:02}-{d:02}"));
        }
        return None;
    }

    let sep = if date_part.contains('/') {
        '/'
    } else if date_part.contains('-') {
        '-'
    } else {
        return None;
    };
    let parts: Vec<&str> = date_part.split(sep).collect();
    if parts.len() != 3
        || !parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }

    let (y, m, d): (i32, u32, u32) = if parts[0].len() == 4 {
        // YYYY-MM-DD or YYYY/M/D
        (
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        )
    } else if parts[2].len() == 4 {
        // MM/DD/YYYY or M/D/YYYY or MM-DD-YYYY (Schwab / Fidelity / Vanguard)
        (
            parts[2].parse().ok()?,
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
        )
    } else {
        return None;
    };

    if is_valid_calendar_date(y, m, d) {
        Some(format!("{y:04}-{m:02}-{d:02}"))
    } else {
        None
    }
}

/// Normalizes brokerage transaction dates (`MM/DD/YYYY`, `YYYY/MM/DD`, `YYYY-MM-DD`,
/// `YYYYMMDD`, Schwab `"MM/DD/YYYY as of MM/DD/YYYY"`, IBKR `"YYYY-MM-DD, HH:MM:SS"`)
/// into canonical `YYYY-MM-DD` for chronological replay and deduplication.
pub fn normalize_transaction_date(raw: &str, row_num: usize, warnings: &mut Vec<String>) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let lower = trimmed.to_ascii_lowercase();
    if let Some(as_of_pos) = lower.find(" as of ") {
        let effective = trimmed[as_of_pos + 7..].trim();
        let posted = trimmed[..as_of_pos].trim();
        if let Some(norm) =
            parse_single_date_token(effective).or_else(|| parse_single_date_token(posted))
        {
            return norm;
        }
    }

    if let Some(norm) = parse_single_date_token(trimmed) {
        return norm;
    }

    warnings.push(format!(
        "Could not normalize transaction date in row {row_num}: '{}'",
        trimmed.chars().take(24).collect::<String>()
    ));
    trimmed.to_string()
}

fn replay_transactions_into_holdings(
    transactions: &[StoredPortfolioTransaction],
    map: &mut BTreeMap<(String, String), HoldingAccumulator>,
    warnings: &mut Vec<String>,
) -> Result<(), CsvImportError> {
    let mut chronological: Vec<(usize, &StoredPortfolioTransaction)> =
        transactions.iter().enumerate().collect();
    chronological.sort_by(|(idx_a, a), (idx_b, b)| {
        a.date
            .cmp(&b.date)
            .then_with(|| tx_action_replay_rank(&a.action).cmp(&tx_action_replay_rank(&b.action)))
            .then_with(|| idx_a.cmp(idx_b))
    });

    for (_, tx) in chronological {
        let rank = tx_action_replay_rank(&tx.action);
        if rank == 6 {
            // REVERSE SPLIT / CONSOLIDATION: never add shares; emit an explicit warning
            // so the user imports a broker Positions CSV for exact post-consolidation shares.
            warnings.push(format!(
                "Reverse split / share consolidation for {} ({}) skipped in transaction replay to prevent share inflation; import a broker Positions CSV for exact post-consolidation share count",
                tx.symbol, tx.action
            ));
            continue;
        }
        let qty = parse_decimal_fixed(&tx.quantity, 0, "Quantity").unwrap_or(0);
        let price = parse_decimal_fixed(&tx.price, 0, "Price").unwrap_or(0);
        if qty <= 0 {
            continue;
        }

        match rank {
            0 => {
                // SPLIT: adds split shares while preserving existing total cost basis.
                let key = (tx.symbol.clone(), tx.currency.clone());
                if let Some(entry) = map.get_mut(&key) {
                    let old_qty = entry.quantity;
                    let new_qty = old_qty
                        .checked_add(qty)
                        .ok_or(CsvImportError::ArithmeticOverflow)?;
                    entry.quantity = new_qty;
                    if price > 0 {
                        entry.last_price = price;
                    } else if entry.last_price > 0 && new_qty > 0 {
                        let old_value = fixed_mul(entry.last_price, old_qty)?;
                        entry.last_price = fixed_div(old_value, new_qty)?;
                    }
                } else {
                    warnings.push(format!(
                        "Split transaction for {} had no prior holding lot in CSV; skipped in holding replay",
                        tx.symbol
                    ));
                }
            }
            1 => {
                // BUY / REINVEST
                accumulate_holding(
                    map,
                    tx.symbol.clone(),
                    tx.symbol.clone(),
                    qty,
                    price,
                    price,
                    tx.currency.clone(),
                )?;
            }
            2 => {
                // SELL
                let key = (tx.symbol.clone(), tx.currency.clone());
                if let Some(entry) = map.get_mut(&key) {
                    if qty >= entry.quantity {
                        entry.quantity = 0;
                        entry.total_cost = 0;
                    } else {
                        let avg = fixed_div(entry.total_cost, entry.quantity)?;
                        entry.quantity -= qty;
                        entry.total_cost = fixed_mul(entry.quantity, avg)?;
                    }
                    if price > 0 {
                        entry.last_price = price;
                    }
                } else {
                    warnings.push(format!(
                        "Sell transaction for {} had no prior buy lot in CSV; skipped in holding replay",
                        tx.symbol
                    ));
                }
            }
            _ => {
                // DIVIDEND / FEE / non-share events do not modify share counts
            }
        }
    }

    map.retain(|_, entry| entry.quantity > 0);
    Ok(())
}

fn finalize_holdings(
    map: BTreeMap<(String, String), HoldingAccumulator>,
) -> Result<Vec<StoredPortfolioHolding>, CsvImportError> {
    let mut holdings = Vec::with_capacity(map.len());
    for (_, acc) in map {
        if acc.quantity <= 0 {
            continue;
        }
        let avg_cost = fixed_div(acc.total_cost, acc.quantity)?;
        let last_price = if acc.last_price > 0 {
            acc.last_price
        } else {
            avg_cost
        };
        holdings.push(StoredPortfolioHolding {
            symbol: acc.symbol.clone(),
            company: if acc.company.is_empty() {
                acc.symbol
            } else {
                acc.company
            },
            quantity: format_fixed_trimmed(acc.quantity),
            average_cost: format_fixed(avg_cost, 4),
            last_price: format_fixed(last_price, 4),
            currency: acc.currency,
        });
    }
    Ok(holdings)
}

fn locate_header_row(rows: &[Vec<String>]) -> Option<(usize, DetectedFormat)> {
    for (idx, row) in rows.iter().enumerate().take(25) {
        let normalized: Vec<String> = row.iter().map(|c| normalize_header(c)).collect();
        let has_symbol = normalized
            .iter()
            .any(|h| SYMBOL_ALIASES.contains(&h.as_str()));
        if !has_symbol {
            continue;
        }

        let has_action = normalized
            .iter()
            .any(|h| matches!(h.as_str(), "action" | "side" | "transaction type"));
        let has_fees_comm = normalized.iter().any(|h| h == "fees & comm");
        let has_schwab_pos = normalized.iter().any(|h| {
            matches!(
                h.as_str(),
                "price change $" | "mkt val (market value)" | "reinvest?" | "security type"
            )
        });
        let has_ibkr_flat = normalized.iter().any(|h| {
            matches!(
                h.as_str(),
                "costbasisprice" | "markprice" | "fifopnlunrealized"
            )
        });
        let has_fidelity = normalized.iter().any(|h| {
            matches!(
                h.as_str(),
                "cost basis total"
                    | "average cost basis"
                    | "percent of account"
                    | "today's gain/loss dollar"
            )
        }) || (normalized.iter().any(|h| h == "current value")
            && normalized.iter().any(|h| h == "last price"));
        let has_vanguard = normalized.iter().any(|h| h == "investment name")
            || (normalized.iter().any(|h| h == "share price")
                && normalized.iter().any(|h| h == "total value"));
        let has_futu = normalized.iter().any(|h| {
            matches!(
                h.as_str(),
                "持有数量"
                    | "稀释成本价"
                    | "平均成本价"
                    | "holding qty"
                    | "diluted cost"
                    | "股票代码"
            )
        });
        let has_tiger = normalized.iter().any(|h| {
            matches!(
                h.as_str(),
                "标的"
                    | "标的代码"
                    | "合约代码"
                    | "持仓均价"
                    | "持仓市值"
                    | "账户现金"
                    | "contract"
            )
        });
        let has_qty = normalized
            .iter()
            .any(|h| QUANTITY_ALIASES.contains(&h.as_str()));

        if has_action && (has_fees_comm || normalized.iter().any(|h| h == "date")) {
            return Some((idx, DetectedFormat::SchwabTransactions));
        }
        if has_schwab_pos && has_qty {
            return Some((idx, DetectedFormat::SchwabPositions));
        }
        if has_ibkr_flat && has_qty {
            return Some((idx, DetectedFormat::IbkrPositions));
        }
        if has_fidelity && has_qty {
            return Some((idx, DetectedFormat::FidelityPositions));
        }
        if has_vanguard && has_qty {
            return Some((idx, DetectedFormat::VanguardPositions));
        }
        if has_futu && has_qty {
            return Some((idx, DetectedFormat::FutuPositions));
        }
        if has_tiger && has_qty {
            return Some((idx, DetectedFormat::TigerPositions));
        }
        if has_qty {
            return Some((idx, DetectedFormat::GenericStandard));
        }
    }
    None
}

fn collect_mappings(headers: &[String], out: &mut Vec<CsvColumnMappingDto>) {
    let specs: &[(&str, &[&str])] = &[
        ("symbol", SYMBOL_ALIASES),
        ("company", COMPANY_ALIASES),
        ("quantity", QUANTITY_ALIASES),
        ("averageCost", AVG_COST_ALIASES),
        ("costBasis", COST_BASIS_ALIASES),
        ("price", PRICE_ALIASES),
        ("marketValue", MARKET_VALUE_ALIASES),
        ("cash", CASH_COL_ALIASES),
        ("currency", CURRENCY_ALIASES),
        ("date", &["date", "date/time", "trade date"]),
        ("action", &["action", "side", "transaction type"]),
    ];

    for (canonical, aliases) in specs {
        if let Some(found) = headers
            .iter()
            .find(|h| aliases.contains(&normalize_header(h).as_str()))
        {
            out.push(CsvColumnMappingDto {
                canonical_field: (*canonical).to_string(),
                source_header: found.clone(),
            });
        }
    }
}

fn dedup_mappings(mappings: Vec<CsvColumnMappingDto>) -> Vec<CsvColumnMappingDto> {
    let mut seen = BTreeMap::new();
    for m in mappings {
        seen.entry(m.canonical_field.clone()).or_insert(m);
    }
    seen.into_values().collect()
}

fn find_cell<'a>(headers: &[String], row: &'a [String], aliases: &[&str]) -> Option<&'a str> {
    for alias in aliases {
        for (idx, header) in headers.iter().enumerate() {
            if normalize_header(header) == *alias {
                return row.get(idx).map(String::as_str);
            }
        }
    }
    None
}

fn normalize_header(header: &str) -> String {
    header
        .trim()
        .trim_matches('"')
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_cash_row(symbol_lower: &str, company_raw: &str) -> bool {
    let clean = symbol_lower.trim_end_matches('*');
    if matches!(
        clean,
        "cash"
            | "cash & cash investments"
            | "cash & money market"
            | "usd"
            | "hkd"
            | "cny"
            | "eur"
            | "gbp"
            | "sgd"
            | "cash balance"
            | "spaxx"
            | "fdrxx"
            | "fcash"
            | "vmfxx"
            | "settlement fund"
            | "pending activity"
            | "现金"
            | "美元现金"
            | "港元现金"
            | "港币现金"
            | "人民币现金"
            | "现金余额"
    ) {
        return true;
    }
    let company_lower = company_raw.trim().to_ascii_lowercase();
    company_lower.contains("settlement fund")
        || company_lower.contains("cash & money market")
        || company_lower == "cash"
}

fn infer_currency_from_cash_symbol(symbol_lower: &str) -> Option<String> {
    match symbol_lower.trim_end_matches('*') {
        "usd" | "美元现金" | "spaxx" | "fdrxx" | "fcash" | "vmfxx" => Some("USD".to_string()),
        "hkd" | "港元现金" | "港币现金" => Some("HKD".to_string()),
        "cny" | "人民币现金" => Some("CNY".to_string()),
        "eur" => Some("EUR".to_string()),
        "gbp" => Some("GBP".to_string()),
        "sgd" => Some("SGD".to_string()),
        "jpy" => Some("JPY".to_string()),
        "cad" => Some("CAD".to_string()),
        "aud" => Some("AUD".to_string()),
        "chf" => Some("CHF".to_string()),
        "dkk" => Some("DKK".to_string()),
        "sek" => Some("SEK".to_string()),
        "nok" => Some("NOK".to_string()),
        "twd" => Some("TWD".to_string()),
        "krw" => Some("KRW".to_string()),
        "inr" => Some("INR".to_string()),
        "nzd" => Some("NZD".to_string()),
        "brl" => Some("BRL".to_string()),
        "mxn" => Some("MXN".to_string()),
        "idr" => Some("IDR".to_string()),
        "thb" => Some("THB".to_string()),
        "myr" => Some("MYR".to_string()),
        "ils" => Some("ILS".to_string()),
        "zar" => Some("ZAR".to_string()),
        _ => None,
    }
}

fn infer_currency_from_symbol(symbol: &str) -> Option<String> {
    crate::quotes::infer_exchange_currency_from_symbol(symbol).map(str::to_string)
}

fn is_secondary_transaction_header(normalized: &[String]) -> bool {
    let has_symbol = normalized
        .iter()
        .any(|h| SYMBOL_ALIASES.contains(&h.as_str()));
    let has_action = normalized
        .iter()
        .any(|h| matches!(h.as_str(), "action" | "side" | "transaction type"));
    let has_date = normalized.iter().any(|h| {
        matches!(
            h.as_str(),
            "date" | "trade date" | "settlement date" | "date/time"
        )
    });
    has_symbol && has_action && has_date
}

fn is_disclaimer_or_footer_row(row: &[String]) -> bool {
    let non_empty: Vec<&str> = row
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .collect();
    if non_empty.is_empty() {
        return true;
    }
    let first = non_empty[0];
    let first_lower = first.to_lowercase();
    let footer_prefixes = [
        "the data and information",
        "brokerage services",
        "date downloaded",
        "disclaimer",
        "important information",
        "important notice",
        "note:",
        "notes:",
        "footnotes",
        "fidelity brokerage",
        "charles schwab",
        "vanguard brokerage",
        "for informational purposes",
        "past performance",
        "all rights reserved",
        "copyright",
        "免责声明",
        "注：",
        "备注：",
    ];
    if footer_prefixes.iter().any(|p| first_lower.starts_with(p)) {
        return true;
    }
    if (first.starts_with('*') || first.starts_with("†")) && non_empty.len() <= 2 {
        return true;
    }
    if non_empty.len() == 1 && first.len() > 40 && first.contains(' ') {
        return true;
    }
    false
}

fn looks_like_option_symbol(raw: &str) -> bool {
    let trimmed = raw.trim().to_ascii_uppercase();
    if trimmed.is_empty() {
        return false;
    }
    // Strip Fidelity leading `-` or Futu market prefixes (`US.`, `HK.`, `SG.`)
    let stripped = trimmed.strip_prefix('-').unwrap_or(&trimmed);
    let stripped = stripped
        .strip_prefix("US.")
        .or_else(|| stripped.strip_prefix("HK."))
        .or_else(|| stripped.strip_prefix("SG."))
        .unwrap_or(stripped);

    // Format 1: Compact OCC / Futu / Fidelity option symbol (e.g. AAPL261218C250000, AAPL261218C250, TCH261218C400000)
    if !stripped.contains(' ') && stripped.is_ascii() && stripped.len() >= 11 {
        let bytes = stripped.as_bytes();
        // Look for 6 digits (YYMMDD) followed by C or P followed by 1..=8 digits (optional decimal)
        for pos in 1..bytes.len().saturating_sub(7) {
            if bytes[pos..pos + 6].iter().all(u8::is_ascii_digit)
                && matches!(bytes[pos + 6], b'C' | b'P')
            {
                let root = &bytes[..pos];
                let strike = &bytes[pos + 7..];
                if !root.is_empty()
                    && root.len() <= 6
                    && root.iter().all(u8::is_ascii_alphanumeric)
                    && !strike.is_empty()
                    && strike.len() <= 10
                    && strike.iter().all(|b| b.is_ascii_digit() || *b == b'.')
                {
                    return true;
                }
            }
        }
    }

    // Format 2: Spaced Schwab / IBKR / Tiger option symbol
    // e.g. "AAPL 12/18/2026 250.00 C", "AAPL 18DEC26 250 C", "NVDA 20261218 140.0 CALL"
    if stripped.contains(' ') {
        let tokens: Vec<&str> = stripped.split_whitespace().collect();
        if tokens.len() >= 3 {
            let last = *tokens.last().unwrap_or(&"");
            let ends_with_cp = matches!(last, "C" | "P" | "CALL" | "PUT");
            let has_date_token = tokens.iter().any(|t| {
                let tb = t.as_bytes();
                (t.contains('/') && t.is_ascii() && tb.len() >= 8)
                    || (tb.len() == 7
                        && tb[0..2].iter().all(u8::is_ascii_digit)
                        && tb[2..5].iter().all(u8::is_ascii_alphabetic)
                        && tb[5..7].iter().all(u8::is_ascii_digit))
                    || ((tb.len() == 6 || tb.len() == 8) && tb.iter().all(u8::is_ascii_digit))
            });
            if ends_with_cp && has_date_token {
                return true;
            }
        }
    }

    false
}

fn is_option_row(headers: &[String], row: &[String], raw_symbol: &str) -> bool {
    if let Some(sec_type) = find_cell(headers, row, SECURITY_TYPE_ALIASES) {
        let lower = sec_type.trim().to_lowercase();
        if lower.contains("option")
            || lower.contains("warrant")
            || lower.contains("future")
            || lower.contains("期权")
            || lower.contains("窝轮")
            || lower.contains("牛熊证")
            || lower.contains("期货")
        {
            return true;
        }
    }
    looks_like_option_symbol(raw_symbol)
}

fn infer_currency_from_amount(raw: &str) -> Option<String> {
    let normalized = normalize_numeric_unicode(raw);
    let trimmed = normalized.trim().trim_matches(['(', ')', '-', '+', ' ']);
    let upper = trimmed.to_ascii_uppercase();
    if upper.starts_with("HK$")
        || upper.starts_with("HKD")
        || upper.ends_with("HK$")
        || upper.ends_with("HKD")
        || trimmed.ends_with("港元")
        || trimmed.ends_with("港币")
    {
        Some("HKD".to_string())
    } else if upper.starts_with("US$")
        || upper.starts_with("USD")
        || upper.ends_with("US$")
        || upper.ends_with("USD")
        || trimmed.ends_with("美元")
    {
        Some("USD".to_string())
    } else if upper.starts_with("S$")
        || upper.starts_with("SGD")
        || upper.ends_with("S$")
        || upper.ends_with("SGD")
    {
        Some("SGD".to_string())
    } else if upper.starts_with("C$")
        || upper.starts_with("CAD")
        || upper.ends_with("C$")
        || upper.ends_with("CAD")
    {
        Some("CAD".to_string())
    } else if upper.starts_with("A$")
        || upper.starts_with("AUD")
        || upper.ends_with("A$")
        || upper.ends_with("AUD")
    {
        Some("AUD".to_string())
    } else if upper.starts_with("CN¥")
        || upper.starts_with("CN￥")
        || upper.starts_with("CNY")
        || upper.starts_with("RMB")
        || upper.ends_with("CNY")
        || upper.ends_with("RMB")
        || trimmed.starts_with('¥')
        || trimmed.starts_with('￥')
        || trimmed.ends_with('¥')
        || trimmed.ends_with('￥')
        || trimmed.ends_with("人民币")
    {
        Some("CNY".to_string())
    } else if trimmed.starts_with('€')
        || trimmed.ends_with('€')
        || upper.starts_with("EUR")
        || upper.ends_with("EUR")
    {
        Some("EUR".to_string())
    } else if trimmed.starts_with('£')
        || trimmed.ends_with('£')
        || upper.starts_with("GBP")
        || upper.ends_with("GBP")
    {
        Some("GBP".to_string())
    } else if upper.starts_with("JPY") || upper.ends_with("JPY") {
        Some("JPY".to_string())
    } else if upper.starts_with("CHF") || upper.ends_with("CHF") {
        Some("CHF".to_string())
    } else {
        None
    }
}

fn is_summary_or_blank_symbol(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_lowercase();
    lower.contains("total")
        || lower.starts_with("positions for")
        || lower.starts_with("account ")
        || lower == "--"
        || lower == "n/a"
        || lower == "合计"
        || lower == "总计"
        || lower == "小计"
        || lower.starts_with("the data and information")
}

fn is_na_placeholder(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "--" | "n/a" | "na" | "-"
    )
}

fn normalize_currency(raw: &str) -> String {
    let trimmed = raw.trim();
    match trimmed {
        "美元" | "美金" => return "USD".to_string(),
        "港元" | "港币" => return "HKD".to_string(),
        "人民币" | "离岸人民币" => return "CNY".to_string(),
        "新元" | "新加坡元" => return "SGD".to_string(),
        "欧元" => return "EUR".to_string(),
        "英镑" => return "GBP".to_string(),
        "日元" => return "JPY".to_string(),
        "加元" => return "CAD".to_string(),
        "澳元" => return "AUD".to_string(),
        _ => {}
    }

    let clean: String = trimmed
        .chars()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_ascii_uppercase())
        .take(3)
        .collect();
    if clean.len() == 3 {
        clean
    } else {
        "USD".to_string()
    }
}

pub fn validate_symbol(raw: &str, row: usize) -> Result<String, CsvImportError> {
    let mut trimmed = raw
        .trim()
        .trim_start_matches('$')
        .trim_end_matches('*')
        .to_ascii_uppercase();

    // Normalize common Futu / Moomoo market prefixes:
    // US.AAPL -> AAPL, HK.00700 -> 00700.HK, SH.600519 -> 600519.SS, SZ.000001 -> 000001.SZ, SG.D05 -> D05.SI
    if let Some(rest) = trimmed.strip_prefix("US.") {
        if !rest.is_empty() {
            trimmed = rest.to_string();
        }
    } else if let Some(rest) = trimmed.strip_prefix("HK.") {
        if !rest.is_empty() && rest.len() + 3 <= 10 {
            trimmed = format!("{rest}.HK");
        }
    } else if let Some(rest) = trimmed.strip_prefix("SH.") {
        if !rest.is_empty() && rest.len() + 3 <= 10 {
            trimmed = format!("{rest}.SS");
        }
    } else if let Some(rest) = trimmed.strip_prefix("SZ.") {
        if !rest.is_empty() && rest.len() + 3 <= 10 {
            trimmed = format!("{rest}.SZ");
        }
    } else if let Some(rest) = trimmed.strip_prefix("SG.") {
        if !rest.is_empty() && rest.len() + 3 <= 10 {
            trimmed = format!("{rest}.SI");
        }
    }

    let bytes = trimmed.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 10
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'));
    if !valid {
        return Err(CsvImportError::InvalidSymbol {
            row,
            value: raw.trim().chars().take(24).collect(),
        });
    }
    Ok(trimmed)
}

/// Strip dangerous leading spreadsheet formula prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`)
/// from text cells to neutralize CSV formula injection.
pub fn sanitize_text_cell(raw: &str, field_name: &str, warnings: &mut Vec<String>) -> String {
    let cleaned_ctrl: String = raw
        .chars()
        .filter(|&c| c != '\0' && (c >= ' ' || c == '\t'))
        .collect();
    let trimmed = cleaned_ctrl.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut stripped = trimmed;
    let mut had_formula = false;
    while let Some(first) = stripped.chars().next() {
        if matches!(first, '=' | '+' | '-' | '@' | '\t' | '\r') {
            had_formula = true;
            stripped = stripped[first.len_utf8()..].trim_start();
        } else {
            break;
        }
    }

    if had_formula {
        warnings.push(format!(
            "Sanitized potential CSV formula prefix in {field_name} column"
        ));
    }
    stripped.chars().take(120).collect()
}

fn normalize_numeric_unicode(raw: &str) -> String {
    raw.chars()
        .map(|ch| match ch {
            '\u{00A0}' | '\u{202F}' | '\u{2007}' | '\u{3000}' => ' ',
            '\u{2212}' | '\u{2013}' | '\u{2014}' | '\u{FF0D}' => '-',
            other => other,
        })
        .collect()
}

const CURRENCY_TOKENS: &[&str] = &[
    "HK$",
    "US$",
    "S$",
    "C$",
    "A$",
    "CN¥",
    "CN￥",
    "RMB",
    "USD",
    "HKD",
    "CNY",
    "EUR",
    "GBP",
    "SGD",
    "JPY",
    "CAD",
    "AUD",
    "CHF",
    "港元",
    "港币",
    "美元",
    "人民币",
    "新元",
    "欧元",
    "英镑",
    "日元",
    "元",
    "$",
    "¥",
    "￥",
    "€",
    "£",
];

fn strip_currency_prefix(text: &str) -> &str {
    let trimmed = text.trim();
    for token in CURRENCY_TOKENS {
        if token.is_ascii() {
            if trimmed.len() >= token.len()
                && trimmed.is_char_boundary(token.len())
                && trimmed[..token.len()].eq_ignore_ascii_case(token)
            {
                return trimmed[token.len()..].trim();
            }
        } else if let Some(rest) = trimmed.strip_prefix(token) {
            return rest.trim();
        }
    }
    trimmed
}

fn strip_currency_suffix(text: &str) -> &str {
    let trimmed = text.trim();
    for token in CURRENCY_TOKENS {
        if token.is_ascii() {
            if trimmed.len() >= token.len() {
                let start = trimmed.len() - token.len();
                if trimmed.is_char_boundary(start) && trimmed[start..].eq_ignore_ascii_case(token) {
                    return trimmed[..start].trim();
                }
            }
        } else if let Some(rest) = trimmed.strip_suffix(token) {
            return rest.trim();
        }
    }
    trimmed
}

/// Strict decimal parser converting currency/accounting strings into `10^8` fixed-point `i128`.
/// Never uses `f32`/`f64`.
pub fn parse_decimal_fixed(raw: &str, row: usize, column: &str) -> Result<i128, CsvImportError> {
    let normalized = normalize_numeric_unicode(raw);
    let mut text = normalized.trim();
    if text.is_empty() {
        return Err(CsvImportError::InvalidDecimal {
            row,
            column: column.to_string(),
            value: raw.to_string(),
        });
    }

    let mut negative = false;
    let mut has_parens = false;
    let mut has_explicit_sign = false;

    if text.starts_with('(') && text.ends_with(')') && text.len() > 2 {
        has_parens = true;
        negative = true;
        text = text[1..text.len() - 1].trim();
    }

    // Consume at most one explicit sign (`-` or `+`) either before or after a currency prefix.
    // Note: `(-$100)` or `($-100)` remains negative (accounting parens + minus never cancel out).
    for _ in 0..2 {
        let before = text;
        text = strip_currency_prefix(text);
        text = strip_currency_suffix(text);
        if let Some(rest) = text.strip_prefix('-') {
            if has_explicit_sign {
                return Err(CsvImportError::InvalidDecimal {
                    row,
                    column: column.to_string(),
                    value: raw.to_string(),
                });
            }
            has_explicit_sign = true;
            negative = true;
            text = rest.trim();
        } else if let Some(rest) = text.strip_prefix('+') {
            if has_explicit_sign || has_parens {
                return Err(CsvImportError::InvalidDecimal {
                    row,
                    column: column.to_string(),
                    value: raw.to_string(),
                });
            }
            has_explicit_sign = true;
            text = rest.trim();
        }
        text = strip_currency_prefix(text);
        text = strip_currency_suffix(text);
        if text == before {
            break;
        }
    }

    if text.starts_with('-') || text.starts_with('+') {
        return Err(CsvImportError::InvalidDecimal {
            row,
            column: column.to_string(),
            value: raw.to_string(),
        });
    }

    let compact: String = text.chars().filter(|&c| c != ',' && c != ' ').collect();
    if compact.is_empty() {
        return Err(CsvImportError::InvalidDecimal {
            row,
            column: column.to_string(),
            value: raw.to_string(),
        });
    }

    let mut parts = compact.split('.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next().unwrap_or("");
    if parts.next().is_some() {
        return Err(CsvImportError::InvalidDecimal {
            row,
            column: column.to_string(),
            value: raw.to_string(),
        });
    }

    if (int_part.is_empty() && frac_part.is_empty())
        || !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(CsvImportError::InvalidDecimal {
            row,
            column: column.to_string(),
            value: raw.to_string(),
        });
    }

    let int_val: i128 = if int_part.is_empty() {
        0
    } else {
        int_part
            .parse()
            .map_err(|_| CsvImportError::InvalidDecimal {
                row,
                column: column.to_string(),
                value: raw.to_string(),
            })?
    };

    let scale_usize = FIXED_SCALE as usize;
    let mut frac_digits = String::with_capacity(scale_usize);
    for ch in frac_part.chars().take(scale_usize) {
        frac_digits.push(ch);
    }
    while frac_digits.len() < scale_usize {
        frac_digits.push('0');
    }
    let mut frac_val: i128 = frac_digits
        .parse()
        .map_err(|_| CsvImportError::InvalidDecimal {
            row,
            column: column.to_string(),
            value: raw.to_string(),
        })?;

    if frac_part.len() > scale_usize && frac_part.as_bytes()[scale_usize] >= b'5' {
        frac_val += 1;
    }

    let combined = int_val
        .checked_mul(FIXED_FACTOR)
        .and_then(|v| v.checked_add(frac_val))
        .ok_or(CsvImportError::ArithmeticOverflow)?;
    Ok(if negative { -combined } else { combined })
}

fn fixed_mul(a: i128, b: i128) -> Result<i128, CsvImportError> {
    let prod = a.checked_mul(b).ok_or(CsvImportError::ArithmeticOverflow)?;
    let half = if prod >= 0 {
        FIXED_FACTOR / 2
    } else {
        -(FIXED_FACTOR / 2)
    };
    let rounded = prod
        .checked_add(half)
        .ok_or(CsvImportError::ArithmeticOverflow)?;
    Ok(rounded / FIXED_FACTOR)
}

fn fixed_div(numerator: i128, denominator: i128) -> Result<i128, CsvImportError> {
    if denominator == 0 {
        return Err(CsvImportError::ArithmeticOverflow);
    }
    let scaled = numerator
        .checked_mul(FIXED_FACTOR)
        .ok_or(CsvImportError::ArithmeticOverflow)?;
    let half = i128::try_from(denominator.unsigned_abs() / 2)
        .map_err(|_| CsvImportError::ArithmeticOverflow)?;
    let adjusted = if (scaled >= 0) == (denominator > 0) {
        scaled.checked_add(if scaled >= 0 { half } else { -half })
    } else {
        scaled.checked_sub(if scaled >= 0 { half } else { -half })
    }
    .ok_or(CsvImportError::ArithmeticOverflow)?;
    adjusted
        .checked_div(denominator)
        .ok_or(CsvImportError::ArithmeticOverflow)
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

fn format_fixed_trimmed(value: i128) -> String {
    let full = format_fixed(value, FIXED_SCALE);
    if !full.contains('.') {
        return full;
    }
    let trimmed = full.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-0" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn compute_snapshot_fingerprint(
    source_format: &str,
    currency: &str,
    cash: &str,
    cash_by_currency: &BTreeMap<String, String>,
    holdings: &[StoredPortfolioHolding],
    transactions: &[StoredPortfolioTransaction],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"foliohelm/csv-portfolio-fingerprint/v1\n");
    hasher.update(source_format.as_bytes());
    hasher.update(b"\n");
    hasher.update(currency.as_bytes());
    hasher.update(b"\n");
    hasher.update(cash.as_bytes());
    hasher.update(b"\n");
    for (curr, amt) in cash_by_currency {
        hasher.update(format!("C|{curr}|{amt}\n").as_bytes());
    }
    for h in holdings {
        hasher.update(
            format!(
                "H|{}|{}|{}|{}|{}\n",
                h.symbol, h.quantity, h.average_cost, h.last_price, h.currency
            )
            .as_bytes(),
        );
    }
    for t in transactions {
        hasher.update(
            format!(
                "T|{}|{}|{}|{}|{}|{}|{}\n",
                t.date, t.action, t.symbol, t.quantity, t.price, t.amount, t.currency
            )
            .as_bytes(),
        );
    }
    let digest: [u8; 32] = hasher.finalize().into();
    encode_hex(&digest)
}

/// RFC 4180 compliant CSV tokenizer supporting quoted fields, escaped quotes, and CRLF/LF.
fn parse_csv_rows(input: &str) -> Result<Vec<Vec<String>>, CsvImportError> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_cell = String::new();
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current_cell.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                current_cell.push(ch);
            }
        } else {
            match ch {
                '"' if current_cell.trim().is_empty() => {
                    current_cell.clear();
                    in_quotes = true;
                }
                ',' => {
                    current_row.push(std::mem::take(&mut current_cell));
                }
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    current_row.push(std::mem::take(&mut current_cell));
                    rows.push(std::mem::take(&mut current_row));
                    if rows.len() > MAX_CSV_ROWS {
                        return Err(CsvImportError::TooManyRows);
                    }
                }
                '\n' => {
                    current_row.push(std::mem::take(&mut current_cell));
                    rows.push(std::mem::take(&mut current_row));
                    if rows.len() > MAX_CSV_ROWS {
                        return Err(CsvImportError::TooManyRows);
                    }
                }
                other => current_cell.push(other),
            }
        }
    }

    if !current_cell.is_empty() || !current_row.is_empty() {
        current_row.push(current_cell);
        rows.push(current_row);
    }

    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_charles_schwab_positions_csv_with_cash_and_cost_basis() {
        let csv = r#""Positions for account Individual ...1234 as of 04:00 PM ET, 2026/11/21"
""
"Symbol","Description","Quantity","Price","Price Change $","Market Value","Cost Basis","Security Type"
"AAPL","APPLE INC","100","$228.50","+$2.10","$22,850.00","$19,500.00","Equity"
"BRK.B","BERKSHIRE HATHAWAY","15","$450.00","-$1.20","$6,750.00","$6,000.00","Equity"
"Cash & Cash Investments","--","--","--","--","$12,345.67","--","Cash and Money Market"
"Account Total","","","--","--","$41,945.67","$25,500.00",""
"#;

        let preview = parse_and_preview_csv(csv, "schwab-positions.csv", false).expect("parse");
        assert_eq!(preview.detected_format, "schwab_positions");
        assert!(!preview.snapshot.is_multi_currency);
        assert_eq!(preview.snapshot.currency, "USD");
        assert_eq!(preview.snapshot.cash, "12345.67");
        assert_eq!(preview.snapshot.holdings.len(), 2);
        assert_eq!(preview.snapshot.holdings[0].symbol, "AAPL");
        assert_eq!(preview.snapshot.holdings[0].quantity, "100");
        assert_eq!(preview.snapshot.holdings[0].average_cost, "195.0000");
        assert_eq!(preview.snapshot.holdings[0].last_price, "228.5000");
        assert_eq!(preview.snapshot.holdings[1].symbol, "BRK.B");
        assert_eq!(preview.snapshot.holdings[1].average_cost, "400.0000");
    }

    #[test]
    fn parses_ibkr_multi_section_activity_statement_csv() {
        let csv = r#"Statement,Header,Field Name,Field Value
Statement,Data,BrokerName,Interactive Brokers
Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Cost Price,Close Price,Description
Positions,Data,Summary,Stocks,USD,MSFT,25,380.25,421.10,MICROSOFT CORP
Positions,Data,Total,Stocks,USD,,25,,,
Cash Report,Header,Currency Summary,Currency,Total
Cash Report,Data,Ending Cash,USD,8420.15
"#;

        let preview = parse_and_preview_csv(csv, "ibkr.csv", false).expect("parse ibkr");
        assert_eq!(preview.detected_format, "ibkr_activity");
        assert_eq!(preview.snapshot.cash, "8420.15");
        assert_eq!(preview.snapshot.holdings.len(), 1);
        assert_eq!(preview.snapshot.holdings[0].symbol, "MSFT");
        assert_eq!(preview.snapshot.holdings[0].quantity, "25");
        assert_eq!(preview.snapshot.holdings[0].average_cost, "380.2500");
        assert_eq!(preview.snapshot.holdings[0].last_price, "421.1000");
    }

    #[test]
    fn parses_fidelity_and_vanguard_positions_csv_with_core_cash() {
        let fidelity_csv = r#"Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis,Percent Of Account
X12345678,Individual,VOO,VANGUARD S&P 500 ETF,10,$515.00,$5150.00,$4600.00,$460.00,64.38%
X12345678,Individual,SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,--,--,$2850.00,--,--,35.62%
"#;
        let fid = parse_and_preview_csv(fidelity_csv, "fidelity.csv", false).expect("fidelity");
        assert_eq!(fid.detected_format, "fidelity_positions");
        assert_eq!(fid.snapshot.cash, "2850.00");
        assert_eq!(fid.snapshot.holdings.len(), 1);
        assert_eq!(fid.snapshot.holdings[0].symbol, "VOO");
        assert_eq!(fid.snapshot.holdings[0].average_cost, "460.0000");
        assert_eq!(fid.snapshot.holdings[0].last_price, "515.0000");

        let vanguard_csv = r#"Account Number,Investment Name,Symbol,Shares,Share Price,Total Value
12345678,Vanguard Total Stock Market ETF,VTI,20,$280.50,$5610.00
12345678,Vanguard Federal Money Market Fund,VMFXX,1200.50,$1.00,$1200.50
"#;
        let van = parse_and_preview_csv(vanguard_csv, "vanguard.csv", false).expect("vanguard");
        assert_eq!(van.detected_format, "vanguard_positions");
        assert_eq!(van.snapshot.cash, "1200.50");
        assert_eq!(van.snapshot.holdings.len(), 1);
        assert_eq!(van.snapshot.holdings[0].symbol, "VTI");
        assert_eq!(van.snapshot.holdings[0].last_price, "280.5000");
    }

    #[test]
    fn parses_futu_and_tiger_csv_and_isolates_multi_currency_fail_safe() {
        let futu_csv = "股票代码,股票名称,持有数量,稀释成本价,现价,市值,币种\n\
                        US.QQQ,纳指100ETF,10,450.00,490.00,4900.00,美元\n\
                        HK.00700,腾讯控股,100,320.00,380.00,38000.00,港元\n\
                        美元现金,--,--,--,--,2000.00,美元\n\
                        港元现金,--,--,--,--,15000.00,港元\n";
        let futu = parse_and_preview_csv(futu_csv, "futu.csv", false).expect("futu");
        assert_eq!(futu.detected_format, "futu_positions");
        assert!(futu.snapshot.is_multi_currency);
        assert_eq!(futu.snapshot.currency, "MULTI");
        assert_eq!(futu.snapshot.currencies, vec!["HKD", "USD"]);
        // Fail-safe: never sum USD + HKD cash into single cash scalar
        assert_eq!(futu.snapshot.cash, "0.00");
        assert_eq!(
            futu.snapshot
                .cash_by_currency
                .get("USD")
                .map(String::as_str),
            Some("2000.00")
        );
        assert_eq!(
            futu.snapshot
                .cash_by_currency
                .get("HKD")
                .map(String::as_str),
            Some("15000.00")
        );
        assert_eq!(futu.currency_subtotals.len(), 2);
        assert_eq!(futu.currency_subtotals[0].currency, "HKD");
        assert_eq!(futu.currency_subtotals[0].holdings_value, "38000.00");
        assert_eq!(futu.currency_subtotals[0].total_value, "53000.00");
        assert_eq!(futu.currency_subtotals[1].currency, "USD");
        assert_eq!(futu.currency_subtotals[1].holdings_value, "4900.00");
        assert_eq!(futu.currency_subtotals[1].total_value, "6900.00");
        assert!(futu
            .warnings
            .iter()
            .any(|w| w.contains("Multi-currency CSV detected")));
        assert_eq!(futu.snapshot.holdings[0].symbol, "00700.HK");
        assert_eq!(futu.snapshot.holdings[1].symbol, "QQQ");

        let tiger_csv = "标的代码,标的名称,持仓数量,持仓均价,最新价,持仓市值,结算币种,账户现金\n\
                         BRK.B,伯克希尔B,5,410.00,455.00,$2275.00,USD,$1500.00\n";
        let tiger = parse_and_preview_csv(tiger_csv, "tiger.csv", false).expect("tiger");
        assert_eq!(tiger.detected_format, "tiger_positions");
        assert!(!tiger.snapshot.is_multi_currency);
        assert_eq!(tiger.snapshot.currency, "USD");
        assert_eq!(tiger.snapshot.cash, "1500.00");
        assert_eq!(tiger.snapshot.holdings[0].symbol, "BRK.B");
        assert_eq!(tiger.snapshot.holdings[0].average_cost, "410.0000");
        assert_eq!(tiger.snapshot.holdings[0].last_price, "455.0000");
    }

    #[test]
    fn sanitizes_formula_injection_and_rejects_negative_quantities_and_bad_symbols() {
        let csv = "symbol,description,quantity,average_cost,price,cash\n\
                   NVDA,\"=HYPERLINK(\"\"http://evil.example\"\",\"\"Click\"\")\",10,110.50,130.00,500.00\n";
        let preview = parse_and_preview_csv(csv, "generic.csv", false).expect("parse");
        assert!(!preview.snapshot.holdings[0].company.starts_with('='));
        assert!(preview
            .warnings
            .iter()
            .any(|w| w.contains("formula prefix")));

        let neg_csv = "symbol,quantity,average_cost,price\nAAPL,-5,150,200\n";
        assert!(matches!(
            parse_and_preview_csv(neg_csv, "neg.csv", false),
            Err(CsvImportError::NegativeQuantity { .. })
        ));

        let bad_sym = "symbol,quantity,average_cost,price\n=CMD|bad,5,150,200\n";
        assert!(matches!(
            parse_and_preview_csv(bad_sym, "bad.csv", false),
            Err(CsvImportError::InvalidSymbol { .. })
        ));
    }

    #[test]
    fn computes_identical_fingerprint_for_idempotent_deduplication_and_enforces_size_limit() {
        let csv_a = "symbol,quantity,average_cost,price,cash\nAAPL,10,200.00,220.00,1000\nMSFT,5,400.00,410.00,1000\n";
        let csv_b = "symbol,quantity,average_cost,price,cash\nMSFT,5,400,410,1000.00\nAAPL,10,200,220,1000.00\n";
        let a = parse_and_preview_csv(csv_a, "first.csv", false).expect("a");
        let b = parse_and_preview_csv(csv_b, "second.csv", false).expect("b");
        assert_eq!(a.snapshot.fingerprint, b.snapshot.fingerprint);

        let oversized = "a".repeat(MAX_CSV_BYTES + 1);
        assert!(matches!(
            parse_and_preview_csv(&oversized, "huge.csv", false),
            Err(CsvImportError::FileTooLarge { .. })
        ));
    }

    #[test]
    fn normalizes_schwab_cross_year_dates_and_replays_same_day_split_buy_sell_deterministically() {
        // Schwab exports newest-first with MM/DD/YYYY dates. Previously string sorting put
        // "01/05/2026" BEFORE "12/20/2025", skipping the sell and leaving a 100-share ghost position!
        let schwab_tx = r#""Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"01/05/2026","Sell","GHOST","GHOST CORP","100","$55.00","$0.00","$5,500.00"
"12/20/2025","Buy","GHOST","GHOST CORP","100","$50.00","$0.00","-$5,000.00"
"01/15/2026","Cash Dividend","AAPL","APPLE INC","","","$0.00","$12.00"
"01/15/2026","Sell","AAPL","APPLE INC","20","$105.00","$0.00","$2,100.00"
"01/15/2026","Buy","AAPL","APPLE INC","10","$100.00","$0.00","-$1,000.00"
"01/15/2026","Stock Split","AAPL","APPLE INC","30","$0.00","$0.00","$0.00"
"01/02/2026 as of 12/31/2025","Buy","AAPL","APPLE INC","10","$400.00","$0.00","-$4,000.00"
"#;

        let preview =
            parse_and_preview_csv(schwab_tx, "schwab-transactions.csv", false).expect("schwab tx");
        assert_eq!(preview.detected_format, "schwab_transactions");
        // GHOST was bought 2025-12-20 and fully sold 2026-01-05 -> MUST NOT exist as ghost holding!
        assert!(preview
            .snapshot
            .holdings
            .iter()
            .all(|h| h.symbol != "GHOST"));
        // AAPL: 2025-12-31 buy 10 @ 400 (cost 4000) -> 2026-01-15 split +30 (40 @ 100 avg, cost 4000)
        //       -> same-day buy +10 @ 100 (50 @ 100 avg, cost 5000) -> same-day sell -20 (30 @ 100 avg)
        assert_eq!(preview.snapshot.holdings.len(), 1);
        let aapl = &preview.snapshot.holdings[0];
        assert_eq!(aapl.symbol, "AAPL");
        assert_eq!(aapl.quantity, "30");
        assert_eq!(aapl.average_cost, "100.0000");
        assert_eq!(aapl.last_price, "105.0000");

        // All transaction dates normalized to YYYY-MM-DD
        assert!(preview
            .snapshot
            .transactions
            .iter()
            .all(|t| t.date.len() == 10
                && t.date.as_bytes()[4] == b'-'
                && t.date.as_bytes()[7] == b'-'));
        assert_eq!(preview.snapshot.transactions[0].date, "2025-12-20");
    }

    #[test]
    fn handles_decimal_edge_cases_negative_prices_and_fixed_point_overflows_safely() {
        // (-$100) must remain negative, never double-negated to +100
        assert_eq!(
            parse_decimal_fixed("(-$100.50)", 1, "Amount").expect("neg parens"),
            -100_5000_0000
        );
        assert_eq!(
            parse_decimal_fixed("($-100.50)", 1, "Amount").expect("neg parens 2"),
            -100_5000_0000
        );
        assert_eq!(
            parse_decimal_fixed("\u{2212}1\u{00a0}234.50 HKD", 1, "Amount").expect("unicode"),
            -1234_5000_0000
        );
        assert_eq!(
            parse_decimal_fixed("250.75€", 1, "Amount").expect("trailing eur"),
            250_7500_0000
        );
        assert_eq!(
            infer_currency_from_amount("1234.50 HKD").as_deref(),
            Some("HKD")
        );
        assert_eq!(
            infer_currency_from_amount("250.75€").as_deref(),
            Some("EUR")
        );

        // Reject double signs and contradictory signs
        assert!(parse_decimal_fixed("--100", 1, "Amount").is_err());
        assert!(parse_decimal_fixed("(+100)", 1, "Amount").is_err());
        assert!(parse_decimal_fixed("-$-100", 1, "Amount").is_err());

        // Reject negative average_cost and negative last_price on holdings
        let neg_price_csv = "symbol,quantity,average_cost,price\nAAPL,10,150.00,-20.00\n";
        assert!(matches!(
            parse_and_preview_csv(neg_price_csv, "neg-price.csv", false),
            Err(CsvImportError::NegativeValue { .. })
        ));
        let neg_cost_csv = "symbol,quantity,average_cost,price\nAAPL,10,(-$150.00),200.00\n";
        assert!(matches!(
            parse_and_preview_csv(neg_cost_csv, "neg-cost.csv", false),
            Err(CsvImportError::NegativeValue { .. })
        ));

        // Checked arithmetic: no panic on overflow or i128::MIN denominator
        assert_eq!(
            fixed_mul(i128::MAX, 1),
            Err(CsvImportError::ArithmeticOverflow)
        );
        assert!(fixed_div(1, i128::MIN).is_ok());
    }

    #[test]
    fn handles_real_world_vanguard_dual_table_fidelity_footers_futu_markets_options_and_ibkr_na() {
        // 1. Vanguard dual-table CSV (holdings + blank line + transactions table)
        let vanguard_dual = r#"Account Number,Investment Name,Symbol,Shares,Share Price,Total Value
12345678,Vanguard Total Stock Market ETF,VTI,20,$280.50,$5610.00
12345678,Vanguard Federal Money Market Fund,VMFXX,1200.50,$1.00,$1200.50

Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type
12345678,11/15/2026,11/17/2026,Buy,Buy,Vanguard Total Stock Market ETF,VTI,5,$275.00,-$1375.00,$0.00,-$1375.00,$0.00,INDIVIDUAL
12345678,11/15/2026,11/17/2026,Sweep Out,Sweep Out,Vanguard Federal Money Market Fund,VMFXX,-1375,$1.00,$1375.00,$0.00,$1375.00,$0.00,INDIVIDUAL
"#;
        let van = parse_and_preview_csv(vanguard_dual, "vanguard-dual.csv", false).expect("van");
        assert_eq!(van.detected_format, "vanguard_positions");
        assert_eq!(van.snapshot.holdings.len(), 1);
        assert_eq!(van.snapshot.holdings[0].symbol, "VTI");
        assert_eq!(van.snapshot.holdings[0].quantity, "20");
        assert_eq!(van.snapshot.cash, "1200.50");
        assert_eq!(van.snapshot.transactions.len(), 1);
        assert_eq!(van.snapshot.transactions[0].date, "2026-11-15");

        // 2. Fidelity positions CSV with trailing legal footnotes & option row
        let fidelity_real = r#"Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis,Percent Of Account
X123,Individual,VOO,VANGUARD S&P 500 ETF,10,$515.00,$5150.00,$4600.00,$460.00,64%
X123,Individual,-AAPL261218C250,AAPL DEC 18 2026 $250 CALL,1,$12.00,$1200.00,$1000.00,$10.00,5%
X123,Individual,SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,--,--,$2850.00,--,--,31%

"The data and information in this spreadsheet is provided to you solely for your use and is not for redistribution."
"Brokerage services provided by Fidelity Brokerage Services LLC, Member NYSE, SIPC."
"Date downloaded Nov-21-2026 4:05 p.m ET"
"#;
        let fid = parse_and_preview_csv(fidelity_real, "fidelity-real.csv", false).expect("fid");
        assert_eq!(fid.snapshot.holdings.len(), 1);
        assert_eq!(fid.snapshot.holdings[0].symbol, "VOO");
        assert_eq!(fid.snapshot.cash, "2850.00");
        assert!(fid.warnings.iter().any(|w| w.contains("option")));

        // 3. Schwab Mkt Val (Market Value) cash column + Futu SH./SZ./SG. + 参考市值 + option skip
        let schwab_mkt = r#""Symbol","Description","Quantity","Price","Mkt Val (Market Value)","Cost Basis","Security Type"
"AAPL","APPLE INC","10","$200.00","$2,000.00","$1,800.00","Equity"
"Cash & Cash Investments","--","--","--","$3,456.78","--","Cash and Money Market"
"#;
        let sch = parse_and_preview_csv(schwab_mkt, "schwab-mkt.csv", false).expect("sch");
        assert_eq!(sch.snapshot.cash, "3456.78");

        let futu_real = "股票代码,股票名称,持有数量,稀释成本价,现价,参考市值,币种,资产类别\n\
                         SH.600519,贵州茅台,100,1500.00,1600.00,160000.00,人民币,正股\n\
                         SZ.000001,平安银行,200,10.00,11.00,2200.00,人民币,正股\n\
                         SG.D05,星展集团,100,35.00,40.00,4000.00,新元,正股\n\
                         US.AAPL261218C250000,AAPL CALL,2,5.00,6.00,1200.00,美元,期权\n\
                         人民币现金,--,--,--,--,5000.00,人民币,现金\n";
        let futu = parse_and_preview_csv(futu_real, "futu-real.csv", false).expect("futu");
        let syms: Vec<&str> = futu
            .snapshot
            .holdings
            .iter()
            .map(|h| h.symbol.as_str())
            .collect();
        assert_eq!(syms, vec!["000001.SZ", "600519.SS", "D05.SI"]);
        assert_eq!(
            futu.snapshot
                .cash_by_currency
                .get("CNY")
                .map(String::as_str),
            Some("5000.00")
        );
        assert!(futu.warnings.iter().any(|w| w.contains("option")));

        // 4. IBKR multi-section with N/A & `--` placeholders + option skip
        let ibkr_na = r#"Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Cost Price,Close Price,Description
Positions,Data,Summary,Stocks,USD,MSFT,10,--,420.00,MICROSOFT CORP
Positions,Data,Summary,Equity and Index Options,USD,AAPL 18DEC26 250 C,1,5.00,6.00,AAPL CALL
Trades,Header,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee
Trades,Data,Stocks,USD,MSFT,"2026-11-20, 10:15:00",10,410.00,-4100.00,--
Cash Report,Header,Currency Summary,Currency,Total
Cash Report,Data,Ending Cash,USD,N/A
Cash Report,Data,Ending Cash,EUR,1000.00
"#;
        let ibkr = parse_and_preview_csv(ibkr_na, "ibkr-na.csv", false).expect("ibkr na");
        assert_eq!(ibkr.snapshot.holdings.len(), 1);
        assert_eq!(ibkr.snapshot.holdings[0].symbol, "MSFT");
        assert_eq!(ibkr.snapshot.holdings[0].average_cost, "420.0000");
        assert_eq!(ibkr.snapshot.transactions.len(), 1);
        assert_eq!(ibkr.snapshot.transactions[0].date, "2026-11-20");
        assert_eq!(
            ibkr.snapshot
                .cash_by_currency
                .get("EUR")
                .map(String::as_str),
            Some("1000.00")
        );
        assert!(ibkr.warnings.iter().any(|w| w.contains("option")));
    }

    #[test]
    fn p1_1_non_ascii_symbols_never_panic_in_option_detection() {
        // Multi-byte UTF-8 tokens with byte length == 7 (e.g. "腾讯A" = 7 bytes) used to panic on t[0..2].
        assert!(!looks_like_option_symbol("腾讯A 250 C"));
        assert!(!looks_like_option_symbol("中文字 2026 C"));
        assert!(!looks_like_option_symbol("腾讯控股 250 CALL"));
        assert!(!looks_like_option_symbol("中国平安261218C50"));
        assert!(!looks_like_option_symbol("¥100 2026 P"));
        // Valid ASCII option symbols still detect accurately.
        assert!(looks_like_option_symbol("AAPL 18DEC26 250 C"));
        assert!(looks_like_option_symbol("AAPL261218C250000"));
        assert!(looks_like_option_symbol("NVDA 20261218 140.0 CALL"));
    }

    #[test]
    fn p2_reverse_split_and_negative_split_never_inflate_shares_in_replay() {
        let csv = r#"Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount
01/05/2026,Buy,ACME,ACME CORP,100,$10.00,$0.00,-$1000.00
02/01/2026,Reverse Split,ACME,ACME CORP,50,$0.00,$0.00,$0.00
02/15/2026,合股,ACME,ACME CORP,20,$0.00,$0.00,$0.00
03/01/2026,Stock Split,ACME,ACME CORP,-30,$0.00,$0.00,$0.00
"#;
        let preview = parse_and_preview_csv(csv, "reverse-split.csv", false).expect("parse");
        let acme = preview
            .snapshot
            .holdings
            .iter()
            .find(|h| h.symbol == "ACME")
            .expect("ACME holding");
        // Must NEVER add 50 + 20 + 30 to inflate shares to 200.
        assert_eq!(acme.quantity, "100");
        assert!(
            preview
                .warnings
                .iter()
                .filter(|w| w.contains("Reverse split / share consolidation"))
                .count()
                >= 3,
            "expected explicit warnings for all reverse splits, got: {:?}",
            preview.warnings
        );
    }

    #[test]
    fn v021_ibkr_trades_filters_data_discriminator_order_trade_subtotal_closedlot_washsale() {
        let csv = r#"Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee
Trades,Data,Order,Stocks,USD,AAPL,"2026-11-20, 09:30:01",100,200.00,-20000.00,-1.00
Trades,Data,Trade,Stocks,USD,AAPL,"2026-11-20, 09:30:02",60,200.00,-12000.00,-0.60
Trades,Data,Trade,Stocks,USD,AAPL,"2026-11-20, 09:30:03",40,200.00,-8000.00,-0.40
Trades,Data,SubTotal,Stocks,USD,AAPL,,100,200.00,-20000.00,-1.00
Trades,Data,ClosedLot,Stocks,USD,AAPL,"2026-10-01, 10:00:00",-100,190.00,19000.00,0.00
Trades,Data,WashSale,Stocks,USD,AAPL,"2026-11-20, 09:30:01",10,195.00,-1950.00,0.00
Trades,Data,Trade,Stocks,USD,MSFT,"2026-11-21, 11:00:00",50,410.00,-20500.00,-1.00
Trades,Data,Total,Stocks,USD,,,150,,-40500.00,-2.00
"#;
        let preview = parse_and_preview_csv(csv, "ibkr-disc.csv", false).expect("parse ibkr");
        // AAPL keeps ONLY the Order row (drops duplicate child Trade rows + SubTotal/ClosedLot/WashSale/Total).
        // MSFT has no Order row, so its standalone Trade row is adopted cleanly!
        assert_eq!(preview.snapshot.transactions.len(), 2);
        let aapl_tx = preview
            .snapshot
            .transactions
            .iter()
            .find(|t| t.symbol == "AAPL")
            .expect("AAPL tx");
        assert_eq!(aapl_tx.quantity, "100");
        let msft_tx = preview
            .snapshot
            .transactions
            .iter()
            .find(|t| t.symbol == "MSFT")
            .expect("MSFT tx");
        assert_eq!(msft_tx.quantity, "50");

        // Replayed holdings must equal exact non-duplicated quantities (AAPL=100, MSFT=50).
        let aapl_pos = preview
            .snapshot
            .holdings
            .iter()
            .find(|h| h.symbol == "AAPL")
            .expect("AAPL pos");
        assert_eq!(aapl_pos.quantity, "100");
        let msft_pos = preview
            .snapshot
            .holdings
            .iter()
            .find(|h| h.symbol == "MSFT")
            .expect("MSFT pos");
        assert_eq!(msft_pos.quantity, "50");
    }

    #[test]
    fn v021_csv_infers_all_24_exchange_suffix_currencies_and_avoids_ghost_usd_cash() {
        // 1. Single non-USD market CSV with untagged `Cash` column must NOT create a ghost USD bucket!
        let hk_csv = "Symbol,Quantity,Average Cost,Price,Cash\n00700.HK,100,320,380,15000\n";
        let hk = parse_and_preview_csv(hk_csv, "hk-cash.csv", false).expect("parse hk");
        assert!(!hk.snapshot.is_multi_currency);
        assert_eq!(hk.snapshot.currency, "HKD");
        assert_eq!(hk.snapshot.currencies, vec!["HKD"]);
        assert_eq!(hk.snapshot.cash, "15000.00");
        assert_eq!(
            hk.snapshot.cash_by_currency.get("HKD").map(String::as_str),
            Some("15000.00")
        );
        assert!(!hk.snapshot.cash_by_currency.contains_key("USD"));

        // 2. Untagged generic `Cash` row in a Tokyo `.T` CSV inherits JPY instead of USD!
        let jp_csv =
            "Symbol,Quantity,Average Cost,Price\nCash,1,500000,500000\n7203.T,100,2500,2800\n";
        let jp = parse_and_preview_csv(jp_csv, "jp-cash.csv", false).expect("parse jp");
        assert!(!jp.snapshot.is_multi_currency);
        assert_eq!(jp.snapshot.currency, "JPY");
        assert_eq!(jp.snapshot.cash, "500000.00");

        // 3. Spot-check global 24-market suffix inference.
        let cases = [
            ("00700.HK", "HKD"),
            ("600519.SS", "CNY"),
            ("000858.SZ", "CNY"),
            ("D05.SI", "SGD"),
            ("7203.T", "JPY"),
            ("HSBA.L", "GBP"),
            ("RY.TO", "CAD"),
            ("BHP.AX", "AUD"),
            ("SAP.DE", "EUR"),
            ("MC.PA", "EUR"),
            ("NESN.SW", "CHF"),
            ("NOVO.CO", "DKK"),
            ("VOLV.ST", "SEK"),
            ("EQNR.OL", "NOK"),
            ("2330.TW", "TWD"),
            ("8069.TWO", "TWD"),
            ("005930.KS", "KRW"),
            ("RELIANCE.NS", "INR"),
            ("FPH.NZ", "NZD"),
            ("PETR4.SA", "BRL"),
            ("WALMEX.MX", "MXN"),
            ("BBCA.JK", "IDR"),
            ("PTT.BK", "THB"),
            ("MAYBANK.KL", "MYR"),
            ("TEVA.TA", "ILS"),
            ("NPN.JO", "ZAR"),
        ];
        for (sym, expected_curr) in cases {
            assert_eq!(
                infer_currency_from_symbol(sym).as_deref(),
                Some(expected_curr),
                "suffix currency mismatch for {sym}"
            );
        }
    }
}
