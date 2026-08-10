import { MOCK_BROKER } from "../domain/mockBroker";
import { decimalToNumber } from "../domain/decimal";
import type { BrokerSymbol } from "../domain/contracts";
import type { ActivityItem, HeatmapEntry, PortfolioMockData, PortfolioPoint, PortfolioPeriod, Position } from "../types";

/** View adapter: the canonical source is the local Mock Broker, never a page-local fixture. */
const snapshot = MOCK_BROKER.getSnapshot();
const quoteBySymbol = new Map(snapshot.quotes.map((item) => [item.symbol, item]));

function toHeatmapEntry(entry: (typeof snapshot.heatmap)[number]): HeatmapEntry {
  return {
    date: entry.date,
    dataStatus: entry.status,
    level: entry.activityLevel,
    actions: entry.actions,
    dailyReturnPct: entry.dailyReturnPct === null ? null : decimalToNumber(entry.dailyReturnPct),
    dailyReturnUsd: entry.dailyReturnUsd === null ? null : decimalToNumber(entry.dailyReturnUsd),
  };
}

const positions: Position[] = snapshot.holdings.map((holding) => ({
  ticker: holding.symbol,
  company: `${holding.companyEn} · ${holding.quantity} shares`,
  shares: decimalToNumber(holding.quantity),
  marketValue: decimalToNumber(holding.marketValue),
  unrealizedPnl: decimalToNumber(holding.dayPnl),
  iconClass: holding.symbol.toLowerCase(),
}));

const portfolioChart: Record<PortfolioPeriod, readonly number[]> = Object.fromEntries(
  Object.entries(snapshot.portfolioChart).map(([period, points]) => [
    period,
    points.map(decimalToNumber),
  ]),
) as unknown as Record<PortfolioPeriod, readonly number[]>;

const portfolioPoints: PortfolioPoint[] = [
  { dateLabel: "Jul 10", value: portfolioChart["1M"][0] ?? 0, change: 0 },
  { dateLabel: "Jul 17", value: portfolioChart["1M"][3] ?? 0, change: (portfolioChart["1M"][3] ?? 0) - (portfolioChart["1M"][0] ?? 0) },
  { dateLabel: "Jul 24", value: portfolioChart["1M"][6] ?? 0, change: (portfolioChart["1M"][6] ?? 0) - (portfolioChart["1M"][3] ?? 0) },
  { dateLabel: "Aug 1", value: portfolioChart["1M"][8] ?? 0, change: (portfolioChart["1M"][8] ?? 0) - (portfolioChart["1M"][6] ?? 0) },
  { dateLabel: "Today", value: decimalToNumber(snapshot.account.totalEquity), change: decimalToNumber(snapshot.account.todayChange) },
];

const activity: ActivityItem[] = [
  {
    kind: "filled",
    title: "AAPL limit order filled",
    detail: "100 shares at $226.34",
    time: "10:42",
  },
  {
    kind: "pending",
    title: "NVDA order pending",
    detail: "Limit price $118.00",
    time: "09:18",
  },
  {
    kind: "dividend",
    title: "SPY dividend received",
    detail: "+$184.20 cash",
    time: "08:05",
  },
];

export const MOCK_DATA_NOTICE = "Demo data · No brokerage connection";

export const MOCK_PORTFOLIO: PortfolioMockData = {
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
};

export function getMockQuotePrice(symbol: string): number | undefined {
  const quote = quoteBySymbol.get(symbol as BrokerSymbol);
  return quote ? decimalToNumber(quote.price) : undefined;
}
