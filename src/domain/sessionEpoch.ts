/**
 * Monotonic session lock-epoch barrier (P0-3 Fail-Closed).
 *
 * Every App Lock / fail-closed sensitive memory wipe synchronously increments
 * `currentLockEpoch` BEFORE wiping stores or awaiting Tauri lock IPC.
 * Every asynchronous hydrator, quote refresh, benchmark sync, CSV commit, or
 * NAV snapshot writer captures `const epoch = getCurrentLockEpoch()` before
 * awaiting IPC and MUST verify `isCurrentLockEpoch(epoch)` after every `await`
 * before mutating any JS store or React state. Stale in-flight callbacks from
 * a pre-lock session are silently discarded so locked RAM can never be repopulated.
 */

let currentLockEpoch = 0;

export function getCurrentLockEpoch(): number {
  return currentLockEpoch;
}

export function advanceLockEpoch(): number {
  currentLockEpoch += 1;
  return currentLockEpoch;
}

export function isCurrentLockEpoch(epoch: number): boolean {
  return epoch === currentLockEpoch;
}
