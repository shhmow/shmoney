// Overview: net worth hero + chart, grouped accounts, this-month cashflow,
// free-to-spend pace, recent activity.
import { api } from "../lib/api.js";
import {
  esc, fmtMoney, fmtMoneyWhole, fmtPct, catChip, txnAmount,
  emptyState, errorCard, parseDate, currentMonth, MID,
} from "../lib/format.js";
import { areaChart, paceChart } from "../lib/charts.js";
import { rangeDelta, deltaBadge } from "../lib/investcharts.js";

const RANGES = { "1M": 31, "3M": 92, "1Y": 366, "All": Infinity };
const RANGE_LABELS = { "1M": "past month", "3M": "past 3 months", "1Y": "past year", "All": "all time" };
let activeRange = "1Y";

function seriesFor(series, rangeKey) {
  const days = RANGES[rangeKey] ?? Infinity;
  if (days === Infinity) return series;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const filtered = series.filter((p) => parseDate(p.date) >= cutoff);
  return filtered.length >= 2 ? filtered : series;
}

function chartLabels(points) {
  if (points.length === 0) return [];
  const spanDays = (parseDate(points[points.length - 1].date) - parseDate(points[0].date)) / 86400000;
  return points.map((p) => {
    const d = parseDate(p.date);
    const mon = d.toLocaleDateString("en-US", { month: "short" });
    return spanDays <= 95 ? `${mon} ${d.getDate()}` : mon;
  });
}

function acctCard(a, group) {
  const bal = Number(a.current_balance ?? a.balance ?? 0);
  const isCredit = group === "credit";
  const shown = isCredit ? -Math.abs(bal) : bal;
  const sub = a.mask ? `${MID}${MID} ${esc(a.mask)}` : esc(a.subtype || a.type || "");
  return `<div class="card acct-card">
    <span class="acct-name">${esc(a.name)}</span>
    <span class="acct-bal${shown < 0 ? " neg" : ""}">${fmtMoney(shown)}</span>
    <span class="acct-sub">${sub}</span>
  </div>`;
}

function groupBlock(label, accts, group) {
  if (!accts || accts.length === 0) return "";
  const total = accts.reduce((s, a) => {
    const b = Number(a.current_balance ?? a.balance ?? 0);
    return s + (group === "credit" ? -Math.abs(b) : b);
  }, 0);
  return `<div class="group-title"><span class="label">${esc(label)}</span><span class="gt-line"></span><span class="label">${fmtMoney(total)}</span></div>
    <div class="grid acct">${accts.map((a) => acctCard(a, group)).join("")}</div>`;
}

/* recent activity rows: category-text style, no initials tiles (matches activity.js) */
function recentRow(t) {
  const merchant = t.merchant_name || t.name || "Unknown";
  const amt = txnAmount(t.amount);
  const acct = t.account_name ? `<span class="acct-tag">${esc(t.account_name)}</span>` : "";
  return `<div class="txn txn-plain${t.pending ? " pending" : ""}">
    <div class="who"><div class="m">${esc(merchant)}</div>
      <div class="meta">${catChip(t.category_name, t.category_color)}${acct}</div></div>
    <div class="${amt.cls}">${amt.text}</div>
  </div>`;
}

/* "This month" card body: income vs spending bars + savings line. */
function thisMonthBody(cf, monthName) {
  const head = `<div class="fts-head"><div class="label">This month ${MID} ${esc(monthName)}</div></div>`;
  if (!cf) {
    return head + `<p class="iv-err">Couldn't load cashflow ${MID} it'll be back on the next refresh.</p>`;
  }
  const inc = Number(cf.totalIncome) || 0;
  const sp = Number(cf.totalSpending) || 0;
  if (inc === 0 && sp === 0) {
    return head + emptyState({
      title: "Nothing in or out yet",
      body: "Income vs spending fills in here as this month's transactions sync.",
      glyph: "bars",
    });
  }
  const max = Math.max(inc, sp, 1);
  const saved = cf.saved != null ? Number(cf.saved) : inc - sp;
  const rate = inc > 0 ? Math.round((saved / inc) * 100) : null;
  const bar = (name, val, color) => `<div class="cfrow">
    <span class="cfname">${name}</span>
    <div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, (val / max) * 100))}%;background:${color}"></div></div>
    <span class="cfval">${fmtMoneyWhole(val)}</span>
  </div>`;
  const savedLine = saved >= 0
    ? `<div class="sub cfsaved">Saved <b class="pos">${fmtMoneyWhole(saved)}</b>${rate != null ? ` ${MID} ${rate}% of income` : ""}</div>`
    : `<div class="sub cfsaved"><span style="color:var(--warn)">${fmtMoneyWhole(Math.abs(saved))} more out than in</span> so far</div>`;
  return `${head}
    <div class="cfbars">
      ${bar("Income", inc, "var(--c1)")}
      ${bar("Spending", sp, "var(--c2)")}
    </div>
    ${savedLine}`;
}

/* Free to spend card body. Null/zero budget -> friendly unlock card, never a
   meaningless negative number. */
function ftsBody(fts, monthName) {
  const hasBudget = fts && fts.amount != null && Number(fts.budgetTotal) > 0;
  if (!hasBudget) {
    return `<div class="fts-head"><div class="label">Free to spend ${MID} ${esc(monthName)}</div></div>
      ${emptyState({
        title: "Set monthly budgets to unlock Free to Spend",
        body: "Once budgets are in, this shows what's actually safe to spend for the rest of the month, after upcoming bills.",
        actionLabel: "Set up budgets",
        actionHash: "#/budget",
        glyph: "bars",
      })}`;
  }
  const daysLeft = Number(fts.daysLeft) || 0;
  const upcoming = Number(fts.upcomingBills) || 0;
  return `<div class="fts-head">
      <div class="label">Free to spend ${MID} ${esc(monthName)}</div>
      <span class="sub">${daysLeft} day${daysLeft === 1 ? "" : "s"} left</span>
    </div>
    <div class="hero-num fts-num">${fmtMoneyWhole(fts.amount)}</div>
    <div class="sub" id="fts-sub">after ${fmtMoneyWhole(upcoming)} of upcoming bills</div>
    <figure class="fts-fig"><svg id="pace-chart" viewBox="0 0 420 130" role="img" aria-label="Cumulative spending this month versus even pace"></svg></figure>`;
}

export default async function render(main) {
  let data, cashflow = null;
  try {
    const [ovRes, cfRes] = await Promise.allSettled([
      api.get("/overview"),
      api.get("/cashflow?month=" + currentMonth()),
    ]);
    if (ovRes.status === "rejected") throw ovRes.reason;
    data = ovRes.value;
    cashflow = cfRes.status === "fulfilled" ? cfRes.value : null;
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }
  data = data || {};
  const nw = data.netWorth || { current: 0, change1m: 0, series: [] };
  const groups = data.groups || { cash: [], credit: [], investments: [] };
  const fts = data.freeToSpend || null;
  const recent = data.recent || [];
  const nAccounts = (groups.cash?.length || 0) + (groups.credit?.length || 0) + (groups.investments?.length || 0);

  if (nAccounts === 0) {
    main.innerHTML = `<div class="page">
      <div class="pagehead"><div><div class="label">Net worth</div><div class="hero-num">$0</div></div></div>
      <div class="card">${emptyState({
        title: "Welcome to shmoney",
        body: "Link your first bank to pull in accounts, balances, and transactions. Everything on this page comes to life after your first sync.",
        actionLabel: "Go to Settings → Link account",
        actionHash: "#/settings",
        glyph: "coins",
      })}</div>
    </div>`;
    return;
  }

  // Fallback delta (shown until the chart draws, and whenever the series is
  // too short for a per-range computation): API-provided 1-month change.
  const change = Number(nw.change1m) || 0;
  const prev = (Number(nw.current) || 0) - change;
  const pct = prev !== 0 ? Math.abs(change / prev) * 100 : 0;
  const fallbackDelta = change === 0
    ? `<span class="sub">no change past month</span>`
    : `<span class="delta ${change >= 0 ? "up" : "down"}">${change >= 0 ? "&#9650;" : "&#9660;"} ${fmtMoneyWhole(Math.abs(change))} (${fmtPct(pct)})</span> <span class="sub">past month</span>`;

  const series = Array.isArray(nw.series) ? nw.series : [];
  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <div>
        <div class="label">Net worth</div>
        <div class="hero-num">${fmtMoneyWhole(nw.current)}</div>
        <span id="nw-delta">${fallbackDelta}</span>
      </div>
      <div class="chips" id="nw-ranges">
        ${Object.keys(RANGES).map((r) => `<button type="button" class="chip${r === activeRange ? " active" : ""}" data-range="${r}">${r}</button>`).join("")}
      </div>
    </div>

    <div class="card">
      ${series.length >= 2
        ? `<figure><svg id="nw-chart" viewBox="0 0 900 240" role="img" aria-label="Net worth over time"></svg></figure>`
        : emptyState({ title: "Net worth chart is warming up", body: "Daily balance snapshots build this chart. Check back after a couple of syncs.", glyph: "chart" })}
    </div>

    ${groupBlock("Cash", groups.cash, "cash")}
    ${groupBlock("Credit cards", groups.credit, "credit")}
    ${groupBlock("Investments", groups.investments, "investments")}

    <div class="grid two ov-bottom">
      <div class="card">${thisMonthBody(cashflow, monthName)}</div>
      <div class="card">${ftsBody(fts, monthName)}</div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:6px">Recent activity</div>
      ${recent.length
        ? recent.map(recentRow).join("")
        : emptyState({ title: "No transactions yet", body: "Recent activity across all accounts shows up here after your first sync.", glyph: "list" })}
    </div>
  </div>`;

  // ---------------------------------------------------------------- nw chart
  const drawNw = () => {
    const svg = document.getElementById("nw-chart");
    if (!svg) return;
    const pts = seriesFor(series, activeRange);
    areaChart(svg, pts.map((p) => Number(p.value) || 0), chartLabels(pts), "#1fa168");
    // per-range change next to the hero value
    const deltaEl = document.getElementById("nw-delta");
    const d = rangeDelta(pts);
    if (deltaEl && d) deltaEl.innerHTML = deltaBadge(d, RANGE_LABELS[activeRange] || "");
  };
  drawNw();
  main.querySelectorAll("#nw-ranges .chip").forEach((b) => b.addEventListener("click", () => {
    activeRange = b.dataset.range;
    main.querySelectorAll("#nw-ranges .chip").forEach((x) => x.classList.toggle("active", x === b));
    drawNw();
  }));

  // -------------------------------------------------------------- pace chart
  const hasBudget = fts && fts.amount != null && Number(fts.budgetTotal) > 0;
  if (hasBudget) {
    const daysLeft = Number(fts.daysLeft) || 0;
    const upcoming = Number(fts.upcomingBills) || 0;
    const paceSeries = Array.isArray(fts.paceSeries) ? fts.paceSeries : [];
    const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const today = Math.max(1, days - daysLeft);
    // build cumulative-by-day array from paceSeries
    const actual = [0];
    let last = 0;
    const byDay = new Map(paceSeries.map((p) => [Number(p.day), Number(p.cumulative) || 0]));
    const maxDay = Math.min(days, Math.max(today, ...paceSeries.map((p) => Number(p.day) || 0)));
    for (let d = 1; d <= maxDay; d++) {
      if (byDay.has(d)) last = byDay.get(d);
      actual.push(last);
    }
    paceChart(document.getElementById("pace-chart"), {
      actual,
      budget: Number(fts.idealTotal) || Number(fts.budgetTotal) || 0,
      days,
      today,
      currentLabel: fmtMoneyWhole(fts.spentTotal ?? last),
    });
    // pace note
    const spent = Number(fts.spentTotal) || last;
    const ideal = (Number(fts.idealTotal) || Number(fts.budgetTotal) || 0) * today / days;
    const note = spent <= ideal ? "slightly ahead of pace" : "running above pace";
    const subEl = main.querySelector("#fts-sub");
    if (subEl) subEl.innerHTML = `after ${fmtMoneyWhole(upcoming)} of upcoming bills ${MID} ${note}`;
  }
}
