// GET/POST /api/categories, PATCH/DELETE /api/categories/:id
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, bad, notFound, readJson, hasOwn, type Bind } from "./util";

interface CategoryRow {
  id: number;
  name: string;
  kind: string;
  color: string | null;
  hidden: number;
  sort: number;
}

const KINDS = ["expense", "income", "transfer"];

export const categories = new Hono<{ Bindings: Env }>();

categories.get("/", async (c) => {
  const rows = await q<CategoryRow>(c.env, "SELECT id, name, kind, color, hidden, sort FROM categories ORDER BY sort, name");
  return c.json(rows);
});

categories.post("/", async (c) => {
  const body = await readJson<{ name?: string; kind?: string; color?: string; sort?: number }>(c);
  if (!body || typeof body.name !== "string" || body.name.trim() === "") return bad(c, "name is required");
  const name = body.name.trim();
  const kind = body.kind ?? "expense";
  if (!KINDS.includes(kind)) return bad(c, "kind must be expense, income or transfer");
  const dupe = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE name = ?", name);
  if (dupe) return bad(c, "a category with that name already exists");
  const maxSort = await first<{ v: number | null }>(c.env, "SELECT MAX(sort) AS v FROM categories");
  const sort = hasOwn(body, "sort") ? Math.floor(num(body.sort)) : num(maxSort ? maxSort.v : 0) + 1;
  const rows = await q<CategoryRow>(
    c.env,
    "INSERT INTO categories (name, kind, color, sort) VALUES (?, ?, ?, ?) RETURNING id, name, kind, color, hidden, sort",
    name,
    kind,
    body.color ?? null,
    sort,
  );
  return c.json(rows[0] ?? null, 201);
});

categories.patch("/:id", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const body = await readJson<{
    name?: string; kind?: string; color?: string | null; hidden?: boolean | number; sort?: number;
    rollover?: boolean | number; preset_type?: string | null; preset_value?: number | null;
  }>(c);
  if (!body) return bad(c, "invalid JSON body");

  // Budget settings ride along on this endpoint (stored in budget_settings).
  const PRESETS = ["fixed", "last_month_budget", "avg_3mo_spend", "recurring_total"];
  const wantsBudgetSettings = hasOwn(body, "rollover") || hasOwn(body, "preset_type") || hasOwn(body, "preset_value");
  if (wantsBudgetSettings) {
    if (hasOwn(body, "preset_type") && body.preset_type != null && !PRESETS.includes(body.preset_type)) {
      return bad(c, "preset_type must be one of: " + PRESETS.join(", "));
    }
    const existing = await first<{ rollover: number; preset_type: string | null; preset_value: number | null }>(
      c.env, "SELECT rollover, preset_type, preset_value FROM budget_settings WHERE category_id = ?", id,
    );
    const rollover = hasOwn(body, "rollover") ? (body.rollover ? 1 : 0) : (existing?.rollover ?? 0);
    const presetType = hasOwn(body, "preset_type") ? (body.preset_type ?? null) : (existing?.preset_type ?? null);
    const presetValue = hasOwn(body, "preset_value") ? (body.preset_value == null ? null : num(body.preset_value)) : (existing?.preset_value ?? null);
    await run(
      c.env,
      `INSERT INTO budget_settings (category_id, rollover, preset_type, preset_value) VALUES (?, ?, ?, ?)
       ON CONFLICT(category_id) DO UPDATE SET rollover = excluded.rollover, preset_type = excluded.preset_type, preset_value = excluded.preset_value`,
      id, rollover, presetType, presetValue,
    );
  }

  const sets: string[] = [];
  const binds: Bind[] = [];
  if (hasOwn(body, "name")) {
    if (typeof body.name !== "string" || body.name.trim() === "") return bad(c, "name must be a non-empty string");
    const dupe = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE name = ? AND id <> ?", body.name.trim(), id);
    if (dupe) return bad(c, "a category with that name already exists");
    sets.push("name = ?");
    binds.push(body.name.trim());
  }
  if (hasOwn(body, "kind")) {
    if (typeof body.kind !== "string" || !KINDS.includes(body.kind)) return bad(c, "kind must be expense, income or transfer");
    sets.push("kind = ?");
    binds.push(body.kind);
  }
  if (hasOwn(body, "color")) {
    sets.push("color = ?");
    binds.push(body.color == null ? null : String(body.color));
  }
  if (hasOwn(body, "hidden")) {
    sets.push("hidden = ?");
    binds.push(body.hidden ? 1 : 0);
  }
  if (hasOwn(body, "sort")) {
    sets.push("sort = ?");
    binds.push(Math.floor(num(body.sort)));
  }
  if (sets.length === 0 && !wantsBudgetSettings) return bad(c, "no fields to update");

  if (sets.length > 0) await run(c.env, `UPDATE categories SET ${sets.join(", ")} WHERE id = ?`, ...binds, id);
  const row = await first<CategoryRow>(c.env, "SELECT id, name, kind, color, hidden, sort FROM categories WHERE id = ?", id);
  if (!row) return notFound(c, "category not found");
  return c.json(row);
});

categories.delete("/:id", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const reassignRaw = c.req.query("reassign_to");
  if (!reassignRaw) return bad(c, "reassign_to query parameter is required");
  const reassignTo = Math.floor(num(reassignRaw, -1));
  if (reassignTo === id) return bad(c, "reassign_to must be a different category");

  const victim = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE id = ?", id);
  if (!victim) return notFound(c, "category not found");
  const target = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE id = ?", reassignTo);
  if (!target) return bad(c, "reassign_to category does not exist");

  // Move transactions and recurring rows to the target category.
  await run(c.env, "UPDATE transactions SET category_id = ? WHERE category_id = ?", reassignTo, id);
  await run(c.env, "UPDATE recurring SET category_id = ? WHERE category_id = ?", reassignTo, id);

  // Merge budgets: add into existing target-month rows, move the rest.
  await run(
    c.env,
    `UPDATE budgets SET amount = amount + COALESCE(
       (SELECT b2.amount FROM budgets b2 WHERE b2.category_id = ? AND b2.month = budgets.month), 0)
     WHERE category_id = ? AND month IN (SELECT month FROM budgets WHERE category_id = ?)`,
    id,
    reassignTo,
    id,
  );
  await run(
    c.env,
    "DELETE FROM budgets WHERE category_id = ? AND month IN (SELECT month FROM budgets WHERE category_id = ?)",
    id,
    reassignTo,
  );
  await run(c.env, "UPDATE budgets SET category_id = ? WHERE category_id = ?", reassignTo, id);

  // Rules and presets pointing at the deleted category go away with it.
  await run(c.env, "DELETE FROM rules WHERE category_id = ?", id);
  await run(c.env, "DELETE FROM budget_settings WHERE category_id = ?", id);
  await run(c.env, "DELETE FROM categories WHERE id = ?", id);

  return c.json({ ok: true, reassigned_to: reassignTo });
});
