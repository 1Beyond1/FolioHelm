import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { Language } from "../../types";
import type { TradePrefill } from "../../domain/contracts";
import { decimalToNumber, money as toMoney } from "../../domain/decimal";
import {
  ACCOUNT_PRESETS,
  ACCOUNT_STORE,
  ALL_ACCOUNTS_ID,
  DEFAULT_ACCOUNT_ID,
} from "../../domain/accounts";
import { MOCK_BROKER } from "../../domain/mockBroker";
import {
  aggregateNavSnapshotsByCurrency,
  decimalToMicros,
  mulDivRoundBigInt,
  NAV_STORE,
} from "../../domain/nav";
import {
  clearPersistedLocalPortfolio,
  commitBrokerCsv,
  MAX_CSV_BYTES,
  previewBrokerCsv,
  type CsvImportPreview,
} from "../../domain/csvImport";
import {
  buildCurrentTargetWeights,
  buildEqualTargetWeights,
  calculateRebalancePlan,
  computeCurrencyBucketAllocation,
  extractCurrencyBuckets,
  REBALANCE_CASH_SYMBOL,
  type CurrencyBucketView,
  type PersistedRebalanceConfig,
  type RebalanceHoldingInput,
  type RebalanceMode,
} from "../../domain/rebalance";
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  loadEncryptedSetting,
  normalizeWorkspacePreferences,
  REBALANCE_TARGETS_SETTING_KEY,
  saveEncryptedSetting,
  saveWorkspacePreferences,
  VAULT_HYDRATED_EVENT,
  WORKSPACE_PREFS_KEY,
} from "../../domain/vaultStorage";
import { invokeDialogOpenCsvFile, isTauriRuntime } from "../../domain/tauriBridge";
import { readStored } from "../../platform/storage";
import { DataStateNotice } from "../../components/DataStateNotice";
import { Modal } from "../../components/Modal";
import { RealNavChart } from "../../components/RealNavChart";
import { getCopy } from "../../i18n";
import { formatCurrency, formatSignedCurrency } from "../../formatters";
import "./portfolio.css";

export interface PortfolioPageProps {
  language: Language;
  onOpenInstrument: (symbol: string) => void;
  onOpenTrade: (symbol?: string, prefill?: TradePrefill) => void;
}

export interface PortfolioHolding {
  symbol: string;
  company: string;
  currency: string;
  shares: number;
  avgCost: number;
  last: number;
  marketValue: number;
  dayPnl: number;
  totalPnl: number;
  weight: number;
}

type HoldingSortKey = keyof Pick<
  PortfolioHolding,
  "symbol" | "shares" | "avgCost" | "last" | "marketValue" | "dayPnl" | "totalPnl" | "weight"
>;
type SortDirection = "asc" | "desc";

interface AllocationSegment {
  label: string;
  value: number;
  color: string;
}

const SLICE_PALETTE = [
  "#b7ff22",
  "#5be9b9",
  "#60a5fa",
  "#f59e0b",
  "#c084fc",
  "#fb7185",
  "#94a3b8",
] as const;

const CASH_SLICE_COLOR = "#777873";

function buildHoldings(language: Language): PortfolioHolding[] {
  const snapshot = MOCK_BROKER.getSnapshot();
  const isMultiCurrency = Boolean(snapshot.account.isMultiCurrency);
  const totalEquityMicros = decimalToMicros(snapshot.account.totalEquity);
  const breakdownByCurrency = new Map(
    (snapshot.account.currencyBreakdowns ?? []).map((item) => [
      item.currency,
      decimalToMicros(item.totalEquity),
    ]),
  );

  return snapshot.holdings.map((holding) => {
    const currency = holding.currency ?? snapshot.account.currency ?? "USD";
    const mvMicros = decimalToMicros(holding.marketValue);
    const denomMicros = isMultiCurrency
      ? (breakdownByCurrency.get(currency) ?? 0n)
      : totalEquityMicros;
    const weightBps = denomMicros > 0n && mvMicros > 0n
      ? mulDivRoundBigInt(mvMicros, 10_000n, denomMicros)
      : 0n;
    const weightPctStr = `${(weightBps / 100n).toString()}.${(weightBps % 100n).toString().padStart(2, "0")}`;
    const matchedQuote = snapshot.quotes.find(
      (quote) => quote.symbol === holding.symbol && (quote.currency ?? "USD") === currency,
    ) ?? snapshot.quotes.find((quote) => quote.symbol === holding.symbol);
    return {
      symbol: holding.symbol,
      company: language === "zh" ? holding.companyZh : holding.companyEn,
      currency,
      shares: decimalToNumber(holding.quantity),
      avgCost: decimalToNumber(holding.averageCost),
      last: decimalToNumber(matchedQuote?.price ?? holding.averageCost),
      marketValue: decimalToNumber(holding.marketValue),
      dayPnl: decimalToNumber(holding.dayPnl),
      totalPnl: decimalToNumber(holding.totalPnl),
      weight: Number(weightPctStr),
    };
  });
}

function buildAllocationForBucket(
  bucket: CurrencyBucketView | undefined,
  language: Language,
): AllocationSegment[] {
  const cashLabel = language === "zh" ? "现金" : "Cash";
  const otherLabel = language === "zh" ? "其他持仓" : "Other";
  if (!bucket) {
    return [{ label: cashLabel, value: 100, color: CASH_SLICE_COLOR }];
  }
  const result = computeCurrencyBucketAllocation(
    bucket.holdings,
    bucket.cash,
    bucket.currency,
    { cashLabel, otherLabel },
  );
  let holdingColorIdx = 0;
  return result.slices.map((slice) => {
    const color = slice.isCash
      ? CASH_SLICE_COLOR
      : slice.isOther
        ? SLICE_PALETTE[6]
        : SLICE_PALETTE[holdingColorIdx++ % (SLICE_PALETTE.length - 1)]!;
    return {
      label: slice.label,
      value: decimalToNumber(slice.weightPct),
      color,
    };
  });
}

const COPY = {
  en: {
    eyebrow: "Account overview",
    title: "Portfolio",
    subtitle: "A clear view of the account you are building.",
    totalEquity: "Total equity",
    todayChange: "Today’s change",
    cash: "Cash",
    buyingPower: "Buying power",
    holdingsValue: "Holdings",
    account: "Individual brokerage · •••• 1234",
    localAccount: "Local Portfolio (CSV + Paper)",
    updated: "Updated just now",
    allocation: "Account allocation",
    allocationHint: "Multi-holding breakdown (top positions + cash)",
    allocationMultiCurrency: "Cross-currency allocation pie is paused: holdings span multiple currencies without verified FX conversion rates.",
    holdings: "Holdings",
    holdingsHint: "Market value at the latest fictional quote",
    holdingsHintLocal: "Market value from imported CSV baseline or delayed public quotes (read-only)",
    symbol: "Symbol",
    shares: "Shares",
    avgCost: "Avg cost",
    last: "Last",
    marketValue: "Market value",
    dayPnl: "Day P&L",
    totalPnl: "Total P&L",
    weight: "Weight",
    trade: "Trade",
    returnCurve: "Return curve",
    returnHint: "Indexed performance · last 12 months",
    returnHintLocal: "Imported CSV snapshot baseline (no synthesized historical return curve)",
    localBaselineTitle: "No fabricated historical curve in Local CSV mode",
    localBaselineBody: "FolioHelm only displays equity anchored to your imported brokerage CSV and optional delayed public quotes.",
    fictionalData: "Fictional data",
    fictionalBody: "Quotes, balances, and returns are fictional and for interface review only.",
    fictionalTag: "No brokerage connection",
    localDataTitle: "Local encrypted CSV portfolio",
    localDataBody: "Holdings and cash come from your local broker CSV import and are isolated from Mock Demo. Paper orders remain simulated only.",
    localDataTag: "AES-256-GCM encrypted · Read-only",
    sortBy: (label: string) => `Sort by ${label}`,
    allocationLabel: "Account allocation donut",
    returnLabel: "Mock portfolio return curve",
    negative: "negative",
    modeMock: "Mock Demo",
    modeLocal: "Local Portfolio (CSV + Paper)",
    importCsv: "Import Broker CSV",
    clearLocal: "Clear CSV portfolio",
    importModalTitle: "Import brokerage CSV",
    importModalSubtitle: "Supports Schwab, IBKR, Fidelity, Vanguard, Futu, Tiger, and standard CSV (max 5 MB, formula-sanitized, exact Decimal).",
    chooseCsvFile: "Choose CSV file",
    detectedFormat: "Detected format",
    columnMapping: "Field mapping",
    previewCash: "Detected cash",
    previewHoldings: "Holdings preview",
    previewWarnings: "Safety & normalization notices",
    previewSubtotals: "Per-currency isolated subtotals",
    duplicateNotice: "Identical snapshot fingerprint already exists. Confirming will deduplicate instead of doubling positions.",
    confirmImport: "Confirm encrypted import",
    cancel: "Cancel",
    importSuccess: (count: number) => `Imported ${count} holdings into Local Portfolio (CSV + Paper) and recorded tamper-evident evidence.`,
    importDeduplicated: "Snapshot already imported (deduplicated safely; no positions were doubled).",
    fileTooLarge: "Selected CSV exceeds the 5 MB safety limit.",
    multiCurrencyTitle: "Multi-currency isolation active (Fail-Safe)",
    multiCurrencyBody: (currencies: string) => `Detected multiple settlement currencies (${currencies}). FolioHelm isolates subtotals per currency and never sums cross-currency balances without verified FX rates.`,
    rebalanceEyebrow: "Read-only calculator · Exact Decimal",
    rebalanceTitle: "Target allocation & rebalance planner",
    rebalanceSubtitle: "Configure target weights summing to 100% and preview buy/sell suggestions. Single-row paper trade prefill only — batch auto-execution is permanently disabled.",
    rebalanceModeFull: "Full rebalance",
    rebalanceModeCashOnly: "Cash-only buy",
    rebalanceAdditionalCash: "New cash contribution",
    rebalanceEqual: "Equal weights",
    rebalanceSyncCurrent: "Match current",
    rebalanceWeightTotal: "Target total",
    rebalanceCashLabel: "Cash reserve",
    rebalanceEmpty: "Add or import at least one holding to configure target weights and calculate read-only rebalance suggestions.",
    rebalanceMultiCurrencyBlocked: "Cross-currency rebalancing is paused (Fail-Safe): multiple currencies detected without verified FX conversion rates.",
    rebalanceSumError: (total: string) => `Target weights currently sum to ${total}%. Adjust targets so holdings + cash equal exactly 100%.`,
    rebalanceInvalidWeight: "Enter valid non-negative decimal percentages (0 to 100) for all target weights.",
    rebalanceInvalidCash: "Additional cash contribution must be a non-negative decimal amount.",
    rebalanceColCurrentPct: "Current %",
    rebalanceColTargetPct: "Target %",
    rebalanceColDrift: "Drift",
    rebalanceColTargetVal: "Target value",
    rebalanceColDelta: "Suggested delta",
    rebalanceColShares: "Est. shares",
    rebalanceColAction: "Action",
    rebalanceActionBuy: "Buy",
    rebalanceActionSell: "Sell",
    rebalanceActionHold: "Hold",
    rebalancePrefill: "Prefill paper ticket",
    rebalanceProjectedTotal: "Projected total",
    rebalanceAvailableCash: "Available cash",
    rebalanceEstBuys: "Est. buys",
    rebalanceEstSells: "Est. sells",
    rebalanceDisclaimer: "Read-only math · Click any single row to prefill the 4-step paper trade ticket. Automatic batch order execution is disabled by design.",
  },
  zh: {
    eyebrow: "账户概览",
    title: "投资组合",
    subtitle: "清晰查看正在构建的账户组合。",
    totalEquity: "总权益",
    todayChange: "今日变化",
    cash: "现金",
    buyingPower: "购买力",
    holdingsValue: "持仓市值",
    account: "个人证券账户 · •••• 1234",
    localAccount: "本地持仓组合 (CSV + 纸上模拟)",
    updated: "刚刚更新",
    allocation: "账户分配",
    allocationHint: "多标的持仓占比（前 6 大持仓 + 现金）",
    allocationMultiCurrency: "跨币种占比图已隔离：当前持仓包含多种结算币种，未接入权威汇率前不混合计算跨币种占比。",
    holdings: "持仓",
    holdingsHint: "按最新虚构报价计算的市值",
    holdingsHintLocal: "按导入的 CSV 基准价或延迟公开只读行情计算的市值",
    symbol: "代码",
    shares: "股数",
    avgCost: "平均成本",
    last: "现价",
    marketValue: "市值",
    dayPnl: "日盈亏",
    totalPnl: "累计盈亏",
    weight: "权重",
    trade: "交易",
    returnCurve: "收益曲线",
    returnHint: "指数化表现 · 过去 12 个月",
    returnHintLocal: "本地 CSV 持仓基准视图（严禁虚构历史收益曲线）",
    localBaselineTitle: "本地 CSV 模式不伪造历史走势曲线",
    localBaselineBody: "FolioHelm 仅展示来自本地导入 CSV 与可选延迟公开行情的真实基准数据，绝不合成虚假的 12 个月历史收益曲线。",
    fictionalData: "虚构数据",
    fictionalBody: "报价、余额和收益均为虚构内容，仅用于界面评审。",
    fictionalTag: "未连接券商",
    localDataTitle: "本地加密 CSV 持仓",
    localDataBody: "当前持仓与现金来自您导入的本地券商 CSV，与 Mock 演示数据完全隔离；所有纸上模拟订单均不连接券商下单。",
    localDataTag: "AES-256-GCM 加密 · 仅本地只读",
    sortBy: (label: string) => `按${label}排序`,
    allocationLabel: "账户分配环形图",
    returnLabel: "模拟组合收益曲线",
    negative: "负值",
    modeMock: "Mock 演示模式",
    modeLocal: "本地持仓 (CSV + 纸上模拟)",
    importCsv: "导入券商 CSV",
    clearLocal: "清除本地 CSV 组合",
    importModalTitle: "安全导入券商 CSV",
    importModalSubtitle: "自动识别嘉信理财 (Schwab)、盈透证券 (IBKR)、Fidelity、Vanguard、富途 (Futu)、老虎 (Tiger) 与标准 CSV（≤ 5 MB、防公式注入清洗、精确 Decimal 核算）。",
    chooseCsvFile: "选择 CSV 文件",
    detectedFormat: "识别格式",
    columnMapping: "字段映射预览",
    previewCash: "识别现金余额",
    previewHoldings: "持仓差异预览",
    previewWarnings: "安全与规范化告警",
    previewSubtotals: "多币种分项小计（Fail-Safe 隔离）",
    duplicateNotice: "检测到与已导入快照完全一致的 SHA-256 指纹：确认后将幂等去重，不会把持仓翻倍。",
    confirmImport: "确认并加密落盘",
    cancel: "取消",
    importSuccess: (count: number) => `已安全导入 ${count} 项持仓至本地组合，并写入防篡改证据链。`,
    importDeduplicated: "该份 CSV 快照已导入过（已幂等去重跳过，未重复叠加持仓）。",
    fileTooLarge: "所选 CSV 超过 5 MB 安全上限。",
    multiCurrencyTitle: "已启用多币种 Fail-Safe 隔离",
    multiCurrencyBody: (currencies: string) => `检测到多个结算币种（${currencies}）。未接入实时汇率前，系统按币种分项小计，绝不跨币种盲目相加。`,
    rebalanceEyebrow: "只读再平衡计算器 · 纯 Decimal 精度",
    rebalanceTitle: "目标仓位与再平衡建议",
    rebalanceSubtitle: "配置总计为 100% 的目标权重并预览调仓建议；单条建议支持一键预填四步纸上模拟交易单，永久禁止自动批量下单。",
    rebalanceModeFull: "存量调仓",
    rebalanceModeCashOnly: "仅新增现金买入",
    rebalanceAdditionalCash: "新增投入现金",
    rebalanceEqual: "均分权重",
    rebalanceSyncCurrent: "同步当前占比",
    rebalanceWeightTotal: "目标权重合计",
    rebalanceCashLabel: "现金储备",
    rebalanceEmpty: "导入或持有至少 1 项标的后，即可配置目标仓位权重并生成只读再平衡建议。",
    rebalanceMultiCurrencyBlocked: "多币种组合已暂停跨币种再平衡（Fail-Safe）：未接入权威汇率前不可跨币种混合测算权重。",
    rebalanceSumError: (total: string) => `当前目标权重合计为 ${total}%，请调整使所有持仓与现金权重严格等于 100%。`,
    rebalanceInvalidWeight: "请为所有目标权重输入合法的非负十进制百分比（0 至 100）。",
    rebalanceInvalidCash: "新增投入现金必须为非负十进制金额。",
    rebalanceColCurrentPct: "当前占比",
    rebalanceColTargetPct: "目标占比",
    rebalanceColDrift: "偏离度",
    rebalanceColTargetVal: "目标市值",
    rebalanceColDelta: "建议金额",
    rebalanceColShares: "估算股数",
    rebalanceColAction: "操作建议",
    rebalanceActionBuy: "买入",
    rebalanceActionSell: "卖出",
    rebalanceActionHold: "持有",
    rebalancePrefill: "预填模拟单",
    rebalanceProjectedTotal: "调仓后总规模",
    rebalanceAvailableCash: "可用现金",
    rebalanceEstBuys: "预计买入",
    rebalanceEstSells: "预计卖出",
    rebalanceDisclaimer: "纯只读数学测算 · 点击单行可预填四步纸上模拟交易单；系统从架构层面永久禁止自动批量下单。",
  },
} as const;

interface ReturnChartData {
  line: string;
  area: string;
  endpointY: number;
  changePercent: number;
}

function buildReturnChart(values: readonly number[]): ReturnChartData {
  const startX = 12;
  const endX = 496;
  const topY = 27;
  const bottomY = 148;
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? first;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const denominator = Math.max(values.length - 1, 1);
  const points = values.map((value, index) => {
    const x = startX + (index / denominator) * (endX - startX);
    const y = topY + ((max - value) / range) * (bottomY - topY);
    return { x, y };
  });
  const line = points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = points.length === 0
    ? ""
    : `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)} L ${points.slice(1).map(({ x, y }) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L ")} L ${endX} ${bottomY} L ${startX} ${bottomY} Z`;

  return {
    line,
    area,
    endpointY: points.at(-1)?.y ?? bottomY,
    changePercent: first === 0 ? 0 : ((last - first) / Math.abs(first)) * 100,
  };
}

function formatMoney(value: number, language: Language, withSign = false, currency = "USD"): string {
  return withSign ? formatSignedCurrency(value, language, currency) : formatCurrency(value, language, currency);
}

function formatShares(value: number, language: Language): string {
  return value.toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 4,
  });
}

function formatPercent(value: number, language: Language, withSign = false): string {
  const amount = value.toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${withSign && value > 0 ? "+" : ""}${amount}%`;
}

function getSortValue(holding: PortfolioHolding, key: HoldingSortKey): string | number {
  return holding[key];
}

function SortButton({
  label,
  sortKey,
  activeSort,
  copy,
  onSort,
}: {
  label: string;
  sortKey: HoldingSortKey;
  activeSort: { key: HoldingSortKey; direction: SortDirection };
  copy: (label: string) => string;
  onSort: (key: HoldingSortKey) => void;
}) {
  const isActive = activeSort.key === sortKey;
  const direction = isActive ? (activeSort.direction === "asc" ? "↑" : "↓") : "↕";

  return (
    <button
      type="button"
      className="fh-sort-button"
      aria-label={copy(label)}
      onClick={() => onSort(sortKey)}
    >
      <span>{label}</span>
      <span className="fh-sort-indicator" aria-hidden="true">{direction}</span>
    </button>
  );
}

function reconcileWeights(
  stored: Record<string, string> | null,
  holdings: readonly RebalanceHoldingInput[],
  cash: typeof MOCK_BROKER extends never ? never : ReturnType<typeof MOCK_BROKER.getSnapshot>["account"]["cash"],
): Record<string, string> {
  if (!stored) {
    return buildCurrentTargetWeights(holdings, cash);
  }
  const hasAnyHoldingMatch = holdings.some((h) => typeof stored[h.symbol] === "string");
  if (!hasAnyHoldingMatch && holdings.length > 0) {
    return buildCurrentTargetWeights(holdings, cash);
  }
  const next: Record<string, string> = {};
  for (const h of holdings) {
    next[h.symbol] = typeof stored[h.symbol] === "string" ? stored[h.symbol]! : "0.00";
  }
  next[REBALANCE_CASH_SYMBOL] = typeof stored[REBALANCE_CASH_SYMBOL] === "string"
    ? stored[REBALANCE_CASH_SYMBOL]!
    : "0.00";
  return next;
}

export function PortfolioPage({ language, onOpenInstrument, onOpenTrade }: PortfolioPageProps) {
  const copy = COPY[language];
  const chinese = language === "zh";
  const appCopy = getCopy(language);
  const [, setBrokerTick] = useState(0);
  useEffect(() => {
    const bump = () => setBrokerTick((v) => v + 1);
    const unsubBroker = MOCK_BROKER.subscribe(bump);
    const unsubAccounts = ACCOUNT_STORE.subscribe(bump);
    const unsubNav = NAV_STORE.subscribe(bump);
    return () => {
      unsubBroker();
      unsubAccounts();
      unsubNav();
    };
  }, []);

  const workspaceMode = MOCK_BROKER.getWorkspaceMode();
  const isLocalMode = workspaceMode === "local-csv";
  const hasLocalPortfolio = MOCK_BROKER.hasLocalPortfolio();
  const localMeta = MOCK_BROKER.getLocalPortfolioMeta();
  const snapshot = MOCK_BROKER.getSnapshot();
  const account = snapshot.account;
  const isMultiCurrency = Boolean(account.isMultiCurrency);
  const currencyBreakdowns = account.currencyBreakdowns ?? [];
  const accountCurrency = account.currency ?? (localMeta && isLocalMode ? localMeta.currency : "USD");
  const holdings = buildHoldings(language);
  const returnChart = buildReturnChart((snapshot.portfolioChart["1Y"] ?? []).map(decimalToNumber));
  const [activeSort, setActiveSort] = useState<{
    key: HoldingSortKey;
    direction: SortDirection;
  }>({ key: "marketValue", direction: "desc" });

  // F2: Multi-account state
  const accounts = ACCOUNT_STORE.getAccounts();
  const selectedAccountId = MOCK_BROKER.getSelectedAccountId();
  const selectedAccountLabel = selectedAccountId === ALL_ACCOUNTS_ID
    ? (chinese ? `全部账户 (${accounts.length})` : `All Accounts (${accounts.length})`)
    : (accounts.find((a) => a.id === selectedAccountId)?.name ?? selectedAccountId);

  // F2: Per-currency bucket isolation (USD / HKD / CNY ... — zero cross-currency FX blending)
  const currencyBuckets = useMemo(
    () => extractCurrencyBuckets(snapshot, language),
    [language, snapshot],
  );
  const [selectedBucketCurrency, setSelectedBucketCurrency] = useState<string>("USD");
  const activeBucket: CurrencyBucketView = useMemo(() => {
    const found = currencyBuckets.find((b) => b.currency === selectedBucketCurrency);
    if (found) return found;
    return currencyBuckets[0] ?? {
      currency: accountCurrency === "MULTI" ? "USD" : accountCurrency,
      cash: account.cash,
      holdingsValue: toMoney("0"),
      totalEquity: account.totalEquity,
      holdings: [],
    };
  }, [account.cash, account.totalEquity, accountCurrency, currencyBuckets, selectedBucketCurrency]);

  // F1: Real NAV & benchmark comparison state for Local Portfolio mode
  const [selectedBenchmark, setSelectedBenchmark] = useState<string | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkNotice, setBenchmarkNotice] = useState<string | null>(null);
  const localNavSnapshots = useMemo(
    () => isLocalMode
      ? aggregateNavSnapshotsByCurrency(NAV_STORE.getAllSnapshots(), activeBucket.currency, selectedAccountId)
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isLocalMode, activeBucket.currency, selectedAccountId, snapshot.account.asOf, NAV_STORE.getAllSnapshots().length],
  );

  // CSV import modal + F2 target account selector state
  const [importOpen, setImportOpen] = useState(false);
  const [pendingRawCsv, setPendingRawCsv] = useState<string>("");
  const [pendingFileName, setPendingFileName] = useState<string>("");
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [targetAccountId, setTargetAccountId] = useState<string>(DEFAULT_ACCOUNT_ID);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [newAcctName, setNewAcctName] = useState("");
  const [newAcctBroker, setNewAcctBroker] = useState("Schwab");
  const [newAcctType, setNewAcctType] = useState("taxable");
  const [newAcctCurrency, setNewAcctCurrency] = useState("USD");
  const [newAcctError, setNewAcctError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // C4 + F2: Rebalance state scoped strictly to the active currency bucket (zero cross-currency FX)
  const rebalanceHoldings: readonly RebalanceHoldingInput[] = activeBucket.holdings;
  const activeBucketCurrency = activeBucket.currency;
  const activeBucketCash = activeBucket.cash;

  const holdingSignature = useMemo(
    () => `${workspaceMode}:${selectedAccountId}:${activeBucketCurrency}:${rebalanceHoldings.map((item) => `${item.symbol}:${item.currency}`).join(",")}`,
    [activeBucketCurrency, rebalanceHoldings, selectedAccountId, workspaceMode],
  );

  const isLegacyDefaultBucket = !isMultiCurrency && selectedAccountId === ALL_ACCOUNTS_ID;
  const rebalanceSettingKey = isLegacyDefaultBucket
    ? `${REBALANCE_TARGETS_SETTING_KEY}:${workspaceMode}`
    : `${REBALANCE_TARGETS_SETTING_KEY}:${workspaceMode}:${selectedAccountId}:${activeBucketCurrency}`;
  const rebalanceLegacyKey = isLegacyDefaultBucket
    ? `rebalance-targets-${workspaceMode}`
    : `rebalance-targets-${workspaceMode}-${selectedAccountId}-${activeBucketCurrency}`;
  const initialStoredRebalance = !isTauriRuntime()
    ? readStored<PersistedRebalanceConfig | null>(rebalanceLegacyKey, null)
    : null;

  const [rebalanceMode, setRebalanceMode] = useState<RebalanceMode>(() =>
    initialStoredRebalance?.mode === "cash-only-buy" ? "cash-only-buy" : "full-rebalance",
  );
  const [additionalCash, setAdditionalCash] = useState<string>(() =>
    typeof initialStoredRebalance?.additionalCash === "string" ? initialStoredRebalance.additionalCash : "0",
  );
  const [targetWeights, setTargetWeights] = useState<Record<string, string>>(() =>
    reconcileWeights(initialStoredRebalance?.weights ?? null, rebalanceHoldings, activeBucketCash),
  );
  const lastSignatureRef = useRef(holdingSignature);

  useEffect(() => {
    let active = true;
    const applySaved = (saved: PersistedRebalanceConfig | null) => {
      if (!active) return;
      if (saved && typeof saved === "object") {
        setRebalanceMode(saved.mode === "cash-only-buy" ? "cash-only-buy" : "full-rebalance");
        setAdditionalCash(typeof saved.additionalCash === "string" ? saved.additionalCash : "0");
        setTargetWeights(reconcileWeights(saved.weights ?? null, rebalanceHoldings, activeBucketCash));
      } else {
        setRebalanceMode("full-rebalance");
        setAdditionalCash("0");
        setTargetWeights(buildCurrentTargetWeights(rebalanceHoldings, activeBucketCash));
      }
    };

    const hydrateRebalanceAsync = async () => {
      const saved = await loadEncryptedSetting<PersistedRebalanceConfig | null>(
        rebalanceSettingKey,
        null,
        rebalanceLegacyKey,
      );
      applySaved(saved);
    };

    if (isTauriRuntime()) {
      void hydrateRebalanceAsync();
    } else if (lastSignatureRef.current !== holdingSignature) {
      const saved = readStored<PersistedRebalanceConfig | null>(rebalanceLegacyKey, null);
      applySaved(saved);
    }
    lastSignatureRef.current = holdingSignature;

    const onVaultHydrated = () => {
      void hydrateRebalanceAsync();
    };
    window.addEventListener(VAULT_HYDRATED_EVENT, onVaultHydrated);
    return () => {
      active = false;
      window.removeEventListener(VAULT_HYDRATED_EVENT, onVaultHydrated);
    };
    // Intentionally keyed on holdingSignature & setting keys so edits don't re-trigger hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdingSignature, rebalanceSettingKey, rebalanceLegacyKey]);

  const rebalancePersistTimerRef = useRef<number | null>(null);
  const pendingRebalanceSaveRef = useRef<{
    settingKey: string;
    legacyKey: string;
    config: PersistedRebalanceConfig;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (rebalancePersistTimerRef.current !== null) {
        window.clearTimeout(rebalancePersistTimerRef.current);
        rebalancePersistTimerRef.current = null;
      }
      if (pendingRebalanceSaveRef.current) {
        const pending = pendingRebalanceSaveRef.current;
        pendingRebalanceSaveRef.current = null;
        void saveEncryptedSetting(pending.settingKey, pending.config, pending.legacyKey);
      }
    };
  }, [rebalanceSettingKey, rebalanceLegacyKey]);

  function persistRebalanceConfigNow(next: PersistedRebalanceConfig) {
    if (rebalancePersistTimerRef.current !== null) {
      window.clearTimeout(rebalancePersistTimerRef.current);
      rebalancePersistTimerRef.current = null;
    }
    pendingRebalanceSaveRef.current = null;
    void saveEncryptedSetting(rebalanceSettingKey, next, rebalanceLegacyKey);
  }

  function persistRebalanceConfigDebounced(next: PersistedRebalanceConfig) {
    pendingRebalanceSaveRef.current = {
      settingKey: rebalanceSettingKey,
      legacyKey: rebalanceLegacyKey,
      config: next,
    };
    if (rebalancePersistTimerRef.current !== null) {
      window.clearTimeout(rebalancePersistTimerRef.current);
    }
    rebalancePersistTimerRef.current = window.setTimeout(() => {
      rebalancePersistTimerRef.current = null;
      const pending = pendingRebalanceSaveRef.current;
      pendingRebalanceSaveRef.current = null;
      if (pending) {
        void saveEncryptedSetting(pending.settingKey, pending.config, pending.legacyKey);
      }
    }, 350);
  }

  function handleRebalanceModeChange(nextMode: RebalanceMode) {
    setRebalanceMode(nextMode);
    persistRebalanceConfigNow({ mode: nextMode, additionalCash, weights: targetWeights });
  }

  function handleAdditionalCashChange(value: string) {
    setAdditionalCash(value);
    persistRebalanceConfigDebounced({ mode: rebalanceMode, additionalCash: value, weights: targetWeights });
  }

  function handleTargetWeightChange(symbol: string, value: string) {
    const nextWeights = { ...targetWeights, [symbol]: value };
    setTargetWeights(nextWeights);
    persistRebalanceConfigDebounced({ mode: rebalanceMode, additionalCash, weights: nextWeights });
  }

  function handleApplyEqualWeights() {
    const nextWeights = buildEqualTargetWeights(rebalanceHoldings.map((item) => item.symbol));
    setTargetWeights(nextWeights);
    persistRebalanceConfigNow({ mode: rebalanceMode, additionalCash, weights: nextWeights });
  }

  function handleSyncCurrentWeights() {
    const nextWeights = buildCurrentTargetWeights(rebalanceHoldings, activeBucketCash);
    setTargetWeights(nextWeights);
    persistRebalanceConfigNow({ mode: rebalanceMode, additionalCash, weights: nextWeights });
  }

  const rebalancePlan = useMemo(
    () =>
      calculateRebalancePlan({
        holdings: rebalanceHoldings,
        cash: activeBucketCash,
        currency: activeBucketCurrency,
        isMultiCurrency: false,
        targetWeights,
        mode: rebalanceMode,
        additionalCash,
      }),
    [activeBucketCash, activeBucketCurrency, additionalCash, rebalanceHoldings, rebalanceMode, targetWeights],
  );

  const sortedHoldings = useMemo(() => {
    return [...holdings].sort((left, right) => {
      const leftValue = getSortValue(left, activeSort.key);
      const rightValue = getSortValue(right, activeSort.key);
      const comparison =
        typeof leftValue === "string" && typeof rightValue === "string"
          ? leftValue.localeCompare(rightValue)
          : Number(leftValue) - Number(rightValue);

      return activeSort.direction === "asc" ? comparison : -comparison;
    });
  }, [activeSort, holdings]);

  const allocationSegments = buildAllocationForBucket(activeBucket, language);
  let allocationOffset = 0;
  const allocationVisuals = allocationSegments.map((segment) => {
    const visual = { ...segment, offset: allocationOffset };
    allocationOffset += segment.value;
    return visual;
  });
  const circumference = 2 * Math.PI * 42;

  function handleSort(key: HoldingSortKey) {
    setActiveSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  function activateHolding(event: KeyboardEvent<HTMLTableRowElement>, symbol: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenInstrument(symbol);
    }
  }

  function handleSelectAccount(nextAccountId: string) {
    ACCOUNT_STORE.setSelectedAccountId(nextAccountId);
    MOCK_BROKER.setSelectedAccountId(nextAccountId);
    setSelectedBenchmark(null);
    setBenchmarkNotice(null);
  }

  function handleSelectBucketCurrency(nextCurrency: string) {
    setSelectedBucketCurrency(nextCurrency);
    setSelectedBenchmark(null);
    setBenchmarkNotice(null);
  }

  async function handleRefreshPortfolioBenchmark(symbol: string) {
    setBenchmarkLoading(true);
    setBenchmarkNotice(null);
    try {
      const prefs = !isTauriRuntime()
        ? normalizeWorkspacePreferences(readStored(WORKSPACE_PREFS_KEY, DEFAULT_WORKSPACE_PREFERENCES))
        : DEFAULT_WORKSPACE_PREFERENCES;
      const outcome = await NAV_STORE.syncBenchmarkHistory(symbol, prefs.quoteProvider);
      if (outcome.degradedReason) {
        setBenchmarkNotice(
          outcome.series
            ? (chinese
                ? `离线降级：使用本地缓存的 ${symbol}（${outcome.degradedReason}）`
                : `Degraded to cached ${symbol} (${outcome.degradedReason})`)
            : (chinese
                ? `${symbol} 基准行情暂不可用（${outcome.degradedReason}）`
                : `${symbol} benchmark unavailable (${outcome.degradedReason})`),
        );
      }
    } catch (error) {
      setBenchmarkNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBenchmarkLoading(false);
    }
  }

  function resetImportModal() {
    setImportOpen(false);
    setPendingRawCsv("");
    setPendingFileName("");
    setCsvPreview(null);
    setCsvError(null);
    setCommitting(false);
    setCreatingAccount(false);
    setNewAcctError(null);
  }

  async function processCsvText(rawText: string, fileName: string, acctIdOverride?: string) {
    setCsvError(null);
    setCsvPreview(null);
    setPendingRawCsv(rawText);
    setPendingFileName(fileName);
    const resolvedAcctId = acctIdOverride ?? targetAccountId;
    const targetAcct = ACCOUNT_STORE.getAccount(resolvedAcctId);
    try {
      const preview = await previewBrokerCsv(rawText, fileName, resolvedAcctId, targetAcct?.name);
      setCsvPreview(preview);
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCreateAccountInline() {
    setNewAcctError(null);
    if (!newAcctName.trim()) {
      setNewAcctError(chinese ? "请输入账户名称（如 Schwab Taxable 或 Futu HK）。" : "Enter an account name (e.g. Schwab Taxable or Futu HK).");
      return;
    }
    try {
      const created = await ACCOUNT_STORE.createOrUpdateAccount({
        name: newAcctName,
        broker: newAcctBroker,
        accountType: newAcctType,
        baseCurrency: newAcctCurrency,
      });
      setTargetAccountId(created.id);
      setCreatingAccount(false);
      setNewAcctName("");
      if (pendingRawCsv) {
        await processCsvText(pendingRawCsv, pendingFileName || "imported.csv", created.id);
      }
    } catch (error) {
      setNewAcctError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleChooseCsvFile() {
    if (isTauriRuntime()) {
      try {
        const opened = await invokeDialogOpenCsvFile();
        if (!opened) return;
        await processCsvText(opened.content, opened.fileName);
        return;
      } catch (error) {
        setCsvError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    fileInputRef.current?.click();
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      setCsvError(copy.fileTooLarge);
      return;
    }
    const text = await file.text();
    await processCsvText(text, file.name);
  }

  async function handleConfirmCsvImport() {
    if (!pendingRawCsv || !csvPreview) return;
    setCommitting(true);
    setCsvError(null);
    const targetAcct = ACCOUNT_STORE.getAccount(targetAccountId);
    try {
      const result = await commitBrokerCsv(
        pendingRawCsv,
        pendingFileName || "imported.csv",
        targetAccountId,
        targetAcct?.name,
      );
      MOCK_BROKER.applyLocalPortfolioSnapshot(result.snapshot, { switchMode: true });
      await saveWorkspacePreferences({ workspaceMode: "local-csv" });
      setImportFeedback(
        result.deduplicated
          ? copy.importDeduplicated
          : `${copy.importSuccess(result.snapshot.holdings.length)}${targetAcct ? ` [${targetAcct.name}]` : ""}`,
      );
      resetImportModal();
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : String(error));
      setCommitting(false);
    }
  }

  async function handleClearLocalPortfolio() {
    await clearPersistedLocalPortfolio();
    MOCK_BROKER.clearLocalPortfolio();
    await saveWorkspacePreferences({ workspaceMode: "mock" });
    setImportFeedback(null);
  }

  function handleSwitchMode(nextMode: "mock" | "local-csv") {
    if (nextMode === "local-csv" && !hasLocalPortfolio) {
      setImportOpen(true);
      return;
    }
    MOCK_BROKER.setWorkspaceMode(nextMode);
    void saveWorkspacePreferences({ workspaceMode: nextMode });
  }

  return (
    <main className="fh-page fh-portfolio-page">
      <header className="fh-page-header">
        <div>
          <p className="fh-eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="fh-page-subtitle">{copy.subtitle}</p>
        </div>
        <div className="fh-portfolio-controls">
          <div className="fh-mode-switcher" role="group" aria-label={chinese ? "工作区模式" : "Workspace mode"}>
            <button
              type="button"
              className={`fh-mode-pill ${!isLocalMode ? "is-active" : ""}`}
              data-testid="workspace-mode-mock"
              aria-pressed={!isLocalMode}
              onClick={() => handleSwitchMode("mock")}
            >
              {copy.modeMock}
            </button>
            <button
              type="button"
              className={`fh-mode-pill ${isLocalMode ? "is-active" : ""}`}
              data-testid="workspace-mode-local"
              aria-pressed={isLocalMode}
              onClick={() => handleSwitchMode("local-csv")}
            >
              {copy.modeLocal}
            </button>
          </div>
          {isLocalMode && (
            <label className="fh-account-switcher-wrap">
              <span>{chinese ? "账户视图" : "Account scope"}</span>
              <select
                className="fh-account-switcher"
                data-testid="portfolio-account-switcher"
                value={selectedAccountId}
                onChange={(event) => handleSelectAccount(event.target.value)}
              >
                <option value={ALL_ACCOUNTS_ID}>
                  {chinese ? `全部账户 (${accounts.length})` : `All Accounts (${accounts.length})`}
                </option>
                {accounts.map((acct) => (
                  <option key={acct.id} value={acct.id}>
                    {acct.name} ({acct.baseCurrency})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="fh-portfolio-actions">
            <button
              type="button"
              className="fh-import-csv-button"
              data-testid="open-csv-import"
              onClick={() => {
                setTargetAccountId(
                  selectedAccountId !== ALL_ACCOUNTS_ID && ACCOUNT_STORE.getAccount(selectedAccountId)
                    ? selectedAccountId
                    : DEFAULT_ACCOUNT_ID,
                );
                setImportOpen(true);
              }}
            >
              {copy.importCsv}
            </button>
            <div className="fh-account-meta">
              <span>{isLocalMode ? `${copy.localAccount} · ${selectedAccountLabel}` : copy.account}</span>
              <span>{isLocalMode && localMeta ? `${localMeta.sourceLabel} · ${localMeta.fingerprint.slice(0, 8)}` : copy.updated}</span>
            </div>
          </div>
        </div>
      </header>

      {importFeedback && (
        <section className="fh-import-feedback" role="status" data-testid="csv-import-feedback">
          <span>{importFeedback}</span>
          <button type="button" onClick={() => setImportFeedback(null)}>×</button>
        </section>
      )}

      {isMultiCurrency && currencyBreakdowns.length > 0 ? (
        <section className="fh-multicurrency-section" aria-label={copy.multiCurrencyTitle}>
          <div className="fh-multicurrency-notice" role="status" data-testid="multi-currency-notice">
            <strong>{copy.multiCurrencyTitle}</strong>
            <p>{copy.multiCurrencyBody(currencyBreakdowns.map((item) => item.currency).join(" / "))}</p>
          </div>
          <div className="fh-multicurrency-grid" data-testid="multi-currency-summary-grid">
            {currencyBreakdowns.map((item) => (
              <article
                key={item.currency}
                className="fh-summary-card fh-currency-card"
                data-testid={`currency-summary-${item.currency}`}
              >
                <div className="fh-currency-card-head">
                  <span>{item.currency} · {copy.totalEquity}</span>
                  <small>{item.holdingsCount} {copy.holdings}</small>
                </div>
                <strong>{formatMoney(decimalToNumber(item.totalEquity), language, false, item.currency)}</strong>
                <div className="fh-currency-card-metrics">
                  <span>{copy.holdingsValue}: {formatMoney(decimalToNumber(item.holdingsValue), language, false, item.currency)}</span>
                  <span>{copy.cash}: {formatMoney(decimalToNumber(item.cash), language, false, item.currency)}</span>
                  <span className={decimalToNumber(item.dayPnl) < 0 ? "fh-negative" : "fh-positive"}>
                    {copy.dayPnl}: {formatMoney(decimalToNumber(item.dayPnl), language, true, item.currency)}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="fh-summary-grid" aria-label={copy.title}>
          <article className="fh-summary-card fh-summary-card-primary">
            <span>{copy.totalEquity}</span>
            <strong>{formatMoney(decimalToNumber(account.totalEquity), language, false, accountCurrency)}</strong>
            <small>{accountCurrency}</small>
          </article>
          <article className="fh-summary-card">
            <span>{copy.todayChange}</span>
            <strong className={decimalToNumber(account.todayChange) < 0 ? "fh-negative" : "fh-positive"}>
              {formatMoney(decimalToNumber(account.todayChange), language, true, accountCurrency)}
            </strong>
            <small className={decimalToNumber(account.todayChangePct) < 0 ? "fh-negative" : "fh-positive"}>
              {formatPercent(decimalToNumber(account.todayChangePct), language, true)}
            </small>
          </article>
          <article className="fh-summary-card">
            <span>{copy.cash}</span>
            <strong>{formatMoney(decimalToNumber(account.cash), language, false, accountCurrency)}</strong>
            <small>{accountCurrency}</small>
          </article>
          <article className="fh-summary-card">
            <span>{copy.buyingPower}</span>
            <strong>{formatMoney(decimalToNumber(account.buyingPower), language, false, accountCurrency)}</strong>
            <small>{accountCurrency}</small>
          </article>
        </section>
      )}

      <section className="fh-feature-grid">
        <article className="fh-panel fh-allocation-panel">
          <div className="fh-panel-heading">
            <div>
              <h2>{copy.allocation}</h2>
              <p>
                {isMultiCurrency
                  ? (chinese
                      ? `按币种桶独立展示 (${activeBucketCurrency} 桶 · 严禁跨币种 FX 混算)`
                      : `Currency-isolated bucket (${activeBucketCurrency} only · No cross-currency FX blending)`)
                  : copy.allocationHint}
              </p>
            </div>
            <div className="fh-bucket-header-right">
              {currencyBuckets.length > 1 && (
                <div
                  className="fh-bucket-tabs"
                  role="group"
                  aria-label={chinese ? "配置币种桶" : "Allocation currency bucket"}
                  data-testid="allocation-currency-tabs"
                >
                  {currencyBuckets.map((bucket) => (
                    <button
                      key={bucket.currency}
                      type="button"
                      className={`fh-bucket-tab ${bucket.currency === activeBucketCurrency ? "is-active" : ""}`}
                      aria-pressed={bucket.currency === activeBucketCurrency}
                      data-testid={`allocation-bucket-tab-${bucket.currency}`}
                      onClick={() => handleSelectBucketCurrency(bucket.currency)}
                    >
                      {bucket.currency}
                    </button>
                  ))}
                </div>
              )}
              <span className="fh-panel-kicker">{activeBucketCurrency} · 100%</span>
            </div>
          </div>
          {isMultiCurrency && (
            <p className="fh-bucket-isolation-note" data-testid="allocation-bucket-isolation-badge">
              {chinese
                ? `仅统计 ${activeBucketCurrency} 桶内持仓与现金（纯整型微单位权重，绝不跨币种混加）。`
                : `Strictly scoped to ${activeBucketCurrency} holdings & cash (exact integer micro weights; no FX blending).`}
            </p>
          )}
          <div className="fh-allocation-content">
            <div className="fh-donut-wrap">
              <svg
                className="fh-donut"
                data-testid="portfolio-allocation-donut"
                data-currency={activeBucketCurrency}
                role="img"
                aria-label={`${copy.allocationLabel} (${activeBucketCurrency})`}
                viewBox="0 0 120 120"
              >
                <circle className="fh-donut-track" cx="60" cy="60" r="42" />
                {allocationVisuals.map((segment) => {
                  const segmentLength = (segment.value / 100) * circumference;
                  return (
                    <circle
                      key={segment.label}
                      className="fh-donut-segment"
                      cx="60"
                      cy="60"
                      r="42"
                      stroke={segment.color}
                      strokeDasharray={`${segmentLength} ${circumference - segmentLength}`}
                      strokeDashoffset={-((segment.offset / 100) * circumference)}
                    />
                  );
                })}
              </svg>
              <div className="fh-donut-center" aria-hidden="true">
                <strong>{allocationSegments.length}</strong>
                <span>{isMultiCurrency ? activeBucketCurrency : (chinese ? "项配置" : "slices")}</span>
              </div>
            </div>
            <ul className="fh-allocation-list" data-testid="portfolio-allocation-list">
              {allocationVisuals.map((segment) => (
                <li key={segment.label}>
                  <span className="fh-legend-dot" style={{ backgroundColor: segment.color }} />
                  <span>{segment.label}</span>
                  <strong>{formatPercent(segment.value, language)}</strong>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="fh-panel fh-return-panel">
          <div className="fh-panel-heading">
            <div>
              <h2>{copy.returnCurve}</h2>
              <p>
                {isLocalMode
                  ? (chinese
                      ? `${activeBucketCurrency} 币种桶真实快照净值与时间加权收益率 TWR（< 2 个点不伪造曲线）`
                      : `${activeBucketCurrency} bucket real NAV & TWR (< 2 snapshots never fabricated)`)
                  : copy.returnHint}
              </p>
            </div>
            {!isLocalMode && (
              <span
                className={`fh-return-stat ${returnChart.changePercent < 0 ? "fh-negative" : "fh-positive"}`}
                data-testid="portfolio-return-stat"
              >
                {formatPercent(returnChart.changePercent, language, true)}
              </span>
            )}
          </div>
          {isLocalMode ? (
            <RealNavChart
              copy={appCopy}
              language={language}
              currency={activeBucketCurrency}
              accountId={selectedAccountId}
              accountLabel={selectedAccountLabel}
              snapshots={localNavSnapshots}
              selectedBenchmark={selectedBenchmark}
              benchmarkSeries={selectedBenchmark ? NAV_STORE.getBenchmark(selectedBenchmark) : null}
              benchmarkLoading={benchmarkLoading}
              benchmarkNotice={benchmarkNotice}
              onSelectBenchmark={(sym) => {
                setSelectedBenchmark(sym);
                setBenchmarkNotice(null);
              }}
              onRefreshBenchmark={(sym) => void handleRefreshPortfolioBenchmark(sym)}
              allTimeChange={decimalToNumber(account.allTimeChange)}
              isMultiCurrency={isMultiCurrency}
              baselineTestId="portfolio-local-baseline"
              compact
            />
          ) : (
            <>
              <svg
                className="fh-return-chart"
                data-testid="portfolio-return-chart"
                role="img"
                aria-label={copy.returnLabel}
                viewBox="0 0 508 164"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="fh-return-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#b7ff22" stopOpacity="0.18" />
                    <stop offset="100%" stopColor="#b7ff22" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <line className="fh-chart-grid-line" x1="12" x2="496" y1="27" y2="27" />
                <line className="fh-chart-grid-line" x1="12" x2="496" y1="87" y2="87" />
                <line className="fh-chart-grid-line" x1="12" x2="496" y1="148" y2="148" />
                <path className="fh-return-area" d={returnChart.area} fill="url(#fh-return-fill)" />
                <polyline className="fh-return-line" points={returnChart.line} />
                <circle className="fh-return-endpoint" cx="496" cy={returnChart.endpointY} r="4" />
              </svg>
              <div className="fh-chart-axis" aria-hidden="true">
                <span>{language === "zh" ? "12个月前" : "12 months ago"}</span>
                <span>{language === "zh" ? "现在" : "Now"}</span>
              </div>
            </>
          )}
        </article>
      </section>

      <section className="fh-panel fh-holdings-panel" aria-labelledby="fh-holdings-title">
        <div className="fh-panel-heading fh-holdings-heading">
          <div>
            <h2 id="fh-holdings-title">{copy.holdings}</h2>
            <p>{isLocalMode ? copy.holdingsHintLocal : copy.holdingsHint}</p>
          </div>
          <span className="fh-holdings-count">{holdings.length}</span>
        </div>
        <div className="fh-table-scroll">
          <table className="fh-holdings-table" data-testid="portfolio-holdings-table">
            <thead>
              <tr>
                <th scope="col" aria-sort={activeSort.key === "symbol" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.symbol} sortKey="symbol" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" className="fh-number-cell" aria-sort={activeSort.key === "shares" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.shares} sortKey="shares" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" className="fh-number-cell" aria-sort={activeSort.key === "avgCost" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.avgCost} sortKey="avgCost" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" className="fh-number-cell" aria-sort={activeSort.key === "last" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.last} sortKey="last" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" className="fh-number-cell" aria-sort={activeSort.key === "marketValue" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.marketValue} sortKey="marketValue" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" className="fh-number-cell" aria-sort={activeSort.key === "dayPnl" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.dayPnl} sortKey="dayPnl" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" className="fh-number-cell" aria-sort={activeSort.key === "totalPnl" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.totalPnl} sortKey="totalPnl" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" className="fh-number-cell" aria-sort={activeSort.key === "weight" ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <SortButton label={copy.weight} sortKey="weight" activeSort={activeSort} copy={copy.sortBy} onSort={handleSort} />
                </th>
                <th scope="col" aria-label={copy.trade} />
              </tr>
            </thead>
            <tbody>
              {sortedHoldings.map((holding) => (
                <tr
                  key={`${holding.symbol}:${holding.currency}`}
                  className="fh-holding-row"
                  data-testid={`portfolio-holding-row-${holding.symbol}`}
                  data-symbol={holding.symbol}
                  tabIndex={0}
                  onClick={() => onOpenInstrument(holding.symbol)}
                  onKeyDown={(event) => activateHolding(event, holding.symbol)}
                  aria-label={`${holding.symbol} ${holding.company}`}
                >
                  <th scope="row">
                    <span className="fh-symbol">
                      {holding.symbol}
                      {(isMultiCurrency || holding.currency !== "USD") && (
                        <span className="fh-currency-badge">{holding.currency}</span>
                      )}
                    </span>
                    <span className="fh-company">{holding.company}</span>
                  </th>
                  <td className="fh-number-cell">{formatShares(holding.shares, language)}</td>
                  <td className="fh-number-cell">{formatMoney(holding.avgCost, language, false, holding.currency)}</td>
                  <td className="fh-number-cell">{formatMoney(holding.last, language, false, holding.currency)}</td>
                  <td className="fh-number-cell fh-emphasis-cell">{formatMoney(holding.marketValue, language, false, holding.currency)}</td>
                  <td className={`fh-number-cell ${holding.dayPnl < 0 ? "fh-negative" : "fh-positive"}`}>
                    {formatMoney(holding.dayPnl, language, true, holding.currency)}
                  </td>
                  <td className={`fh-number-cell ${holding.totalPnl < 0 ? "fh-negative" : "fh-positive"}`}>
                    {formatMoney(holding.totalPnl, language, true, holding.currency)}
                  </td>
                  <td className="fh-number-cell">
                    {formatPercent(holding.weight, language)}
                    {isMultiCurrency ? ` ${holding.currency}` : ""}
                  </td>
                  <td className="fh-action-cell">
                    <button
                      type="button"
                      className="fh-trade-button"
                      data-testid={`portfolio-trade-${holding.symbol}`}
                      aria-label={`${copy.trade} ${holding.symbol}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenTrade(holding.symbol);
                      }}
                    >
                      {copy.trade}
                    </button>
                  </td>
                </tr>
              ))}
              {sortedHoldings.length === 0 && (
                <tr className="fh-empty-row">
                  <td colSpan={9}><DataStateNotice language={language} status="no-data" compact /></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="fh-panel fh-rebalance-panel"
        data-testid="rebalance-panel"
        aria-labelledby="fh-rebalance-title"
      >
        <div className="fh-panel-heading fh-rebalance-heading">
          <div>
            <p className="fh-eyebrow">{copy.rebalanceEyebrow}</p>
            <h2 id="fh-rebalance-title">{copy.rebalanceTitle}</h2>
            <p>{copy.rebalanceSubtitle}</p>
          </div>
          <div className="fh-rebalance-controls">
            {currencyBuckets.length > 1 && (
              <div
                className="fh-bucket-tabs"
                role="group"
                aria-label={chinese ? "再平衡币种桶" : "Rebalance currency bucket"}
                data-testid="rebalance-currency-tabs"
              >
                {currencyBuckets.map((bucket) => (
                  <button
                    key={bucket.currency}
                    type="button"
                    className={`fh-bucket-tab ${bucket.currency === activeBucketCurrency ? "is-active" : ""}`}
                    aria-pressed={bucket.currency === activeBucketCurrency}
                    data-testid={`rebalance-bucket-tab-${bucket.currency}`}
                    onClick={() => handleSelectBucketCurrency(bucket.currency)}
                  >
                    {bucket.currency}
                  </button>
                ))}
              </div>
            )}
            {rebalanceHoldings.length > 0 && (
              <>
                <div className="fh-mode-switcher" role="group" aria-label={copy.rebalanceTitle}>
                  <button
                    type="button"
                    className={`fh-mode-pill ${rebalanceMode === "full-rebalance" ? "is-active" : ""}`}
                    data-testid="rebalance-mode-full"
                    aria-pressed={rebalanceMode === "full-rebalance"}
                    onClick={() => handleRebalanceModeChange("full-rebalance")}
                  >
                    {copy.rebalanceModeFull}
                  </button>
                  <button
                    type="button"
                    className={`fh-mode-pill ${rebalanceMode === "cash-only-buy" ? "is-active" : ""}`}
                    data-testid="rebalance-mode-cash-only"
                    aria-pressed={rebalanceMode === "cash-only-buy"}
                    onClick={() => handleRebalanceModeChange("cash-only-buy")}
                  >
                    {copy.rebalanceModeCashOnly}
                  </button>
                </div>
                <div className="fh-rebalance-quick-actions">
                  <button
                    type="button"
                    className="fh-rebalance-util-btn"
                    data-testid="rebalance-equal-btn"
                    onClick={handleApplyEqualWeights}
                  >
                    {copy.rebalanceEqual}
                  </button>
                  <button
                    type="button"
                    className="fh-rebalance-util-btn"
                    data-testid="rebalance-sync-btn"
                    onClick={handleSyncCurrentWeights}
                  >
                    {copy.rebalanceSyncCurrent}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {isMultiCurrency && (
          <p className="fh-bucket-isolation-note" data-testid="rebalance-bucket-isolation-badge">
            {chinese
              ? `当前仅对 ${activeBucketCurrency} 币种桶内部独立计算再平衡（严禁跨币种 FX 混算）。切换上方币种标签查看其他币种桶。`
              : `Rebalancing strictly inside the isolated ${activeBucketCurrency} bucket (cross-currency FX blending disabled). Switch tabs above for other currencies.`}
          </p>
        )}

        {rebalanceHoldings.length === 0 ? (
          <div className="fh-rebalance-empty" data-testid="rebalance-empty-notice">
            <p>{copy.rebalanceEmpty}</p>
          </div>
        ) : (
          <div className="fh-rebalance-body" data-currency={activeBucketCurrency}>
            <div className="fh-rebalance-toolbar">
              <label className="fh-rebalance-cash-field">
                <span>{copy.rebalanceAdditionalCash} ({activeBucketCurrency})</span>
                <input
                  type="text"
                  inputMode="decimal"
                  data-testid="rebalance-additional-cash"
                  value={additionalCash}
                  onChange={(event) => handleAdditionalCashChange(event.target.value)}
                />
              </label>
              <div className="fh-rebalance-total-badge" data-testid="rebalance-weight-total">
                <span>{copy.rebalanceWeightTotal}</span>
                <strong className={rebalancePlan.valid ? "fh-positive" : "fh-negative"}>
                  {rebalancePlan.totalTargetWeightPct}%
                </strong>
              </div>
            </div>

            <div className="fh-rebalance-weights-grid">
              {rebalanceHoldings.map((holding) => (
                <label key={holding.symbol} className="fh-rebalance-weight-item">
                  <span>{holding.symbol}</span>
                  <div className="fh-rebalance-input-wrap">
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`${holding.symbol} ${copy.rebalanceColTargetPct}`}
                      data-testid={`rebalance-weight-input-${holding.symbol}`}
                      value={targetWeights[holding.symbol] ?? "0"}
                      onChange={(event) => handleTargetWeightChange(holding.symbol, event.target.value)}
                    />
                    <span>%</span>
                  </div>
                </label>
              ))}
              <label className="fh-rebalance-weight-item">
                <span>{copy.rebalanceCashLabel}</span>
                <div className="fh-rebalance-input-wrap">
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`${copy.rebalanceCashLabel} ${copy.rebalanceColTargetPct}`}
                    data-testid="rebalance-weight-input-CASH"
                    value={targetWeights[REBALANCE_CASH_SYMBOL] ?? "0"}
                    onChange={(event) => handleTargetWeightChange(REBALANCE_CASH_SYMBOL, event.target.value)}
                  />
                  <span>%</span>
                </div>
              </label>
            </div>

            {!rebalancePlan.valid && (
              <div className="fh-csv-error fh-rebalance-alert" role="alert" data-testid="rebalance-validation-error">
                {rebalancePlan.errorCode === "weight-sum-mismatch"
                  ? copy.rebalanceSumError(rebalancePlan.totalTargetWeightPct)
                  : rebalancePlan.errorCode === "invalid-additional-cash"
                    ? copy.rebalanceInvalidCash
                    : copy.rebalanceInvalidWeight}
              </div>
            )}

            {rebalancePlan.valid && (
              <>
                <div className="fh-rebalance-metrics">
                  <div>
                    <span>{copy.rebalanceProjectedTotal}</span>
                    <strong>{formatMoney(decimalToNumber(rebalancePlan.projectedPortfolioValue), language, false, activeBucketCurrency)}</strong>
                  </div>
                  <div>
                    <span>{copy.rebalanceAvailableCash}</span>
                    <strong>{formatMoney(decimalToNumber(rebalancePlan.availableCash), language, false, activeBucketCurrency)}</strong>
                  </div>
                  <div>
                    <span>{copy.rebalanceEstBuys}</span>
                    <strong className="fh-positive">{formatMoney(decimalToNumber(rebalancePlan.totalBuyAmount), language, false, activeBucketCurrency)}</strong>
                  </div>
                  <div>
                    <span>{copy.rebalanceEstSells}</span>
                    <strong className={decimalToNumber(rebalancePlan.totalSellAmount) > 0 ? "fh-negative" : ""}>
                      {formatMoney(decimalToNumber(rebalancePlan.totalSellAmount), language, false, activeBucketCurrency)}
                    </strong>
                  </div>
                </div>

                <div className="fh-table-scroll">
                  <table className="fh-holdings-table fh-rebalance-table" data-testid="rebalance-suggestions">
                    <thead>
                      <tr>
                        <th scope="col">{copy.symbol}</th>
                        <th scope="col" className="fh-number-cell">{copy.rebalanceColCurrentPct}</th>
                        <th scope="col" className="fh-number-cell">{copy.rebalanceColTargetPct}</th>
                        <th scope="col" className="fh-number-cell">{copy.rebalanceColDrift}</th>
                        <th scope="col" className="fh-number-cell">{copy.rebalanceColTargetVal}</th>
                        <th scope="col" className="fh-number-cell">{copy.rebalanceColDelta}</th>
                        <th scope="col" className="fh-number-cell">{copy.rebalanceColShares}</th>
                        <th scope="col" className="fh-action-cell">{copy.rebalanceColAction}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rebalancePlan.suggestions.map((suggestion) => {
                        const isCashRow = suggestion.symbol === REBALANCE_CASH_SYMBOL;
                        const deltaNum = decimalToNumber(suggestion.deltaAmount);
                        const driftNum = decimalToNumber(suggestion.driftPct);
                        return (
                          <tr key={suggestion.symbol} data-testid={`rebalance-row-${suggestion.symbol}`}>
                            <th scope="row">
                              <span className="fh-symbol">{isCashRow ? copy.rebalanceCashLabel : suggestion.symbol}</span>
                            </th>
                            <td className="fh-number-cell">{formatPercent(decimalToNumber(suggestion.currentWeightPct), language)}</td>
                            <td className="fh-number-cell">{formatPercent(decimalToNumber(suggestion.targetWeightPct), language)}</td>
                            <td className={`fh-number-cell ${driftNum < 0 ? "fh-negative" : driftNum > 0 ? "fh-positive" : ""}`}>
                              {formatPercent(driftNum, language, true)}
                            </td>
                            <td className="fh-number-cell">{formatMoney(decimalToNumber(suggestion.targetValue), language, false, suggestion.currency)}</td>
                            <td className={`fh-number-cell ${deltaNum < 0 ? "fh-negative" : deltaNum > 0 ? "fh-positive" : ""}`}>
                              {formatMoney(deltaNum, language, true, suggestion.currency)}
                            </td>
                            <td className="fh-number-cell">
                              {isCashRow ? "—" : suggestion.estimatedShares}
                            </td>
                            <td className="fh-action-cell">
                              {suggestion.canPrefillTrade ? (
                                <button
                                  type="button"
                                  className="fh-trade-button"
                                  data-testid={`rebalance-prefill-${suggestion.symbol}`}
                                  onClick={() =>
                                    onOpenTrade(suggestion.symbol, {
                                      symbol: suggestion.symbol,
                                      side: suggestion.action === "sell" ? "sell" : "buy",
                                      quantity: suggestion.estimatedShares,
                                      orderType: "market",
                                    })
                                  }
                                >
                                  {suggestion.action === "sell" ? copy.rebalanceActionSell : copy.rebalanceActionBuy} · {copy.rebalancePrefill}
                                </button>
                              ) : (
                                <span className="fh-rebalance-hold-pill">{copy.rebalanceActionHold}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <p className="fh-rebalance-disclaimer" data-testid="rebalance-readonly-disclaimer">
                  {copy.rebalanceDisclaimer}
                </p>
              </>
            )}
          </div>
        )}
      </section>

      <aside className="fh-data-quality" data-testid="portfolio-data-quality" role="note">
        <span className="fh-quality-mark">i</span>
        <div>
          <strong>{isLocalMode ? copy.localDataTitle : copy.fictionalData}</strong>
          <p>{isLocalMode ? copy.localDataBody : copy.fictionalBody}</p>
        </div>
        <div className="fh-quality-actions">
          <span className="fh-quality-tag">{isLocalMode ? copy.localDataTag : copy.fictionalTag}</span>
          {isLocalMode && (
            <button
              type="button"
              className="fh-clear-local-button"
              data-testid="clear-local-portfolio"
              onClick={() => void handleClearLocalPortfolio()}
            >
              {copy.clearLocal}
            </button>
          )}
        </div>
      </aside>

      {importOpen && (
        <Modal
          className="fh-csv-modal"
          backdropClassName="fh-csv-backdrop"
          labelledBy="fh-csv-modal-title"
          testId="csv-import-modal"
          onClose={resetImportModal}
        >
          <div className="fh-csv-modal-header">
            <div>
              <p className="fh-eyebrow">{copy.modeLocal}</p>
              <h2 id="fh-csv-modal-title">{copy.importModalTitle}</h2>
              <p className="fh-page-subtitle">{copy.importModalSubtitle}</p>
            </div>
            <button type="button" className="fh-csv-close" aria-label={copy.cancel} onClick={resetImportModal}>×</button>
          </div>

          <div className="fh-csv-account-section" data-testid="csv-account-section">
            <div className="fh-csv-account-row">
              <label className="fh-csv-account-select-wrap">
                <span>{chinese ? "导入目标账户" : "Target account"}</span>
                <select
                  data-testid="csv-target-account-select"
                  value={creatingAccount ? "__NEW__" : targetAccountId}
                  onChange={(event) => {
                    const nextVal = event.target.value;
                    if (nextVal === "__NEW__") {
                      setCreatingAccount(true);
                      setNewAcctError(null);
                      return;
                    }
                    setCreatingAccount(false);
                    setTargetAccountId(nextVal);
                    if (pendingRawCsv) {
                      void processCsvText(pendingRawCsv, pendingFileName || "imported.csv", nextVal);
                    }
                  }}
                >
                  {accounts.map((acct) => (
                    <option key={acct.id} value={acct.id}>
                      {acct.name} ({acct.broker} · {acct.baseCurrency})
                    </option>
                  ))}
                  <option value="__NEW__">
                    {chinese ? "+ 新建账户..." : "+ Create new account..."}
                  </option>
                </select>
              </label>
              <button
                type="button"
                className="fh-rebalance-util-btn"
                data-testid="csv-toggle-new-account"
                onClick={() => {
                  setCreatingAccount((cur) => !cur);
                  setNewAcctError(null);
                }}
              >
                {creatingAccount
                  ? (chinese ? "取消新建" : "Cancel new")
                  : (chinese ? "+ 新建账户" : "+ New account")}
              </button>
            </div>

            {creatingAccount && (
              <div className="fh-csv-new-account-form" data-testid="csv-new-account-form">
                <div className="fh-csv-preset-chips">
                  {ACCOUNT_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="fh-csv-preset-chip"
                      data-testid={`csv-preset-${preset.name.toLowerCase().replace(/\s+/g, "-")}`}
                      onClick={() => {
                        setNewAcctName(preset.name);
                        setNewAcctBroker(preset.broker);
                        setNewAcctType(preset.accountType);
                        setNewAcctCurrency(preset.baseCurrency);
                      }}
                    >
                      {preset.name} ({preset.baseCurrency})
                    </button>
                  ))}
                </div>
                <div className="fh-csv-new-account-grid">
                  <input
                    type="text"
                    placeholder={chinese ? "账户名 (如 Schwab IRA / Futu HK)" : "Account name (e.g. Schwab IRA)"}
                    data-testid="csv-new-account-name"
                    value={newAcctName}
                    onChange={(event) => setNewAcctName(event.target.value)}
                  />
                  <input
                    type="text"
                    placeholder={chinese ? "券商 (Schwab / Futu / IBKR)" : "Broker (Schwab / Futu / IBKR)"}
                    data-testid="csv-new-account-broker"
                    value={newAcctBroker}
                    onChange={(event) => setNewAcctBroker(event.target.value)}
                  />
                  <select
                    data-testid="csv-new-account-type"
                    value={newAcctType}
                    onChange={(event) => setNewAcctType(event.target.value)}
                  >
                    <option value="taxable">Taxable</option>
                    <option value="ira">IRA</option>
                    <option value="roth_ira">Roth IRA</option>
                    <option value="margin">Margin</option>
                    <option value="cash">Cash</option>
                  </select>
                  <select
                    data-testid="csv-new-account-currency"
                    value={newAcctCurrency}
                    onChange={(event) => setNewAcctCurrency(event.target.value)}
                  >
                    <option value="USD">USD</option>
                    <option value="HKD">HKD</option>
                    <option value="CNY">CNY</option>
                    <option value="EUR">EUR</option>
                    <option value="SGD">SGD</option>
                    <option value="GBP">GBP</option>
                  </select>
                  <button
                    type="button"
                    className="fh-import-csv-button"
                    data-testid="csv-create-account-btn"
                    onClick={() => void handleCreateAccountInline()}
                  >
                    {chinese ? "保存账户" : "Save account"}
                  </button>
                </div>
                {newAcctError && (
                  <div className="fh-csv-error" role="alert">{newAcctError}</div>
                )}
              </div>
            )}
          </div>

          <div className="fh-csv-picker-row">
            <button
              type="button"
              className="fh-import-csv-button"
              data-testid="csv-choose-file"
              onClick={() => void handleChooseCsvFile()}
            >
              {copy.chooseCsvFile}
            </button>
            {pendingFileName && <span className="fh-csv-filename">{pendingFileName}</span>}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="fh-hidden-file"
              data-testid="csv-file-input"
              onChange={(event) => void handleFileInputChange(event)}
            />
          </div>

          {csvError && (
            <div className="fh-csv-error" role="alert" data-testid="csv-import-error">
              {csvError}
            </div>
          )}

          {csvPreview && (
            <div className="fh-csv-preview" data-testid="csv-import-preview">
              <div className="fh-csv-meta-grid">
                <div>
                  <span>{copy.detectedFormat}</span>
                  <strong>{language === "zh" ? csvPreview.formatLabelZh : csvPreview.formatLabelEn}</strong>
                </div>
                <div>
                  <span>{copy.previewCash}</span>
                  <strong>
                    {csvPreview.snapshot.isMultiCurrency
                      ? (csvPreview.snapshot.currencies ?? []).join(" / ")
                      : `${formatMoney(Number(csvPreview.snapshot.cash), language, false, csvPreview.snapshot.currency)} (${csvPreview.snapshot.currency})`}
                  </strong>
                </div>
                <div>
                  <span>{copy.previewHoldings}</span>
                  <strong>{csvPreview.snapshot.holdings.length}</strong>
                </div>
              </div>

              {csvPreview.snapshot.isMultiCurrency && csvPreview.currencySubtotals && csvPreview.currencySubtotals.length > 0 && (
                <div className="fh-csv-subtotals" data-testid="csv-currency-subtotals">
                  <span>{copy.previewSubtotals}:</span>
                  <div className="fh-csv-mapping-chips">
                    {csvPreview.currencySubtotals.map((sub) => (
                      <code key={sub.currency}>
                        {sub.currency}: {formatMoney(Number(sub.totalValue), language, false, sub.currency)} ({sub.holdingsCount})
                      </code>
                    ))}
                  </div>
                </div>
              )}

              {csvPreview.columnMappings.length > 0 && (
                <div className="fh-csv-mappings">
                  <span>{copy.columnMapping}:</span>
                  <div className="fh-csv-mapping-chips">
                    {csvPreview.columnMappings.map((mapping) => (
                      <code key={mapping.canonicalField}>{mapping.canonicalField} ← {mapping.sourceHeader}</code>
                    ))}
                  </div>
                </div>
              )}

              {csvPreview.alreadyImported && (
                <p className="fh-csv-warning" role="status" data-testid="csv-duplicate-warning">
                  {copy.duplicateNotice}
                </p>
              )}

              {csvPreview.warnings.length > 0 && (
                <div className="fh-csv-warning" role="status" data-testid="csv-safety-warnings">
                  <strong>{copy.previewWarnings}</strong>
                  <ul>
                    {csvPreview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="fh-csv-preview-table-wrap">
                <table className="fh-csv-preview-table">
                  <thead>
                    <tr>
                      <th>{copy.symbol}</th>
                      <th>{copy.shares}</th>
                      <th>{copy.avgCost}</th>
                      <th>{copy.last}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.snapshot.holdings.slice(0, 12).map((item) => (
                      <tr key={item.symbol}>
                        <td><strong>{item.symbol}</strong> <small>{item.company} · {item.currency}</small></td>
                        <td>{item.quantity}</td>
                        <td>{item.averageCost}</td>
                        <td>{item.lastPrice}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="fh-csv-modal-actions">
            <button type="button" className="fh-csv-cancel" onClick={resetImportModal}>{copy.cancel}</button>
            <button
              type="button"
              className="fh-import-csv-button"
              data-testid="csv-confirm-import"
              disabled={!csvPreview || committing}
              onClick={() => void handleConfirmCsvImport()}
            >
              {copy.confirmImport}
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

export default PortfolioPage;
