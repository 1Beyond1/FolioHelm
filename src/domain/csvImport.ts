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
import { ACCOUNT_STORE, DEFAULT_ACCOUNT_ID } from "./accounts";
import { appendEvidence } from "./evidenceJournal";
import {
  decimalToMicros,
  MICROS_PER_UNIT,
  mulDivRoundBigInt,
  NAV_STORE,
  todayUtcIsoDate,
  type NavSnapshotRecord,
} from "./nav";
import { readStored, removeStored, writeStored } from "../platform/storage";
import {
  invokeCsvCommitImport,
  invokeCsvPreviewImport,
  invokeVaultClearPortfolio,
  invokeVaultLoadAccountPortfolios,
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

const CASH_ROW_VALUE_ALIASES = [
  "market value",
  "market_value",
  "mkt val",
  "mkt val (market value)",
  "current value",
  "total value",
  "amount",
  "cash",
  "price",
  "value",
  "市值",
  "持仓市值",
  "参考市值",
  "现金",
  "可用现金",
  "账户现金",
] as const;

const SECURITY_TYPE_ALIASES = [
  "asset category",
  "security type",
  "asset class",
  "type",
  "资产类别",
  "证券类型",
  "品种",
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

function normalizeNumericUnicode(raw: string): string {
  return raw
    .replace(/[\u00A0\u202F\u2007\u3000]/g, " ")
    .replace(/[\u2212\u2013\u2014\uFF0D]/g, "-");
}

function inferCurrencyFromAmount(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = normalizeNumericUnicode(raw).trim().replace(/^[()\-+\s]+|[()\-+\s]+$/g, "");
  const upper = trimmed.toUpperCase();
  if (upper.startsWith("HK$") || upper.startsWith("HKD") || upper.endsWith("HK$") || upper.endsWith("HKD") || trimmed.endsWith("港元") || trimmed.endsWith("港币")) return "HKD";
  if (upper.startsWith("US$") || upper.startsWith("USD") || upper.endsWith("US$") || upper.endsWith("USD") || trimmed.endsWith("美元")) return "USD";
  if (upper.startsWith("S$") || upper.startsWith("SGD") || upper.endsWith("S$") || upper.endsWith("SGD")) return "SGD";
  if (upper.startsWith("C$") || upper.startsWith("CAD") || upper.endsWith("C$") || upper.endsWith("CAD")) return "CAD";
  if (upper.startsWith("A$") || upper.startsWith("AUD") || upper.endsWith("A$") || upper.endsWith("AUD")) return "AUD";
  if (
    upper.startsWith("CN¥") || upper.startsWith("CN￥") || upper.startsWith("CNY") || upper.startsWith("RMB")
    || upper.endsWith("CNY") || upper.endsWith("RMB")
    || trimmed.startsWith("¥") || trimmed.startsWith("￥")
    || trimmed.endsWith("¥") || trimmed.endsWith("￥") || trimmed.endsWith("人民币")
  ) return "CNY";
  if (trimmed.startsWith("€") || trimmed.endsWith("€") || upper.startsWith("EUR") || upper.endsWith("EUR")) return "EUR";
  if (trimmed.startsWith("£") || trimmed.endsWith("£") || upper.startsWith("GBP") || upper.endsWith("GBP")) return "GBP";
  if (upper.startsWith("JPY") || upper.endsWith("JPY")) return "JPY";
  if (upper.startsWith("CHF") || upper.endsWith("CHF")) return "CHF";
  return undefined;
}

function isSecondaryTransactionHeader(normalized: readonly string[]): boolean {
  const hasSymbol = normalized.some((h) => (SYMBOL_ALIASES as readonly string[]).includes(h));
  const hasAction = normalized.some((h) => h === "action" || h === "side" || h === "transaction type");
  const hasDate = normalized.some((h) => h === "date" || h === "trade date" || h === "settlement date" || h === "date/time");
  return hasSymbol && hasAction && hasDate;
}

function isDisclaimerOrFooterRow(row: readonly string[]): boolean {
  const nonEmpty = row.map((c) => c.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return true;
  const first = nonEmpty[0]!;
  const firstLower = first.toLowerCase();
  const prefixes = [
    "the data and information",
    "brokerage services",
    "date downloaded",
    "disclaimer",
    "important information",
    "important notice",
    "note:",
    "notes:",
    "footnotes",
    "fidelity brokerage",
    "charles schwab",
    "vanguard brokerage",
    "for informational purposes",
    "past performance",
    "all rights reserved",
    "copyright",
    "免责声明",
    "注：",
    "备注：",
  ];
  if (prefixes.some((p) => firstLower.startsWith(p))) return true;
  if ((first.startsWith("*") || first.startsWith("†")) && nonEmpty.length <= 2) return true;
  if (nonEmpty.length === 1 && first.length > 40 && first.includes(" ")) return true;
  return false;
}

function looksLikeOptionSymbol(raw: string): boolean {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return false;
  const stripped = trimmed.replace(/^-/, "").replace(/^(?:US|HK|SG)\./, "");
  if (!stripped.includes(" ") && stripped.length >= 11) {
    if (/^[A-Z0-9]{1,6}\d{6}[CP]\d{1,10}(?:\.\d+)?$/.test(stripped)) {
      return true;
    }
  }
  if (stripped.includes(" ")) {
    const tokens = stripped.split(/\s+/);
    if (tokens.length >= 3) {
      const last = tokens[tokens.length - 1] ?? "";
      const endsWithCp = last === "C" || last === "P" || last === "CALL" || last === "PUT";
      const hasDate = tokens.some((t) =>
        (t.includes("/") && t.length >= 8)
        || /^\d{2}[A-Z]{3}\d{2}$/.test(t)
        || /^\d{6}$/.test(t)
        || /^\d{8}$/.test(t));
      if (endsWithCp && hasDate) return true;
    }
  }
  return false;
}

function isOptionRow(headers: readonly string[], row: readonly string[], rawSymbol: string): boolean {
  const secType = findCell(headers, row, SECURITY_TYPE_ALIASES)?.trim().toLowerCase() ?? "";
  if (
    secType.includes("option")
    || secType.includes("warrant")
    || secType.includes("future")
    || secType.includes("期权")
    || secType.includes("窝轮")
    || secType.includes("牛熊证")
    || secType.includes("期货")
  ) {
    return true;
  }
  return looksLikeOptionSymbol(rawSymbol);
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
  } else if (cleaned.startsWith("SH.") && cleaned.length > 3 && cleaned.length <= 10) {
    cleaned = `${cleaned.slice(3)}.SS`;
  } else if (cleaned.startsWith("SZ.") && cleaned.length > 3 && cleaned.length <= 10) {
    cleaned = `${cleaned.slice(3)}.SZ`;
  } else if (cleaned.startsWith("SG.") && cleaned.length > 3 && cleaned.length <= 10) {
    cleaned = `${cleaned.slice(3)}.SI`;
  }
  if (!SYMBOL_RE.test(cleaned)) {
    throw new Error(`Invalid symbol in row ${rowNum}: ${raw.trim().slice(0, 24)}`);
  }
  return cleaned;
}

const CURRENCY_TOKENS = [
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
  "JPY",
  "CAD",
  "AUD",
  "CHF",
  "港元",
  "港币",
  "美元",
  "人民币",
  "新元",
  "欧元",
  "英镑",
  "日元",
  "元",
  "$",
  "¥",
  "￥",
  "€",
  "£",
] as const;

function stripCurrencyPrefix(text: string): string {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  for (const token of CURRENCY_TOKENS) {
    if (upper.startsWith(token.toUpperCase())) {
      return trimmed.slice(token.length).trim();
    }
  }
  return trimmed;
}

function stripCurrencySuffix(text: string): string {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  for (const token of CURRENCY_TOKENS) {
    if (upper.endsWith(token.toUpperCase())) {
      return trimmed.slice(0, trimmed.length - token.length).trim();
    }
  }
  return trimmed;
}

export function parseCsvDecimal(raw: string, rowNum: number, column: string): DecimalString {
  let text = normalizeNumericUnicode(raw).trim();
  if (!text) throw new Error(`Invalid decimal value in row ${rowNum}, column '${column}': ${raw}`);
  let negative = false;
  let hasParens = false;
  let hasExplicitSign = false;

  if (text.startsWith("(") && text.endsWith(")") && text.length > 2) {
    hasParens = true;
    negative = true;
    text = text.slice(1, -1).trim();
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const before = text;
    text = stripCurrencyPrefix(text);
    text = stripCurrencySuffix(text);
    if (text.startsWith("-")) {
      if (hasExplicitSign) {
        throw new Error(`Invalid decimal value in row ${rowNum}, column '${column}': ${raw}`);
      }
      hasExplicitSign = true;
      negative = true;
      text = text.slice(1).trim();
    } else if (text.startsWith("+")) {
      if (hasExplicitSign || hasParens) {
        throw new Error(`Invalid decimal value in row ${rowNum}, column '${column}': ${raw}`);
      }
      hasExplicitSign = true;
      text = text.slice(1).trim();
    }
    text = stripCurrencyPrefix(text);
    text = stripCurrencySuffix(text);
    if (text === before) break;
  }

  if (text.startsWith("-") || text.startsWith("+")) {
    throw new Error(`Invalid decimal value in row ${rowNum}, column '${column}': ${raw}`);
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

function txActionReplayRank(action: string): number {
  const lower = action.toLowerCase();
  if (lower.includes("split") || lower.includes("拆股") || lower.includes("合股")) return 0;
  if (lower.includes("reinvest") || lower.includes("buy") || lower.includes("purchase") || lower.includes("买入")) return 1;
  if (lower.includes("sell") || lower.includes("sale") || lower.includes("redemption") || lower.includes("卖出")) return 2;
  if (lower.includes("dividend") || lower.includes("div") || lower.includes("interest") || lower.includes("股息") || lower.includes("分红")) return 3;
  if (lower.includes("fee") || lower.includes("comm") || lower.includes("tax") || lower.includes("withholding") || lower.includes("费用") || lower.includes("佣金")) return 4;
  return 5;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 ? (isLeap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= maxDay;
}

function parseSingleDateToken(token: string): string | null {
  const trimmed = token.trim().replace(/^"+|"+$/g, "");
  if (!trimmed) return null;
  const datePart = (trimmed.split(/[ ,T]/)[0] ?? "").trim();
  if (!datePart) return null;

  if (/^\d{8}$/.test(datePart)) {
    const y = Number(datePart.slice(0, 4));
    const m = Number(datePart.slice(4, 6));
    const d = Number(datePart.slice(6, 8));
    if (isValidCalendarDate(y, m, d)) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }

  const sep = datePart.includes("/") ? "/" : datePart.includes("-") ? "-" : null;
  if (!sep) return null;
  const parts = datePart.split(sep);
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null;

  let y: number;
  let m: number;
  let d: number;
  if (parts[0]!.length === 4) {
    y = Number(parts[0]);
    m = Number(parts[1]);
    d = Number(parts[2]);
  } else if (parts[2]!.length === 4) {
    y = Number(parts[2]);
    m = Number(parts[0]);
    d = Number(parts[1]);
  } else {
    return null;
  }

  if (!isValidCalendarDate(y, m, d)) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function normalizeTransactionDate(raw: string, rowNum: number, warnings: string[]): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();
  const asOfIdx = lower.indexOf(" as of ");
  if (asOfIdx !== -1) {
    const effective = trimmed.slice(asOfIdx + 7).trim();
    const posted = trimmed.slice(0, asOfIdx).trim();
    const norm = parseSingleDateToken(effective) ?? parseSingleDateToken(posted);
    if (norm) return norm;
  }

  const norm = parseSingleDateToken(trimmed);
  if (norm) return norm;

  warnings.push(`Could not normalize transaction date in row ${rowNum}: '${trimmed.slice(0, 24)}'`);
  return trimmed;
}

function replayTransactions(
  transactions: readonly ImportedPortfolioTransaction[],
  map: Map<string, HoldingAccumulator>,
  warnings: string[],
): void {
  const indexed = transactions.map((tx, idx) => ({ tx, idx }));
  indexed.sort((a, b) =>
    a.tx.date.localeCompare(b.tx.date)
    || txActionReplayRank(a.tx.action) - txActionReplayRank(b.tx.action)
    || a.idx - b.idx);

  for (const { tx } of indexed) {
    const rank = txActionReplayRank(tx.action);
    const qty = decimal(tx.quantity);
    const price = decimal(tx.price);
    if (decimalCompare(qty, ZERO) <= 0) continue;

    if (rank === 0) {
      // SPLIT: add split shares while keeping total cost basis constant.
      const key = `${tx.symbol}|${tx.currency}`;
      const existing = map.get(key);
      if (existing) {
        const oldQty = existing.quantity;
        const newQty = decimalAdd(oldQty, qty);
        existing.quantity = newQty;
        if (decimalCompare(price, ZERO) > 0) {
          existing.lastPrice = price;
        } else if (decimalCompare(existing.lastPrice, ZERO) > 0 && decimalCompare(newQty, ZERO) > 0) {
          const oldVal = decimalRound(decimalMultiply(existing.lastPrice, oldQty), 8, "half-up");
          existing.lastPrice = decimalDivide(oldVal, newQty, 8, "half-up");
        }
      } else {
        warnings.push(`Split transaction for ${tx.symbol} had no prior holding lot in CSV; skipped in holding replay`);
      }
    } else if (rank === 1) {
      accumulateHolding(map, tx.symbol, tx.symbol, qty, price, price, tx.currency);
    } else if (rank === 2) {
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
  accountId?: string,
  accountLabel?: string,
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
        if (isOptionRow(posHeaders, rest, rawSymbol)) {
          warnings.push(`Skipped unsupported option/derivative row ${rowNum} (${rawSymbol.trim().slice(0, 32)})`);
          skippedRows += 1;
          continue;
        }
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const qtyRaw = findCell(posHeaders, rest, QUANTITY_ALIASES) ?? "";
        if (isNaPlaceholder(qtyRaw)) {
          skippedRows += 1;
          continue;
        }
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

        const lastPrice = markRaw && markRaw.trim() && !isNaPlaceholder(markRaw)
          ? parseCsvDecimal(markRaw, rowNum, "Close Price")
          : ZERO;
        if (decimalCompare(lastPrice, ZERO) < 0) {
          throw new Error(`Negative last_price is not allowed in row ${rowNum} for ${symbol}`);
        }
        let avgCost = lastPrice;
        if (costPriceRaw && costPriceRaw.trim() && !isNaPlaceholder(costPriceRaw)) {
          avgCost = parseCsvDecimal(costPriceRaw, rowNum, "Cost Price");
          if (decimalCompare(avgCost, ZERO) < 0) {
            throw new Error(`Negative average_cost is not allowed in row ${rowNum} for ${symbol}`);
          }
        } else if (costBasisRaw && costBasisRaw.trim() && !isNaPlaceholder(costBasisRaw)) {
          const basis = parseCsvDecimal(costBasisRaw, rowNum, "Cost Basis");
          if (decimalCompare(basis, ZERO) < 0) {
            throw new Error(`Negative average_cost is not allowed in row ${rowNum} for ${symbol}`);
          }
          avgCost = decimalDivide(basis, qty, 8, "half-up");
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
        if (isOptionRow(tradeHeaders, rest, rawSymbol)) {
          warnings.push(`Skipped unsupported option/derivative row ${rowNum} (${rawSymbol.trim().slice(0, 32)})`);
          skippedRows += 1;
          continue;
        }
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const qtyRaw = findCell(tradeHeaders, rest, QUANTITY_ALIASES) ?? "0";
        const pxRaw = findCell(tradeHeaders, rest, ["t. price", "trade price", "price"]) ?? "0";
        const proceedsRaw = findCell(tradeHeaders, rest, ["proceeds", "amount"]) ?? "0";
        const commRaw = findCell(tradeHeaders, rest, ["comm/fee", "commission", "fees"]) ?? "0";
        const qty = qtyRaw.trim() && !isNaPlaceholder(qtyRaw) ? parseCsvDecimal(qtyRaw, rowNum, "Quantity") : ZERO;
        const px = pxRaw.trim() && !isNaPlaceholder(pxRaw) ? parseCsvDecimal(pxRaw, rowNum, "Price") : ZERO;
        const proceeds = proceedsRaw.trim() && !isNaPlaceholder(proceedsRaw) ? parseCsvDecimal(proceedsRaw, rowNum, "Proceeds") : ZERO;
        const comm = commRaw.trim() && !isNaPlaceholder(commRaw) ? parseCsvDecimal(commRaw, rowNum, "Comm/Fee") : ZERO;
        const dateSanitized = sanitizeCsvTextCell(findCell(tradeHeaders, rest, ["date/time", "date", "trade date"]) ?? "", "Date/Time", warnings);
        const date = normalizeTransactionDate(dateSanitized, rowNum, warnings);
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
          if (totalRaw && totalRaw.trim() && !isNaPlaceholder(totalRaw)) {
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
    const initialHeaders = rows[located.index]!.map((h) => h.trim());
    const initialNormalized = initialHeaders.map(normalizeHeader);
    let activeHeaders = initialHeaders;
    let inSecondaryTxSection = false;
    const mappingMap = new Map<string, { canonicalField: string; sourceHeader: string }>();
    collectMappings(activeHeaders).forEach((m) => mappingMap.set(m.canonicalField, m));
    skippedRows = located.index;

    for (let idx = located.index + 1; idx < rows.length; idx += 1) {
      const row = rows[idx]!;
      const rowNum = idx + 1;
      if (row.every((c) => !c.trim())) {
        skippedRows += 1;
        continue;
      }

      if (isDisclaimerOrFooterRow(row)) {
        skippedRows += 1;
        continue;
      }

      const rowNormalized = row.map(normalizeHeader);
      if (
        rowNormalized.length === initialNormalized.length
        && rowNormalized.every((cell, i) => cell === initialNormalized[i])
      ) {
        activeHeaders = row.map((h) => h.trim());
        inSecondaryTxSection = false;
        skippedRows += 1;
        continue;
      }
      if (isSecondaryTransactionHeader(rowNormalized)) {
        activeHeaders = row.map((h) => h.trim());
        inSecondaryTxSection = true;
        collectMappings(activeHeaders).forEach((m) => {
          if (!mappingMap.has(m.canonicalField)) mappingMap.set(m.canonicalField, m);
        });
        skippedRows += 1;
        continue;
      }

      const headers = activeHeaders;
      const rawSymbol = findCell(headers, row, SYMBOL_ALIASES) ?? "";
      const symbolLower = rawSymbol.trim().toLowerCase();
      const companyRaw = findCell(headers, row, COMPANY_ALIASES) ?? "";
      const rawCurrCell = findCell(headers, row, CURRENCY_ALIASES);
      const explicitCurrency = rawCurrCell && rawCurrCell.trim() ? normalizeCurrency(rawCurrCell) : undefined;

      if (isCashRow(symbolLower, companyRaw)) {
        if (inSecondaryTxSection) {
          skippedRows += 1;
          continue;
        }
        const valRaw = findCell(headers, row, CASH_ROW_VALUE_ALIASES);
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

      if (!inSecondaryTxSection) {
        const cashCol = findCell(headers, row, CASH_COL_ALIASES);
        if (cashCol && cashCol.trim() && !isNaPlaceholder(cashCol)) {
          const parsedCash = parseCsvDecimal(cashCol, rowNum, "cash");
          const cashCurr = explicitCurrency ?? inferCurrencyFromAmount(cashCol) ?? "USD";
          const existingCash = cashByCurrencyMap.get(cashCurr) ?? ZERO;
          if (decimalCompare(parsedCash, ZERO) > 0 && decimalCompare(existingCash, ZERO) === 0) {
            cashByCurrencyMap.set(cashCurr, parsedCash);
          }
        }
      }

      if (isSummaryOrBlankSymbol(rawSymbol)) {
        skippedRows += 1;
        continue;
      }

      if (isOptionRow(headers, row, rawSymbol)) {
        warnings.push(`Skipped unsupported option/derivative row ${rowNum} (${rawSymbol.trim().slice(0, 32)})`);
        skippedRows += 1;
        continue;
      }

      const actionCell = findCell(headers, row, ["action", "side", "transaction type"]);
      const isTx = inSecondaryTxSection
        || format === "schwab_transactions"
        || Boolean(actionCell && actionCell.trim());

      if (isTx) {
        const symbol = validateCsvSymbol(rawSymbol, rowNum);
        const action = sanitizeCsvTextCell(actionCell ?? "", "Action", warnings);
        const dateSanitized = sanitizeCsvTextCell(
          findCell(headers, row, ["date", "trade date", "settlement date"]) ?? "",
          "Date",
          warnings,
        );
        const date = normalizeTransactionDate(dateSanitized, rowNum, warnings);
        const qtyRaw = findCell(headers, row, QUANTITY_ALIASES) ?? "0";
        const pxRaw = findCell(headers, row, ["price", "trade price", "unit price", "share price"]) ?? "0";
        const feesRaw = findCell(headers, row, ["fees & comm", "commissions and fees", "fees", "commission"]) ?? "0";
        const amtRaw = findCell(headers, row, ["amount", "net amount", "principal amount", "proceeds"]) ?? "0";

        const qty = qtyRaw.trim() && !isNaPlaceholder(qtyRaw) ? parseCsvDecimal(qtyRaw, rowNum, "Quantity") : ZERO;
        const px = pxRaw.trim() && !isNaPlaceholder(pxRaw) ? parseCsvDecimal(pxRaw, rowNum, "Price") : ZERO;
        const fees = feesRaw.trim() && !isNaPlaceholder(feesRaw) ? parseCsvDecimal(feesRaw, rowNum, "Fees") : ZERO;
        const amt = amtRaw.trim() && !isNaPlaceholder(amtRaw) ? parseCsvDecimal(amtRaw, rowNum, "Amount") : ZERO;

        const txCurr = explicitCurrency
          ?? inferCurrencyFromAmount(pxRaw)
          ?? inferCurrencyFromAmount(amtRaw)
          ?? inferCurrencyFromSymbol(symbol)
          ?? "USD";
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
      if (isNaPlaceholder(qtyRaw)) {
        skippedRows += 1;
        continue;
      }
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
        if (decimalCompare(lastPrice, ZERO) < 0) {
          throw new Error(`Negative last_price is not allowed in row ${rowNum} for ${symbol}`);
        }
      } else if (mktValRaw && mktValRaw.trim() && !isNaPlaceholder(mktValRaw)) {
        const mv = parseCsvDecimal(mktValRaw, rowNum, "Market Value");
        if (decimalCompare(mv, ZERO) < 0) {
          throw new Error(`Negative last_price is not allowed in row ${rowNum} for ${symbol}`);
        }
        lastPrice = decimalDivide(mv, qty, 8, "half-up");
      }

      let avgCost = lastPrice;
      if (avgCostRaw && avgCostRaw.trim() && !isNaPlaceholder(avgCostRaw)) {
        avgCost = parseCsvDecimal(avgCostRaw, rowNum, "Average Cost");
        if (decimalCompare(avgCost, ZERO) < 0) {
          throw new Error(`Negative average_cost is not allowed in row ${rowNum} for ${symbol}`);
        }
      } else if (costBasisRaw && costBasisRaw.trim() && !isNaPlaceholder(costBasisRaw)) {
        const basis = parseCsvDecimal(costBasisRaw, rowNum, "Cost Basis");
        if (decimalCompare(basis, ZERO) < 0) {
          throw new Error(`Negative average_cost is not allowed in row ${rowNum} for ${symbol}`);
        }
        avgCost = decimalDivide(basis, qty, 8, "half-up");
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
    columnMappings = [...mappingMap.values()];
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
    || txActionReplayRank(a.action) - txActionReplayRank(b.action)
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
  const baseFingerprint = await computeFingerprint(
    format,
    primaryCurrency,
    cashStr,
    cashByCurrency,
    holdings,
    sortedTransactions,
  );
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const resolvedAccountLabel = accountLabel?.trim() || "Local Portfolio (CSV + Paper)";
  let fingerprint = baseFingerprint;
  if (resolvedAccountId !== DEFAULT_ACCOUNT_ID) {
    const scopedBytes = new TextEncoder().encode(
      `foliohelm/account-snapshot/v1|${resolvedAccountId}|${baseFingerprint}`,
    );
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", scopedBytes);
      fingerprint = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    } else {
      let hash = 0x811c9dc5;
      for (const b of scopedBytes) {
        hash ^= b;
        hash = Math.imul(hash, 0x01000193);
      }
      fingerprint = `${(hash >>> 0).toString(16).padStart(8, "0")}${baseFingerprint.slice(8)}`;
    }
  }
  const alreadyImported = storedFingerprints().includes(fingerprint);
  const labels = FORMAT_LABELS[format];

  const snapshot: ImportedPortfolioSnapshot = {
    id: `csv-${fingerprint.slice(0, 16)}`,
    accountId: resolvedAccountId,
    fingerprint,
    sourceFormat: format,
    sourceLabel: safeLabel,
    importedAtUtc: new Date().toISOString(),
    accountLabel: resolvedAccountLabel,
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

function buildNavRecordsFromImportedSnapshot(
  snapshot: ImportedPortfolioSnapshot,
  dateIso: string,
  source: "csv-import" | "portfolio-load",
): NavSnapshotRecord[] {
  const acctId = snapshot.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const updatedAt = snapshot.importedAtUtc || new Date().toISOString();
  const positionsByCurr = new Map<string, bigint>();
  const cashByCurr = new Map<string, bigint>();
  const currSet = new Set<string>();

  for (const h of snapshot.holdings) {
    const curr = (h.currency || "USD").trim().toUpperCase();
    if (!curr || curr === "MULTI") continue;
    const qtyMicros = decimalToMicros(h.quantity);
    const priceMicros = decimalToMicros(h.lastPrice || h.averageCost);
    const mvMicros = mulDivRoundBigInt(qtyMicros, priceMicros, MICROS_PER_UNIT);
    positionsByCurr.set(curr, (positionsByCurr.get(curr) ?? 0n) + mvMicros);
    currSet.add(curr);
  }

  if (snapshot.cashByCurrency && Object.keys(snapshot.cashByCurrency).length > 0) {
    for (const [rawCurr, rawCash] of Object.entries(snapshot.cashByCurrency)) {
      const curr = rawCurr.trim().toUpperCase();
      if (!curr || curr === "MULTI") continue;
      const cashMicros = decimalToMicros(rawCash);
      cashByCurr.set(curr, (cashByCurr.get(curr) ?? 0n) + cashMicros);
      if (cashMicros !== 0n || currSet.has(curr)) currSet.add(curr);
    }
  } else if (!snapshot.isMultiCurrency) {
    const curr = (snapshot.currency && snapshot.currency !== "MULTI" ? snapshot.currency : "USD").toUpperCase();
    cashByCurr.set(curr, decimalToMicros(snapshot.cash || "0"));
    currSet.add(curr);
  }

  if (currSet.size === 0) {
    const fallback = snapshot.currency && snapshot.currency !== "MULTI" ? snapshot.currency.toUpperCase() : "USD";
    currSet.add(fallback);
  }

  return [...currSet].sort().map((curr) => {
    const cashMicros = cashByCurr.get(curr) ?? 0n;
    const positionsMicros = positionsByCurr.get(curr) ?? 0n;
    const netMicros = cashMicros + positionsMicros;
    return {
      date: dateIso,
      accountId: acctId,
      currency: curr,
      netValueMicros: netMicros.toString(),
      cashMicros: cashMicros.toString(),
      positionsMicros: positionsMicros.toString(),
      externalCashFlowMicros: "0",
      source,
      updatedAt,
    };
  });
}

export async function recordNavSnapshotsForPortfolio(
  snapshot: ImportedPortfolioSnapshot,
  source: "csv-import" | "portfolio-load",
  dateIso = todayUtcIsoDate(),
): Promise<void> {
  const records = buildNavRecordsFromImportedSnapshot(snapshot, dateIso, source);
  if (records.length > 0) {
    await NAV_STORE.recordSnapshots(records, true);
  }
}

export async function previewBrokerCsv(
  rawCsv: string,
  sourceLabel: string,
  accountId?: string,
  accountLabel?: string,
): Promise<CsvImportPreview> {
  if (isTauriRuntime()) {
    return invokeCsvPreviewImport(rawCsv, sourceLabel, accountId, accountLabel);
  }
  return parseCsvLocally(rawCsv, sourceLabel, accountId, accountLabel);
}

export async function commitBrokerCsv(
  rawCsv: string,
  sourceLabel: string,
  accountId?: string,
  accountLabel?: string,
): Promise<CsvCommitResult> {
  if (isTauriRuntime()) {
    const result = await invokeCsvCommitImport(rawCsv, sourceLabel, accountId, accountLabel);
    ACCOUNT_STORE.registerAccountSnapshot(result.snapshot);
    await NAV_STORE.hydrateFromVault().catch(() => {});
    return result;
  }

  const preview = await parseCsvLocally(rawCsv, sourceLabel, accountId, accountLabel);
  const fingerprints = storedFingerprints();
  if (fingerprints.includes(preview.snapshot.fingerprint)) {
    const existing = ACCOUNT_STORE.getSnapshotForAccount(preview.snapshot.accountId ?? DEFAULT_ACCOUNT_ID)
      ?? readStored<ImportedPortfolioSnapshot | null>(LOCAL_PORTFOLIO_KEY, null);
    const snap = existing ?? preview.snapshot;
    ACCOUNT_STORE.registerAccountSnapshot(snap);
    await recordNavSnapshotsForPortfolio(snap, "csv-import");
    return {
      deduplicated: true,
      evidenceSequence: null,
      snapshot: snap,
    };
  }

  writeStored(LOCAL_PORTFOLIO_KEY, preview.snapshot);
  writeStored(LOCAL_FINGERPRINTS_KEY, [...fingerprints, preview.snapshot.fingerprint]);
  ACCOUNT_STORE.registerAccountSnapshot(preview.snapshot);
  await recordNavSnapshotsForPortfolio(preview.snapshot, "csv-import");
  const evidence = await appendEvidence("portfolio_import", {
    mode: "local-csv",
    accountId: preview.snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
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

export async function loadPersistedAccountPortfolios(): Promise<ImportedPortfolioSnapshot[]> {
  if (isTauriRuntime()) {
    const multi = await invokeVaultLoadAccountPortfolios().catch(() => null);
    if (Array.isArray(multi)) {
      return multi;
    }
    // Backward-compatible fallback for older test mocks that only stub `vault_load_portfolio`.
    const single = await invokeVaultLoadPortfolio().catch(() => null);
    return single ? [single] : [];
  }

  await ACCOUNT_STORE.hydrateAccountsFromVault();
  const fromAccounts = ACCOUNT_STORE.getAllAccountSnapshots();
  if (fromAccounts.length > 0) return fromAccounts;
  const legacySingle = readStored<ImportedPortfolioSnapshot | null>(LOCAL_PORTFOLIO_KEY, null);
  return legacySingle ? [{ ...legacySingle, accountId: legacySingle.accountId ?? DEFAULT_ACCOUNT_ID }] : [];
}

export async function clearPersistedLocalPortfolio(): Promise<boolean> {
  const tauriOk = isTauriRuntime() ? await invokeVaultClearPortfolio() : true;
  ACCOUNT_STORE.clearAll();
  NAV_STORE.clearAll();
  const localOk = removeStored(LOCAL_PORTFOLIO_KEY)
    && removeStored(LOCAL_FINGERPRINTS_KEY)
    && removeStored(LOCAL_PAPER_ORDERS_KEY);
  return tauriOk && localOk;
}
