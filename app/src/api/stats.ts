// GET /api/stats?month=YYYY-MM  — analysis layer for the Cash flow tab:
// merchant leaderboard, category month-over-month, daily pace, weekday mix,
// year-over-year, monthly table, and what the totals leave out.
import { Hono } from "hono";
import type { Env } from "../types";
import {
  q, first, num, round2, bad, isMonth, addMonths, monthStart, monthEndExcl,
  daysInMonth, requestToday, SPEND_COND, INCOME_COND,
} from "./util";

export const stats = new Hono<{ Bindings: Env }>();

const BASE = "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id";

stats.get("/", async (c) => {
  const env = c.env;
  const today = requestToday(c);
  const currentMonth = () => today.slice(0, 7);
  const month = c.req.query("month") ?? currentMonth();
  if (!isMonth(month)) return bad(c, "month must be YYYY-MM");
  const range = c.req.query("range"); // optional: ytd | 1y -> leaderboard window
  let from = monthStart(month);
  let to = monthEndExcl(month);
  if (range === "ytd") from = month.slice(0, 4) + "-01-01";
  if (range === "1y") from = monthStart(addMonths(month, -11));
  const prevFrom = monthStart(addMonths(month, -1));
  const prevTo = monthStart(month);
  const yoyFrom = monthStart(addMonths(month, -12));
  const yoyTo = monthEndExcl(addMonths(month, -12));
  const isCurrent = month === currentMonth();
  const dim = daysInMonth(month);
  const dayOfMonth = isCurrent ? parseInt(today.slice(8, 10), 10) : dim;

  // --- merchant leaderboard for the window
  const merchants = await q<{ merchant: string; n: number; total: number; avg: number; logo_url: string | null; website: string | null; last: string }>(
    env,
    `SELECT COALESCE(t.merchant_name, t.name) AS merchant, COUNT(*) AS n, ROUND(SUM(t.amount), 2) AS total,
            ROUND(AVG(t.amount), 2) AS avg, MAX(t.logo_url) AS logo_url, MAX(t.website) AS website, MAX(t.date) AS last
     ${BASE} WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}
     GROUP BY LOWER(COALESCE(t.merchant_name, t.name))
     ORDER BY total DESC LIMIT 12`,
    from, to,
  );
  // previous window of equal length for the trend column
  const spanMonths = range === "ytd" ? parseInt(month.slice(5, 7), 10) : range === "1y" ? 12 : 1;
  const prevWinFrom = monthStart(addMonths(from.slice(0, 7), -spanMonths));
  const prevWinTo = from;
  const prevMerchants = await q<{ merchant: string; total: number }>(
    env,
    `SELECT LOWER(COALESCE(t.merchant_name, t.name)) AS merchant, ROUND(SUM(t.amount), 2) AS total
     ${BASE} WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}
     GROUP BY LOWER(COALESCE(t.merchant_name, t.name))`,
    prevWinFrom, prevWinTo,
  );
  const prevMap = new Map(prevMerchants.map((r) => [r.merchant, num(r.total)]));
  const windowSpend = await first<{ v: number | null }>(
    env, `SELECT SUM(t.amount) AS v ${BASE} WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}`, from, to,
  );
  const windowTotal = round2(num(windowSpend?.v));
  const topMerchants = merchants.map((m) => ({
    merchant: m.merchant,
    count: num(m.n),
    total: round2(num(m.total)),
    avg: round2(num(m.avg)),
    share: windowTotal > 0 ? round2(num(m.total) / windowTotal * 100) : 0,
    prev: prevMap.get(m.merchant.toLowerCase()) ?? 0,
    logo_url: m.logo_url,
    website: m.website,
    last: m.last,
  }));

  // --- category month-over-month (this month, last month, 3-mo avg, same month last year)
  const catRows = await q<{ id: number | null; name: string | null; color: string | null; cur: number; prev: number; avg3: number; yoy: number }>(
    env,
    `SELECT c.id AS id, c.name AS name, c.color AS color,
            ROUND(SUM(CASE WHEN t.date >= ?1 AND t.date < ?2 THEN t.amount ELSE 0 END), 2) AS cur,
            ROUND(SUM(CASE WHEN t.date >= ?3 AND t.date < ?4 THEN t.amount ELSE 0 END), 2) AS prev,
            ROUND(SUM(CASE WHEN t.date >= ?5 AND t.date < ?4 THEN t.amount ELSE 0 END) / 3.0, 2) AS avg3,
            ROUND(SUM(CASE WHEN t.date >= ?6 AND t.date < ?7 THEN t.amount ELSE 0 END), 2) AS yoy
     ${BASE} WHERE t.date >= ?6 AND t.date < ?2 AND ${SPEND_COND}
     GROUP BY c.id ORDER BY cur DESC`,
    monthStart(month), monthEndExcl(month), prevFrom, prevTo, monthStart(addMonths(month, -3)), yoyFrom, yoyTo,
  );
  const categories = catRows
    .filter((r) => num(r.cur) > 0 || num(r.prev) > 0 || num(r.avg3) > 0)
    .map((r) => ({
      category_id: r.id, name: r.name ?? "Uncategorized", color: r.color,
      current: round2(num(r.cur)), lastMonth: round2(num(r.prev)), avg3: round2(num(r.avg3)), lastYear: round2(num(r.yoy)),
      // projection: after a week of data, scale the month-to-date run rate
      projected: isCurrent && dayOfMonth >= 7 ? round2(num(r.cur) / dayOfMonth * dim) : round2(num(r.cur)),
    }));

  // --- daily pace + weekday mix (the viewed month)
  const daily = await q<{ d: string; v: number }>(
    env,
    `SELECT t.date AS d, ROUND(SUM(t.amount), 2) AS v ${BASE}
     WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND} GROUP BY t.date ORDER BY t.date`,
    monthStart(month), monthEndExcl(month),
  );
  const monthSpend = round2(daily.reduce((s, r) => s + num(r.v), 0));
  const prevSpendRow = await first<{ v: number | null }>(
    env, `SELECT SUM(t.amount) AS v ${BASE} WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}`, prevFrom, prevTo,
  );
  const prevSpend = round2(num(prevSpendRow?.v));
  const prevDim = daysInMonth(addMonths(month, -1));
  const weekday = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat totals over the last 6 months
  const weekdayCount = [0, 0, 0, 0, 0, 0, 0];
  const wk = await q<{ d: string; v: number }>(
    env,
    `SELECT t.date AS d, ROUND(SUM(t.amount), 2) AS v ${BASE}
     WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND} GROUP BY t.date`,
    monthStart(addMonths(month, -5)), monthEndExcl(month),
  );
  for (const r of wk) {
    const dow = new Date(`${r.d}T12:00:00Z`).getUTCDay();
    weekday[dow] += num(r.v);
  }
  // number of each weekday inside the 6-month window, for averages
  {
    const start = new Date(`${monthStart(addMonths(month, -5))}T12:00:00Z`);
    const end = new Date(`${monthEndExcl(month)}T12:00:00Z`);
    for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) weekdayCount[d.getUTCDay()]++;
  }
  const weekdays = weekday.map((v, i) => ({
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i],
    total: round2(v),
    avg: weekdayCount[i] ? round2(v / weekdayCount[i]) : 0,
  }));

  // --- monthly table (12 months): income, spending, net, rate
  const table = await q<{ m: string; income: number; spending: number; n: number }>(
    env,
    `SELECT substr(t.date, 1, 7) AS m,
            ROUND(SUM(CASE WHEN ${INCOME_COND} THEN -t.amount ELSE 0 END), 2) AS income,
            ROUND(SUM(CASE WHEN ${SPEND_COND} THEN t.amount ELSE 0 END), 2) AS spending,
            SUM(CASE WHEN ${SPEND_COND} THEN 1 ELSE 0 END) AS n
     ${BASE} WHERE t.date >= ? AND t.date < ?
     GROUP BY m ORDER BY m`,
    monthStart(addMonths(month, -11)), monthEndExcl(month),
  );
  const months = table.map((r) => {
    const inc = round2(num(r.income)), sp = round2(num(r.spending));
    return { month: r.m, income: inc, spending: sp, net: round2(inc - sp), rate: inc > 0 ? round2((inc - sp) / inc * 100) : null, count: num(r.n) };
  });
  // Typical month: full months only (a 6-day month is not a month), true median.
  const fullMonths = months.filter((m) => !(isCurrent && m.month === month && dayOfMonth < dim));
  const avgSpend = fullMonths.length ? round2(fullMonths.reduce((s, m) => s + m.spending, 0) / fullMonths.length) : 0;
  const sortedSp = fullMonths.map((m) => m.spending).sort((a, b) => a - b);
  const medianSpend = sortedSp.length === 0 ? 0
    : sortedSp.length % 2 === 1 ? round2(sortedSp[(sortedSp.length - 1) / 2])
    : round2((sortedSp[sortedSp.length / 2 - 1] + sortedSp[sortedSp.length / 2]) / 2);

  // --- fixed vs variable: recurring merchants + housing count as fixed
  const fixedRow = await first<{ v: number | null }>(
    env,
    `SELECT SUM(t.amount) AS v ${BASE} WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}
       AND (COALESCE(t.merchant_name, t.name) IN (SELECT merchant FROM recurring WHERE active = 1 AND kind = 'expense')
            OR c.name IN ('Housing', 'Bills & utilities', 'Subscriptions'))`,
    monthStart(month), monthEndExcl(month),
  );
  const fixed = round2(num(fixedRow?.v));

  // --- what the totals leave out this month (transfer-kind inflows like gifts, excluded rows)
  const leftOut = await q<{ name: string; kind: string; inflow: number; outflow: number }>(
    env,
    `SELECT COALESCE(c.name, 'Uncategorized') AS name, COALESCE(c.kind, 'expense') AS kind,
            ROUND(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 2) AS inflow,
            ROUND(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 2) AS outflow
     ${BASE} WHERE t.date >= ? AND t.date < ?
       AND (t.excluded = 1 OR t.is_transfer = 1 OR c.kind = 'transfer')
     GROUP BY 1, 2 ORDER BY inflow + outflow DESC LIMIT 8`,
    from, to,
  );

  return c.json({
    month, range: range ?? null, from, to,
    topMerchants, windowTotal,
    categories,
    pace: {
      monthSpend, dayOfMonth, daysInMonth: dim,
      perDay: dayOfMonth > 0 ? round2(monthSpend / dayOfMonth) : 0,
      prevPerDay: prevSpend > 0 ? round2(prevSpend / prevDim) : 0,
      projected: isCurrent && dayOfMonth >= 3 ? round2(monthSpend / dayOfMonth * dim) : monthSpend,
      prevSpend,
      fixed, variable: round2(Math.max(0, monthSpend - fixed)),
      daily: daily.map((r) => ({ date: r.d, amount: round2(num(r.v)) })),
    },
    weekdays,
    months, avgSpend, medianSpend, typicalMonths: fullMonths.length,
    leftOut: leftOut.map((r) => ({ ...r, inflow: round2(num(r.inflow)), outflow: round2(num(r.outflow)) })),
  });
});
