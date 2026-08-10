import { useRef, useState, type KeyboardEvent } from "react";
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

function returnLevel(dailyReturnPct: number | null): HeatLevel {
  if (dailyReturnPct === null || dailyReturnPct === 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil(Math.abs(dailyReturnPct) / 0.28))) as HeatLevel;
}

function actionLabel(actions: number, copy: Copy): string {
  return `${actions} ${actions === 1 ? copy.action : copy.actions}`;
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

  const availableEntries = entries.filter((entry) => entry.dataStatus === "available" && entry.dailyReturnPct !== null);
  const bestDay = availableEntries.reduce((best, entry) => Math.max(best, entry.dailyReturnPct ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  const downDays = availableEntries.filter((entry) => (entry.dailyReturnPct ?? 0) < 0).length;
  const isReturnMode = mode === "return";
  const hoveredColumn = hoveredIndex === null ? null : Math.floor(hoveredIndex / 7);
  const hoveredRow = hoveredIndex === null ? null : hoveredIndex % 7;
  const columnCount = Math.ceil(entries.length / 7);
  const tooltipStyle = hoveredColumn === null || hoveredRow === null
    ? undefined
    : {
        left: `${Math.min(90, Math.max(10, ((hoveredColumn + 0.5) / columnCount) * 100))}%`,
        top: `${36 + hoveredRow * 13}px`,
      };

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
          <button className="year-selector" type="button">{copy.year} <span>⌄</span></button>
        </div>
      </div>

      <div className={`heatmap-frame ${isReturnMode ? "return-mode" : ""}`} data-mode={mode}>
        <div className="month-labels" aria-hidden="true">
          <span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span>
        </div>
        <div className="weekday-labels" aria-hidden="true">
          {copy.weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
        </div>
        <div className="activity-heatmap" role="grid" aria-label={copy.yourInvestingYear}>
          {entries.map((entry, index) => {
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
              const row = index % 7;
              const column = Math.floor(index / 7);
              let nextIndex = index;
              if (event.key === "ArrowUp") nextIndex = column * 7 + Math.max(0, row - 1);
              if (event.key === "ArrowDown") nextIndex = Math.min(entries.length - 1, column * 7 + Math.min(6, row + 1));
              if (event.key === "ArrowLeft") nextIndex = Math.max(0, (column - 1) * 7 + row);
              if (event.key === "ArrowRight") nextIndex = Math.min(entries.length - 1, (column + 1) * 7 + row);
              if (event.key === "Home") nextIndex = column * 7;
              if (event.key === "End") nextIndex = Math.min(entries.length - 1, column * 7 + 6);
              if (nextIndex === index) return;
              event.preventDefault();
              setFocusIndex(nextIndex);
              cellRefs.current[nextIndex]?.focus();
            }

            return (
              <button
                key={entry.date}
                type="button"
                tabIndex={index === focusIndex ? 0 : -1}
                aria-rowindex={index % 7 + 1}
                aria-colindex={Math.floor(index / 7) + 1}
                ref={(element) => { cellRefs.current[index] = element; }}
                className={`heat-cell ${index === 133 ? "featured" : ""} ${entry.dataStatus !== "available" ? "is-no-data" : ""}`}
                data-level={level}
                data-return-sign={tone}
                data-status={entry.dataStatus}
                aria-label={summary}
                onKeyDown={handleKeyDown}
                onMouseEnter={() => {
                  setHoveredEntry(entry);
                  setHoveredIndex(index);
                }}
                onFocus={() => {
                  setFocusIndex(index);
                  setHoveredEntry(entry);
                  setHoveredIndex(index);
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
            );
          })}
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
            <strong>{formatSignedPercent(bestDay, language)}</strong><span>{copy.bestDay}</span>
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
