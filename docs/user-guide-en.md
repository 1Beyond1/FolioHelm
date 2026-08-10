# FolioHelm Mock User Guide

## What this build is

FolioHelm is an unofficial local Windows interface concept for a future
Schwab-connected workflow. This release is Mock-only: all quotes, balances,
holdings, orders, receipts, and automation runs are fictional. It has no
broker connection and cannot move money.

## Start it

Run the portable EXE from the release bundle, or start the development preview:

```powershell
npm install
npm run dev
```

Open the local address printed by Vite. For a Windows desktop build use:

```powershell
npm run desktop:build:portable
```

## Explore safely

- Home shows the fictional account overview, chart, positions, activity, and
  investing heatmap.
- Markets provides the fictional watchlist and search.
- Instrument details support hover inspection and mouse-wheel period changes.
- Portfolio and Orders provide derived views of the same Mock Broker snapshot.
- Trade opens a modal, not a separate page. The four steps end in a fictional
  receipt and do not send a request.
- Automation is restricted to Mock, Paper Trading, and Dry Run. Real Trading
  is intentionally disabled.

## Try failure states

Open Settings → Mock scenario. Useful scenarios are Empty account, Loss account,
No buying power, Stale quote, Offline, Timeout, Unknown outcome, and
Reconciliation failed. The purpose is to verify that the UI explains what is
known and blocks actions when it is not safe to proceed.

## Settings and local data

The first language follows the system when supported and can be switched
between English and Simplified Chinese. Theme supports System, Dark, and
Light. Optional protections are on by default; disabling one requires reading
the risk details, waiting for the countdown, and confirming the risk.

The Evidence Journal is local and Mock-only. Verify it before exporting. Never
put API credentials or real account records into a Mock evidence bundle.

## Important warning

Do not enter a Schwab App Key, App Secret, OAuth code, token, or real order
details into this build. The API Gate is pending official documentation and a
separate security review.

