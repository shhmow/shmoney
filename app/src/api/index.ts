// API router: mounts every domain router under /api (mounted by src/index.ts).
// Auth is enforced upstream; the Plaid webhook is exempted there too.
import { Hono } from "hono";
import type { Env } from "../types";
import { syncAll, syncItem, num, readJson, type SyncResult } from "./util";
import { overview } from "./overview";
import { accounts } from "./accounts";
import { transactions } from "./transactions";
import { categories } from "./categories";
import { rules } from "./rules";
import { budgets } from "./budgets";
import { cashflow } from "./cashflow";
import { investments } from "./investments";
import { market } from "./market";
import { backfill } from "./backfill";
import { recurring } from "./recurring";
import { items } from "./items";
import { link } from "./link";
import { settings } from "./settings";
import { exportcsv } from "./exportcsv";
import { webhooks } from "./webhooks";
import { taxes } from "./taxes";

export const api = new Hono<{ Bindings: Env }>();

// Any uncaught handler error becomes a JSON 500 without leaking a stack trace.
api.onError((err, c) => {
  console.error("api error:", err);
  const msg = err instanceof Error && err.message ? err.message : "internal error";
  return c.json({ error: msg }, 500);
});

api.notFound((c) => c.json({ error: "not found" }, 404));

api.route("/overview", overview);
api.route("/accounts", accounts);
api.route("/transactions", transactions);
api.route("/categories", categories);
api.route("/rules", rules);
api.route("/budgets", budgets);
api.route("/cashflow", cashflow);
api.route("/investments/backfill", backfill);
api.route("/investments", investments);
api.route("/market", market);
api.route("/recurring", recurring);
api.route("/items", items);
api.route("/link", link);
api.route("/settings", settings);
api.route("/export", exportcsv);
api.route("/webhooks", webhooks);
api.route("/taxes", taxes);

// POST /api/sync — full sync, or a single item when body carries {item_id}.
api.post("/sync", async (c) => {
  const body = (await readJson<{ item_id?: number }>(c)) ?? {};
  let results: SyncResult[];
  if (body.item_id != null) {
    results = [await syncItem(c.env, Math.floor(num(body.item_id, -1)))];
  } else {
    results = await syncAll(c.env);
  }
  return c.json({ results });
});
