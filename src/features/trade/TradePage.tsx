import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "../../types";
import { decimalCompare, decimalMultiply, decimalToNumber, money, price, quantity as makeQuantity, type Money, type Percent, type Price, type Quantity } from "../../domain/decimal";
import { findMockHolding, findMockQuote, MOCK_BROKER, MockBrokerError, mockDraftHash } from "../../domain/mockBroker";
import { appendEvidence } from "../../domain/evidenceJournal";
import { persistPaperOrder } from "../../domain/vaultStorage";
import { formatCurrency } from "../../formatters";
import type { BrokerOrder, BrokerOrderStatus, BrokerSymbol, DataStatus, MockPreview, OrderDraft, QuoteSourceKind, TradePrefill } from "../../domain/contracts";
import "./TradePage.css";

export type TradeSymbol = BrokerSymbol;
export type TradeSide = "Buy" | "Sell";
export type OrderType = "Market" | "Limit";

export interface TradePageProps {
  language: Language;
  initialSymbol?: string;
  initialPrefill?: TradePrefill;
  onClose: () => void;
  onViewOrders: () => void;
}

type TradeStep = "ticket" | "safety" | "preview" | "receipt";
type TicketErrors = Partial<Record<"quantity" | "limitPrice", string>>;

interface Quote {
  company: string;
  price: Price;
  changePct: Percent;
  heldShares: Quantity;
  asOf: string;
  status: DataStatus;
  currency: string;
  source?: QuoteSourceKind;
  provider?: string;
}

interface DemoReceipt {
  receiptId: string;
  orderId: string;
  previewId: string;
  draftHash: string;
  estimatedAmount: Money;
  status: BrokerOrderStatus;
  currency: string;
}

function getTradeQuote(symbol: TradeSymbol, language: Language): Quote {
  const canonicalQuote = findMockQuote(symbol);
  const canonicalHolding = findMockHolding(symbol);
  return {
    company: language === "zh" ? canonicalQuote?.companyZh ?? symbol : canonicalQuote?.companyEn ?? symbol,
    price: canonicalQuote?.price ?? price("0"),
    changePct: canonicalQuote?.changePct ?? ("0" as Percent),
    heldShares: canonicalHolding?.availableQuantity ?? makeQuantity("0"),
    asOf: canonicalQuote?.asOf ?? "",
    status: canonicalQuote?.status ?? "no-data",
    currency: canonicalQuote?.currency ?? canonicalHolding?.currency ?? "USD",
    source: canonicalQuote?.source,
    provider: canonicalQuote?.provider,
  };
}

function formatQuoteFreshness(
  asOf: string,
  language: Language,
  isLocalMode: boolean,
  source?: QuoteSourceKind,
): string {
  const prefix = isLocalMode
    ? source === "public-delayed"
      ? (language === "zh" ? "延迟只读公开行情" : "Delayed public quote")
      : (language === "zh" ? "CSV 导入基准价" : "CSV baseline")
    : (language === "zh" ? "模拟快照" : "Mock snapshot");
  const parsed = Date.parse(asOf);
  if (!Number.isFinite(parsed)) {
    return prefix;
  }
  const ageSeconds = Math.floor((Date.now() - parsed) / 1000);
  if (ageSeconds >= 0 && ageSeconds < 60 && !isLocalMode) {
    return language === "zh" ? `${ageSeconds} 秒前` : `${ageSeconds} seconds old`;
  }
  const stamp = new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
  return `${prefix} · ${stamp} UTC`;
}

const COPY = {
  en: {
    title: "Trade workspace",
    eyebrow: "Fictional execution flow",
    demoOnly: "Demo only",
    noConnection: "No brokerage connection · Nothing can be sent",
    ticket: "Ticket",
    safety: "Safety check",
    preview: "Mock preview",
    receipt: "Demo receipt",
    symbol: "Symbol",
    side: "Side",
    buy: "Buy",
    sell: "Sell",
    orderType: "Order type",
    market: "Market",
    limit: "Limit",
    quantity: "Quantity (whole shares)",
    limitPrice: "Limit price",
    quote: "Fictional quote",
    account: "Account",
    buyingPower: "Buying power",
    shares: "shares",
    dollars: "USD",
    continue: "Continue",
    back: "Back",
    continuePreview: "Continue to Mock preview",
    safetyTitle: "Review the fictional safety gates",
    accountMatch: "Account match",
    matchedDemo: "Matched · demo account",
    quoteAge: "Quote age",
    quoteAgeValue: "12 seconds old",
    buyingPowerCheck: "Buying power",
    available: "Available in this mock",
    availableSuffix: "available",
    insufficientBuyingPower: "Insufficient buying power",
    positionAvailable: "Available to sell",
    positionInsufficient: "Insufficient position",
    positionRisk: "Position / risk limit",
    withinLimit: "Within fictional limit",
    executionGate: "Mock preview gate",
    executionReady: "Local Mock preview is available",
    executionBlocked: "Local Mock preview is currently blocked",
    checkPassed: "Passed",
    checkBlocked: "Blocked",
    accountUnavailable: "Demo account data is unavailable",
    quoteUnavailable: "Quote is not fresh enough for a preview",
    noRequestTitle: "No request exists",
    noRequestBody:
      "This check is local-only. Nothing is queued, sent, retried, or persisted; the request does not exist outside this screen.",
    marketPreviewNote:
      "Market orders may continue to Mock preview in this demo. Real version note: market orders would not be sent from this first preview.",
    previewTitle: "Read the simulated order summary",
    naturalLanguage: "Natural-language summary",
    estimatedAmount: "Estimated amount",
    validity: "Validity",
    validityValue: "This demo session only",
    previewId: "Fictional preview ID",
    marketAtQuote: "at the fictional market quote",
    limitAt: "at a fictional limit of",
    acknowledge:
      "I understand this is a simulated order and that no real request exists.",
    simulate: "Simulate order",
    receiptTitle: "Simulation complete",
    receiptBody:
      "This receipt is fictional. No brokerage request was created and no money or position changed.",
    receiptId: "Fictional receipt ID",
    status: "Status",
    simulated: "Simulated only",
    unknownReceiptTitle: "Simulation result is unknown",
    unknownReceiptBody: "The local Mock ledger could not determine a final outcome. Do not resubmit; review Orders and reconcile the existing record. No brokerage request or money changed.",
    unknownReceiptStatus: "Unknown · reconcile before any retry",
    viewOrders: "View orders",
    another: "Create another",
    close: "Close",
    unsupportedTitle: "No demo data for this symbol",
    unsupportedBody: "This trade window only supports symbols with local fictional quotes. Return to Markets and choose a listed symbol. No order or brokerage request is available.",
    invalidQuantity: "Enter a whole-share quantity greater than 0.",
    invalidLimitPrice: "Enter a limit price greater than 0 with at most two decimal places.",
    previewFailed: "The local Mock preview could not be created. Review the ticket and try again.",
    previewBlocked: "The local Mock preview was blocked by a safety gate. No request was sent; review the account, quote, and position before trying again.",
    simulationFailed: "The local Mock simulation could not be completed. Do not repeat it until the preview state is reviewed.",
    previewExpired: "The local preview expired. Review the ticket and create a new preview.",
    quoteChange: "today",
  },
  zh: {
    title: "交易工作区",
    eyebrow: "虚构执行流程",
    demoOnly: "仅演示",
    noConnection: "未连接券商 · 任何内容都不会发送",
    ticket: "订单",
    safety: "安全检查",
    preview: "模拟预览",
    receipt: "演示回执",
    symbol: "代码",
    side: "方向",
    buy: "买入",
    sell: "卖出",
    orderType: "订单类型",
    market: "市价",
    limit: "限价",
    quantity: "数量（整数股）",
    limitPrice: "限价价格",
    quote: "虚构报价",
    account: "账户",
    buyingPower: "可用购买力",
    shares: "股",
    dollars: "美元",
    continue: "继续",
    back: "返回",
    continuePreview: "继续到模拟预览",
    safetyTitle: "检查虚构安全门槛",
    accountMatch: "账户匹配",
    matchedDemo: "已匹配 · 演示账户",
    quoteAge: "报价年龄",
    quoteAgeValue: "12 秒前",
    buyingPowerCheck: "购买力",
    available: "演示中的可用金额",
    availableSuffix: "可用",
    insufficientBuyingPower: "购买力不足",
    positionAvailable: "可卖数量",
    positionInsufficient: "持仓数量不足",
    positionRisk: "持仓 / 风险限制",
    withinLimit: "在虚构限制内",
    executionGate: "模拟预览门槛",
    executionReady: "本地 Mock 预览可用",
    executionBlocked: "本地 Mock 预览当前被阻止",
    checkPassed: "通过",
    checkBlocked: "已阻止",
    accountUnavailable: "演示账户数据不可用",
    quoteUnavailable: "报价不够新鲜，不能创建预览",
    noRequestTitle: "不存在请求",
    noRequestBody:
      "此检查仅在本地进行。没有内容会排队、发送、重试或持久化；请求不会存在于此页面之外。",
    marketPreviewNote:
      "市价订单在本演示中可以继续到 Mock preview。真实版本说明：市价订单不会在首次预览时发送。",
    previewTitle: "阅读模拟订单摘要",
    naturalLanguage: "自然语言摘要",
    estimatedAmount: "估算金额",
    validity: "有效期",
    validityValue: "仅限本次演示会话",
    previewId: "虚构预览 ID",
    marketAtQuote: "按虚构市价",
    limitAt: "按虚构限价",
    acknowledge: "我了解这是模拟订单，且不存在真实请求。",
    simulate: "模拟订单",
    receiptTitle: "模拟完成",
    receiptBody: "这是一张虚构回执。没有创建券商请求，资金和持仓均未发生变化。",
    receiptId: "虚构回执 ID",
    status: "状态",
    simulated: "仅模拟",
    unknownReceiptTitle: "模拟结果未知",
    unknownReceiptBody: "本地 Mock 账本无法确定最终结果。不要重下；请进入订单页对账现有记录。没有创建券商请求，资金也没有变化。",
    unknownReceiptStatus: "未知 · 任何重试前先对账",
    viewOrders: "查看订单",
    another: "创建另一个",
    close: "关闭",
    unsupportedTitle: "此代码暂无演示数据",
    unsupportedBody: "此交易窗口只支持有本地虚构报价的代码。请返回市场页选择列表中的代码；当前没有订单或券商请求可用。",
    invalidQuantity: "请输入大于 0 的整数数量。",
    invalidLimitPrice: "请输入大于 0 且最多两位小数的限价价格。",
    previewFailed: "本地 Mock 预览创建失败。请检查交易单后再试。",
    previewBlocked: "本地 Mock 预览被安全门槛阻止。没有发送请求；请先检查账户、报价和持仓，再决定是否重试。",
    simulationFailed: "本地 Mock 模拟未完成。在确认预览状态前不要重复操作。",
    previewExpired: "本地预览已过期。请返回检查订单，再创建新的预览。",
    quoteChange: "今日",
  },
} as const;

function normalizeTradeSymbol(
  value: string | undefined,
  availableSymbols: readonly TradeSymbol[],
): TradeSymbol | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized && availableSymbols.includes(normalized)
    ? normalized
    : undefined;
}

function formatMoney(amount: Money | Price, language: Language, currency = "USD"): string {
  return formatCurrency(decimalToNumber(amount), language, currency);
}

const WHOLE_QUANTITY_RE = /^[1-9]\d*$/;
const POSITIVE_PRICE_RE = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;
const ZERO_PRICE = price("0");

export function TradePage({ language, initialSymbol, initialPrefill, onClose, onViewOrders }: TradePageProps) {
  const copy = COPY[language];
  const chinese = language === "zh";
  const [, setBrokerRevision] = useState(0);

  useEffect(() => {
    return MOCK_BROKER.subscribe(() => setBrokerRevision((current) => current + 1));
  }, []);

  const workspaceMode = MOCK_BROKER.getWorkspaceMode();
  const isLocalMode = workspaceMode === "local-csv";
  const demoSnapshot = MOCK_BROKER.getSnapshot();
  const availableSymbols = useMemo<readonly TradeSymbol[]>(() => {
    const set = new Set<string>();
    for (const h of demoSnapshot.holdings) set.add(h.symbol);
    for (const q of demoSnapshot.quotes) set.add(q.symbol);
    return [...set];
  }, [demoSnapshot.holdings, demoSnapshot.quotes]);

  const requestedSymbol = initialPrefill?.symbol ?? initialSymbol;
  const initialTradeSymbol = normalizeTradeSymbol(requestedSymbol, availableSymbols);
  const hasUnsupportedInitialSymbol = requestedSymbol !== undefined && initialTradeSymbol === undefined;
  const unsupportedSymbol = requestedSymbol?.trim().toUpperCase() || "—";

  const demoAccount = isLocalMode
    ? chinese
      ? `本地持仓 (CSV + 纸上模拟) · •••• ${demoSnapshot.account.accountKey.slice(-4)}`
      : `Local Portfolio (CSV + Paper) · •••• ${demoSnapshot.account.accountKey.slice(-4)}`
    : chinese
      ? `演示券商 · •••• ${demoSnapshot.account.accountKey.slice(-4)}`
      : `Demo brokerage · •••• ${demoSnapshot.account.accountKey.slice(-4)}`;

  const [step, setStep] = useState<TradeStep>("ticket");
  const [symbol, setSymbol] = useState<TradeSymbol>(() => initialTradeSymbol ?? availableSymbols[0] ?? "AAPL");
  const [side, setSide] = useState<TradeSide>(() => (initialPrefill?.side === "sell" ? "Sell" : "Buy"));
  const [orderType, setOrderType] = useState<OrderType>(() => (initialPrefill?.orderType === "limit" ? "Limit" : "Market"));
  const [quantity, setQuantity] = useState(() => initialPrefill?.quantity ?? "");
  const [limitPrice, setLimitPrice] = useState(() => initialPrefill?.limitPrice ?? "");
  const [errors, setErrors] = useState<TicketErrors>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [preview, setPreview] = useState<MockPreview | null>(null);
  const [receipt, setReceipt] = useState<DemoReceipt | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);

  const currentQuote = getTradeQuote(symbol, language);
  const quoteCurrency = currentQuote.currency;
  const demoBuyingPower: Money = demoSnapshot.account.isMultiCurrency && demoSnapshot.account.currencyBreakdowns
    ? (demoSnapshot.account.currencyBreakdowns.find((b) => b.currency === quoteCurrency)?.buyingPower ?? money("0"))
    : demoSnapshot.account.buyingPower;

  const badgeText = isLocalMode
    ? (chinese ? "本地持仓 · 纸上模拟" : "Local CSV + Paper")
    : copy.demoOnly;
  const eyebrowText = isLocalMode
    ? (chinese ? "本地纸上模拟流程" : "Local paper rehearsal flow")
    : copy.eyebrow;
  const quoteHeadingText = isLocalMode
    ? currentQuote.source === "public-delayed"
      ? (chinese ? "公开延迟报价（只读）" : "Delayed public quote")
      : (chinese ? "CSV 导入基准价" : "CSV baseline price")
    : copy.quote;

  const draft = useMemo<OrderDraft | null>(() => {
    if (!WHOLE_QUANTITY_RE.test(quantity.trim())) return null;
    if (orderType === "Limit" && !POSITIVE_PRICE_RE.test(limitPrice.trim())) return null;
    return {
      symbol,
      side: side === "Buy" ? "buy" : "sell",
      type: orderType === "Market" ? "market" : "limit",
      quantity: makeQuantity(quantity.trim()),
      limitPrice: orderType === "Limit" ? price(limitPrice.trim()) : null,
    };
  }, [limitPrice, orderType, quantity, side, symbol]);
  const stepNames = [copy.ticket, copy.safety, copy.preview, copy.receipt];
  const stepOrder: readonly TradeStep[] = ["ticket", "safety", "preview", "receipt"];
  const activeStepIndex = stepOrder.indexOf(step);
  const accountReady = demoSnapshot.account.status === "available";
  const quoteReady = currentQuote.status === "available";
  const requestedAmount = draft === null
    ? null
    : decimalMultiply(draft.quantity, draft.limitPrice ?? currentQuote.price) as Money;
  const buyingPowerReady = side === "Buy"
    && accountReady
    && quoteReady
    && requestedAmount !== null
    && decimalCompare(requestedAmount, demoBuyingPower) <= 0;
  const positionReady = side === "Sell"
    && accountReady
    && quoteReady
    && (isLocalMode || MOCK_BROKER.getScenario() !== "insufficient-quantity")
    && draft !== null
    && decimalCompare(draft.quantity, currentQuote.heldShares) <= 0;
  const previewBlockedScenarios = ["offline", "reauth-required", "request-failed", "rate-limited", "timeout", "stale-quote", "market-closed"] as const;
  const executionReady = isLocalMode
    || !previewBlockedScenarios.includes(MOCK_BROKER.getScenario() as (typeof previewBlockedScenarios)[number]);
  const safetyChecks = [
    {
      key: "account",
      passed: accountReady,
      title: copy.accountMatch,
      detail: accountReady
        ? isLocalMode
          ? (chinese ? "已匹配 · 本地持仓组合" : "Matched · local CSV portfolio")
          : copy.matchedDemo
        : copy.accountUnavailable,
      suffix: badgeText,
    },
    {
      key: "quote",
      passed: quoteReady,
      title: copy.quoteAge,
      detail: quoteReady ? formatQuoteFreshness(currentQuote.asOf, language, isLocalMode, currentQuote.source) : copy.quoteUnavailable,
      suffix: quoteHeadingText,
    },
    {
      key: side === "Buy" ? "buying-power" : "position",
      passed: side === "Buy" ? buyingPowerReady : positionReady,
      title: side === "Buy" ? copy.buyingPowerCheck : copy.positionRisk,
      detail: side === "Buy"
        ? buyingPowerReady
          ? `${copy.available} · ${formatMoney(demoBuyingPower, language, quoteCurrency)}`
          : `${copy.insufficientBuyingPower} · ${formatMoney(demoBuyingPower, language, quoteCurrency)} ${copy.availableSuffix}`
        : positionReady
          ? `${copy.positionAvailable} · ${currentQuote.heldShares} ${copy.shares}`
          : `${copy.positionInsufficient} · ${currentQuote.heldShares} ${copy.shares}`,
      suffix: side === "Buy" ? quoteCurrency : copy.shares,
    },
    {
      key: "execution",
      passed: executionReady,
      title: copy.executionGate,
      detail: executionReady ? copy.executionReady : copy.executionBlocked,
      suffix: badgeText,
    },
  ];

  function invalidateCurrentPreview(): void {
    if (preview) MOCK_BROKER.invalidatePreview(preview.previewId);
    setPreview(null);
    setAcknowledged(false);
    setFlowError(null);
  }

  function clearTicketErrors(): void {
    setErrors({});
  }

  function handleTicketContinue(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextErrors: TicketErrors = {};

    if (!WHOLE_QUANTITY_RE.test(quantity.trim())) {
      nextErrors.quantity = copy.invalidQuantity;
    }

    if (orderType === "Limit") {
      if (!POSITIVE_PRICE_RE.test(limitPrice.trim()) || decimalCompare(price(limitPrice.trim()), ZERO_PRICE) <= 0) {
        nextErrors.limitPrice = copy.invalidLimitPrice;
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      setFlowError(null);
      setStep("safety");
    }
  }

  function handleSafetyContinue(): void {
    if (!draft) {
      setErrors({ quantity: copy.previewFailed });
      setStep("ticket");
      return;
    }

    if (preview) MOCK_BROKER.invalidatePreview(preview.previewId);

    try {
      const nextPreview = MOCK_BROKER.previewOrder(draft);
      setPreview(nextPreview);
      setAcknowledged(false);
      setErrors({});
      setFlowError(null);
      setStep("preview");
      void appendEvidence("preview_created", {
        mode: workspaceMode,
        symbol: nextPreview.draft.symbol,
        side: nextPreview.draft.side,
        orderType: nextPreview.draft.type,
        quantity: nextPreview.draft.quantity,
        estimatedAmount: nextPreview.estimatedAmount,
        previewId: nextPreview.previewId,
        draftHash: nextPreview.draftHash,
      }).catch(() => undefined);
    } catch (error) {
      setErrors({});
      setFlowError(copy.previewBlocked);
      setStep("safety");
      void appendEvidence("order_intent", {
        mode: workspaceMode,
        symbol: draft.symbol,
        side: draft.side,
        orderType: draft.type,
        quantity: draft.quantity,
        status: "blocked",
        reason: error instanceof MockBrokerError ? error.code : "preview_failed",
      }).catch(() => undefined);
    }
  }

  function handleSimulate(): void {
    if (!acknowledged || !preview || !draft) return;

    try {
      const currentDraftHash = mockDraftHash(draft);
      const simulatedOrder: BrokerOrder = MOCK_BROKER.consumePreview(preview.previewId, currentDraftHash);

      void persistPaperOrder(workspaceMode, simulatedOrder);
      setReceipt({
        receiptId: `${isLocalMode ? "PAPER-RECEIPT" : "DEMO-RECEIPT"}-${simulatedOrder.id}`,
        orderId: simulatedOrder.id,
        previewId: preview.previewId,
        draftHash: currentDraftHash,
        estimatedAmount: preview.estimatedAmount,
        status: simulatedOrder.status,
        currency: quoteCurrency,
      });
      setStep("receipt");
      void appendEvidence("user_confirmation", {
        mode: workspaceMode,
        symbol: draft.symbol,
        previewId: preview.previewId,
        draftHash: currentDraftHash,
      }).catch(() => undefined);
      void appendEvidence("mock_response", {
        mode: workspaceMode,
        orderId: simulatedOrder.id,
        symbol: simulatedOrder.symbol,
        side: simulatedOrder.side,
        quantity: simulatedOrder.quantity,
        status: simulatedOrder.status,
        previewId: preview.previewId,
      }).catch(() => undefined);
    } catch (error) {
      MOCK_BROKER.invalidatePreview(preview.previewId);
      setPreview(null);
      setAcknowledged(false);
      setFlowError(error instanceof MockBrokerError && error.code === "preview-expired" ? copy.previewExpired : copy.simulationFailed);
      setStep("safety");
      void appendEvidence("mock_response", {
        mode: workspaceMode,
        symbol: draft.symbol,
        previewId: preview.previewId,
        status: "failed",
        reason: error instanceof MockBrokerError ? error.code : "simulation_failed",
      }).catch(() => undefined);
    }
  }

  function handleCreateAnother(): void {
    invalidateCurrentPreview();
    setStep("ticket");
    setQuantity("");
    setLimitPrice("");
    setErrors({});
    setAcknowledged(false);
    setFlowError(null);
    setPreview(null);
    setReceipt(null);
  }

  if (hasUnsupportedInitialSymbol) {
    return (
      <section className="trade-page trade-page--empty" data-testid="trade-page" aria-labelledby="trade-page-title">
        <header className="trade-page__header">
          <div>
            <p className="trade-page__eyebrow">{copy.eyebrow}</p>
            <h1 id="trade-page-title">{copy.title}</h1>
          </div>
          <div className="trade-page__header-actions">
            <button
              type="button"
              className="trade-page__close"
              data-testid="trade-close"
              aria-label={copy.close}
              title={copy.close}
              onClick={onClose}
            >
              <span aria-hidden="true">×</span>
              <span>{copy.close}</span>
            </button>
            <div className="trade-page__demo-state">
              <span className="trade-page__demo-dot" aria-hidden="true" />
              <strong>{copy.demoOnly}</strong>
              <span>{copy.noConnection}</span>
            </div>
          </div>
        </header>

        <section className="trade-empty-state" data-testid="trade-no-data" aria-labelledby="trade-no-data-title">
          <span className="trade-badge trade-badge--quiet">{unsupportedSymbol}</span>
          <h2 id="trade-no-data-title">{copy.unsupportedTitle}</h2>
          <p>{copy.unsupportedBody}</p>
          <button className="trade-button trade-button--secondary" type="button" onClick={onClose}>{copy.close}</button>
        </section>
      </section>
    );
  }

  return (
    <section
      className="trade-page"
      data-testid="trade-page"
      aria-labelledby="trade-page-title"
    >
      <header className="trade-page__header">
        <div>
          <p className="trade-page__eyebrow">{eyebrowText}</p>
          <h1 id="trade-page-title">{copy.title}</h1>
        </div>
        <div className="trade-page__header-actions">
          <button
            type="button"
            className="trade-page__close"
            data-testid="trade-close"
            aria-label={copy.close}
            title={copy.close}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
            <span>{copy.close}</span>
          </button>
          <div className="trade-page__demo-state">
            <span className="trade-page__demo-dot" aria-hidden="true" />
            <strong>{badgeText}</strong>
            <span>{copy.noConnection}</span>
          </div>
        </div>
      </header>

      <nav className="trade-stepper" aria-label={language === "zh" ? "交易进度" : "Trade progress"}>
        <ol>
          {stepNames.map((stepName, index) => {
            const itemStep = stepOrder[index];
            const state = index < activeStepIndex ? "complete" : index === activeStepIndex ? "active" : "upcoming";
            return (
              <li key={itemStep} className={`trade-step trade-step--${state}`} data-state={state}>
                <span className="trade-step__number" aria-hidden="true">{index + 1}</span>
                <span>{stepName}</span>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === "ticket" && (
        <form className="trade-card trade-ticket" onSubmit={handleTicketContinue} noValidate>
          <div className="trade-card__heading">
            <div>
              <p className="trade-card__kicker">01 / 04</p>
              <h2>{copy.ticket}</h2>
            </div>
            <span className="trade-badge">{badgeText}</span>
          </div>

          <div className="trade-ticket__layout">
            <div className="trade-fields">
              <label className="trade-field">
                <span>{copy.symbol}</span>
                <select
                  aria-label={copy.symbol}
                  value={symbol}
                  onChange={(event) => {
                    invalidateCurrentPreview();
                    setSymbol(event.target.value as TradeSymbol);
                    clearTicketErrors();
                  }}
                >
                  {availableSymbols.map((option) => (
                    <option key={option} value={option}>
                      {option} · {getTradeQuote(option, language).company}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="trade-fieldset">
                <legend>{copy.side}</legend>
                <div className="trade-choice-grid">
                  <label className={`trade-choice ${side === "Buy" ? "is-selected trade-choice--buy" : ""}`}>
                    <input
                      type="radio"
                      name="trade-side"
                      value="Buy"
                      checked={side === "Buy"}
                      onChange={() => {
                        invalidateCurrentPreview();
                        setSide("Buy");
                      }}
                    />
                    <span>{copy.buy}</span>
                  </label>
                  <label className={`trade-choice ${side === "Sell" ? "is-selected trade-choice--sell" : ""}`}>
                    <input
                      type="radio"
                      name="trade-side"
                      value="Sell"
                      checked={side === "Sell"}
                      onChange={() => {
                        invalidateCurrentPreview();
                        setSide("Sell");
                      }}
                    />
                    <span>{copy.sell}</span>
                  </label>
                </div>
              </fieldset>

              <fieldset className="trade-fieldset">
                <legend>{copy.orderType}</legend>
                <div className="trade-choice-grid">
                  <label className={`trade-choice ${orderType === "Market" ? "is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="trade-order-type"
                      value="Market"
                      checked={orderType === "Market"}
                      onChange={() => {
                        invalidateCurrentPreview();
                        setOrderType("Market");
                        clearTicketErrors();
                      }}
                    />
                    <span>{copy.market}</span>
                  </label>
                  <label className={`trade-choice ${orderType === "Limit" ? "is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="trade-order-type"
                      value="Limit"
                      checked={orderType === "Limit"}
                      onChange={() => {
                        invalidateCurrentPreview();
                        setOrderType("Limit");
                        clearTicketErrors();
                      }}
                    />
                    <span>{copy.limit}</span>
                  </label>
                </div>
              </fieldset>

              <label className="trade-field" htmlFor="trade-quantity">
                <span>{copy.quantity}</span>
                <input
                  id="trade-quantity"
                  aria-label={copy.quantity}
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={quantity}
                  aria-invalid={Boolean(errors.quantity)}
                  aria-describedby={errors.quantity ? "trade-quantity-error" : undefined}
                  onChange={(event) => {
                    invalidateCurrentPreview();
                    setQuantity(event.target.value);
                    clearTicketErrors();
                  }}
                />
                {errors.quantity && <small id="trade-quantity-error" className="trade-error" role="alert">{errors.quantity}</small>}
              </label>

              {orderType === "Limit" && (
                <label className="trade-field" htmlFor="trade-limit-price">
                  <span>{copy.limitPrice}</span>
                  <div className="trade-input-with-suffix">
                    <input
                      id="trade-limit-price"
                      aria-label={copy.limitPrice}
                      type="number"
                      min="0.01"
                      step="0.01"
                      inputMode="decimal"
                      value={limitPrice}
                      aria-invalid={Boolean(errors.limitPrice)}
                      aria-describedby={errors.limitPrice ? "trade-limit-price-error" : undefined}
                      onChange={(event) => {
                        invalidateCurrentPreview();
                        setLimitPrice(event.target.value);
                        clearTicketErrors();
                      }}
                    />
                    <span>{quoteCurrency}</span>
                  </div>
                  {errors.limitPrice && <small id="trade-limit-price-error" className="trade-error" role="alert">{errors.limitPrice}</small>}
                </label>
              )}
            </div>

            <aside className="trade-quote-panel" aria-label={quoteHeadingText}>
              <div className="trade-quote-panel__topline">
                <span>{quoteHeadingText}</span>
                <span className="trade-quote-panel__fictional">{badgeText}</span>
              </div>
              <div className="trade-quote-panel__symbol">
                <strong>{symbol}</strong>
                <span>{currentQuote.company}</span>
              </div>
              <div className="trade-quote-panel__price">{formatMoney(currentQuote.price, language, quoteCurrency)}</div>
              <div className={`trade-quote-panel__change ${decimalCompare(currentQuote.changePct, ZERO_PRICE) < 0 ? "is-negative" : ""}`}>
                {decimalCompare(currentQuote.changePct, ZERO_PRICE) >= 0 ? "+" : ""}{decimalToNumber(currentQuote.changePct).toFixed(2)}% {copy.quoteChange}
              </div>
              <dl className="trade-account-facts">
                <div>
                  <dt>{copy.account}</dt>
                  <dd>{demoAccount}</dd>
                </div>
                <div>
                  <dt>{copy.buyingPower}</dt>
                  <dd>{formatMoney(demoBuyingPower, language, quoteCurrency)}</dd>
                </div>
                <div>
                  <dt>{copy.positionRisk}</dt>
                  <dd>{currentQuote.heldShares} {copy.shares}</dd>
                </div>
              </dl>
            </aside>
          </div>

          <div className="trade-card__footer">
            <p className="trade-inline-note">{copy.noConnection}</p>
            <button className="trade-button trade-button--primary" type="submit">{copy.continue}</button>
          </div>
        </form>
      )}

      {step === "safety" && (
        <section className="trade-card" data-testid="trade-safety">
          <div className="trade-card__heading">
            <div>
              <p className="trade-card__kicker">02 / 04</p>
              <h2>{copy.safety}</h2>
            </div>
            <span className="trade-badge trade-badge--quiet">{copy.safetyTitle}</span>
          </div>

          <div className="trade-safety-summary">
            <div>
              <span>{copy.side} · {copy.orderType}</span>
              <strong>{side === "Buy" ? copy.buy : copy.sell} {quantity} {copy.shares} {symbol} · {orderType === "Market" ? copy.market : copy.limit}</strong>
            </div>
            <div>
              <span>{quoteHeadingText}</span>
              <strong>{formatMoney(currentQuote.price, language, quoteCurrency)}</strong>
            </div>
          </div>

          <div className="trade-check-list">
            {safetyChecks.map((check) => (
              <div
                className={`trade-check-row ${check.passed ? "is-passed" : "is-blocked"}`}
                data-testid={`trade-check-${check.key}`}
                data-state={check.passed ? "passed" : "blocked"}
                key={check.key}
              >
                <span className="trade-check-icon" aria-hidden="true">{check.passed ? "✓" : "!"}</span>
                <div><strong>{check.title}</strong><span>{check.detail}</span></div>
                <em>{check.passed ? check.suffix : copy.checkBlocked}</em>
              </div>
            ))}
          </div>

          <div className="trade-callout trade-callout--risk">
            <strong>{copy.noRequestTitle}</strong>
            <p>{copy.noRequestBody}</p>
          </div>

          {orderType === "Market" && (
            <div className="trade-callout trade-callout--info">
              <p>{copy.marketPreviewNote}</p>
            </div>
          )}

          {flowError && <p className="trade-error trade-flow-error" role="alert">{flowError}</p>}

          <div className="trade-card__footer">
            <button className="trade-button trade-button--secondary" type="button" onClick={() => setStep("ticket")}>{copy.back}</button>
            <button className="trade-button trade-button--primary" type="button" onClick={handleSafetyContinue}>{copy.continuePreview}</button>
          </div>
        </section>
      )}

      {step === "preview" && (
        <section className="trade-card" data-testid="trade-preview">
          <div className="trade-card__heading">
            <div>
              <p className="trade-card__kicker">03 / 04</p>
              <h2>{copy.preview}</h2>
            </div>
            <span className="trade-badge">{badgeText}</span>
          </div>

          <p className="trade-section-lede">{copy.previewTitle}</p>
          <div className="trade-natural-summary" data-testid="trade-summary">
            <span>{copy.naturalLanguage}</span>
            <p>
               {side === "Buy" ? copy.buy : copy.sell} {quantity} {copy.shares} {symbol} {orderType === "Market" ? copy.marketAtQuote : `${copy.limitAt} ${preview?.draft.limitPrice ? formatMoney(preview.draft.limitPrice, language, quoteCurrency) : "—"}`}.
            </p>
          </div>

          <dl className="trade-preview-facts">
             <div><dt>{copy.estimatedAmount}</dt><dd>{preview ? formatMoney(preview.estimatedAmount, language, quoteCurrency) : "—"}</dd></div>
             <div><dt>{copy.validity}</dt><dd>{preview ? copy.validityValue : copy.previewFailed}</dd></div>
             <div><dt>{copy.previewId}</dt><dd>{preview?.previewId ?? "—"}</dd></div>
          </dl>

          {orderType === "Market" && <div className="trade-callout trade-callout--info"><p>{copy.marketPreviewNote}</p></div>}

          <label className="trade-acknowledgement">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>{copy.acknowledge}</span>
          </label>

          <div className="trade-card__footer">
            <button className="trade-button trade-button--secondary" type="button" onClick={() => setStep("safety")}>{copy.back}</button>
            <button
              className="trade-button trade-button--primary"
              type="button"
              data-testid="simulate-order"
              disabled={!acknowledged}
              onClick={handleSimulate}
            >
              {copy.simulate}
            </button>
          </div>
        </section>
      )}

      {step === "receipt" && receipt && (
        <section className={`trade-card trade-receipt ${receipt.status === "unknown" ? "trade-receipt--unknown" : ""}`} data-testid="trade-receipt">
          <div className="trade-receipt__mark" aria-hidden="true">{receipt.status === "unknown" ? "!" : "✓"}</div>
          <p className="trade-card__kicker">04 / 04</p>
          <h2>{receipt.status === "unknown" ? copy.unknownReceiptTitle : copy.receiptTitle}</h2>
          <p className="trade-section-lede">{receipt.status === "unknown" ? copy.unknownReceiptBody : copy.receiptBody}</p>
          {receipt.status === "unknown" && <div className="trade-callout trade-callout--risk" role="alert"><p>{copy.unknownReceiptStatus}</p></div>}
          <div className="trade-receipt__highlight">
            <span>{copy.status}</span>
            <strong>{receipt.status === "unknown" ? copy.unknownReceiptStatus : copy.simulated}</strong>
          </div>
          <dl className="trade-preview-facts">
            <div><dt>{copy.symbol}</dt><dd>{symbol}</dd></div>
             <div><dt>{copy.estimatedAmount}</dt><dd>{formatMoney(receipt.estimatedAmount, language, receipt.currency)}</dd></div>
             <div><dt>{copy.receiptId}</dt><dd>{receipt.receiptId}</dd></div>
             <div><dt>{copy.previewId}</dt><dd data-testid="trade-receipt-preview-id">{receipt.previewId}</dd></div>
          </dl>
          <div className="trade-card__footer">
            <button className="trade-button trade-button--secondary" type="button" onClick={handleCreateAnother}>{copy.another}</button>
            <button className="trade-button trade-button--primary" type="button" onClick={onViewOrders}>{copy.viewOrders}</button>
          </div>
        </section>
      )}
    </section>
  );
}
