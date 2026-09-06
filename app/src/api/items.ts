// GET /api/items, DELETE /api/items/:id — linked institutions.
import { Hono } from "hono";
import type { Env } from "../types";
import { q, first, run, num, notFound, getSettings, ensureInstitutionMeta, backfillMerchantLogos } from "./util";
import { institutionLinks } from "../lib/institutions";

export const items = new Hono<{ Bindings: Env }>();

items.get("/", async (c) => {
  const rows = await q<{
    id: number;
    plaid_item_id: string;
    institution_id: string | null;
    institution_name: string | null;
    status: string;
    last_synced_at: string | null;
    last_error: string | null;
    created_at: string;
    accounts: number;
    primary_color: string | null;
    url: string | null;
    has_logo: number;
  }>(
    c.env,
    `SELECT i.id, i.plaid_item_id, i.institution_id, i.institution_name, i.status,
            i.last_synced_at, i.last_error, i.created_at, COUNT(a.id) AS accounts,
            i.primary_color, i.url, (i.logo IS NOT NULL) AS has_logo
     FROM items i LEFT JOIN accounts a ON a.item_id = i.id
     GROUP BY i.id
     ORDER BY i.institution_name, i.id`,
  );
  return c.json(rows.map((r) => ({ ...r, links: institutionLinks(r.institution_id, r.institution_name) })));
});

// Institution logo as PNG (stored base64 from Plaid). Cacheable per browser.
items.get("/:id/logo", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const row = await first<{ logo: string | null }>(c.env, "SELECT logo FROM items WHERE id = ?", id);
  if (!row || !row.logo) return notFound(c, "no logo");
  const bin = Uint8Array.from(atob(row.logo), (ch) => ch.charCodeAt(0));
  return new Response(bin, {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=604800" },
  });
});

// Links for the detail sheet: built-in defaults merged with settings overrides.
items.get("/links", async (c) => {
  const s = await getSettings(c.env);
  let overrides: Record<string, Record<string, string>> = {};
  try { overrides = s.inst_links ? JSON.parse(s.inst_links) : {}; } catch { overrides = {}; }
  const rows = await q<{ id: number; institution_id: string | null; institution_name: string | null }>(
    c.env, "SELECT id, institution_id, institution_name FROM items",
  );
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const l = institutionLinks(r.institution_id, r.institution_name);
    if (l) out[l.key] = { ...l, ...(overrides[l.key] ?? {}) };
  }
  // Card brands that may live under another institution (Discover via Capital One).
  const discCard = await first<{ n: number }>(c.env, "SELECT 1 AS n FROM accounts WHERE LOWER(name) LIKE '%discover%' LIMIT 1");
  const disc = institutionLinks("ins_33", "Discover");
  if (discCard && disc && !out.discover) out.discover = { ...disc, ...(overrides.discover ?? {}) };
  return c.json(out);
});

// Pull branding for items linked before logos were stored, and merchant logos
// for transactions that pre-date the logo column. Safe to re-run.
items.post("/enrich", async (c) => {
  const body = await c.req.json<{ force?: boolean; logos?: boolean }>().catch(() => ({} as { force?: boolean; logos?: boolean }));
  const institutions = await ensureInstitutionMeta(c.env, { force: body.force === true });
  const merchants = body.logos === false ? { scanned: 0, updated: 0 } : await backfillMerchantLogos(c.env);
  return c.json({ institutions, merchants });
});

items.delete("/:id", async (c) => {
  const id = Math.floor(num(c.req.param("id"), -1));
  const item = await first<{ id: number }>(c.env, "SELECT id FROM items WHERE id = ?", id);
  if (!item) return notFound(c, "item not found");

  // Explicit cascade so nothing is left orphaned regardless of FK enforcement.
  const acctSub = "SELECT id FROM accounts WHERE item_id = ?";
  await run(c.env, `DELETE FROM transactions WHERE account_id IN (${acctSub})`, id);
  await run(c.env, `DELETE FROM investment_transactions WHERE account_id IN (${acctSub})`, id);
  await run(c.env, `DELETE FROM holdings WHERE account_id IN (${acctSub})`, id);
  await run(c.env, `DELETE FROM balance_snapshots WHERE account_id IN (${acctSub})`, id);
  await run(c.env, "DELETE FROM accounts WHERE item_id = ?", id);
  await run(c.env, "DELETE FROM items WHERE id = ?", id);

  return c.json({ ok: true });
});
