import { useMemo, useState, type PointerEvent } from "react";
import type { Copy } from "../i18n";
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from "../formatters";
import type { Language } from "../types";
import {
  allowedBenchmarksForCurrency,
  computeBenchmarkTwrSeries,
  computeTwrSeries,
  filterNavSnapshotsByPeriod,
  microsToDecimal,
  parseMicrosString,
  type BenchmarkSeriesRecord,
  type BenchmarkTwrSeriesResult,
  type NavChartPeriod,
  type NavSnapshotRecord,
} from "../domain/nav";

export interface RealNavChartProps {
  copy: Copy;
  language: Language;
  currency: string;
  accountId: string;
  accountLabel?: string;
  /** Chronologically ordered snapshots already isolated to `currency` & `accountId`. */
  snapshots: readonly NavSnapshotRecord[];
  selectedBenchmark: string | null;
  benchmarkSeries: BenchmarkSeriesRecord | null;
  benchmarkLoading?: boolean;
  benchmarkNotice?: string | null;
  onSelectBenchmark: (symbol: string | null) => void;
  onRefreshBenchmark: (symbol: string) => void;
  allTimeChange?: number;
  isMultiCurrency?: boolean;
  baselineTestId?: string;
  compact?: boolean;
}

const PERIODS: readonly NavChartPeriod[] = ["1W", "1M", "6M", "1Y", "ALL"];
const SVG_W = 680;
const SVG_H = 220;
const PAD_L = 18;
const PAD_R = 648;
const PAD_T = 22;
const PAD_B = 182;

function toSvgY(val: number, min: number, max: number): number {
  const span = max - min || 1;
  return PAD_T + ((max - val) / span) * (PAD_B - PAD_T);
}

function buildSvgLine(values: readonly number[], min: number, max: number): string {
  if (values.length === 0) return "";
  const denom = Math.max(values.length - 1, 1);
  return values
    .map((val, idx) => {
      const x = PAD_L + (idx / denom) * (PAD_R - PAD_L);
      const y = toSvgY(val, min, max);
      return `${idx === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildSvgArea(linePath: string): string {
  if (!linePath) return "";
  return `${linePath} L ${PAD_R} ${PAD_B + 14} L ${PAD_L} ${PAD_B + 14} Z`;
}

export function RealNavChart({
  copy,
  language,
  currency,
  accountId,
  accountLabel,
  snapshots,
  selectedBenchmark,
  benchmarkSeries,
  benchmarkLoading = false,
  benchmarkNotice = null,
  onSelectBenchmark,
  onRefreshBenchmark,
  allTimeChange = 0,
  isMultiCurrency = false,
  baselineTestId = "hero-local-baseline",
  compact = false,
}: RealNavChartProps) {
  const chinese = language === "zh";
  const [period, setPeriod] = useState<NavChartPeriod>("ALL");
  const [chartMode, setChartMode] = useState<"nav" | "twr">("nav");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const safeCurrency = currency && currency !== "MULTI" ? currency.toUpperCase() : "USD";
  const allowedBenchmarks = allowedBenchmarksForCurrency(safeCurrency);
  const effectiveBenchmark = selectedBenchmark && allowedBenchmarks.includes(selectedBenchmark)
    ? selectedBenchmark
    : null;
  const effectiveMode: "nav" | "twr" = effectiveBenchmark ? "twr" : chartMode;

  const fullTwr = useMemo(
    () => computeTwrSeries(snapshots, safeCurrency, accountId),
    [accountId, safeCurrency, snapshots],
  );

  const windowedSnapshots = useMemo(
    () => filterNavSnapshotsByPeriod(snapshots, period),
    [period, snapshots],
  );

  const activeTwr = useMemo(
    () => computeTwrSeries(windowedSnapshots, safeCurrency, accountId),
    [accountId, safeCurrency, windowedSnapshots],
  );

  const benchmarkTwr: BenchmarkTwrSeriesResult | null = useMemo(() => {
    if (!effectiveBenchmark || !benchmarkSeries || !activeTwr.hasEnoughPoints) return null;
    if (benchmarkSeries.symbol.toUpperCase() !== effectiveBenchmark) return null;
    const dates = activeTwr.points.map((pt) => pt.date);
    return computeBenchmarkTwrSeries(dates, benchmarkSeries);
  }, [activeTwr, benchmarkSeries, effectiveBenchmark]);

  // Honest < 2 snapshot gate: NEVER fabricate simulated curve points!
  if (!fullTwr.hasEnoughPoints) {
    return (
      <div className={`hero-local-baseline ${compact ? "is-compact" : ""}`} data-testid={baselineTestId}>
        <div className="nav-baseline-header">
          <p className="hero-local-kicker">
            {chinese ? "本地持仓模式 (CSV + 纸上模拟)" : "Local Portfolio (CSV + Paper)"}
            {accountLabel ? ` · ${accountLabel}` : ""}
          </p>
          <span className="nav-snapshot-pill" data-testid="nav-snapshot-count">
            {chinese
              ? `真实快照 ${fullTwr.snapshotCount} / 2`
              : `${fullTwr.snapshotCount} / 2 real snapshots`}
          </span>
        </div>
        <h2>
          {isMultiCurrency
            ? (chinese
                ? `${safeCurrency} 币种桶基准净值 · 严禁跨币种混加与虚构曲线`
                : `${safeCurrency} bucket baseline · No FX blending or fabricated history`)
            : (chinese
                ? "正在积累真实净值快照 · 绝不伪造模拟历史曲线"
                : "Accumulating real NAV snapshots · No fabricated history curve")}
        </h2>
        <p data-testid="nav-accumulation-hint">
          {chinese
            ? `当前 ${safeCurrency} 币种桶已记录 ${fullTwr.snapshotCount} 个真实快照日（需 ≥ 2 个不同日期才可绘制真实净值走势与时间加权收益率 TWR）。导入新日期 CSV 或执行纸上模拟后将自动幂等落库。`
            : `Recorded ${fullTwr.snapshotCount} real snapshot day(s) in the ${safeCurrency} bucket (at least 2 distinct dates are required before rendering a real NAV & TWR curve). FolioHelm never fabricates simulated historical points.`}
        </p>
        {!isMultiCurrency && (
          <div className="hero-local-stat">
            <span>{copy.allTime}</span>
            <strong>{formatSignedCurrency(allTimeChange, language, safeCurrency)}</strong>
          </div>
        )}
      </div>
    );
  }

  const displaySeries = activeTwr.hasEnoughPoints ? activeTwr : fullTwr;
  const points = displaySeries.points;
  const portfolioValues = points.map((pt) =>
    effectiveMode === "twr"
      ? Number(pt.cumulativeTwrPct)
      : Number(microsToDecimal(parseMicrosString(pt.netValueMicros), 2)),
  );

  const benchMap = new Map<string, number>();
  if (effectiveMode === "twr" && benchmarkTwr && benchmarkTwr.points.length >= 2) {
    for (const pt of benchmarkTwr.points) {
      benchMap.set(pt.date, Number(pt.cumulativeTwrPct));
    }
  }
  const hasAlignedBenchmark = effectiveMode === "twr" && benchMap.size >= 2;
  const benchmarkValues = hasAlignedBenchmark
    ? points.map((pt) => benchMap.get(pt.date) ?? 0)
    : [];

  const allYValues = hasAlignedBenchmark
    ? [...portfolioValues, ...benchmarkValues]
    : portfolioValues;
  const minVal = Math.min(...allYValues);
  const maxVal = Math.max(...allYValues);
  const linePath = buildSvgLine(portfolioValues, minVal, maxVal);
  const areaPath = buildSvgArea(linePath);
  const benchLinePath = hasAlignedBenchmark
    ? buildSvgLine(benchmarkValues, minVal, maxVal)
    : "";

  const lastIdx = Math.max(points.length - 1, 0);
  const activeIdx = hoverIndex !== null ? Math.min(lastIdx, Math.max(0, hoverIndex)) : lastIdx;
  const activePoint = points[activeIdx]!;
  const activeNavNum = Number(microsToDecimal(parseMicrosString(activePoint.netValueMicros), 2));
  const activeTwrNum = Number(activePoint.cumulativeTwrPct);
  const activeDailyPct = activePoint.dailyReturnPct !== null ? Number(activePoint.dailyReturnPct) : null;
  const activeCfMicros = parseMicrosString(activePoint.externalCashFlowMicros);
  const activeBenchPct = hasAlignedBenchmark ? (benchMap.get(activePoint.date) ?? null) : null;
  const activeX = PAD_L + (activeIdx / Math.max(lastIdx, 1)) * (PAD_R - PAD_L);
  const activeY = toSvgY(portfolioValues[activeIdx] ?? 0, minVal, maxVal);
  const tooltipLeft = Math.min(84, Math.max(16, (activeX / SVG_W) * 100));

  const cumTwrNum = Number(displaySeries.cumulativeTwrPct ?? "0");
  const benchCumNum = benchmarkTwr?.cumulativeTwrPct ? Number(benchmarkTwr.cumulativeTwrPct) : null;

  function handlePointerMove(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const relX = bounds.width > 0 ? event.clientX - bounds.left : 0;
    const progress = Math.min(1, Math.max(0, relX / (bounds.width || 1)));
    setHoverIndex(Math.round(progress * lastIdx));
  }

  function formatScaleTick(val: number): string {
    if (effectiveMode === "twr") {
      return `${val > 0 ? "+" : ""}${val.toFixed(1)}%`;
    }
    return formatCurrency(val, language, safeCurrency);
  }

  return (
    <div className={`performance-panel real-nav-panel ${compact ? "is-compact" : ""}`} data-testid="real-nav-chart">
      <div className="performance-header real-nav-header">
        <div>
          <span className="real-nav-kicker">
            {chinese
              ? `真实净值与 TWR (${safeCurrency} 桶 · ${displaySeries.snapshotCount} 个快照日)`
              : `Real NAV & TWR (${safeCurrency} bucket · ${displaySeries.snapshotCount} snapshots)`}
          </span>
          <strong className={cumTwrNum < 0 ? "fh-negative" : "fh-positive"} data-testid="real-nav-twr-stat">
            {formatSignedPercent(cumTwrNum, language)}{" "}
            <em>
              {chinese ? "时间加权收益 TWR" : "TWR"}
              {benchCumNum !== null && effectiveBenchmark
                ? ` · ${effectiveBenchmark} ${formatSignedPercent(benchCumNum, language)}`
                : ""}
            </em>
          </strong>
        </div>

        <div className="real-nav-controls">
          <div className="period-switcher" role="group" aria-label={chinese ? "图表维度" : "Chart mode"}>
            <button
              type="button"
              className={effectiveMode === "nav" ? "active" : undefined}
              aria-pressed={effectiveMode === "nav"}
              data-testid="nav-mode-value"
              onClick={() => {
                onSelectBenchmark(null);
                setChartMode("nav");
              }}
            >
              {chinese ? "净值" : "NAV"}
            </button>
            <button
              type="button"
              className={effectiveMode === "twr" ? "active" : undefined}
              aria-pressed={effectiveMode === "twr"}
              data-testid="nav-mode-twr"
              onClick={() => setChartMode("twr")}
            >
              TWR %
            </button>
          </div>

          <div className="period-switcher" role="group" aria-label={chinese ? "时间窗口" : "Period"}>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={period === p ? "active" : undefined}
                aria-pressed={period === p}
                data-testid={`nav-period-${p}`}
                onClick={() => {
                  setPeriod(p);
                  setHoverIndex(null);
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {allowedBenchmarks.length > 0 && (
        <div className="real-nav-benchmark-bar" data-testid="benchmark-selector">
          <span className="real-nav-bench-label">
            {chinese ? "只读基准对比:" : "Read-only benchmark:"}
          </span>
          <div className="real-nav-bench-pills" role="group" aria-label={chinese ? "基准指数" : "Benchmark"}>
            <button
              type="button"
              className={!effectiveBenchmark ? "is-active" : undefined}
              aria-pressed={!effectiveBenchmark}
              data-testid="benchmark-opt-none"
              onClick={() => onSelectBenchmark(null)}
            >
              {chinese ? "无" : "Off"}
            </button>
            {allowedBenchmarks.map((sym) => (
              <button
                key={sym}
                type="button"
                className={effectiveBenchmark === sym ? "is-active" : undefined}
                aria-pressed={effectiveBenchmark === sym}
                data-testid={`benchmark-opt-${sym}`}
                onClick={() => {
                  setChartMode("twr");
                  onSelectBenchmark(sym);
                }}
              >
                {sym}
              </button>
            ))}
          </div>
          {effectiveBenchmark && (
            <button
              type="button"
              className="real-nav-sync-btn"
              data-testid="benchmark-sync-button"
              disabled={benchmarkLoading}
              onClick={() => onRefreshBenchmark(effectiveBenchmark)}
            >
              {benchmarkLoading
                ? (chinese ? "同步中..." : "Syncing...")
                : (chinese ? `同步 ${effectiveBenchmark}` : `Sync ${effectiveBenchmark}`)}
            </button>
          )}
        </div>
      )}

      {!activeTwr.hasEnoughPoints && period !== "ALL" && (
        <p className="real-nav-notice" role="status" data-testid="nav-window-fallback-notice">
          {chinese
            ? `窗口 ${period} 内真实快照少于 2 个，已自动展示全部 ${fullTwr.snapshotCount} 个真实快照日（不伪造插值点）。`
            : `Fewer than 2 real snapshots exist in ${period}; showing all ${fullTwr.snapshotCount} recorded dates without fabricating points.`}
        </p>
      )}

      {effectiveBenchmark && (benchmarkNotice || !hasAlignedBenchmark) && (
        <p className="real-nav-notice" role="status" data-testid="benchmark-status-notice">
          {benchmarkNotice
            ?? (chinese
              ? `本地尚无 ${effectiveBenchmark} 覆盖当前日期区间的缓存；可点击「同步 ${effectiveBenchmark}」拉取延迟只读历史行情（离线时优雅降级）。`
              : `No local cached ${effectiveBenchmark} bars overlap this range yet. Click "Sync ${effectiveBenchmark}" for delayed read-only history (gracefully degrades offline).`)}
        </p>
      )}

      <div className="chart-wrap real-nav-svg-wrap" data-testid="real-nav-svg-wrap">
        <svg
          className="portfolio-chart"
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          role="img"
          aria-label={chinese ? `真实净值走势图 (${safeCurrency})` : `Real NAV & TWR chart (${safeCurrency})`}
        >
          <g className="chart-grid">
            <path d={`M${PAD_L} ${PAD_T}H${PAD_R}`} />
            <path d={`M${PAD_L} ${(PAD_T + PAD_B) / 2}H${PAD_R}`} />
            <path d={`M${PAD_L} ${PAD_B}H${PAD_R}`} />
          </g>
          <path className="chart-area real-nav-area" d={areaPath} />
          <path className="chart-line" data-testid="real-nav-portfolio-line" d={linePath} />
          {hasAlignedBenchmark && (
            <path
              className="real-nav-benchmark-line"
              data-testid="real-nav-benchmark-line"
              d={benchLinePath}
            />
          )}
          <g className="chart-focus">
            <line x1={activeX} y1={PAD_T} x2={activeX} y2={PAD_B + 10} />
            <circle cx={activeX} cy={activeY} r="5.5" />
          </g>
          <rect
            className="portfolio-chart-hit-area"
            data-testid="real-nav-hit-area"
            x={PAD_L}
            y={PAD_T - 8}
            width={PAD_R - PAD_L}
            height={PAD_B - PAD_T + 22}
            fill="transparent"
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverIndex(null)}
          />
        </svg>

        <div className="chart-tooltip real-nav-tooltip" data-testid="real-nav-tooltip" style={{ left: `${tooltipLeft}%` }}>
          <span>{activePoint.date}</span>
          <strong>
            {effectiveMode === "twr"
              ? `TWR ${formatSignedPercent(activeTwrNum, language)}`
              : formatCurrency(activeNavNum, language, safeCurrency)}
          </strong>
          <em>
            {effectiveMode === "twr"
              ? `${formatCurrency(activeNavNum, language, safeCurrency)}${activeBenchPct !== null && effectiveBenchmark ? ` · ${effectiveBenchmark} ${formatSignedPercent(activeBenchPct, language)}` : ""}`
              : `${activeDailyPct !== null ? `${chinese ? "日收益" : "Day"} ${formatSignedPercent(activeDailyPct, language)}` : (chinese ? "基准首日" : "Baseline")}${activeCfMicros !== 0n ? ` · CF ${formatSignedCurrency(Number(microsToDecimal(activeCfMicros, 2)), language, safeCurrency)}` : ""}`}
          </em>
        </div>

        <div className="chart-scale" aria-hidden="true">
          <span>{formatScaleTick(maxVal)}</span>
          <span>{formatScaleTick((maxVal + minVal) / 2)}</span>
          <span>{formatScaleTick(minVal)}</span>
        </div>
        <div className="chart-dates" aria-hidden="true">
          <span>{points[0]?.date}</span>
          <span>{points[Math.floor(lastIdx / 2)]?.date}</span>
          <span>{points[lastIdx]?.date}</span>
        </div>
      </div>

      {hasAlignedBenchmark && effectiveBenchmark && (
        <div className="real-nav-legend" data-testid="real-nav-legend">
          <span><i className="real-nav-dot-portfolio" /> {chinese ? "我的组合 TWR" : "Portfolio TWR"}</span>
          <span><i className="real-nav-dot-benchmark" /> {effectiveBenchmark} ({chinese ? "延迟只读基准" : "Delayed read-only"})</span>
        </div>
      )}
    </div>
  );
}
