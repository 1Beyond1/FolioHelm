import { useMemo, useState, type KeyboardEvent } from "react";
import type { Language } from "../../types";
import { decimalToNumber } from "../../domain/decimal";
import { MOCK_BROKER } from "../../domain/mockBroker";
import { DataStateNotice } from "../../components/DataStateNotice";
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

function buildHoldings(): PortfolioHolding[] {
  const snapshot = MOCK_BROKER.getSnapshot();
  const totalEquity = decimalToNumber(snapshot.account.totalEquity);
  return snapshot.holdings.map((holding) => ({
    symbol: holding.symbol,
    company: holding.companyEn,
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
    updated: "Updated just now",
    allocation: "Account allocation",
    allocationHint: "Across the account",
    holdings: "Holdings",
    holdingsHint: "Market value at the latest fictional quote",
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
    fictionalData: "Fictional data",
    fictionalBody: "Quotes, balances, and returns are fictional and for interface review only.",
    fictionalTag: "No brokerage connection",
    sortBy: (label: string) => `Sort by ${label}`,
    allocationLabel: "Account allocation donut",
    returnLabel: "Mock portfolio return curve",
    negative: "negative",
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
    updated: "刚刚更新",
    allocation: "账户分配",
    allocationHint: "账户整体配置",
    holdings: "持仓",
    holdingsHint: "按最新虚构报价计算的市值",
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
    fictionalData: "虚构数据",
    fictionalBody: "报价、余额和收益均为虚构内容，仅用于界面评审。",
    fictionalTag: "未连接券商",
    sortBy: (label: string) => `按${label}排序`,
    allocationLabel: "账户分配环形图",
    returnLabel: "模拟组合收益曲线",
    negative: "负值",
  },
} as const;

const RETURN_POINTS = [
  [12, 121],
  [56, 112],
  [100, 116],
  [144, 96],
  [188, 104],
  [232, 82],
  [276, 87],
  [320, 65],
  [364, 72],
  [408, 46],
  [452, 53],
  [496, 27],
] as const;

const RETURN_LINE = RETURN_POINTS.map(([x, y]) => `${x},${y}`).join(" ");
const RETURN_AREA = `M ${RETURN_POINTS[0]?.[0] ?? 0} ${RETURN_POINTS[0]?.[1] ?? 0} L ${RETURN_POINTS
  .map(([x, y]) => `${x} ${y}`)
  .join(" L ")} L 496 148 L 12 148 Z`;

function formatMoney(value: number, language: Language, withSign = false): string {
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const amount = Math.abs(value).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = value < 0 ? "-" : withSign && value > 0 ? "+" : "";
  return `${sign}$${amount}`;
}

function formatShares(value: number, language: Language): string {
  return value.toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 2,
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
  const snapshot = MOCK_BROKER.getSnapshot();
  const account = snapshot.account;
  const holdings = buildHoldings();
  const [activeSort, setActiveSort] = useState<{
    key: HoldingSortKey;
    direction: SortDirection;
  }>({ key: "marketValue", direction: "desc" });

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

  return (
    <main className="fh-page fh-portfolio-page">
      <header className="fh-page-header">
        <div>
          <p className="fh-eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="fh-page-subtitle">{copy.subtitle}</p>
        </div>
        <div className="fh-account-meta">
          <span>{copy.account}</span>
          <span>{copy.updated}</span>
        </div>
      </header>

      <section className="fh-summary-grid" aria-label={copy.title}>
        <article className="fh-summary-card fh-summary-card-primary">
          <span>{copy.totalEquity}</span>
          <strong>{formatMoney(decimalToNumber(account.totalEquity), language)}</strong>
          <small>USD</small>
        </article>
        <article className="fh-summary-card">
          <span>{copy.todayChange}</span>
          <strong className={decimalToNumber(account.todayChange) < 0 ? "fh-negative" : "fh-positive"}>{formatMoney(decimalToNumber(account.todayChange), language, true)}</strong>
          <small className={decimalToNumber(account.todayChangePct) < 0 ? "fh-negative" : "fh-positive"}>{formatPercent(decimalToNumber(account.todayChangePct), language, true)}</small>
        </article>
        <article className="fh-summary-card">
          <span>{copy.cash}</span>
          <strong>{formatMoney(decimalToNumber(account.cash), language)}</strong>
          <small>USD</small>
        </article>
        <article className="fh-summary-card">
          <span>{copy.buyingPower}</span>
          <strong>{formatMoney(decimalToNumber(account.buyingPower), language)}</strong>
          <small>USD</small>
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
              <p>{copy.returnHint}</p>
            </div>
            <span className="fh-return-stat">+18.6%</span>
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
            <path className="fh-return-area" d={RETURN_AREA} fill="url(#fh-return-fill)" />
            <polyline className="fh-return-line" points={RETURN_LINE} />
            <circle className="fh-return-endpoint" cx="496" cy="27" r="4" />
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
            <p>{copy.holdingsHint}</p>
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
          <strong>{copy.fictionalData}</strong>
          <p>{copy.fictionalBody}</p>
        </div>
        <span className="fh-quality-tag">{copy.fictionalTag}</span>
      </aside>
    </main>
  );
}

export default PortfolioPage;
