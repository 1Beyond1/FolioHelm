import {
  decimal,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMultiply,
  decimalRound,
  decimalSubtract,
  decimalToFixed,
  type DecimalString,
} from "./decimal";
import { appendEvidence } from "./evidenceJournal";
import { readStored, removeStored, writeStored } from "../platform/storage";
import {
  invokeCsvCommitImport,
  invokeCsvPreviewImport,
  invokeVaultClearPortfolio,
  invokeVaultLoadPortfolio,
  isTauriRuntime,
  type TauriCsvCommitResult,
  type TauriCsvImportPreview,
  type TauriStoredPortfolioHolding,
  type TauriStoredPortfolioSnapshot,
  type TauriStoredPortfolioTransaction,
} from "./tauriBridge";

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
const ZERO = decimal("0");
const LOCAL_PORTFOLIO_KEY = "local-csv-portfolio";
const LOCAL_FINGERPRINTS_KEY = "local-csv-fingerprints";

export type CsvFormatCode =
  | "schwab_positions"
  | "schwab_transactions"
  | "ibkr_activity"
  | "ibkr_positions"
  | "generic_csv";

export type ImportedPortfolioHolding = TauriStoredPortfolioHolding;
export type ImportedPortfolioTransaction = TauriStoredPortfolioTransaction;
export type ImportedPortfolioSnapshot = TauriStoredPortfolioSnapshot;
export type CsvImportPreview = TauriCsvImportPreview;
export type CsvCommitResult = TauriCsvCommitResult;

const FORMAT_LABELS: Record<CsvFormatCode, { en: string; zh: string }> = {
  schwab_positions: { en: "Charles Schwab Positions CSV", zh: "嘉信理财持仓 CSV" },
  schwab_transactions: { en: "Charles Schwab Transactions CSV", zh: "嘉信理财交易流水 CSV" },
  ibkr_activity: { en: "IBKR Activity Statement CSV", zh: "盈透证券活动报表 CSV" },
  ibkr_positions: { en: "IBKR Positions CSV", zh: "盈透证券持仓 CSV" },
  generic_csv: { en: "Standard Portfolio CSV", zh: "通用标准持仓 CSV" },
};

function normalizeHeader(header: string): string {
  return header.trim().replace(/^"+|"+$/g, "").toLowerCase().replace(/\s+/g, " ");
}

function findCell(headers: readonly string[], row: readonly string[], aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    for (let i = 0; i < headers.length; i += 1) {
      if (normalizeHeader(headers[i] ?? "") === alias) {
        return row[i];
      }
    }
  }
  return undefined;
}

function isCashRow(symbolLower: string): boolean {
  return symbolLower === "cash"
    || symbolLower === "cash & cash investments"
    || symbolLower === "cash & money market"
    || symbolLower === "usd"
    || symbolLower === "cash balance";
}

function isSummaryOrBlankSymbol(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return lower.includes("total")
    || lower.startsWith("positions for")
    || lower.startsWith("account ")
    || lower === "--"
    || lower === "n/a";
}

function isNaPlaceholder(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === "--" || lower === "n/a" || lower === "na" || lower === "-";
}

function normalizeCurrency(raw: string | undefined): string {
  const clean = (raw ?? "").trim().replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 3);
  return clean.length === 3 ? clean : "USD";
}

export function sanitizeCsvTextCell(raw: string, fieldName: string, warnings: string[]): string {
  const noCtrl = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  let stripped = noCtrl.trim();
  if (!stripped) return "";
  let hadFormula = false;
  while (stripped.length > 0 && /^[=+\-@\t\r]/.test(stripped)) {
    hadFormula = true;
    stripped = stripped.slice(1).trimStart();
  }
  if (hadFormula) {
    warnings.push(`Sanitized potential CSV formula prefix in ${fieldName} column`);
  }
  return stripped.slice(0, 120);
}

export function validateCsvSymbol(raw: string, rowNum: number): string {
  const cleaned = raw.trim().replace(/^\$/, "").toUpperCase();
  if (!SYMBOL_RE.test(cleaned)) {
    throw new Error(`Invalid symbol in row ${rowNum}: ${raw.trim().slice(0, 24)}`);
  }
  return cleaned;
}

export function parseCsvDecimal(raw: string, rowNum: number, column: string): DecimalString {
  let text = raw.trim();
  if (!text) throw new Error(`Invalid decimal value in row ${rowNum}, column '${column}': ${raw}`);
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")") && text.length > 2) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }
  text = text.replace(/^\$/, "").trim();
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  const compact = text.replace(/[, ]+/g, "");
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(compact)) {
    throw new Error(`Invalid decimal value in row ${rowNum}, column '${column}': ${raw}`);
  }
  const value = decimal(`${negative ? "-" : ""}${compact}`);
  return decimalRound(value, 8, "half-up");
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      cell = "";
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      if (rows.length > MAX_CSV_ROWS) {
        throw new Error(`CSV file exceeds the ${MAX_CSV_ROWS} row safety limit`);
      }
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function collectMappings(headers: readonly string[]): { canonicalField: string; sourceHeader: string }[] {
  const specs: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["symbol", ["symbol", "ticker"]],
    ["company", ["description", "company", "name"]],
    ["quantity", ["quantity", "qty", "shares", "position"]],
    ["averageCost", ["average_cost", "average cost", "avg_cost", "avg cost", "costbasisprice", "cost basis price", "cost price", "cost basis", "cost_basis"]],
    ["price", ["price", "last", "last price", "markprice", "mark price", "close price", "t. price"]],
    ["cash", ["cash", "cash balance", "cash_balance"]],
    ["currency", ["currency", "ccy"]],
    ["date", ["date", "date/time", "trade date"]],
    ["action", ["action", "side", "transaction type"]],
  ];
  const out: { canonicalField: string; sourceHeader: string }[] = [];
  for (const [canonicalField, aliases] of specs) {
    const matched = headers.find((h) => aliases.includes(normalizeHeader(h)));
    if (matched) out.push({ canonicalField, sourceHeader: matched });
  }
  return out;
}

interface HoldingAccumulator {
  symbol: string;
  company: string;
  quantity: DecimalString;
  totalCost: DecimalString;
  lastPrice: DecimalString;
  currency: string;
}

function accumulateHolding(
  map: Map<string, HoldingAccumulator>,
  symbol: string,
  company: string,
  qty: DecimalString,
  avgCost: DecimalString,
  lastPrice: DecimalString,
  currency: string,
): void {
  const addedCost = decimalRound(decimalMultiply(qty, avgCost), 8, "half-up");
  const existing = map.get(symbol);
  if (existing) {
    existing.quantity = decimalAdd(existing.quantity, qty);
    existing.totalCost = decimalAdd(existing.totalCost, addedCost);
    if (decimalCompare(lastPrice, ZERO) > 0) existing.lastPrice = lastPrice;
    if (!existing.company && company) existing.company = company;
  } else {
    map.set(symbol, {
      symbol,
      company,
      quantity: qty,
      totalCost: addedCost,
      lastPrice,
      currency,
    });
  }
}

function replayTransactions(
  transactions: readonly ImportedPortfolioTransaction[],
  map: Map<string, HoldingAccumulator>,
  warnings: string[],
): void {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const tx of sorted) {
    const actionLower = tx.action.toLowerCase();
    const qty = decimal(tx.quantity);
    const price = decimal(tx.price);
    if (decimalCompare(qty, ZERO) <= 0) continue;

    if (actionLower.includes("buy") || actionLower.includes("reinvest")) {
      accumulateHolding(map, tx.symbol, tx.symbol, qty, price, price, tx.currency);
    } else if (actionLower.includes("sell")) {
      const existing = map.get(tx.symbol);
      if (existing) {
        if (decimalCompare(qty, existing.quantity) >= 0) {
          existing.quantity = ZERO;
          existing.totalCost = ZERO;
        } else {
          const avg = decimalDivide(existing.totalCost, existing.quantity, 8, "half-up");
          existing.quantity = decimalSubtract(existing.quantity, qty);
          existing.totalCost = decimalRound(decimalMultiply(existing.quantity, avg), 8, "half-up");
        }
        if (decimalCompare(price, ZERO) > 0) existing.lastPrice = price;
      } else {
        warnings.push(`Sell transaction for ${tx.symbol} had no prior buy lot in CSV; skipped in holding replay`);
      }
    }
  }
  for (const [symbol, entry] of map) {
    if (decimalCompare(entry.quantity, ZERO) <= 0) map.delete(symbol);
  }
}

function finalizeHoldings(map: Map<string, HoldingAccumulator>): ImportedPortfolioHolding[] {
  return [...map.values()]
    .filter((entry) => decimalCompare(entry.quantity, ZERO) > 0)
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((entry) => {
      const avgCost = decimalDivide(entry.totalCost, entry.quantity, 4, "half-up");
      const lastPrice = decimalCompare(entry.lastPrice, ZERO) > 0 ? entry.lastPrice : avgCost;
      return {
        symbol: entry.symbol,
        company: entry.company || entry.symbol,
        quantity: decimal(entry.quantity),
        averageCost: decimalToFixed(avgCost, 4, "half-up"),
        lastPrice: decimalToFixed(lastPrice, 4, "half-up"),
        currency: entry.currency,
      };
    });
}

async function computeFingerprint(
  sourceFormat: string,
  currency: string,
  cash: string,
  holdings: readonly ImportedPortfolioHolding[],
  transactions: readonly ImportedPortfolioTransaction[],
): Promise<string> {
  const lines = [
    "foliohelm/csv-portfolio-fingerprint/v1",
    sourceFormat,
    currency,
    cash,
    ...holdings.map((h) => `H|${h.symbol}|${h.quantity}|${h.averageCost}|${h.lastPrice}|${h.currency}`),
    ...transactions.map((t) => `T|${t.date}|${t.action}|${t.symbol}|${t.quantity}|${t.price}|${t.amount}|${t.currency}`),
    "",
  ];
  const material = lines.join("\n");
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable; CSV import blocked for safety");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function locateHeaderRow(rows: readonly (readonly string[])[]): { index: number; format: CsvFormatCode } | null {
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    const normalized = (rows[i] ?? []).map(normalizeHeader);
    const hasSymbol = normalized.some((h) => h === "symbol" || h === "ticker");
    if (!hasSymbol) continue;

    const hasAction = normalized.some((h) => h === "action" || h === "side" || h === "transaction type");
    const hasFeesComm = normalized.includes("fees & comm");
    const hasSchwabPos = normalized.some((h) =>
      h === "price change $" || h === "mkt val (market value)" || h === "reinvest?" || h === "security type");
    const hasIbkrFlat = normalized.some((h) =>
      h === "costbasisprice" || h === "markprice" || h === "fifopnlunrealized");
    const hasQty = normalized.some((h) =>
      h === "quantity" || h === "qty" || h === "shares" || h === "position");

    if (hasAction && (hasFeesComm || normalized.includes("date"))) {
      return { index: i, format: "schwab_transactions" };
    }
    if (hasSchwabPos && hasQty) return { index: i, format: "schwab_positions" };
    if (hasIbkrFlat && hasQty) return { index: i, format: "ibkr_positions" };
    if (hasQty) return { index: i, format: "generic_csv" };
  }
  return null;
}

function storedFingerprints(): string[] {
  const saved = readStored<unknown>(LOCAL_FINGERPRINTS_KEY, []);
  return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
}

/** Deterministic local CSV parser used in browser/Vitest environments (mirrors Rust parser). */
export async function parseCsvLocally(
  rawCsv: string,
  sourceLabel = "imported.csv",
): Promise<CsvImportPreview> {
  if (!rawCsv || !rawCsv.trim()) throw new Error("CSV payload is empty");
  const byteSize = new TextEncoder().encode(rawCsv).byteLength;
  if (byteSize > MAX_CSV_BYTES) {
    throw new Error(`CSV file exceeds the 5 MB safety limit (${byteSize} bytes)`);
  }

  const cleaned = rawCsv.startsWith("\uFEFF") ? rawCsv.slice(1) : rawCsv;
  const rows = parseCsvRows(cleaned);
  if (rows.length > MAX_CSV_ROWS) {
    throw new Error(`CSV file exceeds the ${MAX_CSV_ROWS} row safety limit`);
  }

  const warnings: string[] = [];
  const safeLabel = sanitizeCsvTextCell(sourceLabel, "filename", warnings) || "imported.csv";
  const holdingsMap = new Map<string, HoldingAccumulator>();
  const transactions: ImportedPortfolioTransaction[] = [];
  let cash = ZERO;
  let currency = "USD";
  let skippedRows = 0;
  let format: CsvFormatCode = "generic_csv";
  let columnMappings: { canonicalField: string; sourceHeader: string }[] = [];

  const isIbkrMulti = rows.some(
    (row) =>
      row.length >= 4
      && ["positions", "open positions", "trades", "cash report"].includes((row[0] ?? "").trim().toLowerCase())
      && (row[1] ?? "").trim().toLowerCase() === "header",
  );

  if (isIbkrMulti) {
    format = "ibkr_activity";
    let posHeaders: string[] | null = null;
    let tradeHeaders: string[] | null = null;
    let cashHeaders: string[] | null = null;
    const mappingMap = new Map<string, { canonicalField: string; sourceHeader: string }>();

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx]!;
      const rowNum = idx + 1;
      if (row.length < 3) {
        skippedRows += 1;
        continue;
      }
      const section = (row[0] ?? "").trim().toLowerCase();
      const rowType = (row[1] ?? "").trim().toLowerCase();
      const rest = row.slice(2);

      if (rowType === "header") {
        const hdrs = rest.map((s) => s.trim());
        if (section === "positions" || section === "open positions") {
          posHeaders = hdrs;
          collectMappings(hdrs).forEach((m) => mappingMap.set(m.canonicalField, m));
        } else if (section === "trades") {
          tradeHeaders = hdrs;
          collectMappings(hdrs).forEach((m) => mappingMap.set(m.canonicalField, m));
        } else if (section === "cash report") {
          cashHeaders = hdrs;
        }
        continue;
      }

      if (rowType !== "data") {
        skippedRows += 1;
        continue;
      }

      if ((section === "positions" || section === "open positions") && posHeaders) {
        const disc = findCell(posHeaders, rest, ["datadiscriminator", "header"])?.trim().toLowerCase();
        if (disc === "total" || disc === "subtotal") {
          skippedRows += 1;
          continue;
        }
        const rawSymbol = findCell(posHeaders, rest, ["symbol", "ticker"]) ?? "";
        if (isSummaryOrBlankSymbol(rawSymbol)) {
          skippedRows += 1;
          continue;
        }
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const qtyRaw = findCell(posHeaders, rest, ["quantity", "position", "shares"]) ?? "";
        const qty = parseCsvDecimal(qtyRaw, rowNum, "Quantity");
        if (decimalCompare(qty, ZERO) < 0) {
          throw new Error(`Negative holding quantity is not allowed in row ${rowNum} for ${symbol}`);
        }
        if (decimalCompare(qty, ZERO) === 0) {
          skippedRows += 1;
          continue;
        }
        const markRaw = findCell(posHeaders, rest, ["close price", "markprice", "mark price", "price"]);
        const costPriceRaw = findCell(posHeaders, rest, ["cost price", "costbasisprice", "cost basis price", "average cost", "avg cost"]);
        const costBasisRaw = findCell(posHeaders, rest, ["cost basis", "costbasis"]);

        const lastPrice = markRaw && markRaw.trim() ? parseCsvDecimal(markRaw, rowNum, "Close Price") : ZERO;
        let avgCost = lastPrice;
        if (costPriceRaw && costPriceRaw.trim()) {
          avgCost = parseCsvDecimal(costPriceRaw, rowNum, "Cost Price");
        } else if (costBasisRaw && costBasisRaw.trim()) {
          avgCost = decimalDivide(parseCsvDecimal(costBasisRaw, rowNum, "Cost Basis"), qty, 8, "half-up");
        }
        const effectiveLast = decimalCompare(lastPrice, ZERO) > 0 ? lastPrice : avgCost;
        const company = sanitizeCsvTextCell(
          findCell(posHeaders, rest, ["description", "company", "name"]) ?? "",
          "Description",
          warnings,
        );
        currency = normalizeCurrency(findCell(posHeaders, rest, ["currency"]));
        accumulateHolding(holdingsMap, symbol, company, qty, avgCost, effectiveLast, currency);
      } else if (section === "trades" && tradeHeaders) {
        const rawSymbol = findCell(tradeHeaders, rest, ["symbol", "ticker"]) ?? "";
        if (isSummaryOrBlankSymbol(rawSymbol)) {
          skippedRows += 1;
          continue;
        }
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const qty = parseCsvDecimal(findCell(tradeHeaders, rest, ["quantity", "shares"]) ?? "0", rowNum, "Quantity");
        const px = parseCsvDecimal(findCell(tradeHeaders, rest, ["t. price", "trade price", "price"]) ?? "0", rowNum, "Price");
        const proceedsRaw = findCell(tradeHeaders, rest, ["proceeds", "amount"]) ?? "0";
        const commRaw = findCell(tradeHeaders, rest, ["comm/fee", "commission", "fees"]) ?? "0";
        const proceeds = proceedsRaw.trim() ? parseCsvDecimal(proceedsRaw, rowNum, "Proceeds") : ZERO;
        const comm = commRaw.trim() ? parseCsvDecimal(commRaw, rowNum, "Comm/Fee") : ZERO;
        const date = sanitizeCsvTextCell(findCell(tradeHeaders, rest, ["date/time", "date", "trade date"]) ?? "", "Date/Time", warnings);
        const txCurrency = normalizeCurrency(findCell(tradeHeaders, rest, ["currency"]));
        transactions.push({
          date,
          action: decimalCompare(qty, ZERO) >= 0 ? "BUY" : "SELL",
          symbol,
          quantity: decimal(qty.startsWith("-") ? qty.slice(1) : qty),
          price: decimalToFixed(px.startsWith("-") ? decimal(px.slice(1)) : px, 4, "half-up"),
          amount: decimalToFixed(proceeds, 2, "half-up"),
          fees: decimalToFixed(comm.startsWith("-") ? decimal(comm.slice(1)) : comm, 2, "half-up"),
          currency: txCurrency,
        });
      } else if (section === "cash report" && cashHeaders) {
        const summary = (findCell(cashHeaders, rest, ["currency summary", "field"]) ?? "").toLowerCase();
        if (summary.includes("ending cash")) {
          const totalRaw = findCell(cashHeaders, rest, ["total", "amount"]);
          if (totalRaw && totalRaw.trim()) {
            cash = parseCsvDecimal(totalRaw, rowNum, "Ending Cash");
          }
        }
      } else {
        skippedRows += 1;
      }
    }
    columnMappings = [...mappingMap.values()];
  } else {
    const located = locateHeaderRow(rows);
    if (!located) {
      throw new Error("Could not detect a supported header row (Schwab, IBKR, or standard CSV)");
    }
    format = located.format;
    const headers = rows[located.index]!.map((h) => h.trim());
    columnMappings = collectMappings(headers);
    skippedRows = located.index;

    for (let idx = located.index + 1; idx < rows.length; idx += 1) {
      const row = rows[idx]!;
      const rowNum = idx + 1;
      if (row.every((c) => !c.trim())) {
        skippedRows += 1;
        continue;
      }

      const rawSymbol = findCell(headers, row, ["symbol", "ticker"]) ?? "";
      const symbolLower = rawSymbol.trim().toLowerCase();

      if (isCashRow(symbolLower)) {
        const valRaw = findCell(headers, row, ["market value", "mkt val", "amount", "cash", "price", "value"]);
        if (valRaw && valRaw.trim() && !isNaPlaceholder(valRaw)) {
          cash = decimalAdd(cash, parseCsvDecimal(valRaw, rowNum, "Cash"));
        }
        continue;
      }

      const cashCol = findCell(headers, row, ["cash", "cash balance", "cash_balance"]);
      if (cashCol && cashCol.trim() && !isNaPlaceholder(cashCol)) {
        const parsedCash = parseCsvDecimal(cashCol, rowNum, "cash");
        if (decimalCompare(parsedCash, ZERO) > 0 && decimalCompare(cash, ZERO) === 0) {
          cash = parsedCash;
        }
      }

      if (isSummaryOrBlankSymbol(rawSymbol)) {
        skippedRows += 1;
        continue;
      }

      const currRaw = findCell(headers, row, ["currency", "ccy"]);
      if (currRaw && currRaw.trim()) currency = normalizeCurrency(currRaw);

      const actionCell = findCell(headers, row, ["action", "side", "transaction type"]);
      const isTx = format === "schwab_transactions" || Boolean(actionCell && actionCell.trim());

      if (isTx) {
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const action = sanitizeCsvTextCell(actionCell ?? "", "Action", warnings);
        const date = sanitizeCsvTextCell(
          findCell(headers, row, ["date", "trade date", "settlement date"]) ?? "",
          "Date",
          warnings,
        );
        const qtyRaw = findCell(headers, row, ["quantity", "qty", "shares"]) ?? "0";
        const pxRaw = findCell(headers, row, ["price", "trade price", "unit price"]) ?? "0";
        const feesRaw = findCell(headers, row, ["fees & comm", "fees", "commission"]) ?? "0";
        const amtRaw = findCell(headers, row, ["amount", "net amount", "proceeds"]) ?? "0";

        const qty = qtyRaw.trim() && !isNaPlaceholder(qtyRaw) ? parseCsvDecimal(qtyRaw, rowNum, "Quantity") : ZERO;
        const px = pxRaw.trim() && !isNaPlaceholder(pxRaw) ? parseCsvDecimal(pxRaw, rowNum, "Price") : ZERO;
        const fees = feesRaw.trim() && !isNaPlaceholder(feesRaw) ? parseCsvDecimal(feesRaw, rowNum, "Fees") : ZERO;
        const amt = amtRaw.trim() && !isNaPlaceholder(amtRaw) ? parseCsvDecimal(amtRaw, rowNum, "Amount") : ZERO;

        transactions.push({
          date,
          action,
          symbol,
          quantity: decimal(qty.startsWith("-") ? qty.slice(1) : qty),
          price: decimalToFixed(px.startsWith("-") ? decimal(px.slice(1)) : px, 4, "half-up"),
          amount: decimalToFixed(amt, 2, "half-up"),
          fees: decimalToFixed(fees.startsWith("-") ? decimal(fees.slice(1)) : fees, 2, "half-up"),
          currency,
        });
        continue;
      }

      const symbol = validateCsvSymbol(rawSymbol, rowNum);
      const qtyRaw = findCell(headers, row, ["quantity", "qty", "shares", "position"]) ?? "";
      const qty = parseCsvDecimal(qtyRaw, rowNum, "Quantity");
      if (decimalCompare(qty, ZERO) < 0) {
        throw new Error(`Negative holding quantity is not allowed in row ${rowNum} for ${symbol}`);
      }
      if (decimalCompare(qty, ZERO) === 0) {
        skippedRows += 1;
        continue;
      }

      const priceRaw = findCell(headers, row, ["price", "last", "last price", "markprice", "mark price", "close price", "market price"]);
      const avgCostRaw = findCell(headers, row, ["average_cost", "average cost", "avg_cost", "avg cost", "costbasisprice", "cost basis price", "cost price", "cost/share"]);
      const costBasisRaw = findCell(headers, row, ["cost basis", "cost_basis", "costbasis"]);
      const mktValRaw = findCell(headers, row, ["market value", "market_value", "mkt val", "mkt val (market value)"]);

      let lastPrice = ZERO;
      if (priceRaw && priceRaw.trim() && !isNaPlaceholder(priceRaw)) {
        lastPrice = parseCsvDecimal(priceRaw, rowNum, "Price");
      } else if (mktValRaw && mktValRaw.trim() && !isNaPlaceholder(mktValRaw)) {
        lastPrice = decimalDivide(parseCsvDecimal(mktValRaw, rowNum, "Market Value"), qty, 8, "half-up");
      }

      let avgCost = lastPrice;
      if (avgCostRaw && avgCostRaw.trim() && !isNaPlaceholder(avgCostRaw)) {
        avgCost = parseCsvDecimal(avgCostRaw, rowNum, "Average Cost");
      } else if (costBasisRaw && costBasisRaw.trim() && !isNaPlaceholder(costBasisRaw)) {
        avgCost = decimalDivide(parseCsvDecimal(costBasisRaw, rowNum, "Cost Basis"), qty, 8, "half-up");
      }

      const effectiveLast = decimalCompare(lastPrice, ZERO) > 0 ? lastPrice : avgCost;
      const company = sanitizeCsvTextCell(
        findCell(headers, row, ["description", "company", "name", "security description"]) ?? "",
        "Description",
        warnings,
      );
      accumulateHolding(holdingsMap, symbol, company, qty, avgCost, effectiveLast, currency);
    }
  }

  if (holdingsMap.size === 0 && transactions.length > 0) {
    replayTransactions(transactions, holdingsMap, warnings);
  }

  const holdings = finalizeHoldings(holdingsMap);
  if (holdings.length === 0 && transactions.length === 0 && decimalCompare(cash, ZERO) === 0) {
    throw new Error("No valid holdings, cash balances, or transactions were found in the CSV");
  }

  const sortedTransactions = [...transactions].sort((a, b) =>
    a.date.localeCompare(b.date)
    || a.symbol.localeCompare(b.symbol)
    || a.action.localeCompare(b.action)
    || a.quantity.localeCompare(b.quantity));

  const cashStr = decimalToFixed(cash, 2, "half-up");
  const fingerprint = await computeFingerprint(format, currency, cashStr, holdings, sortedTransactions);
  const alreadyImported = storedFingerprints().includes(fingerprint);
  const labels = FORMAT_LABELS[format];

  const snapshot: ImportedPortfolioSnapshot = {
    id: `csv-${fingerprint.slice(0, 16)}`,
    fingerprint,
    sourceFormat: format,
    sourceLabel: safeLabel,
    importedAtUtc: new Date().toISOString(),
    accountLabel: "Local Portfolio (CSV + Paper)",
    currency,
    cash: cashStr,
    holdings,
    transactions: sortedTransactions,
    warnings: [...warnings],
  };

  return {
    detectedFormat: format,
    formatLabelEn: labels.en,
    formatLabelZh: labels.zh,
    columnMappings,
    rowCount: rows.length,
    skippedRows,
    alreadyImported,
    warnings,
    snapshot,
  };
}

export async function previewBrokerCsv(rawCsv: string, sourceLabel: string): Promise<CsvImportPreview> {
  if (isTauriRuntime()) {
    return invokeCsvPreviewImport(rawCsv, sourceLabel);
  }
  return parseCsvLocally(rawCsv, sourceLabel);
}

export async function commitBrokerCsv(rawCsv: string, sourceLabel: string): Promise<CsvCommitResult> {
  if (isTauriRuntime()) {
    return invokeCsvCommitImport(rawCsv, sourceLabel);
  }

  const preview = await parseCsvLocally(rawCsv, sourceLabel);
  const fingerprints = storedFingerprints();
  if (fingerprints.includes(preview.snapshot.fingerprint)) {
    const existing = readStored<ImportedPortfolioSnapshot | null>(LOCAL_PORTFOLIO_KEY, null);
    return {
      deduplicated: true,
      evidenceSequence: null,
      snapshot: existing ?? preview.snapshot,
    };
  }

  writeStored(LOCAL_PORTFOLIO_KEY, preview.snapshot);
  writeStored(LOCAL_FINGERPRINTS_KEY, [...fingerprints, preview.snapshot.fingerprint]);
  const evidence = await appendEvidence("portfolio_import", {
    mode: "local-csv",
    sourceFormat: preview.snapshot.sourceFormat,
    holdingsCount: String(preview.snapshot.holdings.length),
    transactionsCount: String(preview.snapshot.transactions.length),
    currency: preview.snapshot.currency,
    fingerprintPrefix: preview.snapshot.fingerprint.slice(0, 16),
  });

  return {
    deduplicated: false,
    evidenceSequence: evidence.sequence,
    snapshot: preview.snapshot,
  };
}

export async function loadPersistedLocalPortfolio(): Promise<ImportedPortfolioSnapshot | null> {
  if (isTauriRuntime()) {
    return invokeVaultLoadPortfolio();
  }
  return readStored<ImportedPortfolioSnapshot | null>(LOCAL_PORTFOLIO_KEY, null);
}

export async function clearPersistedLocalPortfolio(): Promise<boolean> {
  const tauriOk = isTauriRuntime() ? await invokeVaultClearPortfolio() : true;
  const localOk = removeStored(LOCAL_PORTFOLIO_KEY) && removeStored(LOCAL_FINGERPRINTS_KEY);
  return tauriOk && localOk;
}
