import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InvestingHeatmap } from "../../src/components/InvestingHeatmap";
import { parseCsvLocally } from "../../src/domain/csvImport";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { getCopy } from "../../src/i18n";
import { InstrumentPage, MarketsPage } from "../../src/features/markets";
import { getMarketSecurity } from "../../src/features/markets/marketsData";

afterEach(() => {
  cleanup();
  MOCK_BROKER.reset();
});

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

  it("scales historical price series smoothly to the canonical quote and keeps stats ranges containing current price", () => {
    const aapl = getMarketSecurity("AAPL");
    const oneDay = aapl.chart["1D"];
    const previousPoint = oneDay[oneDay.length - 2]!;
    const lastPoint = oneDay[oneDay.length - 1]!;

    expect(lastPoint).toBe(aapl.price);
    // Avoid single-point cliff jump (previously jumped from 183.50 to 226.34 = >23%)
    expect(Math.abs((lastPoint - previousPoint) / previousPoint)).toBeLessThan(0.05);

    const parseRange = (range: string): [number, number] => {
      const matches = range.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
      return [Number(matches[0]?.replace(/,/g, "")), Number(matches[1]?.replace(/,/g, ""))];
    };
    const [dayLow, dayHigh] = parseRange(aapl.stats.dayRange);
    const [yearLow, yearHigh] = parseRange(aapl.stats.yearRange);
    expect(aapl.price).toBeGreaterThanOrEqual(dayLow);
    expect(aapl.price).toBeLessThanOrEqual(dayHigh);
    expect(aapl.price).toBeGreaterThanOrEqual(yearLow);
    expect(aapl.price).toBeLessThanOrEqual(yearHigh);
    // Uses cumulative totalPnl rather than dayPnl
    expect(aapl.holdingPnl).toBe(1250);
  });

  it("formats InvestingHeatmap with actual non-USD currency and suppresses misleading $0.00 in multi-currency mode", () => {
    const sampleEntries = [
      {
        date: "2026-11-20",
        dataStatus: "available" as const,
        level: 2 as const,
        actions: 1,
        dailyReturnPct: 1.25,
        dailyReturnUsd: 500,
      },
    ];
    const { rerender } = render(
      <InvestingHeatmap
        copy={getCopy("en")}
        language="en"
        entries={sampleEntries}
        activeDays={1}
        ordersFilled={1}
        netChange={1250}
        currency="HKD"
        isMultiCurrency={false}
      />,
    );
    expect(screen.getByTestId("heatmap-net-change")).toHaveTextContent(/HK\$/);
    fireEvent.click(screen.getByTestId("heatmap-mode-return"));
    expect(screen.getByTestId("heatmap-unit-usd")).toHaveTextContent("HKD");

    rerender(
      <InvestingHeatmap
        copy={getCopy("en")}
        language="en"
        entries={sampleEntries}
        activeDays={1}
        ordersFilled={1}
        netChange={0}
        currency="MULTI"
        isMultiCurrency
      />,
    );
    expect(screen.getByTestId("heatmap-net-change")).toHaveTextContent("Multi-currency");
    expect(screen.queryByTestId("heatmap-unit-usd")).not.toBeInTheDocument();
  });

  it("renders honest local-csv copy on MarketsPage and InstrumentPage without fictional demo leaks", async () => {
    const csv = "symbol,description,quantity,average_cost,price,currency\n00700.HK,Tencent Holdings,100,320.00,380.00,HKD\n";
    const parsed = await parseCsvLocally(csv, "hk-only.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(parsed.snapshot, { switchMode: true });

    const { unmount } = render(
      <MarketsPage language="en" onOpenInstrument={vi.fn()} onOpenTrade={vi.fn()} />,
    );
    expect(screen.getByTestId("markets-page")).toHaveTextContent(/Search local portfolio/i);
    expect(screen.getByTestId("markets-page")).toHaveTextContent(/Try 00700\.HK/i);
    expect(screen.getByTestId("markets-movers-empty")).toBeInTheDocument();
    expect(screen.getByTestId("markets-page")).not.toHaveTextContent(/Every quote on this page is invented/i);
    unmount();

    render(
      <InstrumentPage language="en" symbol="UNKNOWN" onBack={vi.fn()} onOpenTrade={vi.fn()} />,
    );
    expect(screen.getByTestId("instrument-no-data")).toHaveTextContent(/No local portfolio data for this symbol/i);
    expect(screen.getByTestId("instrument-no-data")).not.toHaveTextContent(/fictional/i);
  });
});
