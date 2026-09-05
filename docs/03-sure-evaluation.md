# Sure Deep-Dive: Build On It vs. Build Our Own

*2026-08-25. Context: vision is dashboard-first (all accounts + balances, expense breakdown per credit card), phone access required, everything as close to $0 as possible, Claude subscription as the AI.*

## Account inventory (updated)

| Account | Institution | Connection |
|---|---|---|
| Checking | Bank of America | 1 BofA connection covers both |
| Credit card | Bank of America | ↑ same connection, no extra cost/setup |
| Roth IRA | Fidelity | 1 Fidelity connection covers all three |
| Brokerage | Fidelity | ↑ |
| Inherited IRA (soon) | Fidelity | ↑ (same login → should auto-appear) |
| Credit card | Amex | 1 connection |
| Credit card | Discover (now Capital One) | 1 connection; acquisition may migrate it to Capital One's platform eventually — both are aggregator-supported, worst case is a reconnect |

**4 institution connections total.** Well within Plaid's free tier; also fine on SimpleFIN ($15/yr, 25-institution cap).

## Sure: what we learned

**Stack:** Ruby on Rails monolith + Hotwire frontend, PostgreSQL, Redis. Docker-based self-hosting. Active community fork (~9.6k stars, thousands of commits, regular releases).

**Sync:** Supports BOTH Plaid (bring your own free keys; setup is the convoluted part) and **SimpleFIN natively** (since v0.6.3; much simpler setup, $15/yr). Community reports some rough edges on SimpleFIN credit-card syncing — it's a young integration.

**Hosting:** Self-host only — no hosted/managed service exists (the company that would have run one is dead; that's why the fork exists). One-click deploys exist (PikaPods ~$3–5/mo, Railway). 

### Phone access without a hosting bill

Run it on the Mac at home + **Tailscale** (free personal VPN): phone gets a private, authenticated tunnel to the home machine. $0, zero exposed ports, works from anywhere. Only downside: the Mac has to be on (or asleep-with-wake) for the dashboard to load. Paid alternative if that annoys: PikaPods at ~$3/mo. Cloudflare Tunnel + Access is the other $0 route.

### Sure's AI features vs. the Claude subscription

Sure has **two separate AI systems**:

1. **In-app chat assistant** — needs an OpenAI-compatible **API key** (pay-per-token). A Claude *subscription* is not an API key; it cannot power this. Even pointing it at Anthropic's API = metered billing. **Verdict: skip it or treat as optional pennies.**
2. **Auto-categorization + merchant detection** — also uses the OpenAI key. Costs pennies/month with a cheap model, or skip it and use manual rules. Optional.
3. **External agent hook (the interesting one)** — recent Sure versions added agent/MCP support: Sure can expose its financial data to an external AI agent. Combined with Claude Code pointed at Sure's PostgreSQL DB (or its API/MCP), **the "deep analysis" layer runs on the Claude subscription at $0** — same architecture we planned, with Sure as the data+dashboard layer.

So: the built-in chat is a miss for the free requirement, but irrelevant — Claude Code on top of Sure's database *is* the finance bot, subscription-covered.

## How easy is Sure to build on top of?

Honest assessment:

- **Using + light tweaks:** easy. Docker up, connect accounts, dashboard on day one. Small UI changes to a Rails/Hotwire app are very Claude-Code-able.
- **Major custom features:** medium. It's a mature Rails monolith — well-structured but big. You're learning their data model and conventions. Fork drift is the real cost: the further we customize, the harder it is to pull upstream updates.
- **The escape hatch is good:** worst case, all data lives in *our* PostgreSQL instance — if we later go custom, we take the data and lessons with us. That's much better than data trapped in a SaaS.

## Rebuild-from-scratch estimate (for comparison)

Rebuilding just the features in the vision (accounts dashboard, balances, per-card expense breakdown, sync, categorization) in a modern stack (e.g., Next.js/SvelteKit + SQLite) with Claude Code writing most of it: very doable, but realistically several weekends before it matches what Sure gives on day one — plus ongoing ownership of sync edge cases (the genuinely annoying part: pending transactions, duplicates, reconnects).

## Decision framework

**Recommended: 1-weekend evaluation of Sure before committing either way.**

1. `docker compose up` Sure locally (no hosting/Tailscale needed yet)
2. Connect via SimpleFIN ($15/yr, 5-minute setup) — or attempt Plaid free keys if feeling patient
3. Live with the dashboard for a week: Does the per-card expense breakdown satisfy? Does investment tracking handle the Fidelity accounts well?
4. Point Claude Code at its database; run a first real analysis
5. Then decide: invest in Sure (add Tailscale for phone, customize) or go custom knowing exactly what to build

Total evaluation cost: $15 (SimpleFIN year) or $0 (Plaid keys). Nothing wasted either way — the account connections and data transfer to whatever we build.

## Open questions

- [ ] Sure + SimpleFIN credit-card sync quality (community reports mixed) — test with Amex/Discover during eval
- [ ] Does Sure's investment view represent Fidelity holdings well via SimpleFIN (balances-only) vs Plaid (full holdings)? May be the deciding factor for doing Plaid signup
- [ ] Confirm Discover connection stability through the Capital One migration

## Sources

- [Sure repo](https://github.com/we-promise/sure) · [Self-hosting wiki](https://github.com/we-promise/sure/wiki/Self-Hosting-Setup) · [Docker guide](https://github.com/we-promise/sure/blob/main/docs/hosting/docker.md)
- [AI configuration docs](https://github.com/we-promise/sure/docs/hosting/ai.md) · [AI features (external agent/MCP)](https://www.mintlify.com/we-promise/sure/hosting/ai-features)
- [Plaid setup docs](https://github.com/we-promise/sure/blob/main/docs/hosting/plaid.md) · [SimpleFIN integration discussion](https://github.com/we-promise/sure/discussions/93) · [SimpleFIN v0.6.3 release](https://github.com/we-promise/sure/discussions/101) · [SimpleFIN credit-card sync discussion](https://github.com/we-promise/sure/discussions/258)
