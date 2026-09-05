// GET/POST /api/rules, DELETE /api/rules/:id
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, applyRules, num, bad, notFound, readJson } from "./util";

interface RuleRow {
  id: number;
  match_field: string;
  match_value: string;
  category_id: number;
  priority: number;
}

export const rules = new Hono<{ Bindings: Env }>();

rules.get("/", async (c) => {
  const rows = await q<RuleRow & { category_name: string; category_color: string | null }>(
    c.env,
    `SELECT r.id, r.match_field, r.match_value, r.category_id, r.priority,
            c.name AS category_name, c.color AS category_color
     FROM rules r JOIN categories c ON c.id = r.category_id
     ORDER BY r.priority DESC, r.id`,
  );
  return c.json(rows);
});

rules.post("/", async (c) => {
  const body = await readJson<{
    match_value?: string;
    match_field?: string;
    category_id?: number;
    priority?: number;
    retroactive?: boolean;
  }>(c);
  if (!body || typeof body.match_value !== "string" || body.match_value.trim() === "") {
    return bad(c, "match_value is required");
  }
  if (body.category_id == null) return bad(c, "category_id is required");
  const matchField = body.match_field ?? "merchant";
  if (matchField !== "merchant" && matchField !== "name") return bad(c, "match_field must be merchant or name");
  const cat = await first<{ id: number }>(c.env, "SELECT id FROM categories WHERE id = ?", body.category_id);
  if (!cat) return bad(c, "unknown category_id");

  const inserted = await q<RuleRow>(
    c.env,
    `INSERT INTO rules (match_field, match_value, category_id, priority)
     VALUES (?, ?, ?, ?) RETURNING id, match_field, match_value, category_id, priority`,
    matchField,
    body.match_value.trim(),
    body.category_id,
    Math.floor(num(body.priority, 0)),
  );
  const applied = await applyRules(c.env, { retroactive: body.retroactive === true });
  return c.json({ rule: inserted[0] ?? null, applied }, 201);
});

rules.delete("/:id", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const row = await first<{ id: number }>(c.env, "SELECT id FROM rules WHERE id = ?", id);
  if (!row) return notFound(c, "rule not found");
  await run(c.env, "DELETE FROM rules WHERE id = ?", id);
  return c.json({ ok: true });
});
