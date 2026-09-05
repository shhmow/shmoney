# Runbook

## PRODUCTION (2026-08-25): shmoney on Cloudflare

- **Live URL:** https://shmoney.josephlove076.workers.dev (skeleton Worker, [app/](../app/))
- Deploy: `cd app && npx wrangler deploy` · Logs: `npx wrangler tail shmoney`
- Cloudflare account: josephlove076@gmail.com (wrangler OAuth, already authed)
- **Plaid redirect URI (registered in Plaid dashboard):** `https://shmoney.josephlove076.workers.dev/link/oauth`
- Plaid plan: **Trial** (free, 10 lifetime Items, real production data). Client ID + secret held by user; secret goes in via `wrangler secret put PLAID_SECRET` (+ `PLAID_CLIENT_ID`), never in chat/git.
## BUILD COMPLETE (2026-08-25 evening)

Full app deployed to https://shmoney.josephlove076.workers.dev — built by 3 parallel agents against [app/CONTRACT.md](../app/CONTRACT.md), reviewed + integrated by lead.
- Stack: Hono/TS Worker + D1 (id 29be106f…) + static SPA in app/public (vanilla ES modules, PWA) + daily cron 11:00 UTC (sync + month-rollover on the 1st).
- Secrets set: APP_PASSWORD (user), SESSION_SECRET, PLAID_CLIENT_ID, PLAID_SECRET.
- Auth: cookie session (HMAC), 30d; API 401s without it; webhook + login exempt.
- Verified: full typecheck clean; all GET endpoints 200 on empty DB; budget PUT/move/rebalance/rollover exercised locally; UI login + all 7 views + empty states render; PWA assets live.
- Deploy: `cd app && npx wrangler deploy`. Local dev: `.dev.vars` (dummy secrets) + `npx wrangler d1 migrations apply shmoney --local` + `npx wrangler dev`.
- Next: user links BofA/Fidelity/Amex/Discover in Settings (uses 4 of 10 trial Items), then Claude skills phase.

- **No OAuth registration / app profile needed on Trial plan** (dashboard: "Automatic bank access — no action needed"). Banks linkable immediately once the Link flow exists — no approval wait. (The wait only applies if we ever move to full Production access.) Trial meter: 0/10 Items used.
- Pending (user): add redirect URI in Developers → API; store keys via `wrangler secret put`.
- TODO before real data: Cloudflare Access gate in front of the Worker; D1 database (created during build-out).

# ARCHIVED: Self-Hosted Sure Setup (superseded — local dev/reference copy only)

*Set up 2026-08-25.*

## DECISION UPDATE (2026-08-25, later same day)

Laptop hosting rejected — it's the daily-driver Mac, not always-on. **Production home: PikaPods (~$3/mo managed hosting, Sure is in their official catalog).** The local Docker stack below is retained as a **dev/test copy only** — currently stopped (`docker compose down`, Colima stopped, autostart disabled). To revive locally: `colima start && cd sure && docker compose up -d`.

Tailscale plan is obsolete for production (PikaPods provides a public HTTPS domain, which also serves as the Plaid redirect base). Tailscale app remains installed but unconfigured.

### PikaPods setup steps
1. User: create account at pikapods.com, Add Pod → "Sure", accept default resources, pick region
2. Pod URL becomes the dashboard address (bookmark on phone — no VPN needed; Sure's own login is the auth layer)
3. Plaid keys go into the pod's Env settings tab (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=production). If Plaid vars aren't exposed in the Env tab, ask PikaPods support to add them (they're responsive)
4. Plaid redirect URI: `https://<pod-url>/accounts`

## Local dev copy (stopped)

- **Runtime:** Colima (lightweight Docker for Mac) — auto-starts at login via `brew services`
- **App:** Sure (`ghcr.io/we-promise/sure:stable`) via Docker Compose in [`sure/`](../sure/)
  - `sure-web-1` — Rails app on port 3000
  - `sure-worker-1` — Sidekiq background jobs (syncs)
  - `sure-db-1` — PostgreSQL 16 (all financial data lives here, volume `postgres-data`)
  - `sure-redis-1` — Redis (job queue)
- **Config:** `sure/.env` (secrets, chmod 600, NOT to be committed if this becomes a git repo) + `sure/compose.yml` (modified from upstream example: Plaid env vars added, hardcoded default secret removed)
- Containers have `restart: unless-stopped` → the whole stack survives reboots once Colima is up.

## Common operations

```bash
cd ~/Documents/side-projects/finance-bot/sure
docker compose ps                 # status
docker compose logs web --tail 50 # app logs
docker compose down               # stop
docker compose up -d              # start
docker compose pull && docker compose up -d   # upgrade Sure
```

Access: http://localhost:3000 (local) · https://<mac-name>.<tailnet>.ts.net (once Tailscale serve is on — fill in actual URL here).

## Phone access + HTTPS (Tailscale)

Tailscale app installed via Homebrew cask. Plan:
1. User logs into Tailscale on Mac + installs app on phone (same account)
2. `tailscale serve --bg 3000` → publishes Sure at `https://<mac>.<tailnet>.ts.net` with a real Let's Encrypt cert, reachable only from the user's own devices
3. That HTTPS URL doubles as the Plaid OAuth redirect base (`https://.../accounts`) — Plaid requires HTTPS redirect URIs; the redirect happens in the browser, so a tailnet-only URL works

## Plaid setup (user's account)

1. Sign up at dashboard.plaid.com (free)
2. Developers → Keys: copy `client_id` + Production `secret` into `sure/.env` (`PLAID_CLIENT_ID`, `PLAID_SECRET`; `PLAID_ENV=production` already set), then `docker compose up -d` to reload
3. Developers → API → Allowed redirect URIs: add `https://<ts.net domain>/accounts`
4. Products: enable Auth + Balance (Payments section) and all of Financial Management; leave Credit Underwriting and Fraud & Compliance off
5. Request Production access: describe as "personal financial management, self-hosted single user"; security questionnaire — answer honestly, select "Other" where the corporate options don't apply
6. OAuth institution access for: Bank of America, Fidelity, Amex, Discover (may show as Capital One). **Approval can take days–weeks per institution** (worst cases months). Connections activate in Sure's UI (Accounts → Link account) as approvals land.

Fallback if Plaid approval drags: SimpleFIN Bridge ($15/yr) — Sure supports it natively (Settings → SimpleFIN), can run alongside Plaid and be dropped later.

## Backups (TODO)

Compose file includes an optional `backup` profile (daily pg dumps). Enable once data starts flowing:
`docker compose --profile backup up -d` after pointing its volume somewhere sensible (currently `/opt/sure-data/backups`).

## Claude analysis layer (next phase)

PostgreSQL is exposed to Claude Code via `docker compose exec db psql -U sure_user sure_production` — no extra ports needed. Build skills (`/monthly-review`, `/networth`, `/allocation-check`) on top once real data is syncing.
