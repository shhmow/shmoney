import type { Env } from "../types";
import { first, q, run } from "../lib/db";
import { addMonths } from "../lib/format";

// Create budgets rows for `month` from each expense category's preset
// (default: copy last month's budget). Idempotent: existing rows are left
// alone. Categories with no prior budget and no usable preset are skipped.
export async function rolloverBudgets(env: Env, month: string): Promise<number> {
  const categories = await q<{ id: number; preset_type: string | null; preset_value: number | null }>(
    env,
    `SELECT c.id, bs.preset_type, bs.preset_value
     FROM categories c
     LEFT JOIN budget_settings bs ON bs.category_id = c.id
     WHERE c.kind = 'expense'`,
  );
  const prevMonth = addMonths(month, -1);
  let created = 0;

  for (const cat of categories) {
    const existing = await first<{ id: number }>(
      env, "SELECT id FROM budgets WHERE category_id = ? AND month = ?", cat.id, month,
    );
    if (existing) continue;

    let amount: number | null = null;
    switch (cat.preset_type) {
      case "fixed":
        amount = cat.preset_value;
        break;
      case "last_month_budget":
        amount = await budgetAmount(env, cat.id, prevMonth);
        break;
      case "avg_3mo_spend": {
        const from = `${addMonths(month, -3)}-01`;
        const to = `${month}-01`;
        const row = await first<{ total: number | null }>(
          env,
          `SELECT SUM(amount) AS total FROM transactions
           WHERE category_id = ? AND amount > 0 AND is_transfer = 0 AND excluded = 0
             AND date >= ? AND date < ?`,
          cat.id, from, to,
        );
        amount = Math.round(((row?.total ?? 0) / 3) * 100) / 100;
        break;
      }
      case "recurring_total": {
        const row = await first<{ total: number | null }>(
          env,
          `SELECT SUM(CASE cadence
             WHEN 'weekly' THEN avg_amount * 52.0 / 12
             WHEN 'quarterly' THEN avg_amount / 3.0
             WHEN 'yearly' THEN avg_amount / 12.0
             ELSE avg_amount END) AS total
           FROM recurring WHERE active = 1 AND category_id = ?`,
          cat.id,
        );
        amount = row?.total ?? 0;
        break;
      }
      default:
        // No preset: copy last month's budget; skip when there is none.
        amount = await budgetAmount(env, cat.id, prevMonth);
        break;
    }
    if (amount === null) continue;

    await run(
      env,
      "INSERT OR IGNORE INTO budgets (category_id, month, amount) VALUES (?, ?, ?)",
      cat.id, month, amount,
    );
    created++;
  }
  return created;
}

async function budgetAmount(env: Env, categoryId: number, month: string): Promise<number | null> {
  const row = await first<{ amount: number }>(
    env, "SELECT amount FROM budgets WHERE category_id = ? AND month = ?", categoryId, month,
  );
  return row ? row.amount : null;
}
