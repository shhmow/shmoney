// Recurring: bills and income streams detected from transactions, what is
// due in the next 30 days, and a way to track anything by hand.
import { api } from "../lib/api.js";
import { esc, fmtMoney, fmtMoneyWhole, catChip, fmtDate, todayStr, emptyState, errorCard, debounce, MID } from "../lib/format.js";
import { merchantTile } from "../lib/brand.js";

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
const SUFFIX = { weekly: "/wk", biweekly: "/2wk", monthly: "/mo", quarterly: "/qtr", yearly: "/yr" };
const PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };

function cadenceOf(r) {
  const s = String(r.cadence || "").toLowerCase();
  return CADENCES.includes(s) ? s : "monthly";
}
const amountOf = (r) => Math.abs(Number(r.avg_amount) || 0);
const monthly = (r) => amountOf(r) * PER_MONTH[cadenceOf(r)];
const isIgnored = (r) => r.active === 0 || r.active === false;
const isStale = (r) => !isIgnored(r) && (r.stale === 1 || r.stale === true);
const isIncome = (r) => r.kind === "income";

function addDaysStr(date, n) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Paychecks are named by their income category ("SpaceX"), not the bank's
// truncated descriptor ("Space Exploratio").
function nameOf(r) {
  if (isIncome(r) && r.category_name && r.category_name !== "Income") return r.category_name;
  return r.merchant;
}

function daysLate(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  const [ty, tm, td] = todayStr().split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86400000);
}

function row(r, i, { stale = false, ignored = false } = {}) {
  const cadence = cadenceOf(r);
  const amt = amountOf(r);
  const today = todayStr();
  const meta = [cadence];
  if (r.next_date && !stale && !ignored) {
    meta.push(r.next_date < today
      ? `<span class="rc-due">expected ${esc(fmtDate(r.next_date))}, ${daysLate(r.next_date)} days late</span>`
      : `next ${esc(fmtDate(r.next_date))}`);
  }
  const lastDate = r.last_txn_date || r.last_date;
  if (lastDate && (stale || ignored || Math.abs(Number(r.last_amount) - amt) > 0.011)) {
    meta.push(`last ${r.last_amount != null ? fmtMoney(Math.abs(r.last_amount)) + " " : ""}${esc(fmtDate(lastDate))}`);
  }
  if (r.account_name) meta.push(esc(r.account_name));
  if (r.manual) meta.push("manual");
  const sign = isIncome(r) ? "+" : "";
  const amtCell = `<div class="amt${isIncome(r) ? " in" : ""}">${sign}${fmtMoney(amt)}<span class="rc-suffix">${SUFFIX[cadence]}</span>${
    cadence !== "monthly" ? `<div class="rc-permo">${sign}${monthly(r) < 20 ? fmtMoney(monthly(r)) : fmtMoneyWhole(monthly(r))}/mo</div>` : ""}</div>`;
  return `<div class="txn txn-plain${stale ? " rc-stale" : ""}" data-rec="${i}">
    <span class="dot">${merchantTile({ merchant_name: r.merchant, name: r.merchant, logo_url: r.logo_url, website: r.website })}</span>
    <div class="who">
      <div class="m">${esc(nameOf(r))}</div>
      <div class="meta">${isIncome(r) ? "" : catChip(r.category_name, r.category_color)}<span>${meta.join(` ${MID} `)}</span></div>
      <div class="slot-edit"></div>
    </div>
    ${amtCell}
    <button type="button" class="rowmenu" data-edit="${i}" aria-label="Edit ${esc(r.merchant)}" aria-expanded="false">&#8942;</button>
  </div>`;
}

export default async function render(main) {
  let items, categories, candidates;
  try {
    [items, categories, candidates] = await Promise.all([
      api.get("/recurring"),
      api.get("/categories").catch(() => []),
      api.get("/recurring/candidates").catch(() => []),
    ]);
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }
  items = Array.isArray(items) ? items : [];
  categories = Array.isArray(categories) ? categories : [];
  candidates = Array.isArray(candidates) ? candidates : [];

  const bills = [], income = [], stale = [], ignored = [];
  items.forEach((r, i) => {
    const e = { r, i };
    if (isIgnored(r)) ignored.push(e);
    else if (isStale(r)) stale.push(e);
    else if (isIncome(r)) income.push(e);
    else bills.push(e);
  });
  const monthlyTotal = bills.reduce((a, { r }) => a + monthly(r), 0);

  const today = todayStr();
  const horizon = addDaysStr(today, 30);
  const upcoming = [...bills, ...income]
    .filter(({ r }) => r.next_date && r.next_date >= today && r.next_date <= horizon)
    .sort((a, b) => String(a.r.next_date).localeCompare(String(b.r.next_date)));
  const dueTotal = upcoming.filter(({ r }) => !isIncome(r)).reduce((a, { r }) => a + amountOf(r), 0);

  const subline = bills.length
    ? `${bills.length} bill${bills.length === 1 ? "" : "s"} ${MID} about ${fmtMoneyWhole(monthlyTotal)}/mo${stale.length ? ` ${MID} ${stale.length} may have stopped` : ""}`
    : "";

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <div><h1>Recurring</h1>${subline ? `<span class="sub">${subline}</span>` : ""}</div>
      <button type="button" class="btn" id="rec-refresh">Refresh</button>
    </div>

    ${upcoming.length ? `<div class="card" style="margin-bottom:14px">
      <div class="label">Next 30 days</div>
      <div class="rc-upcoming">
        ${upcoming.map(({ r }) => `<div class="rc-up">
          <span class="rc-when">${esc(fmtDate(r.next_date))}</span>
          <span class="rc-who">${esc(nameOf(r))}${r.account_name ? `<span class="sub"> ${MID} ${esc(r.account_name)}</span>` : ""}</span>
          <span class="amt${isIncome(r) ? " in" : ""}">${isIncome(r) ? "+" : ""}${fmtMoney(amountOf(r))}</span>
        </div>`).join("")}
        ${dueTotal > 0 ? `<div class="rc-total"><span class="sub">due by ${esc(fmtDate(horizon))}</span><b>${fmtMoney(dueTotal)}</b></div>` : ""}
      </div>
    </div>` : ""}

    <div class="card" id="rec-list">
      ${items.length ? (
        (bills.length ? bills.map(({ r, i }) => row(r, i)).join("") : `<p class="sub" style="margin:4px 0 8px">No active bills.</p>`) +
        (income.length ? `<div class="rc-group"><div class="label">Income</div>${income.map(({ r, i }) => row(r, i)).join("")}</div>` : "") +
        (stale.length ? `<div class="rc-group"><div class="label">Stopped?</div>
          <p class="sub rc-note">No charge in over 45 days past the expected date. Not counted above.</p>
          ${stale.map(({ r, i }) => row(r, i, { stale: true })).join("")}</div>` : "") +
        (ignored.length ? `<details class="rc-ignored"><summary>Ignored ${MID} ${ignored.length}</summary>
          ${ignored.map(({ r, i }) => row(r, i, { ignored: true })).join("")}</details>` : "")
      ) : emptyState({
        title: "Nothing recurring yet",
        body: "Bills, subscriptions, and paychecks appear after a few months of data.",
        actionLabel: "Link an account", actionHash: "#/settings", glyph: "loop",
      })}
    </div>

    ${candidates.length ? `<div class="card" style="margin-top:14px" id="rec-candidates">
      <div class="label" style="margin-bottom:6px">Might be recurring</div>
      ${candidates.map((cd, i) => `<div class="txn txn-plain" data-cand="${i}">
        <div class="who">
          <div class="m">${esc(cd.merchant)}</div>
          <div class="meta"><span>${cd.count} &#215; ${fmtMoney(cd.amount)} ${MID} last ${esc(fmtDate(cd.last_date))}${cd.gap_days ? ` ${MID} every ~${cd.gap_days} days` : ""}</span></div>
          <div class="muted-note cand-msg"></div>
        </div>
        <div class="rc-ctl">
          <select class="cand-cadence" aria-label="Cadence for ${esc(cd.merchant)}">
            ${CADENCES.map((c) => `<option value="${c}"${c === "monthly" ? " selected" : ""}>${c}</option>`).join("")}
          </select>
          <button type="button" class="btn small primary" data-track="${i}">Track</button>
          <button type="button" class="btn small" data-dismiss="${i}">Not recurring</button>
        </div>
      </div>`).join("")}
    </div>` : ""}

    <div class="card" style="margin-top:14px" id="rec-manual">
      <div class="label" style="margin-bottom:8px">Track something else</div>
      <div class="rc-ctl">
        <input type="search" id="rec-q" placeholder="Search a merchant" aria-label="Search a merchant" style="flex:1;min-width:180px">
        <select id="rec-q-cadence" aria-label="Cadence">
          ${CADENCES.map((c) => `<option value="${c}"${c === "monthly" ? " selected" : ""}>${c}</option>`).join("")}
        </select>
      </div>
      <div id="rec-q-results"></div>
    </div>
  </div>`;

  /* ---- refresh: re-run detection over what is already synced ---- */
  const refreshBtn = main.querySelector("#rec-refresh");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing";
    try { await api.post("/recurring/detect"); render(main); }
    catch (err) { refreshBtn.disabled = false; refreshBtn.textContent = "Refresh"; flash(refreshBtn, err.message || "Refresh failed"); }
  });

  function flash(afterEl, text) {
    const note = document.createElement("span");
    note.className = "muted-note"; note.style.marginLeft = "8px"; note.textContent = text;
    afterEl.after(note);
    setTimeout(() => note.remove(), 5000);
  }

  /* ---- candidates: track / dismiss ---- */
  const track = async (merchant, cadence, btn, msgEl) => {
    btn.disabled = true;
    try { await api.post("/recurring", { merchant, cadence }); render(main); }
    catch (err) { btn.disabled = false; if (msgEl) msgEl.textContent = err.message || "Failed"; }
  };
  main.querySelectorAll("[data-track]").forEach((btn) => btn.addEventListener("click", () => {
    const cd = candidates[Number(btn.dataset.track)];
    const rowEl = btn.closest("[data-cand]");
    if (cd && rowEl) track(cd.merchant, rowEl.querySelector(".cand-cadence").value, btn, rowEl.querySelector(".cand-msg"));
  }));
  main.querySelectorAll("[data-dismiss]").forEach((btn) => btn.addEventListener("click", async () => {
    const cd = candidates[Number(btn.dataset.dismiss)];
    const rowEl = btn.closest("[data-cand]");
    if (!cd || !rowEl) return;
    btn.disabled = true;
    try {
      await api.post("/recurring/candidates/dismiss", { merchant: cd.merchant });
      rowEl.remove();
      const card = main.querySelector("#rec-candidates");
      if (card && !card.querySelector("[data-cand]")) card.remove();
    } catch (err) { btn.disabled = false; rowEl.querySelector(".cand-msg").textContent = err.message || "Failed"; }
  }));

  /* ---- manual search ---- */
  const qIn = main.querySelector("#rec-q");
  const results = main.querySelector("#rec-q-results");
  qIn.addEventListener("input", debounce(async () => {
    const needle = qIn.value.trim();
    if (needle.length < 2) { results.innerHTML = ""; return; }
    let rows = [];
    try { rows = await api.get(`/recurring/merchants?q=${encodeURIComponent(needle)}`); } catch { rows = []; }
    if (qIn.value.trim() !== needle) return;
    const tracked = new Set(items.map((r) => r.merchant));
    results.innerHTML = rows.length ? rows.map((m, i) => `<div class="txn txn-plain" data-m="${i}">
      <div class="who"><div class="m">${esc(m.merchant)}</div>
        <div class="meta"><span>${m.n} charge${m.n === 1 ? "" : "s"} ${MID} avg ${fmtMoney(m.avg)} ${MID} last ${esc(fmtDate(m.last_date))}</span></div></div>
      ${tracked.has(m.merchant) ? `<span class="sub">tracked</span>` : `<button type="button" class="btn small" data-mtrack="${i}">Track</button>`}
    </div>`).join("") : `<p class="sub" style="margin:8px 0 0">No merchant matches.</p>`;
    results.querySelectorAll("[data-mtrack]").forEach((b) => b.addEventListener("click", () => {
      const m = rows[Number(b.dataset.mtrack)];
      track(m.merchant, main.querySelector("#rec-q-cadence").value, b, null);
    }));
  }, 250));

  /* ---- edit popover ---- */
  main.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => {
    const i = Number(btn.dataset.edit);
    const r = items[i];
    const slot = main.querySelector(`[data-rec="${i}"] .slot-edit`);
    if (!slot || !r) return;
    if (slot.innerHTML) { slot.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    const ignoredNow = isIgnored(r);
    const cadence = cadenceOf(r);
    slot.innerHTML = `<div class="popover rc-edit">
      <select class="r-cat" aria-label="Category">
        <option value="">Uncategorized</option>
        ${categories.filter((c) => !c.hidden).map((c) => `<option value="${c.id}"${String(c.id) === String(r.category_id) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
      <label class="sub">Amount <input class="amount-input r-amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${amountOf(r) || ""}" aria-label="Amount"></label>
      <select class="r-cadence" aria-label="Cadence">${CADENCES.map((c) => `<option value="${c}"${c === cadence ? " selected" : ""}>${c}</option>`).join("")}</select>
      <label class="sub">Next <input class="r-next" type="date" value="${esc(r.next_date || "")}" aria-label="Next date"></label>
      <button type="button" class="btn primary small r-save">Save</button>
      <button type="button" class="btn small r-toggle">${ignoredNow ? "Un-ignore" : "Ignore"}</button>
      <button type="button" class="btn small danger r-del">Remove</button>
      <span class="muted-note r-msg" role="status" aria-live="polite"></span>
    </div>`;
    const msg = slot.querySelector(".r-msg");
    slot.querySelector(".r-save").addEventListener("click", async () => {
      const catV = slot.querySelector(".r-cat").value;
      const amount = Number(slot.querySelector(".r-amount").value);
      const cad = slot.querySelector(".r-cadence").value;
      const next = slot.querySelector(".r-next").value;
      if (!(amount > 0)) { msg.textContent = "Amount must be above $0"; return; }
      if (next && next < today) { msg.textContent = "Next date is in the past"; return; }
      const body = { category_id: catV ? Number(catV) : null };
      if (Math.abs(amount - amountOf(r)) >= 0.005) body.avg_amount = Math.round(amount * 100) / 100;
      if (cad !== cadence) body.cadence = cad;
      if (next && next !== (r.next_date || "")) body.next_date = next;
      slot.querySelector(".r-save").disabled = true;
      try { await api.patch(`/recurring/${r.id}`, body); render(main); }
      catch (err) { slot.querySelector(".r-save").disabled = false; msg.textContent = err.message || "Failed"; }
    });
    slot.querySelector(".r-toggle").addEventListener("click", async () => {
      try { await api.patch(`/recurring/${r.id}`, { active: ignoredNow ? 1 : 0 }); render(main); }
      catch (err) { msg.textContent = err.message || "Failed"; }
    });
    slot.querySelector(".r-del").addEventListener("click", async () => {
      try { await api.del(`/recurring/${r.id}`); render(main); }
      catch (err) { msg.textContent = err.message || "Failed"; }
    });
  }));
}
