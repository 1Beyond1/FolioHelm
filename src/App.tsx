import { useEffect, useState } from "react";
import { getCopy, detectInitialLanguage } from "./i18n";
import { getMockPortfolio } from "./mocks/portfolio";
import type { Language, ThemeMode } from "./types";
import type { AppRoute, NavigationState } from "./navigation";
import { applyTheme, watchSystemTheme } from "./platform/theme";
import { readStored, writeStored } from "./platform/storage";
import { ActivityCard } from "./components/ActivityCard";
import { AppShell } from "./components/AppShell";
import { InvestingHeatmap } from "./components/InvestingHeatmap";
import { PortfolioHero } from "./components/PortfolioHero";
import { PositionsCard } from "./components/PositionsCard";
import { SearchPalette } from "./components/SearchPalette";
import { InstrumentPage, MarketsPage } from "./features/markets";
import { PortfolioPage } from "./features/portfolio";
import { OrdersPage } from "./features/orders";
import { TradePage } from "./features/trade";
import { SettingsPage } from "./features/settings";
import { AutomationPage } from "./features/automation";
import { MOCK_BROKER, MOCK_SCENARIOS } from "./domain/mockBroker";
import type { MockScenario } from "./domain/contracts";

export function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = readStored<Language | null>("language", null);
    return stored === "en" || stored === "zh" ? stored : detectInitialLanguage();
  });
  const [theme, setTheme] = useState<ThemeMode>(() => readStored<ThemeMode>("theme", "system"));
  const [mockScenario, setMockScenario] = useState<MockScenario>(() => {
    const stored = readStored<string>("mock-scenario", "healthy");
    return MOCK_SCENARIOS.includes(stored as MockScenario) ? stored as MockScenario : "healthy";
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [navigation, setNavigation] = useState<NavigationState>({ route: "home" });
  const [tradeRequest, setTradeRequest] = useState<{ symbol?: string } | null>(null);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const copy = getCopy(language);
  const mockPortfolio = getMockPortfolio();

  useEffect(() => {
    writeStored("language", language);
  }, [language]);

  useEffect(() => {
    writeStored("theme", theme);
    applyTheme(theme);
    if (theme !== "system") return undefined;
    return watchSystemTheme(() => applyTheme(theme));
  }, [theme]);

  useEffect(() => {
    MOCK_BROKER.setScenario(mockScenario);
    writeStored("mock-scenario", mockScenario);
  }, [mockScenario]);

  useEffect(() => {
    const hasModal = Boolean(searchOpen || tradeRequest || settingsModalOpen);
    if (!hasModal) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [searchOpen, settingsModalOpen, tradeRequest]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The application owns only the global search and trade layers. A
        // settings dialog reports its presence and closes itself so Escape
        // always affects the top-most layer exactly once.
        if (searchOpen) {
          event.preventDefault();
          setSearchOpen(false);
          return;
        }
        if (tradeRequest) {
          event.preventDefault();
          setTradeRequest(null);
          return;
        }
        return;
      }

      if (
        !searchOpen
        && !tradeRequest
        && !settingsModalOpen
        && (event.ctrlKey || event.metaKey)
        && event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, settingsModalOpen, tradeRequest]);

  const navigate = (route: AppRoute, symbol?: string) => {
    setSearchOpen(false);
    if (route === "trade") {
      setTradeRequest({ symbol });
      return;
    }

    setTradeRequest(null);
    setNavigation({ route, symbol });
  };

  const home = (
    <>
      <PortfolioHero
        copy={copy}
        language={language}
        data={mockPortfolio}
        onNavigate={navigate}
        onSearch={() => setSearchOpen(true)}
      />

      <section className="content-grid" aria-label={copy.portfolio}>
        <InvestingHeatmap
          copy={copy}
          language={language}
          entries={mockPortfolio.heatmap}
          activeDays={mockPortfolio.activeDays}
          ordersFilled={mockPortfolio.ordersFilled}
          netChange={mockPortfolio.netChange}
        />
        <aside className="side-stack">
          <PositionsCard
            copy={copy}
            language={language}
            positions={mockPortfolio.positions}
            onOpenInstrument={(symbol) => navigate("instrument", symbol)}
            onViewAll={() => navigate("portfolio")}
          />
          <ActivityCard copy={copy} activity={mockPortfolio.activity} onViewAll={() => navigate("orders")} />
        </aside>
      </section>
    </>
  );

  const content = (() => {
    switch (navigation.route) {
      case "home":
        return home;
      case "markets":
        return (
          <MarketsPage
            language={language}
            onOpenInstrument={(symbol) => navigate("instrument", symbol)}
            onOpenTrade={(symbol) => navigate("trade", symbol)}
          />
        );
      case "instrument":
        return (
          <InstrumentPage
            language={language}
            symbol={navigation.symbol ?? "AAPL"}
            onBack={() => navigate("markets")}
            onOpenTrade={(symbol) => navigate("trade", symbol)}
          />
        );
      case "portfolio":
        return (
          <PortfolioPage
            language={language}
            onOpenInstrument={(symbol) => navigate("instrument", symbol)}
            onOpenTrade={(symbol) => navigate("trade", symbol)}
          />
        );
      case "orders":
        return <OrdersPage language={language} onOpenTrade={(symbol) => navigate("trade", symbol)} />;
      case "automation":
        return <AutomationPage language={language} />;
      case "settings":
        return (
          <SettingsPage
            language={language}
            onLanguageChange={setLanguage}
            theme={theme}
            onThemeChange={setTheme}
            mockScenario={mockScenario}
            onMockScenarioChange={setMockScenario}
            onModalStateChange={setSettingsModalOpen}
          />
        );
      default:
        return home;
    }
  })();

  return (
    <>
      <AppShell
        copy={copy}
        language={language}
        activeRoute={tradeRequest ? "trade" : navigation.route}
        onLanguageChange={setLanguage}
        onNavigate={navigate}
        onSearch={() => setSearchOpen(true)}
      >
        {content}
      </AppShell>

      {searchOpen && (
        <SearchPalette
          copy={copy}
          language={language}
          onClose={() => setSearchOpen(false)}
          onOpenInstrument={(symbol) => navigate("instrument", symbol)}
          onOpenMarkets={() => navigate("markets")}
        />
      )}

      {tradeRequest && (
        <div
          className="trade-modal-backdrop"
          data-testid="trade-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setTradeRequest(null);
          }}
        >
          <div className="trade-modal-window" onMouseDown={(event) => event.stopPropagation()}>
            <TradePage
              key={tradeRequest.symbol ?? "default-trade"}
              language={language}
              initialSymbol={tradeRequest.symbol}
              onClose={() => setTradeRequest(null)}
              onViewOrders={() => navigate("orders")}
            />
          </div>
        </div>
      )}

    </>
  );
}
