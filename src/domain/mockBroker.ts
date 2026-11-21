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
  MockErrorCode,
  MockScenario,
  MockPreview,
  OrderDraft,
} from "./contracts";

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
}

function holdingSeed(
  symbol: BrokerHolding["symbol"],
  companyEn: string,
  companyZh: string,
  quantityValue: string,
  averageCost: string,
): HoldingSeed {
  const parsedQty = quantity(quantityValue);
  return {
    symbol,
    companyEn,
    companyZh,
    quantity: parsedQty,
    availableQuantity: parsedQty,
    averageCost: price(averageCost),
  };
}

function deriveHoldings(
  seeds: readonly HoldingSeed[],
  quotes: readonly BrokerQuote[],
): BrokerHolding[] {
  const quoteBySymbol = new Map(quotes.map((item) => [item.symbol, item]));
  return seeds.map((seed) => {
    const matchedQuote = quoteBySymbol.get(seed.symbol);
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
  return [draft.symbol, draft.side, draft.type, draft.quantity, draft.limitPrice ?? "market"].join(":");
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
    account: { ...snapshot.account },
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

export class MockBroker implements BrokerAdapter {
  readonly id = "mock-broker";
  readonly mode = "mock" as const;
  readonly capabilities = capabilities;
  private snapshot: BrokerSnapshot = BASE_SNAPSHOT;
  private readonly previews = new Map<string, MockPreview>();
  private readonly previewIssuedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private scenario: MockScenario = "healthy";

  constructor(private readonly clock: () => number = () => Date.now()) {}

  getSnapshot(): BrokerSnapshot {
    return cloneSnapshot(scenarioSnapshot(this.snapshot, this.scenario));
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
    this.snapshot = BASE_SNAPSHOT;
    this.previews.clear();
    this.previewIssuedAt.clear();
    this.sequence = 0;
    this.scenario = "healthy";
    this.notify();
  }

  previewOrder(draft: OrderDraft): MockPreview {
    const fault = scenarioError(this.scenario);
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

    const snapshot = this.getSnapshot();
    const matchedQuote = snapshot.quotes.find((item) => item.symbol === draft.symbol);
    if (!matchedQuote) throw new Error(`No mock quote for ${draft.symbol}`);
    if (matchedQuote.status !== "available") {
      throw new MockBrokerError("stale-quote", "Mock quote is not fresh enough for a preview");
    }

    const unitPrice = draft.limitPrice ?? matchedQuote.price;
    const estimatedAmount = decimalRound(decimalMultiply(unitPrice, draft.quantity), 2, "half-even") as Money;
    if (draft.side === "buy" && decimalCompare(estimatedAmount, snapshot.account.buyingPower) > 0) {
      throw new MockBrokerError("insufficient-buying-power", "Mock buying power is insufficient");
    }
    if (draft.side === "sell") {
      if (this.scenario === "insufficient-quantity") {
        throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
      }
      const matchedHolding = snapshot.holdings.find((item) => item.symbol === draft.symbol);
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
      quote: matchedQuote,
      estimatedAmount,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + PREVIEW_EXPIRY_MS).toISOString(),
      status: "preview",
    };
    this.previews.set(previewId, preview);
    this.previewIssuedAt.set(previewId, created.timestamp);
    return clonePreview(preview);
  }

  consumePreview(previewId: string, draftHash: string): BrokerOrder {
    const fault = scenarioError(this.scenario);
    if (fault) throw fault;

    const preview = this.previews.get(previewId);
    if (!preview || preview.status !== "preview") throw new Error("Mock preview is missing, expired, or already consumed");
    const issuedAt = this.previewIssuedAt.get(previewId);
    if (issuedAt !== undefined && this.clock() - issuedAt >= PREVIEW_EXPIRY_MS) {
      preview.status = "invalidated";
      this.previewIssuedAt.delete(previewId);
      throw new MockBrokerError("preview-expired", "Mock preview expired; create a new preview before continuing");
    }
    if (preview.draftHash !== draftHash) throw new Error("Mock preview does not match the current draft");

    // The account and quote can change while a preview is on screen. Recheck
    // the same local gates at consumption time so a stale preview cannot
    // bypass a newly selected safety scenario or double-spend reserved funds.
    const snapshot = this.getSnapshot();
    const matchedQuote = snapshot.quotes.find((item) => item.symbol === preview.draft.symbol);
    if (!matchedQuote || matchedQuote.status !== "available") {
      throw new MockBrokerError("stale-quote", "Mock quote is not fresh enough for a preview");
    }
    const estimatedAmount = decimalRound(
      decimalMultiply(preview.draft.limitPrice ?? matchedQuote.price, preview.draft.quantity),
      2,
      "half-even",
    ) as Money;
    if (preview.draft.side === "buy" && decimalCompare(estimatedAmount, snapshot.account.buyingPower) > 0) {
      throw new MockBrokerError("insufficient-buying-power", "Mock buying power is insufficient");
    }
    if (preview.draft.side === "sell") {
      if (this.scenario === "insufficient-quantity") {
        throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
      }
      const matchedHolding = snapshot.holdings.find((item) => item.symbol === preview.draft.symbol);
      if (!matchedHolding || decimalCompare(preview.draft.quantity, matchedHolding.availableQuantity) > 0) {
        throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
      }
    }
    preview.status = "consumed";
    this.previewIssuedAt.delete(previewId);

    const id = `MOCK-ORDER-${++this.sequence}`;
    const unknown = this.scenario === "unknown" || this.scenario === "reconciliation-failed";
    const eventAt = nowIso(this.clock);
    const event = unknown
      ? orderEvent("unknown", eventAt, "Mock acknowledgement is unknown; do not resubmit", "模拟确认状态未知；不要重下")
      : orderEvent("accepted", eventAt, "Accepted by the mock venue; no broker request exists", "模拟场所已接受；不存在券商请求");
    const order: BrokerOrder = {
      id,
      symbol: preview.draft.symbol,
      side: preview.draft.side,
      type: preview.draft.type,
      quantity: preview.draft.quantity,
      filledQuantity: quantity("0"),
      limitPrice: preview.draft.limitPrice,
      status: unknown ? "unknown" : "working",
      submittedAt: eventAt,
      events: [
        orderEvent("draft", eventAt, "Created locally in Mock Broker", "在本地 Mock Broker 中创建"),
        orderEvent("preview", eventAt, "Preview checked and consumed once", "已检查预览并且只消费一次"),
        event,
      ],
    };

    const nextAccount: BrokerAccount = preview.draft.side === "buy"
      ? {
          ...this.snapshot.account,
          buyingPower: decimalCompare(this.snapshot.account.buyingPower, estimatedAmount) > 0
            ? decimalSubtract(this.snapshot.account.buyingPower, estimatedAmount) as Money
            : ZERO_MONEY,
        }
      : this.snapshot.account;

    const nextHoldings: readonly BrokerHolding[] = preview.draft.side === "sell"
      ? this.snapshot.holdings.map((item) => {
          if (item.symbol !== preview.draft.symbol) return item;
          const remaining = decimalCompare(item.availableQuantity, preview.draft.quantity) > 0
            ? decimalSubtract(item.availableQuantity, preview.draft.quantity) as Quantity
            : ZERO_QUANTITY;
          return { ...item, availableQuantity: remaining };
        })
      : this.snapshot.holdings;

    this.snapshot = {
      ...this.snapshot,
      account: nextAccount,
      holdings: nextHoldings,
      orders: [order, ...this.snapshot.orders],
    };
    this.notify();
    return cloneOrder(order);
  }

  reconcileOrder(orderId: string): BrokerOrder {
    const order = this.snapshot.orders.find((item) => item.id === orderId);
    if (!order) throw new Error(`No mock order ${orderId}`);
    if (order.status !== "unknown") return cloneOrder(order);
    if (this.scenario === "reconciliation-failed") throw new MockBrokerError("unknown-reconciliation", "Mock reconciliation failed; keep the order locked");

    const reconciled: BrokerOrder = {
      ...order,
      status: "working",
      events: [...order.events, orderEvent("accepted", nowIso(this.clock), "Reconciliation found a working mock order", "对账发现模拟订单仍在工作")],
    };
    this.snapshot = { ...this.snapshot, orders: this.snapshot.orders.map((item) => item.id === orderId ? reconciled : item) };
    this.notify();
    return cloneOrder(reconciled);
  }

  invalidatePreview(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (preview?.status === "preview") {
      preview.status = "invalidated";
      this.previewIssuedAt.delete(previewId);
    }
  }
}

export const MOCK_BROKER = new MockBroker();

export function findMockQuote(symbol: string): BrokerQuote | undefined {
  return MOCK_BROKER.getSnapshot().quotes.find((item) => item.symbol === symbol);
}

export function findMockHolding(symbol: string): BrokerHolding | undefined {
  return MOCK_BROKER.getSnapshot().holdings.find((item) => item.symbol === symbol);
}

export function mockDraftHash(draft: OrderDraft): string {
  return stableDraftHash(draft);
}

export function mockFixedMoney(value: Money): string {
  return decimalToFixed(value, 2);
}
