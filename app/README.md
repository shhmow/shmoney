# shmoney

A personal finance dashboard you run yourself. One Cloudflare Worker, one SQLite database (D1), bank data through Plaid. Free to host on Cloudflare's free tier; Plaid's Trial plan is free for up to 10 linked banks.

What it does: net worth over time, transactions with rules and flags, cash flow (sankey, month tables, top merchants), budgets with pace and rollover, investments (holdings, allocation, sectors, S&P comparison), a rough tax estimate, and recurring bills and paychecks with next dates.

No frameworks, no build step, no tracking. Dark theme only.

## Run your own copy

You need: a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, a free [Plaid](https://dashboard.plaid.com/signup) account, Node 20+.

```bash
git clone <this repo> shmoney && cd shmoney
npm install
npx wrangler login
scripts/setup.sh
```

`setup.sh` creates the D1 database, writes its id into `wrangler.jsonc`, applies migrations, asks for your secrets, and deploys. It prints your worker URL at the end.

Then in Plaid's dashboard (Developers → API), add `https://<your-worker-url>/link/oauth` to *Allowed redirect URIs*. Open the app, sign in with the password you chose, go to Settings → Link account.

### Secrets

| Name | What it is |
|---|---|
| `APP_PASSWORD` | The single password for the login screen. |
| `SESSION_SECRET` | Any long random string. Signs the login cookie. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | From Plaid → Developers → Keys. Use the **Production** secret; the Trial plan uses production data. |
| `ALLOWED_EMAILS` | Optional. Comma-separated emails allowed through Cloudflare Access if you put the worker behind it. |
| `APP_URL` | Optional. Public URL of the app if it is not the one requests arrive on (custom domain behind a proxy). |

Set any of them later with `npx wrangler secret put NAME`.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values; Plaid keys can be dummies
npx wrangler d1 migrations apply shmoney --local
npm run dev                       # http://localhost:8787
```

With dummy Plaid keys everything works except linking and syncing banks. To develop against a copy of your real data:

```bash
npx wrangler d1 export shmoney --remote --output=/tmp/dump.sql
rm -rf .wrangler/state/v3/d1 && npx wrangler d1 execute shmoney --local --file=/tmp/dump.sql
```

### Updating

```bash
git pull
npx wrangler d1 migrations apply shmoney --remote
npx wrangler deploy
```

Migrations are additive; your data stays.

## How it works

- `src/index.ts` handles auth (password cookie, or Cloudflare Access identity) and serves the static app from `public/`.
- `src/api/*` are the JSON endpoints, one file per page.
- `src/sync/index.ts` pulls transactions, balances and holdings from Plaid, applies your rules, then a fallback mapping from Plaid's categories. `src/sync/recurring.ts` finds bills and paychecks.
- A daily cron (11:00 UTC) syncs every bank and rolls budgets over on the 1st.
- `public/` is plain ES modules. Each `views/*.js` file renders one page into `#view`.

Money convention: `transactions.amount` is positive for money out, negative for money in (Plaid's convention).

## Plaid notes

- Trial plan: 10 lifetime bank links. Deleting a bank and relinking it uses another slot.
- History length is fixed when a bank is first linked. The app asks for 2 years; some banks give 90 days regardless.
- Plaid Link needs the redirect URI registered exactly as `https://<host>/link/oauth`.

## Privacy

Everything lives in your own Cloudflare account. The worker talks to Plaid (bank data), Yahoo Finance (prices, tickers only) and Google's favicon service (merchant logos, domain names only). Nothing else.
