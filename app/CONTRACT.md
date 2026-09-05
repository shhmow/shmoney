# shmoney build contract

Single source of truth for the parallel build. Read fully before writing code. If code and this doc conflict, this doc wins.

## Stack & hard rules

- Cloudflare Worker, TypeScript, Hono ^4 (only dependency). No other npm deps. Plaid via plain `fetch` to `https://production.plaid.com` — no Plaid SDK.
- D1 (SQLite) via `env.DB` binding. Schema = `migrations/0001_init.sql` (already applied; do not edit — add new migrations only if truly needed).
- Static frontend in `public/` served via assets binding (`env.ASSETS`), `run_worker_first: true` — `src/index.ts` (owned by the lead, do not edit) handles auth then falls through to assets.
- **NEVER use emojis anywhere** — UI, code comments, commit text. Symbols/SVG/initials only.
- Money: `transactions.amount` uses Plaid sign convention (positive = outflow). "Spending" queries = `amount > 0 AND is_transfer = 0 AND excluded = 0 AND pending IN (0,1 as appropriate)` on expense categories. Income = `amount < 0` or kind='income'.
- Dates: TEXT `YYYY-MM-DD`; months `YYYY-MM`; now = `new Date().toISOString()`.
- Env bindings interface (already in scope): `{ DB: D1Database; ASSETS: Fetcher; PLAID_CLIENT_ID: string; PLAID_SECRET: string; APP_PASSWORD: string; SESSION_SECRET: string }` — import type `Env` from `../types` (file `src/types.ts` exists).
- Error shape: `{ error: string }` with proper status. All /api responses JSON.

## File ownership (do not touch outside your area)

| Area | Owner | Paths |
|---|---|---|
| Glue/auth/router mount | LEAD (me) | `src/index.ts`, `src/types.ts` |
| Backend core | Agent A | `src/lib/**`, `src/sync/**` |
| API routes | Agent B | `src/api/**` |
| Frontend | Agent C | `public/**` |

## Module interfaces (Agent A exports; Agent B and LEAD import)

`src/lib/plaid.ts`:
- `plaidPost<T>(env, path, body): Promise<T>` — adds client_id/secret, throws `PlaidError` (has `error_code`, `error_message`) on non-2xx.
- `createLinkToken(env, opts?: {accessToken?: string}): Promise<string>` — products transactions+investments, redirect_uri `https://shmoney.josephlove076.workers.dev/link/oauth`; when `accessToken` given, build update-mode token.
- `exchangePublicToken(env, publicToken): Promise<{item_id: number}>` — exchange, fetch institution + accounts, insert `items` + `accounts` rows, then run `syncItem`.

`src/sync/index.ts`:
- `syncItem(env, itemId): Promise<SyncResult>` — transactions/sync loop (cursor), upsert accounts+balances, snapshot balances (today), holdings + securities + investment_transactions for investment accounts, apply rules to new uncategorized transactions, map Plaid personal_finance_category to our categories as fallback, refresh recurring detection.
- `syncAll(env): Promise<SyncResult[]>` — all active items sequentially (CPU: keep per-item work chunked).
- `detectRecurring(env): Promise<void>` — same merchant, similar amount (±20%), ~monthly spacing (25–35d) or weekly; upsert `recurring` with next_date.
- `applyRules(env, opts?: {retroactive?: boolean}): Promise<number>`.
- `SyncResult = { itemId, added: number, modified: number, removed: number, holdings: number, error?: string }`.

Plaid category fallback mapping (Agent A): INCOME→Income, FOOD_AND_DRINK_GROCERIES→Groceries, FOOD_AND_DRINK→Dining out, TRANSPORTATION→Transport, RENT_AND_UTILITIES→(RENT→Housing, else Bills & utilities), ENTERTAINMENT→Entertainment, GENERAL_MERCHANDISE→Shopping, TRAVEL→Travel, MEDICAL→Health, TRANSFER_IN/OUT & LOAN_PAYMENTS→Transfers (is_transfer=1), else Other.

## API surface (Agent B implements in `src/api/`, one Hono router per file, all mounted under `/api` by LEAD)

Export from `src/api/index.ts`: `const api: Hono<{ Bindings: Env }>` with everything mounted. Auth is enforced upstream in src/index.ts — do NOT implement auth in routes (exception: `POST /api/auth/login` is handled by LEAD too; skip it).

- `GET /overview` → `{ netWorth: {current, change1m, series: [{date, value}]}, groups: {cash: Acct[], credit: Acct[], investments: Acct[], totals: {...}}, freeToSpend: {amount, upcomingBills, budgetTotal, spentTotal, daysLeft, paceSeries: [{day, cumulative}], idealTotal}, recent: Txn[8] }`. Net worth series from balance_snapshots (sum per date; assets minus liabilities — credit/loan balances count negative).
- `GET /accounts`, `PATCH /accounts/:id` `{hidden?}`.
- `GET /transactions?from&to&account_id&category_id&q&limit=50&offset` → `{transactions: Txn[], total}` (Txn joins category name/color + account name/mask). `PATCH /transactions/:id` `{category_id?, excluded?, is_transfer?, notes?}` — when category changed, respond with `{transaction, ruleSuggestion: {merchant, category_id}}` so UI can offer rule creation.
- `GET /categories`, `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id` (delete requires `?reassign_to=` and moves transactions+budgets).
- `GET /rules`, `POST /rules` (`{match_value, category_id, retroactive?}` — applies immediately), `DELETE /rules/:id`.
- `GET /budgets?month` → `{month, rows: [{category_id, name, color, budget, spent, available, pace: 'ok'|'projected_over'|'over', projected}], totals, onTrack: {on, of}}`. Projection: `spent / dayOfMonth * daysInMonth` when >7 days elapsed.
- `PUT /budgets/:month` body `{rows: [{category_id, amount}]}` (upsert; amount 0 removes).
- `GET /budgets/:month/suggestions` → per expense category `{category_id, avg3mo, lastMonthSpend, lastMonthBudget, recurringTotal}`.
- `POST /budgets/:month/move` `{from_category_id, to_category_id, amount}`.
- `POST /budgets/:month/rebalance` `{apply?: boolean, scope?: 'month'|'future'}` — preview (apply=false) returns proposed rows keeping total constant, weighted by avg 3mo spend; apply persists (scope 'future' also writes budget_settings presets to fixed amounts).
- `POST /budgets/:month/rollover` — creates month rows from presets/copy-last-month (idempotent). Also called by cron on the 1st.
- `GET /cashflow?month` → `{income: [{category, amount}], spending: [{category_id, name, color, amount}], totalIncome, totalSpending, saved, savingsRate, months: [{month, income, spending}] (last 6), sankey: {nodes, links}}`.
- `GET /investments` → `{portfolio: {value, dayChange, series: [{date, value}]}, accounts: [{id, name, subtype, value}], holdings: [{ticker, name, quantity, value, costBasis, gain, gainPct, weight, accounts: [{account_id, name, quantity, value}]}] (aggregated by security), allocation: [{class, value, pct}] (map security.type: equity/etf/mutual fund→stocks, fixed income→bonds, cash→cash, else other), checks: [{id, label, detail, status: 'pass'|'check'}] (fee-drag placeholder pass, single-holding concentration >40%, emergency fund months vs 3 from cash/avg spending, allocation drift placeholder), retirement: {roth: {limit, contributed, room}, inheritedIra: {yearOfDeath, year, of: 10, suggested, taken} | null} }` from settings + investment_transactions.
- `GET /recurring` → list with next_date sorted; `PATCH /recurring/:id` `{active?, category_id?}`.
- `GET /items` → institutions with status/last_synced_at/account count. `DELETE /items/:id` (removes item + accounts, keeps nothing orphaned — cascade).
- `POST /link/token` `{item_id?}` → `{link_token}` (update mode when item_id given). `POST /link/exchange` `{public_token}` → `{item_id}`; both thin wrappers over Agent A functions.
- `POST /sync` → `syncAll` results. Body optional `{item_id}`.
- `POST /webhooks/plaid` — NO auth (LEAD exempts it); verify nothing for v1 beyond shape; on TRANSACTIONS webhook → syncItem for that item; store nothing else.
- `GET /settings`, `PUT /settings` (upsert keys: expected_monthly_income, roth_contribution_limit, roth_contributed_ytd, inherited_ira_year_of_death, inherited_ira_starting_balance).
- `GET /export/csv?table=transactions` → CSV download of transactions (and `?table=holdings`).

## Frontend (Agent C, `public/`)

Design source of truth: `design/demo.html` in the repo (copy of the approved mockup — match its look precisely: colors, type, spacing, dark-only theme, symbols-not-emojis, merchant-initial tiles). Build:
- `index.html` + `styles.css` + `app.js` (ES modules ok, no build step, no frameworks). SPA with hash routing (`#/overview`, `#/activity`, `#/cashflow`, `#/budget`, `#/invest`, `#/recurring`, `#/settings`).
- All data from `/api/*` (fetch, credentials same-origin). No fake data in production files. Loading skeletons + empty states (important: pre-link, everything is empty — every screen needs a designed empty state pointing to Settings → Link account).
- Login screen: password field posting to `/api/auth/login`, then reload.
- Link flow on Settings: button loads Plaid Link (`https://cdn.plaid.com/link/v2/stable/link-initialize.js`), `POST /api/link/token` → open → onSuccess `POST /api/link/exchange` → refresh. Relink button for `login_required` items (update mode). Show trial items used e.g. "4 of 10 connections used".
- Budget tab: month nav, rows w/ pace colors (ok=series green, projected_over=warn amber, over=crit red), suggestion chips in edit mode (from /suggestions), move-money popover wired to /move, Rebalance modal w/ preview diff then apply, rollover banner when next month missing, per-category rollover+preset controls.
- Transactions: All/By-account toggle, filters (category, account, search, date), infinite scroll or Load more, tap row → detail sheet (category select w/ "always categorize [merchant] like this" rule checkbox, exclude toggle, transfer toggle, notes).
- Overview: exactly the demo (net worth chart w/ range chips + crosshair tooltip, grouped account cards w/ subtotals, Free to Spend card w/ pace line, recent activity).
- Cash flow: sankey (compute layout from /cashflow sankey data — reuse demo's ribbon style), 6-month bars, savings tile.
- Invest: portfolio chart, allocation donut, holdings table (aggregated, expandable rows showing per-account split), portfolio checks, retirement cards (read/write settings inline for roth_contributed_ytd etc.).
- Recurring: upcoming list w/ next dates + monthly total.
- Settings: institutions w/ status pills + sync-now + relink + delete, categories manager (rename/color/hide/add/delete-with-reassign), rules manager, settings fields, CSV export links, manual full-sync button, logout.
- PWA: `manifest.json` (name shmoney, dark theme colors, SVG icon — draw a simple mark, no emoji), minimal `sw.js` (cache-first for static assets only, never /api), `<link rel=manifest>`, apple-touch tags.
- Charts: vanilla SVG exactly like the demo (reuse/adapt its chart JS). Palette tokens from demo CSS. Tabular numerals for money. Every chart hover → tooltip.

## Conventions

- SQL through small helpers (Agent A exposes `q(env, sql, ...binds)` / `first` / `run` in `src/lib/db.ts`); use prepared statements + binds everywhere (no string interpolation of values).
- Keep per-request CPU small: no unbounded loops over full tables in request handlers; use SQL aggregation.
- Cron behavior (LEAD wires, Agent A implements body): daily `syncAll` + snapshot; on day 1 also budget rollover for new month.
- Frontend fetch wrapper handles 401 → show login.
