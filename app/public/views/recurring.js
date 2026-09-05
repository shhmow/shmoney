// Recurring: upcoming subscriptions/bills with next dates and monthly total.
import { api } from "../lib/api.js";
import {
  esc, fmtMoney, fmtMoneyWhole, catChip, fmtDate, emptyState, errorCard, MID,
} from "../lib/format.js";

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
  const active = items.filter((r) => r.active !== 0 && r.active !== false);
  const monthlyTotal = active.reduce((a, r) => a + monthlyEquivalent(r), 0);

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <div><h1>Recurring</h1>
        ${active.length ? `<span class="sub">${active.length} active ${MID} about ${fmtMoneyWhole(monthlyTotal)}/mo</span>` : ""}
      </div>
      <button type="button" class="btn" id="rec-refresh">Refresh detection</button>
    </div>
    <div class="card" id="rec-list">
      ${items.length ? items.map((r, i) => {
        const name = r.merchant || r.merchant_name || r.name || "Unknown";
        const inactive = r.active === 0 || r.active === false;
        const cadence = cadenceOf(r);
        const amt = itemAmount(r);
        const suffix = CADENCE_SUFFIX[cadence] || "/mo";
        const amtCell = cadence === "monthly"
          ? `<div class="amt">${fmtMoney(amt)}<span class="sub" style="font-weight:400">${suffix}</span></div>`
          : `<div class="amt">${fmtMoney(amt)}<span class="sub" style="font-weight:400">${suffix}</span>
              <div class="sub" style="text-align:right;font-weight:400">&#8776; ${fmtMoneyWhole(monthlyEquivalent(r))}/mo</div></div>`;
        return `<div class="txn txn-plain" style="${inactive ? "opacity:.45" : ""}" data-rec="${i}">
          <div class="who">
            <div class="m">${esc(name)}</div>
            <div class="meta">${catChip(r.category_name, r.category_color)}<span>${cadence}${r.next_date ? ` ${MID} next ${esc(fmtDate(r.next_date))}` : ""}${r.manual ? ` ${MID} tracked manually` : ""}${inactive ? ` ${MID} ignored` : ""}</span></div>
            <div class="slot-edit"></div>
          </div>
          ${amtCell}
          <button type="button" class="rowmenu" data-edit="${i}" aria-label="Edit ${esc(name)}" aria-expanded="false">&#8942;</button>
        </div>`;
      }).join("") : emptyState({
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
      ${candidates.map((cd, i) => `<div class="txn txn-plain" data-cand="${i}">
        <div class="who">
          <div class="m">${esc(cd.merchant)}</div>
          <div class="meta"><span>${cd.count} &#215; ${fmtMoney(Math.abs(Number(cd.amount) || 0))} ${MID} last ${esc(fmtDate(cd.last_date))}${cd.gap_days ? ` ${MID} ${cd.gap_days}d apart` : ""}</span></div>
          <div class="muted-note cand-msg"></div>
        </div>
        <select class="cand-cadence" aria-label="Cadence for ${esc(cd.merchant)}">
          <option value="monthly">monthly</option>
          <option value="weekly">weekly</option>
          <option value="quarterly">quarterly</option>
          <option value="yearly">yearly</option>
        </select>
        <button type="button" class="btn small" data-track="${i}">Track</button>
        <button type="button" class="btn small" data-dismiss="${i}">Dismiss</button>
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

  main.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => {
    const i = Number(btn.dataset.edit);
    const r = items[i];
    const slot = main.querySelector(`[data-rec="${i}"] .slot-edit`);
    if (!slot || !r) return;
    if (slot.innerHTML) { slot.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    const inactive = r.active === 0 || r.active === false;
    slot.innerHTML = `<div class="popover" style="margin-top:8px">
      <select aria-label="Category">
        <option value="">Uncategorized</option>
        ${categories.filter((c) => !c.hidden).map((c) => `<option value="${c.id}"${String(c.id) === String(r.category_id) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
      <button type="button" class="btn small r-cat">Set category</button>
      <button type="button" class="btn small r-toggle">${inactive ? "Reactivate" : "Ignore"}</button>
      <span class="muted-note r-msg"></span>
    </div>`;
    const msg = slot.querySelector(".r-msg");
    slot.querySelector(".r-cat").addEventListener("click", async () => {
      const v = slot.querySelector("select").value;
      try {
        await api.patch(`/recurring/${encodeURIComponent(r.id)}`, { category_id: v ? Number(v) : null });
        render(main);
      } catch (err) { msg.textContent = err.message || "Failed"; }
    });
    slot.querySelector(".r-toggle").addEventListener("click", async () => {
      try {
        await api.patch(`/recurring/${encodeURIComponent(r.id)}`, { active: inactive ? 1 : 0 });
        render(main);
      } catch (err) { msg.textContent = err.message || "Failed"; }
    });
  }));
}
