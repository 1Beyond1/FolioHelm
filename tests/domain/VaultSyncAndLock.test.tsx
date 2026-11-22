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
import { LockScreen } from "../../src/components/LockScreen";
import { PortfolioHero } from "../../src/components/PortfolioHero";
import { SearchPalette } from "../../src/components/SearchPalette";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../../src/domain/automation";
import { commitBrokerCsv, parseCsvLocally } from "../../src/domain/csvImport";
import {
  clearEvidence,
  importEvidence,
  listEvidence,
  MAX_EVIDENCE_IMPORT_BYTES,
} from "../../src/domain/evidenceJournal";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import {
  hydrateWorkspaceFromVault,
  loadEncryptedSetting,
  persistPaperOrder,
  saveEncryptedSetting,
  WORKSPACE_PREFS_KEY,
} from "../../src/domain/vaultStorage";
import { InstrumentPage } from "../../src/features/markets/InstrumentPage";
import { OrdersPage } from "../../src/features/orders/OrdersPage";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { TradePage } from "../../src/features/trade/TradePage";
import { getCopy } from "../../src/i18n";
import { getMockPortfolio } from "../../src/mocks/portfolio";
import { clearFolioHelmStored, readStored, writeStored } from "../../src/platform/storage";

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.invoke.mockReset();
  MOCK_BROKER.reset();
  AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
  clearFolioHelmStored();
  window.location.hash = "#/";
  await clearEvidence();
});

const LOCAL_NON_DEMO_CSV = [
  "Symbol,Description,Quantity,Average Cost,Last Price,Market Value,Currency",
  "VOO,Vanguard S&P 500 ETF,10,450.00,510.00,5100.00,USD",
  "QQQ,Invesco QQQ Trust,8,380.00,440.00,3520.00,USD",
  "BRK.B,Berkshire Hathaway Inc Class B,5,390.00,430.00,2150.00,USD",
  "Cash & Cash Investments,,1,3500.00,3500.00,3500.00,USD",
].join("\n");

describe("C1: Encrypted SQLite vault hydration & previously unused Rust commands", () => {
  it("hydrates local-csv mode, cached public quotes, paper orders, and automation from Tauri vault on launch", async () => {
    tauriMocks.isTauri.mockReturnValue(true);

    const savedSettings: Record<string, string> = {
      workspace_preferences: JSON.stringify({
        workspaceMode: "local-csv",
        publicQuotesEnabled: true,
        quoteProvider: "yahoo",
        idleLockMinutes: 5,
      }),
      automation: JSON.stringify({
        ...DEFAULT_AUTOMATION_STATE,
        enabled: true,
        mode: "paper",
      }),
    };

    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case "vault_status":
          return {
            unlocked: true,
            lockState: "unlocked",
            hasLockPassphrase: true,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: "ed25519-pub",
            evidenceCount: 3,
            hasLocalPortfolio: true,
            lockedReason: null,
          };
        case "vault_load_setting":
          return savedSettings[String(args?.key ?? "")] ?? null;
        case "quotes_load_cached":
          return [
            {
              symbol: "VOO",
              price: "525.50",
              change: "5.50",
              changePct: "1.06",
              currency: "USD",
              provider: "stooq.com",
              asOfUtc: "2026-11-22T05:00:00.000Z",
              delayed: true,
            },
          ];
        case "vault_load_portfolio":
          return {
            id: "snap-1",
            fingerprint: "abc1234567890",
            sourceFormat: "generic_csv",
            sourceLabel: "vanguard.csv",
            importedAtUtc: "2026-11-22T04:00:00.000Z",
            accountLabel: "Local CSV",
            currency: "USD",
            cash: "3500.00",
            holdings: [
              {
                symbol: "VOO",
                company: "Vanguard S&P 500 ETF",
                quantity: "10",
                averageCost: "450.00",
                lastPrice: "510.00",
                currency: "USD",
              },
            ],
            transactions: [],
            warnings: [],
          };
        case "vault_load_paper_orders":
          if (args?.workspaceMode === "local-csv") {
            return [
              {
                id: "PAPER-9001",
                workspaceMode: "local-csv",
                symbol: "VOO",
                side: "buy",
                orderType: "market",
                quantity: "2",
                filledQuantity: "2",
                limitPrice: null,
                status: "filled",
                submittedAt: "2026-11-22T04:30:00.000Z",
                events: [
                  {
                    kind: "fill",
                    at: "2026-11-22T04:30:00.000Z",
                    detailEn: "Filled 2 VOO",
                    detailZh: "成交 2 股 VOO",
                  },
                ],
              },
            ];
          }
          return [];
        default:
          return null;
      }
    });

    const result = await hydrateWorkspaceFromVault();
    expect(result.preferences.workspaceMode).toBe("local-csv");
    expect(result.preferences.idleLockMinutes).toBe(5);
    expect(MOCK_BROKER.getWorkspaceMode()).toBe("local-csv");
    expect(MOCK_BROKER.isPublicQuotesEnabled()).toBe(true);
    expect(AUTOMATION_CONTROLLER.getState().enabled).toBe(true);

    const snapshot = MOCK_BROKER.getSnapshot();
    const vooQuote = snapshot.quotes.find((q) => q.symbol === "VOO");
    expect(vooQuote?.price).toBe("525.5");
    expect(vooQuote?.source).toBe("public-delayed");
    expect(snapshot.orders.some((o) => o.id === "PAPER-9001" && o.symbol === "VOO")).toBe(true);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("quotes_load_cached");
    expect(tauriMocks.invoke).toHaveBeenCalledWith("vault_load_paper_orders", { workspaceMode: "local-csv" });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("vault_load_setting", { key: "workspace_preferences" });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("vault_load_setting", { key: "automation" });
  });

  it("migrates legacy plaintext localStorage settings into encrypted vault and invokes vault_save_paper_order", async () => {
    writeStored("protections", {
      maxOrderValue: true,
      priceDeviation: false,
      autoLock: true,
      accountAllowlist: true,
    });

    tauriMocks.isTauri.mockReturnValue(true);
    const savedVault: Record<string, string> = {};
    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "vault_load_setting") {
        return savedVault[String(args?.key ?? "")] ?? null;
      }
      if (cmd === "vault_save_setting") {
        savedVault[String(args?.key ?? "")] = String(args?.valueJson ?? "");
        return true;
      }
      if (cmd === "vault_save_paper_order") {
        return true;
      }
      return null;
    });

    const migrated = await loadEncryptedSetting("protections", { maxOrderValue: true }, "protections");
    expect(migrated).toEqual({
      maxOrderValue: true,
      priceDeviation: false,
      autoLock: true,
      accountAllowlist: true,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("vault_save_setting", {
      key: "protections",
      valueJson: JSON.stringify(migrated),
    });
    // Legacy plaintext localStorage entry must be removed after successful encrypted migration.
    expect(readStored("protections", null)).toBeNull();

    const saved = await saveEncryptedSetting("protections", { maxOrderValue: false }, "protections");
    expect(saved).toBe(true);

    const orderSaved = await persistPaperOrder("local-csv", {
      id: "ORD-LOCAL-1",
      symbol: "BRK.B",
      side: "buy",
      type: "market",
      quantity: "1" as never,
      filledQuantity: "1" as never,
      limitPrice: null,
      status: "filled",
      submittedAt: "2026-11-22T05:00:00.000Z",
      events: [],
    });
    expect(orderSaved).toBe(true);
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "vault_save_paper_order",
      expect.objectContaining({
        order: expect.objectContaining({
          id: "ORD-LOCAL-1",
          workspaceMode: "local-csv",
          symbol: "BRK.B",
        }),
      }),
    );
  });
});

describe("C1: Full-site local-csv support for arbitrary non-7 imported symbols (VOO / QQQ / BRK.B)", () => {
  it("renders VOO / QQQ / BRK.B across Hero, SearchPalette, InstrumentPage, TradePage, and OrdersPage without fake curves or fake news", async () => {
    const committed = await commitBrokerCsv(LOCAL_NON_DEMO_CSV, "vanguard-positions.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    // 1. PortfolioHero shows honest local baseline (no fabricated home chart hit area)
    const portfolio = getMockPortfolio("en");
    const { unmount: unmountHero } = render(
      <PortfolioHero
        copy={getCopy("en")}
        language="en"
        data={portfolio}
        onNavigate={vi.fn()}
        onSearch={vi.fn()}
      />,
    );
    expect(screen.getByTestId("hero-local-baseline")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-chart-hit-area")).not.toBeInTheDocument();
    unmountHero();

    // 2. SearchPalette discovers imported non-7 symbol BRK.B
    const onOpenInstrument = vi.fn();
    const { unmount: unmountSearch } = render(
      <SearchPalette
        copy={getCopy("en")}
        language="en"
        onClose={vi.fn()}
        onOpenInstrument={onOpenInstrument}
        onOpenMarkets={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "BRK.B" } });
    fireEvent.click(screen.getByText("BRK.B"));
    expect(onOpenInstrument).toHaveBeenCalledWith("BRK.B");
    unmountSearch();

    // 3. InstrumentPage renders VOO cleanly without hitting instrument-no-data, fake chart, or fake news
    const { unmount: unmountInstrument } = render(
      <InstrumentPage
        language="en"
        symbol="VOO"
        onBack={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("instrument-no-data")).not.toBeInTheDocument();
    expect(screen.getByText("VOO")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-mode-chip")).toHaveTextContent(/Local Portfolio/i);
    expect(screen.getByTestId("instrument-no-history")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-no-fake-news")).toBeInTheDocument();
    unmountInstrument();

    // 4. TradePage rehearses paper buy on VOO and writes mode: "local-csv" to evidence journal
    const { unmount: unmountTrade } = render(
      <TradePage
        language="en"
        initialSymbol="VOO"
        initialPrefill={{ symbol: "VOO", side: "buy", quantity: "2", orderType: "market" }}
        onClose={vi.fn()}
        onViewOrders={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("trade-no-data")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Quantity (whole shares)")).toHaveValue(2);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to (Mock|Paper) preview/i }));
    fireEvent.click(screen.getByLabelText(/I understand this is a simulated order/i));
    fireEvent.click(screen.getByRole("button", { name: "Simulate order" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Simulation complete" })).toBeInTheDocument();
    });

    await waitFor(async () => {
      const evidence = await listEvidence();
      expect(
        evidence.some(
          (record) =>
            record.kind === "user_confirmation"
            && record.payload.symbol === "VOO"
            && record.payload.mode === "local-csv",
        ),
      ).toBe(true);
      expect(
        evidence.some(
          (record) =>
            record.kind === "mock_response"
            && record.payload.symbol === "VOO"
            && record.payload.mode === "local-csv",
        ),
      ).toBe(true);
    });
    unmountTrade();

    // 5. OrdersPage lists the local-csv VOO paper order in the Working tab with local-csv ledger header
    render(<OrdersPage language="en" onOpenTrade={vi.fn()} />);
    expect(screen.getByTestId("orders-page")).toHaveAttribute("data-workspace-mode", "local-csv");
    expect(screen.getByTestId("orders-count-working")).toHaveTextContent("1");
    expect(screen.getByText("VOO")).toBeInTheDocument();
  });
});

describe("C5: Multi-currency Fail-Safe isolation in PortfolioPage", () => {
  it("isolates USD and HKD subtotals and switches allocation & rebalance strictly per currency bucket without FX blending", async () => {
    const mixedCsv = [
      "代码,名称,持有数量,平均成本价,现价,币种",
      "US.AAPL,Apple Inc,10,180.00,200.00,美元",
      "HK.00700,腾讯控股,100,320.00,400.00,港元",
    ].join("\n");

    const committed = await commitBrokerCsv(mixedCsv, "futu-mixed.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    render(
      <PortfolioPage
        language="zh"
        onOpenInstrument={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );

    expect(screen.getByTestId("multi-currency-notice")).toBeInTheDocument();
    expect(screen.getByTestId("currency-summary-USD")).toBeInTheDocument();
    expect(screen.getByTestId("currency-summary-HKD")).toBeInTheDocument();
    expect(screen.getByTestId("allocation-bucket-isolation-badge")).toBeInTheDocument();
    expect(screen.getByTestId("rebalance-bucket-isolation-badge")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-local-baseline")).toBeInTheDocument();

    // USD bucket must contain only AAPL (never blended with HKD 00700.HK)
    fireEvent.click(screen.getByTestId("allocation-bucket-tab-USD"));
    expect(screen.getByTestId("portfolio-allocation-donut")).toHaveAttribute("data-currency", "USD");
    expect(screen.getByTestId("portfolio-allocation-list")).toHaveTextContent("AAPL");
    expect(screen.getByTestId("portfolio-allocation-list")).not.toHaveTextContent("00700.HK");
    expect(screen.getByTestId("rebalance-row-AAPL")).toBeInTheDocument();
    expect(screen.queryByTestId("rebalance-row-00700.HK")).not.toBeInTheDocument();

    // HKD bucket must contain only 00700.HK (never blended with USD AAPL)
    fireEvent.click(screen.getByTestId("rebalance-bucket-tab-HKD"));
    expect(screen.getByTestId("portfolio-allocation-donut")).toHaveAttribute("data-currency", "HKD");
    expect(screen.getByTestId("portfolio-allocation-list")).toHaveTextContent("00700.HK");
    expect(screen.getByTestId("portfolio-allocation-list")).not.toHaveTextContent("AAPL");
    expect(screen.getByTestId("rebalance-row-00700.HK")).toBeInTheDocument();
    expect(screen.queryByTestId("rebalance-row-AAPL")).not.toBeInTheDocument();
  });
});

describe("C2: App Lock (manual & idle), .fhvault encrypted backup UI, and 20 MB evidence limit", () => {
  it("locks session manually via TopBar, removes portfolio data from DOM, writes session_locked evidence, and unlocks cleanly", async () => {
    render(<App />);
    expect(screen.getByTestId("home-page")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("topbar-lock-button"));

    await waitFor(() => {
      expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("home-page")).not.toBeInTheDocument();

    const records = await listEvidence();
    expect(records.some((r) => r.kind === "session_locked" && r.payload.trigger === "manual")).toBe(true);

    fireEvent.click(screen.getByTestId("app-lock-unlock-button"));
    await waitFor(() => {
      expect(screen.queryByTestId("app-lock-screen")).not.toBeInTheDocument();
      expect(screen.getByTestId("home-page")).toBeInTheDocument();
    });
  });

  it("triggers idle auto-lock after configured inactivity period", async () => {
    writeStored(WORKSPACE_PREFS_KEY, {
      workspaceMode: "mock",
      publicQuotesEnabled: false,
      quoteProvider: "stooq",
      idleLockMinutes: 1,
    });
    vi.useFakeTimers();

    render(<App />);
    expect(screen.getByTestId("home-page")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("home-page")).not.toBeInTheDocument();
  });

  it("rejects evidence imports exceeding the 20 MB hard cap Fail-Closed", async () => {
    const oversized = "x".repeat(MAX_EVIDENCE_IMPORT_BYTES + 16);
    await expect(importEvidence(oversized)).rejects.toThrow(/20\s*MB/i);
  });

  it("exports and fail-closed restores .fhvault backups in Tauri desktop runtime", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
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
          return JSON.stringify({ format: "foliohelm-vault-backup", version: 1, ciphertext: "abc" });
        case "dialog_save_fhvault_file":
          return "D:\\backups\\test.fhvault";
        case "dialog_open_fhvault_file":
          return { fileName: "tampered.fhvault", content: "{\"tampered\":true}" };
        case "vault_restore_backup":
          throw new Error("Decryption failed: wrong passphrase or tampered backup");
        default:
          return null;
      }
    });

    render(<SettingsPage language="en" onLanguageChange={vi.fn()} />);

    // Export .fhvault flow
    fireEvent.click(screen.getByTestId("fhvault-export-open"));
    fireEvent.change(screen.getByTestId("fhvault-passphrase-input"), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByTestId("fhvault-passphrase-confirm"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByTestId("fhvault-modal-submit"));

    await waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith("vault_export_backup", {
        passphrase: "correct horse battery staple",
      });
    });

    // Fail-closed restore error flow
    fireEvent.click(screen.getByTestId("fhvault-restore-open"));
    fireEvent.click(screen.getByTestId("fhvault-choose-file"));
    await waitFor(() => {
      expect(screen.getByTestId("fhvault-selected-name")).toHaveTextContent("tampered.fhvault");
    });
    fireEvent.change(screen.getByTestId("fhvault-passphrase-input"), { target: { value: "wrong-passphrase-123" } });
    fireEvent.click(screen.getByTestId("fhvault-modal-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("fhvault-modal-error")).toHaveTextContent(/wrong passphrase or tampered/i);
    });
  });
});

describe("C4: PortfolioPage target allocation & read-only rebalance calculator UI", () => {
  it("validates 100% sum, switches modes, prefills a single paper trade ticket, and never exposes batch execution", async () => {
    const committed = await commitBrokerCsv(LOCAL_NON_DEMO_CSV, "vanguard-positions.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });
    const onOpenTrade = vi.fn();

    render(
      <PortfolioPage
        language="en"
        onOpenInstrument={vi.fn()}
        onOpenTrade={onOpenTrade}
      />,
    );

    const panel = screen.getByTestId("rebalance-panel");
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId("rebalance-readonly-disclaimer")).toBeInTheDocument();

    // Invalid sum shows clear validation error and hides suggestions
    fireEvent.change(screen.getByTestId("rebalance-weight-input-VOO"), { target: { value: "90" } });
    expect(screen.getByTestId("rebalance-validation-error")).toBeInTheDocument();
    expect(screen.queryByTestId("rebalance-suggestions")).not.toBeInTheDocument();

    // Equal weights restores exact 100% sum and renders read-only suggestions
    fireEvent.click(screen.getByTestId("rebalance-equal-btn"));
    expect(screen.getByTestId("rebalance-weight-total")).toHaveTextContent("100%");
    expect(screen.getByTestId("rebalance-suggestions")).toBeInTheDocument();

    // Cash-only-buy mode never recommends sells
    fireEvent.click(screen.getByTestId("rebalance-mode-cash-only"));
    fireEvent.change(screen.getByTestId("rebalance-additional-cash"), { target: { value: "2000" } });
    const prefillButtons = screen.getAllByTestId(/^rebalance-prefill-/);
    expect(prefillButtons.length).toBeGreaterThan(0);
    for (const btn of prefillButtons) {
      expect(btn.textContent).not.toMatch(/\bSell\b/i);
    }

    // Clicking one single row prefills TradePage with exact symbol, side, and shares
    fireEvent.click(prefillButtons[0]!);
    expect(onOpenTrade).toHaveBeenCalledTimes(1);
    const [symbolArg, prefillArg] = onOpenTrade.mock.calls[0]!;
    expect(typeof symbolArg).toBe("string");
    expect(prefillArg).toEqual(
      expect.objectContaining({
        symbol: symbolArg,
        side: "buy",
        orderType: "market",
      }),
    );

    // Explicitly verify NO batch execution control exists in the rebalance panel
    expect(panel.textContent).not.toMatch(/execute all|batch submit|一键批量下单/i);
  });

  it("debounces rebalance target-weight text input persistence instead of writing on every keystroke", () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    render(
      <PortfolioPage
        language="en"
        onOpenInstrument={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );

    setItemSpy.mockClear();
    const input = screen.getByTestId("rebalance-weight-input-AAPL");
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.change(input, { target: { value: "25.5" } });

    // Not written yet while typing rapidly
    expect(setItemSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    // Coalesced into a single write after 350ms debounce
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    setItemSpy.mockRestore();
  });
});

describe("Stage 4 Security Core: Heap purge on lock, sleep/wake idle lock, full restore replacement, and LockScreen/vaultErrorLocked hardening", () => {
  it("purges MOCK_BROKER & AUTOMATION_CONTROLLER JS heap and sanitizes document.title to 'FolioHelm — Locked' on lock, then rehydrates on unlock", async () => {
    const committed = await commitBrokerCsv(LOCAL_NON_DEMO_CSV, "secret-holdings.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });
    AUTOMATION_CONTROLLER.updateState({ enabled: true, strategyName: "Private Strategy" });
    writeStored(WORKSPACE_PREFS_KEY, {
      workspaceMode: "local-csv",
      publicQuotesEnabled: false,
      quoteProvider: "stooq",
      idleLockMinutes: 15,
    });
    window.location.hash = "#/instrument/VOO";

    render(<App />);
    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(true);
    expect(document.title).toContain("VOO");

    fireEvent.click(screen.getByTestId("topbar-lock-button"));
    await waitFor(() => {
      expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument();
    });

    // Heap & window title MUST be completely scrubbed while locked
    expect(document.title).toBe("FolioHelm — Locked");
    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
    expect(MOCK_BROKER.getWorkspaceMode()).toBe("mock");
    expect(AUTOMATION_CONTROLLER.getState().enabled).toBe(false);
    expect(AUTOMATION_CONTROLLER.getState().strategyName).toBe(DEFAULT_AUTOMATION_STATE.strategyName);

    // Unlock re-hydrates persisted local portfolio cleanly
    fireEvent.click(screen.getByTestId("app-lock-unlock-button"));
    await waitFor(() => {
      expect(screen.queryByTestId("app-lock-screen")).not.toBeInTheDocument();
      expect(MOCK_BROKER.hasLocalPortfolio()).toBe(true);
    });
    expect(document.title).toContain("VOO");
  });

  it("enforces wall-clock idle auto-lock across OS sleep/wake (focus/visibilitychange/activity never bypass deadline)", async () => {
    writeStored(WORKSPACE_PREFS_KEY, {
      workspaceMode: "mock",
      publicQuotesEnabled: false,
      quoteProvider: "stooq",
      idleLockMinutes: 1,
    });
    vi.useFakeTimers();
    const t0 = new Date("2026-11-22T10:00:00.000Z");
    vi.setSystemTime(t0);

    render(<App />);
    expect(screen.getByTestId("home-page")).toBeInTheDocument();

    // Simulate laptop sleeping 5 minutes WITHOUT firing timers, then waking with focus event
    vi.setSystemTime(new Date(t0.getTime() + 5 * 60_000));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("app-lock-screen")).toBeInTheDocument();
    expect(document.title).toBe("FolioHelm — Locked");
  });

  it("replaces (never union-merges) frontend holdings, orders, quotes, and automation on .fhvault restore and refreshes SettingsPage", async () => {
    tauriMocks.isTauri.mockReturnValue(true);

    // Seed pre-restore stale state in JS RAM
    const stalePreview = await parseCsvLocally(LOCAL_NON_DEMO_CSV, "pre-restore.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(stalePreview.snapshot, { switchMode: true });
    MOCK_BROKER.applyPublicQuotes([
      {
        symbol: "VOO",
        price: "999.00",
        change: "1.00",
        changePct: "0.10",
        currency: "USD",
        asOfUtc: "2026-11-22T01:00:00.000Z",
        provider: "stooq.com",
        delayed: true,
      },
    ]);
    MOCK_BROKER.hydratePaperOrders("local-csv", [
      {
        id: "PAPER-STALE-999",
        symbol: "VOO",
        side: "buy",
        type: "market",
        quantity: "1" as never,
        filledQuantity: "1" as never,
        limitPrice: null,
        status: "filled",
        submittedAt: "2026-11-22T01:00:00.000Z",
        events: [],
      },
    ]);
    AUTOMATION_CONTROLLER.updateState({ enabled: true, strategyName: "Pre-restore strategy" });

    // Restored vault has NO local portfolio, NO paper orders, NO cached quotes, NO automation,
    // and preferences with quoteProvider = "yahoo" & idleLockMinutes = 30.
    tauriMocks.invoke.mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case "vault_status":
          return {
            unlocked: true,
            lockState: "unlocked",
            hasLockPassphrase: true,
            retryAfterSeconds: 0,
            cipher: "AES-256-GCM",
            schemaVersion: 1,
            keyProvider: "os-keyring",
            signerPublicKey: "restored-pub",
            evidenceCount: 1,
            hasLocalPortfolio: false,
            lockedReason: null,
          };
        case "vault_load_setting":
          if (args?.key === "workspace_preferences") {
            return JSON.stringify({
              workspaceMode: "mock",
              publicQuotesEnabled: false,
              quoteProvider: "yahoo",
              idleLockMinutes: 30,
            });
          }
          return null;
        case "quotes_load_cached":
          return [];
        case "vault_load_portfolio":
          return null;
        case "vault_load_paper_orders":
          return [];
        default:
          return null;
      }
    });

    render(<SettingsPage language="en" onLanguageChange={vi.fn()} />);

    await act(async () => {
      await hydrateWorkspaceFromVault();
    });

    // All stale pre-restore data MUST be completely wiped, not merged!
    expect(MOCK_BROKER.hasLocalPortfolio()).toBe(false);
    expect(MOCK_BROKER.getWorkspaceMode()).toBe("mock");
    expect(MOCK_BROKER.getPublicQuoteStatus().cachedCount).toBe(0);
    expect(MOCK_BROKER.getSnapshot().orders.some((o) => o.id === "PAPER-STALE-999")).toBe(false);
    expect(AUTOMATION_CONTROLLER.getState().enabled).toBe(false);
    expect(AUTOMATION_CONTROLLER.getState().strategyName).toBe(DEFAULT_AUTOMATION_STATE.strategyName);

    // SettingsPage refreshed via VAULT_HYDRATED_EVENT
    await waitFor(() => {
      expect(screen.getByLabelText("Public quote source")).toHaveValue("yahoo");
    });
  });

  it("resets LockScreen 300s backoff countdown via retryNonce and creates only one interval per countdown", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    const { rerender } = render(
      <LockScreen
        language="en"
        trigger="manual"
        hasPassphrase
        lockedAtUtc="2026-11-22T00:00:00.000Z"
        retryAfterSeconds={300}
        retryNonce={1}
        errorMessage={null}
        unlocking={false}
        onUnlock={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByTestId("app-lock-backoff")).toHaveTextContent("300s");
    const callsAfterStart = setIntervalSpy.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId("app-lock-backoff")).toHaveTextContent("295s");
    // Single interval reused across ticks (no recreation every second)
    expect(setIntervalSpy.mock.calls.length).toBe(callsAfterStart);

    // Second failure hitting the same 300s cap with incremented retryNonce resets back to 300s
    rerender(
      <LockScreen
        language="en"
        trigger="manual"
        hasPassphrase
        lockedAtUtc="2026-11-22T00:00:00.000Z"
        retryAfterSeconds={300}
        retryNonce={2}
        errorMessage={null}
        unlocking={false}
        onUnlock={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByTestId("app-lock-backoff")).toHaveTextContent("300s");
    setIntervalSpy.mockRestore();
  });

  it("never lets dismissing a warning banner hide a Fail-Closed vaultErrorLocked alert", async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "vault_status") {
        return {
          unlocked: false,
          lockState: "locked",
          hasLockPassphrase: false,
          retryAfterSeconds: 0,
          cipher: "AES-256-GCM",
          schemaVersion: 1,
          keyProvider: "os-keyring",
          signerPublicKey: null,
          evidenceCount: 0,
          hasLocalPortfolio: false,
          lockedReason: "OS keyring key missing for existing vault",
        };
      }
      return null;
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/OS keyring key missing/i);
    });
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });
});
