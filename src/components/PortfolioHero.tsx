import { useState } from "react";
import type { Copy } from "../i18n";
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from "../formatters";
import type { Language, PortfolioMockData } from "../types";
import type { AppRoute } from "../navigation";
import type { BrokerAccountProfile } from "../domain/accounts";
import { ALL_ACCOUNTS_ID } from "../domain/accounts";
import type { BenchmarkSeriesRecord, NavSnapshotRecord } from "../domain/nav";
import { Icon } from "./Icons";
import { PortfolioChart } from "./PortfolioChart";
import { RealNavChart } from "./RealNavChart";

export interface LocalDashboardNavProps {
  accounts: readonly BrokerAccountProfile[];
  selectedAccountId: string;
  onSelectAccount: (accountId: string) => void;
  availableCurrencies: readonly string[];
  activeCurrency: string;
  onSelectCurrency: (currency: string) => void;
  snapshots: readonly NavSnapshotRecord[];
  selectedBenchmark: string | null;
  benchmarkSeries: BenchmarkSeriesRecord | null;
  benchmarkLoading: boolean;
  benchmarkNotice: string | null;
  onSelectBenchmark: (symbol: string | null) => void;
  onRefreshBenchmark: (symbol: string) => void;
}

interface PortfolioHeroProps {
  copy: Copy;
  language: Language;
  data: PortfolioMockData;
  onNavigate: (route: AppRoute) => void;
  onSearch: () => void;
  localNav?: LocalDashboardNavProps;
}

export function PortfolioHero({ copy, language, data, onNavigate, onSearch, localNav }: PortfolioHeroProps) {
  const [valueVisible, setValueVisible] = useState(true);
  const chinese = language === "zh";
  const isLocalMode = data.workspaceMode === "local-csv";
  const isMultiCurrency = Boolean(data.isMultiCurrency);
  const displayCurrency = data.currency && data.currency !== "MULTI" ? data.currency : "USD";
  const activeNavCurrency = localNav?.activeCurrency ?? displayCurrency;
  const selectedAccountName = localNav
    ? (localNav.selectedAccountId === ALL_ACCOUNTS_ID
      ? (chinese ? "全部账户汇总" : "All Accounts")
      : (localNav.accounts.find((a) => a.id === localNav.selectedAccountId)?.name ?? localNav.selectedAccountId))
    : undefined;

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
          <span>{selectedAccountName ? `${data.accountLabel ?? copy.individualBrokerage} · ${selectedAccountName}` : (data.accountLabel ?? copy.individualBrokerage)}</span>
          <span>{data.asOfLabel ?? copy.updatedJustNow}</span>
        </div>

        {isLocalMode && localNav && (
          <div className="hero-local-switchers" data-testid="dashboard-account-currency-bar">
            {localNav.accounts.length > 0 && (
              <label className="hero-switcher-label">
                <span>{chinese ? "账户范围" : "Account"}</span>
                <select
                  data-testid="dashboard-account-switcher"
                  value={localNav.selectedAccountId}
                  onChange={(event) => localNav.onSelectAccount(event.target.value)}
                >
                  <option value={ALL_ACCOUNTS_ID}>
                    {chinese ? `全部账户 (${localNav.accounts.length})` : `All Accounts (${localNav.accounts.length})`}
                  </option>
                  {localNav.accounts.map((acct) => (
                    <option key={acct.id} value={acct.id}>
                      {acct.name} ({acct.baseCurrency})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {localNav.availableCurrencies.length > 1 && (
              <div
                className="hero-currency-tabs"
                role="group"
                aria-label={chinese ? "净值币种桶" : "NAV currency bucket"}
                data-testid="dashboard-currency-tabs"
              >
                {localNav.availableCurrencies.map((curr) => (
                  <button
                    key={curr}
                    type="button"
                    className={curr === activeNavCurrency ? "is-active" : undefined}
                    aria-pressed={curr === activeNavCurrency}
                    data-testid={`dashboard-currency-tab-${curr}`}
                    onClick={() => localNav.onSelectCurrency(curr)}
                  >
                    {curr}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

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
        <RealNavChart
          copy={copy}
          language={language}
          currency={activeNavCurrency}
          accountId={localNav?.selectedAccountId ?? ALL_ACCOUNTS_ID}
          accountLabel={selectedAccountName}
          snapshots={localNav?.snapshots ?? []}
          selectedBenchmark={localNav?.selectedBenchmark ?? null}
          benchmarkSeries={localNav?.benchmarkSeries ?? null}
          benchmarkLoading={localNav?.benchmarkLoading ?? false}
          benchmarkNotice={localNav?.benchmarkNotice ?? null}
          onSelectBenchmark={localNav?.onSelectBenchmark ?? (() => undefined)}
          onRefreshBenchmark={localNav?.onRefreshBenchmark ?? (() => undefined)}
          allTimeChange={data.allTimeChange}
          isMultiCurrency={isMultiCurrency}
          baselineTestId="hero-local-baseline"
        />
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
