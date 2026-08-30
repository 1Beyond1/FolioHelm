import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/App";
import { MOCK_BROKER } from "../../src/domain/mockBroker";

afterEach(() => {
  MOCK_BROKER.reset();
});

describe("FolioHelm broker-to-UI synchronization", () => {
  it("refreshes the working-order count and home activity after a simulated order", () => {
    render(<App />);

    const primaryNavigation = within(screen.getByRole("navigation", { name: /Primary navigation|主导航/i }));
    fireEvent.click(primaryNavigation.getByRole("button", { name: /Trade|交易/i }));

    fireEvent.change(screen.getByLabelText(/Quantity \(whole shares\)|数量（整数股）/i), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$|^继续$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to Mock preview|继续到模拟预览/i }));
    fireEvent.click(screen.getByLabelText(/I understand this is a simulated order|我了解这是模拟订单/i));
    fireEvent.click(screen.getByTestId("simulate-order"));

    expect(screen.getByTestId("trade-receipt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /View orders|查看订单/i }));

    expect(screen.getByTestId("orders-page")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("orders-tab-working"));
    expect(screen.getByTestId("orders-count-working")).toHaveTextContent("2");
    expect(screen.getByTestId("orders-row-MOCK-ORDER-2")).toBeInTheDocument();

    fireEvent.click(primaryNavigation.getByRole("button", { name: /Home|首页/i }));

    expect(screen.getByTestId("home-page")).toBeInTheDocument();
    expect(screen.getByText(/AAPL (buy|买入)/i)).toBeInTheDocument();
  });

  it("surfaces a selected stale-quote scenario as a page-level data state", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Settings|设置/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /Mock scenario|Mock 场景/i }), { target: { value: "stale-quote" } });

    expect(screen.getByTestId("data-state-stale")).toBeInTheDocument();
    expect(screen.getByTestId("data-state-stale")).toHaveTextContent(/stale|过期/i);
    expect(screen.getByText(/Market snapshot stale|行情快照已过期/i)).toBeInTheDocument();
    expect(screen.getByText(/Quotes: Stale snapshot|报价：已过期/i)).toBeInTheDocument();
  });
});
