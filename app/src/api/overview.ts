// GET /api/overview — net worth, account groups, free-to-spend, recent activity.
import { Hono } from "hono";
import type { Env } from "../types";
import {
  q,
  first,
  num,
  round2,
  todayStr,
  currentMonth,
  daysInMonth,
  monthStart,
  monthEndExcl,
  SPEND_COND,
  TXN_SELECT,
  ACCOUNT_SELECT,
  type Txn,
  type AccountRow,
} from "./util";
import { accountLinks } from "../lib/institutions";

export const overview = new Hono<{ Bindings: Env }>();

overview.get("/", async (c) => {
  const env = c.env;
  const today = todayStr();
  const month = currentMonth();

  // --- Net worth: series from snapshots (assets minus liabilities), current from live balances.
  const series = await q<{ date: string; value: number }>(
    env,
    `SELECT s.date AS date,
            ROUND(SUM(s.balance * CASE WHEN a.type IN ('credit','loan') THEN -1 ELSE 1 END), 2) AS value
     FROM balance_snapshots s
     JOIN accounts a ON a.id = s.account_id
     WHERE a.hidden = 0
     GROUP BY s.date
     ORDER BY s.date`,
  );
  const cur = await first<{ v: number | null }>(
    env,
    `SELECT SUM(COALESCE(current_balance, 0) * CASE WHEN type IN ('credit','loan') THEN -1 ELSE 1 END) AS v
     FROM accounts WHERE hidden = 0`,
  );
  const current = round2(num(cur ? cur.v : 0));
  const monthAgoDate = new Date();
  monthAgoDate.setUTCMonth(monthAgoDate.getUTCMonth() - 1);
  const cutoff = monthAgoDate.toISOString().slice(0, 10);
  let base = series.length > 0 ? series[0]!.value : current;
  for (const p of series) if (p.date <= cutoff) base = p.value;
  const change1m = round2(current - base);

  // --- Account groups (hidden accounts excluded; loans grouped with credit).
  const accounts = (await q<AccountRow>(env, `${ACCOUNT_SELECT} WHERE a.hidden = 0 ORDER BY a.type, a.name`))
    .map((a) => ({ ...a, brand: accountLinks(a.name, a.institution_id ?? null, a.institution_name ?? null)?.brand ?? null }));
  const cash = accounts.filter((a) => a.type === "depository");
  const credit = accounts.filter((a) => a.type === "credit" || a.type === "loan");
  const investments = accounts.filter((a) => a.type === "investment");
  const sumBal = (xs: AccountRow[]): number => round2(xs.reduce((s, a) => s + num(a.current_balance), 0));
  const totals = { cash: sumBal(cash), credit: sumBal(credit), investments: sumBal(investments) };

  // --- Free to Spend for the current month.
  const bt = await first<{ v: number | null }>(env, "SELECT SUM(amount) AS v FROM budgets WHERE month = ?", month);
  const budgetTotal = round2(num(bt ? bt.v : 0));
  const sp = await first<{ v: number | null }>(
    env,
    `SELECT SUM(t.amount) AS v
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND t.date < ? AND ${SPEND_COND}`,
    monthStart(month),
    monthEndExcl(month),
  );
  const spentTotal = round2(num(sp ? sp.v : 0));
  const ub = await first<{ v: number | null }>(
    env,
    `SELECT SUM(avg_amount) AS v FROM recurring
     WHERE active = 1 AND avg_amount > 0 AND next_date > ? AND next_date < ?`,
    today,
    monthEndExcl(month),
  );
  const upcomingBills = round2(num(ub ? ub.v : 0));

  const daily = await q<{ d: string; v: number | null }>(
    env,
    `SELECT t.date AS d, SUM(t.amount) AS v
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.date >= ? AND t.date <= ? AND ${SPEND_COND}
     GROUP BY t.date ORDER BY t.date`,
    monthStart(month),
    today,
  );
  const byDay = new Map<number, number>();
  for (const r of daily) byDay.set(parseInt(r.d.slice(8, 10), 10), num(r.v));
  const dayOfMonth = parseInt(today.slice(8, 10), 10);
  const dim = daysInMonth(month);
  let cum = 0;
  const paceSeries: { day: number; cumulative: number }[] = [];
  for (let d = 1; d <= dayOfMonth; d++) {
    cum += byDay.get(d) ?? 0;
    paceSeries.push({ day: d, cumulative: round2(cum) });
  }

  const freeToSpend = {
    amount: round2(budgetTotal - spentTotal - upcomingBills),
    upcomingBills,
    budgetTotal,
    spentTotal,
    daysLeft: dim - dayOfMonth,
    paceSeries,
    idealTotal: budgetTotal,
  };

  // --- Recent activity.
  const recent = await q<Txn>(env, `${TXN_SELECT} ORDER BY t.date DESC, t.id DESC LIMIT 8`);

  return c.json({
    netWorth: { current, change1m, series },
    groups: { cash, credit, investments, totals },
    freeToSpend,
    recent,
  });
});
