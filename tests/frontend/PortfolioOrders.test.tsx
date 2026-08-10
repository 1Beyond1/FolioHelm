import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";
import { OrdersPage } from "../../src/features/orders/OrdersPage";
import { MOCK_BROKER } from "../../src/domain/mockBroker";

afterEach(() => {
  MOCK_BROKER.reset();
  cleanup();
});

describe("PortfolioPage", () => {
  it("sorts holdings and routes row and trade actions to their callbacks", () => {
    const onOpenInstrument = vi.fn();
    const onOpenTrade = vi.fn();

    render(
      <PortfolioPage
        language="en"
        onOpenInstrument={onOpenInstrument}
        onOpenTrade={onOpenTrade}
      />,
    );

    const holdingRows = () => screen.getAllByTestId(/^portfolio-holding-row-/);
    expect(holdingRows()[0]).toHaveAttribute("data-symbol", "SPY");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Symbol" }));
    expect(holdingRows()[0]).toHaveAttribute("data-symbol", "AAPL");

    fireEvent.click(screen.getByTestId("portfolio-holding-row-AAPL"));
    expect(onOpenInstrument).toHaveBeenCalledWith("AAPL");

    fireEvent.click(screen.getByTestId("portfolio-trade-AAPL"));
    expect(onOpenTrade).toHaveBeenCalledWith("AAPL");
  });
});

describe("dynamic Mock snapshot", () => {
  it("reflects the selected empty-account scenario instead of a page fixture", () => {
    MOCK_BROKER.setScenario("empty-account");

    render(
      <PortfolioPage
        language="en"
        onOpenInstrument={() => undefined}
        onOpenTrade={() => undefined}
      />,
    );

    expect(screen.getAllByText("$25,000.00")).toHaveLength(3);
    expect(screen.queryByTestId(/^portfolio-holding-row-/)).not.toBeInTheDocument();
  });
});

describe("OrdersPage", () => {
  it("switches status tabs, filters by symbol, and shows the Unknown warning", () => {
    const onOpenTrade = vi.fn();

    render(<OrdersPage language="en" onOpenTrade={onOpenTrade} />);

    expect(screen.getByTestId("orders-tab-working")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("orders-row-ORD-1048")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("orders-tab-filled"));
    expect(screen.getByTestId("orders-row-ORD-1044")).toBeInTheDocument();
    expect(screen.queryByTestId("orders-row-ORD-1048")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("orders-tab-unknown"));
    expect(screen.getByTestId("orders-unknown-warning")).toHaveTextContent(/do not resubmit/i);
    expect(screen.getByTestId("orders-row-ORD-1047")).toHaveTextContent("AMD");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "NVDA" } });
    expect(screen.getByText("No orders match this view.")).toBeInTheDocument();
  });

  it("expands a filled order timeline and calls New order", () => {
    const onOpenTrade = vi.fn();

    render(<OrdersPage language="zh" onOpenTrade={onOpenTrade} />);

    fireEvent.click(screen.getByTestId("orders-tab-filled"));
    fireEvent.click(screen.getByTestId("orders-row-ORD-1044"));

    expect(screen.getByTestId("orders-timeline-ORD-1044")).toHaveTextContent("草稿");
    expect(screen.getByTestId("orders-timeline-ORD-1044")).toHaveTextContent("成交");

    fireEvent.click(screen.getByTestId("orders-new-order"));
    expect(onOpenTrade).toHaveBeenCalledTimes(1);
  });
});
