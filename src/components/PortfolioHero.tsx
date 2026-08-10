import type { Copy } from "../i18n";
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from "../formatters";
import type { Language, PortfolioMockData } from "../types";
import type { AppRoute } from "../navigation";
import { Icon } from "./Icons";
import { PortfolioChart } from "./PortfolioChart";

interface PortfolioHeroProps {
  copy: Copy;
  language: Language;
  data: PortfolioMockData;
  onNavigate: (route: AppRoute) => void;
  onSearch: () => void;
}

export function PortfolioHero({ copy, language, data, onNavigate, onSearch }: PortfolioHeroProps) {
  return (
    <section className="hero" id="home" aria-labelledby="portfolio-title">
      <div className="hero-summary">
        <div className="eyebrow-row">
          <span id="portfolio-title">{copy.totalPortfolioValue}</span>
          <button className="eye-button" type="button" aria-label={copy.totalPortfolioValue}>
            <Icon name="eye" />
          </button>
        </div>

        <div className="balance-row">
          <strong>{formatCurrency(data.totalValue, language)}</strong>
          <button className="currency-selector" type="button">USD <span>⌄</span></button>
        </div>

        <div className="daily-return">
          <span>{copy.today}</span>
          <strong>{formatSignedCurrency(data.todayChange, language)}</strong>
          <em>{formatSignedPercent(data.todayChangePct, language)}</em>
        </div>

        <div className="account-caption">
          <span>{copy.individualBrokerage}</span>
          <span>{copy.updatedJustNow}</span>
        </div>

        <div className="quick-actions" aria-label={copy.quickActions}>
          <button type="button" onClick={() => onNavigate("trade")} aria-label={`${copy.trade} · ${copy.demoHint}`}>
            <span className="action-icon"><Icon name="trade" /></span>
            <b>{copy.trade}</b>
          </button>
          <button type="button" onClick={onSearch}>
            <span className="action-icon"><Icon name="search" /></span>
            <b>{copy.search}</b>
          </button>
          <button type="button" onClick={() => onNavigate("markets")}>
            <span className="action-icon"><Icon name="watchlist" /></span>
            <b>{copy.watchlist}</b>
          </button>
          <button type="button" onClick={() => onNavigate("orders")}>
            <span className="action-icon"><Icon name="orders" /></span>
            <b>{copy.orders}</b>
          </button>
        </div>
      </div>

      <PortfolioChart
        copy={copy}
        language={language}
        allTimeChange={data.allTimeChange}
        chartSeries={data.portfolioChart}
        interactionHint={copy.portfolioChartHint}
      />
    </section>
  );
}
