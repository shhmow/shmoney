// Shared formatting + tiny HTML helpers. No emojis anywhere; U+2212 for minus.

const MINUS = "−";
const MID = "·"; // middle dot

export { MINUS, MID };

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function group(n, cents) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

/** $1,234.56 — negatives as −$1,234.56 (U+2212). */
export function fmtMoney(n, { cents = true } = {}) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  return (v < 0 ? MINUS : "") + "$" + group(abs, cents);
}

/** Whole dollars: $1,235 / −$1,235 */
export function fmtMoneyWhole(n) {
  return fmtMoney(Math.round(Number(n) || 0), { cents: false });
}

/** Explicit sign: +$12.00 / −$12.00 */
export function fmtSigned(n, opts) {
  const v = Number(n) || 0;
  return (v >= 0 ? "+" : "") + fmtMoney(v, opts);
}

/** Transaction amount (Plaid sign: positive = outflow) -> display string + class. */
export function txnAmount(amount) {
  const v = Number(amount) || 0;
  if (v < 0) return { text: "+" + fmtMoney(Math.abs(v)), cls: "amt in" };
  return { text: MINUS + fmtMoney(v).replace(MINUS, ""), cls: "amt" };
}

export function fmtPct(n, digits = 1) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toFixed(digits).replace(new RegExp("\\.0{" + digits + "}$"), "");
  return (v < 0 ? MINUS : "") + s + "%";
}

/** Merchant-initial tile: first letters of first two words, else first two letters. */
export function initials(name) {
  const clean = String(name || "").trim();
  if (!clean) return "?";
  const words = clean.split(/\s+/).filter(Boolean);
  const s = words.length >= 2
    ? words[0][0] + words[1][0]
    : clean.slice(0, 2);
  return s.toUpperCase();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseDate(d) {
  // 'YYYY-MM-DD' -> local Date at noon (avoids TZ off-by-one)
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, day || 1, 12);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function currentMonth() {
  return todayStr().slice(0, 7);
}

/** 'YYYY-MM' +/- n months */
export function shiftMonth(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1, 12);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthShort(month) {
  const m = Number(String(month).slice(5, 7));
  return MONTHS[(m - 1 + 12) % 12] || "";
}

export function monthLabel(month) {
  return `${monthShort(month)} ${String(month).slice(0, 4)}`;
}

export function daysInMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** 'Aug 22' (with year if not current year) */
export function fmtDate(d) {
  const dt = parseDate(d);
  const now = new Date();
  const base = `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
  return dt.getFullYear() === now.getFullYear() ? base : `${base}, ${dt.getFullYear()}`;
}

/** Date group heading: 'Today · Aug 25' / 'Yesterday · Aug 24' / 'Aug 22' */
export function dateHead(d) {
  const t = todayStr();
  if (d === t) return `Today ${MID} ${fmtDate(d)}`;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const ys = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  if (d === ys) return `Yesterday ${MID} ${fmtDate(d)}`;
  return fmtDate(d);
}

export function fmtTimeAgo(iso) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Category color token ('c1'…) or hex -> CSS color. */
export function catColor(c) {
  if (!c) return "var(--muted)";
  const s = String(c);
  if (s.startsWith("#")) return s;
  if (/^(c[1-9]|series|accent|good|warn|crit|muted)$/.test(s)) return `var(--${s})`;
  return "var(--muted)";
}

export function catChip(name, color) {
  if (!name) return `<span class="catchip"><i style="background:var(--muted)"></i>Uncategorized</span>`;
  return `<span class="catchip"><i style="background:${catColor(color)}"></i>${esc(name)}</span>`;
}

/** Designed empty state card body. */
export function emptyState({ title, body, actionLabel, actionHash, glyph = "coins" } = {}) {
  const glyphs = {
    coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="6"/><path d="M15.5 5.6a6 6 0 11-6.9 9.8"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 3 6-7 3 3"/><path d="M3 21h18"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    flow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 17c4 0 4-10 8-10s4 10 8 10"/><path d="M3 7h2M19 17h2"/></svg>',
    bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 19V9m5 10V5m5 14v-7m5 7V11"/></svg>',
    loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 3v4h-4"/></svg>',
  };
  const action = actionLabel
    ? `<a class="btn primary" style="text-decoration:none;display:inline-block" href="${esc(actionHash || "#/settings")}">${esc(actionLabel)}</a>`
    : "";
  return `<div class="empty">
    <div class="glyph">${glyphs[glyph] || glyphs.coins}</div>
    <h2>${esc(title || "Nothing here yet")}</h2>
    <p>${esc(body || "")}</p>
    ${action}
  </div>`;
}

export function errorCard(err) {
  return `<div class="card"><div class="empty">
    <h2>Something went wrong</h2>
    <p>${esc(err && err.message ? err.message : "Request failed")}</p>
    <button class="btn" onclick="location.reload()">Reload</button>
  </div></div>`;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
