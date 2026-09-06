# Sharing shmoney with friends

Goal: a friend clones a public repo, runs one script, and has their own private copy on their own free Cloudflare account, with their own banks. Nothing of yours ships with it.

## What ships and what does not

The public repo is `app/` only, exported with `app/scripts/export-public.sh` into a fresh directory and committed there as a brand-new repository with no history. Reasons:

- This repo's git history contains `docs/` with your income, employer, family names and tax facts. History cannot be scrubbed reliably; a fresh repo avoids the problem entirely.
- `app/CONTRACT.md`, `app/design/`, `app/BACKFILL-NOTES.md` and the `.claude/commands` are build-time notes about your instance. The export skips them.
- `wrangler.jsonc` ships with `database_id: REPLACE_ME`; `setup.sh` fills it in for each person.
- Your email is no longer in `wrangler.jsonc`. `ALLOWED_EMAILS` is now a secret (see rollout below).
- Plaid's redirect and webhook URLs are derived from each deployment's own origin, so nobody has to edit source.
- Tax defaults, the Roth and inherited-IRA cards, and the bank-links list no longer assume your accounts.

Never share a D1 dump. Categories, rules and settings in the database are personal.

## Steps for you (once)

1. Roll out the current code (below).
2. `cd app && scripts/export-public.sh ~/shmoney-public`
3. `cd ~/shmoney-public && git init && git add -A && git commit -m "shmoney" && gh repo create shmoney --public --source=. --push`
4. Read the README there once as a stranger would.

To publish updates later, re-run the export into the same directory and commit the diff. The export script refuses to run if it finds your email or database id.

## Steps for a friend

Everything is in `app/README.md`. Short version: Cloudflare account, Plaid account, `npm install`, `npx wrangler login`, `scripts/setup.sh`, register the redirect URI in Plaid, link banks in Settings. Cost: $0. Plaid Trial gives 10 lifetime bank links per Plaid account.

What they will hit:
- Plaid asks a few questions at signup (use case: personal finance, self-hosted). Trial needs no approval.
- Some banks (Capital One) only give 90 days of history no matter what.
- The daily sync runs at 11:00 UTC. The first sync happens when they link.
- Cloudflare Access is optional. Password login is the default.

## Rollout for your instance (run from `app/`)

```bash
npx wrangler d1 migrations apply shmoney --remote     # adds 0006 (recurring.kind)
npx wrangler secret put ALLOWED_EMAILS                 # paste: josephlove076@gmail.com
npx wrangler deploy
```

Then in the app: Recurring → Refresh. That re-detects everything: Claude moves to the Anthropic row at $106.25/mo, the car wash and paycheck appear, and the stale Claude.ai row is dropped.

Rent: Crestview's amounts vary (1390 / 130 / 695), so it stays under "Might be recurring" for you to Track at the amount you expect.
