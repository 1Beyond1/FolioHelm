# Security Model

## Assets

The important assets are user credentials, OAuth tokens, account identifiers,
order intent, broker responses, local evidence, automation policy, and the
user's money. The current build intentionally does not possess the first five
live-account assets and cannot move money.

## Trust boundaries

1. React UI: untrusted presentation code. It may request local Mock actions but
   must never own secrets or decide that an Unknown order succeeded.
2. TypeScript domain: deterministic Decimal calculations, policy checks,
   Mock state machine, local journal, and automation guardrails.
3. Tauri/Rust boundary: currently only a minimal shell plus evidence
   primitives. Future credential and broker commands must be narrow,
   capability-scoped, and deny-by-default.
4. Schwab: an external system whose API contract, limits, authorization, and
   order ledger are authoritative only after official verification.
5. Optional notary: receives a commitment, never full trade/account data.

## Safety properties

- default profile is Mock and live writes are absent;
- financial calculations use integer-scaled Decimal values;
- preview binds a draft to a hash and is single-use;
- malformed or inconsistent order drafts are rejected before a preview exists;
- writes will never be retried automatically;
- Unknown is a locked state, not a failure that may be replayed;
- automation is bounded by mode, allowlist, session, value, concurrency,
  rate, idempotency, and kill-switch rules;
- future dates and stale/offline/reauth data carry explicit statuses;
- evidence rejects secrets and verifies its chain before import/export.

## Threats and mitigations

| Threat | Current mitigation | Remaining work |
| --- | --- | --- |
| accidental real order | no live adapter or write capability | official API Gate and independent review |
| duplicate order after timeout | Mock Unknown state, no retry, reconciliation wording | live broker reconciliation and crash recovery |
| floating-point money error | Decimal domain types | audit every live serialization path |
| stale quote used as fresh | scenario status and preview rejection | official entitlement/freshness contract |
| secret in logs/evidence | storage boundary and sensitive-field rejection | secret scanning and Rust credential review |
| tampered local evidence | SHA-256 chain and verification | transactional encrypted persistence and signing |
| runaway automation | caps, allowlist, idempotency, backpressure, kill switch | shadow/canary validation before any live mode |
| supply-chain/build confusion | lockfile, CI checks, hashable unsigned artifact | SBOM/attestation and signed release policy |

## Non-goals

This model does not promise zero defects, zero loss, broker correctness, market
data accuracy, or protection against a fully compromised operating system. It
does require the application to fail closed when it cannot establish the facts
needed for a safe action.
