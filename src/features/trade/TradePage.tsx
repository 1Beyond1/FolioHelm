import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "../../types";
import { decimalCompare, decimalToNumber, price, quantity as makeQuantity, type Money, type Percent, type Price, type Quantity } from "../../domain/decimal";
import { findMockHolding, findMockQuote, MOCK_BROKER, mockDraftHash } from "../../domain/mockBroker";
import type { BrokerOrder, BrokerSymbol, MockPreview, OrderDraft } from "../../domain/contracts";
import "./TradePage.css";

export type TradeSymbol = BrokerSymbol;
export type TradeSide = "Buy" | "Sell";
export type OrderType = "Market" | "Limit";

export interface TradePageProps {
  language: Language;
  initialSymbol?: string;
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
}

interface DemoReceipt {
  receiptId: string;
  orderId: string;
  draftHash: string;
  estimatedAmount: Money;
}

const SYMBOLS: readonly TradeSymbol[] = ["AAPL", "NVDA", "MSFT", "SPY", "TSLA", "AMD", "AMZN"];

function getTradeQuote(symbol: TradeSymbol): Quote {
  const canonicalQuote = findMockQuote(symbol);
  const canonicalHolding = findMockHolding(symbol);
  return {
    company: canonicalQuote?.companyEn ?? symbol,
    price: canonicalQuote?.price ?? price("0"),
    changePct: canonicalQuote?.changePct ?? ("0" as Percent),
    heldShares: canonicalHolding?.quantity ?? makeQuantity("0"),
  };
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
    positionRisk: "Position / risk limit",
    withinLimit: "Within fictional limit",
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
    viewOrders: "View orders",
    another: "Create another",
    close: "Close",
    invalidQuantity: "Enter a whole-share quantity greater than 0.",
    invalidLimitPrice: "Enter a limit price greater than 0 with at most two decimal places.",
    previewFailed: "The local Mock preview could not be created. Review the ticket and try again.",
    simulationFailed: "The local Mock simulation could not be completed. Do not repeat it until the preview state is reviewed.",
    quoteChange: "today",
  },
  zh: {
    title: "交易工作区",
    eyebrow: "虚构执行流程",
    demoOnly: "仅演示",
    noConnection: "未连接券商 · 任何内容都不会发送",
    ticket: "Ticket",
    safety: "Safety check",
    preview: "Mock preview",
    receipt: "Demo receipt",
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
    continuePreview: "继续到 Mock preview",
    safetyTitle: "检查虚构安全门槛",
    accountMatch: "账户匹配",
    matchedDemo: "已匹配 · 演示账户",
    quoteAge: "报价年龄",
    quoteAgeValue: "12 秒前",
    buyingPowerCheck: "购买力",
    available: "演示中的可用金额",
    positionRisk: "持仓 / 风险限制",
    withinLimit: "在虚构限制内",
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
    viewOrders: "查看订单",
    another: "创建另一个",
    close: "关闭",
    invalidQuantity: "请输入大于 0 的整数数量。",
    invalidLimitPrice: "请输入大于 0 且最多两位小数的限价价格。",
    previewFailed: "本地 Mock 预览创建失败。请检查交易单后再试。",
    simulationFailed: "本地 Mock 模拟未完成。在确认预览状态前不要重复操作。",
    quoteChange: "今日",
  },
} as const;

function isTradeSymbol(value: string | undefined): value is TradeSymbol {
  return value !== undefined && SYMBOLS.includes(value as TradeSymbol);
}

function formatMoney(amount: Money | Price, language: Language): string {
  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(decimalToNumber(amount));
}

const WHOLE_QUANTITY_RE = /^[1-9]\d*$/;
const POSITIVE_PRICE_RE = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;
const ZERO_PRICE = price("0");

export function TradePage({ language, initialSymbol, onClose, onViewOrders }: TradePageProps) {
  const copy = COPY[language];
  const demoSnapshot = MOCK_BROKER.getSnapshot();
  const demoAccount = `Demo brokerage · •••• ${demoSnapshot.account.accountKey.slice(-4)}`;
  const demoBuyingPower = demoSnapshot.account.buyingPower;
  const [step, setStep] = useState<TradeStep>("ticket");
  const [symbol, setSymbol] = useState<TradeSymbol>(() =>
    isTradeSymbol(initialSymbol) ? initialSymbol : "AAPL",
  );
  const [side, setSide] = useState<TradeSide>("Buy");
  const [orderType, setOrderType] = useState<OrderType>("Market");
  const [quantity, setQuantity] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [errors, setErrors] = useState<TicketErrors>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [preview, setPreview] = useState<MockPreview | null>(null);
  const [receipt, setReceipt] = useState<DemoReceipt | null>(null);

  const currentQuote = getTradeQuote(symbol);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function invalidateCurrentPreview(): void {
    if (preview) MOCK_BROKER.invalidatePreview(preview.previewId);
    setPreview(null);
    setAcknowledged(false);
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
      setStep("safety");
    }
  }

  function handleSafetyContinue(): void {
    if (!draft) {
      setErrors({ quantity: copy.previewFailed });
      setStep("ticket");
      return;
    }

    try {
      setPreview(MOCK_BROKER.previewOrder(draft));
      setAcknowledged(false);
      setErrors({});
      setStep("preview");
    } catch {
      setErrors({ quantity: copy.previewFailed });
      setStep("ticket");
    }
  }

  function handleSimulate(): void {
    if (!acknowledged || !preview || !draft) return;

    try {
      const currentDraftHash = mockDraftHash(draft);
      const simulatedOrder: BrokerOrder = MOCK_BROKER.consumePreview(preview.previewId, currentDraftHash);

      setReceipt({
        receiptId: `DEMO-RECEIPT-${simulatedOrder.id}`,
        orderId: simulatedOrder.id,
        draftHash: currentDraftHash,
        estimatedAmount: preview.estimatedAmount,
      });
      setStep("receipt");
    } catch {
      setErrors({ quantity: copy.simulationFailed });
    }
  }

  function handleCreateAnother(): void {
    invalidateCurrentPreview();
    setStep("ticket");
    setQuantity("");
    setLimitPrice("");
    setErrors({});
    setAcknowledged(false);
    setPreview(null);
    setReceipt(null);
  }

  return (
    <section
      className="trade-page"
      data-testid="trade-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-page-title"
    >
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
            <span className="trade-badge">{copy.demoOnly}</span>
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
                  {SYMBOLS.map((option) => (
                    <option key={option} value={option}>
                      {option} · {getTradeQuote(option).company}
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
                    <span>{copy.dollars}</span>
                  </div>
                  {errors.limitPrice && <small id="trade-limit-price-error" className="trade-error" role="alert">{errors.limitPrice}</small>}
                </label>
              )}
            </div>

            <aside className="trade-quote-panel" aria-label={copy.quote}>
              <div className="trade-quote-panel__topline">
                <span>{copy.quote}</span>
                <span className="trade-quote-panel__fictional">{copy.demoOnly}</span>
              </div>
              <div className="trade-quote-panel__symbol">
                <strong>{symbol}</strong>
                <span>{currentQuote.company}</span>
              </div>
              <div className="trade-quote-panel__price">{formatMoney(currentQuote.price, language)}</div>
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
                  <dd>{formatMoney(demoBuyingPower, language)}</dd>
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
              <span>{copy.quote}</span>
              <strong>{formatMoney(currentQuote.price, language)}</strong>
            </div>
          </div>

          <div className="trade-check-list">
            <div className="trade-check-row">
              <span className="trade-check-icon" aria-hidden="true">✓</span>
              <div><strong>{copy.accountMatch}</strong><span>{copy.matchedDemo}</span></div>
              <em>{copy.demoOnly}</em>
            </div>
            <div className="trade-check-row">
              <span className="trade-check-icon" aria-hidden="true">✓</span>
              <div><strong>{copy.quoteAge}</strong><span>{copy.quoteAgeValue}</span></div>
              <em>{copy.quote}</em>
            </div>
            <div className="trade-check-row">
              <span className="trade-check-icon" aria-hidden="true">✓</span>
              <div><strong>{copy.buyingPowerCheck}</strong><span>{copy.available} · {formatMoney(demoBuyingPower, language)}</span></div>
              <em>{copy.dollars}</em>
            </div>
            <div className="trade-check-row">
              <span className="trade-check-icon" aria-hidden="true">✓</span>
              <div><strong>{copy.positionRisk}</strong><span>{copy.withinLimit}</span></div>
              <em>{currentQuote.heldShares} {copy.shares}</em>
            </div>
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
            <span className="trade-badge">{copy.demoOnly}</span>
          </div>

          <p className="trade-section-lede">{copy.previewTitle}</p>
          <div className="trade-natural-summary" data-testid="trade-summary">
            <span>{copy.naturalLanguage}</span>
            <p>
               {side === "Buy" ? copy.buy : copy.sell} {quantity} {copy.shares} {symbol} {orderType === "Market" ? copy.marketAtQuote : `${copy.limitAt} ${preview?.draft.limitPrice ? formatMoney(preview.draft.limitPrice, language) : "—"}`}.
            </p>
          </div>

          <dl className="trade-preview-facts">
             <div><dt>{copy.estimatedAmount}</dt><dd>{preview ? formatMoney(preview.estimatedAmount, language) : "—"}</dd></div>
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
        <section className="trade-card trade-receipt" data-testid="trade-receipt">
          <div className="trade-receipt__mark" aria-hidden="true">✓</div>
          <p className="trade-card__kicker">04 / 04</p>
          <h2>{copy.receiptTitle}</h2>
          <p className="trade-section-lede">{copy.receiptBody}</p>
          <div className="trade-receipt__highlight">
            <span>{copy.status}</span>
            <strong>{copy.simulated}</strong>
          </div>
          <dl className="trade-preview-facts">
            <div><dt>{copy.symbol}</dt><dd>{symbol}</dd></div>
             <div><dt>{copy.estimatedAmount}</dt><dd>{formatMoney(receipt.estimatedAmount, language)}</dd></div>
             <div><dt>{copy.receiptId}</dt><dd>{receipt.receiptId}</dd></div>
             <div><dt>{copy.previewId}</dt><dd>{receipt.draftHash}</dd></div>
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
