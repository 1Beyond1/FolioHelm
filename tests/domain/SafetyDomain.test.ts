import { afterEach, describe, expect, it } from "vitest";
import { decimalAdd, decimalMultiply, decimalSubtract, money, price, quantity } from "../../src/domain/decimal";
import { AutomationController, DEFAULT_AUTOMATION_STATE } from "../../src/domain/automation";
import { appendEvidence, clearEvidence, exportEvidence, verifyEvidence } from "../../src/domain/evidenceJournal";
import { MockBroker, MockBrokerError } from "../../src/domain/mockBroker";

afterEach(() => {
  localStorage.clear();
  clearEvidence();
});

describe("exact financial primitives", () => {
  it("does not lose cents during decimal arithmetic", () => {
    expect(decimalAdd(money("0.10"), money("0.20"))).toBe("0.3");
    expect(decimalSubtract(money("100.00"), money("0.01"))).toBe("99.99");
    expect(decimalMultiply(price("226.34"), quantity("3"))).toBe("679.02");
  });
});

describe("Mock Broker safety states", () => {
  it("consumes a preview once and rejects a changed draft", () => {
    const broker = new MockBroker();
    const draft = { symbol: "AAPL" as const, side: "buy" as const, type: "limit" as const, quantity: quantity("2"), limitPrice: price("220.00") };
    const preview = broker.previewOrder(draft);
    expect(() => broker.consumePreview(preview.previewId, "changed")).toThrow();
    const order = broker.consumePreview(preview.previewId, preview.draftHash);
    expect(order.status).toBe("working");
    expect(() => broker.consumePreview(preview.previewId, preview.draftHash)).toThrow();
  });

  it("models unknown outcomes and blocks reconciliation failure", () => {
    const broker = new MockBroker();
    broker.setScenario("unknown");
    const draft = { symbol: "SPY" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };
    const preview = broker.previewOrder(draft);
    const order = broker.consumePreview(preview.previewId, preview.draftHash);
    expect(order.status).toBe("unknown");
    expect(broker.reconcileOrder(order.id).status).toBe("working");

    broker.reset();
    broker.setScenario("reconciliation-failed");
    const secondPreview = broker.previewOrder(draft);
    const unknown = broker.consumePreview(secondPreview.previewId, secondPreview.draftHash);
    expect(() => broker.reconcileOrder(unknown.id)).toThrow(MockBrokerError);
  });

  it("exposes offline and no-buying-power scenarios without network access", () => {
    const broker = new MockBroker();
    broker.setScenario("offline");
    expect(broker.getSnapshot().account.status).toBe("offline");
    const draft = { symbol: "AAPL" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };
    expect(() => broker.previewOrder(draft)).toThrow(MockBrokerError);

    broker.setScenario("no-buying-power");
    expect(broker.getSnapshot().account.buyingPower).toBe("0");
    expect(() => broker.previewOrder(draft)).toThrow(/buying power/i);
  });
});

describe("local automation guardrails", () => {
  it("blocks Real Trading, enforces caps, and prevents duplicate idempotency keys", () => {
    const controller = new AutomationController({ ...DEFAULT_AUTOMATION_STATE, enabled: true, mode: "real" });
    const input = { symbol: "SPY" as const, side: "buy" as const, quantity: quantity("1"), price: price("10.00"), idempotencyKey: "one" };
    expect(controller.run(input).log.status).toBe("blocked");

    controller.replaceState({ ...controller.getState(), mode: "dry-run", policy: { ...DEFAULT_AUTOMATION_STATE.policy, maxOrderValue: money("5.00") } });
    expect(controller.run({ ...input, idempotencyKey: "cap" }).log.status).toBe("blocked");
    controller.replaceState({ ...controller.getState(), enabled: true, policy: { ...DEFAULT_AUTOMATION_STATE.policy, maxOrderValue: money("20.00"), maxDailyValue: money("20.00") } });
    expect(controller.run({ ...input, idempotencyKey: "accepted" }).log.status).toBe("would-run");
    expect(controller.run({ ...input, idempotencyKey: "accepted" }).log.status).toBe("duplicate");
  });
});

describe("tamper-evident local journal", () => {
  it("writes, verifies, exports, and detects modification", async () => {
    await appendEvidence("order_intent", { mode: "mock", symbol: "SPY", amount: "10.00" });
    await appendEvidence("mock_response", { status: "working", symbol: "SPY" });
    expect((await verifyEvidence()).valid).toBe(true);

    const bundle = JSON.parse(await exportEvidence()) as { records: Array<{ payload: Record<string, string> }> };
    bundle.records[0]!.payload.amount = "999.99";
    expect((await verifyEvidence(bundle.records as never)).valid).toBe(false);
  });
});
