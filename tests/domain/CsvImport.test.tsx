import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPersistedLocalPortfolio,
  commitBrokerCsv,
  parseCsvLocally,
} from "../../src/domain/csvImport";
import { clearEvidence, listEvidence, verifyEvidence } from "../../src/domain/evidenceJournal";
import { MOCK_BROKER } from "../../src/domain/mockBroker";
import { PortfolioPage } from "../../src/features/portfolio/PortfolioPage";

afterEach(async () => {
  cleanup();
  MOCK_BROKER.reset();
  await clearPersistedLocalPortfolio();
  await clearEvidence();
});

const SCHWAB_POSITIONS_CSV = `"Positions for account Individual ...1234 as of 04:00 PM ET, 2026/11/21"
""
"Symbol","Description","Quantity","Price","Price Change $","Market Value","Cost Basis","Security Type"
"AAPL","APPLE INC","100","$228.50","+$2.10","$22,850.00","$19,500.00","Equity"
"VOO","VANGUARD S&P 500 ETF","20","$510.00","+$3.00","$10,200.00","$9,200.00","ETF"
"Cash & Cash Investments","--","--","--","--","$4,500.25","--","Cash and Money Market"
"Account Total","","","--","--","$37,550.25","$28,700.00",""
`;

const IBKR_ACTIVITY_CSV = `Statement,Header,Field Name,Field Value
Statement,Data,BrokerName,Interactive Brokers
Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Cost Price,Close Price,Description
Positions,Data,Summary,Stocks,USD,MSFT,15,380.50,415.00,MICROSOFT CORP
Positions,Data,Total,Stocks,USD,,15,,,
Cash Report,Header,Currency Summary,Currency,Total
Cash Report,Data,Ending Cash,USD,2100.75
`;

describe("Broker CSV safe import & mode isolation", () => {
  it("parses Schwab positions CSV using exact Decimal arithmetic and extracts cash", async () => {
    const preview = await parseCsvLocally(SCHWAB_POSITIONS_CSV, "schwab.csv");
    expect(preview.detectedFormat).toBe("schwab_positions");
    expect(preview.snapshot.cash).toBe("4500.25");
    expect(preview.snapshot.holdings).toHaveLength(2);
    expect(preview.snapshot.holdings[0]).toMatchObject({
      symbol: "AAPL",
      quantity: "100",
      averageCost: "195.0000",
      lastPrice: "228.5000",
    });
    expect(preview.snapshot.holdings[1]).toMatchObject({
      symbol: "VOO",
      quantity: "20",
      averageCost: "460.0000",
      lastPrice: "510.0000",
    });
  });

  it("parses IBKR multi-section Activity Statement CSV", async () => {
    const preview = await parseCsvLocally(IBKR_ACTIVITY_CSV, "ibkr.csv");
    expect(preview.detectedFormat).toBe("ibkr_activity");
    expect(preview.snapshot.cash).toBe("2100.75");
    expect(preview.snapshot.holdings).toHaveLength(1);
    expect(preview.snapshot.holdings[0]).toMatchObject({
      symbol: "MSFT",
      quantity: "15",
      averageCost: "380.5000",
      lastPrice: "415.0000",
    });
  });

  it("sanitizes CSV formula injection prefixes and rejects negative quantities or invalid symbols", async () => {
    const formulaCsv = `symbol,description,quantity,average_cost,price,cash
NVDA,"=CMD|' /C calc'!A0",10,115.25,130.00,500.00`;
    const preview = await parseCsvLocally(formulaCsv, "formula.csv");
    expect(preview.snapshot.holdings[0]?.company.startsWith("=")).toBe(false);
    expect(preview.warnings.some((w) => w.includes("formula prefix"))).toBe(true);

    await expect(
      parseCsvLocally("symbol,quantity,average_cost,price\nAAPL,-3,100,120", "neg.csv"),
    ).rejects.toThrow(/Negative holding quantity/i);

    await expect(
      parseCsvLocally("symbol,quantity,average_cost,price\n=EVIL,3,100,120", "bad.csv"),
    ).rejects.toThrow(/Invalid symbol/i);
  });

  it("deduplicates identical CSV imports idempotently and records verifiable portfolio_import evidence", async () => {
    const first = await commitBrokerCsv(SCHWAB_POSITIONS_CSV, "first.csv");
    expect(first.deduplicated).toBe(false);
    expect(first.evidenceSequence).toBe(1);

    const second = await commitBrokerCsv(SCHWAB_POSITIONS_CSV, "second-copy.csv");
    expect(second.deduplicated).toBe(true);
    expect(second.evidenceSequence).toBeNull();

    const records = await listEvidence();
    expect(records.filter((r) => r.kind === "portfolio_import")).toHaveLength(1);
    expect((await verifyEvidence()).valid).toBe(true);
  });

  it("isolates Mock Demo ledger from Local Portfolio (CSV + Paper) ledger", async () => {
    const committed = await commitBrokerCsv(SCHWAB_POSITIONS_CSV, "schwab.csv");
    MOCK_BROKER.applyLocalPortfolioSnapshot(committed.snapshot, { switchMode: true });

    expect(MOCK_BROKER.getWorkspaceMode()).toBe("local-csv");
    const localSnap = MOCK_BROKER.getSnapshot();
    expect(localSnap.mode).toBe("local-csv");
    expect(localSnap.holdings.map((h) => h.symbol)).toEqual(["AAPL", "VOO"]);
    expect(localSnap.account.cash).toBe("4500.25");

    // Switching back to Mock Demo restores the untouched fictional ledger.
    MOCK_BROKER.setWorkspaceMode("mock");
    const mockSnap = MOCK_BROKER.getSnapshot();
    expect(mockSnap.mode).toBe("mock");
    expect(mockSnap.holdings.map((h) => h.symbol)).toEqual(["AAPL", "NVDA", "SPY", "MSFT"]);
    expect(mockSnap.account.cash).toBe("5320");
  });

  it("supports importing a broker CSV through PortfolioPage preview modal and switching back to Mock Demo", async () => {
    render(
      <PortfolioPage
        language="en"
        onOpenInstrument={() => undefined}
        onOpenTrade={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId("open-csv-import"));
    const input = screen.getByTestId("csv-file-input") as HTMLInputElement;
    const file = new File([SCHWAB_POSITIONS_CSV], "schwab.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => SCHWAB_POSITIONS_CSV });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId("csv-import-preview")).toBeInTheDocument());
    expect(screen.getByTestId("csv-import-preview")).toHaveTextContent("Charles Schwab Positions CSV");

    fireEvent.click(screen.getByTestId("csv-confirm-import"));

    await waitFor(() => expect(screen.getByTestId("csv-import-feedback")).toBeInTheDocument());
    expect(screen.getByTestId("portfolio-holding-row-VOO")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-mode-local")).toHaveAttribute("aria-pressed", "true");

    // Switch back to Mock Demo cleanly
    fireEvent.click(screen.getByTestId("workspace-mode-mock"));
    expect(screen.getByTestId("portfolio-holding-row-SPY")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-holding-row-VOO")).not.toBeInTheDocument();
  });
});
