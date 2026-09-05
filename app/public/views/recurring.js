// Recurring: upcoming subscriptions/bills with next dates and monthly total.
import { api } from "../lib/api.js";
import {
  esc, fmtMoney, fmtMoneyWhole, catChip, fmtDate, todayStr, emptyState, errorCard, MID,
} from "../lib/format.js";

const CADENCES = ["weekly", "monthly", "quarterly", "yearly"];

function cadenceOf(r) {
  const s = String(r.cadence || r.frequency || r.interval || "").toLowerCase();
  if (s.includes("week")) return "weekly";
  if (s.includes("quarter")) return "quarterly";
  if (s.includes("year") || s.includes("annual")) return "yearly";
  return "monthly";
}

// Per-charge amount suffix for each cadence.
const CADENCE_SUFFIX = { weekly: "/wk", monthly: "/mo", quarterly: "/qtr", yearly: "/yr" };

function itemAmount(r) {
  // API rows carry avg_amount (schema column); tolerate legacy amount too.
  return Math.abs(Number(r.avg_amount ?? r.amount) || 0);
}

function monthlyEquivalent(r) {
  const amt = itemAmount(r);
  switch (cadenceOf(r)) {
    case "weekly": return amt * 52 / 12; // x4.33
    case "quarterly": return amt / 3;
    case "yearly": return amt / 12;
    default: return amt;
  }
}

function isInactive(r) {
  return r.active === 0 || r.active === false;
}

function isStale(r) {
  return !isInactive(r) && (r.stale === 1 || r.stale === true);
}

function addDaysStr(date, n) {
  const [y, m, d] = String(date).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Escaped HTML: "Discover it Chrome ••6760"
function accountLabel(r) {
  if (!r.account_name) return "";
  return esc(r.account_name) + (r.account_mask ? ` &#8226;&#8226;${esc(r.account_mask)}` : "");
}

function lastChargeText(r) {
  const date = r.last_txn_date || r.last_date;
  if (!date) return "";
  const amt = r.last_amount != null ? Number(r.last_amount) : null;
  return `last ${amt != null ? fmtMoney(Math.abs(amt)) + " on " : ""}${esc(fmtDate(date))}`;
}

function itemRow(r, i, { stale = false, inactive = false } = {}) {
  const name = r.merchant || r.merchant_name || r.name || "Unknown";
  const cadence = cadenceOf(r);
  const amt = itemAmount(r);
  const suffix = CADENCE_SUFFIX[cadence] || "/mo";
  const amtCell = cadence === "monthly"
    ? `<div class="amt">${fmtMoney(amt)}<span class="sub" style="font-weight:400">${suffix}</span></div>`
    : `<div class="amt">${fmtMoney(amt)}<span class="sub" style="font-weight:400">${suffix}</span>
        <div class="sub" style="text-align:right;font-weight:400">&#8776; ${fmtMoneyWhole(monthlyEquivalent(r))}/mo</div></div>`;
  const metaBits = [
    `${cadence}${r.next_date && !stale && !inactive ? ` ${MID} next ${esc(fmtDate(r.next_date))}` : ""}`,
  ];
  const last = lastChargeText(r);
  if (last) metaBits.push(last);
  const acct = accountLabel(r);
  if (acct) metaBits.push(`<span class="rc-acct" title="Charged to ${esc(r.account_name)}">${acct}</span>`);
  if (r.manual) metaBits.push("tracked manually");
  if (inactive) metaBits.push("ignored");
  return `<div class="txn txn-plain${stale ? " rc-stale" : ""}" data-rec="${i}">
    <div class="who">
      <div class="m">${esc(name)}</div>
      <div class="meta">${catChip(r.category_name, r.category_color)}<span>${metaBits.join(` ${MID} `)}</span></div>
      <div class="slot-edit"></div>
    </div>
    ${amtCell}
    <button type="button" class="rowmenu" data-edit="${i}" aria-label="Edit ${esc(name)}" aria-expanded="false">&#8942;</button>
  </div>`;
}

export default async function render(main) {
  let listRes, catsRes, candRes;
  try {
    [listRes, catsRes, candRes] = await Promise.all([
      api.get("/recurring"),
      api.get("/categories").catch(() => []),
      api.get("/recurring/candidates").catch(() => []),
    ]);
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }
  const items = Array.isArray(listRes) ? listRes : (listRes && listRes.recurring) || [];
  const categories = Array.isArray(catsRes) ? catsRes : (catsRes && catsRes.categories) || [];
  const candidates = Array.isArray(candRes) ? candRes : [];

  // Three buckets: live (counted in the monthly total), stale ("Stopped?":
  // a weekly/monthly item whose next charge is 45+ days overdue) and ignored.
  const live = [];
  const stale = [];
  const ignored = [];
  items.forEach((r, i) => {
    const entry = { r, i };
    if (isInactive(r)) ignored.push(entry);
    else if (isStale(r)) stale.push(entry);
    else live.push(entry);
  });
  const monthlyTotal = live.reduce((a, { r }) => a + monthlyEquivalent(r), 0);

  const today = todayStr();
  const horizon = addDaysStr(today, 30);
  const upcoming = live
    .filter(({ r }) => r.next_date && r.next_date >= today && r.next_date <= horizon)
    .sort((a, b) => String(a.r.next_date).localeCompare(String(b.r.next_date)));
  const upcomingTotal = upcoming.reduce((a, { r }) => a + itemAmount(r), 0);

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <div><h1>Recurring</h1>
        ${live.length ? `<span class="sub">${live.length} active ${MID} about ${fmtMoneyWhole(monthlyTotal)}/mo${stale.length ? ` ${MID} ${stale.length} possibly stopped` : ""}</span>` : ""}
      </div>
      <button type="button" class="btn" id="rec-refresh">Refresh detection</button>
    </div>
    ${items.length ? `<div class="card" id="rec-upcoming" style="margin-bottom:14px">
      <div class="label">Upcoming in the next 30 days</div>
      ${upcoming.length ? `<div class="rc-upcoming">
        ${upcoming.map(({ r }) => `<div class="rc-up">
          <span class="rc-when">${esc(fmtDate(r.next_date))}</span>
          <span class="rc-who">${esc(r.merchant || r.name || "Unknown")}${r.account_name ? `<span class="sub"> ${MID} ${esc(r.account_name)}</span>` : ""}</span>
          <span class="amt">${fmtMoney(itemAmount(r))}</span>
        </div>`).join("")}
        <div class="rc-total"><span class="sub">${upcoming.length} charge${upcoming.length === 1 ? "" : "s"} due through ${esc(fmtDate(horizon))}</span><b>${fmtMoney(upcomingTotal)}</b></div>
      </div>` : `<p class="sub" style="margin:6px 0 0">Nothing due before ${esc(fmtDate(horizon))}.</p>`}
    </div>` : ""}
    <div class="card" id="rec-list">
      ${items.length ? (
        (live.length ? live.map(({ r, i }) => itemRow(r, i)).join("")
          : `<p class="sub" style="margin:4px 0 8px">No live recurring charges.</p>`) +
        (stale.length ? `<div class="rc-group" id="rec-stale">
          <div class="label">Stopped?</div>
          <p class="sub rc-note">Monthly or weekly charges that are 45+ days overdue. Not counted in the monthly total. Ignore them, or edit the next date if they are still running.</p>
          ${stale.map(({ r, i }) => itemRow(r, i, { stale: true })).join("")}
        </div>` : "") +
        (ignored.length ? `<details class="rc-ignored" id="rec-ignored">
          <summary>Ignored ${MID} ${ignored.length}</summary>
          ${ignored.map(({ r, i }) => itemRow(r, i, { inactive: true })).join("")}
        </details>` : "")
      ) : emptyState({
        title: "No recurring charges detected yet",
        body: "shmoney watches your transactions for repeating merchants — rent, subscriptions, utilities — and lists them here with the next expected date.",
        actionLabel: "Go to Settings → Link account",
        actionHash: "#/settings",
        glyph: "loop",
      })}
    </div>
    ${candidates.length ? `<div class="card" style="margin-top:14px" id="rec-candidates">
      <div class="label" style="margin-bottom:4px">Possible subscriptions</div>
      <p class="sub" style="margin:0 0 8px">Merchants that charged the exact same amount more than once in the last 18 months but are not tracked yet.</p>
      ${candidates.map((cd, i) => `<div class="txn txn-plain rc-cand" data-cand="${i}">
        <div class="who">
          <div class="m">${esc(cd.merchant)}</div>
          <div class="meta"><span>${cd.count} &#215; ${fmtMoney(Math.abs(Number(cd.amount) || 0))} ${MID} last ${esc(fmtDate(cd.last_date))}${cd.gap_days ? ` ${MID} ${cd.gap_days}d apart` : ""}</span></div>
          <div class="muted-note cand-msg"></div>
        </div>
        <div class="rc-cand-ctl">
          <select class="cand-cadence" aria-label="Cadence for ${esc(cd.merchant)}">
            ${CADENCES.map((cad) => `<option value="${cad}"${cad === "monthly" ? " selected" : ""}>${cad}</option>`).join("")}
          </select>
          <button type="button" class="btn small" data-track="${i}">Track</button>
          <button type="button" class="btn small" data-dismiss="${i}">Dismiss</button>
        </div>
      </div>`).join("")}
    </div>` : ""}
  </div>`;

  const refreshBtn = main.querySelector("#rec-refresh");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    const prevText = refreshBtn.textContent;
    refreshBtn.textContent = "Refreshing…";
    try {
      await api.post("/sync");
      render(main);
    } catch (err) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = prevText;
      const note = document.createElement("span");
      note.className = "muted-note";
      note.style.marginLeft = "8px";
      note.textContent = err.message || "Refresh failed";
      refreshBtn.after(note);
      setTimeout(() => note.remove(), 5000);
    }
  });

  /* ---- possible subscriptions: track / dismiss ---- */
  main.querySelectorAll("[data-track]").forEach((btn) => btn.addEventListener("click", async () => {
    const i = Number(btn.dataset.track);
    const cd = candidates[i];
    const row = main.querySelector(`[data-cand="${i}"]`);
    if (!cd || !row) return;
    const cadence = row.querySelector(".cand-cadence").value;
    btn.disabled = true;
    try {
      // No category_id: the API inherits the merchant's usual category.
      await api.post("/recurring", {
        merchant: cd.merchant,
        cadence,
        avg_amount: Math.abs(Number(cd.amount) || 0),
      });
      render(main);
    } catch (err) {
      btn.disabled = false;
      row.querySelector(".cand-msg").textContent = err.message || "Track failed";
    }
  }));
  main.querySelectorAll("[data-dismiss]").forEach((btn) => btn.addEventListener("click", async () => {
    const i = Number(btn.dataset.dismiss);
    const cd = candidates[i];
    const row = main.querySelector(`[data-cand="${i}"]`);
    if (!cd || !row) return;
    btn.disabled = true;
    try {
      await api.post("/recurring/candidates/dismiss", { merchant: cd.merchant });
      row.remove();
      const card = main.querySelector("#rec-candidates");
      if (card && !card.querySelector("[data-cand]")) card.remove();
    } catch (err) {
      btn.disabled = false;
      row.querySelector(".cand-msg").textContent = err.message || "Dismiss failed";
    }
  }));

  /* ---- edit popover: category, amount, cadence, next date, ignore ---- */
  main.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => {
    const i = Number(btn.dataset.edit);
    const r = items[i];
    const slot = main.querySelector(`[data-rec="${i}"] .slot-edit`);
    if (!slot || !r) return;
    if (slot.innerHTML) { slot.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    const inactive = isInactive(r);
    const cadence = cadenceOf(r);
    slot.innerHTML = `<div class="popover rc-edit" style="margin-top:8px">
      <select class="r-catsel" aria-label="Category">
        <option value="">Uncategorized</option>
        ${categories.filter((c) => !c.hidden).map((c) => `<option value="${c.id}"${String(c.id) === String(r.category_id) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
      <label class="sub" style="display:flex;gap:6px;align-items:center">Amount
        <input class="amount-input r-amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${itemAmount(r) || ""}" aria-label="Amount per charge">
      </label>
      <select class="r-cadence" aria-label="Cadence">
        ${CADENCES.map((cad) => `<option value="${cad}"${cad === cadence ? " selected" : ""}>${cad}</option>`).join("")}
      </select>
      <label class="sub" style="display:flex;gap:6px;align-items:center">Next
        <input class="r-next" type="date" value="${esc(r.next_date || "")}" aria-label="Next charge date">
      </label>
      <button type="button" class="btn primary small r-save">Save</button>
      <button type="button" class="btn small r-toggle">${inactive ? "Reactivate" : "Ignore"}</button>
      <span class="muted-note r-msg" role="status" aria-live="polite"></span>
    </div>`;
    const msg = slot.querySelector(".r-msg");
    slot.querySelector(".r-save").addEventListener("click", async () => {
      const catV = slot.querySelector(".r-catsel").value;
      const amount = Number(slot.querySelector(".r-amount").value);
      const cad = slot.querySelector(".r-cadence").value;
      const next = slot.querySelector(".r-next").value;
      if (!(amount > 0)) { msg.textContent = "Amount must be more than $0"; return; }
      if (next && next < today) { msg.textContent = "Next date is in the past. Pick a future date or Ignore the item."; return; }
      const body = { category_id: catV ? Number(catV) : null };
      if (Math.abs(amount - itemAmount(r)) >= 0.005) body.avg_amount = Math.round(amount * 100) / 100;
      if (cad !== cadence) body.cadence = cad;
      if (next && next !== (r.next_date || "")) body.next_date = next;
      slot.querySelector(".r-save").disabled = true;
      try {
        await api.patch(`/recurring/${encodeURIComponent(r.id)}`, body);
        render(main);
      } catch (err) {
        slot.querySelector(".r-save").disabled = false;
        msg.textContent = err.message || "Failed";
      }
    });
    slot.querySelector(".r-toggle").addEventListener("click", async () => {
      try {
        await api.patch(`/recurring/${encodeURIComponent(r.id)}`, { active: inactive ? 1 : 0 });
        render(main);
      } catch (err) { msg.textContent = err.message || "Failed"; }
    });
  }));
}
