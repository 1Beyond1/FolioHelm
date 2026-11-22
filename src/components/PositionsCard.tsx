import type { Copy } from "../i18n";
import { formatCurrency, formatSignedCurrency } from "../formatters";
import type { Language, Position } from "../types";
import { DataStateNotice } from "./DataStateNotice";

interface PositionsCardProps {
  copy: Copy;
  language: Language;
  positions: Position[];
  onOpenInstrument: (symbol: string) => void;
  onViewAll: () => void;
}

export function PositionsCard({ copy, language, positions, onOpenInstrument, onViewAll }: PositionsCardProps) {
  return (
    <article className="positions-card surface-card" id="portfolio">
      <div className="side-heading">
        <div><span className="section-kicker">{copy.portfolio}</span><h2>{copy.yourPositions}</h2></div>
        <button type="button" onClick={onViewAll}>{copy.viewAll} <span>↗</span></button>
      </div>
      <div className="positions-list">
        {positions.length === 0 ? (
          <DataStateNotice language={language} status="no-data" compact />
        ) : positions.map((position) => (
          <button className="position-row" type="button" key={`${position.ticker}:${position.currency ?? "USD"}`} onClick={() => onOpenInstrument(position.ticker)}>
            <span className={`asset-icon ${position.iconClass}`}>{position.ticker.slice(0, 1)}</span>
            <span className="asset-name"><b>{position.ticker}</b><small>{position.company}</small></span>
            <span className="asset-value"><b>{formatCurrency(position.marketValue, language, position.currency)}</b><small className={position.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatSignedCurrency(position.unrealizedPnl, language, position.currency)}</small></span>
            <span className="chevron">›</span>
          </button>
        ))}
      </div>
    </article>
  );
}
