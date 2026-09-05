# Shmoney — Feature Spec

*2026-08-25. The master list of what we're building. Basis for the agent build-out after demo approval.*

- **UI demo (interactive mockup):** https://claude.ai/code/artifact/dcde634a-1bbf-4191-a946-e5351f002815
- **Build plan:** https://claude.ai/code/artifact/47dbb0e6-9449-4ef1-be9f-ffc3f4199891
- Chart palette validated per dataviz method (dark surface #15181a): series green #1fa168, categorical #3987e5/#d95926/#199e70/#c98500, status good #0ca30c / warn #fab219 / critical #d03b3b. UI accent (chrome only): #3ecf8e. Type: Schibsted Grotesk + IBM Plex Mono.

## Identity

- **Name:** shmoney
- **Look:** dark-first (deep charcoal ground, luminous accent), minimal, modern — Sure + Monarch lineage. Crisp, clean graphs. Light theme later, dark is default.
- **Form:** PWA (Add to Home Screen), phone-first layouts that scale up to desktop.

## Tabs / screens

### 1. Overview (home)
- Net worth headline + change (1M/3M/1Y/All) with line/area chart
- Account cards grouped by type (Sure balance-sheet pattern): Cash / Credit / Investments with subtotals — each with balance + mini trend
- **"Free to Spend" card** (Copilot pattern, best-in-class): budget minus spend minus *expected unpaid recurrings*, with month-to-date cumulative spending line vs dotted ideal-pace line; line color = pace state
- Recent transactions (last 5-8, cross-account)

### 2. Transactions (Monarch-style — user's key feature)
- **Two modes:** "All accounts" unified chronological feed / "By account" — account picker, then only that account's transactions
- Grouped by date; merchant name, category chip, account badge, amount (green for inflows)
- Search + filters (category, account, date range, amount)
- Tap transaction → detail: edit category, add note, mark recurring
- Pending transactions shown distinctly (italic/ghost)

### 3. Cash Flow
- Income → spending Sankey-style flow (money flow viz — user priority)
- Monthly income vs expenses bars (12-month trend)
- Savings rate

### 4. Budget *(redesigned from research — see docs/research/)*
Model: **Lunch Money-style monthly category targets** (no envelope math, no ready-to-assign). Table `budgets(category_id, month, amount)` + per-category `rollover` + optional `preset` rule.
- **Creation flow** (first run / "Edit budgets"): single page, seeded category list with checkboxes, amount input per row. On focus → **suggestion chips from own history**: `Avg 3 mo $412 · Last month $389 · Recurring in category $120` (Lunch Money pattern — highest-leverage feature). Footer sanity bar: "Budgeted $X / est. income $Y" (passive, no enforcement).
- **Monthly view**: progress bars with **projection-aware colors** (Copilot): neutral→on pace, amber = *projected* to exceed at current pace, red = over. Status line "5 of 7 on track".
- **Overspend repair** (Monarch): red "−$42" is clickable → move-money popover (cover from another category). One-click fix, not a guilt screen.
- **Rebalance** (Copilot): button computes previewed reallocation from actual spending, scope "this month only / from now on".
- **Auto-rollover**: on the 1st, next month auto-creates from presets (default: copy last month) + dismissible "September budget created — review" banner. User never faces an empty month.
- Explicitly NOT building: ready-to-assign, goal-by-date targets, credit-vs-cash overspend distinction, Age-of-Money-style vanity metrics.

### 5. Investments
- Total portfolio value + change, chart over time
- Per-account: Fidelity Roth / brokerage / inherited IRA
- Holdings table **aggregated by symbol across accounts** with account drill-in (Ghostfolio pattern — solves FXAIX-in-two-accounts overlap); columns: ticker, name, shares, value, day change, total gain/loss, weight %
- Allocation donut (US equity / intl / bonds / cash)
- **Portfolio checks card** (Ghostfolio X-Ray pattern): 4-6 static pass/warn rules rendered as a linter — single-fund concentration, fee ratio, emergency-fund months, sector concentration
- **Contribution tracker** (Empower pattern): Roth IRA progress vs annual limit
- **Inherited-IRA RMD widget** (white space — no existing app has this): SECURE Act 10-year-rule drawdown schedule w/ per-year progress
- Later: "You Index"-style benchmark line vs S&P 500; gains grouped by tax treatment (taxable/deferred/free — Sure pattern)

### 6. Settings / Accounts
- Linked institutions + connection health, relink buttons
- Category & rule management (merchant → category rules)
- CSV import
- Theme toggle (dark default)

## Data & sync (from build plan)

- D1 schema: institutions, accounts, transactions, balance_snapshots, holdings, securities, categories, rules
- Phase 2: CSV import path per institution
- Phase 3: Plaid Link + daily cron sync + webhooks + dedup
- Categorization: merchant-based rules engine, applied on import; uncategorized queue

## Claude layer (the "bot")

- Skills over D1: /monthly-review, /networth, /allocation-check, /goal-progress
- Scheduled monthly report
- Bulk rule drafting from uncategorized merchants
- Boundary: read/analyze only — never executes trades or moves money; not licensed financial advice

## Later / wishlist

- Goals (target amounts, dates, funding progress)
- Recurring detection & upcoming bills calendar
- Inherited IRA RMD planning views
- Budget rollovers
- Multi-currency (not needed now)
- Light theme

## Non-goals

- Multi-user, sharing, hosted-for-others
- Payments/transfers of any kind
- In-app AI chat via paid API (Claude Code covers analysis at $0)
