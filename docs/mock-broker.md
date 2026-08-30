# Mock Broker Contract

`MockBroker` is the canonical local adapter for the current build. It is a
deterministic simulation boundary, not a broker emulator and not a network
stub. No method in this profile can reach Schwab.

## Snapshot contents

`getSnapshot()` provides:

- account cash, buying power, equity, P&L, timestamp, and data status;
- canonical fictional quotes with quote status and timestamp;
- holdings with Decimal quantity/price/money values;
- orders and event timelines;
- portfolio chart points;
- activity and return heatmap entries, including future `no-data` cells.

Page adapters must derive their view models from this snapshot. They must not
create a second account fixture with competing values.
All snapshot, preview, and order results are defensive copies; mutating a
returned object must not mutate the canonical local ledger.

## Order flow

1. `previewOrder(draft)` validates the local policy and creates a preview ID,
   normalized draft hash, estimated amount, quote, and expiry. Malformed,
   non-positive, or type/limit-price-inconsistent drafts are rejected before a
   preview is created.
2. Any changed ticket field produces a different draft hash. The old preview
   cannot be consumed for the new draft.
3. A preview expires after the local preview window. An expired preview is
   invalidated and cannot be consumed; the user must create a new preview.
4. `consumePreview(previewId, draftHash)` rechecks the current quote status,
   buying power, and sellable position before consuming the preview once and
   creating a local fictional order. There is no broker request. Mock event
   timestamps use the adapter clock so expiry tests and the resulting timeline
   share one deterministic time source. A failed recheck cannot consume the
   preview.
5. `unknown` and `reconciliation-failed` scenarios create/retain an Unknown
   state; the UI must say not to resubmit.
6. `reconcileOrder(orderId)` is the only path that moves an Unknown Mock order
   to a known working state, and it can fail deterministically.

## Fault scenarios

| Scenario | Expected behavior |
| --- | --- |
| healthy | normal local snapshot and preview |
| empty-account | cash-only account, empty holdings/orders |
| loss | negative account and holding P&L |
| no-buying-power | zero buying power; preview rejected |
| insufficient-quantity | sell/quantity safety failure |
| market-closed | quote marked stale and preview blocked |
| stale-quote | stale quote visible; preview blocked |
| offline | snapshot marked offline; no refresh pretending to work |
| reauth-required | data marked reauthorization required |
| request-failed | deterministic request error |
| rate-limited | deterministic rate-limit error; no retry |
| timeout | outcome is not known; do not resubmit |
| unknown | local order enters Unknown |
| reconciliation-failed | Unknown remains locked |

## Reset and test isolation

`reset()` returns the broker to the healthy base snapshot and clears preview
state. Settings → Clear local demo data invokes this reset as well as clearing
local preferences, automation state, and the evidence journal. Tests should use
a fresh broker or call `reset()` in `afterEach`.

## Extension rule

Future broker adapters must implement the same contracts and capability flags.
Adding a live adapter must not change the Mock adapter's semantics or silently
enable real writes. Unknown, stale, offline, and reauthorization states remain
first-class data statuses.
