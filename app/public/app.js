// shmoney SPA shell: nav, hash router, service worker, Plaid OAuth resume.
import "./lib/api.js";
import { resumeOauthIfNeeded } from "./views/settings.js";

const PAGES = [
  ["overview", "Overview", "M3 12l9-8 9 8M5 10v9h5v-5h4v5h5v-9"],
  ["activity", "Activity", "M4 6h16M4 12h16M4 18h10"],
  ["cashflow", "Cash flow", "M3 17c4 0 4-10 8-10s4 10 8 10M3 7h2M19 17h2"],
  ["budget", "Budget", "M4 19V9m5 10V5m5 14v-7m5 7V11"],
  ["invest", "Invest", "M3 17l5-5 4 3 6-7 3 3M14 8h4v4"],
  ["taxes", "Taxes", "M19 5L5 19M7.2 4.2a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2zM16.8 14.6a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z"],
  ["recurring", "Recurring", "M20 12a8 8 0 11-2.3-5.6M20 3v4h-4"],
  ["settings", "Settings", "M12 8a4 4 0 100 8 4 4 0 000-8zm8 4h1M3 12h1m8-9v1m0 16v1m6.4-15.4l-.7.7M5.3 18.7l-.7.7m14.1 0l-.7-.7M5.3 5.3l-.7-.7"],
];

const ROUTES = {
  overview: () => import("./views/overview.js"),
  activity: () => import("./views/activity.js"),
  cashflow: () => import("./views/cashflow.js"),
  budget: () => import("./views/budget.js"),
  invest: () => import("./views/invest.js"),
  taxes: () => import("./views/taxes.js"),
  recurring: () => import("./views/recurring.js"),
  settings: () => import("./views/settings.js"),
};

function icon(d) {
  return `<svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
}

function buildNav() {
  const side = document.getElementById("nav-side");
  const bottom = document.getElementById("nav-bottom");
  side.innerHTML = `<div class="wordmark">shmoney<span>.</span></div>` +
    PAGES.map(([id, label, d]) =>
      `<button type="button" class="navbtn" data-nav="${id}">${icon(d)}${label}</button>`).join("");
  // Mobile bottom bar: all tabs, horizontally scrollable
  bottom.innerHTML = PAGES.map(([id, label, d]) =>
    `<button type="button" class="navbtn" data-nav="${id}" style="flex:1">${icon(d)}${label}</button>`).join("");
  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => { location.hash = "#/" + b.dataset.nav; }));
}

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "").split("?")[0];
  return ROUTES[h] ? h : "overview";
}

function skeletonPage() {
  return `<div class="page" aria-busy="true">
    <div class="skel" style="height:110px;margin-bottom:14px"></div>
    <div class="skel" style="height:260px;margin-bottom:14px"></div>
    <div class="skel" style="height:180px"></div>
  </div>`;
}

let renderToken = 0;

async function renderRoute() {
  const name = currentRoute();
  const token = ++renderToken;
  document.querySelectorAll("[data-nav]").forEach((x) =>
    x.classList.toggle("active", x.dataset.nav === name));
  // close any overlay left open by the previous view (slide-over, modal)
  document.querySelectorAll("#txn-sheet-wrap, .modal-backdrop").forEach((el) => el.remove());
  const main = document.getElementById("view");
  main.innerHTML = skeletonPage();
  window.scrollTo({ top: 0 });
  try {
    const mod = await ROUTES[name]();
    if (token !== renderToken) return; // user navigated away
    await mod.default(main, { stale: () => token !== renderToken });
  } catch (err) {
    if (token !== renderToken) return;
    main.innerHTML = `<div class="page"><div class="card"><div class="empty">
      <h2>Failed to load</h2><p>${(err && err.message) || "Unexpected error"}</p>
      <button class="btn" onclick="location.reload()">Reload</button></div></div></div>`;
  }
}

function registerSW() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
}

async function boot() {
  buildNav();
  registerSW();
  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("shmoney:refresh", renderRoute);
  // Plaid OAuth redirect resume (must run before first route render)
  try { await resumeOauthIfNeeded(); } catch { /* non-fatal */ }
  if (!location.hash) history.replaceState({}, "", "/#/overview");
  renderRoute();
}

boot();
