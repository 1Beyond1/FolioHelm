import type { Copy } from "../i18n";
import type { DisplayDataStatus } from "./DataStateNotice";

interface SystemStatusBarProps {
  copy: Copy;
  dataStatus?: DisplayDataStatus | null;
}

export function SystemStatusBar({ copy, dataStatus = null }: SystemStatusBarProps) {
  const chinese = copy.home === "首页";
  const degraded = dataStatus !== null;
  const marketLabel = chinese
    ? dataStatus === "stale" ? "市场：快照已过期"
      : dataStatus === "offline" ? "市场：数据源离线"
        : dataStatus === "reauth-required" ? "市场：需要重新授权"
          : dataStatus === "no-data" ? "市场：暂无快照"
            : dataStatus ? "市场：数据异常" : "市场：模拟开放"
    : dataStatus === "stale" ? "Market: Snapshot stale"
      : dataStatus === "offline" ? "Market: Source offline"
        : dataStatus === "reauth-required" ? "Market: Reauthorization required"
          : dataStatus === "no-data" ? "Market: No snapshot"
            : dataStatus ? "Market: Data error" : "Market: Simulated open";
  const quoteLabel = chinese
    ? dataStatus === "stale" ? "报价：已过期"
      : dataStatus === "offline" ? "报价：离线"
        : dataStatus === "reauth-required" ? "报价：需要重新授权"
          : dataStatus === "no-data" ? "报价：暂无数据"
            : dataStatus ? "报价：读取失败" : "报价：虚构数据"
    : dataStatus === "stale" ? "Quotes: Stale snapshot"
      : dataStatus === "offline" ? "Quotes: Offline"
        : dataStatus === "reauth-required" ? "Quotes: Reauthorization required"
          : dataStatus === "no-data" ? "Quotes: No data"
            : dataStatus ? "Quotes: Read error" : "Quotes: Fictional data";

  return (
    <section className="system-status-bar" aria-label={chinese ? "系统状态" : "System status"}>
      <span><i className="status-dot neutral" />{chinese ? "券商：演示模式" : "Broker: Demo mode"}</span>
      <span><i className={`status-dot ${degraded ? "warning" : "positive"}`} />{marketLabel}</span>
      <span><i className={`status-dot ${degraded ? "warning" : "neutral"}`} />{quoteLabel}</span>
      <span><i className="status-dot locked" />{chinese ? "真实交易：已锁定" : "Live trading: Locked"}</span>
      <strong>{chinese ? "此版本没有券商写入能力" : "This build has no brokerage write capability"}</strong>
    </section>
  );
}
