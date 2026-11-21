import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";
import { parseLocationHash } from "../../src/navigation";

const labels = {
  home: /Home|首页/i,
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
    home: primaryNavigation.getByRole("button", { name: labels.home }),
    markets: primaryNavigation.getByRole("button", { name: labels.markets }),
    portfolio: primaryNavigation.getByRole("button", { name: labels.portfolio }),
    orders: primaryNavigation.getByRole("button", { name: labels.orders }),
    trade: primaryNavigation.getByRole("button", { name: labels.trade }),
    settings: screen.getByRole("button", { name: labels.settings }),
  };
}

describe("FolioHelm App navigation", () => {
  it("does not turn a malformed instrument hash into an AAPL page", () => {
    expect(parseLocationHash("#/instrument/")).toEqual({ route: "markets" });
    expect(parseLocationHash("#/instrument/%20")).toEqual({ route: "markets" });
    expect(parseLocationHash("#/instrument/%E0%A4%A")).toEqual({ route: "markets" });
    expect(parseLocationHash("#/trade?from=instrument")).toEqual({
      route: "trade",
      symbol: undefined,
      background: { route: "markets" },
    });
  });

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

  it("does not mark Home active while the settings page is open", () => {
    const navigation = renderApp();

    fireEvent.click(navigation.settings);

    expect(navigation.settings).toHaveClass("active");
    expect(navigation.home).not.toHaveClass("active");
    expect(navigation.markets).not.toHaveClass("active");
    expect(within(screen.getByRole("navigation", { name: /Primary navigation|主导航/i })).getByRole("button", { name: labels.trade })).not.toHaveClass("active");
  });

  it("returns to the previous page when the trade workspace is closed", async () => {
    const navigation = renderApp();

    fireEvent.click(navigation.markets);
    const primaryNavigation = within(screen.getByRole("navigation", { name: /Primary navigation|主导航/i }));
    fireEvent.click(primaryNavigation.getByRole("button", { name: labels.trade }));
    expect(screen.getByTestId("trade-page")).toBeInTheDocument();
    expect(window.location.hash).toMatch(/^#\/trade/);
    expect(navigation.markets).toHaveClass("active");
    expect(navigation.trade).not.toHaveClass("active");

    fireEvent.click(screen.getByTestId("trade-close"));
    expect(screen.getByTestId("markets-page")).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/markets"));
    expect(navigation.markets).toHaveClass("active");
    expect(navigation.trade).not.toHaveClass("active");
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

  it("persists page navigation in the hash and restores a deep link on refresh", () => {
    const navigation = renderApp();

    fireEvent.click(navigation.markets);
    expect(window.location.hash).toBe("#/markets");
    expect(document.title).toMatch(/FolioHelm — (Markets|市场)/);

    window.history.replaceState(null, "", "#/instrument/AAPL");
    fireEvent.popState(window);

    expect(screen.getByTestId("instrument-page")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/instrument/AAPL");
    expect(document.title).toMatch(/FolioHelm — AAPL/);
  });

  it("moves the document back to the top when the page changes", () => {
    renderApp();
    document.documentElement.scrollTop = 240;
    document.body.scrollTop = 240;

    fireEvent.click(screen.getByRole("button", { name: labels.markets }));

    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });

  it("supports keyboard selection in global search and restores the opener focus", () => {
    renderApp();
    const opener = screen.getByRole("button", { name: /Search a symbol or company|搜索股票代码或公司/i });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(within(dialog).getByRole("button", { name: /NVDA/ })).toHaveClass("is-active");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("instrument-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /NVIDIA|英伟达/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Search a symbol or company|搜索股票代码或公司/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Search a symbol or company|搜索股票代码或公司/i }));
  });
});
