// GET /api/items, DELETE /api/items/:id — linked institutions.
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, notFound } from "./util";

export const items = new Hono<{ Bindings: Env }>();

items.get("/", async (c) => {
  const rows = await q<{
    id: number;
    plaid_item_id: string;
    institution_id: string | null;
    institution_name: string | null;
    status: string;
    last_synced_at: string | null;
    last_error: string | null;
    created_at: string;
    accounts: number;
  }>(
    c.env,
    `SELECT i.id, i.plaid_item_id, i.institution_id, i.institution_name, i.status,
            i.last_synced_at, i.last_error, i.created_at, COUNT(a.id) AS accounts
     FROM items i LEFT JOIN accounts a ON a.item_id = i.id
     GROUP BY i.id
     ORDER BY i.institution_name, i.id`,
  );
  return c.json(rows);
});

items.delete("/:id", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const item = await first<{ id: number }>(c.env, "SELECT id FROM items WHERE id = ?", id);
  if (!item) return notFound(c, "item not found");

  // Explicit cascade so nothing is left orphaned regardless of FK enforcement.
  const acctSub = "SELECT id FROM accounts WHERE item_id = ?";
  await run(c.env, `DELETE FROM transactions WHERE account_id IN (${acctSub})`, id);
  await run(c.env, `DELETE FROM investment_transactions WHERE account_id IN (${acctSub})`, id);
  await run(c.env, `DELETE FROM holdings WHERE account_id IN (${acctSub})`, id);
  await run(c.env, `DELETE FROM balance_snapshots WHERE account_id IN (${acctSub})`, id);
  await run(c.env, "DELETE FROM accounts WHERE item_id = ?", id);
  await run(c.env, "DELETE FROM items WHERE id = ?", id);

  return c.json({ ok: true });
});
