import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { mockDraftHash } from "../../src/domain/mockBroker";
import { price, quantity } from "../../src/domain/decimal";

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
});
