import { MOCK_BROKER, type PublicQuoteUpdate } from "./mockBroker";
import {
  buildNavSnapshotsFromBrokerSnapshot,
  NAV_STORE,
  todayUtcIsoDate,
  type NavSnapshotRecord,
} from "./nav";
import { getCurrentLockEpoch, isCurrentLockEpoch } from "./sessionEpoch";
import {
  invokeDialogSaveFhvaultFile,
  invokeDialogSaveJsonFile,
  invokeQuotesFetchPublic,
  invokeQuotesLoadCached,
  isTauriRuntime,
} from "./tauriBridge";

export type PublicQuoteProviderChoice = "stooq" | "yahoo";

export interface PublicQuoteRefreshResult {
  updatedCount: number;
  fromCache: boolean;
  provider: string;
  asOfUtc: string | null;
  degradedReason?: string;
}

export type SaveJsonOutcome =
  | { kind: "native-saved"; path: string }
  | { kind: "canceled" }
  | { kind: "browser-download" };

/**
 * Refresh optional read-only delayed public quotes exclusively via the
 * Rust HTTPS-allowlisted backend. Never performs direct browser network calls
 * and degrades cleanly to cached or CSV baseline prices when offline.
 */
export async function refreshPublicQuotes(
  provider: PublicQuoteProviderChoice = "stooq",
): Promise<PublicQuoteRefreshResult> {
  const epoch = getCurrentLockEpoch();
  if (!MOCK_BROKER.isPublicQuotesEnabled()) {
    throw new Error("Public delayed quotes are disabled; enable them explicitly first");
  }

  const snapshot = MOCK_BROKER.getSnapshot();
  const symbolSet = new Set<string>();
  for (const holding of snapshot.holdings) symbolSet.add(holding.symbol.toUpperCase());
  for (const quote of snapshot.quotes) symbolSet.add(quote.symbol.toUpperCase());
  if (MOCK_BROKER.getWorkspaceMode() === "local-csv") {
    for (const acctId of MOCK_BROKER.getLocalAccountIds()) {
      try {
        const acctSnap = MOCK_BROKER.getAccountSnapshot(acctId);
        for (const holding of acctSnap.holdings) symbolSet.add(holding.symbol.toUpperCase());
      } catch {
        // Ignore single-account read errors while collecting symbol list.
      }
    }
  }
  const symbols = [...symbolSet].slice(0, 50);

  if (symbols.length === 0) {
    return {
      updatedCount: 0,
      fromCache: true,
      provider,
      asOfUtc: null,
      degradedReason: "No symbols available in the active portfolio",
    };
  }

  if (!isTauriRuntime()) {
    return {
      updatedCount: 0,
      fromCache: true,
      provider,
      asOfUtc: MOCK_BROKER.getPublicQuoteStatus().lastUpdatedUtc,
      degradedReason: "Direct browser networking is disabled; using local baseline or cached quotes",
    };
  }

  const response = await invokeQuotesFetchPublic(symbols, provider);
  // P0-3 Fail-Closed: discard stale pre-lock quote response if user/idle lock fired mid-flight.
  if (!isCurrentLockEpoch(epoch)) {
    return {
      updatedCount: 0,
      fromCache: true,
      provider: response.provider,
      asOfUtc: null,
      degradedReason: "Session locked",
    };
  }

  const updates: PublicQuoteUpdate[] = response.quotes.map((item) => ({
    symbol: item.symbol,
    price: item.price,
    change: item.change,
    changePct: item.changePct,
    currency: item.currency,
    asOfUtc: item.asOfUtc,
    provider: item.provider,
    delayed: item.delayed,
  }));

  const latestAsOf = updates.reduce<string | null>(
    (latest, item) => (!latest || item.asOfUtc > latest ? item.asOfUtc : latest),
    null,
  );

  if (updates.length > 0) {
    MOCK_BROKER.applyPublicQuotes(updates, response.provider);

    // P1-2: Record real mark-to-market `"quote-refresh"` NAV snapshots per concrete account
    // whenever fresh delayed public quotes update a local CSV portfolio (protected by lockEpoch).
    if (
      !response.fromCache
      && MOCK_BROKER.getWorkspaceMode() === "local-csv"
      && MOCK_BROKER.hasLocalPortfolio()
      && isCurrentLockEpoch(epoch)
    ) {
      const today = todayUtcIsoDate();
      const updatedAt = latestAsOf ?? new Date().toISOString();
      const navRecords: NavSnapshotRecord[] = [];
      for (const acctId of MOCK_BROKER.getLocalAccountIds()) {
        try {
          const acctSnap = MOCK_BROKER.getAccountSnapshot(acctId);
          navRecords.push(
            ...buildNavSnapshotsFromBrokerSnapshot(acctSnap, acctId, today, "quote-refresh", updatedAt),
          );
        } catch {
          // Skip invalid account without aborting quote refresh.
        }
      }
      if (navRecords.length > 0 && isCurrentLockEpoch(epoch)) {
        await NAV_STORE.recordSnapshots(navRecords, true).catch(() => undefined);
      }
    }
  }

  return {
    updatedCount: updates.length,
    fromCache: response.fromCache,
    provider: response.provider,
    asOfUtc: latestAsOf,
    degradedReason: response.degradedReason ?? undefined,
  };
}

export async function hydrateCachedPublicQuotes(): Promise<number> {
  const epoch = getCurrentLockEpoch();
  if (!isTauriRuntime()) return 0;
  const cached = await invokeQuotesLoadCached();
  // P0-3 Fail-Closed: discard stale pre-lock cached quotes if locked mid-flight.
  if (!isCurrentLockEpoch(epoch)) return 0;
  MOCK_BROKER.replacePublicQuotes(
    cached.map((item) => ({
      symbol: item.symbol,
      price: item.price,
      change: item.change,
      changePct: item.changePct,
      currency: item.currency,
      asOfUtc: item.asOfUtc,
      provider: item.provider,
      delayed: item.delayed,
    })),
    cached[0]?.provider,
  );
  return cached.length;
}

/**
 * Save a JSON export via the Tauri native save dialog when running on desktop,
 * or gracefully fall back to a deferred-revoke Blob download in browsers/tests.
 */
export async function saveJsonWithDialogOrBlob(
  defaultFileName: string,
  serialized: string,
): Promise<SaveJsonOutcome> {
  if (isTauriRuntime()) {
    const savedPath = await invokeDialogSaveJsonFile(defaultFileName, serialized);
    if (!savedPath) return { kind: "canceled" };
    return { kind: "native-saved", path: savedPath };
  }

  const blob = new Blob([serialized], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultFileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { kind: "browser-download" };
}

export async function saveFhvaultWithDialogOrBlob(
  defaultFileName: string,
  serialized: string,
): Promise<SaveJsonOutcome> {
  if (isTauriRuntime()) {
    const savedPath = await invokeDialogSaveFhvaultFile(defaultFileName, serialized);
    if (!savedPath) return { kind: "canceled" };
    return { kind: "native-saved", path: savedPath };
  }

  const blob = new Blob([serialized], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultFileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { kind: "browser-download" };
}
