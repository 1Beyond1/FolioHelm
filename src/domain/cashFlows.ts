/**
 * Cash-Flow & Dividend Ledger + Per-Symbol P&L Attribution engine (v0.2.0).
 *
 * Financial & security invariants:
 * - Zero IEEE-754 float math: all sums, ratios, percentages, and attribution
 *   shares use pure `Decimal` (`src/domain/decimal.ts`) and `BigInt` micro-units.
 * - Strict currency-bucket isolation: cash flows and attribution never sum
 *   cross-currency amounts without verified FX rates.
 * - Encrypted persistence in Tauri SQLite (`cash_flows` table, AES-256-GCM + AAD)
 *   with Ed25519 evidence logging and browser-preview localStorage fallback.
 * - Fail-Closed App Lock: `CASH_FLOW_STORE.purgeSensitiveMemory()` synchronously
 *   wipes all heap records, and every async write/hydrate checks `lockEpoch`.
 */
import { readStored, removeStored, writeStored } from "../platform/storage";
import { ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID, registerAccountDeleteHook } from "./accounts";
import type { BrokerHolding, WorkspaceMode } from "./contracts";
import {
  decimal,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMultiply,
  decimalRound,
  decimalSubtract,
  decimalToFixed,
  type DecimalString,
} from "./decimal";
import { appendEvidence } from "./evidenceJournal";
import { MOCK_BROKER, registerBrokerResetHook } from "./mockBroker";
import { decimalToMicros, microsToDecimal, todayUtcIsoDate } from "./nav";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "./sessionEpoch";
import {
  invokeVaultDeleteCashFlow,
  invokeVaultListCashFlows,
  invokeVaultUpsertCashFlow,
  isTauriRuntime,
  type TauriStoredCashFlow,
} from "./tauriBridge";

const BROWSER_CASH_FLOWS_KEY = "local-cash-flows";
const ZERO = decimal("0");
const HUNDRED = decimal("100");
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
const CURRENCY_RE = /^[A-Z]{3,5}$/;

export type CashFlowType = "dividend" | "deposit" | "withdrawal" | "fee";

export const CASH_FLOW_TYPES: readonly CashFlowType[] = [
  "dividend",
  "deposit",
  "withdrawal",
  "fee",
];

export type CashFlowRecord = TauriStoredCashFlow;

export interface UpsertCashFlowInput {
  id?: string;
  accountId: string;
  flowType: CashFlowType;
  symbol?: string | null;
  currency: string;
  amountDecimal: string;
  flowDate: string;
  note?: string;
}

export interface CashFlowBucketSummary {
  currency: string;
  totalDividends: DecimalString;
  totalDeposits: DecimalString;
  totalWithdrawals: DecimalString;
  totalFees: DecimalString;
  /** deposits - withdrawals (pure external flows) */
  netExternalFlow: DecimalString;
  /** dividends + deposits - withdrawals - fees */
  netCashImpact: DecimalString;
  entryCount: number;
}

export interface PnlAttributionEntry {
  symbol: string;
  company: string;
  currency: string;
  quantity: DecimalString;
  costBasis: DecimalString;
  marketValue: DecimalString;
  unrealizedPnl: DecimalString;
  dividendsReceived: DecimalString;
  /** unrealizedPnl + dividendsReceived */
  totalContribution: DecimalString;
  /** Return on cost basis (%) formatted to 2 decimals */
  returnOnCostPct: DecimalString;
  /** Signed share of total positive/negative attribution magnitude (0..100 for bar width) */
  barScalePct: DecimalString;
}

export interface PnlAttributionSummary {
  currency: string;
  totalCostBasis: DecimalString;
  totalMarketValue: DecimalString;
  totalUnrealizedPnl: DecimalString;
  totalDividends: DecimalString;
  combinedContribution: DecimalString;
  entries: PnlAttributionEntry[];
}

export function cashFlowSignedDecimal(record: Pick<CashFlowRecord, "flowType" | "amountMicros">): DecimalString {
  const magnitude = decimal(microsToDecimal(BigInt(record.amountMicros), 6));
  if (record.flowType === "withdrawal" || record.flowType === "fee") {
    return decimalSubtract(ZERO, magnitude);
  }
  return magnitude;
}

export function cashFlowAmountDecimal(record: Pick<CashFlowRecord, "amountMicros">): DecimalString {
  return decimal(microsToDecimal(BigInt(record.amountMicros), 6));
}

function generateCashFlowId(): string {
  const rand = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e8).toString(36)}`;
  return `cf_${Date.now().toString(36)}_${rand}`;
}

export const MOCK_CASH_FLOW_ACCOUNT_ID = "acct_local_mock";

export function validateCashFlowInput(
  input: UpsertCashFlowInput,
  language: "en" | "zh" = "en",
): CashFlowRecord {
  const zh = language === "zh";
  const accountId = (input.accountId || DEFAULT_ACCOUNT_ID).trim();
  if (!accountId || accountId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(accountId)) {
    throw new Error(zh ? "现金流所属账户 ID 无效" : "Invalid account ID for cash flow");
  }
  if (!CASH_FLOW_TYPES.includes(input.flowType)) {
    throw new Error(
      zh
        ? `不支持的现金流类型：${String(input.flowType)}`
        : `Unsupported cash flow type: ${String(input.flowType)}`,
    );
  }
  const currency = input.currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency) || currency === "MULTI") {
    throw new Error(
      zh
        ? `无效币种 '${input.currency}'：每笔现金流必须归属单一币种`
        : `Invalid currency '${input.currency}': single currency required`,
    );
  }
  const trimmedAmount = input.amountDecimal.trim();
  if (!trimmedAmount || !/^\+?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(trimmedAmount)) {
    throw new Error(
      zh
        ? "现金流金额必须为正数（最多保留 6 位小数）"
        : "Cash flow amount must be a positive decimal (up to 6 decimal places)",
    );
  }
  const amountMicros = decimalToMicros(trimmedAmount);
  if (amountMicros <= 0n) {
    throw new Error(
      zh
        ? "现金流金额必须严格大于 0"
        : "Cash flow amount must be strictly greater than zero",
    );
  }
  const flowDate = (input.flowDate || todayUtcIsoDate()).trim();
  if (!ISO_DATE_RE.test(flowDate)) {
    throw new Error(
      zh
        ? `日期格式无效 '${flowDate}'：请使用 YYYY-MM-DD 格式`
        : `Invalid date '${flowDate}': expected YYYY-MM-DD`,
    );
  }
  const [yStr, mStr, dStr] = flowDate.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y
    || check.getUTCMonth() + 1 !== m
    || check.getUTCDate() !== d
  ) {
    throw new Error(
      zh ? `无效的日历日期 '${flowDate}'` : `Invalid calendar date '${flowDate}'`,
    );
  }

  let symbol: string | null = null;
  if (input.symbol && input.symbol.trim()) {
    const upper = input.symbol.trim().toUpperCase();
    if (!SYMBOL_RE.test(upper)) {
      throw new Error(
        zh ? `标的代码格式无效 '${input.symbol}'` : `Invalid symbol '${input.symbol}'`,
      );
    }
    symbol = upper;
  }

  const note = (input.note ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 200);

  const id = input.id?.trim() || generateCashFlowId();
  if (id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(zh ? "现金流记录 ID 无效" : "Invalid cash flow ID");
  }

  return {
    id,
    accountId,
    flowType: input.flowType,
    symbol,
    currency,
    amountMicros: amountMicros.toString(),
    flowDate,
    note,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Pure exact-Decimal cash-flow summary strictly isolated to one currency bucket
 * and optional account scope. Never sums cross-currency balances.
 */
export function summarizeCashFlowsForBucket(
  records: readonly CashFlowRecord[],
  currency: string,
  accountId: string = ALL_ACCOUNTS_ID,
): CashFlowBucketSummary {
  const targetCurrency = currency.trim().toUpperCase();
  const scopeAccount = accountId.trim();
  const filterByAccount = Boolean(scopeAccount && scopeAccount !== ALL_ACCOUNTS_ID);

  let dividendsMicros = 0n;
  let depositsMicros = 0n;
  let withdrawalsMicros = 0n;
  let feesMicros = 0n;
  let entryCount = 0;

  for (const record of records) {
    if (record.currency.trim().toUpperCase() !== targetCurrency) continue;
    if (filterByAccount && record.accountId !== scopeAccount) continue;
    let amt: bigint;
    try {
      amt = BigInt(record.amountMicros);
    } catch {
      continue;
    }
    if (amt <= 0n) continue;
    entryCount += 1;
    switch (record.flowType) {
      case "dividend":
        dividendsMicros += amt;
        break;
      case "deposit":
        depositsMicros += amt;
        break;
      case "withdrawal":
        withdrawalsMicros += amt;
        break;
      case "fee":
        feesMicros += amt;
        break;
    }
  }

  const netExternalMicros = depositsMicros - withdrawalsMicros;
  const netCashImpactMicros = dividendsMicros + depositsMicros - withdrawalsMicros - feesMicros;

  return {
    currency: targetCurrency,
    totalDividends: decimal(microsToDecimal(dividendsMicros, 2)),
    totalDeposits: decimal(microsToDecimal(depositsMicros, 2)),
    totalWithdrawals: decimal(microsToDecimal(withdrawalsMicros, 2)),
    totalFees: decimal(microsToDecimal(feesMicros, 2)),
    netExternalFlow: decimal(microsToDecimal(netExternalMicros, 2)),
    netCashImpact: decimal(microsToDecimal(netCashImpactMicros, 2)),
    entryCount,
  };
}

/**
 * Pure exact-Decimal per-symbol P&L attribution strictly inside one currency bucket.
 * Combines unrealized P&L with recorded dividend cash flows for each symbol.
 */
export function computePnlAttribution(
  holdings: readonly BrokerHolding[],
  cashFlows: readonly CashFlowRecord[],
  currency: string,
  language: "en" | "zh",
  accountId: string = ALL_ACCOUNTS_ID,
): PnlAttributionSummary {
  const targetCurrency = currency.trim().toUpperCase();
  const scopeAccount = accountId.trim();
  const filterByAccount = Boolean(scopeAccount && scopeAccount !== ALL_ACCOUNTS_ID);

  // Sum dividends per symbol inside this isolated currency bucket & account scope
  const dividendsBySymbol = new Map<string, bigint>();
  let totalBucketDividendsMicros = 0n;
  for (const cf of cashFlows) {
    if (cf.flowType !== "dividend") continue;
    if (cf.currency.trim().toUpperCase() !== targetCurrency) continue;
    if (filterByAccount && cf.accountId !== scopeAccount) continue;
    let amt: bigint;
    try {
      amt = BigInt(cf.amountMicros);
    } catch {
      continue;
    }
    if (amt <= 0n) continue;
    totalBucketDividendsMicros += amt;
    const sym = cf.symbol?.trim().toUpperCase();
    if (sym) {
      dividendsBySymbol.set(sym, (dividendsBySymbol.get(sym) ?? 0n) + amt);
    }
  }

  let totalCostBasis = ZERO;
  let totalMarketValue = ZERO;
  let totalUnrealizedPnl = ZERO;

  const rawEntries: Array<{
    symbol: string;
    company: string;
    currency: string;
    quantity: DecimalString;
    costBasis: DecimalString;
    marketValue: DecimalString;
    unrealizedPnl: DecimalString;
    dividendsReceived: DecimalString;
    totalContribution: DecimalString;
    returnOnCostPct: DecimalString;
    absContribution: DecimalString;
  }> = [];

  for (const holding of holdings) {
    const holdingCurr = (holding.currency ?? "USD").trim().toUpperCase();
    if (holdingCurr !== targetCurrency) continue;

    const sym = holding.symbol.trim().toUpperCase();
    const costBasis = decimalRound(decimalMultiply(holding.quantity, holding.averageCost), 2, "half-up");
    const marketValue = decimalRound(holding.marketValue, 2, "half-up");
    const unrealizedPnl = decimalRound(holding.totalPnl, 2, "half-up");
    const divMicros = dividendsBySymbol.get(sym) ?? 0n;
    const dividendsReceived = decimal(microsToDecimal(divMicros, 2));
    const totalContribution = decimalRound(decimalAdd(unrealizedPnl, dividendsReceived), 2, "half-up");

    const returnOnCostPct = decimalCompare(costBasis, ZERO) > 0
      ? decimalRound(
          decimalMultiply(decimalDivide(totalContribution, costBasis, 6, "half-up"), HUNDRED),
          2,
          "half-up",
        )
      : decimal("0");

    const absContribution = decimalCompare(totalContribution, ZERO) < 0
      ? decimalSubtract(ZERO, totalContribution)
      : totalContribution;

    totalCostBasis = decimalAdd(totalCostBasis, costBasis);
    totalMarketValue = decimalAdd(totalMarketValue, marketValue);
    totalUnrealizedPnl = decimalAdd(totalUnrealizedPnl, unrealizedPnl);

    rawEntries.push({
      symbol: sym,
      company: language === "zh" ? holding.companyZh : holding.companyEn,
      currency: targetCurrency,
      quantity: holding.quantity,
      costBasis,
      marketValue,
      unrealizedPnl,
      dividendsReceived,
      totalContribution,
      returnOnCostPct,
      absContribution,
    });
  }

  rawEntries.sort((left, right) => {
    const cmp = decimalCompare(right.totalContribution, left.totalContribution);
    if (cmp !== 0) return cmp;
    return left.symbol.localeCompare(right.symbol);
  });

  let maxAbs = ZERO;
  for (const item of rawEntries) {
    if (decimalCompare(item.absContribution, maxAbs) > 0) {
      maxAbs = item.absContribution;
    }
  }

  const entries: PnlAttributionEntry[] = rawEntries.map((item) => {
    const barScalePct = decimalCompare(maxAbs, ZERO) > 0
      ? decimalRound(
          decimalMultiply(decimalDivide(item.absContribution, maxAbs, 4, "half-up"), HUNDRED),
          1,
          "half-up",
        )
      : decimal("0");
    return {
      symbol: item.symbol,
      company: item.company,
      currency: item.currency,
      quantity: item.quantity,
      costBasis: item.costBasis,
      marketValue: item.marketValue,
      unrealizedPnl: item.unrealizedPnl,
      dividendsReceived: item.dividendsReceived,
      totalContribution: item.totalContribution,
      returnOnCostPct: decimal(decimalToFixed(item.returnOnCostPct, 2, "half-up")),
      barScalePct,
    };
  });

  const totalDividends = decimal(microsToDecimal(totalBucketDividendsMicros, 2));
  const combinedContribution = decimalRound(
    decimalAdd(totalUnrealizedPnl, totalDividends),
    2,
    "half-up",
  );

  return {
    currency: targetCurrency,
    totalCostBasis: decimalRound(totalCostBasis, 2, "half-up"),
    totalMarketValue: decimalRound(totalMarketValue, 2, "half-up"),
    totalUnrealizedPnl: decimalRound(totalUnrealizedPnl, 2, "half-up"),
    totalDividends,
    combinedContribution,
    entries,
  };
}

function sortCashFlowsDesc(list: CashFlowRecord[]): CashFlowRecord[] {
  return [...list].sort((a, b) =>
    b.flowDate.localeCompare(a.flowDate)
    || b.createdAt.localeCompare(a.createdAt)
    || a.id.localeCompare(b.id));
}

class CashFlowStore {
  /** Real local-csv encrypted vault records (persisted to SQLite / browser preview storage). */
  private realRecords = new Map<string, CashFlowRecord>();
  /** Ephemeral in-memory Mock Demo sandbox (NEVER persisted to SQLite, .fhvault, or localStorage). */
  private mockRecords = new Map<string, CashFlowRecord>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  private resolveMode(mode?: WorkspaceMode): WorkspaceMode {
    return mode ?? MOCK_BROKER.getWorkspaceMode();
  }

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

  getAll(mode?: WorkspaceMode): CashFlowRecord[] {
    const activeMode = this.resolveMode(mode);
    const map = activeMode === "mock" ? this.mockRecords : this.realRecords;
    return sortCashFlowsDesc([...map.values()]);
  }

  getFiltered(
    accountId: string = ALL_ACCOUNTS_ID,
    currency?: string,
    mode?: WorkspaceMode,
  ): CashFlowRecord[] {
    const activeMode = this.resolveMode(mode);
    const scopeAccount = accountId.trim();
    const filterAccount = activeMode === "local-csv"
      && Boolean(scopeAccount && scopeAccount !== ALL_ACCOUNTS_ID);
    const filterCurrency = currency?.trim().toUpperCase();
    return this.getAll(activeMode).filter((record) => {
      if (filterAccount && record.accountId !== scopeAccount) return false;
      if (filterCurrency && filterCurrency !== "MULTI" && record.currency.toUpperCase() !== filterCurrency) {
        return false;
      }
      return true;
    });
  }

  replaceAll(records: readonly CashFlowRecord[]): void {
    this.realRecords.clear();
    for (const record of records) {
      if (record && typeof record.id === "string" && record.id.trim()) {
        this.realRecords.set(record.id, { ...record });
      }
    }
    this.notify();
  }

  async hydrateFromVault(): Promise<CashFlowRecord[]> {
    const epoch = getCurrentLockEpoch();
    if (isTauriRuntime()) {
      const loaded = await invokeVaultListCashFlows().catch(() => null);
      if (!isCurrentLockEpoch(epoch)) return [];
      const list = Array.isArray(loaded) ? loaded : [];
      this.replaceAll(list);
      return this.getAll("local-csv");
    }
    if (!isCurrentLockEpoch(epoch)) return [];
    const saved = readStored<unknown>(BROWSER_CASH_FLOWS_KEY, []);
    const list = Array.isArray(saved) ? (saved as CashFlowRecord[]) : [];
    this.replaceAll(list);
    return this.getAll("local-csv");
  }

  async upsert(
    input: UpsertCashFlowInput,
    options?: { mode?: WorkspaceMode; language?: "en" | "zh" },
  ): Promise<CashFlowRecord> {
    const epoch = getCurrentLockEpoch();
    const activeMode = this.resolveMode(options?.mode);
    const language = options?.language ?? "en";

    if (activeMode === "mock") {
      // P1-1 strict isolation: Mock Demo sandbox stays purely in RAM and NEVER touches SQLite/.fhvault.
      const record = validateCashFlowInput(
        { ...input, accountId: MOCK_CASH_FLOW_ACCOUNT_ID },
        language,
      );
      if (!isCurrentLockEpoch(epoch)) return record;
      this.mockRecords.set(record.id, record);
      this.notify();
      return record;
    }

    const record = validateCashFlowInput(input, language);

    if (isTauriRuntime()) {
      const saved = await invokeVaultUpsertCashFlow(record);
      if (!isCurrentLockEpoch(epoch)) return saved;
      this.realRecords.set(saved.id, saved);
      this.notify();
      return saved;
    }

    if (!isCurrentLockEpoch(epoch)) return record;
    this.realRecords.set(record.id, record);
    this.persistBrowser();
    this.notify();
    await appendEvidence("state_changed", {
      action: "cash_flow_upserted",
      cashFlowId: record.id,
      accountId: record.accountId,
      flowType: record.flowType,
      currency: record.currency,
      amountMicros: record.amountMicros,
      flowDate: record.flowDate,
      ...(record.symbol ? { symbol: record.symbol } : {}),
    }).catch(() => undefined);
    return record;
  }

  async remove(id: string, mode?: WorkspaceMode): Promise<boolean> {
    const epoch = getCurrentLockEpoch();
    const trimmed = id.trim();
    if (!trimmed) return false;
    const activeMode = this.resolveMode(mode);

    if (activeMode === "mock") {
      if (!isCurrentLockEpoch(epoch)) return false;
      const existed = this.mockRecords.delete(trimmed);
      if (existed) this.notify();
      return existed;
    }

    if (isTauriRuntime()) {
      const deleted = await invokeVaultDeleteCashFlow(trimmed);
      if (!isCurrentLockEpoch(epoch)) return false;
      if (deleted) {
        this.realRecords.delete(trimmed);
        this.notify();
      }
      return deleted;
    }

    if (!isCurrentLockEpoch(epoch)) return false;
    const existed = this.realRecords.delete(trimmed);
    if (existed) {
      this.persistBrowser();
      this.notify();
      await appendEvidence("state_changed", {
        action: "cash_flow_deleted",
        cashFlowId: trimmed,
      }).catch(() => undefined);
    }
    return existed;
  }

  removeForAccount(accountId: string): void {
    const trimmed = accountId.trim();
    if (!trimmed) return;
    let changed = false;
    for (const [id, record] of [...this.realRecords.entries()]) {
      if (record.accountId === trimmed) {
        this.realRecords.delete(id);
        changed = true;
      }
    }
    if (changed) {
      if (!isTauriRuntime()) this.persistBrowser();
      this.notify();
    }
  }

  /** Fail-Closed App Lock heap wipe: clears RAM without modifying persisted ciphertext. */
  purgeSensitiveMemory(): void {
    this.realRecords.clear();
    this.mockRecords.clear();
    this.notify();
  }

  /** Clear RAM + browser preview storage (used during explicit reset or tests). */
  clearAll(): void {
    this.realRecords.clear();
    this.mockRecords.clear();
    if (!isTauriRuntime()) {
      removeStored(BROWSER_CASH_FLOWS_KEY);
    }
    this.notify();
  }

  private persistBrowser(): void {
    writeStored(BROWSER_CASH_FLOWS_KEY, this.getAll("local-csv"));
  }
}

export const CASH_FLOW_STORE = new CashFlowStore();

registerBrokerResetHook(() => {
  CASH_FLOW_STORE.clearAll();
});

registerAccountDeleteHook((accountId) => {
  CASH_FLOW_STORE.removeForAccount(accountId);
});
