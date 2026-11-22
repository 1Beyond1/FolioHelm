# FolioHelm — Engineering & Security Guide for Agents

FolioHelm is a local-first, security-first Windows desktop portfolio & paper-trading client built with **Tauri 2 + Rust + React + TypeScript**.

## Repository Map

- `src/` — React 19 + TypeScript frontend
  - `src/domain/` — Exact `Decimal` arithmetic (`decimal.ts`), broker contracts (`contracts.ts`), isolated `Mock Demo` / `Local Portfolio (CSV + Paper)` store (`mockBroker.ts`), brokerage CSV importer (`csvImport.ts`), optional read-only public quotes & native save helper (`publicQuotes.ts`), tamper-evident evidence journal (`evidenceJournal.ts`), Tauri IPC bridge (`tauriBridge.ts`), and paper automation controller (`automation.ts`).
  - `src/features/` — Feature pages: `portfolio/`, `markets/`, `orders/`, `trade/`, `automation/`, `settings/`.
  - `src/components/` — Shared layout (`AppShell`, `TopBar`, `SystemStatusBar`, `Modal`, charts, heatmap).
  - `src/platform/` — Browser localStorage wrapper and theme helper.
- `src-tauri/` — Rust backend & Tauri 2 shell
  - `src-tauri/src/vault/mod.rs` — OS keyring abstraction (`KeyStore` trait, `OsKeyringStore`, test `InMemoryKeyStore`), `Zeroizing<[u8; 32]>` key containers, AES-256-GCM AEAD with `schema_version|table|record_id` AAD.
  - `src-tauri/src/storage/mod.rs` — Encrypted SQLite (`rusqlite` bundled, WAL + `secure_delete = ON`), canary verification, fail-closed lock handling, atomic transactions for evidence, portfolios, paper orders, quote cache, and settings.
  - `src-tauri/src/evidence/mod.rs` — Ed25519-signed tamper-evident hash chain with sensitive-field rejection.
  - `src-tauri/src/csv_import/mod.rs` — Safe Schwab / IBKR / standard CSV parser (5 MB / 10,000-row cap, formula-injection sanitization, `i128` fixed-point math, SHA-256 idempotent fingerprint).
  - `src-tauri/src/quotes/mod.rs` — Optional, off-by-default read-only public quote client (`reqwest` `rustls-tls`, strict HTTPS allowlist `stooq.com` & `query1.finance.yahoo.com`, redirects disabled, zero credentials).
  - `src-tauri/src/lib.rs` — Tauri runtime initialization, managed `VaultRuntimeState`, IPC commands, and controlled `tauri-plugin-dialog` file open/save handlers.
  - `src-tauri/icons/` — Multi-resolution application icons (`icon.ico`, `icon.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`).
  - `src-tauri/capabilities/main.json` — Minimal window capability (`core:default`, `dialog:allow-open`, `dialog:allow-save`).
- `tests/` — Vitest domain and React Testing Library suites.
- `docs/` — Architecture decisions (`ADR-0001`), security model, threat model, API gate, user guides, and screenshots.

## Non-Negotiable Security Red Lines (Funds-First)

1. **Fail-Closed Encryption, Never Plaintext Downgrade**:
   - All financial records at rest (imported holdings, cash, transactions, paper orders, evidence chain, quote cache, settings) MUST be AES-256-GCM encrypted with an OS-managed 256-bit key.
   - If an encrypted database exists on disk and OS keyring material is missing, or if AEAD authentication / canary verification fails, **lock fail-closed and preserve existing ciphertext**. Never overwrite or reset an unreadable vault.
   - Unit tests MUST inject `InMemoryKeyStore` and never pollute the host OS credential manager.
2. **Exact Financial Arithmetic Only**:
   - Never use IEEE-754 floating-point math for money, share quantities, average cost, or P&L.
   - Use `src/domain/decimal.ts` on the TypeScript side and `i128` fixed-point or canonical decimal strings across Rust / Tauri IPC boundaries.
3. **Strict Mode Isolation & Honest Capabilities**:
   - Never blur `Mock Demo` and `Local Portfolio (CSV + Paper)` data; keep their ledgers isolated.
   - This build has **no live brokerage write capability**. Charles Schwab OAuth / live order execution remains gated behind official API Gate approval (`docs/api-gate.md`).
   - All public quotes MUST remain disabled by default, read-only, clearly labeled as delayed/non-execution, and fetched exclusively through the Rust allowlisted backend.
4. **Minimal Attack Surface & Strict CSP**:
   - Keep `src-tauri/tauri.conf.json` CSP strict (do not open arbitrary external `connect-src` to the WebView).
   - Never grant unrestricted filesystem plugin permissions to the WebView; keep file open/save mediated by Rust commands with size caps.
   - Never log, store in evidence payloads, or send secrets, credentials, cookies, or raw brokerage account numbers.
5. **Tauri Version Parity**:
   - Keep `@tauri-apps/api` and `tauri` aligned on the same `2.x` minor line, and keep `@tauri-apps/plugin-dialog` aligned with `tauri-plugin-dialog`. Always verify `cargo test --locked` and `npm run desktop:build:portable` after dependency edits.

## Build, Lint & Verification Commands

Run all commands from the repository root (ensure `$env:USERPROFILE\.cargo\bin` is in `PATH` on Windows):

```powershell
# TypeScript & Frontend
npx tsc -b
npm test
npm run build

# Rust formatting, locked tests, and strict Clippy
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings

# Portable Windows desktop build (validates Tauri version alignment, icons, CSP & bundling)
npm run desktop:build:portable
```

## Temporary Files & Git Conventions

- Place any local scratch artifacts, screenshots, or temporary CSV fixtures inside `.tmp/` (gitignored). Never commit `.sqlite`, `.db`, `.env`, or `.tmp/` files.
- Follow Angular commit message conventions with clear Chinese descriptions on renovation branches (e.g., `feat(storage): ...`, `fix(tauri): ...`).
