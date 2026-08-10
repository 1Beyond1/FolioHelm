## What changed

<!-- Describe the user-visible result. -->

## Safety boundary

- [ ] Mock-only / no external broker request
- [ ] No credentials, tokens, cookies, account exports, or private keys added
- [ ] Unknown outcomes still fail closed and are not retried automatically
- [ ] No real Place/Cancel/Replace capability was added

## Verification

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check` (if Rust changed)
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --locked` (if Rust changed)
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings` (if Rust changed)
- [ ] UI manually checked at the default size and 900px minimum (if UI changed)

## Known issues

<!-- List anything intentionally left for a follow-up. -->

