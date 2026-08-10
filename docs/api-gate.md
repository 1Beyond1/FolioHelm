# Schwab API Gate

## Status

`API Gate Pending`. The current build deliberately does not connect to the
Schwab Developer Portal, perform OAuth, store credentials, read live data, or
send broker orders. Public community clients and historical migration pages
are useful for planning but cannot authorize a live release.

## What must be obtained before implementation

The official, current Developer Portal contract must be captured and reviewed
for the exact application and distribution model. Record the date, document
title/version, URL, and a redacted excerpt; never commit secrets or private
account data.

Required evidence:

- Individual versus Commercial application and open-source distribution rules;
- OAuth callback, PKCE, access/refresh lifetime, revocation, and reauthorization;
- account identifier/hash behavior and account permissions;
- quote, historical price, market-hours, account, holdings, order, and activity
  schemas;
- Preview, Place, Cancel, and Replace endpoints, request/response IDs, errors,
  partial fills, and Unknown semantics;
- REST and streaming limits, quotas, Retry-After behavior, subscription caps,
  and whether Preview counts as an order request;
- real-time/delayed market-data entitlements, caching, display, and
  redistribution restrictions;
- rules for automation, scheduling, unattended activity, and high-frequency
  request patterns.

## User-side preparation when the gate reopens

The user must use only the official Schwab Developer Portal and their own
account. The user, not this project, must create the Developer App, configure a
registered loopback callback if the official contract permits it, and retain
the App Key/Secret privately. Do not paste credentials into chat, Git, issues,
screenshots, browser search fields, or the frontend.

The project should receive only a redacted capability report and, during a
controlled local development session, credentials through a reviewed local
secret-entry path. No shared API key will be supplied by FolioHelm.

## Capability promotion gates

| Profile | Allowed before official gate | Additional approval |
| --- | --- | --- |
| Mock | fictional data and local order simulation | normal tests |
| Paper/Dry Run | local strategy records only | domain and UI tests |
| Read-only | none in current build | official contract, credential review, privacy review |
| Preview-only | none in current build | official Preview schema, failure injection, independent security review |
| Live write | none in current build | explicit product decision, user confirmation, canary, evidence and reconciliation audit |

If any endpoint, field, limit, entitlement, or distribution rule is uncertain,
keep that capability read-only or disabled. “Read-only” means the program may
display a verified local response but may not create, cancel, replace, or
otherwise mutate a broker order or account state.

