import { afterEach, describe, expect, it, vi } from "vitest";
import { decimal, decimalAdd, decimalDivide, decimalMultiply, decimalRound, decimalSubtract, decimalToFixed, money, price, quantity } from "../../src/domain/decimal";
import { AutomationController, DEFAULT_AUTOMATION_STATE, FUTURE_LIVE_CANARY_POLICY, normalizeAutomationState } from "../../src/domain/automation";
import { appendEvidence, clearEvidence, evidenceCount, exportEvidence, verifyEvidence, type LocalEvidenceRecord } from "../../src/domain/evidenceJournal";
import { MockBroker, MockBrokerError } from "../../src/domain/mockBroker";

afterEach(async () => {
  localStorage.clear();
  await clearEvidence();
});

describe("exact financial primitives", () => {
  it("does not lose cents during decimal arithmetic", () => {
    expect(decimalAdd(money("0.10"), money("0.20"))).toBe("0.3");
    expect(decimalSubtract(money("100.00"), money("0.01"))).toBe("99.99");
    expect(decimalMultiply(price("226.34"), quantity("3"))).toBe("679.02");
  });

  it("rounds decimals explicitly with half-even, half-up, and truncate modes", () => {
    expect(decimalRound(decimal("2.5"), 0, "half-even")).toBe("2");
    expect(decimalRound(decimal("3.5"), 0, "half-even")).toBe("4");
    expect(decimalRound(decimal("-2.5"), 0, "half-even")).toBe("-2");
    expect(decimalRound(decimal("-3.5"), 0, "half-even")).toBe("-4");

    expect(decimalRound(decimal("2.5"), 0, "half-up")).toBe("3");
    expect(decimalRound(decimal("-2.5"), 0, "half-up")).toBe("-3");
    expect(decimalRound(decimal("1.005"), 2, "half-up")).toBe("1.01");

    expect(decimalRound(decimal("2.999"), 2, "truncate")).toBe("2.99");
    expect(decimalRound(decimal("-2.999"), 2, "truncate")).toBe("-2.99");
    expect(decimalRound(decimal("-0.001"), 2, "truncate")).toBe("0");
  });

  it("divides decimals accurately with explicit scale and rounding and rejects zero divisor", () => {
    expect(decimalDivide(decimal("1"), decimal("3"), 4, "half-even")).toBe("0.3333");
    expect(decimalDivide(decimal("2"), decimal("3"), 4, "half-even")).toBe("0.6667");
    expect(decimalDivide(decimal("5"), decimal("2"), 0, "half-even")).toBe("2");
    expect(decimalDivide(decimal("5"), decimal("2"), 0, "half-up")).toBe("3");
    expect(decimalDivide(decimal("-5"), decimal("2"), 0, "truncate")).toBe("-2");
    expect(decimalDivide(decimal("100"), decimal("0.25"), 2)).toBe("400");
    expect(() => decimalDivide(decimal("1"), decimal("0"))).toThrow(/divide.*zero/i);
  });

  it("keeps decimalToFixed strict by default and allows explicit rounding when requested", () => {
    expect(() => decimalToFixed(decimal("1.234"), 2)).toThrow(/cannot represent/i);
    expect(decimalToFixed(decimal("1.235"), 2, "half-even")).toBe("1.24");
    expect(decimalToFixed(decimal("1.245"), 2, "half-even")).toBe("1.24");
    expect(decimalToFixed(decimal("1.245"), 2, "half-up")).toBe("1.25");
    expect(decimalToFixed(decimal("1.249"), 2, "truncate")).toBe("1.24");
    expect(decimalToFixed(decimal("1.2"), 4)).toBe("1.2000");
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

  it("blocks stale quotes and validates sell quantity without using buying power", () => {
    const broker = new MockBroker();
    const sellDraft = { symbol: "AAPL" as const, side: "sell" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };

    broker.setScenario("stale-quote");
    expect(() => broker.previewOrder(sellDraft)).toThrow(/stale/i);

    broker.setScenario("healthy");
    broker.setScenario("no-buying-power");
    expect(() => broker.previewOrder(sellDraft)).not.toThrow();

    const oversizedSell = { ...sellDraft, quantity: quantity("101") };
    expect(() => broker.previewOrder(oversizedSell)).toThrow(/quantity/i);
  });

  it("expires a preview before it can be consumed", () => {
    let now = 0;
    const broker = new MockBroker(() => now);
    const draft = { symbol: "AAPL" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };
    const preview = broker.previewOrder(draft);

    now = 60_000;

    expect(() => broker.consumePreview(preview.previewId, preview.draftHash)).toThrow(/expired/i);
    expect(() => broker.consumePreview(preview.previewId, preview.draftHash)).toThrow(/missing|expired|already consumed/i);
  });

  it("rechecks account gates when a preview is consumed", () => {
    const broker = new MockBroker();
    const draft = { symbol: "AAPL" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };
    const preview = broker.previewOrder(draft);

    broker.setScenario("no-buying-power");
    expect(() => broker.consumePreview(preview.previewId, preview.draftHash)).toThrow(/buying power/i);
  });

  it("rejects malformed order drafts and uses the injected clock for mock events", () => {
    let now = 0;
    const broker = new MockBroker(() => now);
    const baseDraft = { symbol: "AAPL" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };

    expect(() => broker.previewOrder({ ...baseDraft, quantity: quantity("-1") })).toThrow(/invalid/i);
    expect(() => broker.previewOrder({ ...baseDraft, type: "limit", limitPrice: null })).toThrow(/invalid/i);

    const preview = broker.previewOrder(baseDraft);
    expect(preview.createdAt).toBe("1970-01-01T00:00:00.000Z");

    now = 5_000;
    const order = broker.consumePreview(preview.previewId, preview.draftHash);
    expect(order.submittedAt).toBe("1970-01-01T00:00:05.000Z");
    expect(order.events.every((event) => event.at === order.submittedAt)).toBe(true);
  });

  it("falls back to the deterministic Mock timestamp for an invalid clock", () => {
    const broker = new MockBroker(() => Number.NaN);
    const draft = { symbol: "AAPL" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };
    const preview = broker.previewOrder(draft);
    const order = broker.consumePreview(preview.previewId, preview.draftHash);

    expect(preview.createdAt).toBe("2026-08-10T16:00:00Z");
    expect(order.submittedAt).toBe("2026-08-10T16:00:00Z");
  });

  it("reads the injected clock once when anchoring preview expiry", () => {
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(60_000);
    const broker = new MockBroker(clock);
    const draft = { symbol: "AAPL" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };

    const preview = broker.previewOrder(draft);

    expect(clock).toHaveBeenCalledTimes(1);
    expect(preview.createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(preview.expiresAt).toBe("1970-01-01T00:01:00.000Z");
  });

  it("does not let a broken observer mask a committed mock order", () => {
    const broker = new MockBroker();
    const brokenListener = vi.fn(() => {
      throw new Error("observer failed");
    });
    const healthyListener = vi.fn();
    broker.subscribe(brokenListener);
    broker.subscribe(healthyListener);
    const draft = { symbol: "AAPL" as const, side: "buy" as const, type: "market" as const, quantity: quantity("1"), limitPrice: null };
    const preview = broker.previewOrder(draft);

    expect(() => broker.consumePreview(preview.previewId, preview.draftHash)).not.toThrow();
    expect(healthyListener).toHaveBeenCalledTimes(1);
    expect(broker.getSnapshot().orders[0]?.symbol).toBe("AAPL");
  });
});

describe("local automation guardrails", () => {
  it("keeps the future one-dollar live canary policy immutable in the Mock build", () => {
    expect(FUTURE_LIVE_CANARY_POLICY.cumulativeNotionalCap).toBe("1");
    expect(FUTURE_LIVE_CANARY_POLICY.maxNotionalPerOrder).toBe("1");
    expect(FUTURE_LIVE_CANARY_POLICY.manualLimitOnly).toBe(true);
    expect(FUTURE_LIVE_CANARY_POLICY.freezeBudgetOnUnknown).toBe(true);
    expect(FUTURE_LIVE_CANARY_POLICY.allowOtc).toBe(false);
    expect(FUTURE_LIVE_CANARY_POLICY.allowOptions).toBe(false);
  });

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

  it("enforces the rolling per-minute action cap without reserving blocked value", () => {
    const controller = new AutomationController({
      ...DEFAULT_AUTOMATION_STATE,
      enabled: true,
      mode: "dry-run",
      policy: {
        ...DEFAULT_AUTOMATION_STATE.policy,
        maxOrderValue: money("1000.00"),
        maxDailyValue: money("1000.00"),
        maxOpenTasks: 10,
        maxActionsPerMinute: 2,
      },
    });
    const input = { symbol: "SPY" as const, side: "buy" as const, quantity: quantity("1"), price: price("100.00") };

    expect(controller.run({ ...input, idempotencyKey: "rate-1", at: "2026-08-30T00:00:00Z" }).log.status).toBe("would-run");
    controller.completeTask();
    expect(controller.run({ ...input, idempotencyKey: "rate-2", at: "2026-08-30T00:00:30Z" }).log.status).toBe("would-run");
    controller.completeTask();

    const blocked = controller.run({ ...input, idempotencyKey: "rate-3", at: "2026-08-30T00:00:31Z" });
    expect(blocked.log.status).toBe("blocked");
    expect(blocked.log.reason).toMatch(/actions per minute/i);
    expect(blocked.state.reservedToday).toBe("200");

    expect(controller.run({ ...input, idempotencyKey: "rate-4", at: "2026-08-30T00:01:31Z" }).log.status).toBe("would-run");
  });

  it("normalizes malformed persisted automation state to safe values", () => {
    const normalized = normalizeAutomationState({
      enabled: "yes",
      mode: "live",
      schedule: "never",
      strategyName: "   ",
      openTasks: -4,
      policy: {
        maxOrderValue: "-1",
        maxDailyValue: "not-money",
        maxOpenTasks: 0,
        maxActionsPerMinute: 0,
        allowedSymbols: ["SPY", "NOT-A-SYMBOL"],
      },
      logs: [{ id: "bad", status: "would-run" }],
    });

    expect(normalized.enabled).toBe(false);
    expect(normalized.mode).toBe("dry-run");
    expect(normalized.schedule).toBe("manual");
    expect(normalized.strategyName).toBe("Scheduled review");
    expect(normalized.openTasks).toBe(0);
    expect(normalized.policy.maxOrderValue).toBe("100");
    expect(normalized.policy.maxDailyValue).toBe("500");
    expect(normalized.policy.maxOpenTasks).toBe(1);
    expect(normalized.policy.maxActionsPerMinute).toBe(6);
    expect(normalized.policy.allowedSymbols).toEqual(["SPY"]);
    expect(normalized.logs).toEqual([]);
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

  it("rejects a record with an invalid payload shape", async () => {
    await appendEvidence("order_intent", { mode: "mock", symbol: "SPY" });
    const bundle = JSON.parse(await exportEvidence()) as { records: LocalEvidenceRecord[] };
    const malformed = [{ ...bundle.records[0], payload: null }];

    expect((await verifyEvidence(malformed as never)).valid).toBe(false);
  });

  it("normalizes RFC 3339 offsets and rejects non-canonical stored timestamps", async () => {
    const record = await appendEvidence(
      "order_intent",
      { mode: "mock" },
      "0.1.0-mock",
      "2026-08-09T22:00:01+08:00",
    );
    expect(record.occurredAtUtc).toBe("2026-08-09T14:00:01.000Z");

    const bundle = JSON.parse(await exportEvidence()) as { records: LocalEvidenceRecord[] };
    const nonCanonical = [{ ...bundle.records[0], occurredAtUtc: "2026-08-09T22:00:01+08:00" }];
    expect((await verifyEvidence(nonCanonical)).valid).toBe(false);
  });

  it("rejects unknown top-level record fields instead of hashing them away", async () => {
    await appendEvidence("order_intent", { mode: "mock" });
    const bundle = JSON.parse(await exportEvidence()) as { records: LocalEvidenceRecord[] };
    const withUnexpectedField = [{ ...bundle.records[0], token: "must-not-be-stored" }];

    expect((await verifyEvidence(withUnexpectedField as never)).valid).toBe(false);
  });

  it("fails closed when local storage cannot persist an evidence record", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    await expect(appendEvidence("order_intent", { mode: "mock" })).rejects.toThrow(/could not be persisted/i);
    setItem.mockRestore();
    expect(evidenceCount()).toBe(0);
  });

  it("serializes concurrent appends into one valid evidence chain", async () => {
    const records = await Promise.all([
      appendEvidence("order_intent", { mode: "mock", symbol: "SPY" }),
      appendEvidence("mock_response", { mode: "mock", status: "working" }),
    ]);

    expect(records.map((record) => record.sequence).sort()).toEqual([1, 2]);
    expect((await verifyEvidence()).sequence).toBe(2);
    expect((await verifyEvidence()).valid).toBe(true);
  });

  it("serializes snapshots and clear behind pending journal writes", async () => {
    const append = appendEvidence("order_intent", { mode: "mock", symbol: "AAPL" });
    const exported = exportEvidence();
    const cleared = clearEvidence();

    const bundle = JSON.parse(await exported) as { records: LocalEvidenceRecord[] };
    expect(bundle.records).toHaveLength(1);
    expect(await cleared).toBe(true);
    await append;
    expect(evidenceCount()).toBe(0);
  });
});
