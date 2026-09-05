// GET /api/cashflow?month=YYYY-MM  |  ?range=ytd|1y
// Income vs spending, monthly history bars, sankey data.
import { Hono } from "hono";
import type { Env } from "../types";
import {
  q,
  num,
  round2,
  bad,
  isMonth,
  currentMonth,
  addMonths,
  monthStart,
  monthEndExcl,
  SPEND_COND,
  INCOME_COND,
} from "./util";

// Income/spending predicates are the shared ones from util.ts so cashflow and
// overview always agree on what counts as income and as spending.
const CF_SPEND = SPEND_COND;
const CF_INCOME = INCOME_COND;

// Beyond this many spending categories, the smallest are folded into "Other"
// so the sankey stays legible.
const MAX_SANKEY_SPEND_NODES = 9;

interface SankeyNode {
  id: string;
  label: string;
  value: number;
  kind: "income" | "hub" | "spend" | "saved";
  color?: string | null; // category color token (spend nodes)
}

interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export const cashflow = new Hono<{ Bindings: Env }>();

cashflow.get("/", async (c) => {
  const rangeParam = c.req.query("range");
  let range: "ytd" | "1y" | null = null;
  if (rangeParam !== undefined) {
    if (rangeParam !== "ytd" && rangeParam !== "1y") return bad(c, "range must be ytd or 1y");
    range = rangeParam;
  }

  // Anchor month: the viewed month (month mode) or the current month (ranges).
  const month = range ? currentMonth() : (c.req.query("month") ?? currentMonth());
  if (!isMonth(month)) return bad(c, "month must be YYYY-MM");

  // Months whose transactions feed the aggregates (income/spending/sankey).
  let aggMonths: string[];
  if (range === "ytd") {
    aggMonths = [];
    const jan = month.slice(0, 4) + "-01";
    for (let m = jan; m <= month; m = addMonths(m, 1)) aggMonths.push(m);
  } else if (range === "1y") {
    aggMonths = [];
    for (let i = 11; i >= 0; i--) aggMonths.push(addMonths(month, -i));
  } else {
    aggMonths = [month];
  }
  const from = monthStart(aggMonths[0]);
  const to = monthEndExcl(aggMonths[aggMonths.length - 1]);

  const incomeRows = await q<{ category_id: number | null; category: string; color: string | null; amount: number | null }>(
    c.env,
    `SELECT c.id AS category_id, COALESCE(c.name, 'Other income') AS category, c.color AS color,
            ROUND(SUM(-t.amount), 2) AS amount
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND t.date < ? AND ${CF_INCOME}
     GROUP BY COALESCE(c.name, 'Other income')
     ORDER BY amount DESC`,
    from,
    to,
  );
  const income = incomeRows.map((r) => ({
    category_id: r.category_id,
    category: r.category,
    color: r.color,
    amount: round2(num(r.amount)),
  }));

  const spendingRows = await q<{ category_id: number | null; name: string | null; color: string | null; amount: number | null }>(
    c.env,
    `SELECT t.category_id AS category_id, c.name AS name, c.color AS color, ROUND(SUM(t.amount), 2) AS amount
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND t.date < ? AND ${CF_SPEND}
     GROUP BY t.category_id
     ORDER BY amount DESC`,
    from,
    to,
  );
  const spending = spendingRows.map((r) => ({
    category_id: r.category_id,
    name: r.name ?? "Uncategorized",
    color: r.color,
    amount: round2(num(r.amount)),
  }));

  const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
  const totalSpending = round2(spending.reduce((s, r) => s + r.amount, 0));
  const saved = round2(totalIncome - totalSpending);
  const savingsRate = totalIncome > 0 ? round2(saved / totalIncome) : 0;

  // Bar months: for a range, every month in the range; for a single month,
  // the last 6 calendar months ending at it. Zero-filled either way.
  const barMonths = range
    ? aggMonths
    : Array.from({ length: 6 }, (_, i) => addMonths(month, i - 5));
  const histFrom = monthStart(barMonths[0]);
  const histTo = monthEndExcl(barMonths[barMonths.length - 1]);
  const hist = await q<{ m: string; income: number | null; spending: number | null }>(
    c.env,
    `SELECT substr(t.date, 1, 7) AS m,
            ROUND(SUM(CASE WHEN ${CF_INCOME} THEN -t.amount ELSE 0 END), 2) AS income,
            ROUND(SUM(CASE WHEN ${CF_SPEND} THEN t.amount ELSE 0 END), 2) AS spending
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND t.date < ?
     GROUP BY m ORDER BY m`,
    histFrom,
    histTo,
  );
  const histMap = new Map<string, { income: number; spending: number }>();
  for (const h of hist) histMap.set(h.m, { income: round2(num(h.income)), spending: round2(num(h.spending)) });
  const months = barMonths.map((m) => {
    const v = histMap.get(m);
    return { month: m, income: v ? v.income : 0, spending: v ? v.spending : 0 };
  });

  // Sankey: income categories -> hub (Checking) -> spending categories (+ saved).
  // Smallest spending categories fold into "Other" past MAX_SANKEY_SPEND_NODES.
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const hubValue = round2(Math.max(totalIncome, totalSpending));
  nodes.push({ id: "hub", label: "Checking", value: hubValue, kind: "hub" });
  for (const r of income) {
    if (r.amount <= 0) continue;
    const id = `in:${r.category}`;
    nodes.push({ id, label: r.category, value: r.amount, kind: "income" });
    links.push({ source: id, target: "hub", value: r.amount });
  }
  const positiveSpend = spending.filter((r) => r.amount > 0);
  let sankeySpend: { id: string; label: string; amount: number; color: string | null }[] =
    positiveSpend.map((r) => ({
      id: `cat:${r.category_id ?? "none"}`,
      label: r.name,
      amount: r.amount,
      color: r.color,
    }));
  if (sankeySpend.length > MAX_SANKEY_SPEND_NODES) {
    const keep = sankeySpend.slice(0, MAX_SANKEY_SPEND_NODES - 1);
    const rest = sankeySpend.slice(MAX_SANKEY_SPEND_NODES - 1);
    const restTotal = round2(rest.reduce((s, r) => s + r.amount, 0));
    // Always a distinct node: folding into the real "Other" category made the
    // node total disagree with that category's own drill-down.
    {
      keep.push({ id: "cat:grouped-other", label: `${rest.length} more categories`, amount: restTotal, color: null });
    }
    sankeySpend = keep;
  }
  for (const r of sankeySpend) {
    nodes.push({ id: r.id, label: r.label, value: r.amount, kind: "spend", color: r.color });
    links.push({ source: "hub", target: r.id, value: r.amount });
  }
  if (saved > 0) {
    nodes.push({ id: "saved", label: "Saved", value: saved, kind: "saved" });
    links.push({ source: "hub", target: "saved", value: saved });
  }

  return c.json({
    month,
    range,
    income,
    spending,
    totalIncome,
    totalSpending,
    saved,
    savingsRate,
    months,
    sankey: { nodes, links },
  });
});
