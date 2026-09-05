// GET /api/accounts, PATCH /api/accounts/:id
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, bad, notFound, readJson, hasOwn, ACCOUNT_COLS, type AccountRow } from "./util";

export const accounts = new Hono<{ Bindings: Env }>();

accounts.get("/", async (c) => {
  const rows = await q<AccountRow>(
    c.env,
    `SELECT ${ACCOUNT_COLS} FROM accounts ORDER BY type, name`,
  );
  return c.json(rows);
});

accounts.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readJson<{ hidden?: boolean | number }>(c);
  if (!body) return bad(c, "invalid JSON body");
  if (!hasOwn(body, "hidden")) return bad(c, "no fields to update");
  await run(c.env, "UPDATE accounts SET hidden = ? WHERE id = ?", body.hidden ? 1 : 0, id);
  const row = await first<AccountRow>(c.env, `SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`, id);
  if (!row) return notFound(c, "account not found");
  return c.json(row);
});
