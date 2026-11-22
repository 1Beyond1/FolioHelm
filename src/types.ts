export type Language = "en" | "zh";

export type ThemeMode = "system" | "dark" | "light";

export type HeatmapMode = "activity" | "return";

export type ReturnUnit = "percent" | "usd";

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface PortfolioPoint {
  dateLabel: string;
  value: number;
  change: number;
}

export type PortfolioPeriod = "1D" | "1W" | "1M" | "6M" | "1Y";

export interface HeatmapEntry {
  date: string;
  dataStatus: "available" | "no-data" | "stale" | "error" | "offline" | "reauth-required";
  level: HeatLevel;
  actions: number;
  dailyReturnPct: number | null;
  dailyReturnUsd: number | null;
}

export interface Position {
  ticker: string;
  company: string;
  shares: number;
  marketValue: number;
  unrealizedPnl: number;
  iconClass: string;
  currency?: string;
}

export type ActivityKind = "filled" | "pending" | "dividend";

export interface ActivityItem {
  id?: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  time: string;
}

export interface PortfolioCurrencySubtotal {
  currency: string;
  totalEquity: number;
  cash: number;
  holdingsCount: number;
}

export interface PortfolioMockData {
  totalValue: number;
  todayChange: number;
  todayChangePct: number;
  allTimeChange: number;
  portfolioPoints: PortfolioPoint[];
  portfolioChart: Record<PortfolioPeriod, readonly number[]>;
  heatmap: HeatmapEntry[];
  positions: Position[];
  activity: ActivityItem[];
  activeDays: number;
  ordersFilled: number;
  netChange: number;
  workspaceMode?: "mock" | "local-csv";
  currency?: string;
  isMultiCurrency?: boolean;
  currencySubtotals?: readonly PortfolioCurrencySubtotal[];
  accountLabel?: string;
  asOfLabel?: string;
}
