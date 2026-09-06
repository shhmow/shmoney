// GET /api/recurring, PATCH /api/recurring/:id,
// GET /api/recurring/candidates (possible subscriptions),
// POST /api/recurring (manually track a merchant),
// POST /api/recurring/candidates/dismiss (hide a candidate).
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, bad, notFound, readJson, hasOwn, daysAgoStr, todayStr, isDate, type Bind } from "./util";
import { addDays } from "../lib/format";
import { detectRecurring, manualRecurringMerchants, MANUAL_RECURRING_KEY } from "../sync";

interface RecurringRow {
  id: number;
  merchant: string;
  category_id: number | null;
  cadence: string;
  avg_amount: number;
  last_date: string | null;
  next_date: string | null;
  active: number;
  category_name: string | null;
  category_color: string | null;
  // Most recent charge for this merchant (which account/card it hits).
  account_id: string | null;
  account_name: string | null;
  account_mask: string | null;
  last_amount: number | null;
  last_txn_date: string | null;
}

// `lt` is the merchant's latest outflow; it tells us which account the
// charge lands on and what it actually cost last time.
const RECURRING_SELECT = `
  SELECT r.id, r.merchant, r.category_id, r.cadence, r.avg_amount, r.last_date, r.next_date, r.active,
         c.name AS category_name, c.color AS category_color,
         lt.account_id AS account_id, a.name AS account_name, a.mask AS account_mask,
         lt.amount AS last_amount, lt.date AS last_txn_date
  FROM recurring r
  LEFT JOIN categories c ON c.id = r.category_id
  LEFT JOIN transactions lt ON lt.id = (
    SELECT t.id FROM transactions t
    WHERE COALESCE(t.merchant_name, t.name) = r.merchant AND t.amount > 0 AND t.excluded = 0
    ORDER BY t.date DESC, t.id DESC LIMIT 1)
  LEFT JOIN accounts a ON a.id = lt.account_id`;

// A weekly/monthly item is "stale" (probably stopped) when its expected next
// charge is more than 45 days overdue. Computed, not stored: the row and its
// history stay put and the UI groups it under "Stopped?".
const STALE_DAYS = 45;

function isStale(r: RecurringRow): boolean {
  if (r.cadence !== "monthly" && r.cadence !== "weekly") return false;
  const cutoff = daysAgoStr(STALE_DAYS);
  const last = [r.last_date, r.last_txn_date].filter((d): d is string => !!d).sort().pop() ?? null;
  const expected = last ? addDays(last, CADENCE_DAYS[r.cadence] ?? 30) : null;
  if (expected && expected < cutoff) return true;
  return !!r.next_date && r.next_date < cutoff;
}

async function listRecurring(env: Env): Promise<(RecurringRow & { manual: number; stale: number })[]> {
  const rows = await q<RecurringRow>(
    env,
    `${RECURRING_SELECT} ORDER BY (r.next_date IS NULL), r.next_date, r.merchant`,
  );
  const manual = new Set(await manualRecurringMerchants(env));
  return rows.map((r) => ({ ...r, manual: manual.has(r.merchant) ? 1 : 0, stale: isStale(r) ? 1 : 0 }));
}

// Settings key holding a JSON array of candidate merchant names the user
// dismissed from the "Possible subscriptions" list (no schema change needed).
const DISMISSED_KEY = "recurring_dismissed_merchants";

const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;
const CADENCE_DAYS: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };

async function readMerchantList(env: Env, key: string): Promise<string[]> {
  const row = await first<{ value: string }>(env, "SELECT value FROM settings WHERE key = ?", key);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function writeMerchantList(env: Env, key: string, list: string[]): Promise<void> {
  await run(
    env,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key, JSON.stringify(list),
  );
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export const recurring = new Hono<{ Bindings: Env }>();

recurring.get("/", async (c) => {
  return c.json(await listRecurring(c.env));
});

// Possible subscriptions: merchants not tracked in recurring, charged at
// least twice in the last 18 months, either at amounts within ~20% of each
// other (a price bump still qualifies) or with an exactly repeated amount
// (a fixed plan next to one-off top-ups). At least 20 days between charges.
recurring.get("/candidates", async (c) => {
  const since = daysAgoStr(548); // ~18 months
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  const rows = await q<{ merchant: string; amount: number; date: string }>(
    c.env,
    `SELECT COALESCE(t.merchant_name, t.name) AS merchant, t.amount, t.date
     FROM transactions t
     WHERE t.date >= ?1 AND t.amount >= 1 AND t.is_transfer = 0 AND t.excluded = 0
       AND COALESCE(t.merchant_name, t.name) NOT IN (SELECT merchant FROM recurring)
       AND COALESCE(t.merchant_name, t.name) NOT IN (SELECT value FROM json_each(?2))
       AND LOWER(COALESCE(t.merchant_name, t.name)) IN (
         SELECT LOWER(COALESCE(merchant_name, name)) FROM transactions
         WHERE date >= ?1 AND amount >= 1 AND is_transfer = 0 AND excluded = 0
         GROUP BY LOWER(COALESCE(merchant_name, name)) HAVING COUNT(*) >= 2)
     ORDER BY merchant, t.date`,
    since, JSON.stringify(dismissed),
  );
  const groups = new Map<string, { merchant: string; rows: { amount: number; date: string }[] }>();
  for (const r of rows) {
    const key = r.merchant.toLowerCase();
    let g = groups.get(key);
    if (!g) { g = { merchant: r.merchant, rows: [] }; groups.set(key, g); }
    g.rows.push({ amount: r.amount, date: r.date });
  }
  const out: { merchant: string; amount: number; amount_min: number; amount_max: number; count: number; first_date: string; last_date: string; gap_days: number }[] = [];
  const summarize = (merchant: string, xs: { amount: number; date: string }[]) => {
    const amounts = xs.map((x) => x.amount);
    const first = xs[0].date, last = xs[xs.length - 1].date;
    const gap = Math.round(daysBetween(first, last) / Math.max(1, xs.length - 1));
    if (daysBetween(first, last) < 20) return;
    out.push({
      merchant, count: xs.length,
      amount: Math.round(amounts.reduce((a, b) => a + b, 0) / xs.length * 100) / 100,
      amount_min: Math.min(...amounts), amount_max: Math.max(...amounts),
      first_date: first, last_date: last, gap_days: gap,
    });
  };
  for (const g of groups.values()) {
    const amounts = g.rows.map((x) => x.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    if (Math.max(...amounts) - Math.min(...amounts) <= 0.2 * avg) { summarize(g.merchant, g.rows); continue; }
    // Otherwise: the most repeated exact amount, if it repeats.
    const byCents = new Map<number, { amount: number; date: string }[]>();
    for (const x of g.rows) {
      const k = Math.round(x.amount * 100);
      if (!byCents.has(k)) byCents.set(k, []);
      byCents.get(k)!.push(x);
    }
    const best = [...byCents.values()].sort((a, b) => b.length - a.length)[0];
    if (best && best.length >= 2) summarize(g.merchant, best);
  }
  out.sort((a, b) => (a.last_date < b.last_date ? 1 : -1));
  return c.json(out);
});

// Manually track a merchant as recurring with a user-declared cadence. The
// merchant is added to the manual list (settings key) so detectRecurring
// neither overwrites nor deletes the row.
recurring.post("/", async (c) => {
  const body = await readJson<{
    merchant?: string; cadence?: string; avg_amount?: number; category_id?: number | null;
  }>(c);
  if (!body || typeof body.merchant !== "string" || body.merchant.trim() === "") {
    return bad(c, "merchant is required");
  }
  const merchant = body.merchant.trim();
  const cadence = body.cadence ?? "monthly";
  if (!(CADENCES as readonly string[]).includes(cadence)) {
    return bad(c, "cadence must be one of: " + CADENCES.join(", "));
  }
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

  // Anchor last/next dates and default amount on the merchant's latest charge.
  const lastTxn = await first<{ date: string; amount: number }>(
    c.env,
    `SELECT date, amount FROM transactions
     WHERE COALESCE(merchant_name, name) = ? AND excluded = 0 AND amount > 0
     ORDER BY date DESC LIMIT 1`,
    merchant,
  );
  const avgAmount = body.avg_amount != null ? num(body.avg_amount) : (lastTxn ? lastTxn.amount : null);
  if (avgAmount == null || !(avgAmount > 0)) {
    return bad(c, "avg_amount is required when the merchant has no transactions");
  }
  const lastDate = lastTxn ? lastTxn.date : null;
  const step = CADENCE_DAYS[cadence];
  let nextDate = lastDate ? addDays(lastDate, step) : addDays(todayStr(), step);
  while (nextDate < todayStr()) nextDate = addDays(nextDate, step);

  await run(
    c.env,
    `INSERT INTO recurring (merchant, category_id, cadence, avg_amount, last_date, next_date, active)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
     ON CONFLICT(merchant) DO UPDATE SET
       category_id = excluded.category_id,
       cadence = excluded.cadence,
       avg_amount = excluded.avg_amount,
       last_date = excluded.last_date,
       next_date = excluded.next_date,
       active = 1`,
    merchant, categoryId, cadence, Math.round(avgAmount * 100) / 100, lastDate, nextDate,
  );

  // Protect the row from detection and clear any earlier candidate dismissal.
  const manual = await readMerchantList(c.env, MANUAL_RECURRING_KEY);
  if (!manual.includes(merchant)) await writeMerchantList(c.env, MANUAL_RECURRING_KEY, [...manual, merchant]);
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  if (dismissed.includes(merchant)) {
    await writeMerchantList(c.env, DISMISSED_KEY, dismissed.filter((m) => m !== merchant));
  }

  const row = await first<RecurringRow>(c.env, `${RECURRING_SELECT} WHERE r.merchant = ?`, merchant);
  if (!row) return notFound(c, "recurring row not found after insert");
  return c.json({ ...row, manual: 1, stale: isStale(row) ? 1 : 0 }, 201);
});

// Re-run detection over existing transactions without a Plaid sync.
recurring.post("/detect", async (c) => {
  await detectRecurring(c.env);
  return c.json(await listRecurring(c.env));
});

// Dismiss a "Possible subscriptions" candidate (persisted in settings).
recurring.post("/candidates/dismiss", async (c) => {
  const body = await readJson<{ merchant?: string }>(c);
  if (!body || typeof body.merchant !== "string" || body.merchant.trim() === "") {
    return bad(c, "merchant is required");
  }
  const merchant = body.merchant.trim();
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  if (!dismissed.includes(merchant)) await writeMerchantList(c.env, DISMISSED_KEY, [...dismissed, merchant]);
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
  if (hasOwn(body, "active")) {
    sets.push("active = ?");
    binds.push(body.active ? 1 : 0);
  }
  if (hasOwn(body, "category_id")) {
    if (body.category_id != null) {
      const cat = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE id = ?", body.category_id);
      if (!cat) return bad(c, "unknown category_id");
    }
    sets.push("category_id = ?");
    binds.push(body.category_id ?? null);
  }
  if (hasOwn(body, "avg_amount")) {
    const amt = num(body.avg_amount);
    if (!(amt > 0)) return bad(c, "avg_amount must be positive");
    sets.push("avg_amount = ?");
    binds.push(Math.round(amt * 100) / 100);
    declared = true;
  }
  let cadence = existing.cadence;
  if (hasOwn(body, "cadence")) {
    if (typeof body.cadence !== "string" || !(CADENCES as readonly string[]).includes(body.cadence)) {
      return bad(c, "cadence must be one of: " + CADENCES.join(", "));
    }
    cadence = body.cadence;
    sets.push("cadence = ?");
    binds.push(cadence);
    declared = true;
  }
  if (hasOwn(body, "next_date")) {
    if (body.next_date != null && (typeof body.next_date !== "string" || !isDate(body.next_date))) {
      return bad(c, "next_date must be YYYY-MM-DD");
    }
    sets.push("next_date = ?");
    binds.push(body.next_date ?? null);
    declared = true;
  } else if (hasOwn(body, "cadence") && cadence !== existing.cadence) {
    // Cadence changed without an explicit date: re-anchor on the last charge.
    const step = CADENCE_DAYS[cadence] ?? 30;
    const last = existing.last_date ?? existing.last_txn_date;
    let nextDate = last ? addDays(last, step) : addDays(todayStr(), step);
    while (nextDate < todayStr()) nextDate = addDays(nextDate, step);
    sets.push("next_date = ?");
    binds.push(nextDate);
  }
  if (sets.length === 0) return bad(c, "no fields to update");

  await run(c.env, `UPDATE recurring SET ${sets.join(", ")} WHERE id = ?`, ...binds, id);
  if (declared) {
    const manual = await readMerchantList(c.env, MANUAL_RECURRING_KEY);
    if (!manual.includes(existing.merchant)) {
      await writeMerchantList(c.env, MANUAL_RECURRING_KEY, [...manual, existing.merchant]);
    }
  }
  const row = await first<RecurringRow>(c.env, `${RECURRING_SELECT} WHERE r.id = ?`, id);
  if (!row) return notFound(c, "recurring item not found");
  const manual = await manualRecurringMerchants(c.env);
  return c.json({ ...row, manual: manual.includes(row.merchant) ? 1 : 0, stale: isStale(row) ? 1 : 0 });
});
