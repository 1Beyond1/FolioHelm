import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { TradePage } from "../../src/features/trade/TradePage";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("TradePage", () => {
  it("provides an explicit close action and Escape shortcut without simulating anything", () => {
    const onClose = vi.fn();
    render(<TradePage language="en" initialSymbol="AAPL" onClose={onClose} onViewOrders={() => undefined} />);

    fireEvent.click(screen.getByTestId("trade-close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("validates a positive integer quantity and limit price locally", () => {
    render(<TradePage language="en" initialSymbol="AAPL" onClose={() => undefined} onViewOrders={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("greater than 0");

    fireEvent.change(screen.getByLabelText("Quantity (whole shares)"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("whole-share");

    fireEvent.change(screen.getByLabelText("Quantity (whole shares)"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("Limit"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("limit price");

    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("greater than 0");

    fireEvent.change(screen.getByLabelText("Limit price"), { target: { value: "185" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("trade-safety")).toBeInTheDocument();
  });

  it("walks through all four mock steps and never offers a real submit button", () => {
    const onViewOrders = vi.fn();
    render(<TradePage language="en" initialSymbol="NVDA" onClose={() => undefined} onViewOrders={onViewOrders} />);

    expect(screen.getByDisplayValue(/NVDA/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Quantity (whole shares)"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Safety check" })).toBeInTheDocument();
    expect(screen.getByText("No request exists")).toBeInTheDocument();
    expect(screen.getByText(/market orders would not be sent/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue to Mock preview" }));
    expect(screen.getByRole("heading", { name: "Mock preview" })).toBeInTheDocument();
    expect(screen.getByTestId("trade-summary")).toHaveTextContent("Buy 3 shares NVDA");
    expect(screen.getByRole("button", { name: "Simulate order" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Submit order/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/I understand this is a simulated order/));
    fireEvent.click(screen.getByRole("button", { name: "Simulate order" }));
    expect(screen.getByRole("heading", { name: "Simulation complete" })).toBeInTheDocument();
    expect(screen.getByText("Simulated only")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View orders" }));
    expect(onViewOrders).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Create another" }));
    expect(screen.getByRole("heading", { name: "Ticket" })).toBeInTheDocument();
  });
});

describe("SettingsPage", () => {
  it("starts all optional protections on, exposes core rules, and forwards language changes", () => {
    const onLanguageChange = vi.fn();
    render(<SettingsPage language="en" onLanguageChange={onLanguageChange} />);

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText("no credentials stored")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Max order value: On/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: /Price deviation: On/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: /Auto lock: On/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: /Account allowlist: On/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Preview freshness")).toBeInTheDocument();
    expect(screen.getByText("No write retry")).toBeInTheDocument();
    expect(screen.getByText("Unknown reconciliation")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "简体中文" }));
    expect(onLanguageChange).toHaveBeenCalledWith("zh");

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("No credentials are stored");
  });

  it("requires reading, the eight-second wait, confirmation, and DISABLE for high-risk protection", () => {
    vi.useFakeTimers();
    render(<SettingsPage language="en" onLanguageChange={() => undefined} />);

    fireEvent.click(screen.getByRole("switch", { name: /Max order value: On/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "Confirm disable" });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText("I have read the risk details to the bottom."));
    fireEvent.click(screen.getByTestId("confirm-disable-intent"));
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByTestId("disable-countdown")).toHaveTextContent("complete");
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type DISABLE to continue"), { target: { value: "DISABLE" } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/optional protection is disabled/i)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Max order value: Off/i })).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("switch", { name: /Max order value: Off/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Max order value: On/i })).toHaveAttribute("aria-checked", "true");
  });

  it("uses the same blocking dialog for a lower-risk optional protection without DISABLE", () => {
    vi.useFakeTimers();
    render(<SettingsPage language="en" onLanguageChange={() => undefined} />);

    fireEvent.click(screen.getByRole("switch", { name: /Price deviation: On/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByLabelText("Type DISABLE to continue")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("I have read the risk details to the bottom."));
    fireEvent.click(screen.getByTestId("confirm-disable-intent"));
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    const confirmButton = screen.getByRole("button", { name: "Confirm disable" });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    expect(screen.getByRole("switch", { name: /Price deviation: Off/i })).toBeInTheDocument();
  });
});
