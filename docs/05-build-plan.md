# Build Plan (Plan of Record)

*2026-08-25. Full illustrated version: https://claude.ai/code/artifact/47dbb0e6-9449-4ef1-be9f-ffc3f4199891*

## Decision

Custom-build the app on Cloudflare's free tier. PikaPods/Sure path abandoned (cost + no code control). Local Sure instance retained as design reference only.

**Why $0 works:** PikaPods rents always-on servers (RAM held 24/7 → costs money). Workers run code only for milliseconds per request → free tier is generous, stable, sustainable. Sure required always-on (Rails+PG+Redis+Sidekiq); our app is serverless-first by design.

**Plaid-from-Worker confirmed:** outbound `fetch()` to Plaid's REST API is core Worker functionality, free tier includes it (50 subrequests/invocation; we need ~10/day). Plaid free tier covers ~100 institutions; we need 4.

## Stack

- TypeScript end-to-end (Java not supported on Workers)
- Hono (API + serving), React + Vite PWA (phone: Add to Home Screen)
- D1 (SQLite) + Drizzle ORM — schema: accounts, transactions, balance_snapshots, holdings, securities, categories, rules
- Cron Triggers: daily sync (one institution per invocation — stays under 10ms CPU limit)
- Cloudflare Access (free) gates everything to user's email
- Claude Code (subscription, $0) queries D1 via wrangler for analysis; skills: /monthly-review, /networth, /allocation-check

## Dashboard v1 features

- Accounts overview + net worth over time
- Money flow visualization (Sankey: income → accounts → spending categories)
- **Monarch-style transactions** (user-requested): per-account drill-down tabs + unified all-accounts chronological feed
- Per-card monthly spending by category
- Merchant-based categorization rules (no AI fees; Claude drafts rules in bulk)

## Phases

| Phase | When | What |
|---|---|---|
| 0 | now (user) | Cloudflare signup + Plaid application (starts the approval clock — days to weeks per bank) |
| 1 | weekend 1 | Scaffold, D1 schema, deployed Worker, Access, PWA on phone (empty but live) |
| 2 | weekend 1–2 | CSV import (one-time manual export) → dashboard useful pre-Plaid: balances, transaction views, per-card spending, rules |
| 3 | on approval | Plaid Link flow, daily sync cron, webhooks, dedup vs CSV history |
| 4 | ongoing | Claude skills layer — the "bot" half |
| 5 | later | Sankey polish, budgets, goals, inherited-IRA views |

## CORRECTION (2026-08-25): Plaid pricing ground truth

Earlier "free tier / ~100 items" claims were stale — that program (Limited Production) closed to new signups 2026-04-15. Current reality:
- **Trial plan** (new-signup free path): $0, auto-approved, real production data, **10 lifetime Items** (relinks can burn slots; deletions don't refund), includes Transactions + Investments + Balance + Liabilities. Unclear if/when it expires.
- **Pay-as-you-go** (what the rate card shows): our worst case = 4 items × $0.30 Transactions + Fidelity $0.18 holdings + $0.35 inv-transactions ≈ **$1.73/mo (~$21/yr)**. Skip Auth and the Balance product (not needed; balances ride along with transactions sync).
- Decision tree: Trial free now → if exhausted/expired: $1.73/mo, or switch to SimpleFIN ($15/yr, no holdings). DB stays aggregator-agnostic either way.

## Risks

- Plaid individual approval slow/rejected → CSV keeps dashboard useful; SimpleFIN $15/yr is drop-in fallback writing to same tables
- We own sync edge cases (pending txns, dupes, reconnects) — budgeted in Phase 3
- Free-tier changes → portable by design (SQLite + TS runs anywhere)
