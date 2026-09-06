// Recurring detection: which merchants bill on a schedule, how much they
// charge now, and when the next charge lands.
//
// Design notes:
//  * Charges are grouped by merchant identity, not the raw string. The same
//    subscription shows up under drifting descriptors ("CLAUDE.AI SUBSCRIPTION"
//    on one card, "ANTHROPIC* CLAUDE SUB" on the next), and Plaid sometimes
//    leaves merchant_name empty for one charge in a run. See merchantKey().
//  * A monthly stream is a chain of charges roughly a month apart walking back
//    from the latest charge. Extra charges in between (a prorated upgrade, a
//    one-off top-up) are ignored instead of breaking detection.
//  * The amount is the CURRENT price: the latest charge when the last two core
//    charges agree, else the mean of the recent core. Subscriptions change
//    price; an 18-month average is not what the next bill will be.
//  * Income streams (paychecks) are detected the same way on inflows and stored
//    with kind = 'income'.
import type { Env } from "../types";
import { batch, first, q, run, stmt, type PreparedStatement } from "../lib/db";
import { addDays, todayStr } from "../lib/format";

// Settings key holding a JSON array of merchant names the user tracks by hand
// (via POST /api/recurring). Rows for these merchants are protected from
// detection: never overwritten (user-declared cadence wins) and never deleted
// by the stale-row sweep.
export const MANUAL_RECURRING_KEY = "recurring_manual_merchants";
// Settings key holding a JSON array of merchant names the user dismissed from
// "Possible subscriptions" (or deleted from the list).
export const DISMISSED_KEY = "recurring_dismissed_merchants";

export async function manualRecurringMerchants(env: Env): Promise<string[]> {
  return readMerchantList(env, MANUAL_RECURRING_KEY);
}

export async function readMerchantList(env: Env, key: string): Promise<string[]> {
  const row = await first<{ value: string }>(env, "SELECT value FROM settings WHERE key = ?", key);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export async function writeMerchantList(env: Env, key: string, list: string[]): Promise<void> {
  await run(
    env,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key, JSON.stringify(list),
  );
}

/* ------------------------------------------------------------------ identity */

// Known rebrands and descriptor drift: any charge matching the pattern belongs
// to the named merchant, whatever string the bank printed.
const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(anthropic|claude)\b/, "anthropic"],
  [/\b(openai|chatgpt)\b/, "openai"],
  [/\bapple\.com\/bill\b|\bapple\b.*\bbill\b/, "apple"],
  [/\bamazon\b.*\bprime\b|\bprime video\b/, "amazon prime"],
  [/\bgoogle\b.*\b(one|storage)\b/, "google one"],
  [/\bgithub\b/, "github"],
];

const masked = (s: string | null | undefined): boolean => !s || /^[\s*#\-_.0-9]*$/.test(s);

/** Lowercase, punctuation stripped, bank boilerplate and reference numbers dropped. */
export function normalizeName(raw: string): string {
  let s = String(raw || "").toLowerCase();
  // Card processors prefix the merchant: "SQ *", "TST*", "PY *", "DD *", "SP ".
  s = s.replace(/^(sq|tst|py|dd|sp|pp|paypal|apl|sp)\s*\*\s*/, "");
  // Bank descriptor tails: "DES:WEB PMTS ID:… INDN:…", confirmation numbers.
  s = s.split(/\s+(?:des|id|indn|co id|pmt info|conf#|confirmation#?)[:\s#]/)[0];
  s = s.replace(/^(purchase|mobile purchase|pmnt sent|recurring)\s+\d{4}\s+/, "");
  s = s.replace(/[^a-z0-9 ]+/g, " ").replace(/\b\d{3,}\b/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** Stable identity for a charge: alias if one matches, else the normalized merchant name. */
export function merchantKey(merchantName: string | null, name: string): string {
  const both = normalizeName(`${merchantName ?? ""} ${name}`);
  for (const [re, key] of ALIASES) if (re.test(both)) return key;
  const base = merchantName && !masked(merchantName) ? merchantName : name;
  return normalizeName(base) || both || "unknown";
}

/** Display name for a charge: the cleaned merchant name, else a tidied descriptor. */
export function displayName(merchantName: string | null, name: string): string {
  if (merchantName && !masked(merchantName)) return merchantName.trim();
  const cut = String(name || "").split(/\s+(?:DES|ID|INDN|CO ID|PMT INFO|CONF#|Conf#|Confirmation#?)[:\s#]/i)[0];
  const out = (cut || name || "Unknown").replace(/\s{2,}/g, " ").trim().slice(0, 60);
  // Bank descriptors shout; title-case anything with no lowercase letters.
  return /[a-z]/.test(out) ? out : out.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/* ------------------------------------------------------------------ groups */

export interface Charge { date: string; amount: number; name: string }

export interface ChargeGroup {
  key: string;
  name: string;              // display name (latest charge)
  names: Set<string>;        // every display name seen in the group
  charges: Charge[];         // ascending by date, amounts positive
  categoryId: number | null; // most common category
  categoryName: string | null;
  categoryKind: string;      // expense | income | transfer
}

interface ChargeRow {
  merchant_name: string | null;
  name: string;
  date: string;
  amount: number;
  category_id: number | null;
  category_name: string | null;
  category_kind: string | null;
}

/**
 * Charges since `since` grouped by merchant identity. `direction` picks
 * outflows (bills) or inflows (income). Rows with no merchant_name adopt the
 * identity of rows that share their raw descriptor.
 */
export async function loadChargeGroups(env: Env, since: string, direction: "out" | "in"): Promise<ChargeGroup[]> {
  const rows = await q<ChargeRow>(
    env,
    `SELECT t.merchant_name, t.name, t.date, t.amount, t.category_id,
            c.name AS category_name, c.kind AS category_kind
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ?1 AND t.excluded = 0 AND t.pending = 0
       AND ${direction === "out" ? "t.amount > 0 AND t.is_transfer = 0" : "t.amount < 0 AND c.kind = 'income'"}
     ORDER BY t.date, t.name`,
    since,
  );
  // Raw descriptor -> key, learned from rows that carry a merchant_name.
  const rawToKey = new Map<string, string>();
  for (const r of rows) {
    if (r.merchant_name && !masked(r.merchant_name)) {
      const raw = normalizeName(r.name);
      if (raw && !rawToKey.has(raw)) rawToKey.set(raw, merchantKey(r.merchant_name, r.name));
    }
  }
  const groups = new Map<string, ChargeGroup & { cats: Map<number, number>; catNames: Map<number, [string, string]> }>();
  for (const r of rows) {
    let key = merchantKey(r.merchant_name, r.name);
    if (!r.merchant_name || masked(r.merchant_name)) key = rawToKey.get(normalizeName(r.name)) ?? key;
    let g = groups.get(key);
    if (!g) {
      g = { key, name: "", names: new Set(), charges: [], categoryId: null, categoryName: null, categoryKind: "expense", cats: new Map(), catNames: new Map() };
      groups.set(key, g);
    }
    const dn = displayName(r.merchant_name, r.name);
    g.names.add(dn);
    g.name = dn; // rows are date-ascending, so the latest wins
    g.charges.push({ date: r.date, amount: Math.abs(r.amount), name: dn });
    if (r.category_id !== null) {
      g.cats.set(r.category_id, (g.cats.get(r.category_id) ?? 0) + 1);
      g.catNames.set(r.category_id, [r.category_name ?? "", r.category_kind ?? "expense"]);
    }
  }
  const out: ChargeGroup[] = [];
  for (const g of groups.values()) {
    let best: number | null = null, bestN = 0;
    for (const [cid, n] of g.cats) if (n > bestN) { best = cid; bestN = n; }
    g.categoryId = best;
    if (best !== null) {
      const [cn, ck] = g.catNames.get(best) ?? ["", "expense"];
      g.categoryName = cn || null;
      g.categoryKind = ck || "expense";
    }
    const { cats: _c, catNames: _n, ...rest } = g;
    out.push(rest);
  }
  return out;
}

/* ------------------------------------------------------------------ cadence */

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
export const CADENCES: readonly Cadence[] = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
export const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, yearly: 365 };

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Walk back from the latest charge picking, at each step, the earlier charge
 * whose gap falls in [lo, hi] (closest to the middle of the window). With
 * `skip`, one missed period is tolerated (a gap in [2lo, 2hi]). Returns the
 * chain in ascending date order.
 */
function chain(charges: Charge[], lo: number, hi: number, skip: boolean): Charge[] {
  if (charges.length === 0) return [];
  const out: Charge[] = [charges[charges.length - 1]];
  let i = charges.length - 1;
  const mid = (lo + hi) / 2;
  while (i > 0) {
    let pick = -1, pickErr = Infinity;
    for (let j = i - 1; j >= 0; j--) {
      const gap = daysBetween(charges[j].date, charges[i].date);
      if (gap > 2 * hi) break;
      if (gap >= lo && gap <= hi) {
        const err = Math.abs(gap - mid);
        if (err < pickErr) { pick = j; pickErr = err; }
      } else if (skip && pick === -1 && gap >= 2 * lo && gap <= 2 * hi) {
        const err = Math.abs(gap - 2 * mid);
        if (err < pickErr) { pick = j; pickErr = err; }
      }
    }
    if (pick === -1) break;
    out.unshift(charges[pick]);
    i = pick;
  }
  return out;
}

// Categories where only exact repeats count as recurring: a restaurant
// visited on a similar cadence with similar totals is a habit, not a bill.
const STRICT_CATEGORIES = new Set(["Dining out", "Groceries", "Transport", "Shopping", "Travel"]);
// Categories whose bills legitimately vary month to month.
const VARIABLE_CATEGORIES = new Set(["Bills & utilities", "Housing"]);

function identicalShare(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const a of xs) { const c = Math.round(a * 100); counts.set(c, (counts.get(c) ?? 0) + 1); }
  return Math.max(...counts.values()) / xs.length;
}

function consistent(core: Charge[], k: number, categoryName: string | null, income: boolean): boolean {
  const xs = core.slice(-k).map((c) => c.amount);
  const cv = mean(xs) > 0 ? stddev(xs) / mean(xs) : Infinity;
  const same = identicalShare(xs);
  if (income) return cv <= 0.15 || same >= 0.5;
  if (categoryName && STRICT_CATEGORIES.has(categoryName)) return same === 1;
  if (categoryName && VARIABLE_CATEGORIES.has(categoryName)) return cv <= 0.35 || same >= 0.5;
  return cv <= 0.08 || same >= 0.5;
}

/** Current amount: the latest charge when the last two agree, else the recent mean. */
function currentAmount(core: Charge[], k: number): number {
  const n = core.length;
  if (n >= 2 && Math.abs(core[n - 1].amount - core[n - 2].amount) < 0.011) return core[n - 1].amount;
  return mean(core.slice(-k).map((c) => c.amount));
}

/** Same day next month, clamped to the month's length. */
export function nextMonthly(date: string, months = 1): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, dim));
  return target.toISOString().slice(0, 10);
}

export interface Detection {
  cadence: Cadence;
  amount: number;
  lastDate: string;
  nextDate: string;
  core: Charge[];
}

/** Detect a billing cadence for one group of charges, or null. */
export function detectCadence(g: ChargeGroup, today: string, income = false): Detection | null {
  const shortSince = addDays(today, -200);
  const recent = g.charges.filter((c) => c.date >= shortSince);
  const cat = income ? null : g.categoryName;
  const coverage = (core: Charge[]) => core.length / Math.max(1, recent.length);

  // Short cadences from the recent window: weekly, biweekly, monthly.
  const tryShort = (lo: number, hi: number, minLen: number, k: number, skip: boolean): Charge[] | null => {
    if (recent.length < minLen) return null;
    const core = chain(recent, lo, hi, skip);
    if (core.length < minLen || coverage(core) < 0.6) return null;
    // Most hops must be direct: a chain built from skipped periods is noise.
    let direct = 0;
    for (let i = 1; i < core.length; i++) if (daysBetween(core[i - 1].date, core[i].date) <= hi) direct++;
    if (direct < minLen - 1) return null;
    return consistent(core, k, cat, income) ? core : null;
  };
  let core: Charge[] | null;
  if ((core = tryShort(6, 8, 4, 4, false))) return finish("weekly", core, k4(core, 7));
  if ((core = tryShort(12, 16, 3, 3, false))) return finish("biweekly", core, k4(core, 14));
  if ((core = tryShort(24, 37, 3, 3, true))) return finish("monthly", core, nextMonthly(core[core.length - 1].date));

  // Long cadences from the full window (two years). Charges closer together
  // than a quarter contradict a long cadence.
  const gaps: number[] = [];
  for (let i = 1; i < g.charges.length; i++) gaps.push(daysBetween(g.charges[i - 1].date, g.charges[i].date));
  const recentGaps: number[] = [];
  for (let i = 1; i < recent.length; i++) recentGaps.push(daysBetween(recent[i - 1].date, recent[i].date));
  const contradicted = recentGaps.length >= 1 && median(recentGaps) < 60;
  if (!contradicted && gaps.length >= 2) {
    const med = median(gaps);
    if (med >= 84 && med <= 100 && consistentLong(g.charges)) return finish("quarterly", g.charges, addDays(last(g.charges).date, Math.round(med)));
  }
  if (!contradicted && gaps.length >= 1) {
    const med = median(gaps);
    if (med >= 340 && med <= 390 && consistentLong(g.charges)) return finish("yearly", g.charges, addDays(last(g.charges).date, Math.round(med)));
  }
  return null;

  function finish(cadence: Cadence, c: Charge[], next: string): Detection {
    const k = cadence === "weekly" ? 4 : 3;
    return { cadence, amount: Math.round(currentAmount(c, k) * 100) / 100, lastDate: last(c).date, nextDate: next, core: c };
  }
}

function k4(core: Charge[], step: number): string { return addDays(last(core).date, step); }
function last<T>(xs: T[]): T { return xs[xs.length - 1]; }
function consistentLong(charges: Charge[]): boolean {
  const xs = charges.map((c) => c.amount);
  const cv = mean(xs) > 0 ? stddev(xs) / mean(xs) : Infinity;
  return cv <= 0.1 || identicalShare(xs) === 1;
}

/* ------------------------------------------------------------------ detect */

export async function detectRecurring(env: Env): Promise<void> {
  const today = todayStr();
  const since = addDays(today, -740);
  const [bills, income] = await Promise.all([
    loadChargeGroups(env, since, "out"),
    loadChargeGroups(env, since, "in"),
  ]);
  const manual = new Set(await manualRecurringMerchants(env));
  // Merchants the user dismissed as "not a subscription" are never auto-tracked.
  const dismissed = new Set((await readMerchantList(env, DISMISSED_KEY)).map((m) => merchantKey(m, m)));
  const existing = new Map(
    (await q<{ merchant: string; active: number }>(env, "SELECT merchant, active FROM recurring")).map((r) => [r.merchant, r]),
  );
  const existingByKey = new Map<string, string[]>();
  for (const m of existing.keys()) {
    const k = merchantKey(m, m);
    existingByKey.set(k, [...(existingByKey.get(k) ?? []), m]);
  }
  const subsId = (await first<{ id: number }>(env, "SELECT id FROM categories WHERE name = 'Subscriptions'"))?.id ?? null;

  const stmts: PreparedStatement[] = [];
  const detected: string[] = [];
  const superseded = new Set<string>(); // rows replaced by a renamed/aliased group

  const handle = (g: ChargeGroup, kind: "expense" | "income") => {
    // Other names this merchant has gone by: their rows collapse into this one.
    const others = new Set([...g.names, ...(existingByKey.get(g.key) ?? [])]);
    others.delete(g.name);
    const manualHere = manual.has(g.name);
    // A manually tracked row under an old name keeps its declared cadence only
    // while that name is still what the bank prints; once the descriptor moves
    // on, detection takes over under the new name.
    for (const n of others) if (existing.has(n) || manual.has(n)) superseded.add(n);
    if (manualHere) return; // user-declared values win
    if (dismissed.has(g.key)) return;
    const d = detectCadence(g, today, kind === "income");
    if (!d) return;
    // Long cadences look far back: if the next charge is well overdue the
    // subscription probably ended.
    if ((d.cadence === "quarterly" || d.cadence === "yearly") && d.nextDate < addDays(today, -45)) return;
    // Carry an "ignored" flag over from a superseded row.
    const wasIgnored = [...others].some((n) => existing.get(n)?.active === 0);
    const active = existing.get(g.name)?.active ?? (wasIgnored ? 0 : 1);
    // A detected bill with no real category is almost always a subscription.
    let categoryId = g.categoryId;
    if (kind === "expense" && subsId !== null && (categoryId === null || g.categoryName === "Other")) {
      categoryId = subsId;
      stmts.push(stmt(
        env,
        `UPDATE transactions SET category_id = ?1
         WHERE amount > 0 AND is_transfer = 0 AND COALESCE(merchant_name, name) IN (SELECT value FROM json_each(?2))
           AND (category_id IS NULL OR category_id IN (SELECT id FROM categories WHERE name = 'Other'))`,
        subsId, JSON.stringify([...g.names]),
      ));
    }
    stmts.push(stmt(
      env,
      `INSERT INTO recurring (merchant, category_id, cadence, avg_amount, last_date, next_date, active, kind)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(merchant) DO UPDATE SET
         category_id = excluded.category_id,
         cadence = excluded.cadence,
         avg_amount = excluded.avg_amount,
         last_date = excluded.last_date,
         next_date = excluded.next_date,
         kind = excluded.kind`,
      g.name, categoryId, d.cadence, d.amount, d.lastDate, d.nextDate, active, kind,
    ));
    detected.push(g.name);
  };
  for (const g of bills) handle(g, "expense");
  for (const g of income) handle(g, "income");

  // Dismissed merchants that were auto-tracked earlier drop out (manual rows stay).
  for (const [m] of existing) {
    if (!manual.has(m) && dismissed.has(merchantKey(m, m))) superseded.add(m);
  }
  if (superseded.size) {
    stmts.push(stmt(env, "DELETE FROM recurring WHERE merchant IN (SELECT value FROM json_each(?1))", JSON.stringify([...superseded])));
    const keep = [...manual].filter((m) => !superseded.has(m));
    if (keep.length !== manual.size) await writeMerchantList(env, MANUAL_RECURRING_KEY, keep);
  }
  // Rows no longer detected are kept (with their history) while the last
  // charge is under a year old: the API flags overdue ones as stale and the
  // UI shows them under "Stopped?". Older leftovers are swept, except manual rows.
  stmts.push(stmt(
    env,
    `DELETE FROM recurring
     WHERE merchant NOT IN (SELECT value FROM json_each(?1))
       AND merchant NOT IN (SELECT value FROM json_each(?2))
       AND (last_date IS NULL OR last_date < ?3)`,
    JSON.stringify(detected), JSON.stringify([...manual]), addDays(today, -365),
  ));
  await batch(env, stmts);
  console.log(`recurring: ${detected.length} streams detected, ${manual.size} manual, ${superseded.size} superseded`);
}

/* ------------------------------------------------------------------ candidates */

export interface Candidate {
  merchant: string;
  amount: number;
  amount_min: number;
  amount_max: number;
  count: number;
  first_date: string;
  last_date: string;
  gap_days: number;
  category_name: string | null;
}

/**
 * Possible subscriptions: merchants not tracked, charged at least twice in
 * the last 18 months at least 20 days apart, either at amounts within ~20% of
 * each other or with one exact amount repeated. Habit categories (dining,
 * groceries, transport, shopping, travel) need the exact repeat.
 */
export async function recurringCandidates(env: Env, dismissed: string[]): Promise<Candidate[]> {
  const today = todayStr();
  const groups = await loadChargeGroups(env, addDays(today, -548), "out");
  const tracked = new Set(
    (await q<{ merchant: string }>(env, "SELECT merchant FROM recurring")).map((r) => merchantKey(r.merchant, r.merchant)),
  );
  const skip = new Set(dismissed.map((m) => merchantKey(m, m)));
  const out: Candidate[] = [];
  const summarize = (g: ChargeGroup, xs: Charge[]) => {
    const first = xs[0].date, lastD = xs[xs.length - 1].date;
    const span = daysBetween(first, lastD);
    if (span < 20) return;
    const amounts = xs.map((x) => x.amount);
    out.push({
      merchant: g.name, count: xs.length,
      amount: Math.round(mean(amounts) * 100) / 100,
      amount_min: Math.min(...amounts), amount_max: Math.max(...amounts),
      first_date: first, last_date: lastD, gap_days: Math.round(span / Math.max(1, xs.length - 1)),
      category_name: g.categoryName,
    });
  };
  for (const g of groups) {
    if (g.charges.length < 2 || tracked.has(g.key) || skip.has(g.key)) continue;
    if (g.categoryKind !== "expense") continue;
    // A stream that stopped more than 90 days ago is not worth suggesting.
    if (last(g.charges).date < addDays(today, -90)) continue;
    const strict = g.categoryName !== null && STRICT_CATEGORIES.has(g.categoryName);
    const lenient = g.categoryName !== null && VARIABLE_CATEGORIES.has(g.categoryName);
    const amounts = g.charges.map((c) => c.amount);
    if (lenient || (!strict && Math.max(...amounts) - Math.min(...amounts) <= 0.2 * mean(amounts))) { summarize(g, g.charges); continue; }
    const byCents = new Map<number, Charge[]>();
    for (const c of g.charges) {
      const k = Math.round(c.amount * 100);
      if (!byCents.has(k)) byCents.set(k, []);
      byCents.get(k)!.push(c);
    }
    const best = [...byCents.values()].sort((a, b) => b.length - a.length)[0];
    if (best && best.length >= 2) summarize(g, best);
  }
  out.sort((a, b) => (a.last_date < b.last_date ? 1 : -1));
  return out;
}
