import { describe, expect, it } from "vitest";
import { money, price, quantity } from "../../src/domain/decimal";
import {
  buildCurrentTargetWeights,
  buildEqualTargetWeights,
  calculateRebalancePlan,
  REBALANCE_CASH_SYMBOL,
  type RebalanceHoldingInput,
} from "../../src/domain/rebalance";

const SAMPLE_HOLDINGS: readonly RebalanceHoldingInput[] = [
  {
    symbol: "VOO",
    company: "Vanguard S&P 500 ETF",
    shares: quantity("10"),
    price: price("500.00"),
    marketValue: money("5000.00"),
    currency: "USD",
  },
  {
    symbol: "QQQ",
    company: "Invesco QQQ Trust",
    shares: quantity("10"),
    price: price("300.00"),
    marketValue: money("3000.00"),
    currency: "USD",
  },
  {
    symbol: "BRK.B",
    company: "Berkshire Hathaway B",
    shares: quantity("5"),
    price: price("400.00"),
    marketValue: money("2000.00"),
    currency: "USD",
  },
];

describe("pure Decimal target allocation & read-only rebalance calculator", () => {
  it("builds equal weights summing to exactly 100.00% even for non-divisible counts", () => {
    const weights = buildEqualTargetWeights(["VOO", "QQQ", "BRK.B"]);
    expect(weights).toEqual({
      VOO: "33.33",
      QQQ: "33.33",
      "BRK.B": "33.34",
      [REBALANCE_CASH_SYMBOL]: "0.00",
    });

    const plan = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("0.00"),
      currency: "USD",
      targetWeights: weights,
      mode: "full-rebalance",
    });
    expect(plan.valid).toBe(true);
    expect(plan.totalTargetWeightPct).toBe("100");
  });

  it("builds current weights summing to exactly 100.00%", () => {
    const weights = buildCurrentTargetWeights(SAMPLE_HOLDINGS, money("2500.00"));
    const plan = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("2500.00"),
      currency: "USD",
      targetWeights: weights,
      mode: "full-rebalance",
    });
    expect(plan.valid).toBe(true);
    expect(plan.totalTargetWeightPct).toBe("100");
  });

  it("strictly rejects target weights that do not sum to 100% or contain negative/invalid inputs", () => {
    const mismatch = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("1000.00"),
      currency: "USD",
      targetWeights: { VOO: "50", QQQ: "30", "BRK.B": "10", CASH: "5" },
      mode: "full-rebalance",
    });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errorCode).toBe("weight-sum-mismatch");
    expect(mismatch.totalTargetWeightPct).toBe("95");
    expect(mismatch.suggestions).toHaveLength(0);

    const negative = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("1000.00"),
      currency: "USD",
      targetWeights: { VOO: "110", QQQ: "-10", "BRK.B": "0", CASH: "0" },
      mode: "full-rebalance",
    });
    expect(negative.valid).toBe(false);
    expect(negative.errorCode).toBe("negative-weight");

    const invalidText = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("1000.00"),
      currency: "USD",
      targetWeights: { VOO: "abc", QQQ: "50", "BRK.B": "50", CASH: "0" },
      mode: "full-rebalance",
    });
    expect(invalidText.valid).toBe(false);
    expect(invalidText.errorCode).toBe("invalid-weight");

    const badCash = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("1000.00"),
      currency: "USD",
      targetWeights: { VOO: "40", QQQ: "40", "BRK.B": "20", CASH: "0" },
      mode: "cash-only-buy",
      additionalCash: "-500",
    });
    expect(badCash.valid).toBe(false);
    expect(badCash.errorCode).toBe("invalid-additional-cash");
  });

  it("fail-safe blocks multi-currency rebalancing without verified FX rates", () => {
    const plan = calculateRebalancePlan({
      holdings: [
        SAMPLE_HOLDINGS[0]!,
        {
          symbol: "00700.HK",
          company: "Tencent Holdings",
          shares: quantity("100"),
          price: price("400.00"),
          marketValue: money("40000.00"),
          currency: "HKD",
        },
      ],
      cash: money("0.00"),
      currency: "MULTI",
      isMultiCurrency: true,
      targetWeights: { VOO: "50", "00700.HK": "50", CASH: "0" },
      mode: "full-rebalance",
    });

    expect(plan.valid).toBe(false);
    expect(plan.errorCode).toBe("multi-currency-blocked");
    expect(plan.suggestions).toHaveLength(0);
  });

  it("computes exact full-rebalance buy/sell suggestions without float drift or overselling", () => {
    // Current: VOO $5000 (50%), QQQ $3000 (30%), BRK.B $2000 (20%), Cash $0 => Total $10,000.
    // Target: VOO 30% ($3000 => sell $2000 = 4 shares), QQQ 50% ($5000 => buy $2000 = 6 shares @ $300),
    // BRK.B 20% ($2000 => hold), Cash 0%.
    const plan = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("0.00"),
      currency: "USD",
      targetWeights: { VOO: "30", QQQ: "50", "BRK.B": "20", CASH: "0" },
      mode: "full-rebalance",
    });

    expect(plan.valid).toBe(true);
    expect(plan.projectedPortfolioValue).toBe("10000");

    const voo = plan.suggestions.find((s) => s.symbol === "VOO")!;
    expect(voo.action).toBe("sell");
    expect(voo.deltaAmount).toBe("-2000");
    expect(voo.estimatedShares).toBe("4");
    expect(voo.canPrefillTrade).toBe(true);

    const qqq = plan.suggestions.find((s) => s.symbol === "QQQ")!;
    expect(qqq.action).toBe("buy");
    expect(qqq.deltaAmount).toBe("2000");
    expect(qqq.estimatedShares).toBe("6"); // trunc(2000/300) = 6 shares, never overspends
    expect(qqq.canPrefillTrade).toBe(true);

    const brk = plan.suggestions.find((s) => s.symbol === "BRK.B")!;
    expect(brk.action).toBe("hold");
    expect(brk.estimatedShares).toBe("0");
    expect(brk.canPrefillTrade).toBe(false);

    expect(plan.totalSellAmount).toBe("2000");
    expect(plan.totalBuyAmount).toBe("1800");
  });

  it("never sells existing positions in cash-only-buy mode and respects target cash reserve", () => {
    // Current holdings = $10,000; current cash = $0; additionalCash = $2,000 => Projected total = $12,000.
    // Target: VOO 20% ($2,400 -> overweight, must NOT sell!), QQQ 40% ($4,800 -> deficit $1,800),
    // BRK.B 30% ($3,600 -> deficit $1,600), CASH 10% ($1,200 reserve -> deployable cash = $800).
    const plan = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("0.00"),
      currency: "USD",
      targetWeights: { VOO: "20", QQQ: "40", "BRK.B": "30", CASH: "10" },
      mode: "cash-only-buy",
      additionalCash: "2000.00",
    });

    expect(plan.valid).toBe(true);
    expect(plan.totalSellAmount).toBe("0");
    expect(plan.suggestions.every((s) => s.action !== "sell")).toBe(true);

    const voo = plan.suggestions.find((s) => s.symbol === "VOO")!;
    expect(voo.action).toBe("hold");
    expect(voo.estimatedShares).toBe("0");

    // Deployable cash = $800; QQQ deficit $1,800 (18/34 * 800 = $423.52 -> 1 share @ $300);
    // BRK.B deficit $1,600 (16/34 * 800 = $376.47 -> 0 shares @ $400). Total buy = $300 <= $800.
    const qqq = plan.suggestions.find((s) => s.symbol === "QQQ")!;
    expect(qqq.action).toBe("buy");
    expect(qqq.estimatedShares).toBe("1");
    expect(plan.totalBuyAmount).toBe("300");
  });

  it("handles fractional exact decimal weights without IEEE-754 0.1 + 0.2 drift", () => {
    const plan = calculateRebalancePlan({
      holdings: SAMPLE_HOLDINGS,
      cash: money("0.00"),
      currency: "USD",
      targetWeights: { VOO: "33.1", QQQ: "33.2", "BRK.B": "33.4", CASH: "0.3" },
      mode: "full-rebalance",
    });
    expect(plan.valid).toBe(true);
    expect(plan.totalTargetWeightPct).toBe("100");
  });

  it("keeps CASH row currentValue consistent with currentWeightPct (pre-contribution cash) when additionalCash > 0", () => {
    // Current holdings = $10,000, current cash = $1,000 => currentPortfolioValue = $11,000
    // Additional cash = $2,000 => projectedPortfolioValue = $13,000, availableCash = $3,000
    for (const mode of ["full-rebalance", "cash-only-buy"] as const) {
      const plan = calculateRebalancePlan({
        holdings: SAMPLE_HOLDINGS,
        cash: money("1000.00"),
        currency: "USD",
        targetWeights: { VOO: "40", QQQ: "30", "BRK.B": "20", CASH: "10" },
        mode,
        additionalCash: "2000.00",
      });
      expect(plan.valid).toBe(true);
      expect(plan.currentPortfolioValue).toBe("11000");
      expect(plan.availableCash).toBe("3000");
      const cashRow = plan.suggestions.find((s) => s.symbol === REBALANCE_CASH_SYMBOL)!;
      // CASH currentValue MUST be pre-contribution cash ($1,000), matching its 9.09% currentWeightPct
      expect(cashRow.currentValue).toBe("1000");
      expect(cashRow.currentWeightPct).toBe("9.09");
    }
  });
});
