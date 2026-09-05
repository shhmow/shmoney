# Budgeting-First Apps: YNAB, Actual Budget, Lunch Money — Budget Modeling, Creation & Editing UX Research

*Research for shmoney (dark, minimal, self-hosted dashboard). Verified against current official docs and community sources, August 2026.*

---

## 1. Budget Models Compared

**Zero-based / envelope (YNAB, Actual).** You can only budget money you actually have. Every dollar of real account balance is assigned ("given a job") to a category envelope. The core invariant: `sum(category assigned) + unassigned = total cash`. Ready to Assign (YNAB) / To Budget (Actual) must reach zero. Category balances are *real money*, so moving money between categories is a first-class operation, and overspending must be "covered" from somewhere else. Unspent balances roll forward as envelope balances by default.

- **Pros:** enforces honesty (can't budget money you don't have); rollover makes sinking funds (annual bills, car repairs) natural; overspending is impossible to ignore.
- **Cons for a low-effort user:** requires accounts + balances to be modeled accurately; requires a recurring "assign money" ritual every month/paycheck; overspend states demand action; famously steep learning curve (YNAB's own community treats the mental model as something you must be taught — "give every dollar a job", "age your money").

**Category-target (Lunch Money).** A budget is just a number per category per period: "I intend to spend ≤ $400 on Groceries this month." It works off *expected income/spending*, not account balances — there is no requirement that budgets sum to anything, no mandatory assign step, and nothing breaks if you skip a month. Columns are **Budgeted / Activity / Available**, but "Available" is informational (budget − spend), not an envelope of real cash. Rollover is **opt-in per category** ("Rollover to the same category" for sinking funds, "Rollover to the general pool", or "Do nothing").

- **Pros:** near-zero maintenance; a budget can be created in one sitting and left alone; presets automate the monthly refresh entirely; forgiving — an overspent category is just a red number, not a broken invariant.
- **Cons:** no enforcement — nothing stops total budgets exceeding income; sinking funds are weaker; less "behavior change" power.

**Hybrid.** Lunch Money is itself the hybrid proof point: it defaults to category-targets but lets you toggle general-pool rollovers to "support zero-based or envelope budgeting methods." YNAB's *targets* layered on envelopes are also hybrid-ish: the target is the declarative intent, the envelope is the mechanism.

**For shmoney's chosen model (single user, low-effort category targets): Lunch Money's model is the right skeleton.** Steal from YNAB only the *target declaration + progress* UX, and from Actual only the *automation/fill-from-history* ideas — not the envelope invariant.

---

## 2. Budget Creation Flow Per App

### YNAB (~first-run)
1. **Create a plan** → currency/date format → onboarding wizard.
2. **Categories seeded by default.** A new plan comes with pre-built categories (mortgage/rent, groceries, home maintenance, vacation…) rolled into groups like **Bills**, **Needs**, **Wants**, **Savings**. YNAB also ships **category templates** (support.ynab.com "Category Templates") — themed ready-made lists (beginner template, etc.) you can import selectively, "selecting only the categories that inspire you."
3. **Set targets per category.** Click a category → right-hand **inspector** panel → *Add Target*. Dialog: amount ("How much do you need?"), cadence (**Weekly / Monthly / Yearly / Custom** date), and one of three behaviors:
   - **Set aside another $X** — assign the full amount again each period regardless of leftovers;
   - **Refill up to $X** — top the envelope back up (only asks for what you spent);
   - **Have a balance of $X by [date]** — YNAB divides the remaining amount over remaining months.
   No auto-suggestion from spending history at creation time — the user types the number (history-based amounts come later via Auto-Assign).
4. **Connect accounts, then Assign.** Ready to Assign shows unallocated cash; the **Auto-Assign** panel offers five one-click fills: **Underfunded** (fund all targets), **Assigned Last Month**, **Spent Last Month**, **Average Assigned**, **Average Spent**.
5. **Recurring bills** are not modeled separately — a bill is just a category with a monthly "Refill up to" or yearly "Set aside another" target. (Scheduled transactions exist but don't drive budget amounts.)

### Actual Budget
1. New budget file seeds **starter categories** in groups (one immutable **Income** group; expense groups like Usual Expenses). Add via hover → down-arrow → **Add category**.
2. Budget table per month: **Budgeted / Spent / Balance** columns plus a **To Budget** header amount. You type amounts directly into Budgeted cells.
3. **Month 3-dot menu** shortcuts: *Copy last month's budget*, *Set budgets to 3 month average*, apply/overwrite templates, *Hold for next month*.
4. **Goal templates** (still flagged experimental, enabled in settings): notes on a category containing directives — `#template 50`, `#template up to 150` (refill), `#template 10000 by 2025-12` (save by date), `#template schedule Internet` (fund a recurring bill from its Schedule), `#template average 3 months`, `#template 10% of all income`, `#template remainder`, with priorities (`#template-1`) and a separate `#goal 500` for balance-based progress indicators. Applied via **Budget Actions → Check templates / Apply budget template / Overwrite with budget template**.
5. **Budget Automation** (newer experimental UI) wraps the same engine in a graphical editor: hover a category → **pie-chart icon** → add automations of seven types (**Fixed Amount, Save by Date, Cover Schedule, From History, % of Income, Refill to Cap, Whatever is Left**) with projected amounts previewed. This is the direction Actual is going — declarative per-category rules, one-click monthly fill.
6. **Recurring bills** integrate deeply: define a **Schedule** (Internet, $72.99 monthly), then `#template schedule Internet` / "Cover Schedule" budgets exactly what the bill needs, including smoothing annual bills monthly.

### Lunch Money
1. Onboarding "**Start fresh**" path prompts you to select/customize categories from **preset category lists** (dropdown "Add preset categories", checkbox each or "Select all"; a "Detailed categories" preset includes groups). Bulk "Custom (Advanced)" entry: one per line, `-` prefix for subcategories, properties in brackets (`[income]`, `[exclude_from_budget]`, `[exclude_from_totals]`).
2. Budget Settings: choose **budgeting period** (monthly default, weekly/bi-weekly/custom, with "Starting On" date) and income mode (**Expected Income / Actual Income Activity / Larger of the two**).
3. **Budget page**: rows of categories with **Budgeted / Activity / Available** columns; sidebar shows a **Budget Status Card** and **Net Total Available**. Click the Budgeted cell → type a number, **and a suggestion list appears**: *Left to budget, Zero out available, This period's spend, Last period's spend, Avg spend last 3 periods, Last period's budgeted, Total expected recurring*, plus any preset value. This is the single best "target amount from history" UX of the three — suggestions at the point of entry.
4. **Budget Presets** per category (arrow icon at row end): *Set fixed amount / Fill 'Available' up to X / Set to previous period's spend / Set to previous period's budget / Set to average spend of last 3 periods / Set to total expected recurring / Do nothing*. Applied each period via one **"Apply Budget Presets"** button (or per-row checkmark). Also **Copy Budget** from any prior period (fill-empty-only or overwrite modes).
5. **Recurring items** are first-class: detected/declared recurring transactions with any cadence and start/end dates; the budget then offers "**Total expected recurring**" as a suggested/preset amount per category — bills effectively budget themselves.

---

## 3. Mid-Month Editing & Overspend UX

- **YNAB:** click a category's **Available** pill → **Move Money** (choose amount + destination) or, if negative, **Cover Overspending** (choose a donor category; iOS auto-fills the underfunded amount). Overspend states: **yellow** = credit overspending, **red** = cash overspending. At month rollover, red overspending is *not* carried in the category — the balance resets to 0 and the shortfall reduces next month's Ready to Assign; yellow becomes carried credit-card debt. A 2025-era addition lets you cover overspending from money already assigned in *future months*. Targets can be **snoozed** for a month.
- **Actual:** click the **Balance** amount → *Transfer to another category* (or to/from To Budget). Overspending deducts from next month's **To Budget** and the category resets to zero — unless you set **Rollover overspending** on that category to carry the negative balance (useful for reimbursements). *Hold for next month* parks income.
- **Lunch Money:** click the **exchange icon** next to Available → move an amount between two categories for this period only; net total unchanged. Overspend is simply a negative Available shown in red — no forced covering. At period rollover, each category's rollover setting decides: carry to same category, dump to general pool, or reset. This "shrug-friendly" overspend model fits low-effort users best.

---

## 4. Category Management UX

- **Groups:** all three use two-level hierarchy (group → category). Actual: exactly one Income group, cannot be deleted. Lunch Money: groups optional; **group-level budgeting** toggle ("one combined jar") is a great low-effort feature — budget the group, let subcategories float.
- **Custom categories:** all three allow create/rename/reorder anywhere; Lunch Money also lets you create categories inline from the transaction screen and CSV import.
- **Emoji/icon/color:** none of the three has a structured icon or color picker for categories — the universal community convention is **emoji prefixes in the category name** (YNAB onboarding literally suggests "add a little emoji flair"; Lunch Money users prefix groups with markers like 🔸). Since shmoney forbids emojis, the non-emoji conventions observed: **Actual's approach** — plain text names, hidden categories rendered in *lower-contrast color*, a small **note (paper) icon** and goal-status indicator dot per row; YNAB communicates state through the **colored Available pill** (green/yellow/red) and progress bars rather than category icons; naming conventions like numbered prefixes ("1. Bills") for ordering are common in all three. A muted per-category accent color or a two-letter monogram chip would be a faithful non-emoji substitute.
- **Archiving:** YNAB and Actual = **hide** (data preserved, row collapsed/dimmed); Lunch Money = explicit **archive** plus **merge** and delete. Actual's delete flow prompts you to pick a category to receive orphaned transactions/balance — worth copying. Never hard-orphan transactions.
- **Flags:** Lunch Money's per-category booleans — *treat as income, exclude from budget, exclude from totals* — are a clean minimal property set.

---

## 5. Reports/Tools Inventory

| App | Ships | Community sentiment |
|---|---|---|
| **YNAB** ("Reflect" tab) | **Spending Breakdown** (donut, % by category), **Spending Trends**, **Net Worth**, **Income v Expense** (matrix: categories × months with averages/totals), **Age of Money** | Spending Breakdown and Net Worth are the workhorses; Income v Expense loved by spreadsheet types; **Age of Money is widely ignored/mocked** as a vanity metric; long-running complaint that YNAB's reports are thin (hence the Toolkit browser extension ecosystem) |
| **Actual** | Customizable **dashboards** with widgets: **Net Worth** (trend/stacked), **Cash Flow**, **Spending Analysis** (period comparison), **Summary card**, **Calendar card** (daily in/out heat-calendar), **Text widget** (markdown headings), **Crossover Point** (FI projection), plus fully **Custom Reports** with filters and live date ranges | Custom dashboard is a headline feature post-2024 and well liked; Net Worth + Cash Flow most used |
| **Lunch Money** | **Stats & Trends** (spending over time), **Query Tool** (custom filtered datasets → pie/line/table), **Net Worth Tracker** (auto end-of-month snapshots, % change per account and per asset/liability group, CSV export), budget **Historical Spend** view | Query Tool and Net Worth are the most praised; reviewers call the stats "detailed" and the overall app "way easier than YNAB" |

For shmoney with ~8 categories: the universally used set is just **(a) budget-vs-actual progress, (b) spending trend over months per category, (c) net worth line, (d) income vs expense bars**. Skip novelty metrics (Age of Money).

---

## 6. Recommendation: Minimal Budget-Creation UX for shmoney

**Model:** Lunch Money-style monthly category targets. No envelope invariant, no "ready to assign." One table: `budgets(category_id, month, amount)` + optional per-category `rollover: none | same_category` and a `preset` rule. Data model for a preset: `{type: fixed | last_month_budget | avg_3mo_spend | recurring_total, value?}` — this is Actual's Budget Automation collapsed to four types.

**Screen 1 — "Set up your budget" (first run, replaces the current display-only view when no budgets exist).**
A single page, not a wizard. Left: the user's existing ~8 categories as rows (seed a default list — Housing, Groceries, Dining, Transport, Utilities, Subscriptions, Fun, Savings — shown as pre-checked checkboxes, YNAB-template-style; unchecking skips, "+ Add category" inline). Right of each row: an **amount input**. On focus, show a **suggestion popover** (Lunch Money's killer feature): `Last 3-month average: $412 · Last month: $389 · Recurring bills in this category: $120`. Clicking a chip fills the field. Suggestions computed from transaction history already in shmoney; gray out when no history. Footer: running total **"Budgeted $2,340 / est. monthly income $3,100"** as a passive sanity bar (no enforcement). One button: **Save budget**.

**Screen 2 — Budget view (monthly).**
Rows: category name (plain text; state via a muted accent bar or dot, never emoji) · slim progress bar (spent/budget; neutral → amber ≥ 80% → red > 100%) · `spent / budgeted` figures · Available. Header: month switcher (`←  Aug 2026  →`) and a status line "3 of 8 on track". Overspend = red text only; no forced covering. Optional per-row overflow menu (`…`): **Edit amount** (same suggestion popover), **Move from another category** (simple two-field dialog: amount + source — YNAB's Move Money reduced to one modal), **Rollover: on/off**, **Set as preset** (auto-fill rule for future months), **Hide category**.

**Month rollover (zero-effort path).** On the 1st, auto-create the new month by applying each category's preset, defaulting to **"copy last month's budget"** when no preset exists — the user should never face an empty month. Show a dismissible banner: "September budget created from your presets — review". This merges Actual's "Copy last month" and Lunch Money's "Apply Budget Presets" into an automatic step with an undo, which none of the three quite does.

**Explicitly do not build:** ready-to-assign math, target cadences beyond monthly (add "yearly ÷ 12" later if asked), snooze, credit-vs-cash overspend distinction, category icons/colors pickers, goal-by-date. Do build: the suggestion popover (highest leverage, ~1 query), auto-rollover with presets, and archive-with-reassign on category delete (Actual's pattern) so history never orphans.

**Sources:** [YNAB Targets](https://www.ynab.com/blog/ynab-targets) · [How to Use Targets](https://support.ynab.com/how-to-use-targets-rk5kkI9ks) · [Auto-Assign](https://support.ynab.com/en_us/auto-assign-a-guide-r1gBNbBJo) · [YNAB Category Templates](https://support.ynab.com/en_us/category-templates-HknjS_RA) · [YNAB Get Started Guide](https://www.ynab.com/guide/the-ultimate-get-started-guide) · [Moving Money in YNAB](https://support.ynab.com/moving-money-in-your-plan-ryyCKbBJi) · [Cover Overspending w/ Future Funds](https://www.ynab.com/whats-new/use-future-funds-to-cover-overspending) · [YNAB Reports](https://www.ynab.com/blog/ynab-reports-and-data) · [Actual: How Budgeting Works](https://actualbudget.org/docs/budgeting/) · [Actual: Goal Templates](https://actualbudget.org/docs/experimental/goal-templates/) · [Actual: Budget Automation](https://actualbudget.org/docs/experimental/budget-automation/) · [Actual: Categories](https://actualbudget.org/docs/budgeting/categories/) · [Actual: Reports](https://actualbudget.org/docs/reports/) · [Lunch Money: Setting up Your Budget](https://support.lunchmoney.app/guides/budgeting/step-2-setting-up-your-budget) · [Lunch Money: Budgeting](https://support.lunchmoney.app/guides/budgeting/step-4-budgeting) · [Lunch Money: Category Creation](https://support.lunchmoney.app/setup/categories/category-creation) · [Lunch Money: Net Worth](https://lunchmoney.app/features/net-worth) · [College Investor Lunch Money Review](https://thecollegeinvestor.com/45433/lunch-money-review/) · [From YNAB4 to Lunch Money (Medium)](https://medium.com/@dragon.federation.ii/from-ynab4-to-lunch-money-notes-from-a-longtime-budgeter-4edf9a40df24)