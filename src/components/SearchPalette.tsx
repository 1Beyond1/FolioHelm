import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import { decimalToNumber } from "../domain/decimal";
import { MOCK_BROKER } from "../domain/mockBroker";
import { formatCurrency } from "../formatters";
import { Modal } from "./Modal";

interface SearchPaletteProps {
  copy: Copy;
  language: Language;
  onClose: () => void;
  onOpenInstrument: (symbol: string) => void;
  onOpenMarkets: () => void;
}

export function SearchPalette({
  copy,
  language,
  onClose,
  onOpenInstrument,
  onOpenMarkets,
}: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const chinese = language === "zh";
  const symbols = MOCK_BROKER.getSnapshot().quotes.map((quote) => ({
    symbol: quote.symbol,
    companyEn: quote.companyEn,
    companyZh: quote.companyZh,
    price: decimalToNumber(quote.price),
    change: decimalToNumber(quote.changePct),
  }));
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return symbols.filter((item) =>
      !normalized
      || item.symbol.toLowerCase().includes(normalized)
      || item.companyEn.toLowerCase().includes(normalized)
      || item.companyZh.includes(normalized)
    );
  }, [query, symbols]);

  useEffect(() => {
    setActiveIndex(results.length === 0 ? -1 : 0);
  }, [query, results.length]);

  function moveActive(nextIndex: number): void {
    if (results.length === 0) return;
    const wrapped = (nextIndex + results.length) % results.length;
    setActiveIndex(wrapped);
    const element = document.getElementById(`search-result-${results[wrapped].symbol}`);
    if (typeof element?.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(activeIndex + 1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(activeIndex - 1);
      return;
    }

    if (event.key === "Home" && results.length > 0) {
      event.preventDefault();
      moveActive(0);
      return;
    }

    if (event.key === "End" && results.length > 0) {
      event.preventDefault();
      moveActive(results.length - 1);
      return;
    }

    if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      const result = results[activeIndex];
      if (result) onOpenInstrument(result.symbol);
    }
  }

  return (
    <Modal
      className="search-palette"
      backdropClassName="search-overlay"
      ariaLabel={copy.searchSymbol}
      testId="search-palette"
      onClose={onClose}
    >
      <div className="search-palette-input">
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={copy.searchSymbol}
          aria-label={copy.searchSymbol}
          aria-controls="search-results"
          aria-activedescendant={activeIndex >= 0 ? `search-result-${results[activeIndex]?.symbol}` : undefined}
        />
        <button type="button" onClick={onClose}>Esc</button>
      </div>
      <div className="search-palette-caption">
        <span>{chinese ? "虚构行情 · 仅供界面演示" : "Fictional quotes · Interface demo only"}</span>
        <button type="button" onClick={onOpenMarkets}>{chinese ? "打开市场页" : "Open Markets"} →</button>
      </div>
      <div className="search-results" id="search-results" aria-label={chinese ? "搜索结果" : "Search results"}>
        {results.map((item, index) => (
          <button
            type="button"
            id={`search-result-${item.symbol}`}
            className={index === activeIndex ? "is-active" : undefined}
            aria-current={index === activeIndex ? "true" : undefined}
            key={item.symbol}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => onOpenInstrument(item.symbol)}
          >
            <span className="search-symbol-mark">{item.symbol.slice(0, 1)}</span>
            <span><b>{item.symbol}</b><small>{chinese ? item.companyZh : item.companyEn}</small></span>
            <span className="search-price"><b>{formatCurrency(item.price, language)}</b><small className={item.change >= 0 ? "positive" : "negative"}>{item.change >= 0 ? "+" : ""}{item.change.toFixed(2)}%</small></span>
          </button>
        ))}
        {results.length === 0 && <p>{chinese ? "没有匹配的演示证券" : "No demo instruments match"}</p>}
      </div>
    </Modal>
  );
}
