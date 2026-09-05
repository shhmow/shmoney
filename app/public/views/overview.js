// Overview: net worth hero + chart, grouped accounts, this-month cashflow,
// free-to-spend pace, recent activity.
import { api } from "../lib/api.js";
import {
  esc, fmtMoney, fmtMoneyWhole, fmtPct, catChip, txnAmount, fmtDate,
  emptyState, errorCard, parseDate, currentMonth, MID,
} from "../lib/format.js";
import { areaChart, paceChart } from "../lib/charts.js";
import { rangeDelta, deltaBadge } from "../lib/investcharts.js";
import { instTile, networkBadge, merchantTile, merchantLabel } from "../lib/brand.js";
import { openDetail, ensureRefs } from "./activity.js";

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

function utilization(a) {
  const limit = Number(a.credit_limit || a.manual_limit || 0);
  const bal = Math.abs(Number(a.current_balance || 0));
  if (!(limit > 0)) return null;
  const pct = bal / limit * 100;
  return { limit, bal, pct, cls: pct >= 90 ? "over" : pct >= 30 ? "warn" : "" };
}

function acctCard(a, group) {
  const bal = Number(a.current_balance ?? a.balance ?? 0);
  const isCredit = group === "credit";
  const shown = isCredit ? -Math.abs(bal) : bal;
  const name = a.nickname || a.name;
  const bits = [];
  if (a.mask) bits.push(`${MID}${MID} ${esc(a.mask)}`);
  if (a.institution_name) bits.push(esc(a.institution_name));
  if (!a.mask && !a.institution_name) bits.push(esc(a.subtype || a.type || ""));
  const u = isCredit ? utilization(a) : null;
  const avail = isCredit && !u && a.available_balance != null ? `<span class="acct-sub">${fmtMoneyWhole(a.available_balance)} available</span>` : "";
  const target = group === "investments" ? `#/invest?account=${encodeURIComponent(a.id)}` : `#/activity?account=${encodeURIComponent(a.id)}`;
  return `<a class="card acct-card clickable" href="${target}" style="text-decoration:none;color:inherit" aria-label="${esc(name)}, ${esc(fmtMoney(shown))}">
    <div class="acct-top">${instTile(a, { size: 30 })}<span class="acct-name" title="${esc(a.name)}">${esc(name)}</span>${networkBadge(a, 20)}</div>
    <span class="acct-bal${shown < 0 ? " neg" : ""}">${fmtMoney(shown)}</span>
    <span class="acct-sub">${bits.join(` ${MID} `)}</span>
    ${avail}
    ${u ? `<div class="util"><div class="track"><div class="fill ${u.cls}" style="width:${Math.min(100, u.pct).toFixed(1)}%"></div></div>
      <div class="sub"><span>${Math.round(u.pct)}% of ${fmtMoneyWhole(u.limit)}</span><span>${fmtMoneyWhole(Math.max(0, u.limit - u.bal))} left</span></div></div>` : ""}
  </a>`;
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
function recentRow(t, acctMap) {
  const merchant = merchantLabel(t);
  const amt = txnAmount(t.amount);
  const a = acctMap.get(String(t.account_id));
  const acct = a || t.account_name
    ? `<span class="acct-tag">${a ? instTile(a, { size: 14, cls: "tiny" }) : ""}<span>${esc(a ? (a.nickname || a.name) : t.account_name)}</span></span>` : "";
  const when = `<span class="sub" style="font-size:11.5px">${esc(fmtDate(t.date))}</span>`;
  return `<button type="button" class="txn txn-plain rowbtn${t.pending ? " pending" : ""}" data-txn="${esc(t.id)}" aria-label="${esc(merchant)}, ${esc(amt.text)}, ${esc(fmtDate(t.date))}">
    <span class="dot">${merchantTile(t)}</span>
    <div class="who"><div class="m" title="${esc(t.name || "")}">${esc(merchant)}${t.flagged ? ' <span class="flag-mark">&#9873;</span>' : ""}</div>
      <div class="meta">${when}${catChip(t.category_name, t.category_color)}${acct}</div></div>
    <div class="${amt.cls}">${amt.text}</div>
  </button>`;
}

/* "This month" card body: income vs spending bars + savings line. */
function thisMonthBody(cf, monthName, st) {
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
  const p = st && st.pace;
  const paceLine = p && p.dayOfMonth >= 2
    ? `<div class="sub" style="margin-top:6px"><b style="color:var(--ink)">${fmtMoneyWhole(p.perDay)}</b>/day${p.prevPerDay ? ` (last month ${fmtMoneyWhole(p.prevPerDay)})` : ""} ${MID} on pace for <b style="color:var(--ink)">${fmtMoneyWhole(p.projected)}</b>${p.prevSpend ? ` vs ${fmtMoneyWhole(p.prevSpend)} last month` : ""} ${MID} <a href="#/cashflow" style="color:var(--ink-2)">details</a></div>`
    : "";
  return `${head}
    <div class="cfbars">
      ${bar("Income", inc, "var(--c1)")}
      ${bar("Spending", sp, "var(--c2)")}
    </div>
    ${savedLine}${paceLine}`;
}

/* Free to spend card body. Null/zero budget -> friendly unlock card, never a
   meaningless negative number. */
function upcomingList(recurring) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + 30);
  const due = (recurring || [])
    .filter((r) => r.active !== 0 && r.active !== false && !r.stale && r.next_date)
    .map((r) => ({ ...r, d: parseDate(r.next_date) }))
    .filter((r) => r.d >= today && r.d <= horizon)
    .sort((a, b) => a.d - b.d);
  if (!due.length) return "";
  const total = due.reduce((a, r) => a + Math.abs(Number(r.avg_amount) || 0), 0);
  return `<div class="upcoming">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:14px 0 4px">
      <span class="label">Next 30 days</span><span class="sub">${due.length} bill${due.length === 1 ? "" : "s"} ${MID} ${fmtMoneyWhole(total)}</span></div>
    ${due.slice(0, 4).map((r) => `<div class="upc-row"><span class="sub mono" style="width:52px">${esc(fmtDate(r.next_date))}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.merchant || r.name || "")}</span><span class="mono">${fmtMoneyWhole(Math.abs(Number(r.avg_amount) || 0))}</span></div>`).join("")}
    ${due.length > 4 ? `<a class="sub" href="#/recurring" style="text-decoration:none">+${due.length - 4} more &#8594;</a>` : ""}
  </div>`;
}

function ftsBody(fts, monthName, recurring) {
  const hasBudget = fts && fts.amount != null && Number(fts.budgetTotal) > 0;
  if (!hasBudget) {
    return `<div class="fts-head"><div class="label">Free to spend ${MID} ${esc(monthName)}</div></div>
      ${emptyState({
        title: "Set monthly budgets to unlock Free to Spend",
        body: "Once budgets are in, this shows what's actually safe to spend for the rest of the month, after upcoming bills.",
        actionLabel: "Set up budgets",
        actionHash: "#/budget",
        glyph: "bars",
      })}${upcomingList(recurring)}`;
  }
  const daysLeft = Number(fts.daysLeft) || 0;
  const upcoming = Number(fts.upcomingBills) || 0;
  return `<div class="fts-head">
      <div class="label">Free to spend ${MID} ${esc(monthName)}</div>
      <span class="sub">${daysLeft} day${daysLeft === 1 ? "" : "s"} left</span>
    </div>
    <div class="hero-num fts-num">${fmtMoneyWhole(fts.amount)}</div>
    <div class="sub" id="fts-sub">after ${fmtMoneyWhole(upcoming)} of upcoming bills</div>
    <figure class="fts-fig"><svg id="pace-chart" viewBox="0 0 420 130" role="img" aria-label="Cumulative spending this month versus even pace"></svg></figure>
    ${upcomingList(recurring)}`;
}

export default async function render(main) {
  let data, cashflow = null, stats = null, recurring = [];
  try {
    const [ovRes, cfRes, stRes, rcRes] = await Promise.allSettled([
      api.get("/overview"),
      api.get("/cashflow?month=" + currentMonth()),
      api.get("/stats?month=" + currentMonth()),
      api.get("/recurring"),
    ]);
    if (ovRes.status === "rejected") throw ovRes.reason;
    data = ovRes.value;
    cashflow = cfRes.status === "fulfilled" ? cfRes.value : null;
    stats = stRes.status === "fulfilled" ? stRes.value : null;
    recurring = rcRes.status === "fulfilled" && Array.isArray(rcRes.value) ? rcRes.value : [];
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
  const allAccts = [...(groups.cash || []), ...(groups.credit || []), ...(groups.investments || [])];
  const acctMap = new Map(allAccts.map((a) => [String(a.id), a]));

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
        ? `<figure><svg id="nw-chart" viewBox="0 0 900 240" role="img" aria-label="Net worth over time"></svg>
           ${nw.fullFrom ? `<figcaption class="muted-note" style="margin-top:6px">Before ${esc(fmtDate(nw.fullFrom))} cash and card balances are rebuilt from transaction history; investments before linking are reconstructed from trades and prices.</figcaption>` : ""}</figure>`
        : emptyState({ title: "Net worth chart is warming up", body: "Daily balance snapshots build this chart. Check back after a couple of syncs.", glyph: "chart" })}
    </div>

    ${groupBlock("Cash", groups.cash, "cash")}
    ${groupBlock("Credit cards", groups.credit, "credit")}
    ${groupBlock("Investments", groups.investments, "investments")}

    <div class="grid two ov-bottom">
      <div class="card">${thisMonthBody(cashflow, monthName, stats)}</div>
      <div class="card">${ftsBody(fts, monthName, recurring)}</div>
    </div>

    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div class="label">Recent activity</div>
        <a class="sub" href="#/activity" style="text-decoration:none">See all &#8594;</a>
      </div>
      ${recent.length
        ? recent.map((t) => recentRow(t, acctMap)).join("")
        : emptyState({ title: "No transactions yet", body: "Recent activity across all accounts shows up here after your first sync.", glyph: "list" })}
    </div>
  </div>`;

  // recent rows open the same detail sheet as Activity
  main.querySelectorAll("[data-txn]").forEach((row) => row.addEventListener("click", async () => {
    const t = recent.find((x) => String(x.id) === String(row.dataset.txn));
    if (!t) return;
    await ensureRefs();
    openDetail(t, () => render(main));
  }));

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
    const note = spent <= ideal
      ? `${fmtMoneyWhole(spent)} spent by day ${today}; even pace would be ${fmtMoneyWhole(ideal)}`
      : `${fmtMoneyWhole(spent)} spent by day ${today}, ${fmtMoneyWhole(spent - ideal)} over an even pace of ${fmtMoneyWhole(ideal)}`;
    const subEl = main.querySelector("#fts-sub");
    if (subEl) subEl.innerHTML = `after ${fmtMoneyWhole(upcoming)} of upcoming bills ${MID} ${note}`;
  }
}
