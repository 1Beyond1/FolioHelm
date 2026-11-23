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
import { evaluateWatchlistItem, WATCHLIST_STORE } from "../../src/domain/watchlist";
import { MarketsPage } from "../../src/features/markets/MarketsPage";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
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
