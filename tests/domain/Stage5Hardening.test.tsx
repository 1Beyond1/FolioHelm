import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: tauriMocks.isTauri,
  invoke: tauriMocks.invoke,
}));

import { App } from "../../src/App";
import { InvestingHeatmap } from "../../src/components/InvestingHeatmap";
import { RealNavChart } from "../../src/components/RealNavChart";
import {
  ACCOUNT_STORE,
  ALL_ACCOUNTS_ID,
  DEFAULT_ACCOUNT_ID,
} from "../../src/domain/accounts";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../../src/domain/automation";
import {
  clearPersistedLocalPortfolio,
  commitBrokerCsv,
  loadPersistedAccountPortfolios,
  loadPersistedLocalPortfolio,
  parseCsvLocally,
  recordNavSnapshotsForPortfolio,
} from "../../src/domain/csvImport";
import { clearEvidence } from "../../src/domain/evidenceJournal";
import {
  buyingPowerForCurrency,
  findHoldingInSnapshot,
  findQuoteInSnapshot,
  MOCK_BROKER,
  MockBrokerError,
} from "../../src/domain/mockBroker";
import {
  aggregateNavSnapshotsByCurrency,
  buildCalendarHeatmapFromNav,
  computeBenchmarkTwrSeries,
  computeTwrSeries,
  decimalToMicros,
  MICROS_PER_UNIT,
  NAV_STORE,
  todayUtcIsoDate,
  type NavSnapshotRecord,
} from "../../src/domain/nav";
import { refreshPublicQuotes } from "../../src/domain/publicQuotes";
import { extractCurrencyBuckets } from "../../src/domain/rebalance";
import {
  hydrateWorkspaceFromVault,
  persistPaperOrder,
  purgeAllFrontendSensitiveMemory,
  saveWorkspacePreferences,
  WORKSPACE_PREFS_KEY,
} from "../../src/domain/vaultStorage";
import { AutomationPage } from "../../src/features/automation/AutomationPage";
import { getMarketSecurities } from "../../src/features/markets/marketsData";
import { OrdersPage } from "../../src/features/orders/OrdersPage";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { TradePage } from "../../src/features/trade/TradePage";
import { getCopy } from "../../src/i18n";
import { clearFolioHelmStored, readStored } from "../../src/platform/storage";
import { quantity as makeQty } from "../../src/domain/decimal";

function makeSnap(
  date: string,
  accountId: string,
  currency: string,
  netUnits: number,
  cfUnits = 0,
  source = "test",
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
    source,
    updatedAt: `${date}T21:00:00.000Z`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  cleanup();
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.invoke.mockReset();
  MOCK_BROKER.reset();
  ACCOUNT_STORE.clearAll();
  NAV_STORE.clearAll();
  AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
  clearFolioHelmStored();
  window.location.hash = "#/";
  await clearPersistedLocalPortfolio();
  await clearEvidence();
});

describe("Stage 5 Hardening: P0-1 & P0-2 Multi-account Paper Trading Isolation", () => {
  it("prevents ALL-view paper trades from double-counting NAV into acct_default and isolates per-account buying power/shares", async () => {
    // acct_default: $10,000 USD cash, 0 AAPL
    // acct_schwab:  $0 cash, 500 AAPL @ $200 = $100,000 (plus $10,000 cash = $110,000) -> let's use exact $90,000 total!
    // acct_default: $10,000 cash + 0 shares (via 10 shares of VOO @ $500 = $5,000 + $5,000 cash = $10,000)
    // acct_schwab:  400 shares of AAPL @ $200 = $80,000 + $10,000 cash = $90,000
    // Combined ALL = $100,000
    await ACCOUNT_STORE.createOrUpdateAccount({
      id: "acct_schwab",
      name: "Schwab Taxable",
      broker: "Schwab",
      accountType: "taxable",
      baseCurrency: "USD",
    });

    const defaultCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,Vanguard S&P 500,10,480.00,500.00,USD,5000.00\n";
    const schwabCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nAAPL,Apple Inc,400,180.00,200.00,USD,10000.00\n";

    const committedDefault = await commitBrokerCsv(defaultCsv, "default.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    const committedSchwab = await commitBrokerCsv(schwabCsv, "schwab.csv", "acct_schwab", "Schwab Taxable");
    MOCK_BROKER.applyAccountPortfolioSnapshots(
      [committedDefault.snapshot, committedSchwab.snapshot],
      { switchMode: true, selectedAccountId: ALL_ACCOUNTS_ID },
    );

    // P0-2 Fail-Closed: calling previewOrder without concrete accountId in multi-account ALL view throws!
    expect(() =>
      MOCK_BROKER.previewOrder({
        symbol: "AAPL",
        side: "sell",
        type: "market",
        quantity: makeQty("100"),
        limitPrice: null,
        currency: "USD",
      }),
    ).toThrow(MockBrokerError);

    // P0-2: acct_default has 0 AAPL -> cannot sell AAPL even though ALL has 400 AAPL!
    expect(() =>
      MOCK_BROKER.previewOrder({
        symbol: "AAPL",
        side: "sell",
        type: "market",
        quantity: makeQty("10"),
        limitPrice: null,
        currency: "USD",
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toThrow();

    // P0-2: acct_default has only $5,000 cash -> cannot buy $6,000 of VOO even though ALL has $15,000 cash!
    expect(() =>
      MOCK_BROKER.previewOrder({
        symbol: "VOO",
        side: "buy",
        type: "market",
        quantity: makeQty("12"),
        limitPrice: null,
        currency: "USD",
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toThrow(/insufficient/i);

    // P0-1 + P0-2 UI flow: open TradePage while global view is ALL -> must bind to a concrete account
    render(
      <TradePage
        language="en"
        initialSymbol="AAPL"
        initialPrefill={{ symbol: "AAPL", side: "sell", quantity: "100", orderType: "market", currency: "USD" }}
        onClose={vi.fn()}
        onViewOrders={vi.fn()}
      />,
    );

    // Auto-selects acct_schwab (which holds AAPL) in concrete target account selector
    const acctSelect = screen.getByTestId("trade-account-select") as HTMLSelectElement;
    expect(acctSelect.value).toBe("acct_schwab");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to Mock preview/i }));
    expect(screen.getByTestId("trade-preview-account")).toHaveTextContent("Schwab Taxable");
    fireEvent.click(screen.getByLabelText(/I understand this is a simulated order/i));
    fireEvent.click(screen.getByTestId("simulate-order"));

    await waitFor(() => {
      expect(screen.getByTestId("trade-receipt")).toBeInTheDocument();
    });
    expect(screen.getByTestId("trade-receipt-account")).toHaveTextContent("Schwab Taxable");

    // Verify acct_schwab now has ONLY 300 sellable AAPL (cannot double-spend remaining 400!),
    // while acct_default still has its untouched $10,000 NAV and 0 AAPL.
    const schwabAfter = MOCK_BROKER.getAccountSnapshot("acct_schwab");
    const aaplAfter = findHoldingInSnapshot(schwabAfter, "AAPL", "USD");
    expect(aaplAfter?.availableQuantity).toBe("300");

    // Verify NAV_STORE did NOT write aggregate $100,000 into acct_default or acct_schwab!
    const today = todayUtcIsoDate();
    const defaultNav = NAV_STORE.getSnapshot(today, DEFAULT_ACCOUNT_ID, "USD");
    const schwabNav = NAV_STORE.getSnapshot(today, "acct_schwab", "USD");
    expect(defaultNav?.netValueMicros).toBe(decimalToMicros("10000").toString());
    expect(schwabNav?.netValueMicros).toBe(decimalToMicros("90000").toString());

    const aggAll = aggregateNavSnapshotsByCurrency(NAV_STORE.getAllSnapshots(), "USD", ALL_ACCOUNTS_ID);
    expect(aggAll).toHaveLength(1);
    expect(aggAll[0]?.netValueMicros).toBe(decimalToMicros("100000").toString());
  });
});

describe("Stage 5 Hardening: P0-3 Lock-Epoch Barrier against In-Flight Async Races", () => {
  it("silently discards in-flight hydration, NAV, account, benchmark, and quote responses that resolve after lock", async () => {
    tauriMocks.isTauri.mockReturnValue(true);

    const navListDef = deferred<NavSnapshotRecord[]>();
    const benchListDef = deferred<unknown[]>();
    const acctListDef = deferred<unknown[]>();
    const quotesDef = deferred<{ quotes: unknown[]; fromCache: boolean; degradedReason: null; provider: string }>();
    const benchFetchDef = deferred<{ series: unknown; fromCache: boolean; degradedReason: null; provider: string }>();
    const statusDef = deferred<unknown>();

    tauriMocks.invoke.mockImplementation(async (cmd) => {
      switch (cmd) {
        case "vault_status":
          return statusDef.promise;
        case "nav_list_snapshots":
          return navListDef.promise;
        case "benchmark_load_cached":
          return benchListDef.promise;
        case "vault_list_accounts":
          return acctListDef.promise;
        case "quotes_fetch_public":
          return quotesDef.promise;
        case "benchmark_fetch_history":
          return benchFetchDef.promise;
        default:
          return null;
      }
    });

    MOCK_BROKER.setPublicQuotesEnabled(true);

    // Fire 5 concurrent async requests BEFORE lock
    const pHydrateAll = hydrateWorkspaceFromVault();
    const pNavHydrate = NAV_STORE.hydrateFromVault();
    const pAcctHydrate = ACCOUNT_STORE.hydrateAccountsFromVault();
    const pQuotes = refreshPublicQuotes("stooq");
    const pBench = NAV_STORE.syncBenchmarkHistory("SPY", "stooq");

    // User locks session while all 5 IPC requests are still in-flight!
    purgeAllFrontendSensitiveMemory();

    // Now resolve all pre-lock IPC calls with sensitive payloads
    statusDef.resolve({
      unlocked: true,
      lockState: "unlocked",
      hasLockPassphrase: true,
      retryAfterSeconds: 0,
      cipher: "AES-256-GCM",
      schemaVersion: 1,
      keyProvider: "os-keyring",
      signerPublicKey: "pub",
      evidenceCount: 1,
      hasLocalPortfolio: true,
      lockedReason: null,
    });
    navListDef.resolve([makeSnap("2026-11-22", DEFAULT_ACCOUNT_ID, "USD", 999_999)]);
    benchListDef.resolve([
      {
        symbol: "SPY",
        currency: "USD",
        provider: "stooq.com",
        asOfUtc: "2026-11-22T00:00:00.000Z",
        points: [{ date: "2026-11-22", closeMicros: "550000000" }],
      },
    ]);
    acctListDef.resolve([
      {
        id: "acct_secret",
        name: "Secret Offshore Account",
        broker: "IBKR",
        accountType: "margin",
        baseCurrency: "USD",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    quotesDef.resolve({
      quotes: [
        {
          symbol: "AAPL",
          price: "250.00",
          change: "5.00",
          changePct: "2.04",
          currency: "USD",
          provider: "stooq.com",
          asOfUtc: "2026-11-22T12:00:00.000Z",
          delayed: true,
        },
      ],
      fromCache: false,
      degradedReason: null,
      provider: "stooq.com",
    });
    benchFetchDef.resolve({
      series: {
        symbol: "SPY",
        currency: "USD",
        provider: "stooq.com",
        asOfUtc: "2026-11-22T12:00:00.000Z",
        points: [{ date: "2026-11-22", closeMicros: "555000000" }],
      },
      fromCache: false,
      degradedReason: null,
      provider: "stooq.com",
    });

    await Promise.all([pHydrateAll, pNavHydrate, pAcctHydrate, pQuotes, pBench]);

    // ZERO sensitive payloads may survive in JS RAM!
    expect(NAV_STORE.getAllSnapshots()).toHaveLength(0);
    expect(NAV_STORE.getAllBenchmarks()).toHaveLength(0);
    expect(ACCOUNT_STORE.getAccounts().some((a) => a.id === "acct_secret")).toBe(false);
    expect(MOCK_BROKER.getPublicQuoteStatus().cachedCount).toBe(0);
    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
  });
});

describe("Stage 5 Hardening: P0-4 No Stale CSV NAV Overwrite on Unlock/Restore & P0-5 Clean Clear", () => {
  it("never overwrites today's real NAV snapshot during hydrateWorkspaceFromVault or fabricates future-day CSV snapshots", async () => {
    const csv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nAAPL,Apple Inc,10,180.00,200.00,USD,0.00\n";
    const committed = await commitBrokerCsv(csv, "schwab.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    const today = todayUtcIsoDate();
    // Simulate real intraday quote refresh moving AAPL from $200 -> $230 ($2,300 NAV)
    await NAV_STORE.recordSnapshots(
      [makeSnap(today, DEFAULT_ACCOUNT_ID, "USD", 2_300, 0, "quote-refresh")],
      true,
    );
    expect(NAV_STORE.getSnapshot(today, DEFAULT_ACCOUNT_ID, "USD")?.netValueMicros).toBe(
      decimalToMicros("2300").toString(),
    );

    // Cold-start / unlock / .fhvault restore runs hydrateWorkspaceFromVault -> MUST preserve $2,300!
    await hydrateWorkspaceFromVault();
    const afterHydrate = NAV_STORE.getSnapshot(today, DEFAULT_ACCOUNT_ID, "USD");
    expect(afterHydrate?.netValueMicros).toBe(decimalToMicros("2300").toString());
    expect(afterHydrate?.source).toBe("quote-refresh");

    // Calling portfolio-load on a future date must NOT fabricate a stale CSV $2,000 point either!
    await recordNavSnapshotsForPortfolio(committed.snapshot, "portfolio-load", "2026-12-31");
    expect(NAV_STORE.getSnapshot("2026-12-31", DEFAULT_ACCOUNT_ID, "USD")).toBeNull();
  });

  it("clears MOCK_BROKER, ACCOUNT_STORE, NAV_STORE, and localStorage orders completely on clearPersistedLocalPortfolio (P0-5)", async () => {
    await ACCOUNT_STORE.createOrUpdateAccount({
      id: "acct_ira",
      name: "Schwab IRA",
      broker: "Schwab",
      accountType: "ira",
      baseCurrency: "USD",
    });
    const csv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,VOO,10,450.00,500.00,USD,5000.00\n";
    const committed = await commitBrokerCsv(csv, "ira.csv", "acct_ira", "Schwab IRA");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    const preview = MOCK_BROKER.previewOrder({
      symbol: "VOO",
      side: "buy",
      type: "market",
      quantity: makeQty("1"),
      limitPrice: null,
      currency: "USD",
      accountId: "acct_ira",
    });
    const order = MOCK_BROKER.consumePreview(preview.previewId, preview.draftHash);
    await persistPaperOrder("local-csv", order);

    expect(NAV_STORE.getAllSnapshots().length).toBeGreaterThan(0);
    await clearPersistedLocalPortfolio();

    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
    expect(NAV_STORE.getAllSnapshots()).toHaveLength(0);
    expect(ACCOUNT_STORE.getAccounts().map((a) => a.id)).toEqual([DEFAULT_ACCOUNT_ID]);

    // Re-hydrating from storage must NOT resurrect old accounts, NAV, or local orders
    await hydrateWorkspaceFromVault();
    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
    expect(NAV_STORE.getAllSnapshots()).toHaveLength(0);
    expect(ACCOUNT_STORE.getAccounts().map((a) => a.id)).toEqual([DEFAULT_ACCOUNT_ID]);
  });
});

describe("Stage 5 Hardening: P1-1..P1-10 Logic, Chart, Heatmap, Quotes, Accounts & Resilience", () => {
  it("P1-1: preserves real manual external cash flow across subsequent automatic snapshots", async () => {
    const today = todayUtcIsoDate();
    await NAV_STORE.recordSnapshots([makeSnap(today, DEFAULT_ACCOUNT_ID, "USD", 15_000, 0, "csv-import")], true);
    await NAV_STORE.recordExternalCashFlow({
      date: today,
      accountId: DEFAULT_ACCOUNT_ID,
      currency: "USD",
      cashFlowDecimal: "5000.00",
    });
    expect(NAV_STORE.getSnapshot(today, DEFAULT_ACCOUNT_ID, "USD")?.externalCashFlowMicros).toBe(
      decimalToMicros("5000").toString(),
    );

    // Subsequent automatic quote-refresh snapshot with CF = 0 preserves the recorded +$5,000 CF!
    await NAV_STORE.recordSnapshots([makeSnap(today, DEFAULT_ACCOUNT_ID, "USD", 15_500, 0, "quote-refresh")], true);
    const preserved = NAV_STORE.getSnapshot(today, DEFAULT_ACCOUNT_ID, "USD");
    expect(preserved?.netValueMicros).toBe(decimalToMicros("15500").toString());
    expect(preserved?.externalCashFlowMicros).toBe(decimalToMicros("5000").toString());
  });

  it("P1-2 & P1-6: refreshPublicQuotes records per-account 'quote-refresh' NAV snapshots; syncBenchmarkHistory respects publicQuotesEnabled switch", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "quotes_fetch_public") {
        return {
          quotes: [
            {
              symbol: "AAPL",
              price: "230.00",
              change: "30.00",
              changePct: "15.00",
              currency: "USD",
              provider: "yahoo",
              asOfUtc: "2026-11-22T15:00:00.000Z",
              delayed: true,
            },
          ],
          fromCache: false,
          degradedReason: null,
          provider: "yahoo",
        };
      }
      if (cmd === "nav_upsert_snapshots") {
        return args?.snapshots ?? [];
      }
      return null;
    });

    // P1-6: With publicQuotesEnabled OFF, syncBenchmarkHistory MUST NOT invoke backend IPC!
    MOCK_BROKER.setPublicQuotesEnabled(false);
    const blocked = await NAV_STORE.syncBenchmarkHistory("SPY", "yahoo");
    expect(blocked.fromCache).toBe(true);
    expect(blocked.degradedReason).toMatch(/disabled/i);
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("benchmark_fetch_history", expect.anything());

    // P1-2: Enable public quotes + import CSV (10 AAPL @ $200 = $2,000) -> refresh quotes ($230) -> NAV becomes $2,300 ("quote-refresh")!
    const parsed = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nAAPL,Apple Inc,10,180.00,200.00,USD,0.00\n",
      "aapl.csv",
      DEFAULT_ACCOUNT_ID,
      "Default Account",
    );
    MOCK_BROKER.applyLocalPortfolioSnapshot(parsed.snapshot, { switchMode: true });
    MOCK_BROKER.setPublicQuotesEnabled(true);

    const refreshRes = await refreshPublicQuotes("yahoo");
    expect(refreshRes.updatedCount).toBe(1);
    const todaySnap = NAV_STORE.getSnapshot(todayUtcIsoDate(), DEFAULT_ACCOUNT_ID, "USD");
    expect(todaySnap?.source).toBe("quote-refresh");
    expect(todaySnap?.netValueMicros).toBe(decimalToMicros("2300").toString());
  });

  it("P1-3 & P1-10: RealNavChart keeps benchmark overlay on window fallback, aligns late-starting benchmarks from common date, and degrades safely on corrupt micros", () => {
    const snapshots: NavSnapshotRecord[] = [
      makeSnap("2024-01-10", DEFAULT_ACCOUNT_ID, "USD", 10_000),
      makeSnap("2025-06-10", DEFAULT_ACCOUNT_ID, "USD", 11_000),
      makeSnap("2026-10-01", DEFAULT_ACCOUNT_ID, "USD", 12_000),
      makeSnap("2026-11-20", DEFAULT_ACCOUNT_ID, "USD", 13_200),
    ];
    const lateBenchmark = {
      symbol: "SPY",
      currency: "USD",
      provider: "yahoo",
      asOfUtc: "2026-11-22T00:00:00.000Z",
      points: [
        { date: "2026-10-01", closeMicros: decimalToMicros("500").toString() },
        { date: "2026-11-20", closeMicros: decimalToMicros("550").toString() },
      ],
    };

    // Pure function check: late-starting benchmark aligns from 2026-10-01 (2 points, +10.00%)
    const aligned = computeBenchmarkTwrSeries(
      snapshots.map((s) => s.date),
      lateBenchmark,
    );
    expect(aligned.alignedCount).toBe(2);
    expect(aligned.points[0]?.date).toBe("2026-10-01");
    expect(aligned.points[0]?.cumulativeTwrPct).toBe("0.00");
    expect(aligned.cumulativeTwrPct).toBe("10.00");

    // UI check: click 1W (only 1 point -> falls back to fullTwr) -> benchmark line MUST stay visible!
    const { rerender } = render(
      <RealNavChart
        copy={getCopy("en")}
        language="en"
        currency="USD"
        accountId={DEFAULT_ACCOUNT_ID}
        snapshots={snapshots}
        selectedBenchmark="SPY"
        benchmarkSeries={lateBenchmark}
        onSelectBenchmark={vi.fn()}
        onRefreshBenchmark={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("nav-period-1W"));
    expect(screen.getByTestId("nav-window-fallback-notice")).toBeInTheDocument();
    expect(screen.getByTestId("real-nav-benchmark-line")).toBeInTheDocument();
    expect(screen.getByTestId("benchmark-status-notice")).toHaveTextContent("2026-10-01");

    // P1-10: Corrupt micro-unit string renders isolated degraded notice without throwing!
    rerender(
      <RealNavChart
        copy={getCopy("en")}
        language="en"
        currency="USD"
        accountId={DEFAULT_ACCOUNT_ID}
        snapshots={[
          makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 10_000),
          { ...makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 10_500), netValueMicros: "NOT_A_NUMBER" },
        ]}
        selectedBenchmark={null}
        benchmarkSeries={null}
        onSelectBenchmark={vi.fn()}
        onRefreshBenchmark={vi.fn()}
      />,
    );
    expect(screen.getByTestId("real-nav-degraded-notice")).toBeInTheDocument();
  });

  it("P1-4: PortfolioPage refreshes on same-day NAV overwrite and syncs benchmark using user's configured quoteProvider", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    const vaultSettings: Record<string, string> = {};
    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "vault_load_setting") return vaultSettings[String(args?.key ?? "")] ?? null;
      if (cmd === "vault_save_setting") {
        vaultSettings[String(args?.key ?? "")] = String(args?.valueJson ?? "");
        return true;
      }
      if (cmd === "nav_upsert_snapshots") return args?.snapshots ?? [];
      if (cmd === "benchmark_fetch_history") {
        return {
          series: {
            symbol: "SPY",
            currency: "USD",
            provider: String(args?.provider ?? "stooq"),
            asOfUtc: "2026-11-22T00:00:00.000Z",
            points: [
              { date: "2026-11-18", closeMicros: decimalToMicros("500").toString() },
              { date: "2026-11-19", closeMicros: decimalToMicros("510").toString() },
            ],
          },
          fromCache: false,
          degradedReason: null,
          provider: String(args?.provider ?? "stooq"),
        };
      }
      return null;
    });

    const parsed = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,VOO,10,450.00,500.00,USD,5000.00\n",
      "voo.csv",
      DEFAULT_ACCOUNT_ID,
      "Default Account",
    );
    MOCK_BROKER.applyLocalPortfolioSnapshot(parsed.snapshot, { switchMode: true });
    MOCK_BROKER.setPublicQuotesEnabled(true);
    await saveWorkspacePreferences({ workspaceMode: "local-csv", publicQuotesEnabled: true, quoteProvider: "yahoo" });
    await NAV_STORE.recordSnapshots(
      [
        makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 10_000),
        makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 11_000),
      ],
      false,
    );

    render(
      <PortfolioPage language="en" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />,
    );
    expect(screen.getByTestId("real-nav-twr-stat")).toHaveTextContent("+10.00%");

    // Overwrite SAME date (2026-11-19) in-place (snapshot length unchanged = 2) -> chart MUST refresh to +20.00%!
    await act(async () => {
      await NAV_STORE.recordSnapshots(
        [makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 12_000)],
        false,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("real-nav-twr-stat")).toHaveTextContent("+20.00%");
    });

    // Sync SPY from PortfolioPage in Tauri runtime -> MUST pass configured provider "yahoo", NOT hardcoded "stooq"!
    fireEvent.click(screen.getByTestId("benchmark-opt-SPY"));
    fireEvent.click(screen.getByTestId("benchmark-sync-button"));
    await waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith("benchmark_fetch_history", {
        symbol: "SPY",
        provider: "yahoo",
      });
    });

    // Also verify App.tsx immediately picks up quoteProvider changes via WORKSPACE_PREFS_CHANGED_EVENT
    cleanup();
    tauriMocks.invoke.mockClear();
    render(<App />);
    await act(async () => {
      await saveWorkspacePreferences({ workspaceMode: "local-csv", publicQuotesEnabled: true, quoteProvider: "yahoo" });
    });
    await waitFor(() => expect(screen.getByTestId("real-nav-chart")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("benchmark-opt-SPY"));
    fireEvent.click(screen.getByTestId("benchmark-sync-button"));
    await waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith("benchmark_fetch_history", {
        symbol: "SPY",
        provider: "yahoo",
      });
    });
  });

  it("P1-5: calendar heatmap scopes yearNetChange & ordersFilled to resolvedYear, shows true year label, and renders Day 0 activity without hardcoded day 134 highlight", () => {
    const twr = computeTwrSeries(
      [
        makeSnap("2025-12-30", DEFAULT_ACCOUNT_ID, "USD", 10_000),
        makeSnap("2025-12-31", DEFAULT_ACCOUNT_ID, "USD", 15_000), // +$5,000 in 2025
        makeSnap("2026-01-02", DEFAULT_ACCOUNT_ID, "USD", 15_300), // +$300 in 2026
      ],
      "USD",
      DEFAULT_ACCOUNT_ID,
    );
    const orders = [
      {
        id: "ORD-2025",
        symbol: "AAPL",
        side: "buy" as const,
        type: "market" as const,
        quantity: makeQty("1"),
        filledQuantity: makeQty("1"),
        limitPrice: null,
        currency: "USD",
        status: "filled" as const,
        submittedAt: "2025-12-31T15:00:00.000Z",
        events: [],
      },
      {
        id: "ORD-2026",
        symbol: "AAPL",
        side: "buy" as const,
        type: "market" as const,
        quantity: makeQty("1"),
        filledQuantity: makeQty("1"),
        limitPrice: null,
        currency: "USD",
        status: "filled" as const,
        submittedAt: "2026-01-02T15:00:00.000Z",
        events: [],
      },
    ];

    const bundle2026 = buildCalendarHeatmapFromNav(twr, orders, 2026);
    expect(bundle2026.year).toBe(2026);
    expect(bundle2026.yearNetChange).toBe("300"); // ONLY 2026 P&L (+$300), NOT +$5,300!
    expect(bundle2026.ordersFilled).toBe(1); // ONLY 2026 filled order!

    // Day 0 baseline in 2025: status="no-data", actions=1, level=1
    const bundle2025 = buildCalendarHeatmapFromNav(twr, orders, 2025);
    const entries2025 = bundle2025.entries.map((e) => ({
      date: e.date,
      dataStatus: e.status,
      level: e.activityLevel,
      actions: e.actions,
      dailyReturnPct: e.dailyReturnPct === null ? null : Number(e.dailyReturnPct),
      dailyReturnUsd: e.dailyReturnUsd === null ? null : Number(e.dailyReturnUsd),
    }));

    const { container } = render(
      <InvestingHeatmap
        copy={getCopy("en")}
        language="en"
        entries={entries2025}
        activeDays={bundle2025.activeDays}
        ordersFilled={bundle2025.ordersFilled}
        netChange={Number(bundle2025.yearNetChange)}
        year={bundle2025.year}
      />,
    );

    expect(container.querySelector(".year-label")).toHaveTextContent("2025");
    expect(container.querySelector(".heat-cell.featured")).toBeNull();

    // Day 0 (2025-12-30) has 1 real activity action -> Activity mode MUST render data-level="1"
    const day0Btn = container.querySelector('[data-date="2025-12-30"] button')!;
    expect(day0Btn).toHaveAttribute("data-level", "1");

    // Switching to Return mode keeps Day 0 honestly at data-level="0" (no fabricated return!)
    fireEvent.click(screen.getByTestId("heatmap-mode-return"));
    expect(day0Btn).toHaveAttribute("data-level", "0");
  });

  it("P1-7 & P1-8: deleteAccount purges MOCK_BROKER/NAV_STORE/orders; browser CSV re-import S1->S2->S1 restores S1", async () => {
    // P1-8: S1 -> S2 -> S1 in browser mode
    const csvS1 = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,VOO,10,450.00,500.00,USD,1000.00\n";
    const csvS2 = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,VOO,10,450.00,500.00,USD,2000.00\n";
    const c1 = await commitBrokerCsv(csvS1, "s1.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    expect(c1.deduplicated).toBe(false);
    expect(c1.snapshot.cash).toBe("1000.00");

    const c2 = await commitBrokerCsv(csvS2, "s2.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    expect(c2.deduplicated).toBe(false);
    expect(c2.snapshot.cash).toBe("2000.00");

    // Re-importing S1 MUST activate S1 ($1,000), NOT silently return cached S2 ($2,000)!
    const c3 = await commitBrokerCsv(csvS1, "s1-again.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    expect(c3.deduplicated).toBe(false);
    expect(c3.snapshot.cash).toBe("1000.00");
    expect(ACCOUNT_STORE.getSnapshotForAccount(DEFAULT_ACCOUNT_ID)?.cash).toBe("1000.00");

    // Consecutive duplicate of S1 returns deduplicated = true
    const c4 = await commitBrokerCsv(csvS1, "s1-dup.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    expect(c4.deduplicated).toBe(true);

    // P1-7: deleteAccount cleans MOCK_BROKER + NAV_STORE + local orders
    await ACCOUNT_STORE.createOrUpdateAccount({
      id: "acct_temp",
      name: "Temp Schwab",
      broker: "Schwab",
      accountType: "taxable",
      baseCurrency: "USD",
    });
    const cTemp = await commitBrokerCsv(csvS2, "temp.csv", "acct_temp", "Temp Schwab");
    MOCK_BROKER.applyAccountPortfolioSnapshots([c3.snapshot, cTemp.snapshot], { switchMode: true });
    const prev = MOCK_BROKER.previewOrder({
      symbol: "VOO",
      side: "buy",
      type: "market",
      quantity: makeQty("1"),
      limitPrice: null,
      currency: "USD",
      accountId: "acct_temp",
    });
    const tempOrder = MOCK_BROKER.consumePreview(prev.previewId, prev.draftHash);
    await persistPaperOrder("local-csv", tempOrder);

    expect(MOCK_BROKER.getLocalAccountIds()).toContain("acct_temp");
    expect(NAV_STORE.getAllSnapshots().some((s) => s.accountId === "acct_temp")).toBe(true);

    const deleted = await ACCOUNT_STORE.deleteAccount("acct_temp");
    expect(deleted).toBe(true);
    expect(MOCK_BROKER.getLocalAccountIds()).not.toContain("acct_temp");
    expect(MOCK_BROKER.getSnapshot().orders.some((o) => o.accountId === "acct_temp")).toBe(false);
    expect(NAV_STORE.getAllSnapshots().some((s) => s.accountId === "acct_temp")).toBe(false);
  });

  it("P1-9: strictly matches currency without cross-currency quote fallback and shows currency + account on OrdersPage", async () => {
    const baseSnap = MOCK_BROKER.getSnapshot();
    // Requesting HKD quote for USD-only AAPL MUST return undefined (NEVER fall back to USD AAPL quote!)
    expect(findQuoteInSnapshot(baseSnap, "AAPL", "HKD")).toBeUndefined();
    expect(findHoldingInSnapshot(baseSnap, "AAPL", "HKD")).toBeUndefined();

    // Multi-currency same-symbol isolation in extractCurrencyBuckets
    const buckets = extractCurrencyBuckets(
      {
        ...baseSnap,
        holdings: [
          {
            symbol: "DUAL",
            companyEn: "Dual HK",
            companyZh: "Dual HK",
            quantity: makeQty("10"),
            availableQuantity: makeQty("10"),
            averageCost: "80.00" as never,
            marketValue: "800.00" as never,
            dayPnl: "0.00" as never,
            totalPnl: "0.00" as never,
            currency: "HKD",
          },
        ],
        quotes: [
          {
            symbol: "DUAL",
            companyEn: "Dual US",
            companyZh: "Dual US",
            price: "10.00" as never,
            change: "0.00" as never,
            changePct: "0.00" as never,
            asOf: "2026-11-22T00:00:00.000Z",
            status: "available",
            currency: "USD",
          },
        ],
      },
      "en",
    );
    const hkdBucket = buckets.find((b) => b.currency === "HKD")!;
    // Must use HKD holding's own averageCost (80), NOT USD quote (10)!
    expect(hkdBucket.holdings[0]?.price).toBe("80");

    // OrdersPage displays explicit currency + concrete account name for local paper orders
    await ACCOUNT_STORE.createOrUpdateAccount({
      id: "acct_futu_hk",
      name: "Futu HK",
      broker: "Futu",
      accountType: "taxable",
      baseCurrency: "HKD",
    });
    const hkdCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\n00700.HK,Tencent,100,320.00,400.00,HKD,50000.00\n";
    const committed = await commitBrokerCsv(hkdCsv, "futu.csv", "acct_futu_hk", "Futu HK");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });
    const prev = MOCK_BROKER.previewOrder({
      symbol: "00700.HK",
      side: "buy",
      type: "market",
      quantity: makeQty("10"),
      limitPrice: null,
      currency: "HKD",
      accountId: "acct_futu_hk",
    });
    const order = MOCK_BROKER.consumePreview(prev.previewId, prev.draftHash);

    render(<OrdersPage language="en" onOpenTrade={vi.fn()} />);
    expect(screen.getByTestId(`order-currency-${order.id}`)).toHaveTextContent("HKD");
    expect(screen.getByTestId(`order-account-${order.id}`)).toHaveTextContent("Futu HK");
  });

  it("P1-10: App stays alive and renders home cleanly even if NAV_STORE holds a corrupted micro-unit snapshot", async () => {
    const csv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,VOO,10,450.00,500.00,USD,5000.00\n";
    const committed = await commitBrokerCsv(csv, "voo.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });
    NAV_STORE.replaceAll(
      [{ ...makeSnap("2026-11-20", DEFAULT_ACCOUNT_ID, "USD", 10_000), netValueMicros: "BAD_MICROS" }],
      [],
    );

    render(<App />);
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });
});

describe("Stage 5 Recheck Closure: P0-1, P1-1, P1-2, P1-3 & P2", () => {
  it("Recheck P0-1: single-currency HKD account strictly blocks buying USD stock AAPL with $0 USD buying power and never touches ALL/acct_default USD buying power", async () => {
    await ACCOUNT_STORE.createOrUpdateAccount({
      id: "acct_futu_hk",
      name: "Futu HK",
      broker: "Futu",
      accountType: "taxable",
      baseCurrency: "HKD",
    });

    const defaultUsdCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nAAPL,Apple Inc,5,190.00,200.00,USD,1000.00\n";
    const futuHkdCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\n00700.HK,Tencent,100,320.00,400.00,HKD,100000.00\n";

    const committedDefault = await commitBrokerCsv(defaultUsdCsv, "default.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    const committedFutu = await commitBrokerCsv(futuHkdCsv, "futu.csv", "acct_futu_hk", "Futu HK");

    MOCK_BROKER.applyAccountPortfolioSnapshots(
      [committedDefault.snapshot, committedFutu.snapshot],
      { switchMode: true, selectedAccountId: ALL_ACCOUNTS_ID },
    );
    MOCK_BROKER.setPublicQuotesEnabled(true);
    MOCK_BROKER.applyPublicQuotes(
      [
        {
          symbol: "AAPL",
          price: "200.00",
          change: "2.00",
          changePct: "1.01",
          currency: "USD",
          provider: "stooq.com",
          asOfUtc: "2026-11-22T15:00:00.000Z",
          delayed: true,
        },
      ],
      "stooq.com",
    );

    const hkSnap = MOCK_BROKER.getAccountSnapshot("acct_futu_hk");
    expect(hkSnap.account.isMultiCurrency).toBe(false);
    expect(hkSnap.account.currency).toBe("HKD");
    expect(buyingPowerForCurrency(hkSnap.account, "HKD")).toBe("100000");
    expect(buyingPowerForCurrency(hkSnap.account, "USD")).toBe("0");

    // Single-currency HKD account MUST reject buying USD AAPL (even 1 share or 400 shares)
    let caughtError: unknown = null;
    try {
      MOCK_BROKER.previewOrder({
        symbol: "AAPL",
        side: "buy",
        type: "market",
        quantity: makeQty("400"),
        limitPrice: null,
        currency: "USD",
        accountId: "acct_futu_hk",
      });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(MockBrokerError);
    expect((caughtError as MockBrokerError).code).toBe("insufficient-buying-power");

    expect(() =>
      MOCK_BROKER.previewOrder({
        symbol: "AAPL",
        side: "buy",
        type: "market",
        quantity: makeQty("1"),
        limitPrice: null,
        currency: "USD",
        accountId: "acct_futu_hk",
      }),
    ).toThrow(/insufficient/i);

    // ALL-view USD buying power (from acct_default) & acct_futu_hk HKD buying power stay completely untouched
    const allSnap = MOCK_BROKER.getSnapshot();
    expect(buyingPowerForCurrency(allSnap.account, "USD")).toBe("1000");
    expect(buyingPowerForCurrency(allSnap.account, "HKD")).toBe("100000");
    expect(allSnap.orders).toHaveLength(0);

    // UI check: TradePage with acct_futu_hk + AAPL (USD) reports $0.00 USD buying power and fails buying-power check
    render(
      <TradePage
        language="en"
        initialSymbol="AAPL"
        initialPrefill={{
          symbol: "AAPL",
          side: "buy",
          quantity: "1",
          orderType: "market",
          currency: "USD",
          accountId: "acct_futu_hk",
        }}
        onClose={vi.fn()}
        onViewOrders={vi.fn()}
      />,
    );
    expect((screen.getByTestId("trade-account-select") as HTMLSelectElement).value).toBe("acct_futu_hk");
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("trade-check-buying-power")).toHaveAttribute("data-state", "blocked");
    expect(screen.getByText(/Insufficient buying power/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Continue to Mock preview/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-preview")).toBeNull();
  });

  it("Recheck P1-1: locking mid-flight during benchmark sync resets benchmarkLoading so the sync button is usable after unlock", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    const benchDef = deferred<{
      series: unknown;
      fromCache: boolean;
      degradedReason: null;
      provider: string;
    }>();

    const parsed = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,VOO,10,450.00,500.00,USD,5000.00\n",
      "voo.csv",
      DEFAULT_ACCOUNT_ID,
      "Default Account",
    );
    const snaps = [
      makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 10_000),
      makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 11_000),
    ];

    const unlockedStatus = {
      unlocked: true,
      lockState: "unlocked",
      hasLockPassphrase: false,
      retryAfterSeconds: 0,
      cipher: "AES-256-GCM",
      schemaVersion: 1,
      keyProvider: "os-keyring",
      signerPublicKey: "pub",
      evidenceCount: 1,
      hasLocalPortfolio: true,
      lockedReason: null,
    };

    const lockedStatus = {
      ...unlockedStatus,
      unlocked: false,
      lockState: "user-locked",
    };

    const prefsJson = JSON.stringify({
      workspaceMode: "local-csv",
      publicQuotesEnabled: true,
      idleLockMinutes: 15,
      quoteProvider: "stooq",
    });

    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case "vault_status":
          return unlockedStatus;
        case "vault_load_setting":
          return args?.key === WORKSPACE_PREFS_KEY ? prefsJson : null;
        case "vault_list_accounts":
          return [
            {
              id: DEFAULT_ACCOUNT_ID,
              name: "Default Account",
              broker: "Local CSV",
              accountType: "taxable",
              baseCurrency: "USD",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ];
        case "vault_load_account_portfolios":
          return [parsed.snapshot];
        case "vault_load_paper_orders":
          return [];
        case "quotes_load_cached":
          return [];
        case "nav_list_snapshots":
          return snaps;
        case "benchmark_load_cached":
          return [];
        case "benchmark_fetch_history":
          return benchDef.promise;
        case "vault_lock":
          return lockedStatus;
        case "vault_unlock":
          return unlockedStatus;
        default:
          return null;
      }
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("real-nav-chart")).toBeInTheDocument());

    // Start benchmark sync (enters loading state)
    fireEvent.click(screen.getByTestId("benchmark-opt-SPY"));
    fireEvent.click(screen.getByTestId("benchmark-sync-button"));
    expect(screen.getByTestId("benchmark-sync-button")).toBeDisabled();

    // Lock session while benchmark_fetch_history is still in-flight!
    fireEvent.click(screen.getByTestId("topbar-lock-button"));
    await waitFor(() => expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument());

    // Stale pre-lock benchmark response resolves while locked
    await act(async () => {
      benchDef.resolve({
        series: {
          symbol: "SPY",
          currency: "USD",
          provider: "stooq.com",
          asOfUtc: "2026-11-22T00:00:00.000Z",
          points: [{ date: "2026-11-19", closeMicros: "550000000" }],
        },
        fromCache: false,
        degradedReason: null,
        provider: "stooq.com",
      });
      await Promise.resolve();
    });

    // Unlock session -> benchmark sync button MUST NOT be stuck disabled!
    fireEvent.click(screen.getByTestId("app-lock-unlock-button"));
    await waitFor(() => expect(screen.getByTestId("real-nav-chart")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("benchmark-opt-SPY"));
    expect(screen.getByTestId("benchmark-sync-button")).not.toBeDisabled();
  });

  it("Recheck P1-2: lockEpoch blocks stale AutomationPage setting load and SettingsPage .fhvault post-restore hydration", async () => {
    tauriMocks.isTauri.mockReturnValue(true);

    // (A) AutomationPage: in-flight loadEncryptedSetting resolves AFTER lockEpoch bump (without unmount)
    const autoLoadDef = deferred<string | null>();
    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "vault_load_setting" && args?.key === "automation") {
        return autoLoadDef.promise;
      }
      return null;
    });

    render(<AutomationPage language="en" />);
    // Simulate vaultErrorLocked / lock epoch bump while AutomationPage stays mounted
    act(() => {
      purgeAllFrontendSensitiveMemory();
    });

    await act(async () => {
      autoLoadDef.resolve(
        JSON.stringify({
          ...DEFAULT_AUTOMATION_STATE,
          enabled: true,
          strategyName: "Stale Secret Strategy",
        }),
      );
      await Promise.resolve();
    });

    expect(AUTOMATION_CONTROLLER.getState().strategyName).toBe(DEFAULT_AUTOMATION_STATE.strategyName);
    expect(AUTOMATION_CONTROLLER.getState().enabled).toBe(false);

    // (B) SettingsPage: .fhvault restore completes AFTER lockEpoch bump -> MUST NOT call hydrateWorkspaceFromVault
    cleanup();
    const restoreDef = deferred<{ portfolioCount: number; paperOrderCount: number; evidenceCount: number }>();
    let hydrateTriggeredAfterLock = false;
    let locked = false;

    tauriMocks.invoke.mockImplementation(async (cmd) => {
      if (locked && (cmd === "vault_status" || cmd === "vault_load_account_portfolios" || cmd === "nav_list_snapshots")) {
        hydrateTriggeredAfterLock = true;
      }
      switch (cmd) {
        case "vault_status":
          return {
            unlocked: true,
            lockState: "unlocked",
            hasLockPassphrase: false,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: "pub",
            evidenceCount: 1,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        case "dialog_open_fhvault_file":
          return { fileName: "backup.fhvault", content: "{\"version\":1}" };
        case "vault_restore_backup":
          return restoreDef.promise;
        default:
          return null;
      }
    });

    render(<SettingsPage language="en" onLanguageChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("fhvault-restore-open"));
    await waitFor(() => expect(screen.getByTestId("fhvault-restore-modal")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("fhvault-choose-file"));
    await waitFor(() => expect(screen.getByTestId("fhvault-selected-name")).toHaveTextContent("backup.fhvault"));

    fireEvent.change(screen.getByTestId("fhvault-passphrase-input"), {
      target: { value: "strong-passphrase-123" },
    });
    fireEvent.click(screen.getByTestId("fhvault-modal-submit"));

    // Lock happens while vault_restore_backup is still in-flight!
    locked = true;
    purgeAllFrontendSensitiveMemory();

    await act(async () => {
      restoreDef.resolve({ portfolioCount: 2, paperOrderCount: 3, evidenceCount: 5 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hydrateTriggeredAfterLock).toBe(false);
    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
  });

  it("Recheck P1-3: browser-mode deleteAccount cleans/updates local-csv-portfolio so deleted sole account never resurrects on refresh", async () => {
    // Case 1: Only non-default account acct_schwab has an imported CSV
    await ACCOUNT_STORE.createOrUpdateAccount({
      id: "acct_schwab",
      name: "Schwab Taxable",
      broker: "Schwab",
      accountType: "taxable",
      baseCurrency: "USD",
    });
    const schwabCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nAAPL,Apple Inc,10,180.00,200.00,USD,5000.00\n";
    const committedSchwab = await commitBrokerCsv(schwabCsv, "schwab.csv", "acct_schwab", "Schwab Taxable");
    MOCK_BROKER.applyAccountPortfolioSnapshots([committedSchwab.snapshot], { switchMode: true });
    expect(readStored("local-csv-portfolio", null)).not.toBeNull();

    const deleted = await ACCOUNT_STORE.deleteAccount("acct_schwab");
    expect(deleted).toBe(true);
    expect(readStored("local-csv-portfolio", null)).toBeNull();
    expect(await loadPersistedLocalPortfolio()).toBeNull();
    expect(await loadPersistedAccountPortfolios()).toHaveLength(0);

    // Simulate full page reload -> hydrateWorkspaceFromVault MUST NOT resurrect acct_schwab!
    MOCK_BROKER.reset();
    ACCOUNT_STORE.purgeSensitiveMemory();
    NAV_STORE.purgeSensitiveMemory();
    await hydrateWorkspaceFromVault();

    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
    expect(ACCOUNT_STORE.getAllAccountSnapshots()).toHaveLength(0);
    expect(ACCOUNT_STORE.getAccounts().map((a) => a.id)).toEqual([DEFAULT_ACCOUNT_ID]);

    // Case 2: Both acct_default and acct_ibkr imported (acct_ibkr imported last -> sits in local-csv-portfolio)
    await ACCOUNT_STORE.createOrUpdateAccount({
      id: "acct_ibkr",
      name: "IBKR",
      broker: "IBKR",
      accountType: "margin",
      baseCurrency: "USD",
    });
    const defaultCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,VOO,5,450.00,500.00,USD,1000.00\n";
    const cDef = await commitBrokerCsv(defaultCsv, "def.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    const cIbkr = await commitBrokerCsv(schwabCsv, "ibkr.csv", "acct_ibkr", "IBKR");
    MOCK_BROKER.applyAccountPortfolioSnapshots([cDef.snapshot, cIbkr.snapshot], { switchMode: true });

    const beforeLegacy = await loadPersistedLocalPortfolio();
    expect(beforeLegacy?.accountId).toBe("acct_ibkr");

    await ACCOUNT_STORE.deleteAccount("acct_ibkr");
    const afterLegacy = await loadPersistedLocalPortfolio();
    expect(afterLegacy?.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("Recheck P2: getMarketSecurities strictly matches symbol|currency without cross-currency holding fallback", async () => {
    const hkdCsv = "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nDUAL,Dual HK Listing,50,80.00,90.00,HKD,0.00\n";
    const parsed = await parseCsvLocally(hkdCsv, "hk.csv", DEFAULT_ACCOUNT_ID, "Default Account");
    MOCK_BROKER.applyLocalPortfolioSnapshot(parsed.snapshot, { switchMode: true });
    const realSnap = MOCK_BROKER.getSnapshot();

    const snapSpy = vi.spyOn(MOCK_BROKER, "getSnapshot").mockReturnValue({
      ...realSnap,
      quotes: [
        ...realSnap.quotes,
        {
          symbol: "DUAL",
          companyEn: "Dual US Listing",
          companyZh: "Dual US Listing",
          price: "12.00" as never,
          change: "0.00" as never,
          changePct: "0.00" as never,
          asOf: "2026-11-22T15:00:00.000Z",
          status: "available",
          currency: "USD",
          source: "public-delayed",
        },
      ],
    });
    try {
      const securities = getMarketSecurities();
      const dualHkd = securities.find((s) => s.symbol === "DUAL" && s.currency === "HKD");
      const dualUsd = securities.find((s) => s.symbol === "DUAL" && s.currency === "USD");
      expect(dualHkd).toBeDefined();
      expect(dualHkd!.shares).toBe(50);
      expect(dualUsd).toBeDefined();
      // Strictly matched by symbol|currency: USD quote MUST NOT inherit HKD holding's 50 shares!
      expect(dualUsd!.shares).toBe(0);
      expect(dualUsd!.holdingValue).toBe(0);
      expect(dualUsd!.averageCost).toBe(0);
    } finally {
      snapSpy.mockRestore();
    }
  });
});
