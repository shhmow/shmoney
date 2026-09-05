// Invest: hero portfolio-vs-SPY chart, account filter, allocation-by-type donut
// with drill-down, sector exposure vs benchmark, concentration stat tiles,
// sector pulse, sortable holdings (cost-basis gain + held since), checks,
// retirement, backfill, and the Claude-written analysis card.
//
// Data: /api/investments plus /api/market/{sectors,pulse,performance}, all
// fetched in parallel and all scoped by ?account_id=. The /investments payload
// paints the frame immediately; each market card carries its own skeleton and
// fills (or degrades to a muted error line) as its request settles.
import { api } from "../lib/api.js";
import {
  esc, fmtMoneyWhole, fmtPct, fmtDate, monthLabel, emptyState, errorCard, parseDate, MID, MINUS,
} from "../lib/format.js";
import { lineChart, donutChart, hbar, rangeDelta, deltaBadge } from "../lib/investcharts.js";

const RANGES = { "1M": 31, "1Y": 366, "All": Infinity };
const RANGE_LABELS = { "1M": "past month", "1Y": "past year" };
let activeRange = "1Y";
let customRange = null; // { from, to } 'YYYY-MM-DD', drag-selected zoom window

const ACCT_KEY = "shmoney_invest_acct";
let acctFilter = sessionStorage.getItem(ACCT_KEY) || "";

let sortKey = "value";
let sortDir = -1; // -1 = descending
let allocSel = null; // selected allocation class (drill-down)

const YOU_COLOR = "#1fa168";
const SPY_COLOR = "#69776e";

const CLASS_META = {
  stocks: { label: "Stocks", color: "#1fa168" },
  mutual_funds: { label: "Mutual funds", color: "#4a80c4" },
  etfs: { label: "ETFs", color: "#b58a2e" },
  cash: { label: "Cash", color: "#b4628e" },
  bonds: { label: "Bonds", color: "#3a9ea5" },
  other: { label: "Other", color: "#69776e" },
};
const clsLabel = (k, apiLabel) => apiLabel || (CLASS_META[k] ? CLASS_META[k].label : k);
const clsColor = (k) => (CLASS_META[k] ? CLASS_META[k].color : CLASS_META.other.color);

const HOLDING_COLS = [
  { key: "name", label: "Holding" },
  { key: "quantity", label: "Shares" },
  { key: "value", label: "Value" },
  { key: "gain", label: "Gain" },
  { key: "gainPct", label: "Gain %" },
  { key: "heldSince", label: "Held since" },
  { key: "weight", label: "Weight" },
];

const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

function signedPct(n, digits = 1) {
  const v = Number(n) || 0;
  return (v > 0 ? "+" : "") + fmtPct(v, digits);
}

function retCell(v, extraCls = "") {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return `<td class="na${extraCls}">${MID}</td>`;
  const n = Number(v);
  const cls = n > 0 ? "pos" : n < 0 ? "negd" : "";
  return `<td class="${cls}${extraCls}">${signedPct(n)}</td>`;
}

function gainCell(v, isPct) {
  if (v === null || v === undefined) return `<td class="na">${MID}</td>`;
  const n = Number(v) || 0;
  const cls = n > 0 ? "pos" : n < 0 ? "negd" : "";
  const text = isPct
    ? (n > 0 ? "+" : "") + fmtPct(n)
    : (n > 0 ? "+" : "") + fmtMoneyWhole(n);
  return `<td class="${cls}">${text}</td>`;
}

function heldSinceCell(d) {
  if (!d) return `<td class="na">${MID}</td>`;
  return `<td>${esc(monthLabel(String(d).slice(0, 7)))}</td>`;
}

function sortedHoldings(holdings) {
  const arr = holdings.slice();
  arr.sort((a, b) => {
    if (sortKey === "name" || sortKey === "heldSince") {
      const av = sortKey === "name" ? String(a.ticker || a.name || "").toLowerCase() : (a.heldSince || null);
      const bv = sortKey === "name" ? String(b.ticker || b.name || "").toLowerCase() : (b.heldSince || null);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last either direction
      if (bv == null) return -1;
      return sortDir * String(av).localeCompare(String(bv));
    }
    const av = a[sortKey] == null ? null : Number(a[sortKey]);
    const bv = b[sortKey] == null ? null : Number(b[sortKey]);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last either direction
    if (bv == null) return -1;
    return sortDir * (av - bv);
  });
  return arr;
}

const sectionSkel = (h = 120) => `<div class="skel iv-skel" style="height:${h}px" aria-hidden="true"></div>`;
const errLine = (what, e) =>
  `<p class="iv-err">Couldn't load ${what}. ${esc((e && e.message) || "Request failed.")}</p>`;

export default async function render(main) {
  // Page-level skeleton for the initial /investments wait (also covers re-renders).
  main.innerHTML = `<div class="page" aria-busy="true">
    <div class="skel" style="height:110px;margin-bottom:14px"></div>
    <div class="skel" style="height:240px;margin-bottom:14px"></div>
    <div class="skel" style="height:220px;margin-bottom:14px"></div>
    <div class="skel" style="height:180px"></div>
  </div>`;

  const qs = acctFilter ? `?account_id=${encodeURIComponent(acctFilter)}` : "";
  // All four in parallel; the frame renders as soon as /investments lands and
  // the market cards fill in when their (possibly Yahoo-slow) calls settle.
  const invP = settle(api.get("/investments" + qs));
  const sectorsP = settle(api.get("/market/sectors" + qs));
  const pulseP = settle(api.get("/market/pulse" + qs));
  const perfP = settle(api.get("/market/performance" + qs));

  const invRes = await invP;
  if (!invRes.ok) {
    main.innerHTML = `<div class="page">${errorCard(invRes.e)}</div>`;
    return;
  }
  const data = invRes.v || {};
  const pf = data.portfolio || { value: 0, dayChange: 0, series: [] };
  const accts = data.accounts || [];
  const holdings = data.holdings || [];
  const checks = data.checks || [];
  const retirement = data.retirement || null;
  const pricesAsOf = data.pricesAsOf || null;
  const analysis = data.analysis || null;

  // Allocation by security type (donut + drill-down). The API provides it;
  // fall back to grouping holdings client-side just in case.
  let allocation = Array.isArray(data.allocationByType) ? data.allocationByType : null;
  if (!allocation) {
    const totals = new Map();
    let total = 0;
    for (const h of holdings) {
      const cls = h.typeClass || "other";
      totals.set(cls, (totals.get(cls) || 0) + (Number(h.value) || 0));
      total += Number(h.value) || 0;
    }
    allocation = [...totals.entries()].map(([cls, value]) => ({
      class: cls, label: clsLabel(cls), value, pct: total > 0 ? (value / total) * 100 : 0,
    }));
  }

  // Stale filter (account was removed): reset and refetch once.
  if (acctFilter && !accts.some((a) => String(a.id) === String(acctFilter))) {
    acctFilter = "";
    sessionStorage.removeItem(ACCT_KEY);
    return render(main);
  }
  const filteredAcct = acctFilter ? accts.find((a) => String(a.id) === String(acctFilter)) : null;

  if (!accts.length && !holdings.length) {
    main.innerHTML = `<div class="page">
      <div class="pagehead"><div><div class="label">Portfolio</div><div class="hero-num">$0</div></div></div>
      <div class="card">${emptyState({
        title: "No investment accounts yet",
        body: "Link a brokerage or IRA in Settings.",
        actionLabel: "Go to Settings", actionHash: "#/settings", glyph: "chart",
      })}</div>
    </div>`;
    return;
  }

  const day = Number(pf.dayChange) || 0;
  const prevVal = (Number(pf.value) || 0) - day;
  const dayPct = prevVal !== 0 ? Math.abs(day / prevVal) * 100 : 0;
  const series = Array.isArray(pf.series) ? pf.series : [];

  const allocSegs = allocation
    .map((a) => ({
      key: a.class || "other",
      label: clsLabel(a.class, a.label),
      pct: Number(a.pct) || 0,
      value: Number(a.value) || 0,
      color: clsColor(a.class || "other"),
    }))
    .filter((a) => a.pct > 0)
    .sort((a, b) => b.pct - a.pct);
  if (allocSel && !allocSegs.some((s) => s.key === allocSel)) allocSel = null;

  const roth = retirement && retirement.roth;
  const ira = retirement && retirement.inheritedIra;
  const monthsLeftInYear = 12 - new Date().getMonth();
  const needsBackfill = true; // reconstruction is idempotent; keep it reachable

  const analysisBullets = analysis && Array.isArray(analysis.bullets) ? analysis.bullets.filter((b) => typeof b === "string" && b) : [];
  const analysisDate = analysis && analysis.written_at ? fmtDate(String(analysis.written_at).slice(0, 10)) : "";

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <div>
        <div class="label">Portfolio${filteredAcct ? ` ${MID} ${esc(filteredAcct.name)}` : ""}</div>
        <div class="hero-num">${fmtMoneyWhole(pf.value)}</div>
        <span id="pf-delta">${day !== 0
          ? `<span class="delta ${day >= 0 ? "up" : "down"}">${day >= 0 ? "&#9650;" : "&#9660;"} ${fmtMoneyWhole(Math.abs(day))} (${fmtPct(dayPct)})</span> <span class="sub">today</span>`
          : `<span class="sub">no change today</span>`}</span>
      </div>
      <div class="chips" id="pf-ranges" style="flex-wrap:wrap"></div>
    </div>

    ${accts.length > 1 ? `
    <div class="chips" id="pf-accts" style="margin-bottom:14px;flex-wrap:wrap" role="group" aria-label="Filter by account">
      <button type="button" class="chip${!acctFilter ? " active" : ""}" data-acct="">All accounts</button>
      ${accts.map((a) => `<button type="button" class="chip${String(a.id) === String(acctFilter) ? " active" : ""}" data-acct="${esc(a.id)}">${esc(a.name)}</button>`).join("")}
    </div>` : ""}

    <div class="card">
      ${series.length >= 1
        ? `<figure><svg id="pf-chart" viewBox="0 0 900 220" role="img" aria-label="Portfolio value over time versus the S&amp;P 500. Drag horizontally to zoom to a custom date range."></svg></figure>
           <div class="legend" id="pf-legend"><span><i style="background:${YOU_COLOR}"></i>You</span></div>
           <div class="iv-compare" id="pf-compare"></div>`
        : `<p class="iv-err" style="margin:0">No history yet. Daily snapshots start today.</p>`}
      ${needsBackfill ? `
      <div class="muted-note" style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span>Rebuild past history from transactions:</span>
        <button type="button" class="btn small" id="pf-backfill">Reconstruct history</button>
        <span class="muted-note" id="pf-backfill-msg" style="color:var(--crit)" hidden></span>
      </div>` : ""}
    </div>

    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:10px">Analysis</div>
      ${analysis ? `
      <div class="iv-analysis">
        <div class="hl">${esc(analysis.headline || "")}</div>
        ${analysisBullets.length ? `<ul>${analysisBullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
        <div class="by">by Claude${analysisDate ? ` ${MID} ${esc(analysisDate)}` : ""}</div>
      </div>` : `<p class="iv-err" style="margin:0">Run /invest-review in Claude Code to generate.</p>`}
    </div>

    ${accts.length ? `
    <div class="grid acct" style="margin-top:14px">
      ${accts.map((a) => `<div class="card acct-card">
        <span class="acct-name">${esc(a.name)}</span>
        <span class="acct-bal">${fmtMoneyWhole(a.value)}</span>
        <span class="acct-sub">${esc(a.subtype || "investment")}</span>
      </div>`).join("")}
    </div>` : ""}

    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:12px">Allocation by type</div>
      ${allocSegs.length ? `
      <div class="iv-alloc">
        <figure><svg id="alloc-donut" viewBox="0 0 150 150" style="width:150px" role="img" aria-label="Portfolio allocation by asset type. Segments are interactive."></svg></figure>
        <div class="iv-legend" id="alloc-legend" role="group" aria-label="Asset types"></div>
      </div>
      <div id="alloc-drill"></div>` : emptyState({ title: "No holdings yet", body: "Allocation appears once holdings sync in.", glyph: "chart" })}
    </div>

    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <div class="label" style="margin-bottom:12px">Sector exposure ${MID} you vs S&amp;P 500</div>
        <div id="sector-body">${sectionSkel(180)}</div>
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:12px">Concentration</div>
        <div id="conc-body">${sectionSkel(180)}</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:12px">Sector pulse</div>
      <div id="pulse-body">${sectionSkel(200)}</div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:2px">Holdings${filteredAcct ? ` ${MID} ${esc(filteredAcct.name)}` : ""}</div>
      ${pricesAsOf ? `<div class="muted-note" style="margin-bottom:8px">prices as of ${esc(fmtDate(pricesAsOf))}</div>` : `<div style="height:8px"></div>`}
      ${holdings.length ? `
      <div class="table-wrap">
      <table>
        <thead><tr id="holdings-head"></tr></thead>
        <tbody id="holdings-body"></tbody>
      </table>
      </div>` : emptyState({ title: "No holdings yet", body: filteredAcct ? "Nothing in this account yet." : "Holdings sync in from linked accounts.", glyph: "chart" })}
    </div>

    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <div class="label" style="margin-bottom:10px">Portfolio checks</div>
        ${checks.length ? checks.map((c) => `<div class="txn">
            <div class="who"><div class="m" style="font-size:13.5px">${esc(c.label)}</div><div class="meta">${esc(c.detail || "")}</div></div>
            <span class="pill ${c.status === "pass" ? "ok" : "wait"}">&#9679; ${c.status === "pass" ? "Pass" : "Check"}</span>
          </div>`).join("") : `<p class="sub">Checks run after holdings sync in.</p>`}
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:10px">Retirement</div>
        ${roth ? `
        <div class="brow" style="border-bottom:1px solid var(--line)">
          <div class="top"><span class="name" style="font-size:13.5px">Roth IRA ${MID} ${new Date().getFullYear()}</span>
            <span class="nums"><b>${fmtMoneyWhole(roth.contributed)}</b> / ${fmtMoneyWhole(roth.limit)}</span></div>
          <div class="track"><div class="fill" style="width:${Number(roth.limit) > 0 ? Math.min(100, (Number(roth.contributed) || 0) / Number(roth.limit) * 100) : 0}%"></div></div>
          <div class="sub" style="margin-top:7px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span>${fmtMoneyWhole(roth.room)} room ${MID} ${monthsLeftInYear} month${monthsLeftInYear === 1 ? "" : "s"} left</span>
            <button type="button" class="btn small" id="roth-edit">Update contributed</button></div>
          <div id="roth-form"></div>
        </div>` : ""}
        ${ira ? `
        <div class="brow">
          <div class="top"><span class="name" style="font-size:13.5px">Inherited IRA ${MID} 10 year rule</span>
            <span class="nums"><b>year ${esc(String(ira.year))}</b> / ${esc(String(ira.of || 10))}</span></div>
          <div class="track"><div class="fill" style="width:${Math.min(100, (Number(ira.year) || 0) / (Number(ira.of) || 10) * 100)}%"></div></div>
          <div class="sub" style="margin-top:5px">Suggested this year ${fmtMoneyWhole(ira.suggested)} ${MID} taken ${fmtMoneyWhole(ira.taken)}</div>
        </div>` : ""}
        ${!roth && !ira ? `<p class="sub" style="margin:0">Set Roth and IRA details in <a href="#/settings">Settings</a>.</p>` : ""}
      </div>
    </div>
  </div>`;

  // ------------------------------------------------------------------ hero
  let spySeries = null; // filled when /market/performance settles

  const pctSpan = (v) => `<span class="${(Number(v) || 0) >= 0 ? "pos" : "negd"}">${signedPct(v)}</span>`;

  const drawPf = () => {
    const svg = document.getElementById("pf-chart");
    if (!svg) return;
    // Visible window: drag-selected custom range wins, else the active chip.
    // windowLabel always reflects the span actually rendered: when the series
    // is shorter than the requested window it reads "since <first date>".
    let pts = series;
    let windowLabel = "";
    if (customRange) {
      const f = series.filter((p) => p.date >= customRange.from && p.date <= customRange.to);
      if (f.length >= 2) pts = f;
      else { customRange = null; renderChips(); } // window no longer valid for this series
    }
    if (customRange) {
      windowLabel = `${fmtDate(customRange.from)} to ${fmtDate(customRange.to)}`;
    } else {
      const days = RANGES[activeRange];
      let sliced = false;
      if (days !== Infinity && series.length >= 2) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const f = series.filter((p) => parseDate(p.date) >= cutoff);
        // Only a real slice counts; f === whole series means the data is
        // shorter than the requested window.
        if (f.length >= 2 && f.length < series.length) {
          pts = f;
          sliced = true;
        }
      }
      windowLabel = sliced
        ? (RANGE_LABELS[activeRange] || "")
        : (pts.length ? `since ${fmtDate(pts[0].date)}` : "");
    }
    const list = [{
      points: pts.map((p) => ({ date: p.date, value: Number(p.value) || 0 })),
      color: YOU_COLOR, label: "You", fill: true,
    }];
    // Overlay SPY, indexed to the portfolio's value where the two series first
    // overlap, so both lines share the same dollar axis and start together.
    let spyWin = null;
    if (spySeries && spySeries.length >= 2 && pts.length >= 1) {
      const start = pts[0].date;
      let win = spySeries.filter((p) => p.date >= start);
      if (customRange) win = win.filter((p) => p.date <= customRange.to);
      if (win.length < 2) win = spySeries;
      const anchor = pts.find((p) => p.date >= win[0].date) || pts[0];
      const base = Number(win[0].close);
      const baseVal = Number(anchor.value) || 0;
      if (base > 0 && baseVal > 0) {
        spyWin = win;
        list.push({
          points: win.map((p) => ({ date: p.date, value: (Number(p.close) / base) * baseVal })),
          color: SPY_COLOR, label: "S&P 500", dash: true,
        });
      }
    }
    lineChart(svg, list, {
      onRangeSelect: (from, to) => {
        const win = series.filter((p) => p.date >= from && p.date <= to);
        if (win.length < 2) return; // too tight to zoom into
        customRange = { from: win[0].date, to: win[win.length - 1].date };
        renderChips();
        drawPf();
      },
    });
    const legend = document.getElementById("pf-legend");
    if (legend) {
      legend.innerHTML = `<span><i style="background:${YOU_COLOR}"></i>You</span>` +
        (list.length > 1 ? `<span><i style="background:${SPY_COLOR}"></i>S&amp;P 500 indexed</span>` : "");
    }
    // Per-range change next to the hero value (first vs last visible point).
    const youD = rangeDelta(pts.map((p) => Number(p.value) || 0));
    const deltaEl = document.getElementById("pf-delta");
    if (deltaEl && youD) {
      const dayHtml = day !== 0
        ? ` <span class="sub">${MID} today ${day > 0 ? "+" : MINUS}${fmtMoneyWhole(Math.abs(day))}</span>`
        : "";
      deltaEl.innerHTML = deltaBadge(youD, windowLabel) + dayHtml;
    }
    // Explicit you-vs-S&P % comparison over the same visible window.
    const cmp = document.getElementById("pf-compare");
    if (cmp) {
      const spyD = spyWin ? rangeDelta(spyWin.map((p) => Number(p.close) || 0)) : null;
      cmp.innerHTML = (youD && youD.pct != null && spyD && spyD.pct != null)
        ? `You ${pctSpan(youD.pct)} / S&amp;P ${pctSpan(spyD.pct)}`
        : "";
    }
  };

  // Range chips (+ a removable custom chip after a drag-select).
  const renderChips = () => {
    const row = document.getElementById("pf-ranges");
    if (!row) return;
    row.innerHTML = Object.keys(RANGES).map((r) =>
      `<button type="button" class="chip${!customRange && r === activeRange ? " active" : ""}" data-range="${r}">${r}</button>`).join("")
      + (customRange
        ? `<button type="button" class="chip active" id="pf-custom" aria-label="Custom range ${esc(fmtDate(customRange.from))} to ${esc(fmtDate(customRange.to))}. Activate to clear.">${esc(fmtDate(customRange.from))} to ${esc(fmtDate(customRange.to))}<span class="x" aria-hidden="true">&#215;</span></button>`
        : "");
    row.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      activeRange = b.dataset.range;
      customRange = null;
      renderChips();
      drawPf();
    }));
    const custom = row.querySelector("#pf-custom");
    if (custom) custom.addEventListener("click", () => {
      customRange = null; // falls back to the previously active chip
      renderChips();
      drawPf();
    });
  };
  renderChips();
  drawPf();

  // account filter chips
  main.querySelectorAll("#pf-accts .chip").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.acct || "";
    if (id === acctFilter) return;
    acctFilter = id;
    allocSel = null;
    if (id) sessionStorage.setItem(ACCT_KEY, id);
    else sessionStorage.removeItem(ACCT_KEY);
    render(main);
  }));

  // history backfill
  const bf = main.querySelector("#pf-backfill");
  if (bf) bf.addEventListener("click", async () => {
    const msg = main.querySelector("#pf-backfill-msg");
    msg.hidden = true;
    bf.disabled = true;
    const orig = bf.textContent;
    bf.textContent = "Reconstructing…";
    try {
      await api.post("/investments/backfill", {});
      render(main);
    } catch (err) {
      bf.disabled = false;
      bf.textContent = orig;
      msg.textContent = err.message || "Backfill failed";
      msg.hidden = false;
    }
  });

  // ---------------------------------------------------- allocation drill-down
  const totalValue = allocSegs.reduce((s, a) => s + a.value, 0);

  const renderDrill = () => {
    const slot = document.getElementById("alloc-drill");
    if (!slot) return;
    if (!allocSel) {
      slot.innerHTML = `<p class="iv-foot" style="margin-top:10px">Select a slice to see its holdings.</p>`;
      return;
    }
    const seg = allocSegs.find((s) => s.key === allocSel);
    const inClass = holdings
      .filter((h) => (h.typeClass || "other") === allocSel && (Number(h.value) || 0) > 0)
      .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
    const classTotal = inClass.reduce((s, h) => s + (Number(h.value) || 0), 0) || (seg ? seg.value : 0);
    if (!inClass.length) {
      slot.innerHTML = `<div class="iv-drill"><p class="iv-err" style="margin:0">Nothing in ${esc(seg ? seg.label : allocSel)}.</p></div>`;
      return;
    }
    slot.innerHTML = `<div class="iv-drill">
      <div class="iv-drill-head">
        <span style="font-weight:700;font-size:14px"><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${seg ? seg.color : "#69776e"};margin-right:8px"></i>${esc(seg ? seg.label : allocSel)}</span>
        <span class="sum"><b>${fmtMoneyWhole(classTotal)}</b> ${MID} ${fmtPct(totalValue > 0 ? (classTotal / totalValue) * 100 : 0)} of portfolio ${MID} ${inClass.length} holding${inClass.length === 1 ? "" : "s"}</span>
      </div>
      <div class="table-wrap">
      <table>
        <thead><tr><th>Holding</th><th class="barcell">Of class</th><th>%</th><th>Of portfolio</th><th>Value</th><th>Accounts</th></tr></thead>
        <tbody>
          ${inClass.map((h) => {
            const inCls = classTotal > 0 ? ((Number(h.value) || 0) / classTotal) * 100 : 0;
            const inPf = (Number(h.weight) || 0) * 100;
            const acctNames = Array.isArray(h.accounts) ? h.accounts.map((a) => a.name).join(", ") : "";
            return `<tr>
              <td><span class="tick">${esc(h.ticker || MID)}</span><span class="nm">${esc(h.name || "")}</span></td>
              <td class="barcell">${hbar(inCls, seg ? seg.color : "#69776e")}</td>
              <td>${fmtPct(inCls)}</td>
              <td>${fmtPct(inPf)}</td>
              <td>${fmtMoneyWhole(h.value)}</td>
              <td class="acctcell">${esc(acctNames)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    </div>`;
  };

  const renderAlloc = () => {
    const svg = document.getElementById("alloc-donut");
    const legend = document.getElementById("alloc-legend");
    if (!svg || !legend) return;
    const center = allocSel
      ? allocSegs.find((s) => s.key === allocSel)
      : allocSegs[0];
    donutChart(svg, allocSegs, {
      selectedKey: allocSel,
      center: center ? { big: String(Math.round(center.pct)), unit: "%", small: center.label.toUpperCase() } : {},
      onSelect: (key) => { allocSel = key; renderAlloc(); renderDrill(); },
    });
    legend.innerHTML = allocSegs.map((a) => `
      <button type="button" class="iv-legend-btn" data-cls="${esc(a.key)}" aria-pressed="${allocSel === a.key}">
        <i style="background:${a.color}"></i>${esc(a.label)}
        <span class="val">${fmtMoneyWhole(a.value)}</span>
        <span class="pct">${Math.round(a.pct)}%</span>
      </button>`).join("");
    legend.querySelectorAll(".iv-legend-btn").forEach((b) => b.addEventListener("click", () => {
      allocSel = allocSel === b.dataset.cls ? null : b.dataset.cls;
      renderAlloc();
      renderDrill();
    }));
  };
  if (allocSegs.length) { renderAlloc(); renderDrill(); }

  // roth inline edit -> PUT /settings
  const rothEdit = main.querySelector("#roth-edit");
  if (rothEdit) rothEdit.addEventListener("click", () => {
    const slot = main.querySelector("#roth-form");
    if (slot.innerHTML) { slot.innerHTML = ""; return; }
    slot.innerHTML = `<div class="popover">
      <span class="sub">Contributed this year</span>
      <input type="number" min="0" step="1" style="width:110px" value="${Math.round(Number(roth.contributed) || 0)}" aria-label="Roth contributed year to date">
      <button type="button" class="btn primary small">Save</button>
      <span class="muted-note"></span>
    </div>`;
    slot.querySelector("button").addEventListener("click", async () => {
      const msg = slot.querySelector(".muted-note");
      try {
        await api.put("/settings", { roth_contributed_ytd: Number(slot.querySelector("input").value) || 0 });
        render(main);
      } catch (err) {
        msg.textContent = err.message || "Save failed";
      }
    });
  });

  // -------------------------------------------------------- holdings table
  const head = main.querySelector("#holdings-head");
  const body = main.querySelector("#holdings-body");
  const renderTable = () => {
    if (!head || !body || !head.isConnected) return;
    head.innerHTML = HOLDING_COLS.map((col) => {
      const active = col.key === sortKey;
      const dir = active ? `<span class="dir" aria-hidden="true">${sortDir === 1 ? "&#9650;" : "&#9660;"}</span>` : "";
      return `<th class="sortable" data-sort="${col.key}" role="button" tabindex="0" aria-sort="${active ? (sortDir === 1 ? "ascending" : "descending") : "none"}">${col.label}${dir}</th>`;
    }).join("");
    const rows = sortedHoldings(holdings);
    body.innerHTML = rows.map((h, i) => {
      const multi = Array.isArray(h.accounts) && h.accounts.length > 1;
      const inNote = multi ? ` ${MID} ${h.accounts.map((a) => esc(a.name)).join(" + ")}` : "";
      const expandable = Array.isArray(h.accounts) && h.accounts.length > 0;
      return `<tr class="${expandable ? "expandable" : ""}" data-h="${i}" ${expandable ? `tabindex="0" role="button" aria-expanded="false" aria-label="Show per-account split for ${esc(h.ticker || h.name || "")}"` : ""}>
        <td><span class="tick">${esc(h.ticker || MID)}</span><span class="nm">${esc(h.name || "")}${inNote}</span></td>
        <td>${(Number(h.quantity) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
        <td>${fmtMoneyWhole(h.value)}</td>
        ${gainCell(h.gain, false)}
        ${gainCell(h.gainPct, true)}
        ${heldSinceCell(h.heldSince)}
        <td>${Math.round((Number(h.weight) || 0) * 100)}%</td>
      </tr>`;
    }).join("");

    // header sorting
    head.querySelectorAll("th.sortable").forEach((th) => {
      const activate = () => {
        const key = th.dataset.sort;
        if (key === sortKey) sortDir = -sortDir;
        else { sortKey = key; sortDir = key === "name" ? 1 : -1; }
        renderTable();
      };
      th.addEventListener("click", activate);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
    });

    // expandable per-account split rows
    body.querySelectorAll("tr.expandable").forEach((tr) => {
      const toggle = () => {
        const i = Number(tr.dataset.h);
        const h = rows[i];
        const open = tr.getAttribute("aria-expanded") === "true";
        tr.setAttribute("aria-expanded", String(!open));
        let next = tr.nextElementSibling;
        while (next && next.classList.contains("subrow")) {
          const gone = next;
          next = next.nextElementSibling;
          gone.remove();
        }
        if (open || !h || !Array.isArray(h.accounts)) return;
        let anchor = tr;
        h.accounts.forEach((a) => {
          const sub = document.createElement("tr");
          sub.className = "subrow";
          sub.innerHTML = `<td style="padding-left:18px">${esc(a.name)}</td>
            <td>${(Number(a.quantity) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
            <td>${fmtMoneyWhole(a.value)}</td><td></td><td></td><td></td><td></td>`;
          anchor.after(sub);
          anchor = sub;
        });
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  };
  if (holdings.length) renderTable();

  // ----------------------------------------------- sectors + concentration
  const fillSectors = (res) => {
    const sbody = document.getElementById("sector-body");
    const cbody = document.getElementById("conc-body");
    if (!sbody || !sbody.isConnected) return;
    if (!res.ok) {
      sbody.innerHTML = errLine("sector data", res.e);
      if (cbody) cbody.innerHTML = errLine("concentration data", res.e);
      return;
    }
    const d = res.v || {};
    const sectors = Array.isArray(d.sectors) ? d.sectors : [];
    const holdingSectors = d.holdingSectors || {};
    const approx = Array.isArray(d.approxTickers) ? d.approxTickers : [];
    const unmapped = Array.isArray(d.unmapped) ? d.unmapped : [];

    if (!sectors.length) {
      sbody.innerHTML = `<p class="iv-err" style="margin:0">Appears once holdings sync in.</p>`;
    } else {
      const max = Math.max(10, ...sectors.map((s) => Math.max(Number(s.pct) || 0, Number(s.benchmarkPct) || 0))) * 1.08;
      // Which holdings feed each sector (for the expandable contributor rows).
      const byTicker = new Map(holdings.filter((h) => h.ticker).map((h) => [String(h.ticker).toUpperCase(), h]));
      const contributors = (key) => {
        const out = [];
        for (const [t, info] of Object.entries(holdingSectors)) {
          const s = (info.sectors || []).find((x) => x.key === key);
          if (!s) continue;
          const h = byTicker.get(t);
          const w = h ? (Number(h.weight) || 0) * 100 : null;
          out.push({
            ticker: t, name: h ? h.name : "", within: Number(s.pct) || 0,
            contrib: w != null ? (w * (Number(s.pct) || 0)) / 100 : null,
            fund: !!info.fund, approx: info.source === "approx",
          });
        }
        return out.sort((a, b) => (b.contrib ?? -1) - (a.contrib ?? -1));
      };

      sbody.innerHTML = sectors.map((s, i) => {
        const diff = s.diff;
        const off = diff !== null && diff !== undefined && Math.abs(diff) > 3;
        const badge = off
          ? `<span class="iv-badge ${diff > 0 ? "over" : "under"}">${diff > 0 ? "+" : MINUS}${Math.abs(Math.round(diff))} pts</span>`
          : `<span></span>`;
        const bench = s.benchmarkPct !== null && s.benchmarkPct !== undefined
          ? ` / S&amp;P ${fmtPct(s.benchmarkPct)}` : "";
        return `<button type="button" class="iv-sector" data-sec="${esc(s.key)}" data-i="${i}" aria-expanded="false"
            aria-label="${esc(s.label)}: you ${fmtPct(s.pct)}${s.benchmarkPct != null ? `, benchmark ${fmtPct(s.benchmarkPct)}` : ""}. Activate to see contributing holdings.">
          <span class="snm">${esc(s.label)}</span>
          ${hbar(Number(s.pct) || 0, YOU_COLOR, s.benchmarkPct, max)}
          <span class="spct">${fmtPct(s.pct)}</span>
          ${badge}
        </button>
        <div class="iv-contrib" data-for="${esc(s.key)}" hidden>
          <div class="muted-note" style="margin-bottom:4px">you ${fmtPct(s.pct)}${bench}</div>
          <div class="clist"></div>
        </div>`;
      }).join("") + `
      <p class="iv-foot">Tick = S&amp;P 500 weight. Badge = 3+ pts off. Funds looked through${approx.length ? `. Approx: ${approx.map(esc).join(", ")}` : ""}.</p>
      ${unmapped.length ? `<p class="iv-foot">Unmapped: ${unmapped.map((u) => `${esc(u.ticker || u.name || "?")} (${fmtPct(u.pct)})`).join(", ")}.</p>` : ""}`;

      sbody.querySelectorAll(".iv-sector").forEach((btn) => btn.addEventListener("click", () => {
        const panel = sbody.querySelector(`.iv-contrib[data-for="${btn.dataset.sec}"]`);
        if (!panel) return;
        const open = !panel.hidden;
        panel.hidden = open;
        btn.setAttribute("aria-expanded", String(!open));
        if (!open && !panel.dataset.filled) {
          panel.dataset.filled = "1";
          const list = contributors(btn.dataset.sec);
          panel.querySelector(".clist").innerHTML = list.length
            ? list.map((c) => {
                const parts = [c.fund ? `${fmtPct(c.within)} of fund` : "direct"];
                if (c.contrib != null) parts.push(`${fmtPct(c.contrib)} of portfolio`);
                return `<div class="crow">
                <span><span class="t">${esc(c.ticker)}</span> <span class="n">${esc(c.name || "")}${c.approx ? ` ${MID} approx` : ""}</span></span>
                <span class="v">${parts.join(" / ")}</span>
              </div>`;
              }).join("")
            : `<div class="crow"><span class="n">No mapped holdings.</span></div>`;
        }
      }));
    }

    if (cbody) {
      const conc = d.concentration || {};
      const stats = Array.isArray(conc.stats) ? conc.stats : [];
      const overlaps = Array.isArray(conc.overlaps) ? conc.overlaps : [];
      cbody.innerHTML = stats.length ? `
        <div class="iv-stats">${stats.map((s) => `
          <div class="iv-stat">
            <div class="lrow"><div class="label">${esc(s.label)}</div>${s.status ? `<span class="dot ${s.status === "pass" ? "ok" : "warn"}" aria-label="${s.status === "pass" ? "ok" : "check"}"></span>` : ""}</div>
            <div class="big">${esc(s.value)}</div>
            <div class="det" title="${esc(s.detail || "")}">${esc(s.detail || "")}</div>
          </div>`).join("")}</div>
        ${overlaps.map((o) => `<div class="iv-overlap">
          <span class="iv-badge over">same index</span>
          <span class="t">${(o.tickers || []).map(esc).join(" + ")}</span>
          <span>${esc(o.index || "")} ${MID} ${fmtPct(o.combinedPct)} combined</span>
        </div>`).join("")}`
        : `<p class="iv-err" style="margin:0">Appears once holdings sync in.</p>`;
    }
  };

  // ------------------------------------------------------------ sector pulse
  const fillPulse = (res) => {
    const el = document.getElementById("pulse-body");
    if (!el || !el.isConnected) return;
    if (!res.ok) { el.innerHTML = errLine("market data", res.e); return; }
    const d = res.v || {};
    const rows = Array.isArray(d.rows) ? d.rows : [];
    const withData = rows.filter((r) => r.r1m !== null || r.r3m !== null || r.r1y !== null);
    if (!withData.length) {
      el.innerHTML = `<p class="iv-err" style="margin:0">No market data right now.</p>`;
      return;
    }
    const spy = d.spy;
    el.innerHTML = `
      <div class="table-wrap">
      <table class="iv-pulse">
        <thead><tr><th>Sector</th><th>1M</th><th>3M</th><th>1Y</th><th>You</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const hl = r.stance === "over" ? " class=\"hl-over\"" : r.stance === "under" ? " class=\"hl-under\"" : "";
            const stanceBadge = r.stance === "over"
              ? `<span class="iv-badge over">over</span>`
              : r.stance === "under" ? `<span class="iv-badge under">under</span>` : "";
            return `<tr${hl}>
              <td><span class="tick">${esc(r.label)}</span><span class="nm">${esc(r.ticker)}</span></td>
              ${retCell(r.r1m)}
              ${retCell(r.r3m)}
              ${retCell(r.r1y)}
              <td><span class="you"><span class="youpct">you: ${fmtPct(r.userPct)}</span>${stanceBadge}</span></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
      ${spy ? `<div class="iv-spyline">S&amp;P 500 (SPY): 1M ${spy.r1m == null ? MID : signedPct(spy.r1m)} ${MID} 3M ${spy.r3m == null ? MID : signedPct(spy.r3m)} ${MID} 1Y ${spy.r1y == null ? MID : signedPct(spy.r1y)}</div>` : ""}
      <p class="iv-foot">Yahoo data, cached daily. Not advice.</p>`;
  };

  // -------------------------------------------------- S&P overlay (hero only)
  const fillPerf = (res) => {
    if (!res.ok) return; // overlay degrades silently; the hero still renders
    const d = res.v || {};
    if (Array.isArray(d.spy) && d.spy.length) {
      spySeries = d.spy;
      drawPf();
    }
  };

  // Fill each market section as its request settles (they were started above).
  sectorsP.then(fillSectors);
  pulseP.then(fillPulse);
  perfP.then(fillPerf);
}
