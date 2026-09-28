import { Hono } from "hono";
import type { Env } from "./types";
import { api } from "./api";
import { syncAll } from "./sync";
import { rolloverBudgets } from "./sync/rollover";

const app = new Hono<{ Bindings: Env }>();

const BUILD_TAG = "2026-09-27-access-jwt";

const SESSION_COOKIE = "shmoney_session";
const SESSION_DAYS = 30;

async function sessionToken(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("shmoney-session-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}

// timing-safe-ish comparison
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  if (!body.password || !eq(body.password, c.env.APP_PASSWORD)) {
    return c.json({ error: "wrong password" }, 401);
  }
  const token = await sessionToken(c.env);
  c.header(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
  );
  return c.json({ ok: true });
});

// Auth-gated no-op: the SPA probes this once on boot so a signed-out user
// gets a single 401 (and the login overlay) instead of one per view request.
app.get("/api/auth/check", (c) => c.json({ ok: true }));

// Public, dataless: which worker build is actually serving traffic.
app.get("/api/version", (c) => c.json({ build: BUILD_TAG }));

app.post("/api/auth/logout", (c) => {
  c.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return c.json({ ok: true });
});

// Cloudflare Access (when the Worker is protected behind Access in the
// dashboard): Cloudflare has already authenticated the browser and attaches
// the identity to the execution context. Trust it only for allow-listed
// emails so a mis-scoped Access policy still cannot expose the data.
// Cloudflare Access (when the Worker sits behind Access): every request that
// passed Access carries a signed JWT in `cf-access-jwt-assertion`. Verify it
// against the team's public keys and the application's audience tag, then
// trust the email only if it is allow-listed, so a mis-scoped Access policy
// still cannot expose the data. Needs ACCESS_TEAM_DOMAIN and ACCESS_AUD.
let certCache: { at: number; keys: JsonWebKey[] } | null = null;

async function accessKeys(team: string): Promise<JsonWebKey[]> {
  if (certCache && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) return certCache?.keys ?? [];
  const body = (await res.json()) as { keys?: JsonWebKey[] };
  certCache = { at: Date.now(), keys: body.keys ?? [] };
  return certCache.keys;
}

function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
}

async function accessEmail(c: { req: { raw: Request }; env: Env }): Promise<string | null> {
  const team = (c.env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const aud = (c.env.ACCESS_AUD ?? "").trim();
  const token = c.req.raw.headers.get("cf-access-jwt-assertion") ?? getCookie(c.req.raw, "CF_Authorization");
  if (!team || !aud || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0]))) as { kid?: string; alg?: string };
    const claims = JSON.parse(new TextDecoder().decode(b64url(parts[1]))) as {
      aud?: string | string[]; email?: string; exp?: number; iss?: string;
    };
    if (header.alg !== "RS256") return null;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) return null;
    if (claims.iss !== `https://${team}`) return null;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    const jwk = (await accessKeys(team)).find((k) => (k as { kid?: string }).kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok || !claims.email) return null;
    const allowed = (c.env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(claims.email.toLowerCase())) return null;
    return claims.email;
  } catch {
    return null;
  }
}

// Which sign-in is active, for the Settings page (Access: log out via Cloudflare).
app.get("/api/auth/mode", async (c) => {
  const email = await accessEmail(c);
  return c.json(email ? { mode: "access", email } : { mode: "password" });
});

// Auth gate for the API (webhook is exempt; assets are public — they contain no data)
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/webhooks/plaid" || path === "/api/auth/login" || path === "/api/version") return next();
  if (await accessEmail(c)) return next();
  const cookie = getCookie(c.req.raw, SESSION_COOKIE);
  if (!cookie || !eq(cookie, await sessionToken(c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.route("/api", api);

// Everything else: static assets. SPA fallback for known client routes.
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404 && !url.pathname.includes(".")) {
    return c.env.ASSETS.fetch(new Request(new URL("/index.html", url).toString(), c.req.raw));
  }
  return res;
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await syncAll(env);
        const now = new Date();
        if (now.getUTCDate() === 1) {
          const month = now.toISOString().slice(0, 7);
          await rolloverBudgets(env, month);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
