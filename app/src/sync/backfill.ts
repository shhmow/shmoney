// Portfolio-history backfill: reconstruct daily investment-account values for
// dates before the account was linked, and write them into balance_snapshots.
//
// Method: walk investment_transactions BACKWARD from current holdings
// quantities (current qty minus post-date buys plus post-date sells = qty at
// any past date), price each security from Stooq daily closes when possible,
// and INSERT OR IGNORE snapshots so real observed snapshots are never
// overwritten. See BACKFILL-NOTES.md for approximations.

import type { Env } from "../types";
import { batch, first, q, stmt, type PreparedStatement } from "../lib/db";
import { addDays, todayStr } from "../lib/format";

export interface BackfillResult {
  snapshots: number;
  pricedSecurities: number;
  unpricedSecurities: string[];
  note?: string;
}

const MAX_PRICE_FETCHES = 25;
const MAX_DAYS = 730; // we only hold ~2 years of investment transactions

/** Ascending daily close series. dates[i] pairs with closes[i]. */
export interface PriceSeries {
  dates: string[];
  closes: number[];
}

interface SecurityRow {
  id: string;
  ticker: string | null;
  name: string | null;
  type: string | null;
  close_price: number | null;
}

interface Position {
  accountId: string;
  securityId: string;
  currentQty: number;
  deltas: { date: string; qty: number }[]; // ascending by date
  suffix: number[]; // suffix[i] = sum of deltas[i..]; suffix[deltas.length] = 0
  ptr: number; // first delta index with date > current sampled date
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Parse a Stooq daily-history CSV body ("Date,Open,High,Low,Close,Volume").
 * Returns null when the body is not usable CSV (HTML challenge page, "N/D",
 * empty, unexpected header). Rows before `floor` are dropped; rows with a
 * non-numeric or non-positive close (e.g. "N/D") are skipped.
 */
export function parseStooqCsv(text: string, floor: string): PriceSeries | null {
  if (!text || text.charCodeAt(0) === 60 /* '<' */) return null;
  const lines = text.split("\n");
  if (lines.length < 2 || !lines[0].startsWith("Date,")) return null;
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 10) continue;
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const date = parts[0];
    if (date.length !== 10 || date < floor) continue;
    const close = Number(parts[4]);
    if (!Number.isFinite(close) || close <= 0) continue;
    dates.push(date);
    closes.push(close);
  }
  if (dates.length === 0) return null;
  return { dates, closes };
}

// Primary source is Yahoo's chart API (Stooq gates non-browser traffic behind
// a JS bot-check, verified 2026-08-25). Same PriceSeries shape out.
async function fetchYahooSeries(ticker: string, floor: string, days: number): Promise<PriceSeries | null> {
  try {
    const range = days <= 366 ? "1y" : "2y";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.toUpperCase())}?range=${range}&interval=1d`;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (shmoney personal dashboard)" } });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
    };
    const r = body.chart?.result?.[0];
    const ts = r?.timestamp;
    const closes = r?.indicators?.quote?.[0]?.close;
    if (!ts || !closes || ts.length === 0) return null;
    const outDates: string[] = [];
    const outCloses: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      if (date < floor) continue;
      outDates.push(date);
      outCloses.push(close);
    }
    return outDates.length > 0 ? { dates: outDates, closes: outCloses } : null;
  } catch {
    return null;
  }
}

function isCashLike(s: SecurityRow | undefined): boolean {
  if (!s) return false;
  if ((s.type ?? "").toLowerCase() === "cash") return true;
  return s.ticker === null && s.close_price === 1;
}

export async function backfillPortfolioHistory(
  env: Env,
  opts?: { days?: number },
): Promise<BackfillResult> {
  const daysRaw = opts?.days ?? MAX_DAYS;
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), MAX_DAYS) : MAX_DAYS;
  const today = todayStr();
  const startDate = addDays(today, -days);
  // Keep price rows slightly before the window so the first sampled date has a
  // close at-or-before it (markets close over weekends/holidays).
  const priceFloor = addDays(startDate, -14);
  const step = days <= 120 ? 1 : 2;

  const txnCount = await first<{ n: number }>(
    env, "SELECT COUNT(*) AS n FROM investment_transactions",
  );
  if (!txnCount || txnCount.n === 0) {
    return {
      snapshots: 0,
      pricedSecurities: 0,
      unpricedSecurities: [],
      note: "no investment history to reconstruct",
    };
  }

  // Current positions in investment accounts.
  const holdings = await q<{ account_id: string; security_id: string; quantity: number; value: number | null }>(
    env,
    `SELECT h.account_id, h.security_id, h.quantity, h.value
     FROM holdings h JOIN accounts a ON a.id = h.account_id
     WHERE a.type = 'investment'`,
  );

  // Quantity-affecting transactions inside the window, oldest first. Trades
  // older than the window are already baked into current holdings quantities.
  const txns = await q<{ account_id: string; security_id: string; date: string; quantity: number; type: string }>(
    env,
    `SELECT t.account_id, t.security_id, t.date, t.quantity, t.type
     FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.type = 'investment' AND t.security_id IS NOT NULL
       AND t.type IN ('buy', 'sell') AND t.quantity IS NOT NULL
       AND t.date > ?
     ORDER BY t.date ASC`,
    startDate,
  );

  const securities = await q<SecurityRow>(
    env, "SELECT id, ticker, name, type, close_price FROM securities",
  );
  const secById = new Map(securities.map((s) => [s.id, s]));

  // Build positions keyed by account|security. Start from current holdings;
  // securities that only appear in transactions (fully sold positions) start
  // at quantity 0 and gain history as we walk backward.
  const positions = new Map<string, Position>();
  const positionFor = (accountId: string, securityId: string): Position => {
    const key = `${accountId}|${securityId}`;
    let p = positions.get(key);
    if (!p) {
      p = { accountId, securityId, currentQty: 0, deltas: [], suffix: [], ptr: 0 };
      positions.set(key, p);
    }
    return p;
  };
  for (const h of holdings) {
    positionFor(h.account_id, h.security_id).currentQty = h.quantity;
  }
  for (const t of txns) {
    // Position delta per trade: buys add shares, sells remove them. Plaid may
    // report sell quantities as negative or positive depending on the
    // institution, so normalize on the transaction type.
    const qty = t.type === "sell" ? -Math.abs(t.quantity) : Math.abs(t.quantity);
    positionFor(t.account_id, t.security_id).deltas.push({ date: t.date, qty });
  }
  for (const p of positions.values()) {
    // txns arrived date-ascending, so deltas are already sorted.
    const n = p.deltas.length;
    p.suffix = new Array<number>(n + 1);
    p.suffix[n] = 0;
    for (let i = n - 1; i >= 0; i--) p.suffix[i] = p.suffix[i + 1] + p.deltas[i].qty;
  }

  if (positions.size === 0) {
    return {
      snapshots: 0,
      pricedSecurities: 0,
      unpricedSecurities: [],
      note: "no investment positions to reconstruct",
    };
  }

  // Price each involved security: cash-like at a flat 1.0; others from Stooq
  // by ticker (bounded number of fetches, deduped by ticker); anything left
  // falls back to the current close_price held flat across history.
  const involvedSecIds = [...new Set([...positions.values()].map((p) => p.securityId))];
  const currentValueBySec = new Map<string, number>();
  for (const h of holdings) {
    const s = secById.get(h.security_id);
    const v = h.value ?? (s && s.close_price !== null ? h.quantity * s.close_price : 0);
    currentValueBySec.set(h.security_id, (currentValueBySec.get(h.security_id) ?? 0) + (v ?? 0));
  }
  // Fetch the biggest current positions first so the fetch budget goes where
  // it matters most.
  const fetchOrder = involvedSecIds
    .filter((id) => !isCashLike(secById.get(id)))
    .sort((a, b) => (currentValueBySec.get(b) ?? 0) - (currentValueBySec.get(a) ?? 0));

  const seriesBySec = new Map<string, PriceSeries>();
  const flatPriceBySec = new Map<string, number>();
  const seriesByTicker = new Map<string, PriceSeries | null>();
  const unpricedSecurities: string[] = [];
  let fetches = 0;

  for (const id of involvedSecIds) {
    if (isCashLike(secById.get(id))) flatPriceBySec.set(id, 1);
  }
  for (const id of fetchOrder) {
    const s = secById.get(id);
    const label = s?.ticker ?? s?.name ?? id;
    let series: PriceSeries | null = null;
    if (s && s.ticker) {
      const key = s.ticker.toLowerCase();
      if (seriesByTicker.has(key)) {
        series = seriesByTicker.get(key) ?? null;
      } else if (fetches < MAX_PRICE_FETCHES) {
        fetches++;
        series = await fetchYahooSeries(s.ticker, priceFloor, days);
        seriesByTicker.set(key, series);
      }
    }
    if (series) {
      seriesBySec.set(id, series);
    } else {
      flatPriceBySec.set(id, s?.close_price ?? 0);
      unpricedSecurities.push(label);
    }
  }

  // Sampled dates: startDate up to (but never including) today.
  const sampleDates: string[] = [];
  for (let d = startDate; d < today; d = addDays(d, step)) sampleDates.push(d);

  // Per-security price cursor over the ascending sampled dates.
  const priceCursor = new Map<string, { i: number; last: number }>();
  for (const [id, series] of seriesBySec) {
    priceCursor.set(id, { i: 0, last: series.closes[0] });
  }

  const before = await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM balance_snapshots");
  const stmts: PreparedStatement[] = [];
  const positionList = [...positions.values()];
  const accountValue = new Map<string, number>();

  for (const date of sampleDates) {
    // Advance price cursors to the last close at-or-before this date.
    for (const [id, series] of seriesBySec) {
      const cur = priceCursor.get(id)!;
      while (cur.i < series.dates.length && series.dates[cur.i] <= date) {
        cur.last = series.closes[cur.i];
        cur.i++;
      }
    }
    accountValue.clear();
    for (const p of positionList) {
      // qty at end of `date` = current qty minus every delta dated after it.
      while (p.ptr < p.deltas.length && p.deltas[p.ptr].date <= date) p.ptr++;
      const qty = p.currentQty - p.suffix[p.ptr];
      if (!(qty > 1e-9)) continue;
      const cur = priceCursor.get(p.securityId);
      const price = cur ? cur.last : (flatPriceBySec.get(p.securityId) ?? 0);
      if (!(price > 0)) continue;
      accountValue.set(p.accountId, (accountValue.get(p.accountId) ?? 0) + qty * price);
    }
    for (const [accountId, value] of accountValue) {
      if (value <= 0) continue;
      stmts.push(stmt(
        env,
        "INSERT OR IGNORE INTO balance_snapshots (account_id, date, balance) VALUES (?1, ?2, ?3)",
        accountId, date, round2(value),
      ));
    }
  }

  await batch(env, stmts);
  const after = await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM balance_snapshots");
  const inserted = Math.max(0, (after?.n ?? 0) - (before?.n ?? 0));

  const result: BackfillResult = {
    snapshots: inserted,
    pricedSecurities: seriesBySec.size,
    unpricedSecurities,
  };
  if (unpricedSecurities.length > 0) {
    result.note = "securities without fetchable price history use today's close price flat across the window";
  }
  return result;
}
