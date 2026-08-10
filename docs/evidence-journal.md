# Evidence Journal

## Current implementation

The current Mock build has a local TypeScript evidence journal in
`src/domain/evidenceJournal.ts`. It stores only non-sensitive Mock/Paper/Dry
Run evidence in browser local storage under a versioned key. It is not a cloud
service and it does not upload anything.

Each record contains a schema version, event ID, sequence, UTC timestamp, app
version, event kind, redacted string payload, previous hash, and entry hash.
The entry hash is SHA-256 over canonical JSON. Verification detects:

- changed payloads;
- deleted or reordered entries;
- sequence gaps;
- previous-hash mismatches;
- unsupported schema versions;
- secret-like field names or values.

Settings provides local Verify, Export, Import, and Clear actions. Import is
accepted only after the complete chain verifies. Exports are Mock evidence
bundles and must not be treated as broker statements.

## Evidence recorded by the current UI

The current local journal can hold event kinds for order intent, user
confirmation, Mock response, state changes, reconciliation, automation runs,
and safety-setting changes. The current release does not claim that every UI
transition is automatically journaled yet; this is a release-quality item to
expand before any live capability.

## Required future design

Before real broker writes, the complete local record must include the intent,
confirmation, normalized draft hash, preview, nonce, broker request ID,
response summary, order ID, state transitions, Unknown handling, and
reconciliation. It must be stored transactionally with the order state.

The intended architecture is:

- local full evidence, encrypted at rest with a reviewed Windows key path;
- hash-chain verification and device signing in the Rust boundary;
- optional remote commitment containing only chain sequence, chain-head hash,
  device public key, time, app version, and device signature;
- no account number, symbol, side, quantity, price, order ID, strategy, or
  event body in a remote commitment.

The remote commitment/notary service is not implemented or operated by this
repository. A remote receipt cannot prove that a broker response was correct;
the broker's own order record and request ID remain necessary for disputes.

## Handling an Unknown outcome

Do not resubmit. Freeze the relevant budget, preserve the local evidence, query
the broker ledger once the adapter is available, and append the reconciliation
result. If reconciliation is unavailable, keep the order Unknown and make the
blocked state visible.

