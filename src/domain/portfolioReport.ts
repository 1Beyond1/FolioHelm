/**
 * Sanitized Portfolio Review Report Export domain module (Markdown & CSV) — v0.2.0.
 *
 * Financial & security invariants:
 * - Zero IEEE-754 floating-point math: all amounts, weights, P&L, TWR, and cash-flow
 *   summaries stay in exact `Decimal` / `BigInt` micro strings.
 * - Strict currency-bucket isolation: never aggregates across currencies without verified FX.
 * - Automatic PII / sensitive-number redaction: masks raw brokerage account numbers
 *   (e.g., 6+ digit numeric sequences, IBKR `U1234567`, hyphenated account IDs) and
 *   credential-like tokens before emitting Markdown or CSV output.
 * - CSV Formula Injection Defense (OWASP): neutralizes leading `=`, `+`, `-`, `@`,
 *   `\t`, `\r` in text cells and strips embedded newlines so exported spreadsheets
 *   never execute injected formulas in Excel / Calc / Sheets.
 */
import type { Language } from "../types";
import { ACCOUNT_STORE, ALL_ACCOUNTS_ID } from "./accounts";
import {
  CASH_FLOW_STORE,
  cashFlowSignedDecimal,
  computePnlAttribution,
  summarizeCashFlowsForBucket,
  type CashFlowBucketSummary,
  type CashFlowRecord,
  type PnlAttributionSummary,
} from "./cashFlows";
import type { WorkspaceMode } from "./contracts";
import {
  decimal,
  decimalCompare,
  decimalDivide,
  decimalMultiply,
  decimalRound,
  decimalToFixed,
  type DecimalString,
} from "./decimal";
import { MOCK_BROKER } from "./mockBroker";
import {
  aggregateNavSnapshotsByCurrency,
  computeTwrSeries,
  microsToDecimal,
  NAV_STORE,
  type TwrSeriesResult,
} from "./nav";
import { extractCurrencyBuckets } from "./rebalance";

const ZERO = decimal("0");
const HUNDRED = decimal("100");

export interface ReportHoldingRow {
  symbol: string;
  company: string;
  currency: string;
  quantity: DecimalString;
  averageCost: DecimalString;
  lastPrice: DecimalString;
  marketValue: DecimalString;
  unrealizedPnl: DecimalString;
  dividendsReceived: DecimalString;
  weightPct: DecimalString;
}

export interface ReportCurrencyBucket {
  currency: string;
  totalEquity: DecimalString;
  holdingsValue: DecimalString;
  cash: DecimalString;
  holdings: ReportHoldingRow[];
  twrSeries: TwrSeriesResult | null;
  cashFlowSummary: CashFlowBucketSummary;
  cashFlows: CashFlowRecord[];
  pnlAttribution: PnlAttributionSummary;
}

export interface PortfolioReportInput {
  language: Language;
  workspaceMode: WorkspaceMode;
  generatedAtUtc: string;
  accountId: string;
  accountLabel: string;
  buckets: ReportCurrencyBucket[];
}

/**
 * Redacts raw brokerage account numbers, IBKR-style account IDs, and credential-like
 * substrings so exported portfolio review reports can be shared or archived safely.
 */
export function sanitizeSensitiveReportText(raw: string): string {
  if (!raw) return "";
  let text = raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Redact explicit credential / token assignments
  text = text.replace(
    /\b(?:api[_-]?key|app[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|passphrase|secret|token|authorization)\s*[:=]\s*\S+/gi,
    "[REDACTED]",
  );
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "[REDACTED]");
  text = text.replace(/\b(?:sk-[A-Za-z0-9]{17,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED]");

  // Mask IBKR-style account identifiers (e.g. U1234567 -> U••••567)
  text = text.replace(/\b([UFD])(\d{3,})(\d{3})\b/g, "$1••••$3");

  // Mask hyphenated account numbers (e.g. 1234-5678 or 123-456-7890 -> ••••-5678)
  text = text.replace(/\b\d{3,6}-\d{3,6}(?:-\d{3,6})?\b/g, (match) => {
    const parts = match.split("-");
    const tail = parts[parts.length - 1] ?? "";
    return `••••-${tail.slice(-4)}`;
  });

  // Mask long bare numeric account sequences (6+ digits -> •••• + last 4 digits)
  text = text.replace(/\b\d{6,}\b/g, (match) => `••••${match.slice(-4)}`);

  return text;
}

/**
 * Escapes text for Markdown table cells (strips pipes/newlines and redacts sensitive numbers).
 */
function escapeMdCell(raw: string): string {
  return sanitizeSensitiveReportText(raw).replace(/\|/g, "\\|");
}

/**
 * Escapes a single CSV cell with OWASP formula-injection defense.
 * Any non-numeric cell (or any cell with dangerous leading formula trigger `=`, `+`, `@`, `\t`, `\r`,
 * or non-numeric `-`) is prefixed with `'` before RFC-4180 quoting.
 */
export function escapeCsvCell(
  raw: string,
  options: { isNumeric?: boolean; sanitizeSensitive?: boolean } = {},
): string {
  const cleaned = options.sanitizeSensitive === false
    ? raw.replace(/[\r\n\u0000]+/g, " ").trim()
    : sanitizeSensitiveReportText(raw);

  const isPlainNumeric = Boolean(
    options.isNumeric && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned),
  );

  let safe = cleaned;
  if (!isPlainNumeric && safe.length > 0 && /^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }

  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function formatFixedAmount(val: DecimalString, scale = 2): string {
  return decimalToFixed(decimalRound(val, scale, "half-up"), scale, "half-up");
}

function formatSignedFixedAmount(val: DecimalString, scale = 2): string {
  const fixed = formatFixedAmount(val, scale);
  return decimalCompare(val, ZERO) > 0 ? `+${fixed}` : fixed;
}

function formatFlowTypeLabel(type: CashFlowRecord["flowType"], language: Language): string {
  if (language === "zh") {
    switch (type) {
      case "dividend":
        return "股息分红";
      case "deposit":
        return "资金转入";
      case "withdrawal":
        return "资金转出";
      case "fee":
        return "费用/税费";
    }
  }
  switch (type) {
    case "dividend":
      return "Dividend";
    case "deposit":
      return "Deposit";
    case "withdrawal":
      return "Withdrawal";
    case "fee":
      return "Fee / Tax";
  }
}

/**
 * Generates a structured, PII-sanitized Markdown portfolio review report.
 */
export function generatePortfolioMarkdownReport(input: PortfolioReportInput): string {
  const zh = input.language === "zh";
  const safeAccount = escapeMdCell(input.accountLabel || input.accountId);
  const modeLabel = input.workspaceMode === "local-csv"
    ? (zh ? "本地持仓 (CSV + 纸上模拟)" : "Local Portfolio (CSV + Paper)")
    : (zh ? "Mock 演示模式" : "Mock Demo");

  const lines: string[] = [];
  lines.push(zh ? "# FolioHelm 投资组合复盘报告（已脱敏）" : "# FolioHelm Portfolio Review Report (Sanitized)");
  lines.push("");
  lines.push(`- **${zh ? "生成时间 (UTC)" : "Generated (UTC)"}**: \`${input.generatedAtUtc}\``);
  lines.push(`- **${zh ? "工作区模式" : "Workspace Mode"}**: ${modeLabel}`);
  lines.push(`- **${zh ? "账户范围" : "Account Scope"}**: ${safeAccount}`);
  lines.push(`- **${zh ? "币种口径" : "Currency Policy"}**: ${zh ? "按结算币种桶严格隔离，未接入权威汇率前不跨币种相加" : "Strictly isolated per currency bucket (no unverified cross-currency FX summation)"}`);
  lines.push("");

  if (input.buckets.length === 0) {
    lines.push(zh ? "> 当前账户范围内暂无持仓或现金数据。" : "> No holdings or cash balances in the selected account scope.");
    lines.push("");
  }

  for (const bucket of input.buckets) {
    const curr = bucket.currency.toUpperCase();
    lines.push(zh ? `## ${curr} 币种桶概览` : `## ${curr} Currency Bucket`);
    lines.push("");

    const twrSummary = bucket.twrSeries && bucket.twrSeries.hasEnoughPoints && bucket.twrSeries.cumulativeTwrPct !== null
      ? `${decimalCompare(decimal(bucket.twrSeries.cumulativeTwrPct), ZERO) > 0 ? "+" : ""}${bucket.twrSeries.cumulativeTwrPct}% (${bucket.twrSeries.snapshotCount} ${zh ? "个快照点" : "snapshots"})`
      : (zh
          ? `样本点不足（当前 ${bucket.twrSeries?.snapshotCount ?? 0} 个真实净值快照，需 ≥ 2 个点计算 TWR）`
          : `Insufficient snapshots (${bucket.twrSeries?.snapshotCount ?? 0} real NAV snapshots; ≥ 2 required for TWR)`);

    lines.push(zh ? "| 指标 | 数值 |" : "| Metric | Value |");
    lines.push("| --- | ---: |");
    lines.push(`| ${zh ? "总权益" : "Total Equity"} | ${formatFixedAmount(bucket.totalEquity)} ${curr} |`);
    lines.push(`| ${zh ? "持仓市值" : "Holdings Value"} | ${formatFixedAmount(bucket.holdingsValue)} ${curr} |`);
    lines.push(`| ${zh ? "现金余额" : "Cash Balance"} | ${formatFixedAmount(bucket.cash)} ${curr} |`);
    lines.push(`| ${zh ? "未实现盈亏" : "Unrealized P&L"} | ${formatSignedFixedAmount(bucket.pnlAttribution.totalUnrealizedPnl)} ${curr} |`);
    lines.push(`| ${zh ? "累计分红收入" : "Cumulative Dividends"} | ${formatSignedFixedAmount(bucket.cashFlowSummary.totalDividends)} ${curr} |`);
    lines.push(`| ${zh ? "净外部出入金" : "Net External Flow"} | ${formatSignedFixedAmount(bucket.cashFlowSummary.netExternalFlow)} ${curr} |`);
    lines.push(`| ${zh ? "时间加权收益率 (TWR)" : "Time-Weighted Return (TWR)"} | ${twrSummary} |`);
    lines.push("");

    lines.push(zh ? `### ${curr} 持仓明细与盈亏归因` : `### ${curr} Holdings & P&L Attribution`);
    lines.push("");
    if (bucket.holdings.length === 0) {
      lines.push(zh ? "_该币种桶暂无持仓。_" : "_No holdings in this currency bucket._");
      lines.push("");
    } else {
      lines.push(
        zh
          ? "| 代码 | 名称 | 股数 | 成本均价 | 现价 | 市值 | 未实现盈亏 | 累计分红 | 桶内占比 |"
          : "| Symbol | Company | Shares | Avg Cost | Last Price | Market Value | Unrealized P&L | Dividends | Weight |",
      );
      lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const h of bucket.holdings) {
        lines.push(
          `| ${escapeMdCell(h.symbol)} | ${escapeMdCell(h.company)} | ${decimal(h.quantity)} | ${formatFixedAmount(h.averageCost, 4)} | ${formatFixedAmount(h.lastPrice, 4)} | ${formatFixedAmount(h.marketValue)} | ${formatSignedFixedAmount(h.unrealizedPnl)} | ${formatFixedAmount(h.dividendsReceived)} | ${formatFixedAmount(h.weightPct)}% |`,
        );
      }
      lines.push("");
    }

    lines.push(zh ? `### ${curr} 分红与现金流台账` : `### ${curr} Cash-Flow & Dividend Ledger`);
    lines.push("");
    if (bucket.cashFlows.length === 0) {
      lines.push(zh ? "_该币种桶暂无现金流或分红记录。_" : "_No cash-flow or dividend records in this bucket._");
      lines.push("");
    } else {
      lines.push(
        zh
          ? "| 日期 | 类型 | 标的 | 金额 | 备注（已脱敏） |"
          : "| Date | Type | Symbol | Amount | Note (Sanitized) |",
      );
      lines.push("| --- | --- | --- | ---: | --- |");
      for (const cf of bucket.cashFlows) {
        const signed = cashFlowSignedDecimal(cf);
        lines.push(
          `| ${escapeMdCell(cf.flowDate)} | ${formatFlowTypeLabel(cf.flowType, input.language)} | ${cf.symbol ? escapeMdCell(cf.symbol) : "—"} | ${formatSignedFixedAmount(signed)} ${curr} | ${cf.note ? escapeMdCell(cf.note) : "—"} |`,
        );
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(
    zh
      ? "_声明：本报告由 FolioHelm 在本机基于加密金库只读生成，已自动脱敏账户敏感编号，仅供个人复盘参考，不构成投资建议或券商官方对账单。_"
      : "_Disclaimer: Generated locally and read-only by FolioHelm with automatic sensitive account-number redaction. For personal review only; not investment advice or an official brokerage statement._",
  );

  return lines.join("\n");
}

/**
 * Generates a formula-injection-safe, PII-sanitized CSV portfolio review report.
 */
export function generatePortfolioCsvReport(input: PortfolioReportInput): string {
  const header = [
    "Section",
    "Currency",
    "Account",
    "Date",
    "Symbol",
    "Description",
    "Type",
    "Quantity",
    "AvgCost",
    "LastPrice",
    "Amount",
    "UnrealizedPnL",
    "WeightPct",
    "Note",
  ].join(",");

  const rows: string[] = [header];
  const accountText = input.accountLabel || input.accountId;

  for (const bucket of input.buckets) {
    const curr = bucket.currency.toUpperCase();
    const twrNote = bucket.twrSeries && bucket.twrSeries.hasEnoughPoints && bucket.twrSeries.cumulativeTwrPct !== null
      ? `TWR ${bucket.twrSeries.cumulativeTwrPct}% (${bucket.twrSeries.snapshotCount} pts), PeriodPnL ${microsToDecimal(BigInt(bucket.twrSeries.periodPnlMicros), 2)} ${curr}`
      : `NAV snapshots: ${bucket.twrSeries?.snapshotCount ?? 0}`;

    rows.push(
      [
        escapeCsvCell("SUMMARY", { sanitizeSensitive: false }),
        escapeCsvCell(curr, { sanitizeSensitive: false }),
        escapeCsvCell(accountText),
        escapeCsvCell(input.generatedAtUtc.slice(0, 10), { sanitizeSensitive: false }),
        "",
        escapeCsvCell("Bucket Summary", { sanitizeSensitive: false }),
        escapeCsvCell(input.workspaceMode, { sanitizeSensitive: false }),
        "",
        "",
        "",
        escapeCsvCell(formatFixedAmount(bucket.totalEquity), { isNumeric: true, sanitizeSensitive: false }),
        escapeCsvCell(formatFixedAmount(bucket.pnlAttribution.totalUnrealizedPnl), { isNumeric: true, sanitizeSensitive: false }),
        escapeCsvCell("100.00", { isNumeric: true, sanitizeSensitive: false }),
        escapeCsvCell(`Cash=${formatFixedAmount(bucket.cash)}; Dividends=${formatFixedAmount(bucket.cashFlowSummary.totalDividends)}; NetFlow=${formatFixedAmount(bucket.cashFlowSummary.netExternalFlow)}; ${twrNote}`),
      ].join(","),
    );

    for (const h of bucket.holdings) {
      rows.push(
        [
          escapeCsvCell("HOLDING", { sanitizeSensitive: false }),
          escapeCsvCell(curr, { sanitizeSensitive: false }),
          escapeCsvCell(accountText),
          escapeCsvCell(input.generatedAtUtc.slice(0, 10), { sanitizeSensitive: false }),
          escapeCsvCell(h.symbol),
          escapeCsvCell(h.company),
          escapeCsvCell("POSITION", { sanitizeSensitive: false }),
          escapeCsvCell(decimal(h.quantity), { isNumeric: true, sanitizeSensitive: false }),
          escapeCsvCell(formatFixedAmount(h.averageCost, 4), { isNumeric: true, sanitizeSensitive: false }),
          escapeCsvCell(formatFixedAmount(h.lastPrice, 4), { isNumeric: true, sanitizeSensitive: false }),
          escapeCsvCell(formatFixedAmount(h.marketValue), { isNumeric: true, sanitizeSensitive: false }),
          escapeCsvCell(formatFixedAmount(h.unrealizedPnl), { isNumeric: true, sanitizeSensitive: false }),
          escapeCsvCell(formatFixedAmount(h.weightPct), { isNumeric: true, sanitizeSensitive: false }),
          escapeCsvCell(
            decimalCompare(h.dividendsReceived, ZERO) > 0
              ? `Dividends=${formatFixedAmount(h.dividendsReceived)}`
              : "",
          ),
        ].join(","),
      );
    }

    for (const cf of bucket.cashFlows) {
      const signed = cashFlowSignedDecimal(cf);
      rows.push(
        [
          escapeCsvCell("CASH_FLOW", { sanitizeSensitive: false }),
          escapeCsvCell(curr, { sanitizeSensitive: false }),
          escapeCsvCell(accountText),
          escapeCsvCell(cf.flowDate, { sanitizeSensitive: false }),
          escapeCsvCell(cf.symbol ?? ""),
          escapeCsvCell(formatFlowTypeLabel(cf.flowType, input.language)),
          escapeCsvCell(cf.flowType.toUpperCase(), { sanitizeSensitive: false }),
          "",
          "",
          "",
          escapeCsvCell(formatFixedAmount(signed), { isNumeric: true, sanitizeSensitive: false }),
          "",
          "",
          escapeCsvCell(cf.note),
        ].join(","),
      );
    }
  }

  return rows.join("\n");
}

/**
 * Builds a complete, currency-isolated `PortfolioReportInput` from the live
 * frontend domain stores (`MOCK_BROKER`, `ACCOUNT_STORE`, `NAV_STORE`, `CASH_FLOW_STORE`).
 */
export function buildPortfolioReportInputFromStores(
  language: Language,
  selectedAccountId: string = MOCK_BROKER.getSelectedAccountId(),
  generatedAtUtc: string = new Date().toISOString(),
): PortfolioReportInput {
  const workspaceMode = MOCK_BROKER.getWorkspaceMode();
  const snapshot = MOCK_BROKER.getSnapshot();
  const accounts = ACCOUNT_STORE.getAccounts();
  const accountLabel = workspaceMode === "mock"
    ? (language === "zh" ? "Mock 演示账户 (•••• 1234)" : "Mock Demo Account (•••• 1234)")
    : selectedAccountId === ALL_ACCOUNTS_ID
      ? (language === "zh" ? `全部本地账户 (${accounts.length})` : `All Local Accounts (${accounts.length})`)
      : (accounts.find((a) => a.id === selectedAccountId)?.name ?? selectedAccountId);

  const currencyBuckets = extractCurrencyBuckets(snapshot, language);
  const allCashFlows = CASH_FLOW_STORE.getAll();
  const allNavSnapshots = NAV_STORE.getAllSnapshots();

  const buckets: ReportCurrencyBucket[] = currencyBuckets.map((bucket) => {
    const curr = bucket.currency.toUpperCase();
    const bucketCashFlows = CASH_FLOW_STORE.getFiltered(selectedAccountId, curr);
    const cashFlowSummary = summarizeCashFlowsForBucket(allCashFlows, curr, selectedAccountId);
    const pnlAttribution = computePnlAttribution(
      snapshot.holdings,
      allCashFlows,
      curr,
      language,
      selectedAccountId,
    );
    const dividendsBySymbol = new Map(
      pnlAttribution.entries.map((entry) => [entry.symbol, entry.dividendsReceived]),
    );

    const bucketHoldings: ReportHoldingRow[] = snapshot.holdings
      .filter((h) => (h.currency ?? snapshot.account.currency ?? "USD").toUpperCase() === curr)
      .map((h) => {
        const matchedQuote = snapshot.quotes.find(
          (q) => q.symbol === h.symbol && (q.currency ?? "USD").toUpperCase() === curr,
        );
        const weightPct = decimalCompare(bucket.totalEquity, ZERO) > 0 && decimalCompare(h.marketValue, ZERO) > 0
          ? decimalRound(
              decimalMultiply(decimalDivide(h.marketValue, bucket.totalEquity, 6, "half-up"), HUNDRED),
              2,
              "half-up",
            )
          : ZERO;
        return {
          symbol: h.symbol,
          company: language === "zh" ? h.companyZh : h.companyEn,
          currency: curr,
          quantity: h.quantity,
          averageCost: h.averageCost,
          lastPrice: matchedQuote?.price ?? h.averageCost,
          marketValue: h.marketValue,
          unrealizedPnl: h.totalPnl,
          dividendsReceived: dividendsBySymbol.get(h.symbol.toUpperCase()) ?? ZERO,
          weightPct,
        };
      });

    let twrSeries: TwrSeriesResult | null = null;
    if (workspaceMode === "local-csv") {
      try {
        const aggregated = aggregateNavSnapshotsByCurrency(allNavSnapshots, curr, selectedAccountId);
        twrSeries = computeTwrSeries(aggregated, curr, selectedAccountId);
      } catch {
        twrSeries = null;
      }
    }

    return {
      currency: curr,
      totalEquity: bucket.totalEquity,
      holdingsValue: bucket.holdingsValue,
      cash: bucket.cash,
      holdings: bucketHoldings,
      twrSeries,
      cashFlowSummary,
      cashFlows: bucketCashFlows,
      pnlAttribution,
    };
  });

  return {
    language,
    workspaceMode,
    generatedAtUtc,
    accountId: selectedAccountId,
    accountLabel,
    buckets,
  };
}
