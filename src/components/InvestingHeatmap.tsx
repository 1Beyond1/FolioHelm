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
}: InvestingHeatmapProps) {
  const [mode, setMode] = useState<HeatmapMode>("activity");
  const [returnUnit, setReturnUnit] = useState<ReturnUnit>("percent");
  const [hoveredEntry, setHoveredEntry] = useState<HeatmapEntry | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
                className={returnUnit === "percent" ? "active" : undefined}
                aria-pressed={returnUnit === "percent"}
                onClick={() => setReturnUnit("percent")}
              >
                {copy.percent}
              </button>
              <button
                type="button"
                className={returnUnit === "usd" ? "active" : undefined}
                aria-pressed={returnUnit === "usd"}
                data-testid="heatmap-unit-usd"
                onClick={() => setReturnUnit("usd")}
              >
                {copy.usd}
              </button>
            </div>
          )}
          <span className="year-label" aria-label={copy.year}>{copy.year}</span>
        </div>
      </div>

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

                const displayValue = returnUnit === "percent" ? entry.dailyReturnPct : entry.dailyReturnUsd;
                const tone = entry.dataStatus !== "available" || entry.dailyReturnPct === null
                  ? "neutral"
                  : entry.dailyReturnPct > 0 ? "positive" : entry.dailyReturnPct < 0 ? "negative" : "neutral";
                const level = entry.dataStatus === "available" ? (isReturnMode ? returnLevel(entry.dailyReturnPct) : entry.level) : 0;
                const date = formatHeatmapDate(entry.date, language);
                const summary = entry.dataStatus !== "available" || displayValue === null
                  ? `${date}: ${copy.noData}`
                  : isReturnMode
                    ? `${date}: ${returnUnit === "percent" ? formatSignedPercent(displayValue, language) : formatSignedCurrency(displayValue, language)}`
                    : `${date}: ${actionLabel(entry.actions, copy)}, ${copy.portfolioTooltip} ${formatSignedPercent(entry.dailyReturnPct ?? 0, language)}`;

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
                      className={`heat-cell ${entryIndex === 133 ? "featured" : ""} ${entry.dataStatus !== "available" ? "is-no-data" : ""}`}
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
                {hoveredEntry.dataStatus !== "available"
                  ? copy.noData
                  : isReturnMode
                    ? returnUnit === "percent"
                      ? formatSignedPercent(hoveredEntry.dailyReturnPct ?? 0, language)
                      : formatSignedCurrency(hoveredEntry.dailyReturnUsd ?? 0, language)
                    : actionLabel(hoveredEntry.actions, copy)}
              </strong>
              <em>
                {hoveredEntry.dataStatus !== "available"
                  ? copy.noData
                  : `${copy.portfolioTooltip} ${formatSignedPercent(hoveredEntry.dailyReturnPct ?? 0, language)}${isReturnMode && returnUnit === "percent" ? "" : ` · ${formatSignedCurrency(hoveredEntry.dailyReturnUsd ?? 0, language)}`}`}
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
            <strong>{formatSignedCurrency(netChange, language)}</strong><span>{copy.netChange}</span>
          </div>
        ) : (
          <div className="year-summary">
            <strong>{activeDays}</strong><span>{copy.activeDays}</span>
            <strong>{ordersFilled}</strong><span>{copy.ordersFilled}</span>
            <strong>{formatSignedCurrency(netChange, language)}</strong><span>{copy.netChange}</span>
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
