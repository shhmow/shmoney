// Activity: unified/by-account transactions, filters, load-more, detail slide-over.
import { api } from "../lib/api.js";
import {
  esc, fmtMoney, catChip, dateHead, txnAmount, emptyState, errorCard,
  debounce, MID,
} from "../lib/format.js";

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
  offset: 0,
  transactions: [],
  total: 0,
};

let accounts = [];
let categories = [];

function query() {
  const p = new URLSearchParams();
  p.set("limit", String(PAGE_SIZE));
  p.set("offset", String(state.offset));
  if (state.q) p.set("q", state.q);
  if (state.categoryId) p.set("category_id", state.categoryId);
  if (state.mode === "byacct" && state.accountId) p.set("account_id", state.accountId);
  if (state.from) p.set("from", state.from);
  if (state.to) p.set("to", state.to);
  return "/transactions?" + p.toString();
}

function txnRow(t) {
  const merchant = t.merchant_name || t.name || "Unknown";
  const amt = txnAmount(t.amount);
  const acct = state.mode === "all" && t.account_name
    ? `<span class="acct-tag">${esc(t.account_name)}</span>` : "";
  return `<button type="button" class="txn txn-plain rowbtn${t.pending ? " pending" : ""}" data-txn="${esc(t.id)}">
    <div class="who"><div class="m">${esc(merchant)}</div>
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

function listHtml() {
  const anyFilter = state.q || state.categoryId || state.from || state.to;
  if (state.transactions.length === 0) {
    if (accounts.length === 0) {
      return emptyState({
        title: "No transactions yet",
        body: "Link a bank and your activity will fill in here, grouped by day across every account.",
        actionLabel: "Go to Settings → Link account", actionHash: "#/settings", glyph: "list",
      });
    }
    return emptyState({
      title: anyFilter ? "No matching transactions" : "Nothing here yet",
      body: anyFilter ? "Try widening the search, date range, or category filter." : "Transactions appear after the next sync.",
      glyph: "list",
    });
  }
  let head = "";
  if (state.mode === "byacct" && state.accountId) {
    const a = accounts.find((x) => String(x.id) === String(state.accountId));
    if (a) {
      const bal = Number(a.current_balance ?? a.balance ?? 0);
      const shown = a.type === "credit" ? -Math.abs(bal) : bal;
      head = `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <div><b style="font-size:15.5px">${esc(a.name)}</b> ${a.mask ? `<span class="sub">${MID}${MID} ${esc(a.mask)}</span>` : ""}</div>
        <div class="amt">balance ${fmtMoney(shown)}</div></div>`;
    }
  }
  const more = state.transactions.length < state.total
    ? `<div style="text-align:center;margin-top:14px"><button type="button" class="btn" id="load-more">Load more (${state.total - state.transactions.length} left)</button></div>`
    : "";
  return head + groupedRows(state.transactions) + more;
}

async function fetchPage(append = false) {
  const res = await api.get(query());
  const txns = (res && res.transactions) || [];
  state.total = (res && res.total) || txns.length;
  state.transactions = append ? state.transactions.concat(txns) : txns;
}

/* ---------- detail slide-over ---------- */
function openDetail(t, onSaved) {
  const merchant = t.merchant_name || t.name || "Unknown";
  const amt = txnAmount(t.amount);
  const existing = document.getElementById("txn-sheet-wrap");
  if (existing) existing.remove();

  const wrap = document.createElement("div");
  wrap.id = "txn-sheet-wrap";
  wrap.innerHTML = `
    <button type="button" class="sheet-backdrop" aria-label="Close"></button>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Transaction details">
      <div class="sheet-head">
        <div>
          <div><div style="font-weight:700;font-size:16px">${esc(merchant)}</div>
          <div class="sub">${esc(dateHead(t.date))}${t.account_name ? ` ${MID} ${esc(t.account_name)}` : ""}${t.pending ? ` ${MID} pending` : ""}</div></div>
        </div>
        <button type="button" class="sheet-close" aria-label="Close">&#215;</button>
      </div>
      <div class="hero-num" style="font-size:26px;margin-bottom:18px"><span class="${amt.cls}" style="font-size:26px">${amt.text}</span></div>

      <div class="field">
        <label class="label" for="d-cat">Category</label>
        <select id="d-cat">
          <option value="">Uncategorized</option>
          ${categories.filter((c) => !c.hidden).map((c) =>
            `<option value="${c.id}"${String(c.id) === String(t.category_id) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
      </div>
      <label class="switch" style="margin-bottom:14px">
        <input type="checkbox" id="d-rule">
        <span class="knob"></span>
        <span>Always categorize &#8220;${esc(merchant)}&#8221; like this</span>
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
  requestAnimationFrame(() => sheet.classList.add("open"));

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
        notes: wrap.querySelector("#d-notes").value,
      };
      if (catId !== (t.category_id ?? null)) patch.category_id = catId;
      await api.patch(`/transactions/${encodeURIComponent(t.id)}`, patch);
      if (wrap.querySelector("#d-rule").checked && catId) {
        await api.post("/rules", { match_value: merchant, category_id: catId, retroactive: true });
      }
      close();
      onSaved();
    } catch (err) {
      errEl.textContent = err.message || "Save failed";
      errEl.hidden = false;
      btn.disabled = false;
    }
  });
}

/* ---------- main render ---------- */
export default async function render(main) {
  try {
    const [txnsRes, acctsRes, catsRes] = await Promise.all([
      (state.offset = 0, api.get(query())),
      api.get("/accounts"),
      api.get("/categories"),
    ]);
    state.transactions = (txnsRes && txnsRes.transactions) || [];
    state.total = (txnsRes && txnsRes.total) || state.transactions.length;
    accounts = Array.isArray(acctsRes) ? acctsRes : (acctsRes && acctsRes.accounts) || [];
    categories = Array.isArray(catsRes) ? catsRes : (catsRes && catsRes.categories) || [];
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

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <h1>Transactions</h1>
      <div class="txn-toggle" id="txn-toggle" role="group" aria-label="View mode">
        <button type="button" data-view="all"${state.mode === "all" ? ' class="active"' : ""}>All accounts</button>
        <button type="button" data-view="byacct"${state.mode === "byacct" ? ' class="active"' : ""}>By account</button>
      </div>
    </div>

    <div id="acct-picker" class="chips" style="${state.mode === "byacct" ? "" : "display:none;"}margin-bottom:16px;flex-wrap:wrap">
      ${pickerAccounts.map((a) => `<button type="button" class="chip${String(a.id) === String(state.accountId) ? " active" : ""}" data-acct="${esc(a.id)}">${esc(a.name)}</button>`).join("")}
    </div>

    <div class="toolbar">
      <input type="search" id="f-q" placeholder="Search merchants and descriptions" value="${esc(state.q)}" aria-label="Search transactions">
      <select id="f-cat" aria-label="Filter by category">
        <option value="">All categories</option>
        ${categories.filter((c) => !c.hidden).map((c) => `<option value="${c.id}"${String(c.id) === String(state.categoryId) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
      <input type="date" id="f-from" value="${esc(state.from)}" aria-label="From date">
      <input type="date" id="f-to" value="${esc(state.to)}" aria-label="To date">
      <button type="button" class="btn small" id="f-clear">Clear</button>
    </div>

    <div class="card" id="txn-list">${listHtml()}</div>
  </div>`;

  const listEl = main.querySelector("#txn-list");

  const reload = async (append = false) => {
    if (!append) {
      state.offset = 0;
      listEl.setAttribute("aria-busy", "true");
    }
    try {
      await fetchPage(append);
      listEl.innerHTML = listHtml();
      wireList();
    } catch (err) {
      listEl.innerHTML = errorCard(err);
    } finally {
      listEl.removeAttribute("aria-busy");
    }
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
      if (t) openDetail(t, () => reload(false));
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
    main.querySelectorAll("[data-acct]").forEach((c) =>
      c.classList.toggle("active", String(c.dataset.acct) === String(state.accountId)));
    reload(false);
  }));

  // account chips
  main.querySelectorAll("[data-acct]").forEach((c) => c.addEventListener("click", () => {
    state.accountId = c.dataset.acct;
    main.querySelectorAll("[data-acct]").forEach((x) => x.classList.toggle("active", x === c));
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
  main.querySelector("#f-clear").addEventListener("click", () => {
    state.q = ""; state.categoryId = ""; state.from = ""; state.to = "";
    main.querySelector("#f-q").value = "";
    main.querySelector("#f-cat").value = "";
    main.querySelector("#f-from").value = "";
    main.querySelector("#f-to").value = "";
    reload(false);
  });
}
