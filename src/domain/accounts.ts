/**
 * Multi-account local portfolio store & pure exact-Decimal aggregation engine.
 *
 * Security & financial invariants:
 * - Zero IEEE-754 floating-point math: cross-account holdings aggregation and
 *   weighted average cost basis use exact `src/domain/decimal.ts` arithmetic.
 * - Cross-currency cash and market values are strictly isolated per currency
 *   code (`USD` / `HKD` / `CNY` ...) and NEVER summed across currencies.
 * - Smoothly maps legacy single-account snapshots without `accountId` to
 *   `DEFAULT_ACCOUNT_ID` (`"acct_default"`).
 * - `ACCOUNT_STORE.purgeSensitiveMemory()` synchronously wipes all accounts and
 *   per-account snapshot caches from the JS heap on App Lock.
 */
import { readStored, removeStored, writeStored } from "../platform/storage";
import {
  aggregatePortfolioSnapshots,
  ALL_ACCOUNTS_ID,
  DEFAULT_ACCOUNT_ID,
} from "./accountAggregation";
import { MOCK_BROKER, registerBrokerResetHook } from "./mockBroker";
import { NAV_STORE } from "./nav";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "./sessionEpoch";
import {
  invokeVaultDeleteAccount,
  invokeVaultListAccounts,
  invokeVaultSaveAccount,
  isTauriRuntime,
  type TauriStoredAccount,
  type TauriStoredPaperOrder,
  type TauriStoredPortfolioSnapshot,
} from "./tauriBridge";

export { aggregatePortfolioSnapshots, ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID };

const BROWSER_ACCOUNTS_KEY = "local-accounts";
const BROWSER_ACCOUNT_SNAPSHOTS_KEY = "local-account-portfolios";
const BROWSER_LOCAL_ORDERS_KEY = "local-csv-paper-orders";
const BROWSER_LEGACY_PORTFOLIO_KEY = "local-csv-portfolio";

export type AccountType = "taxable" | "ira" | "roth_ira" | "margin" | "cash" | "general";

export interface BrokerAccountProfile {
  id: string;
  name: string;
  broker: string;
  accountType: string;
  baseCurrency: string;
  createdAt: string;
}

export interface AccountPreset {
  name: string;
  broker: string;
  accountType: AccountType;
  baseCurrency: string;
}

export const ACCOUNT_PRESETS: readonly AccountPreset[] = [
  { name: "Schwab Taxable", broker: "Schwab", accountType: "taxable", baseCurrency: "USD" },
  { name: "Schwab IRA", broker: "Schwab", accountType: "ira", baseCurrency: "USD" },
  { name: "Futu HK", broker: "Futu", accountType: "taxable", baseCurrency: "HKD" },
  { name: "IBKR Margin", broker: "IBKR", accountType: "margin", baseCurrency: "USD" },
];

export function createDefaultAccount(baseCurrency = "USD"): BrokerAccountProfile {
  return {
    id: DEFAULT_ACCOUNT_ID,
    name: "Default Account",
    broker: "Local CSV",
    accountType: "taxable",
    baseCurrency,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

export function slugifyAccountId(name: string, existingIds: ReadonlySet<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  const base = slug ? `acct_${slug}` : "acct_custom";
  if (!existingIds.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}_${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `acct_${Date.now()}`;
}

class AccountStore {
  private accounts = new Map<string, BrokerAccountProfile>([
    [DEFAULT_ACCOUNT_ID, createDefaultAccount()],
  ]);
  private snapshotsByAccount = new Map<string, TauriStoredPortfolioSnapshot>();
  private selectedAccountId: string = ALL_ACCOUNTS_ID;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Ignore observer errors.
      }
    }
  }

  getAccounts(): BrokerAccountProfile[] {
    return [...this.accounts.values()].sort((a, b) => {
      if (a.id === DEFAULT_ACCOUNT_ID) return -1;
      if (b.id === DEFAULT_ACCOUNT_ID) return 1;
      return a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name);
    });
  }

  getAccount(accountId: string): BrokerAccountProfile | undefined {
    return this.accounts.get(accountId);
  }

  getSelectedAccountId(): string {
    return this.selectedAccountId;
  }

  setSelectedAccountId(accountId: string): void {
    const target = accountId === ALL_ACCOUNTS_ID || this.accounts.has(accountId)
      ? accountId
      : ALL_ACCOUNTS_ID;
    if (this.selectedAccountId === target) return;
    this.selectedAccountId = target;
    this.notify();
  }

  getSnapshotForAccount(accountId: string): TauriStoredPortfolioSnapshot | null {
    return this.snapshotsByAccount.get(accountId) ?? null;
  }

  getAllAccountSnapshots(): TauriStoredPortfolioSnapshot[] {
    return [...this.snapshotsByAccount.values()];
  }

  getActiveEffectiveSnapshot(): TauriStoredPortfolioSnapshot | null {
    if (this.snapshotsByAccount.size === 0) return null;
    if (this.selectedAccountId === ALL_ACCOUNTS_ID) {
      return aggregatePortfolioSnapshots([...this.snapshotsByAccount.values()]);
    }
    return this.snapshotsByAccount.get(this.selectedAccountId) ?? null;
  }

  registerAccountSnapshot(snapshot: TauriStoredPortfolioSnapshot): void {
    const acctId = snapshot.accountId?.trim() || DEFAULT_ACCOUNT_ID;
    const normalizedSnap: TauriStoredPortfolioSnapshot = {
      ...snapshot,
      accountId: acctId,
    };
    if (!this.accounts.has(acctId)) {
      const baseCurr = snapshot.currency && snapshot.currency !== "MULTI"
        ? snapshot.currency
        : (snapshot.currencies?.[0] ?? "USD");
      this.accounts.set(acctId, {
        id: acctId,
        name: snapshot.accountLabel && snapshot.accountLabel !== "Local Portfolio (CSV + Paper)"
          ? snapshot.accountLabel
          : acctId === DEFAULT_ACCOUNT_ID
            ? "Default Account"
            : acctId,
        broker: "Local CSV",
        accountType: "taxable",
        baseCurrency: baseCurr,
        createdAt: snapshot.importedAtUtc || new Date().toISOString(),
      });
    }
    this.snapshotsByAccount.set(acctId, normalizedSnap);
    if (!isTauriRuntime()) {
      this.persistBrowserState();
    }
    this.notify();
  }

  replaceAll(
    accounts: readonly BrokerAccountProfile[],
    snapshots: readonly TauriStoredPortfolioSnapshot[],
    selectedAccountId?: string,
  ): void {
    this.accounts.clear();
    for (const acct of accounts) {
      if (acct && typeof acct.id === "string" && acct.id.trim()) {
        this.accounts.set(acct.id.trim(), { ...acct, id: acct.id.trim() });
      }
    }
    if (this.accounts.size === 0) {
      this.accounts.set(DEFAULT_ACCOUNT_ID, createDefaultAccount());
    }

    this.snapshotsByAccount.clear();
    for (const snap of snapshots) {
      const acctId = snap.accountId?.trim() || DEFAULT_ACCOUNT_ID;
      if (!this.accounts.has(acctId)) {
        this.accounts.set(acctId, {
          id: acctId,
          name: snap.accountLabel || acctId,
          broker: "Local CSV",
          accountType: "taxable",
          baseCurrency: snap.currency && snap.currency !== "MULTI" ? snap.currency : "USD",
          createdAt: snap.importedAtUtc || new Date().toISOString(),
        });
      }
      this.snapshotsByAccount.set(acctId, { ...snap, accountId: acctId });
    }

    if (selectedAccountId && (selectedAccountId === ALL_ACCOUNTS_ID || this.accounts.has(selectedAccountId))) {
      this.selectedAccountId = selectedAccountId;
    } else if (this.selectedAccountId !== ALL_ACCOUNTS_ID && !this.accounts.has(this.selectedAccountId)) {
      this.selectedAccountId = ALL_ACCOUNTS_ID;
    }
    this.notify();
  }

  async createOrUpdateAccount(input: {
    id?: string;
    name: string;
    broker: string;
    accountType: string;
    baseCurrency: string;
  }): Promise<BrokerAccountProfile> {
    const epoch = getCurrentLockEpoch();
    const trimmedName = input.name.trim();
    if (!trimmedName) throw new Error("Account name is required");
    const existingIds = new Set(this.accounts.keys());
    const id = input.id?.trim() || slugifyAccountId(trimmedName, existingIds);
    const existing = this.accounts.get(id);
    const profile: BrokerAccountProfile = {
      id,
      name: trimmedName.slice(0, 80),
      broker: (input.broker.trim() || "Local CSV").slice(0, 64),
      accountType: (input.accountType.trim() || "taxable").slice(0, 32),
      baseCurrency: (input.baseCurrency.trim().toUpperCase() || "USD").replace(/[^A-Z]/g, "").slice(0, 5) || "USD",
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    if (isTauriRuntime()) {
      const saved = await invokeVaultSaveAccount(profile as TauriStoredAccount);
      // P0-3 Fail-Closed: discard stale post-lock account mutation.
      if (!isCurrentLockEpoch(epoch)) return saved;
      this.accounts.set(saved.id, saved);
      this.notify();
      return saved;
    }

    if (!isCurrentLockEpoch(epoch)) return profile;
    this.accounts.set(profile.id, profile);
    this.persistBrowserState();
    this.notify();
    return profile;
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const epoch = getCurrentLockEpoch();
    const trimmed = accountId.trim();
    if (!trimmed || trimmed === DEFAULT_ACCOUNT_ID) return false;
    if (isTauriRuntime()) {
      const ok = await invokeVaultDeleteAccount(trimmed);
      if (!isCurrentLockEpoch(epoch)) return false;
      if (!ok) return false;
    }
    if (!isCurrentLockEpoch(epoch)) return false;
    this.accounts.delete(trimmed);
    this.snapshotsByAccount.delete(trimmed);
    if (this.selectedAccountId === trimmed) {
      this.selectedAccountId = ALL_ACCOUNTS_ID;
    }
    // P1-7: Synchronously purge deleted account's snapshots, paper orders, and NAV history
    // across MOCK_BROKER, NAV_STORE, and browser localStorage.
    MOCK_BROKER.removeLocalAccount(trimmed);
    NAV_STORE.removeAccountSnapshots(trimmed);
    if (!isTauriRuntime()) {
      this.persistBrowserState();
      const remainingSnapshots = this.getAllAccountSnapshots();
      if (remainingSnapshots.length === 0) {
        removeStored(BROWSER_LEGACY_PORTFOLIO_KEY);
      } else {
        const legacy = readStored<TauriStoredPortfolioSnapshot | null>(BROWSER_LEGACY_PORTFOLIO_KEY, null);
        if (legacy && (legacy.accountId?.trim() || DEFAULT_ACCOUNT_ID) === trimmed) {
          writeStored(BROWSER_LEGACY_PORTFOLIO_KEY, remainingSnapshots[0]);
        }
      }
      const storedOrders = readStored<unknown>(BROWSER_LOCAL_ORDERS_KEY, []);
      if (Array.isArray(storedOrders)) {
        const remaining = (storedOrders as TauriStoredPaperOrder[]).filter(
          (order) => (order?.accountId ?? DEFAULT_ACCOUNT_ID) !== trimmed,
        );
        writeStored(BROWSER_LOCAL_ORDERS_KEY, remaining);
      }
    }
    this.notify();
    return true;
  }

  async hydrateAccountsFromVault(): Promise<BrokerAccountProfile[]> {
    const epoch = getCurrentLockEpoch();
    if (isTauriRuntime()) {
      const raw = await invokeVaultListAccounts().catch(() => null);
      // P0-3 Fail-Closed: discard stale pre-lock hydration if locked mid-flight.
      if (!isCurrentLockEpoch(epoch)) return [];
      if (Array.isArray(raw) && raw.length > 0) {
        this.accounts.clear();
        for (const item of raw) {
          this.accounts.set(item.id, { ...item });
        }
        this.notify();
        return this.getAccounts();
      }
      return this.getAccounts();
    }

    if (!isCurrentLockEpoch(epoch)) return [];
    const storedAccounts = readStored<unknown>(BROWSER_ACCOUNTS_KEY, []);
    const storedSnapshots = readStored<unknown>(BROWSER_ACCOUNT_SNAPSHOTS_KEY, []);
    if (Array.isArray(storedAccounts) && storedAccounts.length > 0) {
      this.accounts.clear();
      for (const acct of storedAccounts as BrokerAccountProfile[]) {
        if (acct?.id) this.accounts.set(acct.id, acct);
      }
    }
    if (Array.isArray(storedSnapshots)) {
      this.snapshotsByAccount.clear();
      for (const snap of storedSnapshots as TauriStoredPortfolioSnapshot[]) {
        if (snap?.id) {
          const acctId = snap.accountId?.trim() || DEFAULT_ACCOUNT_ID;
          this.snapshotsByAccount.set(acctId, { ...snap, accountId: acctId });
        }
      }
    }
    if (this.accounts.size === 0) {
      this.accounts.set(DEFAULT_ACCOUNT_ID, createDefaultAccount());
    }
    this.notify();
    return this.getAccounts();
  }

  /**
   * Synchronously scrubs all account profiles and per-account snapshots from JS RAM
   * (invoked on App Lock and fail-closed vault lock).
   */
  purgeSensitiveMemory(): void {
    this.accounts.clear();
    this.accounts.set(DEFAULT_ACCOUNT_ID, createDefaultAccount());
    this.snapshotsByAccount.clear();
    this.selectedAccountId = ALL_ACCOUNTS_ID;
    this.notify();
  }

  clearAll(): void {
    this.purgeSensitiveMemory();
    if (!isTauriRuntime()) {
      removeStored(BROWSER_ACCOUNTS_KEY);
      removeStored(BROWSER_ACCOUNT_SNAPSHOTS_KEY);
    }
  }

  private persistBrowserState(): void {
    writeStored(BROWSER_ACCOUNTS_KEY, this.getAccounts());
    writeStored(BROWSER_ACCOUNT_SNAPSHOTS_KEY, this.getAllAccountSnapshots());
  }
}

export const ACCOUNT_STORE = new AccountStore();
registerBrokerResetHook(() => ACCOUNT_STORE.purgeSensitiveMemory());
