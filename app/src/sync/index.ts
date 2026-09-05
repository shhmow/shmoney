import type { Env } from "../types";
import { batch, first, q, run, stmt, type PreparedStatement } from "../lib/db";
import { addDays, nowIso, todayStr } from "../lib/format";
import { PlaidError, plaidPost, upsertAccounts, type PlaidAccount } from "../lib/plaid";

export interface SyncResult {
  itemId: number;
  added: number;
  modified: number;
  removed: number;
  holdings: number;
  error?: string;
}

interface ItemRow {
  id: number;
  plaid_item_id: string;
  access_token: string;
  sync_cursor: string | null;
}

// Minimal shapes of the Plaid response fields we consume.

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  pending: boolean;
  payment_channel: string | null;
  personal_finance_category: { primary: string; detailed: string } | null;
}

interface TxnSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  accounts?: PlaidAccount[];
  next_cursor: string;
  has_more: boolean;
}

interface PlaidSecurity {
  security_id: string;
  ticker_symbol: string | null;
  name: string | null;
  type: string | null;
  close_price: number | null;
  close_price_as_of: string | null;
}

interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  cost_basis: number | null;
  institution_value: number | null;
  institution_price_as_of: string | null;
}

interface PlaidInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  name: string | null;
  amount: number | null;
  quantity: number | null;
  type: string | null;
  subtype: string | null;
}

const TRANSFER_PRIMARIES = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"]);

export async function syncItem(env: Env, itemId: number): Promise<SyncResult> {
  const result: SyncResult = { itemId, added: 0, modified: 0, removed: 0, holdings: 0 };
  const item = await first<ItemRow>(
    env, "SELECT id, plaid_item_id, access_token, sync_cursor FROM items WHERE id = ?", itemId,
  );
  if (!item) {
    result.error = "item not found";
    return result;
  }
  try {
    await syncTransactions(env, item, result);
    await snapshotBalances(env, itemId);
    if (await hasInvestmentAccounts(env, itemId)) {
      await syncHoldings(env, item, result);
      await syncInvestmentTransactions(env, item);
      await refreshHoldingPrices(env, itemId);
      await snapshotBalances(env, itemId);
    }
    await applyRules(env);
    await applyPlaidCategoryFallback(env);
    await detectRecurring(env);
    await run(
      env,
      "UPDATE items SET last_synced_at = ?, last_error = NULL, status = 'active' WHERE id = ?",
      nowIso(), itemId,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof PlaidError && e.error_code === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error";
    result.error = message;
    await run(env, "UPDATE items SET last_error = ?, status = ? WHERE id = ?", message, status, itemId);
  }
  return result;
}

export async function syncAll(env: Env): Promise<SyncResult[]> {
  const items = await q<{ id: number }>(env, "SELECT id FROM items ORDER BY id");
  const results: SyncResult[] = [];
  for (const item of items) {
    results.push(await syncItem(env, item.id));
  }
  return results;
}

async function syncTransactions(env: Env, item: ItemRow, result: SyncResult): Promise<void> {
  let cursor = item.sync_cursor;
  let hasMore = true;
  while (hasMore) {
    const page = await plaidPost<TxnSyncPage>(env, "/transactions/sync", {
      access_token: item.access_token,
      cursor: cursor ?? undefined, // undefined keys are dropped by JSON.stringify
      count: 500,
    });
    const stmts: PreparedStatement[] = [];
    for (const t of page.added) stmts.push(upsertTransactionStmt(env, t));
    for (const t of page.modified) stmts.push(upsertTransactionStmt(env, t));
    for (const r of page.removed) {
      stmts.push(stmt(env, "DELETE FROM transactions WHERE id = ?", r.transaction_id));
    }
    // Advance the cursor atomically with the page's writes.
    stmts.push(stmt(env, "UPDATE items SET sync_cursor = ? WHERE id = ?", page.next_cursor, item.id));
    await batch(env, stmts);
    if (page.accounts && page.accounts.length > 0) {
      await upsertAccounts(env, item.id, page.accounts);
    }
    result.added += page.added.length;
    result.modified += page.modified.length;
    result.removed += page.removed.length;
    cursor = page.next_cursor;
    hasMore = page.has_more;
  }
  console.log(`sync item ${item.id}: txns +${result.added} ~${result.modified} -${result.removed}`);
}

function upsertTransactionStmt(env: Env, t: PlaidTransaction): PreparedStatement {
  const pfc = t.personal_finance_category;
  const isTransfer = pfc !== null && TRANSFER_PRIMARIES.has(pfc.primary) ? 1 : 0;
  // The stored plaid_category is the detailed code (it is prefixed by the
  // primary code, which the fallback mapping matches on).
  const plaidCategory = pfc ? (pfc.detailed || pfc.primary) : null;
  // New rows are inserted with category_id NULL — even Plaid-tagged transfers
  // (they still get is_transfer = 1). This lets applyRules claim them first
  // (e.g. a Zelle deposit routed to an income source); anything left
  // uncategorized is picked up by applyPlaidCategoryFallback, whose map
  // already sends TRANSFER_IN/OUT and LOAN_PAYMENTS to Transfers.
  // INSERT OR REPLACE, but the subselects (evaluated before the conflicting
  // row is replaced) preserve the user-owned fields on modified transactions.
  return stmt(
    env,
    `INSERT OR REPLACE INTO transactions
       (id, account_id, date, name, merchant_name, amount, pending, plaid_category, payment_channel,
        category_id, is_transfer, excluded, notes, biz_category_id, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       (SELECT category_id FROM transactions WHERE id = ?1),
       COALESCE((SELECT is_transfer FROM transactions WHERE id = ?1), ?10),
       COALESCE((SELECT excluded FROM transactions WHERE id = ?1), 0),
       (SELECT notes FROM transactions WHERE id = ?1),
       (SELECT biz_category_id FROM transactions WHERE id = ?1),
       ?11)`,
    t.transaction_id, t.account_id, t.date, t.name, t.merchant_name, t.amount,
    t.pending ? 1 : 0, plaidCategory, t.payment_channel,
    isTransfer, nowIso(),
  );
}

async function snapshotBalances(env: Env, itemId: number): Promise<void> {
  await run(
    env,
    `INSERT OR REPLACE INTO balance_snapshots (account_id, date, balance)
     SELECT id, ?1, current_balance FROM accounts WHERE item_id = ?2 AND current_balance IS NOT NULL`,
    todayStr(), itemId,
  );
}

async function hasInvestmentAccounts(env: Env, itemId: number): Promise<boolean> {
  const row = await first<{ n: number }>(
    env, "SELECT 1 AS n FROM accounts WHERE item_id = ? AND type = 'investment' LIMIT 1", itemId,
  );
  return row !== null;
}

// Plaid's security master sometimes serves stale identities after corporate
// renames; correct them at ingest so market data and display use the live
// ticker. (Yandex NV restructured into Nebius Group in 2024.)
const STALE_SECURITY_FIXES: Record<string, { ticker: string; name: string }> = {
  YNDX: { ticker: "NBIS", name: "Nebius Group N.V." },
};

function securityUpsertStmts(env: Env, securities: PlaidSecurity[]): PreparedStatement[] {
  securities = securities.map((s) => {
    const fix = s.ticker_symbol ? STALE_SECURITY_FIXES[s.ticker_symbol] : undefined;
    return fix ? { ...s, ticker_symbol: fix.ticker, name: fix.name } : s;
  });
  return securities.map((s) =>
    stmt(
      env,
      `INSERT INTO securities (id, ticker, name, type, close_price, close_price_as_of)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET
         ticker = excluded.ticker,
         name = excluded.name,
         type = excluded.type,
         close_price = excluded.close_price,
         close_price_as_of = excluded.close_price_as_of`,
      s.security_id, s.ticker_symbol, s.name, s.type, s.close_price, s.close_price_as_of,
    ),
  );
}

async function syncHoldings(env: Env, item: ItemRow, result: SyncResult): Promise<void> {
  const res = await plaidPost<{ holdings: PlaidHolding[]; securities: PlaidSecurity[] }>(
    env, "/investments/holdings/get", { access_token: item.access_token },
  );
  const stmts: PreparedStatement[] = securityUpsertStmts(env, res.securities);
  // Replace the item's holdings wholesale so sold-out positions disappear.
  stmts.push(stmt(
    env,
    "DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE item_id = ?)",
    item.id,
  ));
  for (const h of res.holdings) {
    stmts.push(stmt(
      env,
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, value, as_of)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(account_id, security_id) DO UPDATE SET
         quantity = excluded.quantity,
         cost_basis = excluded.cost_basis,
         value = excluded.value,
         as_of = excluded.as_of`,
      h.account_id, h.security_id, h.quantity, h.cost_basis, h.institution_value,
      h.institution_price_as_of ?? todayStr(),
    ));
  }
  await batch(env, stmts);
  result.holdings = res.holdings.length;
  console.log(`sync item ${item.id}: holdings ${res.holdings.length}`);
}

// Plaid's institution prices for holdings can lag a market day or more, so a
// manual sync would faithfully re-save stale values. Reprice tickered holdings
// from Yahoo's live quote (30 min cache), then roll investment account
// balances forward so the follow-up snapshot reflects the market.
const QUOTE_TTL_MS = 30 * 60 * 1000;

async function fetchYahooQuote(env: Env, ticker: string): Promise<number | null> {
  const key = `quote:${ticker.toUpperCase()}`;
  const row = await first<{ fetched_at: string; payload: string }>(
    env, "SELECT fetched_at, payload FROM market_cache WHERE key = ?", key,
  );
  if (row) {
    const age = Date.now() - Date.parse(row.fetched_at);
    if (Number.isFinite(age) && age < QUOTE_TTL_MS) {
      const cached = Number(JSON.parse(row.payload));
      if (Number.isFinite(cached) && cached > 0) return cached;
    }
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.toUpperCase())}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (shmoney personal dashboard)" } });
    if (!res.ok) {
      quoteDiag.push(`${ticker}: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } };
    const price = body.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (typeof price !== "number" || !(price > 0)) {
      quoteDiag.push(`${ticker}: no price in body`);
      return null;
    }
    await run(
      env,
      `INSERT INTO market_cache (key, fetched_at, payload) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
      key, nowIso(), JSON.stringify(price),
    );
    return price;
  } catch (e) {
    quoteDiag.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Last sync's quote failures, persisted for diagnosis (read via market_cache).
const quoteDiag: string[] = [];

async function refreshHoldingPrices(env: Env, itemId: number): Promise<void> {
  const secs = await q<{ id: string; ticker: string }>(
    env,
    `SELECT DISTINCT s.id, s.ticker FROM securities s
     JOIN holdings h ON h.security_id = s.id
     JOIN accounts a ON a.id = h.account_id
     WHERE a.item_id = ?1 AND s.ticker IS NOT NULL AND lower(coalesce(s.type, '')) <> 'cash'`,
    itemId,
  );
  const today = todayStr();
  let repriced = 0;
  for (const s of secs) {
    const price = await fetchYahooQuote(env, s.ticker);
    if (price === null) continue;
    await run(env, "UPDATE securities SET close_price = ?1, close_price_as_of = ?2 WHERE id = ?3", price, today, s.id);
    await run(
      env,
      `UPDATE holdings SET value = ROUND(quantity * ?1, 2), as_of = ?2
       WHERE security_id = ?3 AND account_id IN (SELECT id FROM accounts WHERE item_id = ?4)`,
      price, today, s.id, itemId,
    );
    repriced++;
  }
  await run(
    env,
    `UPDATE accounts SET current_balance = (SELECT ROUND(SUM(h.value), 2) FROM holdings h WHERE h.account_id = accounts.id)
     WHERE item_id = ?1 AND type = 'investment'
       AND EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = accounts.id)`,
    itemId,
  );
  console.log(`sync item ${itemId}: repriced ${repriced} of ${secs.length} securities`);
  await run(
    env,
    `INSERT INTO market_cache (key, fetched_at, payload) VALUES ('quote_diag', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
    nowIso(), JSON.stringify({ repriced, of: secs.length, failures: quoteDiag.slice(0, 20) }),
  );
  quoteDiag.length = 0;
}

async function syncInvestmentTransactions(env: Env, item: ItemRow): Promise<void> {
  const endDate = todayStr();
  const startDate = addDays(endDate, -730);
  const count = 500;
  let offset = 0;
  let total = 0;
  do {
    const page = await plaidPost<{
      investment_transactions: PlaidInvestmentTransaction[];
      securities: PlaidSecurity[];
      total_investment_transactions: number;
    }>(env, "/investments/transactions/get", {
      access_token: item.access_token,
      start_date: startDate,
      end_date: endDate,
      options: { count, offset },
    });
    // Upsert this page's securities first: investment_transactions.security_id
    // has a foreign key and may reference securities absent from holdings.
    const stmts: PreparedStatement[] = securityUpsertStmts(env, page.securities);
    for (const t of page.investment_transactions) {
      stmts.push(stmt(
        env,
        `INSERT OR REPLACE INTO investment_transactions
           (id, account_id, security_id, date, name, amount, quantity, type, subtype)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        t.investment_transaction_id, t.account_id, t.security_id, t.date, t.name,
        t.amount, t.quantity, t.type, t.subtype,
      ));
    }
    await batch(env, stmts);
    total = page.total_investment_transactions;
    if (page.investment_transactions.length === 0) break;
    offset += page.investment_transactions.length;
  } while (offset < total);
  console.log(`sync item ${item.id}: investment txns ${offset} of ${total}`);
}

export async function applyRules(env: Env, opts?: { retroactive?: boolean }): Promise<number> {
  const retroactive = opts?.retroactive === true;
  const rules = await q<{ id: number; match_field: string; match_value: string; category_id: number; kind: string }>(
    env,
    `SELECT r.id, r.match_field, r.match_value, r.category_id, c.kind
     FROM rules r JOIN categories c ON c.id = r.category_id
     ORDER BY r.priority DESC, r.id ASC`,
  );
  // Non-retroactive: highest priority first; the category_id IS NULL guard
  // stops lower-priority rules from re-matching. Retroactive: reverse the
  // order so the highest-priority rule writes last and wins.
  if (retroactive) rules.reverse();
  const guard = retroactive ? "" : "AND category_id IS NULL";
  let updated = 0;
  for (const rule of rules) {
    const needle = rule.match_value.toLowerCase();
    const match = rule.match_field === "name"
      ? "instr(lower(name), ?2) > 0"
      : "(instr(lower(coalesce(merchant_name, '')), ?2) > 0 OR instr(lower(name), ?2) > 0)";
    // Income semantics ride along with the category: an income-kind category
    // clears the transfer flag (a Zelle/PayPal deposit the user routed to an
    // income source IS income), a transfer-kind category sets it.
    const transferSet =
      rule.kind === "income" ? ", is_transfer = 0"
      : rule.kind === "transfer" ? ", is_transfer = 1"
      : "";
    const res = await run(
      env,
      `UPDATE transactions SET category_id = ?1, updated_at = ?3${transferSet} WHERE ${match} ${guard}`,
      rule.category_id, needle, nowIso(),
    );
    updated += res.meta.changes;
  }
  return updated;
}

// Ordered: more specific detailed codes must precede their primary prefix.
const PLAID_CATEGORY_MAP: ReadonlyArray<readonly [string, string]> = [
  ["INCOME", "Income"],
  ["FOOD_AND_DRINK_GROCERIES", "Groceries"],
  ["FOOD_AND_DRINK", "Dining out"],
  ["TRANSPORTATION", "Transport"],
  ["RENT_AND_UTILITIES_RENT", "Housing"],
  ["RENT_AND_UTILITIES", "Bills & utilities"],
  ["ENTERTAINMENT", "Entertainment"],
  ["GENERAL_MERCHANDISE", "Shopping"],
  ["TRAVEL", "Travel"],
  ["MEDICAL", "Health"],
  ["TRANSFER_IN", "Transfers"],
  ["TRANSFER_OUT", "Transfers"],
  ["LOAN_PAYMENTS", "Transfers"],
];

async function applyPlaidCategoryFallback(env: Env): Promise<void> {
  const categories = await q<{ id: number; name: string }>(env, "SELECT id, name FROM categories");
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  const stmts: PreparedStatement[] = [];
  for (const [prefix, name] of PLAID_CATEGORY_MAP) {
    const categoryId = byName.get(name);
    if (categoryId === undefined) continue;
    stmts.push(stmt(
      env,
      "UPDATE transactions SET category_id = ?1 WHERE category_id IS NULL AND instr(plaid_category, ?2) = 1",
      categoryId, prefix,
    ));
  }
  const otherId = byName.get("Other");
  if (otherId !== undefined) {
    stmts.push(stmt(
      env,
      "UPDATE transactions SET category_id = ? WHERE category_id IS NULL AND plaid_category IS NOT NULL",
      otherId,
    ));
  }
  await batch(env, stmts);
}

// Categories whose bills legitimately vary month to month (utilities, rent
// adjustments): detection tolerates a wider amount spread only for these.
const VARIABLE_BILL_CATEGORIES = new Set(["Bills & utilities", "Subscriptions", "Housing"]);

// Settings key holding a JSON array of merchant names the user tracks by hand
// (via POST /api/recurring). Rows for these merchants are protected from
// detectRecurring: never overwritten (user-declared cadence wins) and never
// deleted by the stale-row sweep. This avoids a schema migration — the
// recurring table itself is untouched.
export const MANUAL_RECURRING_KEY = "recurring_manual_merchants";

export async function manualRecurringMerchants(env: Env): Promise<string[]> {
  const row = await first<{ value: string }>(env, "SELECT value FROM settings WHERE key = ?", MANUAL_RECURRING_KEY);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface CadenceStats {
  n: number;
  mean: number;
  cv: number;             // coefficient of variation of amounts
  identicalShare: number; // largest share of to-the-cent identical amounts
  medGap: number;
  gapStd: number;
  gapSpread: number;
  lastDate: string;
}

function cadenceStats(dates: string[], amounts: number[]): CadenceStats | null {
  const n = dates.length;
  if (n < 2) return null;
  const mean = amounts.reduce((a, b) => a + b, 0) / n;
  const cv = mean > 0 ? stddev(amounts) / mean : Infinity;
  const centCounts = new Map<number, number>();
  for (const a of amounts) {
    const cents = Math.round(a * 100);
    centCounts.set(cents, (centCounts.get(cents) ?? 0) + 1);
  }
  const identicalShare = Math.max(...centCounts.values()) / n;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
  return {
    n,
    mean,
    cv,
    identicalShare,
    medGap: median(gaps),
    gapStd: stddev(gaps),
    gapSpread: Math.max(...gaps) - Math.min(...gaps),
    lastDate: dates[dates.length - 1],
  };
}

export async function detectRecurring(env: Env): Promise<void> {
  const today = todayStr();
  // Two years of history so yearly charges (2 occurrences ~365d apart) are
  // visible. Monthly/weekly detection still only looks at the last 183 days —
  // that shorter window is what prunes cancelled subscriptions.
  const since = addDays(today, -740);
  const shortSince = addDays(today, -183);
  const rows = await q<{ merchant: string; date: string; amount: number; category_id: number | null }>(
    env,
    `SELECT COALESCE(merchant_name, name) AS merchant, date, amount, category_id
     FROM transactions
     WHERE date >= ? AND amount > 0 AND is_transfer = 0 AND excluded = 0
     ORDER BY merchant, date`,
    since,
  );
  const categoryNames = new Map(
    (await q<{ id: number; name: string }>(env, "SELECT id, name FROM categories")).map((c) => [c.id, c.name]),
  );
  const manual = new Set(await manualRecurringMerchants(env));

  const groups = new Map<string, { dates: string[]; amounts: number[]; categories: (number | null)[] }>();
  for (const r of rows) {
    let g = groups.get(r.merchant);
    if (!g) {
      g = { dates: [], amounts: [], categories: [] };
      groups.set(r.merchant, g);
    }
    g.dates.push(r.date);
    g.amounts.push(r.amount);
    g.categories.push(r.category_id);
  }

  const stmts: PreparedStatement[] = [];
  const detectedMerchants: string[] = [];
  for (const [merchant, g] of groups) {
    // Manual rows keep the user's declared cadence/amount: skip detection.
    if (manual.has(merchant)) continue;

    // Recent subset drives monthly/weekly; the full window drives quarterly/yearly.
    const recentIdx = g.dates.map((d, i) => i).filter((i) => g.dates[i] >= shortSince);
    const recent = cadenceStats(recentIdx.map((i) => g.dates[i]), recentIdx.map((i) => g.amounts[i]));
    const full = cadenceStats(g.dates, g.amounts);

    const categoryId = modal(g.categories.filter((c): c is number => c !== null));
    const categoryName = categoryId !== null ? categoryNames.get(categoryId) : undefined;
    const variableBill = categoryName !== undefined && VARIABLE_BILL_CATEGORIES.has(categoryName);

    // Amount consistency. Subscriptions bill identically to the cent;
    // restaurants never do — require a tight coefficient of variation or a
    // majority of identical amounts.
    const consistent = (s: CadenceStats): boolean => s.cv <= 0.08 || s.identicalShare >= 0.6;
    // Quarterly/yearly rule from the spec: CV <= 0.10 or all amounts identical.
    const consistentLong = (s: CadenceStats): boolean => s.cv <= 0.1 || s.identicalShare === 1;

    let cadence: string | null = null;
    let use: CadenceStats | null = null;
    if (recent && recent.n >= 3 && recent.medGap >= 26 && recent.medGap <= 34 &&
        (recent.gapSpread <= 10 || recent.gapStd <= 4) &&
        (consistent(recent) || (variableBill && recent.cv <= 0.25))) {
      // Monthly. Utility-style categories may vary in amount (CV <= 0.25).
      cadence = "monthly";
      use = recent;
    } else if (recent && recent.n >= 4 && recent.medGap >= 6 && recent.medGap <= 8 &&
        recent.gapStd <= 2 && consistent(recent)) {
      cadence = "weekly";
      use = recent;
    } else if (full && full.n >= 3 && full.medGap >= 84 && full.medGap <= 100 && consistentLong(full)) {
      cadence = "quarterly";
      use = full;
    } else if (full && full.n >= 2 && full.medGap >= 340 && full.medGap <= 390 && consistentLong(full)) {
      cadence = "yearly";
      use = full;
    }
    if (cadence === null || use === null) continue;

    const nextDate = addDays(use.lastDate, Math.round(use.medGap));
    // Long cadences see far back in history: if the next charge is well
    // overdue (45+ days) the subscription likely ended — drop it as stale.
    if ((cadence === "quarterly" || cadence === "yearly") && nextDate < addDays(today, -45)) continue;

    // Preserve the user's active flag on re-detection (ON CONFLICT leaves it).
    stmts.push(stmt(
      env,
      `INSERT INTO recurring (merchant, category_id, cadence, avg_amount, last_date, next_date, active)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
       ON CONFLICT(merchant) DO UPDATE SET
         category_id = excluded.category_id,
         cadence = excluded.cadence,
         avg_amount = excluded.avg_amount,
         last_date = excluded.last_date,
         next_date = excluded.next_date`,
      merchant, categoryId, cadence, Math.round(use.mean * 100) / 100, use.lastDate, nextDate,
    ));
    detectedMerchants.push(merchant);
  }
  // Rows no longer detected are stale (e.g. a one-off streak ended): remove
  // them — except manually tracked rows, which the user owns.
  stmts.push(stmt(
    env,
    `DELETE FROM recurring
     WHERE merchant NOT IN (SELECT value FROM json_each(?1))
       AND merchant NOT IN (SELECT value FROM json_each(?2))`,
    JSON.stringify(detectedMerchants), JSON.stringify([...manual]),
  ));
  await batch(env, stmts);
  console.log(`recurring: ${detectedMerchants.length} merchants detected, ${manual.size} manual`);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function modal(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  let best = values[0];
  let bestCount = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}
