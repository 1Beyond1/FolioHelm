import type { Copy } from "../i18n";
import type { Language } from "../types";
import type { AppRoute } from "../navigation";
import type { WorkspaceMode } from "../domain/contracts";
import type { DisplayDataStatus } from "./DataStateNotice";
import { primaryRoute } from "../navigation";
import { Icon } from "./Icons";

interface TopBarProps {
  copy: Copy;
  language: Language;
  activeRoute: AppRoute;
  onLanguageChange: (language: Language) => void;
  onNavigate: (route: AppRoute) => void;
  onSearch: () => void;
  onLock?: () => void;
  dataStatus?: DisplayDataStatus | null;
  workspaceMode?: WorkspaceMode;
}

function marketStatusLabel(language: Language, status: DisplayDataStatus | null | undefined, openLabel: string): string {
  if (!status) return openLabel;
  if (language === "zh") {
    return status === "stale" ? "行情快照已过期"
      : status === "offline" ? "行情数据源离线"
        : status === "reauth-required" ? "行情需要重新授权"
          : status === "no-data" ? "暂无行情快照"
            : "行情数据异常";
  }
  return status === "stale" ? "Market snapshot stale"
    : status === "offline" ? "Market source offline"
      : status === "reauth-required" ? "Market reauthorization required"
        : status === "no-data" ? "No market snapshot"
          : "Market data error";
}

export function TopBar({
  copy,
  language,
  activeRoute,
  onLanguageChange,
  onNavigate,
  onSearch,
  onLock,
  dataStatus = null,
  workspaceMode = "mock",
}: TopBarProps) {
  const activePrimaryRoute = primaryRoute(activeRoute);
  const degraded = dataStatus !== null;
  const modeNotice = workspaceMode === "local-csv"
    ? (language === "zh" ? "本地持仓 (CSV + 纸上模拟) · 无真实下单" : "Local Portfolio (CSV + Paper) · No live orders")
    : copy.demoNotice;

  return (
    <header className="topbar">
      <button className="brand brand-button" type="button" aria-label={language === "zh" ? "FolioHelm 首页" : "FolioHelm home"} onClick={() => onNavigate("home")}>
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>FolioHelm</span>
      </button>

      <nav className="primary-nav" aria-label={language === "zh" ? "主导航" : "Primary navigation"}>
        {([
          ["home", copy.home],
          ["markets", copy.markets],
          ["trade", copy.trade],
          ["portfolio", copy.portfolio],
          ["orders", copy.orders],
          ["automation", copy.automation],
        ] as const).map(([route, label]) => (
          <button
            type="button"
            className={`nav-button ${activePrimaryRoute === route ? "active" : ""}`}
            key={route}
            onClick={() => onNavigate(route)}
          >
            <span className="nav-button__label">{label}</span>
          </button>
        ))}
      </nav>

      <button className="search-pill" type="button" aria-label={copy.searchSymbol} onClick={onSearch}>
        <Icon name="search" />
        <span>{copy.searchSymbol}</span>
        <kbd>Ctrl K</kbd>
      </button>

      <div className="topbar-status">
        <span className={`status-cluster ${degraded ? "is-degraded" : ""}`}><i />{marketStatusLabel(language, dataStatus, copy.marketOpen)}</span>
        <span className={`status-cluster demo-status ${workspaceMode === "local-csv" ? "is-local-portfolio" : ""}`} data-testid="demo-status"><i />{modeNotice}</span>
        <button className="account-menu" type="button" onClick={() => onNavigate("portfolio")}>
          {copy.account}
          <Icon name="chevron-down" />
        </button>
        <button
          className="language-toggle"
          type="button"
          data-testid="language-toggle"
          aria-label={`${copy.language}: ${language === "en" ? copy.chinese : copy.english}`}
          title={`${copy.language}: ${language === "en" ? copy.chinese : copy.english}`}
          onClick={() => onLanguageChange(language === "en" ? "zh" : "en")}
        >
          {language === "en" ? "中" : "EN"}
        </button>
        {onLock && (
          <button
            className="icon-button"
            type="button"
            data-testid="topbar-lock-button"
            aria-label={language === "zh" ? "锁定会话" : "Lock session"}
            title={language === "zh" ? "锁定会话" : "Lock session"}
            onClick={onLock}
          >
            <Icon name="lock" />
          </button>
        )}
        <button className={`icon-button ${activeRoute === "settings" ? "active" : ""}`} type="button" aria-label={copy.settings} title={copy.settings} onClick={() => onNavigate("settings")}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
