// Cash flow: sankey laid out from /api/cashflow data, monthly bars, savings tile.
// Periods: single month (with prev/next arrows), YTD, trailing 12 months.
import { api } from "../lib/api.js";
import {
  esc, fmtMoneyWhole, emptyState, errorCard, currentMonth, shiftMonth, monthShort, monthLabel, MID,
} from "../lib/format.js";
import { sankey, groupedBars } from "../lib/charts.js";
import { merchantTile } from "../lib/brand.js";
import { fmtMoney, fmtPct } from "../lib/format.js";

let period = "month"; // 'month' | 'ytd' | '1y'
let month = null;

const MAX_FALLBACK_SPEND = 9;

/** Fallback: build sankey nodes/links from income/spending lists if API omits them. */
function buildSankey(data) {
  const s = data.sankey;
  if (s && Array.isArray(s.nodes) && s.nodes.length && Array.isArray(s.links) && s.links.length) return s;
  const income = data.income || [];
  let spending = (data.spending || []).filter((sp) => (Number(sp.amount) || 0) > 0);
  if (!income.length && !spending.length) return null;
  if (spending.length > MAX_FALLBACK_SPEND) {
    const keep = spending.slice(0, MAX_FALLBACK_SPEND - 1);
    const restTotal = spending.slice(MAX_FALLBACK_SPEND - 1).reduce((a, sp) => a + (Number(sp.amount) || 0), 0);
    keep.push({ name: "Other", amount: restTotal, color: null });
    spending = keep;
  }
  const nodes = [];
  const links = [];
  const CENTER = "Cash";
  income.forEach((i) => {
    const label = i.category || i.name || "Income";
    nodes.push({ name: label, value: i.amount });
    links.push({ source: label, target: CENTER, value: i.amount });
  });
  nodes.push({ name: CENTER });
  spending.forEach((sp) => {
    const label = sp.name || sp.category || "Other";
    nodes.push({ name: label, value: sp.amount, color: sp.color || null });
    links.push({ source: CENTER, target: label, value: sp.amount });
  });
  const saved = Number(data.saved) || 0;
  if (saved > 0) {
    nodes.push({ name: "Saved", value: saved, pct: data.savingsRate });
    links.push({ source: CENTER, target: "Saved", value: saved });
  }
  return { nodes, links };
}

/** Inclusive date bounds of the viewed period, for the transactions API. */
function periodRange() {
  const cur = currentMonth();
  if (period === "ytd") return { from: `${cur.slice(0, 4)}-01-01`, to: `${cur}-31` };
  if (period === "1y") return { from: `${shiftMonth(cur, -11)}-01`, to: `${cur}-31` };
  return { from: `${month}-01`, to: `${month}-31` };
}

/** Node click: fetch the period's transactions for that node and render a breakdown. */
async function drill(main, data, nid, nlabel) {
  const panel = main.querySelector("#cf-drill");
  if (!panel) return;
  const close = `<button type="button" class="btn small" id="cf-drill-close" style="margin-left:auto">&#215; Close</button>`;
  const head = (title, sub) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
    <span class="label">${esc(title)}</span><span class="sub">${esc(sub)}</span>${close}</div>`;
  const wire = () => {
    panel.hidden = false;
    const x = panel.querySelector("#cf-drill-close");
    if (x) x.addEventListener("click", () => { panel.hidden = true; panel.innerHTML = ""; });
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  if (nid === "hub") {
    const inc = Number(data.totalIncome) || 0, sp = Number(data.totalSpending) || 0;
    panel.innerHTML = `<div style="border-top:1px solid var(--line, #232a27);margin-top:14px;padding-top:12px">
      ${head("Checking", periodLabel())}
      <div class="grid two" style="gap:18px">
        <div><div class="sub" style="margin-bottom:6px">IN</div>${(data.income || []).map((r) => `<div style="display:flex;justify-content:space-between;padding:3px 0"><span>${esc(r.category)}</span><span class="mono">${fmtMoneyWhole(r.amount)}</span></div>`).join("")}
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line);margin-top:4px"><b>Total in</b><b class="mono">${fmtMoneyWhole(inc)}</b></div></div>
        <div><div class="sub" style="margin-bottom:6px">OUT</div>${(data.spending || []).slice(0, 10).map((r) => `<div style="display:flex;justify-content:space-between;padding:3px 0"><span>${esc(r.name)}</span><span class="mono">${fmtMoneyWhole(r.amount)}</span></div>`).join("")}
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line);margin-top:4px"><b>Total out</b><b class="mono">${fmtMoneyWhole(sp)}</b></div>
          <div style="display:flex;justify-content:space-between;padding:3px 0"><span class="sub">Net</span><span class="mono ${inc - sp >= 0 ? "pos" : "negd"}">${fmtMoney(inc - sp, { cents: false })}</span></div></div>
      </div></div>`;
    wire();
    return;
  }
  if (nid === "saved") {
    panel.innerHTML = `<div style="border-top:1px solid var(--line, #232a27);margin-top:14px;padding-top:12px">
      ${head("Saved", periodLabel())}
      <p class="sub" style="margin:0">Income minus spending for the period: ${fmtMoneyWhole(Number(data.totalIncome) || 0)} in, ${fmtMoneyWhole(Number(data.totalSpending) || 0)} out. A computed leftover, not a bank balance. It lands wherever the money sits: checking, savings, or transfers you made to Fidelity.</p>
    </div>`;
    wire();
    return;
  }

  // The grouped tail node: break it down by category instead of merchant.
  if (nid === "cat:grouped-other") {
    const shown = new Set((data.sankey && data.sankey.nodes || []).map((n) => n.id));
    const folded = (data.spending || []).filter((r) => r.amount > 0 && !shown.has(`cat:${r.category_id ?? "none"}`));
    const top = Math.max(...folded.map((r) => r.amount), 1);
    panel.innerHTML = `<div style="border-top:1px solid var(--line, #232a27);margin-top:14px;padding-top:12px">
      ${head("Smaller categories", `${fmtMoneyWhole(folded.reduce((a, r) => a + r.amount, 0))} ${MID} ${periodLabel()} ${MID} click one to drill in`)}
      ${folded.map((r) => `<div class="drill-row" data-cat="${r.category_id ?? "none"}" data-catname="${esc(r.name)}" style="display:grid;grid-template-columns:150px 1fr 90px;gap:10px;align-items:center;padding:5px 0;cursor:pointer">
        <span>${esc(r.name)}</span>
        <div class="track"><div class="fill" style="width:${Math.round(r.amount / top * 100)}%"></div></div>
        <span class="mono" style="text-align:right">${fmtMoneyWhole(r.amount)}</span></div>`).join("")}
    </div>`;
    wire();
    panel.querySelectorAll(".drill-row").forEach((row) => row.addEventListener("click", () =>
      drill(main, data, `cat:${row.dataset.cat}`, row.dataset.catname)));
    return;
  }

  // Income node ("in:<name>") or spend node ("cat:<id>"): merchant + transaction breakdown.
  let categoryId = null;
  let isIncome = false;
  if (nid.startsWith("in:")) {
    isIncome = true;
    const src = (data.income || []).find((r) => r.category === nlabel);
    categoryId = src ? src.category_id : null;
  } else if (nid.startsWith("cat:")) {
    categoryId = nid.slice(4);
  } else {
    // Fallback sankey (name-keyed nodes): resolve by label.
    const sp = (data.spending || []).find((r) => r.name === nlabel);
    const inc = (data.income || []).find((r) => r.category === nlabel);
    if (sp) categoryId = sp.category_id;
    else if (inc) { categoryId = inc.category_id; isIncome = true; }
  }
  if (categoryId === null || categoryId === undefined) categoryId = "none";

  const { from, to } = periodRange();
  panel.innerHTML = `<div style="border-top:1px solid var(--line, #232a27);margin-top:14px;padding-top:12px">${head(nlabel, "Loading")}</div>`;
  wire();
  let res;
  try {
    res = await api.get(`/transactions?category_id=${encodeURIComponent(categoryId)}&from=${from}&to=${to}&limit=200`);
  } catch (err) {
    panel.innerHTML = `<div style="border-top:1px solid var(--line, #232a27);margin-top:14px;padding-top:12px">${head(nlabel, periodLabel())}<p class="sub">${esc(err.message || "Failed to load")}</p></div>`;
    wire();
    return;
  }
  const txns = (res.transactions || []).filter((t) =>
    !t.excluded && (isIncome ? t.amount < 0 : (t.amount > 0 && !t.is_transfer)));
  const val = (t) => Math.abs(Number(t.amount) || 0);

  const byMerchant = new Map();
  for (const t of txns) {
    const key = t.merchant_name || (t.name || "").slice(0, 32) || "Unknown";
    const cur = byMerchant.get(key) || { total: 0, n: 0 };
    cur.total += val(t);
    cur.n += 1;
    byMerchant.set(key, cur);
  }
  const merchants = [...byMerchant.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 8);
  const top = Math.max(...merchants.map(([, v]) => v.total), 1);
  const total = txns.reduce((s, t) => s + val(t), 0);
  const list = txns.slice().sort((a, b) => val(b) - val(a)).slice(0, 12);

  panel.innerHTML = `<div style="border-top:1px solid var(--line, #232a27);margin-top:14px;padding-top:12px">
    ${head(nlabel, `${fmtMoneyWhole(total)} ${MID} ${txns.length} transactions ${MID} ${periodLabel()}`)}
    <div class="grid two" style="gap:18px">
      <div>
        <div class="sub" style="margin-bottom:6px">BY ${isIncome ? "SOURCE" : "MERCHANT"}</div>
        ${merchants.map(([m, v]) => `<div style="display:grid;grid-template-columns:minmax(90px,150px) 1fr 80px;gap:10px;align-items:center;padding:4px 0">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m)}">${esc(m)}</span>
          <div class="track"><div class="fill" style="width:${Math.round(v.total / top * 100)}%"></div></div>
          <span class="mono" style="text-align:right">${fmtMoneyWhole(v.total)}${v.n > 1 ? ` <span class="sub">x${v.n}</span>` : ""}</span></div>`).join("")}
      </div>
      <div>
        <div class="sub" style="margin-bottom:6px">LARGEST</div>
        ${list.map((t) => `<div style="display:flex;gap:10px;align-items:baseline;padding:4px 0">
          <span class="sub mono">${esc(String(t.date))}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.merchant_name || t.name || "")}">${esc(t.merchant_name || t.name || "")}</span>
          <span class="mono">${fmtMoneyWhole(val(t))}</span></div>`).join("")}
      </div>
    </div>
  </div>`;
  wire();
}

/* ---------- stats (analysis layer under the charts) ---------- */
function statsQuery() {
  const cur = currentMonth();
  if (period === "ytd") return `/stats?month=${cur}&range=ytd`;
  if (period === "1y") return `/stats?month=${cur}&range=1y`;
  return `/stats?month=${month}`;
}

function delta(cur, prev) {
  if (!(prev > 0)) return `<span class="sub">new</span>`;
  const p = (cur - prev) / prev * 100;
  if (Math.abs(p) < 1) return `<span class="sub">flat</span>`;
  const cls = p > 0 ? "negd" : "pos"; // spending up is bad
  return `<span class="${cls}">${p > 0 ? "&#9650;" : "&#9660;"} ${Math.abs(Math.round(p))}%</span>`;
}

function tile(label, value, sub) {
  return `<div class="card cf-tile"><div class="label">${label}</div><div class="cf-tile-n">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

function statsHtml(st) {
  if (!st) return "";
  const isMonth = period === "month";
  const isCur = isMonth && month === currentMonth();
  const p = st.pace || {};
  const cats = st.categories || [];
  const tops = st.topMerchants || [];
  const months = st.months || [];
  const wk = st.weekdays || [];
  const wkMax = Math.max(1, ...wk.map((w) => w.avg));
  const catMax = Math.max(1, ...cats.map((c) => Math.max(c.current, c.lastMonth, c.avg3)));

  const paceTiles = isMonth ? `<div class="cf-tiles">
    ${tile("Per day", fmtMoneyWhole(p.perDay), p.prevPerDay ? `last month ${fmtMoneyWhole(p.prevPerDay)}/day ${delta(p.perDay, p.prevPerDay)}` : "")}
    ${tile(isCur ? "Projected month" : "Month total", fmtMoneyWhole(p.projected), isCur ? `${fmtMoneyWhole(p.monthSpend)} so far ${MID} day ${p.dayOfMonth} of ${p.daysInMonth}` : p.prevSpend ? `last month ${fmtMoneyWhole(p.prevSpend)} ${delta(p.monthSpend, p.prevSpend)}` : "")}
    ${tile("Fixed vs variable", `${fmtMoneyWhole(p.fixed)} <span class="sub">/</span> ${fmtMoneyWhole(p.variable)}`, "rent, bills, subscriptions vs everything else")}
    ${tile("12-mo typical month", fmtMoneyWhole(st.medianSpend), `average ${fmtMoneyWhole(st.avgSpend)}`)}
  </div>` : "";

  const catTable = cats.length ? `<div class="card" style="margin-top:14px">
    <div class="label" style="margin-bottom:8px">Categories ${MID} ${esc(monthLabel(st.month))} vs last month</div>
    <div class="table-wrap"><table class="cf-cats">
      <thead><tr><th>Category</th><th>This month</th><th>Last month</th><th>Change</th><th>3-mo avg</th><th>Same month last year</th>${isCur ? "<th>Projected</th>" : ""}</tr></thead>
      <tbody>${cats.map((c) => `<tr class="cf-cat-row" data-cat="${c.category_id ?? "none"}" data-catname="${esc(c.name)}">
        <td><span class="catchip"><i style="background:${c.color ? `var(--${c.color})` : "var(--muted)"}"></i>${esc(c.name)}</span>
          <div class="track" style="height:4px;margin-top:4px;max-width:160px"><div class="fill" style="width:${Math.round(c.current / catMax * 100)}%"></div></div></td>
        <td><b>${fmtMoneyWhole(c.current)}</b></td>
        <td>${fmtMoneyWhole(c.lastMonth)}</td>
        <td>${delta(c.current, c.lastMonth)}</td>
        <td>${fmtMoneyWhole(c.avg3)}</td>
        <td>${c.lastYear ? fmtMoneyWhole(c.lastYear) : `<span class="sub">${MID}</span>`}</td>
        ${isCur ? `<td>${fmtMoneyWhole(c.projected)}</td>` : ""}
      </tr>`).join("")}</tbody></table></div>
    <div class="muted-note" style="margin-top:8px">Click a row to see its merchants. Change compares against last month; red means spending went up.</div>
  </div>` : "";

  const merchants = tops.length ? `<div class="card">
    <div class="label" style="margin-bottom:8px">Top merchants ${MID} ${esc(periodLabel())}</div>
    ${tops.map((m, i) => `<button type="button" class="txn txn-plain rowbtn cf-merchant" data-merchant="${esc(m.merchant)}" style="padding:8px 4px">
      <span class="sub mono" style="width:18px;text-align:right">${i + 1}</span>
      <span class="dot">${merchantTile({ merchant_name: m.merchant, name: m.merchant, logo_url: m.logo_url, website: m.website })}</span>
      <div class="who"><div class="m" style="font-size:13.5px">${esc(m.merchant)}</div>
        <div class="meta"><span>${m.count} &#215; ${fmtMoneyWhole(m.avg)} avg ${MID} ${m.share}% of spend</span></div></div>
      <div style="text-align:right"><div class="amt" style="font-size:13.5px">${fmtMoneyWhole(m.total)}</div><div class="sub" style="font-size:11.5px">${delta(m.total, m.prev)} vs prior</div></div>
    </button>`).join("")}
  </div>` : "";

  const weekdays = wk.length ? `<div class="card">
    <div class="label" style="margin-bottom:8px">Spend by weekday ${MID} 6-month daily average</div>
    <div class="cf-week">${wk.map((w) => `<div class="cf-day"><div class="cf-bar-wrap"><div class="cf-bar" style="height:${Math.max(3, Math.round(w.avg / wkMax * 100))}%" title="${esc(w.day)}: ${fmtMoneyWhole(w.avg)}/day"></div></div><div class="sub mono" style="font-size:10.5px">${w.day}</div><div class="sub" style="font-size:11px">${fmtMoneyWhole(w.avg)}</div></div>`).join("")}</div>
  </div>` : "";

  const monthTable = months.length ? `<div class="card" style="margin-top:14px">
    <div class="label" style="margin-bottom:8px">Month by month</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Month</th><th>Income</th><th>Spending</th><th>Net</th><th>Saved</th><th>Purchases</th></tr></thead>
      <tbody>${months.slice().reverse().map((m) => `<tr>
        <td>${esc(monthLabel(m.month))}</td><td>${fmtMoneyWhole(m.income)}</td><td>${fmtMoneyWhole(m.spending)}</td>
        <td class="${m.net >= 0 ? "pos" : "negd"}">${fmtMoney(m.net, { cents: false })}</td>
        <td>${m.rate == null ? `<span class="sub">${MID}</span>` : `${Math.round(m.rate)}%`}</td><td>${m.count}</td></tr>`).join("")}</tbody>
    </table></div>
  </div>` : "";

  const left = (st.leftOut || []).filter((r) => r.inflow > 0 || r.outflow > 0);
  const leftOut = left.length ? `<p class="muted-note" style="margin:12px 0 0">Not counted above (transfers, excluded, gift-type categories): ${left.map((r) => `${esc(r.name)} ${r.inflow ? `+${fmtMoneyWhole(r.inflow)}` : ""}${r.inflow && r.outflow ? " / " : ""}${r.outflow ? `${MINUS_SIGN}${fmtMoneyWhole(r.outflow)}` : ""}`).join(` ${MID} `)}. Change a category's kind in <a href="#/settings">Settings</a> to include it.</p>` : "";

  return `<div id="cf-stats">
    ${paceTiles}
    ${catTable}
    <div class="grid two" style="margin-top:14px">${merchants}${weekdays}</div>
    ${monthTable}
    ${leftOut}
  </div>`;
}
const MINUS_SIGN = "\u2212";

/** Mobile alternative to the sankey: category bars with share of spend. */
function spendListHtml(data) {
  const sp = (data.spending || []).filter((r) => r.amount > 0);
  const inc = Number(data.totalIncome) || 0;
  const total = Number(data.totalSpending) || 0;
  const max = Math.max(1, ...sp.map((r) => r.amount));
  return `<div class="cf-list">
    <div class="cf-list-row" style="margin-bottom:8px"><span><b>In</b></span><span class="mono pos">${fmtMoneyWhole(inc)}</span></div>
    ${sp.map((r) => `<button type="button" class="cf-list-row rowbtn" data-cat="${r.category_id ?? "none"}" data-catname="${esc(r.name)}">
      <span class="catchip"><i style="background:${r.color ? `var(--${r.color})` : "var(--muted)"}"></i>${esc(r.name)}</span>
      <span class="mono">${fmtMoneyWhole(r.amount)} <span class="sub">${inc > 0 ? Math.round(r.amount / inc * 100) + "%" : ""}</span></span>
      <div class="track" style="grid-column:1 / -1;height:5px"><div class="fill" style="width:${Math.round(r.amount / max * 100)}%;background:${r.color ? `var(--${r.color})` : "var(--muted)"}"></div></div>
    </button>`).join("")}
    <div class="cf-list-row" style="margin-top:8px;border-top:1px solid var(--line);padding-top:8px"><span><b>Out</b></span><span class="mono">${fmtMoneyWhole(total)}</span></div>
    <div class="cf-list-row"><span><b>Kept</b></span><span class="mono ${inc - total >= 0 ? "pos" : "negd"}">${fmtMoney(inc - total, { cents: false })}</span></div>
  </div>`;
}

function periodLabel() {
  if (period === "ytd") return `YTD ${currentMonth().slice(0, 4)}`;
  if (period === "1y") return "Last 12 mo";
  return monthLabel(month);
}

function flowTitle() {
  if (period === "ytd") return "Where this year's money went";
  if (period === "1y") return "Where the last 12 months' money went";
  return `Where ${monthLabel(month)}'s money went`;
}

export default async function render(main) {
  if (!month) month = currentMonth();
  const query = period === "month"
    ? `/cashflow?month=${encodeURIComponent(month)}`
    : `/cashflow?range=${period === "ytd" ? "ytd" : "1y"}`;
  let data, stats = null;
  try {
    const [d, st] = await Promise.all([api.get(query), api.get(statsQuery()).catch(() => null)]);
    data = d; stats = st;
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }
  data = data || {};
  const narrow = window.innerWidth < 640;
  const months = Array.isArray(data.months) ? data.months : [];
  const totalIncome = Number(data.totalIncome) || 0;
  const totalSpending = Number(data.totalSpending) || 0;
  const saved = Number(data.saved) || 0;
  const rate = Number(data.savingsRate) || 0;
  const hasFlow = totalIncome > 0 || totalSpending > 0;

  // 3-mo average savings rate (month mode only — ranges already aggregate)
  const last3 = months.slice(-3).filter((m) => (Number(m.income) || 0) > 0);
  const avg3 = period === "month" && last3.length
    ? Math.round(last3.reduce((a, m) => a + (m.income - m.spending) / m.income, 0) / last3.length * 100)
    : null;

  const sankeyData = hasFlow ? buildSankey(data) : null;
  const atCurrent = month >= currentMonth();
  const arrowsOn = period === "month";

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <h1>Cash flow</h1>
      <div class="chips" style="align-items:center">
        <span class="period-nav">
          <button type="button" class="navarrow" id="cf-prev" aria-label="Previous month"${arrowsOn ? "" : " disabled"}>&#8249;</button>
          <span class="period-label" id="cf-label">${esc(periodLabel())}</span>
          <button type="button" class="navarrow" id="cf-next" aria-label="Next month"${arrowsOn && !atCurrent ? "" : " disabled"}>&#8250;</button>
        </span>
        <button type="button" class="chip${period === "month" ? " active" : ""}" data-period="month">Month</button>
        <button type="button" class="chip${period === "ytd" ? " active" : ""}" data-period="ytd">YTD</button>
        <button type="button" class="chip${period === "1y" ? " active" : ""}" data-period="1y">1Y</button>
      </div>
    </div>

    <div class="card">
      <div class="label" style="margin-bottom:10px">${esc(flowTitle())}</div>
      ${sankeyData && narrow
        ? `${spendListHtml(data)}<div id="cf-drill" hidden></div>`
        : sankeyData
        ? `<figure>
            <svg id="cf-sankey" viewBox="0 0 900 330" role="img" aria-label="Money flow for ${esc(periodLabel())}: ${fmtMoneyWhole(totalIncome)} of income traced to spending categories with ${fmtMoneyWhole(saved)} kept as savings"></svg>
            <figcaption class="sub" style="margin-top:8px">Every dollar in, traced to where it went. Each category keeps its own color; green = kept. Click a node to break it down.</figcaption>
          </figure>
          <div id="cf-drill" hidden></div>`
        : emptyState({
            title: "No cash flow yet",
            body: "Once income and spending land in your accounts, this traces every dollar from paycheck to category.",
            actionLabel: "Go to Settings → Link account", actionHash: "#/settings", glyph: "flow",
          })}
    </div>

    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <div class="label" style="margin-bottom:10px">Income vs spending ${MID} ${months.length || 6} months</div>
        ${months.length
          ? `<figure><svg id="cf-bars" viewBox="0 0 440 200" role="img" aria-label="Monthly income versus spending, ${months.length} months"></svg></figure>
             <div class="legend"><span><i style="background:var(--c1)"></i>Income</span><span><i style="background:var(--c2)"></i>Spending</span><span class="sub" style="margin-left:auto">hover a bar for the amount</span></div>`
          : emptyState({ title: "No history yet", body: "Monthly income and spending bars appear after your first full month of data.", glyph: "bars" })}
      </div>
      <div class="card" style="display:flex;flex-direction:column;justify-content:center;gap:4px">
        <div class="label">Savings rate ${MID} ${esc(period === "month" ? monthShort(month) : periodLabel())}</div>
        ${hasFlow && totalIncome > 0
          ? `<div class="hero-num" style="color:var(--accent)">${Math.round(rate * (Math.abs(rate) <= 1 ? 100 : 1))}%</div>
             <div class="sub">${fmtMoneyWhole(saved)} kept${avg3 != null ? ` ${MID} 3-month average ${avg3}%` : ""}</div>`
          : `<div class="hero-num" style="color:var(--muted)">&#8212;</div>
             <div class="sub">Savings rate shows once income arrives.</div>`}
      </div>
    </div>
    ${statsHtml(stats)}
  </div>`;

  // stats interactions: category rows + merchants drill into the transaction list
  main.querySelectorAll(".cf-cat-row, .cf-list-row[data-cat]").forEach((row) => row.addEventListener("click", () => {
    const panel = main.querySelector("#cf-drill");
    if (panel) drill(main, data, `cat:${row.dataset.cat}`, row.dataset.catname);
    else location.hash = `#/activity?category=${encodeURIComponent(row.dataset.cat)}`;
  }));
  main.querySelectorAll(".cf-merchant").forEach((row) => row.addEventListener("click", () => {
    const { from, to } = periodRange();
    location.hash = `#/activity?q=${encodeURIComponent(row.dataset.merchant)}&from=${from}&to=${to}`;
  }));

  if (sankeyData && !narrow) {
    const drew = sankey(document.getElementById("cf-sankey"), sankeyData, {
      onNodeClick: (nid, nlabel) => drill(main, data, nid, nlabel),
    });
    if (!drew) {
      const fig = main.querySelector("#cf-sankey");
      if (fig && fig.closest("figure")) {
        fig.closest("figure").outerHTML = emptyState({
          title: "Not enough flow to draw yet",
          body: "The flow diagram needs both income and spending in the period.",
          glyph: "flow",
        });
      }
    }
  }
  if (months.length) {
    groupedBars(
      document.getElementById("cf-bars"),
      months.map((m) => monthShort(m.month)),
      months.map((m) => Number(m.income) || 0),
      months.map((m) => Number(m.spending) || 0),
    );
  }

  main.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => {
    if (period === b.dataset.period) return;
    period = b.dataset.period;
    if (period === "month" && (!month || month > currentMonth())) month = currentMonth();
    render(main);
  }));
  const prev = main.querySelector("#cf-prev");
  const next = main.querySelector("#cf-next");
  if (prev) prev.addEventListener("click", () => {
    if (period !== "month") return;
    month = shiftMonth(month, -1);
    render(main);
  });
  if (next) next.addEventListener("click", () => {
    if (period !== "month" || month >= currentMonth()) return;
    month = shiftMonth(month, 1);
    render(main);
  });
}
