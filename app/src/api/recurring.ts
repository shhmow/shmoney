// GET /api/recurring, PATCH /api/recurring/:id,
// GET /api/recurring/candidates (possible subscriptions),
// GET /api/recurring/merchants?q= (merchant search for manual tracking),
// POST /api/recurring (manually track a merchant),
// POST /api/recurring/detect (re-run detection),
// POST /api/recurring/candidates/dismiss (hide a candidate),
// GET /api/recurring/plaid?refresh=1 (Plaid's own recurring streams, cached).
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, bad, notFound, readJson, hasOwn, daysAgoStr, todayStr, isDate, type Bind } from "./util";
import { addDays } from "../lib/format";
import { plaidPost, PlaidError } from "../lib/plaid";
import {
  detectRecurring, manualRecurringMerchants, readMerchantList, writeMerchantList, recurringCandidates,
  merchantKey, MANUAL_RECURRING_KEY, DISMISSED_KEY, CADENCES, CADENCE_DAYS, HABIT_PFC, nextMonthly,
  type Cadence, type Candidate,
} from "../sync/recurring";

interface RecurringRow {
  id: number;
  merchant: string;
  category_id: number | null;
  cadence: string;
  avg_amount: number;
  last_date: string | null;
  next_date: string | null;
  active: number;
  kind: string;
  category_name: string | null;
  category_color: string | null;
  // Most recent charge for this merchant (which account/card it hits).
  account_id: string | null;
  account_name: string | null;
  account_mask: string | null;
  last_amount: number | null;
  last_txn_date: string | null;
  logo_url: string | null;
  website: string | null;
  last_pfc: string | null;
  charge_count: number;
}

// `lt` is the merchant's latest charge; it tells us which account the
// charge lands on and what it actually cost last time.
const RECURRING_SELECT = `
  SELECT r.id, r.merchant, r.category_id, r.cadence, r.avg_amount, r.last_date, r.next_date, r.active, r.kind,
         c.name AS category_name, c.color AS category_color,
         lt.account_id AS account_id, COALESCE(a.nickname, a.name) AS account_name, a.mask AS account_mask,
         lt.amount AS last_amount, lt.date AS last_txn_date, lt.logo_url AS logo_url, lt.website AS website,
         lt.plaid_category AS last_pfc,
         (SELECT COUNT(*) FROM transactions t
          WHERE (COALESCE(t.merchant_name, t.name) = r.merchant
                 OR (t.merchant_name IS NULL AND instr(LOWER(t.name), LOWER(r.merchant)) = 1)) AND t.excluded = 0
            AND ((r.kind = 'income' AND t.amount < 0) OR (r.kind <> 'income' AND t.amount > 0))) AS charge_count
  FROM recurring r
  LEFT JOIN categories c ON c.id = r.category_id
  LEFT JOIN transactions lt ON lt.id = (
    SELECT t.id FROM transactions t
    WHERE (COALESCE(t.merchant_name, t.name) = r.merchant
           OR (t.merchant_name IS NULL AND instr(LOWER(t.name), LOWER(r.merchant)) = 1)) AND t.excluded = 0
      AND ((r.kind = 'income' AND t.amount < 0) OR (r.kind <> 'income' AND t.amount > 0))
    ORDER BY t.date DESC, t.id DESC LIMIT 1)
  LEFT JOIN accounts a ON a.id = lt.account_id`;

// A short-cadence item is "stale" (probably stopped) when its expected next
// charge is more than 45 days overdue. Computed, not stored: the row and its
// history stay put and the UI groups it under "Stopped?".
const STALE_DAYS = 45;

function isStale(r: RecurringRow): boolean {
  if (r.cadence === "quarterly" || r.cadence === "yearly") return false;
  const cutoff = daysAgoStr(STALE_DAYS);
  const last = [r.last_date, r.last_txn_date].filter((d): d is string => !!d).sort().pop() ?? null;
  const expected = last ? addDays(last, CADENCE_DAYS[r.cadence as Cadence] ?? 30) : null;
  if (expected && expected < cutoff) return true;
  return !!r.next_date && r.next_date < cutoff;
}

// Bills are what keeps the lights on (rent, utilities, phone, insurance,
// storage, loans); everything else that repeats is a subscription.
const BILL_CATEGORIES = new Set(["Housing", "Bills & utilities", "Taxes", "Education"]);
const BILL_PFC = /^(RENT_AND_UTILITIES|LOAN_PAYMENTS|GOVERNMENT_AND_NON_PROFIT|GENERAL_SERVICES_(INSURANCE|STORAGE|CHILDCARE|EDUCATION))/;

function sectionOf(r: RecurringRow): "income" | "bill" | "subscription" {
  if (r.kind === "income") return "income";
  if (r.category_name && BILL_CATEGORIES.has(r.category_name)) return "bill";
  if (r.last_pfc && BILL_PFC.test(r.last_pfc)) return "bill";
  return "subscription";
}

function decorate(r: RecurringRow, manual: Set<string>) {
  const { last_pfc: _p, ...rest } = r;
  return { ...rest, section: sectionOf(r), manual: manual.has(r.merchant) ? 1 : 0, stale: isStale(r) ? 1 : 0 };
}

async function listRecurring(env: Env) {
  const rows = await q<RecurringRow>(env, `${RECURRING_SELECT} ORDER BY (r.next_date IS NULL), r.next_date, r.merchant`);
  const manual = new Set(await manualRecurringMerchants(env));
  return rows.map((r) => decorate(r, manual));
}

function isCadence(s: unknown): s is Cadence {
  return typeof s === "string" && (CADENCES as readonly string[]).includes(s);
}

function nextAfter(last: string | null, cadence: Cadence): string {
  const today = todayStr();
  let next = last
    ? (cadence === "monthly" ? nextMonthly(last) : addDays(last, CADENCE_DAYS[cadence]))
    : addDays(today, CADENCE_DAYS[cadence]);
  while (next < today) next = cadence === "monthly" ? nextMonthly(next) : addDays(next, CADENCE_DAYS[cadence]);
  return next;
}


/* ---- Plaid's recurring streams: a second opinion on candidates ----
 * /transactions/recurring/get is a Plaid add-on; plans without it return an
 * error per item, which is cached like a result so page loads never wait on
 * Plaid more than twice a day. */
const PLAID_CACHE_KEY = "plaid_recurring_cache";
const PLAID_CACHE_HOURS = 12;

interface PlaidStream {
  merchant_name: string | null;
  description: string;
  first_date: string;
  last_date: string;
  frequency: string;
  transaction_ids: string[];
  average_amount: { amount: number | null };
  last_amount: { amount: number | null };
  is_active: boolean;
  status: string; // MATURE | EARLY_DETECTION | TOMBSTONED | UNKNOWN
  personal_finance_category?: { primary: string; detailed: string } | null;
}
interface PlaidRecurring { at: string; streams: PlaidStream[]; errors: { item: number; code: string; message: string }[] }

async function plaidRecurring(env: Env, refresh = false): Promise<PlaidRecurring> {
  const cached = await first<{ value: string }>(env, "SELECT value FROM settings WHERE key = ?", PLAID_CACHE_KEY);
  if (cached && !refresh) {
    try {
      const v = JSON.parse(cached.value) as PlaidRecurring;
      if (Date.now() - Date.parse(v.at) < PLAID_CACHE_HOURS * 3600_000) return v;
    } catch { /* rebuild */ }
  }
  const items = await q<{ id: number; access_token: string }>(env, "SELECT id, access_token FROM items WHERE status = 'active'");
  const out: PlaidRecurring = { at: new Date().toISOString(), streams: [], errors: [] };
  for (const item of items) {
    try {
      const res = await plaidPost<{ outflow_streams: PlaidStream[] }>(env, "/transactions/recurring/get", { access_token: item.access_token });
      out.streams.push(...(res.outflow_streams ?? []));
    } catch (err) {
      out.errors.push({
        item: item.id,
        code: err instanceof PlaidError ? err.error_code : "FETCH_FAILED",
        message: err instanceof PlaidError ? err.error_message : String(err),
      });
    }
  }
  await run(
    env,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    PLAID_CACHE_KEY, JSON.stringify(out),
  );
  return out;
}

const PLAID_FREQ: Record<string, number> = { WEEKLY: 7, BIWEEKLY: 14, SEMI_MONTHLY: 15, MONTHLY: 30, ANNUALLY: 365 };

/** Plaid streams we do not already track or suggest, as candidates. Habits are skipped. */
function plaidCandidates(p: PlaidRecurring, seen: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const s of p.streams) {
    if (!s.is_active || (s.status !== "MATURE" && s.status !== "EARLY_DETECTION")) continue;
    if (s.personal_finance_category && HABIT_PFC.test(s.personal_finance_category.detailed)) continue;
    const name = (s.merchant_name || s.description || "").trim();
    const key = merchantKey(s.merchant_name, s.description);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const amt = Math.abs(s.last_amount?.amount ?? s.average_amount?.amount ?? 0);
    out.push({
      merchant: name, amount: amt, amount_min: amt, amount_max: amt,
      count: s.transaction_ids?.length ?? 0, first_date: s.first_date, last_date: s.last_date,
      gap_days: PLAID_FREQ[s.frequency] ?? 0, category_name: null, source: "plaid",
    });
  }
  return out;
}

export const recurring = new Hono<{ Bindings: Env }>();

recurring.get("/", async (c) => c.json(await listRecurring(c.env)));

recurring.get("/candidates", async (c) => {
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  const ours = await recurringCandidates(c.env, dismissed);
  const seen = new Set([
    ...ours.map((cd) => merchantKey(cd.merchant, cd.merchant)),
    ...dismissed.map((m) => merchantKey(m, m)),
    ...(await q<{ merchant: string }>(c.env, "SELECT merchant FROM recurring")).map((r) => merchantKey(r.merchant, r.merchant)),
  ]);
  const plaid = await plaidRecurring(c.env).catch(() => null);
  return c.json(plaid ? [...ours, ...plaidCandidates(plaid, seen)] : ours);
});

// What Plaid itself thinks recurs, with per-item errors (e.g. the add-on is
// not on this plan). ?refresh=1 skips the cache.
recurring.get("/plaid", async (c) => c.json(await plaidRecurring(c.env, c.req.query("refresh") === "1")));

// Merchant search for "Track a merchant": distinct names with charge counts.
recurring.get("/merchants", async (c) => {
  const needle = (c.req.query("q") ?? "").trim().toLowerCase();
  if (needle.length < 2) return c.json([]);
  const rows = await q<{ merchant: string; n: number; last_date: string; avg: number }>(
    c.env,
    `SELECT COALESCE(merchant_name, name) AS merchant, COUNT(*) AS n, MAX(date) AS last_date, ROUND(AVG(amount), 2) AS avg
     FROM transactions
     WHERE amount > 0 AND excluded = 0 AND is_transfer = 0
       AND instr(LOWER(COALESCE(merchant_name, '') || ' ' || name), ?1) > 0
     GROUP BY COALESCE(merchant_name, name)
     ORDER BY n DESC, last_date DESC LIMIT 8`,
    needle,
  );
  return c.json(rows);
});

// Manually track a merchant with a user-declared cadence. The merchant is
// added to the manual list so detection neither overwrites nor deletes it.
recurring.post("/", async (c) => {
  const body = await readJson<{ merchant?: string; cadence?: string; avg_amount?: number; category_id?: number | null }>(c);
  if (!body || typeof body.merchant !== "string" || body.merchant.trim() === "") return bad(c, "merchant is required");
  const merchant = body.merchant.trim();
  const cadence = body.cadence ?? "monthly";
  if (!isCadence(cadence)) return bad(c, "cadence must be one of: " + CADENCES.join(", "));
  let categoryId: number | null = null;
  if (body.category_id != null) {
    const cat = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE id = ?", body.category_id);
    if (!cat) return bad(c, "unknown category_id");
    categoryId = cat.id;
  } else {
    // Inherit the merchant's usual category (most common on its charges).
    const common = await first<{ category_id: number }>(
      c.env,
      `SELECT category_id FROM transactions
       WHERE COALESCE(merchant_name, name) = ? AND category_id IS NOT NULL AND excluded = 0 AND amount > 0
       GROUP BY category_id ORDER BY COUNT(*) DESC, MAX(date) DESC LIMIT 1`,
      merchant,
    );
    if (common) categoryId = common.category_id;
  }
  const lastTxn = await first<{ date: string; amount: number }>(
    c.env,
    `SELECT date, amount FROM transactions
     WHERE COALESCE(merchant_name, name) = ? AND excluded = 0 AND amount > 0 ORDER BY date DESC LIMIT 1`,
    merchant,
  );
  const avgAmount = body.avg_amount != null ? num(body.avg_amount) : (lastTxn ? lastTxn.amount : null);
  if (avgAmount == null || !(avgAmount > 0)) return bad(c, "avg_amount is required when the merchant has no transactions");
  const lastDate = lastTxn ? lastTxn.date : null;

  await run(
    c.env,
    `INSERT INTO recurring (merchant, category_id, cadence, avg_amount, last_date, next_date, active, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'expense')
     ON CONFLICT(merchant) DO UPDATE SET
       category_id = excluded.category_id, cadence = excluded.cadence, avg_amount = excluded.avg_amount,
       last_date = excluded.last_date, next_date = excluded.next_date, active = 1`,
    merchant, categoryId, cadence, Math.round(avgAmount * 100) / 100, lastDate, nextAfter(lastDate, cadence),
  );
  const manual = await readMerchantList(c.env, MANUAL_RECURRING_KEY);
  if (!manual.includes(merchant)) await writeMerchantList(c.env, MANUAL_RECURRING_KEY, [...manual, merchant]);
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  if (dismissed.includes(merchant)) await writeMerchantList(c.env, DISMISSED_KEY, dismissed.filter((m) => m !== merchant));

  const row = await first<RecurringRow>(c.env, `${RECURRING_SELECT} WHERE r.merchant = ?`, merchant);
  if (!row) return notFound(c, "recurring row not found after insert");
  return c.json(decorate(row, new Set([merchant])), 201);
});

// Re-run detection over existing transactions without a Plaid sync.
recurring.post("/detect", async (c) => {
  await detectRecurring(c.env);
  return c.json(await listRecurring(c.env));
});

recurring.post("/candidates/dismiss", async (c) => {
  const body = await readJson<{ merchant?: string }>(c);
  if (!body || typeof body.merchant !== "string" || body.merchant.trim() === "") return bad(c, "merchant is required");
  const merchant = body.merchant.trim();
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  if (!dismissed.includes(merchant)) await writeMerchantList(c.env, DISMISSED_KEY, [...dismissed, merchant]);
  return c.json({ ok: true });
});

recurring.delete("/:id", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const existing = await first<{ merchant: string }>(c.env, "SELECT merchant FROM recurring WHERE id = ?", id);
  if (!existing) return notFound(c, "recurring item not found");
  await run(c.env, "DELETE FROM recurring WHERE id = ?", id);
  const manual = await readMerchantList(c.env, MANUAL_RECURRING_KEY);
  if (manual.includes(existing.merchant)) {
    await writeMerchantList(c.env, MANUAL_RECURRING_KEY, manual.filter((m) => m !== existing.merchant));
  }
  // Keep detection from bringing it straight back.
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  if (!dismissed.includes(existing.merchant)) await writeMerchantList(c.env, DISMISSED_KEY, [...dismissed, existing.merchant]);
  return c.json({ ok: true });
});

recurring.patch("/:id", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const body = await readJson<{
    active?: boolean | number; category_id?: number | null;
    avg_amount?: number; cadence?: string; next_date?: string | null;
  }>(c);
  if (!body) return bad(c, "invalid JSON body");
  const existing = await first<RecurringRow>(c.env, `${RECURRING_SELECT} WHERE r.id = ?`, id);
  if (!existing) return notFound(c, "recurring item not found");

  const sets: string[] = [];
  const binds: Bind[] = [];
  let declared = false; // amount/cadence/date edits are user-declared: protect from detection
  if (hasOwn(body, "active")) { sets.push("active = ?"); binds.push(body.active ? 1 : 0); }
  if (hasOwn(body, "category_id")) {
    if (body.category_id != null) {
      const cat = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE id = ?", body.category_id);
      if (!cat) return bad(c, "unknown category_id");
    }
    sets.push("category_id = ?"); binds.push(body.category_id ?? null);
  }
  if (hasOwn(body, "avg_amount")) {
    const amt = num(body.avg_amount);
    if (!(amt > 0)) return bad(c, "avg_amount must be positive");
    sets.push("avg_amount = ?"); binds.push(Math.round(amt * 100) / 100);
    declared = true;
  }
  let cadence = existing.cadence as Cadence;
  if (hasOwn(body, "cadence")) {
    if (!isCadence(body.cadence)) return bad(c, "cadence must be one of: " + CADENCES.join(", "));
    cadence = body.cadence;
    sets.push("cadence = ?"); binds.push(cadence);
    declared = true;
  }
  if (hasOwn(body, "next_date")) {
    if (body.next_date != null && (typeof body.next_date !== "string" || !isDate(body.next_date))) return bad(c, "next_date must be YYYY-MM-DD");
    sets.push("next_date = ?"); binds.push(body.next_date ?? null);
    declared = true;
  } else if (hasOwn(body, "cadence") && cadence !== existing.cadence) {
    // Cadence changed without an explicit date: re-anchor on the last charge.
    sets.push("next_date = ?"); binds.push(nextAfter(existing.last_date ?? existing.last_txn_date, cadence));
  }
  if (sets.length === 0) return bad(c, "no fields to update");

  await run(c.env, `UPDATE recurring SET ${sets.join(", ")} WHERE id = ?`, ...binds, id);
  if (declared) {
    const manual = await readMerchantList(c.env, MANUAL_RECURRING_KEY);
    if (!manual.includes(existing.merchant)) await writeMerchantList(c.env, MANUAL_RECURRING_KEY, [...manual, existing.merchant]);
  }
  const row = await first<RecurringRow>(c.env, `${RECURRING_SELECT} WHERE r.id = ?`, id);
  if (!row) return notFound(c, "recurring item not found");
  return c.json(decorate(row, new Set(await manualRecurringMerchants(c.env))));
});
