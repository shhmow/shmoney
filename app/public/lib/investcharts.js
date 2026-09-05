// Invest-view charts: multi-series time line (portfolio vs benchmark) and an
// interactive, keyboard-accessible allocation donut. Vanilla SVG, demo
// palette, adapted from the approved chart style (kept separate from
// lib/charts.js on purpose — that file belongs to the shared views).

import { esc, fmtMoneyWhole, fmtPct } from "./format.js";

let UID = 0;

/* ---------- per-range change helpers (shared by invest + overview heroes) ---------- */

/**
 * Change over a visible window: first vs last point.
 * points: array of numbers or {value} objects. Returns
 * { first, last, change, pct } or null when fewer than 2 finite values.
 * pct is signed (matches change) and null when the window starts at 0.
 */
export function rangeDelta(points) {
  const vals = (points || [])
    .map((p) => Number(p && typeof p === "object" ? p.value : p))
    .filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const first = vals[0], last = vals[vals.length - 1];
  const change = last - first;
  const pct = first !== 0 ? (change / Math.abs(first)) * 100 : null;
  return { first, last, change, pct };
}

/**
 * Renders a rangeDelta as the standard hero badge:
 * "▲ $2,301 (+14.2%) <sub>past year</sub>" — colored via .delta.up/.down.
 * Returns "" for a null delta so callers can keep their fallback markup.
 */
export function deltaBadge(delta, subLabel) {
  if (!delta) return "";
  const subHtml = subLabel ? ` <span class="sub">${esc(subLabel)}</span>` : "";
  if (Math.round(delta.change) === 0) {
    return `<span class="sub">no change</span>${subHtml}`;
  }
  const up = delta.change > 0;
  const pctTxt = delta.pct == null ? "" : ` (${up ? "+" : ""}${fmtPct(delta.pct)})`;
  return `<span class="delta ${up ? "up" : "down"}">${up ? "&#9650;" : "&#9660;"} ` +
    `${fmtMoneyWhole(Math.abs(delta.change))}${pctTxt}</span>${subHtml}`;
}

/* ---------- tooltip (reuses the #tip element from index.html) ---------- */
function tipEl() {
  let t = document.getElementById("tip");
  if (!t) {
    t = document.createElement("div");
    t.id = "tip";
    document.body.appendChild(t);
  }
  return t;
}

export function showTip(x, y, label, valueHtml) {
  const tip = tipEl();
  tip.innerHTML = `<div class="t-l">${esc(label)}</div><div class="t-v">${valueHtml}</div>`;
  tip.style.display = "block";
  tip.style.left = Math.min(x + 14, window.innerWidth - 180) + "px";
  tip.style.top = (y - 14) + "px";
}

export function hideTip() {
  tipEl().style.display = "none";
}

function axisFmt(maxVal) {
  if (maxVal >= 10000) return (v) => (Math.round(v / 100) / 10) + "k";
  if (maxVal >= 2000) return (v) => (Math.round(v / 100) / 10) + "k";
  return (v) => String(Math.round(v));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDay(d) {
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, day || 1, 12).getTime();
}

/**
 * Multi-series time-scale line chart.
 * seriesList: [{ points: [{date:'YYYY-MM-DD', value}], color, label,
 *               fill?: bool, dash?: bool }]  (first series is primary)
 * Handles any data size: 0 total points -> cleared svg (caller shows an empty
 * state); a 1-point series renders as a flat line with a dot.
 *
 * opts.onRangeSelect(fromDate, toDate): additive. When provided, a horizontal
 * pointer drag on the chart draws a translucent selection band and, on
 * release, calls back with the selected 'YYYY-MM-DD' window (progressive
 * enhancement — pointer events cover mouse and touch; vertical touch scroll
 * still pans the page). The chart itself does not re-render; the caller
 * decides what a selection means.
 */
export function lineChart(svg, seriesList, opts = {}) {
  if (!svg) return;
  const series = (seriesList || [])
    .map((s) => ({
      ...s,
      pts: (s.points || [])
        .filter((p) => Number.isFinite(Number(p.value)))
        .map((p) => ({ t: parseDay(p.date), y: Number(p.value), date: p.date })),
    }))
    .filter((s) => s.pts.length > 0);
  if (series.length === 0) { svg.innerHTML = ""; return; }

  const vb = (svg.getAttribute("viewBox") || "0 0 900 220").split(" ").map(Number);
  const W = vb[2], H = vb[3];
  const P = { l: 56, r: 14, t: 14, b: 26 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;

  let tmin = Infinity, tmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of series) for (const p of s.pts) {
    if (p.t < tmin) tmin = p.t;
    if (p.t > tmax) tmax = p.t;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  if (tmin === tmax) { tmin -= 43200000; tmax += 43200000; }
  if (ymin === ymax) { ymin -= Math.max(1, Math.abs(ymin) * 0.02); ymax += Math.max(1, Math.abs(ymax) * 0.02); }
  else { const pad = (ymax - ymin) * 0.06; ymin -= pad; ymax += pad; }

  const X = (t) => P.l + iw * (t - tmin) / (tmax - tmin);
  const Y = (v) => P.t + ih * (1 - (v - ymin) / (ymax - ymin));
  const yf = opts.yFmt || axisFmt(ymax);

  let g = "";
  for (let t = 0; t <= 3; t++) {
    const y = P.t + ih * t / 3, v = ymax - (ymax - ymin) * t / 3;
    g += `<line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="#232927" stroke-width="1"/>
          <text x="${P.l - 8}" y="${y + 4}" text-anchor="end" fill="#69776e" font-size="10.5" font-family="IBM Plex Mono, monospace">${yf(v)}</text>`;
  }
  // x ticks: up to 7, month (+day when the span is short)
  const spanDays = (tmax - tmin) / 86400000;
  const ticks = Math.min(7, Math.max(2, Math.floor(iw / 90)));
  for (let i = 0; i <= ticks; i++) {
    const t = tmin + (tmax - tmin) * i / ticks;
    const d = new Date(t);
    const lb = spanDays <= 95 ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : MONTHS[d.getMonth()];
    const anchor = i === 0 ? "start" : i === ticks ? "end" : "middle";
    g += `<text x="${X(t)}" y="${H - 8}" text-anchor="${anchor}" fill="#69776e" font-size="10.5" font-family="IBM Plex Mono, monospace">${esc(lb)}</text>`;
  }

  let body = "";
  const defs = [];
  series.forEach((s, si) => {
    if (s.pts.length === 1) {
      const p = s.pts[0];
      body += `<line x1="${P.l}" y1="${Y(p.y)}" x2="${W - P.r}" y2="${Y(p.y)}" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ""}/>
               <circle cx="${X(p.t)}" cy="${Y(p.y)}" r="4.5" fill="${s.color}" stroke="#15181a" stroke-width="2"/>`;
      return;
    }
    const pts = s.pts.map((p) => `${X(p.t)},${Y(p.y)}`).join(" ");
    if (s.fill) {
      const gid = "ivg" + (++UID);
      defs.push(`<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${s.color}" stop-opacity=".26"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`);
      body += `<polygon points="${X(s.pts[0].t)},${P.t + ih} ${pts} ${X(s.pts[s.pts.length - 1].t)},${P.t + ih}" fill="url(#${gid})"/>`;
    }
    body += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${si === 0 ? 2 : 1.6}" ${s.dash ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round" ${si === 0 ? "" : 'opacity=".85"'}/>`;
  });

  svg.innerHTML = `<defs>${defs.join("")}</defs>${g}${body}
    <line class="hover-x" y1="${P.t}" y2="${P.t + ih}" stroke="#69776e" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
    ${series.map((s) => `<circle class="hover-dot" r="4" fill="${s.color}" stroke="#15181a" stroke-width="2" style="display:none"/>`).join("")}`;

  const xl = svg.querySelector(".hover-x");
  const dots = [...svg.querySelectorAll(".hover-dot")];
  const fmtV = opts.fmtValue || fmtMoneyWhole;

  const nearest = (s, t) => {
    let lo = 0, hi = s.pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s.pts[mid].t < t) lo = mid; else hi = mid;
    }
    return (t - s.pts[lo].t) <= (s.pts[hi].t - t) ? s.pts[lo] : s.pts[hi];
  };

  const drag = { on: false, band: null, x0: 0, moved: false };

  svg.onmousemove = (e) => {
    if (drag.on) return;
    const r = svg.getBoundingClientRect();
    const t = tmin + (tmax - tmin) * Math.max(0, Math.min(1, ((e.clientX - r.left) * W / r.width - P.l) / iw));
    const prim = nearest(series[0], t);
    xl.style.display = "block";
    xl.setAttribute("x1", X(prim.t)); xl.setAttribute("x2", X(prim.t));
    const rows = [];
    series.forEach((s, i) => {
      const p = nearest(s, prim.t);
      dots[i].style.display = "block";
      dots[i].setAttribute("cx", X(p.t)); dots[i].setAttribute("cy", Y(p.y));
      const val = s.fmtValue ? s.fmtValue(p.y) : fmtV(p.y);
      rows.push(series.length > 1
        ? `<span style="color:${s.color}">${esc(s.label || "")}</span> ${esc(val)}`
        : esc(val));
    });
    const d = new Date(prim.t);
    showTip(e.clientX, e.clientY, `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`, rows.join("<br>"));
  };
  svg.onmouseleave = () => {
    hideTip();
    xl.style.display = "none";
    dots.forEach((d) => { d.style.display = "none"; });
  };

  /* ---- drag-to-zoom selection band (additive; see opts.onRangeSelect) ---- */
  if (typeof opts.onRangeSelect === "function") {
    svg.style.touchAction = "pan-y"; // horizontal drag selects; vertical still scrolls
    const toVBX = (clientX) => {
      const r = svg.getBoundingClientRect();
      return Math.max(P.l, Math.min(W - P.r, (clientX - r.left) * W / r.width));
    };
    const tAtX = (x) => tmin + (tmax - tmin) * ((x - P.l) / iw);
    const isoAt = (t) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const clearBand = () => {
      if (drag.band) drag.band.remove();
      drag.band = null;
      drag.on = false;
      drag.moved = false;
    };
    svg.onpointerdown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      drag.on = true;
      drag.moved = false;
      drag.x0 = toVBX(e.clientX);
      try { svg.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    };
    svg.onpointermove = (e) => {
      if (!drag.on) return;
      const x1 = toVBX(e.clientX);
      if (!drag.moved && Math.abs(x1 - drag.x0) < 4) return; // ignore jitter / taps
      drag.moved = true;
      hideTip();
      xl.style.display = "none";
      dots.forEach((d) => { d.style.display = "none"; });
      if (!drag.band) {
        svg.insertAdjacentHTML("beforeend",
          `<rect class="sel-band" y="${P.t}" height="${ih}" fill="#3ecf8e" fill-opacity=".12" stroke="#3ecf8e" stroke-opacity=".45" stroke-width="1" pointer-events="none"/>`);
        drag.band = svg.querySelector(".sel-band");
      }
      drag.band.setAttribute("x", Math.min(drag.x0, x1));
      drag.band.setAttribute("width", Math.abs(x1 - drag.x0));
    };
    svg.onpointerup = (e) => {
      if (!drag.on) return;
      const x1 = toVBX(e.clientX);
      const moved = drag.moved && Math.abs(x1 - drag.x0) >= 8;
      const t0 = tAtX(Math.min(drag.x0, x1)), t1 = tAtX(Math.max(drag.x0, x1));
      clearBand();
      if (moved && t1 - t0 >= 86400000) opts.onRangeSelect(isoAt(t0), isoAt(t1));
    };
    svg.onpointercancel = clearBand;
  }
}

/**
 * Interactive donut. segs: [{key, pct, color, label, value}].
 * opts: { selectedKey, onSelect(key|null), center: {big, unit, small} }
 * Segments are buttons: click / Enter / Space select (toggle).
 */
export function donutChart(svg, segs, opts = {}) {
  if (!svg) return;
  const clean = (segs || []).filter((s) => (s.pct || 0) > 0.4);
  if (clean.length === 0) { svg.innerHTML = ""; return; }
  const cx = 75, cy = 75, r = 56, sw = 22;
  const sel = opts.selectedKey ?? null;
  let s = "";
  const segAttrs = (seg) =>
    `class="iv-seg${sel && sel !== seg.key ? " dim" : ""}${sel === seg.key ? " on" : ""}" tabindex="0" role="button" ` +
    `aria-pressed="${sel === seg.key}" aria-label="${esc(seg.label)}: ${Math.round(seg.pct)} percent. Activate for details." ` +
    `data-seg="${esc(seg.key)}" data-tt="${esc(seg.label)}" data-tv="${Math.round(seg.pct)}%"`;
  if (clean.length === 1) {
    const one = clean[0];
    s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${one.color}" stroke-width="${sw}" ${segAttrs(one)}/>`;
  } else {
    let a = -90;
    clean.forEach((seg) => {
      const span = seg.pct * 3.6;
      const gap = Math.min(2.2, span * 0.3);
      const a2 = a + span - gap;
      const rad = (d) => d * Math.PI / 180;
      const x1 = cx + r * Math.cos(rad(a)), y1 = cy + r * Math.sin(rad(a));
      const x2 = cx + r * Math.cos(rad(a2)), y2 = cy + r * Math.sin(rad(a2));
      s += `<path d="M${x1},${y1} A${r},${r} 0 ${(span - gap) > 180 ? 1 : 0} 1 ${x2},${y2}" fill="none" stroke="${seg.color}" stroke-width="${sw}" stroke-linecap="butt" ${segAttrs(seg)}/>`;
      a = a2 + gap;
    });
  }
  const center = opts.center || {};
  if (center.big != null) {
    s += `<text x="${cx}" y="${cy + 1}" text-anchor="middle" fill="#eef2ef" font-weight="800" font-size="20" font-family="Schibsted Grotesk, sans-serif" pointer-events="none">${esc(center.big)}<tspan font-size="12" fill="#69776e">${esc(center.unit || "")}</tspan></text>`;
  }
  if (center.small) {
    s += `<text x="${cx}" y="${cy + 17}" text-anchor="middle" fill="#69776e" font-size="9.5" font-family="IBM Plex Mono, monospace" pointer-events="none">${esc(center.small)}</text>`;
  }
  svg.innerHTML = s;
  svg.querySelectorAll(".iv-seg").forEach((el) => {
    el.addEventListener("mousemove", (e) => showTip(e.clientX, e.clientY, el.dataset.tt, esc(el.dataset.tv)));
    el.addEventListener("mouseleave", hideTip);
    const activate = () => {
      hideTip();
      if (opts.onSelect) opts.onSelect(el.dataset.seg === sel ? null : el.dataset.seg);
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });
  });
}

/** Horizontal bar row with an optional benchmark tick. Returns HTML. */
export function hbar(pct, color, benchmarkPct = null, max = 100) {
  const w = Math.max(0, Math.min(100, (pct / max) * 100));
  const tick = benchmarkPct !== null && benchmarkPct !== undefined
    ? `<i class="iv-tick" style="left:${Math.max(0, Math.min(100, (benchmarkPct / max) * 100))}%"></i>`
    : "";
  return `<div class="iv-hbar"><div class="iv-hfill" style="width:${w}%;background:${color}"></div>${tick}</div>`;
}
