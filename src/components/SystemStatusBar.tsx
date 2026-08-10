import type { Copy } from "../i18n";

interface SystemStatusBarProps {
  copy: Copy;
}

export function SystemStatusBar({ copy }: SystemStatusBarProps) {
  const chinese = copy.home === "首页";

  return (
    <section className="system-status-bar" aria-label={chinese ? "系统状态" : "System status"}>
      <span><i className="status-dot neutral" />{chinese ? "券商：演示模式" : "Broker: Demo mode"}</span>
      <span><i className="status-dot positive" />{chinese ? "市场：模拟开放" : "Market: Simulated open"}</span>
      <span><i className="status-dot neutral" />{chinese ? "报价：虚构数据" : "Quotes: Fictional data"}</span>
      <span><i className="status-dot locked" />{chinese ? "真实交易：已锁定" : "Live trading: Locked"}</span>
      <strong>{chinese ? "此版本没有券商写入能力" : "This build has no brokerage write capability"}</strong>
    </section>
  );
}
