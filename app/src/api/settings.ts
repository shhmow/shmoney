// GET/PUT /api/settings — key/value settings (values stored and returned as strings).
import { Hono } from "hono";
import type { Env } from "../types";
import { run, getSettings, bad, readJson, hasOwn } from "./util";

const ALLOWED_KEYS = [
  "expected_monthly_income",
  "roth_contribution_limit",
  "roth_contributed_ytd",
  "inherited_ira_year_of_death",
  "inherited_ira_starting_balance",
  "inherited_ira_taken_ytd",
  // JSON string: {"written_at": ISO, "headline": string, "bullets": [string], "model": "claude"}
  "invest_analysis",
  "recurring_manual_merchants",
  // JSON string: taxes tab profile — filing status, resident state, per-source
  // treatment/state/withholding, and per-payment year/jurisdiction attribution.
  "tax_profile",
  // JSON string: per-institution link overrides {key: {activity, dispute, phone}}
  "inst_links",
];

export const settings = new Hono<{ Bindings: Env }>();

settings.get("/", async (c) => {
  return c.json(await getSettings(c.env));
});

settings.put("/", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad(c, "body must be an object of settings");

  let updated = 0;
  for (const key of ALLOWED_KEYS) {
    if (!hasOwn(body, key)) continue;
    const raw = body[key];
    // Objects (e.g. invest_analysis passed as JSON rather than a string) are
    // stored as their JSON text; null clears the key to "".
    const value = raw == null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    await run(
      c.env,
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
    updated++;
  }
  if (updated === 0) return bad(c, "no recognized settings keys in body");
  return c.json(await getSettings(c.env));
});
