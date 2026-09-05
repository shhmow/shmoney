// GET /api/accounts, PATCH /api/accounts/:id
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, bad, notFound, readJson, hasOwn, ACCOUNT_SELECT, type AccountRow } from "./util";
import { accountLinks } from "../lib/institutions";

function withBrand(a: AccountRow): AccountRow {
  const l = accountLinks(a.name, a.institution_id ?? null, a.institution_name ?? null);
  return { ...a, brand: l ? l.brand : null };
}

export const accounts = new Hono<{ Bindings: Env }>();

accounts.get("/", async (c) => {
  const rows = await q<AccountRow>(c.env, `${ACCOUNT_SELECT} ORDER BY a.type, a.name`);
  return c.json(rows.map(withBrand));
});

accounts.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ hidden?: boolean | number; nickname?: string | null; manual_limit?: number | null }>(c);
  if (!body) return bad(c, "invalid JSON body");
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (hasOwn(body, "hidden")) { sets.push("hidden = ?"); binds.push(body.hidden ? 1 : 0); }
  if (hasOwn(body, "nickname")) {
    const v = body.nickname == null ? "" : String(body.nickname).trim().slice(0, 60);
    sets.push("nickname = ?"); binds.push(v === "" ? null : v);
  }
  if (hasOwn(body, "manual_limit")) {
    const v = body.manual_limit == null ? NaN : Number(body.manual_limit);
    sets.push("manual_limit = ?"); binds.push(Number.isFinite(v) && v > 0 ? v : null);
  }
  if (sets.length === 0) return bad(c, "no fields to update");
  await run(c.env, `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...binds, id);
  const row = await first<AccountRow>(c.env, `${ACCOUNT_SELECT} WHERE a.id = ?`, id);
  if (!row) return notFound(c, "account not found");
  return c.json(withBrand(row));
});
