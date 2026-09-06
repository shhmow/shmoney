// Taxes: rough estimate of the year's federal, SE, and state tax from real
// income categories, tagged business expenses, and Taxes-category payments.
// Planning estimate only; the math is deliberately simple and stated openly.
import { api } from "../lib/api.js";
import { esc, errorCard, debounce, MID } from "../lib/format.js";

let tab = "estimate";
let data = null;     // /api/taxes response
let profile = null;  // tax_profile setting (persisted JSON)
let expQuery = "";
let expResults = null;

/* ---------------- rate tables (2026) ---------------- */
// Simplified 2026 state tables. Flat states use rate + a standard deduction
// or exemption; progressive states are approximated with a few brackets.
const STATES = {
  AZ: { name: "Arizona", type: "flat", rate: .025, sd: 15750, note: "2.5% flat" },
  CA: { name: "California", type: "brackets", sd: 5706, ex: 0,
        brackets: [[10906, .01], [25842, .02], [40784, .04], [56612, .06], [71528, .08], [Infinity, .093]],
        note: "simplified brackets" },
  CO: { name: "Colorado", type: "flat", rate: .044, sd: 15750, note: "4.4% flat" },
  GA: { name: "Georgia", type: "flat", rate: .0519, sd: 12000, note: "5.19% flat" },
  IL: { name: "Illinois", type: "flat", rate: .0495, ex: 2850, note: "4.95% flat" },
  IN: { name: "Indiana", type: "flat", rate: .0295, ex: 1000, note: "2.95% flat, county tax not included" },
  KY: { name: "Kentucky", type: "flat", rate: .04, sd: 3270, note: "4% flat" },
  MA: { name: "Massachusetts", type: "flat", rate: .05, ex: 4400, note: "5% flat" },
  MI: { name: "Michigan", type: "flat", rate: .0425, ex: 5800, note: "4.25% flat, city tax not included" },
  NC: { name: "North Carolina", type: "flat", rate: .0399, sd: 12750, note: "3.99% flat" },
  NJ: { name: "New Jersey", type: "brackets", sd: 0, ex: 1000,
        brackets: [[20000, .014], [35000, .0175], [40000, .035], [75000, .05525], [500000, .0637], [Infinity, .0897]],
        note: "simplified brackets" },
  NY: { name: "New York", type: "brackets", sd: 8000, ex: 0,
        brackets: [[8500, .04], [11700, .045], [13900, .0525], [80650, .055], [215400, .06], [Infinity, .0685]],
        note: "simplified brackets, NYC tax not included" },
  OH: { name: "Ohio", type: "brackets", sd: 0, ex: 0,
        brackets: [[26050, 0], [100000, .0275], [Infinity, .035]], note: "simplified brackets" },
  PA: { name: "Pennsylvania", type: "flat", rate: .0307, note: "3.07% flat, local tax not included" },
  UT: { name: "Utah", type: "flat", rate: .045, note: "4.5% flat, credits not modeled" },
  VA: { name: "Virginia", type: "brackets", sd: 8500, ex: 0,
        brackets: [[3000, .02], [5000, .03], [17000, .05], [Infinity, .0575]], note: "simplified brackets" },
  WI: { name: "Wisconsin", type: "brackets", sd: 13930, ex: 0,
        brackets: [[14680, .035], [29370, .044], [323290, .053], [Infinity, .0765]], note: "simplified brackets" },
  AK: { name: "Alaska", type: "none", note: "no income tax" },
  FL: { name: "Florida", type: "none", note: "no income tax" },
  NV: { name: "Nevada", type: "none", note: "no income tax" },
  NH: { name: "New Hampshire", type: "none", note: "no wage tax" },
  SD: { name: "South Dakota", type: "none", note: "no income tax" },
  TN: { name: "Tennessee", type: "none", note: "no income tax" },
  TX: { name: "Texas", type: "none", note: "no income tax" },
  WA: { name: "Washington", type: "none", note: "no income tax" },
  WY: { name: "Wyoming", type: "none", note: "no income tax" },
};
const FED = {
  single: { sd: 16100, brackets: [[12400, .10], [50400, .12], [105700, .22], [201775, .24], [256225, .32], [640600, .35], [Infinity, .37]] },
  mfj:    { sd: 32200, brackets: [[24800, .10], [100800, .12], [211400, .22], [403550, .24], [512450, .32], [640600, .35], [Infinity, .37]] },
};
const TREATS = { w2: "W2 withheld", se: "1099 self emp", none: "Not taxable" };

/* ---------------- profile ---------------- */
// New income sources start as W2 in the resident state unless the name says
// otherwise (freelance, contract, PayPal, Venmo, 1099 read as self-employment).
function defaultTreatment(name, res) {
  const n = name.toLowerCase();
  const se = /freelanc|contract|consult|1099|paypal|venmo|stripe|client|side/.test(n);
  return { treat: se ? "se" : "w2", state: res, fedWh: 0, stWh: 0 };
}

function ensureProfile() {
  if (!profile || typeof profile !== "object") profile = {};
  if (!profile.filing) profile.filing = "single";
  if (!profile.res || !STATES[profile.res]) profile.res = "CA";
  if (!profile.treatments) profile.treatments = {};
  if (!profile.payments) profile.payments = {};
  for (const s of data.sources) {
    if (!profile.treatments[s.category_id]) profile.treatments[s.category_id] = defaultTreatment(s.name, profile.res);
  }
  for (const p of data.payments) {
    if (!profile.payments[p.id]) {
      const n = p.name.toLowerCase();
      // Federal unless the descriptor names a state ("MA DOR", "FRANCHISE TAX BD", "NYS DTF").
      const st = Object.keys(STATES).find((code) => new RegExp(`\\b${code}\\b|${STATES[code].name.toLowerCase()}`).test(n));
      const kind = /irs|usatax|us treas/.test(n) || !st ? "fed" : st;
      // A payment early in the year is usually the PRIOR year's filing balance.
      const priorYear = p.date < `${data.year}-06-01`;
      profile.payments[p.id] = { kind, year: priorYear ? String(Number(data.year) - 1) : data.year };
    }
  }
}

const saveProfile = debounce(() => {
  api.put("/settings", { tax_profile: profile }).catch(() => {});
}, 600);

/* ---------------- calc ---------------- */
function progressive(taxable, brackets) {
  let tax = 0, lo = 0;
  for (const [hi, rate] of brackets) {
    if (taxable > lo) tax += (Math.min(taxable, hi) - lo) * rate;
    lo = hi;
  }
  return tax;
}

function expensesFor(cid) {
  const e = (data.expenses || []).find((x) => x.category_id === cid);
  return e ? e.total : 0;
}

function calc() {
  const fed = FED[profile.filing] || FED.single;
  const rows = data.sources.map((s) => {
    const t = profile.treatments[s.category_id];
    const exp = t.treat === "se" ? Math.min(expensesFor(s.category_id), s.gross) : 0;
    return { ...s, ...t, exp, net: s.gross - exp };
  });
  const active = rows.filter((s) => s.treat !== "none");
  const w2 = active.filter((s) => s.treat === "w2");
  const se = active.filter((s) => s.treat === "se");
  const wages = w2.reduce((a, s) => a + s.gross, 0);
  const seNetIncome = se.reduce((a, s) => a + s.net, 0);       // after expenses
  const seBase = seNetIncome * .9235;
  const seTax = Math.max(0, seBase * .153);
  const halfSE = seTax / 2;
  const agi = wages + seNetIncome - halfSE;
  const taxable = Math.max(0, agi - fed.sd);
  const fedTax = progressive(taxable, fed.brackets);

  // States. Resident state taxes ALL income with a credit for tax paid to a
  // nonresident work state; nonresident states tax only their sourced income.
  const res = profile.res;
  const stateOut = {}; // code -> {tax, note}
  const nonres = {};   // code -> sourced base
  for (const s of active) {
    if (s.state === res) continue;
    const st = STATES[s.state];
    if (!st || st.type === "none") continue;
    const base = s.treat === "se" && seNetIncome > 0 ? s.net - halfSE * (s.net / seNetIncome) : s.gross;
    nonres[s.state] = (nonres[s.state] || 0) + base;
  }
  let credits = 0;
  for (const code of Object.keys(nonres)) {
    const st = STATES[code];
    const t = Math.max(0, nonres[code] - (st.sd || 0) - (st.ex || 0));
    const tax = st.type === "flat" ? t * st.rate : progressive(t, st.brackets);
    if (tax > 0) stateOut[code] = { tax, note: `${st.note}, nonresident` };
  }
  const resSt = STATES[res];
  if (resSt && resSt.type !== "none") {
    const base = wages + seNetIncome - halfSE;
    const t = Math.max(0, base - (resSt.sd || 0) - (resSt.ex || 0));
    let resTax = resSt.type === "flat" ? t * resSt.rate : progressive(t, resSt.brackets);
    // Credit for tax paid to nonresident states, capped at the resident tax
    // attributable to that same income.
    for (const code of Object.keys(stateOut)) {
      const share = base > 0 ? Math.min(1, nonres[code] / base) : 0;
      const cr = Math.min(stateOut[code].tax, resTax * share);
      credits += cr;
    }
    resTax = Math.max(0, resTax - credits);
    stateOut[res] = { tax: resTax, note: `${resSt.note}, resident, all income${credits > 0.5 ? ", credit for other states" : ""}` };
  }

  // Credits: withholding plus this-year attributed payments.
  const fedWh = active.reduce((a, s) => a + (s.fedWh || 0), 0);
  const stWh = active.reduce((a, s) => a + (s.stWh || 0), 0);
  let fedPaid = 0, statePaid = 0;
  const countedPayments = [];
  for (const p of data.payments) {
    const att = profile.payments[p.id] || {};
    const counted = att.year === data.year;
    countedPayments.push({ ...p, ...att, counted });
    if (!counted) continue;
    if (att.kind === "fed") fedPaid += p.amount;
    else statePaid += p.amount;
  }

  const stateTaxTotal = Object.values(stateOut).reduce((a, x) => a + x.tax, 0);
  const gross = active.reduce((a, s) => a + s.gross, 0);
  const totalExp = active.reduce((a, s) => a + s.exp, 0);
  const liab = fedTax + seTax + stateTaxTotal;
  const paid = fedWh + fedPaid + stWh + statePaid;
  return {
    fed, rows, active, se, wages, seNetIncome, seTax, halfSE, agi, taxable, fedTax,
    states: stateOut, credits, fedWh, stWh, fedPaid, statePaid, countedPayments,
    w2Missing: w2.filter((s) => s.gross > 0 && !(s.fedWh > 0)).map((s) => s.name),
    gross, totalExp, liab, paid, net: liab - paid, fedNet: fedTax + seTax - fedWh - fedPaid,
  };
}

/* ---------------- format ---------------- */
function fmt(n) {
  const r = Math.round(Math.abs(n));
  const s = "$" + r.toLocaleString("en-US");
  return n < -0.5 ? "(" + s + ")" : s;
}
function pct(n) { return (n * 100).toFixed(1) + "%"; }
function lrow(k, v, sub, cls) {
  return `<div class="lrow${cls ? " " + cls : ""}"><span class="k">${k}${sub ? `<span class="nm">${sub}</span>` : ""}</span><span class="v">${v}</span></div>`;
}
function stateOptions(sel) {
  return Object.keys(STATES).map((code) =>
    `<option value="${code}"${code === sel ? " selected" : ""}>${STATES[code].name}</option>`).join("");
}

/* ---------------- section renderers ---------------- */
function estimateHtml(c) {
  const owes = c.net > 0.5;
  let liabRows = "";
  liabRows += lrow("Federal income", fmt(c.fedTax), `taxable ${fmt(c.taxable)} after ${fmt(c.fed.sd)} standard deduction`);
  liabRows += lrow("Self employment", fmt(c.seTax), `15.3% on 92.35% of ${fmt(c.seNetIncome)}${c.totalExp > 0 ? ` after ${fmt(c.totalExp)} expenses` : ""}`);
  for (const code of Object.keys(c.states)) {
    liabRows += lrow(esc(STATES[code].name), fmt(c.states[code].tax), esc(c.states[code].note));
  }
  liabRows += lrow("Total", fmt(c.liab), "", "total");

  let paidRows = "";
  paidRows += lrow("Fed withheld", fmt(c.fedWh), "entered in Setup");
  paidRows += lrow("State withheld", fmt(c.stWh), "entered in Setup");
  if (c.w2Missing && c.w2Missing.length) {
    paidRows += `<div class="lrow"><span class="k" style="color:var(--warn)">Check withholding</span>
      <span class="v" style="font-weight:500;color:var(--warn);white-space:normal;text-align:right;font-size:12.5px">
      No withholding entered for ${esc(c.w2Missing.join(", "))}, so the amount owed is overstated. Enter it in Setup.</span></div>`;
  }
  for (const p of c.countedPayments) {
    const label = p.kind === "fed" ? "IRS payment" : `${esc(p.kind)} payment`;
    paidRows += lrow(label, p.counted ? fmt(p.amount) : `<span class="sub">${fmt(p.amount)} not counted</span>`,
      `${esc(p.date)}${p.counted ? "" : `, applied to ${esc(p.year || "prior year")}`}`);
  }
  paidRows += lrow("Total paid", fmt(c.paid), "", "total");
  paidRows += lrow(owes ? "Still owed" : "Refund",
    `<span class="${owes ? "negd" : "pos"}">${fmt(Math.abs(c.net))}</span>`, "", "total");

  const fb = c.fed.brackets;
  const stTxt = Object.keys(c.states).map((code) => `${STATES[code].name}: ${c.states[code].note}`).join(". ")
    || "No state tax for the assigned states.";
  return `
    <div class="card tax-hero">
      <div class="big">
        <span class="label">${owes ? "Estimated still owed" : "Estimated refund"}</span>
        <div class="hero-num ${owes ? "owed" : "refund"}">${fmt(Math.abs(c.net))}</div>
        <div class="sub">federal ${fmt(c.fedNet)} ${MID} states ${fmt(c.net - c.fedNet)}</div>
      </div>
      <div class="split">
        <div class="cell"><span class="label">Total tax</span><span class="n">${fmt(c.liab)}</span></div>
        <div class="cell"><span class="label">Paid so far</span><span class="n">${fmt(c.paid)}</span></div>
        <div class="cell"><span class="label">Effective rate</span><span class="n">${c.gross ? pct(c.liab / c.gross) : "0%"}</span></div>
      </div>
    </div>
    <div class="grid two">
      <div class="card"><span class="label">${esc(data.year)} estimated tax</span><div>${liabRows}</div></div>
      <div class="card"><span class="label">Paid so far</span><div>${paidRows}</div></div>
    </div>
    <div class="card tax-assume">
      <span class="label">Assumptions</span>
      ${lrow("Federal", `${esc(data.year)} ${profile.filing === "mfj" ? "married joint" : "single"} brackets, standard deduction ${fmt(c.fed.sd)}. 10% to ${fmt(fb[0][0])}, 12% to ${fmt(fb[1][0])}, 22% above.`)}
      ${lrow("Self employment", "15.3% on 92.35% of untaxed income after tagged expenses, half deductible")}
      ${lrow("States", esc(stTxt))}
      ${lrow("Residency", `${esc(STATES[profile.res] ? STATES[profile.res].name : profile.res)} taxes all income as resident state, with credit for tax paid to work states`)}
      ${lrow("Income", "YTD totals treated as the full year, no projection")}
    </div>`;
}

function quarterlyHtml(c) {
  const estNeed = Math.max(0, c.liab - c.fedWh - c.stWh);
  const perQ = estNeed / 4;
  const estPaid = c.fedPaid + c.statePaid;
  const remaining = Math.max(0, estNeed - estPaid);
  const y = Number(data.year);
  const now = new Date().toISOString().slice(0, 10);
  const qs = [
    { q: "Q1", due: `${y}-04-15`, covers: "Jan to Mar" },
    { q: "Q2", due: `${y}-06-15`, covers: "Apr to May" },
    { q: "Q3", due: `${y}-09-15`, covers: "Jun to Aug" },
    { q: "Q4", due: `${y + 1}-01-15`, covers: "Sep to Dec" },
  ];
  qs.forEach((q) => { q.past = q.due < now; });
  // Attribute this-year estimated payments to the quarter they were paid in.
  qs.forEach((q) => { q.paid = 0; });
  for (const p of c.countedPayments) {
    if (!p.counted) continue;
    const target = qs.find((q) => p.date <= q.due) || qs[3];
    target.paid += p.amount;
  }
  const remQ = Math.max(1, qs.filter((q) => !q.past).length);
  qs.forEach((q) => { q.suggested = q.past ? perQ : remaining / remQ; });
  let next = qs.find((q) => !q.past);

  const cards = qs.map((q) => {
    let pill, cls;
    if (q.past && q.paid > 0) { pill = "PAID"; cls = "ok"; }
    else if (q.past) { pill = "PASSED"; cls = "dim"; }
    else if (q === next) { pill = `DUE ${q.due.slice(5).replace("-", "/")}`; cls = "wait"; }
    else { pill = "UPCOMING"; cls = "dim"; }
    return `<div class="card"><span class="label">${q.q} ${MID} ${esc(q.due)}</span>
      <div class="qn">${fmt(q.past ? q.paid : q.suggested)}</div>
      <div class="qsub">${q.past ? `paid ${MID} suggested was ${fmt(q.suggested)}` : "suggested"}</div>
      <div><span class="pill ${cls}">${pill}</span></div></div>`;
  }).join("");

  const rows = qs.map((q) => {
    let pill, cls;
    if (q.past && q.paid > 0) { pill = "PAID"; cls = "ok"; }
    else if (q.past) { pill = "PASSED"; cls = "dim"; }
    else if (q === next) { pill = "NEXT"; cls = "wait"; }
    else { pill = "UPCOMING"; cls = "dim"; }
    return `<tr><td>${esc(q.due)}</td><td>${q.covers}</td><td>${fmt(q.suggested)}</td><td>${q.paid ? fmt(q.paid) : "$0"}</td><td><span class="pill ${cls}">${pill}</span></td></tr>`;
  }).join("");

  return `<div class="qq">${cards}</div>
    <div class="card">
      <span class="label">Estimated payment schedule</span>
      <div class="table-wrap"><table>
        <thead><tr><th>Deadline</th><th>Covers</th><th>Suggested</th><th>Paid</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="muted-note" style="margin-top:10px">Suggested amounts spread what is still owed over the remaining quarters.</div>
    </div>`;
}

function sourcesHtml(c) {
  const seNet = c.seNetIncome || 1;
  const taxedGross = c.active.reduce((a, s) => a + s.gross, 0) || 1;
  const stateTaxTotal = Object.values(c.states).reduce((a, x) => a + x.tax, 0);
  const rows = c.rows.map((s) => {
    let alloc = 0;
    if (s.treat !== "none") {
      alloc += c.fedTax * (s.gross / taxedGross);
      if (s.treat === "se") alloc += c.seTax * (s.net / seNet);
      alloc += stateTaxTotal * (s.gross / taxedGross);
    }
    const eff = s.gross ? alloc / s.gross : 0;
    return `<tr><td><b>${esc(s.name)}</b></td><td>${TREATS[s.treat]}</td><td>${esc(s.state)}</td>
      <td>${fmt(s.gross)}</td><td>${s.exp ? fmt(s.exp) : "$0"}</td><td>${fmt(alloc)}</td>
      <td>${s.treat === "none" ? "0%" : pct(eff)}</td></tr>`;
  }).join("");
  const totGross = c.rows.reduce((a, s) => a + s.gross, 0) || 1;
  const totalRow = `<tr><td><b>Total</b></td><td></td><td></td><td><b>${fmt(totGross)}</b></td>
    <td><b>${fmt(c.totalExp)}</b></td><td><b>${fmt(c.liab)}</b></td><td><b>${pct(c.liab / totGross)}</b></td></tr>`;
  return `<div class="card">
    <span class="label">Per source</span>
    <div class="table-wrap"><table>
      <thead><tr><th>Source</th><th>Treatment</th><th>State</th><th>Gross</th><th>Expenses</th><th>Est tax</th><th>Eff rate</th></tr></thead>
      <tbody>${rows}${totalRow}</tbody>
    </table></div>
    <div class="muted-note" style="margin-top:10px">Federal and state split by income share. Self-employment tax on 1099 sources only.</div>
  </div>`;
}

function expensesHtml() {
  const seSources = data.sources.filter((s) => (profile.treatments[s.category_id] || {}).treat === "se");
  if (!seSources.length) {
    return `<div class="card"><span class="label">Business expenses</span>
      <p class="sub" style="margin:10px 0 0">No 1099 sources. Set one up in Setup to tag expenses.</p></div>`;
  }
  const tagged = data.expenseTxns || [];
  const bySource = seSources.map((s) => {
    const txns = tagged.filter((t) => t.biz_category_id === s.category_id);
    const total = txns.reduce((a, t) => a + t.amount, 0);
    return `<div style="margin-top:14px">
      <div class="lrow total"><span class="k">${esc(s.name)}</span><span class="v">${fmt(total)} in ${txns.length} expenses</span></div>
      ${txns.map((t) => `<div class="exp-row">
        <span class="sub mono">${esc(t.date)}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.merchant_name || t.name)}</span>
        <span class="mono">${fmt(t.amount)}</span>
        <button type="button" class="chip" data-untag="${esc(t.id)}">Remove</button>
      </div>`).join("") || `<p class="sub" style="margin:6px 0 0">Nothing tagged yet.</p>`}
    </div>`;
  }).join("");

  const results = expResults === null ? "" : `<div style="margin-top:10px">
    ${expResults.length ? expResults.map((t) => `<div class="exp-row">
      <span class="sub mono">${esc(t.date)}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.name)}">${esc(t.merchant_name || t.name)}</span>
      <span class="mono">${fmt(t.amount)}</span>
      ${seSources.map((s) => `<button type="button" class="chip" data-tag="${esc(t.id)}" data-cat="${s.category_id}">to ${esc(s.name)}</button>`).join("")}
    </div>`).join("") : `<p class="sub" style="margin:6px 0 0">No matching spending this year.</p>`}
  </div>`;

  return `<div class="card">
    <span class="label">Business expenses</span>
    <p class="muted-note" style="margin:8px 0 12px">Tag spending as a business expense against a 1099 source. Real business costs only.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <input type="search" id="exp-q" placeholder="Search spending" value="${esc(expQuery)}" style="flex:1;min-width:200px">
      <button type="button" class="btn small" id="exp-go">Search</button>
    </div>
    ${results}
    ${bySource}
  </div>`;
}

function setupHtml() {
  const srcRows = data.sources.map((s) => {
    const t = profile.treatments[s.category_id];
    const isW2 = t.treat === "w2";
    return `<div class="src-row" data-cid="${s.category_id}">
      <div class="who"><div class="m">${esc(s.name)}</div><span class="sub">${s.n} deposits YTD</span></div>
      <div class="gross mono">${fmt(s.gross)}</div>
      <div class="field"><span class="label">Treatment</span><select data-f="treat">
        <option value="w2"${t.treat === "w2" ? " selected" : ""}>W2 withheld</option>
        <option value="se"${t.treat === "se" ? " selected" : ""}>1099 self emp</option>
        <option value="none"${t.treat === "none" ? " selected" : ""}>Not taxable</option>
      </select></div>
      <div class="field"><span class="label">Work state</span><select data-f="state"${t.treat === "none" ? " disabled" : ""}>${stateOptions(t.state)}</select></div>
      <div class="field"><span class="label">Fed withheld</span><input type="number" data-f="fedWh" value="${t.fedWh || 0}"${isW2 ? "" : " disabled"}></div>
      <div class="field"><span class="label">State withheld</span><input type="number" data-f="stWh" value="${t.stWh || 0}"${isW2 ? "" : " disabled"}></div>
    </div>`;
  }).join("");

  const payRows = data.payments.map((p) => {
    const att = profile.payments[p.id] || {};
    const years = [String(Number(data.year) - 1), data.year];
    return `<div class="src-row" data-pid="${esc(p.id)}" style="grid-template-columns:minmax(150px,1.3fr) auto 1fr 1fr">
      <div class="who"><div class="m">${att.kind === "fed" ? "IRS" : esc(att.kind || "State")}</div><span class="sub">${esc(p.date)} ${MID} ${esc((p.name || "").slice(0, 40))}</span></div>
      <div class="gross mono">${fmt(p.amount)}</div>
      <div class="field"><span class="label">Applies to</span><select data-f="year">
        ${years.map((yy) => `<option value="${yy}"${att.year === yy ? " selected" : ""}>${yy}${yy !== data.year ? " filing" : " estimate"}</option>`).join("")}
      </select></div>
      <div class="field"><span class="label">Jurisdiction</span><select data-f="kind">
        <option value="fed"${att.kind === "fed" ? " selected" : ""}>Federal</option>
        ${Object.keys(STATES).filter((cd) => STATES[cd].type !== "none").map((cd) =>
          `<option value="${cd}"${att.kind === cd ? " selected" : ""}>${STATES[cd].name}</option>`).join("")}
      </select></div>
    </div>`;
  }).join("") || `<p class="sub" style="margin:8px 0 0">No payments found in the Taxes category this year.</p>`;

  return `<div class="card" style="margin-bottom:14px">
      <span class="label">Profile</span>
      <div class="setup-top" style="margin-top:10px">
        <div class="field"><span class="label">Filing status</span><select id="set-filing">
          <option value="single"${profile.filing === "single" ? " selected" : ""}>Single</option>
          <option value="mfj"${profile.filing === "mfj" ? " selected" : ""}>Married joint</option>
        </select></div>
        <div class="field"><span class="label">Resident state</span><select id="set-res">${stateOptions(profile.res)}</select></div>
      </div>
      <div class="muted-note">Resident state taxes all income, with credit for tax paid to work states. Assumes you are not claimed as a dependent.</div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <span class="label">Income sources</span>
      <div id="src-setup">${srcRows}</div>
      <div class="muted-note" style="margin-top:10px">Gross is from your income categories. Enter withholding from paystubs for W2 sources.</div>
    </div>
    <div class="card">
      <span class="label">Tax payments found</span>
      <div id="pay-setup">${payRows}</div>
      <div class="muted-note" style="margin-top:10px">From the Taxes category. Payments applied to a prior year do not count.</div>
    </div>`;
}

/* ---------------- main render ---------------- */
export default async function render(main) {
  if (!data) {
    try {
      const [taxData, settings] = await Promise.all([api.get("/taxes"), api.get("/settings")]);
      data = taxData;
      try { profile = settings.tax_profile ? JSON.parse(settings.tax_profile) : null; } catch { profile = null; }
    } catch (err) {
      main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
      return;
    }
  }
  ensureProfile();
  const c = calc();

  const body =
    tab === "quarterly" ? quarterlyHtml(c)
    : tab === "sources" ? sourcesHtml(c)
    : tab === "expenses" ? expensesHtml()
    : tab === "setup" ? setupHtml()
    : estimateHtml(c);

  const owes = c.net > 0.5;
  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <div>
        <h1>Taxes</h1>
        <div class="sub">${esc(data.year)} ${MID} year to date</div>
      </div>
      <span class="pill dim mono">${owes ? "OWES " : "REFUND "}${fmt(Math.abs(c.net))}</span>
    </div>
    <div class="card banner tax-banner"><span class="label">Estimate only</span><span class="muted-note">Rough math from category totals, not tax advice.</span></div>
    <div class="chips tabrow" role="tablist" id="tax-tabs">
      ${["estimate", "quarterly", "sources", "expenses", "setup"].map((t) =>
        `<button type="button" class="chip${tab === t ? " active" : ""}" data-tab="${t}" role="tab">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
    </div>
    <section id="tax-body">${body}</section>
  </div>`;

  main.querySelector("#tax-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn || btn.dataset.tab === tab) return;
    tab = btn.dataset.tab;
    render(main);
  });

  const filing = main.querySelector("#set-filing");
  if (filing) filing.addEventListener("change", (e) => { profile.filing = e.target.value; saveProfile(); render(main); });
  const res = main.querySelector("#set-res");
  if (res) res.addEventListener("change", (e) => { profile.res = e.target.value; saveProfile(); render(main); });

  const srcSetup = main.querySelector("#src-setup");
  if (srcSetup) srcSetup.addEventListener("change", (e) => {
    const row = e.target.closest("[data-cid]");
    if (!row) return;
    const t = profile.treatments[row.dataset.cid];
    const f = e.target.dataset.f;
    if (f === "fedWh" || f === "stWh") t[f] = Math.max(0, Number(e.target.value) || 0);
    else t[f] = e.target.value;
    if (f === "treat" && t.treat !== "w2") { t.fedWh = 0; t.stWh = 0; }
    saveProfile();
    render(main);
  });

  const paySetup = main.querySelector("#pay-setup");
  if (paySetup) paySetup.addEventListener("change", (e) => {
    const row = e.target.closest("[data-pid]");
    if (!row) return;
    const att = profile.payments[row.dataset.pid];
    att[e.target.dataset.f] = e.target.value;
    saveProfile();
    render(main);
  });

  // expenses tab wiring
  const go = main.querySelector("#exp-go");
  const qIn = main.querySelector("#exp-q");
  const runSearch = async () => {
    expQuery = qIn.value.trim();
    if (!expQuery) { expResults = null; render(main); return; }
    try {
      const res2 = await api.get(`/transactions?q=${encodeURIComponent(expQuery)}&from=${data.year}-01-01&to=${data.year}-12-31&limit=40`);
      expResults = (res2.transactions || []).filter((t) => t.amount > 0 && !t.excluded && !t.biz_category_id).slice(0, 12);
    } catch { expResults = []; }
    render(main);
  };
  if (go) go.addEventListener("click", runSearch);
  if (qIn) qIn.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

  main.querySelectorAll("[data-tag]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await api.patch(`/transactions/${encodeURIComponent(b.dataset.tag)}`, { biz_category_id: Number(b.dataset.cat) });
      data = null; expResults = null;
      render(main);
    } catch { /* leave as is */ }
  }));
  main.querySelectorAll("[data-untag]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await api.patch(`/transactions/${encodeURIComponent(b.dataset.untag)}`, { biz_category_id: null });
      data = null;
      render(main);
    } catch { /* leave as is */ }
  }));
}
