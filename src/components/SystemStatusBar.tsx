import type { Copy } from "../i18n";
import type { WorkspaceMode } from "../domain/contracts";
import type { DisplayDataStatus } from "./DataStateNotice";

interface SystemStatusBarProps {
  copy: Copy;
  dataStatus?: DisplayDataStatus | null;
  workspaceMode?: WorkspaceMode;
  publicQuotesEnabled?: boolean;
}

export function SystemStatusBar({
  copy,
  dataStatus = null,
  workspaceMode = "mock",
  publicQuotesEnabled = false,
}: SystemStatusBarProps) {
  const chinese = copy.home === "首页";
  const degraded = dataStatus !== null;
  const isLocalPortfolio = workspaceMode === "local-csv";
  const modeLabel = isLocalPortfolio
    ? (chinese ? "模式：本地持仓 (CSV + 纸上模拟)" : "Mode: Local Portfolio (CSV + Paper)")
    : (chinese ? "券商：演示模式" : "Broker: Demo mode");

  const marketLabel = chinese
    ? dataStatus === "stale" ? "市场：快照已过期"
      : dataStatus === "offline" ? "市场：数据源离线"
        : dataStatus === "reauth-required" ? "市场：需要重新授权"
          : dataStatus === "no-data" ? "市场：暂无快照"
            : dataStatus ? "市场：数据异常" : (isLocalPortfolio ? "市场：本地只读账本" : "市场：模拟开放")
    : dataStatus === "stale" ? "Market: Snapshot stale"
      : dataStatus === "offline" ? "Market: Source offline"
        : dataStatus === "reauth-required" ? "Market: Reauthorization required"
          : dataStatus === "no-data" ? "Market: No snapshot"
            : dataStatus ? "Market: Data error" : (isLocalPortfolio ? "Market: Local read-only ledger" : "Market: Simulated open");

  const quoteLabel = chinese
    ? dataStatus === "stale" ? "报价：已过期"
      : dataStatus === "offline" ? "报价：离线"
        : dataStatus === "reauth-required" ? "报价：需要重新授权"
          : dataStatus === "no-data" ? "报价：暂无数据"
            : dataStatus ? "报价：读取失败"
              : publicQuotesEnabled ? "延迟只读公开行情 · 不可用于真实下单"
                : isLocalPortfolio ? "报价：CSV 导入基准价" : "报价：虚构数据"
    : dataStatus === "stale" ? "Quotes: Stale snapshot"
      : dataStatus === "offline" ? "Quotes: Offline"
        : dataStatus === "reauth-required" ? "Quotes: Reauthorization required"
          : dataStatus === "no-data" ? "Quotes: No data"
            : dataStatus ? "Quotes: Read error"
              : publicQuotesEnabled ? "Delayed read-only public quotes · Not for live order execution"
                : isLocalPortfolio ? "Quotes: CSV baseline price" : "Quotes: Fictional data";

  return (
    <section className="system-status-bar" aria-label={chinese ? "系统状态" : "System status"} data-workspace-mode={workspaceMode}>
      <span><i className={`status-dot ${isLocalPortfolio ? "positive" : "neutral"}`} />{modeLabel}</span>
      <span><i className={`status-dot ${degraded ? "warning" : "positive"}`} />{marketLabel}</span>
      <span data-testid="quote-source-status"><i className={`status-dot ${degraded || publicQuotesEnabled ? "warning" : "neutral"}`} />{quoteLabel}</span>
      <span><i className="status-dot locked" />{chinese ? "真实交易：已锁定" : "Live trading: Locked"}</span>
      <strong>{chinese ? "此版本没有券商写入能力" : "This build has no brokerage write capability"}</strong>
    </section>
  );
}
