// Settings: institutions (link/relink/sync/delete), Plaid Link + OAuth resume,
// categories manager, rules manager, settings fields, CSV export, logout.
import { api } from "../lib/api.js";
import { esc, fmtTimeAgo, catColor, errorCard, MID } from "../lib/format.js";

const PLAID_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const TOKEN_KEY = "shmoney_link_token";
const MAX_CONNECTIONS = 10;
// Distinct color tokens from styles.css ("series" is the same hex as c1, so it is skipped).
const COLOR_TOKENS = ["c1", "c2", "c3", "c4", "muted"];
// A stored color of "series" renders identically to c1, so treat it as selected c1.
const tokenSelected = (color, token) => color === token || (color === "series" && token === "c1");

let plaidLoading = null;

function loadPlaid() {
  if (window.Plaid) return Promise.resolve();
  if (!plaidLoading) {
    plaidLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PLAID_SRC;
      s.onload = resolve;
      s.onerror = () => { plaidLoading = null; reject(new Error("Could not load Plaid Link")); };
      document.head.appendChild(s);
    });
  }
  return plaidLoading;
}

function refreshView() {
  window.dispatchEvent(new Event("shmoney:refresh"));
}

/** Plaid OAuth redirect resume — called from app.js on boot, before routing. */
export async function resumeOauthIfNeeded() {
  const isOauth = location.pathname === "/link/oauth" ||
    new URLSearchParams(location.search).has("oauth_state_id");
  if (!isOauth) return;
  const receivedRedirectUri = window.location.href;
  const token = sessionStorage.getItem(TOKEN_KEY);
  history.replaceState({}, "", "/#/settings");
  if (!token) return;
  await loadPlaid();
  const handler = window.Plaid.create({
    token,
    receivedRedirectUri,
    onSuccess: async (public_token, metadata) => {
      sessionStorage.removeItem(TOKEN_KEY);
      try {
        if (public_token) await api.post("/link/exchange", { public_token });
      } finally {
        refreshView();
      }
    },
    onExit: () => { sessionStorage.removeItem(TOKEN_KEY); refreshView(); },
  });
  handler.open();
}

async function openLink({ itemId = null } = {}) {
  const res = await api.post("/link/token", itemId != null ? { item_id: itemId } : {});
  const token = res && res.link_token;
  if (!token) throw new Error("No link token returned");
  sessionStorage.setItem(TOKEN_KEY, token);
  await loadPlaid();
  const isUpdate = itemId != null;
  const handler = window.Plaid.create({
    token,
    onSuccess: async (public_token) => {
      sessionStorage.removeItem(TOKEN_KEY);
      try {
        if (isUpdate) {
          // update mode: no exchange needed; kick a sync so status clears
          await api.post("/sync", { item_id: itemId }).catch(() => {});
        } else if (public_token) {
          await api.post("/link/exchange", { public_token });
        }
      } finally {
        refreshView();
      }
    },
    onExit: () => { sessionStorage.removeItem(TOKEN_KEY); },
  });
  handler.open();
}

function statusPill(status) {
  if (status === "login_required") return `<span class="pill wait">&#9679; Needs relink</span>`;
  if (status === "error") return `<span class="pill err">&#9679; Error</span>`;
  return `<span class="pill ok">&#9679; Connected</span>`;
}

function accountCount(it) {
  if (Array.isArray(it.accounts)) return it.accounts.length;
  const n = it.account_count ?? it.accountCount ?? it.accounts;
  return typeof n === "number" ? n : 0;
}

export default async function render(main) {
  let items, categories, rules, settings;
  try {
    const [i, c, r, s] = await Promise.all([
      api.get("/items"),
      api.get("/categories"),
      api.get("/rules"),
      api.get("/settings"),
    ]);
    items = Array.isArray(i) ? i : (i && i.items) || [];
    categories = Array.isArray(c) ? c : (c && c.categories) || [];
    rules = Array.isArray(r) ? r : (r && r.rules) || [];
    settings = (s && (s.settings || s)) || {};
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }

  const catName = new Map(categories.map((c) => [String(c.id), c.name]));
  const sVal = (k) => settings[k] != null && settings[k] !== "" ? settings[k] : "";

  main.innerHTML = `<div class="page">
    <div class="pagehead"><h1>Accounts &amp; settings</h1></div>

    <!-- institutions -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px;flex-wrap:wrap">
        <div class="label">Linked institutions</div>
        <div style="display:flex;gap:8px">
          ${items.length ? `<button type="button" class="btn small" id="sync-all">Sync all</button>` : ""}
          <button type="button" class="btn primary small" id="link-new"${items.length >= MAX_CONNECTIONS ? " disabled" : ""}>Link account</button>
        </div>
      </div>
      <div id="inst-list">
      ${items.length ? items.map((it) => `
        <div class="inst" data-item="${it.id}">
          <div class="who"><b>${esc(it.institution_name || "Institution")}</b>
            <span class="sub">${accountCount(it)} account${accountCount(it) === 1 ? "" : "s"} ${MID} synced ${esc(fmtTimeAgo(it.last_synced_at))}</span></div>
          ${statusPill(it.status)}
          <button type="button" class="btn small" data-sync="${it.id}">Sync now</button>
          <button type="button" class="btn small" data-relink="${it.id}">Relink</button>
          <button type="button" class="btn small danger" data-del="${it.id}" data-name="${esc(it.institution_name || "this institution")}">Delete</button>
        </div>`).join("")
      : `<p class="sub" style="margin:10px 0 4px">Nothing linked yet. Connect your bank through Plaid to start syncing accounts, transactions, and holdings automatically.</p>`}
      </div>
      <div class="sub" style="margin-top:10px">${items.length} of ${MAX_CONNECTIONS} connections used</div>
      <div class="muted-note" id="inst-msg" style="margin-top:6px" hidden></div>
    </div>

    <!-- categories + rules -->
    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <div class="label" style="margin-bottom:8px">Categories</div>
        <div id="cat-list">
          ${categories.map((c) => `
          <div class="txn" data-cat="${c.id}" style="${c.hidden ? "opacity:.45" : ""}">
            <span class="swatches" role="group" aria-label="Color for ${esc(c.name)}">
              ${COLOR_TOKENS.map((t) => `<button type="button" class="swatch" data-color="${t}" aria-pressed="${tokenSelected(c.color, t)}" aria-label="${t}" style="background:${catColor(t)}"></button>`).join("")}
            </span>
            <div class="who"><div class="m" style="font-size:13.5px">${esc(c.name)}</div>
              <div class="meta">${esc(c.kind || "expense")}${c.hidden ? ` ${MID} hidden` : ""}</div>
              <div class="slot-del"></div></div>
            <button type="button" class="btn small" data-cat-rename="${c.id}" aria-label="Rename ${esc(c.name)}">Rename</button>
            <button type="button" class="btn small" data-cat-hide="${c.id}" aria-label="${c.hidden ? "Unhide" : "Hide"} ${esc(c.name)}">${c.hidden ? "Show" : "Hide"}</button>
            <button type="button" class="rowmenu" data-cat-del="${c.id}" aria-label="Delete ${esc(c.name)}">&#215;</button>
          </div>`).join("")}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <input id="cat-new-name" placeholder="New category" style="flex:1;min-width:120px" aria-label="New category name">
          <select id="cat-new-kind" aria-label="Kind">
            <option value="expense">expense</option><option value="income">income</option><option value="transfer">transfer</option>
          </select>
          <button type="button" class="btn small" id="cat-add">Add</button>
        </div>
        <div class="muted-note" id="cat-msg" hidden style="margin-top:6px"></div>
      </div>

      <div class="card">
        <div class="label" style="margin-bottom:8px">Rules</div>
        <p class="sub" style="margin:0 0 10px">${rules.length} rule${rules.length === 1 ? "" : "s"} ${MID} merchant contains &#8594; category, applied on every sync.</p>
        <div id="rule-list">
          ${rules.length ? rules.map((r) => `
          <div class="txn" data-rule="${r.id}">
            <div class="who"><div class="m" style="font-size:13.5px">&#8220;${esc(r.match_value)}&#8221;</div>
              <div class="meta">&#8594; ${esc(catName.get(String(r.category_id)) || "Unknown")}</div></div>
            <button type="button" class="rowmenu" data-rule-del="${r.id}" aria-label="Delete rule">&#215;</button>
          </div>`).join("") : `<p class="sub">No rules yet. Create them here or from a transaction's detail panel.</p>`}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
          <input id="rule-new-match" placeholder="Merchant contains" style="flex:1;min-width:120px" aria-label="Rule match text">
          <select id="rule-new-cat" aria-label="Rule category">
            ${categories.filter((c) => !c.hidden).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
          </select>
          <label class="switch"><input type="checkbox" id="rule-new-retro" checked><span class="knob"></span><span style="font-size:12px">apply to existing</span></label>
          <button type="button" class="btn small" id="rule-add">Add</button>
        </div>
        <div class="muted-note" id="rule-msg" hidden style="margin-top:6px"></div>
      </div>
    </div>

    <!-- settings fields -->
    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:12px">Numbers shmoney should know</div>
      <div class="form-grid">
        <div class="field"><label class="label" for="s-income">Expected monthly income</label>
          <input id="s-income" type="number" min="0" step="1" value="${esc(sVal("expected_monthly_income"))}"></div>
        <div class="field"><label class="label" for="s-roth-limit">Roth IRA contribution limit</label>
          <input id="s-roth-limit" type="number" min="0" step="1" value="${esc(sVal("roth_contribution_limit"))}"></div>
        <div class="field"><label class="label" for="s-roth-ytd">Roth contributed this year</label>
          <input id="s-roth-ytd" type="number" min="0" step="1" value="${esc(sVal("roth_contributed_ytd"))}"></div>
        <div class="field"><label class="label" for="s-ira-year">Inherited IRA ${MID} year of death</label>
          <input id="s-ira-year" type="number" min="1990" max="2100" step="1" value="${esc(sVal("inherited_ira_year_of_death"))}"></div>
        <div class="field"><label class="label" for="s-ira-start">Inherited IRA ${MID} starting balance</label>
          <input id="s-ira-start" type="number" min="0" step="1" value="${esc(sVal("inherited_ira_starting_balance"))}"></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:4px">
        <button type="button" class="btn primary small" id="s-save">Save settings</button>
        <span class="muted-note" id="s-msg" hidden></span>
      </div>
    </div>

    <!-- data + session -->
    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <div class="label" style="margin-bottom:8px">Data</div>
        <p class="sub" style="margin:0 0 12px">Download everything shmoney knows as CSV.</p>
        <a class="btn" style="text-decoration:none;display:inline-block" href="/api/export/csv?table=transactions" download>Export transactions</a>
        <a class="btn" style="text-decoration:none;display:inline-block" href="/api/export/csv?table=holdings" download>Export holdings</a>
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:8px">Session</div>
        <p class="sub" style="margin:0 0 12px">Signed in on this device. Sessions last 30 days.</p>
        <button type="button" class="btn" id="logout">Log out</button>
      </div>
    </div>
  </div>`;

  const say = (id, text) => {
    const el = main.querySelector(id);
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 4000);
  };

  /* ---- link / relink / sync / delete ---- */
  main.querySelector("#link-new").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { await openLink(); } catch (err) { say("#inst-msg", err.message || "Link failed"); }
    e.target.disabled = false;
  });
  main.querySelectorAll("[data-relink]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { await openLink({ itemId: Number(b.dataset.relink) }); }
    catch (err) { say("#inst-msg", err.message || "Relink failed"); }
    b.disabled = false;
  }));
  const runSync = async (btn, body) => {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Syncing";
    try {
      await api.post("/sync", body);
      refreshView();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = orig;
      say("#inst-msg", err.message || "Sync failed");
    }
  };
  const syncAllBtn = main.querySelector("#sync-all");
  if (syncAllBtn) syncAllBtn.addEventListener("click", () => runSync(syncAllBtn, {}));
  main.querySelectorAll("[data-sync]").forEach((b) =>
    b.addEventListener("click", () => runSync(b, { item_id: Number(b.dataset.sync) })));
  main.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Remove ${b.dataset.name}? All of its accounts and transactions will be deleted from shmoney.`)) return;
    b.disabled = true;
    try {
      await api.del(`/items/${b.dataset.del}`);
      refreshView();
    } catch (err) {
      b.disabled = false;
      say("#inst-msg", err.message || "Delete failed");
    }
  }));

  /* ---- categories ---- */
  main.querySelectorAll("[data-cat] .swatch").forEach((sw) => sw.addEventListener("click", async () => {
    if (sw.getAttribute("aria-pressed") === "true") return;
    const id = sw.closest("[data-cat]").dataset.cat;
    try { await api.patch(`/categories/${id}`, { color: sw.dataset.color }); refreshView(); }
    catch (err) { say("#cat-msg", err.message || "Failed"); }
  }));
  main.querySelectorAll("[data-cat-rename]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.catRename;
    const cat = categories.find((c) => String(c.id) === String(id));
    const name = prompt("Rename category", cat ? cat.name : "");
    if (!name || !name.trim()) return;
    try { await api.patch(`/categories/${id}`, { name: name.trim() }); refreshView(); }
    catch (err) { say("#cat-msg", err.message || "Rename failed"); }
  }));
  main.querySelectorAll("[data-cat-hide]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.catHide;
    const cat = categories.find((c) => String(c.id) === String(id));
    try { await api.patch(`/categories/${id}`, { hidden: cat && cat.hidden ? 0 : 1 }); refreshView(); }
    catch (err) { say("#cat-msg", err.message || "Failed"); }
  }));
  main.querySelectorAll("[data-cat-del]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.catDel;
    const row = main.querySelector(`[data-cat="${id}"] .slot-del`);
    if (!row) return;
    if (row.innerHTML) { row.innerHTML = ""; return; }
    const others = categories.filter((c) => String(c.id) !== String(id));
    if (!others.length) { say("#cat-msg", "Cannot delete the only category."); return; }
    row.innerHTML = `<div class="popover" style="margin-top:6px">
      <span class="sub">Reassign its transactions to</span>
      <select aria-label="Reassign to">${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <button type="button" class="btn small danger">Delete</button>
    </div>`;
    row.querySelector("button").addEventListener("click", async () => {
      const to = row.querySelector("select").value;
      try { await api.del(`/categories/${id}?reassign_to=${to}`); refreshView(); }
      catch (err) { say("#cat-msg", err.message || "Delete failed"); }
    });
  }));
  main.querySelector("#cat-add").addEventListener("click", async () => {
    const name = main.querySelector("#cat-new-name").value.trim();
    const kind = main.querySelector("#cat-new-kind").value;
    if (!name) return;
    const used = new Set(categories.map((c) => c.color));
    const color = COLOR_TOKENS.find((t) => !used.has(t)) || COLOR_TOKENS[categories.length % 4];
    try { await api.post("/categories", { name, kind, color }); refreshView(); }
    catch (err) { say("#cat-msg", err.message || "Add failed"); }
  });

  /* ---- rules ---- */
  main.querySelectorAll("[data-rule-del]").forEach((b) => b.addEventListener("click", async () => {
    try { await api.del(`/rules/${b.dataset.ruleDel}`); refreshView(); }
    catch (err) { say("#rule-msg", err.message || "Delete failed"); }
  }));
  main.querySelector("#rule-add").addEventListener("click", async () => {
    const match = main.querySelector("#rule-new-match").value.trim();
    const cat = main.querySelector("#rule-new-cat").value;
    const retro = main.querySelector("#rule-new-retro").checked;
    if (!match || !cat) return;
    try {
      await api.post("/rules", { match_value: match, category_id: Number(cat), retroactive: retro });
      refreshView();
    } catch (err) { say("#rule-msg", err.message || "Add failed"); }
  });

  /* ---- settings fields ---- */
  main.querySelector("#s-save").addEventListener("click", async () => {
    const num = (id) => {
      const v = main.querySelector(id).value;
      return v === "" ? null : Number(v);
    };
    try {
      await api.put("/settings", {
        expected_monthly_income: num("#s-income"),
        roth_contribution_limit: num("#s-roth-limit"),
        roth_contributed_ytd: num("#s-roth-ytd"),
        inherited_ira_year_of_death: num("#s-ira-year"),
        inherited_ira_starting_balance: num("#s-ira-start"),
      });
      say("#s-msg", "Saved.");
    } catch (err) { say("#s-msg", err.message || "Save failed"); }
  });

  /* ---- logout ---- */
  main.querySelector("#logout").addEventListener("click", async () => {
    try { await api.post("/auth/logout"); } catch { /* session is gone either way */ }
    location.reload();
  });
}
