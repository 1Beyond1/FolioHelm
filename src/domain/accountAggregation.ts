/**
 * Pure multi-account portfolio aggregation utilities.
 *
 * Kept intentionally free of runtime / Tauri IPC imports so pure domain modules
 * (such as `mockBroker.ts`) can aggregate per-account snapshots without pulling
 * `@tauri-apps/api/core` into the module graph before test mocks initialize.
 *
 * Security & financial invariants:
 * - Zero IEEE-754 floating-point math: holdings aggregation and weighted average
 *   cost basis use exact `src/domain/decimal.ts` arithmetic.
 * - Cross-currency cash and market values are strictly isolated per currency
 *   code (`USD` / `HKD` / `CNY` ...) and NEVER summed across currencies.
 */
import {
  decimal,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMultiply,
  decimalToFixed,
  type DecimalString,
} from "./decimal";
import type {
  TauriStoredPortfolioHolding,
  TauriStoredPortfolioSnapshot,
  TauriStoredPortfolioTransaction,
} from "./tauriBridge";

export const DEFAULT_ACCOUNT_ID = "acct_default";
export const ALL_ACCOUNTS_ID = "ALL";

const ZERO = decimal("0");

/**
 * Aggregates multiple per-account `TauriStoredPortfolioSnapshot` records into one
 * combined "All Accounts" snapshot using pure exact Decimal arithmetic.
 *
 * - Holdings with the same `(symbol, currency)` combine quantities and compute exact
 *   quantity-weighted average cost: `(qty1 * cost1 + qty2 * cost2) / (qty1 + qty2)`.
 * - Cash balances are summed strictly within each currency bucket (`cashByCurrency`),
 *   NEVER across currencies.
 */
export function aggregatePortfolioSnapshots(
  snapshots: readonly TauriStoredPortfolioSnapshot[],
): TauriStoredPortfolioSnapshot | null {
  if (snapshots.length === 0) return null;
  if (snapshots.length === 1) {
    return {
      ...snapshots[0]!,
      accountId: snapshots[0]!.accountId || DEFAULT_ACCOUNT_ID,
    };
  }

  interface AggHolding {
    symbol: string;
    company: string;
    currency: string;
    quantity: DecimalString;
    totalCost: DecimalString;
    lastPrice: DecimalString;
    importedAtUtc: string;
  }

  const holdingMap = new Map<string, AggHolding>();
  const cashByCurrencyMap = new Map<string, DecimalString>();
  const currencySet = new Set<string>();
  const allTransactions: TauriStoredPortfolioTransaction[] = [];
  const warningSet = new Set<string>();
  let latestImportedAt = "";

  const sortedSnaps = [...snapshots].sort((a, b) => a.importedAtUtc.localeCompare(b.importedAtUtc));

  for (const snap of sortedSnaps) {
    if (snap.importedAtUtc > latestImportedAt) latestImportedAt = snap.importedAtUtc;

    for (const w of snap.warnings ?? []) warningSet.add(w);
    for (const tx of snap.transactions ?? []) allTransactions.push({ ...tx });

    for (const h of snap.holdings) {
      const curr = (h.currency || "USD").trim().toUpperCase();
      currencySet.add(curr);
      const key = `${h.symbol.toUpperCase()}|${curr}`;
      const qty = decimal(h.quantity);
      if (decimalCompare(qty, ZERO) <= 0) continue;
      const avgCost = decimal(h.averageCost);
      const lastPrice = decimal(h.lastPrice || h.averageCost);
      const lotCost = decimalMultiply(qty, avgCost);

      const existing = holdingMap.get(key);
      if (existing) {
        existing.quantity = decimalAdd(existing.quantity, qty);
        existing.totalCost = decimalAdd(existing.totalCost, lotCost);
        if (snap.importedAtUtc >= existing.importedAtUtc && decimalCompare(lastPrice, ZERO) > 0) {
          existing.lastPrice = lastPrice;
          existing.importedAtUtc = snap.importedAtUtc;
        }
        if (!existing.company && h.company) existing.company = h.company;
      } else {
        holdingMap.set(key, {
          symbol: h.symbol.toUpperCase(),
          company: h.company || h.symbol.toUpperCase(),
          currency: curr,
          quantity: qty,
          totalCost: lotCost,
          lastPrice,
          importedAtUtc: snap.importedAtUtc,
        });
      }
    }

    if (snap.cashByCurrency && Object.keys(snap.cashByCurrency).length > 0) {
      for (const [rawCurr, rawAmt] of Object.entries(snap.cashByCurrency)) {
        const curr = rawCurr.trim().toUpperCase();
        if (!curr || curr === "MULTI") continue;
        const amt = decimal(rawAmt);
        const prev = cashByCurrencyMap.get(curr) ?? ZERO;
        const next = decimalAdd(prev, amt);
        cashByCurrencyMap.set(curr, next);
        if (decimalCompare(amt, ZERO) !== 0) currencySet.add(curr);
      }
    } else if (!snap.isMultiCurrency) {
      const curr = (snap.currency && snap.currency !== "MULTI" ? snap.currency : "USD").toUpperCase();
      const amt = decimal(snap.cash || "0");
      const prev = cashByCurrencyMap.get(curr) ?? ZERO;
      cashByCurrencyMap.set(curr, decimalAdd(prev, amt));
      if (decimalCompare(amt, ZERO) !== 0 || snap.holdings.length === 0) currencySet.add(curr);
    }
  }

  if (currencySet.size === 0) currencySet.add("USD");
  const currencies = [...currencySet].sort();
  const isMultiCurrency = currencies.length > 1;
  const primaryCurrency = isMultiCurrency ? "MULTI" : currencies[0]!;

  const holdings: TauriStoredPortfolioHolding[] = [...holdingMap.values()]
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.currency.localeCompare(b.currency))
    .map((agg) => {
      const avgCost = decimalDivide(agg.totalCost, agg.quantity, 4, "half-up");
      return {
        symbol: agg.symbol,
        company: agg.company,
        quantity: agg.quantity,
        averageCost: decimalToFixed(avgCost, 4, "half-up"),
        lastPrice: decimalToFixed(agg.lastPrice, 4, "half-up"),
        currency: agg.currency,
      };
    });

  const cashByCurrency: Record<string, string> = {};
  for (const curr of currencies) {
    cashByCurrency[curr] = decimalToFixed(cashByCurrencyMap.get(curr) ?? ZERO, 2, "half-up");
  }
  const cashStr = isMultiCurrency ? "0.00" : (cashByCurrency[primaryCurrency] ?? "0.00");

  allTransactions.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  const combinedFp = sortedSnaps.map((s) => s.fingerprint.slice(0, 8)).join("-");

  return {
    id: `all-${combinedFp.slice(0, 24)}`,
    accountId: ALL_ACCOUNTS_ID,
    fingerprint: `all-${combinedFp}`,
    sourceFormat: "multi_account_aggregate",
    sourceLabel: `${sortedSnaps.length} accounts`,
    importedAtUtc: latestImportedAt || new Date().toISOString(),
    accountLabel: `All Accounts (${sortedSnaps.length})`,
    currency: primaryCurrency,
    cash: cashStr,
    cashByCurrency,
    currencies,
    isMultiCurrency,
    holdings,
    transactions: allTransactions,
    warnings: [...warningSet],
  };
}
