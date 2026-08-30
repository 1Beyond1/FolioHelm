import { useEffect, useState } from "react";
import { getCopy, detectInitialLanguage } from "./i18n";
import { getMockPortfolio } from "./mocks/portfolio";
import type { Language, ThemeMode } from "./types";
import type { AppLocation, AppRoute, NavigationState } from "./navigation";
import { parseLocationHash, sameLocation, serializeLocation } from "./navigation";
import { applyTheme, watchSystemTheme } from "./platform/theme";
import { hasStorageIssue, isStorageAvailable, readStored, STORAGE_ISSUE_EVENT, writeStored } from "./platform/storage";
import { ActivityCard } from "./components/ActivityCard";
import { AppShell } from "./components/AppShell";
import { InvestingHeatmap } from "./components/InvestingHeatmap";
import { PortfolioHero } from "./components/PortfolioHero";
import { PositionsCard } from "./components/PositionsCard";
import { SearchPalette } from "./components/SearchPalette";
import { Modal } from "./components/Modal";
import { DataStateNotice, type DisplayDataStatus } from "./components/DataStateNotice";
import { InstrumentPage, MarketsPage } from "./features/markets";
import { PortfolioPage } from "./features/portfolio";
import { OrdersPage } from "./features/orders";
import { TradePage } from "./features/trade";
import { SettingsPage } from "./features/settings";
import { AutomationPage } from "./features/automation";
import { MOCK_BROKER, MOCK_SCENARIOS } from "./domain/mockBroker";
import type { MockScenario } from "./domain/contracts";

function initialLocation(): AppLocation {
  if (typeof window === "undefined") return { route: "home" };
  return parseLocationHash(window.location.hash);
}

interface FolioHistoryState {
  foliohelm: true;
  entry: "initial" | "page" | "trade-dialog";
}

function isTradeDialogHistoryState(value: unknown): value is FolioHistoryState {
  if (!value || typeof value !== "object") return false;
  return (value as Partial<FolioHistoryState>).foliohelm === true
    && (value as Partial<FolioHistoryState>).entry === "trade-dialog";
}

function aggregateDataStatus(): DisplayDataStatus | null {
  const snapshot = MOCK_BROKER.getSnapshot();
  const statuses = [snapshot.account.status, ...snapshot.quotes.map((quote) => quote.status)];
  const priority = ["reauth-required", "offline", "error", "stale"] as const;
  return priority.find((status) => statuses.includes(status))
    ?? (snapshot.quotes.length === 0 || snapshot.quotes.every((quote) => quote.status === "no-data") ? "no-data" : null);
}

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
  const [location, setLocation] = useState<AppLocation>(initialLocation);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [storageWarning, setStorageWarning] = useState(() => hasStorageIssue() || !isStorageAvailable());
  const [, setBrokerRevision] = useState(0);
  const copy = getCopy(language);
  const mockPortfolio = getMockPortfolio(language);
  const dataStatus = aggregateDataStatus();
  const navigation: NavigationState = location.route === "trade"
    ? location.background ?? { route: "home" }
    : { route: location.route, symbol: location.symbol };
  const tradeRequest = location.route === "trade" ? { symbol: location.symbol } : null;

  useEffect(() => {
    const onStorageIssue = () => setStorageWarning(true);
    window.addEventListener(STORAGE_ISSUE_EVENT, onStorageIssue);
    return () => window.removeEventListener(STORAGE_ISSUE_EVENT, onStorageIssue);
  }, []);

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
    return MOCK_BROKER.subscribe(() => setBrokerRevision((current) => current + 1));
  }, []);

  useEffect(() => {
    MOCK_BROKER.setScenario(mockScenario);
    writeStored("mock-scenario", mockScenario);
  }, [mockScenario]);

  useEffect(() => {
    const canonicalLocation = parseLocationHash(window.location.hash);
    const canonicalHash = serializeLocation(canonicalLocation);
    if (window.location.hash !== canonicalHash || !window.history.state?.foliohelm) {
      const state: FolioHistoryState = { foliohelm: true, entry: "initial" };
      window.history.replaceState(state, "", canonicalHash);
    }

    const syncFromBrowser = () => {
      const nextLocation = parseLocationHash(window.location.hash);
      setSearchOpen(false);
      setLocation((current) => sameLocation(current, nextLocation) ? current : nextLocation);
    };

    window.addEventListener("popstate", syncFromBrowser);
    window.addEventListener("hashchange", syncFromBrowser);
    return () => {
      window.removeEventListener("popstate", syncFromBrowser);
      window.removeEventListener("hashchange", syncFromBrowser);
    };
  }, []);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const appContent = document.querySelector<HTMLElement>(".app-content");
    if (appContent) appContent.scrollTop = 0;
  }, [navigation.route, navigation.symbol]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

  const commitLocation = (nextLocation: AppLocation, mode: "push" | "replace" = "push") => {
    const nextHash = serializeLocation(nextLocation);
    if (window.location.hash !== nextHash) {
      const state: FolioHistoryState = {
        foliohelm: true,
        entry: mode === "push" && nextLocation.route === "trade" ? "trade-dialog" : "page",
      };
      if (mode === "replace") window.history.replaceState(state, "", nextHash);
      else window.history.pushState(state, "", nextHash);
    }
    setSearchOpen(false);
    setLocation((current) => sameLocation(current, nextLocation) ? current : nextLocation);
  };

  const navigate = (route: AppRoute, symbol?: string) => {
    if (route === "trade") {
      commitLocation({ route, symbol, background: navigation });
      return;
    }

    commitLocation({ route, symbol });
  };

  const closeTrade = () => {
    if (location.route !== "trade") return;
    const background = location.background ?? { route: "home" };
    if (isTradeDialogHistoryState(window.history.state)) {
      setSearchOpen(false);
      setLocation(background);
      window.history.back();
      return;
    }
    commitLocation(background, "replace");
  };

  const home = (
    <main className="home-page" data-testid="home-page">
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
    </main>
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
        activeRoute={location.route}
        onLanguageChange={setLanguage}
        onNavigate={navigate}
        onSearch={() => setSearchOpen(true)}
        persistenceWarning={storageWarning ? copy.localStorageWarning : undefined}
        onDismissPersistenceWarning={() => setStorageWarning(false)}
      >
        {dataStatus && <DataStateNotice language={language} status={dataStatus} />}
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
        <Modal
          className="trade-modal-window"
          backdropClassName="trade-modal-backdrop"
          labelledBy="trade-page-title"
          testId="trade-modal"
          onClose={closeTrade}
        >
          <TradePage
            key={tradeRequest.symbol ?? "default-trade"}
            language={language}
            initialSymbol={tradeRequest.symbol}
            onClose={closeTrade}
            onViewOrders={() => navigate("orders")}
          />
        </Modal>
      )}

    </>
  );
}
