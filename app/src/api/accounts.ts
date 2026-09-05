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
  const body = await readJson<{ hidden?: boolean | number }>(c);
  if (!body) return bad(c, "invalid JSON body");
  if (!hasOwn(body, "hidden")) return bad(c, "no fields to update");
  await run(c.env, "UPDATE accounts SET hidden = ? WHERE id = ?", body.hidden ? 1 : 0, id);
  const row = await first<AccountRow>(c.env, `${ACCOUNT_SELECT} WHERE a.id = ?`, id);
  if (!row) return notFound(c, "account not found");
  return c.json(withBrand(row));
});
