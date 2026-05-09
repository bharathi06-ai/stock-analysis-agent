/* ═══════════════════════════════════════════════════════
   StockDesk by Siva — Dashboard JS (Phase D)
   Company-name UX: three views, no ticker search.
═══════════════════════════════════════════════════════ */

"use strict";

// ── Currency unit (set from dashboard payload on each render) ─────────────
let _currencyUnit = "SEKm";
function _baseCcy() { return _currencyUnit.replace(/m$/i, ""); }

// ── Helpers ──────────────────────────────────────────
function fmt(v, decimals = 2, suffix = "") {
  if (v == null || v === "" || isNaN(v)) return "—";
  return Number(v).toLocaleString("sv-SE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + suffix;
}

function fmtM(v)   { return v == null ? "—" : fmt(v, 0) + " " + _currencyUnit; }
function fmtPct(v) { return v == null ? "—" : fmt(v, 2) + "%"; }

function colClass(v) {
  if (v == null) return "";
  return v >= 0 ? "pos" : "neg";
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// HTML-safe string for use inside attributes and text nodes
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Top-nav view switching ────────────────────────────
function switchView(viewId) {
  document.querySelectorAll(".view-panel").forEach(p => p.classList.add("hidden"));
  document.getElementById(viewId).classList.remove("hidden");
  document.querySelectorAll(".top-nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === viewId);
  });
  if (viewId === "view-upload") renderUploadView();
}

// ── Status bar ────────────────────────────────────────
function showStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  document.getElementById("status-text").textContent = msg;
  document.getElementById("status-icon").textContent = isError ? "✖" : "⏳";
  document.getElementById("status-step").textContent = "";
  document.getElementById("status-track").classList.add("hidden");
  bar.classList.remove("hidden", "error-bar");
  if (isError) bar.classList.add("error-bar");
}

function showProgress(msg, step, total) {
  document.getElementById("status-text").textContent = msg;
  document.getElementById("status-icon").textContent = "⏳";
  document.getElementById("status-step").textContent = `${step} of ${total}`;
  document.getElementById("status-fill").style.width =
    Math.round((step / total) * 100) + "%";
  document.getElementById("status-track").classList.remove("hidden");
  const bar = document.getElementById("status-bar");
  bar.classList.remove("hidden", "error-bar");
}

function hideStatus() {
  document.getElementById("status-bar").classList.add("hidden");
}

// ── Tab switching ─────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ════════════════════════════════════════════════════════
//  COMPANIES CACHE & INIT
// ════════════════════════════════════════════════════════

let _companiesCache = null;  // { companies: [...] }
let _currentCompany = null;  // currently loaded company name

async function _fetchCompanies(force = false) {
  if (!force && _companiesCache) return _companiesCache;
  const resp = await fetch("/api/list_reports");
  if (!resp.ok) throw new Error("Failed to load companies (" + resp.status + ")");
  _companiesCache = await resp.json();
  return _companiesCache;
}

function _analysedCompanies(data) {
  return (data.companies || []).filter(c => c.analysed);
}

// Called once on page load (after password gate)
async function initApp() {
  try {
    const data = await _fetchCompanies();
    const analysed = _analysedCompanies(data);
    populateDeskDropdown(data.companies || []);
    populateUploadDropdown(data.companies || []);

    if (analysed.length > 0) {
      switchView("view-desk");
      await loadCompany(analysed[0].company_name);
    } else {
      switchView("view-upload");
      renderCompanyCards(data.companies || []);
    }
  } catch (_) {
    switchView("view-upload");
  }
}

// ════════════════════════════════════════════════════════
//  MY STOCK DESK
// ════════════════════════════════════════════════════════

function populateDeskDropdown(companies) {
  const sel = document.getElementById("desk-company-select");
  const analysed = (companies || []).filter(c => c.analysed);
  sel.innerHTML = analysed.length
    ? analysed.map(c => `<option value="${esc(c.company_name)}">${esc(c.company_name)}</option>`).join("")
    : '<option value="">No analysed companies</option>';
}

async function onDeskCompanyChange(companyName) {
  if (companyName && companyName !== _currentCompany) {
    await loadCompany(companyName);
  }
}

async function loadCompany(companyName) {
  _currentCompany = companyName;
  document.getElementById("desk-empty").classList.add("hidden");
  document.getElementById("desk-content").classList.remove("hidden");
  document.getElementById("dashboard").classList.add("hidden");

  // Sync dropdown
  const sel = document.getElementById("desk-company-select");
  if (sel) sel.value = companyName;

  showStatus("Loading " + companyName + "…");

  try {
    const resp = await fetch("/api/analyse", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ company_name: companyName }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showStatus(err.error || "Failed to load data", true);
      return;
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); }
        catch { continue; }

        if (evt.type === "progress") {
          showProgress(evt.message, evt.step, evt.total);

        } else if (evt.type === "done") {
          hideStatus();
          renderDashboard(evt.result);
          document.getElementById("dashboard").classList.remove("hidden");
          // Reset to summary tab
          document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
          document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
          document.querySelector('.tab-btn[data-tab="summary"]').classList.add("active");
          document.getElementById("tab-summary").classList.add("active");

        } else if (evt.type === "error") {
          showStatus(evt.message || "Analysis failed", true);
        }
      }
    }
  } catch (err) {
    showStatus("Network error: " + err.message, true);
  }
}

// ════════════════════════════════════════════════════════
//  FINANCIAL TABLE HELPERS
// ════════════════════════════════════════════════════════

function toE(v) { return v; }
function fmtE(v) { return v == null ? "—" : fmt(v, 0); }

function yoyPct(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function cagrPct(latest, oldest, n) {
  if (latest == null || oldest == null || oldest <= 0 || n <= 0) return null;
  return (Math.pow(latest / oldest, 1 / n) - 1) * 100;
}

function trendArrow(curr, prev, lowerIsBetter = false) {
  if (curr == null || prev == null) return { sym: "►", cls: "trend-flat" };
  const diff = Math.abs(prev) > 0 ? (curr - prev) / Math.abs(prev) : 0;
  if (Math.abs(diff) < 0.005) return { sym: "►", cls: "trend-flat" };
  const up   = curr > prev;
  const good = lowerIsBetter ? !up : up;
  return { sym: up ? "▲" : "▼", cls: good ? "trend-up" : "trend-down" };
}

function deltaYoYCell(curr, prev, lb = false) {
  const yoy = yoyPct(curr, prev);
  if (yoy == null) return '<td class="delta-neu">—</td>';
  const good = lb ? yoy <= 0 : yoy >= 0;
  return `<td class="${good ? 'delta-pos' : 'delta-neg'}">${yoy >= 0 ? "+" : ""}${fmt(yoy, 1)}%</td>`;
}

function deltaAbsCell(curr, prev, lb = false) {
  if (curr == null || prev == null) return '<td class="delta-neu">—</td>';
  const d    = curr - prev;
  const good = lb ? d <= 0 : d >= 0;
  return `<td class="${good ? 'delta-pos' : 'delta-neg'}">${d >= 0 ? "+" : ""}${fmt(d, 0)}</td>`;
}

function buildFinTable(rows, years, { showDelta = false, showYoY = true, showCagr = false } = {}) {
  if (!years.length) return '<p class="empty-state">No data available.</p>';
  const extra = +showDelta + +showYoY + +showCagr;
  const total = 1 + years.length + extra;

  let h = '<div class="fin-table-wrap"><table class="fin-table"><thead><tr>';
  h += `<th>${_currencyUnit}</th>`;
  years.forEach(y => { h += `<th>${y}</th>`; });
  if (showDelta) h += `<th>Δ ${_currencyUnit}</th>`;
  if (showYoY)   h += '<th>YoY %</th>';
  if (showCagr)  h += '<th>5Y CAGR</th>';
  h += '</tr></thead><tbody>';

  for (const row of rows) {
    if (row.type === 'section') {
      h += `<tr class="fin-section-header"><td colspan="${total}">${row.label}</td></tr>`;
      continue;
    }
    const cls  = row.type === 'major' ? 'fin-major'
               : row.type === 'total' ? 'fin-total' : 'fin-sub';
    const lb   = !!row.lowerIsBetter;
    const vals = row.vals || Array(years.length).fill(null);
    const last = vals[vals.length - 1];
    const prev = vals.length > 1 ? vals[vals.length - 2] : null;
    const first= vals[0];

    h += `<tr class="${cls}"><td>${row.label}</td>`;
    vals.forEach(v => { h += `<td>${fmtE(v)}</td>`; });
    if (showDelta) h += deltaAbsCell(last, prev, lb);
    if (showYoY)   h += deltaYoYCell(last, prev, lb);
    if (showCagr) {
      const cv = cagrPct(last, first, years.length - 1);
      if (cv != null) {
        const good = lb ? cv <= 0 : cv >= 0;
        h += `<td class="cagr-col ${good ? 'delta-pos' : 'delta-neg'}">${cv >= 0 ? "+" : ""}${fmt(cv, 1)}%</td>`;
      } else h += '<td class="delta-neu">—</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  return h;
}

function ratioSection(title, rows) {
  let h = `<div class="ratio-section"><div class="ratio-section-title">${title}</div>`;
  h += '<table class="ratio-table"><tbody>';
  for (const [label, value, fmtFn, tr] of rows) {
    const fmted = value != null ? (fmtFn ? fmtFn(value) : String(value)) : "—";
    const arrow = tr || { sym: "►", cls: "trend-flat" };
    h += `<tr><td class="ratio-label">${label}</td>`;
    h += `<td class="ratio-val">${fmted}</td>`;
    h += `<td class="ratio-trend"><span class="${arrow.cls}">${arrow.sym}</span></td></tr>`;
  }
  h += '</tbody></table></div>';
  return h;
}

// ════════════════════════════════════════════════════════
//  RENDER DASHBOARD
// ════════════════════════════════════════════════════════
function renderDashboard(d) {
  _currencyUnit = d.currency_unit || "SEKm";

  renderDeskHero(d);
  renderMetricPills(d);
  renderSummary(d);
  renderIncomeStatement(d);
  renderBalanceSheet(d);
  renderCashFlow(d);
  renderRatiosAndKeyFigures(d);
  renderYoY(d);
  renderQoQ(d);
  renderSourceChips(d);

  const updatedStr = "Last updated: " + (d.last_updated || "—");
  document.getElementById("last-updated").textContent = updatedStr;
  const utilDate = document.getElementById("util-date-display");
  if (utilDate) utilDate.textContent = updatedStr;
}

// ── DESK HERO ─────────────────────────────────────────
function renderDeskHero(d) {
  const co = d.company || {};
  const displayName = co.name || _currentCompany || "—";
  document.getElementById("company-name").textContent = displayName;

  // Subtitle: N reports · YYYY–YYYY from profit_loss years
  const pl = (d.profit_loss || []).map(r => r.year).filter(Boolean).sort((a, b) => a - b);
  let meta = "";
  if (pl.length) {
    meta = pl.length + " report" + (pl.length !== 1 ? "s" : "");
    if (pl.length > 1) meta += " · " + pl[0] + "–" + pl[pl.length - 1];
    else meta += " · " + pl[0];
  }
  document.getElementById("company-meta").textContent = meta || "—";

  // Keep dropdown in sync
  const sel = document.getElementById("desk-company-select");
  if (sel && _currentCompany) sel.value = _currentCompany;
}

// ── METRIC PILLS (4 cards: Total Income, Net Income, ROE, CET1) ──────────
function renderMetricPills(d) {
  const pl  = (d.profit_loss  || []).sort((a, b) => b.year - a.year);
  const kf  = (d.key_figures  || []).sort((a, b) => b.year - a.year);
  const rat = d.ratios || {};
  const pl0 = pl[0] || {};
  const pl1 = pl[1] || {};
  const kf0 = kf[0] || {};
  const kf1 = kf[1] || {};

  const roe0  = kf0.roe_pct  ?? rat.roe  ?? null;
  const roe1  = kf1.roe_pct  ?? null;
  const cet0  = kf0.cet1_ratio_pct ?? null;
  const cet1  = kf1.cet1_ratio_pct ?? null;

  const metrics = [
    {
      label: "Total Income",
      value: fmtE(pl0.revenue),
      unit: _currencyUnit,
      delta: yoyPct(pl0.revenue, pl1.revenue),
    },
    {
      label: "Net Income",
      value: fmtE(pl0.net_income),
      unit: _currencyUnit,
      delta: yoyPct(pl0.net_income, pl1.net_income),
    },
    {
      label: "Return on Equity",
      value: roe0 != null ? fmt(roe0, 1) + "%" : "—",
      delta: yoyPct(roe0, roe1),
    },
    {
      label: "CET1 Capital",
      value: cet0 != null ? fmt(cet0, 1) + "%" : "—",
      delta: yoyPct(cet0, cet1),
    },
  ];

  const wrap = document.getElementById("metric-pills");
  wrap.innerHTML = metrics.map(m => {
    const yoyHtml = m.delta != null
      ? `<div class="mpill-yoy ${m.delta >= 0 ? 'pos' : 'neg'}">${m.delta >= 0 ? "+" : ""}${fmt(m.delta, 1)}% YoY</div>`
      : "";
    const unitHtml = m.unit
      ? ` <span style="font-size:11px;font-weight:300;color:var(--text3)">${m.unit}</span>`
      : "";
    return `
      <div class="mpill">
        <div class="pill-label">${m.label}</div>
        <div class="pill-value">${m.value}${unitHtml}</div>
        ${yoyHtml}
      </div>`;
  }).join("");
}

// ── SOURCE CHIPS ──────────────────────────────────────
function renderSourceChips(d) {
  const src         = d.data_sources || {};
  const companyName = _currentCompany || "";
  const storedFile  = sessionStorage.getItem("pdf_filename_" + companyName);
  const finLabel    = storedFile || src.financials || "Company Annual Reports (PDF)";
  const qLabel      = storedFile || src.quarters   || "Company Quarterly Reports (PDF)";

  const map = {
    "income-source-chip":   { icon: "📄", text: finLabel },
    "bs-source-chip":       { icon: "📄", text: finLabel },
    "cf-source-chip":       { icon: "📄", text: finLabel },
    "qoq-source-chip":      { icon: "📄", text: qLabel },
  };
  Object.entries(map).forEach(([id, { icon, text }]) => {
    const chip = document.getElementById(id);
    if (!chip || !text) return;
    chip.innerHTML = `${icon} Source: <em>${text}</em>`;
  });
}

// ── SUMMARY TAB ───────────────────────────────────────
function renderSummary(d) {
  const co  = d.company || {};
  const rec = d.recommendation || {};
  const rat = d.ratios  || {};

  const pl0 = (d.profit_loss   || []).sort((a, b) => b.year - a.year)[0] || {};
  const bs0 = (d.balance_sheet || []).sort((a, b) => b.year - a.year)[0] || {};
  const kf0 = (d.key_figures   || []).sort((a, b) => b.year - a.year)[0] || {};
  const hlWrap = document.getElementById("summary-highlights");
  const ccy = _currencyUnit;
  const hlItems = [
    { label: "Net Interest Income", raw: pl0.nii,               fmt: v => fmtE(v) + " " + ccy },
    { label: "Total Income",        raw: pl0.revenue,           fmt: v => fmtE(v) + " " + ccy },
    { label: "Operating Profit",    raw: pl0.operating_profit,  fmt: v => fmtE(v) + " " + ccy },
    { label: "Net Profit",          raw: pl0.net_income,        fmt: v => fmtE(v) + " " + ccy },
    { label: "Total Assets",        raw: bs0.total_assets,      fmt: v => fmtE(v) + " " + ccy },
    { label: "Total Equity",        raw: bs0.equity,            fmt: v => fmtE(v) + " " + ccy },
    { label: "CET1 Ratio",          raw: kf0.cet1_ratio_pct,                     fmt: v => fmt(v, 1) + "%" },
    { label: "Cost / Income",       raw: kf0.cost_to_income_pct,                 fmt: v => fmt(v, 1) + "%" },
    { label: "ROE",                 raw: kf0.roe_pct           ?? rat.roe,       fmt: v => fmt(v, 1) + "%" },
    { label: "Diluted EPS",         raw: kf0.diluted_eps       ?? rat.eps,       fmt: v => fmt(v, 2) + " " + _baseCcy() },
    { label: "Dividend / Share",    raw: kf0.dividend_per_share ?? rat.dividend_per_share, fmt: v => fmt(v, 2) + " " + _baseCcy() },
    { label: "Dividend Yield",      raw: rat.dividend_yield,                     fmt: v => fmt(v, 2) + "%" },
    { label: "AuM",                 raw: kf0.aum_bn,                             fmt: v => fmt(v, 0) + " bn " + _baseCcy() },
  ].filter(x => x.raw != null);

  if (hlItems.length) {
    const yr = pl0.year || bs0.year || kf0.year || "";
    hlWrap.innerHTML = `
      <div class="fin-highlights">
        <div class="fin-hl-header">Key Highlights${yr ? " — " + yr : ""}</div>
        <div class="fin-hl-grid">
          ${hlItems.map(x => `
            <div class="fin-hl-item">
              <div class="fin-hl-label">${x.label}</div>
              <div class="fin-hl-value">${x.fmt(x.raw)}</div>
            </div>`).join("")}
        </div>
      </div>`;
  } else {
    hlWrap.innerHTML = "";
  }

  const descEl = document.getElementById("company-desc");
  if (co.description) {
    descEl.textContent = co.description;
  } else if (d.analysis) {
    descEl.textContent = d.analysis;
  } else {
    descEl.closest(".two-col > div").querySelector("h3").style.display = "none";
    descEl.style.display = "none";
  }

  const ig = document.getElementById("company-info-grid");
  ig.innerHTML = "";
  const rows = [
    ["Country",   co.country],
    ["Employees", co.employees ? Number(co.employees).toLocaleString("sv-SE") : null],
    ["Website",   co.website ? `<a href="${co.website}" target="_blank" rel="noopener" style="color:var(--accent)">${co.website}</a>` : null],
    ["Exchange",  co.exchange],
  ];
  rows.forEach(([l, v]) => {
    if (!v) return;
    const item = el("div", "info-item");
    item.innerHTML = `<div class="info-label">${l}</div><div class="info-val">${v}</div>`;
    ig.appendChild(item);
  });

  const rating = (rec.rating || "Hold").toLowerCase();
  const rc = document.getElementById("rec-card");
  rc.className = "rec-card " + rating;
  rc.innerHTML = `
    <div class="rec-rating ${rating}">${rec.rating || "Hold"}</div>
    <div class="rec-text">${rec.rationale || "—"}</div>
  `;

  const rl = document.getElementById("risks-list");
  rl.innerHTML = "";
  (d.risks || []).forEach(r => {
    const li = document.createElement("li");
    li.textContent = r;
    rl.appendChild(li);
  });
  if (!d.risks || d.risks.length === 0)
    rl.innerHTML = '<li style="color:var(--text3)">None identified.</li>';

  const ol = document.getElementById("opps-list");
  ol.innerHTML = "";
  (d.opportunities || []).forEach(o => {
    const li = document.createElement("li");
    li.textContent = o;
    ol.appendChild(li);
  });
  if (!d.opportunities || d.opportunities.length === 0)
    ol.innerHTML = '<li style="color:var(--text3)">None identified.</li>';
}

// ── INCOME STATEMENT TAB ─────────────────────────────
function renderIncomeStatement(d) {
  const pl   = (d.profit_loss || []).sort((a, b) => a.year - b.year).slice(-5);
  const wrap = document.getElementById("income-table-wrap");
  if (!pl.length) { wrap.innerHTML = '<p class="empty-state">No income statement data available.</p>'; return; }

  const years = pl.map(r => r.year);
  const g = key => pl.map(r => toE(r[key] ?? null));

  const rows = [
    { type: 'section', label: 'INCOME' },
    { type: 'sub',   label: 'Net interest income',              vals: g('nii') },
    { type: 'sub',   label: 'Net fee & commission income',      vals: g('fee_income') },
    { type: 'sub',   label: 'Net insurance result',             vals: g('insurance_result') },
    { type: 'sub',   label: 'Fair value result',                vals: g('fair_value') },
    { type: 'sub',   label: 'Other income',                     vals: g('other_income') },
    { type: 'total', label: 'Total Operating Income',           vals: g('revenue') },

    { type: 'section', label: 'EXPENSES' },
    { type: 'sub',   label: 'Staff costs',                      vals: g('staff_costs'),               lowerIsBetter: true },
    { type: 'sub',   label: 'Other expenses',                   vals: g('other_expenses'),            lowerIsBetter: true },
    { type: 'sub',   label: 'Regulatory fees',                  vals: g('reg_fees'),                  lowerIsBetter: true },
    { type: 'sub',   label: 'Depreciation & Amortisation',      vals: g('da'),                        lowerIsBetter: true },
    { type: 'total', label: 'Total Expenses',                   vals: g('total_expenses'),            lowerIsBetter: true },

    { type: 'major', label: 'Profit Before Loan Losses',        vals: g('profit_before_loan_losses') },
    { type: 'sub',   label: 'Net result items at fair value',   vals: g('net_result_loans_fv') },
    { type: 'sub',   label: 'Net loan losses',                  vals: g('net_loan_losses'),           lowerIsBetter: true },
    { type: 'major', label: 'Operating Profit',                 vals: g('operating_profit') },
    { type: 'sub',   label: 'Income tax',                       vals: g('income_tax'),                lowerIsBetter: true },
    { type: 'major', label: 'Net Profit',                       vals: g('net_income') },
  ];

  wrap.innerHTML = buildFinTable(rows, years, { showYoY: true, showCagr: true });
}

// ── BALANCE SHEET TAB ────────────────────────────────
function renderBalanceSheet(d) {
  const bs   = (d.balance_sheet || []).sort((a, b) => a.year - b.year).slice(-5);
  const wrap = document.getElementById("bs-table-wrap");
  if (!bs.length) { wrap.innerHTML = '<p class="empty-state">No balance sheet data available.</p>'; return; }

  const years = bs.map(r => r.year);
  const g = key => bs.map(r => toE(r[key] ?? null));

  const rows = [
    { type: 'section', label: 'ASSETS' },
    { type: 'sub',   label: 'Cash & balances with central banks',  vals: g('cash_central_banks') },
    { type: 'sub',   label: 'Loans to credit institutions',        vals: g('loans_credit_institutions') },
    { type: 'sub',   label: 'Loans to the public',                 vals: g('loans_public') },
    { type: 'sub',   label: 'Securities',                          vals: g('securities') },
    { type: 'sub',   label: 'Pooled unit-linked assets',           vals: g('pooled_unit_linked') },
    { type: 'sub',   label: 'Derivatives',                         vals: g('derivatives_assets') },
    { type: 'sub',   label: 'Other assets',                        vals: g('other_assets') },
    { type: 'total', label: 'Total Assets',                        vals: g('total_assets') },

    { type: 'section', label: 'LIABILITIES' },
    { type: 'sub',   label: 'Deposits from credit institutions',   vals: g('deposits_credit_institutions'), lowerIsBetter: true },
    { type: 'sub',   label: 'Deposits from the public',            vals: g('deposits_public'),              lowerIsBetter: true },
    { type: 'sub',   label: 'Deposits pooled (unit-linked)',       vals: g('deposits_pooled'),              lowerIsBetter: true },
    { type: 'sub',   label: 'Insurance liabilities',               vals: g('insurance_liabilities'),        lowerIsBetter: true },
    { type: 'sub',   label: 'Debt securities issued',              vals: g('debt_securities'),              lowerIsBetter: true },
    { type: 'sub',   label: 'Derivatives',                         vals: g('derivatives_liabilities'),      lowerIsBetter: true },
    { type: 'sub',   label: 'Subordinated liabilities',            vals: g('subordinated_liabilities'),     lowerIsBetter: true },
    { type: 'sub',   label: 'Other liabilities',                   vals: g('other_liabilities'),            lowerIsBetter: true },
    { type: 'total', label: 'Total Liabilities',                   vals: g('total_liabilities'),            lowerIsBetter: true },

    { type: 'section', label: 'EQUITY' },
    { type: 'major', label: 'Total Equity',                        vals: g('equity') },
    { type: 'total', label: 'Total Liabilities & Equity',          vals: g('total_liabilities_equity') },
  ];

  wrap.innerHTML = buildFinTable(rows, years, { showYoY: true });
}

// ── CASH FLOW TAB ─────────────────────────────────────
function renderCashFlow(d) {
  const cf   = (d.cash_flow || []).sort((a, b) => a.year - b.year).slice(-5);
  const wrap = document.getElementById("cf-table-wrap");
  if (!cf.length) { wrap.innerHTML = '<p class="empty-state">No cash flow data available.</p>'; return; }

  const years = cf.map(r => r.year);
  const g = key => cf.map(r => toE(r[key] ?? null));

  const rows = [
    { type: 'section', label: 'OPERATING ACTIVITIES' },
    { type: 'sub',   label: 'Operating profit',               vals: g('operating_profit_cf') },
    { type: 'sub',   label: 'Non-cash adjustments',           vals: g('non_cash_adjustments') },
    { type: 'sub',   label: 'Income taxes paid',              vals: g('income_taxes_paid'),     lowerIsBetter: true },
    { type: 'total', label: 'Cash flow before changes',       vals: g('cf_before_changes') },
    { type: 'sub',   label: 'Change in loans to public',      vals: g('change_loans_public') },
    { type: 'sub',   label: 'Change in deposits from public', vals: g('change_deposits_public') },

    { type: 'section', label: 'INVESTING ACTIVITIES' },
    { type: 'sub',   label: 'CapEx — Property & equipment',  vals: g('capex_ppe'),             lowerIsBetter: true },
    { type: 'sub',   label: 'CapEx — Intangibles',           vals: g('capex_intangibles'),     lowerIsBetter: true },

    { type: 'section', label: 'FINANCING ACTIVITIES' },
    { type: 'sub',   label: 'Dividends paid',                vals: g('dividend_paid'),         lowerIsBetter: true },
    { type: 'sub',   label: 'Share repurchases',             vals: g('share_repurchase'),      lowerIsBetter: true },
    { type: 'sub',   label: 'Issued subordinated debt',      vals: g('issued_subordinated') },

    { type: 'major', label: 'Net Cash Flow',                 vals: g('net_cash_flow') },
  ];

  wrap.innerHTML = buildFinTable(rows, years, { showYoY: true });
}

// ── RATIOS & KEY FIGURES TAB ──────────────────────────
function renderRatiosAndKeyFigures(d) {
  const kf  = (d.key_figures || []).sort((a, b) => a.year - b.year).slice(-5);
  const wrap = document.getElementById("ratios-wrap");
  wrap.innerHTML = "";

  if (!kf.length) {
    wrap.innerHTML = '<p class="empty-state">No key figures data available.</p>';
    return;
  }

  const years = kf.map(r => r.year);

  const buildKfTable = (title, fieldRows) => {
    const hasData = fieldRows.some(r => kf.some(row => row[r.key] != null));
    if (!hasData) return "";
    let h = `<div class="kf-section"><div class="kf-section-title">${title}</div>`;
    h += '<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th></th>';
    years.forEach(y => { h += `<th>${y}</th>`; });
    h += '</tr></thead><tbody>';
    for (const r of fieldRows) {
      if (!kf.some(row => row[r.key] != null)) continue;
      h += `<tr class="fin-sub"><td>${r.label}</td>`;
      kf.forEach(row => {
        const v = row[r.key];
        h += `<td>${v != null ? r.fmt(v) : "—"}</td>`;
      });
      h += '</tr>';
    }
    h += '</tbody></table></div></div>';
    return h;
  };

  wrap.innerHTML =
    buildKfTable("Per Share Data", [
      { label: "Basic EPS",            key: "basic_eps",            fmt: v => fmt(v, 2) + " " + _baseCcy() },
      { label: "Diluted EPS",          key: "diluted_eps",          fmt: v => fmt(v, 2) + " " + _baseCcy() },
      { label: "Dividend per share",   key: "dividend_per_share",   fmt: v => fmt(v, 2) + " " + _baseCcy() },
      { label: "Equity per share",     key: "equity_per_share",     fmt: v => fmt(v, 2) + " " + _baseCcy() },
      { label: "Share price",          key: "share_price",          fmt: v => fmt(v, 2) + " " + _baseCcy() },
      { label: "Shares outstanding",   key: "shares_outstanding_m", fmt: v => fmt(v, 0) + " m" },
    ]) +
    buildKfTable("Performance", [
      { label: "Return on Equity (ROE)",    key: "roe_pct",                fmt: v => fmt(v, 1) + "%" },
      { label: "Cost / Income",             key: "cost_to_income_pct",     fmt: v => fmt(v, 1) + "%" },
      { label: "Net loan loss ratio",       key: "net_loan_loss_ratio_pct",fmt: v => fmt(v, 2) + "%" },
      { label: "Assets under Management",  key: "aum_bn",                 fmt: v => fmt(v, 0) + " bn " + _baseCcy() },
    ]) +
    buildKfTable("Capital Adequacy", [
      { label: "CET1 Ratio",            key: "cet1_ratio_pct",         fmt: v => fmt(v, 1) + "%" },
      { label: "Tier 1 Ratio",          key: "tier1_ratio_pct",        fmt: v => fmt(v, 1) + "%" },
      { label: "Total Capital Ratio",   key: "total_capital_ratio_pct",fmt: v => fmt(v, 1) + "%" },
      { label: "Tier 1 Capital",        key: "tier1_capital",          fmt: v => fmtE(v) + " " + _currencyUnit },
      { label: "Risk-weighted Assets",  key: "rea",                    fmt: v => fmtE(v) + " " + _currencyUnit },
      { label: "Employees",             key: "employees",              fmt: v => Number(v).toLocaleString("sv-SE") },
    ]);
}

// ── YOY ANALYSIS TAB ─────────────────────────────────
function renderYoY(d) {
  const pl  = (d.profit_loss   || []).sort((a, b) => a.year - b.year);
  const bs  = (d.balance_sheet || []).sort((a, b) => a.year - b.year);
  const kf  = (d.key_figures   || []).sort((a, b) => a.year - b.year);
  const wrap = document.getElementById("yoy-table-wrap");

  const allYears = [...new Set([
    ...pl.map(r => r.year),
    ...bs.map(r => r.year),
    ...kf.map(r => r.year),
  ])].sort((a, b) => a - b).slice(-6);

  if (allYears.length < 2) {
    wrap.innerHTML = '<p class="empty-state">Need at least 2 years of data for YoY analysis.</p>';
    return;
  }

  const plMap = Object.fromEntries(pl.map(r => [r.year, r]));
  const bsMap = Object.fromEntries(bs.map(r => [r.year, r]));
  const kfMap = Object.fromEntries(kf.map(r => [r.year, r]));

  const nDelta = allYears.length - 1;
  const colSpan = 1 + allYears.length + nDelta;

  let h = `<div class="fin-table-wrap"><table class="fin-table yoy-table"><thead><tr><th>${_currencyUnit}</th>`;
  allYears.forEach((y, i) => {
    h += `<th>${y}</th>`;
    if (i < nDelta) h += '<th class="fin-delta-hdr">Δ%</th>';
  });
  h += '</tr></thead><tbody>';

  const addSection = label => {
    h += `<tr class="fin-section-header"><td colspan="${colSpan}">${label}</td></tr>`;
  };

  const addRow = (label, getVal, rowType = 'fin-sub', lb = false) => {
    const vals = allYears.map(y => getVal(y));
    if (vals.every(v => v == null)) return;
    h += `<tr class="${rowType}"><td>${label}</td>`;
    vals.forEach((v, i) => {
      h += `<td>${fmtE(v)}</td>`;
      if (i < nDelta) h += deltaYoYCell(vals[i + 1], v, lb);
    });
    h += '</tr>';
  };

  const addRatioRow = (label, getVal, fmtFn, lb = false) => {
    const vals = allYears.map(y => getVal(y));
    if (vals.every(v => v == null)) return;
    h += `<tr class="fin-sub"><td>${label}</td>`;
    vals.forEach((v, i) => {
      h += `<td>${v != null ? fmtFn(v) : "—"}</td>`;
      if (i < nDelta) h += deltaYoYCell(vals[i + 1], v, lb);
    });
    h += '</tr>';
  };

  addSection('INCOME STATEMENT');
  addRow('Total Operating Income',      y => toE((plMap[y] || {}).revenue),                  'fin-total');
  addRow('Total Expenses',              y => toE((plMap[y] || {}).total_expenses),            'fin-sub', true);
  addRow('Profit Before Loan Losses',   y => toE((plMap[y] || {}).profit_before_loan_losses), 'fin-sub');
  addRow('Net Loan Losses',             y => toE((plMap[y] || {}).net_loan_losses),           'fin-sub', true);
  addRow('Operating Profit',            y => toE((plMap[y] || {}).operating_profit),          'fin-major');
  addRow('Net Profit',                  y => toE((plMap[y] || {}).net_income),                'fin-major');

  addSection('BALANCE SHEET');
  addRow('Total Assets',                y => toE((bsMap[y] || {}).total_assets),              'fin-total');
  addRow('Loans to the public',         y => toE((bsMap[y] || {}).loans_public));
  addRow('Deposits from the public',    y => toE((bsMap[y] || {}).deposits_public),           'fin-sub', true);
  addRow('Total Liabilities',           y => toE((bsMap[y] || {}).total_liabilities),         'fin-total', true);
  addRow('Total Equity',                y => toE((bsMap[y] || {}).equity),                    'fin-major');

  addSection('KEY RATIOS');
  addRatioRow('CET1 Ratio',      y => (kfMap[y] || {}).cet1_ratio_pct,         v => fmt(v, 1) + "%");
  addRatioRow('ROE',             y => (kfMap[y] || {}).roe_pct,                v => fmt(v, 1) + "%");
  addRatioRow('Cost / Income',   y => (kfMap[y] || {}).cost_to_income_pct,     v => fmt(v, 1) + "%", true);
  addRatioRow('Net Loan Loss %', y => (kfMap[y] || {}).net_loan_loss_ratio_pct,v => fmt(v, 2) + "%", true);
  addRatioRow('Diluted EPS',     y => (kfMap[y] || {}).diluted_eps,            v => fmt(v, 2) + " " + _baseCcy());
  addRatioRow('Dividend/Share',  y => (kfMap[y] || {}).dividend_per_share,     v => fmt(v, 2) + " " + _baseCcy());

  h += '</tbody></table></div>';
  wrap.innerHTML = h;
}

// ── QOQ ANALYSIS TAB ─────────────────────────────────
function renderQoQ(d) {
  const quarters = (d.quarters || []).slice().reverse().slice(-5);
  const wrap     = document.getElementById("qoq-table-wrap");

  if (quarters.length < 2) {
    wrap.innerHTML = '<p class="empty-state">Need at least 2 quarters of data for QoQ analysis.</p>';
    return;
  }

  const metrics = [
    { label: "Revenue",      key: "revenue" },
    { label: "Gross Profit", key: "gross_profit" },
    { label: "Net Profit",   key: "net_income" },
  ];

  let h = `<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>${_currencyUnit}</th>`;
  quarters.forEach((q, i) => {
    h += `<th>${q.period}</th>`;
    if (i < quarters.length - 1) h += '<th>QoQ %</th>';
  });
  h += '</tr></thead><tbody>';

  for (const m of metrics) {
    const vals = quarters.map(q => toE(q[m.key] ?? null));
    h += `<tr class="fin-sub"><td>${m.label}</td>`;
    vals.forEach((v, i) => {
      h += `<td>${fmtE(v)}</td>`;
      if (i < vals.length - 1) h += deltaYoYCell(vals[i + 1], v);
    });
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  wrap.innerHTML = h;
}

// ════════════════════════════════════════════════════════
//  UPLOAD & REPORTS VIEW
// ════════════════════════════════════════════════════════

function _formatPeriod(period) {
  return (period || "").replace(/_/g, " ").replace(/\b(\w)/g, c => c.toUpperCase());
}

function populateUploadDropdown(companies) {
  const sel = document.getElementById("up-company-select");
  const names = [...new Set((companies || []).map(c => c.company_name))].sort();
  sel.innerHTML =
    '<option value="" disabled selected>Select company…</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("") +
    '<option value="__new__">+ Add new company…</option>';
}

function onUpCompanyChange(val) {
  const inp = document.getElementById("up-new-company");
  if (val === "__new__") {
    inp.classList.remove("hidden");
    inp.focus();
  } else {
    inp.classList.add("hidden");
  }
}

async function renderUploadView() {
  const cardsEl = document.getElementById("company-cards");
  try {
    const data = await _fetchCompanies();
    populateUploadDropdown(data.companies || []);
    renderCompanyCards(data.companies || []);
  } catch (err) {
    cardsEl.innerHTML = '<p class="empty-state">Could not load companies — ' + esc(err.message) + '</p>';
  }
}

function renderCompanyCards(companies) {
  const wrap = document.getElementById("company-cards");
  if (!companies || !companies.length) {
    wrap.innerHTML = '<p class="empty-state">No companies yet. Upload a PDF to get started.</p>';
    return;
  }
  wrap.innerHTML = companies.map(_renderCompanyCard).join("");
}

function _renderCompanyCard(c) {
  const analysed   = !!c.analysed;
  const reports    = c.reports || [];
  const lastDate   = c.last_updated ? c.last_updated.slice(0, 10) : "";
  const cnt        = reports.length;
  const meta       = cnt + " report" + (cnt !== 1 ? "s" : "") + (lastDate ? " · " + lastDate : "");

  const badge = analysed
    ? '<span class="co-badge analysed">Analysed</span>'
    : '<span class="co-badge pending">Not analysed</span>';

  const btnLabel = analysed ? "Re-Analyse" : "Analyse";

  const reportRows = reports.map(r => `
    <tr>
      <td>${esc(_formatPeriod(r.period))}</td>
      <td>${esc(r.report_type ? r.report_type.charAt(0).toUpperCase() + r.report_type.slice(1) : "—")}</td>
      <td>${esc(r.filename || "—")}</td>
      <td>${esc((r.uploaded_at || "").slice(0, 10) || "—")}</td>
      <td class="report-actions">
        <button class="report-action-btn report-btn-delete"
          data-company="${esc(c.company_name)}"
          data-period="${esc(r.period)}"
          data-report-type="${esc(r.report_type)}">Remove</button>
      </td>
    </tr>`).join("");

  const tableHtml = cnt > 0
    ? `<table class="reports-table">
        <thead><tr><th>Period</th><th>Type</th><th>Filename</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${reportRows}</tbody>
       </table>`
    : '<p class="empty-state" style="margin:0">No PDFs uploaded yet.</p>';

  return `
    <div class="co-card ${analysed ? "analysed" : "pending"}" data-company="${esc(c.company_name)}">
      <div class="co-card-header">
        <span class="co-card-name">${esc(c.company_name)}</span>
        <div class="co-card-right">
          ${badge}
          <span class="co-card-meta">${esc(meta)}</span>
          <span class="co-card-chevron">▶</span>
        </div>
      </div>
      <div class="co-card-body hidden">
        <div class="co-card-actions">
          <button class="btn-analyse">${esc(btnLabel)}</button>
          <span class="co-analyse-status"></span>
        </div>
        ${tableHtml}
      </div>
    </div>`;
}

// Event delegation for company cards
document.getElementById("company-cards").addEventListener("click", async e => {
  // Toggle card header
  const header = e.target.closest(".co-card-header");
  if (header) {
    const body    = header.closest(".co-card").querySelector(".co-card-body");
    const chevron = header.querySelector(".co-card-chevron");
    body.classList.toggle("hidden");
    chevron.textContent = body.classList.contains("hidden") ? "▶" : "▼";
    return;
  }

  // Analyse / Re-Analyse button
  const analyseBtn = e.target.closest(".btn-analyse");
  if (analyseBtn) {
    const card        = analyseBtn.closest(".co-card");
    const companyName = card.dataset.company;
    await _doAnalyse(companyName, analyseBtn, card);
    return;
  }

  // Remove report button
  const deleteBtn = e.target.closest(".report-btn-delete");
  if (deleteBtn) {
    const { company, period, reportType } = deleteBtn.dataset;
    await _doDeleteReport(company, period, reportType, deleteBtn);
    return;
  }
});

async function _doAnalyse(companyName, btn, card) {
  const statusEl   = card.querySelector(".co-analyse-status");
  const origText   = btn.textContent;
  btn.disabled     = true;
  btn.textContent  = "Analysing…";
  statusEl.textContent = "";
  statusEl.className   = "co-analyse-status";

  try {
    const resp = await fetch("/api/analyse", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ company_name: companyName }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      statusEl.textContent = err.error || "Analysis failed";
      statusEl.className = "co-analyse-status error";
      btn.disabled = false;
      btn.textContent = origText;
      return;
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); }
        catch { continue; }

        if (evt.type === "progress") {
          btn.textContent = `Analysing… ${evt.step}/${evt.total}`;
          statusEl.textContent = evt.message;

        } else if (evt.type === "done") {
          // Refresh cards and dropdowns
          _companiesCache = null;
          const data = await _fetchCompanies();
          populateUploadDropdown(data.companies || []);
          renderCompanyCards(data.companies || []);
          populateDeskDropdown(data.companies || []);
          return;

        } else if (evt.type === "error") {
          statusEl.textContent = evt.message || "Analysis failed";
          statusEl.className = "co-analyse-status error";
          btn.disabled = false;
          btn.textContent = origText;
          return;
        }
      }
    }
  } catch (err) {
    statusEl.textContent = "Network error: " + err.message;
    statusEl.className = "co-analyse-status error";
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function _doDeleteReport(companyName, period, reportType, btn) {
  const periodLabel = _formatPeriod(period);
  const confirmed   = confirm(
    `Remove ${periodLabel} ${reportType} for ${companyName}?\nThis cannot be undone.`
  );
  if (!confirmed) return;

  const row    = btn.closest("tr");
  btn.disabled = true;
  btn.textContent = "Removing…";

  try {
    const resp = await fetch("/api/delete_report", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ company_name: companyName, period, report_type: reportType }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      alert(data.error || "Failed to remove report");
      btn.disabled = false;
      btn.textContent = "Remove";
      return;
    }
    // Remove row, refresh lists
    if (row) row.remove();
    _companiesCache = null;
    const freshData = await _fetchCompanies();
    populateUploadDropdown(freshData.companies || []);
    renderCompanyCards(freshData.companies || []);
  } catch (err) {
    alert("Network error: " + err.message);
    btn.disabled = false;
    btn.textContent = "Remove";
  }
}

// ════════════════════════════════════════════════════════
//  PDF UPLOAD (inline form in view-upload)
// ════════════════════════════════════════════════════════

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf   = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const total = pdf.numPages;
  const MAX_PAGES = 400;

  const coverEnd  = Math.min(30, total);
  const bodyStart = Math.max(coverEnd + 1, Math.floor(total * 0.40));
  const bodyEnd   = Math.min(total, bodyStart + (MAX_PAGES - coverEnd));

  const pageNums = [];
  for (let i = 1; i <= coverEnd; i++) pageNums.push(i);
  for (let i = bodyStart; i <= bodyEnd; i++) pageNums.push(i);

  const parts = [];
  for (const i of pageNums) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text    = content.items.map(item => item.str).join(" ");
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n\n");
}

let _uploadFile = null;

document.getElementById("up-file-input").addEventListener("change", e => {
  _uploadFile = e.target.files[0] || null;
  document.getElementById("up-file-name-label").textContent = _uploadFile ? _uploadFile.name : "";
  e.target.value = "";
});

async function submitUpload() {
  const sel        = document.getElementById("up-company-select");
  const newInp     = document.getElementById("up-new-company");
  const companyName = sel.value === "__new__"
    ? newInp.value.trim()
    : sel.value;

  const year       = document.getElementById("up-year").value;
  const periodType = document.getElementById("up-period-type").value;
  const period     = periodType === "Annual" ? year : `${periodType} ${year}`;
  const reportType = periodType === "Annual" ? "annual" : "quarterly";

  const errorEl    = document.getElementById("up-error");
  const successEl  = document.getElementById("up-success");
  const submitBtn  = document.getElementById("up-submit-btn");
  const progressEl = document.getElementById("up-progress");
  const progText   = document.getElementById("up-progress-text");
  const progFill   = document.getElementById("up-progress-fill");

  errorEl.classList.add("hidden");
  successEl.classList.add("hidden");

  if (!companyName) { _showUploadError("Company name is required."); return; }
  if (!_uploadFile) { _showUploadError("Please choose a PDF file."); return; }

  submitBtn.disabled = true;
  progFill.style.width = "0%";
  progressEl.classList.remove("hidden");

  progText.textContent = "Extracting text from PDF…";
  progFill.style.width = "30%";

  let pdfText;
  try {
    pdfText = await extractPdfText(_uploadFile);
  } catch (err) {
    _showUploadError("Could not read PDF — is it scanned/image-only?");
    submitBtn.disabled = false;
    progressEl.classList.add("hidden");
    return;
  }

  if (!pdfText || pdfText.trim().length < 200) {
    _showUploadError("Extracted text too short — is this a scanned PDF?");
    submitBtn.disabled = false;
    progressEl.classList.add("hidden");
    return;
  }

  progText.textContent = "Uploading…";
  progFill.style.width = "70%";

  try {
    const res  = await fetch("/api/upload", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: companyName,
        report_type:  reportType,
        period,
        pdf_text:     pdfText,
        filename:     _uploadFile.name,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      _showUploadError(data.error || `Upload failed (${res.status})`);
      submitBtn.disabled = false;
      progressEl.classList.add("hidden");
      return;
    }

    // Store filename for source chips
    sessionStorage.setItem("pdf_filename_" + companyName, _uploadFile.name);

    progFill.style.width = "100%";
    progressEl.classList.add("hidden");
    successEl.textContent = "Report uploaded successfully.";
    successEl.classList.remove("hidden");

    _uploadFile = null;
    document.getElementById("up-file-name-label").textContent = "";

    // Refresh lists
    _companiesCache = null;
    const freshData = await _fetchCompanies();
    populateUploadDropdown(freshData.companies || []);
    renderCompanyCards(freshData.companies || []);
    populateDeskDropdown(freshData.companies || []);

    setTimeout(() => {
      successEl.classList.add("hidden");
      submitBtn.disabled = false;
    }, 3000);
  } catch (err) {
    _showUploadError("Network error: " + err.message);
    submitBtn.disabled = false;
    progressEl.classList.add("hidden");
  }
}

function _showUploadError(msg) {
  const el = document.getElementById("up-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ════════════════════════════════════════════════════════
//  FEEDBACK MODAL
// ════════════════════════════════════════════════════════

function openFeedback() {
  document.getElementById("feedback-overlay").classList.remove("hidden");
  document.getElementById("fb-message").focus();
}

function closeFeedback() {
  document.getElementById("feedback-overlay").classList.add("hidden");
}

function closeFeedbackOnOverlay(e) {
  if (e.target === document.getElementById("feedback-overlay")) closeFeedback();
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeFeedback();
});

document.getElementById("feedback-form").addEventListener("submit", async e => {
  e.preventDefault();
  const message = document.getElementById("fb-message").value.trim();
  if (!message) { document.getElementById("fb-message").focus(); return; }

  const submitBtn = document.getElementById("fb-submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending…";

  try {
    const payload = new FormData();
    payload.append("company", document.getElementById("fb-company").value.trim());
    payload.append("message", message);

    const res = await fetch("https://formspree.io/f/xlgarjwy", {
      method:  "POST",
      headers: { "Accept": "application/json" },
      body:    payload,
    });

    if (res.ok) {
      document.getElementById("feedback-form").classList.add("hidden");
      document.getElementById("fb-success").classList.remove("hidden");
      setTimeout(() => {
        closeFeedback();
        setTimeout(() => {
          document.getElementById("feedback-form").classList.remove("hidden");
          document.getElementById("fb-success").classList.add("hidden");
          document.getElementById("feedback-form").reset();
          submitBtn.disabled = false;
          submitBtn.textContent = "Send feedback";
        }, 300);
      }, 3000);
    } else {
      throw new Error("Server error " + res.status);
    }
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send feedback";
    alert("Couldn't send feedback — please try again.");
  }
});

// ════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════

initApp();
