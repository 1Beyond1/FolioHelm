import { readStored, removeStored, writeStored } from "../platform/storage";
import { ACCOUNT_STORE, DEFAULT_ACCOUNT_ID } from "./accounts";
import { AUTOMATION_CONTROLLER, normalizeAutomationState } from "./automation";
import type { BrokerOrder, BrokerOrderEvent, WorkspaceMode } from "./contracts";
import { loadPersistedAccountPortfolios, recordNavSnapshotsForPortfolio } from "./csvImport";
import { price, quantity } from "./decimal";
import { MOCK_BROKER } from "./mockBroker";
import { NAV_STORE } from "./nav";
import { hydrateCachedPublicQuotes, type PublicQuoteProviderChoice } from "./publicQuotes";
import {
  invokeVaultLoadPaperOrders,
  invokeVaultLoadSetting,
  invokeVaultSavePaperOrder,
  invokeVaultSaveSetting,
  invokeVaultStatus,
  isTauriRuntime,
  type TauriStoredPaperOrder,
  type TauriVaultStatus,
} from "./tauriBridge";

export const VAULT_HYDRATED_EVENT = "foliohelm:vault-hydrated";
export const WORKSPACE_PREFS_KEY = "workspace_preferences";
export const PROTECTIONS_SETTING_KEY = "protections";
export const AUTOMATION_SETTING_KEY = "automation";
export const REBALANCE_TARGETS_SETTING_KEY = "rebalance_targets";
const BROWSER_LOCAL_ORDERS_KEY = "local-csv-paper-orders";

export interface WorkspacePreferences {
  workspaceMode: WorkspaceMode;
  publicQuotesEnabled: boolean;
  quoteProvider: PublicQuoteProviderChoice;
  idleLockMinutes: number;
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  workspaceMode: "mock",
  publicQuotesEnabled: false,
  quoteProvider: "stooq",
  idleLockMinutes: 15,
};

export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_WORKSPACE_PREFERENCES };
  }
  const candidate = value as Partial<WorkspacePreferences>;
  const workspaceMode: WorkspaceMode =
    candidate.workspaceMode === "local-csv" ? "local-csv" : "mock";
  const publicQuotesEnabled = typeof candidate.publicQuotesEnabled === "boolean"
    ? candidate.publicQuotesEnabled
    : DEFAULT_WORKSPACE_PREFERENCES.publicQuotesEnabled;
  const quoteProvider: PublicQuoteProviderChoice =
    candidate.quoteProvider === "yahoo" ? "yahoo" : "stooq";
  const idleLockMinutes =
    typeof candidate.idleLockMinutes === "number"
    && Number.isSafeInteger(candidate.idleLockMinutes)
    && candidate.idleLockMinutes >= 0
    && candidate.idleLockMinutes <= 240
      ? candidate.idleLockMinutes
      : DEFAULT_WORKSPACE_PREFERENCES.idleLockMinutes;

  return {
    workspaceMode,
    publicQuotesEnabled,
    quoteProvider,
    idleLockMinutes,
  };
}

/**
 * Load a structured setting from the AES-256-GCM encrypted SQLite vault in Tauri
 * runtime, transparently migrating any legacy plaintext localStorage entry on first
 * read and removing the legacy plaintext copy once encrypted persistence succeeds.
 * Falls back cleanly to browser localStorage in browser previews and Vitest.
 */
export async function loadEncryptedSetting<T>(
  vaultKey: string,
  fallback: T,
  legacyLocalStorageKey?: string,
): Promise<T> {
  if (!isTauriRuntime()) {
    return legacyLocalStorageKey ? readStored<T>(legacyLocalStorageKey, fallback) : fallback;
  }

  try {
    const raw = await invokeVaultLoadSetting(vaultKey);
    if (raw !== null) {
      return JSON.parse(raw) as T;
    }
  } catch {
    // Fall through to legacy read or fallback without crashing UI.
  }

  if (legacyLocalStorageKey) {
    const sentinel = Symbol("missing");
    const legacy = readStored<T | typeof sentinel>(legacyLocalStorageKey, sentinel);
    if (legacy !== sentinel) {
      try {
        await invokeVaultSaveSetting(vaultKey, JSON.stringify(legacy));
        removeStored(legacyLocalStorageKey);
      } catch {
        // Vault may be locked; retain legacy value without data loss.
      }
      return legacy;
    }
  }

  return fallback;
}

/**
 * Persist a structured setting to the AES-256-GCM encrypted SQLite vault in Tauri
 * runtime, or browser localStorage in browser previews / tests.
 */
export async function saveEncryptedSetting<T>(
  vaultKey: string,
  value: T,
  legacyLocalStorageKey?: string,
): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      const ok = await invokeVaultSaveSetting(vaultKey, JSON.stringify(value));
      if (ok && legacyLocalStorageKey) {
        removeStored(legacyLocalStorageKey);
      }
      return ok;
    } catch {
      return false;
    }
  }
  return legacyLocalStorageKey ? writeStored(legacyLocalStorageKey, value) : true;
}

export async function loadWorkspacePreferences(): Promise<WorkspacePreferences> {
  const raw = await loadEncryptedSetting<unknown>(
    WORKSPACE_PREFS_KEY,
    DEFAULT_WORKSPACE_PREFERENCES,
    WORKSPACE_PREFS_KEY,
  );
  return normalizeWorkspacePreferences(raw);
}

export async function saveWorkspacePreferences(
  patch: Partial<WorkspacePreferences>,
): Promise<WorkspacePreferences> {
  const current = await loadWorkspacePreferences();
  const next = normalizeWorkspacePreferences({ ...current, ...patch });
  await saveEncryptedSetting(WORKSPACE_PREFS_KEY, next, WORKSPACE_PREFS_KEY);
  return next;
}

const ORDER_EVENT_KINDS = new Set<BrokerOrderEvent["kind"]>([
  "draft",
  "preview",
  "accepted",
  "fill",
  "canceled",
  "rejected",
  "unknown",
]);

function toStoredPaperOrder(workspaceMode: WorkspaceMode, order: BrokerOrder): TauriStoredPaperOrder {
  return {
    id: order.id,
    workspaceMode,
    accountId: order.accountId ?? DEFAULT_ACCOUNT_ID,
    symbol: order.symbol,
    side: order.side,
    orderType: order.type,
    quantity: order.quantity,
    filledQuantity: order.filledQuantity,
    limitPrice: order.limitPrice,
    currency: order.currency ?? "USD",
    status: order.status,
    submittedAt: order.submittedAt,
    events: order.events.map((event) => ({
      kind: event.kind,
      at: event.at,
      detailEn: event.detailEn,
      detailZh: event.detailZh,
    })),
  };
}

function fromStoredPaperOrder(raw: TauriStoredPaperOrder): BrokerOrder | null {
  try {
    if (!raw || typeof raw.id !== "string" || !raw.id.trim()) return null;
    if (raw.side !== "buy" && raw.side !== "sell") return null;
    if (raw.orderType !== "market" && raw.orderType !== "limit") return null;
    if (!["working", "filled", "canceled", "rejected", "unknown"].includes(raw.status)) return null;
    const normalizedCurrency = typeof raw.currency === "string" && raw.currency.trim()
      ? raw.currency.trim().toUpperCase()
      : "USD";
    const normalizedAccountId = typeof raw.accountId === "string" && raw.accountId.trim()
      ? raw.accountId.trim()
      : DEFAULT_ACCOUNT_ID;
    return {
      id: raw.id,
      accountId: normalizedAccountId,
      symbol: raw.symbol,
      side: raw.side,
      type: raw.orderType,
      quantity: quantity(raw.quantity),
      filledQuantity: quantity(raw.filledQuantity),
      limitPrice: raw.limitPrice === null ? null : price(raw.limitPrice),
      currency: normalizedCurrency,
      status: raw.status,
      submittedAt: raw.submittedAt,
      events: (Array.isArray(raw.events) ? raw.events : []).map((event) => ({
        kind: ORDER_EVENT_KINDS.has(event.kind as BrokerOrderEvent["kind"])
          ? event.kind as BrokerOrderEvent["kind"]
          : "accepted",
        at: event.at,
        detailEn: event.detailEn,
        detailZh: event.detailZh,
      })),
    };
  } catch {
    return null;
  }
}

export async function persistPaperOrder(
  workspaceMode: WorkspaceMode,
  order: BrokerOrder,
): Promise<boolean> {
  const stored = toStoredPaperOrder(workspaceMode, order);
  if (isTauriRuntime()) {
    try {
      return await invokeVaultSavePaperOrder(stored);
    } catch {
      return false;
    }
  }

  // In browser previews, keep Mock Demo orders volatile for test isolation while
  // persisting Local Portfolio (CSV + Paper) rehearsal orders locally.
  if (workspaceMode === "local-csv") {
    const existing = readStored<TauriStoredPaperOrder[]>(BROWSER_LOCAL_ORDERS_KEY, []);
    const next = [stored, ...existing.filter((item) => item.id !== stored.id)];
    return writeStored(BROWSER_LOCAL_ORDERS_KEY, next);
  }
  return true;
}

export async function loadPersistedPaperOrders(
  workspaceMode: WorkspaceMode,
): Promise<BrokerOrder[]> {
  let rawOrders: TauriStoredPaperOrder[] = [];
  if (isTauriRuntime()) {
    try {
      rawOrders = await invokeVaultLoadPaperOrders(workspaceMode);
    } catch {
      return [];
    }
  } else if (workspaceMode === "local-csv") {
    const saved = readStored<unknown>(BROWSER_LOCAL_ORDERS_KEY, []);
    rawOrders = Array.isArray(saved) ? saved as TauriStoredPaperOrder[] : [];
  }

  return rawOrders
    .map(fromStoredPaperOrder)
    .filter((order): order is BrokerOrder => order !== null);
}

export interface VaultHydrationResult {
  status: TauriVaultStatus | null;
  preferences: WorkspacePreferences;
}

/**
 * Synchronously scrubs all sensitive frontend domain memory (portfolios, quotes,
 * paper orders, automation rules, accounts, NAV snapshots, and benchmark caches).
 */
export function purgeAllFrontendSensitiveMemory(): void {
  MOCK_BROKER.purgeSensitiveMemory();
  AUTOMATION_CONTROLLER.purgeSensitiveMemory();
  ACCOUNT_STORE.purgeSensitiveMemory();
  NAV_STORE.purgeSensitiveMemory();
}

/**
 * Hydrate the entire workspace from the encrypted SQLite vault on desktop launch,
 * after unlocking a locked session, or after restoring a `.fhvault` backup.
 *
 * Always performs a complete replacement (never a union-merge) so stale pre-restore
 * or pre-lock holdings, paper orders, quotes, accounts, NAV snapshots, benchmarks,
 * or automation rules cannot survive in RAM.
 */
export async function hydrateWorkspaceFromVault(): Promise<VaultHydrationResult> {
  if (!isTauriRuntime()) {
    const preferences = await loadWorkspacePreferences();
    MOCK_BROKER.setPublicQuotesEnabled(preferences.publicQuotesEnabled);
    await Promise.all([
      ACCOUNT_STORE.hydrateAccountsFromVault().catch(() => []),
      NAV_STORE.hydrateFromVault().catch(() => {}),
    ]);
    const persistedPortfolios = await loadPersistedAccountPortfolios().catch(() => []);
    if (persistedPortfolios.length > 0) {
      ACCOUNT_STORE.replaceAll(ACCOUNT_STORE.getAccounts(), persistedPortfolios);
      MOCK_BROKER.applyAccountPortfolioSnapshots(persistedPortfolios, {
        switchMode: preferences.workspaceMode === "local-csv",
        resetOrders: true,
      });
      const localOrders = await loadPersistedPaperOrders("local-csv");
      MOCK_BROKER.hydratePaperOrders("local-csv", localOrders, { replace: true });
      for (const snap of persistedPortfolios) {
        await recordNavSnapshotsForPortfolio(snap, "portfolio-load").catch(() => {});
      }
    } else {
      ACCOUNT_STORE.replaceAll(ACCOUNT_STORE.getAccounts(), []);
      MOCK_BROKER.clearLocalPortfolio();
    }
    const storedAutomation = readStored<unknown>("automation", null);
    if (storedAutomation !== null) {
      AUTOMATION_CONTROLLER.replaceState(normalizeAutomationState(storedAutomation));
    } else {
      AUTOMATION_CONTROLLER.purgeSensitiveMemory();
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(VAULT_HYDRATED_EVENT, { detail: { status: null, preferences } }));
    }
    return { status: null, preferences };
  }

  const status = await invokeVaultStatus();
  if (!status.unlocked) {
    // Fail-Closed: purge any sensitive user data from the JS heap whenever vault is locked.
    purgeAllFrontendSensitiveMemory();
    return { status, preferences: { ...DEFAULT_WORKSPACE_PREFERENCES } };
  }

  const preferences = await loadWorkspacePreferences();

  // Restore public quote opt-in preference and completely replace encrypted quote cache first.
  MOCK_BROKER.setPublicQuotesEnabled(preferences.publicQuotesEnabled);
  await hydrateCachedPublicQuotes().catch(() => {
    MOCK_BROKER.replacePublicQuotes([]);
    return 0;
  });

  // Completely replace accounts, NAV snapshots, and cached benchmarks from encrypted SQLite.
  const [hydratedAccounts] = await Promise.all([
    ACCOUNT_STORE.hydrateAccountsFromVault().catch(() => ACCOUNT_STORE.getAccounts()),
    NAV_STORE.hydrateFromVault().catch(() => {}),
  ]);

  // Restore persisted local CSV portfolios per account (or clear stale portfolios if absent).
  const persistedPortfolios = await loadPersistedAccountPortfolios().catch(() => []);
  if (persistedPortfolios.length > 0) {
    ACCOUNT_STORE.replaceAll(hydratedAccounts, persistedPortfolios);
    const restoreLocalMode = preferences.workspaceMode === "local-csv";
    MOCK_BROKER.applyAccountPortfolioSnapshots(persistedPortfolios, {
      switchMode: restoreLocalMode,
      resetOrders: true,
    });
    for (const snap of persistedPortfolios) {
      await recordNavSnapshotsForPortfolio(snap, "portfolio-load").catch(() => {});
    }
  } else {
    ACCOUNT_STORE.replaceAll(hydratedAccounts, []);
    MOCK_BROKER.clearLocalPortfolio();
  }

  // Completely replace persisted paper orders for both isolated ledgers (never union-merge).
  const [localOrders, mockOrders] = await Promise.all([
    loadPersistedPaperOrders("local-csv"),
    loadPersistedPaperOrders("mock"),
  ]);
  MOCK_BROKER.hydratePaperOrders("local-csv", localOrders, { replace: true });
  MOCK_BROKER.hydratePaperOrders("mock", mockOrders, { replace: true });

  // Completely replace encrypted automation policy & run logs (reset to defaults if absent).
  const storedAutomation = await loadEncryptedSetting<unknown>(
    AUTOMATION_SETTING_KEY,
    null,
    "automation",
  );
  if (storedAutomation !== null) {
    AUTOMATION_CONTROLLER.replaceState(normalizeAutomationState(storedAutomation));
  } else {
    AUTOMATION_CONTROLLER.purgeSensitiveMemory();
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VAULT_HYDRATED_EVENT, { detail: { status, preferences } }));
  }

  return { status, preferences };
}
