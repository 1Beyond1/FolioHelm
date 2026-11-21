import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";
import { OrdersPage } from "../../src/features/orders/OrdersPage";
import { clearEvidence, listEvidence, verifyEvidence } from "../../src/domain/evidenceJournal";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { getMockPortfolio } from "../../src/mocks/portfolio";

afterEach(async () => {
  cleanup();
  MOCK_BROKER.reset();
  await clearEvidence();
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
  it("localizes holding companies in the portfolio view", () => {
    render(
      <PortfolioPage
        language="zh"
        onOpenInstrument={() => undefined}
        onOpenTrade={() => undefined}
      />,
    );

    expect(screen.getByText("苹果公司")).toBeInTheDocument();
    expect(screen.queryByText("Apple Inc.")).not.toBeInTheDocument();
  });

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
    expect(screen.getByTestId("portfolio-return-stat")).toHaveTextContent("0.0%");
  });

  it("keeps the return curve negative in the loss scenario", () => {
    MOCK_BROKER.setScenario("loss");

    render(
      <PortfolioPage
        language="en"
        onOpenInstrument={() => undefined}
        onOpenTrade={() => undefined}
      />,
    );

    expect(screen.getByTestId("portfolio-return-stat")).toHaveTextContent(/^-/);
  });

  it("localizes Mock activity content for Chinese users", () => {
    const activity = getMockPortfolio("zh").activity;

    expect(activity).not.toHaveLength(0);
    expect(activity.every((item) => !/\b(buy|sell|working|filled|shares|market)\b/i.test(`${item.title} ${item.detail}`))).toBe(true);
    expect(activity[0]?.title).toContain("买入");
    expect(activity[0]?.detail).toContain("股");
  });

  it("uses cumulative unrealized P&L (totalPnl) consistently on home positions instead of dayPnl", () => {
    const snapshot = MOCK_BROKER.getSnapshot();
    const portfolio = getMockPortfolio("en");
    const aaplHolding = snapshot.holdings.find((item) => item.symbol === "AAPL")!;
    const aaplPosition = portfolio.positions.find((item) => item.ticker === "AAPL")!;

    expect(aaplHolding.totalPnl).not.toBe(aaplHolding.dayPnl);
    expect(aaplPosition.unrealizedPnl).toBe(Number(aaplHolding.totalPnl));
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
    expect(screen.getByTestId("orders-timeline-ORD-1044")).toHaveTextContent("按模拟报价成交 8 股");

    fireEvent.click(screen.getByTestId("orders-new-order"));
    expect(onOpenTrade).toHaveBeenCalledTimes(1);
  });

  it("reconciles an unknown order via the Reconcile action and records reconciliation evidence", async () => {
    render(<OrdersPage language="en" onOpenTrade={vi.fn()} />);

    fireEvent.click(screen.getByTestId("orders-tab-unknown"));
    expect(screen.getByTestId("orders-count-unknown")).toHaveTextContent("1");
    expect(screen.getByTestId("orders-count-working")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("orders-reconcile-ORD-1047"));

    expect(screen.getByTestId("orders-count-unknown")).toHaveTextContent("0");
    expect(screen.getByTestId("orders-count-working")).toHaveTextContent("2");
    expect(screen.getByTestId("orders-reconcile-feedback")).toHaveTextContent(/Reconciled ORD-1047/i);

    await waitFor(async () => {
      const records = await listEvidence();
      expect(records.some((r) => r.kind === "reconciliation" && r.payload.orderId === "ORD-1047" && r.payload.nextStatus === "working")).toBe(true);
    });
    expect((await verifyEvidence()).valid).toBe(true);
  });

  it("keeps an unknown order locked and shows an alert when reconciliation fails", async () => {
    MOCK_BROKER.setScenario("reconciliation-failed");
    render(<OrdersPage language="zh" onOpenTrade={vi.fn()} />);

    fireEvent.click(screen.getByTestId("orders-tab-unknown"));
    fireEvent.click(screen.getByTestId("orders-reconcile-ORD-1047"));

    expect(screen.getByTestId("orders-count-unknown")).toHaveTextContent("1");
    expect(screen.getByTestId("orders-reconcile-feedback")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("orders-reconcile-feedback")).toHaveTextContent(/对账失败/);

    await waitFor(async () => {
      const records = await listEvidence();
      expect(records.some((r) => r.kind === "reconciliation" && r.payload.outcome === "failed")).toBe(true);
    });
  });
});
