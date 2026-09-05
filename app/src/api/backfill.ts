// POST /api/investments/backfill — reconstruct historical portfolio snapshots.
import { Hono } from "hono";
import type { Env } from "../types";
import { backfillPortfolioHistory } from "../sync/backfill";

export const backfill = new Hono<{ Bindings: Env }>();

backfill.post("/", async (c) => {
  let days: number | undefined;
  try {
    const body = await c.req.json<{ days?: unknown }>();
    if (typeof body?.days === "number") days = body.days;
  } catch {
    // No/invalid JSON body: use the default window.
  }
  try {
    const result = await backfillPortfolioHistory(c.env, { days });
    return c.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: message }, 500);
  }
});
