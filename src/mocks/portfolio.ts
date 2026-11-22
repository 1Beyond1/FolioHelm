import { MOCK_BROKER } from "../domain/mockBroker";
import { decimalToNumber } from "../domain/decimal";
import { formatCurrency } from "../formatters";
import type { BrokerSymbol } from "../domain/contracts";
import type { ActivityItem, HeatmapEntry, Language, PortfolioMockData, PortfolioPoint, PortfolioPeriod, Position } from "../types";

/** View adapter: the canonical source is the local Mock Broker, never a page-local fixture. */
function toHeatmapEntry(entry: ReturnType<typeof MOCK_BROKER.getSnapshot>["heatmap"][number]): HeatmapEntry {
  return {
    date: entry.date,
    dataStatus: entry.status,
    level: entry.activityLevel,
    actions: entry.actions,
    dailyReturnPct: entry.dailyReturnPct === null ? null : decimalToNumber(entry.dailyReturnPct),
    dailyReturnUsd: entry.dailyReturnUsd === null ? null : decimalToNumber(entry.dailyReturnUsd),
  };
}

export const MOCK_DATA_NOTICE = "Demo data · No brokerage connection";

export function getMockPortfolio(language: Language = "en"): PortfolioMockData {
  const snapshot = MOCK_BROKER.getSnapshot();
  const workspaceMode = MOCK_BROKER.getWorkspaceMode();
  const isLocalMode = workspaceMode === "local-csv";
  const localMeta = MOCK_BROKER.getLocalPortfolioMeta();
  const chinese = language === "zh";
  const quoteBySymbol = new Map(snapshot.quotes.map((item) => [item.symbol, item]));
  const positions: Position[] = snapshot.holdings.map((holding) => ({
    ticker: holding.symbol,
    company: `${chinese ? holding.companyZh : holding.companyEn} · ${holding.quantity} ${chinese ? "股" : "shares"}`,
    shares: decimalToNumber(holding.quantity),
    marketValue: decimalToNumber(holding.marketValue),
    unrealizedPnl: decimalToNumber(holding.totalPnl),
    iconClass: holding.symbol.toLowerCase(),
    currency: holding.currency ?? "USD",
  }));

  const portfolioChart: Record<PortfolioPeriod, readonly number[]> = Object.fromEntries(
    Object.entries(snapshot.portfolioChart).map(([period, points]) => [
      period,
      points.map(decimalToNumber),
    ]),
  ) as unknown as Record<PortfolioPeriod, readonly number[]>;

  const monthlyPoints = portfolioChart["1M"] ?? [];
  const portfolioPoints: PortfolioPoint[] = [
    { dateLabel: "Jul 10", value: monthlyPoints[0] ?? 0, change: 0 },
    { dateLabel: "Jul 17", value: monthlyPoints[3] ?? 0, change: (monthlyPoints[3] ?? 0) - (monthlyPoints[0] ?? 0) },
    { dateLabel: "Jul 24", value: monthlyPoints[6] ?? 0, change: (monthlyPoints[6] ?? 0) - (monthlyPoints[3] ?? 0) },
    { dateLabel: "Aug 1", value: monthlyPoints[8] ?? 0, change: (monthlyPoints[8] ?? 0) - (monthlyPoints[6] ?? 0) },
    { dateLabel: "Today", value: decimalToNumber(snapshot.account.totalEquity), change: decimalToNumber(snapshot.account.todayChange) },
  ];

  const activity: ActivityItem[] = snapshot.orders.slice(0, 3).map((order) => {
    const quote = quoteBySymbol.get(order.symbol);
    const quoteCurr = quote?.currency ?? "USD";
    const isFilled = order.status === "filled";
    const detailPrice = order.limitPrice === null
      ? quote ? formatCurrency(decimalToNumber(quote.price), language, quoteCurr) : chinese ? "市价" : "market"
      : formatCurrency(decimalToNumber(order.limitPrice), language, quoteCurr);
    const sideLabel = chinese ? order.side === "buy" ? "买入" : "卖出" : order.side === "buy" ? "buy" : "sell";
    const statusLabel = chinese
      ? order.status === "filled" ? "订单已成交" : order.status === "working" ? "订单工作中" : order.status === "canceled" ? "订单已撤销" : order.status === "rejected" ? "订单已拒绝" : "订单状态未知"
      : order.status;
    return {
      id: order.id,
      kind: isFilled ? "filled" : "pending",
      title: `${order.symbol} ${sideLabel} ${statusLabel}`,
      detail: `${decimalToNumber(order.quantity)} ${chinese ? "股" : "shares"} · ${detailPrice}`,
      time: new Intl.DateTimeFormat(chinese ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(order.submittedAt)),
    };
  });

  const currencySubtotals = snapshot.account.currencyBreakdowns?.map((item) => ({
    currency: item.currency,
    totalEquity: decimalToNumber(item.totalEquity),
    cash: decimalToNumber(item.cash),
    holdingsCount: item.holdingsCount,
  }));

  const accountLabel = isLocalMode
    ? (chinese ? "本地持仓 (CSV + 纸上模拟)" : "Local Portfolio (CSV + Paper)")
    : undefined;
  const asOfLabel = isLocalMode && localMeta
    ? `${localMeta.sourceLabel} · ${localMeta.importedAtUtc.slice(0, 16).replace("T", " ")} UTC`
    : undefined;

  return {
    totalValue: decimalToNumber(snapshot.account.totalEquity),
    todayChange: decimalToNumber(snapshot.account.todayChange),
    todayChangePct: decimalToNumber(snapshot.account.todayChangePct),
    allTimeChange: decimalToNumber(snapshot.account.allTimeChange),
    portfolioPoints,
    portfolioChart,
    heatmap: snapshot.heatmap.map(toHeatmapEntry),
    positions,
    activity,
    activeDays: snapshot.activeDays,
    ordersFilled: snapshot.ordersFilled,
    netChange: decimalToNumber(snapshot.yearNetChange),
    workspaceMode,
    currency: snapshot.account.currency ?? "USD",
    isMultiCurrency: Boolean(snapshot.account.isMultiCurrency),
    currencySubtotals,
    accountLabel,
    asOfLabel,
  };
}

/** Backwards-compatible fixture export for component tests and external demos. */
export const MOCK_PORTFOLIO: PortfolioMockData = getMockPortfolio();

export function getMockQuotePrice(symbol: string): number | undefined {
  const quote = MOCK_BROKER.getSnapshot().quotes.find((item) => item.symbol === symbol as BrokerSymbol);
  return quote ? decimalToNumber(quote.price) : undefined;
}
