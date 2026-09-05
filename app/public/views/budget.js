// Budget: month nav, pace-colored rows, edit mode with suggestion chips,
// move-money popover, rebalance modal, rollover banner, per-category settings.
import { api } from "../lib/api.js";
import {
  esc, fmtMoney, fmtMoneyWhole, catColor, emptyState, errorCard,
  currentMonth, shiftMonth, monthLabel, monthShort, daysInMonth, todayStr, MID, MINUS,
} from "../lib/format.js";

let month = null;
let editMode = false;

const PRESET_LABEL = {
  fixed: "Fixed amount",
  last_month_budget: "Last month's budget",
  avg_3mo_spend: "Avg 3-mo spend",
  recurring_total: "Recurring total",
};

function fillClass(pace) {
  if (pace === "over") return "over";
  if (pace === "projected_over") return "warn";
  return "";
}

function stateLine(row, { isCurrent, isPast, day, daysLeft }) {
  const spent = Number(row.spent) || 0;
  const budget = Number(row.budget) || 0;
  const available = row.available != null ? Number(row.available) : budget - spent;
  if (row.pace === "over") {
    // Past months are settled: no point offering to move money into them.
    const cover = isPast ? "" : ` &#8212; <button type="button" class="linky" data-move="${row.category_id}">cover from another category</button>`;
    return `<div class="bstate over">&#9679; Over by ${fmtMoneyWhole(spent - budget)}${cover}</div>`;
  }
  if (row.pace === "projected_over") {
    const proj = Number(row.projected) || 0;
    const overBy = Math.max(0, proj - budget);
    const runsOut = row.exhaustDays != null && Number(row.exhaustDays) < daysLeft
      ? ` ${MID} runs out in ~${Number(row.exhaustDays)} day${Number(row.exhaustDays) === 1 ? "" : "s"}` : "";
    return `<div class="bstate warn">&#9679; On pace for ~${fmtMoneyWhole(proj)}${overBy > 0 ? ` &#8212; projected ${fmtMoneyWhole(overBy)} over` : ""}${runsOut}</div>`;
  }
  if (available > 0 && available <= budget * 0.15) {
    return `<div class="bstate warn">&#9679; ${fmtMoneyWhole(available)} left</div>`;
  }
  return "";
}

// Muted second line: pace (current month, after day 7) and month-over-month.
function paceLine(row, { isCurrent, isFuture, day, daysLeft }) {
  const spent = Number(row.spent) || 0;
  const budget = Number(row.budget) || 0;
  const bits = [];
  if (isCurrent && budget > 0) {
    if (day >= 7 && spent > 0 && row.pace !== "over" && row.pace !== "projected_over") {
      bits.push(`on pace for ~${fmtMoneyWhole(row.projected)}`);
    }
    if (row.dailyLeft != null && daysLeft > 0 && row.pace !== "over") {
      const perDay = Number(row.dailyLeft);
      bits.push(`${fmtMoney(perDay, { cents: perDay < 10 })}/day left`);
    }
  }
  const lm = row.lastMonthSpent != null ? Number(row.lastMonthSpent) : null;
  if (!isFuture && lm != null && (lm > 0 || spent > 0)) {
    let cmp = `vs last month ${fmtMoneyWhole(lm)}`;
    if (lm > 0 && row.lastMonthDeltaPct != null && spent > 0) {
      const pct = Number(row.lastMonthDeltaPct);
      cmp += pct === 0 ? " (same)" : ` (${pct > 0 ? "up" : "down"} ${Math.abs(pct)}%)`;
    } else if (lm > 0 && spent === 0) {
      cmp += " (nothing yet)";
    }
    bits.push(cmp);
  }
  return bits.length ? `<div class="bg-pace">${bits.join(` ${MID} `)}</div>` : "";
}

function viewRow(row, ctx) {
  const spent = Number(row.spent) || 0;
  const budget = Number(row.budget) || 0;
  const pct = budget > 0 ? Math.min(100, spent / budget * 100) : (spent > 0 ? 100 : 0);
  return `<div class="brow" data-row="${row.category_id}">
    <div class="top">
      <span class="name"><i style="width:8px;height:8px;border-radius:99px;background:${catColor(row.color)};display:inline-block"></i>${esc(row.name)}</span>
      <span style="display:flex;gap:6px;align-items:baseline">
        <span class="nums"><b>${fmtMoneyWhole(spent)}</b> / ${fmtMoneyWhole(budget)}</span>
        <button type="button" class="rowmenu" data-menu="${row.category_id}" aria-label="Category budget settings for ${esc(row.name)}" aria-expanded="false">&#8942;</button>
      </span>
    </div>
    <div class="track"><div class="fill ${fillClass(row.pace)}" style="width:${pct}%"></div></div>
    ${stateLine(row, ctx)}
    ${paceLine(row, ctx)}
    <div class="slot-move"></div>
    <div class="slot-settings"></div>
  </div>`;
}

function suggChips(sug) {
  if (!sug) return "";
  const chips = [];
  if (sug.avg3mo != null) chips.push([`Avg 3 months ${MID} ${fmtMoneyWhole(sug.avg3mo)}`, sug.avg3mo]);
  if (sug.lastMonthSpend != null) chips.push([`Last month ${MID} ${fmtMoneyWhole(sug.lastMonthSpend)}`, sug.lastMonthSpend]);
  if (sug.recurringTotal != null && Number(sug.recurringTotal) > 0) chips.push([`Recurring in category ${MID} ${fmtMoneyWhole(sug.recurringTotal)}`, sug.recurringTotal]);
  return chips.map(([label, v]) =>
    `<button type="button" class="chip" data-sugg="${Math.round(Number(v) || 0)}">${esc(label)}</button>`).join("");
}

function editRow(cat, currentAmount, sug) {
  return `<div class="brow editrow" data-editrow="${cat.id}">
    <div class="top">
      <span class="name"><i style="width:8px;height:8px;border-radius:99px;background:${catColor(cat.color)};display:inline-block"></i>${esc(cat.name)}</span>
      <input class="amount-input" type="number" min="0" step="1" inputmode="numeric" value="${Math.round(Number(currentAmount) || 0) || ""}" placeholder="0" aria-label="Budget for ${esc(cat.name)}" data-cat="${cat.id}">
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${suggChips(sug)}</div>
  </div>`;
}

export default async function render(main) {
  if (!month) month = currentMonth();
  const isCurrent = month === currentMonth();
  const nextMonth = shiftMonth(currentMonth(), 1);

  let data, categories, suggestions = new Map(), nextData = null, settings = null;
  try {
    const wants = [
      api.get(`/budgets?month=${month}`),
      api.get("/categories"),
      editMode ? api.get(`/budgets/${month}/suggestions`).catch(() => []) : Promise.resolve(null),
      isCurrent ? api.get(`/budgets?month=${nextMonth}`).catch(() => null) : Promise.resolve(null),
      editMode ? api.get("/settings").catch(() => null) : Promise.resolve(null),
    ];
    const [b, cats, sugg, nx, st] = await Promise.all(wants);
    data = b || {};
    categories = Array.isArray(cats) ? cats : (cats && cats.categories) || [];
    if (sugg) {
      const list = Array.isArray(sugg) ? sugg : sugg.suggestions || [];
      list.forEach((s) => suggestions.set(String(s.category_id), s));
    }
    nextData = nx;
    settings = st && (st.settings || st);
  } catch (err) {
    main.innerHTML = `<div class="page">${errorCard(err)}</div>`;
    return;
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const totals = data.totals || {};
  const budgetTotal = Number(totals.budget ?? totals.budgeted ?? rows.reduce((a, r) => a + (Number(r.budget) || 0), 0)) || 0;
  // Spent-of-budgeted only sums categories that have a budget; unbudgeted
  // spend is shown on its own line so the ratio is not polluted.
  const spentBudgeted = Number(totals.spentBudgeted ?? rows.reduce((a, r) => a + (Number(r.budget) > 0 ? Number(r.spent) || 0 : 0), 0)) || 0;
  const unbudgetedRows = rows.filter((r) => !(Number(r.budget) > 0) && Number(r.spent) > 0);
  const unbudgetedSpent = Number(totals.unbudgetedSpent ?? unbudgetedRows.reduce((a, r) => a + (Number(r.spent) || 0), 0)) || 0;
  const left = budgetTotal - spentBudgeted;
  const onTrack = data.onTrack || null;
  const isPast = month < currentMonth();
  const isFuture = month > currentMonth();
  const dim = daysInMonth(month);
  const dayOfMonth = isCurrent ? Number(todayStr().slice(8, 10)) : (isPast ? dim : 0);
  const daysLeft = Math.max(0, dim - dayOfMonth);
  const ctx = { isCurrent, isPast, isFuture, day: dayOfMonth, daysLeft };
  const hasBudget = rows.some((r) => Number(r.budget) > 0);
  const onTrackText = onTrack && hasBudget
    ? `${onTrack.on} of ${onTrack.of} budgeted on track` +
      (unbudgetedRows.length ? ` ${MID} ${unbudgetedRows.length} unbudgeted (${fmtMoneyWhole(unbudgetedSpent)})` : "")
    : "";

  // rollover banner: current month view, next month has no budget rows
  const nextRows = nextData && Array.isArray(nextData.rows) ? nextData.rows : null;
  const showRollover = isCurrent && hasBudget && nextRows !== null && !nextRows.some((r) => Number(r.budget) > 0);

  const expenseCats = categories.filter((c) => (c.kind || "expense") === "expense" && !c.hidden);
  const rowByCat = new Map(rows.map((r) => [String(r.category_id), r]));
  const expectedIncome = settings ? Number(settings.expected_monthly_income) || 0 : 0;

  main.innerHTML = `<div class="page">
    <div class="pagehead">
      <div><h1>Budget</h1>${onTrackText ? `<span class="sub">${esc(onTrackText)}</span>` : ""}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <div class="chips" role="group" aria-label="Month">
          <button type="button" class="chip" id="m-prev" aria-label="Previous month">&#8249;</button>
          <button type="button" class="chip active" id="m-today" title="${isCurrent ? "Current month" : "Jump to the current month"}" aria-label="${esc(monthLabel(month))}${isCurrent ? "" : ", jump to the current month"}"${isCurrent ? " disabled" : ""}>${esc(monthLabel(month))}</button>
          <button type="button" class="chip" id="m-next" aria-label="Next month">&#8250;</button>
        </div>
        ${hasBudget || editMode ? `<button type="button" class="btn" id="b-rebalance"${editMode ? " disabled" : ""}>Rebalance</button>` : ""}
        <button type="button" class="btn${editMode ? " primary" : ""}" id="b-edit">${editMode ? "Save budgets" : "Edit budgets"}</button>
        ${editMode ? `<button type="button" class="btn" id="b-cancel">Cancel</button>` : ""}
      </div>
    </div>

    <div id="b-banner">
    ${showRollover ? `<div class="card banner">
      <span class="sub">${esc(monthLabel(nextMonth))}'s budget hasn't been created yet. Create it now from your presets (default: copy this month).</span>
      <button type="button" class="btn small" id="b-rollover">Create ${esc(monthShort(nextMonth))} budget</button>
    </div>` : ""}
    </div>

    ${!editMode && hasBudget ? `
    <div class="grid two" style="margin-bottom:14px">
      <div class="card"><div class="label">Spent of budgeted</div>
        <div class="hero-num" style="font-size:28px">${fmtMoneyWhole(spentBudgeted)} <span style="color:var(--muted);font-weight:500;font-size:17px">/ ${fmtMoneyWhole(budgetTotal)}</span></div>
        ${unbudgetedSpent > 0 ? `<div class="bg-unbudgeted">+ ${fmtMoneyWhole(unbudgetedSpent)} unbudgeted ${MID} ${esc(unbudgetedRows.map((r) => r.name).join(", "))}</div>` : ""}</div>
      <div class="card"><div class="label">${left < 0 ? "Over by" : "Left to spend"}${isCurrent ? ` ${MID} ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : ""}</div>
        <div class="hero-num" style="font-size:28px;color:${left >= 0 ? "var(--accent)" : "var(--crit)"}">${fmtMoneyWhole(Math.abs(left))}</div>
        ${isCurrent && left > 0 && daysLeft > 0 ? `<div class="bg-unbudgeted">${fmtMoneyWhole(left / daysLeft)}/day</div>` : ""}</div>
    </div>` : ""}

    <div class="card" id="b-list">
      ${editMode
        ? (expenseCats.length
            ? expenseCats.map((c) => editRow(c, rowByCat.get(String(c.id))?.budget, suggestions.get(String(c.id)))).join("") +
              `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;flex-wrap:wrap;gap:8px">
                 <span class="sub" id="b-sanity"></span>
                 <span class="muted-note">Set an amount to 0 to remove a category's budget.</span>
               </div>`
            : emptyState({ title: "No expense categories", body: "Add categories in Settings first, then budget against them.", actionLabel: "Go to Settings", actionHash: "#/settings" }))
        : (hasBudget
            ? rows.filter((r) => Number(r.budget) > 0 || Number(r.spent) > 0).map((r) => viewRow(r, ctx)).join("")
            : emptyState({
                title: "No budget for " + monthLabel(month),
                body: "Set monthly targets per category. Suggestion chips from your own history make this quick.",
                glyph: "bars",
              }) + `<div style="text-align:center;margin-top:-6px;padding-bottom:20px"><button type="button" class="btn primary" id="b-start">Set up budgets</button></div>`)}
    </div>
    <div id="b-modal"></div>
  </div>`;

  /* ---- month nav ---- */
  main.querySelector("#m-prev").addEventListener("click", () => { month = shiftMonth(month, -1); editMode = false; render(main); });
  main.querySelector("#m-next").addEventListener("click", () => { month = shiftMonth(month, 1); editMode = false; render(main); });
  main.querySelector("#m-today").addEventListener("click", () => { if (!isCurrent) { month = currentMonth(); editMode = false; render(main); } });

  /* ---- edit mode ---- */
  const editBtn = main.querySelector("#b-edit");
  const startBtn = main.querySelector("#b-start");
  if (startBtn) startBtn.addEventListener("click", () => { editMode = true; render(main); });
  const cancelBtn = main.querySelector("#b-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", () => { editMode = false; render(main); });

  if (editMode) {
    const sanity = main.querySelector("#b-sanity");
    const updateSanity = () => {
      if (!sanity) return;
      let sum = 0;
      main.querySelectorAll(".amount-input").forEach((i) => { sum += Number(i.value) || 0; });
      sanity.textContent = `Budgeted ${fmtMoneyWhole(sum)}` + (expectedIncome > 0 ? ` / est. income ${fmtMoneyWhole(expectedIncome)}` : "");
    };
    updateSanity();
    main.querySelectorAll(".amount-input").forEach((i) => i.addEventListener("input", updateSanity));
    main.querySelectorAll("[data-sugg]").forEach((chip) => chip.addEventListener("click", () => {
      const input = chip.closest("[data-editrow]").querySelector(".amount-input");
      input.value = chip.dataset.sugg;
      updateSanity();
    }));
    editBtn.addEventListener("click", async () => {
      editBtn.disabled = true;
      const out = [];
      main.querySelectorAll(".amount-input").forEach((i) => {
        out.push({ category_id: Number(i.dataset.cat), amount: Number(i.value) || 0 });
      });
      try {
        await api.put(`/budgets/${month}`, { rows: out });
        editMode = false;
        render(main);
      } catch (err) {
        editBtn.disabled = false;
        alert(err.message || "Save failed");
      }
    });
    return; // view-mode wiring below not needed
  }

  editBtn.addEventListener("click", () => { editMode = true; render(main); });

  /* ---- rollover ---- */
  const roll = main.querySelector("#b-rollover");
  if (roll) roll.addEventListener("click", async () => {
    roll.disabled = true;
    roll.textContent = "Creating";
    try {
      await api.post(`/budgets/${nextMonth}/rollover`);
      main.querySelector("#b-banner").innerHTML = `<div class="card banner"><span class="sub">${esc(monthLabel(nextMonth))} budget created from your presets. <a href="#" id="b-viewnext">Review it</a></span></div>`;
      main.querySelector("#b-viewnext").addEventListener("click", (e) => { e.preventDefault(); month = nextMonth; render(main); });
    } catch (err) {
      roll.disabled = false;
      roll.textContent = `Create ${monthShort(nextMonth)} budget`;
      alert(err.message || "Rollover failed");
    }
  });

  /* ---- move-money popover ---- */
  main.querySelectorAll("[data-move]").forEach((link) => link.addEventListener("click", () => {
    const catId = link.dataset.move;
    const row = rows.find((r) => String(r.category_id) === String(catId));
    const rowEl = main.querySelector(`[data-row="${catId}"] .slot-move`);
    if (!row || !rowEl) return;
    if (rowEl.innerHTML) { rowEl.innerHTML = ""; return; }
    const overBy = Math.max(1, Math.round((Number(row.spent) || 0) - (Number(row.budget) || 0)));
    const donors = rows.filter((r) => {
      const avail = r.available != null ? Number(r.available) : (Number(r.budget) || 0) - (Number(r.spent) || 0);
      return String(r.category_id) !== String(catId) && avail > 0;
    });
    if (!donors.length) {
      rowEl.innerHTML = `<div class="popover"><span class="sub">No other category has money left this month.</span></div>`;
      return;
    }
    rowEl.innerHTML = `<div class="popover">
      <span class="sub">Move</span>
      <input class="amount-input" style="width:80px" type="number" min="1" value="${overBy}" aria-label="Amount to move">
      <span class="sub">from</span>
      <select aria-label="Source category">
        ${donors.map((d) => {
          const avail = d.available != null ? Number(d.available) : (Number(d.budget) || 0) - (Number(d.spent) || 0);
          return `<option value="${d.category_id}">${esc(d.name)} ${MID} ${fmtMoneyWhole(avail)} left</option>`;
        }).join("")}
      </select>
      <button type="button" class="btn primary small">Move</button>
    </div>`;
    rowEl.querySelector("button").addEventListener("click", async () => {
      const amount = Number(rowEl.querySelector("input").value) || 0;
      const from = Number(rowEl.querySelector("select").value);
      if (amount <= 0) return;
      try {
        await api.post(`/budgets/${month}/move`, { from_category_id: from, to_category_id: Number(catId), amount });
        render(main);
      } catch (err) {
        alert(err.message || "Move failed");
      }
    });
  }));

  /* ---- per-category settings (rollover toggle + preset) ---- */
  const nextMonthOf = shiftMonth(month, 1);
  // What a preset would produce if the next month were created right now.
  const presetPreview = async (row, type, value) => {
    if (type === "fixed") return Number(value) || 0;
    if (type === "last_month_budget") return Number(row.budget) || 0;
    if (type === "avg_3mo_spend" || type === "recurring_total") {
      const sugg = await api.get(`/budgets/${nextMonthOf}/suggestions`).catch(() => null);
      const list = Array.isArray(sugg) ? sugg : (sugg && sugg.suggestions) || [];
      const s = list.find((x) => String(x.category_id) === String(row.category_id));
      if (!s) return null;
      return Number(type === "avg_3mo_spend" ? s.avg3mo : s.recurringTotal) || 0;
    }
    return Number(row.budget) || 0; // no preset: copies this month's budget
  };
  main.querySelectorAll("[data-menu]").forEach((btn) => btn.addEventListener("click", () => {
    const catId = btn.dataset.menu;
    const row = rows.find((r) => String(r.category_id) === String(catId)) || {};
    const slot = main.querySelector(`[data-row="${catId}"] .slot-settings`);
    if (!slot) return;
    if (slot.innerHTML) { slot.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    const curType = row.preset_type || "";
    slot.innerHTML = `<div class="brow-settings">
      <label class="switch"><input type="checkbox" class="s-roll"${row.rollover ? " checked" : ""}><span class="knob"></span><span>Roll over what's left</span></label>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink-2)">Preset
        <select class="s-preset">
          <option value=""${curType === "" ? " selected" : ""}>None (copy last month)</option>
          ${Object.entries(PRESET_LABEL).map(([v, l]) => `<option value="${v}"${curType === v ? " selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <input class="s-preset-val" type="number" min="0" style="width:90px;${curType === "fixed" ? "" : "display:none"}" placeholder="$" aria-label="Preset amount" value="${curType === "fixed" && row.preset_value != null ? Math.round(Number(row.preset_value) || 0) : ""}">
      <button type="button" class="btn small s-save">Save</button>
      <span class="muted-note s-msg" role="status" aria-live="polite"></span>
    </div>`;
    const presetSel = slot.querySelector(".s-preset");
    const valInput = slot.querySelector(".s-preset-val");
    presetSel.addEventListener("change", () => {
      valInput.style.display = presetSel.value === "fixed" ? "" : "none";
    });
    slot.querySelector(".s-save").addEventListener("click", async () => {
      const msg = slot.querySelector(".s-msg");
      const saveBtn = slot.querySelector(".s-save");
      const body = {
        rollover: slot.querySelector(".s-roll").checked ? 1 : 0,
        preset_type: presetSel.value || null,
        preset_value: presetSel.value === "fixed" ? (Number(valInput.value) || 0) : null,
      };
      saveBtn.disabled = true;
      try {
        await api.patch(`/categories/${catId}`, body);
        row.rollover = body.rollover;
        row.preset_type = body.preset_type;
        row.preset_value = body.preset_value;
        msg.textContent = "Preset saved.";
        const would = await presetPreview(row, body.preset_type, body.preset_value);
        msg.textContent = `Preset saved. Applies when ${monthShort(nextMonthOf)} is created` +
          (would != null ? ` (would be ${fmtMoneyWhole(would)} now).` : ".");
        setTimeout(() => { slot.innerHTML = ""; btn.setAttribute("aria-expanded", "false"); }, 4000);
      } catch (err) {
        saveBtn.disabled = false;
        msg.textContent = err.message || "Save failed";
      }
    });
  }));

  /* ---- rebalance modal ---- */
  const reb = main.querySelector("#b-rebalance");
  if (reb) reb.addEventListener("click", async () => {
    reb.disabled = true;
    let preview;
    try {
      preview = await api.post(`/budgets/${month}/rebalance`, { apply: false, scope: "month" });
    } catch (err) {
      reb.disabled = false;
      alert(err.message || "Rebalance preview failed");
      return;
    }
    reb.disabled = false;
    const catName = new Map(categories.map((c) => [String(c.id), c.name]));
    rows.forEach((r) => catName.set(String(r.category_id), r.name));
    const pRows = (Array.isArray(preview) ? preview : preview.rows || preview.proposed || [])
      .map((r) => {
        const cur = Number(r.current ?? r.budget ?? rowByCat.get(String(r.category_id))?.budget ?? 0);
        const prop = Number(r.proposed ?? r.amount ?? r.proposed_amount ?? 0);
        const spent = Number(r.spent ?? rowByCat.get(String(r.category_id))?.spent ?? 0);
        return {
          id: r.category_id, name: r.name || catName.get(String(r.category_id)) || `Category ${r.category_id}`,
          cur, prop, delta: prop - cur, spent, floored: !!r.floored, over: !!r.over || prop < spent,
        };
      });
    const anyFloored = pRows.some((r) => r.floored);
    const previewTotal = Number(preview.total ?? budgetTotal) || budgetTotal;
    const totalChanged = !!preview.totalChanged;
    const modalWrap = main.querySelector("#b-modal");
    modalWrap.innerHTML = `<div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Rebalance budgets">
        <h2>Rebalance ${esc(monthLabel(month))}</h2>
        <p class="sub" style="margin:0 0 12px">Reallocates your total (${fmtMoneyWhole(budgetTotal)}) across categories, weighted by your average spending over the last 3 months.${anyFloored ? ` Rows marked &#8224; were raised to what is already spent this month (rounded up to $5).` : ""}${totalChanged ? ` Spend already exceeds the total, so it rises to ${fmtMoneyWhole(previewTotal)}.` : ""}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Category</th><th>Current</th><th>Spent</th><th>Proposed</th><th>&#916;</th></tr></thead>
          <tbody>
            ${pRows.map((r) => `<tr${r.over ? ' class="bg-reb-over"' : ""}>
              <td>${esc(r.name)}${r.floored ? ' <span class="bg-floored" title="Raised to spend so far this month">&#8224;</span>' : ""}</td>
              <td>${fmtMoneyWhole(r.cur)}</td>
              <td class="${r.over ? "negd" : ""}">${fmtMoneyWhole(r.spent)}${r.over ? " over" : ""}</td>
              <td><b>${fmtMoneyWhole(r.prop)}</b></td>
              <td class="${r.delta > 0 ? "pos" : r.delta < 0 ? "negd" : ""}">${r.delta === 0 ? MID : (r.delta > 0 ? "+" : MINUS) + fmtMoneyWhole(Math.abs(r.delta)).replace(MINUS, "")}</td>
            </tr>`).join("")}
          </tbody>
        </table></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="rb-cancel">Cancel</button>
          <button type="button" class="btn" id="rb-future">From now on</button>
          <button type="button" class="btn primary" id="rb-month">Apply this month</button>
        </div>
      </div>
    </div>`;
    const closeModal = () => { modalWrap.innerHTML = ""; };
    modalWrap.querySelector("#rb-cancel").addEventListener("click", closeModal);
    modalWrap.querySelector(".modal-backdrop").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
    const apply = async (scope) => {
      try {
        await api.post(`/budgets/${month}/rebalance`, { apply: true, scope });
        closeModal();
        render(main);
      } catch (err) {
        alert(err.message || "Rebalance failed");
      }
    };
    modalWrap.querySelector("#rb-month").addEventListener("click", () => apply("month"));
    modalWrap.querySelector("#rb-future").addEventListener("click", () => apply("future"));
  });
}
