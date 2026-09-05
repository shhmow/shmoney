# Personal-Finance App UX Research: Monarch Money & Copilot Money

Researched August 2026 via official sites, help centers (help.monarch.com, help.copilot.money), and third-party reviews (Rob Berger, Money with Katie, Penny Hoarder, Productive with Chris, HomeTechHacker, screensdesign.com, envelopebudgeting.com). Monarch's help center blocks fetching (403), so some Monarch flow detail is reconstructed from search-index snippets of those exact help articles plus screenshot-rich walkthroughs.

---

# Monarch Money

## 1. Screen/tab inventory

Monarch rebranded from monarchmoney.com to **monarch.com** and shipped a major redesign in Dec 2024 that carried into 2025–26. Web app left-nav (slimmed in 2025 so it "fits on a 13-inch laptop without scrolling," with settings/help moved into a profile sidebar):

- **Dashboard** — fully customizable, drag-and-drop widgets: net worth, recent transactions, budget status, upcoming bills, investment performance, goals, "Month in Review."
- **Accounts / Net Worth** — account list grouped by type (cash, investments, real estate via Zillow Zestimate sync, vehicles, loans, credit cards) with a net-worth chart; filter assets vs. liabilities.
- **Transactions** — unified ledger across all accounts.
- **Cash Flow** — income vs. expense analysis; home of the Sankey diagram.
- **Budget (renamed "Plan")** — flex or category budgeting plus multi-month forecasting; "Plan" is one of the 5 bottom tabs on mobile.
- **Recurring** — detected bills/subscriptions with due-date alerts; "Bill Sync" pulls bills from credit reports to find ones you forgot.
- **Goals** — save-up and pay-down-debt goals with target amount/date and planned monthly contribution.
- **Investments** — holdings across accounts, allocation, top movers, benchmark vs. S&P 500.
- **Reports** — three tabs (Cash Flow, Spending, Income), each with chart-type selector, filters, click-through to underlying transactions, and **saved reports**.
- **Advice / Assistant** — CPA-written recommendations + AI assistant.

Mobile: 5 bottom tabs (Dashboard, Accounts, Transactions, Plan, +1) with everything else in a profile-icon sidebar.

## 2. Charts & visualizations

- **Cash-flow Sankey** (the signature piece, Dec 2024): income sources flow left-to-right into expense groups and then categories. Interactive; timeframe from daily to yearly; a **chart selector toggles Sankey ↔ trend bars**; **shareable as an image with an option to hide all dollar amounts** — a privacy-aware social feature reviewers call "surprisingly addictive."
- **Net-worth line chart** — on Dashboard and Accounts; timeframe selectors; filterable to assets/liabilities/individual account types; includes manually-valued assets (Zillow, vehicles).
- **Budget progress bars** per category, with click-in to a **historical trend view of spend in that category**.
- **Reports charts** — bar/stacked-bar breakdowns of spending by category, group, or merchant over month/quarter/year; income charts; every chart segment is clickable to the transactions behind it.
- **Goal progress bars**; investment performance line vs. S&P 500.
- **Month in Review** — an auto-generated, story-style report of top categories, cash-flow trend, net-worth change.
- Styling: one consistent palette; each category has a **user-editable emoji + color** that reappears in every chart, list, and Sankey node, which is what keeps the visualizations cohesive. Dark mode throughout.

## 3. Budget creation & editing flow (detailed)

Monarch offers **two modes, switchable any time — even mid-month, no penalty**: **Flex Budgeting** (default since 2024) and **Category Budgeting**.

**Initial setup — "Budget Walkthrough":** a step-by-step wizard Monarch pushes hard.
1. **Expected income**: you set monthly income; help docs advise entering your *minimum* expected monthly earnings (Monarch shows your historical income to anchor this). The whole budget is income-anchored: `Income − Fixed − Non-monthly − Goals = Flex number`.
2. **Sort categories into three buckets**: **Fixed** (rent, car payment — pre-filled from detected recurrings), **Non-monthly** (insurance, taxes, seasonal — converted into monthly set-asides), **Flex** (groceries, dining, shopping — the variable stuff).
3. **The output is one number**: your monthly **Flex budget**, optionally broken into a **weekly flex number** so pacing is visible ("you're week 2 and have spent 60% of flex").
4. Amounts are **suggested from your historical averages** — the walkthrough shows past spending per category as you set each target; this is why Monarch imports history first.

**Category mode** instead sets a limit per category/group; you can budget at the *group* level (e.g., one "Food & Dining" number covering groceries + restaurants) or per category. A **"Left to Budget"** header shows planned income minus everything allocated — a soft zero-based nudge (it can sit positive; it doesn't force allocation to zero).

**Editing mid-month:** budget amounts are inline-editable on the Budget screen (click amount → type). Category rows show Budget / Actual / **Remaining** columns; remaining goes **red with a negative number (e.g. "-$65") on overspend**. Crucially, **clicking that red negative number opens a "move money" popup**: pick a donor category and an amount to cover the overage — lightweight envelope mechanics without full envelope dogma. Reviewers (emilyblasik.com) describe mid-month reallocation as the core monthly ritual: "as long as the bottom line stays positive, move money freely."

**Overspend:** no hard block — the row turns red, the flex/total number absorbs it, and notifications (configurable) warn when you're trending over. Nothing auto-deducts from next month unless rollover is on.

**Rollovers:** per-category toggle, in two places — hover a category on the Budget page → **gear icon → toggle rollover**, or in Settings. A **"cycle" icon next to the Remaining figure** signals rollover is active. You can set a **Starting Balance** (seed a rollover pot with more than one month's budget — for holidays/annual bills), and rollover can be enabled **on the whole Flex bucket** itself. Leftover *and* overspend both carry forward.

**Forecasting:** budget "Plan" view extends beyond the current month — set future months' budgets in advance and see projected totals.

**Goals integration:** each goal's planned monthly contribution is deducted as a budget line, so savings compete with spending in the same math.

## 4. Transactions UX

- **Unified ledger** grouped by date; per-account views via account pages; search across all accounts.
- **Filters:** account, category, merchant, tags, amount, goal, date. Tags are free-form and orthogonal to categories.
- **Categorization:** AI auto-categorizes; a one-click change offers to **create a rule** applying to "future and/or past transactions" matching the merchant. Full rules engine (match on merchant/amount/account → set category, rename, tag, hide). Transaction **splitting** across categories.
- **Swipe to Review** on mobile: new transactions arrive in a review queue; swipe to confirm/edit — turns cleanup into a 30-second daily habit.
- **Amazon/Target integration** (browser extension) itemizes retailer orders so they don't land in a generic "Shopping" bucket.
- **Recurring detection:** automatic, plus **Bill Sync from credit-report data**; upcoming-bill alerts before due dates.
- Household sharing: partners/advisors get access at no extra cost — collaboration is a first-class feature.

## 5. Five features worth stealing (ranked)

1. **Click-the-red-number → move money popup.** Overspend handling as a one-click repair, not a guilt screen. Trivial to build, huge UX payoff.
2. **Cash-flow Sankey with a chart-selector fallback (bars) and hide-amounts share mode.** The single most-praised finance viz of 2025.
3. **Category identity system (emoji + color) reused across every list and chart** — the cheap trick that makes a whole dashboard feel cohesive.
4. **Budget walkthrough anchored on historical averages + a single "flex number"** (with weekly pacing). Suggest targets from history; don't make users guess.
5. **Every chart segment clicks through to its transactions**, and any filter combo can be a **saved report**.

## 6. User complaints / anti-patterns

- **Bank connection reliability is the #1 gripe** (~a third of complaints in one 2025 review roundup): dropped connections, HSAs and small credit unions "a hot mess," duplicate accounts after reconnects; a reported bug where transactions occasionally auto-delete.
- **Email-only support** with slow turnaround.
- **Can't delete default categories, only hide them** — a persistent r/MonarchMoney annoyance.
- **Price** ($99.99/yr, $14.99/mo; no free tier, 7-day trial).
- **Flex-budgeting confusion**: fixed vs. non-monthly vs. flex sorting is a real onboarding hump; users mis-bucket and then their flex number looks wrong. Goals/credit-card payments interacting with cash flow confuses newcomers.
- **Investments still shallow** (long "beta" feel): no comparison of foreign holdings, weak retirement-vs-taxable breakdowns; crypto ≈ Coinbase only.
- The Dec 2024 redesign itself drew a vocal "where did my layout go" backlash — a caution about moving users' furniture.

---

# Copilot Money

## 1. Screen/tab inventory

iOS/iPadOS/macOS native (SwiftUI); a **web app since Dec 2025** that is still a subset (no Goals, no Cash Flow tab, no split transactions, no month/year-in-review). Navigation is a tab strip of **eight tabs, and the user can reorder them** (Settings → Appearance) by usage frequency:

- **Dashboard** — the hub: month spending graph + "Free to Spend," then stacked sections: **To Review** (new transactions), **Budgets** (trending categories snapshot), **Upcoming** (horizontally scrolling recurring cards), **Net This Month** (income vs. spend, vs. last month-to-date), referral module.
- **Categories** — the budget screen: top comparison chart + color-coded per-category bars; rebalance control; category groups via top-right menu.
- **Transactions** — flat ledger with search/filters/export.
- **Recurrings** — list or grid of paid / left-to-pay / future / archived recurrings.
- **Cash Flow** — income, spending, net income cards with YTD/MTD comparisons.
- **Accounts** — synced accounts, assets/debt, net-worth overview.
- **Investments** — holdings aggregated **by ticker across accounts**, performance vs. benchmarks.
- **Goals** — savings goals linked to real account balances.

Onboarding is an 11-step trust-building flow (screensdesign.com): manual account entry offered *before* Plaid credentials, notification-granularity carousel, soft paywall with social proof; the dashboard then runs a dismissible-tooltip guided tour.

## 2. Charts & visualizations

- **Dashboard spending-pace graph** (the hero): a month-to-date **solid line of actual cumulative spending against a dotted "ideal pace" line**, headlined by **"Free to Spend"** — what's left after subtracting *expected unpaid recurrings* from the budget. **The line's color changes** based on actual vs. ideal pace for today's date. This one chart answers "am I okay?" instantly.
- **Category bars with semantic color ramp**: **green = on pace, yellow→orange = projected to exceed, red = already over; outlined (hollow) bar segments = expected-but-unpaid recurrings**. Past months collapse to binary green/red. Projection baked into color is Copilot's most distinctive viz idea.
- **Category detail view**: tap the Categories top chart → yearly totals and monthly averages, navigable across past years/months; tap a category → monthly bar history with the budget line overlaid.
- **Cash Flow cards**: income chart, spending, net income with YTD/MTD frames and year-over-year comparison; drills to category and transaction level.
- **Animated budget dials / progress rings** with smooth transitions; net-worth and per-ticker investment charts; benchmark comparisons.
- Styling: dark-first, near-black background, one saturated accent per category (**user-picked color + emoji/Genmoji per category** carried through all charts), heavy haptics, spring animations, carefully designed empty states. Reviewers uniformly call it the best-looking finance app on iOS.

## 3. Budget creation & editing flow (detailed)

**Initial setup:** on connecting accounts, Copilot imports history and **auto-creates a starting budget from your historical spending per category** — you don't start from zero. The Categories tab appears pre-filled with suggested amounts; setup is then curation: add premade or custom categories, group them, set colors/emojis, exclude categories, enable rollovers. Historic transactions come pre-categorized; you review/approve (Money with Katie describes approving 7,121 back-transactions). **Budgeting is optional** — it can be disabled entirely (Settings → Features), turning Copilot into a pure tracker whose top chart then compares this month vs. last month instead of vs. budget.

**Editing a budget:** tap a category → detail view → **tap the budget line label → type a number**. A key mode switch per category: **"Same budget every month" vs. "Different budgets for different months,"** which lets you set distinct amounts for any historic or future month (lower December groceries, higher travel in July) without disturbing other months.

**Rebalancing (the "magic wand"):** the standout flow. Button at bottom of Categories tab (iOS) / top (Mac/iPad) → Copilot computes a **preview of suggested reallocations based on where you actually spent, keeping the total budget constant** — it shifts dollars toward overspent categories from underspent ones. You review the diff, then choose a scope toggle: **"Only this month" vs. "From now on"** (future months with custom amounts are preserved), then **Save**; swipe down to dismiss. This is "adjust budget to reality" as a one-tap, reversible, previewed operation — the answer to budgets rotting after month one.

**Overspend:** no blocking; the bar goes red, the Dashboard graph line crosses the dotted pace line and Free to Spend drops (it can go negative). Overages are also **highlighted on the Dashboard's Budgets section**. Notifications flag categories trending over.

**Rollovers:** enabled **globally in Settings with a "first month with a rollover"** date; from then on **both leftover and overspend carry forward and accumulate cumulatively** month over month. **Per-category opt-out** by tapping the category (right for utilities/fixed bills). Month-to-month budget edits interact with the rollover amount. Note the asymmetry vs. Monarch: Copilot is global-on/per-category-off; Monarch is per-category-on.

**Recurrings pre-allocation:** detected recurring bills are **pre-deducted at the start of the month** (the hollow bar segments and the Free to Spend math), so "you have $400 left" already accounts for the $180 of bills that haven't hit yet — arguably Copilot's smartest budgeting mechanic.

## 4. Transactions UX

- **To Review queue on the Dashboard** is the primary loop: new imports group by date; tap to edit, **"MARK AS REVIEWED"** to clear. Review ≈ approve categorization.
- **Copilot Intelligence**: on-device-feeling ML categorization that **trains on your corrections** (activates after ~30 reviewed transactions); reviewers report mis-categorization dropping to ~20% then near zero within 2–3 weeks. Supplemented by explicit **Name Rules** (match merchant string → rename/categorize).
- **Transaction types as first-class flags**: Regular, **Income ("I"), Internal Transfer ("T"), Recurring ("R")** — transfers and CC payments are excluded from spending math automatically; an **"exclude" toggle** removes e.g. business expenses from totals.
- Detail view: edit date/name/category/type, **split across months**, mark as recurring; Mac/iPad show **"Similar Transactions"** (same-name history + monthly totals) — great context while categorizing. Amounts/dates of synced data aren't editable.
- Filters: text search + stackable filters; filtered sets exportable (Mac/iPad). Manual transactions via **+** next to search.
- **Recurrings**: auto-detected from patterns; per-recurring **match filters you can edit inline** (tap underlined tokens) when detection drifts; statuses paid / left to pay / future / archived; Venmo email-forwarding integration for reimbursements.
- Unified ledger by default; per-account lists live in the Accounts tab.

## 5. Five features worth stealing (ranked)

1. **"Free to Spend" + actual-vs-ideal pace line with recurring bills pre-deducted.** One number and one line that answer "can I spend?" — the best single dashboard element in the category.
2. **Rebalance with previewed diff and "only this month / from now on" scope.** Budget maintenance as a suggested, reversible transaction rather than a spreadsheet chore.
3. **Projection-aware color semantics** (green/amber/red = on-pace/projected-over/over; hollow = expected unpaid). Encodes the *future* into a plain progress bar.
4. **To Review queue + learning categorizer + transaction types (transfer/income/recurring) excluded from spend math.** The whole data-hygiene loop in one inbox.
5. **Per-month budget overrides** ("different budgets for different months") — seasonal budgets without cloning or resetting anything.

## 6. User complaints / anti-patterns

- **Apple-only** is the overwhelming complaint: no Android ever shipped (promised for 2024), so **mixed-platform couples can't share a household** — reviewers call it "a real household blocker."
- **Web app is a thin subset** (no Goals, Cash Flow, splits, month-in-review as of early 2026) despite the Dec 2025 launch — "the real product still lives on iPhone."
- **Price creep**: now ~$95/yr, no free tier; several long-time users report not renewing because "no major updates in the past year."
- **Tracking, not planning**: no zero-based/envelope mode; it reports overspending after the fact rather than preventing it — YNAB refugees bounce off this.
- **US banks only**; no shared/collaborative accounts at all (even Apple-to-Apple sharing is weak vs. Monarch's household model).
- Confusion point: **Cash Flow tab totals ≠ Categories tab totals** by design (Cash Flow excludes unpaid recurrings; Categories includes them) — a documented, recurring "why don't these match" support question. Lesson for shmoney: if two screens compute "spending" differently, label the difference in the UI.
- Initial setup burden: reviewing thousands of historic transactions is powerful but heavy; the density of the 8-tab structure and long multi-account onboarding is flagged even by admirers.

---

**Cross-cutting takeaways for shmoney:** both apps converge on (a) category identity = emoji + color reused everywhere, (b) budgets seeded from history rather than blank forms, (c) a review-inbox loop as the daily habit, (d) overspend as a repairable state (move-money / rebalance) rather than a failure state, and (e) one hero chart per screen with click-through to transactions. Monarch's edge is the income-anchored plan and Sankey; Copilot's is pace-projection and recurring-aware "Free to Spend."

Sources: [monarch.com/features/budgeting](https://www.monarch.com/features/budgeting) · [monarch.com/features/tracking](https://www.monarch.com/features/tracking) · [monarch.com sankey blog](https://www.monarch.com/blog/visualize-your-cash-flow-like-never-before) · [monarch.com new mobile navigation](https://www.monarch.com/new-mobile-navigation) · Monarch help articles (via search snippets): [Rollover Budgets](https://help.monarch.com/hc/en-us/articles/4411119762196-Rollover-Budgets), [Creating Your Budget](https://help.monarch.com/hc/en-us/articles/360048883631-Creating-Your-Budget-in-Monarch), [Using Flex Budgeting](https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting), [Moving Money Between Categories](https://help.monarch.com/hc/en-us/articles/360048883591-Moving-Money-Between-Categories-to-Accommodate-Overspending), [Using Reports](https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports) · [robberger.com Monarch review](https://robberger.com/monarch-money-review/) · [productivewithchris.com Monarch review](https://productivewithchris.com/app-reviews/monarch-money-review-2025/) · [hometechhacker.com review](https://hometechhacker.com/monarch-money-review-budgeting-the-smart-way/) · [emilyblasik.com budget walkthrough](https://www.emilyblasik.com/blog/how-i-budget-with-monarch-part-2) · [blackandbrownmakegreen.com flex budget guide](https://blackandbrownmakegreen.com/blog/how-to-budget-in-monarch-flex-budget/) · Copilot help: [Quick Start](https://help.copilot.money/en/articles/11157550-quick-start-guide), [Dashboard](https://help.copilot.money/en/articles/6045480-dashboard-tab-overview), [Categories](https://help.copilot.money/en/articles/9504513-categories-tab-overview), [Rebalancing](https://help.copilot.money/en/articles/6206302-rebalancing-your-budget), [Rollovers](https://help.copilot.money/en/articles/3790828-budget-rollovers), [Editing Budgets by Month](https://help.copilot.money/en/articles/6206293-editing-budgets-by-month), [Transactions](https://help.copilot.money/en/articles/9554412-transactions-tab-overview), [Recurrings](https://help.copilot.money/en/articles/9778259-recurrings-tab-overview), [Cash Flow](https://help.copilot.money/en/articles/9682232-cash-flow-tab-overview) · [moneywithkatie.com Copilot review](https://moneywithkatie.com/copilot-review-a-budgeting-app-that-finally-gets-it-right/) · [screensdesign.com Copilot UI breakdown](https://screensdesign.com/showcase/copilot-track-budget-money) · [thepennyhoarder.com Copilot review](https://www.thepennyhoarder.com/budgeting/budgeting-copilot-money-review/) · [envelopebudgeting.com Copilot review](https://envelopebudgeting.com/articles/copilot-money-review)