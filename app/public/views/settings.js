// Settings: institutions (link/relink/sync/delete), Plaid Link + OAuth resume,
// categories manager, rules manager, settings fields, CSV export, logout.
import { api } from "../lib/api.js";
import { esc, fmtTimeAgo, catColor, errorCard, fmtMoneyWhole, MID } from "../lib/format.js";
import { instTile, networkBadge, brandOf, BRANDS } from "../lib/brand.js";

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
  let items, categories, rules, settings, accounts, links, authMode;
  try {
    const [i, c, r, s, a, l, am] = await Promise.all([
      api.get("/items"),
      api.get("/categories"),
      api.get("/rules"),
      api.get("/settings"),
      api.get("/accounts").catch(() => []),
      api.get("/items/links").catch(() => ({})),
      api.get("/auth/mode").catch(() => ({ mode: "password" })),
    ]);
    items = Array.isArray(i) ? i : (i && i.items) || [];
    categories = Array.isArray(c) ? c : (c && c.categories) || [];
    rules = Array.isArray(r) ? r : (r && r.rules) || [];
    settings = (s && (s.settings || s)) || {};
    accounts = Array.isArray(a) ? a : [];
    links = l || {};
    authMode = am || { mode: "password" };
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }

  const catName = new Map(categories.map((c) => [String(c.id), c.name]));
  const sVal = (k) => settings[k] != null && settings[k] !== "" ? settings[k] : "";
  const hasIra = accounts.some((a) => String(a.subtype || "").toLowerCase() === "ira") || sVal("inherited_ira_year_of_death") !== "";

  main.innerHTML = `<div class="page">
    <div class="pagehead"><h1>Settings</h1></div>

    <!-- institutions -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px;flex-wrap:wrap">
        <div class="label">Banks</div>
        <div style="display:flex;gap:8px">
          ${items.length ? `<button type="button" class="btn small" id="sync-all">Sync all</button>` : ""}
          <button type="button" class="btn primary small" id="link-new"${items.length >= MAX_CONNECTIONS ? " disabled" : ""}>Link account</button>
        </div>
      </div>
      <div id="inst-list">
      ${items.length ? items.map((it) => {
        const instAcct = { item_id: it.id, has_logo: it.has_logo, institution_name: it.institution_name, brand: it.links ? it.links.brand : null };
        const accts = accounts.filter((a) => String(a.item_id) === String(it.id));
        return `
        <div class="inst" data-item="${it.id}">
          ${instTile(instAcct, { size: 36 })}
          <div class="who"><b>${esc(it.institution_name || "Institution")}</b>
            <span class="sub">${accountCount(it)} account${accountCount(it) === 1 ? "" : "s"} ${MID} synced ${esc(fmtTimeAgo(it.last_synced_at))}${it.last_error ? ` ${MID} <span style="color:var(--crit)">${esc(it.last_error)}</span>` : ""}</span></div>
          ${statusPill(it.status)}
          <button type="button" class="btn small" data-sync="${it.id}">Sync now</button>
          <button type="button" class="btn small" data-relink="${it.id}">Relink</button>
          <button type="button" class="rowmenu" data-del="${it.id}" data-name="${esc(it.institution_name || "this institution")}" aria-label="Remove ${esc(it.institution_name || "institution")}" title="Remove institution">&#215;</button>
          <div class="inst-accts">
            ${accts.map((a) => `<div class="inst-acct" data-acct="${esc(a.id)}">
              ${instTile(a, { size: 22 })}
              <div class="who" style="min-width:140px"><span style="font-size:13.5px;font-weight:600">${esc(a.nickname || a.name)}</span>${networkBadge(a, 16)}
                <span class="sub" style="display:block">${a.nickname ? esc(a.name) + " " + MID + " " : ""}${a.mask ? MID + MID + " " + esc(a.mask) + " " + MID + " " : ""}${esc(a.subtype || a.type)}${a.hidden ? ` ${MID} hidden` : ""}</span></div>
              <input class="nick" placeholder="Nickname" value="${esc(a.nickname || "")}" aria-label="Nickname for ${esc(a.name)}" style="width:150px">
              ${a.type === "credit" ? `<input class="lim" type="number" inputmode="decimal" placeholder="${a.credit_limit ? "Limit " + fmtMoneyWhole(a.credit_limit) : "Credit limit"}" value="${a.manual_limit ? esc(a.manual_limit) : ""}" aria-label="Credit limit for ${esc(a.name)}" style="width:120px"${a.credit_limit ? " disabled title=\"Reported by the bank\"" : ""}>` : ""}
              <button type="button" class="btn small acct-save">Save</button>
              <button type="button" class="btn small acct-hide">${a.hidden ? "Show" : "Hide"}</button>
              <span class="muted-note acct-msg"></span>
            </div>`).join("")}
          </div>
        </div>`;
      }).join("")
      : `<p class="sub" style="margin:10px 0 4px">No banks linked yet.</p>`}
      </div>
      <div class="sub" style="margin-top:10px">${items.length} of ${MAX_CONNECTIONS} Plaid connections used</div>
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
        <p class="sub" style="margin:0 0 10px">Merchant contains &#8594; category. Applied on every sync.</p>
        <div id="rule-list">
          ${rules.length ? rules.map((r) => `
          <div class="txn" data-rule="${r.id}">
            <div class="who"><div class="m" style="font-size:13.5px">&#8220;${esc(r.match_value)}&#8221;</div>
              <div class="meta">&#8594; ${esc(catName.get(String(r.category_id)) || "Unknown")}</div></div>
            <button type="button" class="rowmenu" data-rule-del="${r.id}" aria-label="Delete rule">&#215;</button>
          </div>`).join("") : `<p class="sub">No rules yet.</p>`}
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

    <!-- bank links -->
    ${Object.keys(links).length ? `<div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:4px">Bank links</div>
      <p class="sub" style="margin:0 0 10px">Where &#8220;Open in bank&#8221; and &#8220;Dispute&#8221; go from a transaction.</p>
      ${Object.values(links).map((l) => `<div class="inst" data-link="${esc(l.key)}">
        ${BRANDS[l.brand] ? `<span class="brand-tile" style="width:30px;height:30px">${BRANDS[l.brand].svg}</span>` : ""}
        <div class="who" style="min-width:110px"><b>${esc(l.label)}</b><span class="sub">${esc(l.phone || "")}</span></div>
        <input class="l-activity" value="${esc(l.activity)}" aria-label="${esc(l.label)} activity URL" style="flex:2;min-width:180px" placeholder="Activity URL">
        <input class="l-dispute" value="${esc(l.dispute)}" aria-label="${esc(l.label)} dispute URL" style="flex:2;min-width:180px" placeholder="Dispute URL">
        <input class="l-phone" value="${esc(l.phone || "")}" aria-label="${esc(l.label)} phone" style="width:130px" placeholder="Phone">
        <button type="button" class="btn small l-save">Save</button>
        <button type="button" class="btn small l-reset" title="Back to the built-in default">Reset</button>
        <span class="muted-note l-msg"></span>
      </div>`).join("")}
    </div>` : ""}

    <!-- maintenance -->
    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:4px">Maintenance</div>
      <p class="sub" style="margin:0 0 10px">Re-run rules and recurring detection over everything synced.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button type="button" class="btn small" id="recat">Re-run rules</button>
        <button type="button" class="btn small" id="enrich">Fetch logos</button>
        <span class="muted-note" id="maint-msg" hidden></span>
      </div>
    </div>

    <!-- settings fields -->
    <div class="card" style="margin-top:14px">
      <div class="label" style="margin-bottom:12px">Planning numbers ${MID} optional</div>
      <div class="form-grid">
        <div class="field"><label class="label" for="s-income">Expected monthly income</label>
          <input id="s-income" type="number" min="0" step="1" value="${esc(sVal("expected_monthly_income"))}"></div>
        <div class="field"><label class="label" for="s-roth-limit">Roth IRA limit</label>
          <input id="s-roth-limit" type="number" min="0" step="1" value="${esc(sVal("roth_contribution_limit"))}"></div>
        <div class="field"><label class="label" for="s-roth-ytd">Roth contributed this year</label>
          <input id="s-roth-ytd" type="number" min="0" step="1" value="${esc(sVal("roth_contributed_ytd"))}"></div>
        ${hasIra ? `<div class="field"><label class="label" for="s-ira-year">Inherited IRA ${MID} year of death</label>
          <input id="s-ira-year" type="number" min="1990" max="2100" step="1" value="${esc(sVal("inherited_ira_year_of_death"))}"></div>
        <div class="field"><label class="label" for="s-ira-start">Inherited IRA ${MID} starting balance</label>
          <input id="s-ira-start" type="number" min="0" step="1" value="${esc(sVal("inherited_ira_starting_balance"))}"></div>` : ""}
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
        <p class="sub" style="margin:0 0 12px">CSV export.</p>
        <a class="btn" style="text-decoration:none;display:inline-block" href="/api/export/csv?table=transactions" download>Export transactions</a>
        <a class="btn" style="text-decoration:none;display:inline-block" href="/api/export/csv?table=holdings" download>Export holdings</a>
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:8px">Session</div>
        <p class="sub" style="margin:0 0 12px">${authMode.mode === "access"
          ? `Signed in through Cloudflare Access as <b>${esc(authMode.email)}</b>.`
          : "Signed in with the app password. Sessions last 30 days."}</p>
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
    if (!confirm(`Remove ${b.dataset.name} and all of its accounts and transactions?`)) return;
    b.disabled = true;
    try {
      await api.del(`/items/${b.dataset.del}`);
      refreshView();
    } catch (err) {
      b.disabled = false;
      say("#inst-msg", err.message || "Delete failed");
    }
  }));

  /* ---- accounts: nickname / manual limit / hide ---- */
  main.querySelectorAll(".inst-acct").forEach((row) => {
    const id = row.dataset.acct;
    const msg = row.querySelector(".acct-msg");
    const flash = (t) => { msg.textContent = t; setTimeout(() => { msg.textContent = ""; }, 3000); };
    row.querySelector(".acct-save").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const body = { nickname: row.querySelector(".nick").value.trim() || null };
      const lim = row.querySelector(".lim");
      if (lim && !lim.disabled) body.manual_limit = lim.value === "" ? null : Number(lim.value);
      btn.disabled = true;
      try {
        await api.patch(`/accounts/${encodeURIComponent(id)}`, body);
        btn.textContent = "Saved"; flash("Saved.");
        setTimeout(() => { btn.textContent = "Save"; }, 2500);
      } catch (err) { flash(err.message || "Save failed"); }
      btn.disabled = false;
    });
    row.querySelector(".acct-hide").addEventListener("click", async () => {
      const a = accounts.find((x) => String(x.id) === String(id));
      try { await api.patch(`/accounts/${encodeURIComponent(id)}`, { hidden: a && a.hidden ? 0 : 1 }); refreshView(); }
      catch (err) { flash(err.message || "Failed"); }
    });
  });

  /* ---- bank link overrides ---- */
  const readOverrides = () => { try { return settings.inst_links ? JSON.parse(settings.inst_links) : {}; } catch { return {}; } };
  main.querySelectorAll("[data-link]").forEach((row) => {
    const key = row.dataset.link;
    const msg = row.querySelector(".l-msg");
    const saveBtn = row.querySelector(".l-save");
    saveBtn.addEventListener("click", async () => {
      const overrides = readOverrides();
      overrides[key] = {
        activity: row.querySelector(".l-activity").value.trim(),
        dispute: row.querySelector(".l-dispute").value.trim(),
        phone: row.querySelector(".l-phone").value.trim(),
      };
      saveBtn.disabled = true;
      try {
        settings = await api.put("/settings", { inst_links: JSON.stringify(overrides) });
        saveBtn.textContent = "Saved"; msg.textContent = "Links saved.";
        setTimeout(() => { saveBtn.textContent = "Save"; msg.textContent = ""; }, 3000);
      } catch (err) { msg.textContent = err.message || "Save failed"; }
      saveBtn.disabled = false;
    });
    row.querySelector(".l-reset").addEventListener("click", async () => {
      const overrides = readOverrides();
      delete overrides[key];
      try {
        settings = await api.put("/settings", { inst_links: JSON.stringify(overrides) });
        refreshView();
      } catch (err) { msg.textContent = err.message || "Reset failed"; }
    });
  });

  /* ---- maintenance ---- */
  const maint = async (btn, path, body, done) => {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = "Working";
    try { const r = await api.post(path, body); say("#maint-msg", done(r)); }
    catch (err) { say("#maint-msg", err.message || "Failed"); }
    btn.disabled = false; btn.textContent = orig;
  };
  main.querySelector("#recat").addEventListener("click", (e) =>
    maint(e.currentTarget, "/transactions/recategorize", { retroactive: true }, (r) => `Done. ${r.rulesApplied} transactions updated.`));
  main.querySelector("#enrich").addEventListener("click", (e) =>
    maint(e.currentTarget, "/items/enrich", {}, (r) => `Institutions: ${r.institutions} ${MID} merchant logos: ${r.merchants.updated} of ${r.merchants.scanned}`));

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
      const el = main.querySelector(id);
      if (!el) return undefined;
      return el.value === "" ? null : Number(el.value);
    };
    try {
      const body = {
        expected_monthly_income: num("#s-income"),
        roth_contribution_limit: num("#s-roth-limit"),
        roth_contributed_ytd: num("#s-roth-ytd"),
        inherited_ira_year_of_death: num("#s-ira-year"),
        inherited_ira_starting_balance: num("#s-ira-start"),
      };
      Object.keys(body).forEach((k) => { if (body[k] === undefined) delete body[k]; });
      await api.put("/settings", body);
      say("#s-msg", "Saved.");
    } catch (err) { say("#s-msg", err.message || "Save failed"); }
  });

  /* ---- logout ---- */
  main.querySelector("#logout").addEventListener("click", async () => {
    try { await api.post("/auth/logout"); } catch { /* session is gone either way */ }
    if (authMode.mode === "access") { location.href = "/cdn-cgi/access/logout"; return; }
    location.reload();
  });
}
