import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_CONTROLLER, DEFAULT_AUTOMATION_STATE } from "../../src/domain/automation";
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
});
