import type { Copy } from "../i18n";
import type { Language } from "../types";
import type { AppRoute } from "../navigation";
import { primaryRoute } from "../navigation";
import { Icon } from "./Icons";

interface TopBarProps {
  copy: Copy;
  language: Language;
  activeRoute: AppRoute;
  onLanguageChange: (language: Language) => void;
  onNavigate: (route: AppRoute) => void;
  onSearch: () => void;
}

export function TopBar({ copy, language, activeRoute, onLanguageChange, onNavigate, onSearch }: TopBarProps) {
  const activePrimaryRoute = primaryRoute(activeRoute);

  return (
    <header className="topbar">
      <button className="brand brand-button" type="button" aria-label="FolioHelm home" onClick={() => onNavigate("home")}>
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>FolioHelm</span>
      </button>

      <nav className="primary-nav" aria-label="Primary navigation">
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
        <span className="status-cluster"><i />{copy.marketOpen}</span>
        <span className="status-cluster demo-status" data-testid="demo-status"><i />{copy.demoNotice}</span>
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
        <button className={`icon-button ${activeRoute === "settings" ? "active" : ""}`} type="button" aria-label={copy.settings} title={copy.settings} onClick={() => onNavigate("settings")}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
