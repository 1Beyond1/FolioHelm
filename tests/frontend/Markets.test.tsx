import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InstrumentPage, MarketsPage } from "../../src/features/markets";
import { getMarketSecurity } from "../../src/features/markets/marketsData";

describe("FolioHelm markets demo", () => {
  it("filters the watchlist immediately by symbol", () => {
    render(
      <MarketsPage
        language="en"
        onOpenInstrument={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nvda" } });

    expect(screen.getByTestId("market-row-NVDA")).toBeInTheDocument();
    expect(screen.queryByTestId("market-row-AAPL")).not.toBeInTheDocument();
    expect(screen.getAllByText("1 results")).toHaveLength(2);
  });

  it("opens an instrument when a watchlist symbol is clicked", () => {
    const onOpenInstrument = vi.fn();

    render(
      <MarketsPage
        language="en"
        onOpenInstrument={onOpenInstrument}
        onOpenTrade={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("market-symbol-AAPL"));

    expect(onOpenInstrument).toHaveBeenCalledWith("AAPL");
  });

  it("changes the instrument chart when the period changes", () => {
    render(
      <InstrumentPage
        language="en"
        symbol="AAPL"
        onBack={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );

    const initialPath = screen.getByTestId("instrument-chart-line").getAttribute("d");
    fireEvent.click(screen.getByTestId("instrument-period-1M"));

    expect(screen.getByTestId("instrument-chart")).toHaveAttribute("data-chart-period", "1M");
    expect(screen.getByTestId("instrument-period-1M")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("instrument-chart-line").getAttribute("d")).not.toBe(initialPath);
  });

  it("shows the price at the hovered chart position", () => {
    render(
      <InstrumentPage
        language="en"
        symbol="AAPL"
        onBack={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );

    fireEvent.pointerMove(screen.getByTestId("instrument-chart-hit-area"), { clientX: 420 });

    expect(screen.getByTestId("instrument-chart-tooltip")).toHaveTextContent("$");
    expect(screen.getByTestId("instrument-chart-marker")).toBeInTheDocument();
  });

  it("smoothly changes the chart time span with the mouse wheel", () => {
    render(
      <InstrumentPage
        language="en"
        symbol="AAPL"
        onBack={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    );

    const frame = screen.getByTestId("instrument-chart-frame");
    const initialPath = screen.getByTestId("instrument-chart-line").getAttribute("d");
    fireEvent.wheel(frame, { deltaY: 240 });

    expect(Number(frame.getAttribute("data-chart-zoom"))).toBeGreaterThan(0);
    expect(screen.getByTestId("instrument-chart-line").getAttribute("d")).not.toBe(initialPath);
  });

  it("routes Trade actions through the callback with the selected symbol", () => {
    const onOpenTrade = vi.fn();

    render(
      <MarketsPage
        language="en"
        onOpenInstrument={vi.fn()}
        onOpenTrade={onOpenTrade}
      />,
    );

    fireEvent.click(screen.getByTestId("trade-TSLA"));

    expect(onOpenTrade).toHaveBeenCalledWith("TSLA");
  });

  it("does not reuse a listed instrument's quote for an unknown deep link", () => {
    const onOpenTrade = vi.fn();

    expect(getMarketSecurity("GOOG")).toMatchObject({ symbol: "GOOG", status: "no-data" });

    render(
      <InstrumentPage
        language="en"
        symbol="GOOG"
        onBack={vi.fn()}
        onOpenTrade={onOpenTrade}
      />,
    );

    expect(screen.getByTestId("instrument-no-data")).toBeInTheDocument();
    expect(screen.queryByTestId("instrument-trade")).not.toBeInTheDocument();
    expect(screen.queryByText("$226.34")).not.toBeInTheDocument();
    expect(onOpenTrade).not.toHaveBeenCalled();
  });

  it("returns a value-free model for unknown instruments", () => {
    const security = getMarketSecurity("GOOG");

    expect(security.status).toBe("no-data");
    expect(security.price).toBeNaN();
    expect(security.chart["1D"]).toEqual([]);
    expect(security.news).toEqual([]);
  });
});
