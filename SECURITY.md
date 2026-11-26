# Security Policy

## Current security boundary (v0.2.1)

FolioHelm is a local-first, security-first Windows desktop portfolio and paper-trading workbench running in two strictly isolated local modes: **Mock Demo** and **Local Portfolio (CSV + Paper)**.

- **Encrypted local vault**: User holdings, multi-account profiles, daily NAV snapshots, cached benchmarks, cash-flow & dividend ledgers, watchlist targets, paper orders, settings, and Ed25519-signed evidence records are stored locally in bundled SQLite (`WAL` + `PRAGMA secure_delete = ON`) with per-record **AES-256-GCM** encryption (96-bit random nonces + `schema_version|table|record_id` AAD) and OS Credential Manager / OS Keyring key storage.
- **Offline `.fhvault` backup & App Lock**: Full vault migration backups use **Argon2id** (`64 MiB`, `t=3`, `p=1`) + random 128-bit salt + **AES-256-GCM** with header AAD, atomic SQLite swap with `-wal`/`-shm` sidecar preservation and `.restore-intent` crash recovery, and Fail-Closed `ErrorLocked` handling. Manual and idle App Lock zeroize in-memory keys, write Ed25519-signed `SessionLocked` evidence, and enforce optional Argon2id passphrase verification with persisted exponential backoff.
- **Optional read-only public quotes (off by default)**: When explicitly enabled by the user, only the Rust backend sends read-only HTTPS GET requests to allowlisted hosts (`stooq.com`, `query1.finance.yahoo.com`, no custom ports, no redirects, 512 KiB streamed body cap, 4-way concurrency limit, 20s timeout) parsed purely in `i128` fixed-point arithmetic.
- **No live brokerage writes (`API Gate Pending`)**: This build contains **no** Schwab OAuth client, App Key, App Secret, access/refresh token, live order routing, or brokerage write capability. The Trade workflow executes local paper/mock orders only and cannot place, cancel, or replace a live brokerage order.

## Reporting a vulnerability

Please do not open a public issue containing credentials, passphrases, account numbers, tokens, private keys, `.fhvault` files, exported financial records, or live order identifiers. For a suspected security vulnerability, contact the project maintainer privately through the contact method published by the repository owner. If no private channel is available, open an issue with only the label `security` and the minimum information needed to request a private follow-up.

Include:

- affected version (e.g., `v0.2.1`), commit hash, and operating system;
- whether the report concerns the desktop Tauri/Rust vault runtime or the browser preview runtime;
- reproducible local steps that do not involve live brokerage accounts or secrets;
- observed impact and any redacted diagnostic details.

## Secrets and personal data

- Never commit brokerage credentials, OAuth codes, access/refresh tokens, cookies, account hashes, private keys, `.fhvault` backups, or exported brokerage CSVs.
- Examples and issue attachments must use placeholders such as `SCHWAB_APP_KEY_REDACTED`.
- Evidence payloads and sanitized report exports must reject or redact secret-like fields and neutralize CSV formula prefixes. Do not add telemetry or remote uploads without a separate design and explicit review.
- Any future user-managed brokerage Developer App is bring-your-own; the project does not provide shared API access or host user credentials.

## Safety invariants

Changes must preserve these invariants:

- all financial math (money, NAV, TWR, quotes, rebalance, cash flows, attribution) uses pure `Decimal` / `BigInt` (TypeScript) and `i128` fixed-point (Rust) — zero `f32`/`f64`;
- cross-currency buckets remain strictly isolated without unverified FX blending;
- paper-order primary keys are unique and never silently overwrite historical encrypted orders;
- preview data is bound to the exact draft hash and cannot be consumed twice;
- an `Unknown` order outcome stays locked until explicit reconciliation and never triggers automatic retry;
- live broker write capabilities remain disabled until `API Gate` review is complete;
- native OS file dialogs and async vault/quote/backup operations fail closed across App Lock boundaries;
- evidence verification and `.fhvault` restore fail closed on tampering, reordering, gaps, bad AEAD tags, or invalid signatures.

## Verification before merge

Run the full verification suite from the repository root:

```powershell
npm ci
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

Any future live brokerage adapter requires a separate threat model, official API contract evidence, failure-injection tests, credential-storage audit, and explicit human approval before it can be enabled or distributed.
