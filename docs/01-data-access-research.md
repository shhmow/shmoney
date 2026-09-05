# Data Access Research — Pulling BofA + Fidelity into One Place

*Researched 2026-08-24. Goal: automated (no repeated logins) read access to Bank of America checking + Fidelity Roth IRA / brokerage (+ upcoming inherited IRA).*

## The good news

Both institutions support modern OAuth-based aggregation. You log in **once per institution** through the institution's own consent screen, grant read access, and the connection persists (typically for months to a year before re-consent is required). No screen-scraping, no storing your passwords anywhere.

- **Bank of America** — supported by every major aggregator (Plaid, MX, Finicity, etc.) via OAuth.
- **Fidelity** — shut off screen-scraping in 2023 and routes all third-party access through **Fidelity Access / Akoya** (OAuth). Aggregators that adopted it (Plaid, MX, SnapTrade) get a clean, stable feed. New Fidelity accounts under the same login (like the inherited IRA) generally show up on the existing connection.

## The options

### Option A: SimpleFIN Bridge — ~$1.50/mo, built for exactly this
- Consumer-facing aggregation service designed for personal finance projects. You (not a company) sign up, connect your banks through its portal, and get an access token + a dead-simple REST API returning accounts, balances, and transactions as JSON.
- $1.50/month or $15/year, up to 25 institutions. Uses MX under the hood, so BofA and Fidelity coverage is there (it's the standard sync backend for Actual Budget users).
- **Limitation:** transaction/balance oriented. Investment accounts come through as balances + transactions, but **no per-security holdings breakdown** (positions, cost basis, tickers).
- No business entity, no API approval process, no compliance questionnaire. Sign up and go.

### Option B: Plaid — richest data, free at our scale
- The industry standard. `/accounts`, `/transactions`, and crucially **`/investments/holdings` + `/investments/transactions`** — per-security positions with CUSIP/ISIN/ticker, quantities, cost basis. As of Aug 2026, 95%+ of holdings include security name/type and 2+ identifiers, and Fidelity is a fully supported OAuth institution.
- Free tier covers small personal use (on the order of ~100 live connected accounts / limited free API usage — we'd have 2 "Items": one BofA, one Fidelity, so effectively free or near-free). You do have to sign up as a "developer," answer some questions about your use case, and request production + Fidelity OAuth institution access, which is more ceremony than SimpleFIN.
- Best data quality of any option; this is what real fintech apps use.

### Option C: SnapTrade — brokerage specialist
- Purpose-built for brokerage connections; has a **free Personal plan explicitly for "build your own tool / chat with AI about your portfolio"** use cases. Fidelity connects via Fidelity's own OAuth.
- Great for holdings/positions/dividends on the Fidelity side, but it's brokerage-only — doesn't cover the BofA checking account. Would need pairing with something else.

### Option D: File exports (fallback, no service dependency)
- Both BofA and Fidelity offer CSV/OFX/QFX downloads. Zero cost, zero third parties — but it's manual (you log in and download), which fails your "don't want to log in every time" requirement. Worth keeping as the escape hatch if an aggregator connection breaks.

### Ruled out
- **Direct APIs from BofA/Fidelity to individuals** — neither offers a personal-developer API; access is only via partner aggregators.
- **Screen-scraping** — Fidelity actively blocks it; fragile and stores credentials. Dead end.

## Recommendation

**Start with Plaid** (Option B), with SimpleFIN as the fallback if Plaid's signup/approval process is annoying:

1. Plaid's investments endpoints are the only way to get real holdings data (positions, cost basis, tickers) for the Fidelity accounts — and holdings-level data is what the "where should I invest / long-term planning" analysis layer will need. SimpleFIN would give us balances only on the investment side.
2. One integration covers both institutions.
3. At 2 connected institutions, cost is ~$0.

**Hybrid worth considering:** SimpleFIN for BofA transactions ($15/yr, trivial API) + SnapTrade Personal (free) for Fidelity holdings. Two integrations instead of one, but zero approval processes.

## Architecture sketch (next step)

```
BofA ──OAuth──┐
              ├─→ Aggregator (Plaid) ─→ sync job (daily cron) ─→ local DB (SQLite)
Fidelity ─────┘                                                      │
                                                          analysis / dashboard / bot
```

- Sync job pulls accounts, balances, transactions, holdings on a schedule; you never log in after the initial connect (re-consent roughly annually).
- Local SQLite keeps all history (aggregators only return ~90 days–2 yrs of transactions; we accumulate our own archive).
- Analysis layer (categorization, income/expense breakdown, goal planning) sits on the DB, independent of whichever aggregator feeds it — so we can swap Plaid ↔ SimpleFIN later without rewriting the interesting parts.

## Open questions

- [ ] Confirm Plaid free-tier signup friction as an individual (vs. LLC) — reports vary on how strict the production-access review is.
- [ ] Verify inherited IRA appears under the existing Fidelity connection once opened (should, same login).
- [ ] Decide transaction history backfill strategy (Plaid returns up to ~24 months on first sync; export older history via CSV once, import manually).

## Sources

- [SimpleFIN Bridge](https://beta-bridge.simplefin.org/) · [SimpleFIN protocol](https://www.simplefin.org/protocol.html) · [Actual Budget SimpleFIN docs](https://actualbudget.org/docs/advanced/bank-sync/simplefin/)
- [Plaid August 2026 product updates (Fidelity OAuth, investments enrichment)](https://thepaypers.com/fintech/news/plaid-rolls-out-product-updates-spanning-open-finance-to-investments)
- [Plaid free plan details](https://costbench.com/software/api-management/plaid/free-plan/) · [Plaid pricing overview](https://www.vendr.com/marketplace/plaid)
- [SnapTrade pricing](https://snaptrade.com/pricing) · [SnapTrade Fidelity integration](https://snaptrade.com/brokerage-integrations/fidelity-api)
- [Fidelity ends screen-scraping (RIABiz)](https://riabiz.com/a/2023/10/19/fidelity-just-dropped-the-hammer-on-screen-scrapers-to-cheers-but-some-firms-like-plaid-are-holdouts-and-the-cfpb-may-wield-the-final-gavel)
