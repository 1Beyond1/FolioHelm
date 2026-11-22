import { useCallback, useEffect, useRef, useState } from "react";
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
import { LockScreen } from "./components/LockScreen";
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
import { ACCOUNT_STORE } from "./domain/accounts";
import { decimalToNumber } from "./domain/decimal";
import {
  aggregateNavSnapshotsByCurrency,
  buildCalendarHeatmapFromNav,
  computeTwrSeries,
  NAV_STORE,
} from "./domain/nav";
import { appendEvidence } from "./domain/evidenceJournal";
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  hydrateWorkspaceFromVault,
  normalizeWorkspacePreferences,
  purgeAllFrontendSensitiveMemory,
  saveWorkspacePreferences,
  VAULT_HYDRATED_EVENT,
  WORKSPACE_PREFS_KEY,
  type VaultHydrationResult,
} from "./domain/vaultStorage";
import type { PublicQuoteProviderChoice } from "./domain/publicQuotes";
import {
  invokeVaultLock,
  invokeVaultStatus,
  invokeVaultUnlock,
  isTauriRuntime,
} from "./domain/tauriBridge";
import type { MockScenario, TradePrefill } from "./domain/contracts";

function initialLocation(): AppLocation {
  if (typeof window === "undefined") return { route: "home" };
  return parseLocationHash(window.location.hash);
}

function initialTheme(): ThemeMode {
  const stored = readStored<string>("theme", "system");
  return stored === "system" || stored === "dark" || stored === "light" ? stored : "system";
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

function syncThemeColor(): void {
  let themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeColor) {
    themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.appendChild(themeColor);
  }
  themeColor.content = document.documentElement.dataset.theme === "light" ? "#f4f5f0" : "#050505";
}

export function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = readStored<Language | null>("language", null);
    return stored === "en" || stored === "zh" ? stored : detectInitialLanguage();
  });
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [mockScenario, setMockScenario] = useState<MockScenario>(() => {
    const stored = readStored<string>("mock-scenario", "healthy");
    const resolved = MOCK_SCENARIOS.includes(stored as MockScenario) ? stored as MockScenario : "healthy";
    MOCK_BROKER.setScenario(resolved);
    return resolved;
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [location, setLocation] = useState<AppLocation>(initialLocation);
  const [tradePrefill, setTradePrefill] = useState<TradePrefill | null>(null);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [storageWarning, setStorageWarning] = useState(() => hasStorageIssue() || !isStorageAvailable());
  const [vaultLockedReason, setVaultLockedReason] = useState<string | null>(null);
  const [vaultErrorLocked, setVaultErrorLocked] = useState(false);
  const [userLocked, setUserLocked] = useState(false);
  const [lockTrigger, setLockTrigger] = useState<"manual" | "idle">("manual");
  const [lockedAtUtc, setLockedAtUtc] = useState<string | null>(null);
  const [hasLockPassphrase, setHasLockPassphrase] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [lockError, setLockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [idleLockMinutes, setIdleLockMinutes] = useState<number>(() =>
    !isTauriRuntime()
      ? normalizeWorkspacePreferences(readStored(WORKSPACE_PREFS_KEY, DEFAULT_WORKSPACE_PREFERENCES)).idleLockMinutes
      : DEFAULT_WORKSPACE_PREFERENCES.idleLockMinutes,
  );
  const [quoteProvider, setQuoteProvider] = useState<PublicQuoteProviderChoice>(() =>
    !isTauriRuntime()
      ? normalizeWorkspacePreferences(readStored(WORKSPACE_PREFS_KEY, DEFAULT_WORKSPACE_PREFERENCES)).quoteProvider
      : DEFAULT_WORKSPACE_PREFERENCES.quoteProvider,
  );
  const [selectedDashboardCurrency, setSelectedDashboardCurrency] = useState<string>("USD");
  const [selectedBenchmark, setSelectedBenchmark] = useState<string | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkNotice, setBenchmarkNotice] = useState<string | null>(null);
  const [, setBrokerRevision] = useState(0);
  const copy = getCopy(language);
  const navigation: NavigationState = location.route === "trade"
    ? location.background ?? { route: "home" }
    : { route: location.route, symbol: location.symbol };
  const tradeRequest = location.route === "trade" ? { symbol: location.symbol } : null;
  const vaultLockedWarning = vaultErrorLocked
    ? (vaultLockedReason
      ?? (language === "zh"
        ? "本地加密库已锁定：操作系统凭证密钥缺失或校验失败，已保留原密文并禁止覆盖。"
        : "Encrypted local vault is locked: OS credential key missing or integrity check failed; existing ciphertext was preserved."))
    : null;

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
    const applyThemeAndColor = () => {
      applyTheme(theme);
      syncThemeColor();
    };
    applyThemeAndColor();
    if (theme !== "system") return undefined;
    return watchSystemTheme(applyThemeAndColor);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  useEffect(() => {
    const bump = () => setBrokerRevision((current) => current + 1);
    const unsubBroker = MOCK_BROKER.subscribe(bump);
    const unsubAccounts = ACCOUNT_STORE.subscribe(bump);
    const unsubNav = NAV_STORE.subscribe(bump);
    return () => {
      unsubBroker();
      unsubAccounts();
      unsubNav();
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (isTauriRuntime()) {
      void (async () => {
        try {
          const { status, preferences } = await hydrateWorkspaceFromVault();
          if (!active) return;
          setIdleLockMinutes(preferences.idleLockMinutes);
          setQuoteProvider(preferences.quoteProvider);
          if (status) {
            setHasLockPassphrase(Boolean(status.hasLockPassphrase));
            setRetryAfterSeconds(status.retryAfterSeconds ?? 0);
            if (!status.unlocked) {
              if (status.lockState === "user-locked") {
                purgeAllFrontendSensitiveMemory();
                setSelectedBenchmark(null);
                setBenchmarkNotice(null);
                setTradePrefill(null);
                setSearchOpen(false);
                setUserLocked(true);
                setLockTrigger("manual");
                setRetryNonce((current) => current + 1);
                setVaultErrorLocked(false);
                setVaultLockedReason(null);
              } else {
                purgeAllFrontendSensitiveMemory();
                setSelectedBenchmark(null);
                setBenchmarkNotice(null);
                setVaultErrorLocked(true);
                setVaultLockedReason(status.lockedReason ?? null);
              }
            } else {
              setVaultErrorLocked(false);
              setVaultLockedReason(null);
            }
          }
        } catch {
          // Keep UI responsive; settings page surfaces explicit vault diagnostics.
        }
      })();
    }

    const onVaultHydrated = (event: Event) => {
      const detail = (event as CustomEvent<VaultHydrationResult>).detail;
      if (!detail) return;
      if (detail.preferences) {
        setIdleLockMinutes(detail.preferences.idleLockMinutes);
        setQuoteProvider(detail.preferences.quoteProvider);
      }
      if (detail.status) {
        setHasLockPassphrase(Boolean(detail.status.hasLockPassphrase));
        setRetryAfterSeconds(detail.status.retryAfterSeconds ?? 0);
      }
    };
    window.addEventListener(VAULT_HYDRATED_EVENT, onVaultHydrated);
    return () => {
      active = false;
      window.removeEventListener(VAULT_HYDRATED_EVENT, onVaultHydrated);
    };
  }, []);

  const lockSession = useCallback(async (trigger: "manual" | "idle") => {
    const mode = MOCK_BROKER.getWorkspaceMode();
    // P0-2 Fail-Closed: immediately wipe all sensitive user portfolio, quote, order,
    // automation, accounts, NAV snapshots, benchmark caches, and draft state from JS memory,
    // sanitize window title, and engage LockScreen synchronously BEFORE awaiting any IPC.
    purgeAllFrontendSensitiveMemory();
    setSelectedBenchmark(null);
    setBenchmarkNotice(null);
    setTradePrefill(null);
    setSearchOpen(false);
    setSettingsModalOpen(false);
    setLockTrigger(trigger);
    setLockedAtUtc(new Date().toISOString());
    setLockError(null);
    document.title = "FolioHelm — Locked";
    setUserLocked(true);
    if (isTauriRuntime()) {
      try {
        const status = await invokeVaultLock(trigger, mode);
        setHasLockPassphrase(Boolean(status.hasLockPassphrase));
        setRetryAfterSeconds(status.retryAfterSeconds ?? 0);
        setRetryNonce((current) => current + 1);
      } catch {
        // LockScreen is already engaged fail-closed even if IPC reports already locked or fails.
      }
      return;
    }
    setHasLockPassphrase(false);
    setRetryAfterSeconds(0);
    await appendEvidence("session_locked", { trigger, mode }).catch(() => {});
  }, []);

  const lockSessionRef = useRef(lockSession);
  useEffect(() => {
    lockSessionRef.current = lockSession;
  }, [lockSession]);

  const unlockSession = useCallback(async (passphrase: string) => {
    setUnlocking(true);
    setLockError(null);
    if (!isTauriRuntime()) {
      await hydrateWorkspaceFromVault().catch(() => {});
      setUserLocked(false);
      setRetryAfterSeconds(0);
      setUnlocking(false);
      return;
    }

    try {
      const status = await invokeVaultUnlock(passphrase);
      if (status.unlocked) {
        setHasLockPassphrase(Boolean(status.hasLockPassphrase));
        setRetryAfterSeconds(0);
        setLockError(null);
        await hydrateWorkspaceFromVault().catch(() => {});
        setUserLocked(false);
      } else {
        setRetryAfterSeconds(status.retryAfterSeconds ?? 0);
        setRetryNonce((current) => current + 1);
        setLockError(
          status.lockedReason
            ?? (language === "zh" ? "解锁失败，请重试。" : "Unlock failed. Please try again."),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let backoffSeconds = 0;
      const status = await invokeVaultStatus().catch(() => null);
      if (status) {
        setHasLockPassphrase(Boolean(status.hasLockPassphrase));
        backoffSeconds = status.retryAfterSeconds ?? 0;
      }
      if (backoffSeconds === 0) {
        const match = message.match(/(\d+)\s*seconds?/i);
        if (match) backoffSeconds = Number(match[1]) || 0;
      }
      setRetryAfterSeconds(backoffSeconds);
      setRetryNonce((current) => current + 1);
      setLockError(message);
    } finally {
      setUnlocking(false);
    }
  }, [language]);

  useEffect(() => {
    if (userLocked || idleLockMinutes <= 0) return undefined;
    const timeoutMs = idleLockMinutes * 60 * 1000;
    let lastActivityAt = Date.now();
    let locked = false;

    const triggerIdleLock = () => {
      if (locked) return;
      locked = true;
      void lockSessionRef.current("idle");
    };

    const checkIdle = (): boolean => {
      if (Date.now() - lastActivityAt >= timeoutMs) {
        triggerIdleLock();
        return true;
      }
      return false;
    };

    let timer = window.setTimeout(() => {
      if (!checkIdle()) scheduleNext();
    }, timeoutMs);

    const scheduleNext = () => {
      window.clearTimeout(timer);
      if (locked) return;
      const remaining = Math.max(0, timeoutMs - (Date.now() - lastActivityAt));
      if (remaining === 0) {
        triggerIdleLock();
        return;
      }
      timer = window.setTimeout(() => {
        if (!checkIdle()) scheduleNext();
      }, remaining);
    };

    const onActivity = () => {
      // Check wall-clock elapsed time BEFORE updating lastActivityAt so sleep/wake
      // or throttled timers can never be bypassed by an immediate click/keypress.
      if (checkIdle()) return;
      lastActivityAt = Date.now();
      scheduleNext();
    };

    const onFocusOrVisibility = () => {
      if (document.visibilityState === "hidden") return;
      // Never reset lastActivityAt on focus or visibilitychange; enforce wall-clock deadline.
      if (!checkIdle()) {
        scheduleNext();
      }
    };

    const heartbeatMs = Math.min(30_000, Math.max(1_000, Math.floor(timeoutMs / 4)));
    const heartbeat = window.setInterval(() => {
      checkIdle();
    }, heartbeatMs);

    const activityEvents = ["pointerdown", "keydown", "wheel"] as const;
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, onActivity, { passive: true });
    }
    window.addEventListener("focus", onFocusOrVisibility, { passive: true });
    document.addEventListener("visibilitychange", onFocusOrVisibility);

    return () => {
      locked = true;
      window.clearTimeout(timer);
      window.clearInterval(heartbeat);
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, onActivity);
      }
      window.removeEventListener("focus", onFocusOrVisibility);
      document.removeEventListener("visibilitychange", onFocusOrVisibility);
    };
  }, [idleLockMinutes, userLocked]);

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
    if (userLocked) {
      document.title = "FolioHelm — Locked";
      return;
    }
    let pageTitle: string;
    switch (location.route) {
      case "home":
        pageTitle = language === "zh" ? "首页" : "Portfolio Home";
        break;
      case "instrument":
        pageTitle = navigation.symbol
          ? `${navigation.symbol} · ${language === "zh" ? "证券详情" : "Instrument"}`
          : copy.markets;
        break;
      case "trade":
        pageTitle = language === "zh" ? "交易" : "Trade";
        break;
      case "markets":
        pageTitle = copy.markets;
        break;
      case "portfolio":
        pageTitle = copy.portfolio;
        break;
      case "orders":
        pageTitle = copy.orders;
        break;
      case "automation":
        pageTitle = copy.automation;
        break;
      case "settings":
        pageTitle = copy.settings;
        break;
      default:
        pageTitle = copy.home;
    }
    document.title = `FolioHelm — ${pageTitle}`;
  }, [copy, language, location.route, navigation.symbol, userLocked]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !userLocked
        && !searchOpen
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
  }, [searchOpen, settingsModalOpen, tradeRequest, userLocked]);

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

  const navigate = (route: AppRoute, symbol?: string, prefill?: TradePrefill) => {
    const trimmedSymbol = symbol?.trim() || prefill?.symbol?.trim() || undefined;
    if (route === "trade") {
      setTradePrefill(prefill ?? null);
      commitLocation({ route, symbol: trimmedSymbol, background: navigation });
      return;
    }

    setTradePrefill(null);
    if (route === "instrument" && !trimmedSymbol) {
      commitLocation({ route: "markets" });
      return;
    }

    commitLocation({ route, symbol: route === "instrument" ? trimmedSymbol : undefined });
  };

  const closeTrade = () => {
    setTradePrefill(null);
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

  if (userLocked) {
    return (
      <LockScreen
        language={language}
        trigger={lockTrigger}
        hasPassphrase={hasLockPassphrase}
        lockedAtUtc={lockedAtUtc}
        retryAfterSeconds={retryAfterSeconds}
        retryNonce={retryNonce}
        errorMessage={lockError}
        unlocking={unlocking}
        onUnlock={unlockSession}
      />
    );
  }

  const mockPortfolio = getMockPortfolio(language);
  const workspaceMode = MOCK_BROKER.getWorkspaceMode();
  const isLocalMode = workspaceMode === "local-csv";
  const publicQuotesEnabled = MOCK_BROKER.isPublicQuotesEnabled();
  const dataStatus = aggregateDataStatus();

  const rawSnapshot = MOCK_BROKER.getSnapshot();
  const localAccounts = ACCOUNT_STORE.getAccounts();
  const selectedAccountId = MOCK_BROKER.getSelectedAccountId();
  const availableCurrencies = (() => {
    const fromBreakdowns = (rawSnapshot.account.currencyBreakdowns ?? [])
      .map((b) => b.currency.toUpperCase())
      .filter((c) => c && c !== "MULTI");
    if (fromBreakdowns.length > 0) return [...new Set(fromBreakdowns)].sort();
    const fallback = rawSnapshot.account.currency && rawSnapshot.account.currency !== "MULTI"
      ? rawSnapshot.account.currency.toUpperCase()
      : "USD";
    return [fallback];
  })();
  const activeNavCurrency = availableCurrencies.includes(selectedDashboardCurrency)
    ? selectedDashboardCurrency
    : availableCurrencies[0]!;

  const localNavSnapshots = isLocalMode
    ? aggregateNavSnapshotsByCurrency(NAV_STORE.getAllSnapshots(), activeNavCurrency, selectedAccountId)
    : [];
  const localTwrSeries = isLocalMode
    ? computeTwrSeries(localNavSnapshots, activeNavCurrency, selectedAccountId)
    : null;
  const localHeatmapBundle = isLocalMode && localTwrSeries
    ? buildCalendarHeatmapFromNav(localTwrSeries, rawSnapshot.orders)
    : null;

  const heatmapEntries = localHeatmapBundle
    ? localHeatmapBundle.entries.map((entry) => ({
        date: entry.date,
        dataStatus: entry.status,
        level: entry.activityLevel,
        actions: entry.actions,
        dailyReturnPct: entry.dailyReturnPct === null ? null : decimalToNumber(entry.dailyReturnPct),
        dailyReturnUsd: entry.dailyReturnUsd === null ? null : decimalToNumber(entry.dailyReturnUsd),
      }))
    : mockPortfolio.heatmap;

  const handleRefreshBenchmark = async (symbol: string) => {
    setBenchmarkLoading(true);
    setBenchmarkNotice(null);
    try {
      const outcome = await NAV_STORE.syncBenchmarkHistory(symbol, quoteProvider);
      if (outcome.degradedReason) {
        setBenchmarkNotice(
          outcome.series
            ? (language === "zh"
                ? `离线降级：使用本地加密缓存的 ${symbol} 历史（${outcome.degradedReason}）`
                : `Degraded to cached ${symbol} history (${outcome.degradedReason})`)
            : (language === "zh"
                ? `${symbol} 基准行情当前不可用（${outcome.degradedReason}）`
                : `${symbol} benchmark unavailable (${outcome.degradedReason})`),
        );
      } else {
        setBenchmarkNotice(null);
      }
    } catch (error) {
      setBenchmarkNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBenchmarkLoading(false);
    }
  };

  const home = (
    <main className="home-page" data-testid="home-page">
      <PortfolioHero
        copy={copy}
        language={language}
        data={mockPortfolio}
        onNavigate={navigate}
        onSearch={() => setSearchOpen(true)}
        localNav={isLocalMode ? {
          accounts: localAccounts,
          selectedAccountId,
          onSelectAccount: (acctId) => {
            ACCOUNT_STORE.setSelectedAccountId(acctId);
            MOCK_BROKER.setSelectedAccountId(acctId);
            setBenchmarkNotice(null);
          },
          availableCurrencies,
          activeCurrency: activeNavCurrency,
          onSelectCurrency: (curr) => {
            setSelectedDashboardCurrency(curr);
            setSelectedBenchmark(null);
            setBenchmarkNotice(null);
          },
          snapshots: localNavSnapshots,
          selectedBenchmark,
          benchmarkSeries: selectedBenchmark ? NAV_STORE.getBenchmark(selectedBenchmark) : null,
          benchmarkLoading,
          benchmarkNotice,
          onSelectBenchmark: (sym) => {
            setSelectedBenchmark(sym);
            setBenchmarkNotice(null);
          },
          onRefreshBenchmark: (sym) => void handleRefreshBenchmark(sym),
        } : undefined}
      />

      <section className="content-grid" aria-label={copy.portfolio}>
        <InvestingHeatmap
          copy={copy}
          language={language}
          entries={heatmapEntries}
          activeDays={localHeatmapBundle ? localHeatmapBundle.activeDays : mockPortfolio.activeDays}
          ordersFilled={localHeatmapBundle ? localHeatmapBundle.ordersFilled : mockPortfolio.ordersFilled}
          netChange={localHeatmapBundle ? decimalToNumber(localHeatmapBundle.yearNetChange) : mockPortfolio.netChange}
          currency={isLocalMode ? activeNavCurrency : mockPortfolio.currency}
          isMultiCurrency={isLocalMode ? false : mockPortfolio.isMultiCurrency}
          localNavSummary={isLocalMode && localTwrSeries ? {
            snapshotCount: localTwrSeries.snapshotCount,
            hasEnoughPoints: localTwrSeries.hasEnoughPoints,
            currency: activeNavCurrency,
          } : undefined}
        />
        <aside className="side-stack">
          <PositionsCard
            copy={copy}
            language={language}
            positions={mockPortfolio.positions}
            onOpenInstrument={(symbol) => navigate("instrument", symbol)}
            onViewAll={() => navigate("portfolio")}
          />
          <ActivityCard copy={copy} language={language} activity={mockPortfolio.activity} onViewAll={() => navigate("orders")} />
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
        if (!navigation.symbol) {
          return (
            <MarketsPage
              language={language}
              onOpenInstrument={(symbol) => navigate("instrument", symbol)}
              onOpenTrade={(symbol) => navigate("trade", symbol)}
            />
          );
        }
        return (
          <InstrumentPage
            language={language}
            symbol={navigation.symbol}
            onBack={() => navigate("markets")}
            onOpenTrade={(symbol) => navigate("trade", symbol)}
          />
        );
      case "portfolio":
        return (
          <PortfolioPage
            language={language}
            onOpenInstrument={(symbol) => navigate("instrument", symbol)}
            onOpenTrade={(symbol, prefill) => navigate("trade", symbol, prefill)}
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
            idleLockMinutes={idleLockMinutes}
            onIdleLockMinutesChange={(minutes) => {
              setIdleLockMinutes(minutes);
              void saveWorkspacePreferences({ idleLockMinutes: minutes });
            }}
            onLockSession={(trigger) => void lockSession(trigger)}
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
        activeRoute={navigation.route}
        onLanguageChange={setLanguage}
        onNavigate={navigate}
        onSearch={() => setSearchOpen(true)}
        onLock={() => void lockSession("manual")}
        dataStatus={dataStatus}
        workspaceMode={workspaceMode}
        publicQuotesEnabled={publicQuotesEnabled}
        persistenceWarning={vaultLockedWarning ?? (storageWarning ? copy.localStorageWarning : undefined)}
        onDismissPersistenceWarning={vaultErrorLocked ? undefined : () => setStorageWarning(false)}
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
            key={`${tradeRequest.symbol ?? "default-trade"}:${tradePrefill?.side ?? ""}:${tradePrefill?.quantity ?? ""}`}
            language={language}
            initialSymbol={tradeRequest.symbol}
            initialPrefill={tradePrefill ?? undefined}
            onClose={closeTrade}
            onViewOrders={() => navigate("orders")}
          />
        </Modal>
      )}

    </>
  );
}
