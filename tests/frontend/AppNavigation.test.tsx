import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/App";

afterEach(() => {
  document.body.innerHTML = "";
});

const labels = {
  markets: /Markets|市场/i,
  portfolio: /Portfolio|投资组合/i,
  orders: /Orders|订单/i,
  trade: /Trade|交易/i,
  settings: /Settings|设置/i,
};

function renderApp() {
  render(<App />);
  const primaryNavigation = within(screen.getByRole("navigation", { name: /Primary navigation|主导航/i }));
  return {
    markets: primaryNavigation.getByRole("button", { name: labels.markets }),
    portfolio: primaryNavigation.getByRole("button", { name: labels.portfolio }),
    orders: primaryNavigation.getByRole("button", { name: labels.orders }),
    trade: primaryNavigation.getByRole("button", { name: labels.trade }),
    settings: screen.getByRole("button", { name: labels.settings }),
  };
}

describe("FolioHelm App navigation", () => {
  it("opens the Markets page from the top navigation", () => {
    const { markets } = renderApp();

    fireEvent.click(markets);

    expect(screen.getByTestId("markets-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /Markets|市场/i })).toBeInTheDocument();
  });

  it.each([
    ["portfolio", labels.portfolio],
    ["orders", labels.orders],
    ["trade", labels.trade],
    ["settings", labels.settings],
  ] as const)("opens the %s page from the top navigation", (_route, label) => {
    const navigation = renderApp();

    fireEvent.click(navigation[_route]);

    expect(screen.getByRole("heading", { level: 1, name: label })).toBeInTheDocument();
  });

  it("returns to the previous page when the trade workspace is closed", () => {
    const navigation = renderApp();

    fireEvent.click(navigation.markets);
    fireEvent.click(within(screen.getByRole("navigation", { name: /Primary navigation|主导航/i })).getByRole("button", { name: labels.trade }));
    expect(screen.getByTestId("trade-page")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("trade-close"));
    expect(screen.getByTestId("markets-page")).toBeInTheDocument();
  });

  it("opens the AAPL instrument page from global search", () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: /Search a symbol or company|搜索股票代码或公司/i }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "AAPL" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /AAPL/ }));

    expect(screen.getByTestId("instrument-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /Apple|苹果/i })).toBeInTheDocument();
  });
});
