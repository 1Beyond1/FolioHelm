# Security Model

Updated: 2026-11-23 (v0.2.0)

## Assets

The protected assets are:
1. Local encrypted multi-account profiles, portfolio holdings, daily NAV snapshots, cached benchmarks, cash-flow & dividend ledgers, watchlist targets, paper orders, rebalance targets, automation policies, and workspace preferences.
2. Device cryptographic key material: 256-bit vault database encryption key, Ed25519 evidence signing seed, and optional App Lock Argon2id verifier.
3. User-supplied passphrases for `.fhvault` offline migration backups and App Lock unlock (transient in memory only; never persisted or logged).
4. Tamper-evident Ed25519 local evidence journal.
5. Future live-brokerage credentials, OAuth tokens, and real funds — absent in this build (`API Gate Pending`; no live brokerage write capability).

## Trust boundaries

1. **React UI (WebView)**: Untrusted presentation layer under a strict CSP (no arbitrary external `connect-src`, no unrestricted filesystem permissions). While locked (`App Lock`), sensitive JS stores are purged synchronously via a monotonic `lockEpoch` barrier, portfolio DOM nodes are unmounted behind `<LockScreen />`, and unlock actions are blocked while lock IPC is in flight.
2. **TypeScript Domain Layer**: Deterministic pure-`Decimal` / `BigInt` math (`decimal.ts`, `nav.ts`, `rebalance.ts`, `cashFlows.ts`, `watchlist.ts`, `portfolioReport.ts`), serialized preference write queues, CSV sanitization, strict mode isolation (`mock` vs `local-csv`), 4-step paper-order state machine, and encrypted vault bridge (`vaultStorage.ts`).
3. **Tauri / Rust Security Core (`src-tauri/`)**:
   - **Encrypted SQLite Vault (`vault/` + `storage/`)**: Bundled SQLite (`WAL` + `PRAGMA secure_delete = ON`) with per-record **AES-256-GCM** encryption, random 96-bit nonces, `Zeroizing` serialization buffers, and per-record AAD binding (`schema_version|table|record_id`) across `evidence_entries`, `portfolio_snapshots`, `paper_orders`, `quote_cache`, `app_settings`, `accounts`, `nav_snapshots`, `benchmark_history`, `cash_flows`, and `watchlist_items`. Master key and Ed25519 signing seed live in OS Credential Manager (**Windows Credential Manager** / OS Keyring) and `Zeroizing` wrappers.
   - **Fail-Closed Startup & Restore**: Missing keyring material, canary decryption mismatch, corrupted `.fhvault` AEAD tags, invalid Ed25519 chain signatures, or a rollback failure to reopen/verify the original DB immediately transition `VaultRuntimeState` into Fail-Closed `ErrorLocked`, preserving ciphertext and `.restore-intent` recovery metadata.
   - **`.fhvault` Offline Encrypted Backup**: Derives a one-time 256-bit key via **Argon2id** (`m=64 MiB`, `t=3`, `p=1`, bounded DoS parameter validation) + random 128-bit salt, encrypts the complete vault payload + signing seed using **AES-256-GCM** with full header/KDF/salt AAD, re-checks unlocked state after async encryption, and verifies decrypted Ed25519 evidence chains before atomic SQLite swap with keyring rollback.
   - **Real App Lock (Manual & Idle)**: Writes an Ed25519-signed `EvidenceKind::SessionLocked` record before dropping and `Zeroizing`-wiping active database, journal, and runtime cache handles from memory. Unlock verifies the optional Argon2id passphrase verifier in constant time (`subtle::ConstantTimeEq`) with persisted exponential backoff (`1s → 2s → 4s … → 300s`).
   - **Hardened Read-Only Public Quotes & Benchmarks (`quotes/` + `nav/`)**: Disabled by default; HTTPS allowlist only (`stooq.com`, `query1.finance.yahoo.com`) with `url.port().is_none()` and redirects disabled; **zero `f64`** (`i128` fixed-point / `RawValue`); 512 KiB streamed body cap; 4-way bounded concurrency with 20s timeout; lock state verified before and after network I/O; encrypted local cache fallback.
   - **Lock-Protected Native Dialogs, CSV Import & Sanitized Report Export (`csv_import/` + `lib.rs`)**: All native `tauri-plugin-dialog` open/save commands (`CSV`, `JSON`, `Markdown/CSV report`, `.fhvault`) verify vault state both before opening the OS dialog and after it returns before reading or writing disk (`UserLocked` strictly denies every dialog and restore command; `ErrorLocked` permits only verified `.fhvault` disaster recovery via `dialog_open_fhvault_file` + `vault_restore_fhvault_backup`); CSV import enforces 5 MB / 10,000-row caps, UTF-8-safe option detection, formula neutralization, reverse-split inflation prevention, `i128` cost basis, and SHA-256 deduplication; report exports redact sensitive account numbers/tokens without corrupting structured ticker symbols or decimal amounts, and neutralize CSV formula prefixes.
4. **Schwab / External Brokerages**: Out of scope until official API Gate approval; no live API adapters exist.
5. **Optional Remote Notary**: Privacy-minimized commitment/receipt primitives exist in Rust; no remote calls are enabled.

## Safety properties

- Default profile is isolated local **Mock Demo** or **Local Portfolio (CSV + Paper)**; live brokerage writes are absent.
- Financial math uses integer-scaled `Decimal` (TS) and `i128` fixed-point (Rust) end-to-end — zero `f64` financial computation.
- Paper trade previews bind drafts to a hash, are single-use, and never auto-batch orders (Rebalance Calculator supports single-row paper prefill only).
- `Unknown` order states are locked until explicit reconciliation; writes are never automatically retried.
- Multi-currency CSV imports isolate per-currency subtotals and block cross-currency summation/rebalancing without verified FX rates.
- Local CSV mode never synthesizes fictional historical charts, statistics, or market news for imported tickers.
- Evidence journals reject secret-like fields, enforce a 20 MB import cap, and verify SHA-256 + Ed25519 chains before import/restore.
- All passphrases are kept transient and never logged or written to disk.

## Threats and mitigations

| Threat | Current mitigation | Remaining work |
| --- | --- | --- |
| Accidental real order / batch execution | No live brokerage adapter; Rebalance Calculator is strictly read-only with single-row paper prefill only | Official API Gate & independent audit before any live write |
| Local plaintext holding/setting exposure | AES-256-GCM encrypted SQLite (`WAL` + `secure_delete = ON`), OS Keyring master key, lossless migration removing legacy `localStorage` | Hardware-backed enclave attestation (optional future hardening) |
| Walk-up / idle desktop snooping | Manual & idle App Lock drops/zeroizes in-memory keys, records signed `SessionLocked` evidence, unmounts portfolio DOM, enforces Argon2id + exponential backoff | Biometric / Windows Hello unlock option (future) |
| Corrupted or tampered offline backup | `.fhvault` Argon2id + 128-bit salt + AES-256-GCM + header AAD + pre-commit Ed25519 chain verification + atomic SQLite swap with rollback | Optional hardware security key wrapping |
| Floating-point money / quote precision drift | Exact `Decimal` in TS (`decimal.ts`, `rebalance.ts`) and `i128` fixed-point + `RawValue` in Rust (`quotes/`, `csv_import/`) | Audit any future broker serialization layer |
| Cross-currency sum corruption | Multi-currency Fail-Safe detection & per-currency subtotal isolation across Rust, TS domain, Portfolio UI, and Rebalance Calculator | Auditable fixed-point FX conversion provider (future) |
| Quote endpoint OOM / SSRF / port smuggling / hang | HTTPS host allowlist + `url.port().is_none()` + zero redirects + 512 KiB streamed body cap + 4-way bounded concurrency + 20s timeout | Rate-limit telemetry & provider health metrics |
| Oversized evidence / CSV DoS & formula injection | 5 MB / 10,000-row CSV cap + formula prefix neutralization; 20 MB hard cap on evidence & `.fhvault` imports | Fuzz testing for exotic broker CSV locales |
| Secret leakage in logs or evidence | `Zeroizing` buffers, secret-field rejection in evidence journal, passphrases excluded from logs & persistence | Automated CI secret scanning |
| Duplicate order after timeout | Mock `Unknown` locked state, no auto-retry, explicit reconciliation flow | Live broker crash-recovery reconciliation (post API Gate) |

## Non-goals

This model does not promise zero defects, zero financial loss, third-party quote accuracy, or defense against a fully compromised operating system or kernel-level memory dump while unlocked. It strictly enforces Fail-Closed behavior whenever cryptographic integrity, currency consistency, or safety preconditions cannot be established.
