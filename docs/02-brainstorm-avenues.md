# Brainstorm: Avenues, Free-ness, and Claude Integration

*2026-08-25. Constraints: everything free (or nearly), AI analysis via existing Claude subscription (no API spend), personal use only.*

## Why we need an aggregator at all (the "why Plaid" question)

Banks do not let your own code log in and fetch data. There is no "Bank of America API for individuals." The only two ways to get your data out:

1. **Manually download CSV/OFX files** — free, but you log in every time. Fails the requirement.
2. **Go through an aggregator** — a licensed middleman (Plaid, MX, SimpleFIN, SnapTrade) that has signed data-access agreements with the banks. You authorize it once via the bank's OAuth screen; after that, *it* maintains the connection and your code asks the aggregator for fresh data whenever it wants.

The aggregator is nothing more than **the pipe**. It doesn't analyze, store long-term, or do anything smart — it turns "my bank" into "a JSON API my script can call." That's the entire reason Plaid (or any of them) is in the picture.

## The free-ness reality check

| Source | Cost | What you get | Catch |
|---|---|---|---|
| Plaid free tier | $0 | BofA + Fidelity incl. holdings | Developer signup + production approval friction; free-tier limits are fuzzy for individuals |
| SnapTrade Personal | $0 | Fidelity holdings/transactions only | Brokerage only — no BofA |
| SimpleFIN Bridge | $15/yr | BofA + Fidelity balances/transactions | Not $0; no per-security holdings |
| Manual CSV export | $0 | Everything | You log in each time (fails requirement) |

**Honest summary:** a truly-$0, fully-automated, holdings-included pipeline exists only if Plaid's free tier works out for an individual. The guaranteed-to-work fallback costs $15/year (SimpleFIN) — or $0 via SnapTrade (Fidelity) + Plaid free tier just for BofA. Everything else in the stack (storage, analysis, UI) can be genuinely $0.

## Claude integration — yes, and it's the best part

Your Claude subscription **can absolutely be the analysis engine**, with zero API cost, as long as the data lives locally:

- Run **Claude Code in this repo**, with all your financial data in a local SQLite DB. Ask anything: "break down my spending this quarter," "am I on track for X," "what's my asset allocation across the Roth + brokerage + inherited IRA, and where's the overlap?" Claude queries the DB directly. Covered by the subscription.
- Build **skills** (slash commands) for recurring analyses: `/monthly-review`, `/networth`, `/allocation-check`, `/goal-progress`. Each one is a repeatable, structured analysis you invoke whenever you want.
- **Scheduled tasks** can run a weekly/monthly review automatically and leave you a report.
- Claude can also *build and maintain* the dashboards/reports (HTML artifacts, charts) from the data.

The one boundary: the subscription powers *interactive/scheduled Claude Code use* — it can't be embedded as an API inside a hosted web app. For a personal tool that's no limitation at all; it actually pushes us toward the right architecture (local data, Claude on top).

Also a hard boundary worth stating: Claude analyzes and suggests; it never executes trades or moves money, and can't give personalized licensed financial advice — it's an analysis copilot, not an advisor.

## Existing open-source apps (build-on-top candidates)

| App | What it is | Sync | Investments | Notes |
|---|---|---|---|---|
| **Sure** (fork of Maybe) | Full personal-finance app: net worth, accounts, budgets, investments | Plaid (your own keys) | ✅ | Maybe Inc. died 2025; repo archived; community fork `we-promise/sure` is the live continuation. Rails, self-host via Docker, AGPL |
| **Actual Budget** | Budgeting/cash-flow, local-first, very polished | SimpleFIN built in | ❌ (balances only) | The strongest budgeting UX in OSS; SQLite under the hood |
| **Firefly III** | Self-hosted finance manager, powerful rules engine | SimpleFIN via data importer | ❌ weak | PHP; battle-tested; people already pair it with SimpleFIN + AI agents |
| **Ghostfolio** | Portfolio/wealth tracker | Manual/CSV | ✅ | Investment side only; no US bank sync |
| **Wealthfolio** | Local desktop portfolio tracker | Manual/CSV | ✅ | Privacy-first, no sync |

Observation: **no single OSS app covers both halves well.** Budgeting apps (Actual, Firefly) have no real investment support; portfolio apps (Ghostfolio, Wealthfolio) have no bank sync. Sure is the closest to "both," at the cost of running a heavier Rails app and bringing your own Plaid keys.

## The three avenues

### Avenue 1 — Build on existing OSS
Self-host Sure (or Actual + Ghostfolio side by side), connect sync, let Claude read their databases/exports for analysis.
- ✅ UI, categorization, budgeting logic already built
- ❌ Their data models are their own; Claude works around them; two-app setups split the data; you maintain Docker services either way

### Avenue 2 — Roll our own thin core (data-first)
A small sync script (aggregator → SQLite) + Claude Code as the entire brain. No web app initially — the "UI" is conversations, skills, and generated HTML reports/dashboards.
- ✅ Simplest thing that fully works; data model is ours; Claude-native from day one; UI can grow later if wanted
- ❌ No pretty always-on dashboard on day 1; we write the (small) sync + categorization layer ourselves

### Avenue 3 — Full custom app
Own sync + DB + web dashboard.
- ✅ Exactly what you want, looks how you want
- ❌ Most work; most of that work is rebuilding what Avenue 1 apps already have

## Recommendation

**Start with Avenue 2, keep Avenue 1 as an optional bolt-on.** Reasoning:

1. The differentiating feature of this project — Claude doing real analysis and long-term planning on your actual data — needs exactly one thing: **clean local data**. Every avenue requires building the sync→SQLite layer anyway (even Sure needs your own Plaid keys configured).
2. Once the data core exists, adopting an OSS UI later is cheap (point Actual/Ghostfolio at the same sources, or generate our own dashboards). The reverse — starting inside someone else's app and extracting the data model later — is painful.
3. It's the cheapest possible stack: $0 storage (SQLite), $0 analysis (Claude subscription), $0–15/yr for the pipe.

## Proposed next steps

1. Sign up for Plaid, attempt free production access as an individual (BofA + Fidelity). If friction: SnapTrade Personal for Fidelity + decide between Plaid-for-BofA-only or $15/yr SimpleFIN.
2. Design the SQLite schema: accounts, balances (daily snapshots), transactions, holdings, securities, categories.
3. Write the sync script + one-time CSV backfill of history.
4. Build first Claude skills: `/monthly-review`, `/networth`, `/allocation-check`.

## Sources

- [Sure (community fork of Maybe)](https://github.com/we-promise/sure) · [Maybe repo (archived)](https://github.com/maybe-finance/maybe)
- [Firefly III SimpleFIN import docs](https://docs.firefly-iii.org/how-to/data-importer/import/simplefin/) · [Firefly III + SimpleFIN + AI agent writeup](https://ricotan.com/firefly-iii-simplefin-openclaw-personal-finance-tracking/)
- [Actual Budget SimpleFIN docs](https://actualbudget.org/docs/advanced/bank-sync/simplefin/)
- [SnapTrade pricing](https://snaptrade.com/pricing)
