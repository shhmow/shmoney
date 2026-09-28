// shmoney service worker.
// Network-first for all same-origin assets (deploys arrive immediately; cache
// is the offline fallback). Cache-first only for fonts (immutable). NEVER
// touches /api/*. Bump CACHE on strategy changes.
const CACHE = "shmoney-v7";
const PRECACHE = [
  "/",
  "/styles.css",
  "/invest.css",
  "/budget.css",
  "/app.js",
  "/icon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/manifest.json",
  "/lib/api.js",
  "/lib/format.js",
  "/lib/charts.js",
  "/lib/investcharts.js",
  "/lib/brand.js",
  "/views/taxes.js",
  "/views/overview.js",
  "/views/activity.js",
  "/views/cashflow.js",
  "/views/budget.js",
  "/views/invest.js",
  "/views/recurring.js",
  "/views/settings.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept the API.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin && !isFont) return;

  // Fonts: cache-first (they never change).
  if (isFont) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // Everything same-origin: network-first, cache fallback (offline support).
  const cacheKey = req.mode === "navigate" || !url.pathname.includes(".") ? "/" : req;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(cacheKey, copy));
        }
        return res;
      })
      .catch(() => caches.match(cacheKey))
  );
});
