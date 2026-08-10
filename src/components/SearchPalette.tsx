import { useMemo, useState } from "react";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import { decimalToNumber } from "../domain/decimal";
import { MOCK_BROKER } from "../domain/mockBroker";

interface SearchPaletteProps {
  copy: Copy;
  language: Language;
  onClose: () => void;
  onOpenInstrument: (symbol: string) => void;
  onOpenMarkets: () => void;
}

const symbols = MOCK_BROKER.getSnapshot().quotes.map((quote) => ({
  symbol: quote.symbol,
  companyEn: quote.companyEn,
  companyZh: quote.companyZh,
  price: decimalToNumber(quote.price),
  change: decimalToNumber(quote.changePct),
}));

export function SearchPalette({
  copy,
  language,
  onClose,
  onOpenInstrument,
  onOpenMarkets,
}: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const chinese = language === "zh";
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return symbols.filter((item) =>
      !normalized || item.symbol.toLowerCase().includes(normalized) || item.companyEn.toLowerCase().includes(normalized) || item.companyZh.includes(normalized)
    );
  }, [query]);

  return (
    <div className="search-overlay" role="presentation" onMouseDown={onClose}>
      <section className="search-palette" role="dialog" aria-modal="true" aria-label={copy.searchSymbol} onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-palette-input">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.searchSymbol}
            aria-label={copy.searchSymbol}
          />
          <button type="button" onClick={onClose}>Esc</button>
        </div>
        <div className="search-palette-caption">
          <span>{chinese ? "虚构行情 · 仅供界面演示" : "Fictional quotes · Interface demo only"}</span>
          <button type="button" onClick={onOpenMarkets}>{chinese ? "打开市场页" : "Open Markets"} →</button>
        </div>
        <div className="search-results">
          {results.map((item) => (
            <button type="button" key={item.symbol} onClick={() => onOpenInstrument(item.symbol)}>
              <span className="search-symbol-mark">{item.symbol.slice(0, 1)}</span>
              <span><b>{item.symbol}</b><small>{chinese ? item.companyZh : item.companyEn}</small></span>
              <span className="search-price"><b>${item.price.toFixed(2)}</b><small className={item.change >= 0 ? "positive" : "negative"}>{item.change >= 0 ? "+" : ""}{item.change.toFixed(2)}%</small></span>
            </button>
          ))}
          {results.length === 0 && <p>{chinese ? "没有匹配的演示证券" : "No demo instruments match"}</p>}
        </div>
      </section>
    </div>
  );
}
