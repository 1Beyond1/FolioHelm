# Changelog

All notable changes to **FolioHelm** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-26

### Fixed

- **[P0] Paper-order ID collision & silent overwrite protection**:
  - Switched local paper-order IDs in `src/domain/mockBroker.ts` to collision-proof `PAPER-ORDER-<UUID>` identifiers and removed cross-mode `this.sequence = 0` resets during double hydration (`local-csv` → `mock`).
  - Changed Rust `save_paper_order` (`src-tauri/src/storage/mod.rs`) from `INSERT OR REPLACE` to strict `INSERT INTO paper_orders` so duplicate primary keys fail closed instead of silently overwriting historical orders.
- **[P1] `ErrorLocked` disaster-recovery hardening**:
  - Added non-empty `db_path` guards in `EncryptedVaultDb::restore_from_error_locked` and `VaultRuntimeState::apply_restored_payload`.
  - Preserved SQLite `-wal` and `-shm` sidecar files alongside the backed-up DB during disaster recovery, restoring them atomically on rollback and removing backups only after OS keyring persistence and post-swap canary + Ed25519 verification succeed.
  - Reused AES-256-GCM `.restore-intent` crash-recovery metadata and surfaced `appLockCleared` in `VaultRestoreSummaryDto` so Settings prompts users to reconfigure their App Lock passphrase after recovery.
- **[P1] IBKR Activity Statement `Trades` `DataDiscriminator` filtering (Rust & TS)**:
  - Skipped `SubTotal`, `Total`, `ClosedLot`, and `WashSale` rows; preferred canonical `Order` rows and adopted `Trade` rows when no matching `Order` row exists for the same `(symbol, date, currency, action)`.
- **[P1] Yahoo Finance 1-day change accuracy & sub-unit currency scaling**:
  - Updated Yahoo chart fetches to `range=1d`, prioritized `meta.previousClose` with penultimate daily bar close fallback, and converted case-sensitive sub-unit currencies (`GBp`/`GBX` → `GBP`, `ZAc` → `ZAR`, `ILA` → `ILS`) by exact `i128` division by `100` before uppercasing.
  - Replaced hardcoded quote `User-Agent` version with `env!("CARGO_PKG_VERSION")`.
- **[P1] Multi-account TWR accuracy & zero-start BOD inflows (Rust & TS)**:
  - Separated `eod_onboarding_micros` from beginning-of-day `external_cash_flow_micros` so newly onboarded accounts enter at EOD (`(V_end - eod_onboarding) / (V_start + bod_cf)`) without diluting existing accounts' daily returns.
  - Fixed zero-start initial inflow (`v_start <= 0 && bod_cf > 0`) sub-period return calculation whenever `capital_base > 0`.
- **[P1] Unified `cash_flows` ledger ↔ `nav_snapshots` external cash flow**:
  - Transactionally aggregated `deposit`/`withdrawal` entries by `(account_id, currency, flow_date)` back into `nav_snapshots.external_cash_flow_micros` inside Rust SQLite transactions (and synchronized frontend `NAV_STORE` & Portfolio quick-entry UI to eliminate split/duplicate entry).
- **[P1] P&L attribution reconciliation**:
  - Added `quantity = 0` attribution rows for liquidated/closed positions with dividends and `UNATTRIBUTED` rows for `symbol = null` dividends so `Σ entries === summary` holds strictly.
- **[P1] 24-market CSV currency inference & ghost `USD` cash fix (Rust & TS)**:
  - Expanded CSV exchange suffix currency inference to match all 24 global markets supported by `quotes/mod.rs`.
  - Resolved untagged `cash` columns/rows against the row's or file's holding currency instead of hardcoding `USD`.
- **[P1] Idle auto-lock reactivation after disaster recovery**:
  - Added `vaultErrorLocked` to the idle auto-lock `useEffect` dependency array in `src/App.tsx`.
- **[P2] UI & CI polish**:
  - Changed limit-price input in `TradePage` to `min="0.000001" step="any"` to support up to 6 decimal places.
  - Fixed cross-currency composite React keys in `SearchPalette` and `PortfolioPage`.
  - Added `Swatinem/rust-cache@v2` and updated the portable desktop build step name in `.github/workflows/ci.yml`.
  - Aligned version metadata to `0.2.1` and updated `docs/release-checklist.md`, `SECURITY.md`, `docs/known-issues.md`, and `docs/security-model.md`.

## [0.2.0] - 2026-11-23

### Added

- Multi-account management (`All Accounts` aggregate + single-account scope) with strict per-currency bucket isolation (`USD`, `HKD`, `CNY`, etc.).
- Real daily NAV snapshot tracking and pure `i128` / `BigInt` Time-Weighted Return (TWR) engine with allowlisted read-only benchmark overlay (`SPY`, `QQQ`, `2800.HK`, `510300.SS`, etc.) and honest `< 2 snapshots` gate.
- Encrypted `cash_flows` (dividends, deposits, withdrawals, fees) and `watchlist_items` (read-only target buy/sell price alerts with single-row paper ticket prefill) SQLite tables and `.fhvault` backup/restore support.
- Per-symbol pure-`Decimal` P&L attribution (unrealized P&L + recorded dividends) and sanitized Markdown/CSV portfolio review report export.
- `ErrorLocked` disaster recovery via verified `.fhvault` restore.

### Security & Hardening

- Stage 6 security hardening: UTF-8-safe option detection, lock-state verification before and after native OS file dialogs, monotonic `lockEpoch` barrier, serialized workspace preference writes, Fail-Closed `RollbackLockRequired` → `ErrorLocked` transitions, reverse-split replay protection, and `Zeroizing` plaintext buffers.

## [0.1.0] - 2026-11-18

### Added

- Local-first Windows desktop workbench built with Tauri 2, Rust, React, and TypeScript featuring isolated **Mock Demo** and **Local Portfolio (CSV + Paper)** modes.
- AES-256-GCM encrypted SQLite vault (`WAL` + `PRAGMA secure_delete = ON`), OS Keyring master key management, `.fhvault` Argon2id offline backup/restore, manual & idle App Lock with exponential backoff, and Ed25519 hash-chained evidence journal.
- Multi-broker CSV import (Schwab, IBKR, Fidelity, Vanguard, Futu, Tiger, Generic CSV), pure-`Decimal` target rebalance calculator, 4-step single-use paper trade ticket, and optional read-only delayed public quotes (`stooq.com`, `query1.finance.yahoo.com`) with zero `f64` math.
