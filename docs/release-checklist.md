# Windows Mock Release Checklist

This checklist is for a public preview of the local Mock build. It is not a
checklist for enabling Schwab live trading.

## Source and safety

- [ ] Working tree reviewed; unrelated user changes preserved.
- [ ] Local Git checkpoint created and commit ID recorded.
- [ ] No API key, secret, token, cookie, private key, account export, or live
      order identifier is in the source, logs, artifact, or screenshots.
- [ ] `API Gate Pending` remains visible in the product/documentation.
- [ ] Real Trading is disabled and no Place/Cancel/Replace path exists in the
      Mock profile.
- [ ] README, SECURITY.md, API Gate, user guides, and known issues agree on
      the current boundary.

## Automated verification

```powershell
npm ci
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

- [ ] Windows portable build completes:

```powershell
npm run desktop:build:portable
```

- [ ] The EXE starts without a Vite dev server and exits cleanly.
- [ ] The artifact is hashed with SHA-256.

## Manual acceptance

- [ ] Home, Markets, Instrument, Portfolio, Orders, Trade, Settings, and
      Automation reviewed in a real browser/Tauri window.
- [ ] 900×680 minimum window checked.
- [ ] English/Chinese and System/Dark/Light checked.
- [ ] Mock scenario matrix checked.
- [ ] Trade modal close button and Escape tested.
- [ ] Unknown order warning says to reconcile and not resubmit.
- [ ] Evidence verify/export/import and clear-data confirmation checked.

## Current known release limitation

The current restricted Windows environment successfully produces an independent
portable EXE but may fail in the final WiX/NSIS bundler step with `os error 5`
(Access denied). Until an installer is rebuilt in an environment with the
required bundler permissions, publish the portable EXE only with its exact
SHA-256 and mark it unsigned.

## Artifact record

The last verified portable artifact was:

- path: `artifacts/foliohelm-0.1.0-windows-x64-mock.exe`
- SHA-256: `EC2E22BEBC772AAAE0F88E47C3CC5262C9A6C8493F64157A26DB4F30997C224E`
- build command: `npm run desktop:build:portable`
- commit: record the release commit here at publish time

