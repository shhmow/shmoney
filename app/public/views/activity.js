// Activity: unified/by-account transactions, filters, load-more, detail slide-over.
import { api } from "../lib/api.js";
import {
  esc, fmtMoney, fmtMoneyWhole, catChip, dateHead, fmtDate, txnAmount, emptyState, errorCard,
  debounce, currentMonth, shiftMonth, MID,
} from "../lib/format.js";
import { instTile, networkBadge, merchantTile, merchantLabel, brandOf, BRANDS } from "../lib/brand.js";

// Accounts that actually carry transactions (investment/loan accounts do not).
const isTxnAccount = (a) => a.type === "depository" || a.type === "credit";

const PAGE_SIZE = 50;

// module-level state survives navigation within the session
const state = {
  mode: "all",          // 'all' | 'byacct'
  accountId: null,
  q: "",
  categoryId: "",
  from: "",
  to: "",
  flagged: false,
  offset: 0,
  transactions: [],
  total: 0,
  sumOut: 0,
  sumIn: 0,
};

let accounts = [];
let categories = [];
let bankLinks = {};
const acctById = () => new Map(accounts.map((a) => [String(a.id), a]));

/** Read ?account=… / ?q=… from the hash once (deep links from Overview). */
function applyHashParams() {
  const qs = location.hash.split("?")[1];
  if (!qs) return;
  const p = new URLSearchParams(qs);
  if (p.get("account")) { state.mode = "byacct"; state.accountId = p.get("account"); }
  if (p.has("q")) state.q = p.get("q") || "";
  if (p.has("category")) state.categoryId = p.get("category") || "";
  if (p.has("from")) state.from = p.get("from") || "";
  if (p.has("to")) state.to = p.get("to") || "";
  if (p.get("flagged") === "1") state.flagged = true;
  history.replaceState({}, "", "#/activity");
}

function query() {
  const p = new URLSearchParams();
  p.set("limit", String(PAGE_SIZE));
  p.set("offset", String(state.offset));
  if (state.q) p.set("q", state.q);
  if (state.categoryId) p.set("category_id", state.categoryId);
  if (state.mode === "byacct" && state.accountId) p.set("account_id", state.accountId);
  if (state.from) p.set("from", state.from);
  if (state.to) p.set("to", state.to);
  if (state.flagged) p.set("flagged", "1");
  return "/transactions?" + p.toString();
}

export function acctLabel(a) {
  return a ? (a.nickname || a.name) : "";
}

function acctTag(t) {
  const a = acctById().get(String(t.account_id));
  const name = a ? acctLabel(a) : t.account_name;
  if (!name) return "";
  const tile = a ? instTile(a, { size: 14, cls: "tiny" }) : "";
  const mask = t.account_mask ? ` <span class="sub" style="font-size:11px">${MID}${MID}${esc(t.account_mask)}</span>` : "";
  return `<span class="acct-tag">${tile}<span style="overflow:hidden;text-overflow:ellipsis">${esc(name)}</span>${mask}</span>`;
}

function txnRow(t) {
  const merchant = merchantLabel(t);
  const amt = txnAmount(t.amount);
  const acct = state.mode === "all" ? acctTag(t) : "";
  const flag = t.flagged ? `<span class="flag-mark" title="Flagged for follow-up">&#9873;</span>` : "";
  const note = t.notes ? `<span class="sub" title="${esc(t.notes)}">&#9998;</span>` : "";
  return `<button type="button" class="txn txn-plain rowbtn${t.pending ? " pending" : ""}" data-txn="${esc(t.id)}"
      aria-label="${esc(merchant)}, ${esc(amt.text)}, ${esc(fmtDate(t.date))}${t.category_name ? ", " + esc(t.category_name) : ""}">
    <span class="dot">${merchantTile(t)}</span>
    <div class="who"><div class="m" title="${esc(t.name || "")}">${esc(merchant)}${flag}${note}</div>
      <div class="meta">${catChip(t.category_name, t.category_color)}${acct}</div></div>
    <div class="${amt.cls}">${amt.text}</div>
  </button>`;
}

function groupedRows(txns) {
  let html = "", lastDate = null;
  for (const t of txns) {
    if (t.date !== lastDate) {
      html += `<div class="label datehead">${esc(dateHead(t.date))}</div>`;
      lastDate = t.date;
    }
    html += txnRow(t);
  }
  return html;
}

function utilization(a) {
  const limit = Number(a.credit_limit || a.manual_limit || 0);
  const bal = Math.abs(Number(a.current_balance || 0));
  if (!(limit > 0)) return null;
  const pct = bal / limit * 100;
  return { limit, bal, pct, cls: pct >= 90 ? "over" : pct >= 30 ? "warn" : "" };
}

function acctHeader(a) {
  const bal = Number(a.current_balance ?? a.balance ?? 0);
  const shown = a.type === "credit" ? -Math.abs(bal) : bal;
  const u = a.type === "credit" ? utilization(a) : null;
  const avail = a.type === "credit" && a.available_balance != null
    ? `<span class="sub">${fmtMoneyWhole(a.available_balance)} available</span>` : "";
  const bank = bankLinks[brandOf(a)] || null;
  const open = bank ? `<a class="btn small" href="${esc(bank.activity)}" target="_blank" rel="noopener">Open in ${esc(bank.label)} &#8599;</a>` : "";
  return `<div class="acct-head" id="acct-head">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      ${instTile(a, { size: 38 })}
      <div style="flex:1;min-width:160px">
        <div style="display:flex;align-items:center;gap:8px"><b style="font-size:16px">${esc(acctLabel(a))}</b>${networkBadge(a, 24)}</div>
        <div class="sub">${a.mask ? `${MID}${MID} ${esc(a.mask)} ${MID} ` : ""}${esc(a.institution_name || "")}${a.nickname ? ` ${MID} ${esc(a.name)}` : ""}</div>
      </div>
      <div style="text-align:right">
        <div class="amt" style="font-size:18px">${fmtMoney(shown)}</div>
        ${avail}
      </div>
      ${open}
    </div>
    ${u ? `<div class="util" style="margin-top:10px;max-width:420px">
      <div class="track"><div class="fill ${u.cls}" style="width:${Math.min(100, u.pct).toFixed(1)}%"></div></div>
      <div class="sub"><span>${Math.round(u.pct)}% of ${fmtMoneyWhole(u.limit)} limit${a.manual_limit && !a.credit_limit ? " (set manually)" : ""}</span><span>${fmtMoneyWhole(Math.max(0, u.limit - u.bal))} left</span></div>
    </div>` : a.type === "credit" ? `<div class="sub" style="margin-top:8px">No credit limit reported ${MID} <a href="#/settings" style="color:var(--ink-2)">set one in Settings</a> to see utilization.</div>` : ""}
    <div id="acct-month" class="sub" style="margin-top:8px"></div>
  </div>`;
}

/** Per-card month summary: this month vs last month spend (excl. transfers/payments). */
async function fillMonthSummary(a) {
  const el = document.getElementById("acct-month");
  if (!el) return;
  const cur = currentMonth(), prev = shiftMonth(cur, -1);
  try {
    const [c, p] = await Promise.all([
      api.get(`/transactions?account_id=${encodeURIComponent(a.id)}&from=${cur}-01&to=${cur}-31&limit=1`),
      api.get(`/transactions?account_id=${encodeURIComponent(a.id)}&from=${prev}-01&to=${prev}-31&limit=1`),
    ]);
    const co = Number(c.sumOut) || 0, po = Number(p.sumOut) || 0;
    const delta = po > 0 ? Math.round((co - po) / po * 100) : null;
    const arrow = delta == null ? "" : delta > 0 ? `<span style="color:var(--warn)">&#9650; ${delta}%</span>` : `<span style="color:var(--good)">&#9660; ${Math.abs(delta)}%</span>`;
    el.innerHTML = `Out this month <b style="color:var(--ink)">${fmtMoneyWhole(co)}</b> ${MID} last month ${fmtMoneyWhole(po)} ${arrow}
      ${MID} in this month <b style="color:var(--ink)">${fmtMoneyWhole(Number(c.sumIn) || 0)}</b>`;
    if (a.type === "credit") {
      // last payment received on the card (money in, flagged as a transfer)
      const pay = await api.get(`/transactions?account_id=${encodeURIComponent(a.id)}&direction=in&transfer=1&limit=1`);
      const last = pay && pay.transactions && pay.transactions[0];
      if (last) {
        el.innerHTML += ` ${MID} last payment <b style="color:var(--ink)">${fmtMoneyWhole(Math.abs(last.amount))}</b> on ${esc(fmtDate(last.date))}`
          + ` <a class="linky" href="#/activity?account=${encodeURIComponent(a.id)}&category=${encodeURIComponent(last.category_id ?? "")}" style="font-size:12px">all payments</a>`;
      }
    }
  } catch { el.textContent = ""; }
}

function exportHref() {
  const p = new URLSearchParams({ table: "transactions" });
  if (state.q) p.set("q", state.q);
  if (state.categoryId) p.set("category_id", state.categoryId);
  if (state.mode === "byacct" && state.accountId) p.set("account_id", state.accountId);
  if (state.from) p.set("from", state.from);
  if (state.to) p.set("to", state.to);
  if (state.flagged) p.set("flagged", "1");
  return "/api/export/csv?" + p.toString();
}

function totalsLine() {
  if (!state.transactions.length) return "";
  const parts = [`${state.total} transaction${state.total === 1 ? "" : "s"}`];
  if (state.sumOut > 0) parts.push(`<b>${fmtMoneyWhole(state.sumOut)}</b> out`);
  if (state.sumIn > 0) parts.push(`<b class="pos">${fmtMoneyWhole(state.sumIn)}</b> in`);
  if (state.sumOut > 0 && state.sumIn > 0) {
    const net = state.sumIn - state.sumOut;
    parts.push(`net <b class="${net >= 0 ? "pos" : ""}">${fmtMoney(net, { cents: false })}</b>`);
  }
  return `<div class="sub" style="margin:0 0 4px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span>${parts.join(` ${MID} `)}</span><a href="${exportHref()}" download style="text-decoration:none">Export CSV &#8595;</a></div>`;
}

function listHtml() {
  const anyFilter = state.q || state.categoryId || state.from || state.to || state.flagged;
  let head = "";
  if (state.mode === "byacct" && state.accountId) {
    const a = accounts.find((x) => String(x.id) === String(state.accountId));
    if (a) head = acctHeader(a) + `<div style="border-top:1px solid var(--line);margin:14px 0 4px"></div>`;
  }
  if (state.transactions.length === 0) {
    if (accounts.length === 0) {
      return emptyState({
        title: "No transactions yet",
        body: "Link a bank and your activity will fill in here, grouped by day across every account.",
        actionLabel: "Go to Settings → Link account", actionHash: "#/settings", glyph: "list",
      });
    }
    return head + emptyState({
      title: anyFilter ? "No matching transactions" : "Nothing here yet",
      body: anyFilter ? "Try widening the search, date range, or category filter." : "Transactions appear after the next sync.",
      glyph: "list",
    });
  }
  const more = state.transactions.length < state.total
    ? `<div style="text-align:center;margin-top:14px"><button type="button" class="btn" id="load-more">Load more (${state.total - state.transactions.length} left)</button></div>`
    : "";
  return head + totalsLine() + groupedRows(state.transactions) + more;
}

async function fetchPage(append = false) {
  const res = await api.get(query());
  const txns = (res && res.transactions) || [];
  state.total = (res && res.total) || txns.length;
  state.sumOut = Number(res && res.sumOut) || 0;
  state.sumIn = Number(res && res.sumIn) || 0;
  state.transactions = append ? state.transactions.concat(txns) : txns;
}

/* ---------- detail slide-over ---------- */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } finally { ta.remove(); }
  return Promise.resolve();
}

export function openDetail(t, onSaved) {
  const merchant = merchantLabel(t);
  const amt = txnAmount(t.amount);
  const existing = document.getElementById("txn-sheet-wrap");
  if (existing) existing.remove();
  const acct = acctById().get(String(t.account_id));
  const brand = acct ? brandOf(acct) : null;
  const bank = brand ? bankLinks[brand] : null;
  const isCharge = Number(t.amount) > 0;

  const wrap = document.createElement("div");
  wrap.id = "txn-sheet-wrap";
  wrap.innerHTML = `
    <button type="button" class="sheet-backdrop" aria-label="Close details"></button>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Transaction details">
      <div class="sheet-head">
        <div style="display:flex;gap:12px;align-items:center;min-width:0">
          ${merchantTile(t, { size: 40 })}
          <div style="min-width:0"><div style="font-weight:700;font-size:16px">${esc(merchant)}</div>
          <div class="sub">${esc(dateHead(t.date))}${acct ? ` ${MID} ${esc(acctLabel(acct))}` : t.account_name ? ` ${MID} ${esc(t.account_name)}` : ""}${t.pending ? ` ${MID} pending` : ""}</div></div>
        </div>
        <button type="button" class="sheet-close" aria-label="Close details">&#215;</button>
      </div>
      <div class="hero-num" style="font-size:26px;margin-bottom:14px"><span class="${amt.cls}" style="font-size:26px">${amt.text}</span></div>

      <div class="kv">
        <span class="k">Descriptor</span><span class="v">${esc(t.name || MID)}</span>
        ${t.merchant_name && t.merchant_name !== merchant ? `<span class="k">Merchant</span><span class="v">${esc(t.merchant_name)}</span>` : ""}
        <span class="k">Status</span><span class="v">${t.pending ? "Pending" : "Posted"}${t.payment_channel ? ` ${MID} ${esc(t.payment_channel)}` : ""}</span>
        ${t.plaid_category ? `<span class="k">Bank tag</span><span class="v">${esc(String(t.plaid_category).toLowerCase().replace(/_/g, " "))}</span>` : ""}
        ${t.website ? `<span class="k">Website</span><span class="v"><a href="https://${esc(String(t.website).replace(/^https?:\/\//, ""))}" target="_blank" rel="noopener">${esc(t.website)}</a></span>` : ""}
        ${acct && acct.mask ? `<span class="k">Account</span><span class="v">${esc(acct.name)} ${MID}${MID}${esc(acct.mask)}</span>` : ""}
      </div>

      ${bank ? `<div class="bank">
        <div class="bank-head">${acct ? instTile(acct, { size: 26 }) : ""}<b>${esc(bank.label)}</b>${bank.phone ? `<span class="sub" style="margin-left:auto">${esc(bank.phone)}</span>` : ""}</div>
        <div class="bank-actions">
          <a class="btn small" href="${esc(bank.activity)}" target="_blank" rel="noopener">Open in ${esc(bank.label)} &#8599;</a>
          ${isCharge ? `<a class="btn small" href="${esc(bank.dispute)}" target="_blank" rel="noopener">How to dispute &#8599;</a>` : ""}
          <button type="button" class="btn small" id="d-copy">Copy details</button>
        </div>
        <div class="muted-note" style="margin-top:8px">Banks don't allow deep links to a single charge. Open your activity, find <b>${esc(fmtDate(t.date))} ${MID} ${esc(amt.text.replace(/^[+−-]/, ""))}</b>, then choose Dispute. Copy details pastes the date, merchant and amount.</div>
      </div>` : ""}

      <div class="related" id="d-related"><div class="label">Other charges from this merchant</div><div class="sub" style="margin-top:4px">Looking</div></div>

      <div class="field">
        <label class="label" for="d-cat">Category</label>
        <select id="d-cat">
          <option value="">Uncategorized</option>
          ${categoryOptions(t.category_id)}
        </select>
      </div>
      <label class="switch" style="margin-bottom:14px">
        <input type="checkbox" id="d-rule">
        <span class="knob"></span>
        <span>Always categorize &#8220;${esc(merchant)}&#8221; like this</span>
      </label>
      <label class="switch" style="margin-bottom:10px">
        <input type="checkbox" id="d-flag"${t.flagged ? " checked" : ""}>
        <span class="knob"></span><span>Flag for follow-up (dispute, refund, question)</span>
      </label>
      <label class="switch" style="margin-bottom:10px">
        <input type="checkbox" id="d-excluded"${t.excluded ? " checked" : ""}>
        <span class="knob"></span><span>Exclude from totals</span>
      </label>
      <label class="switch" style="margin-bottom:14px">
        <input type="checkbox" id="d-transfer"${t.is_transfer ? " checked" : ""}>
        <span class="knob"></span><span>Mark as transfer</span>
      </label>
      <div class="field">
        <label class="label" for="d-notes">Notes</label>
        <textarea id="d-notes" placeholder="Add a note">${esc(t.notes || "")}</textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
        <button type="button" class="btn" id="d-cancel">Cancel</button>
        <button type="button" class="btn primary" id="d-save">Save</button>
      </div>
      <div class="muted-note" id="d-err" style="margin-top:10px" hidden></div>
    </div>`;
  document.body.appendChild(wrap);
  const sheet = wrap.querySelector(".sheet");
  // force a layout so the transition runs even when rAF is throttled
  void sheet.offsetWidth;
  sheet.classList.add("open");

  const close = () => {
    sheet.classList.remove("open");
    setTimeout(() => wrap.remove(), 200);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  wrap.querySelector(".sheet-backdrop").addEventListener("click", close);
  wrap.querySelector(".sheet-close").addEventListener("click", close);
  wrap.querySelector("#d-cancel").addEventListener("click", close);
  wrap.querySelector("#d-cat").focus({ preventScroll: true });

  const copyBtn = wrap.querySelector("#d-copy");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    const text = `${t.date}  ${merchant}  ${amt.text}\n${t.name || ""}${acct && acct.mask ? `\n${acct.name} ending ${acct.mask}` : ""}`;
    try { await copyText(text); copyBtn.textContent = "Copied"; } catch { copyBtn.textContent = "Copy failed"; }
    setTimeout(() => { copyBtn.textContent = "Copy details"; }, 1800);
  });

  // related charges
  api.get(`/transactions/${encodeURIComponent(t.id)}/related`).then((r) => {
    const el = wrap.querySelector("#d-related");
    if (!el) return;
    const rows = (r && r.transactions) || [];
    if (!rows.length) {
      el.innerHTML = `<div class="label">Other charges from this merchant</div><div class="sub" style="margin-top:4px">First time this merchant shows up.</div>`;
      return;
    }
    el.innerHTML = `<div class="label">Other charges from this merchant</div>
      <div class="sub" style="margin:4px 0 6px">${r.count} total ${MID} ${fmtMoneyWhole(r.total)} spent${r.first ? ` since ${esc(fmtDate(r.first))}` : ""}</div>
      ${rows.slice(0, 5).map((x) => {
        const xa = txnAmount(x.amount);
        return `<div class="txn"><div class="who"><div class="m">${esc(fmtDate(x.date))} <span class="sub">${MID} ${esc(x.account_name || "")}</span></div></div><div class="${xa.cls}" style="font-size:13px">${xa.text}</div></div>`;
      }).join("")}
      ${rows.length > 5 ? `<a class="linky" href="#/activity?q=${encodeURIComponent(t.merchant_name || t.name)}" style="font-size:12.5px">See all ${r.count}</a>` : ""}`;
    el.querySelectorAll("a.linky").forEach((a) => a.addEventListener("click", () => close()));
  }).catch(() => {
    const el = wrap.querySelector("#d-related");
    if (el) el.innerHTML = "";
  });

  wrap.querySelector("#d-save").addEventListener("click", async () => {
    const btn = wrap.querySelector("#d-save");
    const errEl = wrap.querySelector("#d-err");
    errEl.hidden = true;
    btn.disabled = true;
    const catVal = wrap.querySelector("#d-cat").value;
    const catId = catVal ? Number(catVal) : null;
    try {
      const patch = {
        excluded: wrap.querySelector("#d-excluded").checked ? 1 : 0,
        is_transfer: wrap.querySelector("#d-transfer").checked ? 1 : 0,
        flagged: wrap.querySelector("#d-flag").checked ? 1 : 0,
        notes: wrap.querySelector("#d-notes").value,
      };
      if (catId !== (t.category_id ?? null)) patch.category_id = catId;
      const res = await api.patch(`/transactions/${encodeURIComponent(t.id)}`, patch);
      let ruleMade = false;
      if (wrap.querySelector("#d-rule").checked && catId) {
        await api.post("/rules", { match_value: t.merchant_name || merchant, category_id: catId, retroactive: true });
        ruleMade = true;
      }
      close();
      onSaved(res && res.transaction ? res.transaction : null, ruleMade);
    } catch (err) {
      errEl.textContent = err.message || "Save failed";
      errEl.hidden = false;
      btn.disabled = false;
    }
  });
}

/** Category options grouped by kind: expenses first, then income sources, then transfers. */
function categoryOptions(selectedId) {
  const vis = categories.filter((c) => !c.hidden);
  const group = (kind, label) => {
    const xs = vis.filter((c) => (c.kind || "expense") === kind).sort((a, b) => a.name.localeCompare(b.name));
    if (!xs.length) return "";
    return `<optgroup label="${label}">${xs.map((c) =>
      `<option value="${c.id}"${String(c.id) === String(selectedId) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`;
  };
  return group("expense", "Spending") + group("income", "Income") + group("transfer", "Transfers");
}

/** Load accounts + categories + bank links for other views that open the sheet. */
export async function ensureRefs() {
  if (accounts.length && categories.length) return;
  const [acctsRes, catsRes, linksRes] = await Promise.all([
    api.get("/accounts"), api.get("/categories"), api.get("/items/links").catch(() => ({})),
  ]);
  accounts = (Array.isArray(acctsRes) ? acctsRes : []).filter((a) => !a.hidden);
  categories = Array.isArray(catsRes) ? catsRes : [];
  bankLinks = linksRes || {};
}

/* ---------- main render ---------- */
export default async function render(main) {
  applyHashParams();
  try {
    const [txnsRes, acctsRes, catsRes, linksRes] = await Promise.all([
      (state.offset = 0, api.get(query())),
      api.get("/accounts"),
      api.get("/categories"),
      api.get("/items/links").catch(() => ({})),
    ]);
    state.transactions = (txnsRes && txnsRes.transactions) || [];
    state.total = (txnsRes && txnsRes.total) || state.transactions.length;
    state.sumOut = Number(txnsRes && txnsRes.sumOut) || 0;
    state.sumIn = Number(txnsRes && txnsRes.sumIn) || 0;
    accounts = Array.isArray(acctsRes) ? acctsRes : (acctsRes && acctsRes.accounts) || [];
    categories = Array.isArray(catsRes) ? catsRes : (catsRes && catsRes.categories) || [];
    bankLinks = linksRes || {};
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }
  accounts = accounts.filter((a) => !a.hidden);
  // By-account picker: only accounts that take transactions (no investment/loan).
  const pickerAccounts = accounts.filter(isTxnAccount);
  if (state.mode === "byacct" && state.accountId
      && !pickerAccounts.some((a) => String(a.id) === String(state.accountId))) {
    state.accountId = null;
  }
  if (state.mode === "byacct" && !state.accountId && pickerAccounts.length) {
    state.accountId = pickerAccounts[0].id;
  }

  const chip = (a) => `<button type="button" class="chip acct-chip${String(a.id) === String(state.accountId) ? " active" : ""}" data-acct="${esc(a.id)}" aria-pressed="${String(a.id) === String(state.accountId)}">${instTile(a, { size: 16, cls: "tiny" })}${esc(acctLabel(a))}${a.mask ? `<span class="sub" style="font-size:10.5px">${MID}${MID}${esc(a.mask)}</span>` : ""}</button>`;

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <h1>Transactions</h1>
      <div class="txn-toggle" id="txn-toggle" role="group" aria-label="View mode">
        <button type="button" data-view="all"${state.mode === "all" ? ' class="active"' : ""}>All accounts</button>
        <button type="button" data-view="byacct"${state.mode === "byacct" ? ' class="active"' : ""}>By account</button>
      </div>
    </div>

    <div id="acct-picker" class="chips" style="${state.mode === "byacct" ? "" : "display:none;"}margin-bottom:16px;flex-wrap:wrap">
      ${pickerAccounts.map(chip).join("")}
    </div>

    <div class="toolbar" id="txn-toolbar">
      <input type="search" id="f-q" placeholder="Search merchants, notes, or an amount" value="${esc(state.q)}" aria-label="Search transactions">
      <select id="f-cat" aria-label="Filter by category">
        <option value="">All categories</option>
        ${categoryOptions(state.categoryId)}
      </select>
      <input type="date" id="f-from" value="${esc(state.from)}" aria-label="From date">
      <input type="date" id="f-to" value="${esc(state.to)}" aria-label="To date">
      <button type="button" class="chip${state.flagged ? " active" : ""}" id="f-flag" aria-pressed="${state.flagged}" title="Only flagged transactions">&#9873; Flagged</button>
      <button type="button" class="btn small" id="f-clear">Clear</button>
    </div>

    <div class="card" id="txn-list">${listHtml()}</div>
  </div>`;

  const listEl = main.querySelector("#txn-list");
  const acctFor = () => accounts.find((x) => String(x.id) === String(state.accountId));
  if (state.mode === "byacct" && acctFor()) fillMonthSummary(acctFor());

  const reload = async (append = false) => {
    if (!append) {
      state.offset = 0;
      listEl.setAttribute("aria-busy", "true");
    }
    try {
      await fetchPage(append);
      listEl.innerHTML = listHtml();
      wireList();
      if (!append && state.mode === "byacct" && acctFor()) fillMonthSummary(acctFor());
    } catch (err) {
      listEl.innerHTML = errorCard(err);
    } finally {
      listEl.removeAttribute("aria-busy");
    }
  };

  /** After a save: patch the row in place (keeps loaded pages + scroll). */
  const onSaved = (updated, ruleMade) => {
    if (ruleMade || !updated) { reload(false); return; }
    const i = state.transactions.findIndex((x) => String(x.id) === String(updated.id));
    if (i >= 0) state.transactions[i] = updated;
    const row = listEl.querySelector(`[data-txn="${CSS.escape(String(updated.id))}"]`);
    if (row) {
      const tmp = document.createElement("div");
      tmp.innerHTML = txnRow(updated);
      const fresh = tmp.firstElementChild;
      row.replaceWith(fresh);
      fresh.addEventListener("click", () => openDetail(updated, onSaved));
    }
    // totals may have moved if excluded/transfer changed; cheap refresh of the line
    api.get(query().replace(/limit=\d+/, "limit=1")).then((r) => {
      state.sumOut = Number(r.sumOut) || 0; state.sumIn = Number(r.sumIn) || 0; state.total = r.total || state.total;
      const line = listEl.querySelector(".sub[style*='justify-content:space-between']");
      if (line) line.outerHTML = totalsLine();
    }).catch(() => {});
  };

  const wireList = () => {
    const more = listEl.querySelector("#load-more");
    if (more) more.addEventListener("click", () => {
      state.offset += PAGE_SIZE;
      more.disabled = true;
      reload(true);
    });
    listEl.querySelectorAll("[data-txn]").forEach((row) => row.addEventListener("click", () => {
      const t = state.transactions.find((x) => String(x.id) === String(row.dataset.txn));
      if (t) openDetail(t, onSaved);
    }));
  };
  wireList();

  // toggle
  main.querySelectorAll("#txn-toggle button").forEach((b) => b.addEventListener("click", () => {
    state.mode = b.dataset.view;
    main.querySelectorAll("#txn-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    const picker = main.querySelector("#acct-picker");
    picker.style.display = state.mode === "byacct" ? "flex" : "none";
    if (state.mode === "byacct" && !state.accountId && pickerAccounts.length) state.accountId = pickerAccounts[0].id;
    main.querySelectorAll("[data-acct]").forEach((c) => {
      const on = String(c.dataset.acct) === String(state.accountId);
      c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on));
    });
    reload(false);
  }));

  // account chips
  main.querySelectorAll("[data-acct]").forEach((c) => c.addEventListener("click", () => {
    state.accountId = c.dataset.acct;
    main.querySelectorAll("[data-acct]").forEach((x) => {
      x.classList.toggle("active", x === c); x.setAttribute("aria-pressed", String(x === c));
    });
    reload(false);
  }));

  // filters
  main.querySelector("#f-q").addEventListener("input", debounce((e) => {
    state.q = e.target.value.trim();
    reload(false);
  }, 300));
  main.querySelector("#f-cat").addEventListener("change", (e) => { state.categoryId = e.target.value; reload(false); });
  main.querySelector("#f-from").addEventListener("change", (e) => { state.from = e.target.value; reload(false); });
  main.querySelector("#f-to").addEventListener("change", (e) => { state.to = e.target.value; reload(false); });
  main.querySelector("#f-flag").addEventListener("click", (e) => {
    state.flagged = !state.flagged;
    e.currentTarget.classList.toggle("active", state.flagged);
    e.currentTarget.setAttribute("aria-pressed", String(state.flagged));
    reload(false);
  });
  main.querySelector("#f-clear").addEventListener("click", () => {
    state.q = ""; state.categoryId = ""; state.from = ""; state.to = ""; state.flagged = false;
    main.querySelector("#f-q").value = "";
    main.querySelector("#f-cat").value = "";
    main.querySelector("#f-from").value = "";
    main.querySelector("#f-to").value = "";
    const fl = main.querySelector("#f-flag"); fl.classList.remove("active"); fl.setAttribute("aria-pressed", "false");
    reload(false);
  });
}
