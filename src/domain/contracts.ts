import type { Money, Percent, Price, Quantity } from "./decimal";

export type WorkspaceMode = "mock" | "local-csv";
export type BrokerMode = "mock" | "local-csv" | "offline" | "live-disabled";
export type DataStatus = "available" | "no-data" | "stale" | "error" | "offline" | "reauth-required";
export type QuoteSourceKind = "mock" | "csv-import" | "public-delayed";

export type DefaultMockSymbol = "AAPL" | "NVDA" | "MSFT" | "SPY" | "TSLA" | "AMD" | "AMZN";
export type BrokerSymbol = string;
export type BrokerOrderStatus = "working" | "filled" | "canceled" | "rejected" | "unknown";
export type BrokerOrderSide = "buy" | "sell";
export type BrokerOrderType = "market" | "limit";
export type BrokerPortfolioPeriod = "1D" | "1W" | "1M" | "6M" | "1Y";
export type MockScenario =
  | "healthy"
  | "empty-account"
  | "loss"
  | "no-buying-power"
  | "insufficient-quantity"
  | "market-closed"
  | "stale-quote"
  | "offline"
  | "reauth-required"
  | "request-failed"
  | "rate-limited"
  | "timeout"
  | "unknown"
  | "reconciliation-failed";

export type MockErrorCode =
  | "offline"
  | "reauth-required"
  | "request-failed"
  | "rate-limited"
  | "timeout"
  | "stale-quote"
  | "preview-expired"
  | "invalid-order"
  | "market-closed"
  | "insufficient-buying-power"
  | "insufficient-quantity"
  | "unknown-reconciliation";

export interface BrokerQuote {
  symbol: BrokerSymbol;
  companyEn: string;
  companyZh: string;
  price: Price;
  change: Price;
  changePct: Percent;
  asOf: string;
  status: DataStatus;
  source?: QuoteSourceKind;
  delayed?: boolean;
  provider?: string;
}

export interface BrokerHolding {
  symbol: BrokerSymbol;
  companyEn: string;
  companyZh: string;
  quantity: Quantity;
  availableQuantity: Quantity;
  averageCost: Price;
  marketValue: Money;
  dayPnl: Money;
  totalPnl: Money;
}

export interface BrokerAccount {
  accountKey: string;
  cash: Money;
  buyingPower: Money;
  totalEquity: Money;
  todayChange: Money;
  todayChangePct: Percent;
  allTimeChange: Money;
  asOf: string;
  status: DataStatus;
}

export interface BrokerOrderEvent {
  kind: "draft" | "preview" | "accepted" | "fill" | "canceled" | "rejected" | "unknown";
  at: string;
  detailEn: string;
  detailZh: string;
}

export interface BrokerOrder {
  id: string;
  symbol: BrokerSymbol;
  side: BrokerOrderSide;
  type: BrokerOrderType;
  quantity: Quantity;
  filledQuantity: Quantity;
  limitPrice: Price | null;
  status: BrokerOrderStatus;
  submittedAt: string;
  events: readonly BrokerOrderEvent[];
}

export interface BrokerHeatmapEntry {
  date: string;
  status: DataStatus;
  activityLevel: 0 | 1 | 2 | 3 | 4;
  actions: number;
  dailyReturnPct: Percent | null;
  dailyReturnUsd: Money | null;
}

export interface BrokerSnapshot {
  mode: BrokerMode;
  account: BrokerAccount;
  quotes: readonly BrokerQuote[];
  holdings: readonly BrokerHolding[];
  orders: readonly BrokerOrder[];
  portfolioChart: Record<BrokerPortfolioPeriod, readonly Money[]>;
  heatmap: readonly BrokerHeatmapEntry[];
  activeDays: number;
  ordersFilled: number;
  yearNetChange: Money;
}

export interface OrderDraft {
  symbol: BrokerSymbol;
  side: BrokerOrderSide;
  type: BrokerOrderType;
  quantity: Quantity;
  limitPrice: Price | null;
}

export interface MockPreview {
  previewId: string;
  draftHash: string;
  draft: OrderDraft;
  quote: BrokerQuote;
  estimatedAmount: Money;
  createdAt: string;
  expiresAt: string;
  status: "preview" | "consumed" | "invalidated";
}

export interface BrokerCapabilities {
  readQuotes: boolean;
  readAccount: boolean;
  readHoldings: boolean;
  readOrders: boolean;
  previewOrders: boolean;
  submitOrders: boolean;
  cancelOrders: boolean;
  replaceOrders: boolean;
}

export interface BrokerAdapter {
  readonly id: string;
  readonly mode: BrokerMode;
  readonly capabilities: BrokerCapabilities;
  getSnapshot(): BrokerSnapshot;
  subscribe(listener: () => void): () => void;
  previewOrder(draft: OrderDraft): MockPreview;
  consumePreview(previewId: string, draftHash: string): BrokerOrder;
}
