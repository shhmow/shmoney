// Budgets: month view, upserts, suggestions, move, rebalance, rollover.
import { Hono } from "hono";
import type { Env } from "../types";
import {
  q,
  first,
  run,
  rolloverBudgets,
  num,
  round2,
  bad,
  readJson,
  isMonth,
  currentMonth,
  todayStr,
  daysInMonth,
  addMonths,
  monthSpendByCategory,
  avg3moSpend,
} from "./util";

type Pace = "ok" | "projected_over" | "over";

export const budgets = new Hono<{ Bindings: Env }>();

function monthParam(raw: string | undefined): string | null {
  const m = raw ?? currentMonth();
  return isMonth(m) ? m : null;
}

/**
 * Day-of-month position for pace math: for the current month it is today's
 * day; past months count as complete; future months as day 0.
 */
function elapsedDays(month: string): { day: number; dim: number } {
  const dim = daysInMonth(month);
  const cur = currentMonth();
  if (month === cur) return { day: parseInt(todayStr().slice(8, 10), 10), dim };
  if (month < cur) return { day: dim, dim };
  return { day: 0, dim };
}

budgets.get("/", async (c) => {
  const month = monthParam(c.req.query("month"));
  if (!month) return bad(c, "month must be YYYY-MM");
  const { day, dim } = elapsedDays(month);
  const isCurrent = month === currentMonth();
  const daysLeft = Math.max(0, dim - day);

  const rows = await q<{
    category_id: number; name: string; color: string | null; budget: number | null;
    rollover: number | null; preset_type: string | null; preset_value: number | null;
  }>(
    c.env,
    `SELECT cat.id AS category_id, cat.name AS name, cat.color AS color, b.amount AS budget,
            bs.rollover AS rollover, bs.preset_type AS preset_type, bs.preset_value AS preset_value
     FROM categories cat
     LEFT JOIN budgets b ON b.category_id = cat.id AND b.month = ?
     LEFT JOIN budget_settings bs ON bs.category_id = cat.id
     WHERE cat.kind = 'expense' AND cat.hidden = 0
     ORDER BY cat.sort, cat.name`,
    month,
  );
  const spent = await monthSpendByCategory(c.env, month);
  const lastSpent = await monthSpendByCategory(c.env, addMonths(month, -1));

  let onCount = 0;
  let budgetedCount = 0;
  let unbudgetedCount = 0;
  let unbudgetedSpent = 0;
  const out = rows.map((r) => {
    const budget = round2(num(r.budget));
    const sp = spent.get(r.category_id) ?? 0;
    const projected = day >= 7 && day < dim ? round2((sp / Math.max(day, 1)) * dim) : sp;
    const available = round2(budget - sp);
    let pace: Pace = "ok";
    if (budget > 0) {
      if (sp > budget) pace = "over";
      else if (day >= 7 && projected > budget) pace = "projected_over";
      budgetedCount++;
      if (pace === "ok") onCount++;
    } else if (sp > 0) {
      unbudgetedCount++;
      unbudgetedSpent += sp;
    }
    // Pace helpers for the current month only: dollars per remaining day and,
    // at the current burn rate, how many days until the budget is used up.
    const burn = isCurrent && day >= 7 && sp > 0 ? sp / day : 0;
    const dailyLeft = isCurrent && budget > 0 && daysLeft > 0 && available > 0 ? round2(available / daysLeft) : null;
    const exhaustDays = isCurrent && budget > 0 && burn > 0 && available > 0 ? Math.round(available / burn) : null;
    const lm = lastSpent.get(r.category_id) ?? 0;
    return {
      category_id: r.category_id,
      name: r.name,
      color: r.color,
      budget,
      spent: sp,
      available,
      pace,
      projected,
      dailyLeft,
      exhaustDays,
      lastMonthSpent: lm,
      lastMonthDeltaPct: lm > 0 ? Math.round(((sp - lm) / lm) * 100) : null,
      rollover: num(r.rollover) ? 1 : 0,
      preset_type: r.preset_type,
      preset_value: r.preset_value,
    };
  });

  const totalBudget = round2(out.reduce((s, r) => s + r.budget, 0));
  const totalSpent = round2(out.reduce((s, r) => s + r.spent, 0));
  // "Spent of budgeted" only counts categories that have a budget; spend in
  // unbudgeted categories is reported separately so the ratio stays honest.
  const spentBudgeted = round2(out.reduce((s, r) => s + (r.budget > 0 ? r.spent : 0), 0));

  return c.json({
    month,
    day,
    daysInMonth: dim,
    daysLeft,
    rows: out,
    totals: {
      budget: totalBudget,
      spent: totalSpent,
      spentBudgeted,
      unbudgetedSpent: round2(unbudgetedSpent),
      available: round2(totalBudget - spentBudgeted),
    },
    onTrack: { on: onCount, of: budgetedCount, unbudgeted: unbudgetedCount, unbudgetedSpent: round2(unbudgetedSpent) },
  });
});

budgets.put("/:month", async (c) => {
  const month = monthParam(c.req.param("month"));
  if (!month) return bad(c, "month must be YYYY-MM");
  const body = await readJson<{ rows?: { category_id?: number; amount?: number }[] }>(c);
  if (!body || !Array.isArray(body.rows)) return bad(c, "body must be { rows: [{category_id, amount}] }");

  for (const row of body.rows) {
    const cid = Math.floor(num(row.category_id, -1));
    if (cid < 0) return bad(c, "each row needs a category_id");
    const amount = round2(num(row.amount));
    if (amount > 0) {
      await run(
        c.env,
        `INSERT INTO budgets (category_id, month, amount) VALUES (?, ?, ?)
         ON CONFLICT(category_id, month) DO UPDATE SET amount = excluded.amount`,
        cid,
        month,
        amount,
      );
    } else {
      await run(c.env, "DELETE FROM budgets WHERE category_id = ? AND month = ?", cid, month);
    }
  }
  return c.json({ ok: true, month });
});

budgets.get("/:month/suggestions", async (c) => {
  const month = monthParam(c.req.param("month"));
  if (!month) return bad(c, "month must be YYYY-MM");
  const prev = addMonths(month, -1);

  const cats = await q<{ id: number; name: string }>(
    c.env,
    "SELECT id, name FROM categories WHERE kind = 'expense' AND hidden = 0 ORDER BY sort, name",
  );
  const avg = await avg3moSpend(c.env, month);
  const lastSpend = await monthSpendByCategory(c.env, prev);
  const lastBudgets = await q<{ category_id: number; amount: number }>(
    c.env,
    "SELECT category_id, amount FROM budgets WHERE month = ?",
    prev,
  );
  const lastBudgetMap = new Map<number, number>();
  for (const b of lastBudgets) lastBudgetMap.set(b.category_id, num(b.amount));
  const recurring = await q<{ cid: number; v: number | null }>(
    c.env,
    `SELECT category_id AS cid, SUM(CASE cadence
       WHEN 'weekly' THEN avg_amount * 52.0 / 12
       WHEN 'quarterly' THEN avg_amount / 3.0
       WHEN 'yearly' THEN avg_amount / 12.0
       ELSE avg_amount END) AS v FROM recurring
     WHERE active = 1 AND avg_amount > 0 AND category_id IS NOT NULL
     GROUP BY category_id`,
  );
  const recurringMap = new Map<number, number>();
  for (const r of recurring) recurringMap.set(r.cid, round2(num(r.v)));

  const out = cats.map((cat) => ({
    category_id: cat.id,
    name: cat.name,
    avg3mo: avg.get(cat.id) ?? 0,
    lastMonthSpend: lastSpend.get(cat.id) ?? 0,
    lastMonthBudget: lastBudgetMap.get(cat.id) ?? 0,
    recurringTotal: recurringMap.get(cat.id) ?? 0,
  }));
  return c.json(out);
});

budgets.post("/:month/move", async (c) => {
  const month = monthParam(c.req.param("month"));
  if (!month) return bad(c, "month must be YYYY-MM");
  const body = await readJson<{ from_category_id?: number; to_category_id?: number; amount?: number }>(c);
  if (!body) return bad(c, "invalid JSON body");
  const from = Math.floor(num(body.from_category_id, -1));
  const to = Math.floor(num(body.to_category_id, -1));
  const amount = round2(num(body.amount));
  if (from < 0 || to < 0) return bad(c, "from_category_id and to_category_id are required");
  if (from === to) return bad(c, "from and to must differ");
  if (!(amount > 0)) return bad(c, "amount must be positive");

  const fromRow = await first<{ amount: number }>(
    c.env,
    "SELECT amount FROM budgets WHERE category_id = ? AND month = ?",
    from,
    month,
  );
  if (!fromRow) return bad(c, "no budget to move from");
  if (num(fromRow.amount) < amount) return bad(c, "amount exceeds the source budget");

  await run(
    c.env,
    "UPDATE budgets SET amount = ROUND(amount - ?, 2) WHERE category_id = ? AND month = ?",
    amount,
    from,
    month,
  );
  await run(
    c.env,
    `INSERT INTO budgets (category_id, month, amount) VALUES (?, ?, ?)
     ON CONFLICT(category_id, month) DO UPDATE SET amount = ROUND(budgets.amount + excluded.amount, 2)`,
    to,
    month,
    amount,
  );

  const fromAfter = await first<{ amount: number }>(c.env, "SELECT amount FROM budgets WHERE category_id = ? AND month = ?", from, month);
  const toAfter = await first<{ amount: number }>(c.env, "SELECT amount FROM budgets WHERE category_id = ? AND month = ?", to, month);
  return c.json({
    ok: true,
    month,
    from: { category_id: from, amount: round2(num(fromAfter ? fromAfter.amount : 0)) },
    to: { category_id: to, amount: round2(num(toAfter ? toAfter.amount : 0)) },
  });
});

budgets.post("/:month/rebalance", async (c) => {
  const month = monthParam(c.req.param("month"));
  if (!month) return bad(c, "month must be YYYY-MM");
  const body = (await readJson<{ apply?: boolean; scope?: "month" | "future" }>(c)) ?? {};
  const scope = body.scope === "future" ? "future" : "month";

  const current = await q<{ category_id: number; name: string; amount: number }>(
    c.env,
    `SELECT b.category_id, cat.name, b.amount
     FROM budgets b JOIN categories cat ON cat.id = b.category_id
     WHERE b.month = ? AND b.amount > 0
     ORDER BY b.amount DESC`,
    month,
  );
  if (current.length === 0) return bad(c, "no budgets for this month to rebalance");

  const total = current.reduce((s, r) => s + num(r.amount), 0);
  const avg = await avg3moSpend(c.env, month);
  const weightSum = current.reduce((s, r) => s + (avg.get(r.category_id) ?? 0), 0);
  // Spend so far this month floors each proposal (a budget below what is
  // already spent would be breached the moment it is applied). Only months
  // that have started have spend to floor against.
  const floorSpend = month <= currentMonth() ? await monthSpendByCategory(c.env, month) : new Map<number, number>();

  const rows = current.map((r) => {
    const weight = weightSum > 0 ? (avg.get(r.category_id) ?? 0) / weightSum : 1 / current.length;
    const proposed = Math.round((total * weight) / 5) * 5; // nearest $5
    const spent = floorSpend.get(r.category_id) ?? 0;
    const floor = Math.ceil(spent / 5) * 5;
    return {
      category_id: r.category_id, name: r.name, current: round2(num(r.amount)),
      proposed, delta: 0, spent, floor, floored: false, over: false,
    };
  });
  // Preserve the total: put rounding drift on the largest proposed row.
  const drift = round2(total - rows.reduce((s, r) => s + r.proposed, 0));
  if (drift !== 0) {
    let largest = rows[0]!;
    for (const r of rows) if (r.proposed > largest.proposed) largest = r;
    largest.proposed = round2(largest.proposed + drift);
  }
  // Raise breached proposals to their floor, then take the excess back from
  // rows with slack ($5 steps, most slack first) so the total holds when it can.
  for (const r of rows) {
    if (r.proposed < r.floor) {
      r.proposed = r.floor;
      r.floored = true;
    }
  }
  let excess = round2(rows.reduce((s, r) => s + r.proposed, 0) - total);
  let guard = 0;
  while (excess > 0 && guard++ < 1000) {
    let donor: (typeof rows)[number] | null = null;
    for (const r of rows) {
      const slack = r.proposed - r.floor;
      if (slack > 0 && (donor === null || slack > donor.proposed - donor.floor)) donor = r;
    }
    if (donor === null) break;
    const take = Math.min(excess, 5, donor.proposed - donor.floor);
    donor.proposed = round2(donor.proposed - take);
    excess = round2(excess - take);
  }
  for (const r of rows) {
    r.delta = round2(r.proposed - r.current);
    r.over = r.proposed < r.spent;
  }
  const newTotal = round2(rows.reduce((s, r) => s + r.proposed, 0));

  if (body.apply === true) {
    for (const r of rows) {
      if (r.proposed > 0) {
        await run(
          c.env,
          `INSERT INTO budgets (category_id, month, amount) VALUES (?, ?, ?)
           ON CONFLICT(category_id, month) DO UPDATE SET amount = excluded.amount`,
          r.category_id,
          month,
          r.proposed,
        );
      } else {
        await run(c.env, "DELETE FROM budgets WHERE category_id = ? AND month = ?", r.category_id, month);
      }
      if (scope === "future") {
        await run(
          c.env,
          `INSERT INTO budget_settings (category_id, rollover, preset_type, preset_value)
           VALUES (?, 0, 'fixed', ?)
           ON CONFLICT(category_id) DO UPDATE SET preset_type = 'fixed', preset_value = excluded.preset_value`,
          r.category_id,
          r.proposed,
        );
      }
    }
  }

  return c.json({
    month, total: newTotal, previousTotal: round2(total), totalChanged: newTotal !== round2(total),
    rows, applied: body.apply === true, scope,
  });
});

budgets.post("/:month/rollover", async (c) => {
  const month = monthParam(c.req.param("month"));
  if (!month) return bad(c, "month must be YYYY-MM");
  await rolloverBudgets(c.env, month);
  const count = await first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM budgets WHERE month = ?", month);
  return c.json({ ok: true, month, rows: num(count ? count.n : 0) });
});
