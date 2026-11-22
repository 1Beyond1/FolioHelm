import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../../src/domain/automation";
import { parseCsvLocally } from "../../src/domain/csvImport";
import { price, quantity } from "../../src/domain/decimal";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { AutomationPage } from "../../src/features/automation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  MOCK_BROKER.reset();
  AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
});

describe("automation evidence feedback", () => {
  it("does not claim a run is durable when local evidence persistence fails", async () => {
    render(<AutomationPage language="en" />);
    fireEvent.click(screen.getByRole("switch"));

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    fireEvent.click(screen.getByRole("button", { name: /Run one local simulation/i }));

    await waitFor(() => expect(screen.getByTestId("automation-evidence-status")).toHaveAttribute("role", "alert"));
    expect(screen.getByTestId("automation-evidence-status")).toHaveTextContent(/visible in memory|could not be saved/i);
    expect(screen.getByTestId("automation-page")).toHaveTextContent(/AUTO-00001/);
  });

  it("uses the canonical quote price instead of hardcoded $100, respects market-closed, and stays synced with AUTOMATION_CONTROLLER", async () => {
    render(<AutomationPage language="en" />);
    fireEvent.click(screen.getByRole("switch"));
    // Raise caps above SPY's canonical price ($542.18)
    fireEvent.change(screen.getByLabelText("Max order value"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Max daily value"), { target: { value: "1000" } });

    // Market-closed scenario blocks regular-session-only automation
    MOCK_BROKER.setScenario("market-closed");
    fireEvent.click(screen.getByRole("button", { name: /Run one local simulation/i }));
    await waitFor(() => expect(screen.getByTestId("automation-page")).toHaveTextContent(/Regular market session is closed/i));
    expect(AUTOMATION_CONTROLLER.getState().logs[0]?.price).toBe("542.18");

    // Healthy scenario runs with real SPY quote price ($542.18)
    MOCK_BROKER.setScenario("healthy");
    fireEvent.click(screen.getByRole("button", { name: /Run one local simulation/i }));
    await waitFor(() => expect(screen.getByTestId("automation-page")).toHaveTextContent("$542.18"));
    expect(AUTOMATION_CONTROLLER.getState().reservedToday).toBe("542.18");

    // External singleton reset (e.g. from SettingsPage clearLocalData) updates AutomationPage immediately
    act(() => {
      AUTOMATION_CONTROLLER.replaceState(DEFAULT_AUTOMATION_STATE);
    });
    expect(screen.getByTestId("automation-page")).toHaveTextContent("No runs recorded.");
  });

  it("isolates non-USD holdings from USD-capped automation allowlists and blocks non-USD runs Fail-Closed", async () => {
    const mixedCsv = [
      "股票代码,股票名称,持有数量,稀释成本价,现价,市值,币种",
      "US.VOO,Vanguard S&P 500 ETF,10,450.00,500.00,5000.00,美元",
      "HK.00700,腾讯控股,100,320.00,380.00,38000.00,港元",
      "SH.600519,贵州茅台,10,1500.00,1600.00,16000.00,人民币",
    ].join("\n");
    const parsed = await parseCsvLocally(mixedCsv, "futu-mixed.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(parsed.snapshot, { switchMode: true });

    render(<AutomationPage language="en" />);
    expect(screen.getByTestId("automation-non-usd-notice")).toHaveTextContent("00700.HK (HKD)");
    expect(screen.getByTestId("automation-non-usd-notice")).toHaveTextContent("600519.SS (CNY)");

    // Non-USD symbols must NOT appear as selectable USD-capped allowlist checkboxes
    expect(screen.queryByRole("checkbox", { name: "00700.HK" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "600519.SS" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "VOO" })).toBeInTheDocument();

    // Direct controller call with non-USD currency MUST block Fail-Closed even if allowed & below USD cap
    let blocked!: ReturnType<typeof AUTOMATION_CONTROLLER.run>;
    act(() => {
      AUTOMATION_CONTROLLER.updateState({ enabled: true });
      AUTOMATION_CONTROLLER.updatePolicy({
        maxOrderValue: "10000.00" as never,
        maxDailyValue: "10000.00" as never,
        allowedSymbols: ["00700.HK"],
      });
      blocked = AUTOMATION_CONTROLLER.run({
        symbol: "00700.HK",
        side: "buy",
        quantity: quantity("1"),
        price: price("380.00"),
        currency: "HKD",
        idempotencyKey: "non-usd-test-1",
      });
    });
    expect(blocked.log.status).toBe("blocked");
    expect(blocked.log.reason).toMatch(/Non-USD symbol \(HKD\)/i);
    expect(AUTOMATION_CONTROLLER.getState().reservedToday).toBe("0");
  });
});
