import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../src/features/settings/SettingsPage";
import { TradePage } from "../../src/features/trade/TradePage";
import { detectInitialLanguage } from "../../src/i18n";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { Modal } from "../../src/components/Modal";
import { STORAGE_PREFIX } from "../../src/platform/storage";

afterEach(() => {
  vi.useRealTimers();
  MOCK_BROKER.reset();
  document.body.innerHTML = "";
});

describe("TradePage", () => {
  it("provides an explicit close action and Escape shortcut without simulating anything", () => {
    const onClose = vi.fn();
    render(
      <Modal
        className="trade-modal-window"
        backdropClassName="trade-modal-backdrop"
        labelledBy="trade-page-title"
        onClose={onClose}
      >
        <TradePage language="en" initialSymbol="AAPL" onClose={onClose} onViewOrders={() => undefined} />
      </Modal>,
    );

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

  it("keeps a stale-quote failure on the safety step instead of attaching it to quantity", () => {
    MOCK_BROKER.setScenario("stale-quote");
    render(<TradePage language="en" initialSymbol="AAPL" onClose={() => undefined} onViewOrders={() => undefined} />);

    fireEvent.change(screen.getByLabelText("Quantity (whole shares)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Mock preview" }));

    expect(screen.getByTestId("trade-safety")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/preview was blocked/i);
    expect(screen.queryByTestId("trade-quantity-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-check-quote")).toHaveAttribute("data-state", "blocked");
  });

  it("does not present an Unknown Mock outcome as a successful receipt", () => {
    MOCK_BROKER.setScenario("unknown");
    render(<TradePage language="en" initialSymbol="AAPL" onClose={() => undefined} onViewOrders={() => undefined} />);

    fireEvent.change(screen.getByLabelText("Quantity (whole shares)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Mock preview" }));
    fireEvent.click(screen.getByLabelText(/I understand this is a simulated order/));
    fireEvent.click(screen.getByRole("button", { name: "Simulate order" }));

    expect(screen.getByTestId("trade-receipt")).toHaveTextContent("Simulation result is unknown");
    expect(screen.getByTestId("trade-receipt")).toHaveTextContent(/Do not resubmit/i);
    expect(screen.getByTestId("trade-receipt")).not.toHaveTextContent("Simulation complete");
  });

  it("does not silently fall back to AAPL for an unsupported trade deep link", () => {
    const onClose = vi.fn();
    render(<TradePage language="en" initialSymbol="GOOG" onClose={onClose} onViewOrders={() => undefined} />);

    expect(screen.getByTestId("trade-no-data")).toBeInTheDocument();
    expect(screen.getByTestId("trade-no-data")).toHaveTextContent("No demo data for this symbol");
    expect(screen.queryByLabelText("Quantity (whole shares)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Simulate order" })).not.toBeInTheDocument();
    expect(screen.queryByText("$226.34")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("trade-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("normalizes a known trade symbol from a deep link", () => {
    render(<TradePage language="en" initialSymbol=" aapl " onClose={() => undefined} onViewOrders={() => undefined} />);

    expect(screen.getByLabelText("Symbol")).toHaveValue("AAPL");
    expect(screen.queryByTestId("trade-no-data")).not.toBeInTheDocument();
  });

  it("shows the actual buying-power gate before the Mock preview", () => {
    MOCK_BROKER.setScenario("no-buying-power");
    render(<TradePage language="en" initialSymbol="AAPL" onClose={() => undefined} onViewOrders={() => undefined} />);

    fireEvent.change(screen.getByLabelText("Quantity (whole shares)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByTestId("trade-check-buying-power")).toHaveAttribute("data-state", "blocked");
    expect(screen.getByTestId("trade-check-buying-power")).toHaveTextContent(/Insufficient buying power/i);
  });

  it("uses localized step labels in the Chinese trade workspace", () => {
    render(<TradePage language="zh" initialSymbol="AAPL" onClose={() => undefined} onViewOrders={() => undefined} />);

    expect(screen.getByRole("heading", { name: "订单" })).toBeInTheDocument();
    expect(screen.getByText("安全检查")).toBeInTheDocument();
    expect(screen.getByText("模拟预览")).toBeInTheDocument();
    expect(screen.getByText("演示回执")).toBeInTheDocument();
    expect(screen.queryByText("Ticket")).not.toBeInTheDocument();
    expect(screen.queryByText("Safety check")).not.toBeInTheDocument();
    expect(screen.queryByText("Mock preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Demo receipt")).not.toBeInTheDocument();
  });
});

describe("SettingsPage", () => {
  it("does not treat malformed persisted protection values as enabled", () => {
    window.localStorage.setItem(`${STORAGE_PREFIX}protections`, JSON.stringify({
      maxOrderValue: "false",
      priceDeviation: 0,
      autoLock: null,
      accountAllowlist: "yes",
    }));

    render(<SettingsPage language="en" onLanguageChange={() => undefined} />);

    expect(screen.getByRole("switch", { name: /Max order value: On/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Price deviation: On/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Auto lock: On/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Account allowlist: On/i })).toBeInTheDocument();
  });

  it("recovers when the persisted protection object is not an object", () => {
    window.localStorage.setItem(`${STORAGE_PREFIX}protections`, JSON.stringify(null));

    render(<SettingsPage language="en" onLanguageChange={() => undefined} />);

    expect(screen.getByRole("switch", { name: /Max order value: On/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Account allowlist: On/i })).toBeInTheDocument();
  });

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
    expect(screen.getByText(/optional protection preference is disabled/i)).toBeInTheDocument();
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

  it("resets in-memory preferences when local demo data is cleared", async () => {
    const onLanguageChange = vi.fn();
    const onThemeChange = vi.fn();

    render(
      <SettingsPage
        language="en"
        theme="dark"
        onLanguageChange={onLanguageChange}
        onThemeChange={onThemeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear local demo data" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear data" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onLanguageChange).toHaveBeenCalledWith(detectInitialLanguage());
    expect(onThemeChange).toHaveBeenCalledWith("system");
  });

  it("clears the parent modal state when the settings page unmounts", () => {
    const onModalStateChange = vi.fn();
    const { unmount } = render(
      <SettingsPage
        language="en"
        onLanguageChange={() => undefined}
        onModalStateChange={onModalStateChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onModalStateChange).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onModalStateChange).toHaveBeenLastCalledWith(false);
  });
});
