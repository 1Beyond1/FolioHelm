import { useEffect, useMemo, useState } from "react";
import type { Language } from "../../types";
import { MOCK_BROKER } from "../../domain/mockBroker";
import {
  chartLinePath,
  companyForLanguage,
  formatPrice,
  formatSignedPercent,
  formatSignedPrice,
  MARKET_COPY,
  MARKET_OVERVIEW,
  getMarketSecurities,
} from "./marketsData";
import "./markets.css";

export interface MarketsPageProps {
  language: Language;
  onOpenInstrument: (symbol: string) => void;
  onOpenTrade: (symbol: string) => void;
}

type MoverMode = "gainers" | "losers";

interface SparklineProps {
  points: readonly number[];
  positive: boolean;
  label: string;
}

function Sparkline({ points, positive, label }: SparklineProps) {
  return (
    <svg
      className="markets-sparkline"
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path
        d={chartLinePath(points, 100, 28)}
        className={positive ? "markets-sparkline-line positive" : "markets-sparkline-line negative"}
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="markets-search-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.7" cy="10.7" r="6.2" />
      <path d="m15.4 15.4 4.2 4.2" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className="markets-arrow-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 17 17 5M8 5h9v9" />
    </svg>
  );
}

export function MarketsPage({ language, onOpenInstrument, onOpenTrade }: MarketsPageProps) {
  const copy = MARKET_COPY[language];
  const chinese = language === "zh";
  const [query, setQuery] = useState("");
  const [moverMode, setMoverMode] = useState<MoverMode>("gainers");
  const [, setBrokerTick] = useState(0);
  useEffect(() => MOCK_BROKER.subscribe(() => setBrokerTick((v) => v + 1)), []);

  const isLocalMode = MOCK_BROKER.getWorkspaceMode() === "local-csv";
  const marketSecurities = getMarketSecurities();
  const degradedStatus = marketSecurities.some((security) => security.status === "offline")
    ? chinese ? { title: "数据源离线", note: "展示最近的本地快照" } : { title: "Data source offline", note: "Showing the latest local snapshot" }
    : marketSecurities.some((security) => security.status === "reauth-required")
      ? chinese ? { title: "需要重新授权", note: "暂不刷新报价" } : { title: "Reauthorization required", note: "Quotes are not being refreshed" }
      : marketSecurities.some((security) => security.status === "stale")
        ? chinese ? { title: "报价已过期", note: "当前页面不是实时行情" } : { title: "Quotes are stale", note: "This page is not live" }
        : isLocalMode
          ? chinese
            ? { title: "本地持仓 · 只读行情", note: "CSV 导入基准价 / 可选公开延迟行情" }
            : { title: "Local Portfolio · Read-only", note: "CSV import baseline / optional delayed public quotes" }
          : { title: copy.marketStatus, note: copy.marketStatusNote };

  const filteredSecurities = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return marketSecurities;

    return marketSecurities.filter((security) =>
      [security.symbol, security.companyEn, security.companyZh]
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [marketSecurities, query]);

  const movers = useMemo(() => {
    const sorted = marketSecurities
      .filter((security) => moverMode === "gainers" ? security.changePct > 0 : security.changePct < 0)
      .sort((left, right) => moverMode === "gainers"
        ? right.changePct - left.changePct
        : left.changePct - right.changePct);

    return sorted.slice(0, 3);
  }, [marketSecurities, moverMode]);

  return (
    <main className="markets-page" data-testid="markets-page">
      <header className="markets-heading">
        <div className="markets-heading-copy">
          <span className="markets-kicker">{copy.marketDesk}</span>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <div className="markets-status" role="status" aria-live="polite">
          <span className="markets-status-dot" aria-hidden="true" />
          <span className="markets-status-copy">
            <strong>{degradedStatus.title}</strong>
            <small>{degradedStatus.note}</small>
          </span>
          <span className="markets-demo-chip">
            {isLocalMode ? (chinese ? "本地 CSV" : "Local CSV") : copy.demo}
          </span>
        </div>
      </header>

      <div className="markets-demo-banner" role="note" data-testid="markets-mode-banner">
        <span className="markets-demo-banner-mark" aria-hidden="true">✦</span>
        {isLocalMode ? (
          <span>
            <strong>{chinese ? "本地持仓 (CSV + 纸上模拟)" : "Local Portfolio (CSV + Paper)"}</strong>{" "}
            {chinese
              ? "展示您本地导入的真实标的与 CSV 基准价（或显式开启的只读公开延迟行情），绝不生成虚构历史走势或假新闻。"
              : "Showing your imported symbols with CSV baseline prices (or opted-in delayed read-only public quotes). No fabricated charts or fake news."}
          </span>
        ) : (
          <span><strong>{copy.fictionalData}</strong>{copy.fictionalDataDescription}</span>
        )}
      </div>

      <section className="markets-search-card" aria-labelledby="markets-search-title">
        <div className="markets-search-heading">
          <div>
            <span className="markets-kicker">{copy.searchLabel}</span>
            <h2 id="markets-search-title">{copy.searchPlaceholder}</h2>
          </div>
          <span className="markets-search-count">{filteredSecurities.length} {copy.results}</span>
        </div>
        <div className="markets-search-field">
          <SearchIcon />
          <input
            id="markets-symbol-search"
            data-testid="markets-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="markets-clear-search" onClick={() => setQuery("")} aria-label={copy.clearSearch}>
              ×
            </button>
          )}
        </div>
        <p className="markets-search-hint">{copy.searchHint}</p>
      </section>

      {!isLocalMode && (
        <section className="markets-overview-section" aria-labelledby="markets-overview-title">
          <div className="markets-section-heading">
            <div>
              <span className="markets-kicker">{copy.marketOverviewKicker}</span>
              <h2 id="markets-overview-title">{copy.marketOverviewTitle}</h2>
            </div>
            <p>{copy.marketOverviewDescription}</p>
          </div>
          <div className="markets-overview-grid">
            {MARKET_OVERVIEW.map((market) => (
              <article className="markets-overview-card" key={market.symbol}>
                <div className="markets-overview-card-topline">
                  <span className="markets-overview-symbol">{market.symbol}</span>
                  <span className={market.changePct >= 0 ? "markets-positive" : "markets-negative"}>
                    {formatSignedPercent(market.changePct)}
                  </span>
                </div>
                <strong className="markets-overview-name">{language === "zh" ? market.labelZh : market.labelEn}</strong>
                <div className="markets-overview-card-bottomline">
                  <span>{market.value}</span>
                  <Sparkline
                    points={market.sparkline}
                    positive={market.changePct >= 0}
                    label={`${market.symbol} ${copy.trend}`}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="markets-main-grid">
        <section className="markets-card markets-watchlist-card" aria-labelledby="markets-watchlist-title">
          <div className="markets-section-heading markets-card-heading">
            <div>
              <span className="markets-kicker">{copy.watchlistKicker}</span>
              <h2 id="markets-watchlist-title">{copy.watchlistTitle}</h2>
              <p>{copy.watchlistDescription}</p>
            </div>
            <span className="markets-card-count">{filteredSecurities.length} {copy.results}</span>
          </div>
          <div className="markets-table-wrap">
            <table className="markets-table">
              <thead>
                <tr>
                  <th scope="col">{copy.symbol}</th>
                  <th scope="col">{copy.company}</th>
                  <th scope="col" className="markets-number-cell">{copy.price}</th>
                  <th scope="col" className="markets-number-cell">{copy.change}</th>
                  <th scope="col" className="markets-number-cell">{copy.changePct}</th>
                  <th scope="col">{copy.trend}</th>
                  <th scope="col" className="markets-action-cell">{copy.action}</th>
                </tr>
              </thead>
              <tbody>
                {filteredSecurities.map((security) => {
                  const isPositive = security.changePct >= 0;
                  return (
                    <tr key={security.symbol} data-testid={`market-row-${security.symbol}`}>
                      <td>
                        <button
                          type="button"
                          className="markets-symbol-button"
                          data-testid={`market-symbol-${security.symbol}`}
                          onClick={() => onOpenInstrument(security.symbol)}
                          aria-label={`${copy.openInstrument}: ${security.symbol}`}
                        >
                          <strong>{security.symbol}</strong>
                          <ArrowIcon />
                        </button>
                      </td>
                      <td className="markets-company-cell" title={companyForLanguage(security, language)}>
                        {companyForLanguage(security, language)}
                      </td>
                      <td className="markets-number-cell markets-price-cell">
                        {formatPrice(security.price, language, security.currency)}
                      </td>
                      <td className={`markets-number-cell ${isPositive ? "markets-positive" : "markets-negative"}`}>
                        {formatSignedPrice(security.change, language, security.currency)}
                      </td>
                      <td className={`markets-number-cell ${isPositive ? "markets-positive" : "markets-negative"}`}>
                        {formatSignedPercent(security.changePct)}
                      </td>
                      <td>
                        {security.hasHistoricalSeries === false || security.sparkline.length === 0 ? (
                          <span className="markets-demo-chip" data-testid={`quote-source-tag-${security.symbol}`}>
                            {security.quoteSource === "public-delayed"
                              ? (chinese ? "延迟行情" : "Delayed")
                              : (chinese ? "CSV 基准" : "CSV base")}
                          </span>
                        ) : (
                          <Sparkline
                            points={security.sparkline}
                            positive={isPositive}
                            label={`${security.symbol} ${copy.trend}`}
                          />
                        )}
                      </td>
                      <td className="markets-action-cell">
                        <button
                          type="button"
                          className="markets-trade-button"
                          data-testid={`trade-${security.symbol}`}
                          onClick={() => onOpenTrade(security.symbol)}
                        >
                          {isLocalMode ? (chinese ? "纸上模拟" : "Paper trade") : copy.trade}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filteredSecurities.length === 0 && (
                  <tr>
                    <td className="markets-empty-cell" colSpan={7}>
                      <strong>{copy.noResults}</strong>
                      <span>{copy.noResultsBody}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="markets-card markets-movers-card" aria-labelledby="markets-movers-title">
          <div className="markets-section-heading markets-card-heading">
            <div>
              <span className="markets-kicker">{copy.topMoversKicker}</span>
              <h2 id="markets-movers-title">{copy.topMoversTitle}</h2>
            </div>
          </div>
          <div className="markets-segmented-control" role="group" aria-label={copy.topMoversTitle}>
            <button
              type="button"
              className={moverMode === "gainers" ? "active" : ""}
              aria-pressed={moverMode === "gainers"}
              data-testid="movers-gainers"
              onClick={() => setMoverMode("gainers")}
            >
              {copy.gainers}
            </button>
            <button
              type="button"
              className={moverMode === "losers" ? "active" : ""}
              aria-pressed={moverMode === "losers"}
              data-testid="movers-losers"
              onClick={() => setMoverMode("losers")}
            >
              {copy.losers}
            </button>
          </div>
          <div className="markets-movers-list">
            {movers.map((security, index) => {
              const isPositive = security.changePct >= 0;
              return (
                <div className="markets-mover-row" key={security.symbol}>
                  <span className="markets-mover-rank">0{index + 1}</span>
                  <button
                    type="button"
                    className="markets-mover-security"
                    onClick={() => onOpenInstrument(security.symbol)}
                    aria-label={`${copy.openInstrument}: ${security.symbol}`}
                  >
                    <strong>{security.symbol}</strong>
                    <small>{companyForLanguage(security, language)}</small>
                  </button>
                  <span className={`markets-mover-change ${isPositive ? "markets-positive" : "markets-negative"}`}>
                    {formatSignedPercent(security.changePct)}
                  </span>
                  <button
                    type="button"
                    className="markets-mover-trade"
                    onClick={() => onOpenTrade(security.symbol)}
                    aria-label={`${copy.trade}: ${security.symbol}`}
                  >
                    +
                  </button>
                </div>
              );
            })}
          </div>
          <p className="markets-movers-note">{copy.fictionalDataDescription}</p>
        </aside>
      </div>
    </main>
  );
}
