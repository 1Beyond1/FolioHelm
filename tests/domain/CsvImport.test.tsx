import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPersistedLocalPortfolio,
  commitBrokerCsv,
  parseCsvDecimal,
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

  it("supports Fidelity, Vanguard, Futu, and Tiger CSV headers while isolating multi-currency portfolios fail-safe", async () => {
    const fidelityCsv = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis,Percent Of Account
X123,Individual,VOO,VANGUARD S&P 500 ETF,10,$515.00,$5150.00,$4600.00,$460.00,65%
X123,Individual,SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,--,--,$2850.00,--,--,35%`;
    const fid = await parseCsvLocally(fidelityCsv, "fidelity.csv");
    expect(fid.detectedFormat).toBe("fidelity_positions");
    expect(fid.snapshot.cash).toBe("2850.00");
    expect(fid.snapshot.holdings[0]).toMatchObject({ symbol: "VOO", averageCost: "460.0000", lastPrice: "515.0000" });

    const vanguardCsv = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value
123456,Vanguard Total Stock Market ETF,VTI,20,$280.50,$5610.00
123456,Vanguard Federal Money Market Fund,VMFXX,1200.50,$1.00,$1200.50`;
    const van = await parseCsvLocally(vanguardCsv, "vanguard.csv");
    expect(van.detectedFormat).toBe("vanguard_positions");
    expect(van.snapshot.cash).toBe("1200.50");
    expect(van.snapshot.holdings[0]).toMatchObject({ symbol: "VTI", quantity: "20", lastPrice: "280.5000" });

    const futuMultiCurrencyCsv = `股票代码,股票名称,持有数量,稀释成本价,现价,市值,币种
US.QQQ,纳指100ETF,10,450.00,490.00,4900.00,美元
HK.00700,腾讯控股,100,320.00,380.00,38000.00,港元
美元现金,--,--,--,--,2000.00,美元
港元现金,--,--,--,--,15000.00,港元`;
    const futu = await parseCsvLocally(futuMultiCurrencyCsv, "futu.csv");
    expect(futu.detectedFormat).toBe("futu_positions");
    expect(futu.snapshot.isMultiCurrency).toBe(true);
    expect(futu.snapshot.currency).toBe("MULTI");
    expect(futu.snapshot.currencies).toEqual(["HKD", "USD"]);
    expect(futu.snapshot.cash).toBe("0.00");
    expect(futu.snapshot.cashByCurrency).toEqual({ HKD: "15000.00", USD: "2000.00" });
    expect(futu.currencySubtotals).toEqual([
      { currency: "HKD", holdingsValue: "38000.00", cash: "15000.00", totalValue: "53000.00", holdingsCount: 1 },
      { currency: "USD", holdingsValue: "4900.00", cash: "2000.00", totalValue: "6900.00", holdingsCount: 1 },
    ]);
    expect(futu.warnings.some((w) => w.includes("Multi-currency CSV detected"))).toBe(true);
    expect(futu.snapshot.holdings.map((h) => h.symbol)).toEqual(["00700.HK", "QQQ"]);

    const tigerCsv = `标的代码,标的名称,持仓数量,持仓均价,最新价,持仓市值,结算币种,账户现金
BRK.B,伯克希尔B,5,410.00,455.00,$2275.00,USD,$1500.00`;
    const tiger = await parseCsvLocally(tigerCsv, "tiger.csv");
    expect(tiger.detectedFormat).toBe("tiger_positions");
    expect(tiger.snapshot.isMultiCurrency).toBe(false);
    expect(tiger.snapshot.cash).toBe("1500.00");
    expect(tiger.snapshot.holdings[0]).toMatchObject({ symbol: "BRK.B", averageCost: "410.0000", lastPrice: "455.0000" });
  });

  it("normalizes Schwab cross-year MM/DD/YYYY dates and replays same-day SPLIT -> BUY -> SELL without ghost holdings", async () => {
    const schwabTx = `"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"01/05/2026","Sell","GHOST","GHOST CORP","100","$55.00","$0.00","$5,500.00"
"12/20/2025","Buy","GHOST","GHOST CORP","100","$50.00","$0.00","-$5,000.00"
"01/15/2026","Cash Dividend","AAPL","APPLE INC","","","$0.00","$12.00"
"01/15/2026","Sell","AAPL","APPLE INC","20","$105.00","$0.00","$2,100.00"
"01/15/2026","Buy","AAPL","APPLE INC","10","$100.00","$0.00","-$1,000.00"
"01/15/2026","Stock Split","AAPL","APPLE INC","30","$0.00","$0.00","$0.00"
"01/02/2026 as of 12/31/2025","Buy","AAPL","APPLE INC","10","$400.00","$0.00","-$4,000.00"
`;
    const preview = await parseCsvLocally(schwabTx, "schwab-tx.csv");
    expect(preview.detectedFormat).toBe("schwab_transactions");
    expect(preview.snapshot.holdings.some((h) => h.symbol === "GHOST")).toBe(false);
    expect(preview.snapshot.holdings).toHaveLength(1);
    expect(preview.snapshot.holdings[0]).toMatchObject({
      symbol: "AAPL",
      quantity: "30",
      averageCost: "100.0000",
      lastPrice: "105.0000",
    });
    expect(preview.snapshot.transactions.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true);
    expect(preview.snapshot.transactions[0]?.date).toBe("2025-12-20");
  });

  it("handles (-$100), Unicode minus/NBSP, trailing currencies, negative price rejection, Vanguard dual-table, Fidelity footers, Futu SH/SZ/SG & option skipping, and IBKR N/A", async () => {
    expect(parseCsvDecimal("(-$100.50)", 1, "Amount")).toBe("-100.5");
    expect(parseCsvDecimal("($-100.50)", 1, "Amount")).toBe("-100.5");
    expect(parseCsvDecimal("\u22121\u00a0234.50 HKD", 1, "Amount")).toBe("-1234.5");
    expect(parseCsvDecimal("250.75€", 1, "Amount")).toBe("250.75");
    expect(() => parseCsvDecimal("--100", 1, "Amount")).toThrow();
    expect(() => parseCsvDecimal("(+100)", 1, "Amount")).toThrow();

    await expect(
      parseCsvLocally("symbol,quantity,average_cost,price\nAAPL,10,150.00,-20.00", "neg-price.csv"),
    ).rejects.toThrow(/Negative last_price/i);
    await expect(
      parseCsvLocally("symbol,quantity,average_cost,price\nAAPL,10,(-$150.00),200.00", "neg-cost.csv"),
    ).rejects.toThrow(/Negative average_cost/i);

    const vanguardDual = `Account Number,Investment Name,Symbol,Shares,Share Price,Total Value
123456,Vanguard Total Stock Market ETF,VTI,20,$280.50,$5610.00
123456,Vanguard Federal Money Market Fund,VMFXX,1200.50,$1.00,$1200.50

Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type
123456,11/15/2026,11/17/2026,Buy,Buy,Vanguard Total Stock Market ETF,VTI,5,$275.00,-$1375.00,$0.00,-$1375.00,$0.00,INDIVIDUAL
123456,11/15/2026,11/17/2026,Sweep Out,Sweep Out,Vanguard Federal Money Market Fund,VMFXX,-1375,$1.00,$1375.00,$0.00,$1375.00,$0.00,INDIVIDUAL`;
    const van = await parseCsvLocally(vanguardDual, "vanguard-dual.csv");
    expect(van.snapshot.holdings).toHaveLength(1);
    expect(van.snapshot.holdings[0]?.quantity).toBe("20");
    expect(van.snapshot.cash).toBe("1200.50");
    expect(van.snapshot.transactions).toHaveLength(1);
    expect(van.snapshot.transactions[0]?.date).toBe("2026-11-15");

    const fidelityWithFooters = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis,Percent Of Account
X123,Individual,VOO,VANGUARD S&P 500 ETF,10,$515.00,$5150.00,$4600.00,$460.00,64%
X123,Individual,-AAPL261218C250,AAPL CALL,1,$12.00,$1200.00,$1000.00,$10.00,5%
X123,Individual,SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,--,--,$2850.00,--,--,31%

"The data and information in this spreadsheet is provided to you solely for your use."
"Brokerage services provided by Fidelity Brokerage Services LLC."
"Date downloaded Nov-21-2026 4:05 p.m ET"`;
    const fid = await parseCsvLocally(fidelityWithFooters, "fid.csv");
    expect(fid.snapshot.holdings).toHaveLength(1);
    expect(fid.snapshot.cash).toBe("2850.00");
    expect(fid.warnings.some((w) => w.includes("option"))).toBe(true);

    const schwabMktVal = `"Symbol","Description","Quantity","Price","Mkt Val (Market Value)","Cost Basis","Security Type"
"AAPL","APPLE INC","10","$200.00","$2,000.00","$1,800.00","Equity"
"Cash & Cash Investments","--","--","--","$3,456.78","--","Cash and Money Market"`;
    const sch = await parseCsvLocally(schwabMktVal, "schwab-mkt.csv");
    expect(sch.snapshot.cash).toBe("3456.78");

    const futuMulti = `股票代码,股票名称,持有数量,稀释成本价,现价,参考市值,币种,资产类别
SH.600519,贵州茅台,100,1500.00,1600.00,160000.00,人民币,正股
SZ.000001,平安银行,200,10.00,11.00,2200.00,人民币,正股
SG.D05,星展集团,100,35.00,40.00,4000.00,新元,正股
US.AAPL261218C250000,AAPL CALL,2,5.00,6.00,1200.00,美元,期权
人民币现金,--,--,--,--,5000.00,人民币,现金`;
    const futu = await parseCsvLocally(futuMulti, "futu-real.csv");
    expect(futu.snapshot.holdings.map((h) => h.symbol)).toEqual(["000001.SZ", "600519.SS", "D05.SI"]);
    expect(futu.snapshot.cashByCurrency.CNY).toBe("5000.00");
    expect(futu.warnings.some((w) => w.includes("option"))).toBe(true);

    const ibkrNa = `Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Cost Price,Close Price,Description
Positions,Data,Summary,Stocks,USD,MSFT,10,--,420.00,MICROSOFT CORP
Positions,Data,Summary,Equity and Index Options,USD,AAPL 18DEC26 250 C,1,5.00,6.00,AAPL CALL
Trades,Header,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Proceeds,Comm/Fee
Trades,Data,Stocks,USD,MSFT,"2026-11-20, 10:15:00",10,410.00,-4100.00,--
Cash Report,Header,Currency Summary,Currency,Total
Cash Report,Data,Ending Cash,USD,N/A
Cash Report,Data,Ending Cash,EUR,1000.00`;
    const ibkr = await parseCsvLocally(ibkrNa, "ibkr-na.csv");
    expect(ibkr.snapshot.holdings).toHaveLength(1);
    expect(ibkr.snapshot.holdings[0]?.averageCost).toBe("420.0000");
    expect(ibkr.snapshot.transactions[0]?.date).toBe("2026-11-20");
    expect(ibkr.snapshot.cashByCurrency.EUR).toBe("1000.00");
    expect(ibkr.warnings.some((w) => w.includes("option"))).toBe(true);
  });
});
