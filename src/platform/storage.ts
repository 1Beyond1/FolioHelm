/**
 * Small, defensive persistence boundary for non-sensitive local preferences.
 *
 * This module must never be used for brokerage credentials, access tokens,
 * refresh tokens, cookies, or any other secret. It is intentionally limited to
 * user-interface preferences and Mock/Paper simulation state.
 */

const PREFIX = "foliohelm.v1.";
const PROBE_KEY = `${PREFIX}storage-probe`;

export const STORAGE_ISSUE_EVENT = "foliohelm:storage-issue";

export interface StorageIssueDetail {
  operation: "read" | "write" | "remove" | "clear";
  key?: string;
}

let storageIssueObserved = false;

function reportStorageIssue(detail: StorageIssueDetail): void {
  storageIssueObserved = true;
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent<StorageIssueDetail>(STORAGE_ISSUE_EVENT, { detail }));
}

function storage(): Storage | undefined {
  try {
    if (typeof window === "undefined" || !window.localStorage) return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStored<T>(key: string, fallback: T): T {
  const store = storage();
  if (!store) {
    reportStorageIssue({ operation: "read", key });
    return fallback;
  }

  try {
    const raw = store.getItem(`${PREFIX}${key}`);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    reportStorageIssue({ operation: "read", key });
    return fallback;
  }
}

export function writeStored<T>(key: string, value: T): boolean {
  const store = storage();
  if (!store) {
    reportStorageIssue({ operation: "write", key });
    return false;
  }

  try {
    store.setItem(`${PREFIX}${key}`, JSON.stringify(value));
    return true;
  } catch {
    reportStorageIssue({ operation: "write", key });
    return false;
  }
}

export function removeStored(key: string): boolean {
  const store = storage();
  if (!store) {
    reportStorageIssue({ operation: "remove", key });
    return false;
  }

  try {
    store.removeItem(`${PREFIX}${key}`);
    return true;
  } catch {
    reportStorageIssue({ operation: "remove", key });
    return false;
  }
}

export function clearFolioHelmStored(): boolean {
  const store = storage();
  if (!store) {
    reportStorageIssue({ operation: "clear" });
    return false;
  }

  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
    return true;
  } catch {
    reportStorageIssue({ operation: "clear" });
    return false;
  }
}

export function isStorageAvailable(): boolean {
  const store = storage();
  if (!store) return false;

  try {
    store.setItem(PROBE_KEY, "1");
    store.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasStorageIssue(): boolean {
  return storageIssueObserved;
}

export const STORAGE_PREFIX = PREFIX;
