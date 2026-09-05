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
  // Accounts were linked at different times (investments carry ~2y of
  // reconstructed history, cash/cards only from their link date), so a plain
  // per-date SUM would show a fake jump when the later accounts appear. Each
  // account's balance is carried forward between snapshots and its earliest
  // known balance is carried back before the first one.
  const snaps = await q<{ account_id: string; date: string; balance: number; sign: number }>(
    env,
    `SELECT s.account_id, s.date, s.balance,
            CASE WHEN a.type IN ('credit','loan') THEN -1 ELSE 1 END AS sign
     FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id
     WHERE a.hidden = 0
     ORDER BY s.date`,
  );
  const dates = [...new Set(snaps.map((r) => r.date))];
  const byAcct = new Map<string, { sign: number; points: { date: string; balance: number }[] }>();
  for (const r of snaps) {
    let a = byAcct.get(r.account_id);
    if (!a) { a = { sign: r.sign, points: [] }; byAcct.set(r.account_id, a); }
    a.points.push({ date: r.date, balance: r.balance });
  }
  // Before an account's first snapshot, rebuild its balance from the ledger
  // anchored on today's posted balance: depository bal(d) = current + sum of
  // posted amounts dated after d (outflows are positive, so adding them back
  // walks the balance into the past); credit owed(d) = current - that sum.
  // (Anchoring on the first snapshot is unsafe: a snapshot taken mid-day can
  // predate transactions carrying the same date.) Earlier than the first
  // transaction on record the balance is unknowable and held flat.
  const liveBal = new Map<string, number>();
  for (const r of await q<{ id: string; current_balance: number | null }>(
    env, "SELECT id, current_balance FROM accounts WHERE hidden = 0",
  )) liveBal.set(r.id, num(r.current_balance));
  const ledger = await q<{ account_id: string; date: string; amount: number; type: string }>(
    env,
    `SELECT t.account_id, t.date, t.amount, a.type FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.hidden = 0 AND a.type IN ('depository','credit') AND t.pending = 0
     ORDER BY t.date DESC`,
  );
  const ledgerByAcct = new Map<string, { date: string; amount: number }[]>();
  for (const r of ledger) {
    let l = ledgerByAcct.get(r.account_id);
    if (!l) { l = []; ledgerByAcct.set(r.account_id, l); }
    l.push({ date: r.date, amount: r.amount });
  }
  // Ensure the series starts no later than the oldest reconstructable ledger date.
  const oldestLedger = ledger.length ? ledger[ledger.length - 1]!.date : null;
  if (oldestLedger && (dates.length === 0 || oldestLedger < dates[0]!)) {
    // add one synthetic point per month back to the oldest ledger date
    let d = dates[0] ?? todayStr();
    const extra: string[] = [];
    while (d > oldestLedger) {
      const dt = new Date(`${d}T12:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - 7);
      d = dt.toISOString().slice(0, 10);
      if (d >= oldestLedger) extra.unshift(d);
    }
    dates.unshift(...extra);
  }
  const cursors = new Map<string, number>();
  const series: { date: string; value: number }[] = [];
  let carriedBack = 0;
  let reconstructed = 0;
  for (const d of dates) {
    let v = 0;
    for (const [id, a] of byAcct) {
      let i = cursors.get(id) ?? -1;
      while (i + 1 < a.points.length && a.points[i + 1].date <= d) i++;
      cursors.set(id, i);
      let bal: number;
      if (i >= 0) {
        bal = a.points[i].balance;
      } else {
        const p0 = a.points[0];
        const l = ledgerByAcct.get(id);
        if (l && l.length && d >= l[l.length - 1]!.date) {
          let sum = 0;
          for (const t of l) { if (t.date <= d) break; sum += t.amount; }
          const live = liveBal.get(id) ?? p0.balance;
          bal = a.sign < 0 ? live - sum : live + sum;
          reconstructed++;
        } else {
          bal = p0.balance; // unknowable: hold flat
          if (d === dates[0]) carriedBack++;
        }
      }
      v += bal * a.sign;
    }
    series.push({ date: d, value: round2(v) });
  }
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
  // Earliest date on which every visible account has a real snapshot.
  let fullFrom: string | null = null;
  for (const a of byAcct.values()) {
    const f = a.points[0]?.date ?? null;
    if (f && (fullFrom === null || f > fullFrom)) fullFrom = f;
  }

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
    netWorth: { current, change1m, series, fullFrom, carriedBack, reconstructed },
    groups: { cash, credit, investments, totals },
    freeToSpend,
    recent,
  });
});
