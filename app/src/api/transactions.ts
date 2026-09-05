// GET /api/transactions (filtered list), PATCH /api/transactions/:id
import { Hono } from "hono";
import type { Env } from "../types";
import {
  q,
  first,
  run,
  num,
  nowIso,
  bad,
  notFound,
  readJson,
  hasOwn,
  TXN_SELECT,
  TXN_JOIN,
  type Bind,
  type Txn,
} from "./util";

export const transactions = new Hono<{ Bindings: Env }>();

transactions.get("/", async (c) => {
  const p = c.req.query();
  const conds: string[] = [];
  const binds: Bind[] = [];

  if (p.from) {
    conds.push("t.date >= ?");
    binds.push(p.from);
  }
  if (p.to) {
    conds.push("t.date <= ?");
    binds.push(p.to);
  }
  if (p.account_id) {
    conds.push("t.account_id = ?");
    binds.push(p.account_id);
  }
  if (p.category_id) {
    if (p.category_id === "none") {
      conds.push("t.category_id IS NULL");
    } else {
      conds.push("t.category_id = ?");
      binds.push(num(p.category_id, -1));
    }
  }
  if (p.q) {
    conds.push("(t.name LIKE ? OR t.merchant_name LIKE ?)");
    const like = `%${p.q}%`;
    binds.push(like, like);
  }

  const where = conds.length > 0 ? " WHERE " + conds.join(" AND ") : "";
  const limit = Math.min(Math.max(Math.floor(num(p.limit, 50)), 1), 200);
  const offset = Math.max(Math.floor(num(p.offset, 0)), 0);

  const rows = await q<Txn>(
    c.env,
    `${TXN_SELECT}${where} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    offset,
  );
  const tot = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n ${TXN_JOIN}${where}`,
    ...binds,
  );
  return c.json({ transactions: rows, total: num(tot ? tot.n : 0) });
});

transactions.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{
    category_id?: number | null;
    excluded?: boolean | number;
    is_transfer?: boolean | number;
    notes?: string | null;
    biz_category_id?: number | null;
  }>(c);
  if (!body) return bad(c, "invalid JSON body");

  const sets: string[] = [];
  const binds: Bind[] = [];
  const categoryChanged = hasOwn(body, "category_id");

  if (categoryChanged) {
    let kind: string | null = null;
    if (body.category_id != null) {
      const cat = await first<{ id: number; kind: string }>(
        c.env, "SELECT id, kind FROM categories WHERE id = ?", body.category_id,
      );
      if (!cat) return bad(c, "unknown category_id");
      kind = cat.kind;
    }
    sets.push("category_id = ?");
    binds.push(body.category_id ?? null);
    // Income semantics: assigning an income category makes the transaction
    // income (clear the transfer flag); assigning a transfer category marks it
    // a transfer. An explicit is_transfer in the same request wins below.
    if (!hasOwn(body, "is_transfer")) {
      if (kind === "income") {
        sets.push("is_transfer = 0");
      } else if (kind === "transfer") {
        sets.push("is_transfer = 1");
      }
    }
  }
  if (hasOwn(body, "excluded")) {
    sets.push("excluded = ?");
    binds.push(body.excluded ? 1 : 0);
  }
  if (hasOwn(body, "is_transfer")) {
    sets.push("is_transfer = ?");
    binds.push(body.is_transfer ? 1 : 0);
  }
  if (hasOwn(body, "notes")) {
    sets.push("notes = ?");
    binds.push(body.notes == null ? null : String(body.notes));
  }
  if (hasOwn(body, "biz_category_id")) {
    if (body.biz_category_id != null) {
      const biz = await first<{ kind: string }>(
        c.env, "SELECT kind FROM categories WHERE id = ?", body.biz_category_id,
      );
      if (!biz || biz.kind !== "income") return bad(c, "biz_category_id must be an income category");
    }
    sets.push("biz_category_id = ?");
    binds.push(body.biz_category_id ?? null);
  }
  if (sets.length === 0) return bad(c, "no fields to update");

  sets.push("updated_at = ?");
  binds.push(nowIso());
  await run(c.env, `UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`, ...binds, id);

  const txn = await first<Txn>(c.env, `${TXN_SELECT} WHERE t.id = ?`, id);
  if (!txn) return notFound(c, "transaction not found");

  // Offer the UI a one-tap rule when the category was changed to a real category.
  const ruleSuggestion =
    categoryChanged && body.category_id != null
      ? { merchant: txn.merchant_name ?? txn.name, category_id: body.category_id }
      : null;

  return c.json({ transaction: txn, ruleSuggestion });
});
