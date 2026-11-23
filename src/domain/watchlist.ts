/**
 * Local Watchlist & Price Target Alerts store & pure exact-Decimal evaluator (v0.2.0).
 *
 * Financial & security invariants:
 * - Zero IEEE-754 floating-point math: all target comparisons and distance
 *   percentages use exact `BigInt` micro-units and `Decimal` arithmetic.
 * - Strict currency matching: a quote or holding price is ONLY compared against
 *   a watchlist item when its currency matches `item.currency`.
 * - Read-only alerts: never triggers automatic order submission; users click to
 *   open the 4-step paper trade ticket for manual review.
 * - Encrypted SQLite persistence (`watchlist_items` table, AES-256-GCM + AAD)
 *   with Ed25519 evidence logging, `.fhvault` backup support, and Fail-Closed lock purge.
 */
import { readStored, removeStored, writeStored } from "../platform/storage";
import type { BrokerSnapshot } from "./contracts";
import {
  decimal,
  decimalDivide,
  decimalMultiply,
  decimalRound,
  decimalSubtract,
  decimalToFixed,
  type DecimalString,
} from "./decimal";
import { appendEvidence } from "./evidenceJournal";
import { registerBrokerResetHook } from "./mockBroker";
import { decimalToMicros, microsToDecimal } from "./nav";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "./sessionEpoch";
import {
  invokeVaultDeleteWatchlistItem,
  invokeVaultListWatchlist,
  invokeVaultUpsertWatchlistItem,
  isTauriRuntime,
  type TauriStoredWatchlistItem,
} from "./tauriBridge";

const BROWSER_WATCHLIST_KEY = "local-watchlist-items";
const HUNDRED = decimal("100");
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
const CURRENCY_RE = /^[A-Z]{3,5}$/;
const POSITIVE_DECIMAL_RE = /^\+?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/;

export type WatchlistItem = TauriStoredWatchlistItem;

export type WatchlistAlertStatus =
  | "buy-triggered"
  | "sell-triggered"
  | "watching"
  | "disabled"
  | "no-price";

export type WatchlistPriceSource =
  | "public-delayed"
  | "holding-baseline"
  | "demo-quote"
  | null;

export interface UpsertWatchlistInput {
  id?: string;
  symbol: string;
  currency: string;
  targetBuyDecimal?: string | null;
  targetSellDecimal?: string | null;
  note?: string;
  enabled?: boolean;
}

export interface EvaluatedWatchlistItem {
  item: WatchlistItem;
  targetBuyDecimal: DecimalString | null;
  targetSellDecimal: DecimalString | null;
  currentPrice: DecimalString | null;
  priceSource: WatchlistPriceSource;
  status: WatchlistAlertStatus;
  /** Signed % delta from target buy: (current - buy) / buy * 100. <= 0 means triggered. */
  distanceToBuyPct: DecimalString | null;
  /** Signed % delta from target sell: (current - sell) / sell * 100. >= 0 means triggered. */
  distanceToSellPct: DecimalString | null;
}

function generateWatchlistId(): string {
  const rand = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e8).toString(36)}`;
  return `wl_${Date.now().toString(36)}_${rand}`;
}

export function microsToDisplayDecimal(microsStr: string | null): DecimalString | null {
  if (microsStr === null || microsStr.trim() === "") return null;
  try {
    const val = BigInt(microsStr);
    if (val <= 0n) return null;
    return decimal(microsToDecimal(val, 4));
  } catch {
    return null;
  }
}

export function validateWatchlistInput(input: UpsertWatchlistInput): WatchlistItem {
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    throw new Error(`Invalid watchlist symbol '${input.symbol}'`);
  }
  const currency = input.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency) || currency === "MULTI") {
    throw new Error(`Invalid currency '${input.currency}'`);
  }

  let targetBuyMicros: bigint | null = null;
  const rawBuy = input.targetBuyDecimal?.trim() ?? "";
  if (rawBuy) {
    if (!POSITIVE_DECIMAL_RE.test(rawBuy)) {
      throw new Error("Target buy price must be a positive decimal (up to 6 decimal places)");
    }
    const parsed = decimalToMicros(rawBuy);
    if (parsed <= 0n) {
      throw new Error("Target buy price must be strictly greater than zero");
    }
    targetBuyMicros = parsed;
  }

  let targetSellMicros: bigint | null = null;
  const rawSell = input.targetSellDecimal?.trim() ?? "";
  if (rawSell) {
    if (!POSITIVE_DECIMAL_RE.test(rawSell)) {
      throw new Error("Target sell price must be a positive decimal (up to 6 decimal places)");
    }
    const parsed = decimalToMicros(rawSell);
    if (parsed <= 0n) {
      throw new Error("Target sell price must be strictly greater than zero");
    }
    targetSellMicros = parsed;
  }

  if (targetBuyMicros !== null && targetSellMicros !== null && targetBuyMicros >= targetSellMicros) {
    throw new Error("Target buy price must be lower than target sell price");
  }

  const note = (input.note ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 200);

  const id = input.id?.trim() || generateWatchlistId();
  if (id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid watchlist ID");
  }

  return {
    id,
    symbol,
    currency,
    targetBuyMicros: targetBuyMicros === null ? null : targetBuyMicros.toString(),
    targetSellMicros: targetSellMicros === null ? null : targetSellMicros.toString(),
    note,
    enabled: input.enabled ?? true,
    updatedAt: new Date().toISOString(),
  };
}

function resolveCurrentPriceForWatchlistItem(
  item: WatchlistItem,
  snapshot: BrokerSnapshot,
): { price: DecimalString | null; priceMicros: bigint | null; source: WatchlistPriceSource } {
  const targetSymbol = item.symbol.trim().toUpperCase();
  const targetCurrency = item.currency.trim().toUpperCase();

  const matchedQuote = snapshot.quotes.find(
    (q) =>
      q.symbol.trim().toUpperCase() === targetSymbol
      && (q.currency ?? "USD").trim().toUpperCase() === targetCurrency
      && q.status !== "no-data",
  );
  if (matchedQuote) {
    try {
      const micros = decimalToMicros(matchedQuote.price);
      if (micros > 0n) {
        const source: WatchlistPriceSource = matchedQuote.source === "public-delayed"
          ? "public-delayed"
          : matchedQuote.source === "csv-import"
            ? "holding-baseline"
            : "demo-quote";
        return { price: matchedQuote.price, priceMicros: micros, source };
      }
    } catch {
      // Fall through to holding baseline
    }
  }

  const matchedHolding = snapshot.holdings.find(
    (h) =>
      h.symbol.trim().toUpperCase() === targetSymbol
      && (h.currency ?? "USD").trim().toUpperCase() === targetCurrency,
  );
  if (matchedHolding) {
    try {
      const micros = decimalToMicros(matchedHolding.averageCost);
      if (micros > 0n) {
        return {
          price: matchedHolding.averageCost,
          priceMicros: micros,
          source: "holding-baseline",
        };
      }
    } catch {
      // No valid price
    }
  }

  return { price: null, priceMicros: null, source: null };
}

/**
 * Pure BigInt / Decimal alert evaluator for one watchlist item against the
 * active broker snapshot (public delayed quotes or local holding baseline).
 */
export function evaluateWatchlistItem(
  item: WatchlistItem,
  snapshot: BrokerSnapshot,
): EvaluatedWatchlistItem {
  const targetBuyDecimal = microsToDisplayDecimal(item.targetBuyMicros);
  const targetSellDecimal = microsToDisplayDecimal(item.targetSellMicros);
  const { price: currentPrice, priceMicros, source: priceSource } =
    resolveCurrentPriceForWatchlistItem(item, snapshot);

  let buyMicros: bigint | null = null;
  let sellMicros: bigint | null = null;
  try {
    if (item.targetBuyMicros !== null && item.targetBuyMicros.trim() !== "") {
      buyMicros = BigInt(item.targetBuyMicros);
    }
  } catch {
    buyMicros = null;
  }
  try {
    if (item.targetSellMicros !== null && item.targetSellMicros.trim() !== "") {
      sellMicros = BigInt(item.targetSellMicros);
    }
  } catch {
    sellMicros = null;
  }

  let status: WatchlistAlertStatus;
  if (!item.enabled) {
    status = "disabled";
  } else if (priceMicros === null || priceMicros <= 0n) {
    status = "no-price";
  } else if (buyMicros !== null && priceMicros <= buyMicros) {
    status = "buy-triggered";
  } else if (sellMicros !== null && priceMicros >= sellMicros) {
    status = "sell-triggered";
  } else {
    status = "watching";
  }

  const distanceToBuyPct = currentPrice !== null && targetBuyDecimal !== null
    ? decimal(
        decimalToFixed(
          decimalRound(
            decimalMultiply(
              decimalDivide(decimalSubtract(currentPrice, targetBuyDecimal), targetBuyDecimal, 6, "half-up"),
              HUNDRED,
            ),
            2,
            "half-up",
          ),
          2,
          "half-up",
        ),
      )
    : null;

  const distanceToSellPct = currentPrice !== null && targetSellDecimal !== null
    ? decimal(
        decimalToFixed(
          decimalRound(
            decimalMultiply(
              decimalDivide(decimalSubtract(currentPrice, targetSellDecimal), targetSellDecimal, 6, "half-up"),
              HUNDRED,
            ),
            2,
            "half-up",
          ),
          2,
          "half-up",
        ),
      )
    : null;

  return {
    item,
    targetBuyDecimal,
    targetSellDecimal,
    currentPrice,
    priceSource,
    status,
    distanceToBuyPct,
    distanceToSellPct,
  };
}

function sortWatchlistItems(items: WatchlistItem[]): WatchlistItem[] {
  return [...items].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.symbol.localeCompare(b.symbol));
}

class WatchlistStore {
  private items = new Map<string, WatchlistItem>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Ignore observer errors.
      }
    }
  }

  getRevision(): number {
    return this.revision;
  }

  getAll(): WatchlistItem[] {
    return sortWatchlistItems([...this.items.values()]);
  }

  replaceAll(items: readonly WatchlistItem[]): void {
    this.items.clear();
    for (const item of items) {
      if (item && typeof item.id === "string" && item.id.trim()) {
        this.items.set(item.id, { ...item });
      }
    }
    this.notify();
  }

  async hydrateFromVault(): Promise<WatchlistItem[]> {
    const epoch = getCurrentLockEpoch();
    if (isTauriRuntime()) {
      const loaded = await invokeVaultListWatchlist().catch(() => null);
      if (!isCurrentLockEpoch(epoch)) return [];
      const list = Array.isArray(loaded) ? loaded : [];
      this.replaceAll(list);
      return this.getAll();
    }
    if (!isCurrentLockEpoch(epoch)) return [];
    const saved = readStored<unknown>(BROWSER_WATCHLIST_KEY, []);
    const list = Array.isArray(saved) ? (saved as WatchlistItem[]) : [];
    this.replaceAll(list);
    return this.getAll();
  }

  async upsert(input: UpsertWatchlistInput): Promise<WatchlistItem> {
    const epoch = getCurrentLockEpoch();
    // Reuse existing ID if symbol already exists and caller did not provide an explicit ID
    const normalizedSymbol = input.symbol.trim().toUpperCase();
    const existingBySymbol = !input.id
      ? [...this.items.values()].find((item) => item.symbol.toUpperCase() === normalizedSymbol)
      : undefined;
    const record = validateWatchlistInput({
      ...input,
      id: input.id ?? existingBySymbol?.id,
    });

    if (isTauriRuntime()) {
      const saved = await invokeVaultUpsertWatchlistItem(record);
      if (!isCurrentLockEpoch(epoch)) return saved;
      for (const [key, value] of [...this.items.entries()]) {
        if (value.symbol === saved.symbol && key !== saved.id) {
          this.items.delete(key);
        }
      }
      this.items.set(saved.id, saved);
      this.notify();
      return saved;
    }

    if (!isCurrentLockEpoch(epoch)) return record;
    for (const [key, value] of [...this.items.entries()]) {
      if (value.symbol === record.symbol && key !== record.id) {
        this.items.delete(key);
      }
    }
    this.items.set(record.id, record);
    this.persistBrowser();
    this.notify();
    await appendEvidence("state_changed", {
      action: "watchlist_upserted",
      watchlistId: record.id,
      symbol: record.symbol,
      currency: record.currency,
      enabled: String(record.enabled),
      ...(record.targetBuyMicros ? { targetBuyMicros: record.targetBuyMicros } : {}),
      ...(record.targetSellMicros ? { targetSellMicros: record.targetSellMicros } : {}),
    }).catch(() => undefined);
    return record;
  }

  async toggleEnabled(id: string): Promise<WatchlistItem | null> {
    const existing = this.items.get(id);
    if (!existing) return null;
    return this.upsert({
      id: existing.id,
      symbol: existing.symbol,
      currency: existing.currency,
      targetBuyDecimal: microsToDisplayDecimal(existing.targetBuyMicros),
      targetSellDecimal: microsToDisplayDecimal(existing.targetSellMicros),
      note: existing.note,
      enabled: !existing.enabled,
    });
  }

  async remove(id: string): Promise<boolean> {
    const epoch = getCurrentLockEpoch();
    const trimmed = id.trim();
    if (!trimmed) return false;

    if (isTauriRuntime()) {
      const deleted = await invokeVaultDeleteWatchlistItem(trimmed);
      if (!isCurrentLockEpoch(epoch)) return false;
      if (deleted) {
        this.items.delete(trimmed);
        this.notify();
      }
      return deleted;
    }

    if (!isCurrentLockEpoch(epoch)) return false;
    const existed = this.items.delete(trimmed);
    if (existed) {
      this.persistBrowser();
      this.notify();
      await appendEvidence("state_changed", {
        action: "watchlist_deleted",
        watchlistId: trimmed,
      }).catch(() => undefined);
    }
    return existed;
  }

  /** Fail-Closed App Lock heap wipe: clears RAM without modifying persisted ciphertext. */
  purgeSensitiveMemory(): void {
    this.items.clear();
    this.notify();
  }

  /** Clear RAM + browser preview storage (used during explicit reset or tests). */
  clearAll(): void {
    this.items.clear();
    if (!isTauriRuntime()) {
      removeStored(BROWSER_WATCHLIST_KEY);
    }
    this.notify();
  }

  private persistBrowser(): void {
    writeStored(BROWSER_WATCHLIST_KEY, this.getAll());
  }
}

export const WATCHLIST_STORE = new WatchlistStore();

registerBrokerResetHook(() => {
  WATCHLIST_STORE.clearAll();
});
