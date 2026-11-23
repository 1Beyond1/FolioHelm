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
import { ACCOUNT_STORE, DEFAULT_ACCOUNT_ID } from "../../src/domain/accounts";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../../src/domain/automation";
import {
  CASH_FLOW_STORE,
  computePnlAttribution,
  summarizeCashFlowsForBucket,
} from "../../src/domain/cashFlows";
import { clearPersistedLocalPortfolio, commitBrokerCsv, parseCsvLocally } from "../../src/domain/csvImport";
import { decimal, decimalAdd } from "../../src/domain/decimal";
import { clearEvidence, exportEvidence } from "../../src/domain/evidenceJournal";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { NAV_STORE } from "../../src/domain/nav";
import {
  buildPortfolioReportInputFromStores,
  escapeCsvCell,
  generatePortfolioCsvReport,
  generatePortfolioMarkdownReport,
  sanitizeSensitiveReportText,
} from "../../src/domain/portfolioReport";
import {
  purgeAllFrontendSensitiveMemory,
  saveWorkspacePreferences,
  WORKSPACE_PREFS_KEY,
} from "../../src/domain/vaultStorage";
import { evaluateWatchlistItem, microsToDisplayDecimal, WATCHLIST_STORE } from "../../src/domain/watchlist";
import { refreshPublicQuotes } from "../../src/domain/publicQuotes";
import { MarketsPage } from "../../src/features/markets/MarketsPage";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { TradePage } from "../../src/features/trade/TradePage";
import { clearFolioHelmStored, readStored } from "../../src/platform/storage";

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
  CASH_FLOW_STORE.clearAll();
  WATCHLIST_STORE.clearAll();
  AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
  clearFolioHelmStored();
  window.location.hash = "#/";
  await clearPersistedLocalPortfolio();
  await clearEvidence();
});

describe("Stage 6 P1 & P2 Hardening", () => {
  it("P1-2: mid-flight App Lock during .fhvault export discards result and never opens native save dialog", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    const exportGate = deferred<string>();
    tauriMocks.invoke.mockImplementation(async (cmd) => {
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
            signerPublicKey: "pub-1",
            evidenceCount: 1,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        case "vault_load_setting":
          return null;
        case "vault_export_backup":
          return exportGate.promise;
        case "dialog_save_fhvault_file":
          return "D:\\should-never-be-called.fhvault";
        default:
          return null;
      }
    });

    render(<SettingsPage language="en" onLanguageChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId("fhvault-export-open"));
    fireEvent.change(screen.getByTestId("fhvault-passphrase-input"), { target: { value: "Strong-Backup-Pass-2026!" } });
    fireEvent.change(screen.getByTestId("fhvault-passphrase-confirm"), { target: { value: "Strong-Backup-Pass-2026!" } });
    fireEvent.click(screen.getByTestId("fhvault-modal-submit"));

    // Lock advances lockEpoch while vault_export_backup is still in flight
    purgeAllFrontendSensitiveMemory();

    await act(async () => {
      exportGate.resolve("{\"encrypted\":true}");
      await Promise.resolve();
    });

    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "dialog_save_fhvault_file",
      expect.anything(),
    );
  });

  it("P1-3: blocks Unlock while Tauri lock IPC is in flight and syncs hasLockPassphrase immediately from Settings", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    const lockGate = deferred<Record<string, unknown>>();
    let passphraseConfigured = false;

    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case "vault_status":
          return {
            unlocked: true,
            lockState: "unlocked",
            hasLockPassphrase: passphraseConfigured,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: "pub-1",
            evidenceCount: 1,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        case "vault_load_setting":
          return null;
        case "quotes_load_cached":
        case "vault_load_account_portfolios":
        case "vault_list_accounts":
        case "nav_list_snapshots":
        case "benchmark_load_cached":
        case "vault_list_cash_flows":
        case "vault_list_watchlist":
        case "vault_load_paper_orders":
          return [];
        case "vault_set_lock_passphrase":
          passphraseConfigured = Boolean(args?.newPassphrase);
          return {
            unlocked: true,
            lockState: "unlocked",
            hasLockPassphrase: passphraseConfigured,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: "pub-1",
            evidenceCount: 2,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        case "vault_lock":
          return lockGate.promise;
        case "vault_unlock":
          return {
            unlocked: true,
            lockState: "unlocked",
            hasLockPassphrase: passphraseConfigured,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: "pub-1",
            evidenceCount: 2,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        default:
          return null;
      }
    });

    window.location.hash = "#/settings";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-configure-lock-passphrase")).toBeInTheDocument();
    });

    // Configure lock passphrase in SettingsPage -> App.tsx must sync hasLockPassphrase immediately
    fireEvent.click(screen.getByTestId("settings-configure-lock-passphrase"));
    fireEvent.change(screen.getByTestId("lock-pass-new"), { target: { value: "My-Secret-Lock-Pass-2026" } });
    fireEvent.change(screen.getByTestId("lock-pass-confirm"), { target: { value: "My-Secret-Lock-Pass-2026" } });
    fireEvent.click(screen.getByTestId("lock-pass-save"));

    await waitFor(() => {
      expect(screen.queryByTestId("lock-passphrase-modal")).not.toBeInTheDocument();
    });

    // Lock now -> while vault_lock is pending, LockScreen must already show passphrase field AND disable unlock
    fireEvent.click(screen.getByTestId("topbar-lock-button"));
    await waitFor(() => {
      expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument();
    });
    expect(screen.getByTestId("app-lock-passphrase-input")).toBeDisabled();
    expect(screen.getByTestId("app-lock-unlock-button")).toBeDisabled();
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("vault_unlock", expect.anything());

    // Once vault_lock completes, passphrase input becomes interactive
    await act(async () => {
      lockGate.resolve({
        unlocked: false,
        lockState: "user-locked",
        hasLockPassphrase: true,
        retryAfterSeconds: 0,
        cipher: "AES-256-GCM",
        schemaVersion: 1,
        keyProvider: "os-keyring",
        signerPublicKey: null,
        evidenceCount: 0,
        hasLocalPortfolio: false,
        lockedReason: "Locked manually",
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("app-lock-passphrase-input")).not.toBeDisabled();
    });
  });

  it("P1-4: serializes concurrent saveWorkspacePreferences writes and avoids duplicate writes when changing idle lock", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    let storedPrefsJson: string | null = null;
    const savedPrefCalls: string[] = [];

    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
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
            signerPublicKey: "pub-1",
            evidenceCount: 0,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        case "vault_load_setting":
          return args?.key === WORKSPACE_PREFS_KEY ? storedPrefsJson : null;
        case "vault_save_setting":
          if (args?.key === WORKSPACE_PREFS_KEY) {
            storedPrefsJson = String(args.valueJson ?? "");
            savedPrefCalls.push(storedPrefsJson);
          }
          return true;
        case "evidence_append":
          return {
            schemaVersion: 1,
            eventId: "FH-EVENT-000001",
            sequence: 1,
            occurredAtUtc: "2026-11-23T00:00:00.000Z",
            appVersion: "0.2.0",
            kind: "safety_setting_changed",
            rustKind: "safety_setting_changed",
            accountRef: "acct_local_mock",
            intentId: "intent-1",
            payload: {},
            previousHash: "0".repeat(64),
            payloadHash: "a".repeat(64),
            entryHash: "b".repeat(64),
            signerPublicKey: "c".repeat(64),
            signature: "d".repeat(128),
          };
        case "quotes_load_cached":
        case "vault_load_account_portfolios":
        case "vault_list_accounts":
        case "nav_list_snapshots":
        case "benchmark_load_cached":
        case "vault_list_cash_flows":
        case "vault_list_watchlist":
        case "vault_load_paper_orders":
          return [];
        default:
          return null;
      }
    });

    // Concurrent preference patches must serialize and preserve BOTH updates
    await Promise.all([
      saveWorkspacePreferences({ quoteProvider: "yahoo" }),
      saveWorkspacePreferences({ idleLockMinutes: 30 }),
    ]);
    expect(JSON.parse(storedPrefsJson!)).toMatchObject({
      quoteProvider: "yahoo",
      idleLockMinutes: 30,
    });

    // Changing idle lock in SettingsPage inside App must trigger ONLY ONE workspace_preferences write
    savedPrefCalls.length = 0;
    window.location.hash = "#/settings";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("idle-lock-select")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("idle-lock-select"), { target: { value: "60" } });
    await waitFor(() => {
      expect(savedPrefCalls.length).toBe(1);
    });
    expect(JSON.parse(savedPrefCalls[0]!)).toMatchObject({ idleLockMinutes: 60 });
  });

  it("P2: reverse splits never inflate TS CSV replay, evidence export carries real mode, and clearLocalData resets App idleLockMinutes", async () => {
    const csv = [
      "Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount",
      "01/05/2026,Buy,ACME,ACME CORP,100,$10.00,$0.00,-$1000.00",
      "02/01/2026,Reverse Split,ACME,ACME CORP,50,$0.00,$0.00,$0.00",
      "02/15/2026,合股,ACME,ACME CORP,20,$0.00,$0.00,$0.00",
      "03/01/2026,Stock Split,ACME,ACME CORP,-30,$0.00,$0.00,$0.00",
    ].join("\n");
    const preview = await parseCsvLocally(csv, "reverse-split.csv");
    expect(preview.snapshot.holdings[0]?.quantity).toBe("100");
    expect(preview.warnings.filter((w) => w.includes("Reverse split / share consolidation")).length).toBe(3);

    const exportedLocal = await exportEvidence("local-csv");
    expect(JSON.parse(exportedLocal).mode).toBe("local-csv");

    // clearLocalData resets App's idleLockMinutes back to default 15
    window.location.hash = "#/settings";
    render(<App />);
    fireEvent.change(screen.getByTestId("idle-lock-select"), { target: { value: "60" } });
    expect(screen.getByTestId("idle-lock-select")).toHaveValue("60");

    fireEvent.click(screen.getByRole("button", { name: /Clear local demo data/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Clear data$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("idle-lock-select")).toHaveValue("15");
    });
    expect(readStored(WORKSPACE_PREFS_KEY, null)).toBeNull();
  });
});

describe("v0.2.0 Feature 1: Cash-Flow & Dividend Ledger + P&L Attribution", () => {
  it("isolates cash-flow summaries & P&L attribution strictly per currency bucket, persists via UI, and wipes on lock", async () => {
    const mixedCsv = [
      "代码,名称,持有数量,平均成本价,现价,币种",
      "US.AAPL,Apple Inc,10,180.00,200.00,美元",
      "HK.00700,腾讯控股,100,320.00,300.00,港元",
    ].join("\n");
    const committed = await commitBrokerCsv(mixedCsv, "futu.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    await CASH_FLOW_STORE.upsert({
      accountId: DEFAULT_ACCOUNT_ID,
      flowType: "dividend",
      symbol: "AAPL",
      currency: "USD",
      amountDecimal: "45.50",
      flowDate: "2026-11-18",
      note: "Q4 Dividend",
    });
    await CASH_FLOW_STORE.upsert({
      accountId: DEFAULT_ACCOUNT_ID,
      flowType: "deposit",
      currency: "HKD",
      amountDecimal: "10000.00",
      flowDate: "2026-11-19",
      note: "HKD funding",
    });

    const usdSummary = summarizeCashFlowsForBucket(CASH_FLOW_STORE.getAll(), "USD", DEFAULT_ACCOUNT_ID);
    expect(usdSummary.totalDividends).toBe("45.5");
    expect(usdSummary.totalDeposits).toBe("0");

    const hkdSummary = summarizeCashFlowsForBucket(CASH_FLOW_STORE.getAll(), "HKD", DEFAULT_ACCOUNT_ID);
    expect(hkdSummary.totalDeposits).toBe("10000");
    expect(hkdSummary.totalDividends).toBe("0");

    const snap = MOCK_BROKER.getSnapshot();
    const usdAttr = computePnlAttribution(snap.holdings, CASH_FLOW_STORE.getAll(), "USD", "en", DEFAULT_ACCOUNT_ID);
    expect(usdAttr.entries).toHaveLength(1);
    expect(usdAttr.entries[0]?.symbol).toBe("AAPL");
    // Unrealized = 10 * (200 - 180) = +200.00, Dividend = +45.50 => Combined = +245.50
    expect(usdAttr.entries[0]?.unrealizedPnl).toBe("200");
    expect(usdAttr.entries[0]?.dividendsReceived).toBe("45.5");
    expect(usdAttr.entries[0]?.totalContribution).toBe("245.5");

    // UI flow in PortfolioPage: record a fee and verify ledger updates & deletion works
    render(<PortfolioPage language="en" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />);
    expect(screen.getByTestId("pnl-attribution-panel")).toBeInTheDocument();
    expect(screen.getByTestId("cash-flow-ledger-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("allocation-bucket-tab-USD"));
    fireEvent.change(screen.getByTestId("cash-flow-type"), { target: { value: "fee" } });
    fireEvent.change(screen.getByTestId("cash-flow-amount"), { target: { value: "5.50" } });
    fireEvent.change(screen.getByTestId("cash-flow-note"), { target: { value: "ADR fee" } });
    fireEvent.click(screen.getByTestId("cash-flow-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("cash-flow-total-fees")).toHaveTextContent("$5.50");
      expect(screen.getByTestId("cash-flow-net-impact")).toHaveTextContent("+$40.00");
    });

    // Fail-Closed lock wipes CASH_FLOW_STORE RAM synchronously
    purgeAllFrontendSensitiveMemory();
    expect(CASH_FLOW_STORE.getAll()).toHaveLength(0);
  });
});

describe("v0.2.0 Feature 2: Local Watchlist & Price Target Alerts", () => {
  it("evaluates buy/sell price targets strictly in matching currency, highlights alerts in MarketsPage, prefills paper trade, and purges on lock", async () => {
    const snap = MOCK_BROKER.getSnapshot();
    const aaplQuote = snap.quotes.find((q) => q.symbol === "AAPL")!;
    const buyTargetAbovePrice = decimalAdd(aaplQuote.price, decimal("10"));
    const sellTargetHigher = decimalAdd(aaplQuote.price, decimal("80"));

    // Reject targetBuy >= targetSell
    await expect(
      WATCHLIST_STORE.upsert({
        symbol: "AAPL",
        currency: "USD",
        targetBuyDecimal: "300.00",
        targetSellDecimal: "250.00",
      }),
    ).rejects.toThrow(/lower than target sell/i);

    // Currency mismatch MUST NOT trigger alert (HKD target vs USD AAPL quote => no-price)
    const hkdMismatch = await WATCHLIST_STORE.upsert({
      symbol: "AAPL",
      currency: "HKD",
      targetBuyDecimal: "500.00",
    });
    expect(evaluateWatchlistItem(hkdMismatch, snap).status).toBe("no-price");
    await WATCHLIST_STORE.remove(hkdMismatch.id);

    const onOpenTrade = vi.fn();
    render(
      <MarketsPage
        language="en"
        onOpenInstrument={vi.fn()}
        onOpenTrade={onOpenTrade}
      />,
    );

    // Add AAPL with buy target ABOVE current price so buy-triggered fires immediately
    fireEvent.change(screen.getByTestId("watchlist-symbol-input"), { target: { value: "AAPL" } });
    fireEvent.change(screen.getByTestId("watchlist-buy-input"), { target: { value: buyTargetAbovePrice } });
    fireEvent.change(screen.getByTestId("watchlist-sell-input"), { target: { value: sellTargetHigher } });
    fireEvent.change(screen.getByTestId("watchlist-note-input"), { target: { value: "Dip buy zone" } });
    fireEvent.click(screen.getByTestId("watchlist-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("watchlist-row-AAPL")).toHaveAttribute("data-alert-status", "buy-triggered");
      expect(screen.getByTestId("watchlist-triggered-count")).toHaveTextContent("1 target alert(s) hit");
    });

    // Clicking "Review ticket" prefills manual paper trade ticket (never auto-submits!)
    fireEvent.click(screen.getByTestId("watchlist-review-trade-AAPL"));
    expect(onOpenTrade).toHaveBeenCalledWith(
      "AAPL",
      expect.objectContaining({
        symbol: "AAPL",
        side: "buy",
        orderType: "limit",
        currency: "USD",
      }),
    );

    // Toggle pause -> status becomes disabled
    fireEvent.click(screen.getByTestId("watchlist-toggle-AAPL"));
    await waitFor(() => {
      expect(screen.getByTestId("watchlist-row-AAPL")).toHaveAttribute("data-alert-status", "disabled");
    });

    // Lock wipes watchlist RAM
    purgeAllFrontendSensitiveMemory();
    expect(WATCHLIST_STORE.getAll()).toHaveLength(0);
  });
});

describe("v0.2.0 Feature 3: Sanitized Portfolio Review Report Export (Markdown & CSV)", () => {
  it("redacts sensitive account numbers/credentials, neutralizes CSV formula injection, and invokes lock-guarded native save dialog", async () => {
    expect(sanitizeSensitiveReportText("Schwab Acct 1234567890 / IBKR U7654321 / api_key=sk_live_secret")).toBe(
      "Schwab Acct ••••7890 / IBKR U••••321 / [REDACTED]",
    );
    expect(escapeCsvCell("=CMD|' /C calc'!A0")).toBe("'=CMD|' /C calc'!A0");
    expect(escapeCsvCell("+1+1")).toBe("'+1+1");
    expect(escapeCsvCell("@HYPERLINK(\"http://evil\")")).toBe("\"'@HYPERLINK(\"\"http://evil\"\")\"");
    expect(escapeCsvCell("-125.50", { isNumeric: true, sanitizeSensitive: false })).toBe("-125.50");

    await CASH_FLOW_STORE.upsert({
      accountId: DEFAULT_ACCOUNT_ID,
      flowType: "dividend",
      symbol: "AAPL",
      currency: "USD",
      amountDecimal: "32.10",
      flowDate: "2026-11-22",
      note: "=HYPERLINK(\"http://evil\") Acct 9988776655",
    });

    const input = buildPortfolioReportInputFromStores("zh", DEFAULT_ACCOUNT_ID, "2026-11-23T09:00:00.000Z");
    input.accountLabel = "Schwab 9876-5432 / U1234567";

    const md = generatePortfolioMarkdownReport(input);
    expect(md).toContain("# FolioHelm 投资组合复盘报告（已脱敏）");
    expect(md).not.toContain("9876-5432");
    expect(md).not.toContain("U1234567");
    expect(md).not.toContain("9988776655");
    expect(md).toContain("••••-5432");
    expect(md).toContain("U••••567");
    expect(md).toContain("••••6655");

    const csv = generatePortfolioCsvReport(input);
    expect(csv).not.toContain("9876-5432");
    expect(csv).not.toContain("9988776655");
    expect(csv).toContain("'=HYPERLINK");

    // Verify PortfolioPage export buttons invoke lock-guarded dialog_save_report_file in Tauri runtime
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "dialog_save_report_file") return "D:\\reports\\foliohelm-review.md";
      return null;
    });

    render(<PortfolioPage language="zh" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />);
    fireEvent.click(screen.getByTestId("export-report-md"));

    await waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "dialog_save_report_file",
        expect.objectContaining({
          format: "md",
          defaultFileName: expect.stringMatching(/\.md$/),
        }),
      );
      expect(screen.getByTestId("report-export-feedback")).toHaveTextContent("D:\\reports\\foliohelm-review.md");
    });
  });
});

describe("Red-Team Recheck (#177/#178): Strict Mode Isolation, Report Redaction, Watchlist Quotes, ErrorLocked Recovery & Precision", () => {
  it("P1-1: completely isolates Mock Demo sandbox from local-csv real encrypted vault (cash flows, watchlist, accounts, reports)", async () => {
    // 1. Seed a real local account, real local-csv portfolio, cash flow, and watchlist item
    const realAcct = await ACCOUNT_STORE.createOrUpdateAccount({
      name: "Schwab Secret Vault",
      broker: "Schwab",
      accountType: "taxable",
      baseCurrency: "USD",
    });
    const csv = [
      "Symbol,Description,Quantity,Average Cost,Price,Currency",
      "AAPL,Apple Inc.,10,180.00,200.00,USD",
    ].join("\n");
    const committed = await commitBrokerCsv(csv, "schwab.csv", realAcct.id, realAcct.name);
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    await CASH_FLOW_STORE.upsert(
      {
        accountId: realAcct.id,
        flowType: "dividend",
        symbol: "AAPL",
        currency: "USD",
        amountDecimal: "99.00",
        flowDate: "2026-11-20",
        note: "Real Vault Dividend",
      },
      { mode: "local-csv" },
    );
    await WATCHLIST_STORE.upsert(
      {
        symbol: "00700.HK",
        currency: "HKD",
        targetBuyDecimal: "380.00",
        note: "Real HK target",
      },
      { mode: "local-csv" },
    );

    // 2. Switch back to Mock Demo mode under Tauri runtime
    MOCK_BROKER.setWorkspaceMode("mock");
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockResolvedValue(null);

    // Real local-csv data MUST NOT leak into Mock mode stores or reports
    expect(CASH_FLOW_STORE.getAll("mock")).toHaveLength(0);
    expect(WATCHLIST_STORE.getAll("mock")).toHaveLength(0);
    const mockReport = buildPortfolioReportInputFromStores("en", realAcct.id);
    expect(mockReport.buckets.every((b) => b.cashFlows.length === 0)).toBe(true);

    // PortfolioPage in Mock mode must NOT expose real local account name or real dividend
    const { unmount: unmountPortfolio } = render(
      <PortfolioPage language="en" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />,
    );
    expect(screen.queryByTestId("cash-flow-account")).not.toBeInTheDocument();
    expect(screen.queryByText("Schwab Secret Vault")).not.toBeInTheDocument();
    expect(screen.queryByText("Real Vault Dividend")).not.toBeInTheDocument();

    // Recording a Mock cash flow MUST stay in memory sandbox and NEVER call vault_upsert_cash_flow
    fireEvent.change(screen.getByTestId("cash-flow-amount"), { target: { value: "12.34" } });
    fireEvent.change(screen.getByTestId("cash-flow-note"), { target: { value: "Mock Sandbox Div" } });
    fireEvent.click(screen.getByTestId("cash-flow-submit"));
    await waitFor(() => {
      expect(screen.getByText("Mock Sandbox Div")).toBeInTheDocument();
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("vault_upsert_cash_flow", expect.anything());
    unmountPortfolio();

    // MarketsPage in Mock mode must NOT show real watchlist item and MUST NOT call vault_upsert_watchlist_item
    const { unmount: unmountMarkets } = render(
      <MarketsPage language="en" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />,
    );
    expect(screen.queryByTestId("watchlist-row-00700.HK")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("watchlist-symbol-input"), { target: { value: "NVDA" } });
    fireEvent.change(screen.getByTestId("watchlist-buy-input"), { target: { value: "120.00" } });
    fireEvent.click(screen.getByTestId("watchlist-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("watchlist-row-NVDA")).toBeInTheDocument();
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("vault_upsert_watchlist_item", expect.anything());
    unmountMarkets();

    // 3. Switch back to local-csv -> real vault entries intact, Mock sandbox entries absent!
    MOCK_BROKER.setWorkspaceMode("local-csv");
    expect(CASH_FLOW_STORE.getAll("local-csv").map((c) => c.note)).toEqual(["Real Vault Dividend"]);
    expect(WATCHLIST_STORE.getAll("local-csv").map((w) => w.symbol)).toEqual(["00700.HK"]);
    const localReport = buildPortfolioReportInputFromStores("en", realAcct.id);
    const localNotes = localReport.buckets.flatMap((b) => b.cashFlows.map((c) => c.note));
    expect(localNotes).toEqual(["Real Vault Dividend"]);
  });

  it("P1-2 & P2-5: preserves 6-digit A-share tickers and >=100k decimal amounts while redacting JWTs and underscore account IDs", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(sanitizeSensitiveReportText(`acct_1234567890 token ${jwt} 600519.SS 500000.00`)).toBe(
      "acct_••••7890 token [REDACTED] 600519.SS 500000.00",
    );

    const aShareCsv = [
      "代码,名称,持有数量,平均成本价,现价,币种",
      "600519.SS,贵州茅台,100,1500.00,1800.00,人民币",
      "000001.SZ,平安银行,1000,10.00,12.00,人民币",
    ].join("\n");
    const committed = await commitBrokerCsv(aShareCsv, "cn.csv");
    committed.snapshot.cash = "500000.00";
    committed.snapshot.cashByCurrency = { CNY: "500000.00" };
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    await CASH_FLOW_STORE.upsert(
      {
        accountId: DEFAULT_ACCOUNT_ID,
        flowType: "dividend",
        symbol: "600519.SS",
        currency: "CNY",
        amountDecimal: "120000.00",
        flowDate: "2026-11-21",
        note: `Dividend acct_9988776655 ${jwt}`,
      },
      { mode: "local-csv" },
    );

    const input = buildPortfolioReportInputFromStores("zh", DEFAULT_ACCOUNT_ID, "2026-11-23T09:00:00.000Z");
    const md = generatePortfolioMarkdownReport(input);
    const csv = generatePortfolioCsvReport(input);

    // 6-digit tickers & >=100k structured amounts MUST NOT be corrupted
    expect(md).toContain("| 600519.SS |");
    expect(md).toContain("| 000001.SZ |");
    expect(md).toContain("500000.00 CNY");
    expect(md).toContain("+120000.00 CNY");
    expect(csv).toContain(",600519.SS,");
    expect(csv).toContain(",000001.SZ,");
    expect(csv).toContain("Cash=500000.00; Dividends=120000.00;");

    // Sensitive tokens & underscore account IDs MUST be redacted
    expect(md).not.toContain("9988776655");
    expect(md).not.toContain("eyJhbGci");
    expect(md).toContain("acct_••••6655");
    expect(csv).not.toContain("9988776655");
    expect(csv).not.toContain("eyJhbGci");
  });

  it("P1-3: fetches and retains public delayed quotes for non-holding, non-demo local-csv watchlist symbols (e.g. 00700.HK)", async () => {
    const csv = [
      "Symbol,Description,Quantity,Average Cost,Price,Currency",
      "AAPL,Apple Inc.,10,180.00,200.00,USD",
    ].join("\n");
    const committed = await commitBrokerCsv(csv, "us-only.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });
    MOCK_BROKER.setPublicQuotesEnabled(true);

    // Add non-holding, non-demo HK symbol to local-csv watchlist
    await WATCHLIST_STORE.upsert(
      {
        symbol: "00700.HK",
        currency: "HKD",
        targetBuyDecimal: "400.00",
        targetSellDecimal: "480.00",
        note: "Tencent watch",
      },
      { mode: "local-csv" },
    );

    tauriMocks.isTauri.mockReturnValue(true);
    let requestedSymbols: string[] = [];
    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "quotes_fetch_public") {
        requestedSymbols = Array.isArray(args?.symbols) ? (args.symbols as string[]) : [];
        return {
          quotes: [
            {
              symbol: "AAPL",
              price: "205.00",
              change: "5.00",
              changePct: "2.50",
              currency: "USD",
              asOfUtc: "2026-11-23T09:00:00.000Z",
              provider: "yahoo",
              delayed: true,
            },
            {
              symbol: "00700.HK",
              price: "385.20",
              change: "-4.80",
              changePct: "-1.23",
              currency: "HKD",
              asOfUtc: "2026-11-23T09:00:00.000Z",
              provider: "yahoo",
              delayed: true,
            },
          ],
          fromCache: false,
          degradedReason: null,
          provider: "yahoo",
        };
      }
      if (cmd === "nav_upsert_snapshots") return 1;
      return null;
    });

    await refreshPublicQuotes("yahoo");
    expect(requestedSymbols).toContain("00700.HK");

    // Snapshot MUST preserve 00700.HK delayed quote even though it is neither held nor in the 7 demo stocks
    const snap = MOCK_BROKER.getSnapshot();
    expect(snap.quotes.find((q) => q.symbol === "00700.HK")?.price).toBe("385.2");

    render(<MarketsPage language="en" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />);
    expect(screen.getByTestId("watchlist-row-00700.HK")).toHaveAttribute("data-alert-status", "buy-triggered");
    expect(screen.getByTestId("watchlist-triggered-count")).toHaveTextContent("1 target alert(s) hit");
  });

  it("P2-1 & P2-4: syncs ErrorLocked state & wipes memory on rollback failure, and never traps user on LockScreen when ErrorLocked", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    let backendErrorLocked = false;

    tauriMocks.invoke.mockImplementation(async (cmd) => {
      switch (cmd) {
        case "vault_status":
          return backendErrorLocked
            ? {
                unlocked: false,
                lockState: "error-locked",
                hasLockPassphrase: false,
                retryAfterSeconds: 0,
                cipher: "AES-256-GCM + Ed25519",
                schemaVersion: 1,
                keyProvider: "os-keyring",
                signerPublicKey: null,
                evidenceCount: 0,
                hasLocalPortfolio: false,
                lockedReason: "rollback failed to reopen original vault",
              }
            : {
                unlocked: true,
                lockState: "unlocked",
                hasLockPassphrase: false,
                retryAfterSeconds: 0,
                cipher: "AES-256-GCM + Ed25519",
                schemaVersion: 1,
                keyProvider: "os-keyring",
                signerPublicKey: "pub-1",
                evidenceCount: 1,
                hasLocalPortfolio: false,
                lockedReason: null,
              };
        case "dialog_open_fhvault_file":
          return { fileName: "backup.fhvault", content: "{\"version\":1}" };
        case "vault_restore_backup":
          backendErrorLocked = true;
          throw new Error("restore verification failed; unable to reopen original vault");
        case "vault_list_cash_flows":
          return [
            {
              id: "cf_mem_1",
              accountId: DEFAULT_ACCOUNT_ID,
              flowType: "dividend",
              symbol: "AAPL",
              currency: "USD",
              amountMicros: "50000000",
              flowDate: "2026-11-20",
              note: "Sensitive memo",
              createdAt: "2026-11-20T00:00:00.000Z",
            },
          ];
        case "vault_list_watchlist":
        case "quotes_load_cached":
        case "vault_load_account_portfolios":
        case "vault_list_accounts":
        case "nav_list_snapshots":
        case "benchmark_load_cached":
        case "vault_load_paper_orders":
          return [];
        default:
          return null;
      }
    });

    window.location.hash = "#/settings";
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("fhvault-restore-open")).toBeInTheDocument();
      expect(CASH_FLOW_STORE.getAll("local-csv")).toHaveLength(1);
    });

    // Open restore modal, select file, submit -> backend fails into ErrorLocked
    fireEvent.click(screen.getByTestId("fhvault-restore-open"));
    fireEvent.click(screen.getByTestId("fhvault-choose-file"));
    await waitFor(() => {
      expect(screen.getByTestId("fhvault-passphrase-input")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("fhvault-passphrase-input"), { target: { value: "Valid-Passphrase-2026!" } });
    fireEvent.click(screen.getByTestId("fhvault-modal-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("fhvault-modal-error")).toHaveTextContent(/ErrorLocked/i);
      expect(screen.getByTestId("fhvault-modal-error")).not.toHaveTextContent(/existing vault untouched/i);
    });
    // Sensitive frontend memory must be wiped immediately
    expect(CASH_FLOW_STORE.getAll("local-csv")).toHaveLength(0);

    // P2-4: Clicking topbar Lock while ErrorLocked must NOT trap user behind <LockScreen />
    fireEvent.click(screen.getByTestId("topbar-lock-button"));
    expect(screen.queryByTestId("app-lock-screen")).not.toBeInTheDocument();
  });

  it("P2-2 & P2-3: preserves 6-decimal watchlist precision across toggleEnabled and TradePage, localizes Chinese errors, and resets ledger currency on bucket switch", async () => {
    // 6-decimal target prices must not truncate to 4 decimals on toggleEnabled
    const saved = await WATCHLIST_STORE.upsert(
      {
        symbol: "PENNY",
        currency: "HKD",
        targetBuyDecimal: "0.01001",
        targetSellDecimal: "0.01002",
      },
      { mode: "mock" },
    );
    expect(microsToDisplayDecimal(saved.targetBuyMicros)).toBe("0.01001");
    expect(microsToDisplayDecimal(saved.targetSellMicros)).toBe("0.01002");
    const toggled = await WATCHLIST_STORE.toggleEnabled(saved.id, { mode: "mock" });
    expect(toggled?.enabled).toBe(false);
    expect(microsToDisplayDecimal(toggled?.targetBuyMicros ?? null)).toBe("0.01001");

    // TradePage accepts up to 6-decimal limit prices prefilled from Watchlist
    const { unmount: unmountTrade } = render(
      <TradePage
        language="en"
        initialSymbol="AAPL"
        initialPrefill={{ symbol: "AAPL", side: "buy", orderType: "limit", limitPrice: "0.01001", currency: "USD" }}
        onClose={vi.fn()}
        onViewOrders={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Quantity (whole shares)"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("trade-safety")).toBeInTheDocument();
    unmountTrade();

    // Chinese validation errors in MarketsPage and PortfolioPage + currency reset on bucket switch
    const { unmount: unmountMarkets } = render(
      <MarketsPage language="zh" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId("watchlist-symbol-input"), { target: { value: "AAPL" } });
    fireEvent.change(screen.getByTestId("watchlist-buy-input"), { target: { value: "300" } });
    fireEvent.change(screen.getByTestId("watchlist-sell-input"), { target: { value: "200" } });
    fireEvent.click(screen.getByTestId("watchlist-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("watchlist-error")).toHaveTextContent("买入目标价必须低于卖出目标价");
    });
    unmountMarkets();

    const mixedCsv = [
      "代码,名称,持有数量,平均成本价,现价,币种",
      "US.AAPL,Apple Inc,10,180.00,200.00,美元",
      "HK.00700,腾讯控股,100,320.00,300.00,港元",
    ].join("\n");
    const committed = await commitBrokerCsv(mixedCsv, "mixed.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    render(<PortfolioPage language="zh" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />);
    // Submit invalid empty amount -> must show Chinese validation error
    fireEvent.click(screen.getByTestId("cash-flow-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("cash-flow-error")).toHaveTextContent("现金流金额必须为正数");
    });
    // Manually change ledgerCurrency to EUR, then click HKD bucket tab -> must reset to HKD
    fireEvent.change(screen.getByTestId("cash-flow-currency"), { target: { value: "EUR" } });
    expect(screen.getByTestId("cash-flow-currency")).toHaveValue("EUR");
    fireEvent.click(screen.getByTestId("allocation-bucket-tab-HKD"));
    expect(screen.getByTestId("cash-flow-currency")).toHaveValue("HKD");
  });
});
