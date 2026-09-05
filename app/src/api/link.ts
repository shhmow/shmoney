// POST /api/link/token, POST /api/link/exchange — thin wrappers over lib/plaid.
import { Hono } from "hono";
import type { Env } from "../types";
import { first, createLinkToken, exchangePublicToken, num, bad, notFound, readJson } from "./util";

export const link = new Hono<{ Bindings: Env }>();

link.post("/token", async (c) => {
  const body = (await readJson<{ item_id?: number }>(c)) ?? {};
  let accessToken: string | undefined;
  if (body.item_id != null) {
    const item = await first<{ access_token: string }>(
      c.env,
      "SELECT access_token FROM items WHERE id = ?",
      Math.floor(num(body.item_id, -1)),
    );
    if (!item) return notFound(c, "item not found");
    accessToken = item.access_token;
  }
  const linkToken = await createLinkToken(c.env, accessToken ? { accessToken } : undefined);
  return c.json({ link_token: linkToken });
});

link.post("/exchange", async (c) => {
  const body = await readJson<{ public_token?: string }>(c);
  if (!body || typeof body.public_token !== "string" || body.public_token === "") {
    return bad(c, "public_token is required");
  }
  const result = await exchangePublicToken(c.env, body.public_token);
  return c.json({ item_id: result.item_id });
});
