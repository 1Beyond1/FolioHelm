import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { Language } from "../../types";
import { decimalToNumber } from "../../domain/decimal";
import { MOCK_BROKER } from "../../domain/mockBroker";
import {
  clearPersistedLocalPortfolio,
  commitBrokerCsv,
  MAX_CSV_BYTES,
  previewBrokerCsv,
  type CsvImportPreview,
} from "../../domain/csvImport";
import { invokeDialogOpenCsvFile, isTauriRuntime } from "../../domain/tauriBridge";
import { DataStateNotice } from "../../components/DataStateNotice";
import { Modal } from "../../components/Modal";
import { formatCurrency, formatSignedCurrency } from "../../formatters";
import "./portfolio.css";

export interface PortfolioPageProps {
  language: Language;
  onOpenInstrument: (symbol: string) => void;
  onOpenTrade: (symbol?: string) => void;
}

export interface PortfolioHolding {
  symbol: string;
  company: string;
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

function buildHoldings(language: Language): PortfolioHolding[] {
  const snapshot = MOCK_BROKER.getSnapshot();
  const totalEquity = decimalToNumber(snapshot.account.totalEquity);
  return snapshot.holdings.map((holding) => ({
    symbol: holding.symbol,
    company: language === "zh" ? holding.companyZh : holding.companyEn,
    shares: decimalToNumber(holding.quantity),
    avgCost: decimalToNumber(holding.averageCost),
    last: decimalToNumber(snapshot.quotes.find((quote) => quote.symbol === holding.symbol)?.price ?? holding.averageCost),
    marketValue: decimalToNumber(holding.marketValue),
    dayPnl: decimalToNumber(holding.dayPnl),
    totalPnl: decimalToNumber(holding.totalPnl),
    weight: totalEquity > 0 ? (decimalToNumber(holding.marketValue) / totalEquity) * 100 : 0,
  }));
}

function buildAllocation(language: Language): AllocationSegment[] {
  const snapshot = MOCK_BROKER.getSnapshot();
  const totalEquity = decimalToNumber(snapshot.account.totalEquity);
  const equities = snapshot.holdings.reduce((total, holding) => total + decimalToNumber(holding.marketValue), 0);
  const labels = language === "zh"
    ? { equities: "股票", cash: "现金" }
    : { equities: "Equities", cash: "Cash" };

  if (totalEquity <= 0) return [{ label: labels.cash, value: 100, color: "#777873" }];
  const equityValue = Math.max(0, Math.min(100, (equities / totalEquity) * 100));
  const cashValue = Math.max(0, 100 - equityValue);
  return [
    { label: labels.equities, value: equityValue, color: "#b7ff22" },
    { label: labels.cash, value: cashValue, color: "#777873" },
  ].filter((segment) => segment.value > 0);
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
    account: "Individual brokerage · •••• 1234",
    localAccount: "Local Portfolio (CSV + Paper)",
    updated: "Updated just now",
    allocation: "Account allocation",
    allocationHint: "Across the account",
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
    returnHintLocal: "Anchored to imported CSV equity baseline (no fictional history)",
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
    importModalSubtitle: "Supports Charles Schwab, IBKR Activity/Positions, and standard CSV (max 5 MB, formula-sanitized, exact Decimal).",
    chooseCsvFile: "Choose CSV file",
    detectedFormat: "Detected format",
    columnMapping: "Field mapping",
    previewCash: "Detected cash",
    previewHoldings: "Holdings preview",
    previewWarnings: "Safety & normalization notices",
    duplicateNotice: "Identical snapshot fingerprint already exists. Confirming will deduplicate instead of doubling positions.",
    confirmImport: "Confirm encrypted import",
    cancel: "Cancel",
    importSuccess: (count: number) => `Imported ${count} holdings into Local Portfolio (CSV + Paper) and recorded tamper-evident evidence.`,
    importDeduplicated: "Snapshot already imported (deduplicated safely; no positions were doubled).",
    fileTooLarge: "Selected CSV exceeds the 5 MB safety limit.",
  },
  zh: {
    eyebrow: "账户概览",
    title: "投资组合",
    subtitle: "清晰查看正在构建的账户组合。",
    totalEquity: "总权益",
    todayChange: "今日变化",
    cash: "现金",
    buyingPower: "购买力",
    account: "个人证券账户 · •••• 1234",
    localAccount: "本地持仓组合 (CSV + 纸上模拟)",
    updated: "刚刚更新",
    allocation: "账户分配",
    allocationHint: "账户整体配置",
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
    returnHintLocal: "以本地导入权益为基准锚定（不虚构历史曲线）",
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
    importModalSubtitle: "自动识别嘉信理财 (Schwab)、盈透证券 (IBKR) 与通用标准 CSV（≤ 5 MB、防公式注入清洗、精确 Decimal 核算）。",
    chooseCsvFile: "选择 CSV 文件",
    detectedFormat: "识别格式",
    columnMapping: "字段映射预览",
    previewCash: "识别现金余额",
    previewHoldings: "持仓差异预览",
    previewWarnings: "安全与规范化告警",
    duplicateNotice: "检测到与已导入快照完全一致的 SHA-256 指纹：确认后将幂等去重，不会把持仓翻倍。",
    confirmImport: "确认并加密落盘",
    cancel: "取消",
    importSuccess: (count: number) => `已安全导入 ${count} 项持仓至本地组合，并写入防篡改证据链。`,
    importDeduplicated: "该份 CSV 快照已导入过（已幂等去重跳过，未重复叠加持仓）。",
    fileTooLarge: "所选 CSV 超过 5 MB 安全上限。",
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

function formatMoney(value: number, language: Language, withSign = false): string {
  return withSign ? formatSignedCurrency(value, language) : formatCurrency(value, language);
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

export function PortfolioPage({ language, onOpenInstrument, onOpenTrade }: PortfolioPageProps) {
  const copy = COPY[language];
  const [, setBrokerTick] = useState(0);
  useEffect(() => MOCK_BROKER.subscribe(() => setBrokerTick((v) => v + 1)), []);

  const workspaceMode = MOCK_BROKER.getWorkspaceMode();
  const isLocalMode = workspaceMode === "local-csv";
  const hasLocalPortfolio = MOCK_BROKER.hasLocalPortfolio();
  const localMeta = MOCK_BROKER.getLocalPortfolioMeta();
  const snapshot = MOCK_BROKER.getSnapshot();
  const account = snapshot.account;
  const holdings = buildHoldings(language);
  const returnChart = buildReturnChart((snapshot.portfolioChart["1Y"] ?? []).map(decimalToNumber));
  const [activeSort, setActiveSort] = useState<{
    key: HoldingSortKey;
    direction: SortDirection;
  }>({ key: "marketValue", direction: "desc" });

  const [importOpen, setImportOpen] = useState(false);
  const [pendingRawCsv, setPendingRawCsv] = useState<string>("");
  const [pendingFileName, setPendingFileName] = useState<string>("");
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const allocationSegments = buildAllocation(language);
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

  function resetImportModal() {
    setImportOpen(false);
    setPendingRawCsv("");
    setPendingFileName("");
    setCsvPreview(null);
    setCsvError(null);
    setCommitting(false);
  }

  async function processCsvText(rawText: string, fileName: string) {
    setCsvError(null);
    setCsvPreview(null);
    setPendingRawCsv(rawText);
    setPendingFileName(fileName);
    try {
      const preview = await previewBrokerCsv(rawText, fileName);
      setCsvPreview(preview);
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : String(error));
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
    try {
      const result = await commitBrokerCsv(pendingRawCsv, pendingFileName || "imported.csv");
      MOCK_BROKER.applyLocalPortfolioSnapshot(result.snapshot, { switchMode: true });
      setImportFeedback(
        result.deduplicated
          ? copy.importDeduplicated
          : copy.importSuccess(result.snapshot.holdings.length),
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
    setImportFeedback(null);
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
          <div className="fh-mode-switcher" role="group" aria-label={language === "zh" ? "工作区模式" : "Workspace mode"}>
            <button
              type="button"
              className={`fh-mode-pill ${!isLocalMode ? "is-active" : ""}`}
              data-testid="workspace-mode-mock"
              aria-pressed={!isLocalMode}
              onClick={() => MOCK_BROKER.setWorkspaceMode("mock")}
            >
              {copy.modeMock}
            </button>
            <button
              type="button"
              className={`fh-mode-pill ${isLocalMode ? "is-active" : ""}`}
              data-testid="workspace-mode-local"
              aria-pressed={isLocalMode}
              onClick={() => {
                if (hasLocalPortfolio) {
                  MOCK_BROKER.setWorkspaceMode("local-csv");
                } else {
                  setImportOpen(true);
                }
              }}
            >
              {copy.modeLocal}
            </button>
          </div>
          <div className="fh-portfolio-actions">
            <button
              type="button"
              className="fh-import-csv-button"
              data-testid="open-csv-import"
              onClick={() => setImportOpen(true)}
            >
              {copy.importCsv}
            </button>
            <div className="fh-account-meta">
              <span>{isLocalMode ? copy.localAccount : copy.account}</span>
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

      <section className="fh-summary-grid" aria-label={copy.title}>
        <article className="fh-summary-card fh-summary-card-primary">
          <span>{copy.totalEquity}</span>
          <strong>{formatMoney(decimalToNumber(account.totalEquity), language)}</strong>
          <small>{localMeta && isLocalMode ? localMeta.currency : "USD"}</small>
        </article>
        <article className="fh-summary-card">
          <span>{copy.todayChange}</span>
          <strong className={decimalToNumber(account.todayChange) < 0 ? "fh-negative" : "fh-positive"}>{formatMoney(decimalToNumber(account.todayChange), language, true)}</strong>
          <small className={decimalToNumber(account.todayChangePct) < 0 ? "fh-negative" : "fh-positive"}>{formatPercent(decimalToNumber(account.todayChangePct), language, true)}</small>
        </article>
        <article className="fh-summary-card">
          <span>{copy.cash}</span>
          <strong>{formatMoney(decimalToNumber(account.cash), language)}</strong>
          <small>{localMeta && isLocalMode ? localMeta.currency : "USD"}</small>
        </article>
        <article className="fh-summary-card">
          <span>{copy.buyingPower}</span>
          <strong>{formatMoney(decimalToNumber(account.buyingPower), language)}</strong>
          <small>{localMeta && isLocalMode ? localMeta.currency : "USD"}</small>
        </article>
      </section>

      <section className="fh-feature-grid">
        <article className="fh-panel fh-allocation-panel">
          <div className="fh-panel-heading">
            <div>
              <h2>{copy.allocation}</h2>
              <p>{copy.allocationHint}</p>
            </div>
            <span className="fh-panel-kicker">100%</span>
          </div>
          <div className="fh-allocation-content">
            <div className="fh-donut-wrap">
              <svg
                className="fh-donut"
                data-testid="portfolio-allocation-donut"
                role="img"
                aria-label={copy.allocationLabel}
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
                <span>{language === "zh" ? "类资产" : "asset groups"}</span>
              </div>
            </div>
            <ul className="fh-allocation-list">
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
              <p>{isLocalMode ? copy.returnHintLocal : copy.returnHint}</p>
            </div>
            <span className={`fh-return-stat ${returnChart.changePercent < 0 ? "fh-negative" : "fh-positive"}`} data-testid="portfolio-return-stat">{formatPercent(returnChart.changePercent, language, true)}</span>
          </div>
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
                  key={holding.symbol}
                  className="fh-holding-row"
                  data-testid={`portfolio-holding-row-${holding.symbol}`}
                  data-symbol={holding.symbol}
                  tabIndex={0}
                  onClick={() => onOpenInstrument(holding.symbol)}
                  onKeyDown={(event) => activateHolding(event, holding.symbol)}
                  aria-label={`${holding.symbol} ${holding.company}`}
                >
                  <th scope="row">
                    <span className="fh-symbol">{holding.symbol}</span>
                    <span className="fh-company">{holding.company}</span>
                  </th>
                  <td className="fh-number-cell">{formatShares(holding.shares, language)}</td>
                  <td className="fh-number-cell">{formatMoney(holding.avgCost, language)}</td>
                  <td className="fh-number-cell">{formatMoney(holding.last, language)}</td>
                  <td className="fh-number-cell fh-emphasis-cell">{formatMoney(holding.marketValue, language)}</td>
                  <td className={`fh-number-cell ${holding.dayPnl < 0 ? "fh-negative" : "fh-positive"}`}>
                    {formatMoney(holding.dayPnl, language, true)}
                  </td>
                  <td className={`fh-number-cell ${holding.totalPnl < 0 ? "fh-negative" : "fh-positive"}`}>
                    {formatMoney(holding.totalPnl, language, true)}
                  </td>
                  <td className="fh-number-cell">{formatPercent(holding.weight, language)}</td>
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
                  <strong>{formatMoney(Number(csvPreview.snapshot.cash), language)} ({csvPreview.snapshot.currency})</strong>
                </div>
                <div>
                  <span>{copy.previewHoldings}</span>
                  <strong>{csvPreview.snapshot.holdings.length}</strong>
                </div>
              </div>

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
                        <td><strong>{item.symbol}</strong> <small>{item.company}</small></td>
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
