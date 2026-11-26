/**
 * Pure BigInt (`i128`-equivalent) NAV snapshot tracking, multi-account per-currency
 * aggregation, Time-Weighted Return (TWR), read-only allowlisted benchmark TWR,
 * and honest calendar return heatmap derivation.
 *
 * Security & financial invariants:
 * - Zero IEEE-754 floating-point arithmetic for NAV, cash flows, returns, or weights.
 * - Micro-unit scale: `1.000000 = 1_000_000n` micros.
 * - Wealth index scale: `1.000000000 = 1_000_000_000n`.
 * - Sub-period TWR strips external cash flows via `(V_end - CF) / V_start`.
 * - Strict currency bucket isolation: never sums across different currencies.
 * - When real snapshot count < 2, NEVER fabricates simulated points.
 * - `NAV_STORE.purgeSensitiveMemory()` synchronously wipes all in-memory NAV and
 *   benchmark caches on App Lock.
 */
import { readStored, removeStored, writeStored } from "../platform/storage";
import type { BrokerHeatmapEntry, BrokerOrder, BrokerSnapshot } from "./contracts";
import { money, percent, type Money } from "./decimal";
import { MOCK_BROKER, registerBrokerResetHook } from "./mockBroker";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "./sessionEpoch";
import {
  invokeBenchmarkFetchHistory,
  invokeBenchmarkLoadCached,
  invokeNavListSnapshots,
  invokeNavUpsertSnapshots,
  isTauriRuntime,
  type TauriBenchmarkFetchResponse,
  type TauriStoredBenchmarkSeries,
  type TauriStoredNavSnapshot,
} from "./tauriBridge";
import type { PublicQuoteProviderChoice } from "./publicQuotes";

export const MICROS_PER_UNIT = 1_000_000n;
export const TWR_FACTOR_SCALE = 1_000_000_000n;
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3,5}$/;
const BROWSER_NAV_KEY = "local-nav-snapshots";
const BROWSER_BENCHMARK_KEY = "local-benchmark-cache";

export type NavSnapshotSource =
  | "csv-import"
  | "paper-trade"
  | "portfolio-load"
  | "quote-refresh"
  | "manual"
  | "aggregated";

export interface NavSnapshotRecord {
  date: string;
  accountId: string;
  currency: string;
  netValueMicros: string;
  cashMicros: string;
  positionsMicros: string;
  externalCashFlowMicros: string;
  eodOnboardingMicros?: string;
  source: string;
  updatedAt: string;
}

export interface BenchmarkPricePoint {
  date: string;
  closeMicros: string;
}

export interface BenchmarkSeriesRecord {
  symbol: string;
  currency: string;
  provider: string;
  asOfUtc: string;
  points: readonly BenchmarkPricePoint[];
}

export interface TwrPoint {
  date: string;
  netValueMicros: string;
  cashMicros: string;
  positionsMicros: string;
  externalCashFlowMicros: string;
  eodOnboardingMicros?: string;
  dailyPnlMicros: string | null;
  dailyReturnPct: string | null;
  cumulativeTwrPct: string;
  cumulativeFactor: string;
}

export interface TwrSeriesResult {
  currency: string;
  accountId: string;
  snapshotCount: number;
  hasEnoughPoints: boolean;
  cumulativeTwrPct: string | null;
  cumulativeFactor: string;
  periodPnlMicros: string;
  points: readonly TwrPoint[];
}

export interface BenchmarkTwrPoint {
  date: string;
  closeMicros: string;
  cumulativeTwrPct: string;
  cumulativeFactor: string;
}

export interface BenchmarkTwrSeriesResult {
  symbol: string;
  currency: string;
  provider: string;
  asOfUtc: string;
  alignedCount: number;
  cumulativeTwrPct: string | null;
  points: readonly BenchmarkTwrPoint[];
}

export interface BenchmarkSyncOutcome {
  series: BenchmarkSeriesRecord | null;
  fromCache: boolean;
  degradedReason?: string;
  provider: string;
}

/** Strictly allowlisted read-only benchmarks grouped by currency bucket. */
export const ALLOWED_BENCHMARKS_BY_CURRENCY: Readonly<Record<string, readonly string[]>> = {
  USD: ["SPY", "QQQ"],
  HKD: ["2800.HK"],
  CNY: ["510300.SS"],
};

export function allowedBenchmarksForCurrency(currency: string): readonly string[] {
  const upper = currency.trim().toUpperCase();
  return ALLOWED_BENCHMARKS_BY_CURRENCY[upper] ?? [];
}

export function isAllowlistedBenchmark(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  return Object.values(ALLOWED_BENCHMARKS_BY_CURRENCY).some((list) => list.includes(upper));
}

export function isValidIsoDate(date: string): boolean {
  if (!ISO_DATE_RE.test(date)) return false;
  const [yStr, mStr, dStr] = date.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}

export function normalizeSingleCurrency(currency: string): string {
  const upper = currency.trim().toUpperCase();
  if (!upper || upper === "MULTI" || !CURRENCY_RE.test(upper)) {
    throw new Error(`Invalid single currency bucket: ${currency}`);
  }
  return upper;
}

function assertI128Range(value: bigint): bigint {
  if (value > I128_MAX || value < I128_MIN) {
    throw new Error("Fixed-point i128 overflow in NAV/TWR calculation");
  }
  return value;
}

/**
 * Pure BigInt `round_half_away_from_zero((a * b) / denom)` with explicit i128 range guard.
 */
export function mulDivRoundBigInt(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error("Division by zero in NAV/TWR calculation");
  if (a === 0n || b === 0n) return 0n;
  const negative = (a < 0n) !== (b < 0n) !== (denom < 0n);
  const ua = a < 0n ? -a : a;
  const ub = b < 0n ? -b : b;
  const ud = denom < 0n ? -denom : denom;
  const product = ua * ub;
  const half = ud / 2n;
  const q = (product + half) / ud;
  return assertI128Range(negative && q > 0n ? -q : q);
}

/** Parse a signed decimal string into `10^6`-scaled BigInt micro-units (half-away-from-zero). */
export function decimalToMicros(raw: string): bigint {
  const trimmed = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    throw new Error(`Invalid decimal string: ${raw}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [intPart = "0", fracPart = ""] = unsigned.split(".");
  const whole = intPart ? BigInt(intPart) : 0n;
  const paddedFrac = fracPart.slice(0, 6).padEnd(6, "0");
  let fracMicros = BigInt(paddedFrac);
  if (fracPart.length > 6 && fracPart.charCodeAt(6) >= 53) {
    fracMicros += 1n;
  }
  const mag = whole * MICROS_PER_UNIT + fracMicros;
  return assertI128Range(negative && mag > 0n ? -mag : mag);
}

/** Format `10^6`-scaled BigInt micro-units into a canonical fixed-decimal string (0..=6 decimals). */
export function microsToDecimal(micros: bigint, decimals = 2): string {
  const clamped = Math.max(0, Math.min(6, Math.trunc(decimals)));
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const shift = 6 - clamped;
  const divisor = 10n ** BigInt(shift);
  const rounded = (abs + divisor / 2n) / divisor;
  const scalePow = 10n ** BigInt(clamped);
  const whole = rounded / scalePow;
  const frac = rounded % scalePow;
  const sign = negative && rounded > 0n ? "-" : "";
  if (clamped === 0) return `${sign}${whole.toString()}`;
  return `${sign}${whole.toString()}.${frac.toString().padStart(clamped, "0")}`;
}

export function formatReturnPctFromFactor(factor: bigint): string {
  const delta = assertI128Range(factor - TWR_FACTOR_SCALE);
  const pctHundredths = mulDivRoundBigInt(delta, 10_000n, TWR_FACTOR_SCALE);
  const negative = pctHundredths < 0n;
  const abs = negative ? -pctHundredths : pctHundredths;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const sign = negative && abs > 0n ? "-" : "";
  return `${sign}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

export function parseMicrosString(raw: string): bigint {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`Invalid micro-unit integer string: ${raw}`);
  }
  return assertI128Range(BigInt(trimmed));
}

/**
 * Aggregates NAV snapshots strictly within a single currency bucket.
 * Supports single account or `"ALL"` across accounts with carry-forward and
 * automatic onboarding external cash-flow adjustment for newly added accounts.
 */
export function aggregateNavSnapshotsByCurrency(
  snapshots: readonly NavSnapshotRecord[],
  currency: string,
  accountId: string | "ALL" = "ALL",
): NavSnapshotRecord[] {
  const targetCurrency = normalizeSingleCurrency(currency);
  const singleFilter = accountId.trim() && accountId.trim().toUpperCase() !== "ALL"
    ? accountId.trim()
    : null;

  if (singleFilter) {
    const byDate = new Map<string, NavSnapshotRecord>();
    for (const snap of snapshots) {
      if (snap.accountId === singleFilter && snap.currency.toUpperCase() === targetCurrency && isValidIsoDate(snap.date)) {
        byDate.set(snap.date, { ...snap, currency: targetCurrency });
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  const perAccount = new Map<string, Map<string, NavSnapshotRecord>>();
  const dateSet = new Set<string>();
  for (const snap of snapshots) {
    if (snap.currency.toUpperCase() !== targetCurrency || !isValidIsoDate(snap.date)) continue;
    dateSet.add(snap.date);
    let dateMap = perAccount.get(snap.accountId);
    if (!dateMap) {
      dateMap = new Map<string, NavSnapshotRecord>();
      perAccount.set(snap.accountId, dateMap);
    }
    dateMap.set(snap.date, { ...snap, currency: targetCurrency });
  }

  if (dateSet.size === 0) return [];

  const sortedDates = [...dateSet].sort((a, b) => a.localeCompare(b));
  const firstGlobalDate = sortedDates[0]!;
  const latestByAccount = new Map<string, NavSnapshotRecord>();
  const aggregated: NavSnapshotRecord[] = [];

  for (const date of sortedDates) {
    let netSum = 0n;
    let cashSum = 0n;
    let posSum = 0n;
    let bodCfSum = 0n;
    let eodOnboardingSum = 0n;
    let latestUpdated = "";

    for (const [acctId, dateMap] of perAccount.entries()) {
      const today = dateMap.get(date);
      if (today) {
        const isFirstForAcct = !latestByAccount.has(acctId);
        const todayNet = parseMicrosString(today.netValueMicros);
        const todayCf = parseMicrosString(today.externalCashFlowMicros);
        const todayEodOnb = today.eodOnboardingMicros ? parseMicrosString(today.eodOnboardingMicros) : 0n;
        // On an account's first date after `firstGlobalDate`, its ENTIRE opening NAV
        // enters at end-of-day (`eodOnboardingMicros`) so it neither masquerades as fake
        // gain nor dilutes existing accounts' day return as a BOD inflow.
        if (isFirstForAcct && date > firstGlobalDate) {
          eodOnboardingSum = assertI128Range(eodOnboardingSum + todayNet);
        } else {
          bodCfSum = assertI128Range(bodCfSum + todayCf);
          eodOnboardingSum = assertI128Range(eodOnboardingSum + todayEodOnb);
        }
        if (today.updatedAt > latestUpdated) latestUpdated = today.updatedAt;
        latestByAccount.set(acctId, today);
      }

      const active = latestByAccount.get(acctId);
      if (active) {
        netSum = assertI128Range(netSum + parseMicrosString(active.netValueMicros));
        cashSum = assertI128Range(cashSum + parseMicrosString(active.cashMicros));
        posSum = assertI128Range(posSum + parseMicrosString(active.positionsMicros));
        if (active.updatedAt > latestUpdated) latestUpdated = active.updatedAt;
      }
    }

    aggregated.push({
      date,
      accountId: "ALL",
      currency: targetCurrency,
      netValueMicros: netSum.toString(),
      cashMicros: cashSum.toString(),
      positionsMicros: posSum.toString(),
      externalCashFlowMicros: bodCfSum.toString(),
      eodOnboardingMicros: eodOnboardingSum.toString(),
      source: "aggregated",
      updatedAt: latestUpdated,
    });
  }

  return aggregated;
}

/**
 * Pure BigInt Time-Weighted Return (TWR) calculation (100% isomorphic to Rust `nav/mod.rs`):
 * - Inflows (`CF > 0`, BOD convention): `sub_factor = V_end / (V_start + CF)`.
 * - Outflows / zero CF (`CF <= 0`, EOD convention): `sub_factor = (V_end - CF) / V_start`.
 * Strictly refuses cross-currency (`MULTI`) inputs and NEVER fabricates points when `< 2`.
 */
export function computeTwrSeries(
  rawSnapshots: readonly NavSnapshotRecord[],
  currency: string,
  accountId = "ALL",
): TwrSeriesResult {
  const validCurrency = normalizeSingleCurrency(currency);
  const byDate = new Map<string, NavSnapshotRecord>();
  for (const snap of rawSnapshots) {
    if (!isValidIsoDate(snap.date)) {
      throw new Error(`Invalid snapshot date: ${snap.date}`);
    }
    if (snap.currency.trim().toUpperCase() !== validCurrency) {
      throw new Error(`Cross-currency snapshot ${snap.currency} rejected for ${validCurrency} bucket`);
    }
    byDate.set(snap.date, snap);
  }

  const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) {
    return {
      currency: validCurrency,
      accountId,
      snapshotCount: 0,
      hasEnoughPoints: false,
      cumulativeTwrPct: null,
      cumulativeFactor: TWR_FACTOR_SCALE.toString(),
      periodPnlMicros: "0",
      points: [],
    };
  }

  let cumFactor = TWR_FACTOR_SCALE;
  let periodPnl = 0n;
  const first = sorted[0]!;
  // Validate micro fields on first point as well.
  parseMicrosString(first.netValueMicros);
  parseMicrosString(first.cashMicros);
  parseMicrosString(first.positionsMicros);
  parseMicrosString(first.externalCashFlowMicros);

  const firstEodOnb = first.eodOnboardingMicros ? parseMicrosString(first.eodOnboardingMicros) : 0n;

  const points: TwrPoint[] = [
    {
      date: first.date,
      netValueMicros: first.netValueMicros,
      cashMicros: first.cashMicros,
      positionsMicros: first.positionsMicros,
      externalCashFlowMicros: first.externalCashFlowMicros,
      eodOnboardingMicros: firstEodOnb.toString(),
      dailyPnlMicros: null,
      dailyReturnPct: null,
      cumulativeTwrPct: "0.00",
      cumulativeFactor: TWR_FACTOR_SCALE.toString(),
    },
  ];

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const vStart = parseMicrosString(prev.netValueMicros);
    const vEnd = parseMicrosString(curr.netValueMicros);
    const bodCf = parseMicrosString(curr.externalCashFlowMicros);
    const eodOnb = curr.eodOnboardingMicros ? parseMicrosString(curr.eodOnboardingMicros) : 0n;

    // Strip EOD newly onboarded account NAV from ending value before computing sub-period
    // return so onboarding a second account never dilutes existing accounts' day return.
    const vEndExOnb = assertI128Range(vEnd - eodOnb);
    const adjustedEnd = assertI128Range(vEndExOnb - bodCf);
    const dailyPnl = assertI128Range(adjustedEnd - vStart);
    periodPnl = assertI128Range(periodPnl + dailyPnl);

    let subFactor: bigint;
    let dailyReturnPct: string | null;
    if (bodCf > 0n) {
      // Beginning-of-day inflow convention: capital base is `V_start + bod_cf`.
      // Also handles zero-start initial deposits (`vStart <= 0 && bodCf > 0`) whenever
      // `capitalBase > 0`.
      const capitalBase = assertI128Range(vStart + bodCf);
      if (capitalBase <= 0n) {
        subFactor = TWR_FACTOR_SCALE;
        dailyReturnPct = null;
      } else if (vEndExOnb <= 0n) {
        subFactor = 0n;
        dailyReturnPct = "-100.00";
      } else {
        subFactor = mulDivRoundBigInt(vEndExOnb, TWR_FACTOR_SCALE, capitalBase);
        dailyReturnPct = formatReturnPctFromFactor(subFactor);
      }
    } else if (vStart <= 0n) {
      subFactor = TWR_FACTOR_SCALE;
      dailyReturnPct = null;
    } else if (adjustedEnd <= 0n) {
      subFactor = 0n;
      dailyReturnPct = "-100.00";
    } else {
      subFactor = mulDivRoundBigInt(adjustedEnd, TWR_FACTOR_SCALE, vStart);
      dailyReturnPct = formatReturnPctFromFactor(subFactor);
    }

    cumFactor = mulDivRoundBigInt(cumFactor, subFactor, TWR_FACTOR_SCALE);
    const cumPct = formatReturnPctFromFactor(cumFactor);

    points.push({
      date: curr.date,
      netValueMicros: curr.netValueMicros,
      cashMicros: curr.cashMicros,
      positionsMicros: curr.positionsMicros,
      externalCashFlowMicros: curr.externalCashFlowMicros,
      eodOnboardingMicros: eodOnb.toString(),
      dailyPnlMicros: dailyPnl.toString(),
      dailyReturnPct,
      cumulativeTwrPct: cumPct,
      cumulativeFactor: cumFactor.toString(),
    });
  }

  const hasEnoughPoints = points.length >= 2;
  return {
    currency: validCurrency,
    accountId,
    snapshotCount: points.length,
    hasEnoughPoints,
    cumulativeTwrPct: hasEnoughPoints ? formatReturnPctFromFactor(cumFactor) : null,
    cumulativeFactor: cumFactor.toString(),
    periodPnlMicros: periodPnl.toString(),
    points,
  };
}

/**
 * Pure BigInt benchmark TWR aligned to portfolio dates (weekend/holiday carry-forward).
 */
export function computeBenchmarkTwrSeries(
  dates: readonly string[],
  benchmark: BenchmarkSeriesRecord,
): BenchmarkTwrSeriesResult {
  if (dates.length < 2 || benchmark.points.length === 0) {
    return {
      symbol: benchmark.symbol,
      currency: benchmark.currency,
      provider: benchmark.provider,
      asOfUtc: benchmark.asOfUtc,
      alignedCount: 0,
      cumulativeTwrPct: null,
      points: [],
    };
  }

  const sortedBench = [...benchmark.points]
    .filter((pt) => isValidIsoDate(pt.date) && parseMicrosString(pt.closeMicros) > 0n)
    .sort((a, b) => a.date.localeCompare(b.date));

  const findCloseOnOrBefore = (targetDate: string): bigint | null => {
    let best: bigint | null = null;
    for (const pt of sortedBench) {
      if (pt.date <= targetDate) {
        best = parseMicrosString(pt.closeMicros);
      } else {
        break;
      }
    }
    return best;
  };

  // P1-3: Anchor at the first common overlapping date where a benchmark close exists,
  // so benchmarks starting after `dates[0]` still align cleanly from the common start date.
  let baseClose: bigint | null = null;
  const aligned: BenchmarkTwrPoint[] = [];
  for (const date of dates) {
    const close = findCloseOnOrBefore(date);
    if (close === null || close <= 0n) continue;
    if (baseClose === null) baseClose = close;
    const factor = mulDivRoundBigInt(close, TWR_FACTOR_SCALE, baseClose);
    aligned.push({
      date,
      closeMicros: close.toString(),
      cumulativeTwrPct: formatReturnPctFromFactor(factor),
      cumulativeFactor: factor.toString(),
    });
  }

  return {
    symbol: benchmark.symbol,
    currency: benchmark.currency,
    provider: benchmark.provider,
    asOfUtc: benchmark.asOfUtc,
    alignedCount: aligned.length,
    cumulativeTwrPct: aligned.length >= 2 ? aligned[aligned.length - 1]!.cumulativeTwrPct : null,
    points: aligned,
  };
}

/**
 * Filter a sorted TWR series by period window while recomputing cumulative TWR from
 * the window start (pure BigInt). Returns only real snapshots (never fabricates).
 */
export type NavChartPeriod = "1W" | "1M" | "6M" | "1Y" | "ALL";

export function filterNavSnapshotsByPeriod(
  snapshots: readonly NavSnapshotRecord[],
  period: NavChartPeriod,
): NavSnapshotRecord[] {
  if (period === "ALL" || snapshots.length === 0) return [...snapshots];
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const latestDate = sorted[sorted.length - 1]!.date;
  const anchorMs = Date.parse(`${latestDate}T00:00:00Z`);
  if (!Number.isFinite(anchorMs)) return sorted;

  const days =
    period === "1W" ? 7
      : period === "1M" ? 31
        : period === "6M" ? 183
          : 366;
  const cutoff = new Date(anchorMs - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return sorted.filter((snap) => snap.date >= cutoff);
}

/**
 * Builds per-currency `NavSnapshotRecord` items from a live `BrokerSnapshot` using pure BigInt.
 */
export function buildNavSnapshotsFromBrokerSnapshot(
  snapshot: BrokerSnapshot,
  accountId: string,
  dateIso: string,
  source: NavSnapshotSource,
  updatedAtUtc = new Date().toISOString(),
): NavSnapshotRecord[] {
  if (!isValidIsoDate(dateIso)) {
    throw new Error(`Invalid snapshot date: ${dateIso}`);
  }
  const breakdowns = snapshot.account.currencyBreakdowns;
  if (breakdowns && breakdowns.length > 0) {
    return breakdowns
      .filter((b) => CURRENCY_RE.test(b.currency.toUpperCase()) && b.currency.toUpperCase() !== "MULTI")
      .map((b) => {
        const cashMicros = decimalToMicros(b.cash);
        const positionsMicros = decimalToMicros(b.holdingsValue);
        const netMicros = assertI128Range(cashMicros + positionsMicros);
        return {
          date: dateIso,
          accountId,
          currency: b.currency.toUpperCase(),
          netValueMicros: netMicros.toString(),
          cashMicros: cashMicros.toString(),
          positionsMicros: positionsMicros.toString(),
          externalCashFlowMicros: "0",
          source,
          updatedAt: updatedAtUtc,
        };
      });
  }

  const fallbackCurr = snapshot.account.currency && snapshot.account.currency !== "MULTI"
    ? snapshot.account.currency.toUpperCase()
    : "USD";
  const cashMicros = decimalToMicros(snapshot.account.cash);
  const netMicros = decimalToMicros(snapshot.account.totalEquity);
  const positionsMicros = assertI128Range(netMicros - cashMicros);
  return [
    {
      date: dateIso,
      accountId,
      currency: fallbackCurr,
      netValueMicros: netMicros.toString(),
      cashMicros: cashMicros.toString(),
      positionsMicros: positionsMicros.toString(),
      externalCashFlowMicros: "0",
      source,
      updatedAt: updatedAtUtc,
    },
  ];
}

/**
 * Builds an honest 365-day calendar heatmap from real TWR snapshots & local orders.
 * Dates without real snapshots stay `status: "no-data"`, NEVER fabricated.
 */
export function buildCalendarHeatmapFromNav(
  twr: TwrSeriesResult,
  orders: readonly BrokerOrder[],
  year?: number,
): {
  year: number;
  entries: BrokerHeatmapEntry[];
  activeDays: number;
  ordersFilled: number;
  yearNetChange: Money;
} {
  const latestSnapDate = twr.points.length > 0 ? twr.points[twr.points.length - 1]!.date : null;
  const resolvedYear = year ?? (latestSnapDate ? Number(latestSnapDate.slice(0, 4)) : new Date().getUTCFullYear());
  const resolvedYearPrefix = `${resolvedYear}-`;

  const twrByDate = new Map<string, TwrPoint>();
  for (const pt of twr.points) {
    twrByDate.set(pt.date, pt);
  }

  const orderCountByDate = new Map<string, number>();
  let ordersFilled = 0;
  for (const order of orders) {
    const orderCurr = (order.currency ?? "USD").toUpperCase();
    if (orderCurr !== twr.currency) continue;
    const dateKey = order.submittedAt.slice(0, 10);
    if (!isValidIsoDate(dateKey) || !dateKey.startsWith(resolvedYearPrefix)) continue;
    orderCountByDate.set(dateKey, (orderCountByDate.get(dateKey) ?? 0) + 1);
    if (order.status === "filled") ordersFilled += 1;
  }

  const isLeapYear = (resolvedYear % 4 === 0 && resolvedYear % 100 !== 0) || resolvedYear % 400 === 0;
  const totalDays = isLeapYear ? 366 : 365;
  const start = new Date(Date.UTC(resolvedYear, 0, 1));
  const entries: BrokerHeatmapEntry[] = [];
  let activeDays = 0;
  let yearPnlMicros = 0n;

  for (let idx = 0; idx < totalDays; idx += 1) {
    const dt = new Date(start);
    dt.setUTCDate(idx + 1);
    const iso = dt.toISOString().slice(0, 10);
    const point = twrByDate.get(iso);
    const orderActions = orderCountByDate.get(iso) ?? 0;

    if (!point && orderActions === 0) {
      entries.push({
        date: iso,
        status: "no-data",
        activityLevel: 0,
        actions: 0,
        dailyReturnPct: null,
        dailyReturnUsd: null,
      });
      continue;
    }

    const actions = orderActions + (point ? 1 : 0);
    if (actions > 0) activeDays += 1;
    const level = Math.min(4, actions) as 0 | 1 | 2 | 3 | 4;

    if (point && point.dailyReturnPct !== null && point.dailyPnlMicros !== null) {
      const dailyPnl = parseMicrosString(point.dailyPnlMicros);
      yearPnlMicros = assertI128Range(yearPnlMicros + dailyPnl);
      entries.push({
        date: iso,
        status: "available",
        activityLevel: level,
        actions,
        dailyReturnPct: percent(point.dailyReturnPct),
        dailyReturnUsd: money(microsToDecimal(dailyPnl, 2)),
      });
    } else {
      // Snapshot exists (day 0 baseline) or order activity without prior snapshot:
      // NEVER fabricate a fake daily return!
      if (point && point.dailyPnlMicros !== null) {
        yearPnlMicros = assertI128Range(yearPnlMicros + parseMicrosString(point.dailyPnlMicros));
      }
      entries.push({
        date: iso,
        status: "no-data",
        activityLevel: level,
        actions,
        dailyReturnPct: null,
        dailyReturnUsd: null,
      });
    }
  }

  const yearNetChange = money(microsToDecimal(yearPnlMicros, 2));
  return { year: resolvedYear, entries, activeDays, ordersFilled, yearNetChange };
}

export function todayUtcIsoDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function navRecordKey(snap: Pick<NavSnapshotRecord, "date" | "accountId" | "currency">): string {
  return `${snap.date}|${snap.accountId}|${snap.currency.toUpperCase()}`;
}

class NavHistoryStore {
  private snapshots = new Map<string, NavSnapshotRecord>();
  private benchmarks = new Map<string, BenchmarkSeriesRecord>();
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Ignore observer errors so state integrity is unaffected.
      }
    }
  }

  hasSnapshot(date: string, accountId: string, currency: string): boolean {
    const key = navRecordKey({ date, accountId, currency });
    return this.snapshots.has(key);
  }

  hasAnySnapshotForAccountCurrency(accountId: string, currency: string): boolean {
    const upperCurr = currency.trim().toUpperCase();
    for (const snap of this.snapshots.values()) {
      if (snap.accountId === accountId && snap.currency.toUpperCase() === upperCurr) {
        return true;
      }
    }
    return false;
  }

  getSnapshot(date: string, accountId: string, currency: string): NavSnapshotRecord | null {
    const found = this.snapshots.get(navRecordKey({ date, accountId, currency }));
    return found ? { ...found } : null;
  }

  removeAccountSnapshots(accountId: string): void {
    const trimmed = accountId.trim();
    if (!trimmed) return;
    let changed = false;
    for (const [key, snap] of this.snapshots.entries()) {
      if (snap.accountId === trimmed) {
        this.snapshots.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    if (!isTauriRuntime()) {
      writeStored(BROWSER_NAV_KEY, this.getAllSnapshots());
    }
    this.notify();
  }

  getAllSnapshots(): NavSnapshotRecord[] {
    return [...this.snapshots.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.accountId.localeCompare(b.accountId) || a.currency.localeCompare(b.currency),
    );
  }

  getTwrSeries(currency: string, accountId: string | "ALL" = "ALL", period: NavChartPeriod = "ALL"): TwrSeriesResult {
    const agg = aggregateNavSnapshotsByCurrency(this.getAllSnapshots(), currency, accountId);
    const windowed = filterNavSnapshotsByPeriod(agg, period);
    return computeTwrSeries(windowed, currency, accountId);
  }

  getBenchmark(symbol: string): BenchmarkSeriesRecord | null {
    const upper = symbol.trim().toUpperCase();
    const found = this.benchmarks.get(upper);
    return found ? { ...found, points: [...found.points] } : null;
  }

  getAllBenchmarks(): BenchmarkSeriesRecord[] {
    return [...this.benchmarks.values()].map((s) => ({ ...s, points: [...s.points] }));
  }

  replaceAll(
    snapshots: readonly NavSnapshotRecord[],
    benchmarks: readonly BenchmarkSeriesRecord[],
  ): void {
    this.snapshots.clear();
    for (const snap of snapshots) {
      if (isValidIsoDate(snap.date) && CURRENCY_RE.test(snap.currency.toUpperCase()) && snap.currency.toUpperCase() !== "MULTI") {
        const normalized: NavSnapshotRecord = { ...snap, currency: snap.currency.toUpperCase() };
        this.snapshots.set(navRecordKey(normalized), normalized);
      }
    }
    this.benchmarks.clear();
    for (const series of benchmarks) {
      if (isAllowlistedBenchmark(series.symbol)) {
        const upper = series.symbol.toUpperCase();
        this.benchmarks.set(upper, {
          ...series,
          symbol: upper,
          currency: series.currency.toUpperCase(),
          points: [...series.points],
        });
      }
    }
    this.notify();
  }

  /**
   * Synchronously scrubs all NAV snapshots and cached benchmark series from JS RAM
   * (invoked on App Lock and fail-closed vault lock).
   */
  purgeSensitiveMemory(): void {
    this.snapshots.clear();
    this.benchmarks.clear();
    this.notify();
  }

  async hydrateFromVault(): Promise<void> {
    const epoch = getCurrentLockEpoch();
    if (isTauriRuntime()) {
      const [rawSnaps, rawBenchmarks] = await Promise.all([
        invokeNavListSnapshots().catch(() => null),
        invokeBenchmarkLoadCached().catch(() => null),
      ]);
      // P0-3 Fail-Closed: discard stale pre-lock hydration response if session locked mid-flight.
      if (!isCurrentLockEpoch(epoch)) return;
      const snaps: NavSnapshotRecord[] = Array.isArray(rawSnaps) ? rawSnaps : [];
      const benches: BenchmarkSeriesRecord[] = Array.isArray(rawBenchmarks) ? rawBenchmarks : [];
      this.replaceAll(snaps, benches);
      return;
    }

    if (!isCurrentLockEpoch(epoch)) return;
    const storedSnaps = readStored<unknown>(BROWSER_NAV_KEY, []);
    const storedBenches = readStored<unknown>(BROWSER_BENCHMARK_KEY, []);
    this.replaceAll(
      Array.isArray(storedSnaps) ? storedSnaps as NavSnapshotRecord[] : [],
      Array.isArray(storedBenches) ? storedBenches as BenchmarkSeriesRecord[] : [],
    );
  }

  async recordSnapshots(
    incoming: readonly NavSnapshotRecord[],
    preserveExistingCf = true,
  ): Promise<NavSnapshotRecord[]> {
    const epoch = getCurrentLockEpoch();
    if (incoming.length === 0) return [];
    const normalized: NavSnapshotRecord[] = [];

    for (const item of incoming) {
      if (!isValidIsoDate(item.date)) continue;
      const curr = item.currency.trim().toUpperCase();
      if (!CURRENCY_RE.test(curr) || curr === "MULTI") continue;
      const key = navRecordKey({ date: item.date, accountId: item.accountId, currency: curr });
      const prev = this.snapshots.get(key);
      const cf =
        preserveExistingCf && prev && item.externalCashFlowMicros === "0"
          ? prev.externalCashFlowMicros
          : item.externalCashFlowMicros;
      const record: NavSnapshotRecord = {
        ...item,
        currency: curr,
        externalCashFlowMicros: cf,
      };
      this.snapshots.set(key, record);
      normalized.push(record);
    }

    if (normalized.length === 0) return [];

    if (isTauriRuntime()) {
      try {
        const persisted = await invokeNavUpsertSnapshots(
          normalized as TauriStoredNavSnapshot[],
          preserveExistingCf,
        );
        // P0-3 Fail-Closed: never repopulate JS RAM if locked while IPC was in flight.
        if (!isCurrentLockEpoch(epoch)) return [];
        if (Array.isArray(persisted)) {
          for (const item of persisted) {
            this.snapshots.set(navRecordKey(item), item);
          }
        }
      } catch {
        if (!isCurrentLockEpoch(epoch)) return [];
        // Keep in-memory state consistent; caller / vault status surfaces lock errors.
      }
    } else {
      if (!isCurrentLockEpoch(epoch)) return [];
      writeStored(BROWSER_NAV_KEY, this.getAllSnapshots());
    }

    if (!isCurrentLockEpoch(epoch)) return [];
    this.notify();
    return normalized;
  }

  /**
   * Records or adjusts real external cash flow (deposit > 0, withdrawal < 0) on a concrete
   * account + single-currency snapshot using pure BigInt micros, preserving existing valuation
   * fields and persisting with `preserveExistingCf = false` so subsequent automatic snapshots
   * retain the recorded cash flow (P1-1).
   */
  async recordExternalCashFlow(input: {
    date: string;
    accountId: string;
    currency: string;
    cashFlowDecimal: string;
    fallbackNetValueMicros?: string;
    fallbackCashMicros?: string;
    fallbackPositionsMicros?: string;
  }): Promise<NavSnapshotRecord | null> {
    if (!isValidIsoDate(input.date)) {
      throw new Error(`Invalid snapshot date: ${input.date}`);
    }
    const acctId = input.accountId.trim();
    if (!acctId || acctId.toUpperCase() === "ALL") {
      throw new Error("A concrete account ID is required to record external cash flow");
    }
    const curr = normalizeSingleCurrency(input.currency);
    const cfMicros = decimalToMicros(input.cashFlowDecimal);
    const existing = this.getSnapshot(input.date, acctId, curr);
    const record: NavSnapshotRecord = {
      date: input.date,
      accountId: acctId,
      currency: curr,
      netValueMicros: existing?.netValueMicros ?? input.fallbackNetValueMicros ?? "0",
      cashMicros: existing?.cashMicros ?? input.fallbackCashMicros ?? "0",
      positionsMicros: existing?.positionsMicros ?? input.fallbackPositionsMicros ?? "0",
      externalCashFlowMicros: cfMicros.toString(),
      source: existing?.source || "manual",
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.recordSnapshots([record], false);
    return saved[0] ?? null;
  }

  /**
   * Synchronizes an existing NAV snapshot's `externalCashFlowMicros` in browser preview mode
   * from aggregated `cash_flows` deposit/withdrawal entries (mirroring Rust transactional sync).
   */
  syncExternalCashFlowFromLedger(
    accountId: string,
    currency: string,
    date: string,
    netExternalMicros: bigint,
  ): boolean {
    if (!isValidIsoDate(date)) return false;
    const curr = currency.trim().toUpperCase();
    const key = navRecordKey({ date, accountId: accountId.trim(), currency: curr });
    const existing = this.snapshots.get(key);
    if (!existing) return false;
    const updated: NavSnapshotRecord = {
      ...existing,
      externalCashFlowMicros: netExternalMicros.toString(),
      updatedAt: new Date().toISOString(),
    };
    this.snapshots.set(key, updated);
    if (!isTauriRuntime()) {
      writeStored(BROWSER_NAV_KEY, this.getAllSnapshots());
    }
    this.notify();
    return true;
  }

  async syncBenchmarkHistory(
    rawSymbol: string,
    provider: PublicQuoteProviderChoice = "stooq",
  ): Promise<BenchmarkSyncOutcome> {
    const epoch = getCurrentLockEpoch();
    const symbol = rawSymbol.trim().toUpperCase();
    if (!isAllowlistedBenchmark(symbol)) {
      throw new Error(`Benchmark ${symbol} is not in the read-only allowlist`);
    }

    // P1-6: Respect the master opt-in networking toggle ("Enable public delayed quotes").
    // Never fire outbound HTTPS benchmark requests when public delayed quotes are disabled.
    if (!MOCK_BROKER.isPublicQuotesEnabled()) {
      const cached = this.getBenchmark(symbol);
      return {
        series: cached,
        fromCache: true,
        provider,
        degradedReason:
          "Public delayed quotes are disabled; enable them in Settings first to sync online benchmark history",
      };
    }

    if (!isTauriRuntime()) {
      const cached = this.getBenchmark(symbol);
      return {
        series: cached,
        fromCache: true,
        provider,
        degradedReason: cached
          ? "Browser preview mode: displaying locally cached benchmark series"
          : "Direct browser networking is disabled; benchmark history is unavailable offline",
      };
    }

    try {
      const response: TauriBenchmarkFetchResponse = await invokeBenchmarkFetchHistory(symbol, provider);
      // P0-3 Fail-Closed: discard stale benchmark fetch if locked while request was in flight.
      if (!isCurrentLockEpoch(epoch)) {
        return {
          series: null,
          fromCache: true,
          provider: response.provider,
          degradedReason: "Session locked",
        };
      }
      if (response.series) {
        this.benchmarks.set(symbol, {
          ...response.series,
          symbol,
          points: [...response.series.points],
        });
        this.notify();
      }
      return {
        series: response.series ? { ...response.series, points: [...response.series.points] } : this.getBenchmark(symbol),
        fromCache: response.fromCache,
        degradedReason: response.degradedReason ?? undefined,
        provider: response.provider,
      };
    } catch (error) {
      if (!isCurrentLockEpoch(epoch)) {
        return {
          series: null,
          fromCache: true,
          provider,
          degradedReason: "Session locked",
        };
      }
      const cached = this.getBenchmark(symbol);
      return {
        series: cached,
        fromCache: true,
        provider,
        degradedReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Helper for browser-mode tests or cached benchmark injection. */
  cacheBenchmarkLocally(series: TauriStoredBenchmarkSeries): void {
    const upper = series.symbol.trim().toUpperCase();
    if (!isAllowlistedBenchmark(upper)) {
      throw new Error(`Benchmark ${series.symbol} is not in the read-only allowlist`);
    }
    this.benchmarks.set(upper, {
      ...series,
      symbol: upper,
      currency: series.currency.trim().toUpperCase(),
      points: [...series.points],
    });
    if (!isTauriRuntime()) {
      writeStored(BROWSER_BENCHMARK_KEY, this.getAllBenchmarks());
    }
    this.notify();
  }

  clearAll(): void {
    this.snapshots.clear();
    this.benchmarks.clear();
    if (!isTauriRuntime()) {
      removeStored(BROWSER_NAV_KEY);
      removeStored(BROWSER_BENCHMARK_KEY);
    }
    this.notify();
  }
}

export const NAV_STORE = new NavHistoryStore();
registerBrokerResetHook(() => NAV_STORE.purgeSensitiveMemory());
