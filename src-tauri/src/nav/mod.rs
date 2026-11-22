//! Pure `i128` fixed-point NAV snapshot calculation, multi-account currency-isolated
//! aggregation, Time-Weighted Return (TWR), and benchmark TWR comparison.
//!
//! Security & financial invariants:
//! - ZERO `f32`/`f64` floating-point arithmetic anywhere in this module.
//! - Currency values use exact `i128` micro-units (`1.000000 = 1_000_000` micros).
//! - Growth wealth factors use `10^9` fixed-point scale (`1.000000000 = 1_000_000_000`).
//! - External cash flows are stripped per sub-period via `(V_end - CF) / V_start`.
//! - Cross-currency aggregation is strictly forbidden: every NAV / TWR / allocation
//!   series operates inside a single currency bucket (`USD`, `HKD`, `CNY`, ...).
//! - When fewer than 2 real snapshots exist, NO simulated points are fabricated.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::storage::{
    i128_string_serde, StoredBenchmarkSeries, StoredNavSnapshot, StoredPortfolioSnapshot,
    DEFAULT_ACCOUNT_ID,
};

pub const MICROS_PER_UNIT: i128 = 1_000_000;
pub const TWR_FACTOR_SCALE: i128 = 1_000_000_000;
pub const WEIGHT_BPS_SCALE: i128 = 10_000;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum NavError {
    #[error("invalid date '{0}': expected YYYY-MM-DD")]
    InvalidDate(String),
    #[error("invalid currency bucket '{0}': cross-currency FX blending is forbidden")]
    InvalidCurrency(String),
    #[error("invalid decimal string: {0}")]
    InvalidDecimal(String),
    #[error("fixed-point arithmetic overflow in NAV/TWR calculation")]
    ArithmeticOverflow,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwrPointDto {
    pub date: String,
    #[serde(with = "i128_string_serde")]
    pub net_value_micros: i128,
    #[serde(with = "i128_string_serde")]
    pub cash_micros: i128,
    #[serde(with = "i128_string_serde")]
    pub positions_micros: i128,
    #[serde(with = "i128_string_serde")]
    pub external_cash_flow_micros: i128,
    /// Investment P&L for this sub-period excluding external cash flow (`V_end - CF - V_start`).
    pub daily_pnl_micros: Option<String>,
    /// Daily sub-period return percentage formatted to 2 decimals (e.g. `"1.25"`), `None` on day 0 or undefined start.
    pub daily_return_pct: Option<String>,
    /// Cumulative TWR percentage formatted to 2 decimals (e.g. `"-3.42"`).
    pub cumulative_twr_pct: String,
    /// Internal cumulative wealth index at `10^9` scale.
    #[serde(with = "i128_string_serde")]
    pub cumulative_factor: i128,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwrSeriesDto {
    pub currency: String,
    pub account_id: String,
    pub snapshot_count: usize,
    pub has_enough_points: bool,
    pub cumulative_twr_pct: Option<String>,
    #[serde(with = "i128_string_serde")]
    pub cumulative_factor: i128,
    #[serde(with = "i128_string_serde")]
    pub period_pnl_micros: i128,
    pub points: Vec<TwrPointDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkTwrPointDto {
    pub date: String,
    #[serde(with = "i128_string_serde")]
    pub close_micros: i128,
    pub cumulative_twr_pct: String,
    #[serde(with = "i128_string_serde")]
    pub cumulative_factor: i128,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkTwrSeriesDto {
    pub symbol: String,
    pub currency: String,
    pub provider: String,
    pub as_of_utc: String,
    pub aligned_count: usize,
    pub cumulative_twr_pct: Option<String>,
    pub points: Vec<BenchmarkTwrPointDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavAnalyticsResponseDto {
    pub portfolio: TwrSeriesDto,
    pub benchmark: Option<BenchmarkTwrSeriesDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketWeightDto {
    pub label: String,
    #[serde(with = "i128_string_serde")]
    pub value_micros: i128,
    /// Exact weight in basis points (`10_000 = 100.00%`).
    #[serde(with = "i128_string_serde")]
    pub weight_bps: i128,
    /// Formatted percentage string (2 decimals, e.g. `"42.50"`).
    pub weight_pct: String,
}

pub fn validate_iso_date(date: &str) -> Result<NaiveDate, NavError> {
    let trimmed = date.trim();
    if trimmed.len() != 10 {
        return Err(NavError::InvalidDate(trimmed.to_string()));
    }
    NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
        .map_err(|_| NavError::InvalidDate(trimmed.to_string()))
}

pub fn validate_single_currency(currency: &str) -> Result<String, NavError> {
    let normalized = currency.trim().to_ascii_uppercase();
    if normalized.is_empty()
        || normalized == "MULTI"
        || normalized.len() < 3
        || normalized.len() > 5
        || !normalized.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err(NavError::InvalidCurrency(currency.to_string()));
    }
    Ok(normalized)
}

/// Exact 128x128 -> 256-bit unsigned multiplication `(hi, lo)`.
fn full_mul_u128(a: u128, b: u128) -> (u128, u128) {
    let a_lo = a as u64 as u128;
    let a_hi = a >> 64;
    let b_lo = b as u64 as u128;
    let b_hi = b >> 64;

    let p0 = a_lo * b_lo;
    let p1 = a_lo * b_hi;
    let p2 = a_hi * b_lo;
    let p3 = a_hi * b_hi;

    let mid = (p0 >> 64) + (p1 as u64 as u128) + (p2 as u64 as u128);
    let lo = (p0 as u64 as u128) | (mid << 64);
    let hi = p3 + (p1 >> 64) + (p2 >> 64) + (mid >> 64);
    (hi, lo)
}

/// Exact 256-by-128 unsigned division when `hi < denom`, returning quotient `q`.
fn div_256_by_128(hi: u128, lo: u128, denom: u128) -> u128 {
    debug_assert!(denom > 0 && hi < denom);
    let mut rem_hi = hi;
    let mut rem_lo = lo;
    let mut quotient: u128 = 0;

    for _ in 0..128 {
        let carry = rem_hi >> 127;
        rem_hi = (rem_hi << 1) | (rem_lo >> 127);
        rem_lo <<= 1;
        quotient <<= 1;
        if carry != 0 || rem_hi >= denom {
            rem_hi = rem_hi.wrapping_sub(denom);
            quotient |= 1;
        }
    }
    quotient
}

/// Computes `round_half_away_from_zero((a * b) / denom)` using exact 256-bit
/// intermediate arithmetic so intermediate multiplication never spuriously overflows.
pub fn mul_div_round_i128(a: i128, b: i128, denom: i128) -> Result<i128, NavError> {
    if denom == 0 {
        return Err(NavError::ArithmeticOverflow);
    }
    if a == 0 || b == 0 {
        return Ok(0);
    }

    let negative = (a < 0) ^ (b < 0) ^ (denom < 0);
    let ua = a.unsigned_abs();
    let ub = b.unsigned_abs();
    let ud = denom.unsigned_abs();

    let (mut hi, mut lo) = full_mul_u128(ua, ub);
    let half = ud / 2;
    let (new_lo, carry) = lo.overflowing_add(half);
    lo = new_lo;
    if carry {
        hi = hi.checked_add(1).ok_or(NavError::ArithmeticOverflow)?;
    }

    if hi >= ud {
        return Err(NavError::ArithmeticOverflow);
    }

    let q = div_256_by_128(hi, lo, ud);
    if negative {
        if q == (i128::MAX as u128) + 1 {
            Ok(i128::MIN)
        } else if q > (i128::MAX as u128) {
            Err(NavError::ArithmeticOverflow)
        } else {
            Ok(-(q as i128))
        }
    } else if q > (i128::MAX as u128) {
        Err(NavError::ArithmeticOverflow)
    } else {
        Ok(q as i128)
    }
}

/// Strictly parses a signed decimal string into `10^6`-scaled `i128` micro-units.
/// Uses half-away-from-zero rounding if more than 6 fractional digits exist.
pub fn parse_decimal_to_micros(raw: &str) -> Result<i128, NavError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.is_ascii() {
        return Err(NavError::InvalidDecimal(raw.to_string()));
    }
    let (negative, unsigned) = if let Some(rest) = trimmed.strip_prefix('-') {
        (true, rest)
    } else if let Some(rest) = trimmed.strip_prefix('+') {
        (false, rest)
    } else {
        (false, trimmed)
    };

    let mut parts = unsigned.split('.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next().unwrap_or("");
    if parts.next().is_some()
        || (int_part.is_empty() && frac_part.is_empty())
        || !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(NavError::InvalidDecimal(raw.to_string()));
    }

    let int_val: i128 = if int_part.is_empty() {
        0
    } else {
        int_part.parse().map_err(|_| NavError::ArithmeticOverflow)?
    };

    let mut frac_micros: i128 = 0;
    let frac_bytes = frac_part.as_bytes();
    for i in 0..6 {
        let digit = if i < frac_bytes.len() {
            i128::from(frac_bytes[i] - b'0')
        } else {
            0
        };
        frac_micros = frac_micros * 10 + digit;
    }
    if frac_bytes.len() > 6 && frac_bytes[6] >= b'5' {
        frac_micros += 1;
    }

    let magnitude = int_val
        .checked_mul(MICROS_PER_UNIT)
        .and_then(|v| v.checked_add(frac_micros))
        .ok_or(NavError::ArithmeticOverflow)?;

    if negative {
        magnitude.checked_neg().ok_or(NavError::ArithmeticOverflow)
    } else {
        Ok(magnitude)
    }
}

/// Formats `i128` micro-units (`10^6`) to a fixed-decimal string (0..=6 decimals).
pub fn format_micros(micros: i128, decimals: u32) -> String {
    let clamped = decimals.min(6);
    let negative = micros < 0;
    let abs = micros.unsigned_abs();
    let shift = 6 - clamped;
    let divisor = 10_u128.pow(shift);
    let rounded = (abs + divisor / 2) / divisor;
    let scale_pow = 10_u128.pow(clamped);
    let whole = rounded / scale_pow;
    let frac = rounded % scale_pow;
    let sign = if negative && rounded > 0 { "-" } else { "" };
    if clamped == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{frac:0width$}", width = clamped as usize)
    }
}

/// Converts a `10^9`-scaled wealth factor to a 2-decimal percentage string:
/// `(factor - 10^9) * 100 / 10^9`, e.g. `1_123_450_000` -> `"12.35"`.
pub fn format_return_pct_from_factor(factor: i128) -> Result<String, NavError> {
    let delta = factor
        .checked_sub(TWR_FACTOR_SCALE)
        .ok_or(NavError::ArithmeticOverflow)?;
    // Convert delta (scale 10^9) into hundredths of a percent (scale 10^4):
    // pct_hundredths = delta * 10_000 / 1_000_000_000 = delta / 100_000
    let pct_hundredths = mul_div_round_i128(delta, 10_000, TWR_FACTOR_SCALE)?;
    let negative = pct_hundredths < 0;
    let abs = pct_hundredths.unsigned_abs();
    let whole = abs / 100;
    let frac = abs % 100;
    let sign = if negative && abs > 0 { "-" } else { "" };
    Ok(format!("{sign}{whole}.{frac:02}"))
}

/// Builds per-currency `StoredNavSnapshot` records from a `StoredPortfolioSnapshot`
/// using pure `i128` fixed-point arithmetic (zero float).
pub fn build_nav_snapshots_from_portfolio(
    portfolio: &StoredPortfolioSnapshot,
    date: &str,
    source: &str,
    updated_at: &str,
) -> Result<Vec<StoredNavSnapshot>, NavError> {
    validate_iso_date(date)?;
    let account_id = if portfolio.account_id.trim().is_empty() {
        DEFAULT_ACCOUNT_ID.to_string()
    } else {
        portfolio.account_id.trim().to_string()
    };

    let mut positions_by_currency: BTreeMap<String, i128> = BTreeMap::new();
    let mut cash_by_currency: BTreeMap<String, i128> = BTreeMap::new();
    let mut currencies: BTreeSet<String> = BTreeSet::new();

    for holding in &portfolio.holdings {
        let curr = validate_single_currency(if holding.currency.trim().is_empty() {
            "USD"
        } else {
            &holding.currency
        })?;
        let qty_micros = parse_decimal_to_micros(&holding.quantity)?;
        let price_str = if holding.last_price.trim().is_empty() {
            &holding.average_cost
        } else {
            &holding.last_price
        };
        let price_micros = parse_decimal_to_micros(price_str)?;
        // Holding market value in micros = round((qty_micros * price_micros) / 10^6)
        let mv_micros = mul_div_round_i128(qty_micros, price_micros, MICROS_PER_UNIT)?;
        let entry = positions_by_currency.entry(curr.clone()).or_insert(0);
        *entry = entry
            .checked_add(mv_micros)
            .ok_or(NavError::ArithmeticOverflow)?;
        currencies.insert(curr);
    }

    if !portfolio.cash_by_currency.is_empty() {
        for (raw_curr, raw_cash) in &portfolio.cash_by_currency {
            if let Ok(curr) = validate_single_currency(raw_curr) {
                let cash_micros = parse_decimal_to_micros(raw_cash)?;
                let entry = cash_by_currency.entry(curr.clone()).or_insert(0);
                *entry = entry
                    .checked_add(cash_micros)
                    .ok_or(NavError::ArithmeticOverflow)?;
                if cash_micros != 0 || currencies.contains(&curr) {
                    currencies.insert(curr);
                }
            }
        }
    } else if !portfolio.is_multi_currency {
        let fallback_curr = validate_single_currency(if portfolio.currency.trim().is_empty() {
            "USD"
        } else {
            &portfolio.currency
        })?;
        let cash_micros = parse_decimal_to_micros(&portfolio.cash)?;
        cash_by_currency.insert(fallback_curr.clone(), cash_micros);
        currencies.insert(fallback_curr);
    }

    if currencies.is_empty() {
        let fallback = if portfolio.currency.trim().is_empty()
            || portfolio.currency.eq_ignore_ascii_case("MULTI")
        {
            "USD".to_string()
        } else {
            validate_single_currency(&portfolio.currency)?
        };
        currencies.insert(fallback);
    }

    let mut out = Vec::with_capacity(currencies.len());
    for curr in currencies {
        let cash_micros = *cash_by_currency.get(&curr).unwrap_or(&0);
        let positions_micros = *positions_by_currency.get(&curr).unwrap_or(&0);
        let net_value_micros = cash_micros
            .checked_add(positions_micros)
            .ok_or(NavError::ArithmeticOverflow)?;
        out.push(StoredNavSnapshot {
            date: date.trim().to_string(),
            account_id: account_id.clone(),
            currency: curr,
            net_value_micros,
            cash_micros,
            positions_micros,
            external_cash_flow_micros: 0,
            source: source.to_string(),
            updated_at: updated_at.to_string(),
        });
    }
    Ok(out)
}

/// Aggregates `StoredNavSnapshot` records strictly within a single currency bucket.
///
/// - When `account_id` is `Some(id)` (and not `"ALL"`), returns deduplicated chronologically
///   sorted snapshots for that single account.
/// - When `account_id` is `None` or `Some("ALL")`, aggregates across all accounts in that
///   currency bucket on the sorted union of snapshot dates using carry-forward of each
///   account's latest known valuation. If a new account enters after the earliest portfolio
///   date, its initial NAV is treated as an external cash flow on its entry date (unless
///   already accounted for) so adding a second brokerage account never distorts TWR.
pub fn aggregate_nav_snapshots_for_currency(
    snapshots: &[StoredNavSnapshot],
    currency: &str,
    account_id: Option<&str>,
) -> Result<Vec<StoredNavSnapshot>, NavError> {
    let target_currency = validate_single_currency(currency)?;
    let filter_single = account_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && !id.eq_ignore_ascii_case("ALL"));

    if let Some(single_id) = filter_single {
        let mut by_date: BTreeMap<String, StoredNavSnapshot> = BTreeMap::new();
        for snap in snapshots {
            if snap.account_id == single_id && snap.currency.eq_ignore_ascii_case(&target_currency)
            {
                validate_iso_date(&snap.date)?;
                by_date.insert(snap.date.clone(), snap.clone());
            }
        }
        return Ok(by_date.into_values().collect());
    }

    // Group per-account snapshots by date strictly inside `target_currency`.
    let mut per_account: BTreeMap<String, BTreeMap<String, StoredNavSnapshot>> = BTreeMap::new();
    let mut all_dates: BTreeSet<String> = BTreeSet::new();

    for snap in snapshots {
        if !snap.currency.eq_ignore_ascii_case(&target_currency) {
            continue;
        }
        validate_iso_date(&snap.date)?;
        all_dates.insert(snap.date.clone());
        per_account
            .entry(snap.account_id.clone())
            .or_default()
            .insert(snap.date.clone(), snap.clone());
    }

    if all_dates.is_empty() {
        return Ok(Vec::new());
    }

    let first_global_date = all_dates.iter().next().cloned().unwrap_or_default();
    let mut latest_by_account: BTreeMap<String, StoredNavSnapshot> = BTreeMap::new();
    let mut aggregated = Vec::with_capacity(all_dates.len());

    for date in all_dates {
        let mut net_sum: i128 = 0;
        let mut cash_sum: i128 = 0;
        let mut pos_sum: i128 = 0;
        let mut cf_sum: i128 = 0;
        let mut latest_updated = String::new();

        for (acct_id, date_map) in &per_account {
            if let Some(today_snap) = date_map.get(&date) {
                let is_first_for_account = !latest_by_account.contains_key(acct_id);
                let effective_cf = if is_first_for_account && date > first_global_date {
                    // Account newly added on a later date: its full opening NAV on entry day
                    // represents external capital onboarding into the aggregate portfolio
                    // (even if the account also recorded a partial same-day cash flow).
                    today_snap.net_value_micros
                } else {
                    today_snap.external_cash_flow_micros
                };
                cf_sum = cf_sum
                    .checked_add(effective_cf)
                    .ok_or(NavError::ArithmeticOverflow)?;
                if today_snap.updated_at > latest_updated {
                    latest_updated = today_snap.updated_at.clone();
                }
                latest_by_account.insert(acct_id.clone(), today_snap.clone());
            }

            if let Some(active) = latest_by_account.get(acct_id) {
                net_sum = net_sum
                    .checked_add(active.net_value_micros)
                    .ok_or(NavError::ArithmeticOverflow)?;
                cash_sum = cash_sum
                    .checked_add(active.cash_micros)
                    .ok_or(NavError::ArithmeticOverflow)?;
                pos_sum = pos_sum
                    .checked_add(active.positions_micros)
                    .ok_or(NavError::ArithmeticOverflow)?;
                if active.updated_at > latest_updated {
                    latest_updated = active.updated_at.clone();
                }
            }
        }

        aggregated.push(StoredNavSnapshot {
            date,
            account_id: "ALL".to_string(),
            currency: target_currency.clone(),
            net_value_micros: net_sum,
            cash_micros: cash_sum,
            positions_micros: pos_sum,
            external_cash_flow_micros: cf_sum,
            source: "aggregated".to_string(),
            updated_at: latest_updated,
        });
    }

    Ok(aggregated)
}

/// Computes pure `i128` fixed-point Time-Weighted Return (TWR) across chronologically
/// ordered snapshots within one currency bucket.
///
/// Sub-period formula (GIPS BOD-inflow / EOD-outflow convention, scaled by `10^9`):
/// - For inflows (`CF > 0`): `sub_factor = V_end / (V_start + CF)` so large deposits on a
///   small base with an intraday drawdown never collapse `cum_factor` to `0` (`-100.00%`).
/// - For outflows or zero flow (`CF <= 0`): `sub_factor = (V_end - CF) / V_start`.
/// - Cumulative TWR factor: `cum_factor = cum_factor * sub_factor / 10^9`.
///
/// Edge-case guarantees:
/// - Empty (`0` points): `has_enough_points = false`, `cumulative_twr_pct = None`.
/// - Single day (`1` point): `has_enough_points = false`, `cumulative_twr_pct = None` (never fabricates a 2nd point!).
/// - `V_start <= 0`: sub-period return is undefined -> neutral factor `1.0`, `daily_return_pct = None`.
/// - Total wipeout (`V_end <= 0` for inflows, or `V_end - CF <= 0` for outflows/zero-CF): floored at `0` (`-100.00%`).
/// - Extreme `i128` boundaries: checked arithmetic returns `Err(NavError::ArithmeticOverflow)` instead of panicking.
pub fn compute_twr_series(
    raw_snapshots: &[StoredNavSnapshot],
    currency: &str,
    account_id: &str,
) -> Result<TwrSeriesDto, NavError> {
    let valid_currency = validate_single_currency(currency)?;
    let mut by_date: BTreeMap<String, &StoredNavSnapshot> = BTreeMap::new();
    for snap in raw_snapshots {
        validate_iso_date(&snap.date)?;
        if !snap.currency.eq_ignore_ascii_case(&valid_currency) {
            return Err(NavError::InvalidCurrency(snap.currency.clone()));
        }
        by_date.insert(snap.date.clone(), snap);
    }

    let sorted: Vec<&StoredNavSnapshot> = by_date.into_values().collect();
    if sorted.is_empty() {
        return Ok(TwrSeriesDto {
            currency: valid_currency,
            account_id: account_id.to_string(),
            snapshot_count: 0,
            has_enough_points: false,
            cumulative_twr_pct: None,
            cumulative_factor: TWR_FACTOR_SCALE,
            period_pnl_micros: 0,
            points: Vec::new(),
        });
    }

    let mut points = Vec::with_capacity(sorted.len());
    let mut cum_factor = TWR_FACTOR_SCALE;
    let mut period_pnl_micros: i128 = 0;

    let first = sorted[0];
    points.push(TwrPointDto {
        date: first.date.clone(),
        net_value_micros: first.net_value_micros,
        cash_micros: first.cash_micros,
        positions_micros: first.positions_micros,
        external_cash_flow_micros: first.external_cash_flow_micros,
        daily_pnl_micros: None,
        daily_return_pct: None,
        cumulative_twr_pct: "0.00".to_string(),
        cumulative_factor: TWR_FACTOR_SCALE,
    });

    for window in sorted.windows(2) {
        let prev = window[0];
        let curr = window[1];
        let v_start = prev.net_value_micros;
        let v_end = curr.net_value_micros;
        let cf = curr.external_cash_flow_micros;

        let adjusted_end = v_end.checked_sub(cf).ok_or(NavError::ArithmeticOverflow)?;
        let daily_pnl = adjusted_end
            .checked_sub(v_start)
            .ok_or(NavError::ArithmeticOverflow)?;
        period_pnl_micros = period_pnl_micros
            .checked_add(daily_pnl)
            .ok_or(NavError::ArithmeticOverflow)?;

        let (sub_factor, daily_return_pct) = if v_start <= 0 {
            (TWR_FACTOR_SCALE, None)
        } else if cf > 0 {
            // Beginning-of-day inflow convention: capital base is `V_start + CF`.
            let capital_base = v_start
                .checked_add(cf)
                .ok_or(NavError::ArithmeticOverflow)?;
            if v_end <= 0 {
                (0_i128, Some("-100.00".to_string()))
            } else {
                let factor = mul_div_round_i128(v_end, TWR_FACTOR_SCALE, capital_base)?;
                let pct = format_return_pct_from_factor(factor)?;
                (factor, Some(pct))
            }
        } else if adjusted_end <= 0 {
            (0_i128, Some("-100.00".to_string()))
        } else {
            let factor = mul_div_round_i128(adjusted_end, TWR_FACTOR_SCALE, v_start)?;
            let pct = format_return_pct_from_factor(factor)?;
            (factor, Some(pct))
        };

        cum_factor = mul_div_round_i128(cum_factor, sub_factor, TWR_FACTOR_SCALE)?;
        let cum_pct = format_return_pct_from_factor(cum_factor)?;

        points.push(TwrPointDto {
            date: curr.date.clone(),
            net_value_micros: curr.net_value_micros,
            cash_micros: curr.cash_micros,
            positions_micros: curr.positions_micros,
            external_cash_flow_micros: curr.external_cash_flow_micros,
            daily_pnl_micros: Some(daily_pnl.to_string()),
            daily_return_pct,
            cumulative_twr_pct: cum_pct,
            cumulative_factor: cum_factor,
        });
    }

    let has_enough_points = points.len() >= 2;
    let cumulative_twr_pct = if has_enough_points {
        Some(format_return_pct_from_factor(cum_factor)?)
    } else {
        None
    };

    Ok(TwrSeriesDto {
        currency: valid_currency,
        account_id: account_id.to_string(),
        snapshot_count: points.len(),
        has_enough_points,
        cumulative_twr_pct,
        cumulative_factor: cum_factor,
        period_pnl_micros,
        points,
    })
}

/// Aligns a cached read-only benchmark series to portfolio snapshot dates and computes
/// exact `i128` cumulative benchmark TWR starting at `0.00%` on the first overlapping date.
///
/// For weekend/holiday portfolio dates, carries forward the latest benchmark close on or
/// before that date. When benchmark history starts after `dates[0]`, anchors at the first
/// common overlapping date instead of dropping the entire series. Returns an empty `points`
/// vector if fewer than 2 portfolio dates exist or no overlapping benchmark close exists.
pub fn compute_benchmark_twr_series(
    dates: &[String],
    benchmark: &StoredBenchmarkSeries,
) -> Result<BenchmarkTwrSeriesDto, NavError> {
    if dates.len() < 2 || benchmark.points.is_empty() {
        return Ok(BenchmarkTwrSeriesDto {
            symbol: benchmark.symbol.clone(),
            currency: benchmark.currency.clone(),
            provider: benchmark.provider.clone(),
            as_of_utc: benchmark.as_of_utc.clone(),
            aligned_count: 0,
            cumulative_twr_pct: None,
            points: Vec::new(),
        });
    }

    let mut price_by_date: BTreeMap<&str, i128> = BTreeMap::new();
    for pt in &benchmark.points {
        if pt.close_micros > 0 && validate_iso_date(&pt.date).is_ok() {
            price_by_date.insert(pt.date.as_str(), pt.close_micros);
        }
    }

    let find_close_on_or_before = |target_date: &str| -> Option<i128> {
        price_by_date
            .range(..=target_date)
            .next_back()
            .map(|(_, &close)| close)
    };

    let mut base_close: Option<i128> = None;
    let mut aligned = Vec::with_capacity(dates.len());
    for date in dates {
        let Some(close) = find_close_on_or_before(date.as_str()) else {
            continue;
        };
        if close <= 0 {
            continue;
        }
        let anchor = *base_close.get_or_insert(close);
        let factor = mul_div_round_i128(close, TWR_FACTOR_SCALE, anchor)?;
        let pct = format_return_pct_from_factor(factor)?;
        aligned.push(BenchmarkTwrPointDto {
            date: date.clone(),
            close_micros: close,
            cumulative_twr_pct: pct,
            cumulative_factor: factor,
        });
    }

    let cumulative_twr_pct = if aligned.len() >= 2 {
        aligned.last().map(|pt| pt.cumulative_twr_pct.clone())
    } else {
        None
    };

    Ok(BenchmarkTwrSeriesDto {
        symbol: benchmark.symbol.clone(),
        currency: benchmark.currency.clone(),
        provider: benchmark.provider.clone(),
        as_of_utc: benchmark.as_of_utc.clone(),
        aligned_count: aligned.len(),
        cumulative_twr_pct,
        points: aligned,
    })
}

/// Computes pure `i128` asset allocation weights inside a single currency bucket.
pub fn compute_currency_bucket_weights(
    items: &[(&str, i128)],
    cash_micros: i128,
) -> Result<Vec<BucketWeightDto>, NavError> {
    let mut total: i128 = cash_micros.max(0);
    for &(_, val) in items {
        if val > 0 {
            total = total.checked_add(val).ok_or(NavError::ArithmeticOverflow)?;
        }
    }

    if total <= 0 {
        return Ok(vec![BucketWeightDto {
            label: "CASH".to_string(),
            value_micros: 0,
            weight_bps: WEIGHT_BPS_SCALE,
            weight_pct: "100.00".to_string(),
        }]);
    }

    let format_bps = |bps: i128| -> String {
        let whole = bps / 100;
        let frac = bps % 100;
        format!("{whole}.{frac:02}")
    };

    let mut out = Vec::with_capacity(items.len() + 1);
    for &(label, val) in items {
        let clamped = val.max(0);
        if clamped == 0 {
            continue;
        }
        let bps = mul_div_round_i128(clamped, WEIGHT_BPS_SCALE, total)?;
        out.push(BucketWeightDto {
            label: label.to_string(),
            value_micros: clamped,
            weight_bps: bps,
            weight_pct: format_bps(bps),
        });
    }

    let clamped_cash = cash_micros.max(0);
    if clamped_cash > 0 {
        let bps = mul_div_round_i128(clamped_cash, WEIGHT_BPS_SCALE, total)?;
        out.push(BucketWeightDto {
            label: "CASH".to_string(),
            value_micros: clamped_cash,
            weight_bps: bps,
            weight_pct: format_bps(bps),
        });
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{BenchmarkPricePoint, StoredPortfolioHolding};

    fn snap(
        date: &str,
        account_id: &str,
        currency: &str,
        net: i128,
        cf: i128,
    ) -> StoredNavSnapshot {
        StoredNavSnapshot {
            date: date.to_string(),
            account_id: account_id.to_string(),
            currency: currency.to_string(),
            net_value_micros: net,
            cash_micros: 0,
            positions_micros: net,
            external_cash_flow_micros: cf,
            source: "test".to_string(),
            updated_at: format!("{date}T21:00:00.000Z"),
        }
    }

    #[test]
    fn twr_handles_empty_and_single_day_honestly_without_fabricating_points() {
        let empty = compute_twr_series(&[], "USD", "acct_default").expect("empty");
        assert_eq!(empty.snapshot_count, 0);
        assert!(!empty.has_enough_points);
        assert_eq!(empty.cumulative_twr_pct, None);
        assert!(empty.points.is_empty());

        let single = compute_twr_series(
            &[snap(
                "2026-11-20",
                "acct_default",
                "USD",
                10_000 * MICROS_PER_UNIT,
                0,
            )],
            "USD",
            "acct_default",
        )
        .expect("single");
        assert_eq!(single.snapshot_count, 1);
        assert!(!single.has_enough_points);
        assert_eq!(single.cumulative_twr_pct, None);
        assert_eq!(single.points.len(), 1);
        assert_eq!(single.points[0].daily_return_pct, None);
        assert_eq!(single.points[0].cumulative_twr_pct, "0.00");
    }

    #[test]
    fn twr_strips_cross_day_inflows_and_outflows_accurately_with_pure_i128() {
        // Day 1: $10,000
        // Day 2: BOD deposit +$5,000 (capital base $15,000), market +10% => V_end = $16,500, CF = +$5,000
        //        sub-period 1: 16_500 / (10_000 + 5_000) = 1.10 (+10.00%), P&L = +$1,500
        // Day 3: market -10% on $16,500 -> $14,850, EOD withdrawal -$4,850 => V_end = $10,000, CF = -$4,850
        //        sub-period 2: (10_000 - (-4_850)) / 16_500 = 14_850 / 16_500 = 0.90 (-10.00%), P&L = -$1,650
        // Cumulative TWR = 1.10 * 0.90 - 1 = 0.99 - 1 = -1.00%
        // True P&L = +$1,500 - $1,650 = -$150 (even though V_end == V_start == $10,000!)
        let series = compute_twr_series(
            &[
                snap(
                    "2026-11-18",
                    "acct_default",
                    "USD",
                    10_000 * MICROS_PER_UNIT,
                    0,
                ),
                snap(
                    "2026-11-19",
                    "acct_default",
                    "USD",
                    16_500 * MICROS_PER_UNIT,
                    5_000 * MICROS_PER_UNIT,
                ),
                snap(
                    "2026-11-20",
                    "acct_default",
                    "USD",
                    10_000 * MICROS_PER_UNIT,
                    -4_850 * MICROS_PER_UNIT,
                ),
            ],
            "USD",
            "acct_default",
        )
        .expect("twr with cash flows");

        assert!(series.has_enough_points);
        assert_eq!(series.snapshot_count, 3);
        assert_eq!(series.points[1].daily_return_pct.as_deref(), Some("10.00"));
        assert_eq!(series.points[1].cumulative_twr_pct, "10.00");
        assert_eq!(series.points[2].daily_return_pct.as_deref(), Some("-10.00"));
        assert_eq!(series.points[2].cumulative_twr_pct, "-1.00");
        assert_eq!(series.cumulative_twr_pct.as_deref(), Some("-1.00"));
        assert_eq!(series.period_pnl_micros, -150 * MICROS_PER_UNIT);
    }

    #[test]
    fn twr_guards_against_zero_start_negative_adjusted_end_and_i128_overflow() {
        // 1. Zero V_start followed by deposit does not divide by zero
        let zero_start = compute_twr_series(
            &[
                snap("2026-11-18", "acct_default", "USD", 0, 0),
                snap(
                    "2026-11-19",
                    "acct_default",
                    "USD",
                    5_000 * MICROS_PER_UNIT,
                    5_000 * MICROS_PER_UNIT,
                ),
                snap(
                    "2026-11-20",
                    "acct_default",
                    "USD",
                    5_500 * MICROS_PER_UNIT,
                    0,
                ),
            ],
            "USD",
            "acct_default",
        )
        .expect("zero start safe");
        assert_eq!(zero_start.points[1].daily_return_pct, None);
        assert_eq!(
            zero_start.points[2].daily_return_pct.as_deref(),
            Some("10.00")
        );
        assert_eq!(zero_start.cumulative_twr_pct.as_deref(), Some("10.00"));

        // 2. P0-6 regression: small base ($100) + large deposit (+$10,000) + -2% intraday drop ($9,898)
        //    must NEVER lock cum_factor at 0 (-100.00%); Day 3 +50% ($14,847) recovers cleanly to +47.00%!
        let large_inflow_dip = compute_twr_series(
            &[
                snap(
                    "2026-11-18",
                    "acct_default",
                    "USD",
                    100 * MICROS_PER_UNIT,
                    0,
                ),
                snap(
                    "2026-11-19",
                    "acct_default",
                    "USD",
                    9_898 * MICROS_PER_UNIT,
                    10_000 * MICROS_PER_UNIT,
                ),
                snap(
                    "2026-11-20",
                    "acct_default",
                    "USD",
                    14_847 * MICROS_PER_UNIT,
                    0,
                ),
            ],
            "USD",
            "acct_default",
        )
        .expect("large inflow dip safe");
        assert_eq!(
            large_inflow_dip.points[1].daily_return_pct.as_deref(),
            Some("-2.00")
        );
        assert_eq!(large_inflow_dip.points[1].cumulative_twr_pct, "-2.00");
        assert_eq!(
            large_inflow_dip.points[2].daily_return_pct.as_deref(),
            Some("50.00")
        );
        assert_eq!(
            large_inflow_dip.cumulative_twr_pct.as_deref(),
            Some("47.00")
        );
        assert_eq!(large_inflow_dip.cumulative_factor, 1_470_000_000);
        assert_eq!(large_inflow_dip.period_pnl_micros, 4_747 * MICROS_PER_UNIT);

        // 3. Genuine total wipeout (V_end = 0, CF = 0) still floors cleanly at -100.00% without sign flip
        let wiped = compute_twr_series(
            &[
                snap(
                    "2026-11-18",
                    "acct_default",
                    "USD",
                    1_000 * MICROS_PER_UNIT,
                    0,
                ),
                snap("2026-11-19", "acct_default", "USD", 0, 0),
            ],
            "USD",
            "acct_default",
        )
        .expect("wipeout safe");
        assert_eq!(wiped.points[1].daily_return_pct.as_deref(), Some("-100.00"));
        assert_eq!(wiped.cumulative_twr_pct.as_deref(), Some("-100.00"));

        // 4. Extreme i128::MAX / i128::MIN overflow is caught gracefully as Err, never panics
        let overflow_err = compute_twr_series(
            &[
                snap("2026-11-18", "acct_default", "USD", 1, 0),
                snap("2026-11-19", "acct_default", "USD", i128::MAX, -10),
            ],
            "USD",
            "acct_default",
        )
        .expect_err("must detect i128 overflow");
        assert_eq!(overflow_err, NavError::ArithmeticOverflow);

        // 5. Rejects cross-currency MULTI bucket
        let multi_err = compute_twr_series(&[], "MULTI", "ALL").expect_err("reject MULTI");
        assert!(matches!(multi_err, NavError::InvalidCurrency(_)));
    }

    #[test]
    fn aggregates_multiple_accounts_per_currency_without_fake_onboarding_return_spike() {
        // Account A starts Day 1 at $10,000, grows 10% on Day 2 to $11,000.
        // Account B is newly onboarded on Day 2 with $20,000 AND an internal same-day CF of $1,000:
        // its FULL $20,000 onboarding NAV must be counted as aggregate external CF (P1-1), NOT $1,000!
        // Account C is in HKD (must be strictly excluded from USD bucket!).
        let snaps = vec![
            snap(
                "2026-11-18",
                "acct_schwab_taxable",
                "USD",
                10_000 * MICROS_PER_UNIT,
                0,
            ),
            snap(
                "2026-11-19",
                "acct_schwab_taxable",
                "USD",
                11_000 * MICROS_PER_UNIT,
                0,
            ),
            snap(
                "2026-11-19",
                "acct_schwab_ira",
                "USD",
                20_000 * MICROS_PER_UNIT,
                1_000 * MICROS_PER_UNIT,
            ),
            snap(
                "2026-11-19",
                "acct_futu_hk",
                "HKD",
                50_000 * MICROS_PER_UNIT,
                0,
            ),
        ];

        let usd_agg = aggregate_nav_snapshots_for_currency(&snaps, "USD", Some("ALL"))
            .expect("aggregate USD");
        assert_eq!(usd_agg.len(), 2);
        assert_eq!(usd_agg[0].net_value_micros, 10_000 * MICROS_PER_UNIT);
        assert_eq!(usd_agg[1].net_value_micros, 31_000 * MICROS_PER_UNIT);
        assert_eq!(
            usd_agg[1].external_cash_flow_micros,
            20_000 * MICROS_PER_UNIT
        );

        let twr = compute_twr_series(&usd_agg, "USD", "ALL").expect("agg twr");
        // True P&L = +$1,000 (not +$20,000); BOD inflow return = 31_000 / (10_000 + 20_000) - 1 = +3.33%
        assert_eq!(twr.period_pnl_micros, 1_000 * MICROS_PER_UNIT);
        assert_eq!(twr.cumulative_twr_pct.as_deref(), Some("3.33"));
    }

    #[test]
    fn aligns_benchmark_twr_with_weekend_carry_forward_and_builds_snapshots_from_portfolio() {
        let bench = StoredBenchmarkSeries {
            symbol: "SPY".to_string(),
            currency: "USD".to_string(),
            provider: "stooq.com".to_string(),
            as_of_utc: "2026-11-22T00:00:00.000Z".to_string(),
            points: vec![
                BenchmarkPricePoint {
                    date: "2026-11-18".to_string(),
                    close_micros: 500 * MICROS_PER_UNIT,
                },
                BenchmarkPricePoint {
                    date: "2026-11-20".to_string(),
                    close_micros: 525 * MICROS_PER_UNIT,
                },
            ],
        };
        // Portfolio has snapshots on 11-18, 11-19 (benchmark gap -> carries 11-18 close), 11-21 (Saturday -> carries 11-20 close)
        let dates = vec![
            "2026-11-18".to_string(),
            "2026-11-19".to_string(),
            "2026-11-21".to_string(),
        ];
        let aligned = compute_benchmark_twr_series(&dates, &bench).expect("bench twr");
        assert_eq!(aligned.aligned_count, 3);
        assert_eq!(aligned.points[0].cumulative_twr_pct, "0.00");
        assert_eq!(aligned.points[1].cumulative_twr_pct, "0.00");
        assert_eq!(aligned.points[2].cumulative_twr_pct, "5.00");
        assert_eq!(aligned.cumulative_twr_pct.as_deref(), Some("5.00"));

        // Build per-currency snapshots from multi-currency portfolio using pure i128
        let multi = StoredPortfolioSnapshot {
            id: "snap-1".to_string(),
            account_id: "acct_futu".to_string(),
            fingerprint: "fp-1".to_string(),
            source_format: "futu_positions".to_string(),
            source_label: "futu.csv".to_string(),
            imported_at_utc: "2026-11-22T02:00:00.000Z".to_string(),
            account_label: "Futu HK".to_string(),
            currency: "MULTI".to_string(),
            cash: "0.00".to_string(),
            cash_by_currency: BTreeMap::from([
                ("HKD".to_string(), "15000.50".to_string()),
                ("USD".to_string(), "2000.25".to_string()),
            ]),
            currencies: vec!["HKD".to_string(), "USD".to_string()],
            is_multi_currency: true,
            holdings: vec![
                StoredPortfolioHolding {
                    symbol: "00700.HK".to_string(),
                    company: "Tencent".to_string(),
                    quantity: "100".to_string(),
                    average_cost: "320.00".to_string(),
                    last_price: "380.10".to_string(),
                    currency: "HKD".to_string(),
                },
                StoredPortfolioHolding {
                    symbol: "QQQ".to_string(),
                    company: "Invesco QQQ".to_string(),
                    quantity: "10".to_string(),
                    average_cost: "450.00".to_string(),
                    last_price: "490.50".to_string(),
                    currency: "USD".to_string(),
                },
            ],
            transactions: vec![],
            warnings: vec![],
        };
        let built = build_nav_snapshots_from_portfolio(
            &multi,
            "2026-11-22",
            "csv-import",
            "2026-11-22T02:00:00.000Z",
        )
        .expect("build nav");
        assert_eq!(built.len(), 2);
        assert_eq!(built[0].currency, "HKD");
        assert_eq!(built[0].positions_micros, 38_010 * MICROS_PER_UNIT);
        assert_eq!(built[0].cash_micros, 15_000_500_000);
        assert_eq!(built[0].net_value_micros, 53_010_500_000);
        assert_eq!(built[1].currency, "USD");
        assert_eq!(built[1].positions_micros, 4_905 * MICROS_PER_UNIT);
        assert_eq!(built[1].cash_micros, 2_000_250_000);
        assert_eq!(built[1].net_value_micros, 6_905_250_000);

        let weights = compute_currency_bucket_weights(
            &[
                ("AAPL", 600 * MICROS_PER_UNIT),
                ("MSFT", 300 * MICROS_PER_UNIT),
            ],
            100 * MICROS_PER_UNIT,
        )
        .expect("weights");
        assert_eq!(weights.len(), 3);
        assert_eq!(weights[0].weight_pct, "60.00");
        assert_eq!(weights[1].weight_pct, "30.00");
        assert_eq!(weights[2].weight_pct, "10.00");
    }

    #[test]
    fn aligns_benchmark_from_first_common_date_when_benchmark_starts_later() {
        let bench = StoredBenchmarkSeries {
            symbol: "SPY".to_string(),
            currency: "USD".to_string(),
            provider: "yahoo".to_string(),
            as_of_utc: "2026-11-22T00:00:00.000Z".to_string(),
            points: vec![
                BenchmarkPricePoint {
                    date: "2026-11-18".to_string(),
                    close_micros: 500 * MICROS_PER_UNIT,
                },
                BenchmarkPricePoint {
                    date: "2026-11-20".to_string(),
                    close_micros: 550 * MICROS_PER_UNIT,
                },
            ],
        };
        let portfolio_dates = vec![
            "2024-01-15".to_string(),
            "2025-06-01".to_string(),
            "2026-11-18".to_string(),
            "2026-11-20".to_string(),
        ];
        let aligned = compute_benchmark_twr_series(&portfolio_dates, &bench).expect("common start");
        assert_eq!(aligned.aligned_count, 2);
        assert_eq!(aligned.points[0].date, "2026-11-18");
        assert_eq!(aligned.points[0].cumulative_twr_pct, "0.00");
        assert_eq!(aligned.points[1].date, "2026-11-20");
        assert_eq!(aligned.points[1].cumulative_twr_pct, "10.00");
        assert_eq!(aligned.cumulative_twr_pct.as_deref(), Some("10.00"));
    }
}
