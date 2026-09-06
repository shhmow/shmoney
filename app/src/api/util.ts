// Shared helpers for the API routes: re-exports of Agent A's modules (so the
// route files import everything from one place), date/month math, SQL
// fragments, and small request/response utilities.
import type { Context } from "hono";
import type { Env } from "../types";
import { q, first } from "../lib/db";

export { q, first, run } from "../lib/db";
export { createLinkToken, exchangePublicToken } from "../lib/plaid";
export { syncAll, syncItem, applyRules, applyPlaidCategoryFallback, backfillMerchantLogos, detectRecurring } from "../sync";
export { ensureInstitutionMeta } from "../lib/plaid";
export type { SyncResult } from "../sync";
export { rolloverBudgets } from "../sync/rollover";

export type Bind = string | number | null;

// ---------------------------------------------------------------------------
// Dates & months (all UTC, TEXT 'YYYY-MM-DD' / 'YYYY-MM')

export const nowIso = (): string => new Date().toISOString();
export const todayStr = (): string => nowIso().slice(0, 10);
export const currentMonth = (): string => todayStr().slice(0, 7);
export const isMonth = (s: string): boolean => /^\d{4}-\d{2}$/.test(s);
export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The client's local calendar date (sent as ?today=YYYY-MM-DD by lib/api.js),
 * accepted when it is within two days of UTC today; otherwise UTC. Keeps "day
 * 6 of 30" consistent across views when the server is already on tomorrow.
 */
export function requestToday(c: Context): string {
  const t = c.req.query("today") ?? "";
  if (!isDate(t)) return todayStr();
  const diff = Math.abs(Date.parse(`${t}T00:00:00Z`) - Date.parse(`${todayStr()}T00:00:00Z`));
  return diff <= 2 * 86400_000 ? t : todayStr();
}
export const requestMonth = (c: Context): string => requestToday(c).slice(0, 7);

export function addMonths(month: string, delta: number): string {
  const y = parseInt(month.slice(0, 4), 10);
  const m = parseInt(month.slice(5, 7), 10) - 1 + delta;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

export const monthStart = (month: string): string => month + "-01";
export const monthEndExcl = (month: string): string => monthStart(addMonths(month, 1));

export function daysInMonth(month: string): number {
  const y = parseInt(month.slice(0, 4), 10);
  const m = parseInt(month.slice(5, 7), 10);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function daysAgoStr(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Numbers

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// SQL fragments (aliases: t = transactions, c = categories, a = accounts)

// Spending: money out, not a transfer, not user-excluded, category neither
// transfer- nor income-kind (a positive amount in an income category is a
// paycheck reversal, not spending). Shared by overview, budgets and cashflow.
export const SPEND_COND =
  "t.amount > 0 AND t.is_transfer = 0 AND t.excluded = 0 AND (c.kind IS NULL OR c.kind NOT IN ('transfer','income'))";

// Income, one rule everywhere: money in that either sits in an income-kind
// category (kind wins over the is_transfer flag — a rules/user categorization
// to an income category IS income, full stop) or is uncategorized and not
// flagged as a transfer. Money in on categorized expense/transfer categories
// (refunds, transfers) is never income. Shared by overview and cashflow.
export const INCOME_COND =
  "t.amount < 0 AND t.excluded = 0 AND (c.kind = 'income' OR (t.category_id IS NULL AND t.is_transfer = 0))";

export const TXN_JOIN =
  "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id";

export const TXN_SELECT =
  "SELECT t.id, t.account_id, t.date, t.name, t.merchant_name, t.amount, t.pending, " +
  "t.category_id, t.plaid_category, t.payment_channel, t.is_transfer, t.excluded, t.notes, t.biz_category_id, " +
  "t.logo_url, t.website, t.flagged, " +
  "c.name AS category_name, c.color AS category_color, c.kind AS category_kind, " +
  "a.name AS account_name, a.mask AS account_mask, a.item_id AS item_id, a.type AS account_type " +
  TXN_JOIN;

export interface Txn {
  id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  pending: number;
  category_id: number | null;
  plaid_category: string | null;
  payment_channel: string | null;
  is_transfer: number;
  excluded: number;
  notes: string | null;
  biz_category_id: number | null;
  logo_url: string | null;
  website: string | null;
  flagged: number;
  item_id: number;
  account_type: string;
  category_name: string | null;
  category_color: string | null;
  category_kind: string | null;
  account_name: string;
  account_mask: string | null;
}

export interface AccountRow {
  id: string;
  item_id: number;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string;
  current_balance: number | null;
  available_balance: number | null;
  credit_limit: number | null;
  hidden: number;
  updated_at: string | null;
  nickname?: string | null;
  manual_limit?: number | null;
  institution_id?: string | null;
  institution_name?: string | null;
  primary_color?: string | null;
  institution_url?: string | null;
  has_logo?: number;
  brand?: string | null;
  links_key?: string | null;
}

export const ACCOUNT_COLS =
  "id, item_id, name, official_name, mask, type, subtype, currency, " +
  "current_balance, available_balance, credit_limit, hidden, updated_at";

// Accounts joined with their institution's branding (alias a = accounts, i = items).
export const ACCOUNT_SELECT =
  "SELECT a.id, a.item_id, a.name, a.official_name, a.mask, a.type, a.subtype, a.currency, " +
  "a.current_balance, a.available_balance, a.credit_limit, a.hidden, a.updated_at, a.nickname, a.manual_limit, " +
  "i.institution_id, i.institution_name, i.primary_color, i.url AS institution_url, " +
  "(i.logo IS NOT NULL) AS has_logo " +
  "FROM accounts a LEFT JOIN items i ON i.id = a.item_id";

// ---------------------------------------------------------------------------
// Common queries

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const rows = await q<{ key: string; value: string }>(env, "SELECT key, value FROM settings");
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Spending per category for one month. Key = category_id (null spend is skipped). */
export async function monthSpendByCategory(env: Env, month: string): Promise<Map<number, number>> {
  const rows = await q<{ cid: number | null; spent: number | null }>(
    env,
    `SELECT t.category_id AS cid, SUM(t.amount) AS spent
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}
     GROUP BY t.category_id`,
    monthStart(month),
    monthEndExcl(month),
  );
  const out = new Map<number, number>();
  for (const r of rows) if (r.cid != null) out.set(r.cid, round2(num(r.spent)));
  return out;
}

/**
 * Average spend per category over the 3 calendar months before `month`.
 * Months before the first transaction on record do not count toward the
 * divisor (so short histories are not diluted); divisor is at least 1.
 */
export async function avg3moSpend(env: Env, month: string): Promise<Map<number, number>> {
  const rows = await q<{ cid: number | null; spent: number | null }>(
    env,
    `SELECT t.category_id AS cid, SUM(t.amount) AS spent
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}
     GROUP BY t.category_id`,
    monthStart(addMonths(month, -3)),
    monthStart(month),
  );
  const earliest = await first<{ d: string | null }>(env, "SELECT MIN(date) AS d FROM transactions");
  let months = 0;
  if (earliest && earliest.d) {
    const em = earliest.d.slice(0, 7);
    for (let i = 1; i <= 3; i++) if (addMonths(month, -i) >= em) months++;
  }
  const divisor = Math.max(1, Math.min(3, months));
  const out = new Map<number, number>();
  for (const r of rows) if (r.cid != null) out.set(r.cid, round2(num(r.spent) / divisor));
  return out;
}

// ---------------------------------------------------------------------------
// Request/response helpers

export function bad(c: Context, msg: string): Response {
  return c.json({ error: msg }, 400);
}

export function notFound(c: Context, msg = "not found"): Response {
  return c.json({ error: msg }, 404);
}

export async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

export const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);
