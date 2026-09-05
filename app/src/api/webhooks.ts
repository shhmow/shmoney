// POST /api/webhooks/plaid — no auth (exempted upstream). Always answers 200 fast;
// sync work happens in the background via waitUntil.
import { Hono } from "hono";
import type { Env } from "../types";
import { first, syncItem } from "./util";

export const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post("/plaid", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const webhookType = typeof body["webhook_type"] === "string" ? (body["webhook_type"] as string) : "";
    const plaidItemId = typeof body["item_id"] === "string" ? (body["item_id"] as string) : "";

    if ((webhookType === "TRANSACTIONS" || webhookType === "HOLDINGS") && plaidItemId !== "") {
      const item = await first<{ id: number }>(c.env, "SELECT id FROM items WHERE plaid_item_id = ?", plaidItemId);
      if (item) {
        c.executionCtx.waitUntil(
          syncItem(c.env, item.id).catch((err: unknown) => {
            console.error("webhook sync failed:", err);
          }),
        );
      }
    }
  } catch (err) {
    // Never fail a webhook delivery; log and acknowledge.
    console.error("webhook handling error:", err);
  }
  return c.json({ ok: true });
});
