// GET /api/taxes?year=YYYY — the year's tax inputs from real data: income by
// source, tagged business expenses, and payments from the Taxes category.
// Estimation math runs client-side against the user's tax_profile setting.
import { Hono } from "hono";
import type { Env } from "../types";
import { q, num, round2, bad } from "./util";

export const taxes = new Hono<{ Bindings: Env }>();

taxes.get("/", async (c) => {
  const year = c.req.query("year") ?? new Date().toISOString().slice(0, 4);
  if (!/^\d{4}$/.test(year)) return bad(c, "year must be YYYY");
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const sources = await q<{ category_id: number; name: string; gross: number | null; n: number }>(
    c.env,
    `SELECT c.id AS category_id, c.name, ROUND(SUM(-t.amount), 2) AS gross, COUNT(*) AS n
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE c.kind = 'income' AND t.amount < 0 AND t.excluded = 0 AND t.date >= ?1 AND t.date <= ?2
     GROUP BY c.id ORDER BY gross DESC`,
    from, to,
  );

  const expenses = await q<{ category_id: number; total: number | null; n: number }>(
    c.env,
    `SELECT t.biz_category_id AS category_id, ROUND(SUM(t.amount), 2) AS total, COUNT(*) AS n
     FROM transactions t
     WHERE t.biz_category_id IS NOT NULL AND t.amount > 0 AND t.excluded = 0
       AND t.date >= ?1 AND t.date <= ?2
     GROUP BY t.biz_category_id`,
    from, to,
  );

  const expenseTxns = await q<{
    id: string; date: string; name: string; merchant_name: string | null;
    amount: number; biz_category_id: number;
  }>(
    c.env,
    `SELECT t.id, t.date, t.name, t.merchant_name, t.amount, t.biz_category_id
     FROM transactions t
     WHERE t.biz_category_id IS NOT NULL AND t.amount > 0 AND t.excluded = 0
       AND t.date >= ?1 AND t.date <= ?2
     ORDER BY t.date DESC LIMIT 200`,
    from, to,
  );

  const payments = await q<{ id: string; date: string; name: string; amount: number }>(
    c.env,
    `SELECT t.id, t.date, t.name, ROUND(t.amount, 2) AS amount
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE c.name = 'Taxes' AND t.amount > 0 AND t.excluded = 0 AND t.date >= ?1 AND t.date <= ?2
     ORDER BY t.date`,
    from, to,
  );

  return c.json({
    year,
    sources: sources.map((s) => ({ ...s, gross: round2(num(s.gross)) })),
    expenses: expenses.map((e) => ({ ...e, total: round2(num(e.total)) })),
    expenseTxns,
    payments,
  });
});
