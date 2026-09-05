// Vanilla SVG charts, adapted from the approved design demo.
// All charts paint onto an existing <svg> element and use the demo palette.

import { fmtMoneyWhole, fmtMoney, esc } from "./format.js";

let UID = 0;

/* ---------- shared tooltip ---------- */
function tipEl() {
  let t = document.getElementById("tip");
  if (!t) {
    t = document.createElement("div");
    t.id = "tip";
    document.body.appendChild(t);
  }
  return t;
}

export function showTip(x, y, label, value) {
  const tip = tipEl();
  tip.innerHTML = `<div class="t-l">${esc(label)}</div><div class="t-v">${esc(value)}</div>`;
  tip.style.display = "block";
  tip.style.left = Math.min(x + 14, window.innerWidth - 160) + "px";
  tip.style.top = (y - 14) + "px";
}

export function hideTip() {
  tipEl().style.display = "none";
}

function wireDataTips(svg) {
  svg.querySelectorAll("[data-tt]").forEach((b) => {
    b.addEventListener("mousemove", (e) => showTip(e.clientX, e.clientY, b.dataset.tt, b.dataset.tv));
    b.addEventListener("mouseleave", hideTip);
  });
}

function axisFmt(maxVal) {
  if (maxVal >= 100000) return (v) => Math.round(v / 1000) + "k";
  if (maxVal >= 10000) return (v) => (Math.round(v / 100) / 10) + "k";
  if (maxVal >= 2000) return (v) => (Math.round(v / 100) / 10) + "k";
  return (v) => String(Math.round(v));
}

/* palette tokens (mirrors styles.css) so SVG gradients get concrete colors */
const TOKEN_COLORS = {
  c1: "#1fa168", c2: "#b58a2e", c3: "#4a80c4", c4: "#b4628e",
  series: "#1fa168", accent: "#3ecf8e", good: "#0ca30c", warn: "#fab219",
  crit: "#d03b3b", muted: "#69776e",
};
function tokenColor(c, fallback) {
  const s = String(c || "");
  if (s.startsWith("#")) return s;
  return TOKEN_COLORS[s] || fallback;
}

/** Centered muted message inside an empty chart area. */
function chartMessage(svg, text) {
  const vb = (svg.getAttribute("viewBox") || "0 0 900 240").split(" ").map(Number);
  svg.innerHTML = `<text x="${vb[2] / 2}" y="${vb[3] / 2 + 4}" text-anchor="middle" fill="#69776e"
    font-size="13" font-family="Schibsted Grotesk, sans-serif">${esc(text)}</text>`;
}

/**
 * Narrow screens: a 900-unit viewBox squeezed into ~300px renders 12px text at
 * 4px. Re-base the viewBox width on the container so text scales with the
 * device instead (height kept proportional to the original aspect, min 160).
 */
export function fitViewBox(svg, baseW, baseH) {
  const w = svg.parentElement ? svg.parentElement.clientWidth : 0;
  if (w > 0 && w < baseW * 0.75) {
    const scaledH = Math.max(160, Math.round(baseH * Math.max(0.55, w / baseW) * 1.15));
    svg.setAttribute("viewBox", `0 0 ${Math.round(w)} ${scaledH}`);
  } else if (svg.dataset.baseVb) {
    svg.setAttribute("viewBox", svg.dataset.baseVb);
  }
}

/* ---------- area chart with crosshair + dot on hover ---------- */
export function areaChart(svg, data, labels, color = "#1fa168", opts = {}) {
  if (!svg) return;
  if (!svg.dataset.baseVb) svg.dataset.baseVb = svg.getAttribute("viewBox") || "0 0 900 240";
  { const b = svg.dataset.baseVb.split(" ").map(Number); fitViewBox(svg, b[2], b[3]); }
  if (!data || data.length === 0) { chartMessage(svg, "No history yet"); return; }
  const single = data.length === 1;
  if (single) { data = [data[0], data[0]]; labels = [labels[0] || "", labels[0] || ""]; }
  const vb = (svg.getAttribute("viewBox") || "0 0 900 240").split(" ").map(Number);
  const W = vb[2], H = vb[3];
  const P = { l: 56, r: 14, t: 14, b: 26 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  let min = Math.min(...data), max = Math.max(...data);
  if (min === max) { min -= 1; max += 1; } else { min *= min > 0 ? 0.985 : 1.015; max *= max > 0 ? 1.01 : 0.99; }
  const X = (i) => P.l + iw * i / (data.length - 1);
  const Y = (v) => P.t + ih * (1 - (v - min) / (max - min));
  const yf = opts.yFmt || axisFmt(max);
  let g = "";
  for (let t = 0; t <= 3; t++) {
    const y = P.t + ih * t / 3, v = max - (max - min) * t / 3;
    g += `<line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="#232927" stroke-width="1"/>
          <text x="${P.l - 8}" y="${y + 4}" text-anchor="end" fill="#69776e" font-size="10.5" font-family="IBM Plex Mono, monospace">${yf(v)}</text>`;
  }
  const step = Math.max(1, Math.round(data.length / 8));
  labels.forEach((lb, i) => {
    if ((i % step === 0 && i <= labels.length - 1 - step * 0.6) || i === labels.length - 1) {
      g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" fill="#69776e" font-size="10.5" font-family="IBM Plex Mono, monospace">${esc(lb)}</text>`;
    }
  });
  const pts = data.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const gid = "ac-g" + (++UID);
  svg.innerHTML = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${g}
    <polygon points="${P.l},${P.t + ih} ${pts} ${W - P.r},${P.t + ih}" fill="url(#${gid})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <circle class="hover-dot" r="4.5" fill="${color}" stroke="#15181a" stroke-width="2" style="display:none"/>
    <line class="hover-x" y1="${P.t}" y2="${P.t + ih}" stroke="#69776e" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>`;
  const dot = svg.querySelector(".hover-dot"), xl = svg.querySelector(".hover-x");
  const fmtV = opts.fmtValue || fmtMoneyWhole;
  if (single) {
    // one data point: flat line already drawn; add a fixed endpoint dot + value label
    const lx = X(data.length - 1), ly = Y(data[0]);
    svg.insertAdjacentHTML("beforeend",
      `<circle cx="${lx}" cy="${ly}" r="4.5" fill="${color}" stroke="#15181a" stroke-width="2"/>
       <text x="${lx - 10}" y="${Math.max(14, ly - 10)}" text-anchor="end" fill="#eef2ef" font-size="11.5"
         font-weight="600" font-family="Schibsted Grotesk, sans-serif">${fmtV(data[0])}</text>`);
  }
  svg.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(data.length - 1, Math.round((mx - P.l) / iw * (data.length - 1))));
    dot.style.display = "block"; dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(data[i]));
    xl.style.display = "block"; xl.setAttribute("x1", X(i)); xl.setAttribute("x2", X(i));
    showTip(e.clientX, e.clientY, labels[i] || "", fmtV(data[i]));
  };
  svg.onmouseleave = () => { hideTip(); dot.style.display = "none"; xl.style.display = "none"; };
}

/* ---------- grouped gradient bars (income vs spending) ---------- */
export function groupedBars(svg, labels, seriesA, seriesB, opts = {}) {
  if (!svg) return;
  if (!svg.dataset.baseVb) svg.dataset.baseVb = svg.getAttribute("viewBox") || "0 0 440 200";
  { const b = svg.dataset.baseVb.split(" ").map(Number); fitViewBox(svg, b[2], b[3]); }
  if (!labels || labels.length === 0) { chartMessage(svg, "No history yet"); return; }
  const vb = (svg.getAttribute("viewBox") || "0 0 440 200").split(" ").map(Number);
  const W = vb[2], H = vb[3];
  const P = { l: 44, r: 8, t: 12, b: 24 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const aName = opts.aName || "Income", bName = opts.bName || "Spending";
  const aColor = opts.aColor || "#1fa168", bColor = opts.bColor || "#b58a2e";
  const rawMax = Math.max(1, ...seriesA.map((v) => v || 0), ...seriesB.map((v) => v || 0));
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const max = Math.ceil(rawMax * 1.1 / mag) * mag;
  const Y = (v) => P.t + ih * (1 - v / max);
  const yf = axisFmt(max);
  const idA = "gb-a" + (++UID), idB = "gb-b" + UID;
  let s = `<defs>
    <linearGradient id="${idA}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${aColor}" stop-opacity=".9"/><stop offset="1" stop-color="${aColor}" stop-opacity=".22"/></linearGradient>
    <linearGradient id="${idB}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bColor}" stop-opacity=".9"/><stop offset="1" stop-color="${bColor}" stop-opacity=".22"/></linearGradient>
  </defs>`;
  for (let t = 0; t <= 2; t++) {
    const y = P.t + ih * t / 2, v = max * (1 - t / 2);
    s += `<line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="#232927"/>
          <text x="${P.l - 6}" y="${y + 4}" text-anchor="end" fill="#69776e" font-size="10" font-family="IBM Plex Mono, monospace">${yf(v)}</text>`;
  }
  const gw = iw / labels.length, bw = Math.min(13, gw / 2 - 3);
  labels.forEach((m, i) => {
    const cx = P.l + gw * i + gw / 2;
    [[seriesA[i] || 0, `url(#${idA})`, -bw - 1, aName], [seriesB[i] || 0, `url(#${idB})`, 1, bName]].forEach(([v, c, off, name]) => {
      const y = Y(v), h = Math.max(0, P.t + ih - y);
      if (h > 4) {
        s += `<path d="M${cx + off},${y + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} h-${bw} z" fill="${c}" data-tt="${esc(m)} · ${esc(name)}" data-tv="${fmtMoneyWhole(v)}"/>`;
      } else if (h > 0) {
        s += `<rect x="${cx + off}" y="${y}" width="${bw}" height="${h}" fill="${c}" data-tt="${esc(m)} · ${esc(name)}" data-tv="${fmtMoneyWhole(v)}"/>`;
      }
    });
    s += `<text x="${cx}" y="${H - 6}" text-anchor="middle" fill="#69776e" font-size="10.5" font-family="IBM Plex Mono, monospace">${esc(m)}</text>`;
  });
  svg.innerHTML = s;
  wireDataTips(svg);
}

/* ---------- free-to-spend pace chart ---------- */
export function paceChart(svg, { actual, budget, days, today, currentLabel }) {
  if (!svg) return;
  if (!actual || actual.length === 0 || !(budget > 0)) { svg.innerHTML = ""; return; }
  const vb = (svg.getAttribute("viewBox") || "0 0 380 110").split(" ").map(Number);
  const W = vb[2], H = vb[3];
  const P = { l: 8, r: 8, t: 12, b: 18 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const maxY = Math.max(budget, ...actual) * 1.02;
  const X = (d) => P.l + iw * d / days;
  const Y = (v) => P.t + ih * (1 - v / maxY);
  const pts = actual.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const spent = actual[actual.length - 1] || 0;
  const over = spent > budget * today / days;
  const col = over ? "#b58a2e" : "#1fa168";
  const gid = "pg" + (++UID);
  const lastX = X(actual.length - 1), lastY = Y(spent);
  svg.innerHTML = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${col}" stop-opacity=".22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${X(0)}" y1="${Y(0)}" x2="${X(days)}" y2="${Y(budget)}" stroke="#69776e" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${X(days) - 4}" y="${Y(budget) + 12}" text-anchor="end" fill="#69776e" font-size="10" font-family="IBM Plex Mono, monospace">even pace to ${fmtMoneyWhole(budget)}</text>
    <polygon points="${X(0)},${Y(0)} ${pts} ${lastX},${Y(0)}" fill="url(#${gid})"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${lastX}" cy="${lastY}" r="4" fill="${col}" stroke="#15181a" stroke-width="2"/>
    <text x="${lastX - 8}" y="${Math.max(12, lastY - 8)}" text-anchor="end" fill="#eef2ef" font-size="11" font-weight="600" font-family="Schibsted Grotesk, sans-serif">${currentLabel || fmtMoneyWhole(spent)}</text>`;
}

/* ---------- donut with gaps ---------- */
export function donut(svg, segs, center = {}) {
  if (!svg) return;
  const clean = (segs || []).filter((s) => (s.pct || 0) > 0.4);
  if (clean.length === 0) { svg.innerHTML = ""; return; }
  const cx = 75, cy = 75, r = 56, sw = 22;
  let s = "";
  if (clean.length === 1) {
    const one = clean[0];
    s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${one.color}" stroke-width="${sw}" data-tt="${esc(one.label)}" data-tv="${Math.round(one.pct)}%"/>`;
  } else {
    let a = -90;
    clean.forEach((seg) => {
      const span = seg.pct * 3.6;
      const gap = Math.min(2.2, span * 0.3);
      const a2 = a + span - gap;
      const rad = (d) => d * Math.PI / 180;
      const x1 = cx + r * Math.cos(rad(a)), y1 = cy + r * Math.sin(rad(a));
      const x2 = cx + r * Math.cos(rad(a2)), y2 = cy + r * Math.sin(rad(a2));
      s += `<path d="M${x1},${y1} A${r},${r} 0 ${(span - gap) > 180 ? 1 : 0} 1 ${x2},${y2}" fill="none" stroke="${seg.color}" stroke-width="${sw}" stroke-linecap="butt" data-tt="${esc(seg.label)}" data-tv="${Math.round(seg.pct)}%"/>`;
      a = a2 + gap;
    });
  }
  if (center.big != null) {
    s += `<text x="${cx}" y="${cy + 1}" text-anchor="middle" fill="#eef2ef" font-weight="800" font-size="20" font-family="Schibsted Grotesk, sans-serif">${esc(center.big)}<tspan font-size="12" fill="#69776e">${esc(center.unit || "")}</tspan></text>`;
  }
  if (center.small) {
    s += `<text x="${cx}" y="${cy + 17}" text-anchor="middle" fill="#69776e" font-size="9.5" font-family="IBM Plex Mono, monospace">${esc(center.small)}</text>`;
  }
  svg.innerHTML = s;
  wireDataTips(svg);
}

/* ---------- sankey: 3-column layout from {nodes, links} ---------- */
// Accepts nodes as [{id?, name|label, value?}] and links as [{source, target, value}]
// where source/target may be an array index, an id, or a name. Column assignment:
// sources-only -> col 0, both -> col 1, targets-only -> col 2.
export function sankey(svg, data, opts) {
  if (!svg) return false;
  const nodesIn = (data && data.nodes) || [];
  const linksIn = (data && data.links) || [];
  if (!nodesIn.length || !linksIn.length) { svg.innerHTML = ""; return false; }

  const W = 900, H = 330;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const nodes = nodesIn.map((n, i) => ({
    idx: i,
    id: n.id !== undefined ? n.id : (n.name ?? n.label ?? i),
    label: String(n.label ?? n.name ?? n.id ?? i),
    declared: Number(n.value) || 0,
    pct: n.pct,
    color: n.color || null,
    in: 0, out: 0,
  }));
  const byKey = new Map();
  nodes.forEach((n) => { byKey.set(String(n.id), n); byKey.set(String(n.label), n); });
  const resolve = (x) => {
    if (typeof x === "number" && nodes[x]) return nodes[x];
    if (x && typeof x === "object") return resolve(x.id ?? x.name ?? x.label);
    return byKey.get(String(x));
  };
  const links = [];
  for (const l of linksIn) {
    const s = resolve(l.source), t = resolve(l.target);
    const v = Number(l.value) || 0;
    if (!s || !t || s === t || v <= 0) continue;
    s.out += v; t.in += v;
    links.push({ s, t, v });
  }
  if (!links.length) { svg.innerHTML = ""; return false; }

  nodes.forEach((n) => {
    n.val = Math.max(n.in, n.out, n.declared);
    n.col = n.out > 0 && n.in === 0 ? 0 : (n.in > 0 && n.out > 0 ? 1 : 2);
  });
  const cols = [[], [], []];
  nodes.filter((n) => n.val > 0).forEach((n) => cols[n.col].push(n));
  if (!cols[0].length || !cols[2].length) { svg.innerHTML = ""; return false; }

  // vertical scale: consistent across columns
  const padT = 30, padB = 16, gap = 10;
  let scale = Infinity;
  cols.forEach((col) => {
    if (!col.length) return;
    const total = col.reduce((a, n) => a + n.val, 0);
    const usable = H - padT - padB - gap * (col.length - 1);
    scale = Math.min(scale, usable / Math.max(total, 1));
  });
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const xs = [30, 445, 860];
  const NW = 10;
  cols.forEach((col, ci) => {
    const totalH = col.reduce((a, n) => a + Math.max(3, n.val * scale), 0) + gap * (col.length - 1);
    let y = Math.max(padT, (H - totalH) / 2);
    col.forEach((n) => {
      n.x = xs[ci];
      n.y = y;
      n.h = Math.max(3, n.val * scale);
      n.inOff = 0; n.outOff = 0;
      y += n.h + gap;
    });
  });

  const isSaved = (n) => /sav|keep/i.test(n.label);
  const GREEN = "#1fa168";
  // percent of total income (left column total)
  const totalIn = cols[0].reduce((a, n) => a + n.val, 0);
  const pctTxt = (v) => {
    if (!(totalIn > 0)) return "";
    return ` (${(v / totalIn * 100).toFixed(1)}%)`;
  };
  const valLabel = (n) => fmtMoneyWhole(n.val) + pctTxt(n.val);
  // resolved fill color for a right-column node
  const nodeColor = (n) => {
    if (isSaved(n)) return GREEN;
    if (n.color) return tokenColor(n.color, "#566360");
    return /other|uncategor/i.test(n.label) ? "#69776e" : "#566360";
  };

  // ribbons: each gets its own gradient — solid near the category node,
  // fading to ~.15 opacity mid-ribbon, so colors glow against the dark bg.
  const ordered = links.slice().sort((a, b) =>
    (a.s.col - b.s.col) || ((a.s.col === 1 ? a.t.y - b.t.y : a.s.y - b.s.y)));
  let defs = "<defs>";
  let ribbons = "";
  ordered.forEach((l, k) => {
    const h = l.v * scale;
    const sx = l.s.x + NW, tx = l.t.x;
    const sy0 = l.s.y + l.s.outOff, sy1 = sy0 + h; l.s.outOff += h;
    const ty0 = l.t.y + l.t.inOff, ty1 = ty0 + h; l.t.inOff += h;
    const c1 = sx + (tx - sx) * 0.45, c2 = sx + (tx - sx) * 0.55;
    const fromIncome = l.s.col === 0;
    const color = fromIncome || isSaved(l.t) ? GREEN : nodeColor(l.t);
    // income ribbons: solid at the income node (left); spend/saved: solid at the category node (right)
    const [o0, o1] = fromIncome ? [".6", ".15"] : [".15", ".6"];
    const gid = `rib${UID + 1}-${k}`;
    defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${color}" stop-opacity="${o0}"/>
      <stop offset="1" stop-color="${color}" stop-opacity="${o1}"/>
    </linearGradient>`;
    ribbons += `<path d="M${sx},${sy0} C${c1},${sy0} ${c2},${ty0} ${tx},${ty0} L${tx},${ty1} C${c2},${ty1} ${c1},${sy1} ${sx},${sy1} Z" fill="url(#${gid})" data-tt="${esc(l.s.label)} → ${esc(l.t.label)}" data-tv="${fmtMoneyWhole(l.v)}"/>`;
  });
  UID++;
  defs += "</defs>";
  let out = defs + ribbons;

  // nodes + labels: every node shows "$amount (xx.x%)" of total income
  let labels = `<g font-size="12.5" font-family="Schibsted Grotesk, sans-serif">`;
  cols[0].forEach((n) => {
    out += `<rect x="${n.x}" y="${n.y}" width="${NW}" height="${n.h}" rx="3" fill="${GREEN}"/>`;
    const my = n.y + n.h / 2;
    labels += `<text x="${n.x + 18}" y="${my - 1}" fill="#eef2ef" font-weight="600">${esc(n.label)}</text>
      <text x="${n.x + 18}" y="${my + 15}" fill="#69776e" font-family="IBM Plex Mono, monospace" font-size="11">${valLabel(n)}</text>`;
  });
  cols[1].forEach((n) => {
    out += `<rect x="${n.x}" y="${n.y}" width="${NW}" height="${n.h}" rx="3" fill="#9fb0a6"/>`;
    labels += `<text x="${n.x + NW / 2}" y="${Math.max(12, n.y - 20)}" fill="#eef2ef" font-weight="700" text-anchor="middle">${esc(n.label)}</text>
      <text x="${n.x + NW / 2}" y="${Math.max(26, n.y - 6)}" fill="#69776e" font-family="IBM Plex Mono, monospace" font-size="11" text-anchor="middle">${valLabel(n)}</text>`;
  });
  cols[2].forEach((n) => {
    const saved = isSaved(n);
    const fill = nodeColor(n);
    out += `<rect x="${n.x}" y="${n.y}" width="${NW}" height="${n.h}" rx="${Math.min(3, n.h / 2)}" fill="${fill}"/>`;
    const ink = saved ? "#3ecf8e" : "#eef2ef";
    const sub = saved ? "#3ecf8e" : "#69776e";
    const my = n.y + n.h / 2;
    if (n.h >= 30) {
      labels += `<text x="${n.x - 8}" y="${my - 1}" text-anchor="end" fill="${ink}" font-weight="600">${esc(n.label)}</text>
        <text x="${n.x - 8}" y="${my + 15}" text-anchor="end" fill="${sub}" font-family="IBM Plex Mono, monospace" font-size="11">${valLabel(n)}</text>`;
    } else {
      labels += `<text x="${n.x - 8}" y="${my + 4}" text-anchor="end" fill="${ink}" font-weight="600">${esc(n.label)} <tspan fill="${sub}" font-weight="400" font-size="11">${valLabel(n)}</tspan></text>`;
    }
  });
  labels += "</g>";

  // click targets: income (col 0) and category/saved (col 2) nodes, label area included
  let hits = "";
  const clickable = typeof (opts && opts.onNodeClick) === "function";
  if (clickable) {
    cols[0].forEach((n) => {
      hits += `<rect x="${n.x - 4}" y="${Math.min(n.y, n.y + n.h / 2 - 18)}" width="215" height="${Math.max(n.h + 8, 36)}" fill="transparent" style="cursor:pointer" data-nid="${esc(String(n.id))}" data-nlabel="${esc(n.label)}"><title>${esc(n.label)}: view transactions</title></rect>`;
    });
    cols[2].forEach((n) => {
      hits += `<rect x="${n.x - 215}" y="${Math.min(n.y, n.y + n.h / 2 - 18)}" width="${215 + NW + 4}" height="${Math.max(n.h + 8, 36)}" fill="transparent" style="cursor:pointer" data-nid="${esc(String(n.id))}" data-nlabel="${esc(n.label)}"><title>${esc(n.label)}: view breakdown</title></rect>`;
    });
  }

  svg.innerHTML = out + labels + hits;
  wireDataTips(svg);
  if (clickable) {
    svg.querySelectorAll("[data-nid]").forEach((r) => r.addEventListener("click", () => opts.onNodeClick(r.dataset.nid, r.dataset.nlabel)));
  }
  return true;
}

/* ---------- budget-style horizontal track (helper used in HTML, no SVG) ---------- */
export function trackBar(pct, cls = "") {
  const w = Math.max(0, Math.min(100, pct));
  return `<div class="track"><div class="fill ${cls}" style="width:${w}%"></div></div>`;
}

export { fmtMoney, fmtMoneyWhole };
