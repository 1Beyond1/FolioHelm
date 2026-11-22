import { useState } from "react";
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
  const [valueVisible, setValueVisible] = useState(true);
  const chinese = language === "zh";
  const isLocalMode = data.workspaceMode === "local-csv";
  const isMultiCurrency = Boolean(data.isMultiCurrency);
  const displayCurrency = data.currency && data.currency !== "MULTI" ? data.currency : "USD";

  return (
    <section className="hero" id="home" aria-labelledby="portfolio-title" data-workspace-mode={data.workspaceMode ?? "mock"}>
      <div className="hero-summary">
        <div className="eyebrow-row">
          <span id="portfolio-title">{copy.totalPortfolioValue}</span>
          <button
            className="eye-button"
            type="button"
            aria-label={valueVisible ? copy.hideBalance : copy.showBalance}
            aria-pressed={!valueVisible}
            onClick={() => setValueVisible((visible) => !visible)}
          >
            <Icon name="eye" />
          </button>
        </div>

        <div className="balance-row">
          {isMultiCurrency ? (
            <>
              <strong data-testid="hero-multi-currency-label">
                {valueVisible
                  ? (chinese ? "多币种已分项隔离" : "Multi-currency (isolated)")
                  : "••••••"}
              </strong>
              <span className="currency-selector" aria-label="MULTI">MULTI</span>
            </>
          ) : (
            <>
              <strong>{valueVisible ? formatCurrency(data.totalValue, language, displayCurrency) : "••••••"}</strong>
              <span className="currency-selector" aria-label={displayCurrency}>{displayCurrency}</span>
            </>
          )}
        </div>

        {isMultiCurrency && data.currencySubtotals && data.currencySubtotals.length > 0 ? (
          <div className="hero-currency-subtotals" data-testid="hero-currency-subtotals">
            {data.currencySubtotals.map((item) => (
              <span key={item.currency} className="hero-currency-chip">
                <strong>{item.currency}</strong>{" "}
                {valueVisible ? formatCurrency(item.totalEquity, language, item.currency) : "••••"}
              </span>
            ))}
          </div>
        ) : (
          <div className="daily-return">
            <span>{copy.today}</span>
            <strong>{formatSignedCurrency(data.todayChange, language, displayCurrency)}</strong>
            <em>{formatSignedPercent(data.todayChangePct, language)}</em>
          </div>
        )}

        <div className="account-caption" data-testid="hero-account-caption">
          <span>{data.accountLabel ?? copy.individualBrokerage}</span>
          <span>{data.asOfLabel ?? copy.updatedJustNow}</span>
        </div>

        <div className="quick-actions" aria-label={copy.quickActions}>
          <button
            type="button"
            onClick={() => onNavigate("trade")}
            aria-label={`${copy.trade} · ${isLocalMode ? (chinese ? "本地纸上模拟" : "Local paper rehearsal") : copy.demoHint}`}
          >
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

      {isLocalMode ? (
        <div className="hero-local-baseline" data-testid="hero-local-baseline">
          <p className="hero-local-kicker">
            {chinese ? "本地持仓模式 (CSV + 纸上模拟)" : "Local Portfolio (CSV + Paper)"}
          </p>
          <h2>
            {isMultiCurrency
              ? (chinese ? "按币种隔离净值 · 无跨币种混加" : "Currency-isolated baselines · No FX blending")
              : (chinese ? "仅展示导入基准净值 · 不虚构历史曲线" : "Baseline equity only · No fabricated history curve")}
          </h2>
          <p>
            {chinese
              ? "当前展示的净值与未实现盈亏全部基于您本地导入的 CSV 持仓与可选只读延迟行情计算，绝不套用虚构演示走势。"
              : "Equity and P&L reflect your locally imported CSV snapshot and optional read-only delayed quotes. No fictional historical curve is generated."}
          </p>
          {!isMultiCurrency && (
            <div className="hero-local-stat">
              <span>{copy.allTime}</span>
              <strong>{formatSignedCurrency(data.allTimeChange, language, displayCurrency)}</strong>
            </div>
          )}
        </div>
      ) : (
        <PortfolioChart
          copy={copy}
          language={language}
          allTimeChange={data.allTimeChange}
          chartSeries={data.portfolioChart}
          interactionHint={copy.portfolioChartHint}
        />
      )}
    </section>
  );
}
