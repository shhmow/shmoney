// GET /api/recurring, PATCH /api/recurring/:id,
// GET /api/recurring/candidates (possible subscriptions),
// POST /api/recurring (manually track a merchant),
// POST /api/recurring/candidates/dismiss (hide a candidate).
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, bad, notFound, readJson, hasOwn, daysAgoStr, todayStr, type Bind } from "./util";
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
}

const RECURRING_SELECT = `
  SELECT r.id, r.merchant, r.category_id, r.cadence, r.avg_amount, r.last_date, r.next_date, r.active,
         c.name AS category_name, c.color AS category_color
  FROM recurring r LEFT JOIN categories c ON c.id = r.category_id`;

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
  const rows = await q<RecurringRow>(
    c.env,
    `${RECURRING_SELECT} ORDER BY (r.next_date IS NULL), r.next_date, r.merchant`,
  );
  const manual = new Set(await manualRecurringMerchants(c.env));
  return c.json(rows.map((r) => ({ ...r, manual: manual.has(r.merchant) ? 1 : 0 })));
});

// Possible subscriptions: merchants not tracked in recurring, charged the
// exact same amount (to the cent) at least twice in the last 18 months.
recurring.get("/candidates", async (c) => {
  const since = daysAgoStr(548); // ~18 months
  const dismissed = await readMerchantList(c.env, DISMISSED_KEY);
  const rows = await q<{ merchant: string; amount: number; count: number; first_date: string; last_date: string }>(
    c.env,
    `SELECT COALESCE(t.merchant_name, t.name) AS merchant,
            t.amount AS amount,
            COUNT(*) AS count,
            MIN(t.date) AS first_date,
            MAX(t.date) AS last_date
     FROM transactions t
     WHERE t.date >= ?1 AND t.amount >= 1 AND t.is_transfer = 0 AND t.excluded = 0
       AND COALESCE(t.merchant_name, t.name) NOT IN (SELECT merchant FROM recurring)
       AND COALESCE(t.merchant_name, t.name) NOT IN (SELECT value FROM json_each(?2))
     GROUP BY COALESCE(t.merchant_name, t.name), CAST(ROUND(t.amount * 100) AS INTEGER)
     HAVING COUNT(*) >= 2
     ORDER BY MAX(t.date) DESC`,
    since, JSON.stringify(dismissed),
  );
  return c.json(rows.map((r) => ({
    merchant: r.merchant,
    amount: r.amount,
    count: r.count,
    first_date: r.first_date,
    last_date: r.last_date,
    gap_days: daysBetween(r.first_date, r.last_date),
  })));
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
  return c.json({ ...row, manual: 1 }, 201);
});

// Re-run detection over existing transactions without a Plaid sync.
recurring.post("/detect", async (c) => {
  await detectRecurring(c.env);
  const rows = await q<RecurringRow>(
    c.env,
    `${RECURRING_SELECT} ORDER BY (r.next_date IS NULL), r.next_date, r.merchant`,
  );
  const manual = new Set(await manualRecurringMerchants(c.env));
  return c.json(rows.map((r) => ({ ...r, manual: manual.has(r.merchant) ? 1 : 0 })));
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
  const body = await readJson<{ active?: boolean | number; category_id?: number | null }>(c);
  if (!body) return bad(c, "invalid JSON body");

  const sets: string[] = [];
  const binds: Bind[] = [];
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
  if (sets.length === 0) return bad(c, "no fields to update");

  await run(c.env, `UPDATE recurring SET ${sets.join(", ")} WHERE id = ?`, ...binds, id);
  const row = await first<RecurringRow>(c.env, `${RECURRING_SELECT} WHERE r.id = ?`, id);
  if (!row) return notFound(c, "recurring item not found");
  return c.json(row);
});
