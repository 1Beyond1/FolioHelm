import { decimalAdd, decimalCompare, decimalMultiply, money, type Money, type Price, type Quantity } from "./decimal";
import type { BrokerOrderSide, BrokerSymbol } from "./contracts";

export type AutomationMode = "mock" | "paper" | "dry-run" | "real";
export type AutomationSchedule = "manual" | "5m" | "15m" | "hourly" | "daily";
export type AutomationRunStatus = "would-run" | "blocked" | "duplicate";

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
  openTasks: number;
  policy: AutomationPolicy;
  logs: readonly AutomationRunLog[];
}

export const DEFAULT_AUTOMATION_STATE: AutomationState = {
  enabled: false,
  mode: "dry-run",
  schedule: "manual",
  strategyName: "Scheduled review",
  killSwitchTripped: false,
  reservedToday: money("0"),
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
    policy: { ...state.policy, allowedSymbols: [...state.policy.allowedSymbols] },
    logs: [...state.logs],
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

export class AutomationController {
  private state: AutomationState;

  constructor(initial: AutomationState = DEFAULT_AUTOMATION_STATE) {
    this.state = cloneState(initial);
  }

  getState(): AutomationState {
    return cloneState(this.state);
  }

  replaceState(next: AutomationState): void {
    this.state = cloneState(next);
  }

  tripKillSwitch(): AutomationState {
    this.state = { ...this.state, killSwitchTripped: true, enabled: false };
    return this.getState();
  }

  resetKillSwitch(): AutomationState {
    this.state = { ...this.state, killSwitchTripped: false };
    return this.getState();
  }

  completeTask(): AutomationState {
    this.state = { ...this.state, openTasks: Math.max(0, this.state.openTasks - 1) };
    return this.getState();
  }

  run(
    input: {
      symbol: BrokerSymbol;
      side: BrokerOrderSide;
      quantity: Quantity;
      price: Price;
      idempotencyKey: string;
      at?: string;
    },
  ): { log: AutomationRunLog; state: AutomationState } {
    const at = input.at ?? new Date().toISOString();
    const amount = decimalMultiply(input.quantity, input.price) as Money;
    const existing = this.state.logs.find((log) => log.idempotencyKey === input.idempotencyKey);
    let status: AutomationRunStatus = "would-run";
    let reason = "Recorded locally; no broker write exists in this build";

    if (existing) {
      status = "duplicate";
      reason = "Idempotency key was already processed; no second action was created";
    } else if (!this.state.enabled) {
      status = "blocked";
      reason = "Automation is disabled";
    } else if (this.state.killSwitchTripped) {
      status = "blocked";
      reason = "Global kill switch is active";
    } else if (this.state.mode === "real") {
      status = "blocked";
      reason = "Real Trading is unavailable until the Schwab API gate is completed";
    } else if (!this.state.policy.allowedSymbols.includes(input.symbol)) {
      status = "blocked";
      reason = "Symbol is not on the explicit automation allowlist";
    } else if (decimalCompare(amount, this.state.policy.maxOrderValue) > 0) {
      status = "blocked";
      reason = "Order value exceeds the configured per-order cap";
    } else if (decimalCompare(decimalAdd(this.state.reservedToday, amount), this.state.policy.maxDailyValue) > 0) {
      status = "blocked";
      reason = "Daily value cap would be exceeded; remaining budget is frozen";
    } else if (this.state.openTasks >= this.state.policy.maxOpenTasks) {
      status = "blocked";
      reason = "Backpressure: maximum concurrent task count reached";
    }

    const log: AutomationRunLog = {
      id: `AUTO-${String(this.state.logs.length + 1).padStart(5, "0")}`,
      at,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      amount,
      mode: this.state.mode,
      status,
      reason,
      idempotencyKey: input.idempotencyKey,
    };

    this.state = {
      ...this.state,
      reservedToday: status === "would-run" ? decimalAdd(this.state.reservedToday, amount) as Money : this.state.reservedToday,
      openTasks: status === "would-run" ? this.state.openTasks + 1 : this.state.openTasks,
      logs: [log, ...this.state.logs].slice(0, 100),
    };

    return { log, state: this.getState() };
  }
}

export const AUTOMATION_CONTROLLER = new AutomationController();

export function normalizeAutomationState(value: unknown): AutomationState {
  if (!value || typeof value !== "object") return cloneState(DEFAULT_AUTOMATION_STATE);
  const candidate = value as Partial<AutomationState>;
  const policy = candidate.policy && typeof candidate.policy === "object" ? candidate.policy as Partial<AutomationPolicy> : {};
  return {
    ...cloneState(DEFAULT_AUTOMATION_STATE),
    ...candidate,
    reservedToday: safeMoney(candidate.reservedToday, DEFAULT_AUTOMATION_STATE.reservedToday),
    policy: {
      ...DEFAULT_AUTOMATION_STATE.policy,
      ...policy,
      maxOrderValue: safeMoney(policy.maxOrderValue, DEFAULT_AUTOMATION_STATE.policy.maxOrderValue),
      maxDailyValue: safeMoney(policy.maxDailyValue, DEFAULT_AUTOMATION_STATE.policy.maxDailyValue),
      allowedSymbols: Array.isArray(policy.allowedSymbols) ? policy.allowedSymbols.filter((symbol): symbol is BrokerSymbol => typeof symbol === "string") : DEFAULT_AUTOMATION_STATE.policy.allowedSymbols,
      regularSessionOnly: true,
    },
    logs: Array.isArray(candidate.logs) ? candidate.logs as AutomationRunLog[] : [],
  };
}
