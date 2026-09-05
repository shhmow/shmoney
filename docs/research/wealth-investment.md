# Wealth & Investment UX Research: Sure, Empower Personal Dashboard, Ghostfolio

Research for **shmoney** (dark, minimal, self-hosted; checking + 3 credit cards + Fidelity Roth IRA / brokerage / inherited IRA). Verified against the live Sure codebase (`we-promise/sure`, ~9.6k stars, actively developed with 3,200+ commits as of mid-2026), current Ghostfolio releases, and 2025–2026 Empower reviews/support docs.

---

## 1. Screen inventory per app

### Sure (community fork of Maybe Finance)

Top-level nav is deliberately tiny — four items: **Home (dashboard)**, **Transactions**, **Reports**, and **Assistant** (AI chat, rendered as a persistent right-hand sidebar on desktop, a nav item on mobile). A left sidebar lists all accounts grouped by type with sparklines per group (`accountable_sparklines`). Everything else hangs off those:

- **Home** — a *widget-based, drag-to-reorder, collapsible* dashboard. Section keys in `pages_controller.rb`: `net_worth_chart`, `balance_sheet`, `cashflow_sankey`, `money_flow` (6-month income/expense bar chart), `outflows_donut` (spending-by-category donut), `investment_summary`, `insights_feed` (feature-gated). Widgets support half/full width and height sliders. A global period picker (options in `Period`: last day, current week, last 7/30/90 days, current/last month, YTD, last 365 days, 5y, 10y, all-time) rescopes the whole dashboard via Turbo frames.
- **Transactions** — unified ledger with categories, merchants, tags, rules engine, transfer matching, duplicate-merge, recurring-transaction detection, attachments, splits.
- **Reports** — a fork-added page (not in original Maybe): summary dashboard + draggable collapsible sections (`net_worth`, `investment_performance`, `investment_flows`, `budget_performance`, `transactions_breakdown`, `trends_insights`), Monthly/Quarterly/YTD/Last-6-months/Custom period tabs with prev/next chevrons, and a **print view** (plus Google Sheets export instructions).
- **Account detail pages** per accountable type — depository, investment, crypto, property, vehicle, credit card, loan, other asset/liability — each with a balance chart; investment accounts get a **Holdings tab**.
- Also shipped: budgets/budget categories, goals + goal pledges, imports (CSV/PDF), and a very large set of sync connectors the fork added: SimpleFIN, Plaid, Enable Banking, SnapTrade, IBKR, Trading212, Questrade, Coinbase, Kraken, Binance, Wise, Mercury, and ~10 more.

### Empower Personal Dashboard

Left-nav buckets: **Overview (Dashboard)**, **Banking**, **Investing**, **Planning**, plus Transactions. Dashboard is a stacked module feed: net worth, portfolio balances, cash flow, budgeting, market movers, retirement readiness. Investing section tabs: **Holdings/Balances, Performance, Allocation, US Sectors**. Planning holds: **Retirement Planner**, **Investment Checkup**, **Fee Analyzer**, **Savings Planner** (retirement savings / emergency fund / debt paydown).

### Ghostfolio

Nav: **Overview (Home)**, **Portfolio** (tabs: **Analysis, Activities, Allocations, FIRE**), **Accounts**, **Markets**, admin panel (self-host), and **Zen Mode** (strips numbers down to a "calm" performance-only view). Home shows total value, today's change, a performance line chart with `Today / WTD / MTD / YTD / 1Y / 5Y / Max` range chips, a holdings tab, and a summary tab with a full ledger of metrics (buys/sells, fees, dividends, interest, cash, emergency fund, annualized performance).

---

## 2. Net worth presentation

- **Sure**: The dashboard's `net_worth_chart` is a D3 area/line chart of total net worth with a % / absolute change badge against the comparison period, driven by the global period picker (30/90 days, YTD, 1y, 5y, 10y, all). Underneath, the **balance sheet widget** is the star: assets vs liabilities as two grouped lists by accountable type — **Cash (depositories), Investments, Crypto, Property, Vehicles, Other Assets** vs **Credit Cards, Loans, Other Liabilities** — each group with subtotal, % of total (segmented horizontal bar), and per-account rows. The left sidebar mirrors this grouping with mini sparklines per group. This asset-classification convention maps 1:1 onto shmoney's account mix.
- **Empower**: Net worth is the anchor module — a historical line chart (default ~90 days, adjustable ranges + custom dates) with assets and liabilities in a grouped account list (Cash, Investment, Credit, Loan, Mortgage, Other Assets/Liabilities), each account showing balance + daily change. Real estate auto-values via Zillow Zestimate; collectibles/vehicles are manual. Weekly email snapshot of net worth + market recap is a beloved retention feature. Notably **no historical data import** — history starts the day you sign up (a repeated complaint).
- **Ghostfolio**: There is no true "net worth" concept — it's portfolio-value-centric. The home chart is portfolio value/performance over time; cash lives in accounts and liabilities are a bolted-on activity type. Accounts page is a flat table (name, currency, platform, transaction count, balance, value). For a checking+cards user this is Ghostfolio's biggest gap — it tracks *wealth*, not *net worth*.

---

## 3. Investment views

**Holdings tables.**
- *Sure* (`holdings/index.html.erb`): columns are **Name / Weight / Average Cost / Holdings (qty × price = value) / Return**, with a dedicated **cash row** at top of each investment account. Cost basis is average-cost; Return is simple gain vs cost basis (no TWR/IRR — a known limitation inherited from Maybe). No sortable columns.
- *Empower*: ticker, shares, price, **1-day change ($ and %)**, total value, gain/loss; three sub-tabs (Balances/Performance/Allocation). Consolidates across all linked accounts with a per-account filter — so the same fund in two accounts appears once in "all accounts" view and separately when filtered. This filter-based aggregation is the cleanest answer to the "FXAIX in Roth + brokerage" overlap problem.
- *Ghostfolio*: holdings are **aggregated by symbol across all accounts** by default; clicking a position opens a detail dialog with its own performance chart, average unit price, transactions list, and which accounts hold it. Columns: name/symbol, value, gain/loss %, allocation %.

**Allocation breakdowns.**
- *Empower*: interactive **treemap-style box chart** (click a box to drill from asset class → sub-class → holding) across US/Intl stocks, US/Intl bonds, alternatives, cash — including **cash held inside mutual funds**, i.e., it does look-through on fund composition. Separate **US Sectors** bar comparison vs the S&P 500's sector weights.
- *Ghostfolio*: Allocations page pie/donut groupings **by asset class, by currency, by sector, by continent/country, by market (developed/emerging), by account, by ETF provider**, and an experimental **"By ETF Holding" look-through** that decomposes ETFs into underlying companies to reveal overlap between funds — the only one of the three that explicitly surfaces cross-fund overlap.
- *Sure*: weight-% column only; no class/sector/geo breakdown — allocation is its weakest area.

**Performance.**
- *Empower*: the **You Index®** — your current holdings' performance extrapolated backward, charted against selectable benchmarks (S&P 500 default, plus foreign, bond indexes); you can add an individual holding as a third line. Excludes bonds/options/alternatives it can't price.
- *Ghostfolio*: **ROAI (Return on Average Investment)** — a money-weighted-ish metric they renamed in 2025 precisely because users kept mistaking it for TWR; a **benchmark comparator** overlays indices on your chart; Analysis page adds an investment timeline (deposits over time), **Top 3 / Bottom 3 performers**, and dividend timeline. GitHub issues/discussions (#4341, #5451) show recurring user confusion and edge-case bugs (e.g., dividends received before later buys skewing %).
- *Sure*: `investment_summary` widget + Reports "investment performance" section: five cards (portfolio value, total return, period return, **contributions, withdrawals**), top-holdings mini-table, and — uniquely — **gains grouped by tax treatment** (taxable / tax-deferred / tax-free) with realized-vs-unrealized splits and warnings on taxable realized gains. Excellent idea for a Roth-vs-inherited-IRA household.

**Dividends.** Ghostfolio is the only strong one: dividend as a first-class activity type, monthly dividend bar timeline, projected annual income, per-holding yield, and one-click fetch of historical dividends from premium data providers. Empower shows dividends as income transactions in Cash Flow (Rob Berger filters cash flow to isolate dividend/interest income). Sure records dividends as trades/income but has no dedicated dividend view.

---

## 4. Cash-flow & income/spending views

- **Empower Cash Flow**: the canonical version — a monthly bar chart of income vs spending with this-month-vs-last-month comparison, tabs for Income / Spending / Bills, category donut, transaction-level drill-down, per-account filtering, and custom tags. Budgeting is just one total monthly target (no per-category goals) — universally cited as its weak spot. No sankey.
- **Sure**: ships an actual **cash-flow sankey** on the dashboard (`cashflow_sankey`, expandable to full-screen): income categories → total income → spending categories, widths proportional to amounts. Complemented by `money_flow` (6-month grouped income/expense bars with month selector) and `outflows_donut`. The **Reports summary dashboard** is effectively the income statement: Total Income, Total Expenses, **Net Savings** (color-coded), and Budget Performance (progress bar, green <80% / yellow / red ≥100%), followed by category breakdown tables with period-over-period deltas. This is the best-designed income-statement pattern of the three.
- **Ghostfolio**: none. No spending, no income categorization — out of scope for it.

---

## 5. Retirement / IRA-specific tools

- **Empower Retirement Planner**: the benchmark. Monte Carlo (~5,000 scenarios) → a single **retirement readiness score** ("chance your money lasts"), median/10th-percentile projection chart, income events (Social Security, pension, sale), spending goals, side-by-side scenario comparison. **Savings Planner** tracks *annual IRA/401k contribution progress against limits* — the simplest high-value thing to clone. Fee Analyzer projects expense-ratio drag to retirement age.
- **Ghostfolio FIRE page**: 4% rule ("with a total of $X you could withdraw $Y/yr"), a savings-rate input driving a compounding **projection chart** to your FI date, plus the **X-Ray** rule engine (pass/fail cards: account cluster risk, currency cluster risk, regional/emerging-market cluster risk, fee ratio, emergency-fund coverage). The X-ray "linter for your portfolio" pattern is very stealable.
- **Sure**: goals with pledges and the tax-treatment gains report, but no contribution-limit tracking, no RMD logic, no Monte Carlo.
- **Nobody handles inherited-IRA RMDs / the 10-year rule.** That's white space: a simple widget (year-of-death + balance → required annual drawdown schedule under SECURE Act rules, progress bar per year) would beat all three.

---

## 6. Five features worth stealing (ranked)

1. **Sure's balance-sheet widget + typed account grouping** (Cash / Investments / Property… vs Credit Cards / Loans) with subtotals, %-of-total bars, and sidebar sparklines — it *is* the net worth mental model for exactly shmoney's account mix.
2. **Sure's cash-flow sankey + income-statement summary cards** (Income / Expenses / Net Savings with period-over-period deltas) — one glance answers "am I saving money?", and the sankey is the single most-praised visual in the Maybe/Sure lineage.
3. **Empower's You Index** — extrapolate current holdings backward and overlay S&P 500; a simple daily-price × current-shares series is cheap to compute and answers "am I beating the market?" without full TWR math.
4. **Ghostfolio's X-Ray rule cards** — 5–6 static pass/warn rules (single-fund concentration, fee ratio, emergency-fund months, sector concentration) render as a linter, not a chart; huge insight-per-pixel for a minimal dashboard.
5. **Empower's contribution tracker** (Savings Planner) — Roth IRA progress bar vs the annual limit + a hand-rolled inherited-IRA RMD countdown; trivial to build, exists in no self-hosted tool.

Honorable mention: Ghostfolio's per-symbol aggregation with account drill-in (solves same-fund-in-2-accounts cleanly), Sure's gains-by-tax-treatment report.

---

## 7. User complaints / anti-patterns

**Sure**: performance problems on data-heavy installs (the project runs a public dashboard of slow requests/stacktraces and openly solicits perf fixes); investment returns are simple cost-basis gain — no TWR/IRR, no benchmarks, no allocation breakdown; average-cost basis only; bank sync depends on third parties (SimpleFIN subscription, self-supplied Plaid keys) that users find fiddly; Rails+Postgres+Redis is heavy for a homelab; fork churn — features land feature-flagged (`insights_feed`) and docs lag the app.

**Empower**: **advisor sales calls** after linking >$100k (Bogleheads threads literally titled "Memoir of my Empower 'Financial Advisor' call"; standard advice is "use the free tools, ignore the calls" — the dashboard is a lead-gen funnel for 0.49–0.89% AUM management); chronic aggregation/sync breakage and duplicate accounts (Yodlee-era plumbing); no historical import — history begins at signup; budgeting has no per-category goals; miscategorization requires monthly cleanup; no data export of any depth; and it's cloud-only — the anti-pattern shmoney exists to avoid.

**Ghostfolio**: no bank/brokerage sync at all — every activity is manual or CSV import (deal-breaker for many); **Yahoo Finance data breakage and rate-limiting** recurs (issue #6314, Feb 2026: "Yahoo Finance Data is Unavailable" across versions), pushing users to paid data providers; performance metric confusion — ROAI is money-weighted-adjacent and users expecting TWR file bugs (dividends-before-buys distorting returns, #5451); missing sector/country data for many non-US ETFs (#4257); no cash-flow/spending side; several niceties (ETF look-through, some X-ray rules) are premium-gated or "experimental" toggles even self-hosted; symbol search requires exact tickers; reported high memory use on large portfolios.

**Cross-cutting anti-patterns to avoid**: burying key numbers behind tabs (Empower's Investing section), metrics without method labels (Ghostfolio's return %), history that starts at signup (Empower), and allocation charts with no drill-down (Sure).

**Sources:** [Sure repo](https://github.com/we-promise/sure) (README, `app/views/pages/dashboard.html.erb`, `pages_controller.rb`, `app/views/reports/*`, `app/views/holdings/index.html.erb`, `app/models/period.rb`, layout/sidebar), [Rob Berger Empower review](https://robberger.com/empower-review/), [Wallet Hacks review](https://wallethacks.com/personal-capital-review/), [Empower You Index support doc](https://support-personalwealth.empower.com/hc/en-us/articles/201169610-What-is-the-You-Index), [Financial Samurai](https://www.financialsamurai.com/empower-personal-dashboard-review/), [Bogleheads advisor-call thread](https://www.bogleheads.org/forum/viewtopic.php?t=431481), [Ghostfolio repo/README](https://github.com/ghostfolio/ghostfolio), [Ghostfolio changelog/releases](https://github.com/ghostfolio/ghostfolio/releases), GitHub issues [#6314](https://github.com/ghostfolio/ghostfolio/issues/6314), [#4257](https://github.com/ghostfolio/ghostfolio/issues/4257), [#5451](https://github.com/ghostfolio/ghostfolio/issues/5451), [#4477](https://github.com/ghostfolio/ghostfolio/issues/4477), [discussion #3149 (ETF look-through)](https://github.com/ghostfolio/ghostfolio/discussions/3149), [XDA Ghostfolio review](https://www.xda-developers.com/this-self-hosted-app-changed-the-way-track-investments/), [Self Host Setup guide](https://selfhostsetup.com/posts/running-ghostfolio-portfolio-tracker/).