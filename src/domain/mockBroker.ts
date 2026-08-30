import {
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalToFixed,
  money,
  percent,
  price,
  quantity,
  type Money,
} from "./decimal";
import type {
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

const quote = (
  symbol: BrokerQuote["symbol"],
  companyEn: string,
  companyZh: string,
  currentPrice: string,
  change: string,
  changePct: string,
): BrokerQuote => ({
  symbol,
  companyEn,
  companyZh,
  price: price(currentPrice),
  change: price(change),
  changePct: percent(changePct),
  asOf: AS_OF,
  status: "available",
});

const QUOTES: readonly BrokerQuote[] = [
  quote("AAPL", "Apple Inc.", "苹果公司", "226.34", "2.68", "1.18"),
  quote("NVDA", "NVIDIA Corporation", "英伟达", "118.40", "-0.74", "-0.62"),
  quote("MSFT", "Microsoft Corporation", "微软", "412.55", "1.90", "0.46"),
  quote("SPY", "SPDR S&P 500 ETF", "标普 500 ETF", "542.18", "1.14", "0.21"),
  quote("TSLA", "Tesla, Inc.", "特斯拉", "241.73", "-2.54", "-1.04"),
  quote("AMD", "Advanced Micro Devices", "超威半导体", "168.44", "1.94", "1.16"),
  quote("AMZN", "Amazon.com, Inc.", "亚马逊", "181.27", "-1.12", "-0.61"),
];

function holding(
  symbol: BrokerHolding["symbol"],
  companyEn: string,
  companyZh: string,
  quantityValue: string,
  averageCost: string,
  marketValue: string,
  dayPnl: string,
  totalPnl: string,
): BrokerHolding {
  return {
    symbol,
    companyEn,
    companyZh,
    quantity: quantity(quantityValue),
    averageCost: price(averageCost),
    marketValue: money(marketValue),
    dayPnl: money(dayPnl),
    totalPnl: money(totalPnl),
  };
}

const HOLDINGS: readonly BrokerHolding[] = [
  holding("AAPL", "Apple Inc.", "苹果公司", "100", "221.84", "22634.00", "450.00", "1250.00"),
  holding("NVDA", "NVIDIA Corporation", "英伟达", "50", "120.50", "5920.00", "-105.00", "-105.00"),
  holding("SPY", "SPDR S&P 500 ETF", "标普 500 ETF", "200", "535.00", "108436.00", "1436.00", "14800.00"),
  holding("MSFT", "Microsoft Corporation", "微软", "28", "406.03", "11551.40", "182.14", "2797.16"),
];

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

const holdingsValue = HOLDINGS.reduce<Money>((total, item) => decimalAdd(total, item.marketValue) as Money, money("0"));
const account = {
  accountKey: "demo-account-1234",
  cash: money("5320.00"),
  buyingPower: money("10983.40"),
  totalEquity: decimalAdd(holdingsValue, money("5320.00")) as Money,
  todayChange: HOLDINGS.reduce<Money>((total, item) => decimalAdd(total, item.dayPnl) as Money, money("0")),
  todayChangePct: percent("1.28"),
  allTimeChange: money("18742.16"),
  asOf: AS_OF,
  status: "available" as const,
};

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
  yearNetChange: money("8214.00"),
};

function stableDraftHash(draft: OrderDraft): string {
  return [draft.symbol, draft.side, draft.type, draft.quantity, draft.limitPrice ?? "market"].join(":");
}

function nowIso(): string {
  return AS_OF;
}

function scenarioSnapshot(snapshot: BrokerSnapshot, scenario: MockScenario): BrokerSnapshot {
  if (scenario === "healthy" || scenario === "request-failed" || scenario === "rate-limited" || scenario === "timeout" || scenario === "unknown" || scenario === "reconciliation-failed" || scenario === "insufficient-quantity" || scenario === "no-buying-power") {
    if (scenario === "no-buying-power") {
      return {
        ...snapshot,
        account: { ...snapshot.account, cash: money("0"), buyingPower: money("0"), status: "available" },
      };
    }
    return snapshot;
  }

  if (scenario === "empty-account") {
    return {
      ...snapshot,
      account: {
        ...snapshot.account,
        cash: money("25000.00"),
        buyingPower: money("25000.00"),
        totalEquity: money("25000.00"),
        todayChange: money("0"),
        todayChangePct: percent("0"),
        allTimeChange: money("0"),
      },
      holdings: [],
      orders: [],
      activeDays: 0,
      ordersFilled: 0,
      yearNetChange: money("0"),
    };
  }

  if (scenario === "loss") {
    return {
      ...snapshot,
      account: { ...snapshot.account, todayChange: money("-1820.34"), todayChangePct: percent("-1.18"), allTimeChange: money("-4210.80") },
      holdings: snapshot.holdings.map((holding) => ({ ...holding, dayPnl: decimalMultiply(holding.dayPnl, money("-1")) as Money, totalPnl: decimalMultiply(holding.totalPnl, money("-1")) as Money })),
      yearNetChange: money("-4210.80"),
    };
  }

  if (scenario === "market-closed") {
    return { ...snapshot, quotes: snapshot.quotes.map((quote) => ({ ...quote, status: "stale" as const })) };
  }

  if (scenario === "stale-quote") {
    return { ...snapshot, quotes: snapshot.quotes.map((quote) => ({ ...quote, status: "stale" as const })) };
  }

  if (scenario === "offline") {
    return {
      ...snapshot,
      account: { ...snapshot.account, status: "offline" },
      quotes: snapshot.quotes.map((quote) => ({ ...quote, status: "offline" as const })),
    };
  }

  return {
    ...snapshot,
    account: { ...snapshot.account, status: "reauth-required" },
    quotes: snapshot.quotes.map((quote) => ({ ...quote, status: "reauth-required" as const })),
  };
}

function scenarioError(scenario: MockScenario): MockBrokerError | undefined {
  switch (scenario) {
    case "offline": return new MockBrokerError("offline", "Mock data source is offline");
    case "reauth-required": return new MockBrokerError("reauth-required", "Mock session requires reauthorization");
    case "request-failed": return new MockBrokerError("request-failed", "Mock request failed deterministically");
    case "rate-limited": return new MockBrokerError("rate-limited", "Mock rate limit reached; no retry is scheduled");
    case "timeout": return new MockBrokerError("timeout", "Mock request timed out; outcome is not known");
    case "market-closed": return new MockBrokerError("market-closed", "Mock regular session is closed");
    default: return undefined;
  }
}

export class MockBroker implements BrokerAdapter {
  readonly id = "mock-broker";
  readonly mode = "mock" as const;
  readonly capabilities = capabilities;
  private snapshot: BrokerSnapshot = BASE_SNAPSHOT;
  private readonly previews = new Map<string, MockPreview>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private scenario: MockScenario = "healthy";

  getSnapshot(): BrokerSnapshot {
    return scenarioSnapshot(this.snapshot, this.scenario);
  }

  getScenario(): MockScenario {
    return this.scenario;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  setScenario(scenario: MockScenario): void {
    if (this.scenario === scenario) return;
    this.scenario = scenario;
    this.notify();
  }

  reset(): void {
    this.snapshot = BASE_SNAPSHOT;
    this.previews.clear();
    this.sequence = 0;
    this.scenario = "healthy";
    this.notify();
  }

  previewOrder(draft: OrderDraft): MockPreview {
    const fault = scenarioError(this.scenario);
    if (fault) throw fault;

    const quote = this.snapshot.quotes.find((item) => item.symbol === draft.symbol);
    if (!quote) throw new Error(`No mock quote for ${draft.symbol}`);

    const unitPrice = draft.limitPrice ?? quote.price;
    const estimatedAmount = decimalMultiply(unitPrice, draft.quantity) as Money;
    if (this.scenario === "no-buying-power" || decimalCompare(estimatedAmount, this.snapshot.account.buyingPower) > 0) {
      throw new MockBrokerError("insufficient-buying-power", "Mock buying power is insufficient");
    }
    if (this.scenario === "insufficient-quantity") {
      throw new MockBrokerError("insufficient-quantity", "Mock position quantity is insufficient");
    }
    const draftHash = stableDraftHash(draft);
    const previewId = `MOCK-PREVIEW-${draft.symbol}-${++this.sequence}`;
    const createdAt = nowIso();
    const preview: MockPreview = {
      previewId,
      draftHash,
      draft: { ...draft },
      quote,
      estimatedAmount,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + PREVIEW_EXPIRY_MS).toISOString(),
      status: "preview",
    };
    this.previews.set(previewId, preview);
    return preview;
  }

  consumePreview(previewId: string, draftHash: string): BrokerOrder {
    const fault = scenarioError(this.scenario);
    if (fault) throw fault;

    const preview = this.previews.get(previewId);
    if (!preview || preview.status !== "preview") throw new Error("Mock preview is missing, expired, or already consumed");
    if (preview.draftHash !== draftHash) throw new Error("Mock preview does not match the current draft");
    preview.status = "consumed";

    const id = `MOCK-ORDER-${++this.sequence}`;
    const unknown = this.scenario === "unknown" || this.scenario === "reconciliation-failed";
    const event = unknown
      ? orderEvent("unknown", nowIso(), "Mock acknowledgement is unknown; do not resubmit", "模拟确认状态未知；不要重下")
      : orderEvent("accepted", nowIso(), "Accepted by the mock venue; no broker request exists", "模拟场所已接受；不存在券商请求");
    const order: BrokerOrder = {
      id,
      symbol: preview.draft.symbol,
      side: preview.draft.side,
      type: preview.draft.type,
      quantity: preview.draft.quantity,
      filledQuantity: quantity("0"),
      limitPrice: preview.draft.limitPrice,
      status: unknown ? "unknown" : "working",
      submittedAt: nowIso(),
      events: [
        orderEvent("draft", nowIso(), "Created locally in Mock Broker", "在本地 Mock Broker 中创建"),
        orderEvent("preview", nowIso(), "Preview checked and consumed once", "已检查预览并且只消费一次"),
        event,
      ],
    };
    this.snapshot = { ...this.snapshot, orders: [order, ...this.snapshot.orders] };
    this.notify();
    return order;
  }

  reconcileOrder(orderId: string): BrokerOrder {
    const order = this.snapshot.orders.find((item) => item.id === orderId);
    if (!order) throw new Error(`No mock order ${orderId}`);
    if (order.status !== "unknown") return order;
    if (this.scenario === "reconciliation-failed") throw new MockBrokerError("unknown-reconciliation", "Mock reconciliation failed; keep the order locked");

    const reconciled: BrokerOrder = {
      ...order,
      status: "working",
      events: [...order.events, orderEvent("accepted", nowIso(), "Reconciliation found a working mock order", "对账发现模拟订单仍在工作")],
    };
    this.snapshot = { ...this.snapshot, orders: this.snapshot.orders.map((item) => item.id === orderId ? reconciled : item) };
    this.notify();
    return reconciled;
  }

  invalidatePreview(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (preview?.status === "preview") preview.status = "invalidated";
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
