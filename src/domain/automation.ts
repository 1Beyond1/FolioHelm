import { decimalAdd, decimalCompare, decimalMultiply, money, price, quantity, type Money, type Price, type Quantity } from "./decimal";
import type { BrokerOrderSide, BrokerSymbol } from "./contracts";

const AUTOMATION_MODES: readonly AutomationMode[] = ["mock", "paper", "dry-run", "real"];
const AUTOMATION_SCHEDULES: readonly AutomationSchedule[] = ["manual", "5m", "15m", "hourly", "daily"];
const VALID_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
const ZERO_MONEY = money("0");
const RATE_WINDOW_MS = 60_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type AutomationMode = "mock" | "paper" | "dry-run" | "real";
export type AutomationSchedule = "manual" | "5m" | "15m" | "hourly" | "daily";
export type AutomationRunStatus = "would-run" | "blocked" | "duplicate";
export type AutomationMarketSession = "regular" | "closed" | "extended";

export interface AutomationPolicy {
  maxOrderValue: Money;
  maxDailyValue: Money;
  maxOpenTasks: number;
  maxActionsPerMinute: number;
  allowedSymbols: readonly BrokerSymbol[];
  regularSessionOnly: true;
}

/**
 * Immutable policy reserved for a future, separately reviewed live canary.
 * It is data-only in the Mock build: no code path can submit a live order.
 */
export interface FutureLiveCanaryPolicy {
  cumulativeNotionalCap: Money;
  maxNotionalPerOrder: Money;
  manualLimitOnly: true;
  regularSessionOnly: true;
  userSpecifiedSymbolOnly: true;
  allowOtc: false;
  allowOptions: false;
  allowLeveragedEtf: false;
  allowShortSelling: false;
  allowExtendedHours: false;
  freezeBudgetOnUnknown: true;
}

export const FUTURE_LIVE_CANARY_POLICY: FutureLiveCanaryPolicy = {
  cumulativeNotionalCap: money("1.00"),
  maxNotionalPerOrder: money("1.00"),
  manualLimitOnly: true,
  regularSessionOnly: true,
  userSpecifiedSymbolOnly: true,
  allowOtc: false,
  allowOptions: false,
  allowLeveragedEtf: false,
  allowShortSelling: false,
  allowExtendedHours: false,
  freezeBudgetOnUnknown: true,
};

export interface AutomationRunLog {
  id: string;
  at: string;
  symbol: BrokerSymbol;
  side: BrokerOrderSide;
  quantity: Quantity;
  price: Price;
  amount: Money;
  mode: AutomationMode;
  status: AutomationRunStatus;
  reason: string;
  idempotencyKey: string;
}

export interface AutomationState {
  enabled: boolean;
  mode: AutomationMode;
  schedule: AutomationSchedule;
  strategyName: string;
  killSwitchTripped: boolean;
  reservedToday: Money;
  reservedDate?: string | null;
  openTasks: number;
  policy: AutomationPolicy;
  logs: readonly AutomationRunLog[];
}

function isAutomationMode(value: unknown): value is AutomationMode {
  return typeof value === "string" && AUTOMATION_MODES.includes(value as AutomationMode);
}

function isAutomationSchedule(value: unknown): value is AutomationSchedule {
  return typeof value === "string" && AUTOMATION_SCHEDULES.includes(value as AutomationSchedule);
}

function isBrokerSymbol(value: unknown): value is BrokerSymbol {
  return typeof value === "string" && VALID_SYMBOL_RE.test(value);
}

function isBrokerOrderSide(value: unknown): value is BrokerOrderSide {
  return value === "buy" || value === "sell";
}

function isAutomationRunStatus(value: unknown): value is AutomationRunStatus {
  return value === "would-run" || value === "blocked" || value === "duplicate";
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

export const DEFAULT_AUTOMATION_STATE: AutomationState = {
  enabled: false,
  mode: "dry-run",
  schedule: "manual",
  strategyName: "Scheduled review",
  killSwitchTripped: false,
  reservedToday: money("0"),
  reservedDate: null,
  openTasks: 0,
  policy: {
    maxOrderValue: money("100.00"),
    maxDailyValue: money("500.00"),
    maxOpenTasks: 1,
    maxActionsPerMinute: 6,
    allowedSymbols: ["SPY", "AAPL", "MSFT", "NVDA"],
    regularSessionOnly: true,
  },
  logs: [],
};

function cloneState(state: AutomationState): AutomationState {
  return {
    ...state,
    reservedDate: state.reservedDate ?? null,
    policy: { ...state.policy, allowedSymbols: [...state.policy.allowedSymbols] },
    logs: state.logs.map((log) => ({ ...log })),
  };
}

function safeMoney(value: unknown, fallback: Money): Money {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = money(value);
    return decimalCompare(parsed, money("0")) < 0 ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  return value < minimum || value > maximum ? fallback : value;
}

function normalizeLog(value: unknown): AutomationRunLog | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AutomationRunLog>;
  if (
    typeof candidate.id !== "string"
    || candidate.id.trim() === ""
    || typeof candidate.at !== "string"
    || !Number.isFinite(Date.parse(candidate.at))
    || !isBrokerSymbol(candidate.symbol)
    || !isBrokerOrderSide(candidate.side)
    || !isAutomationMode(candidate.mode)
    || !isAutomationRunStatus(candidate.status)
    || typeof candidate.reason !== "string"
    || typeof candidate.idempotencyKey !== "string"
    || candidate.idempotencyKey.trim() === ""
    || typeof candidate.quantity !== "string"
    || typeof candidate.price !== "string"
    || typeof candidate.amount !== "string"
  ) return null;

  try {
    const normalizedQuantity = quantity(candidate.quantity);
    const normalizedPrice = price(candidate.price);
    const normalizedAmount = money(candidate.amount);
    if (decimalCompare(normalizedQuantity, ZERO_MONEY) <= 0 || decimalCompare(normalizedPrice, ZERO_MONEY) <= 0) return null;
    if (decimalCompare(normalizedAmount, decimalMultiply(normalizedQuantity, normalizedPrice)) !== 0) return null;
    return {
      id: candidate.id.trim().slice(0, 100),
      at: new Date(candidate.at).toISOString(),
      symbol: candidate.symbol,
      side: candidate.side,
      quantity: normalizedQuantity,
      price: normalizedPrice,
      amount: normalizedAmount,
      mode: candidate.mode,
      status: candidate.status,
      reason: candidate.reason.slice(0, 500),
      idempotencyKey: candidate.idempotencyKey.trim().slice(0, 200),
    };
  } catch {
    return null;
  }
}

function nextLogId(logs: readonly AutomationRunLog[]): string {
  const highest = logs.reduce((currentHighest, log) => {
    const match = /^AUTO-(\d+)$/.exec(log.id);
    const number = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(number) ? Math.max(currentHighest, number) : currentHighest;
  }, 0);
  return `AUTO-${String(highest + 1).padStart(5, "0")}`;
}

export class AutomationController {
  private state: AutomationState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: AutomationState = DEFAULT_AUTOMATION_STATE) {
    this.state = normalizeAutomationState(initial);
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
        // UI observers must not break local controller updates.
      }
    }
  }

  getState(): AutomationState {
    return cloneState(this.state);
  }

  replaceState(next: AutomationState): void {
    this.state = normalizeAutomationState(next);
    this.notify();
  }

  /**
   * Immediately clears sensitive automation policies, allowlists, and run logs
   * from the frontend JS heap when the session is locked or reset.
   */
  purgeSensitiveMemory(): void {
    this.state = cloneState(DEFAULT_AUTOMATION_STATE);
    this.notify();
  }

  updateState(patch: Partial<AutomationState>): AutomationState {
    this.state = normalizeAutomationState({ ...this.state, ...patch });
    this.notify();
    return this.getState();
  }

  updatePolicy(patch: Partial<AutomationPolicy>): AutomationState {
    this.state = normalizeAutomationState({
      ...this.state,
      policy: { ...this.state.policy, ...patch },
    });
    this.notify();
    return this.getState();
  }

  tripKillSwitch(): AutomationState {
    this.state = { ...this.state, killSwitchTripped: true, enabled: false };
    this.notify();
    return this.getState();
  }

  resetKillSwitch(): AutomationState {
    this.state = { ...this.state, killSwitchTripped: false };
    this.notify();
    return this.getState();
  }

  completeTask(): AutomationState {
    this.state = { ...this.state, openTasks: Math.max(0, this.state.openTasks - 1) };
    this.notify();
    return this.getState();
  }

  run(
    input: {
      symbol: BrokerSymbol;
      side: BrokerOrderSide;
      quantity: Quantity;
      price: Price;
      currency?: string;
      idempotencyKey: string;
      at?: string;
      marketSession?: AutomationMarketSession;
    },
  ): { log: AutomationRunLog; state: AutomationState } {
    const at = input.at ?? new Date().toISOString();
    const parsedAtMs = Date.parse(at);
    const atValid = Number.isFinite(parsedAtMs);
    const atDate = atValid ? new Date(parsedAtMs).toISOString().slice(0, 10) : null;
    const isNewDay = atDate !== null && this.state.reservedDate !== null && this.state.reservedDate !== atDate;
    const effectiveReservedToday = isNewDay ? ZERO_MONEY : this.state.reservedToday;

    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    const symbol = isBrokerSymbol(input.symbol) ? input.symbol : "SPY";
    const side = isBrokerOrderSide(input.side) ? input.side : "buy";
    const normalizedCurrency = typeof input.currency === "string" && input.currency.trim() !== ""
      ? input.currency.trim().toUpperCase()
      : "USD";
    let normalizedQuantity = quantity("0");
    let normalizedPrice = price("0");
    let amount = ZERO_MONEY;
    let validAmount = true;
    try {
      normalizedQuantity = quantity(input.quantity);
      normalizedPrice = price(input.price);
      amount = decimalMultiply(normalizedQuantity, normalizedPrice) as Money;
      validAmount = decimalCompare(normalizedQuantity, ZERO_MONEY) > 0 && decimalCompare(normalizedPrice, ZERO_MONEY) > 0;
    } catch {
      validAmount = false;
    }
    const existing = idempotencyKey === "" ? undefined : this.state.logs.find((log) => log.idempotencyKey === idempotencyKey);
    const marketSession = input.marketSession ?? "regular";
    let status: AutomationRunStatus = "would-run";
    let reason = "Recorded locally; no broker write exists in this build";

    if (existing) {
      status = "duplicate";
      reason = "Idempotency key was already processed; no second action was created";
    } else if (idempotencyKey === "" || !isBrokerSymbol(input.symbol) || !isBrokerOrderSide(input.side)) {
      status = "blocked";
      reason = "Order input is invalid; action was blocked";
    } else if (!this.state.enabled) {
      status = "blocked";
      reason = "Automation is disabled";
    } else if (this.state.killSwitchTripped) {
      status = "blocked";
      reason = "Global kill switch is active";
    } else if (this.state.mode === "real") {
      status = "blocked";
      reason = "Real Trading is unavailable until the Schwab API gate is completed";
    } else if (this.state.policy.regularSessionOnly && marketSession !== "regular") {
      status = "blocked";
      reason = "Regular market session is closed; automation is restricted to regular hours";
    } else if (normalizedCurrency !== "USD") {
      status = "blocked";
      reason = `Non-USD symbol (${normalizedCurrency}) is isolated from USD-denominated automation caps`;
    } else if (!validAmount) {
      status = "blocked";
      reason = "Quantity and price must be positive decimals";
    } else if (!this.state.policy.allowedSymbols.includes(input.symbol)) {
      status = "blocked";
      reason = "Symbol is not on the explicit automation allowlist";
    } else if (decimalCompare(amount, this.state.policy.maxOrderValue) > 0) {
      status = "blocked";
      reason = "Order value exceeds the configured per-order cap";
    } else if (decimalCompare(decimalAdd(effectiveReservedToday, amount), this.state.policy.maxDailyValue) > 0) {
      status = "blocked";
      reason = "Daily value cap would be exceeded; remaining budget is frozen";
    } else if (!atValid) {
      status = "blocked";
      reason = "Run timestamp is invalid; action was blocked";
    } else if (this.recentActionCount(parsedAtMs) >= this.state.policy.maxActionsPerMinute) {
      status = "blocked";
      reason = "Maximum actions per minute reached; no new action was created";
    } else if (this.state.openTasks >= this.state.policy.maxOpenTasks) {
      status = "blocked";
      reason = "Backpressure: maximum concurrent task count reached";
    }

    const log: AutomationRunLog = {
      id: nextLogId(this.state.logs),
      at,
      symbol,
      side,
      quantity: normalizedQuantity,
      price: normalizedPrice,
      amount,
      mode: this.state.mode,
      status,
      reason,
      idempotencyKey: idempotencyKey || `invalid-${nextLogId(this.state.logs)}`,
    };

    const nextReservedToday = status === "would-run"
      ? decimalAdd(effectiveReservedToday, amount) as Money
      : effectiveReservedToday;
    const nextReservedDate = atDate !== null && (status === "would-run" || isNewDay)
      ? atDate
      : this.state.reservedDate ?? null;

    this.state = {
      ...this.state,
      reservedToday: nextReservedToday,
      reservedDate: nextReservedDate,
      openTasks: status === "would-run" ? this.state.openTasks + 1 : this.state.openTasks,
      logs: [log, ...this.state.logs].slice(0, 100),
    };
    this.notify();

    return { log, state: this.getState() };
  }

  private recentActionCount(atMs: number): number {
    const windowStart = atMs - RATE_WINDOW_MS;
    return this.state.logs.filter((log) => {
      if (log.status !== "would-run") return false;
      const logAt = Date.parse(log.at);
      return Number.isFinite(logAt) && logAt > windowStart && logAt <= atMs;
    }).length;
  }
}

export const AUTOMATION_CONTROLLER = new AutomationController();

export function normalizeAutomationState(value: unknown): AutomationState {
  if (!value || typeof value !== "object") return cloneState(DEFAULT_AUTOMATION_STATE);
  const candidate = value as Partial<AutomationState>;
  const policy = candidate.policy && typeof candidate.policy === "object" ? candidate.policy as Partial<AutomationPolicy> : {};
  const allowedSymbols = Array.isArray(policy.allowedSymbols)
    ? [...new Set(policy.allowedSymbols.filter(isBrokerSymbol))]
    : [...DEFAULT_AUTOMATION_STATE.policy.allowedSymbols];
  const logs = Array.isArray(candidate.logs)
    ? candidate.logs.map(normalizeLog).filter((log): log is AutomationRunLog => log !== null).slice(0, 100)
    : [];
  const latestRunDate = logs.find((log) => log.status === "would-run")?.at.slice(0, 10) ?? null;
  const reservedDate = normalizeIsoDate(candidate.reservedDate) ?? latestRunDate;

  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_AUTOMATION_STATE.enabled,
    mode: isAutomationMode(candidate.mode) ? candidate.mode : DEFAULT_AUTOMATION_STATE.mode,
    schedule: isAutomationSchedule(candidate.schedule) ? candidate.schedule : DEFAULT_AUTOMATION_STATE.schedule,
    strategyName: typeof candidate.strategyName === "string" && candidate.strategyName.trim() !== ""
      ? candidate.strategyName.trim().slice(0, 200)
      : DEFAULT_AUTOMATION_STATE.strategyName,
    killSwitchTripped: typeof candidate.killSwitchTripped === "boolean" ? candidate.killSwitchTripped : DEFAULT_AUTOMATION_STATE.killSwitchTripped,
    reservedToday: safeMoney(candidate.reservedToday, DEFAULT_AUTOMATION_STATE.reservedToday),
    reservedDate,
    openTasks: safeInteger(candidate.openTasks, DEFAULT_AUTOMATION_STATE.openTasks, 0, 100_000),
    policy: {
      maxOrderValue: safeMoney(policy.maxOrderValue, DEFAULT_AUTOMATION_STATE.policy.maxOrderValue),
      maxDailyValue: safeMoney(policy.maxDailyValue, DEFAULT_AUTOMATION_STATE.policy.maxDailyValue),
      maxOpenTasks: safeInteger(policy.maxOpenTasks, DEFAULT_AUTOMATION_STATE.policy.maxOpenTasks, 1, 100_000),
      maxActionsPerMinute: safeInteger(policy.maxActionsPerMinute, DEFAULT_AUTOMATION_STATE.policy.maxActionsPerMinute, 1, 100_000),
      allowedSymbols,
      regularSessionOnly: true,
    },
    logs,
  };
}
