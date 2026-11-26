import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(() => false),
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauriMocks.isTauri(),
  invoke: (cmd: string, args?: Record<string, unknown>) => tauriMocks.invoke(cmd, args),
}));

import { App } from "../../src/App";
import { SearchPalette } from "../../src/components/SearchPalette";
import { ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID } from "../../src/domain/accounts";
import { CASH_FLOW_STORE, computePnlAttribution, type CashFlowRecord } from "../../src/domain/cashFlows";
import { parseCsvLocally } from "../../src/domain/csvImport";
import { decimal, decimalAdd, decimalRound, money, price, quantity } from "../../src/domain/decimal";
import { MOCK_BROKER, mockDraftHash } from "../../src/domain/mockBroker";
import {
  aggregateNavSnapshotsByCurrency,
  computeTwrSeries,
  decimalToMicros,
  NAV_STORE,
  type NavSnapshotRecord,
} from "../../src/domain/nav";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { TradePage } from "../../src/features/trade/TradePage";
import { getCopy } from "../../src/i18n";
import type { BrokerHolding, BrokerOrder } from "../../src/domain/contracts";

function makeSnap(
  date: string,
  accountId: string,
  currency: string,
  net: number,
  cf = 0,
): NavSnapshotRecord {
  return {
    date,
    accountId,
    currency,
    netValueMicros: decimalToMicros(String(net)).toString(),
    cashMicros: "0",
    positionsMicros: decimalToMicros(String(net)).toString(),
    externalCashFlowMicros: decimalToMicros(String(cf)).toString(),
    source: "test",
    updatedAt: `${date}T21:00:00.000Z`,
  };
}

describe("v0.2.1 regression suite (P0/P1/P2)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "#/home";
    tauriMocks.isTauri.mockReturnValue(false);
    tauriMocks.invoke.mockReset();
    MOCK_BROKER.reset();
    NAV_STORE.clearAll();
    CASH_FLOW_STORE.clearAll();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    MOCK_BROKER.reset();
    NAV_STORE.clearAll();
    CASH_FLOW_STORE.clearAll();
    window.localStorage.clear();
  });

  it("P0-1: double hydration (local-csv then mock) never resets sequence or overwrites historical paper orders", async () => {
    const imported = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nAAPL,Apple Inc.,10,150.00,200.00,USD,50000.00\n",
      "p0-orders.csv",
    );
    MOCK_BROKER.applyLocalPortfolioSnapshot(imported.snapshot, { switchMode: true });

    const historicalOrder: BrokerOrder = {
      id: "PAPER-ORDER-1",
      accountId: DEFAULT_ACCOUNT_ID,
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: quantity("5"),
      filledQuantity: quantity("0"),
      limitPrice: null,
      currency: "USD",
      status: "working",
      submittedAt: "2026-11-24T10:00:00.000Z",
      events: [],
    };

    // Simulate startup / unlock double hydration: first local-csv, then empty mock ledger.
    MOCK_BROKER.hydratePaperOrders("local-csv", [historicalOrder], { replace: true });
    MOCK_BROKER.hydratePaperOrders("mock", [], { replace: true });

    const draft = {
      accountId: DEFAULT_ACCOUNT_ID,
      symbol: "AAPL",
      side: "buy" as const,
      type: "market" as const,
      quantity: quantity("2"),
      limitPrice: null,
      currency: "USD",
    };
    const preview1 = MOCK_BROKER.previewOrder(draft);
    const order1 = MOCK_BROKER.consumePreview(preview1.previewId, mockDraftHash(draft));
    const preview2 = MOCK_BROKER.previewOrder(draft);
    const order2 = MOCK_BROKER.consumePreview(preview2.previewId, mockDraftHash(draft));

    expect(order1.id).toMatch(/^PAPER-ORDER-/);
    expect(order2.id).toMatch(/^PAPER-ORDER-/);
    expect(order1.id).not.toBe("PAPER-ORDER-1");
    expect(order2.id).not.toBe("PAPER-ORDER-1");
    expect(order1.id).not.toBe(order2.id);

    const allOrders = MOCK_BROKER.getSnapshot().orders;
    expect(allOrders).toHaveLength(3);
    expect(allOrders.find((o) => o.id === "PAPER-ORDER-1")?.quantity).toBe("5");
  });

  it("P1-1: SettingsPage prompts the user to reconfigure App Lock when disaster recovery sets appLockCleared=true", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    let currentState: "error-locked" | "unlocked" = "error-locked";
    tauriMocks.invoke.mockImplementation(async (cmd) => {
      switch (cmd) {
        case "vault_status":
          return {
            unlocked: currentState === "unlocked",
            lockState: currentState,
            hasLockPassphrase: false,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: currentState === "unlocked" ? "pub-recovered" : null,
            evidenceCount: currentState === "unlocked" ? 3 : 0,
            hasLocalPortfolio: false,
            lockedReason: currentState === "error-locked" ? "OS keyring missing" : null,
          };
        case "dialog_open_fhvault_file":
          return {
            fileName: "recovery.fhvault",
            content: '{"format":"foliohelm-vault-backup"}',
          };
        case "vault_restore_backup":
          currentState = "unlocked";
          return {
            evidenceCount: 3,
            portfolioCount: 1,
            paperOrderCount: 2,
            quoteCount: 0,
            settingCount: 1,
            accountCount: 1,
            navSnapshotCount: 2,
            benchmarkCount: 0,
            cashFlowCount: 0,
            watchlistCount: 0,
            signerPublicKey: "pub-recovered",
            appLockCleared: true,
          };
        case "vault_list_accounts":
        case "vault_load_account_portfolios":
        case "vault_load_paper_orders":
        case "quotes_load_cached":
        case "nav_list_snapshots":
        case "benchmark_load_cached":
        case "vault_list_cash_flows":
        case "vault_list_watchlist":
          return [];
        default:
          return null;
      }
    });

    render(
      <SettingsPage
        language="en"
        theme="dark"
        mockScenario="healthy"
        onLanguageChange={() => {}}
        onThemeChange={() => {}}
        onMockScenarioChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("fhvault-restore-open")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("fhvault-restore-open"));
    await waitFor(() => {
      expect(screen.getByTestId("fhvault-choose-file")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("fhvault-choose-file"));
    await waitFor(() => {
      expect(screen.getByTestId("fhvault-selected-name")).toHaveTextContent("recovery.fhvault");
    });

    fireEvent.change(screen.getByTestId("fhvault-passphrase-input"), {
      target: { value: "Strong-Recovery-Pass-2026!" },
    });
    fireEvent.click(screen.getByTestId("fhvault-modal-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("fhvault-backup-status")).toBeInTheDocument();
    });
    expect(screen.getByTestId("fhvault-backup-status")).toHaveTextContent(/App Lock passphrase/i);
  });

  it("P1-2: IBKR Activity Statement Trades filters DataDiscriminator (Order, Trade, SubTotal, ClosedLot, WashSale)", async () => {
    const ibkrCsv = [
      "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee",
      'Trades,Data,Order,Stocks,USD,AAPL,"2026-11-20, 09:30:01",100,200.00,-20000.00,-1.00',
      'Trades,Data,Trade,Stocks,USD,AAPL,"2026-11-20, 09:30:02",60,200.00,-12000.00,-0.60',
      'Trades,Data,Trade,Stocks,USD,AAPL,"2026-11-20, 09:30:03",40,200.00,-8000.00,-0.40',
      "Trades,Data,SubTotal,Stocks,USD,AAPL,,100,200.00,-20000.00,-1.00",
      'Trades,Data,ClosedLot,Stocks,USD,AAPL,"2026-10-01, 10:00:00",-100,190.00,19000.00,0.00',
      'Trades,Data,WashSale,Stocks,USD,AAPL,"2026-11-20, 09:30:01",10,195.00,-1950.00,0.00',
      'Trades,Data,Trade,Stocks,USD,MSFT,"2026-11-21, 11:00:00",50,410.00,-20500.00,-1.00',
      "Trades,Data,Total,Stocks,USD,,,150,,-40500.00,-2.00",
    ].join("\n");

    const parsed = await parseCsvLocally(ibkrCsv, "ibkr-activity.csv");
    expect(parsed.snapshot.transactions).toHaveLength(2);
    expect(parsed.snapshot.transactions.find((t) => t.symbol === "AAPL")?.quantity).toBe("100");
    expect(parsed.snapshot.transactions.find((t) => t.symbol === "MSFT")?.quantity).toBe("50");
    expect(parsed.snapshot.holdings.find((h) => h.symbol === "AAPL")?.quantity).toBe("100");
    expect(parsed.snapshot.holdings.find((h) => h.symbol === "MSFT")?.quantity).toBe("50");
  });

  it("P1-4: multi-account TWR separates EOD onboarding from BOD cash flow and handles zero-start BOD inflows", () => {
    const combined = [
      makeSnap("2026-11-18", "acct_a", "USD", 10_000, 0),
      makeSnap("2026-11-19", "acct_a", "USD", 16_500, 5_000),
      makeSnap("2026-11-19", "acct_b", "USD", 20_000, 0),
    ];
    const agg = aggregateNavSnapshotsByCurrency(combined, "USD", ALL_ACCOUNTS_ID);
    expect(agg[1]?.externalCashFlowMicros).toBe(decimalToMicros("5000").toString());
    expect(agg[1]?.eodOnboardingMicros).toBe(decimalToMicros("20000").toString());

    const twr = computeTwrSeries(agg, "USD", ALL_ACCOUNTS_ID);
    // (36,500 - 20,000) / (10,000 + 5,000) = 1.10 -> +10.00% without onboarding dilution!
    expect(twr.cumulativeTwrPct).toBe("10.00");
    expect(twr.periodPnlMicros).toBe(decimalToMicros("1500").toString());

    // Zero-start BOD inflow with same-day gain: 0 -> deposit 5,000 -> end 5,500 => +10.00%
    const zeroStartGain = computeTwrSeries(
      [
        makeSnap("2026-11-18", DEFAULT_ACCOUNT_ID, "USD", 0, 0),
        makeSnap("2026-11-19", DEFAULT_ACCOUNT_ID, "USD", 5_500, 5_000),
      ],
      "USD",
      DEFAULT_ACCOUNT_ID,
    );
    expect(zeroStartGain.points[1]?.dailyReturnPct).toBe("10.00");
    expect(zeroStartGain.cumulativeTwrPct).toBe("10.00");
    expect(zeroStartGain.periodPnlMicros).toBe(decimalToMicros("500").toString());
  });

  it("P1-5: CASH_FLOW_STORE deposit/withdrawal upsert and remove synchronize NAV_STORE externalCashFlowMicros", async () => {
    const imported = await parseCsvLocally(
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency,Cash\nVOO,Vanguard S&P 500,10,500.00,500.00,USD,5000.00\n",
      "cf-sync.csv",
    );
    MOCK_BROKER.applyLocalPortfolioSnapshot(imported.snapshot, { switchMode: true });

    await NAV_STORE.recordSnapshots(
      [
        makeSnap("2026-11-20", DEFAULT_ACCOUNT_ID, "USD", 10_000, 0),
        makeSnap("2026-11-21", DEFAULT_ACCOUNT_ID, "USD", 16_500, 0),
      ],
      false,
    );

    const dep = await CASH_FLOW_STORE.upsert(
      {
        accountId: DEFAULT_ACCOUNT_ID,
        flowType: "deposit",
        symbol: null,
        currency: "USD",
        amountDecimal: "5000",
        flowDate: "2026-11-21",
        note: "Wire in",
      },
      { mode: "local-csv", language: "en" },
    );

    // NAV snapshot externalCashFlowMicros synced automatically -> TWR is +10.00% (16,500 / 15,000)
    expect(NAV_STORE.getSnapshot("2026-11-21", DEFAULT_ACCOUNT_ID, "USD")?.externalCashFlowMicros).toBe(
      decimalToMicros("5000").toString(),
    );
    expect(NAV_STORE.getTwrSeries("USD", DEFAULT_ACCOUNT_ID).cumulativeTwrPct).toBe("10.00");

    // Dividend on same date must NOT alter externalCashFlowMicros
    await CASH_FLOW_STORE.upsert(
      {
        accountId: DEFAULT_ACCOUNT_ID,
        flowType: "dividend",
        symbol: "VOO",
        currency: "USD",
        amountDecimal: "120",
        flowDate: "2026-11-21",
        note: "Quarterly dividend",
      },
      { mode: "local-csv", language: "en" },
    );
    expect(NAV_STORE.getSnapshot("2026-11-21", DEFAULT_ACCOUNT_ID, "USD")?.externalCashFlowMicros).toBe(
      decimalToMicros("5000").toString(),
    );

    // Deleting the deposit reverts externalCashFlowMicros to 0
    await CASH_FLOW_STORE.remove(dep.id, "local-csv");
    expect(NAV_STORE.getSnapshot("2026-11-21", DEFAULT_ACCOUNT_ID, "USD")?.externalCashFlowMicros).toBe("0");
  });

  it("P1-6: computePnlAttribution includes liquidated symbol and UNATTRIBUTED dividends so sum(entries) === summary", () => {
    const holdings: BrokerHolding[] = [
      {
        symbol: "AAPL",
        companyEn: "Apple Inc.",
        companyZh: "苹果",
        currency: "USD",
        quantity: quantity("10"),
        availableQuantity: quantity("10"),
        averageCost: price("150.00"),
        marketPrice: price("175.00"),
        marketValue: money("1750.00"),
        dayPnl: money("10.00"),
        totalPnl: money("250.00"),
        totalPnlPct: decimal("16.67"),
      },
    ];
    const cashFlows: CashFlowRecord[] = [
      {
        id: "cf_aapl",
        accountId: DEFAULT_ACCOUNT_ID,
        flowType: "dividend",
        symbol: "AAPL",
        currency: "USD",
        amountMicros: decimalToMicros("25.50").toString(),
        flowDate: "2026-11-15",
        note: "",
        createdAt: "2026-11-15T10:00:00.000Z",
      },
      {
        id: "cf_sold",
        accountId: DEFAULT_ACCOUNT_ID,
        flowType: "dividend",
        symbol: "KO",
        currency: "USD",
        amountMicros: decimalToMicros("42.75").toString(),
        flowDate: "2026-11-16",
        note: "Sold before snapshot",
        createdAt: "2026-11-16T10:00:00.000Z",
      },
      {
        id: "cf_unattr",
        accountId: DEFAULT_ACCOUNT_ID,
        flowType: "dividend",
        symbol: null,
        currency: "USD",
        amountMicros: decimalToMicros("18.25").toString(),
        flowDate: "2026-11-17",
        note: "Interest sweep",
        createdAt: "2026-11-17T10:00:00.000Z",
      },
    ];

    const summary = computePnlAttribution(holdings, cashFlows, "USD", "en", DEFAULT_ACCOUNT_ID);
    expect(summary.entries).toHaveLength(3);
    const koRow = summary.entries.find((e) => e.symbol === "KO");
    const unattrRow = summary.entries.find((e) => e.symbol === "UNATTRIBUTED");
    expect(koRow?.quantity).toBe("0");
    expect(koRow?.dividendsReceived).toBe("42.75");
    expect(unattrRow?.quantity).toBe("0");
    expect(unattrRow?.dividendsReceived).toBe("18.25");

    let sumUnrealized = decimal("0");
    let sumDividends = decimal("0");
    let sumCombined = decimal("0");
    for (const entry of summary.entries) {
      sumUnrealized = decimalAdd(sumUnrealized, entry.unrealizedPnl);
      sumDividends = decimalAdd(sumDividends, entry.dividendsReceived);
      sumCombined = decimalAdd(sumCombined, entry.totalContribution);
    }
    expect(decimalRound(sumUnrealized, 2, "half-up")).toBe(summary.totalUnrealizedPnl);
    expect(decimalRound(sumDividends, 2, "half-up")).toBe(summary.totalDividends);
    expect(decimalRound(sumCombined, 2, "half-up")).toBe(summary.combinedContribution);
  });

  it("P1-7: CSV infers all 24 exchange-suffix currencies and avoids ghost USD cash on non-USD files", async () => {
    const hkCsv = "Symbol,Quantity,Average Cost,Price,Cash\n00700.HK,100,320,380,15000\n";
    const hk = await parseCsvLocally(hkCsv, "hk-cash.csv");
    expect(hk.snapshot.isMultiCurrency).toBe(false);
    expect(hk.snapshot.currency).toBe("HKD");
    expect(hk.snapshot.currencies).toEqual(["HKD"]);
    expect(hk.snapshot.cash).toBe("15000.00");
    expect(hk.snapshot.cashByCurrency).toEqual({ HKD: "15000.00" });

    const globalCsv = [
      "Symbol,Quantity,Average Cost,Price",
      "7203.T,10,2500,2800",
      "HSBA.L,20,6.50,7.00",
      "SAP.DE,5,180,200",
      "RY.TO,10,130,140",
      "NESN.SW,10,85,90",
      "2330.TW,100,900,1000",
      "005930.KS,10,60000,65000",
      "TEVA.TA,10,60,65",
      "NPN.JO,5,3500,3700",
    ].join("\n");
    const globalRes = await parseCsvLocally(globalCsv, "global-24.csv");
    const bySym = new Map(globalRes.snapshot.holdings.map((h) => [h.symbol, h.currency]));
    expect(bySym.get("7203.T")).toBe("JPY");
    expect(bySym.get("HSBA.L")).toBe("GBP");
    expect(bySym.get("SAP.DE")).toBe("EUR");
    expect(bySym.get("RY.TO")).toBe("CAD");
    expect(bySym.get("NESN.SW")).toBe("CHF");
    expect(bySym.get("2330.TW")).toBe("TWD");
    expect(bySym.get("005930.KS")).toBe("KRW");
    expect(bySym.get("TEVA.TA")).toBe("ILS");
    expect(bySym.get("NPN.JO")).toBe("ZAR");
  });

  it("P1-8: App idle auto-lock reactivates after recovering from ErrorLocked to Unlocked", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    let currentState: "error-locked" | "unlocked" = "error-locked";
    const realDateNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockOffsetMs);

    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case "vault_status":
          return {
            unlocked: currentState === "unlocked",
            lockState: currentState,
            hasLockPassphrase: false,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: currentState === "unlocked" ? "pub-1" : null,
            evidenceCount: 1,
            hasLocalPortfolio: false,
            lockedReason: currentState === "error-locked" ? "Keyring cleared" : null,
          };
        case "dialog_open_fhvault_file":
          return { fileName: "backup.fhvault", content: '{"format":"foliohelm-vault-backup"}' };
        case "vault_restore_backup":
          currentState = "unlocked";
          return {
            evidenceCount: 1,
            portfolioCount: 0,
            paperOrderCount: 0,
            quoteCount: 0,
            settingCount: 1,
            signerPublicKey: "pub-1",
            appLockCleared: true,
          };
        case "vault_load_setting":
          // Keep idleLockMinutes unchanged at the default 15 so ONLY `vaultErrorLocked` changes
          // across recovery — proving `vaultErrorLocked` is in the idle-lock useEffect deps!
          if (args?.key === "workspace_preferences") {
            return JSON.stringify({
              workspaceMode: "mock",
              publicQuotesEnabled: false,
              quoteProvider: "stooq",
              idleLockMinutes: 15,
            });
          }
          return null;
        case "vault_lock":
          return {
            unlocked: false,
            lockState: "user-locked",
            hasLockPassphrase: false,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: null,
            evidenceCount: 1,
            hasLocalPortfolio: false,
            lockedReason: "Idle timeout",
          };
        case "vault_list_accounts":
        case "vault_load_account_portfolios":
        case "vault_load_paper_orders":
        case "quotes_load_cached":
        case "nav_list_snapshots":
        case "benchmark_load_cached":
        case "vault_list_cash_flows":
        case "vault_list_watchlist":
          return [];
        default:
          return null;
      }
    });

    try {
      window.location.hash = "#/settings";
      render(<App />);

      // Wait for BOTH App (persistence-warning banner -> vaultErrorLocked=true) and SettingsPage to settle.
      await waitFor(() => {
        const banner = document.querySelector(".persistence-warning");
        expect(banner).not.toBeNull();
        expect(banner?.textContent ?? "").toMatch(/Keyring cleared/i);
        expect(screen.getByTestId("fhvault-restore-open")).toBeInTheDocument();
      });

      // While in ErrorLocked, advancing past 15 min must NOT overlay LockScreen.
      clockOffsetMs += 20 * 60_000;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
      });
      expect(screen.queryByTestId("app-lock-screen")).not.toBeInTheDocument();

      // Recover from ErrorLocked -> Unlocked via .fhvault restore.
      fireEvent.click(screen.getByTestId("fhvault-restore-open"));
      await waitFor(() => {
        expect(screen.getByTestId("fhvault-choose-file")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("fhvault-choose-file"));
      await waitFor(() => {
        expect(screen.getByTestId("fhvault-selected-name")).toHaveTextContent("backup.fhvault");
      });
      fireEvent.change(screen.getByTestId("fhvault-passphrase-input"), {
        target: { value: "Recovery-Pass-2026!" },
      });
      fireEvent.click(screen.getByTestId("fhvault-modal-submit"));

      await waitFor(() => {
        expect(document.querySelector(".persistence-warning")).toBeNull();
        expect(screen.getByTestId("fhvault-backup-status")).toHaveTextContent(/App Lock passphrase/i);
      });

      // Now advance wall-clock past the 15-minute idle threshold -> idle auto-lock MUST engage!
      clockOffsetMs += 16 * 60_000;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument();
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("P2: TradePage limit input allows 6-decimal precision (step=any) and SearchPalette keys handle cross-currency symbols", async () => {
    const dualCsv = [
      "Symbol,Description,Quantity,Average Cost,Last Price,Currency",
      "DUAL,Dual Corp USD,10,10.00,12.00,USD",
      "DUAL,Dual Corp HKD,10,80.00,90.00,HKD",
    ].join("\n");
    const parsed = await parseCsvLocally(dualCsv, "dual-curr.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(parsed.snapshot, { switchMode: true });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { unmount } = render(
        <SearchPalette
          copy={getCopy("en")}
          language="en"
          onClose={() => {}}
          onOpenInstrument={() => {}}
          onOpenMarkets={() => {}}
        />,
      );
      expect(document.getElementById("search-result-DUAL-USD")).toBeInTheDocument();
      expect(document.getElementById("search-result-DUAL-HKD")).toBeInTheDocument();
      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes("same key")),
      ).toBe(false);
      unmount();
    } finally {
      errorSpy.mockRestore();
    }

    render(<TradePage language="en" initialSymbol="DUAL" onClose={() => {}} onViewOrders={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Limit$/i }));
    const limitInput = screen.getByLabelText(/Limit price/i) as HTMLInputElement;
    expect(limitInput.getAttribute("step")).toBe("any");
    expect(limitInput.getAttribute("min")).toBe("0.000001");
  });
});
