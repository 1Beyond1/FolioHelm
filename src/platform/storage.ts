/**
 * Small, defensive persistence boundary for non-sensitive local preferences.
 *
 * This module must never be used for brokerage credentials, access tokens,
 * refresh tokens, cookies, or any other secret. It is intentionally limited to
 * user-interface preferences and Mock/Paper simulation state.
 */

const PREFIX = "foliohelm.v1.";

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
  if (!store) return fallback;

  try {
    const raw = store.getItem(`${PREFIX}${key}`);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStored<T>(key: string, value: T): void {
  const store = storage();
  if (!store) return;

  try {
    store.setItem(`${PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // Storage can be unavailable or full. The application remains usable in
    // memory; callers must not interpret this as a successful durable write.
  }
}

export function removeStored(key: string): void {
  const store = storage();
  if (!store) return;

  try {
    store.removeItem(`${PREFIX}${key}`);
  } catch {
    // Best effort only.
  }
}

export function clearFolioHelmStored(): void {
  const store = storage();
  if (!store) return;

  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Best effort only.
  }
}

export const STORAGE_PREFIX = PREFIX;
