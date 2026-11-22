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
  type TauriCsvCurrencySubtotal,
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
const LOCAL_PAPER_ORDERS_KEY = "local-csv-paper-orders";

export type CsvFormatCode =
  | "schwab_positions"
  | "schwab_transactions"
  | "ibkr_activity"
  | "ibkr_positions"
  | "fidelity_positions"
  | "vanguard_positions"
  | "futu_positions"
  | "tiger_positions"
  | "generic_csv";

export type ImportedPortfolioHolding = TauriStoredPortfolioHolding;
export type ImportedPortfolioTransaction = TauriStoredPortfolioTransaction;
export type ImportedPortfolioSnapshot = TauriStoredPortfolioSnapshot;
export type CsvCurrencySubtotal = TauriCsvCurrencySubtotal;
export type CsvImportPreview = TauriCsvImportPreview;
export type CsvCommitResult = TauriCsvCommitResult;

const SYMBOL_ALIASES = [
  "symbol",
  "ticker",
  "code",
  "stock code",
  "contract",
  "代码",
  "股票代码",
  "标的",
  "标的代码",
  "合约代码",
] as const;

const COMPANY_ALIASES = [
  "description",
  "company",
  "name",
  "security description",
  "investment name",
  "fund name",
  "security name",
  "stock name",
  "contract name",
  "名称",
  "股票名称",
  "标的名称",
] as const;

const QUANTITY_ALIASES = [
  "quantity",
  "qty",
  "shares",
  "position",
  "holding qty",
  "holdings",
  "持有数量",
  "持仓数量",
  "持仓",
  "数量",
] as const;

const PRICE_ALIASES = [
  "price",
  "last",
  "last price",
  "share price",
  "current price",
  "latest price",
  "markprice",
  "mark price",
  "close price",
  "market price",
  "现价",
  "最新价",
  "市价",
  "收盘价",
] as const;

const AVG_COST_ALIASES = [
  "average_cost",
  "average cost",
  "average cost basis",
  "cost basis per share",
  "avg_cost",
  "avg cost",
  "avg price",
  "costbasisprice",
  "cost basis price",
  "cost price",
  "diluted cost",
  "cost/share",
  "成本价",
  "稀释成本价",
  "平均成本价",
  "平均成本",
  "持仓均价",
  "均价",
] as const;

const COST_BASIS_ALIASES = [
  "cost basis",
  "cost_basis",
  "costbasis",
  "cost basis total",
  "total cost basis",
  "总成本",
  "持仓成本",
] as const;

const MARKET_VALUE_ALIASES = [
  "market value",
  "market_value",
  "mkt val",
  "mkt val (market value)",
  "current value",
  "total value",
  "持仓市值",
  "参考市值",
  "市值",
] as const;

const CURRENCY_ALIASES = ["currency", "ccy", "币种", "货币", "结算币种"] as const;

const CASH_COL_ALIASES = [
  "cash",
  "cash balance",
  "cash_balance",
  "现金",
  "现金余额",
  "可用现金",
  "账户现金",
] as const;

const FORMAT_LABELS: Record<CsvFormatCode, { en: string; zh: string }> = {
  schwab_positions: { en: "Charles Schwab Positions CSV", zh: "嘉信理财持仓 CSV" },
  schwab_transactions: { en: "Charles Schwab Transactions CSV", zh: "嘉信理财交易流水 CSV" },
  ibkr_activity: { en: "IBKR Activity Statement CSV", zh: "盈透证券活动报表 CSV" },
  ibkr_positions: { en: "IBKR Positions CSV", zh: "盈透证券持仓 CSV" },
  fidelity_positions: { en: "Fidelity Positions CSV", zh: "富达 (Fidelity) 持仓 CSV" },
  vanguard_positions: { en: "Vanguard Positions CSV", zh: "先锋领航 (Vanguard) 持仓 CSV" },
  futu_positions: { en: "Futu / Moomoo Positions CSV", zh: "富途 (Futu) 持仓 CSV" },
  tiger_positions: { en: "Tiger Brokers Positions CSV", zh: "老虎证券 (Tiger) 持仓 CSV" },
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

function isCashRow(symbolLower: string, companyRaw: string): boolean {
  const clean = symbolLower.replace(/\*+$/, "");
  if ([
    "cash",
    "cash & cash investments",
    "cash & money market",
    "usd",
    "hkd",
    "cny",
    "eur",
    "gbp",
    "sgd",
    "cash balance",
    "spaxx",
    "fdrxx",
    "fcash",
    "vmfxx",
    "settlement fund",
    "pending activity",
    "现金",
    "美元现金",
    "港元现金",
    "港币现金",
    "人民币现金",
    "现金余额",
  ].includes(clean)) {
    return true;
  }
  const companyLower = companyRaw.trim().toLowerCase();
  return companyLower.includes("settlement fund")
    || companyLower.includes("cash & money market")
    || companyLower === "cash";
}

function inferCurrencyFromCashSymbol(symbolLower: string): string | undefined {
  const clean = symbolLower.replace(/\*+$/, "");
  switch (clean) {
    case "usd":
    case "美元现金":
    case "spaxx":
    case "fdrxx":
    case "fcash":
    case "vmfxx":
      return "USD";
    case "hkd":
    case "港元现金":
    case "港币现金":
      return "HKD";
    case "cny":
    case "人民币现金":
      return "CNY";
    case "eur":
      return "EUR";
    case "gbp":
      return "GBP";
    case "sgd":
      return "SGD";
    default:
      return undefined;
  }
}

function inferCurrencyFromSymbol(symbol: string): string | undefined {
  if (symbol.endsWith(".HK")) return "HKD";
  if (symbol.endsWith(".SS") || symbol.endsWith(".SZ")) return "CNY";
  if (symbol.endsWith(".SI")) return "SGD";
  return undefined;
}

function inferCurrencyFromAmount(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^[(\-+\s]+/, "");
  const upper = trimmed.toUpperCase();
  if (upper.startsWith("HK$") || upper.startsWith("HKD")) return "HKD";
  if (upper.startsWith("US$") || upper.startsWith("USD")) return "USD";
  if (upper.startsWith("S$") || upper.startsWith("SGD")) return "SGD";
  if (upper.startsWith("C$") || upper.startsWith("CAD")) return "CAD";
  if (upper.startsWith("A$") || upper.startsWith("AUD")) return "AUD";
  if (upper.startsWith("CN¥") || upper.startsWith("CN￥") || upper.startsWith("RMB") || trimmed.startsWith("¥") || trimmed.startsWith("￥")) return "CNY";
  if (trimmed.startsWith("€")) return "EUR";
  if (trimmed.startsWith("£")) return "GBP";
  return undefined;
}

function isSummaryOrBlankSymbol(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return lower.includes("total")
    || lower.startsWith("positions for")
    || lower.startsWith("account ")
    || lower === "--"
    || lower === "n/a"
    || lower === "合计"
    || lower === "总计"
    || lower === "小计"
    || lower.startsWith("the data and information");
}

function isNaPlaceholder(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower === "--" || lower === "n/a" || lower === "na" || lower === "-";
}

function normalizeCurrency(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  switch (trimmed) {
    case "美元":
    case "美金":
      return "USD";
    case "港元":
    case "港币":
      return "HKD";
    case "人民币":
    case "离岸人民币":
      return "CNY";
    case "新元":
    case "新加坡元":
      return "SGD";
    case "欧元":
      return "EUR";
    case "英镑":
      return "GBP";
    case "日元":
      return "JPY";
    case "加元":
      return "CAD";
    case "澳元":
      return "AUD";
    default:
      break;
  }
  const clean = trimmed.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 3);
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
  let cleaned = raw.trim().replace(/^\$/, "").replace(/\*+$/, "").toUpperCase();
  if (cleaned.startsWith("US.") && cleaned.length > 3) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith("HK.") && cleaned.length > 3 && cleaned.length <= 10) {
    cleaned = `${cleaned.slice(3)}.HK`;
  }
  if (!SYMBOL_RE.test(cleaned)) {
    throw new Error(`Invalid symbol in row ${rowNum}: ${raw.trim().slice(0, 24)}`);
  }
  return cleaned;
}

function stripCurrencyPrefix(text: string): string {
  const prefixes = [
    "HK$",
    "US$",
    "S$",
    "C$",
    "A$",
    "CN¥",
    "CN￥",
    "RMB",
    "USD",
    "HKD",
    "CNY",
    "EUR",
    "GBP",
    "SGD",
    "$",
    "¥",
    "￥",
    "€",
    "£",
  ];
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length).trim();
    }
  }
  return text;
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
  text = stripCurrencyPrefix(text);
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }
  text = stripCurrencyPrefix(text);
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
    ["symbol", SYMBOL_ALIASES],
    ["company", COMPANY_ALIASES],
    ["quantity", QUANTITY_ALIASES],
    ["averageCost", AVG_COST_ALIASES],
    ["costBasis", COST_BASIS_ALIASES],
    ["price", PRICE_ALIASES],
    ["marketValue", MARKET_VALUE_ALIASES],
    ["cash", CASH_COL_ALIASES],
    ["currency", CURRENCY_ALIASES],
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
  const key = `${symbol}|${currency}`;
  const existing = map.get(key);
  if (existing) {
    existing.quantity = decimalAdd(existing.quantity, qty);
    existing.totalCost = decimalAdd(existing.totalCost, addedCost);
    if (decimalCompare(lastPrice, ZERO) > 0) existing.lastPrice = lastPrice;
    if (!existing.company && company) existing.company = company;
  } else {
    map.set(key, {
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
      const key = `${tx.symbol}|${tx.currency}`;
      const existing = map.get(key);
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
  for (const [key, entry] of map) {
    if (decimalCompare(entry.quantity, ZERO) <= 0) map.delete(key);
  }
}

function finalizeHoldings(map: Map<string, HoldingAccumulator>): ImportedPortfolioHolding[] {
  return [...map.values()]
    .filter((entry) => decimalCompare(entry.quantity, ZERO) > 0)
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.currency.localeCompare(b.currency))
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

function computeCurrencySubtotals(
  currencies: readonly string[],
  holdings: readonly ImportedPortfolioHolding[],
  cashByCurrency: ReadonlyMap<string, DecimalString>,
): CsvCurrencySubtotal[] {
  return currencies.map((curr) => {
    let mvSum = ZERO;
    let count = 0;
    for (const h of holdings) {
      if (h.currency !== curr) continue;
      const mv = decimalRound(decimalMultiply(decimal(h.quantity), decimal(h.lastPrice)), 8, "half-up");
      mvSum = decimalAdd(mvSum, mv);
      count += 1;
    }
    const cash = cashByCurrency.get(curr) ?? ZERO;
    const total = decimalAdd(mvSum, cash);
    return {
      currency: curr,
      holdingsValue: decimalToFixed(mvSum, 2, "half-up"),
      cash: decimalToFixed(cash, 2, "half-up"),
      totalValue: decimalToFixed(total, 2, "half-up"),
      holdingsCount: count,
    };
  });
}

async function computeFingerprint(
  sourceFormat: string,
  currency: string,
  cash: string,
  cashByCurrency: Record<string, string>,
  holdings: readonly ImportedPortfolioHolding[],
  transactions: readonly ImportedPortfolioTransaction[],
): Promise<string> {
  const cashLines = Object.entries(cashByCurrency)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([curr, amt]) => `C|${curr}|${amt}`);
  const lines = [
    "foliohelm/csv-portfolio-fingerprint/v1",
    sourceFormat,
    currency,
    cash,
    ...cashLines,
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
    const hasSymbol = normalized.some((h) => (SYMBOL_ALIASES as readonly string[]).includes(h));
    if (!hasSymbol) continue;

    const hasAction = normalized.some((h) => h === "action" || h === "side" || h === "transaction type");
    const hasFeesComm = normalized.includes("fees & comm");
    const hasSchwabPos = normalized.some((h) =>
      h === "price change $" || h === "mkt val (market value)" || h === "reinvest?" || h === "security type");
    const hasIbkrFlat = normalized.some((h) =>
      h === "costbasisprice" || h === "markprice" || h === "fifopnlunrealized");
    const hasFidelity = normalized.some((h) =>
      h === "cost basis total"
      || h === "average cost basis"
      || h === "percent of account"
      || h === "today's gain/loss dollar")
      || (normalized.includes("current value") && normalized.includes("last price"));
    const hasVanguard = normalized.includes("investment name")
      || (normalized.includes("share price") && normalized.includes("total value"));
    const hasFutu = normalized.some((h) =>
      h === "持有数量" || h === "稀释成本价" || h === "平均成本价" || h === "holding qty" || h === "diluted cost" || h === "股票代码");
    const hasTiger = normalized.some((h) =>
      h === "标的" || h === "标的代码" || h === "合约代码" || h === "持仓均价" || h === "持仓市值" || h === "账户现金" || h === "contract");
    const hasQty = normalized.some((h) => (QUANTITY_ALIASES as readonly string[]).includes(h));

    if (hasAction && (hasFeesComm || normalized.includes("date"))) {
      return { index: i, format: "schwab_transactions" };
    }
    if (hasSchwabPos && hasQty) return { index: i, format: "schwab_positions" };
    if (hasIbkrFlat && hasQty) return { index: i, format: "ibkr_positions" };
    if (hasFidelity && hasQty) return { index: i, format: "fidelity_positions" };
    if (hasVanguard && hasQty) return { index: i, format: "vanguard_positions" };
    if (hasFutu && hasQty) return { index: i, format: "futu_positions" };
    if (hasTiger && hasQty) return { index: i, format: "tiger_positions" };
    if (hasQty) return { index: i, format: "generic_csv" };
  }
  return null;
}

function storedFingerprints(): string[] {
  const saved = readStored<unknown>(LOCAL_FINGERPRINTS_KEY, []);
  return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
}

function addCashByCurrency(map: Map<string, DecimalString>, currency: string, amount: DecimalString): void {
  const existing = map.get(currency) ?? ZERO;
  map.set(currency, decimalAdd(existing, amount));
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
  const cashByCurrencyMap = new Map<string, DecimalString>();
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
        const rawSymbol = findCell(posHeaders, rest, SYMBOL_ALIASES) ?? "";
        if (isSummaryOrBlankSymbol(rawSymbol)) {
          skippedRows += 1;
          continue;
        }
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const qtyRaw = findCell(posHeaders, rest, QUANTITY_ALIASES) ?? "";
        const qty = parseCsvDecimal(qtyRaw, rowNum, "Quantity");
        if (decimalCompare(qty, ZERO) < 0) {
          throw new Error(`Negative holding quantity is not allowed in row ${rowNum} for ${symbol}`);
        }
        if (decimalCompare(qty, ZERO) === 0) {
          skippedRows += 1;
          continue;
        }
        const markRaw = findCell(posHeaders, rest, PRICE_ALIASES);
        const costPriceRaw = findCell(posHeaders, rest, AVG_COST_ALIASES);
        const costBasisRaw = findCell(posHeaders, rest, COST_BASIS_ALIASES);

        const lastPrice = markRaw && markRaw.trim() ? parseCsvDecimal(markRaw, rowNum, "Close Price") : ZERO;
        let avgCost = lastPrice;
        if (costPriceRaw && costPriceRaw.trim()) {
          avgCost = parseCsvDecimal(costPriceRaw, rowNum, "Cost Price");
        } else if (costBasisRaw && costBasisRaw.trim()) {
          avgCost = decimalDivide(parseCsvDecimal(costBasisRaw, rowNum, "Cost Basis"), qty, 8, "half-up");
        }
        const effectiveLast = decimalCompare(lastPrice, ZERO) > 0 ? lastPrice : avgCost;
        const company = sanitizeCsvTextCell(
          findCell(posHeaders, rest, COMPANY_ALIASES) ?? "",
          "Description",
          warnings,
        );
        const rowCurrency = normalizeCurrency(findCell(posHeaders, rest, CURRENCY_ALIASES));
        accumulateHolding(holdingsMap, symbol, company, qty, avgCost, effectiveLast, rowCurrency);
      } else if (section === "trades" && tradeHeaders) {
        const rawSymbol = findCell(tradeHeaders, rest, SYMBOL_ALIASES) ?? "";
        if (isSummaryOrBlankSymbol(rawSymbol)) {
          skippedRows += 1;
          continue;
        }
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const qty = parseCsvDecimal(findCell(tradeHeaders, rest, QUANTITY_ALIASES) ?? "0", rowNum, "Quantity");
        const px = parseCsvDecimal(findCell(tradeHeaders, rest, ["t. price", "trade price", "price"]) ?? "0", rowNum, "Price");
        const proceedsRaw = findCell(tradeHeaders, rest, ["proceeds", "amount"]) ?? "0";
        const commRaw = findCell(tradeHeaders, rest, ["comm/fee", "commission", "fees"]) ?? "0";
        const proceeds = proceedsRaw.trim() ? parseCsvDecimal(proceedsRaw, rowNum, "Proceeds") : ZERO;
        const comm = commRaw.trim() ? parseCsvDecimal(commRaw, rowNum, "Comm/Fee") : ZERO;
        const date = sanitizeCsvTextCell(findCell(tradeHeaders, rest, ["date/time", "date", "trade date"]) ?? "", "Date/Time", warnings);
        const txCurrency = normalizeCurrency(findCell(tradeHeaders, rest, CURRENCY_ALIASES));
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
          const rawCurr = findCell(cashHeaders, rest, CURRENCY_ALIASES) ?? "USD";
          if (rawCurr.trim().toLowerCase().includes("base currency")) {
            skippedRows += 1;
            continue;
          }
          const rowCurrency = normalizeCurrency(rawCurr);
          const totalRaw = findCell(cashHeaders, rest, ["total", "amount"]);
          if (totalRaw && totalRaw.trim()) {
            cashByCurrencyMap.set(rowCurrency, parseCsvDecimal(totalRaw, rowNum, "Ending Cash"));
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
      throw new Error("Could not detect a supported header row (Schwab, IBKR, Fidelity, Vanguard, Futu, Tiger, or standard CSV)");
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

      const rawSymbol = findCell(headers, row, SYMBOL_ALIASES) ?? "";
      const symbolLower = rawSymbol.trim().toLowerCase();
      const companyRaw = findCell(headers, row, COMPANY_ALIASES) ?? "";
      const rawCurrCell = findCell(headers, row, CURRENCY_ALIASES);
      const explicitCurrency = rawCurrCell && rawCurrCell.trim() ? normalizeCurrency(rawCurrCell) : undefined;

      if (isCashRow(symbolLower, companyRaw)) {
        const valRaw = findCell(headers, row, [
          "market value",
          "market_value",
          "mkt val",
          "current value",
          "total value",
          "amount",
          "cash",
          "price",
          "value",
          "市值",
          "持仓市值",
          "现金",
        ]);
        if (valRaw && valRaw.trim() && !isNaPlaceholder(valRaw)) {
          const parsedCash = parseCsvDecimal(valRaw, rowNum, "Cash");
          const cashCurr = explicitCurrency
            ?? inferCurrencyFromCashSymbol(symbolLower)
            ?? inferCurrencyFromAmount(valRaw)
            ?? "USD";
          addCashByCurrency(cashByCurrencyMap, cashCurr, parsedCash);
        }
        continue;
      }

      const cashCol = findCell(headers, row, CASH_COL_ALIASES);
      if (cashCol && cashCol.trim() && !isNaPlaceholder(cashCol)) {
        const parsedCash = parseCsvDecimal(cashCol, rowNum, "cash");
        const cashCurr = explicitCurrency ?? inferCurrencyFromAmount(cashCol) ?? "USD";
        const existingCash = cashByCurrencyMap.get(cashCurr) ?? ZERO;
        if (decimalCompare(parsedCash, ZERO) > 0 && decimalCompare(existingCash, ZERO) === 0) {
          cashByCurrencyMap.set(cashCurr, parsedCash);
        }
      }

      if (isSummaryOrBlankSymbol(rawSymbol)) {
        skippedRows += 1;
        continue;
      }

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
        const qtyRaw = findCell(headers, row, QUANTITY_ALIASES) ?? "0";
        const pxRaw = findCell(headers, row, ["price", "trade price", "unit price"]) ?? "0";
        const feesRaw = findCell(headers, row, ["fees & comm", "fees", "commission"]) ?? "0";
        const amtRaw = findCell(headers, row, ["amount", "net amount", "proceeds"]) ?? "0";

        const qty = qtyRaw.trim() && !isNaPlaceholder(qtyRaw) ? parseCsvDecimal(qtyRaw, rowNum, "Quantity") : ZERO;
        const px = pxRaw.trim() && !isNaPlaceholder(pxRaw) ? parseCsvDecimal(pxRaw, rowNum, "Price") : ZERO;
        const fees = feesRaw.trim() && !isNaPlaceholder(feesRaw) ? parseCsvDecimal(feesRaw, rowNum, "Fees") : ZERO;
        const amt = amtRaw.trim() && !isNaPlaceholder(amtRaw) ? parseCsvDecimal(amtRaw, rowNum, "Amount") : ZERO;

        const txCurr = explicitCurrency ?? inferCurrencyFromAmount(pxRaw) ?? inferCurrencyFromAmount(amtRaw) ?? "USD";
        transactions.push({
          date,
          action,
          symbol,
          quantity: decimal(qty.startsWith("-") ? qty.slice(1) : qty),
          price: decimalToFixed(px.startsWith("-") ? decimal(px.slice(1)) : px, 4, "half-up"),
          amount: decimalToFixed(amt, 2, "half-up"),
          fees: decimalToFixed(fees.startsWith("-") ? decimal(fees.slice(1)) : fees, 2, "half-up"),
          currency: txCurr,
        });
        continue;
      }

      const symbol = validateCsvSymbol(rawSymbol, rowNum);
      const qtyRaw = findCell(headers, row, QUANTITY_ALIASES) ?? "";
      const qty = parseCsvDecimal(qtyRaw, rowNum, "Quantity");
      if (decimalCompare(qty, ZERO) < 0) {
        throw new Error(`Negative holding quantity is not allowed in row ${rowNum} for ${symbol}`);
      }
      if (decimalCompare(qty, ZERO) === 0) {
        skippedRows += 1;
        continue;
      }

      const priceRaw = findCell(headers, row, PRICE_ALIASES);
      const avgCostRaw = findCell(headers, row, AVG_COST_ALIASES);
      const costBasisRaw = findCell(headers, row, COST_BASIS_ALIASES);
      const mktValRaw = findCell(headers, row, MARKET_VALUE_ALIASES);

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
      const rowCurrency = explicitCurrency
        ?? inferCurrencyFromAmount(priceRaw)
        ?? inferCurrencyFromAmount(mktValRaw)
        ?? inferCurrencyFromAmount(avgCostRaw)
        ?? inferCurrencyFromSymbol(symbol)
        ?? "USD";
      const company = sanitizeCsvTextCell(companyRaw, "Description", warnings);
      accumulateHolding(holdingsMap, symbol, company, qty, avgCost, effectiveLast, rowCurrency);
    }
  }

  if (holdingsMap.size === 0 && transactions.length > 0) {
    replayTransactions(transactions, holdingsMap, warnings);
  }

  const holdings = finalizeHoldings(holdingsMap);
  const hasAnyCash = [...cashByCurrencyMap.values()].some((v) => decimalCompare(v, ZERO) !== 0);
  if (holdings.length === 0 && transactions.length === 0 && !hasAnyCash) {
    throw new Error("No valid holdings, cash balances, or transactions were found in the CSV");
  }

  const sortedTransactions = [...transactions].sort((a, b) =>
    a.date.localeCompare(b.date)
    || a.symbol.localeCompare(b.symbol)
    || a.action.localeCompare(b.action)
    || a.quantity.localeCompare(b.quantity));

  const currencySet = new Set<string>();
  for (const h of holdings) currencySet.add(h.currency);
  for (const [curr, amt] of cashByCurrencyMap) {
    if (decimalCompare(amt, ZERO) !== 0) currencySet.add(curr);
  }
  if (currencySet.size === 0) {
    for (const t of sortedTransactions) currencySet.add(t.currency);
  }
  if (currencySet.size === 0) currencySet.add("USD");

  const currencies = [...currencySet].sort();
  const isMultiCurrency = currencies.length > 1;
  const primaryCurrency = isMultiCurrency ? "MULTI" : currencies[0]!;

  const cashByCurrency: Record<string, string> = {};
  for (const curr of currencies) {
    cashByCurrency[curr] = decimalToFixed(cashByCurrencyMap.get(curr) ?? ZERO, 2, "half-up");
  }

  const cashStr = isMultiCurrency
    ? (() => {
        warnings.push(
          `Multi-currency CSV detected (${currencies.join(", ")}): balances and valuations are isolated by currency with no FX conversion`,
        );
        return "0.00";
      })()
    : (cashByCurrency[primaryCurrency] ?? "0.00");

  const currencySubtotals = computeCurrencySubtotals(currencies, holdings, cashByCurrencyMap);
  const fingerprint = await computeFingerprint(
    format,
    primaryCurrency,
    cashStr,
    cashByCurrency,
    holdings,
    sortedTransactions,
  );
  const alreadyImported = storedFingerprints().includes(fingerprint);
  const labels = FORMAT_LABELS[format];

  const snapshot: ImportedPortfolioSnapshot = {
    id: `csv-${fingerprint.slice(0, 16)}`,
    fingerprint,
    sourceFormat: format,
    sourceLabel: safeLabel,
    importedAtUtc: new Date().toISOString(),
    accountLabel: "Local Portfolio (CSV + Paper)",
    currency: primaryCurrency,
    cash: cashStr,
    cashByCurrency,
    currencies,
    isMultiCurrency,
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
    currencySubtotals,
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
  const localOk = removeStored(LOCAL_PORTFOLIO_KEY)
    && removeStored(LOCAL_FINGERPRINTS_KEY)
    && removeStored(LOCAL_PAPER_ORDERS_KEY);
  return tauriOk && localOk;
}
