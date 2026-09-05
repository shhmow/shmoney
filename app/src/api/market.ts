// Market data: sector exposure, concentration analysis, sector pulse, and
// per-holding performance. All external fetches happen HERE (server-side) —
// the browser cannot reach Yahoo cross-origin. Every external lookup is
// cached in D1 (market_cache, 24h TTL) and degrades to stale data, then to a
// built-in approximate sector map, and finally to an honest "unmapped" list.
//
// Endpoints (mounted under /api/market):
//   GET /sectors?account_id=      sector exposure + concentration analysis
//   GET /pulse?account_id=        11 SPDR sector ETFs + SPY, 1M/3M/1Y returns
//   GET /performance?account_id=  per-holding returns + SPY 1Y series
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, round2 } from "./util";

// ---------------------------------------------------------------------------
// D1-backed cache (migrations/0002_market_cache.sql). 24h TTL; stale rows are
// served when a refetch fails so a Yahoo outage never blanks a card.

const TTL_MS = 24 * 3600 * 1000;

async function cacheRead(env: Env, key: string): Promise<{ fresh: unknown; stale: unknown }> {
  const row = await first<{ fetched_at: string; payload: string }>(
    env, "SELECT fetched_at, payload FROM market_cache WHERE key = ?", key,
  );
  if (!row) return { fresh: null, stale: null };
  let parsed: unknown = null;
  try { parsed = JSON.parse(row.payload); } catch { return { fresh: null, stale: null }; }
  const age = Date.now() - Date.parse(row.fetched_at);
  return Number.isFinite(age) && age < TTL_MS ? { fresh: parsed, stale: parsed } : { fresh: null, stale: parsed };
}

async function cacheWrite(env: Env, key: string, payload: unknown): Promise<void> {
  await run(
    env,
    `INSERT INTO market_cache (key, fetched_at, payload) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET fetched_at = ?2, payload = ?3`,
    key, new Date().toISOString(), JSON.stringify(payload),
  );
}

/** Cached call: fresh hit -> cached value; miss -> fn(); fn() null -> stale. */
async function memo<T>(env: Env, key: string, fn: () => Promise<T | null>): Promise<T | null> {
  const { fresh, stale } = await cacheRead(env, key);
  if (fresh !== null) return fresh as T;
  let value: T | null = null;
  try { value = await fn(); } catch { value = null; }
  if (value !== null) {
    await cacheWrite(env, key, value);
    return value;
  }
  return (stale as T) ?? null;
}

// ---------------------------------------------------------------------------
// Yahoo fetchers

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function ysig(ms = 8000): AbortSignal | undefined {
  try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

export interface PriceSeries { dates: string[]; closes: number[] }

/** Daily closes for ~1y from the verified-working Yahoo chart API. */
async function fetchChart(ticker: string): Promise<PriceSeries | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.toUpperCase())}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: ysig() });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
  };
  const r = body.chart?.result?.[0];
  const ts = r?.timestamp;
  const closes = r?.indicators?.quote?.[0]?.close;
  if (!ts || !closes || ts.length === 0) return null;
  const dates: string[] = [];
  const out: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
    out.push(Math.round(close * 10000) / 10000);
  }
  return dates.length > 0 ? { dates, closes: out } : null;
}

function chart(env: Env, ticker: string): Promise<PriceSeries | null> {
  return memo<PriceSeries>(env, `chart1y:${ticker.toUpperCase()}`, () => fetchChart(ticker));
}

// quoteSummary needs a session cookie + crumb. This flow can be rate-limited
// or blocked by Yahoo; when it fails we cache the failure briefly (1h) so we
// don't hammer the endpoint, and holdings fall back to the built-in map.
interface YahooAuth { cookie: string; crumb: string }
const AUTH_FAIL_TTL = 3600 * 1000;

async function getYahooAuth(env: Env): Promise<YahooAuth | null> {
  const row = await first<{ fetched_at: string; payload: string }>(
    env, "SELECT fetched_at, payload FROM market_cache WHERE key = 'yahoo_auth'",
  );
  if (row) {
    try {
      const parsed = JSON.parse(row.payload) as (YahooAuth & { failed?: boolean });
      const age = Date.now() - Date.parse(row.fetched_at);
      if (parsed.failed && age < AUTH_FAIL_TTL) return null;
      if (!parsed.failed && parsed.crumb && age < 12 * 3600 * 1000) return parsed;
    } catch { /* refetch below */ }
  }
  let auth: YahooAuth | null = null;
  try {
    const cres = await fetch("https://fc.yahoo.com/", {
      headers: { "user-agent": UA }, redirect: "manual", signal: ysig(),
    });
    const setCookie = cres.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    if (cookie.includes("=")) {
      const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
        headers: { "user-agent": UA, cookie }, signal: ysig(),
      });
      if (crumbRes.ok) {
        const crumb = (await crumbRes.text()).trim();
        if (crumb && crumb.length < 32 && !/\s/.test(crumb)) auth = { cookie, crumb };
      }
    }
  } catch { auth = null; }
  await cacheWrite(env, "yahoo_auth", auth ?? { failed: true });
  return auth;
}

// Canonical GICS-ish sector keys.
const SECTOR_DEFS = [
  { key: "tech", label: "Technology", etf: "XLK", spx: 33 },
  { key: "financials", label: "Financials", etf: "XLF", spx: 13 },
  { key: "cyclical", label: "Consumer discretionary", etf: "XLY", spx: 10.5 },
  { key: "comms", label: "Communication services", etf: "XLC", spx: 9.5 },
  { key: "health", label: "Health care", etf: "XLV", spx: 9.5 },
  { key: "industrials", label: "Industrials", etf: "XLI", spx: 8.5 },
  { key: "defensive", label: "Consumer staples", etf: "XLP", spx: 5.5 },
  { key: "energy", label: "Energy", etf: "XLE", spx: 3 },
  { key: "utilities", label: "Utilities", etf: "XLU", spx: 2.5 },
  { key: "realestate", label: "Real estate", etf: "XLRE", spx: 2 },
  { key: "materials", label: "Materials", etf: "XLB", spx: 2 },
] as const;
type SectorKey = (typeof SECTOR_DEFS)[number]["key"] | "bonds" | "cash";
const SECTOR_LABEL: Record<string, string> = { bonds: "Bonds / fixed income", cash: "Cash" };
for (const s of SECTOR_DEFS) SECTOR_LABEL[s.key] = s.label;

// Yahoo topHoldings.sectorWeightings keys -> canonical.
const YAHOO_SECTOR_KEY: Record<string, SectorKey> = {
  technology: "tech",
  financial_services: "financials",
  consumer_cyclical: "cyclical",
  communication_services: "comms",
  healthcare: "health",
  industrials: "industrials",
  consumer_defensive: "defensive",
  energy: "energy",
  utilities: "utilities",
  realestate: "realestate",
  basic_materials: "materials",
};

function sectorFromProfileText(text: string): SectorKey | null {
  const k = text.toLowerCase().replace(/[^a-z]/g, "");
  const map: Record<string, SectorKey> = {
    technology: "tech",
    financialservices: "financials",
    financial: "financials",
    consumercyclical: "cyclical",
    communicationservices: "comms",
    healthcare: "health",
    industrials: "industrials",
    consumerdefensive: "defensive",
    energy: "energy",
    utilities: "utilities",
    realestate: "realestate",
    basicmaterials: "materials",
  };
  return map[k] ?? null;
}

type Weights = Partial<Record<SectorKey, number>>;

interface SectorLookup { sectors: Weights; source: "yahoo" | "approx"; fund: boolean }

/** quoteSummary lookup: fund look-through sectors, or a stock's own sector. */
async function fetchQuoteSummarySectors(env: Env, ticker: string): Promise<SectorLookup | { none: true } | null> {
  const auth = await getYahooAuth(env);
  if (!auth) return null;
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker.toUpperCase())}` +
    `?modules=assetProfile,fundProfile,topHoldings&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, { headers: { "user-agent": UA, cookie: auth.cookie }, signal: ysig() });
  if (res.status === 404) return { none: true };
  if (!res.ok) {
    if (res.status === 401 || res.status === 429) await cacheWrite(env, "yahoo_auth", { failed: true });
    return null;
  }
  const body = (await res.json()) as {
    quoteSummary?: {
      result?: {
        topHoldings?: { sectorWeightings?: Record<string, { raw?: number }>[] };
        assetProfile?: { sector?: string };
      }[];
      error?: unknown;
    };
  };
  const r = body.quoteSummary?.result?.[0];
  if (!r) return { none: true };
  const sw = r.topHoldings?.sectorWeightings;
  if (Array.isArray(sw) && sw.length > 0) {
    const sectors: Weights = {};
    for (const entry of sw) {
      for (const [yk, v] of Object.entries(entry)) {
        const key = YAHOO_SECTOR_KEY[yk];
        const raw = v && typeof v === "object" ? num(v.raw) : 0;
        if (key && raw > 0) sectors[key] = (sectors[key] ?? 0) + raw * 100;
      }
    }
    if (Object.keys(sectors).length > 0) return { sectors, source: "yahoo", fund: true };
  }
  const sectorText = r.assetProfile?.sector;
  if (sectorText) {
    const key = sectorFromProfileText(sectorText);
    if (key) return { sectors: { [key]: 100 }, source: "yahoo", fund: false };
  }
  return { none: true };
}

function quoteSummarySectors(env: Env, ticker: string): Promise<SectorLookup | { none: true } | null> {
  return memo(env, `qs:${ticker.toUpperCase()}`, () => fetchQuoteSummarySectors(env, ticker));
}

// ---------------------------------------------------------------------------
// Built-in approximate sector map — fallback when quoteSummary is blocked.
// Index-fund weights are APPROXIMATE (rough S&P 500 / total-market mixes as
// of 2025) and labeled as such in the API response.

const W_SP500: Weights = { tech: 33, financials: 13, cyclical: 10.5, comms: 9.5, health: 9.5, industrials: 8.5, defensive: 5.5, energy: 3, utilities: 2.5, realestate: 2, materials: 2 };
const W_TOTAL_US: Weights = { tech: 31.5, financials: 13.5, cyclical: 10.5, comms: 9, health: 10, industrials: 9, defensive: 5.5, energy: 3.5, utilities: 2.5, realestate: 2.5, materials: 2.5 };
const W_NDX: Weights = { tech: 50, comms: 15.5, cyclical: 13.5, defensive: 6, health: 6, industrials: 5, utilities: 1.5, materials: 1.5, energy: 0.5, financials: 0.5 };
const W_INTL: Weights = { financials: 21, industrials: 14, tech: 14, cyclical: 11, health: 9, defensive: 7, materials: 7, comms: 6, energy: 5, utilities: 3, realestate: 2 };
const W_BOND: Weights = { bonds: 100 };

interface BuiltinFund { w: Weights; index: string }
const FUND_MAP: Record<string, BuiltinFund> = {};
function reg(tickers: string[], w: Weights, index: string): void {
  for (const t of tickers) FUND_MAP[t] = { w, index };
}
reg(["FXAIX", "VOO", "SPY", "IVV", "VFIAX", "SWPPX", "SPLG", "VINIX", "FNILX"], W_SP500, "S&P 500 / US large cap");
reg(["VTI", "FSKAX", "FZROX", "SWTSX", "ITOT", "VTSAX"], W_TOTAL_US, "US total market");
reg(["QQQ", "QQQM"], W_NDX, "Nasdaq-100");
reg(["VXUS", "FTIHX", "FZILX", "IXUS", "FSPSX", "VEA", "VTIAX"], W_INTL, "International ex-US");
reg(["BND", "AGG", "FXNAX", "BNDX", "VBTLX", "FTBFX"], W_BOND, "US aggregate bond");
// Sector SPDRs map to their own sector outright.
for (const s of SECTOR_DEFS) FUND_MAP[s.etf] = { w: { [s.key]: 100 }, index: `${s.label} sector` };

const STOCK_SECTOR: Record<string, SectorKey> = {
  AAPL: "tech", MSFT: "tech", NVDA: "tech", AMD: "tech", INTC: "tech", CRM: "tech", ORCL: "tech", AVGO: "tech", PLTR: "tech", ADBE: "tech", CSCO: "tech", IBM: "tech",
  GOOGL: "comms", GOOG: "comms", META: "comms", NFLX: "comms", DIS: "comms", T: "comms", VZ: "comms",
  AMZN: "cyclical", TSLA: "cyclical", HD: "cyclical", NKE: "cyclical", SBUX: "cyclical", MCD: "cyclical", ABNB: "cyclical", F: "cyclical", GM: "cyclical",
  "BRK.B": "financials", BRKB: "financials", JPM: "financials", BAC: "financials", V: "financials", MA: "financials", GS: "financials", MS: "financials", SCHW: "financials", PYPL: "financials", SOFI: "financials",
  UNH: "health", JNJ: "health", LLY: "health", PFE: "health", ABBV: "health", MRK: "health", CVS: "health",
  XOM: "energy", CVX: "energy", COP: "energy", OXY: "energy",
  PG: "defensive", KO: "defensive", PEP: "defensive", COST: "defensive", WMT: "defensive", TGT: "defensive",
  BA: "industrials", CAT: "industrials", GE: "industrials", UPS: "industrials", RTX: "industrials", DE: "industrials",
  LIN: "materials", NEM: "materials", FCX: "materials",
  NEE: "utilities", DUK: "utilities", SO: "utilities",
  O: "realestate", PLD: "realestate", AMT: "realestate", SPG: "realestate",
};

// Name-based patterns feed ONLY the approximate sector-weight fallback (and
// are labeled "approx" in the response). They are never used to claim two
// funds track the same index; that claim comes from OVERLAP_GROUPS below.
const INDEX_PATTERNS: { re: RegExp; index: string; w: Weights }[] = [
  { re: /s\s*&\s*p\s*500|500\s+index/i, index: "S&P 500 / US large cap", w: W_SP500 },
  { re: /total\s+(stock\s+)?market/i, index: "US total market", w: W_TOTAL_US },
  { re: /nasdaq[\s-]*100/i, index: "Nasdaq-100", w: W_NDX },
  { re: /total\s+international|international\s+index|ex[\s-]*u\.?s/i, index: "International ex-US", w: W_INTL },
  { re: /total\s+bond|aggregate\s+bond|bond\s+index/i, index: "US aggregate bond", w: W_BOND },
];

const CASH_TICKERS = new Set(["SPAXX", "FDRXX", "FZFXX", "FCASH", "SPRXX", "FDLXX", "VMFXX", "VMRXX", "SWVXX", "SNVXX", "CORE"]);

/** Asset-type bucket used by the allocation donut. Exported for investments.ts. */
export function classifyType(
  stype: string | null, ticker: string | null, name: string | null, closePrice: number | null,
): "stocks" | "mutual_funds" | "etfs" | "cash" | "bonds" | "other" {
  const t = (stype ?? "").toLowerCase();
  const tick = (ticker ?? "").toUpperCase();
  const nm = name ?? "";
  if (t === "cash" || CASH_TICKERS.has(tick) || /money\s*market|cash\s+reserves/i.test(nm)) return "cash";
  if (ticker == null && closePrice === 1) return "cash";
  if (t === "fixed income") return "bonds";
  if (t === "etf") return "etfs";
  if (t === "mutual fund") return "mutual_funds";
  if (t === "equity" || t === "derivative") return "stocks";
  return "other";
}

// Strict allowlist for same-index overlap. Overlap is flagged ONLY when two
// or more actually-held tickers appear in the same group; never inferred from
// fund names (name matching misfires and produces false claims).
const OVERLAP_GROUPS: { index: string; tickers: Set<string> }[] = [
  { index: "S&P 500", tickers: new Set(["FXAIX", "VOO", "SPY", "IVV", "SPLG", "FNILX"]) },
  { index: "Total US market", tickers: new Set(["VTI", "ITOT", "SCHB", "FSKAX", "FZROX"]) },
  { index: "Nasdaq 100", tickers: new Set(["QQQ", "QQQM"]) },
  { index: "Total international", tickers: new Set(["VXUS", "IXUS", "FTIHX", "FZILX"]) },
];

function builtinSectors(ticker: string, name: string | null): SectorLookup | null {
  const fund = FUND_MAP[ticker];
  if (fund) return { sectors: fund.w, source: "approx", fund: true };
  if (name) {
    for (const p of INDEX_PATTERNS) if (p.re.test(name)) return { sectors: p.w, source: "approx", fund: true };
  }
  const stock = STOCK_SECTOR[ticker];
  if (stock) return { sectors: { [stock]: 100 }, source: "approx", fund: false };
  return null;
}

// ---------------------------------------------------------------------------
// Shared holdings view (scoped by ?account_id like /api/investments)

interface Holding {
  security_id: string;
  ticker: string | null;
  name: string | null;
  stype: string | null;
  close_price: number | null;
  quantity: number;
  value: number;
}

async function getHoldings(env: Env, accountId: string | null): Promise<Holding[]> {
  const binds: string[] = [];
  let filter = "";
  if (accountId) { filter = " AND h.account_id = ?"; binds.push(accountId); }
  const rows = await q<Holding>(
    env,
    `SELECT h.security_id, s.ticker, s.name, s.type AS stype, s.close_price,
            SUM(h.quantity) AS quantity, SUM(COALESCE(h.value, 0)) AS value
     FROM holdings h
     JOIN accounts a ON a.id = h.account_id
     LEFT JOIN securities s ON s.id = h.security_id
     WHERE a.hidden = 0${filter}
     GROUP BY h.security_id`,
    ...binds,
  );
  return rows.map((r) => ({ ...r, quantity: num(r.quantity), value: num(r.value) }));
}

const MAX_TICKER_FETCHES = 25;

/** Highest-value tickers first, so any fetch budget goes where it matters. */
function tickersByValue(holdings: Holding[]): string[] {
  const byTicker = new Map<string, number>();
  for (const h of holdings) {
    if (!h.ticker) continue;
    if (classifyType(h.stype, h.ticker, h.name, h.close_price) === "cash") continue;
    const t = h.ticker.toUpperCase();
    byTicker.set(t, (byTicker.get(t) ?? 0) + h.value);
  }
  return [...byTicker.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, MAX_TICKER_FETCHES);
}

// ---------------------------------------------------------------------------
// Sector exposure + concentration

interface SectorExposure {
  sectors: { key: string; label: string; pct: number; benchmarkPct: number | null; diff: number | null }[];
  holdingSectors: Record<string, { source: string; fund: boolean; sectors: { key: string; label: string; pct: number }[] }>;
  approxTickers: string[];
  unmapped: { ticker: string | null; name: string | null; pct: number }[];
  total: number;
}

async function computeSectorExposure(env: Env, holdings: Holding[]): Promise<SectorExposure> {
  const total = holdings.reduce((s, h) => s + h.value, 0);
  const exposure = new Map<string, number>();
  const holdingSectors: SectorExposure["holdingSectors"] = {};
  const approxTickers: string[] = [];
  const unmapped: SectorExposure["unmapped"] = [];

  // Resolve per-ticker lookups concurrently (each is cache-first).
  const wanted = tickersByValue(holdings);
  const lookups = new Map<string, SectorLookup | null>();
  const results = await Promise.all(wanted.map(async (t) => {
    const qs = await quoteSummarySectors(env, t);
    if (qs && !("none" in qs)) return [t, qs] as const;
    return [t, builtinSectors(t, holdings.find((h) => (h.ticker ?? "").toUpperCase() === t)?.name ?? null)] as const;
  }));
  for (const [t, lk] of results) lookups.set(t, lk);

  for (const h of holdings) {
    if (!(h.value > 0)) continue;
    const w = total > 0 ? (h.value / total) * 100 : 0;
    const cls = classifyType(h.stype, h.ticker, h.name, h.close_price);
    if (cls === "cash") { exposure.set("cash", (exposure.get("cash") ?? 0) + w); continue; }
    const t = (h.ticker ?? "").toUpperCase();
    const lookup = t ? lookups.get(t) ?? null : null;
    if (lookup) {
      const sum = Object.values(lookup.sectors).reduce((a, b) => a + num(b), 0) || 1;
      for (const [key, pct] of Object.entries(lookup.sectors)) {
        exposure.set(key, (exposure.get(key) ?? 0) + (w * num(pct)) / sum);
      }
      if (t && !holdingSectors[t]) {
        holdingSectors[t] = {
          source: lookup.source,
          fund: lookup.fund,
          sectors: Object.entries(lookup.sectors)
            .map(([key, pct]) => ({ key, label: SECTOR_LABEL[key] ?? key, pct: round2((num(pct) / sum) * 100) }))
            .sort((a, b) => b.pct - a.pct)
            .slice(0, 5),
        };
      }
      if (lookup.source === "approx" && t && !approxTickers.includes(t)) approxTickers.push(t);
    } else if (cls === "bonds") {
      exposure.set("bonds", (exposure.get("bonds") ?? 0) + w);
    } else {
      unmapped.push({ ticker: h.ticker, name: h.name, pct: round2(w) });
    }
  }

  const spxTotal = SECTOR_DEFS.reduce((s, d) => s + d.spx, 0);
  const sectors = [
    ...SECTOR_DEFS.map((d) => ({
      key: d.key as string,
      label: d.label,
      pct: round2(exposure.get(d.key) ?? 0),
      benchmarkPct: round2((d.spx / spxTotal) * 100),
    })),
    { key: "bonds", label: SECTOR_LABEL.bonds, pct: round2(exposure.get("bonds") ?? 0), benchmarkPct: null },
    { key: "cash", label: SECTOR_LABEL.cash, pct: round2(exposure.get("cash") ?? 0), benchmarkPct: null },
  ]
    .filter((s) => s.pct > 0 || s.benchmarkPct !== null)
    .map((s) => ({ ...s, diff: s.benchmarkPct === null ? null : round2(s.pct - s.benchmarkPct) }))
    .sort((a, b) => b.pct - a.pct);

  return { sectors, holdingSectors, approxTickers, unmapped, total };
}

interface Concentration {
  stats: { id: string; label: string; value: string; detail: string; status?: "pass" | "check" }[];
  // Sentence-style notes were removed from the UI; kept as an empty array so
  // the response shape stays backward compatible.
  notes: never[];
  overlaps: { index: string; tickers: string[]; combinedPct: number }[];
}

function computeConcentration(holdings: Holding[], exposure: SectorExposure): Concentration {
  const total = holdings.reduce((s, h) => s + h.value, 0);
  const stats: Concentration["stats"] = [];
  const overlaps: Concentration["overlaps"] = [];
  if (!(total > 0)) return { stats, notes: [], overlaps };

  const label = (h: Holding): string => (h.ticker ?? h.name ?? "?").toUpperCase();
  const isCash = (h: Holding): boolean => classifyType(h.stype, h.ticker, h.name, h.close_price) === "cash";
  const invested = holdings.filter((h) => h.value > 0 && !isCash(h)).sort((a, b) => b.value - a.value);
  const cashValue = holdings.filter((h) => h.value > 0 && isCash(h)).reduce((s, h) => s + h.value, 0);

  if (invested.length > 0) {
    const top = invested[0];
    const topPct = (top.value / total) * 100;
    const top3Pct = invested.slice(0, 3).reduce((s, h) => s + h.value, 0) / total * 100;
    // A big weight in one diversified fund is fine; in one single stock it isn't.
    const topIsFund = FUND_MAP[label(top)] !== undefined ||
      classifyType(top.stype, top.ticker, top.name, top.close_price) !== "stocks";
    stats.push({
      id: "top", label: "Top holding", value: `${Math.round(topPct)}%`,
      detail: label(top),
      status: topPct > 40 && !topIsFund ? "check" : "pass",
    });
    stats.push({
      id: "top3", label: "Top 3 holdings", value: `${Math.round(top3Pct)}%`,
      detail: invested.slice(0, 3).map(label).join(" + "),
    });

    // Effective number of holdings: 1 / sum(w^2) over invested (non-cash) positions.
    const investedTotal = invested.reduce((s, h) => s + h.value, 0);
    const hhi = invested.reduce((s, h) => { const w = h.value / investedTotal; return s + w * w; }, 0);
    const effective = hhi > 0 ? 1 / hhi : 0;
    stats.push({
      id: "effective", label: "Effective holdings", value: effective.toFixed(1),
      detail: `${invested.length} position${invested.length === 1 ? "" : "s"}`,
      status: effective < 2 && invested.length > 2 ? "check" : "pass",
    });
  }

  const topSector = exposure.sectors.filter((s) => s.benchmarkPct !== null).sort((a, b) => b.pct - a.pct)[0];
  if (topSector && topSector.pct > 0) {
    stats.push({
      id: "sector", label: "Largest sector", value: `${Math.round(topSector.pct)}%`,
      detail: topSector.label,
      status: topSector.pct > 40 ? "check" : "pass",
    });
  }

  const cashPct = (cashValue / total) * 100;
  stats.push({
    id: "cash", label: "Cash drag", value: `${Math.round(cashPct)}%`,
    detail: "uninvested",
    status: cashPct > 10 ? "check" : "pass",
  });

  // Same-index overlap: allowlist only, held tickers only.
  for (const g of OVERLAP_GROUPS) {
    const held = invested.filter((h) => g.tickers.has(label(h)));
    const tickers = [...new Set(held.map(label))];
    if (tickers.length < 2) continue;
    const value = held.reduce((s, h) => s + h.value, 0);
    overlaps.push({ index: g.index, tickers, combinedPct: round2((value / total) * 100) });
  }

  return { stats, notes: [], overlaps };
}

// ---------------------------------------------------------------------------
// Returns math

function returnOver(series: PriceSeries, daysBack: number): number | null {
  const n = series.dates.length;
  if (n < 2) return null;
  const last = series.closes[n - 1];
  const floor = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  // First close at-or-after the floor date; require reasonable coverage.
  let i = 0;
  while (i < n && series.dates[i] < floor) i++;
  if (i >= n - 1) return null;
  // If the series starts long after the floor, the window is short — for the
  // 1Y case demand at least ~10 months of data.
  if (daysBack >= 300 && i === 0 && series.dates[0] > new Date(Date.now() - 300 * 86400_000).toISOString().slice(0, 10)) return null;
  const base = series.closes[i];
  if (!(base > 0)) return null;
  return round2(((last - base) / base) * 100);
}

function lastDayReturn(series: PriceSeries): number | null {
  const n = series.dates.length;
  if (n < 2) return null;
  const a = series.closes[n - 2], b = series.closes[n - 1];
  if (!(a > 0)) return null;
  return round2(((b - a) / a) * 100);
}

// ---------------------------------------------------------------------------
// Router

export const market = new Hono<{ Bindings: Env }>();

market.get("/sectors", async (c) => {
  const accountId = c.req.query("account_id") || null;
  const holdings = await getHoldings(c.env, accountId);
  if (holdings.length === 0) {
    return c.json({
      sectors: [], holdingSectors: {}, approxTickers: [], unmapped: [],
      concentration: { stats: [], notes: [], overlaps: [] },
      source: "none",
    });
  }
  const exposure = await computeSectorExposure(c.env, holdings);
  const concentration = computeConcentration(holdings, exposure);
  const sources = new Set(Object.values(exposure.holdingSectors).map((h) => h.source));
  const source = sources.has("yahoo") ? (sources.has("approx") ? "mixed" : "yahoo") : (sources.size > 0 ? "builtin" : "none");
  return c.json({
    sectors: exposure.sectors,
    holdingSectors: exposure.holdingSectors,
    approxTickers: exposure.approxTickers,
    unmapped: exposure.unmapped,
    concentration,
    source,
  });
});

market.get("/pulse", async (c) => {
  const accountId = c.req.query("account_id") || null;
  const holdings = await getHoldings(c.env, accountId);
  const exposure = holdings.length > 0 ? await computeSectorExposure(c.env, holdings) : null;
  const userPct = new Map<string, number>();
  if (exposure) for (const s of exposure.sectors) userPct.set(s.key, s.pct);

  const symbols = [...SECTOR_DEFS.map((s) => s.etf), "SPY"];
  const series = await Promise.all(symbols.map((sym) => chart(c.env, sym)));
  const bySym = new Map<string, PriceSeries | null>();
  symbols.forEach((sym, i) => bySym.set(sym, series[i]));

  const spySeries = bySym.get("SPY");
  const spy = spySeries
    ? { r1m: returnOver(spySeries, 31), r3m: returnOver(spySeries, 92), r1y: returnOver(spySeries, 366) }
    : null;

  const spxTotal = SECTOR_DEFS.reduce((s, d) => s + d.spx, 0);
  const rows = SECTOR_DEFS.map((d) => {
    const s = bySym.get(d.etf);
    const pct = userPct.get(d.key) ?? 0;
    const benchmarkPct = round2((d.spx / spxTotal) * 100);
    const diff = pct - benchmarkPct;
    return {
      key: d.key,
      label: d.label,
      ticker: d.etf,
      r1m: s ? returnOver(s, 31) : null,
      r3m: s ? returnOver(s, 92) : null,
      r1y: s ? returnOver(s, 366) : null,
      userPct: round2(pct),
      benchmarkPct,
      stance: exposure === null ? null : diff > 4 ? "over" : diff < -4 ? "under" : "inline",
    };
  }).sort((a, b) => (b.r3m ?? -Infinity) - (a.r3m ?? -Infinity));

  const missing = rows.filter((r) => r.r3m === null && r.r1y === null).map((r) => r.ticker);
  return c.json({
    rows, spy,
    missing,
    benchmarkNote: "Yahoo data, cached daily. Not advice.",
  });
});

market.get("/performance", async (c) => {
  const accountId = c.req.query("account_id") || null;
  const holdings = await getHoldings(c.env, accountId);
  const tickers = tickersByValue(holdings);
  const [spySeries, ...holdingSeries] = await Promise.all([
    chart(c.env, "SPY"),
    ...tickers.map((t) => chart(c.env, t)),
  ]);

  const returns: Record<string, { r1d: number | null; r1m: number | null; r1y: number | null }> = {};
  const unpriced: string[] = [];
  tickers.forEach((t, i) => {
    const s = holdingSeries[i];
    if (!s) { unpriced.push(t); return; }
    returns[t] = { r1d: lastDayReturn(s), r1m: returnOver(s, 31), r1y: returnOver(s, 366) };
  });

  let best: { ticker: string; r1y: number } | null = null;
  let worst: { ticker: string; r1y: number } | null = null;
  for (const [t, r] of Object.entries(returns)) {
    if (r.r1y === null) continue;
    if (!best || r.r1y > best.r1y) best = { ticker: t, r1y: r.r1y };
    if (!worst || r.r1y < worst.r1y) worst = { ticker: t, r1y: r.r1y };
  }

  const spy = spySeries
    ? spySeries.dates.map((date, i) => ({ date, close: spySeries.closes[i] }))
    : [];

  return c.json({ spy, returns, best, worst, unpriced });
});
