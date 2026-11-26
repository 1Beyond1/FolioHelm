# Windows Desktop Release Checklist (v0.2.1)

This checklist applies to public releases of **FolioHelm** covering both isolated local modes (**Mock Demo** and **Local Portfolio (CSV + Paper)**). It is **not** a checklist for enabling Schwab live brokerage trading (`API Gate Pending`).

## Source, version alignment, and safety

- [ ] Working tree reviewed; unrelated local changes preserved.
- [ ] Version aligned across `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `SettingsPage.tsx`, `evidenceJournal.ts`, and `CHANGELOG.md`.
- [ ] No API key, secret, token, cookie, private key, account export, or live order identifier exists in source, logs, artifacts, or screenshots.
- [ ] `API Gate Pending` remains visible in the UI and documentation.
- [ ] Live brokerage write capability remains disabled (no live Place/Cancel/Replace path exists).
- [ ] `README.md`, `README.zh-CN.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/security-model.md`, and `docs/known-issues.md` agree on the current security boundary.

## Automated verification

```powershell
npm ci
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

- [ ] Portable Windows desktop build completes:

```powershell
npm run desktop:build:portable
```

- [ ] The portable EXE starts cleanly without a Vite dev server and exits cleanly.
- [ ] Published artifact SHA-256 is computed and recorded (and unsigned status is clearly disclosed).

## Manual acceptance

- [ ] Home, Markets, Instrument, Portfolio, Orders, Trade, Settings, and Automation reviewed in a desktop Tauri window.
- [ ] 900×680 minimum window size checked; English/Chinese and System/Dark/Light themes checked.
- [ ] CSV import verified (Schwab, IBKR `DataDiscriminator`, Fidelity, Vanguard, Futu, Tiger, multi-market suffixes, multi-currency isolation).
- [ ] Paper-order persistence verified across restart/lock/unlock (UUID IDs, no overwrite of historical orders).
- [ ] Real NAV & `i128` TWR verified across multi-account onboarding, `cash_flows` deposit/withdrawal sync, and P&L attribution reconciliation.
- [ ] Encrypted SQLite vault, `.fhvault` Argon2id backup/restore (including `ErrorLocked` recovery and App Lock re-set prompt), and manual/idle App Lock verified.
- [ ] Trade modal close button, Escape key, 6-decimal limit price input, and `Unknown` order reconcile-only safeguard checked.
- [ ] Evidence verify/export/import, sanitized Markdown/CSV report export, and clear-data confirmation checked.

## Known packaging limitation

In restricted Windows environments, WiX/NSIS installer bundling may encounter `os error 5` (Access denied) while `npm run desktop:build:portable` succeeds cleanly. Until an installer is built in a standard-privilege environment, ship the portable EXE with its exact SHA-256 digest and explicitly mark it unsigned.
