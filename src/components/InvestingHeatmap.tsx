import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Copy } from "../i18n";
import { formatHeatmapDate, formatSignedCurrency, formatSignedPercent } from "../formatters";
import type { HeatLevel, HeatmapEntry, HeatmapMode, Language, ReturnUnit } from "../types";

interface InvestingHeatmapProps {
  copy: Copy;
  language: Language;
  entries: HeatmapEntry[];
  activeDays: number;
  ordersFilled: number;
  netChange: number;
  year?: number;
  currency?: string;
  isMultiCurrency?: boolean;
  localNavSummary?: {
    snapshotCount: number;
    hasEnoughPoints: boolean;
    currency: string;
  };
}

const legendLevels: HeatLevel[] = [0, 1, 2, 3, 4];
const DAYS_PER_WEEK = 7;

function returnLevel(dailyReturnPct: number | null): HeatLevel {
  if (dailyReturnPct === null || !Number.isFinite(dailyReturnPct) || dailyReturnPct === 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil(Math.abs(dailyReturnPct) / 0.28))) as HeatLevel;
}

function actionLabel(actions: number, copy: Copy): string {
  return `${actions} ${actions === 1 ? copy.action : copy.actions}`;
}

function startWeekdayOffset(entries: readonly HeatmapEntry[]): number {
  if (entries.length === 0) return 0;
  const parsed = new Date(`${entries[0]!.date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.getUTCDay() : 0;
}

export function InvestingHeatmap({
  copy,
  language,
  entries,
  activeDays,
  ordersFilled,
  netChange,
  year,
  currency = "USD",
  isMultiCurrency = false,
  localNavSummary,
}: InvestingHeatmapProps) {
  const [mode, setMode] = useState<HeatmapMode>("activity");
  const [returnUnit, setReturnUnit] = useState<ReturnUnit>("percent");
  const [hoveredEntry, setHoveredEntry] = useState<HeatmapEntry | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const multiCurrency = isMultiCurrency || currency === "MULTI";
  const displayCurrency = multiCurrency ? "USD" : (currency || "USD");
  const effectiveReturnUnit: ReturnUnit = multiCurrency ? "percent" : returnUnit;
  const currencyUnitLabel = displayCurrency === "USD" ? copy.usd : displayCurrency;
  const displayYear = year !== undefined
    ? String(year)
    : (entries[0]?.date && /^\d{4}-/.test(entries[0].date) ? entries[0].date.slice(0, 4) : copy.year);
  const formattedNetChange = multiCurrency
    ? (language === "zh" ? "多币种隔离" : "Multi-currency")
    : formatSignedCurrency(netChange, language, displayCurrency);

  const availableEntries = entries.filter((entry) => entry.dataStatus === "available" && entry.dailyReturnPct !== null && Number.isFinite(entry.dailyReturnPct));
  const bestDay = availableEntries.length === 0
    ? null
    : availableEntries.reduce((best, entry) => Math.max(best, entry.dailyReturnPct ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  const downDays = availableEntries.filter((entry) => (entry.dailyReturnPct ?? 0) < 0).length;
  const isReturnMode = mode === "return";
  const months = language === "zh"
    ? ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"]
    : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const startOffset = startWeekdayOffset(entries);
  const weekCount = Math.max(1, Math.ceil((startOffset + entries.length) / DAYS_PER_WEEK));
  const hoveredSlot = hoveredIndex === null ? null : startOffset + hoveredIndex;
  const hoveredColumn = hoveredSlot === null ? null : Math.floor(hoveredSlot / DAYS_PER_WEEK);
  const hoveredRow = hoveredSlot === null ? null : hoveredSlot % DAYS_PER_WEEK;
  const tooltipStyle = hoveredColumn === null || hoveredRow === null
    ? undefined
    : {
        left: `${Math.min(90, Math.max(10, ((hoveredColumn + 0.5) / weekCount) * 100))}%`,
        top: `${36 + hoveredRow * 13}px`,
      };
  const heatmapStyle = { "--heatmap-weeks": String(weekCount) } as CSSProperties;

  return (
    <article className="heatmap-card surface-card">
      <div className="card-heading">
        <div>
          <span className="section-kicker">{isReturnMode ? copy.dailyReturn : copy.activity}</span>
          <h2>{copy.yourInvestingYear}</h2>
          <p>{copy.consistencyHint}</p>
        </div>
        <div className="heatmap-controls">
          <div className="segmented-control" role="group" aria-label={copy.activity}>
            <button
              type="button"
              className={mode === "activity" ? "active" : undefined}
              aria-pressed={mode === "activity"}
              data-testid="heatmap-mode-activity"
              onClick={() => setMode("activity")}
            >
              {copy.activity}
            </button>
            <button
              type="button"
              className={isReturnMode ? "active" : undefined}
              aria-pressed={isReturnMode}
              data-testid="heatmap-mode-return"
              onClick={() => setMode("return")}
            >
              {copy.dailyReturn}
            </button>
          </div>
          {isReturnMode && (
            <div className="segmented-control unit-control" role="group" aria-label={copy.dailyReturn} data-testid="heatmap-unit-control">
              <button
                type="button"
                className={effectiveReturnUnit === "percent" ? "active" : undefined}
                aria-pressed={effectiveReturnUnit === "percent"}
                onClick={() => setReturnUnit("percent")}
              >
                {copy.percent}
              </button>
              {!multiCurrency && (
                <button
                  type="button"
                  className={effectiveReturnUnit === "usd" ? "active" : undefined}
                  aria-pressed={effectiveReturnUnit === "usd"}
                  data-testid="heatmap-unit-usd"
                  onClick={() => setReturnUnit("usd")}
                >
                  {currencyUnitLabel}
                </button>
              )}
            </div>
          )}
          <span className="year-label" aria-label={displayYear}>{displayYear}</span>
        </div>
      </div>

      {localNavSummary && !localNavSummary.hasEnoughPoints && (
        <p className="heatmap-accumulation-notice" role="status" data-testid="heatmap-accumulation-notice">
          {language === "zh"
            ? `${localNavSummary.currency} 币种桶已记录 ${localNavSummary.snapshotCount} / 2 个真实净值快照日：积累满 2 个交易日后自动点亮真实日历收益热力图，绝不伪造模拟点。`
            : `${localNavSummary.currency} bucket: ${localNavSummary.snapshotCount} / 2 real NAV snapshot day(s) recorded. Daily return cells populate automatically once ≥ 2 dates exist — no simulated days are fabricated.`}
        </p>
      )}

      <div className={`heatmap-frame ${isReturnMode ? "return-mode" : ""}`} data-mode={mode}>
        <div className="month-labels" aria-hidden="true">
          {months.map((month) => <span key={month}>{month}</span>)}
        </div>
        <div className="weekday-labels" aria-hidden="true">
          {copy.weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
        </div>
        <div
          className="activity-heatmap"
          role="grid"
          aria-label={copy.yourInvestingYear}
          aria-rowcount={DAYS_PER_WEEK}
          aria-colcount={weekCount}
          style={heatmapStyle}
        >
          {Array.from({ length: DAYS_PER_WEEK }, (_, row) => (
            <div
              key={row}
              className="heatmap-row"
              role="row"
              aria-rowindex={row + 1}
            >
              {Array.from({ length: weekCount }, (_, column) => {
                const entryIndex = column * DAYS_PER_WEEK + row - startOffset;
                const entry = entryIndex >= 0 && entryIndex < entries.length ? entries[entryIndex] : undefined;

                if (!entry) {
                  return (
                    <div
                      key={`pad-${row}-${column}`}
                      className="heatmap-gridcell"
                      role="gridcell"
                      aria-colindex={column + 1}
                      aria-disabled="true"
                    >
                      <span className="heat-cell-empty" aria-hidden="true" />
                    </div>
                  );
                }

                const displayValue = effectiveReturnUnit === "percent" ? entry.dailyReturnPct : entry.dailyReturnUsd;
                const hasReturnData = entry.dataStatus === "available" && entry.dailyReturnPct !== null;
                const hasActivity = entry.actions > 0 && entry.level > 0;
                const tone = !hasReturnData
                  ? "neutral"
                  : entry.dailyReturnPct! > 0 ? "positive" : entry.dailyReturnPct! < 0 ? "negative" : "neutral";
                // P1-5: In Activity mode, Day 0 baseline or order-only days with real activity MUST render
                // their activity level consistently with `activeDays`, while Return mode stays strictly
                // `level = 0` / `noData` whenever no prior-day return exists (never fabricating returns).
                const level = isReturnMode
                  ? (hasReturnData ? returnLevel(entry.dailyReturnPct) : 0)
                  : (hasActivity ? entry.level : (entry.dataStatus === "available" ? entry.level : 0));
                const isCellNoData = isReturnMode
                  ? !hasReturnData
                  : (!hasActivity && entry.dataStatus !== "available");
                const date = formatHeatmapDate(entry.date, language);
                const summary = isReturnMode
                  ? (!hasReturnData || displayValue === null
                      ? `${date}: ${copy.noData}`
                      : `${date}: ${effectiveReturnUnit === "percent" ? formatSignedPercent(displayValue, language) : formatSignedCurrency(displayValue, language, displayCurrency)}`)
                  : hasActivity
                    ? (hasReturnData
                        ? `${date}: ${actionLabel(entry.actions, copy)}, ${copy.portfolioTooltip} ${formatSignedPercent(entry.dailyReturnPct ?? 0, language)}`
                        : `${date}: ${actionLabel(entry.actions, copy)}`)
                    : entry.dataStatus === "available"
                      ? `${date}: ${actionLabel(entry.actions, copy)}, ${copy.portfolioTooltip} ${formatSignedPercent(entry.dailyReturnPct ?? 0, language)}`
                      : `${date}: ${copy.noData}`;

                function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
                  let nextIndex = entryIndex;
                  if (event.key === "ArrowUp" && row > 0 && entryIndex - 1 >= 0) nextIndex = entryIndex - 1;
                  if (event.key === "ArrowDown" && row < DAYS_PER_WEEK - 1 && entryIndex + 1 < entries.length) nextIndex = entryIndex + 1;
                  if (event.key === "ArrowLeft" && entryIndex - DAYS_PER_WEEK >= 0) nextIndex = entryIndex - DAYS_PER_WEEK;
                  if (event.key === "ArrowRight" && entryIndex + DAYS_PER_WEEK < entries.length) nextIndex = entryIndex + DAYS_PER_WEEK;
                  if (event.key === "Home") nextIndex = Math.max(0, column * DAYS_PER_WEEK - startOffset);
                  if (event.key === "End") nextIndex = Math.min(entries.length - 1, column * DAYS_PER_WEEK + (DAYS_PER_WEEK - 1) - startOffset);
                  if (nextIndex === entryIndex) return;
                  event.preventDefault();
                  setFocusIndex(nextIndex);
                  cellRefs.current[nextIndex]?.focus();
                }

                return (
                  <div
                    key={entry.date}
                    className="heatmap-gridcell"
                    role="gridcell"
                    aria-colindex={column + 1}
                    data-date={entry.date}
                    data-weekday={row}
                  >
                    <button
                      type="button"
                      tabIndex={entryIndex === focusIndex ? 0 : -1}
                      ref={(element) => { cellRefs.current[entryIndex] = element; }}
                      className={`heat-cell ${isCellNoData ? "is-no-data" : ""}`}
                      data-level={level}
                      data-return-sign={tone}
                      data-status={entry.dataStatus}
                      aria-label={summary}
                      onKeyDown={handleKeyDown}
                      onMouseEnter={() => {
                        setHoveredEntry(entry);
                        setHoveredIndex(entryIndex);
                      }}
                      onFocus={() => {
                        setFocusIndex(entryIndex);
                        setHoveredEntry(entry);
                        setHoveredIndex(entryIndex);
                      }}
                      onMouseLeave={() => {
                        setHoveredEntry(null);
                        setHoveredIndex(null);
                      }}
                      onBlur={() => {
                        setHoveredEntry(null);
                        setHoveredIndex(null);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className={`heatmap-tooltip ${hoveredEntry ? "visible" : ""}`} style={tooltipStyle} role="status" aria-live="polite">
          {hoveredEntry && (
            <>
              <span>{formatHeatmapDate(hoveredEntry.date, language)}</span>
              <strong>
                {isReturnMode
                  ? (hoveredEntry.dataStatus !== "available" || hoveredEntry.dailyReturnPct === null
                      ? copy.noData
                      : effectiveReturnUnit === "percent"
                        ? formatSignedPercent(hoveredEntry.dailyReturnPct, language)
                        : formatSignedCurrency(hoveredEntry.dailyReturnUsd ?? 0, language, displayCurrency))
                  : (hoveredEntry.actions > 0 || hoveredEntry.dataStatus === "available"
                      ? actionLabel(hoveredEntry.actions, copy)
                      : copy.noData)}
              </strong>
              <em>
                {hoveredEntry.dataStatus !== "available" || hoveredEntry.dailyReturnPct === null
                  ? copy.noData
                  : `${copy.portfolioTooltip} ${formatSignedPercent(hoveredEntry.dailyReturnPct, language)}${(isReturnMode && effectiveReturnUnit === "percent") || multiCurrency ? "" : ` · ${formatSignedCurrency(hoveredEntry.dailyReturnUsd ?? 0, language, displayCurrency)}`}`}
              </em>
            </>
          )}
        </div>
      </div>

      <div className="heatmap-footer">
        {isReturnMode ? (
          <div className="year-summary return-summary">
            <strong data-testid="heatmap-best-day">{bestDay === null ? copy.noData : formatSignedPercent(bestDay, language)}</strong><span>{copy.bestDay}</span>
            <strong>{downDays}</strong><span>{copy.downDays}</span>
            <strong data-testid="heatmap-net-change">{formattedNetChange}</strong><span>{copy.netChange}</span>
          </div>
        ) : (
          <div className="year-summary">
            <strong>{activeDays}</strong><span>{copy.activeDays}</span>
            <strong>{ordersFilled}</strong><span>{copy.ordersFilled}</span>
            <strong data-testid="heatmap-net-change">{formattedNetChange}</strong><span>{copy.netChange}</span>
          </div>
        )}
        <div className="heatmap-legend" aria-label={isReturnMode ? `${copy.loss} to ${copy.gain}` : `${copy.less} to ${copy.more}`}>
          <span>{isReturnMode ? copy.loss : copy.less}</span>
          {legendLevels.map((level) => (
            <i
              key={level}
              data-level={level}
              data-tone={isReturnMode ? level <= 2 && level > 0 ? "negative" : level >= 3 ? "positive" : undefined : undefined}
            />
          ))}
          <span>{isReturnMode ? copy.gain : copy.more}</span>
        </div>
      </div>
    </article>
  );
}
