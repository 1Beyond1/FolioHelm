/**
 * Pure exact-Decimal target allocation & read-only rebalancing calculator.
 *
 * Security & financial invariants:
 * - Zero IEEE-754 floating-point math; all weights, values, drifts, and share
 *   counts are derived exclusively via `src/domain/decimal.ts`.
 * - Strictly requires target weights (holdings + CASH) to sum to exactly 100%.
 * - Fail-safe blocks cross-currency rebalancing when a portfolio holds multiple
 *   currencies without verified FX rates.
 * - Read-only computation only: produces single-row trade prefill hints and
 *   NEVER submits or batches orders.
 */
import {
  decimal,
  decimalAbs,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMultiply,
  decimalRound,
  decimalSubtract,
  decimalToFixed,
  money,
  percent,
  quantity,
  type DecimalString,
  type Money,
  type Percent,
  type Price,
  type Quantity,
} from "./decimal";

export const REBALANCE_CASH_SYMBOL = "CASH";

const ZERO = decimal("0");
const ZERO_MONEY = money("0");
const ZERO_PERCENT = percent("0");
const ZERO_QTY = quantity("0");
const HUNDRED = decimal("100");

export type RebalanceMode = "full-rebalance" | "cash-only-buy";

export interface RebalanceHoldingInput {
  symbol: string;
  company: string;
  shares: Quantity;
  price: Price;
  marketValue: Money;
  currency: string;
}

export interface RebalanceInput {
  holdings: readonly RebalanceHoldingInput[];
  cash: Money;
  currency: string;
  isMultiCurrency?: boolean;
  /** Target weight percentages keyed by ticker (plus optional "CASH"), e.g. { AAPL: "40", MSFT: "40", CASH: "20" }. */
  targetWeights: Readonly<Record<string, string>>;
  mode: RebalanceMode;
  /** Optional new cash contribution (exact decimal >= 0). */
  additionalCash?: string;
}

export type RebalanceErrorCode =
  | "empty-portfolio"
  | "multi-currency-blocked"
  | "invalid-weight"
  | "negative-weight"
  | "weight-sum-mismatch"
  | "invalid-additional-cash";

export type RebalanceAction = "buy" | "sell" | "hold";

export interface RebalanceSuggestion {
  symbol: string;
  company: string;
  currency: string;
  currentValue: Money;
  currentWeightPct: Percent;
  targetWeightPct: Percent;
  driftPct: Percent;
  targetValue: Money;
  /** Positive means buy/inflow, negative means sell/outflow. */
  deltaAmount: Money;
  estimatedPrice: Price | null;
  /** Whole shares truncated toward zero so buys never exceed target budget and sells never exceed owned shares. */
  estimatedShares: Quantity;
  action: RebalanceAction;
  canPrefillTrade: boolean;
}

export interface RebalancePlanResult {
  valid: boolean;
  errorCode?: RebalanceErrorCode;
  mode: RebalanceMode;
  currency: string;
  totalTargetWeightPct: Percent;
  currentPortfolioValue: Money;
  projectedPortfolioValue: Money;
  availableCash: Money;
  totalBuyAmount: Money;
  totalSellAmount: Money;
  suggestions: readonly RebalanceSuggestion[];
}

export interface PersistedRebalanceConfig {
  mode: RebalanceMode;
  additionalCash: string;
  weights: Record<string, string>;
}

/** Build default equal-weight targets summing to exactly 100.00% across holdings (0% cash). */
export function buildEqualTargetWeights(symbols: readonly string[]): Record<string, string> {
  if (symbols.length === 0) return { [REBALANCE_CASH_SYMBOL]: "100" };
  const count = decimal(String(symbols.length));
  const baseWeight = decimalDivide(HUNDRED, count, 2, "truncate");
  const weights: Record<string, string> = {};
  let running = ZERO;
  for (let i = 0; i < symbols.length; i += 1) {
    const sym = symbols[i]!;
    if (i === symbols.length - 1) {
      const remainder = decimalSubtract(HUNDRED, running);
      weights[sym] = decimalToFixed(remainder, 2, "half-up");
    } else {
      weights[sym] = decimalToFixed(baseWeight, 2, "half-up");
      running = decimalAdd(running, baseWeight);
    }
  }
  weights[REBALANCE_CASH_SYMBOL] = "0.00";
  return weights;
}

/** Build target weights matching current portfolio allocation, normalized to sum to exactly 100.00%. */
export function buildCurrentTargetWeights(
  holdings: readonly RebalanceHoldingInput[],
  cash: Money,
): Record<string, string> {
  const holdingsSum = holdings.reduce<Money>(
    (acc, item) => decimalAdd(acc, item.marketValue) as Money,
    ZERO_MONEY,
  );
  const total = decimalAdd(holdingsSum, cash) as Money;
  if (decimalCompare(total, ZERO_MONEY) <= 0) {
    return buildEqualTargetWeights(holdings.map((h) => h.symbol));
  }

  const weights: Record<string, string> = {};
  let allocated = ZERO;
  for (const h of holdings) {
    const rawPct = decimalDivide(decimalMultiply(h.marketValue, HUNDRED), total, 2, "truncate");
    weights[h.symbol] = decimalToFixed(rawPct, 2, "half-up");
    allocated = decimalAdd(allocated, rawPct);
  }
  const cashRemainder = decimalSubtract(HUNDRED, allocated);
  weights[REBALANCE_CASH_SYMBOL] = decimalToFixed(
    decimalCompare(cashRemainder, ZERO) < 0 ? ZERO : cashRemainder,
    2,
    "half-up",
  );
  return weights;
}

export function calculateRebalancePlan(input: RebalanceInput): RebalancePlanResult {
  const currency = input.currency || "USD";
  const baseResult = (
    errorCode: RebalanceErrorCode,
    totalTargetWeightPct: Percent = ZERO_PERCENT,
    currentPortfolioValue: Money = ZERO_MONEY,
    projectedPortfolioValue: Money = ZERO_MONEY,
    availableCash: Money = input.cash,
  ): RebalancePlanResult => ({
    valid: false,
    errorCode,
    mode: input.mode,
    currency,
    totalTargetWeightPct,
    currentPortfolioValue,
    projectedPortfolioValue,
    availableCash,
    totalBuyAmount: ZERO_MONEY,
    totalSellAmount: ZERO_MONEY,
    suggestions: [],
  });

  // Fail-safe: never calculate cross-currency rebalance weights without FX rates.
  const distinctCurrencies = new Set(input.holdings.map((h) => h.currency || currency));
  if (input.isMultiCurrency || currency === "MULTI" || distinctCurrencies.size > 1) {
    return baseResult("multi-currency-blocked");
  }

  let additionalCash: Money;
  try {
    const rawExtra = (input.additionalCash ?? "0").trim() || "0";
    additionalCash = decimalRound(money(rawExtra), 2, "half-even") as Money;
    if (decimalCompare(additionalCash, ZERO_MONEY) < 0) {
      return baseResult("invalid-additional-cash");
    }
  } catch {
    return baseResult("invalid-additional-cash");
  }

  const holdingsValue = input.holdings.reduce<Money>(
    (acc, item) => decimalAdd(acc, item.marketValue) as Money,
    ZERO_MONEY,
  );
  const currentPortfolioValue = decimalAdd(holdingsValue, input.cash) as Money;
  const projectedPortfolioValue = decimalAdd(currentPortfolioValue, additionalCash) as Money;
  const availableCash = decimalAdd(input.cash, additionalCash) as Money;

  if (input.holdings.length === 0 && decimalCompare(projectedPortfolioValue, ZERO_MONEY) <= 0) {
    return baseResult("empty-portfolio", ZERO_PERCENT, currentPortfolioValue, projectedPortfolioValue, availableCash);
  }

  // Parse and validate every configured target weight (holdings + CASH).
  const orderedKeys: string[] = [
    ...input.holdings.map((h) => h.symbol),
    REBALANCE_CASH_SYMBOL,
  ];
  const parsedWeights = new Map<string, Percent>();
  let totalTargetWeight: DecimalString = ZERO;

  for (const key of orderedKeys) {
    const raw = (input.targetWeights[key] ?? "0").trim() || "0";
    let parsed: Percent;
    try {
      parsed = percent(raw);
    } catch {
      return baseResult(
        "invalid-weight",
        decimalRound(totalTargetWeight, 2, "half-even") as Percent,
        currentPortfolioValue,
        projectedPortfolioValue,
        availableCash,
      );
    }
    if (decimalCompare(parsed, ZERO) < 0 || decimalCompare(parsed, HUNDRED) > 0) {
      return baseResult(
        "negative-weight",
        decimalRound(totalTargetWeight, 2, "half-even") as Percent,
        currentPortfolioValue,
        projectedPortfolioValue,
        availableCash,
      );
    }
    parsedWeights.set(key, parsed);
    totalTargetWeight = decimalAdd(totalTargetWeight, parsed);
  }

  // Check if any stray unknown key in targetWeights was provided with non-zero weight.
  for (const [key, raw] of Object.entries(input.targetWeights)) {
    if (parsedWeights.has(key)) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = percent(trimmed);
      if (decimalCompare(parsed, ZERO) < 0) {
        return baseResult(
          "negative-weight",
          decimalRound(totalTargetWeight, 2, "half-even") as Percent,
          currentPortfolioValue,
          projectedPortfolioValue,
          availableCash,
        );
      }
      totalTargetWeight = decimalAdd(totalTargetWeight, parsed);
    } catch {
      return baseResult(
        "invalid-weight",
        decimalRound(totalTargetWeight, 2, "half-even") as Percent,
        currentPortfolioValue,
        projectedPortfolioValue,
        availableCash,
      );
    }
  }

  const normalizedTotalWeight = decimalRound(totalTargetWeight, 4, "half-even") as Percent;
  if (decimalCompare(normalizedTotalWeight, HUNDRED) !== 0) {
    return baseResult(
      "weight-sum-mismatch",
      normalizedTotalWeight,
      currentPortfolioValue,
      projectedPortfolioValue,
      availableCash,
    );
  }

  if (decimalCompare(projectedPortfolioValue, ZERO_MONEY) <= 0) {
    return baseResult("empty-portfolio", normalizedTotalWeight, currentPortfolioValue, projectedPortfolioValue, availableCash);
  }

  const currentWeightOf = (value: Money): Percent =>
    decimalCompare(currentPortfolioValue, ZERO_MONEY) > 0
      ? decimalDivide(decimalMultiply(value, HUNDRED), currentPortfolioValue, 2, "half-even") as Percent
      : ZERO_PERCENT;

  const targetValueOf = (weightPct: Percent): Money =>
    decimalRound(
      decimalDivide(decimalMultiply(projectedPortfolioValue, weightPct), HUNDRED, 8, "half-even"),
      2,
      "half-even",
    ) as Money;

  const suggestions: RebalanceSuggestion[] = [];
  let totalBuyAmount = ZERO_MONEY;
  let totalSellAmount = ZERO_MONEY;

  if (input.mode === "full-rebalance") {
    for (const holding of input.holdings) {
      const targetWeightPct = parsedWeights.get(holding.symbol) ?? ZERO_PERCENT;
      const currentWeightPct = currentWeightOf(holding.marketValue);
      const driftPct = decimalSubtract(currentWeightPct, targetWeightPct) as Percent;
      const targetValue = targetValueOf(targetWeightPct);
      const deltaAmount = decimalSubtract(targetValue, holding.marketValue) as Money;

      let estimatedShares = ZERO_QTY;
      let action: RebalanceAction = "hold";
      if (decimalCompare(holding.price, ZERO) > 0 && decimalCompare(deltaAmount, ZERO_MONEY) !== 0) {
        const rawWhole = decimalDivide(decimalAbs(deltaAmount), holding.price, 0, "truncate") as Quantity;
        if (decimalCompare(deltaAmount, ZERO_MONEY) > 0) {
          estimatedShares = rawWhole;
          if (decimalCompare(estimatedShares, ZERO_QTY) > 0) {
            action = "buy";
            const execAmount = decimalRound(decimalMultiply(estimatedShares, holding.price), 2, "half-even") as Money;
            totalBuyAmount = decimalAdd(totalBuyAmount, execAmount) as Money;
          }
        } else {
          const maxSellableWhole = decimalRound(holding.shares, 0, "truncate") as Quantity;
          estimatedShares = decimalCompare(rawWhole, maxSellableWhole) > 0 ? maxSellableWhole : rawWhole;
          if (decimalCompare(estimatedShares, ZERO_QTY) > 0) {
            action = "sell";
            const execAmount = decimalRound(decimalMultiply(estimatedShares, holding.price), 2, "half-even") as Money;
            totalSellAmount = decimalAdd(totalSellAmount, execAmount) as Money;
          }
        }
      }

      suggestions.push({
        symbol: holding.symbol,
        company: holding.company,
        currency,
        currentValue: holding.marketValue,
        currentWeightPct,
        targetWeightPct,
        driftPct,
        targetValue,
        deltaAmount,
        estimatedPrice: holding.price,
        estimatedShares,
        action,
        canPrefillTrade: action !== "hold" && decimalCompare(estimatedShares, ZERO_QTY) > 0,
      });
    }

    // Cash row summary
    const cashTargetWeight = parsedWeights.get(REBALANCE_CASH_SYMBOL) ?? ZERO_PERCENT;
    const cashCurrentWeight = currentWeightOf(input.cash);
    const cashTargetValue = targetValueOf(cashTargetWeight);
    const cashDelta = decimalSubtract(cashTargetValue, availableCash) as Money;
    suggestions.push({
      symbol: REBALANCE_CASH_SYMBOL,
      company: "Cash Reserve",
      currency,
      currentValue: availableCash,
      currentWeightPct: cashCurrentWeight,
      targetWeightPct: cashTargetWeight,
      driftPct: decimalSubtract(cashCurrentWeight, cashTargetWeight) as Percent,
      targetValue: cashTargetValue,
      deltaAmount: cashDelta,
      estimatedPrice: null,
      estimatedShares: ZERO_QTY,
      action: "hold",
      canPrefillTrade: false,
    });
  } else {
    // Mode: "cash-only-buy" — NEVER generate sell actions; allocate deployable cash
    // proportionally toward underweight holdings.
    const cashTargetWeight = parsedWeights.get(REBALANCE_CASH_SYMBOL) ?? ZERO_PERCENT;
    const targetCashReserve = targetValueOf(cashTargetWeight);
    const rawDeployable = decimalSubtract(availableCash, targetCashReserve) as Money;
    const deployableCash = decimalCompare(rawDeployable, ZERO_MONEY) > 0 ? rawDeployable : ZERO_MONEY;

    const deficits = input.holdings.map((holding) => {
      const targetWeightPct = parsedWeights.get(holding.symbol) ?? ZERO_PERCENT;
      const targetValue = targetValueOf(targetWeightPct);
      const rawDiff = decimalSubtract(targetValue, holding.marketValue) as Money;
      const deficit = decimalCompare(rawDiff, ZERO_MONEY) > 0 ? rawDiff : ZERO_MONEY;
      return { holding, targetWeightPct, targetValue, deficit };
    });

    const totalDeficit = deficits.reduce<Money>(
      (acc, item) => decimalAdd(acc, item.deficit) as Money,
      ZERO_MONEY,
    );

    let remainingBudget = deployableCash;

    for (const item of deficits) {
      const currentWeightPct = currentWeightOf(item.holding.marketValue);
      const driftPct = decimalSubtract(currentWeightPct, item.targetWeightPct) as Percent;

      let allocatedBuy = ZERO_MONEY;
      if (
        decimalCompare(item.deficit, ZERO_MONEY) > 0
        && decimalCompare(deployableCash, ZERO_MONEY) > 0
        && decimalCompare(totalDeficit, ZERO_MONEY) > 0
      ) {
        if (decimalCompare(totalDeficit, deployableCash) <= 0) {
          allocatedBuy = item.deficit;
        } else {
          const proportional = decimalRound(
            decimalDivide(decimalMultiply(deployableCash, item.deficit), totalDeficit, 8, "truncate"),
            2,
            "truncate",
          ) as Money;
          allocatedBuy = decimalCompare(proportional, remainingBudget) > 0 ? remainingBudget : proportional;
        }
      }

      let estimatedShares = ZERO_QTY;
      let action: RebalanceAction = "hold";
      if (
        decimalCompare(allocatedBuy, ZERO_MONEY) > 0
        && decimalCompare(item.holding.price, ZERO) > 0
      ) {
        const whole = decimalDivide(allocatedBuy, item.holding.price, 0, "truncate") as Quantity;
        if (decimalCompare(whole, ZERO_QTY) > 0) {
          const actualSpend = decimalRound(decimalMultiply(whole, item.holding.price), 2, "half-even") as Money;
          if (decimalCompare(actualSpend, remainingBudget) <= 0) {
            estimatedShares = whole;
            action = "buy";
            remainingBudget = decimalSubtract(remainingBudget, actualSpend) as Money;
            totalBuyAmount = decimalAdd(totalBuyAmount, actualSpend) as Money;
          }
        }
      }

      suggestions.push({
        symbol: item.holding.symbol,
        company: item.holding.company,
        currency,
        currentValue: item.holding.marketValue,
        currentWeightPct,
        targetWeightPct: item.targetWeightPct,
        driftPct,
        targetValue: item.targetValue,
        deltaAmount: allocatedBuy,
        estimatedPrice: item.holding.price,
        estimatedShares,
        action,
        canPrefillTrade: action === "buy" && decimalCompare(estimatedShares, ZERO_QTY) > 0,
      });
    }

    const cashCurrentWeight = currentWeightOf(input.cash);
    const projectedCashAfterBuys = decimalSubtract(availableCash, totalBuyAmount) as Money;
    suggestions.push({
      symbol: REBALANCE_CASH_SYMBOL,
      company: "Cash Reserve",
      currency,
      currentValue: availableCash,
      currentWeightPct: cashCurrentWeight,
      targetWeightPct: cashTargetWeight,
      driftPct: decimalSubtract(cashCurrentWeight, cashTargetWeight) as Percent,
      targetValue: targetCashReserve,
      deltaAmount: decimalSubtract(projectedCashAfterBuys, availableCash) as Money,
      estimatedPrice: null,
      estimatedShares: ZERO_QTY,
      action: "hold",
      canPrefillTrade: false,
    });
  }

  return {
    valid: true,
    mode: input.mode,
    currency,
    totalTargetWeightPct: normalizedTotalWeight,
    currentPortfolioValue,
    projectedPortfolioValue,
    availableCash,
    totalBuyAmount,
    totalSellAmount,
    suggestions,
  };
}
