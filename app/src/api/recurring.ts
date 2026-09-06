// GET /api/recurring, PATCH /api/recurring/:id,
// GET /api/recurring/candidates (possible subscriptions),
// GET /api/recurring/merchants?q= (merchant search for manual tracking),
// POST /api/recurring (manually track a merchant),
// POST /api/recurring/detect (re-run detection),
// POST /api/recurring/candidates/dismiss (hide a candidate).
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, bad, notFound, readJson, hasOwn, daysAgoStr, todayStr, isDate, type Bind } from "./util";
import { addDays } from "../lib/format";
import {
  detectRecurring, manualRecurringMerchants, readMerchantList, writeMerchantList, recurringCandidates,
  MANUAL_RECURRING_KEY, DISMISSED_KEY, CADENCES, CADENCE_DAYS, nextMonthly, type Cadence,
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
}

// `lt` is the merchant's latest charge; it tells us which account the
// charge lands on and what it actually cost last time.
const RECURRING_SELECT = `
  SELECT r.id, r.merchant, r.category_id, r.cadence, r.avg_amount, r.last_date, r.next_date, r.active, r.kind,
         c.name AS category_name, c.color AS category_color,
         lt.account_id AS account_id, COALESCE(a.nickname, a.name) AS account_name, a.mask AS account_mask,
         lt.amount AS last_amount, lt.date AS last_txn_date, lt.logo_url AS logo_url, lt.website AS website
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

function decorate(r: RecurringRow, manual: Set<string>) {
  return { ...r, manual: manual.has(r.merchant) ? 1 : 0, stale: isStale(r) ? 1 : 0 };
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

export const recurring = new Hono<{ Bindings: Env }>();

recurring.get("/", async (c) => c.json(await listRecurring(c.env)));

recurring.get("/candidates", async (c) => {
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  return c.json(await recurringCandidates(c.env, dismissed));
});

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
