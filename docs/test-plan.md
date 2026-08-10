# FolioHelm Test Plan

This plan validates the current Windows Mock build. It intentionally does not
authorize Schwab API access or real-money testing.

## Test layers

### Domain and unit tests

Run `npm test` and cover:

- Decimal arithmetic, normalization, comparison, and formatting;
- Mock Broker snapshots and every deterministic fault scenario;
- Preview draft hashing, expiry/invalidation, single consumption, and unknown
  outcomes;
- order reconciliation and “do not resubmit” behavior;
- automation caps, allowlists, idempotency, backpressure, and kill switch;
- evidence hash-chain creation, import/export, tamper detection, and secret
  field rejection.

### Frontend tests

The React tests cover navigation and the critical interaction contract:

- home chart hover and wheel period interpolation;
- heatmap activity/return and percent/USD modes;
- market search, movers, instrument navigation, and trade entry;
- portfolio sorting and order timeline expansion;
- trade modal validation, safety gate, preview acknowledgement, receipt, and
  close behavior;
- settings persistence, scenario selection, theme/language controls, and
  risk confirmation.

### Rust/Tauri checks

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

The Rust evidence primitives must continue to reject malformed signatures,
tampered payloads, deleted/reordered entries, untrusted receipts, and receipt
reuse.

## Browser acceptance matrix

Use the local Vite preview or a portable Tauri EXE. Do not enter real API data.

| Area | Acceptance checks |
| --- | --- |
| Home | summary, chart hover, wheel period change, heatmap tooltip, heatmap mode/unit change |
| Markets | search, empty results, movers tabs, instrument and trade buttons |
| Instrument | quote freshness state, chart hover tooltip, wheel zoom, period buttons, trade button |
| Portfolio | dynamic totals/holdings, allocation donut, sorting, row navigation, trade button |
| Orders | status tabs/counts, search, expand timeline, Unknown warning, new Mock order visibility |
| Trade modal | open, close button, backdrop, Escape, validation, preview invalidation, receipt |
| Settings | language, System/Dark/Light, scenario selector, risk dialog, evidence actions, clear-data confirmation |
| Automation | Mock/Paper/Dry Run only, Real disabled, allowlist, caps, local run log, duplicate guard, kill switch |

## Scenario matrix

At minimum, manually select these Mock scenarios in Settings and confirm the
UI remains honest:

- `healthy`: normal values and enabled Mock preview;
- `empty-account`: cash-only account and no holdings/orders;
- `loss`: negative P&L uses the muted loss tone and no false success copy;
- `no-buying-power`: zero buying power and preview blocked;
- `market-closed` / `stale-quote`: quote freshness is visible and preview is blocked;
- `offline` / `reauth-required`: local snapshot remains inspectable while
  refresh/trade paths do not pretend to be connected;
- `timeout` / `unknown` / `reconciliation-failed`: no retry and explicit
  Unknown/reconciliation warning;
- `request-failed` / `rate-limited`: deterministic local failure with no
  network request.

## Responsive and accessibility checks

- 1440×900 default desktop layout;
- 1280×800 normal laptop layout;
- 900×680 minimum target with no accidental document-level horizontal scroll;
- keyboard focus, roving heatmap focus, visible labels, ARIA roles, and Escape
  handling;
- Light, Dark, and System theme variables;
- English and Simplified Chinese visible copy.

## Release evidence

Record the commit, commands, OS, artifact path, and SHA-256 in the release
checklist. Any failed installer bundler must be recorded as a known issue; do
not silently present a portable EXE as a signed installer.

