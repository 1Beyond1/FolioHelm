import {
  decimal,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMultiply,
  decimalRound,
  decimalSubtract,
  decimalToFixed,
  money,
  percent,
  price,
  quantity,
  type Money,
  type Percent,
  type Price,
  type Quantity,
} from "./decimal";
import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerCapabilities,
  BrokerHolding,
  BrokerOrder,
  BrokerOrderEvent,
  BrokerQuote,
  BrokerSnapshot,
  CurrencySummary,
  MockErrorCode,
  MockScenario,
  MockPreview,
  OrderDraft,
  WorkspaceMode,
} from "./contracts";
import type { ImportedPortfolioSnapshot } from "./csvImport";
import {
  aggregatePortfolioSnapshots,
  ALL_ACCOUNTS_ID,
  DEFAULT_ACCOUNT_ID,
} from "./accountAggregation";

const brokerResetHooks = new Set<() => void>();

/**
 * Registers an optional teardown callback invoked by `MOCK_BROKER.reset()`
 * (test harness only) so dependent runtime stores can clear state without
 * forcing `mockBroker.ts` or `src/test/setup.ts` to import Tauri IPC modules.
 */
export function registerBrokerResetHook(hook: () => void): () => void {
  brokerResetHooks.add(hook);
  return () => brokerResetHooks.delete(hook);
}

export interface LocalPortfolioMeta {
  id: string;
  fingerprint: string;
  sourceFormat: string;
  sourceLabel: string;
  importedAtUtc: string;
  currency: string;
  currencies: readonly string[];
  isMultiCurrency: boolean;
  holdingsCount: number;
  transactionsCount: number;
  warnings: readonly string[];
}

export interface PublicQuoteUpdate {
  symbol: string;
  price: string;
  change: string;
  changePct: string;
  currency?: string;
  asOfUtc: string;
  provider: string;
  delayed: boolean;
}

const AS_OF = "2026-08-10T16:00:00Z";
const PREVIEW_EXPIRY_MS = 60_000;
const ZERO_PRICE = price("0");
const ZERO_MONEY = money("0");
const ZERO_QUANTITY = quantity("0");
const HUNDRED = decimal("100");
const LOSS_PRICE_FACTOR = decimal("0.84");
const LOSS_DAY_DROP_RATE = decimal("-0.018");

const capabilities: BrokerCapabilities = {
  readQuotes: true,
  readAccount: true,
  readHoldings: true,
  readOrders: true,
  previewOrders: true,
  submitOrders: false,
  cancelOrders: false,
  replaceOrders: false,
};

export class MockBrokerError extends Error {
  readonly code: MockErrorCode;

  constructor(code: MockErrorCode, message: string) {
    super(message);
    this.name = "MockBrokerError";
    this.code = code;
  }
}

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "healthy",
  "empty-account",
  "loss",
  "no-buying-power",
  "insufficient-quantity",
  "market-closed",
  "stale-quote",
  "offline",
  "reauth-required",
  "request-failed",
  "rate-limited",
  "timeout",
  "unknown",
  "reconciliation-failed",
];

function deriveChangePct(currentPrice: Price, dailyChange: Price): Percent {
  const previousClose = decimalSubtract(currentPrice, dailyChange);
  if (decimalCompare(previousClose, ZERO_PRICE) <= 0) return percent("0");
  return decimalDivide(decimalMultiply(dailyChange, HUNDRED), previousClose, 2, "half-even") as Percent;
}

const quote = (
  symbol: BrokerQuote["symbol"],
  companyEn: string,
  companyZh: string,
  currentPrice: string,
  change: string,
): BrokerQuote => {
  const parsedPrice = price(currentPrice);
  const parsedChange = price(change);
  return {
    symbol,
    companyEn,
    companyZh,
    price: parsedPrice,
    change: parsedChange,
    changePct: deriveChangePct(parsedPrice, parsedChange),
    asOf: AS_OF,
    status: "available",
  };
};

const QUOTES: readonly BrokerQuote[] = [
  quote("AAPL", "Apple Inc.", "苹果公司", "226.34", "2.68"),
  quote("NVDA", "NVIDIA Corporation", "英伟达", "118.40", "-0.74"),
  quote("MSFT", "Microsoft Corporation", "微软", "412.55", "1.90"),
  quote("SPY", "SPDR S&P 500 ETF", "标普 500 ETF", "542.18", "1.14"),
  quote("TSLA", "Tesla, Inc.", "特斯拉", "241.73", "-2.54"),
  quote("AMD", "Advanced Micro Devices", "超威半导体", "168.44", "1.94"),
  quote("AMZN", "Amazon.com, Inc.", "亚马逊", "181.27", "-1.12"),
];

interface HoldingSeed {
  symbol: BrokerHolding["symbol"];
  companyEn: string;
  companyZh: string;
  quantity: Quantity;
  availableQuantity: Quantity;
  averageCost: Price;
  currency?: string;
}

function holdingSeed(
  symbol: BrokerHolding["symbol"],
  companyEn: string,
  companyZh: string,
  quantityValue: string,
  averageCost: string,
  currency = "USD",
): HoldingSeed {
  const parsedQty = quantity(quantityValue);
  return {
    symbol,
    companyEn,
    companyZh,
    quantity: parsedQty,
    availableQuantity: parsedQty,
    averageCost: price(averageCost),
    currency,
  };
}

function symbolCurrencyKey(symbol: string, currency = "USD"): string {
  return `${symbol.toUpperCase()}|${(currency || "USD").toUpperCase()}`;
}

function matchQuote(
  quotes: readonly BrokerQuote[],
  symbol: string,
  currency?: string,
): BrokerQuote | undefined {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedCurrency = currency?.trim().toUpperCase();
  if (normalizedCurrency && normalizedCurrency !== "MULTI") {
    return quotes.find(
      (item) =>
        item.symbol.toUpperCase() === normalizedSymbol
        && (item.currency ?? "USD").toUpperCase() === normalizedCurrency,
    );
  }
  return quotes.find((item) => item.symbol.toUpperCase() === normalizedSymbol);
}

function matchHolding(
  holdings: readonly BrokerHolding[],
  symbol: string,
  currency?: string,
): BrokerHolding | undefined {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedCurrency = currency?.trim().toUpperCase();
  if (normalizedCurrency && normalizedCurrency !== "MULTI") {
    return holdings.find(
      (item) =>
        item.symbol.toUpperCase() === normalizedSymbol
        && (item.currency ?? "USD").toUpperCase() === normalizedCurrency,
    );
  }
  return holdings.find((item) => item.symbol.toUpperCase() === normalizedSymbol);
}

function deriveHoldings(
  seeds: readonly HoldingSeed[],
  quotes: readonly BrokerQuote[],
): BrokerHolding[] {
  const quoteByKey = new Map(
    quotes.map((item) => [symbolCurrencyKey(item.symbol, item.currency), item]),
  );
  const quoteBySymbol = new Map<string, BrokerQuote>();
  for (const item of quotes) {
    if (!quoteBySymbol.has(item.symbol)) quoteBySymbol.set(item.symbol, item);
  }
  return seeds.map((seed) => {
    const seedCurrency = seed.currency ?? "USD";
    const exactQuote = quoteByKey.get(symbolCurrencyKey(seed.symbol, seedCurrency));
    const fallbackQuote = quoteBySymbol.get(seed.symbol);
    const matchedQuote = exactQuote
      ?? (fallbackQuote && (!fallbackQuote.currency || fallbackQuote.currency === seedCurrency)
        ? fallbackQuote
        : undefined);
    const currentPrice = matchedQuote?.price ?? seed.averageCost;
    const dailyChange = matchedQuote?.change ?? ZERO_PRICE;
    const marketValue = decimalRound(decimalMultiply(currentPrice, seed.quantity), 2, "half-even") as Money;
    const dayPnl = decimalRound(decimalMultiply(dailyChange, seed.quantity), 2, "half-even") as Money;
    const totalPnl = decimalRound(
      decimalMultiply(decimalSubtract(currentPrice, seed.averageCost), seed.quantity),
      2,
      "half-even",
    ) as Money;
    return {
      symbol: seed.symbol,
      companyEn: seed.companyEn,
      companyZh: seed.companyZh,
      quantity: seed.quantity,
      availableQuantity: seed.availableQuantity,
      averageCost: seed.averageCost,
      marketValue,
      dayPnl,
      totalPnl,
      currency: seed.currency ?? matchedQuote?.currency ?? "USD",
    };
  });
}

function deriveAccountSummary(
  baseAccount: BrokerAccount,
  holdings: readonly BrokerHolding[],
): BrokerAccount {
  const holdingsValue = holdings.reduce<Money>(
    (total, item) => decimalAdd(total, item.marketValue) as Money,
    ZERO_MONEY,
  );
  const totalEquity = decimalAdd(holdingsValue, baseAccount.cash) as Money;
  const todayChange = holdings.reduce<Money>(
    (total, item) => decimalAdd(total, item.dayPnl) as Money,
    ZERO_MONEY,
  );
  const previousEquity = decimalSubtract(totalEquity, todayChange);
  const todayChangePct = decimalCompare(previousEquity, ZERO_PRICE) > 0
    ? decimalDivide(decimalMultiply(todayChange, HUNDRED), previousEquity, 2, "half-even") as Percent
    : percent("0");
  const allTimeChange = holdings.reduce<Money>(
    (total, item) => decimalAdd(total, item.totalPnl) as Money,
    ZERO_MONEY,
  );
  return {
    ...baseAccount,
    totalEquity,
    todayChange,
    todayChangePct,
    allTimeChange,
  };
}

const BASE_HOLDING_SEEDS: readonly HoldingSeed[] = [
  holdingSeed("AAPL", "Apple Inc.", "苹果公司", "100", "213.84"),
  holdingSeed("NVDA", "NVIDIA Corporation", "英伟达", "50", "120.50"),
  holdingSeed("SPY", "SPDR S&P 500 ETF", "标普 500 ETF", "200", "468.18"),
  holdingSeed("MSFT", "Microsoft Corporation", "微软", "28", "372.55"),
];

const HOLDINGS: readonly BrokerHolding[] = deriveHoldings(BASE_HOLDING_SEEDS, QUOTES);

const orderEvent = (
  kind: BrokerOrderEvent["kind"],
  at: string,
  detailEn: string,
  detailZh: string,
): BrokerOrderEvent => ({ kind, at, detailEn, detailZh });

const ORDERS: readonly BrokerOrder[] = [
  {
    id: "ORD-1048",
    symbol: "NVDA",
    side: "buy",
    type: "limit",
    quantity: quantity("12"),
    filledQuantity: quantity("0"),
    limitPrice: price("118.00"),
    status: "working",
    submittedAt: "2026-08-10T09:42:00Z",
    events: [
      orderEvent("draft", "2026-08-10T09:41:48Z", "Created from the mock trade ticket", "从模拟交易单创建"),
      orderEvent("preview", "2026-08-10T09:41:55Z", "Estimated cost and buying power checked", "已检查预计金额和购买力"),
      orderEvent("accepted", "2026-08-10T09:42:01Z", "Accepted by the mock venue", "模拟交易场所已接受"),
    ],
  },
  {
    id: "ORD-1044",
    symbol: "AAPL",
    side: "sell",
    type: "market",
    quantity: quantity("8"),
    filledQuantity: quantity("8"),
    limitPrice: null,
    status: "filled",
    submittedAt: "2026-08-09T14:16:00Z",
    events: [
      orderEvent("draft", "2026-08-09T14:15:12Z", "Created from the mock trade ticket", "从模拟交易单创建"),
      orderEvent("preview", "2026-08-09T14:15:18Z", "Estimated cost and buying power checked", "已检查预计金额和购买力"),
      orderEvent("accepted", "2026-08-09T14:15:24Z", "Accepted by the mock venue", "模拟交易场所已接受"),
      orderEvent("fill", "2026-08-09T14:16:03Z", "8 shares filled at the mock quote", "按模拟报价成交 8 股"),
    ],
  },
  {
    id: "ORD-1042",
    symbol: "MSFT",
    side: "buy",
    type: "limit",
    quantity: quantity("4"),
    filledQuantity: quantity("4"),
    limitPrice: price("411.00"),
    status: "filled",
    submittedAt: "2026-08-09T11:07:00Z",
    events: [
      orderEvent("draft", "2026-08-09T11:06:41Z", "Created from the mock trade ticket", "从模拟交易单创建"),
      orderEvent("preview", "2026-08-09T11:06:49Z", "Estimated cost and buying power checked", "已检查预计金额和购买力"),
      orderEvent("accepted", "2026-08-09T11:06:55Z", "Accepted by the mock venue", "模拟交易场所已接受"),
      orderEvent("fill", "2026-08-09T11:07:22Z", "4 shares filled at the mock quote", "按模拟报价成交 4 股"),
    ],
  },
  {
    id: "ORD-1039",
    symbol: "TSLA",
    side: "buy",
    type: "limit",
    quantity: quantity("3"),
    filledQuantity: quantity("0"),
    limitPrice: price("240.00"),
    status: "canceled",
    submittedAt: "2026-08-08T16:32:00Z",
    events: [
      orderEvent("draft", "2026-08-08T16:31:08Z", "Created from the mock trade ticket", "从模拟交易单创建"),
      orderEvent("preview", "2026-08-08T16:31:16Z", "Estimated cost and buying power checked", "已检查预计金额和购买力"),
      orderEvent("accepted", "2026-08-08T16:31:24Z", "Accepted by the mock venue", "模拟交易场所已接受"),
      orderEvent("canceled", "2026-08-08T16:32:10Z", "Canceled in the mock ledger", "在模拟账本中撤销"),
    ],
  },
  {
    id: "ORD-1038",
    symbol: "SPY",
    side: "sell",
    type: "limit",
    quantity: quantity("5"),
    filledQuantity: quantity("0"),
    limitPrice: price("545.00"),
    status: "rejected",
    submittedAt: "2026-08-08T13:55:00Z",
    events: [
      orderEvent("draft", "2026-08-08T13:54:27Z", "Created from the mock trade ticket", "从模拟交易单创建"),
      orderEvent("preview", "2026-08-08T13:54:34Z", "Estimated cost and buying power checked", "已检查预计金额和购买力"),
      orderEvent("rejected", "2026-08-08T13:55:02Z", "Rejected in the mock ledger", "模拟账本拒绝了订单"),
    ],
  },
  {
    id: "ORD-1047",
    symbol: "AMD",
    side: "buy",
    type: "limit",
    quantity: quantity("6"),
    filledQuantity: quantity("0"),
    limitPrice: price("161.40"),
    status: "unknown",
    submittedAt: "2026-08-10T09:39:00Z",
    events: [
      orderEvent("draft", "2026-08-10T09:38:12Z", "Created from the mock trade ticket", "从模拟交易单创建"),
      orderEvent("preview", "2026-08-10T09:38:20Z", "Estimated cost and buying power checked", "已检查预计金额和购买力"),
      orderEvent("accepted", "2026-08-10T09:38:31Z", "Accepted by the mock venue", "模拟交易场所已接受"),
      orderEvent("unknown", "2026-08-10T09:39:04Z", "Mock venue acknowledgement is incomplete", "模拟交易场所确认信息不完整"),
    ],
  },
];

function createHeatmap(): BrokerSnapshot["heatmap"] {
  const start = new Date(Date.UTC(2026, 0, 1));
  const asOfDate = "2026-08-10";
  return Array.from({ length: 365 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(index + 1);
    const iso = date.toISOString().slice(0, 10);
    if (iso > asOfDate) {
      return { date: iso, status: "no-data", activityLevel: 0, actions: 0, dailyReturnPct: null, dailyReturnUsd: null };
    }

    const wave = Math.sin(index * 0.43) + Math.cos(index * 0.19);
    const level = index % 23 === 0 || index % 31 === 0 ? 4 : wave > 1.18 ? 3 : wave > 0.42 ? 2 : wave > -0.18 && index % 3 === 0 ? 1 : 0;
    const pct = ((index * 17) % 143) / 100 - 0.41;
    const dailyReturnPct = percent(pct.toFixed(2));
    const dailyReturnUsd = money((pct * 1175 + ((index % 7) - 3) * 2.5).toFixed(2));
    return {
      date: iso,
      status: "available",
      activityLevel: Math.min(4, level) as 0 | 1 | 2 | 3 | 4,
      actions: level === 0 ? 0 : Math.min(5, level + (index % 2)),
      dailyReturnPct,
      dailyReturnUsd,
    };
  });
}

const account: BrokerAccount = deriveAccountSummary(
  {
    accountKey: "demo-account-1234",
    cash: money("5320.00"),
    buyingPower: money("10983.40"),
    totalEquity: ZERO_MONEY,
    todayChange: ZERO_MONEY,
    todayChangePct: percent("0"),
    allTimeChange: ZERO_MONEY,
    asOf: AS_OF,
    status: "available",
  },
  HOLDINGS,
);

const BASE_SNAPSHOT: BrokerSnapshot = {
  mode: "mock",
  account,
  quotes: QUOTES,
  holdings: HOLDINGS,
  orders: ORDERS,
  portfolioChart: {
    "1D": ["152000.00", "152180.00", "152040.00", "152520.00", "152330.00", "152760.00", "152610.00", "153420.00", "153180.00", "153861.40"].map(money),
    "1W": ["149980.00", "150420.00", "150180.00", "151260.00", "151940.00", "151580.00", "152880.00", "153861.40"].map(money),
    "1M": ["146200.00", "145860.00", "147420.00", "146980.00", "149100.00", "148760.00", "151200.00", "150980.00", "152420.00", "153861.40"].map(money),
    "6M": ["132400.00", "136800.00", "135900.00", "140400.00", "144900.00", "147600.00", "149800.00", "152200.00", "153861.40"].map(money),
    "1Y": ["112400.00", "117200.00", "121800.00", "130800.00", "138500.00", "143800.00", "147600.00", "151100.00", "153861.40"].map(money),
  },
  heatmap: createHeatmap(),
  activeDays: 86,
  ordersFilled: 42,
  yearNetChange: account.allTimeChange,
};

function stableDraftHash(draft: OrderDraft): string {
  const base = [draft.symbol, draft.side, draft.type, draft.quantity, draft.limitPrice ?? "market"];
  if (draft.currency) base.push(draft.currency.trim().toUpperCase());
  if (draft.accountId) base.push(`acct=${draft.accountId.trim()}`);
  return base.join(":");
}

function nowValue(clock: () => number = () => Date.now()): { timestamp: number; iso: string } {
  const timestamp = clock();
  const date = new Date(timestamp);
  return Number.isFinite(timestamp) && Number.isFinite(date.getTime())
    ? { timestamp, iso: date.toISOString() }
    : { timestamp: Date.parse(AS_OF), iso: AS_OF };
}

function nowIso(clock: () => number = () => Date.now()): string {
  return nowValue(clock).iso;
}

function scenarioSnapshot(snapshot: BrokerSnapshot, scenario: MockScenario): BrokerSnapshot {
  if (
    scenario === "healthy"
    || scenario === "request-failed"
    || scenario === "rate-limited"
    || scenario === "timeout"
    || scenario === "unknown"
    || scenario === "reconciliation-failed"
    || scenario === "insufficient-quantity"
    || scenario === "no-buying-power"
  ) {
    if (scenario === "no-buying-power") {
      return {
        ...snapshot,
        account: deriveAccountSummary(
          { ...snapshot.account, cash: ZERO_MONEY, buyingPower: ZERO_MONEY, status: "available" },
          snapshot.holdings,
        ),
      };
    }
    return snapshot;
  }

  if (scenario === "empty-account") {
    const cashOnlyValue = money("25000.00");
    const portfolioChart: BrokerSnapshot["portfolioChart"] = {
      "1D": snapshot.portfolioChart["1D"].map(() => cashOnlyValue),
      "1W": snapshot.portfolioChart["1W"].map(() => cashOnlyValue),
      "1M": snapshot.portfolioChart["1M"].map(() => cashOnlyValue),
      "6M": snapshot.portfolioChart["6M"].map(() => cashOnlyValue),
      "1Y": snapshot.portfolioChart["1Y"].map(() => cashOnlyValue),
    };
    const heatmap = snapshot.heatmap.map((entry) => ({
      ...entry,
      status: "no-data" as const,
      activityLevel: 0 as const,
      actions: 0,
      dailyReturnPct: null,
      dailyReturnUsd: null,
    }));
    return {
      ...snapshot,
      account: {
        ...snapshot.account,
        cash: cashOnlyValue,
        buyingPower: cashOnlyValue,
        totalEquity: cashOnlyValue,
        todayChange: ZERO_MONEY,
        todayChangePct: percent("0"),
        allTimeChange: ZERO_MONEY,
      },
      holdings: [],
      orders: [],
      portfolioChart,
      heatmap,
      activeDays: 0,
      ordersFilled: 0,
      yearNetChange: ZERO_MONEY,
    };
  }

  if (scenario === "loss") {
    const lossQuotes: BrokerQuote[] = snapshot.quotes.map((item) => {
      const lossPrice = decimalRound(decimalMultiply(item.price, LOSS_PRICE_FACTOR), 2, "half-even") as Price;
      const lossChange = decimalRound(decimalMultiply(lossPrice, LOSS_DAY_DROP_RATE), 2, "half-even") as Price;
      return {
        ...item,
        price: lossPrice,
        change: lossChange,
        changePct: deriveChangePct(lossPrice, lossChange),
      };
    });
    const lossHoldings = deriveHoldings(snapshot.holdings, lossQuotes);
    const lossAccount = deriveAccountSummary(snapshot.account, lossHoldings);
    const reverseAndAnchor = (points: readonly Money[]): readonly Money[] => {
      const reversed = [...points].reverse();
      if (reversed.length === 0) return reversed;
      const offset = decimalSubtract(lossAccount.totalEquity, reversed[reversed.length - 1]!) as Money;
      return reversed.map((point) => decimalAdd(point, offset) as Money);
    };
    const portfolioChart: BrokerSnapshot["portfolioChart"] = {
      "1D": reverseAndAnchor(snapshot.portfolioChart["1D"]),
      "1W": reverseAndAnchor(snapshot.portfolioChart["1W"]),
      "1M": reverseAndAnchor(snapshot.portfolioChart["1M"]),
      "6M": reverseAndAnchor(snapshot.portfolioChart["6M"]),
      "1Y": reverseAndAnchor(snapshot.portfolioChart["1Y"]),
    };
    return {
      ...snapshot,
      quotes: lossQuotes,
      account: lossAccount,
      holdings: lossHoldings,
      portfolioChart,
      yearNetChange: lossAccount.allTimeChange,
    };
  }

  if (scenario === "market-closed") {
    return { ...snapshot, quotes: snapshot.quotes.map((item) => ({ ...item, status: "stale" as const })) };
  }

  if (scenario === "stale-quote") {
    return { ...snapshot, quotes: snapshot.quotes.map((item) => ({ ...item, status: "stale" as const })) };
  }

  if (scenario === "offline") {
    return {
      ...snapshot,
      account: { ...snapshot.account, status: "offline" },
      quotes: snapshot.quotes.map((item) => ({ ...item, status: "offline" as const })),
    };
  }

  return {
    ...snapshot,
    account: { ...snapshot.account, status: "reauth-required" },
    quotes: snapshot.quotes.map((item) => ({ ...item, status: "reauth-required" as const })),
  };
}

function scenarioError(scenario: MockScenario): MockBrokerError | undefined {
  switch (scenario) {
    case "offline": return new MockBrokerError("offline", "Mock data source is offline");
    case "reauth-required": return new MockBrokerError("reauth-required", "Mock session requires reauthorization");
    case "request-failed": return new MockBrokerError("request-failed", "Mock request failed deterministically");
    case "rate-limited": return new MockBrokerError("rate-limited", "Mock rate limit reached; no retry is scheduled");
    case "timeout": return new MockBrokerError("timeout", "Mock request timed out; outcome is not known");
    case "stale-quote": return new MockBrokerError("stale-quote", "Mock quote is stale; preview is blocked");
    case "market-closed": return new MockBrokerError("market-closed", "Mock regular session is closed");
    default: return undefined;
  }
}

function cloneSnapshot(snapshot: BrokerSnapshot): BrokerSnapshot {
  return {
    ...snapshot,
    account: {
      ...snapshot.account,
      currencyBreakdowns: snapshot.account.currencyBreakdowns?.map((item) => ({ ...item })),
    },
    quotes: snapshot.quotes.map((item) => ({ ...item })),
    holdings: snapshot.holdings.map((item) => ({ ...item })),
    orders: snapshot.orders.map((order) => ({
      ...order,
      events: order.events.map((event) => ({ ...event })),
    })),
    portfolioChart: {
      "1D": [...snapshot.portfolioChart["1D"]],
      "1W": [...snapshot.portfolioChart["1W"]],
      "1M": [...snapshot.portfolioChart["1M"]],
      "6M": [...snapshot.portfolioChart["6M"]],
      "1Y": [...snapshot.portfolioChart["1Y"]],
    },
    heatmap: snapshot.heatmap.map((entry) => ({ ...entry })),
  };
}

function clonePreview(preview: MockPreview): MockPreview {
  return {
    ...preview,
    draft: { ...preview.draft },
    quote: { ...preview.quote },
  };
}

function cloneOrder(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    events: order.events.map((event) => ({ ...event })),
  };
}

function buyingPowerForCurrency(account: BrokerAccount, currency: string): Money {
  if (account.isMultiCurrency && account.currencyBreakdowns) {
    const match = account.currencyBreakdowns.find((item) => item.currency === currency);
    return match ? match.buyingPower : ZERO_MONEY;
  }
  return account.buyingPower;
}

function deriveLocalCurrencies(imported: ImportedPortfolioSnapshot): string[] {
  if (imported.currencies && imported.currencies.length > 0) {
    return [...new Set(imported.currencies)].sort();
  }
  const set = new Set<string>();
  for (const h of imported.holdings) {
    if (h.currency) set.add(h.currency);
  }
  if (imported.cashByCurrency) {
    for (const [curr, amt] of Object.entries(imported.cashByCurrency)) {
      if (decimalCompare(money(amt), ZERO_MONEY) !== 0) set.add(curr);
    }
  }
  if (set.size === 0) {
    set.add(imported.currency && imported.currency !== "MULTI" ? imported.currency : "USD");
  }
  return [...set].sort();
}

function applyOpenOrderReservations(
  account: BrokerAccount,
  holdings: readonly BrokerHolding[],
  quotes: readonly BrokerQuote[],
  orders: readonly BrokerOrder[],
): { account: BrokerAccount; holdings: BrokerHolding[] } {
  let nextAccount: BrokerAccount = {
    ...account,
    currencyBreakdowns: account.currencyBreakdowns?.map((item) => ({ ...item })),
  };
  let nextHoldings: BrokerHolding[] = holdings.map((item) => ({ ...item }));

  for (const order of orders) {
    if (order.status !== "working" && order.status !== "unknown") continue;
    const openQty = decimalCompare(order.quantity, order.filledQuantity) > 0
      ? decimalSubtract(order.quantity, order.filledQuantity) as Quantity
      : ZERO_QUANTITY;
    if (decimalCompare(openQty, ZERO_QUANTITY) <= 0) continue;

    const matchedQuote = matchQuote(quotes, order.symbol, order.currency);
    const orderCurrency = order.currency ?? matchedQuote?.currency ?? nextAccount.currency ?? "USD";

    if (order.side === "buy") {
      const unitPrice = order.limitPrice ?? matchedQuote?.price ?? ZERO_PRICE;
      if (decimalCompare(unitPrice, ZERO_PRICE) <= 0) continue;
      const reserved = decimalRound(decimalMultiply(unitPrice, openQty), 2, "half-even") as Money;
      if (nextAccount.currencyBreakdowns) {
        nextAccount = {
          ...nextAccount,
          currencyBreakdowns: nextAccount.currencyBreakdowns.map((item) => {
            if (item.currency !== orderCurrency) return item;
            return {
              ...item,
              buyingPower: decimalCompare(item.buyingPower, reserved) > 0
                ? decimalSubtract(item.buyingPower, reserved) as Money
                : ZERO_MONEY,
            };
          }),
        };
      }
      if (!nextAccount.isMultiCurrency && orderCurrency === (nextAccount.currency ?? "USD")) {
        nextAccount = {
          ...nextAccount,
          buyingPower: decimalCompare(nextAccount.buyingPower, reserved) > 0
            ? decimalSubtract(nextAccount.buyingPower, reserved) as Money
            : ZERO_MONEY,
        };
      }
    } else if (order.side === "sell") {
      let matchedIndex = nextHoldings.findIndex(
        (item) => item.symbol === order.symbol && (item.currency ?? "USD") === orderCurrency,
      );
      if (matchedIndex === -1 && !order.currency) {
        matchedIndex = nextHoldings.findIndex((item) => item.symbol === order.symbol);
      }
      if (matchedIndex !== -1) {
        const target = nextHoldings[matchedIndex]!;
        const remaining = decimalCompare(target.availableQuantity, openQty) > 0
          ? decimalSubtract(target.availableQuantity, openQty) as Quantity
          : ZERO_QUANTITY;
        nextHoldings = nextHoldings.map((item, idx) =>
          idx === matchedIndex ? { ...item, availableQuantity: remaining } : item,
        );
      }
    }
  }

  return { account: nextAccount, holdings: nextHoldings };
}

function buildLocalSnapshotFromCsv(
  imported: ImportedPortfolioSnapshot,
  existingOrders: readonly BrokerOrder[] = [],
  publicQuoteMap?: ReadonlyMap<string, PublicQuoteUpdate>,
): BrokerSnapshot {
  const quotes: BrokerQuote[] = [];
  const seenSymbolCurrencies = new Set<string>();
  const seenSymbols = new Set<string>();

  for (const holding of imported.holdings) {
    const holdingCurr = holding.currency || "USD";
    const key = symbolCurrencyKey(holding.symbol, holdingCurr);
    if (seenSymbolCurrencies.has(key)) continue;
    seenSymbolCurrencies.add(key);
    seenSymbols.add(holding.symbol);

    const livePublic = publicQuoteMap?.get(holding.symbol);
    const usePublic = Boolean(
      livePublic && (!livePublic.currency || livePublic.currency === holdingCurr),
    );
    const unitPrice = price(usePublic && livePublic ? livePublic.price : holding.lastPrice);
    const dailyChange = price(usePublic && livePublic ? livePublic.change : "0");
    const changePct = usePublic && livePublic
      ? percent(livePublic.changePct)
      : deriveChangePct(unitPrice, dailyChange);
    quotes.push({
      symbol: holding.symbol,
      companyEn: holding.company || holding.symbol,
      companyZh: holding.company || holding.symbol,
      price: unitPrice,
      change: dailyChange,
      changePct,
      asOf: usePublic && livePublic ? livePublic.asOfUtc : imported.importedAtUtc,
      status: "available",
      currency: holdingCurr,
      source: usePublic ? "public-delayed" : "csv-import",
      delayed: usePublic && livePublic ? livePublic.delayed : true,
      provider: usePublic && livePublic ? livePublic.provider : imported.sourceFormat,
    });
  }

  // Keep cached public quotes for non-held symbols available without mixing fictional mock prices.
  for (const baseQuote of QUOTES) {
    if (!seenSymbols.has(baseQuote.symbol)) {
      const livePublic = publicQuoteMap?.get(baseQuote.symbol);
      if (livePublic) {
        quotes.push({
          ...baseQuote,
          price: price(livePublic.price),
          change: price(livePublic.change),
          changePct: percent(livePublic.changePct),
          asOf: livePublic.asOfUtc,
          status: "available",
          currency: livePublic.currency ?? "USD",
          source: "public-delayed",
          delayed: livePublic.delayed,
          provider: livePublic.provider,
        });
      }
    }
  }

  const holdingSeeds: HoldingSeed[] = imported.holdings.map((item) => ({
    symbol: item.symbol,
    companyEn: item.company || item.symbol,
    companyZh: item.company || item.symbol,
    quantity: quantity(item.quantity),
    availableQuantity: quantity(item.quantity),
    averageCost: price(item.averageCost),
    currency: item.currency || "USD",
  }));

  const rawHoldings = deriveHoldings(holdingSeeds, quotes);
  const currencies = deriveLocalCurrencies(imported);
  const isMultiCurrency = Boolean(imported.isMultiCurrency) || currencies.length > 1;

  const currencyBreakdowns: CurrencySummary[] = currencies.map((curr) => {
    const currHoldings = rawHoldings.filter((h) => (h.currency ?? "USD") === curr);
    const holdingsValue = currHoldings.reduce<Money>(
      (total, item) => decimalAdd(total, item.marketValue) as Money,
      ZERO_MONEY,
    );
    const dayPnl = currHoldings.reduce<Money>(
      (total, item) => decimalAdd(total, item.dayPnl) as Money,
      ZERO_MONEY,
    );
    const totalPnl = currHoldings.reduce<Money>(
      (total, item) => decimalAdd(total, item.totalPnl) as Money,
      ZERO_MONEY,
    );
    const rawCash = imported.cashByCurrency?.[curr]
      ?? (!isMultiCurrency && curr === imported.currency ? imported.cash : "0");
    const cash = money(rawCash);
    return {
      currency: curr,
      cash,
      buyingPower: cash,
      holdingsValue,
      totalEquity: decimalAdd(holdingsValue, cash) as Money,
      dayPnl,
      totalPnl,
      holdingsCount: currHoldings.length,
    };
  });

  const baseAccount: BrokerAccount = isMultiCurrency
    ? {
        accountKey: `local-csv-${imported.fingerprint.slice(0, 8)}`,
        // Fail-safe: never sum cross-currency balances into a combined total.
        cash: ZERO_MONEY,
        buyingPower: ZERO_MONEY,
        totalEquity: ZERO_MONEY,
        todayChange: ZERO_MONEY,
        todayChangePct: percent("0"),
        allTimeChange: ZERO_MONEY,
        asOf: imported.importedAtUtc,
        status: "available",
        currency: "MULTI",
        isMultiCurrency: true,
        currencyBreakdowns,
      }
    : deriveAccountSummary(
        {
          accountKey: `local-csv-${imported.fingerprint.slice(0, 8)}`,
          cash: currencyBreakdowns[0]?.cash ?? money(imported.cash),
          buyingPower: currencyBreakdowns[0]?.buyingPower ?? money(imported.cash),
          totalEquity: ZERO_MONEY,
          todayChange: ZERO_MONEY,
          todayChangePct: percent("0"),
          allTimeChange: ZERO_MONEY,
          asOf: imported.importedAtUtc,
          status: "available",
          currency: currencies[0] ?? "USD",
          isMultiCurrency: false,
          currencyBreakdowns,
        },
        rawHoldings,
      );

  // Replay open (`working` / `unknown`) paper orders so frozen buying power and locked sell
  // shares are preserved across quote toggles, quote refreshes, CSV reloads, and vault hydration.
  const { account, holdings } = applyOpenOrderReservations(
    baseAccount,
    rawHoldings,
    quotes,
    existingOrders,
  );

  // Use flat baseline points anchored to real imported total equity rather than fictional demo curves.
  const flatSeries = (len: number): readonly Money[] =>
    Array.from({ length: len }, () => account.totalEquity);
  const emptyHeatmap = BASE_SNAPSHOT.heatmap.map((entry) => ({
    ...entry,
    status: "no-data" as const,
    activityLevel: 0 as const,
    actions: 0,
    dailyReturnPct: null,
    dailyReturnUsd: null,
  }));

  return {
    mode: "local-csv",
    account,
    quotes,
    holdings,
    orders: [...existingOrders],
    portfolioChart: {
      "1D": flatSeries(10),
      "1W": flatSeries(8),
      "1M": flatSeries(10),
      "6M": flatSeries(9),
      "1Y": flatSeries(9),
    },
    heatmap: emptyHeatmap,
    activeDays: 0,
    ordersFilled: existingOrders.filter((o) => o.status === "filled").length,
    yearNetChange: account.allTimeChange,
  };
}

export class MockBroker implements BrokerAdapter {
  readonly id = "mock-broker";
  readonly capabilities = capabilities;
  private workspaceMode: WorkspaceMode = "mock";
  private snapshot: BrokerSnapshot = BASE_SNAPSHOT;
  private localImported: ImportedPortfolioSnapshot | null = null;
  private localAccountSnapshots = new Map<string, ImportedPortfolioSnapshot>();
  private selectedAccountId: string = ALL_ACCOUNTS_ID;
  private allLocalOrders: BrokerOrder[] = [];
  private localSnapshot: BrokerSnapshot | null = null;
  private localMeta: LocalPortfolioMeta | null = null;
  private publicQuotesEnabled = false;
  private publicQuotes = new Map<string, PublicQuoteUpdate>();
  private publicQuoteProvider: string | null = null;
  private publicQuoteLastUpdatedUtc: string | null = null;
  private readonly previews = new Map<string, MockPreview>();
  private readonly previewIssuedAt = new Map<string, number>();
  private readonly previewTargetAccounts = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private scenario: MockScenario = "healthy";

  constructor(private readonly clock: () => number = () => Date.now()) {}

  get mode(): WorkspaceMode {
    return this.workspaceMode;
  }

  getWorkspaceMode(): WorkspaceMode {
    return this.workspaceMode;
  }

  hasLocalPortfolio(): boolean {
    return this.localSnapshot !== null;
  }

  getLocalPortfolioMeta(): LocalPortfolioMeta | null {
    return this.localMeta ? { ...this.localMeta, warnings: [...this.localMeta.warnings] } : null;
  }

  isPublicQuotesEnabled(): boolean {
    return this.publicQuotesEnabled;
  }

  getPublicQuoteStatus(): {
    enabled: boolean;
    provider: string | null;
    lastUpdatedUtc: string | null;
    cachedCount: number;
  } {
    return {
      enabled: this.publicQuotesEnabled,
      provider: this.publicQuoteProvider,
      lastUpdatedUtc: this.publicQuoteLastUpdatedUtc,
      cachedCount: this.publicQuotes.size,
    };
  }

  setPublicQuotesEnabled(enabled: boolean): void {
    if (this.publicQuotesEnabled === enabled) return;
    this.publicQuotesEnabled = enabled;
    if (!enabled && this.localImported) {
      // Revert local portfolio quotes cleanly to CSV-imported baseline prices.
      this.localSnapshot = buildLocalSnapshotFromCsv(
        this.localImported,
        this.localSnapshot?.orders ?? [],
      );
    } else if (enabled && this.localImported && this.publicQuotes.size > 0) {
      this.localSnapshot = buildLocalSnapshotFromCsv(
        this.localImported,
        this.localSnapshot?.orders ?? [],
        this.publicQuotes,
      );
    }
    this.notify();
  }

  applyPublicQuotes(updates: readonly PublicQuoteUpdate[], provider?: string): void {
    if (updates.length === 0) return;
    let latestTs = this.publicQuoteLastUpdatedUtc;
    for (const item of updates) {
      this.publicQuotes.set(item.symbol.toUpperCase(), {
        ...item,
        symbol: item.symbol.toUpperCase(),
      });
      if (!latestTs || item.asOfUtc > latestTs) latestTs = item.asOfUtc;
    }
    this.publicQuoteProvider = provider ?? updates[0]?.provider ?? this.publicQuoteProvider;
    this.publicQuoteLastUpdatedUtc = latestTs;

    if (this.publicQuotesEnabled && this.localImported) {
      this.localSnapshot = buildLocalSnapshotFromCsv(
        this.localImported,
        this.localSnapshot?.orders ?? [],
        this.publicQuotes,
      );
    }
    this.notify();
  }

  replacePublicQuotes(updates: readonly PublicQuoteUpdate[], provider?: string): void {
    this.publicQuotes.clear();
    let latestTs: string | null = null;
    for (const item of updates) {
      this.publicQuotes.set(item.symbol.toUpperCase(), {
        ...item,
        symbol: item.symbol.toUpperCase(),
      });
      if (!latestTs || item.asOfUtc > latestTs) latestTs = item.asOfUtc;
    }
    this.publicQuoteProvider = updates.length > 0
      ? (provider ?? updates[0]?.provider ?? null)
      : null;
    this.publicQuoteLastUpdatedUtc = latestTs;

    if (this.localImported) {
      this.localSnapshot = buildLocalSnapshotFromCsv(
        this.localImported,
        this.localSnapshot?.orders ?? [],
        this.publicQuotesEnabled && this.publicQuotes.size > 0 ? this.publicQuotes : undefined,
      );
    }
    this.notify();
  }

  private clearPreviews(): void {
    this.previews.clear();
    this.previewIssuedAt.clear();
    this.previewTargetAccounts.clear();
  }

  setWorkspaceMode(mode: WorkspaceMode): void {
    if (mode === "local-csv" && !this.localSnapshot) return;
    if (this.workspaceMode === mode) return;
    this.workspaceMode = mode;
    this.clearPreviews();
    this.notify();
  }

  getSelectedAccountId(): string {
    return this.selectedAccountId;
  }

  getLocalAccountIds(): string[] {
    return [...this.localAccountSnapshots.keys()].sort();
  }

  /**
   * Returns an isolated single-account `BrokerSnapshot` (strictly rejecting `"ALL"`).
   * Used by paper-trading validation, execution, NAV snapshots, and quote refreshes so
   * aggregated multi-account snapshots are NEVER treated as a single account.
   */
  getAccountSnapshot(accountId: string): BrokerSnapshot {
    if (this.workspaceMode !== "local-csv") {
      return this.getSnapshot();
    }
    const trimmed = accountId.trim();
    if (!trimmed || trimmed.toUpperCase() === ALL_ACCOUNTS_ID) {
      throw new MockBrokerError(
        "invalid-order",
        "A concrete target account ID is required for single-account operations",
      );
    }
    const exact = this.localAccountSnapshots.get(trimmed);
    const imported: ImportedPortfolioSnapshot = exact ?? {
      id: `empty-${trimmed}`,
      accountId: trimmed,
      fingerprint: `empty-${trimmed}`,
      sourceFormat: "empty_account",
      sourceLabel: "No CSV imported yet",
      importedAtUtc: new Date().toISOString(),
      accountLabel: trimmed,
      currency: "USD",
      cash: "0.00",
      cashByCurrency: { USD: "0.00" },
      currencies: ["USD"],
      isMultiCurrency: false,
      holdings: [],
      transactions: [],
      warnings: [],
    };
    const scopedOrders = this.allLocalOrders.filter(
      (order) => (order.accountId ?? DEFAULT_ACCOUNT_ID) === trimmed,
    );
    return cloneSnapshot(
      buildLocalSnapshotFromCsv(
        imported,
        scopedOrders,
        this.publicQuotesEnabled && this.publicQuotes.size > 0 ? this.publicQuotes : undefined,
      ),
    );
  }

  private resolveOrderTargetAccountId(draftAccountId?: string): string {
    if (draftAccountId !== undefined) {
      const trimmed = draftAccountId.trim();
      if (!trimmed || trimmed.toUpperCase() === ALL_ACCOUNTS_ID) {
        throw new MockBrokerError(
          "invalid-order",
          "A concrete target account must be selected for paper trading",
        );
      }
      return trimmed;
    }
    if (this.selectedAccountId !== ALL_ACCOUNTS_ID) {
      return this.selectedAccountId;
    }
    if (this.localAccountSnapshots.size === 1) {
      return [...this.localAccountSnapshots.keys()][0]!;
    }
    throw new MockBrokerError(
      "invalid-order",
      "Select a specific target account before placing a paper order across multiple accounts",
    );
  }

  setSelectedAccountId(accountId: string): void {
    const normalized = accountId.trim() || ALL_ACCOUNTS_ID;
    if (this.selectedAccountId === normalized) return;
    this.selectedAccountId = normalized;
    if (this.localAccountSnapshots.size > 0) {
      this.rebuildActiveLocalSnapshot();
    }
    this.clearPreviews();
    this.notify();
  }

  removeLocalAccount(accountId: string): void {
    const trimmed = accountId.trim();
    if (!trimmed || trimmed === DEFAULT_ACCOUNT_ID || trimmed.toUpperCase() === ALL_ACCOUNTS_ID) {
      return;
    }
    const removedSnap = this.localAccountSnapshots.delete(trimmed);
    const prevOrderCount = this.allLocalOrders.length;
    this.allLocalOrders = this.allLocalOrders.filter(
      (order) => (order.accountId ?? DEFAULT_ACCOUNT_ID) !== trimmed,
    );
    const removedOrders = this.allLocalOrders.length !== prevOrderCount;
    if (this.selectedAccountId === trimmed) {
      this.selectedAccountId = ALL_ACCOUNTS_ID;
    }
    if (!removedSnap && !removedOrders) {
      return;
    }
    this.rebuildActiveLocalSnapshot();
    if (!this.localSnapshot) {
      this.workspaceMode = "mock";
    }
    this.clearPreviews();
    this.notify();
  }

  private filterOrdersForActiveAccount(orders: readonly BrokerOrder[]): BrokerOrder[] {
    if (this.selectedAccountId === ALL_ACCOUNTS_ID) {
      return [...orders];
    }
    return orders.filter((order) => (order.accountId ?? DEFAULT_ACCOUNT_ID) === this.selectedAccountId);
  }

  private resolveEffectiveLocalImported(): ImportedPortfolioSnapshot | null {
    if (this.localAccountSnapshots.size === 0) return null;
    if (this.selectedAccountId === ALL_ACCOUNTS_ID) {
      return aggregatePortfolioSnapshots([...this.localAccountSnapshots.values()]);
    }
    const exact = this.localAccountSnapshots.get(this.selectedAccountId);
    if (exact) return exact;
    return {
      id: `empty-${this.selectedAccountId}`,
      accountId: this.selectedAccountId,
      fingerprint: `empty-${this.selectedAccountId}`,
      sourceFormat: "empty_account",
      sourceLabel: "No CSV imported yet",
      importedAtUtc: new Date().toISOString(),
      accountLabel: this.selectedAccountId,
      currency: "USD",
      cash: "0.00",
      cashByCurrency: { USD: "0.00" },
      currencies: ["USD"],
      isMultiCurrency: false,
      holdings: [],
      transactions: [],
      warnings: [],
    };
  }

  private rebuildActiveLocalSnapshot(): void {
    const effective = this.resolveEffectiveLocalImported();
    if (!effective) {
      this.localImported = null;
      this.localMeta = null;
      this.localSnapshot = null;
      return;
    }
    const currencies = deriveLocalCurrencies(effective);
    const isMultiCurrency = Boolean(effective.isMultiCurrency) || currencies.length > 1;
    this.localImported = effective;
    this.localMeta = {
      id: effective.id,
      fingerprint: effective.fingerprint,
      sourceFormat: effective.sourceFormat,
      sourceLabel: effective.sourceLabel,
      importedAtUtc: effective.importedAtUtc,
      currency: isMultiCurrency ? "MULTI" : (currencies[0] ?? effective.currency ?? "USD"),
      currencies,
      isMultiCurrency,
      holdingsCount: effective.holdings.length,
      transactionsCount: effective.transactions.length,
      warnings: [...effective.warnings],
    };
    const scopedOrders = this.filterOrdersForActiveAccount(this.allLocalOrders);
    this.localSnapshot = buildLocalSnapshotFromCsv(
      effective,
      scopedOrders,
      this.publicQuotesEnabled && this.publicQuotes.size > 0 ? this.publicQuotes : undefined,
    );
  }

  applyAccountPortfolioSnapshots(
    snapshots: readonly ImportedPortfolioSnapshot[],
    options: { switchMode?: boolean; resetOrders?: boolean; selectedAccountId?: string } = {},
  ): void {
    this.localAccountSnapshots.clear();
    for (const snap of snapshots) {
      const acctId = snap.accountId?.trim() || DEFAULT_ACCOUNT_ID;
      this.localAccountSnapshots.set(acctId, { ...snap, accountId: acctId });
    }
    if (options.resetOrders) {
      this.allLocalOrders = [];
    }
    if (options.selectedAccountId) {
      this.selectedAccountId = options.selectedAccountId;
    } else if (
      this.selectedAccountId !== ALL_ACCOUNTS_ID
      && !this.localAccountSnapshots.has(this.selectedAccountId)
    ) {
      this.selectedAccountId = ALL_ACCOUNTS_ID;
    }

    this.rebuildActiveLocalSnapshot();
    if (this.localSnapshot && options.switchMode !== false) {
      this.workspaceMode = "local-csv";
    } else if (!this.localSnapshot) {
      this.workspaceMode = "mock";
    }
    this.clearPreviews();
    this.notify();
  }

  applyLocalPortfolioSnapshot(
    imported: ImportedPortfolioSnapshot,
    options: { switchMode?: boolean; resetOrders?: boolean; selectAccount?: boolean } = {},
  ): void {
    const acctId = imported.accountId?.trim() || DEFAULT_ACCOUNT_ID;
    this.localAccountSnapshots.set(acctId, { ...imported, accountId: acctId });
    if (options.resetOrders) {
      this.allLocalOrders = [];
    }
    if (options.selectAccount) {
      this.selectedAccountId = acctId;
    }
    this.rebuildActiveLocalSnapshot();
    if (options.switchMode !== false) {
      this.workspaceMode = "local-csv";
    }
    this.clearPreviews();
    this.notify();
  }

  hydratePaperOrders(
    mode: WorkspaceMode,
    persistedOrders: readonly BrokerOrder[],
    options: { replace?: boolean } = {},
  ): void {
    const replace = options.replace === true;
    if (!replace && persistedOrders.length === 0) return;

    if (replace) {
      this.sequence = 0;
    }
    for (const order of persistedOrders) {
      const match = /^(?:PAPER|MOCK)-ORDER-(\d+)$/.exec(order.id);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isSafeInteger(parsed) && parsed > this.sequence) {
          this.sequence = parsed;
        }
      }
    }

    const mergeOrders = (existing: readonly BrokerOrder[]): BrokerOrder[] => {
      const byId = new Map<string, BrokerOrder>();
      for (const order of persistedOrders) byId.set(order.id, cloneOrder(order));
      for (const order of existing) {
        if (!byId.has(order.id)) byId.set(order.id, cloneOrder(order));
      }
      return [...byId.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    };

    if (mode === "local-csv") {
      if (!this.localSnapshot) return;
      const nextOrders = replace
        ? [...persistedOrders].map(cloneOrder).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        : mergeOrders(this.allLocalOrders);
      this.allLocalOrders = nextOrders;
      this.rebuildActiveLocalSnapshot();
    } else {
      // When replacing (e.g. after .fhvault restore), drop all pre-restore mock orders
      // and keep only the immutable demo baseline plus orders present in the restored vault.
      const baseOrders = replace ? BASE_SNAPSHOT.orders : this.snapshot.orders;
      const nextOrders = mergeOrders(baseOrders);
      const baseTarget = replace ? BASE_SNAPSHOT : this.snapshot;
      const baseOrderIds = new Set(BASE_SNAPSHOT.orders.map((o) => o.id));
      const extraOpenOrders = replace
        ? nextOrders.filter((o) => !baseOrderIds.has(o.id))
        : persistedOrders.filter((o) => !this.snapshot.orders.some((existing) => existing.id === o.id));
      const reserved = applyOpenOrderReservations(
        baseTarget.account,
        baseTarget.holdings,
        baseTarget.quotes,
        extraOpenOrders,
      );
      this.snapshot = {
        ...baseTarget,
        account: reserved.account,
        holdings: reserved.holdings,
        orders: nextOrders,
        ordersFilled: nextOrders.filter((o) => o.status === "filled").length,
      };
    }
    this.notify();
  }

  /**
   * Immediately wipes all sensitive user portfolio, quote cache, order preview, and paper ledger
   * data from the frontend JavaScript heap (invoked on App Lock and fail-closed vault lock).
   */
  purgeSensitiveMemory(): void {
    this.workspaceMode = "mock";
    this.snapshot = BASE_SNAPSHOT;
    this.localImported = null;
    this.localAccountSnapshots.clear();
    this.selectedAccountId = ALL_ACCOUNTS_ID;
    this.allLocalOrders = [];
    this.localSnapshot = null;
    this.localMeta = null;
    this.publicQuotesEnabled = false;
    this.publicQuotes.clear();
    this.publicQuoteProvider = null;
    this.publicQuoteLastUpdatedUtc = null;
    this.clearPreviews();
    this.sequence = 0;
    this.notify();
  }

  clearLocalPortfolio(): void {
    this.localImported = null;
    this.localAccountSnapshots.clear();
    this.selectedAccountId = ALL_ACCOUNTS_ID;
    this.allLocalOrders = [];
    this.localSnapshot = null;
    this.localMeta = null;
    this.workspaceMode = "mock";
    this.clearPreviews();
    this.notify();
  }

  getSnapshot(): BrokerSnapshot {
    if (this.workspaceMode === "local-csv" && this.localSnapshot) {
      return cloneSnapshot(this.localSnapshot);
    }
    const base = scenarioSnapshot(this.snapshot, this.scenario);
    if (this.publicQuotesEnabled && this.publicQuotes.size > 0 && this.scenario === "healthy") {
      const updatedQuotes = base.quotes.map((item) => {
        const live = this.publicQuotes.get(item.symbol);
        if (!live) return item;
        return {
          ...item,
          price: price(live.price),
          change: price(live.change),
          changePct: percent(live.changePct),
          asOf: live.asOfUtc,
          source: "public-delayed" as const,
          delayed: live.delayed,
          provider: live.provider,
        };
      });
      const updatedHoldings = deriveHoldings(base.holdings, updatedQuotes);
      const updatedAccount = deriveAccountSummary(base.account, updatedHoldings);
      return cloneSnapshot({
        ...base,
        quotes: updatedQuotes,
        holdings: updatedHoldings,
        account: updatedAccount,
        yearNetChange: updatedAccount.allTimeChange,
      });
    }
    return cloneSnapshot(base);
  }

  getScenario(): MockScenario {
    return this.scenario;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Observers refresh UI only; a broken observer must not turn a
        // completed local ledger mutation into a reported order failure.
      }
    }
  }

  setScenario(scenario: MockScenario): void {
    if (this.scenario === scenario) return;
    this.scenario = scenario;
    this.notify();
  }

  reset(): void {
    this.workspaceMode = "mock";
    this.snapshot = BASE_SNAPSHOT;
    this.localImported = null;
    this.localAccountSnapshots.clear();
    this.selectedAccountId = ALL_ACCOUNTS_ID;
    this.allLocalOrders = [];
    this.localSnapshot = null;
    this.localMeta = null;
    this.publicQuotesEnabled = false;
    this.publicQuotes.clear();
    this.publicQuoteProvider = null;
    this.publicQuoteLastUpdatedUtc = null;
    this.clearPreviews();
    this.sequence = 0;
    this.scenario = "healthy";
    for (const hook of brokerResetHooks) {
      hook();
    }
    this.notify();
  }

  previewOrder(draft: OrderDraft): MockPreview {
    const fault = this.workspaceMode === "mock" ? scenarioError(this.scenario) : undefined;
    if (fault) throw fault;

    try {
      const validSide = draft.side === "buy" || draft.side === "sell";
      const validType = draft.type === "market" || draft.type === "limit";
      const validQuantity = decimalCompare(draft.quantity, ZERO_QUANTITY) > 0;
      const validLimit = draft.limitPrice === null || decimalCompare(draft.limitPrice, ZERO_PRICE) > 0;
      const typeMatchesPrice = draft.type === "market" ? draft.limitPrice === null : draft.limitPrice !== null;
      if (!validSide || !validType || !validQuantity || !validLimit || !typeMatchesPrice) {
        throw new MockBrokerError("invalid-order", "Mock order input is invalid; preview was blocked");
      }
    } catch (error) {
      if (error instanceof MockBrokerError) throw error;
      throw new MockBrokerError("invalid-order", "Mock order input is invalid; preview was blocked");
    }

    const isLocalMode = this.workspaceMode === "local-csv" && this.localSnapshot !== null;
    const targetAccountId = isLocalMode
      ? this.resolveOrderTargetAccountId(draft.accountId)
      : undefined;
    const snapshot = isLocalMode && targetAccountId
      ? this.getAccountSnapshot(targetAccountId)
      : this.getSnapshot();
    const matchedQuote = matchQuote(snapshot.quotes, draft.symbol, draft.currency);
    if (!matchedQuote) throw new Error(`No mock quote for ${draft.symbol}`);
    if (matchedQuote.status !== "available") {
      throw new MockBrokerError("stale-quote", "Mock quote is not fresh enough for a preview");
    }

    const unitPrice = draft.limitPrice ?? matchedQuote.price;
    const quoteCurrency = (matchedQuote.currency ?? draft.currency ?? "USD").toUpperCase();
    const availableBuyingPower = buyingPowerForCurrency(snapshot.account, quoteCurrency);
    const estimatedAmount = decimalRound(decimalMultiply(unitPrice, draft.quantity), 2, "half-even") as Money;
    if (draft.side === "buy" && decimalCompare(estimatedAmount, availableBuyingPower) > 0) {
      throw new MockBrokerError("insufficient-buying-power", "Mock buying power is insufficient");
    }
    if (draft.side === "sell") {
      if (this.workspaceMode === "mock" && this.scenario === "insufficient-quantity") {
        throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
      }
      const matchedHolding = matchHolding(snapshot.holdings, draft.symbol, quoteCurrency);
      if (!matchedHolding || decimalCompare(draft.quantity, matchedHolding.availableQuantity) > 0) {
        throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
      }
    }
    const draftHash = stableDraftHash(draft);
    const previewId = `MOCK-PREVIEW-${draft.symbol}-${++this.sequence}`;
    // Read the injected clock once so the displayed creation time and the
    // internal expiry anchor describe the same instant.
    const created = nowValue(this.clock);
    const createdAt = created.iso;
    const preview: MockPreview = {
      previewId,
      draftHash,
      draft: { ...draft },
      ...(targetAccountId ? { accountId: targetAccountId } : {}),
      quote: matchedQuote,
      estimatedAmount,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + PREVIEW_EXPIRY_MS).toISOString(),
      status: "preview",
    };
    this.previews.set(previewId, preview);
    this.previewIssuedAt.set(previewId, created.timestamp);
    if (targetAccountId) {
      this.previewTargetAccounts.set(previewId, targetAccountId);
    }
    return clonePreview(preview);
  }

  consumePreview(previewId: string, draftHash: string): BrokerOrder {
    const fault = this.workspaceMode === "mock" ? scenarioError(this.scenario) : undefined;
    if (fault) throw fault;

    const preview = this.previews.get(previewId);
    if (!preview || preview.status !== "preview") throw new Error("Mock preview is missing, expired, or already consumed");
    const issuedAt = this.previewIssuedAt.get(previewId);
    if (issuedAt !== undefined && this.clock() - issuedAt >= PREVIEW_EXPIRY_MS) {
      preview.status = "invalidated";
      this.previewIssuedAt.delete(previewId);
      this.previewTargetAccounts.delete(previewId);
      throw new MockBrokerError("preview-expired", "Mock preview expired; create a new preview before continuing");
    }
    if (preview.draftHash !== draftHash) throw new Error("Mock preview does not match the current draft");

    const isLocalMode = this.workspaceMode === "local-csv" && this.localSnapshot !== null;
    const orderAccountId = isLocalMode
      ? (this.previewTargetAccounts.get(previewId)
        ?? preview.accountId
        ?? this.resolveOrderTargetAccountId(preview.draft.accountId))
      : undefined;
    const snapshot = isLocalMode && orderAccountId
      ? this.getAccountSnapshot(orderAccountId)
      : this.getSnapshot();
    const matchedQuote = matchQuote(
      snapshot.quotes,
      preview.draft.symbol,
      preview.draft.currency ?? preview.quote.currency,
    );
    if (!matchedQuote || matchedQuote.status !== "available") {
      throw new MockBrokerError("stale-quote", "Mock quote is not fresh enough for a preview");
    }
    const quoteCurrency = (matchedQuote.currency ?? preview.draft.currency ?? "USD").toUpperCase();
    const availableBuyingPower = buyingPowerForCurrency(snapshot.account, quoteCurrency);
    const estimatedAmount = decimalRound(
      decimalMultiply(preview.draft.limitPrice ?? matchedQuote.price, preview.draft.quantity),
      2,
      "half-even",
    ) as Money;
    if (preview.draft.side === "buy" && decimalCompare(estimatedAmount, availableBuyingPower) > 0) {
      throw new MockBrokerError("insufficient-buying-power", "Mock buying power is insufficient");
    }
    if (preview.draft.side === "sell") {
      if (this.workspaceMode === "mock" && this.scenario === "insufficient-quantity") {
        throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
      }
      const matchedHolding = matchHolding(snapshot.holdings, preview.draft.symbol, quoteCurrency);
      if (!matchedHolding || decimalCompare(preview.draft.quantity, matchedHolding.availableQuantity) > 0) {
        throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
      }
    }
    preview.status = "consumed";
    this.previewIssuedAt.delete(previewId);
    this.previewTargetAccounts.delete(previewId);

    const id = isLocalMode ? `PAPER-ORDER-${++this.sequence}` : `MOCK-ORDER-${++this.sequence}`;
    const unknown = !isLocalMode && (this.scenario === "unknown" || this.scenario === "reconciliation-failed");
    const eventAt = nowIso(this.clock);
    const event = unknown
      ? orderEvent("unknown", eventAt, "Mock acknowledgement is unknown; do not resubmit", "模拟确认状态未知；不要重下")
      : orderEvent("accepted", eventAt, "Accepted by the local paper ledger; no broker request exists", "本地纸上账本已接受；不存在券商请求");
    const order: BrokerOrder = {
      id,
      ...(orderAccountId ? { accountId: orderAccountId } : {}),
      symbol: preview.draft.symbol,
      side: preview.draft.side,
      type: preview.draft.type,
      quantity: preview.draft.quantity,
      filledQuantity: quantity("0"),
      limitPrice: preview.draft.limitPrice,
      currency: quoteCurrency,
      status: unknown ? "unknown" : "working",
      submittedAt: eventAt,
      events: [
        orderEvent("draft", eventAt, "Created locally in paper ledger", "在本地纸上账本中创建"),
        orderEvent("preview", eventAt, "Preview checked and consumed once", "已检查预览并且只消费一次"),
        event,
      ],
    };

    if (isLocalMode) {
      this.allLocalOrders = [order, ...this.allLocalOrders];
      this.rebuildActiveLocalSnapshot();
      this.notify();
      return cloneOrder(order);
    }

    const activeTarget = this.snapshot;
    const nextAccount: BrokerAccount = preview.draft.side === "buy"
      ? activeTarget.account.isMultiCurrency && activeTarget.account.currencyBreakdowns
        ? {
            ...activeTarget.account,
            currencyBreakdowns: activeTarget.account.currencyBreakdowns.map((item) => {
              if (item.currency !== quoteCurrency) return item;
              return {
                ...item,
                buyingPower: decimalCompare(item.buyingPower, estimatedAmount) > 0
                  ? decimalSubtract(item.buyingPower, estimatedAmount) as Money
                  : ZERO_MONEY,
              };
            }),
          }
        : {
            ...activeTarget.account,
            buyingPower: decimalCompare(activeTarget.account.buyingPower, estimatedAmount) > 0
              ? decimalSubtract(activeTarget.account.buyingPower, estimatedAmount) as Money
              : ZERO_MONEY,
            currencyBreakdowns: activeTarget.account.currencyBreakdowns?.map((item) => {
              if (item.currency !== quoteCurrency) return item;
              return {
                ...item,
                buyingPower: decimalCompare(item.buyingPower, estimatedAmount) > 0
                  ? decimalSubtract(item.buyingPower, estimatedAmount) as Money
                  : ZERO_MONEY,
              };
            }),
          }
      : activeTarget.account;

    const nextHoldings: readonly BrokerHolding[] = preview.draft.side === "sell"
      ? activeTarget.holdings.map((item) => {
          if (item.symbol !== preview.draft.symbol || (item.currency ?? "USD") !== quoteCurrency) return item;
          const remaining = decimalCompare(item.availableQuantity, preview.draft.quantity) > 0
            ? decimalSubtract(item.availableQuantity, preview.draft.quantity) as Quantity
            : ZERO_QUANTITY;
          return { ...item, availableQuantity: remaining };
        })
      : activeTarget.holdings;

    this.snapshot = {
      ...activeTarget,
      account: nextAccount,
      holdings: nextHoldings,
      orders: [order, ...activeTarget.orders],
    };
    this.notify();
    return cloneOrder(order);
  }

  reconcileOrder(orderId: string): BrokerOrder {
    const isLocalMode = this.workspaceMode === "local-csv" && this.localSnapshot !== null;
    const order = isLocalMode
      ? this.allLocalOrders.find((item) => item.id === orderId)
      : this.snapshot.orders.find((item) => item.id === orderId);
    if (!order) throw new Error(`No mock order ${orderId}`);
    if (order.status !== "unknown") return cloneOrder(order);
    if (!isLocalMode && this.scenario === "reconciliation-failed") {
      throw new MockBrokerError("unknown-reconciliation", "Mock reconciliation failed; keep the order locked");
    }

    const reconciled: BrokerOrder = {
      ...order,
      status: "working",
      events: [...order.events, orderEvent("accepted", nowIso(this.clock), "Reconciliation found a working mock order", "对账发现模拟订单仍在工作")],
    };
    if (isLocalMode) {
      this.allLocalOrders = this.allLocalOrders.map((item) => item.id === orderId ? reconciled : item);
      this.rebuildActiveLocalSnapshot();
    } else {
      this.snapshot = {
        ...this.snapshot,
        orders: this.snapshot.orders.map((item) => item.id === orderId ? reconciled : item),
      };
    }
    this.notify();
    return cloneOrder(reconciled);
  }

  invalidatePreview(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (preview?.status === "preview") {
      preview.status = "invalidated";
      this.previewIssuedAt.delete(previewId);
      this.previewTargetAccounts.delete(previewId);
    }
  }
}

export const MOCK_BROKER = new MockBroker();

export function findQuoteInSnapshot(
  snapshot: BrokerSnapshot,
  symbol: string,
  currency?: string,
): BrokerQuote | undefined {
  return matchQuote(snapshot.quotes, symbol, currency);
}

export function findHoldingInSnapshot(
  snapshot: BrokerSnapshot,
  symbol: string,
  currency?: string,
): BrokerHolding | undefined {
  return matchHolding(snapshot.holdings, symbol, currency);
}

export function findMockQuote(symbol: string, currency?: string): BrokerQuote | undefined {
  return matchQuote(MOCK_BROKER.getSnapshot().quotes, symbol, currency);
}

export function findMockHolding(symbol: string, currency?: string): BrokerHolding | undefined {
  return matchHolding(MOCK_BROKER.getSnapshot().holdings, symbol, currency);
}

export function mockDraftHash(draft: OrderDraft): string {
  return stableDraftHash(draft);
}

export function mockFixedMoney(value: Money): string {
  return decimalToFixed(value, 2);
}
