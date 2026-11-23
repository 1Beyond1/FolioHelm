import { useEffect, useMemo, useState } from "react";
import type { Language } from "../../types";
import type { TradePrefill } from "../../domain/contracts";
import { decimalToNumber } from "../../domain/decimal";
import { MOCK_BROKER } from "../../domain/mockBroker";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "../../domain/sessionEpoch";
import {
  evaluateWatchlistItem,
  microsToDisplayDecimal,
  WATCHLIST_STORE,
  type EvaluatedWatchlistItem,
  type WatchlistAlertStatus,
  type WatchlistItem,
} from "../../domain/watchlist";
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
  onOpenTrade: (symbol: string, prefill?: TradePrefill) => void;
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
  useEffect(() => {
    const bump = () => setBrokerTick((v) => v + 1);
    const unsubBroker = MOCK_BROKER.subscribe(bump);
    const unsubWatchlist = WATCHLIST_STORE.subscribe(bump);
    return () => {
      unsubBroker();
      unsubWatchlist();
    };
  }, []);

  // v0.2.0: Local encrypted Watchlist & Price Target Alerts state
  const [editingWatchId, setEditingWatchId] = useState<string | null>(null);
  const [watchSymbol, setWatchSymbol] = useState("");
  const [watchCurrency, setWatchCurrency] = useState("USD");
  const [watchBuyTarget, setWatchBuyTarget] = useState("");
  const [watchSellTarget, setWatchSellTarget] = useState("");
  const [watchNote, setWatchNote] = useState("");
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchStatusMsg, setWatchStatusMsg] = useState<string | null>(null);

  const brokerSnapshot = MOCK_BROKER.getSnapshot();
  const watchlistRevision = WATCHLIST_STORE.getRevision();
  const evaluatedWatchlist = useMemo<EvaluatedWatchlistItem[]>(() => {
    return WATCHLIST_STORE.getAll().map((item) => evaluateWatchlistItem(item, brokerSnapshot));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerSnapshot, watchlistRevision]);

  const triggeredAlertCount = evaluatedWatchlist.filter(
    (entry) => entry.status === "buy-triggered" || entry.status === "sell-triggered",
  ).length;

  function resetWatchlistForm() {
    setEditingWatchId(null);
    setWatchSymbol("");
    setWatchCurrency("USD");
    setWatchBuyTarget("");
    setWatchSellTarget("");
    setWatchNote("");
    setWatchError(null);
  }

  function startEditWatchlistItem(item: WatchlistItem) {
    setEditingWatchId(item.id);
    setWatchSymbol(item.symbol);
    setWatchCurrency(item.currency);
    setWatchBuyTarget(microsToDisplayDecimal(item.targetBuyMicros) ?? "");
    setWatchSellTarget(microsToDisplayDecimal(item.targetSellMicros) ?? "");
    setWatchNote(item.note);
    setWatchError(null);
    setWatchStatusMsg(null);
  }

  async function handleSaveWatchlistItem() {
    const epoch = getCurrentLockEpoch();
    setWatchError(null);
    setWatchStatusMsg(null);
    setWatchBusy(true);
    try {
      const saved = await WATCHLIST_STORE.upsert({
        id: editingWatchId ?? undefined,
        symbol: watchSymbol,
        currency: watchCurrency,
        targetBuyDecimal: watchBuyTarget || null,
        targetSellDecimal: watchSellTarget || null,
        note: watchNote,
        enabled: true,
      });
      if (!isCurrentLockEpoch(epoch)) return;
      const wasEditing = editingWatchId !== null;
      resetWatchlistForm();
      setWatchStatusMsg(
        wasEditing
          ? (chinese ? `已更新自选目标价：${saved.symbol} (${saved.currency})。` : `Updated watchlist target for ${saved.symbol} (${saved.currency}).`)
          : (chinese ? `已加密保存至本地自选表：${saved.symbol} (${saved.currency})。` : `Saved ${saved.symbol} (${saved.currency}) to encrypted local watchlist.`),
      );
    } catch (error) {
      if (!isCurrentLockEpoch(epoch)) return;
      setWatchError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentLockEpoch(epoch)) {
        setWatchBusy(false);
      }
    }
  }

  async function handleToggleWatchlistItem(id: string) {
    const epoch = getCurrentLockEpoch();
    setWatchError(null);
    try {
      await WATCHLIST_STORE.toggleEnabled(id);
      if (!isCurrentLockEpoch(epoch)) return;
    } catch (error) {
      if (!isCurrentLockEpoch(epoch)) return;
      setWatchError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleDeleteWatchlistItem(id: string) {
    const epoch = getCurrentLockEpoch();
    setWatchError(null);
    try {
      const deleted = await WATCHLIST_STORE.remove(id);
      if (!isCurrentLockEpoch(epoch)) return;
      if (deleted && editingWatchId === id) {
        resetWatchlistForm();
      }
    } catch (error) {
      if (!isCurrentLockEpoch(epoch)) return;
      setWatchError(error instanceof Error ? error.message : String(error));
    }
  }

  function alertStatusLabel(status: WatchlistAlertStatus): string {
    if (chinese) {
      switch (status) {
        case "buy-triggered":
          return "触达买入目标";
        case "sell-triggered":
          return "触达卖出目标";
        case "watching":
          return "监控中";
        case "disabled":
          return "已暂停";
        case "no-price":
          return "暂无报价";
      }
    }
    switch (status) {
      case "buy-triggered":
        return "Buy target hit";
      case "sell-triggered":
        return "Sell target hit";
      case "watching":
        return "Watching";
      case "disabled":
        return "Paused";
      case "no-price":
        return "No price";
    }
  }

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

  const localSymbolHints = marketSecurities.slice(0, 5).map((s) => s.symbol).join(", ");
  const headerSubtitle = isLocalMode
    ? (chinese ? "浏览本地导入的 CSV 持仓及可选只读延迟公开行情。" : "Review your locally imported CSV holdings and optional delayed public quotes.")
    : copy.subtitle;
  const searchLabelText = isLocalMode
    ? (chinese ? "搜索本地持仓" : "Search local portfolio")
    : copy.searchLabel;
  const searchHintText = isLocalMode
    ? (localSymbolHints
        ? (chinese ? `试试 ${localSymbolHints}` : `Try ${localSymbolHints}`)
        : (chinese ? "输入代码或名称筛选已导入标的" : "Filter your imported holdings by symbol or name"))
    : copy.searchHint;
  const watchlistKickerText = isLocalMode
    ? (chinese ? "本地持仓列表" : "Local portfolio")
    : copy.watchlistKicker;
  const watchlistDescriptionText = isLocalMode
    ? (chinese ? "按导入 CSV 基准价或已开启的只读延迟公开行情展示。" : "Imported holdings priced by CSV baseline or opted-in delayed read-only quotes.")
    : copy.watchlistDescription;
  const moversNoteText = isLocalMode
    ? (chinese ? "基于 CSV 基准价或已开启的延迟公开行情；未开启延迟行情时不虚构日内涨跌幅。" : "Based on CSV baseline or opted-in delayed public quotes; no fabricated intraday moves.")
    : copy.fictionalDataDescription;

  return (
    <main className="markets-page" data-testid="markets-page">
      <header className="markets-heading">
        <div className="markets-heading-copy">
          <span className="markets-kicker">{copy.marketDesk}</span>
          <h1>{copy.title}</h1>
          <p>{headerSubtitle}</p>
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
            <span className="markets-kicker">{searchLabelText}</span>
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
        <p className="markets-search-hint">{searchHintText}</p>
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
              <span className="markets-kicker">{watchlistKickerText}</span>
              <h2 id="markets-watchlist-title">{copy.watchlistTitle}</h2>
              <p>{watchlistDescriptionText}</p>
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
                    <tr key={`${security.symbol}:${security.currency ?? "USD"}`} data-testid={`market-row-${security.symbol}`}>
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
            {movers.length === 0 ? (
              <p className="markets-movers-note" data-testid="markets-movers-empty">
                {isLocalMode
                  ? (chinese ? "当前无日内涨跌数据（可于设置页显式开启公开延迟行情）。" : "No daily movers yet (opt in to delayed public quotes in Settings).")
                  : copy.noResults}
              </p>
            ) : movers.map((security, index) => {
              const isPositive = security.changePct >= 0;
              return (
                <div className="markets-mover-row" key={`${security.symbol}:${security.currency ?? "USD"}`}>
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
          <p className="markets-movers-note">{moversNoteText}</p>
        </aside>
      </div>

      <section
        className="markets-card markets-targets-card"
        data-testid="watchlist-targets-panel"
        aria-labelledby="markets-targets-title"
      >
        <div className="markets-section-heading markets-card-heading">
          <div>
            <span className="markets-kicker">
              {chinese ? "本地加密自选与目标价预警 · 只读提示" : "Encrypted local watchlist & price targets · Read-only"}
            </span>
            <h2 id="markets-targets-title">
              {chinese ? "自选观察表与目标价预警" : "Watchlist & price target alerts"}
            </h2>
            <p>
              {chinese
                ? "添加任意标的及买入/卖出目标价，按同币种本地持仓价或延迟公开行情实时比对；触发后仅高亮只读提示并可一键打开纸上模拟单人工复核，绝不自动下单。"
                : "Configure buy/sell price targets for any symbol in its native currency. Triggered alerts highlight read-only and prefill a manual paper trade ticket — never auto-executing."}
            </p>
          </div>
          <div className="markets-targets-badges">
            <span className="markets-card-count" data-testid="watchlist-item-count">
              {evaluatedWatchlist.length} {chinese ? "项观察" : "watched"}
            </span>
            {triggeredAlertCount > 0 && (
              <span className="markets-alert-count-badge" data-testid="watchlist-triggered-count">
                {chinese ? `${triggeredAlertCount} 项已触达目标价` : `${triggeredAlertCount} target alert(s) hit`}
              </span>
            )}
          </div>
        </div>

        <form
          className="markets-targets-form"
          data-testid="watchlist-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSaveWatchlistItem();
          }}
        >
          <label>
            <span>{chinese ? "标的代码" : "Symbol"}</span>
            <input
              type="text"
              data-testid="watchlist-symbol-input"
              placeholder="e.g. AAPL, 00700.HK"
              value={watchSymbol}
              onChange={(event) => setWatchSymbol(event.target.value)}
            />
          </label>
          <label>
            <span>{chinese ? "币种" : "Currency"}</span>
            <select
              data-testid="watchlist-currency-select"
              value={watchCurrency}
              onChange={(event) => setWatchCurrency(event.target.value)}
            >
              {["USD", "HKD", "CNY", "EUR", "GBP", "SGD"].map((curr) => (
                <option key={curr} value={curr}>{curr}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{chinese ? "买入目标价 (≤)" : "Target buy (≤)"}</span>
            <input
              type="text"
              inputMode="decimal"
              data-testid="watchlist-buy-input"
              placeholder="e.g. 210.00"
              value={watchBuyTarget}
              onChange={(event) => setWatchBuyTarget(event.target.value)}
            />
          </label>
          <label>
            <span>{chinese ? "卖出目标价 (≥)" : "Target sell (≥)"}</span>
            <input
              type="text"
              inputMode="decimal"
              data-testid="watchlist-sell-input"
              placeholder="e.g. 250.00"
              value={watchSellTarget}
              onChange={(event) => setWatchSellTarget(event.target.value)}
            />
          </label>
          <label>
            <span>{chinese ? "备注（可选）" : "Note (optional)"}</span>
            <input
              type="text"
              data-testid="watchlist-note-input"
              placeholder={chinese ? "如 回踩均线关注" : "e.g. Support level watch"}
              value={watchNote}
              onChange={(event) => setWatchNote(event.target.value)}
            />
          </label>
          <div className="markets-targets-form-actions">
            <button
              type="submit"
              className="markets-trade-button markets-targets-submit"
              data-testid="watchlist-submit"
              disabled={watchBusy}
            >
              {editingWatchId
                ? (chinese ? "保存修改" : "Save changes")
                : (chinese ? "添加观察" : "Add target")}
            </button>
            {editingWatchId && (
              <button
                type="button"
                className="markets-secondary-button"
                data-testid="watchlist-cancel-edit"
                onClick={resetWatchlistForm}
              >
                {chinese ? "取消" : "Cancel"}
              </button>
            )}
          </div>
        </form>

        {watchError && (
          <p className="markets-targets-error" role="alert" data-testid="watchlist-error">
            {watchError}
          </p>
        )}
        {watchStatusMsg && (
          <p className="markets-targets-status" role="status" data-testid="watchlist-status">
            {watchStatusMsg}
          </p>
        )}

        <div className="markets-table-wrap">
          <table className="markets-table markets-targets-table" data-testid="watchlist-table">
            <thead>
              <tr>
                <th scope="col">{copy.symbol}</th>
                <th scope="col" className="markets-number-cell">{copy.price}</th>
                <th scope="col" className="markets-number-cell">{chinese ? "买入目标 (≤)" : "Target buy (≤)"}</th>
                <th scope="col" className="markets-number-cell">{chinese ? "卖出目标 (≥)" : "Target sell (≥)"}</th>
                <th scope="col">{chinese ? "预警状态" : "Alert status"}</th>
                <th scope="col">{chinese ? "备注" : "Note"}</th>
                <th scope="col" className="markets-action-cell">{copy.action}</th>
              </tr>
            </thead>
            <tbody>
              {evaluatedWatchlist.map((entry) => {
                const { item } = entry;
                const isHit = entry.status === "buy-triggered" || entry.status === "sell-triggered";
                const suggestedSide = entry.status === "sell-triggered" ? "sell" : "buy";
                const suggestedLimit = entry.status === "sell-triggered"
                  ? (entry.targetSellDecimal ?? entry.currentPrice ?? undefined)
                  : (entry.targetBuyDecimal ?? entry.currentPrice ?? undefined);

                return (
                  <tr
                    key={item.id}
                    className={isHit ? "markets-target-row-hit" : undefined}
                    data-testid={`watchlist-row-${item.symbol}`}
                    data-alert-status={entry.status}
                  >
                    <td>
                      <div className="markets-target-symbol-cell">
                        <button
                          type="button"
                          className="markets-symbol-button"
                          onClick={() => onOpenInstrument(item.symbol)}
                          aria-label={`${copy.openInstrument}: ${item.symbol}`}
                        >
                          <strong>{item.symbol}</strong>
                          <ArrowIcon />
                        </button>
                        <span className="markets-currency-pill">{item.currency}</span>
                      </div>
                    </td>
                    <td className="markets-number-cell markets-price-cell">
                      {entry.currentPrice !== null ? (
                        <div>
                          <div>{formatPrice(decimalToNumber(entry.currentPrice), language, item.currency)}</div>
                          <small className="markets-target-source">
                            {entry.priceSource === "public-delayed"
                              ? (chinese ? "延迟行情" : "Delayed")
                              : entry.priceSource === "holding-baseline"
                                ? (chinese ? "持仓基准" : "Holding")
                                : (chinese ? "演示报价" : "Demo")}
                          </small>
                        </div>
                      ) : "—"}
                    </td>
                    <td className="markets-number-cell">
                      {entry.targetBuyDecimal !== null
                        ? formatPrice(decimalToNumber(entry.targetBuyDecimal), language, item.currency)
                        : "—"}
                    </td>
                    <td className="markets-number-cell">
                      {entry.targetSellDecimal !== null
                        ? formatPrice(decimalToNumber(entry.targetSellDecimal), language, item.currency)
                        : "—"}
                    </td>
                    <td>
                      <span
                        className={`markets-alert-badge markets-alert-badge--${entry.status}`}
                        data-testid={`watchlist-badge-${item.symbol}`}
                      >
                        {alertStatusLabel(entry.status)}
                      </span>
                    </td>
                    <td className="markets-company-cell" title={item.note}>
                      {item.note || "—"}
                    </td>
                    <td className="markets-action-cell">
                      <div className="markets-target-actions">
                        <button
                          type="button"
                          className="markets-trade-button"
                          data-testid={`watchlist-review-trade-${item.symbol}`}
                          onClick={() =>
                            onOpenTrade(item.symbol, {
                              symbol: item.symbol,
                              side: suggestedSide,
                              orderType: suggestedLimit ? "limit" : "market",
                              limitPrice: suggestedLimit,
                              currency: item.currency,
                            })
                          }
                        >
                          {chinese ? "人工复核单" : "Review ticket"}
                        </button>
                        <button
                          type="button"
                          className="markets-secondary-button"
                          data-testid={`watchlist-toggle-${item.symbol}`}
                          onClick={() => void handleToggleWatchlistItem(item.id)}
                        >
                          {item.enabled ? (chinese ? "暂停" : "Pause") : (chinese ? "启用" : "Resume")}
                        </button>
                        <button
                          type="button"
                          className="markets-secondary-button"
                          data-testid={`watchlist-edit-${item.symbol}`}
                          onClick={() => startEditWatchlistItem(item)}
                        >
                          {chinese ? "编辑" : "Edit"}
                        </button>
                        <button
                          type="button"
                          className="markets-secondary-button"
                          data-testid={`watchlist-delete-${item.symbol}`}
                          onClick={() => void handleDeleteWatchlistItem(item.id)}
                        >
                          {chinese ? "删除" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {evaluatedWatchlist.length === 0 && (
                <tr>
                  <td className="markets-empty-cell" colSpan={7} data-testid="watchlist-empty">
                    <strong>{chinese ? "尚未添加自选观察标的" : "No watchlist targets yet"}</strong>
                    <span>
                      {chinese
                        ? "在上方输入代码与买入/卖出目标价，即可在本地加密监控并接收只读价格提醒。"
                        : "Enter any ticker and optional buy/sell target prices above to monitor alerts locally."}
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
