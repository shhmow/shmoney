// Cash flow: sankey laid out from /api/cashflow data, monthly bars, savings tile.
// Periods: single month (with prev/next arrows), YTD, trailing 12 months.
import { api } from "../lib/api.js";
import {
  esc, fmtMoneyWhole, emptyState, errorCard, currentMonth, shiftMonth, monthShort, monthLabel, MID,
} from "../lib/format.js";
import { sankey, groupedBars } from "../lib/charts.js";

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

  if (nid === "hub") return;
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
      ${head("Grouped categories", periodLabel())}
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
  let data;
  try {
    data = await api.get(query);
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }
  data = data || {};
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
      ${sankeyData
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
             <div class="legend"><span><i style="background:var(--c1)"></i>Income</span><span><i style="background:var(--c2)"></i>Spending</span></div>`
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
  </div>`;

  if (sankeyData) {
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
