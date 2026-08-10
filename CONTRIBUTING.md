# Contributing to FolioHelm

FolioHelm is currently an offline Mock terminal. Contributions should improve
the local product without weakening the boundary around real money, broker
credentials, or uncertain order outcomes.

## Before changing code

Work from the repository root and inspect the current state first:

```powershell
git status --short --branch
rg --files
npm test
npm run build
```

Preserve unrelated working-tree changes. Do not use `git reset --hard`,
`git checkout --`, broad deletion, or force-pushes as part of normal work.

## Development rules

- Keep Schwab API access behind the documented API Gate.
- Do not add credentials, network calls, web scraping, or real order methods to
  the Mock profile.
- Do not add automatic retries for writes. Preserve the Unknown → reconcile
  flow.
- Use `Money`, `Price`, `Quantity`, and `Percent` for financial calculations.
- Keep UI labels localized in English and Simplified Chinese.
- Add deterministic tests for every new scenario and every safety-sensitive
  branch.
- Use `apply_patch` for source edits and keep changes focused.

## Git checkpoints

The project intentionally uses frequent local checkpoints. After each stable
stage, run the checks, review `git diff --check`, and make a descriptive local
commit. This repository is not automatically pushed anywhere.

Suggested sequence:

```powershell
git add -A
git commit -m "checkpoint: describe the stable stage"
git log --oneline -5
```

Do not commit `node_modules`, local credentials, browser profiles, or private
account exports. Build artifacts belong in a release artifact workflow, not in
source commits unless a release decision explicitly says otherwise.

## Required checks

For frontend/domain changes:

```powershell
npm test
npm run build
```

For Rust/Tauri changes:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

For UI changes, manually inspect the affected page at the default desktop
size and at the 900px minimum-width target. Check both themes, both languages,
keyboard Escape/Ctrl+K behavior, and the Mock scenario that exercises the
changed state.

## Pull requests

Describe the user-visible result, the safety boundary, tests run, known issues,
and whether the change is Mock-only. A change that introduces a new external
dependency must explain its license, maintenance status, network behavior, and
why the dependency is necessary.

