// GET /api/investments — portfolio, holdings, allocation, checks, retirement.
// Supports ?account_id= to scope portfolio value/series, holdings, allocation,
// and dayChange to one investment account. Checks and retirement stay global.
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, num, round2, daysAgoStr, getSettings, SPEND_COND } from "./util";
import { classifyType } from "./market";

interface HoldingRow {
  account_id: string;
  account_name: string;
  security_id: string;
  ticker: string | null;
  sname: string | null;
  stype: string | null;
  quantity: number;
  cost_basis: number | null;
  value: number | null;
  as_of: string | null;
  close_price: number | null;
  close_price_as_of: string | null;
}

interface AggHolding {
  ticker: string;
  name: string;
  typeClass: string;
  quantity: number;
  value: number;
  costBasis: number | null;
  gain: number | null;
  gainPct: number | null;
  weight: number;
  heldSince: string | null; // earliest 'buy' date from investment_transactions
  accounts: { account_id: string; name: string; quantity: number; value: number }[];
}

const ROTH_LIMIT_DEFAULT = 7500;

const TYPE_LABEL: Record<string, string> = {
  stocks: "Stocks",
  mutual_funds: "Mutual funds",
  etfs: "ETFs",
  cash: "Cash",
  bonds: "Bonds",
  other: "Other",
};

// "none" = the check has no data to evaluate yet (rendered neutral, not a pass).
type CheckStatus = "pass" | "check" | "none";

function allocClass(stype: string | null): "stocks" | "bonds" | "cash" | "other" {
  const t = (stype ?? "").toLowerCase();
  if (t === "equity" || t === "etf" || t === "mutual fund") return "stocks";
  if (t === "fixed income") return "bonds";
  if (t === "cash") return "cash";
  return "other";
}

/** Aggregate raw holding rows by security into display holdings + allocation. */
function aggregate(rows: HoldingRow[], heldSince?: Map<string, string>): {
  holdings: AggHolding[];
  allocation: { class: string; value: number; pct: number }[];
  allocationByType: { class: string; label: string; value: number; pct: number }[];
  total: number;
} {
  const total = rows.reduce((s, h) => s + num(h.value), 0);
  const bySecurity = new Map<string, AggHolding & { hasCostBasis: boolean }>();
  for (const h of rows) {
    let agg = bySecurity.get(h.security_id);
    if (!agg) {
      agg = {
        ticker: h.ticker ?? "",
        name: h.sname ?? h.ticker ?? "Unknown security",
        typeClass: classifyType(h.stype, h.ticker, h.sname, h.close_price),
        quantity: 0,
        value: 0,
        costBasis: 0,
        gain: null,
        gainPct: null,
        weight: 0,
        heldSince: null,
        accounts: [],
        hasCostBasis: false,
      };
      bySecurity.set(h.security_id, agg);
    }
    agg.quantity += num(h.quantity);
    agg.value += num(h.value);
    if (h.cost_basis != null) {
      agg.costBasis = num(agg.costBasis) + num(h.cost_basis);
      agg.hasCostBasis = true;
    }
    agg.accounts.push({
      account_id: h.account_id,
      name: h.account_name,
      quantity: round2(num(h.quantity)),
      value: round2(num(h.value)),
    });
  }
  const holdings: AggHolding[] = [...bySecurity.entries()]
    .map(([securityId, agg]) => {
      const value = round2(agg.value);
      const costBasis = agg.hasCostBasis ? round2(num(agg.costBasis)) : null;
      const gain = costBasis != null ? round2(value - costBasis) : null;
      const gainPct = costBasis != null && costBasis > 0 && gain != null ? round2((gain / costBasis) * 100) : null;
      return {
        ticker: agg.ticker,
        name: agg.name,
        typeClass: agg.typeClass,
        quantity: round2(agg.quantity),
        value,
        costBasis,
        gain,
        gainPct,
        weight: total > 0 ? round2((agg.value / total) * 100) / 100 : 0,
        heldSince: heldSince?.get(securityId) ?? null,
        accounts: agg.accounts,
      };
    })
    .sort((a, b) => b.value - a.value);

  const allocTotals = new Map<string, number>();
  for (const h of rows) {
    const cls = allocClass(h.stype);
    allocTotals.set(cls, (allocTotals.get(cls) ?? 0) + num(h.value));
  }
  const allocation = (["stocks", "bonds", "cash", "other"] as const)
    .filter((cls) => (allocTotals.get(cls) ?? 0) > 0)
    .map((cls) => ({
      class: cls,
      value: round2(allocTotals.get(cls) ?? 0),
      pct: total > 0 ? round2(((allocTotals.get(cls) ?? 0) / total) * 100) : 0,
    }));

  // Finer-grained allocation by security type (donut with drill-down).
  const typeTotals = new Map<string, number>();
  for (const h of holdings) {
    typeTotals.set(h.typeClass, (typeTotals.get(h.typeClass) ?? 0) + h.value);
  }
  const allocationByType = (["stocks", "mutual_funds", "etfs", "cash", "bonds", "other"] as const)
    .filter((cls) => (typeTotals.get(cls) ?? 0) > 0)
    .map((cls) => ({
      class: cls,
      label: TYPE_LABEL[cls] ?? cls,
      value: round2(typeTotals.get(cls) ?? 0),
      pct: total > 0 ? round2(((typeTotals.get(cls) ?? 0) / total) * 100) : 0,
    }));

  return { holdings, allocation, allocationByType, total };
}

export const investments = new Hono<{ Bindings: Env }>();

investments.get("/", async (c) => {
  const env = c.env;
  const accountId = c.req.query("account_id") || null;

  // Accounts list is always global (the UI uses it for the filter chips).
  const accts = await q<{ id: string; name: string; subtype: string | null; value: number | null }>(
    env,
    `SELECT id, name, subtype, current_balance AS value
     FROM accounts WHERE type = 'investment' AND hidden = 0
     ORDER BY name`,
  );
  const accounts = accts.map((a) => ({ id: a.id, name: a.name, subtype: a.subtype, value: round2(num(a.value)) }));
  const portfolioValue = accountId
    ? round2(accounts.filter((a) => a.id === accountId).reduce((s, a) => s + a.value, 0))
    : round2(accounts.reduce((s, a) => s + a.value, 0));

  // Series from balance snapshots of investment accounts (scoped when filtered).
  const seriesBinds: string[] = [];
  let seriesFilter = "";
  if (accountId) {
    seriesFilter = " AND s.account_id = ?";
    seriesBinds.push(accountId);
  }
  const series = await q<{ date: string; value: number }>(
    env,
    `SELECT s.date AS date, ROUND(SUM(s.balance), 2) AS value
     FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id
     WHERE a.type = 'investment' AND a.hidden = 0${seriesFilter}
     GROUP BY s.date ORDER BY s.date`,
    ...seriesBinds,
  );
  const dayChange =
    series.length >= 2
      ? round2(series[series.length - 1]!.value - series[series.length - 2]!.value)
      : 0;

  // All holding rows (global — checks always run over the whole portfolio),
  // then scoped rows for the displayed holdings/allocation.
  const hrows = await q<HoldingRow>(
    env,
    `SELECT h.account_id, a.name AS account_name, h.security_id,
            s.ticker AS ticker, s.name AS sname, s.type AS stype,
            h.quantity, h.cost_basis, h.value, h.as_of, s.close_price, s.close_price_as_of
     FROM holdings h
     JOIN accounts a ON a.id = h.account_id
     LEFT JOIN securities s ON s.id = h.security_id
     WHERE a.hidden = 0`,
  );
  // Earliest 'buy' date per security (null-safe: securities with no recorded
  // buy history simply have no entry). Scoped to the account filter.
  const heldBinds: string[] = [];
  let heldFilter = "";
  if (accountId) {
    heldFilter = " AND account_id = ?";
    heldBinds.push(accountId);
  }
  const heldRows = await q<{ security_id: string; first_buy: string }>(
    env,
    `SELECT security_id, MIN(date) AS first_buy
     FROM investment_transactions
     WHERE type = 'buy' AND security_id IS NOT NULL${heldFilter}
     GROUP BY security_id`,
    ...heldBinds,
  );
  const heldSince = new Map(heldRows.map((r) => [r.security_id, r.first_buy]));

  const scoped = accountId ? hrows.filter((h) => h.account_id === accountId) : hrows;
  const { holdings, allocation, allocationByType } = aggregate(scoped, heldSince);
  const globalHoldings = accountId ? aggregate(hrows).holdings : holdings;

  // Prices are Plaid end-of-day closes; surface the freshest date we have.
  let pricesAsOf: string | null = null;
  for (const h of scoped) {
    for (const d of [h.close_price_as_of, h.as_of]) {
      const day = d ? d.slice(0, 10) : null;
      if (day && (!pricesAsOf || day > pricesAsOf)) pricesAsOf = day;
    }
  }

  // Portfolio checks (always global).
  const checks: { id: string; label: string; detail: string; status: CheckStatus }[] = [];
  checks.push({
    id: "fees",
    label: "Fee drag",
    detail: "No fee data.",
    status: "none",
  });
  const top = globalHoldings[0];
  if (top && top.weight > 0.4) {
    checks.push({
      id: "concentration",
      label: "Concentration",
      detail: `${top.ticker || top.name} ${Math.round(top.weight * 100)}% of portfolio. Threshold 40%.`,
      status: "check",
    });
  } else {
    checks.push({
      id: "concentration",
      label: "Concentration",
      detail: "Largest holding under 40%.",
      status: "pass",
    });
  }
  const cashRow = await first<{ v: number | null }>(
    env,
    "SELECT SUM(COALESCE(current_balance, 0)) AS v FROM accounts WHERE type = 'depository' AND hidden = 0",
  );
  const cashTotal = round2(num(cashRow ? cashRow.v : 0));
  const spend90 = await first<{ v: number | null }>(
    env,
    `SELECT SUM(t.amount) AS v
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND ${SPEND_COND}`,
    daysAgoStr(90),
  );
  const avgMonthlySpend = round2(num(spend90 ? spend90.v : 0) / 3);
  if (avgMonthlySpend > 0) {
    const monthsCovered = round2(cashTotal / avgMonthlySpend);
    checks.push({
      id: "emergency_fund",
      label: "Emergency fund",
      detail: `${monthsCovered.toFixed(1)} months of spending in cash. Target 3.`,
      status: monthsCovered >= 3 ? "pass" : "check",
    });
  } else {
    checks.push({
      id: "emergency_fund",
      label: "Emergency fund",
      detail: "Not enough spending history yet.",
      status: "none",
    });
  }
  // Allocation drift against the user's targets (Settings, JSON by type class).
  const settings = await getSettings(env);
  let targetAllocation: Record<string, number> | null = null;
  try {
    const p = settings["target_allocation"] ? JSON.parse(settings["target_allocation"]) : null;
    if (p && typeof p === "object") {
      targetAllocation = {};
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) if (typeof v === "number" && v >= 0) targetAllocation[k] = v;
      if (Object.keys(targetAllocation).length === 0) targetAllocation = null;
    }
  } catch { targetAllocation = null; }
  if (targetAllocation) {
    const globalAlloc = aggregate(hrows).allocationByType;
    let worst: { label: string; diff: number } | null = null;
    for (const a of globalAlloc) {
      const target = targetAllocation[a.class] ?? 0;
      const diff = a.pct - target;
      if (!worst || Math.abs(diff) > Math.abs(worst.diff)) worst = { label: a.label, diff };
    }
    for (const [cls, target] of Object.entries(targetAllocation)) {
      if (!globalAlloc.some((a) => a.class === cls) && target > 0) {
        const label = cls.replace("_", " ");
        if (!worst || target > Math.abs(worst.diff)) worst = { label, diff: -target };
      }
    }
    const off = worst ? Math.abs(worst.diff) : 0;
    checks.push({
      id: "drift",
      label: "Allocation drift",
      detail: worst ? `${worst.label} is ${Math.round(off)} pts ${worst.diff > 0 ? "over" : "under"} target.` : "On target.",
      status: off > 5 ? "check" : "pass",
    });
  } else {
    checks.push({ id: "drift", label: "Allocation drift", detail: "No targets set. Use Targets in the allocation card.", status: "none" });
  }

  // Retirement from settings (always global).
  // 2026 IRS limit (under 50) is $7,500. A missing value, or the old $7,000
  // default that earlier builds seeded, both resolve to the current limit;
  // anything else is the user's own override.
  const rothLimitRaw = num(settings["roth_contribution_limit"], 0);
  const rothLimit = rothLimitRaw > 0 && rothLimitRaw !== 7000 ? rothLimitRaw : ROTH_LIMIT_DEFAULT;
  const rothContributed = num(settings["roth_contributed_ytd"], 0);
  // Contributions for tax year Y are accepted until Apr 15 of Y+1.
  const taxYear = new Date().getUTCFullYear();
  const deadline = `${taxYear + 1}-04-15`;
  const daysToDeadline = Math.max(0, Math.ceil((Date.parse(deadline + "T00:00:00Z") - Date.now()) / 86400_000));
  const hasRoth = accounts.some((a) => /roth/i.test(`${a.subtype ?? ""} ${a.name}`));
  const rothAuto = await first<{ v: number | null }>(
    env,
    `SELECT SUM(-t.amount) AS v FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE (LOWER(a.subtype) = 'roth' OR a.name LIKE '%ROTH%') AND t.date >= ?1
       AND t.type IN ('cash', 'transfer') AND t.subtype IN ('contribution', 'deposit', 'transfer')
       AND (t.name IS NULL OR t.name NOT LIKE '%DISTRIBUTION%')`,
    `${taxYear}-01-01`,
  );
  const roth = !hasRoth && rothContributed <= 0 ? null : {
    limit: round2(rothLimit),
    contributed: round2(rothContributed),
    // What the linked Roth account(s) actually received this year, for the "use this" hint.
    autoContributed: round2(Math.max(0, num(rothAuto?.v))),
    room: round2(Math.max(0, rothLimit - rothContributed)),
    taxYear,
    deadline,
    daysToDeadline,
  };

  let inheritedIra: {
    yearOfDeath: number;
    year: number;
    of: number;
    suggested: number;
    taken: number;
    accountId: string | null;
    accountName: string | null;
    currentValue: number | null;
    basis: "current" | "starting";
    remainingYears: number;
    deadline: string;
    note: string;
  } | null = null;
  const yodRaw = settings["inherited_ira_year_of_death"] ?? "";
  const yod = Math.floor(num(yodRaw, 0));
  if (yodRaw.trim() !== "" && yod > 1900) {
    const currentYear = new Date().getUTCFullYear();
    const year = Math.min(10, Math.max(1, currentYear - yod));
    // The 10-year window closes Dec 31 of the tenth year after death.
    const deadline = `${yod + 10}-12-31`;
    const remainingYears = Math.max(1, yod + 10 - currentYear + 1);
    // Suggested draw = what is actually in the inherited account today, spread
    // over the years left in the window. The account is the non-Roth IRA whose
    // name carries Fidelity's "BDA" (beneficiary distribution account) marker,
    // else the only non-Roth IRA. Falls back to the starting balance from
    // Settings when the account is unknown or reports no value.
    const iraAccts = accounts.filter((a) => (a.subtype ?? "").toLowerCase() === "ira");
    const iraAcct = iraAccts.find((a) => /\bBDA\b/i.test(a.name)) ?? (iraAccts.length === 1 ? iraAccts[0] : null) ?? null;
    const currentValue = iraAcct ? round2(iraAcct.value) : null;
    const starting = num(settings["inherited_ira_starting_balance"], 0);
    const basis: "current" | "starting" = currentValue != null && currentValue > 0 ? "current" : "starting";
    const base = basis === "current" ? (currentValue as number) : starting;
    const suggested = round2(base / remainingYears);
    const taken = round2(num(settings["inherited_ira_taken_ytd"], 0));
    inheritedIra = {
      yearOfDeath: yod,
      year,
      of: 10,
      suggested,
      taken,
      accountId: iraAcct ? iraAcct.id : null,
      accountName: iraAcct ? iraAcct.name : null,
      currentValue,
      basis,
      remainingYears,
      deadline,
      note: "Straight line over the years left in the 10 year window. Annual RMDs may also apply under post-2024 rules.",
    };
  }

  // External cash flows in and out of the (scoped) investment accounts, so the
  // hero can split a window's value change into contributions vs market gain.
  // Plaid signs cash rows from the account's view: deposits are negative.
  // Fund distributions land as 'deposit' rows too; those are not new money.
  const flowBinds: string[] = [];
  let flowFilter = "";
  if (accountId) {
    flowFilter = " AND t.account_id = ?";
    flowBinds.push(accountId);
  }
  const flowRows = await q<{ date: string; amount: number | null }>(
    env,
    `SELECT t.date, SUM(-t.amount) AS amount
     FROM investment_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.type = 'investment' AND a.hidden = 0
       AND t.type IN ('cash', 'transfer')
       AND t.subtype IN ('contribution', 'deposit', 'withdrawal', 'transfer')
       AND (t.name IS NULL OR t.name NOT LIKE '%DISTRIBUTION%')${flowFilter}
     GROUP BY t.date ORDER BY t.date`,
    ...flowBinds,
  );
  const contributions = flowRows
    .map((r) => ({ date: r.date, amount: round2(num(r.amount)) }))
    .filter((r) => r.amount !== 0);

  // Claude-written analysis, stored in settings as a JSON string under
  // `invest_analysis` (written via PUT /api/settings). Null when absent or
  // unparseable; the frontend then shows a how-to-generate line.
  let analysis: { written_at: string; headline: string; bullets: string[]; model: string } | null = null;
  const rawAnalysis = settings["invest_analysis"];
  if (rawAnalysis && rawAnalysis.trim() !== "") {
    try {
      const p = JSON.parse(rawAnalysis) as Record<string, unknown>;
      if (p && typeof p === "object" && typeof p.headline === "string" && Array.isArray(p.bullets)) {
        analysis = {
          written_at: typeof p.written_at === "string" ? p.written_at : "",
          headline: p.headline,
          bullets: p.bullets.filter((b): b is string => typeof b === "string"),
          model: typeof p.model === "string" ? p.model : "claude",
        };
      }
    } catch {
      analysis = null;
    }
  }

  return c.json({
    analysis,
    portfolio: { value: portfolioValue, dayChange, series },
    pricesAsOf,
    accounts,
    holdings,
    allocation,
    allocationByType,
    checks,
    contributions,
    targetAllocation,
    retirement: { roth, inheritedIra },
  });
});
