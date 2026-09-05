# Portfolio history backfill

`POST /api/investments/backfill` (optional JSON body `{"days": 365}`, capped at 730) reconstructs
daily investment-account values for dates before the account was linked and writes them into
`balance_snapshots`, so the portfolio and net-worth charts get history immediately.

## How reconstruction works

1. Start from current `holdings.quantity` per (account, security). Securities that appear only in
   `investment_transactions` (fully sold positions) start at quantity 0.
2. Walk `investment_transactions` backward: quantity at any past date = current quantity minus buys
   dated after it plus sells dated after it. Only `buy`/`sell` rows move quantities (buys add,
   sells subtract; sell quantities are normalized whether Plaid reports them signed or not);
   dividends, cash, and fee rows are ignored for quantity purposes. Trades older than the window
   are already baked into current quantities.
3. Price each security from Stooq daily closes (`https://stooq.com/q/d/l/?s=TICKER.us&i=d`, free
   CSV, no key), fetched once per distinct ticker, capped at 25 fetches per run (largest current
   positions fetched first). Cash-like holdings (security type `cash`, or no ticker with a close
   price of 1) are priced at a flat 1.0.
4. For each sampled date (daily for windows of 120 days or less, every 2 days for longer windows),
   account value = sum over positions of quantity-at-date times the last close at-or-before that
   date. Rows are written with `INSERT OR IGNORE`, and today/future dates are never written.

## Approximations

- **Flat-price fallback**: securities with no ticker, a failed/404/"N/D" Stooq fetch, or beyond the
  25-fetch budget use the current `securities.close_price` flat across the whole window. They are
  listed in the response's `unpricedSecurities`.
- **Fees and dividend timing ignored**: cash thrown off by dividends, fees, and sweep timing is not
  modeled; only priced positions (plus flat cash-like holdings at $1) contribute to value.
- **Splits and corporate actions not handled**: a split inside the window will misprice the
  pre-split stretch (Stooq closes are as-traded around the ratio change while reconstructed
  quantities are not adjusted).
- **Zero-value dates are skipped**: a date where an account reconstructs to $0 gets no snapshot
  (indistinguishable from the account not existing yet).
- Windows longer than 120 days are sampled every 2 days to bound CPU and row count.

## Re-running safely

The backfill is idempotent: snapshots are written with `INSERT OR IGNORE` on the
`(account_id, date)` unique key, so real snapshots recorded by the daily sync are never
overwritten, and re-runs only fill dates that are still missing. Run it again any time (e.g. after
linking another investment account, or with a larger `days`). To rebuild a range from scratch,
delete the synthetic rows for the affected dates first, then re-run.
