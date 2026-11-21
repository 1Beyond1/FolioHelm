import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Copy } from "../i18n";
import { formatCurrency, formatSignedCurrency } from "../formatters";
import type { Language, PortfolioPeriod } from "../types";

interface PortfolioChartProps {
  copy: Copy;
  language: Language;
  allTimeChange: number;
  chartSeries: Record<PortfolioPeriod, readonly number[]>;
  interactionHint: string;
}

const PORTFOLIO_PERIODS: readonly PortfolioPeriod[] = ["1D", "1W", "1M", "6M", "1Y"];
const CHART_WIDTH = 720;
const CHART_LEFT = 20;
const CHART_RIGHT = 690;
const CHART_TOP = 30;
const CHART_BOTTOM = 205;
const CHART_AREA_BOTTOM = 238;

function resampleSeries(points: readonly number[], targetLength = 36): number[] {
  if (targetLength <= 0 || points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: targetLength }, () => points[0]);

  const lastIndex = points.length - 1;
  return Array.from({ length: targetLength }, (_, index) => {
    const sourcePosition = (index / Math.max(targetLength - 1, 1)) * lastIndex;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, lastIndex);
    const fraction = sourcePosition - leftIndex;
    return points[leftIndex] + (points[rightIndex] - points[leftIndex]) * fraction;
  });
}

function blendSeries(left: readonly number[], right: readonly number[], amount: number): number[] {
  const length = Math.max(left.length, right.length);
  if (length === 0) return [];

  const leftSeries = resampleSeries(left, length);
  const rightSeries = resampleSeries(right, length);
  const normalizedAmount = Math.min(1, Math.max(0, amount));

  return leftSeries.map((value, index) => value + (rightSeries[index] - value) * normalizedAmount);
}

function chartPointY(value: number, min: number, max: number): number {
  const range = max - min || 1;
  return CHART_TOP + ((max - value) / range) * (CHART_BOTTOM - CHART_TOP);
}

function chartLinePath(points: readonly number[], min: number, max: number): string {
  const denominator = Math.max(points.length - 1, 1);

  return points
    .map((point, index) => {
      const x = CHART_LEFT + (index / denominator) * (CHART_RIGHT - CHART_LEFT);
      const y = chartPointY(point, min, max);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function chartAreaPath(linePath: string): string {
  if (!linePath) return "";
  return `${linePath} L ${CHART_RIGHT} ${CHART_AREA_BOTTOM} L ${CHART_LEFT} ${CHART_AREA_BOTTOM} Z`;
}

function chartPointLabel(period: PortfolioPeriod, index: number, total: number, language: Language): string {
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
    const dates = language === "zh" ? ["7 月 10 日", "7 月 17 日", "7 月 24 日", "8 月 1 日", "现在"] : ["Jul 10", "Jul 17", "Jul 24", "Aug 1", "Today"];
    return dates[Math.min(dates.length - 1, Math.round(progress * (dates.length - 1)))];
  }

  if (period === "6M") {
    const months = language === "zh" ? ["3 月", "4 月", "5 月", "6 月", "8 月"] : ["Mar", "Apr", "May", "Jun", "Aug"];
    return months[Math.min(months.length - 1, Math.round(progress * (months.length - 1)))];
  }

  const yearLabels = language === "zh"
    ? ["2025年8月", "2025年11月", "2026年2月", "2026年5月", "2026年8月"]
    : ["Aug '25", "Nov '25", "Feb '26", "May '26", "Aug '26"];
  return yearLabels[Math.min(yearLabels.length - 1, Math.round(progress * (yearLabels.length - 1)))];
}

function chartScaleLabel(value: number): string {
  return value >= 1000 ? `$${Math.round(value / 1000)}k` : `$${value.toFixed(0)}`;
}

export function PortfolioChart({
  copy,
  language,
  allTimeChange,
  chartSeries,
  interactionHint,
}: PortfolioChartProps) {
  const [zoomPosition, setZoomPosition] = useState(2);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const leftPeriodIndex = Math.floor(zoomPosition);
  const rightPeriodIndex = Math.min(leftPeriodIndex + 1, PORTFOLIO_PERIODS.length - 1);
  const periodBlend = zoomPosition - leftPeriodIndex;
  const activePeriodIndex = Math.min(PORTFOLIO_PERIODS.length - 1, Math.max(0, Math.round(zoomPosition)));
  const activePeriod = PORTFOLIO_PERIODS[activePeriodIndex];
  const chartPoints = blendSeries(
    chartSeries[PORTFOLIO_PERIODS[leftPeriodIndex]],
    chartSeries[PORTFOLIO_PERIODS[rightPeriodIndex]],
    periodBlend,
  );
  const min = Math.min(...chartPoints);
  const max = Math.max(...chartPoints);
  const linePath = chartLinePath(chartPoints, min, max);
  const areaPath = chartAreaPath(linePath);
  const lastIndex = Math.max(chartPoints.length - 1, 0);
  const displayIndex = hoverIndex ?? Math.round(lastIndex * 0.67);
  const displayValue = chartPoints[displayIndex] ?? chartPoints[0] ?? 0;
  const displayChange = displayValue - (chartPoints[0] ?? displayValue);
  const displayX = CHART_LEFT + (displayIndex / Math.max(lastIndex, 1)) * (CHART_RIGHT - CHART_LEFT);
  const displayY = chartPointY(displayValue, min, max);
  const tooltipLeft = Math.min(86, Math.max(14, (displayX / CHART_WIDTH) * 100));
  const chartDates = Array.from({ length: 5 }, (_, index) =>
    chartPointLabel(activePeriod, Math.round((index / 4) * lastIndex), chartPoints.length, language),
  );

  function handlePointerMove(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = bounds.width > 0 ? event.clientX - bounds.left : bounds.width === 0 ? bounds.width / 2 : 0;
    const progress = Math.min(1, Math.max(0, relativeX / (bounds.width || 1)));
    setHoverIndex(Math.round(progress * lastIndex));
  }

  useEffect(() => {
    const element = chartWrapRef.current;
    if (!element) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const normalizedDelta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 240 : event.deltaY;
      setZoomPosition((current) => Math.min(PORTFOLIO_PERIODS.length - 1, Math.max(0, current + normalizedDelta / 480)));
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <div className="performance-panel">
      <div className="performance-header">
        <div>
          <span>{copy.portfolioPerformance}</span>
          <strong>{formatSignedCurrency(allTimeChange, language)} <em>{copy.allTime}</em></strong>
        </div>
        <div className="period-switcher" role="group" aria-label={copy.portfolioPerformance}>
          {copy.periods.map((period, index) => (
            <button
              key={period}
              type="button"
              className={activePeriodIndex === index ? "active" : undefined}
              aria-pressed={activePeriodIndex === index}
              onClick={() => setZoomPosition(index)}
            >
              {period}
            </button>
          ))}
        </div>
      </div>

      <div
        className="chart-wrap"
        ref={chartWrapRef}
        aria-label={copy.portfolioPerformance}
        data-testid="portfolio-chart-wrap"
        data-chart-zoom={zoomPosition.toFixed(3)}
      >
        <svg
          className="portfolio-chart"
          data-testid="portfolio-chart"
          viewBox="0 0 720 260"
          role="img"
          aria-label={`${copy.portfolioPerformance}. ${interactionHint}`}
        >
          <defs>
            <pattern id="dotPattern" width="8" height="8" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1.1" fill="#b7ff22" opacity="0.48" />
            </pattern>
            <linearGradient id="fadeDots" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <mask id="fadeMask">
              <rect width="720" height="260" fill="url(#fadeDots)" />
            </mask>
            <filter id="softGlow" x="-30%" y="-60%" width="160%" height="220%">
              <feGaussianBlur stdDeviation="7" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g className="chart-grid">
            <path d="M20 42H690" />
            <path d="M20 100H690" />
            <path d="M20 158H690" />
            <path d="M20 216H690" />
          </g>

          <path className="chart-area" mask="url(#fadeMask)" d={areaPath} fill="url(#dotPattern)" />
          <path className="chart-glow" d={linePath} filter="url(#softGlow)" />
          <path data-testid="portfolio-chart-line" className="chart-line" d={linePath} />

          <g className="chart-focus">
            <line x1={displayX} y1="32" x2={displayX} y2="238" />
            <circle cx={displayX} cy={displayY} r="7" />
          </g>

          <rect
            className="portfolio-chart-hit-area"
            data-testid="portfolio-chart-hit-area"
            x={CHART_LEFT}
            y="20"
            width={CHART_RIGHT - CHART_LEFT}
            height="218"
            fill="transparent"
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverIndex(null)}
          />
        </svg>

        <div className="chart-tooltip" data-testid="portfolio-chart-tooltip" style={{ left: `${tooltipLeft}%` }}>
          <span>{copy.periods[activePeriodIndex]} · {chartPointLabel(activePeriod, displayIndex, chartPoints.length, language)}</span>
          <strong>{formatCurrency(displayValue, language)}</strong>
          <em>{formatSignedCurrency(displayChange, language)}</em>
        </div>

        <span className="chart-interaction-hint">{interactionHint}</span>

        <div className="chart-scale" aria-hidden="true">
          <span>{chartScaleLabel(max)}</span>
          <span>{chartScaleLabel(max - (max - min) / 3)}</span>
          <span>{chartScaleLabel(max - ((max - min) / 3) * 2)}</span>
          <span>{chartScaleLabel(min)}</span>
        </div>
        <div className="chart-dates" aria-hidden="true">
          {chartDates.map((date, index) => <span key={`${activePeriod}-${index}`}>{date}</span>)}
        </div>
      </div>
    </div>
  );
}
