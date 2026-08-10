import { useMemo, useState } from "react";
import type { Language } from "../../types";
import { decimalToNumber } from "../../domain/decimal";
import { MOCK_BROKER } from "../../domain/mockBroker";
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
  status: OrderStatus;
  submitted: string;
  timeline: OrderTimelineEvent[];
}

const STATUS_KEYS: OrderStatus[] = ["working", "filled", "canceled", "rejected", "unknown"];

const LEGACY_ORDERS: OrderRecord[] = [
  {
    id: "ORD-1048",
    symbol: "NVDA",
    side: "Buy",
    type: "Limit",
    qty: 12,
    filled: 0,
    limit: 132.5,
    status: "working",
    submitted: "Aug 09 · 09:42",
    timeline: [
      { kind: "draft", timestamp: "09:41:48", detail: "Created from the trade ticket" },
      { kind: "preview", timestamp: "09:41:55", detail: "Estimated cost and buying power checked" },
      { kind: "accepted", timestamp: "09:42:01", detail: "Accepted by the demo venue" },
    ],
  },
  {
    id: "ORD-1044",
    symbol: "AAPL",
    side: "Sell",
    type: "Market",
    qty: 8,
    filled: 8,
    limit: null,
    status: "filled",
    submitted: "Aug 08 · 14:16",
    timeline: [
      { kind: "draft", timestamp: "14:15:12", detail: "Created from the trade ticket" },
      { kind: "preview", timestamp: "14:15:18", detail: "Estimated cost and buying power checked" },
      { kind: "accepted", timestamp: "14:15:24", detail: "Accepted by the demo venue" },
      { kind: "fill", timestamp: "14:16:03", detail: "8 shares filled at $196.20" },
    ],
  },
  {
    id: "ORD-1042",
    symbol: "MSFT",
    side: "Buy",
    type: "Limit",
    qty: 4,
    filled: 4,
    limit: 418,
    status: "filled",
    submitted: "Aug 08 · 11:07",
    timeline: [
      { kind: "draft", timestamp: "11:06:41", detail: "Created from the trade ticket" },
      { kind: "preview", timestamp: "11:06:49", detail: "Estimated cost and buying power checked" },
      { kind: "accepted", timestamp: "11:06:55", detail: "Accepted by the demo venue" },
      { kind: "fill", timestamp: "11:07:22", detail: "4 shares filled at $417.88" },
    ],
  },
  {
    id: "ORD-1039",
    symbol: "TSLA",
    side: "Buy",
    type: "Stop",
    qty: 3,
    filled: 0,
    limit: 344,
    status: "canceled",
    submitted: "Aug 07 · 16:32",
    timeline: [
      { kind: "draft", timestamp: "16:31:08", detail: "Created from the trade ticket" },
      { kind: "preview", timestamp: "16:31:16", detail: "Estimated cost and buying power checked" },
      { kind: "accepted", timestamp: "16:31:24", detail: "Accepted by the demo venue" },
      { kind: "canceled", timestamp: "16:32:10", detail: "Canceled by the account owner" },
    ],
  },
  {
    id: "ORD-1038",
    symbol: "VTI",
    side: "Sell",
    type: "Limit",
    qty: 5,
    filled: 0,
    limit: 281,
    status: "rejected",
    submitted: "Aug 07 · 13:55",
    timeline: [
      { kind: "draft", timestamp: "13:54:27", detail: "Created from the trade ticket" },
      { kind: "preview", timestamp: "13:54:34", detail: "Estimated cost and buying power checked" },
      { kind: "rejected", timestamp: "13:55:02", detail: "Demo venue rejected the order" },
    ],
  },
  {
    id: "ORD-1047",
    symbol: "AMD",
    side: "Buy",
    type: "Limit",
    qty: 6,
    filled: 0,
    limit: 161.4,
    status: "unknown",
    submitted: "Aug 09 · 09:39",
    timeline: [
      { kind: "draft", timestamp: "09:38:12", detail: "Created from the trade ticket" },
      { kind: "preview", timestamp: "09:38:20", detail: "Estimated cost and buying power checked" },
      { kind: "accepted", timestamp: "09:38:31", detail: "Accepted by the demo venue" },
      { kind: "unknown", timestamp: "09:39:04", detail: "Venue acknowledgement is incomplete" },
    ],
  },
];

function readOrders(): OrderRecord[] {
  void LEGACY_ORDERS;
  return MOCK_BROKER.getSnapshot().orders.map((order) => ({
    id: order.id,
    symbol: order.symbol,
    side: order.side === "buy" ? "Buy" : "Sell",
    type: order.type === "market" ? "Market" : "Limit",
    qty: decimalToNumber(order.quantity),
    filled: decimalToNumber(order.filledQuantity),
    limit: order.limitPrice === null ? null : decimalToNumber(order.limitPrice),
    status: order.status,
    submitted: new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(order.submittedAt)).replace(",", " ·"),
    timeline: order.events.map((event) => ({
      kind: event.kind,
      timestamp: new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(event.at)),
      detail: event.detailEn,
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
    eventDetails: {
      draft: "Created from the trade ticket",
      preview: "Estimated cost and buying power checked",
      accepted: "Accepted by the demo venue",
      fill: "Fill confirmed",
      canceled: "Canceled by the account owner",
      rejected: "Demo venue rejected the order",
      unknown: "Venue acknowledgement is incomplete",
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
    eventDetails: {
      draft: "从交易单创建",
      preview: "已检查预计金额和购买力",
      accepted: "模拟交易场所已接受",
      fill: "已确认成交",
      canceled: "账户所有者撤销",
      rejected: "模拟交易场所拒绝了订单",
      unknown: "交易场所确认信息不完整",
    },
    doNotResubmit: "先对账，禁止重下",
  },
} as const;

function formatMoney(value: number, language: Language): string {
  const locale = language === "zh" ? "zh-CN" : "en-US";
  return `$${value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatQuantity(value: number, language: Language): string {
  return value.toLocaleString(language === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 2 });
}

function formatEventDetail(event: OrderTimelineEvent, language: Language): string {
  return COPY[language].eventDetails[event.kind];
}

export function OrdersPage({ language, onOpenTrade }: OrdersPageProps) {
  const copy = COPY[language];
  // Read the canonical local ledger on every render so a newly consumed Mock
  // preview appears immediately after the trade modal closes.
  const orders = readOrders();
  const [activeStatus, setActiveStatus] = useState<OrderStatus>("working");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

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

  return (
    <main className="fh-page fh-orders-page">
      <header className="fh-page-header">
        <div>
          <p className="fh-eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="fh-page-subtitle">{copy.subtitle}</p>
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
                    order={order}
                    expanded={expanded}
                    onToggle={() => setExpandedOrderId(expanded ? null : order.id)}
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
  order,
  expanded,
  onToggle,
}: {
  copy: OrdersCopy;
  language: Language;
  order: OrderRecord;
  expanded: boolean;
  onToggle: () => void;
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
        <td className="fh-number-cell">{order.limit === null ? "—" : formatMoney(order.limit, language)}</td>
        <td>
          <span className={`fh-order-status fh-order-status-${order.status}`}>{statusLabel}</span>
        </td>
        <td className="fh-submitted-cell">{order.submitted}</td>
      </tr>
      {expanded && (
        <tr className="fh-order-detail-row" data-testid={`orders-timeline-${order.id}`}>
          <td colSpan={8}>
            <div className="fh-order-timeline-heading">
              <div>
                <strong>{copy.timeline}</strong>
                <span>{copy.timelineDetail}</span>
              </div>
              {order.status === "unknown" && <span className="fh-timeline-warning">{copy.doNotResubmit}</span>}
            </div>
            <ol className="fh-order-timeline">
              {order.timeline.map((event) => (
                <li key={`${order.id}-${event.kind}-${event.timestamp}`} className={`fh-timeline-event fh-timeline-${event.kind}`}>
                  <span className="fh-timeline-dot" aria-hidden="true" />
                  <div>
                    <div className="fh-timeline-meta">
                      <strong>{copy.eventKinds[event.kind]}</strong>
                      <time>{event.timestamp}</time>
                    </div>
                    <p>{formatEventDetail(event, language)}</p>
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
