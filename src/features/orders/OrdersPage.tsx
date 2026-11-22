import { useEffect, useMemo, useState } from "react";
import type { Language } from "../../types";
import { decimalToNumber } from "../../domain/decimal";
import { appendEvidence } from "../../domain/evidenceJournal";
import { MOCK_BROKER, MockBrokerError } from "../../domain/mockBroker";
import { persistPaperOrder } from "../../domain/vaultStorage";
import { formatCurrency } from "../../formatters";
import "./orders.css";

export interface OrdersPageProps {
  language: Language;
  onOpenTrade: (symbol?: string) => void;
}

export type OrderStatus = "working" | "filled" | "canceled" | "rejected" | "unknown";

type OrderSide = "Buy" | "Sell";
type OrderType = "Limit" | "Market" | "Stop";
type TimelineKind = "draft" | "preview" | "accepted" | "fill" | "canceled" | "rejected" | "unknown";

export interface OrderTimelineEvent {
  kind: TimelineKind;
  timestamp: string;
  detail: string;
}

export interface OrderRecord {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  filled: number;
  limit: number | null;
  currency: string;
  status: OrderStatus;
  submitted: string;
  timeline: OrderTimelineEvent[];
}

const STATUS_KEYS: OrderStatus[] = ["working", "filled", "canceled", "rejected", "unknown"];

function readOrders(language: Language): OrderRecord[] {
  const locale = language === "zh" ? "zh-CN" : "en-US";
  const snapshot = MOCK_BROKER.getSnapshot();
  const currencyBySymbol = new Map(snapshot.quotes.map((q) => [q.symbol, q.currency ?? "USD"]));
  return snapshot.orders.map((order) => ({
    id: order.id,
    symbol: order.symbol,
    side: order.side === "buy" ? "Buy" : "Sell",
    type: order.type === "market" ? "Market" : "Limit",
    qty: decimalToNumber(order.quantity),
    filled: decimalToNumber(order.filledQuantity),
    limit: order.limitPrice === null ? null : decimalToNumber(order.limitPrice),
    currency: currencyBySymbol.get(order.symbol) ?? "USD",
    status: order.status,
    submitted: new Intl.DateTimeFormat(locale, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(order.submittedAt)).replace(",", " ·"),
    timeline: order.events.map((event) => ({
      kind: event.kind,
      timestamp: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(event.at)),
      detail: language === "zh" ? event.detailZh : event.detailEn,
    })),
  }));
}

const COPY = {
  en: {
    eyebrow: "Execution ledger",
    title: "Orders",
    subtitle: "Every intent, acknowledgement, and fill in one place.",
    newOrder: "New order",
    search: "Search symbol",
    searchPlaceholder: "e.g. NVDA",
    symbol: "Symbol",
    sideValues: { Buy: "Buy", Sell: "Sell" },
    typeValues: { Limit: "Limit", Market: "Market", Stop: "Stop" },
    tabs: {
      working: "Working",
      filled: "Filled",
      canceled: "Canceled",
      rejected: "Rejected",
      unknown: "Unknown",
    },
    side: "Side",
    type: "Type",
    qty: "Qty",
    filled: "Filled",
    limit: "Limit",
    status: "Status",
    submitted: "Submitted",
    expand: "Expand order",
    collapse: "Collapse order",
    timeline: "Order timeline",
    timelineDetail: "Mock event history",
    empty: "No orders match this view.",
    unknownTitle: "Unknown order state",
    unknownBody: "Do not resubmit — reconcile the broker ledger before taking any action.",
    unknownTag: "Review required",
    reconcile: "Reconcile",
    reconcileSuccess: (orderId: string, status: string) => `Reconciled ${orderId}: status updated to ${status}.`,
    reconcileFailed: (orderId: string) => `Reconciliation failed for ${orderId}. Keep the order locked and do not resubmit.`,
    statuses: {
      working: "Working",
      filled: "Filled",
      canceled: "Canceled",
      rejected: "Rejected",
      unknown: "Unknown",
    },
    eventKinds: {
      draft: "Draft",
      preview: "Preview",
      accepted: "Accepted",
      fill: "Fill",
      canceled: "Canceled",
      rejected: "Rejected",
      unknown: "Status unknown",
    },
    doNotResubmit: "Do not resubmit",
  },
  zh: {
    eyebrow: "执行账本",
    title: "订单",
    subtitle: "在同一处查看每次意图、确认和成交。",
    newOrder: "新建订单",
    search: "搜索代码",
    searchPlaceholder: "例如 NVDA",
    symbol: "代码",
    sideValues: { Buy: "买入", Sell: "卖出" },
    typeValues: { Limit: "限价", Market: "市价", Stop: "止损" },
    tabs: {
      working: "工作中",
      filled: "已成交",
      canceled: "已撤销",
      rejected: "已拒绝",
      unknown: "未知",
    },
    side: "方向",
    type: "类型",
    qty: "数量",
    filled: "已成交",
    limit: "限价",
    status: "状态",
    submitted: "提交时间",
    expand: "展开订单",
    collapse: "收起订单",
    timeline: "订单时间线",
    timelineDetail: "模拟事件历史",
    empty: "当前视图没有匹配的订单。",
    unknownTitle: "未知订单状态",
    unknownBody: "先对账，禁止重下。请先核对券商账本，再采取任何操作。",
    unknownTag: "需要复核",
    reconcile: "对账",
    reconcileSuccess: (orderId: string, status: string) => `已完成 ${orderId} 对账：状态已更新为「${status}」。`,
    reconcileFailed: (orderId: string) => `${orderId} 对账失败，请保持该订单锁定并禁止重下。`,
    statuses: {
      working: "工作中",
      filled: "已成交",
      canceled: "已撤销",
      rejected: "已拒绝",
      unknown: "未知",
    },
    eventKinds: {
      draft: "草稿",
      preview: "预览",
      accepted: "已接受",
      fill: "成交",
      canceled: "已撤销",
      rejected: "已拒绝",
      unknown: "状态未知",
    },
    doNotResubmit: "先对账，禁止重下",
  },
} as const;

function formatQuantity(value: number, language: Language): string {
  return value.toLocaleString(language === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 2 });
}

interface ReconcileFeedback {
  kind: "success" | "error";
  message: string;
}

export function OrdersPage({ language, onOpenTrade }: OrdersPageProps) {
  const copy = COPY[language];
  const [, setBrokerRevision] = useState(0);
  const [activeStatus, setActiveStatus] = useState<OrderStatus>("working");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [reconcileFeedback, setReconcileFeedback] = useState<ReconcileFeedback | null>(null);

  useEffect(() => {
    return MOCK_BROKER.subscribe(() => setBrokerRevision((current) => current + 1));
  }, []);

  // Read the canonical local ledger on every render so a newly consumed Mock
  // preview or reconciled order appears immediately.
  const workspaceMode = MOCK_BROKER.getWorkspaceMode();
  const isLocalMode = workspaceMode === "local-csv";
  const orders = readOrders(language);

  const statusCounts = useMemo(() => {
    return orders.reduce<Record<OrderStatus, number>>(
      (counts, order) => {
        counts[order.status] += 1;
        return counts;
      },
      { working: 0, filled: 0, canceled: 0, rejected: 0, unknown: 0 },
    );
  }, [orders]);

  const visibleOrders = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return orders.filter((order) => {
      const matchesStatus = order.status === activeStatus;
      const matchesSearch = normalizedQuery.length === 0 || order.symbol.toLowerCase().includes(normalizedQuery);
      return matchesStatus && matchesSearch;
    });
  }, [activeStatus, orders, searchQuery]);

  function selectStatus(status: OrderStatus) {
    setActiveStatus(status);
    setExpandedOrderId(null);
  }

  function handleReconcile(orderId: string, symbol: string): void {
    try {
      const reconciled = MOCK_BROKER.reconcileOrder(orderId);
      void persistPaperOrder(workspaceMode, reconciled);
      setReconcileFeedback({
        kind: "success",
        message: copy.reconcileSuccess(reconciled.id, copy.statuses[reconciled.status]),
      });
      if (expandedOrderId === orderId && reconciled.status !== activeStatus) {
        setExpandedOrderId(null);
      }
      void appendEvidence("reconciliation", {
        mode: workspaceMode,
        orderId: reconciled.id,
        symbol: reconciled.symbol,
        previousStatus: "unknown",
        nextStatus: reconciled.status,
      }).catch(() => undefined);
    } catch (error) {
      setReconcileFeedback({
        kind: "error",
        message: copy.reconcileFailed(orderId),
      });
      void appendEvidence("reconciliation", {
        mode: workspaceMode,
        orderId,
        symbol,
        previousStatus: "unknown",
        outcome: "failed",
        reason: error instanceof MockBrokerError ? error.code : "reconciliation_failed",
      }).catch(() => undefined);
    }
  }

  return (
    <main className="fh-page fh-orders-page" data-testid="orders-page" data-workspace-mode={workspaceMode}>
      <header className="fh-page-header">
        <div>
          <p className="fh-eyebrow">
            {isLocalMode
              ? (language === "zh" ? "本地纸上模拟账本 (CSV + 纸上模拟)" : "Local paper ledger (CSV + Paper)")
              : copy.eyebrow}
          </p>
          <h1>{copy.title}</h1>
          <p className="fh-page-subtitle">
            {isLocalMode
              ? (language === "zh" ? "本地加密保存的纸上模拟订单，仅用于演练，不连接真实券商。" : "Encrypted local paper-trading orders isolated from Mock Demo. No live brokerage requests exist.")
              : copy.subtitle}
          </p>
        </div>
        <button
          type="button"
          className="fh-new-order-button"
          data-testid="orders-new-order"
          onClick={() => onOpenTrade()}
        >
          <span aria-hidden="true">+</span>
          {copy.newOrder}
        </button>
      </header>

      <section className="fh-orders-toolbar" aria-label={copy.title}>
        <div className="fh-order-tabs" role="tablist" aria-label={copy.status}>
          {STATUS_KEYS.map((status) => {
            const isActive = activeStatus === status;
            return (
              <button
                key={status}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="fh-orders-table-panel"
                className={`fh-order-tab ${isActive ? "is-active" : ""}`}
                data-testid={`orders-tab-${status}`}
                onClick={() => selectStatus(status)}
              >
                <span>{copy.tabs[status]}</span>
                <span className="fh-tab-count" data-testid={`orders-count-${status}`}>
                  {statusCounts[status]}
                </span>
              </button>
            );
          })}
        </div>
        <label className="fh-order-search">
          <span>{copy.search}</span>
          <input
            type="search"
            aria-label={copy.search}
            placeholder={copy.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>
      </section>

      {reconcileFeedback && (
        <aside
          className={`fh-reconcile-feedback fh-reconcile-feedback--${reconcileFeedback.kind}`}
          data-testid="orders-reconcile-feedback"
          role={reconcileFeedback.kind === "error" ? "alert" : "status"}
        >
          {reconcileFeedback.message}
        </aside>
      )}

      {activeStatus === "unknown" && (
        <aside className="fh-unknown-warning" data-testid="orders-unknown-warning" role="alert">
          <span className="fh-unknown-icon">!</span>
          <div>
            <strong>{copy.unknownTitle}</strong>
            <p>{copy.unknownBody}</p>
          </div>
          <span className="fh-unknown-tag">{copy.unknownTag}</span>
        </aside>
      )}

      <section
        className="fh-panel fh-orders-panel"
        id="fh-orders-table-panel"
        role="tabpanel"
        aria-label={copy.tabs[activeStatus]}
      >
        <div className="fh-orders-panel-heading">
          <div>
            <h2>{copy.tabs[activeStatus]}</h2>
            <p>{visibleOrders.length} {language === "zh" ? "笔订单" : visibleOrders.length === 1 ? "order" : "orders"}</p>
          </div>
          {activeStatus === "unknown" && <span className="fh-orders-neutral-label">{copy.doNotResubmit}</span>}
        </div>
        <div className="fh-table-scroll">
          <table className="fh-orders-table" data-testid="orders-table">
            <thead>
              <tr>
                <th scope="col">{copy.symbol}</th>
                <th scope="col">{copy.side}</th>
                <th scope="col">{copy.type}</th>
                <th scope="col" className="fh-number-cell">{copy.qty}</th>
                <th scope="col" className="fh-number-cell">{copy.filled}</th>
                <th scope="col" className="fh-number-cell">{copy.limit}</th>
                <th scope="col">{copy.status}</th>
                <th scope="col">{copy.submitted}</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const expanded = expandedOrderId === order.id;
                return (
                  <OrderRows
                    key={order.id}
                    copy={copy}
                    language={language}
                    isLocalMode={isLocalMode}
                    order={order}
                    expanded={expanded}
                    onToggle={() => setExpandedOrderId(expanded ? null : order.id)}
                    onReconcile={() => handleReconcile(order.id, order.symbol)}
                  />
                );
              })}
              {visibleOrders.length === 0 && (
                <tr className="fh-empty-row">
                  <td colSpan={8}>{copy.empty}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

type OrdersCopy = (typeof COPY)[Language];

function OrderRows({
  copy,
  language,
  isLocalMode,
  order,
  expanded,
  onToggle,
  onReconcile,
}: {
  copy: OrdersCopy;
  language: Language;
  isLocalMode: boolean;
  order: OrderRecord;
  expanded: boolean;
  onToggle: () => void;
  onReconcile: () => void;
}) {
  const statusLabel = copy.statuses[order.status];
  return (
    <>
      <tr
        className={`fh-order-row ${expanded ? "is-expanded" : ""}`}
        data-testid={`orders-row-${order.id}`}
        data-order-status={order.status}
        onClick={onToggle}
      >
        <th scope="row">
          <button
            type="button"
            className="fh-expand-button"
            aria-label={`${expanded ? copy.collapse : copy.expand}: ${order.symbol}`}
            aria-expanded={expanded}
            data-testid={`orders-expand-${order.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
          <span className="fh-order-symbol">{order.symbol}</span>
          <span className="fh-order-id">{order.id}</span>
        </th>
        <td>
          <span className={`fh-side-badge fh-side-${order.side.toLowerCase()}`}>{copy.sideValues[order.side]}</span>
        </td>
        <td>{copy.typeValues[order.type]}</td>
        <td className="fh-number-cell">{formatQuantity(order.qty, language)}</td>
        <td className="fh-number-cell">
          <span>{formatQuantity(order.filled, language)}</span>
          <span className="fh-filled-total">/ {formatQuantity(order.qty, language)}</span>
        </td>
        <td className="fh-number-cell">{order.limit === null ? "—" : formatCurrency(order.limit, language, order.currency)}</td>
        <td>
          <span className="fh-status-cell-group">
            <span className={`fh-order-status fh-order-status-${order.status}`}>{statusLabel}</span>
            {order.status === "unknown" && (
              <button
                type="button"
                className="fh-reconcile-button"
                data-testid={`orders-reconcile-${order.id}`}
                aria-label={`${copy.reconcile} ${order.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onReconcile();
                }}
              >
                {copy.reconcile}
              </button>
            )}
          </span>
        </td>
        <td className="fh-submitted-cell">{order.submitted}</td>
      </tr>
      {expanded && (
        <tr className="fh-order-detail-row" data-testid={`orders-timeline-${order.id}`}>
          <td colSpan={8}>
            <div className="fh-order-timeline-heading">
              <div>
                <strong>{copy.timeline}</strong>
                <span>
                  {isLocalMode
                    ? (language === "zh" ? "本地纸上模拟事件历史" : "Local paper event history")
                    : copy.timelineDetail}
                </span>
              </div>
              {order.status === "unknown" && (
                <div className="fh-timeline-actions">
                  <span className="fh-timeline-warning">{copy.doNotResubmit}</span>
                  <button
                    type="button"
                    className="fh-reconcile-button"
                    data-testid={`orders-timeline-reconcile-${order.id}`}
                    onClick={onReconcile}
                  >
                    {copy.reconcile}
                  </button>
                </div>
              )}
            </div>
            <ol className="fh-order-timeline">
              {order.timeline.map((event, index) => (
                <li key={`${order.id}-${event.kind}-${event.timestamp}-${index}`} className={`fh-timeline-event fh-timeline-${event.kind}`}>
                  <span className="fh-timeline-dot" aria-hidden="true" />
                  <div>
                    <div className="fh-timeline-meta">
                      <strong>{copy.eventKinds[event.kind]}</strong>
                      <time>{event.timestamp}</time>
                    </div>
                    <p>{event.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

export default OrdersPage;
