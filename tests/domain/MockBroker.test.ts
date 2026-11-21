import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_BROKER, MockBroker, MockBrokerError, mockDraftHash } from "../../src/domain/mockBroker";
import { decimalAdd, decimalCompare, decimalMultiply, decimalRound, decimalSubtract, money, price, quantity, type Money } from "../../src/domain/decimal";

afterEach(() => {
  MOCK_BROKER.reset();
});

describe("MockBroker subscriptions", () => {
  it("notifies subscribers when scenarios and ledger state change", () => {
    const listener = vi.fn();
    const unsubscribe = MOCK_BROKER.subscribe(listener);

    MOCK_BROKER.setScenario("stale-quote");
    expect(listener).toHaveBeenCalledTimes(1);

    MOCK_BROKER.setScenario("stale-quote");
    expect(listener).toHaveBeenCalledTimes(1);

    const draft = {
      symbol: "AAPL" as const,
      side: "buy" as const,
      type: "limit" as const,
      quantity: quantity("1"),
      limitPrice: price("220.00"),
    };
    MOCK_BROKER.setScenario("healthy");
    const preview = MOCK_BROKER.previewOrder(draft);
    MOCK_BROKER.consumePreview(preview.previewId, mockDraftHash(draft));
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    MOCK_BROKER.reset();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not expose mutable references to the canonical snapshot", () => {
    const snapshot = MOCK_BROKER.getSnapshot();
    const firstQuote = snapshot.quotes[0];
    const firstOrder = snapshot.orders[0];
    const firstHeatmapEntry = snapshot.heatmap[0];

    if (!firstQuote || !firstOrder || !firstHeatmapEntry) throw new Error("Expected base snapshot fixtures");
    (firstQuote as { price: string }).price = "0";
    (firstOrder.events as Array<{ detailEn: string }>)[0]!.detailEn = "mutated";
    (firstHeatmapEntry as { actions: number }).actions = 999;

    const freshSnapshot = MOCK_BROKER.getSnapshot();
    expect(freshSnapshot.quotes[0]?.price).toBe("226.34");
    expect(freshSnapshot.orders[0]?.events[0]?.detailEn).not.toBe("mutated");
    expect(freshSnapshot.heatmap[0]?.actions).not.toBe(999);
  });

  it("isolates preview and order results from the canonical ledger", () => {
    const draft = {
      symbol: "AAPL" as const,
      side: "buy" as const,
      type: "market" as const,
      quantity: quantity("1"),
      limitPrice: null,
    };
    const preview = MOCK_BROKER.previewOrder(draft);
    preview.draft.quantity = quantity("999");
    preview.quote.price = price("0");

    const order = MOCK_BROKER.consumePreview(preview.previewId, preview.draftHash);
    order.events[0]!.detailEn = "mutated";

    expect(order.quantity).toBe("1");
    expect(MOCK_BROKER.getSnapshot().orders[0]?.quantity).toBe("1");
    expect(MOCK_BROKER.getSnapshot().orders[0]?.events[0]?.detailEn).not.toBe("mutated");
  });

  it("reserves buying power on buy consumePreview to prevent double-spend", () => {
    const broker = new MockBroker();
    const initialBp = broker.getSnapshot().account.buyingPower;
    const draft = {
      symbol: "AAPL" as const,
      side: "buy" as const,
      type: "limit" as const,
      quantity: quantity("30"),
      limitPrice: price("200.00"),
    };

    const preview1 = broker.previewOrder(draft);
    const preview2 = broker.previewOrder(draft);

    broker.consumePreview(preview1.previewId, preview1.draftHash);
    const remainingBp = broker.getSnapshot().account.buyingPower;
    expect(remainingBp).toBe(decimalSubtract(initialBp, money("6000.00")));

    // Second preview (6000) exceeds remaining buyingPower (4983.40)
    expect(() => broker.consumePreview(preview2.previewId, preview2.draftHash)).toThrow(MockBrokerError);
    expect(() => broker.previewOrder(draft)).toThrow(/buying power/i);
  });

  it("reserves available position quantity on sell consumePreview to prevent overselling", () => {
    const broker = new MockBroker();
    const draft = {
      symbol: "AAPL" as const,
      side: "sell" as const,
      type: "market" as const,
      quantity: quantity("60"),
      limitPrice: null,
    };

    const preview1 = broker.previewOrder(draft);
    const preview2 = broker.previewOrder(draft);

    broker.consumePreview(preview1.previewId, preview1.draftHash);
    const holding = broker.getSnapshot().holdings.find((item) => item.symbol === "AAPL");
    expect(holding?.quantity).toBe("100");
    expect(holding?.availableQuantity).toBe("40");

    // Second 60-share sell exceeds 40 available shares
    expect(() => broker.consumePreview(preview2.previewId, preview2.draftHash)).toThrow(/quantity/i);
    expect(() => broker.previewOrder(draft)).toThrow(/quantity/i);
  });

  it("applies insufficient-quantity scenario only to sell orders and allows buy orders", () => {
    const broker = new MockBroker();
    broker.setScenario("insufficient-quantity");

    const buyDraft = {
      symbol: "AAPL" as const,
      side: "buy" as const,
      type: "market" as const,
      quantity: quantity("1"),
      limitPrice: null,
    };
    const sellDraft = {
      symbol: "AAPL" as const,
      side: "sell" as const,
      type: "market" as const,
      quantity: quantity("1"),
      limitPrice: null,
    };

    const buyPreview = broker.previewOrder(buyDraft);
    expect(broker.consumePreview(buyPreview.previewId, buyPreview.draftHash).status).toBe("working");
    expect(() => broker.previewOrder(sellDraft)).toThrow(/quantity/i);
  });

  it("derives mathematically consistent holdings and account totals in healthy and loss scenarios", () => {
    const broker = new MockBroker();

    for (const scenario of ["healthy", "loss"] as const) {
      broker.setScenario(scenario);
      const snapshot = broker.getSnapshot();
      let sumMv = money("0");
      let sumDayPnl = money("0");
      let sumTotalPnl = money("0");

      for (const item of snapshot.holdings) {
        const quote = snapshot.quotes.find((q) => q.symbol === item.symbol)!;
        expect(item.marketValue).toBe(decimalRound(decimalMultiply(quote.price, item.quantity), 2, "half-even"));
        expect(item.dayPnl).toBe(decimalRound(decimalMultiply(quote.change, item.quantity), 2, "half-even"));
        expect(item.totalPnl).toBe(decimalRound(decimalMultiply(decimalSubtract(quote.price, item.averageCost), item.quantity), 2, "half-even"));
        sumMv = decimalAdd(sumMv, item.marketValue) as Money;
        sumDayPnl = decimalAdd(sumDayPnl, item.dayPnl) as Money;
        sumTotalPnl = decimalAdd(sumTotalPnl, item.totalPnl) as Money;
      }

      expect(snapshot.account.totalEquity).toBe(decimalAdd(sumMv, snapshot.account.cash));
      expect(snapshot.account.todayChange).toBe(sumDayPnl);
      expect(snapshot.account.allTimeChange).toBe(sumTotalPnl);

      if (scenario === "loss") {
        // NVDA was already at a loss in healthy; loss scenario must keep it negative, never flip it positive
        const nvda = snapshot.holdings.find((item) => item.symbol === "NVDA")!;
        expect(decimalCompare(nvda.totalPnl, money("0"))).toBe(-1);
        expect(decimalCompare(nvda.dayPnl, money("0"))).toBe(-1);
        expect(decimalCompare(snapshot.account.todayChange, money("0"))).toBe(-1);
        expect(decimalCompare(snapshot.account.allTimeChange, money("0"))).toBe(-1);
      }
    }
  });
});
