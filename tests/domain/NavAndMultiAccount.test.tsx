import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import {
  ACCOUNT_STORE,
  aggregatePortfolioSnapshots,
  ALL_ACCOUNTS_ID,
  DEFAULT_ACCOUNT_ID,
} from "../../src/domain/accounts";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../../src/domain/automation";
import { clearPersistedLocalPortfolio, commitBrokerCsv, parseCsvLocally } from "../../src/domain/csvImport";
import { money, price, quantity } from "../../src/domain/decimal";
import { clearEvidence } from "../../src/domain/evidenceJournal";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import {
  aggregateNavSnapshotsByCurrency,
  buildCalendarHeatmapFromNav,
  computeBenchmarkTwrSeries,
  computeTwrSeries,
  decimalToMicros,
  isAllowlistedBenchmark,
  MICROS_PER_UNIT,
  NAV_STORE,
  type NavSnapshotRecord,
} from "../../src/domain/nav";
import { computeCurrencyBucketAllocation } from "../../src/domain/rebalance";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";
import { clearFolioHelmStored } from "../../src/platform/storage";

afterEach(async () => {
  cleanup();
  MOCK_BROKER.reset();
  ACCOUNT_STORE.clearAll();
  NAV_STORE.clearAll();
  AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
  clearFolioHelmStored();
  window.location.hash = "#/";
  await clearPersistedLocalPortfolio();
  await clearEvidence();
});

function makeSnap(
  date: string,
  accountId: string,
  currency: string,
  netUnits: number,
  cfUnits = 0,
): NavSnapshotRecord {
  const net = BigInt(netUnits) * MICROS_PER_UNIT;
  const cf = BigInt(cfUnits) * MICROS_PER_UNIT;
  return {
    date,
    accountId,
    currency,
    netValueMicros: net.toString(),
    cashMicros: "0",
    positionsMicros: net.toString(),
    externalCashFlowMicros: cf.toString(),
    source: "test",
    updatedAt: `${date}T21:00:00.000Z`,
  };
}

describe("F1: Pure BigInt TWR, multi-account NAV aggregation & read-only benchmark alignment", () => {
  it("handles empty and single-day snapshots honestly without fabricating simulated points", () => {
    const empty = computeTwrSeries([], "USD", DEFAULT_ACCOUNT_ID);
    expect(empty.snapshotCount).toBe(0);
    expect(empty.hasEnoughPoints).toBe(false);
    expect(empty.cumulativeTwrPct).toBeNull();
    expect(empty.points).toHaveLength(0);

    const single = computeTwrSeries(
      [makeSnap("2026-11-20", DEFAULT_ACCOUNT_ID, "USD", 10_000)],
      "USD",
      DEFAULT_ACCOUNT_ID,
    );
    expect(single.snapshotCount).toBe(1);
    expect(single.hasEnoughPoints).toBe(false);
    expect(single.cumulativeTwrPct).toBeNull();
    expect(single.points[0]?.dailyReturnPct).toBeNull();
    expect(single.points[0]?.cumulativeTwrPct).toBe("0.00");
  });

  it("strips cross-day inflows and outflows cleanly via (V_end - CF) / V_start", () => {
    // Day 1: $10,000
    // Day 2: +10% gain -> $11,000 + $5,000 deposit => $16,000 (CF = +5,000)
    // Day 3: -10% loss on $16,000 -> $14,400 - $4,400 withdrawal => $10,000 (CF = -4,400)
    // Cumulative TWR = 1.10 * 0.90 - 1 = -1.00%, true P&L = -$600.00
    const series = computeTwrSeries(
      [
        makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 10_000, 0),
        makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 16_000, 5_000),
        makeSnap("2026-11-20", DEFAULT_ACCOUNT_ID, "USD", 10_000, -4_400),
      ],
      "USD",
      DEFAULT_ACCOUNT_ID,
    );
    expect(series.hasEnoughPoints).toBe(true);
    expect(series.points[1]?.dailyReturnPct).toBe("10.00");
    expect(series.points[2]?.dailyReturnPct).toBe("-10.00");
    expect(series.cumulativeTwrPct).toBe("-1.00");
    expect(series.periodPnlMicros).toBe((-600n * MICROS_PER_UNIT).toString());
  });

  it("guards against zero V_start, negative adjusted end, MULTI currency, and i128 overflow", () => {
    const zeroStart = computeTwrSeries(
      [
        makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 0, 0),
        makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 5_000, 5_000),
        makeSnap("2026-11-20", DEFAULT_ACCOUNT_ID, "USD", 5_500, 0),
      ],
      "USD",
      DEFAULT_ACCOUNT_ID,
    );
    expect(zeroStart.points[1]?.dailyReturnPct).toBeNull();
    expect(zeroStart.points[2]?.dailyReturnPct).toBe("10.00");
    expect(zeroStart.cumulativeTwrPct).toBe("10.00");

    const negativeAdjusted = computeTwrSeries(
      [
        makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 1_000, 0),
        makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 100, 500),
      ],
      "USD",
      DEFAULT_ACCOUNT_ID,
    );
    expect(negativeAdjusted.points[1]?.dailyReturnPct).toBe("-100.00");
    expect(negativeAdjusted.cumulativeTwrPct).toBe("-100.00");

    // Extreme i128 overflow throws cleanly instead of silently wrapping or turning into Infinity/NaN
    const maxI128 = ((1n << 127n) - 1n).toString();
    expect(() =>
      computeTwrSeries(
        [
          makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 1, 0),
          {
            ...makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 1, 0),
            netValueMicros: maxI128,
            externalCashFlowMicros: "-10",
          },
        ],
        "USD",
        DEFAULT_ACCOUNT_ID,
      ),
    ).toThrow(/overflow/i);

    // Cross-currency MULTI bucket is strictly forbidden
    expect(() => computeTwrSeries([], "MULTI", ALL_ACCOUNTS_ID)).toThrow(/Invalid single currency/i);
  });

  it("aggregates multiple accounts per currency without onboarding return spikes and aligns allowlisted benchmarks", () => {
    const snaps: NavSnapshotRecord[] = [
      makeSnap("2026-11-18", "acct_schwab_taxable", "USD", 10_000, 0),
      makeSnap("2026-11-19", "acct_schwab_taxable", "USD", 11_000, 0),
      // Second USD account onboarded on Day 2 with $20,000 (must NOT create fake +210% spike)
      makeSnap("2026-11-19", "acct_schwab_ira", "USD", 20_000, 0),
      // HKD account must be strictly excluded from USD bucket
      makeSnap("2026-11-19", "acct_futu_hk", "HKD", 50_000, 0),
    ];

    const aggUsd = aggregateNavSnapshotsByCurrency(snaps, "USD", ALL_ACCOUNTS_ID);
    expect(aggUsd).toHaveLength(2);
    expect(aggUsd[1]?.netValueMicros).toBe(decimalToMicros("31000").toString());
    expect(aggUsd[1]?.externalCashFlowMicros).toBe(decimalToMicros("20000").toString());

    const twr = computeTwrSeries(aggUsd, "USD", ALL_ACCOUNTS_ID);
    expect(twr.cumulativeTwrPct).toBe("10.00");

    // Allowlist check
    expect(isAllowlistedBenchmark("SPY")).toBe(true);
    expect(isAllowlistedBenchmark("QQQ")).toBe(true);
    expect(isAllowlistedBenchmark("2800.HK")).toBe(true);
    expect(isAllowlistedBenchmark("AAPL")).toBe(false);
    expect(isAllowlistedBenchmark("https://evil.example/spy")).toBe(false);

    // Benchmark TWR alignment with weekend carry-forward
    const bench = computeBenchmarkTwrSeries(["2026-11-18", "2026-11-19", "2026-11-21"], {
      symbol: "SPY",
      currency: "USD",
      provider: "stooq.com",
      asOfUtc: "2026-11-22T00:00:00.000Z",
      points: [
        { date: "2026-11-18", closeMicros: decimalToMicros("500").toString() },
        { date: "2026-11-20", closeMicros: decimalToMicros("525").toString() },
      ],
    });
    expect(bench.alignedCount).toBe(3);
    expect(bench.points[0]?.cumulativeTwrPct).toBe("0.00");
    expect(bench.points[1]?.cumulativeTwrPct).toBe("0.00");
    expect(bench.points[2]?.cumulativeTwrPct).toBe("5.00");
    expect(bench.cumulativeTwrPct).toBe("5.00");

    // Calendar heatmap populates ONLY real dates and keeps missing dates as no-data
    const heatmap = buildCalendarHeatmapFromNav(twr, [], 2026);
    const day2 = heatmap.entries.find((e) => e.date === "2026-11-19");
    const day1 = heatmap.entries.find((e) => e.date === "2026-11-18");
    const emptyDay = heatmap.entries.find((e) => e.date === "2026-01-05");
    expect(day2?.status).toBe("available");
    expect(day2?.dailyReturnPct).toBe("10");
    expect(day1?.status).toBe("no-data"); // baseline day 0 has no fabricated prior-day return
    expect(emptyDay?.status).toBe("no-data");
  });
});

describe("F2: Multi-account CSV aggregation & pure BigInt per-currency bucket allocation", () => {
  it("aggregates multiple accounts with exact weighted average cost and strict currency isolation", async () => {
    const schwabTaxable = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,Vanguard S&P 500,10,450.00,520.00,USD,2000.00\n",
      "taxable.csv",
      "acct_schwab_taxable",
      "Schwab Taxable",
    );
    const schwabIra = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,Vanguard S&P 500,30,500.00,520.00,USD,1000.00\nQQQ,Invesco QQQ,5,400.00,450.00,USD,0\n",
      "ira.csv",
      "acct_schwab_ira",
      "Schwab IRA",
    );
    const futuHk = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\n00700.HK,Tencent,100,320.00,400.00,HKD,15000.00\n",
      "futu.csv",
      "acct_futu_hk",
      "Futu HK",
    );

    const agg = aggregatePortfolioSnapshots([
      schwabTaxable.snapshot,
      schwabIra.snapshot,
      futuHk.snapshot,
    ])!;
    expect(agg.isMultiCurrency).toBe(true);
    expect(agg.currencies).toEqual(["HKD", "USD"]);
    expect(agg.cashByCurrency).toEqual({ HKD: "15000.00", USD: "3000.00" });

    const voo = agg.holdings.find((h) => h.symbol === "VOO")!;
    expect(voo.quantity).toBe("40");
    // Exact weighted average cost: (10*450 + 30*500) / 40 = 19500 / 40 = 487.5000
    expect(voo.averageCost).toBe("487.5000");

    // Per-currency bucket allocation strictly rejects mixed-currency holdings
    expect(() =>
      computeCurrencyBucketAllocation(
        [
          {
            symbol: "VOO",
            company: "VOO",
            shares: quantity("10"),
            price: price("500"),
            marketValue: money("5000"),
            currency: "USD",
          },
          {
            symbol: "00700.HK",
            company: "Tencent",
            shares: quantity("100"),
            price: price("400"),
            marketValue: money("40000"),
            currency: "HKD",
          },
        ],
        money("0"),
        "USD",
      ),
    ).toThrow(/Cross-currency allocation blocked/i);

    const usdBucket = computeCurrencyBucketAllocation(
      [
        {
          symbol: "VOO",
          company: "VOO",
          shares: quantity("10"),
          price: price("500"),
          marketValue: money("5000"),
          currency: "USD",
        },
        {
          symbol: "QQQ",
          company: "QQQ",
          shares: quantity("10"),
          price: price("300"),
          marketValue: money("3000"),
          currency: "USD",
        },
      ],
      money("2000"),
      "USD",
    );
    expect(usdBucket.slices.map((s) => [s.label, s.weightPct])).toEqual([
      ["VOO", "50"],
      ["QQQ", "30"],
      ["Cash", "20"],
    ]);
  });

  it("supports creating accounts in CSV import modal, switching All/single account, and independent per-currency donut & rebalance", async () => {
    const usdCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,Vanguard S&P 500,10,450.00,500.00,USD,2500.00\nQQQ,Invesco QQQ,10,350.00,400.00,USD,0\n";
    const hkdCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\n00700.HK,Tencent,100,320.00,400.00,HKD,10000.00\n";

    render(
      <PortfolioPage
        language="en"
        onOpenInstrument={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );

    // 1. Open CSV modal, create "Schwab Taxable" account inline, import USD CSV
    fireEvent.click(screen.getByTestId("open-csv-import"));
    fireEvent.click(screen.getByTestId("csv-toggle-new-account"));
    fireEvent.click(screen.getByTestId("csv-preset-schwab-taxable"));
    fireEvent.click(screen.getByTestId("csv-create-account-btn"));

    await waitFor(() => {
      expect(screen.queryByTestId("csv-new-account-form")).not.toBeInTheDocument();
    });

    const input1 = screen.getByTestId("csv-file-input") as HTMLInputElement;
    const file1 = new File([usdCsv], "schwab-taxable.csv", { type: "text/csv" });
    Object.defineProperty(file1, "text", { value: async () => usdCsv });
    fireEvent.change(input1, { target: { files: [file1] } });
    await waitFor(() => expect(screen.getByTestId("csv-import-preview")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-confirm-import"));
    await waitFor(() => expect(screen.getByTestId("csv-import-feedback")).toBeInTheDocument());

    // 2. Open CSV modal again, create "Futu HK" account inline, import HKD CSV
    fireEvent.click(screen.getByTestId("open-csv-import"));
    fireEvent.click(screen.getByTestId("csv-toggle-new-account"));
    fireEvent.click(screen.getByTestId("csv-preset-futu-hk"));
    fireEvent.click(screen.getByTestId("csv-create-account-btn"));
    await waitFor(() => {
      expect(screen.queryByTestId("csv-new-account-form")).not.toBeInTheDocument();
    });

    const input2 = screen.getByTestId("csv-file-input") as HTMLInputElement;
    const file2 = new File([hkdCsv], "futu-hk.csv", { type: "text/csv" });
    Object.defineProperty(file2, "text", { value: async () => hkdCsv });
    fireEvent.change(input2, { target: { files: [file2] } });
    await waitFor(() => expect(screen.getByTestId("csv-import-preview")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-confirm-import"));
    await waitFor(() => expect(screen.getByTestId("portfolio-holding-row-00700.HK")).toBeInTheDocument());

    // 3. All Accounts view shows both USD & HKD isolated subtotals + currency bucket tabs for donut & rebalance
    expect(screen.getByTestId("multi-currency-notice")).toBeInTheDocument();
    expect(screen.getByTestId("currency-summary-USD")).toBeInTheDocument();
    expect(screen.getByTestId("currency-summary-HKD")).toBeInTheDocument();
    expect(screen.getByTestId("allocation-currency-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("rebalance-currency-tabs")).toBeInTheDocument();

    // Switch bucket tab to USD -> donut & rebalance show ONLY VOO, QQQ, Cash (never 00700.HK!)
    fireEvent.click(screen.getByTestId("allocation-bucket-tab-USD"));
    expect(screen.getByTestId("portfolio-allocation-donut")).toHaveAttribute("data-currency", "USD");
    expect(screen.getByTestId("portfolio-allocation-list")).toHaveTextContent("VOO");
    expect(screen.getByTestId("portfolio-allocation-list")).not.toHaveTextContent("00700.HK");
    expect(screen.getByTestId("rebalance-row-VOO")).toBeInTheDocument();
    expect(screen.queryByTestId("rebalance-row-00700.HK")).not.toBeInTheDocument();

    // Switch bucket tab to HKD -> donut & rebalance show ONLY 00700.HK, Cash (never VOO!)
    fireEvent.click(screen.getByTestId("rebalance-bucket-tab-HKD"));
    expect(screen.getByTestId("portfolio-allocation-donut")).toHaveAttribute("data-currency", "HKD");
    expect(screen.getByTestId("portfolio-allocation-list")).toHaveTextContent("00700.HK");
    expect(screen.getByTestId("portfolio-allocation-list")).not.toHaveTextContent("VOO");
    expect(screen.getByTestId("rebalance-row-00700.HK")).toBeInTheDocument();
    expect(screen.queryByTestId("rebalance-row-VOO")).not.toBeInTheDocument();

    // 4. Switch Account Switcher to single account "Futu HK" -> only 00700.HK appears in holdings table
    const switcher = screen.getByTestId("portfolio-account-switcher") as HTMLSelectElement;
    const futuOption = [...switcher.options].find((o) => o.textContent?.includes("Futu HK"))!;
    fireEvent.change(switcher, { target: { value: futuOption.value } });
    expect(screen.getByTestId("portfolio-holding-row-00700.HK")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-holding-row-VOO")).not.toBeInTheDocument();
  });
});

describe("F1 + Security: Dashboard Real NAV Curve, Benchmark TWR Overlay & Lock-Screen Memory Wipe", () => {
  it("shows honest < 2 accumulation notice first, unlocks real NAV + SPY TWR chart at >= 2 points, degrades offline gracefully, and wipes NAV/accounts/benchmark heap on lock", async () => {
    const usdCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,Vanguard S&P 500,10,450.00,500.00,USD,5000.00\n";
    const committed = await commitBrokerCsv(usdCsv, "schwab.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    const { rerender } = render(<App />);

    // 1. With only 1 real snapshot recorded on CSV commit, Dashboard NEVER fabricates a curve!
    expect(screen.getByTestId("hero-local-baseline")).toBeInTheDocument();
    expect(screen.getByTestId("nav-snapshot-count")).toHaveTextContent("1 / 2");
    expect(screen.getByTestId("heatmap-accumulation-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("real-nav-chart")).not.toBeInTheDocument();

    // 2. Record 2 additional real historical dates + cache SPY benchmark -> real NAV & TWR chart unlocks!
    await act(async () => {
      await NAV_STORE.recordSnapshots(
        [
          makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 10_000, 0),
          makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 11_000, 0),
          makeSnap("2026-11-20", DEFAULT_ACCOUNT_ID, "USD", 12_100, 0),
        ],
        false,
      );
      NAV_STORE.cacheBenchmarkLocally({
        symbol: "SPY",
        currency: "USD",
        provider: "stooq.com",
        asOfUtc: "2026-11-22T00:00:00.000Z",
        points: [
          { date: "2026-11-18", closeMicros: decimalToMicros("500").toString() },
          { date: "2026-11-19", closeMicros: decimalToMicros("510").toString() },
          { date: "2026-11-20", closeMicros: decimalToMicros("525").toString() },
        ],
      });
    });
    rerender(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("real-nav-chart")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("heatmap-accumulation-notice")).not.toBeInTheDocument();

    // Select SPY benchmark overlay -> renders benchmark dashed line & legend
    fireEvent.click(screen.getByTestId("benchmark-opt-SPY"));
    expect(screen.getByTestId("real-nav-benchmark-line")).toBeInTheDocument();
    expect(screen.getByTestId("real-nav-legend")).toHaveTextContent("SPY");

    // Clicking Sync SPY in browser/offline mode degrades gracefully without crashing
    fireEvent.click(screen.getByTestId("benchmark-sync-button"));
    await waitFor(() => {
      expect(screen.getByTestId("benchmark-status-notice")).toBeInTheDocument();
    });

    // 3. Locking session MUST synchronously wipe NAV_STORE, ACCOUNT_STORE, and benchmark cache from JS RAM!
    await ACCOUNT_STORE.createOrUpdateAccount({
      name: "Secret Private IRA",
      broker: "Schwab",
      accountType: "ira",
      baseCurrency: "USD",
    });
    expect(NAV_STORE.getAllSnapshots().length).toBeGreaterThanOrEqual(3);
    expect(NAV_STORE.getAllBenchmarks()).toHaveLength(1);
    expect(ACCOUNT_STORE.getAccounts().some((a) => a.name === "Secret Private IRA")).toBe(true);

    fireEvent.click(screen.getByTestId("topbar-lock-button"));
    await waitFor(() => {
      expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument();
    });

    expect(NAV_STORE.getAllSnapshots()).toHaveLength(0);
    expect(NAV_STORE.getAllBenchmarks()).toHaveLength(0);
    expect(ACCOUNT_STORE.getAllAccountSnapshots()).toHaveLength(0);
    expect(ACCOUNT_STORE.getAccounts().some((a) => a.name === "Secret Private IRA")).toBe(false);
    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
  });
});
