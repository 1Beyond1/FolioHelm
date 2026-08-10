import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Language } from "../../types";
import {
  blendSeries,
  chartAreaPath,
  chartLinePath,
  companyForLanguage,
  formatPrice,
  formatSignedPercent,
  formatSignedPrice,
  getMarketSecurity,
  MARKET_COPY,
  MARKET_PERIODS,
  type MarketPeriod,
} from "./marketsData";
import "./markets.css";

export interface InstrumentPageProps {
  language: Language;
  symbol: string;
  onBack: () => void;
  onOpenTrade: (symbol: string) => void;
}

function BackIcon() {
  return (
    <svg className="instrument-back-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m14.5 5-7 7 7 7M8 12h11" />
    </svg>
  );
}

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 360;
const CHART_VERTICAL_PADDING = CHART_HEIGHT * 0.1;

function chartYForValue(value: number, min: number, max: number): number {
  const range = max - min || 1;
  return CHART_VERTICAL_PADDING + ((max - value) / range) * (CHART_HEIGHT - CHART_VERTICAL_PADDING * 2);
}

function chartPointLabel(period: MarketPeriod, index: number, total: number, language: Language): string {
  const progress = total <= 1 ? 0 : index / (total - 1);

  if (period === "1D") {
    const startMinutes = 9 * 60 + 30;
    const endMinutes = 16 * 60;
    const minutes = Math.round(startMinutes + (endMinutes - startMinutes) * progress);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  if (period === "1W") {
    const days = language === "zh" ? ["周一", "周二", "周三", "周四", "周五"] : ["Mon", "Tue", "Wed", "Thu", "Fri"];
    return days[Math.min(days.length - 1, Math.round(progress * (days.length - 1)))];
  }

  if (period === "1M") {
    return language === "zh" ? `第 ${Math.min(4, Math.floor(progress * 4) + 1)} 周` : `Week ${Math.min(4, Math.floor(progress * 4) + 1)}`;
  }

  if (period === "6M") {
    const months = language === "zh" ? ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月"] : ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
    return months[Math.min(months.length - 1, Math.round(progress * (months.length - 1)))];
  }

  return String(2025 + Math.round(progress));
}

function InstrumentChart({
  points,
  symbol,
  period,
  chartDescription,
  chartInteractionHint,
  language,
}: {
  points: readonly number[];
  symbol: string;
  period: MarketPeriod;
  chartDescription: string;
  chartInteractionHint: string;
  language: Language;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const linePath = chartLinePath(points, CHART_WIDTH, CHART_HEIGHT);
  const areaPath = chartAreaPath(points, CHART_WIDTH, CHART_HEIGHT);
  const lastPoint = points[points.length - 1] ?? 0;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const lastY = chartYForValue(lastPoint, min, max);
  const safePointCount = Math.max(points.length, 1);
  const lastIndex = Math.max(points.length - 1, 0);
  const hoveredPoint = hoverIndex === null ? undefined : points[hoverIndex];
  const hoverX = hoverIndex === null ? CHART_WIDTH : (hoverIndex / Math.max(lastIndex, 1)) * CHART_WIDTH;
  const hoverY = hoveredPoint === undefined ? lastY : chartYForValue(hoveredPoint, min, max);
  const tooltipLeft = Math.min(88, Math.max(12, (hoverX / CHART_WIDTH) * 100));

  function handlePointerMove(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = bounds.width > 0 ? event.clientX - bounds.left : bounds.width === 0 ? CHART_WIDTH / 2 : 0;
    const progress = Math.min(1, Math.max(0, relativeX / (bounds.width || CHART_WIDTH)));
    setHoverIndex(Math.round(progress * lastIndex));
  }

  return (
    <>
      <svg
        className="instrument-chart"
        data-testid="instrument-chart"
        data-chart-period={period}
        viewBox="0 0 1000 360"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${symbol} ${period} ${chartDescription}. ${chartInteractionHint}`}
      >
        <defs>
          <linearGradient id="instrument-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--lime)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--lime)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="instrument-chart-grid" aria-hidden="true">
          <path d="M 0 72 H 1000" />
          <path d="M 0 164 H 1000" />
          <path d="M 0 256 H 1000" />
        </g>
        <path className="instrument-chart-area" d={areaPath} fill="url(#instrument-chart-fill)" />
        <path className="instrument-chart-glow" d={linePath} />
        <path data-testid="instrument-chart-line" className="instrument-chart-line" d={linePath} />
        <line
          className="instrument-chart-marker"
          data-testid="instrument-chart-marker"
          x1={hoveredPoint === undefined ? CHART_WIDTH : hoverX}
          x2={hoveredPoint === undefined ? CHART_WIDTH : hoverX}
          y1="36"
          y2="324"
        />
        <circle
          className="instrument-chart-dot"
          cx={hoveredPoint === undefined ? CHART_WIDTH : hoverX}
          cy={hoveredPoint === undefined ? lastY : hoverY}
          r="6"
        />
        <rect
          className="instrument-chart-hit-area"
          data-testid="instrument-chart-hit-area"
          x="0"
          y="0"
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>
      {hoveredPoint !== undefined && hoverIndex !== null && (
        <div
          className="instrument-chart-tooltip"
          data-testid="instrument-chart-tooltip"
          style={{ left: `${tooltipLeft}%` }}
        >
          <span>
            {period} · {chartPointLabel(period, hoverIndex, safePointCount, language)}
          </span>
          <strong>{formatPrice(hoveredPoint)}</strong>
          <em className={hoveredPoint - (points[0] ?? hoveredPoint) >= 0 ? "positive" : "negative"}>
            {formatSignedPrice(hoveredPoint - (points[0] ?? hoveredPoint))}
          </em>
        </div>
      )}
    </>
  );
}

export function InstrumentPage({ language, symbol, onBack, onOpenTrade }: InstrumentPageProps) {
  const copy = MARKET_COPY[language];
  const security = getMarketSecurity(symbol);
  const [zoomPosition, setZoomPosition] = useState(0);
  const chartFrameRef = useRef<HTMLDivElement>(null);
  const leftPeriodIndex = Math.floor(zoomPosition);
  const rightPeriodIndex = Math.min(leftPeriodIndex + 1, MARKET_PERIODS.length - 1);
  const periodBlend = zoomPosition - leftPeriodIndex;
  const periodIndex = Math.min(MARKET_PERIODS.length - 1, Math.max(0, Math.round(zoomPosition)));
  const period = MARKET_PERIODS[periodIndex];
  const chartPoints = blendSeries(
    security.chart[MARKET_PERIODS[leftPeriodIndex]],
    security.chart[MARKET_PERIODS[rightPeriodIndex]],
    periodBlend,
  );
  const isPositive = security.changePct >= 0;
  const stats = [
    { label: copy.volume, value: security.stats.volume },
    { label: copy.marketCap, value: security.stats.marketCap },
    { label: copy.averageVolume, value: security.stats.averageVolume },
    { label: copy.dayRange, value: security.stats.dayRange },
    { label: copy.yearRange, value: security.stats.yearRange },
    { label: copy.peRatio, value: security.stats.peRatio },
    { label: copy.dividendYield, value: security.stats.dividendYield },
  ];

  useEffect(() => {
    const element = chartFrameRef.current;
    if (!element) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const normalizedDelta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 240 : event.deltaY;
      setZoomPosition((current) => Math.min(MARKET_PERIODS.length - 1, Math.max(0, current + normalizedDelta / 480)));
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <div className="instrument-page" data-testid="instrument-page">
      <button type="button" className="instrument-back-button" data-testid="instrument-back" onClick={onBack}>
        <BackIcon />
        <span>{copy.backToMarkets}</span>
      </button>

      <header className="instrument-heading">
        <div className="instrument-heading-copy">
          <div className="instrument-symbol-row">
            <span className="instrument-symbol">{security.symbol}</span>
            <span className="instrument-demo-chip">{copy.instrumentKicker}</span>
          </div>
          <h1>{companyForLanguage(security, language)}</h1>
          <div className="instrument-price-row">
            <strong>{formatPrice(security.price)}</strong>
            <span className={isPositive ? "markets-positive" : "markets-negative"}>
              {formatSignedPrice(security.change)}
            </span>
            <span className={`instrument-change-pill ${isPositive ? "positive" : "negative"}`}>
              {formatSignedPercent(security.changePct)}
            </span>
            <span className="instrument-today-label">{copy.today}</span>
          </div>
          <div className="instrument-freshness" data-testid="instrument-quote-freshness">
            <span>{copy.quoteFreshness}</span>
            <strong>{copy.quoteFreshnessValue}</strong>
          </div>
        </div>
        <button
          type="button"
          className="instrument-trade-button"
          data-testid="instrument-trade"
          onClick={() => onOpenTrade(security.symbol)}
        >
          <span>{copy.trade}</span>
          <span aria-hidden="true">↗</span>
        </button>
      </header>

      <section className="instrument-chart-card" aria-labelledby="instrument-chart-title">
        <div className="instrument-card-heading">
          <div>
            <span className="markets-kicker">{copy.priceHistoryKicker}</span>
            <h2 id="instrument-chart-title">{copy.priceHistoryTitle}</h2>
            <p>{copy.priceHistoryDescription}</p>
          </div>
          <div className="instrument-period-switcher" role="group" aria-label={copy.priceHistoryTitle}>
            {MARKET_PERIODS.map((option) => (
              <button
                type="button"
                key={option}
                className={period === option ? "active" : ""}
                aria-pressed={period === option}
                data-testid={`instrument-period-${option}`}
                onClick={() => setZoomPosition(MARKET_PERIODS.indexOf(option))}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <div
          className="instrument-chart-frame"
          ref={chartFrameRef}
          data-testid="instrument-chart-frame"
          data-chart-zoom={zoomPosition.toFixed(3)}
        >
          <InstrumentChart
            points={chartPoints}
            symbol={security.symbol}
            period={period}
            chartDescription={copy.chartDescription}
            chartInteractionHint={copy.chartInteractionHint}
            language={language}
          />
          <span className="instrument-chart-hint">{copy.chartInteractionHint}</span>
          <div className="instrument-chart-scale" aria-hidden="true">
            <span>{formatPrice(Math.max(...chartPoints))}</span>
            <span>{formatPrice(Math.min(...chartPoints))}</span>
          </div>
          <div className="instrument-chart-dates" aria-hidden="true">
            <span>{period === "1D" ? "09:30" : period === "1W" ? "Mon" : period === "1M" ? "Week 1" : period === "6M" ? "Jan" : "2025"}</span>
            <span>{period === "1D" ? "Now" : period === "1W" ? "Fri" : period === "1M" ? "Now" : period === "6M" ? "Jun" : "Demo"}</span>
          </div>
        </div>
      </section>

      <div className="instrument-lower-grid">
        <section className="instrument-card instrument-holdings-card" aria-labelledby="instrument-holdings-title">
          <div className="instrument-card-heading compact">
            <div>
              <span className="markets-kicker">{copy.holdingsKicker}</span>
              <h2 id="instrument-holdings-title">{copy.holdingsTitle}</h2>
              <p>{copy.holdingsDescription}</p>
            </div>
          </div>
          <div className="instrument-holding-total">
            <span>{copy.holdingValue}</span>
            <strong>{formatPrice(security.holdingValue)}</strong>
            <em className={security.holdingPnl >= 0 ? "positive" : "negative"}>
              {formatSignedPrice(security.holdingPnl)}
            </em>
          </div>
          <dl className="instrument-holding-metrics">
            <div>
              <dt>{copy.shares}</dt>
              <dd>{security.shares}</dd>
            </div>
            <div>
              <dt>{copy.averageCost}</dt>
              <dd>{formatPrice(security.averageCost)}</dd>
            </div>
            <div>
              <dt>{copy.unrealizedPnl}</dt>
              <dd className={security.holdingPnl >= 0 ? "positive" : "negative"}>{formatSignedPrice(security.holdingPnl)}</dd>
            </div>
          </dl>
        </section>

        <section className="instrument-card instrument-stats-card" aria-labelledby="instrument-stats-title">
          <div className="instrument-card-heading compact">
            <div>
              <span className="markets-kicker">{copy.keyStatsKicker}</span>
              <h2 id="instrument-stats-title">{copy.keyStatsTitle}</h2>
            </div>
          </div>
          <dl className="instrument-stats-grid">
            {stats.map((stat) => (
              <div key={stat.label}>
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="instrument-news-section" aria-labelledby="instrument-news-title">
        <div className="instrument-section-heading">
          <div>
            <span className="markets-kicker">{copy.newsKicker}</span>
            <h2 id="instrument-news-title">{copy.newsTitle}</h2>
          </div>
          <p>{copy.newsDescription}</p>
        </div>
        <div className="instrument-news-grid">
          {security.news.map((story, index) => (
            <article className="instrument-news-card" key={`${security.symbol}-${index}`}>
              <div className="instrument-news-card-topline">
                <span>{language === "zh" ? story.tagZh : story.tagEn}</span>
                <time>{copy.demoContextTime}</time>
              </div>
              <h3>{language === "zh" ? story.titleZh : story.titleEn}</h3>
              <p>{language === "zh" ? story.bodyZh : story.bodyEn}</p>
              <small>{copy.demoContext}</small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
