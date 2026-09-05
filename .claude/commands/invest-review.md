# /invest-review — generate portfolio analysis and publish it to shmoney

You are generating the investment analysis that appears in the ANALYSIS card on shmoney's Investments tab. The site displays whatever this command stores; it is the single source of real analysis (the UI itself deliberately contains no generated prose).

## Steps

1. Pull current data from the production D1 database (read-only queries; run from `app/`):
   ```bash
   npx wrangler d1 execute shmoney --remote --json --command "SELECT s.ticker, s.name, s.type, h.quantity, h.value, h.cost_basis, a.name AS account FROM holdings h JOIN securities s ON s.id=h.security_id JOIN accounts a ON a.id=h.account_id ORDER BY h.value DESC"
   ```
   ```bash
   npx wrangler d1 execute shmoney --remote --json --command "SELECT type, ROUND(SUM(amount),0) total, COUNT(*) n FROM investment_transactions WHERE date >= date('now','-365 days') GROUP BY type"
   ```
   ```bash
   npx wrangler d1 execute shmoney --remote --json --command "SELECT date, ROUND(SUM(balance),0) v FROM balance_snapshots bs JOIN accounts a ON a.id=bs.account_id WHERE a.type='investment' GROUP BY date ORDER BY date"
   ```
   Add further queries as needed (cash balances for context, recent buys, per-account splits).

2. Analyze. Compute what the numbers support: allocation shape, concentration, cost-basis gains, contribution pace, cash drag, notable recent activity, how the portfolio moved vs its own history. Be specific to THIS portfolio. You may use WebSearch for current market context where it sharpens a point.

3. Write the analysis. Format constraints (strict):
   - One headline: max 10 words, factual, no hype.
   - 3 to 6 bullets: each one sentence, max 20 words, numbers first, plain words.
   - NO hyphens or em-dashes anywhere. No hedging filler. No generic advice phrases.
   - Observational and educational only. NEVER instruct to buy, sell, or trade. No "you should". Frame options neutrally ("cash is 8 percent, above the 3 percent typical for index portfolios").

4. Store it (single statement; escape single quotes in text by doubling them):
   ```bash
   npx wrangler d1 execute shmoney --remote --command "INSERT INTO settings (key, value) VALUES ('invest_analysis', json('{\"written_at\":\"<ISO-8601 now>\",\"headline\":\"...\",\"bullets\":[\"...\"],\"model\":\"claude\"}')) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
   ```

5. Confirm to the user with the headline + bullets you published and remind them it appears on the Investments tab after a refresh.

## Boundaries

Claude never executes trades or moves money and is not a licensed advisor; this analysis is descriptive context on the user's own data. If data looks stale (no snapshot today), note it in a bullet rather than guessing.
