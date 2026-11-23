English | [简体中文](README.zh-CN.md)

# FolioHelm

FolioHelm is a local-first, security-first Windows desktop portfolio and paper-trading workbench built with **Tauri 2, Rust, React, and TypeScript**.

> FolioHelm runs in two isolated local modes — **Mock Demo** and **Local Portfolio (CSV + Paper)** — keeping all portfolio data on your machine. Live brokerage OAuth and order execution are planned once [API Gate](docs/api-gate.md) review is completed.

## What's Implemented

- **Encrypted Local Persistence & `.fhvault` Offline Backup (Fail-Closed)**:
  - Stores your imported portfolios, cash snapshots, paper orders, evidence journal, cached quotes, safety preferences, automation policies, and rebalance targets in a bundled SQLite database (`WAL` + `secure_delete = ON`) encrypted at rest with **AES-256-GCM** (random 96-bit nonces + per-record AAD binding `schema_version|table|record_id`), with lossless migration from legacy browser storage and automatic restoration of your `local-csv` workspace & cached quotes on relaunch.
  - Protects the 256-bit database master key and **Ed25519** device signing seed inside the operating system credential manager (**Windows Credential Manager** / OS Keyring) and scrubs key buffers from memory with `zeroize`.
  - **`.fhvault` Passphrase-Encrypted Offline Migration**: exports the entire encrypted vault + signing identity using **Argon2id** + random 128-bit salt + **AES-256-GCM** + format/version AAD; restore verifies AEAD authentication and the full Ed25519 evidence chain before atomically swapping the database (Fail-Closed: failures never touch your existing vault). Evidence and backup imports enforce a 20 MB hard cap.
  - **Real Manual & Idle App Lock**: locking writes an Ed25519-signed `SessionLocked` evidence event, immediately drops and `Zeroizing`-wipes in-memory session keys, and unmounts portfolio data behind a lock screen; unlocking supports an optional Argon2id lock passphrase verified in constant time with exponential anti-bruteforce backoff (passphrases are never persisted or logged).
  - **Fail-Closed by design**: if an existing encrypted vault cannot be decrypted or its OS keyring key is missing, FolioHelm locks the vault, preserves the untouched ciphertext, and never silently resets or downgrades to plaintext.
- **Tamper-Evident Ed25519 Evidence Journal**:
  - Records trade previews, confirmations, reconciliations, safety setting changes, App Lock events (`SessionLocked`), and CSV portfolio imports (tagged with exact `mock` / `local-csv` mode) into a hash-chained, Ed25519-signed local evidence journal that persists across restarts and rejects credentials or sensitive fields before writing.
- **Safe Multi-Broker CSV Import, Multi-Currency Fail-Safe Isolation & Full-Site Local Portfolio**:
  - Supports **Charles Schwab**, **Interactive Brokers (IBKR)**, **Fidelity**, **Vanguard**, **Futu (富途)**, **Tiger (老虎)**, and **Standard Portfolio CSV**.
  - Enforces a 5 MB / 10,000-row safety limit, neutralizes spreadsheet formula injection (`=`, `+`, `-`, `@` prefixes), validates ticker format and non-negative share quantities, calculates cost basis and P&L with **exact `Decimal` / fixed-point arithmetic** (never IEEE-754 floats), and computes deterministic SHA-256 fingerprints for **idempotent deduplication**.
  - **Multi-Currency Isolation**: when a CSV spans multiple settlement currencies (e.g., USD + HKD), FolioHelm isolates per-currency subtotals and computes allocation and rebalance plans per currency bucket without mixing currencies.
  - **Full-Site Arbitrary-Ticker Support**: imported non-demo holdings (e.g., `VOO`, `QQQ`, `BRK.B`, `00700.HK`) work seamlessly across Home, Search (`Ctrl+K`), Markets, Instrument Detail, Portfolio, Paper Trade, and Orders using real imported positions, cached quotes, and local NAV history.
- **Target Allocation & Read-Only Rebalance Calculator (Pure Decimal)**:
  - Multi-holding allocation donut plus an encrypted-persisted target-weight planner strictly validating that holdings + cash sum to exactly **100%**.
  - Supports both **Full Rebalance** and **Cash-Only Buy** (zero-sell) modes using pure exact `Decimal` math, with single-row one-click prefill into the 4-step paper trade ticket (manual single-order review only; no batch auto-execution).
- **Hardened Optional Delayed Public Quotes (Off by Default)**:
  - Disabled by default for local-first operation. When explicitly enabled in **Settings**, the Rust backend fetches unauthenticated, delayed read-only quotes exclusively from HTTPS-allowlisted hosts (`stooq.com` and `query1.finance.yahoo.com`) with `url.port().is_none()`, redirects disabled, **zero `f64`** (`i128` fixed-point parsing), a 512 KiB streamed HTTP body cap, bounded 4-way concurrency with a 20s batch timeout, encrypted cache persistence, and automatic offline fallback to cached or CSV baseline prices.
- **Native Desktop File Dialogs & Strict CSP**:
  - Uses controlled Rust `tauri-plugin-dialog` commands for opening brokerage CSVs and saving evidence bundles or safety diagnostics (gracefully falling back to browser file inputs and deferred-revoke Blob downloads in browser previews).
  - Preserves a strict WebView Content Security Policy without exposing external network origins or unrestricted filesystem access to the frontend.
- **Interactive Workbench**:
  - Global symbol search (`Ctrl+K`), market/instrument explorer, portfolio allocation & return views, annual investing activity/return heatmap, working/filled/canceled/rejected/unknown order timelines with reconciliation, and a 4-step simulated trade workflow (`Ticket → Safety check → Mock preview → Demo receipt`).

### Roadmap

- Charles Schwab OAuth and live brokerage API integration (pending [API Gate](docs/api-gate.md))
- Real-time execution quotes and live order submission
- Optional remote notary checkpoint integration (local Ed25519 checkpoint/receipt primitives already exist in Rust)

## Interface Preview

Local workbench preview:

![Home](docs/images/home-16x9.jpg)

![Markets](docs/images/market-16x9.jpg)

![Instrument Detail & Hover](docs/images/instrument-hover-16x9.jpg)

![Trade Workspace Modal](docs/images/trade-modal-16x9.jpg)

### Safe Brokerage CSV Import & Local Encrypted Vault Controls

**Safe Brokerage CSV Import & Field Mapping Preview** — Auto-detects Charles Schwab, Interactive Brokers (IBKR), and Standard CSVs with formula-injection sanitization, cash balance detection, field mapping preview, exact `Decimal` cost-basis calculation, and encrypted local persistence:

![Safe Brokerage CSV Import & Field Mapping Preview](docs/images/route-b-csv-import.png)

**Local Encrypted Vault & Optional Delayed Public Quotes** — Shows local AES-256-GCM + OS Credential Manager vault status, read-only delayed public quote toggle (off by default, HTTPS allowlist only), and Ed25519 evidence journal verification/export controls:

![Local Encrypted Vault & Delayed Public Quotes Settings](docs/images/route-b-local-vault-settings.png)

## Tech Stack

- **Desktop & Security Core**: Tauri 2 (`2.11.x`), Rust (`rusqlite` bundled, `aes-gcm`, `argon2`, `ed25519-dalek`, `subtle`, `zeroize`, `keyring`, `reqwest` `rustls-tls`, `tauri-plugin-dialog`)
- **Frontend**: React 19, TypeScript, Vite, Vitest, React Testing Library

## Security Boundaries

- **BYO Developer App**: Future broker integrations will require users to provide their own developer credentials under official terms.
- **No Secrets in Frontend or Logs**: Key material stays inside OS Credential Manager and Rust `Zeroizing` buffers; evidence payloads actively reject secret-like keys and tokens.
- **Live Trading Locked**: Real brokerage order submission is unavailable in this build.
- **No Automatic Write Retries**: Uncertain (`Unknown`) states require explicit reconciliation before continuing.
- **API Gate First**: Any future live API scope, rate limit, market-data license, and redistribution term must clear [docs/api-gate.md](docs/api-gate.md).

## Development & Verification

Prerequisites on Windows: Node.js 22+, Rust toolchain (`rust-toolchain.toml` / 1.92.0+), MSVC Build Tools, and WebView2.

```powershell
# Install frontend dependencies
npm install

# TypeScript check, Vitest unit/UI tests, and frontend production build
npx tsc -b
npm test
npm run build

# Rust formatting, locked unit tests (uses in-memory keystore; does not touch host Windows Credential Manager), and Clippy
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings

# Desktop dev mode (starts Vite + Tauri shell)
npm run desktop:dev

# Portable Windows desktop build (validates Tauri version parity, icons, CSP & frontend bundling)
npm run desktop:build:portable

# Full Windows installer build (NSIS)
npm run desktop:build
```

> Always build standalone Windows executables via `npm run desktop:build:portable` or `npm run desktop:build` rather than bare `cargo build`, so Tauri embeds the compiled frontend assets properly.

## Documentation

- [Engineering & Security Guide (`AGENTS.md`)](AGENTS.md)
- [ADR-0001: Dual Evidence Journal](docs/architecture-decisions/ADR-0001-dual-evidence-journal.md)
- [Security Policy](SECURITY.md) · [Security Model](docs/security-model.md) · [Evidence Threat Model](docs/security/evidence-threat-model-v1.md)
- [Evidence Journal Specification](docs/evidence-journal.md)
- [Mock Broker Contract](docs/mock-broker.md)
- [Schwab API Gate](docs/api-gate.md) · [Schwab API Capability Matrix](docs/schwab-api-capability-matrix-v1.md)
- [Test Plan](docs/test-plan.md) · [Windows Release Checklist](docs/release-checklist.md) · [Windows Toolchain Guide](docs/development/windows-toolchain.md)
- [Contributing Guide](CONTRIBUTING.md)
- [English User Guide](docs/user-guide-en.md) · [中文使用说明](docs/user-guide-zh.md)

## License & Disclaimer

Licensed under [Apache-2.0](LICENSE). Nothing in this software constitutes financial or investment advice. FolioHelm is an independent open-source project and is not affiliated with, sponsored by, or endorsed by Charles Schwab or Interactive Brokers.
