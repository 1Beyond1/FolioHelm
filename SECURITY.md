# Security Policy

## Current security boundary

The current public build is a Windows-first, local-only Mock/Paper/Dry Run
terminal. It contains no Schwab OAuth client, App Key, App Secret, access
token, refresh token, live quote feed, or broker write capability. The UI must
continue to show `API Gate Pending` until the official Schwab contract has
been reviewed and the relevant capability has been implemented and tested.

Do not use this build with a real account for trading. The “Trade” workflow
creates a local Mock preview and a fictional receipt only. It cannot place,
cancel, or replace a Schwab order.

## Reporting a vulnerability

Please do not open a public issue containing credentials, account numbers,
tokens, private keys, exported financial records, or a live order identifier.
For a suspected security vulnerability, contact the project maintainer
privately through the contact method published by the repository owner. If no
private channel is available, open an issue with only the label “security” and
the minimum information needed to request a private follow-up.

Include:

- affected version, commit, and operating system;
- whether the report concerns the Mock build or a separately enabled broker adapter;
- reproducible local steps that do not submit a real order;
- observed impact and any relevant redacted logs.

## Secrets and personal data

- Never commit Schwab credentials, OAuth codes, access/refresh tokens, cookies,
  account hashes, private keys, or exported account data.
- Examples and issue attachments must use placeholders such as
  `SCHWAB_APP_KEY_REDACTED`.
- Logs and evidence payloads must reject secret-like fields. Do not add
  telemetry or remote uploads without a separate design and explicit review.
- A user-managed Developer App is bring-your-own; the project does not provide
  shared API access or host user credentials.

## Safety invariants

Changes must preserve these invariants:

- financial values use the Decimal domain types rather than binary floating
  point for calculations;
- Preview data is bound to the exact draft and cannot be consumed twice;
- an `Unknown` outcome is locked until reconciliation and must never trigger an
  automatic retry;
- real broker capabilities are disabled until the API Gate is complete;
- automation remains Mock/Paper/Dry Run only in the current build;
- evidence verification fails closed on tampering, reordering, gaps, or
  sensitive payloads.

## Verification before merge

Run the applicable checks from the repository root:

```powershell
npm ci
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

Any future live adapter requires a separate threat model, official API
evidence, failure-injection tests, credential-storage review, and explicit
human approval before it can be enabled or distributed.

