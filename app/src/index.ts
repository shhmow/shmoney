import { Hono } from "hono";
import type { Env } from "./types";
import { api } from "./api";
import { syncAll } from "./sync";
import { rolloverBudgets } from "./sync/rollover";

const app = new Hono<{ Bindings: Env }>();

const BUILD_TAG = "2026-08-26-quotes-1";

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

// Public, dataless: which worker build is actually serving traffic.
app.get("/api/version", (c) => c.json({ build: BUILD_TAG }));

app.post("/api/auth/logout", (c) => {
  c.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return c.json({ ok: true });
});

// Auth gate for the API (webhook is exempt; assets are public — they contain no data)
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/webhooks/plaid" || path === "/api/auth/login" || path === "/api/version") return next();
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
