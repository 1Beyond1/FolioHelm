import type { DataStatus } from "../domain/contracts";
import type { Language } from "../types";

export type DisplayDataStatus = Exclude<DataStatus, "available"> | "loading";

interface DataStateNoticeProps {
  language: Language;
  status: DisplayDataStatus;
  compact?: boolean;
}

const COPY: Record<Language, Record<DisplayDataStatus, { title: string; body: string }>> = {
  en: {
    loading: {
      title: "Loading data",
      body: "Waiting for the local data adapter. No order or broker write is being attempted.",
    },
    "no-data": {
      title: "Nothing here yet",
      body: "This can be a valid empty state. No placeholder holding or order has been invented.",
    },
    stale: {
      title: "Snapshot is stale",
      body: "Values are kept for context only and must not be treated as a live quote.",
    },
    error: {
      title: "Data could not be read",
      body: "The view stopped safely. No broker action was sent or retried.",
    },
    offline: {
      title: "Data source is offline",
      body: "The latest local snapshot is shown where available. It is not live market data.",
    },
    "reauth-required": {
      title: "Authorization would be required",
      body: "Live brokerage access remains disabled in this build; no sign-in attempt was made.",
    },
  },
  zh: {
    loading: {
      title: "正在加载数据",
      body: "正在等待本地数据适配器；没有尝试提交订单或写入券商。",
    },
    "no-data": {
      title: "这里暂时没有内容",
      body: "这可能是正常的空状态；应用不会凭空伪造持仓或订单。",
    },
    stale: {
      title: "快照已经过期",
      body: "数值只保留作上下文参考，不能当作实时行情。",
    },
    error: {
      title: "数据读取失败",
      body: "当前视图已安全停止；没有发送或重试任何券商操作。",
    },
    offline: {
      title: "数据源处于离线状态",
      body: "如有可用内容，页面会展示最近的本地快照；它不是实时行情。",
    },
    "reauth-required": {
      title: "需要重新授权",
      body: "本版本仍禁用真实券商访问，也没有发起任何登录请求。",
    },
  },
};

export function DataStateNotice({ language, status, compact = false }: DataStateNoticeProps) {
  const copy = COPY[language][status];
  const urgent = status === "error" || status === "offline" || status === "reauth-required";

  return (
    <section
      className={`data-state-notice data-state-notice--${status} ${compact ? "is-compact" : ""}`}
      data-testid={`data-state-${status}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <span className="data-state-notice__mark" aria-hidden="true" />
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
      </div>
    </section>
  );
}

