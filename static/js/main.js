/* ═══════════════════════════════════════════════════════
   StockGPT for Siva — Dashboard JS (Phase 4)
   9-tab Screener UI with Chart.js
═══════════════════════════════════════════════════════ */

"use strict";

// ── Helpers ──────────────────────────────────────────
function fmt(v, decimals = 2, suffix = "") {
  if (v == null || v === "" || isNaN(v)) return "—";
  return Number(v).toLocaleString("sv-SE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + suffix;
}

function fmtM(v)   { return v == null ? "—" : fmt(v, 0) + " MSEK"; }
function fmtPct(v) { return v == null ? "—" : fmt(v, 2) + "%"; }
function fmtPE(v)  { return v == null ? "—" : fmt(v, 1) + "x"; }

// Market cap: show as BSEK (1 dp) for values ≥ 1 000 MSEK, else MSEK
function fmtCap(m) {
  if (m == null) return "—";
  if (m >= 1_000) return fmt(m / 1_000, 1) + " BSEK";
  return fmt(m, 0) + " MSEK";
}

function colClass(v) {
  if (v == null) return "";
  return v >= 0 ? "pos" : "neg";
}

function ratColor(label, v) {
  if (v == null) return "";
  // heuristics: green = good, red = risky
  const L = label.toLowerCase();
  if (L.includes("yield") || L.includes("roe") || L.includes("roa") ||
      L.includes("margin") || L.includes("cash flow")) return v > 0 ? "green" : "red";
  if (L.includes("debt") || L.includes("payout")) return v > 100 ? "red" : "";
  if (L.includes("p/e") || L.includes("p/b")) return v < 0 ? "red" : "accent";
  return "";
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function setTicker(ticker) {
  document.getElementById("ticker-input").value = ticker;
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

// Step-aware progress — shows "Step N of M" + animated fill bar
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

// ── Demo loader ──────────────────────────────────────
async function loadDemo() {
  const btn = document.getElementById("analyse-btn");
  btn.disabled = true;
  showStatus("Loading Nordea demo data…");
  document.getElementById("dashboard").classList.add("hidden");
  try {
    const resp = await fetch("/api/demo");
    const data = await resp.json();
    hideStatus();
    renderDashboard(data);
    document.getElementById("dashboard").classList.remove("hidden");
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.querySelector('.tab-btn[data-tab="summary"]').classList.add("active");
    document.getElementById("tab-summary").classList.add("active");
  } catch (err) {
    showStatus("Demo load failed: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Analyse button ────────────────────────────────────
document.getElementById("analyse-btn").addEventListener("click", runAnalysis);
document.getElementById("ticker-input").addEventListener("keydown", e => {
  if (e.key === "Enter") runAnalysis();
});

async function runAnalysis(nocache = false) {
  const ticker = document.getElementById("ticker-input").value.trim().toUpperCase();
  if (!ticker) return;

  const btn = document.getElementById("analyse-btn");
  btn.disabled = true;
  showStatus(`Starting analysis for ${ticker}…`);
  document.getElementById("dashboard").classList.add("hidden");

  try {
    const url  = nocache ? "/api/analyse?nocache=1" : "/api/analyse";
    const resp = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ticker }),
    });

    // Validation errors come back as plain JSON before streaming starts
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showStatus(err.error || "Analysis failed", true);
      return;
    }

    // Read the SSE stream chunk by chunk
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buf.split("\n\n");
      buf = parts.pop();   // keep any incomplete trailing chunk

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
  } finally {
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════════════
//  FINANCIAL TABLE HELPERS
// ════════════════════════════════════════════════════════

const EUR_SEK = 11.5;
function toE(msek) { return msek == null ? null : msek / EUR_SEK; }
function fmtE(v)   { return v == null ? "—" : fmt(v, 0); }

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

/**
 * Build a Nordic-bank-style financial statement table.
 * rows: [{type:'section'|'sub'|'total'|'major', label, vals:[], lowerIsBetter}]
 * years: [2020, 2021, ...]
 * opts: { showDelta, showYoY, showCagr }
 */
function buildFinTable(rows, years, { showDelta = false, showYoY = true, showCagr = false } = {}) {
  if (!years.length) return '<p class="empty-state">No data available.</p>';
  const extra = +showDelta + +showYoY + +showCagr;
  const total = 1 + years.length + extra;

  let h = '<div class="fin-table-wrap"><table class="fin-table"><thead><tr>';
  h += '<th>EURm</th>';
  years.forEach(y => { h += `<th>${y}</th>`; });
  if (showDelta) h += '<th>Δ EURm</th>';
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
  renderHero(d);
  renderMetricPills(d);
  renderSummary(d);
  renderIncomeStatement(d);
  renderBalanceSheet(d);
  renderCashFlow(d);
  renderRatiosAndKeyFigures(d);
  renderYoY(d);
  renderQoQ(d);
  renderAnalysis(d);
  renderSourceChips(d);
  document.getElementById("last-updated").textContent =
    "Last updated: " + (d.last_updated || "—");
}

// ── SOURCE CHIPS ──────────────────────────────────────
function renderSourceChips(d) {
  const src = d.data_sources || {};
  const map = {
    "income-source-chip":   { icon: "📄", text: src.financials },
    "bs-source-chip":       { icon: "📄", text: src.financials },
    "cf-source-chip":       { icon: "📄", text: src.financials },
    "qoq-source-chip":      { icon: "📄", text: src.quarters },
    "analysis-source-chip": { icon: "🤖", text: src.analysis },
  };
  Object.entries(map).forEach(([id, { icon, text }]) => {
    const chip = document.getElementById(id);
    if (!chip || !text) return;
    chip.innerHTML = `${icon} Source: <em>${text}</em>`;
  });
}

// ── HERO ──────────────────────────────────────────────
function renderHero(d) {
  const co  = d.company || {};
  const mkt = d.market  || {};
  const rec = d.recommendation || {};

  document.getElementById("company-name").textContent = co.name || d.ticker || "—";

  const meta = document.getElementById("company-meta");
  meta.innerHTML = "";
  [co.ticker, co.sector, co.industry, co.exchange].filter(Boolean).forEach((v, i) => {
    const s = document.createElement("span");
    s.textContent = v;
    if (i > 0) s.className = "dot";
    meta.appendChild(s);
  });

  const pb = document.getElementById("price-block");
  pb.innerHTML = `
    <div class="price-val">${fmt(mkt.price, 2)}<span class="price-cur">${mkt.currency || "SEK"}</span></div>
    <div class="price-sub">
      52-wk: ${fmt(mkt.week_52_low, 2)} – ${fmt(mkt.week_52_high, 2)}
    </div>
  `;

  const rating = (rec.rating || "Hold").toLowerCase();
  const rb = document.getElementById("rating-badge");
  rb.className = "rating-badge " + rating;
  rb.innerHTML = `<div>${rec.rating || "Hold"}</div><div style="font-size:0.65rem;opacity:0.7;margin-top:2px">Rating</div>`;

  // Traffic light — illuminate the correct dot
  ["sell", "hold", "buy"].forEach(r => {
    const dot = document.getElementById("tl-" + r);
    if (dot) dot.classList.toggle("active", r === rating);
  });
}

// ── METRIC PILLS ─────────────────────────────────────
function renderMetricPills(d) {
  const mkt = d.market  || {};
  const rat = d.ratios  || {};
  // Only show metrics sourced from PDF parsing (no Finnhub paid data)
  const pills = [
    { label: "Dividend Yield", value: fmtPct(rat.dividend_yield), cls: rat.dividend_yield > 0 ? "green" : "" },
    { label: "ROE",            value: fmtPct(rat.roe), cls: rat.roe > 10 ? "green" : rat.roe < 0 ? "red" : "" },
    { label: "EPS",            value: rat.eps != null ? fmt(rat.eps, 2) + " SEK" : "—" },
  ];

  const wrap = document.getElementById("metric-pills");
  wrap.innerHTML = "";
  pills.forEach(p => {
    const div = el("div", "mpill");
    div.innerHTML = `
      <div class="pill-label">${p.label}</div>
      <div class="pill-value ${p.cls || ""}">${p.value}</div>
    `;
    wrap.appendChild(div);
  });
}

// ── SUMMARY TAB ───────────────────────────────────────
function renderSummary(d) {
  const co  = d.company || {};
  const rec = d.recommendation || {};

  // Financial highlights strip
  const pl0 = (d.profit_loss   || []).sort((a, b) => b.year - a.year)[0] || {};
  const bs0 = (d.balance_sheet || []).sort((a, b) => b.year - a.year)[0] || {};
  const kf0 = (d.key_figures   || []).sort((a, b) => b.year - a.year)[0] || {};
  const hlWrap = document.getElementById("summary-highlights");
  const hlItems = [
    { label: "Net Interest Income", raw: pl0.nii,               fmt: v => fmtE(toE(v)) + " EURm" },
    { label: "Total Income",        raw: pl0.revenue,           fmt: v => fmtE(toE(v)) + " EURm" },
    { label: "Operating Profit",    raw: pl0.operating_profit,  fmt: v => fmtE(toE(v)) + " EURm" },
    { label: "Net Profit",          raw: pl0.net_income,        fmt: v => fmtE(toE(v)) + " EURm" },
    { label: "Total Assets",        raw: bs0.total_assets,      fmt: v => fmtE(toE(v)) + " EURm" },
    { label: "Total Equity",        raw: bs0.equity,            fmt: v => fmtE(toE(v)) + " EURm" },
    { label: "CET1 Ratio",          raw: kf0.cet1_ratio_pct,    fmt: v => fmt(v, 1) + "%" },
    { label: "Cost / Income",       raw: kf0.cost_to_income_pct,fmt: v => fmt(v, 1) + "%" },
    { label: "ROE",                 raw: kf0.roe_pct,           fmt: v => fmt(v, 1) + "%" },
    { label: "Diluted EPS",         raw: kf0.diluted_eps,       fmt: v => fmt(v, 2) + " SEK" },
    { label: "Dividend / Share",    raw: kf0.dividend_per_share,fmt: v => fmt(v, 2) + " SEK" },
    { label: "AuM",                 raw: kf0.aum_bn,            fmt: v => fmt(v, 0) + " bn SEK" },
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
  if (!d.risks || d.risks.length === 0) rl.innerHTML = '<li style="color:var(--text3)">None identified.</li>';

  const ol = document.getElementById("opps-list");
  ol.innerHTML = "";
  (d.opportunities || []).forEach(o => {
    const li = document.createElement("li");
    li.textContent = o;
    ol.appendChild(li);
  });
  if (!d.opportunities || d.opportunities.length === 0) ol.innerHTML = '<li style="color:var(--text3)">None identified.</li>';
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
      { label: "Basic EPS",            key: "basic_eps",            fmt: v => fmt(v, 2) + " SEK" },
      { label: "Diluted EPS",          key: "diluted_eps",          fmt: v => fmt(v, 2) + " SEK" },
      { label: "Dividend per share",   key: "dividend_per_share",   fmt: v => fmt(v, 2) + " SEK" },
      { label: "Equity per share",     key: "equity_per_share",     fmt: v => fmt(v, 2) + " SEK" },
      { label: "Share price",          key: "share_price",          fmt: v => fmt(v, 2) + " SEK" },
      { label: "Shares outstanding",   key: "shares_outstanding_m", fmt: v => fmt(v, 0) + " m" },
    ]) +
    buildKfTable("Performance", [
      { label: "Return on Equity (ROE)",    key: "roe_pct",                fmt: v => fmt(v, 1) + "%" },
      { label: "Cost / Income",             key: "cost_to_income_pct",     fmt: v => fmt(v, 1) + "%" },
      { label: "Net loan loss ratio",       key: "net_loan_loss_ratio_pct",fmt: v => fmt(v, 2) + "%" },
      { label: "Assets under Management",  key: "aum_bn",                 fmt: v => fmt(v, 0) + " bn SEK" },
    ]) +
    buildKfTable("Capital Adequacy", [
      { label: "CET1 Ratio",            key: "cet1_ratio_pct",         fmt: v => fmt(v, 1) + "%" },
      { label: "Tier 1 Ratio",          key: "tier1_ratio_pct",        fmt: v => fmt(v, 1) + "%" },
      { label: "Total Capital Ratio",   key: "total_capital_ratio_pct",fmt: v => fmt(v, 1) + "%" },
      { label: "Tier 1 Capital",        key: "tier1_capital",          fmt: v => fmtE(toE(v)) + " EURm" },
      { label: "Risk-weighted Assets",  key: "rea",                    fmt: v => fmtE(toE(v)) + " EURm" },
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

  // Header: label | yr0 | Δ% | yr1 | Δ% | ... | yrN
  const nDelta = allYears.length - 1;
  const colSpan = 1 + allYears.length + nDelta;

  let h = '<div class="fin-table-wrap"><table class="fin-table yoy-table"><thead><tr><th>EURm</th>';
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
  addRatioRow('Diluted EPS',     y => (kfMap[y] || {}).diluted_eps,            v => fmt(v, 2) + " SEK");
  addRatioRow('Dividend/Share',  y => (kfMap[y] || {}).dividend_per_share,     v => fmt(v, 2) + " SEK");

  h += '</tbody></table></div>';
  wrap.innerHTML = h;
}

// ── QOQ ANALYSIS TAB ─────────────────────────────────
function renderQoQ(d) {
  // quarters from API come newest-first; reverse to oldest-first for display
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

  // Header: EURm | Q1 | QoQ% | Q2 | QoQ% | …
  let h = '<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>EURm</th>';
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

// ── AI ANALYSIS TAB ───────────────────────────────────
function renderAnalysis(d) {
  document.getElementById("analysis-text").textContent =
    d.analysis || "No analysis available.";

  const nl = document.getElementById("news-list");
  nl.innerHTML = "";
  (d.news || []).forEach(n => {
    const sent = (n.sentiment || "neutral").toLowerCase();
    const card = el("div", `news-card ${sent}`);
    card.innerHTML = `
      <div class="news-title">${n.title || "—"}</div>
      <div class="news-summary">${n.summary || ""}</div>
      <div class="news-meta">
        <span><span class="sentiment-dot ${sent}"></span>${sent}</span>
        <span>${n.date || "—"}</span>
      </div>
    `;
    nl.appendChild(card);
  });
  if (!d.news || !d.news.length)
    nl.innerHTML = '<p class="empty-state">No news available.</p>';
}

function makeTable(headers, rows) {
  const ths = headers.map(h => `<th>${h}</th>`).join("");
  const trs = rows.map(row => {
    const tds = row.map((v, i) => {
      if (i === 0) return `<td>${v}</td>`;
      const cls = typeof v === "string" && v.startsWith("-") ? "neg" : "";
      return `<td class="${cls}">${v}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");
  return `<table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

// ════════════════════════════════════════════════════════
//  WELCOME MODAL
// ════════════════════════════════════════════════════════

function closeWelcome() {
  document.getElementById("welcome-overlay").classList.add("hidden");
  sessionStorage.setItem("welcomeSeen", "1");
}

function closeWelcomeOnOverlay(e) {
  if (e.target === document.getElementById("welcome-overlay")) closeWelcome();
}

// Show once per browser session
(function () {
  if (!sessionStorage.getItem("welcomeSeen")) {
    document.getElementById("welcome-overlay").classList.remove("hidden");
  }
})();

// Also close welcome on Escape (merged below with feedback Escape handler)

// ════════════════════════════════════════════════════════
//  FEEDBACK MODAL
// ════════════════════════════════════════════════════════

function openFeedback() {
  // Pre-fill ticker if a stock is loaded
  const tickerInput = document.getElementById("ticker-input");
  const fbTicker    = document.getElementById("fb-ticker");
  if (tickerInput.value.trim() && !fbTicker.value) {
    fbTicker.value = tickerInput.value.trim().toUpperCase();
  }
  document.getElementById("feedback-overlay").classList.remove("hidden");
  document.getElementById("fb-message").focus();
}

function closeFeedback() {
  document.getElementById("feedback-overlay").classList.add("hidden");
}

function closeFeedbackOnOverlay(e) {
  // Close only when clicking the dark backdrop, not the modal card itself
  if (e.target === document.getElementById("feedback-overlay")) closeFeedback();
}

// Close on Escape key (both modals)
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeFeedback();
    closeWelcome();
  }
});

// Submit via fetch — no page reload
document.getElementById("feedback-form").addEventListener("submit", async e => {
  e.preventDefault();

  const message = document.getElementById("fb-message").value.trim();
  if (!message) {
    document.getElementById("fb-message").focus();
    return;
  }

  const submitBtn = document.getElementById("fb-submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending…";

  try {
    // Build payload explicitly so Formspree field names are reliable
    const payload = new FormData();
    payload.append("ticker",  document.getElementById("fb-ticker").value.trim());
    payload.append("message", message);

    const res = await fetch("https://formspree.io/f/xlgarjwy", {
      method:  "POST",
      headers: { "Accept": "application/json" },
      body:    payload,
    });

    if (res.ok) {
      document.getElementById("feedback-form").classList.add("hidden");
      document.getElementById("fb-success").classList.remove("hidden");
      // Auto-close after 3 s and reset for next use
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
//  PDF UPLOAD MODAL
// ════════════════════════════════════════════════════════

// Configure pdf.js worker (CDN must match the main script version)
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const total = pdf.numPages;
  const MAX_PAGES = 400;

  // Annual reports bury financial statements in the latter half (often pages 150–334+).
  // Strategy: extract up to 30 cover pages for context, then prioritise from 40% of
  // the document onwards, up to MAX_PAGES total pages extracted.
  const coverEnd  = Math.min(30, total);
  const bodyStart = Math.max(coverEnd + 1, Math.floor(total * 0.40));
  const bodyEnd   = Math.min(total, bodyStart + (MAX_PAGES - coverEnd));

  const pageNums = [];
  for (let i = 1; i <= coverEnd; i++) pageNums.push(i);
  for (let i = bodyStart; i <= bodyEnd; i++) pageNums.push(i);

  console.log(
    `[pdf] total=${total} pages | extracting cover 1–${coverEnd}, body ${bodyStart}–${bodyEnd}` +
    ` (${pageNums.length} pages)`
  );

  const parts = [];
  for (const i of pageNums) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text    = content.items.map(item => item.str).join(" ");
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n\n");
}

// ── Upload state ──────────────────────────────────────
// Each entry: { file: File, year: number, reportType: "annual"|"quarterly", quarter: "Q1"|…|"Q4" }
let _uploadFiles = [];
const _CURRENT_YEAR = new Date().getFullYear();

function _yearOptions(selected) {
  let html = "";
  for (let y = _CURRENT_YEAR; y >= 2015; y--) {
    html += `<option value="${y}"${y === selected ? " selected" : ""}>${y}</option>`;
  }
  return html;
}

function _renderUploadFileList() {
  const list = document.getElementById("up-file-list");
  if (!_uploadFiles.length) {
    list.innerHTML = '<p class="up-empty">No files added yet. Click "+ Add PDF files" to begin.</p>';
    return;
  }
  list.innerHTML = "";
  _uploadFiles.forEach((item, i) => {
    const entry = document.createElement("div");
    entry.className = "up-file-entry";
    entry.innerHTML = `
      <div class="up-file-info">
        <span class="up-file-name" title="${item.file.name}">${item.file.name}</span>
        <button class="up-file-remove" onclick="_removeUploadFile(${i})" aria-label="Remove">✕</button>
      </div>
      <div class="up-file-meta">
        <select class="up-sel up-year" onchange="_uploadFiles[${i}].year=+this.value">
          ${_yearOptions(item.year)}
        </select>
        <select class="up-sel up-rtype" onchange="_setUploadRtype(${i},this.value)">
          <option value="annual"${item.reportType==="annual"?" selected":""}>Annual</option>
          <option value="quarterly"${item.reportType==="quarterly"?" selected":""}>Quarterly</option>
        </select>
        <select class="up-sel up-quarter"
                style="display:${item.reportType==="quarterly"?"":"none"}"
                onchange="_uploadFiles[${i}].quarter=this.value">
          <option value="Q1"${item.quarter==="Q1"?" selected":""}>Q1</option>
          <option value="Q2"${item.quarter==="Q2"?" selected":""}>Q2</option>
          <option value="Q3"${item.quarter==="Q3"?" selected":""}>Q3</option>
          <option value="Q4"${item.quarter==="Q4"?" selected":""}>Q4</option>
        </select>
      </div>
    `;
    list.appendChild(entry);
  });
}

function _removeUploadFile(idx) {
  _uploadFiles.splice(idx, 1);
  _renderUploadFileList();
}

function _setUploadRtype(idx, val) {
  _uploadFiles[idx].reportType = val;
  _renderUploadFileList();
}

document.getElementById("up-file-input").addEventListener("change", e => {
  Array.from(e.target.files).forEach(f => {
    _uploadFiles.push({ file: f, year: _CURRENT_YEAR, reportType: "annual", quarter: "Q1" });
  });
  _renderUploadFileList();
  e.target.value = "";
});

function openUpload() {
  const loaded = document.getElementById("ticker-input").value.trim().toUpperCase();
  const upTicker = document.getElementById("up-ticker");
  if (loaded && !upTicker.value) upTicker.value = loaded;
  _renderUploadFileList();
  document.getElementById("upload-overlay").classList.remove("hidden");
  upTicker.focus();
}

function closeUpload() {
  document.getElementById("upload-overlay").classList.add("hidden");
}

function closeUploadOnOverlay(e) {
  if (e.target === document.getElementById("upload-overlay")) closeUpload();
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeUpload();
}, { capture: false });

async function submitUpload() {
  const ticker    = document.getElementById("up-ticker").value.trim().toUpperCase();
  const errorEl   = document.getElementById("up-error");
  const successEl = document.getElementById("up-success");
  const submitBtn = document.getElementById("up-submit-btn");
  const progressEl   = document.getElementById("up-progress");
  const progressText = document.getElementById("up-progress-text");
  const progressFill = document.getElementById("up-progress-fill");

  errorEl.classList.add("hidden");
  errorEl.textContent = "";

  if (!ticker)             { showUploadError("Ticker is required."); return; }
  if (!_uploadFiles.length){ showUploadError("Add at least one PDF file."); return; }

  submitBtn.disabled = true;
  progressFill.style.width = "0%";
  progressEl.classList.remove("hidden");

  const total = _uploadFiles.length;
  let successCount = 0;

  for (let i = 0; i < total; i++) {
    const item = _uploadFiles[i];

    // ── Extract text ──────────────────────────────────
    progressText.textContent =
      `Extracting text from file ${i + 1} of ${total}: ${item.file.name}…`;
    progressFill.style.width = `${Math.round(((i + 0.3) / total) * 100)}%`;

    let pdfText;
    try {
      pdfText = await extractPdfText(item.file);
    } catch (err) {
      showUploadError(`${item.file.name}: could not read PDF — is it scanned/image-only?`);
      submitBtn.disabled = false;
      progressEl.classList.add("hidden");
      return;
    }
    if (!pdfText || pdfText.trim().length < 200) {
      showUploadError(`${item.file.name}: extracted text too short.`);
      submitBtn.disabled = false;
      progressEl.classList.add("hidden");
      return;
    }

    // ── Upload ────────────────────────────────────────
    const period = item.reportType === "quarterly"
      ? `${item.quarter} ${item.year}`
      : String(item.year);

    progressText.textContent =
      `Uploading file ${i + 1} of ${total}: ${item.file.name} (${period})…`;
    progressFill.style.width = `${Math.round(((i + 0.7) / total) * 100)}%`;

    try {
      const res  = await fetch("/api/upload", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          report_type: item.reportType,
          period,
          pdf_text: pdfText,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        showUploadError(`${item.file.name}: ${data.error || `Upload failed (${res.status})`}`);
        submitBtn.disabled = false;
        progressEl.classList.add("hidden");
        return;
      }
      successCount++;
    } catch (err) {
      showUploadError(`${item.file.name}: network error — ${err.message}`);
      submitBtn.disabled = false;
      progressEl.classList.add("hidden");
      return;
    }

    progressFill.style.width = `${Math.round(((i + 1) / total) * 100)}%`;

    // 5-second delay between files (not after the last one)
    if (i < total - 1) {
      const remaining = total - i - 1;
      progressText.textContent =
        `Waiting 5 s before next upload… (${remaining} file${remaining > 1 ? "s" : ""} remaining)`;
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ── All done ──────────────────────────────────────
  progressEl.classList.add("hidden");
  successEl.textContent =
    `✦ ${successCount} file${successCount > 1 ? "s" : ""} uploaded successfully. Click Analyse to run fresh analysis.`;
  successEl.classList.remove("hidden");
  document.getElementById("ticker-input").value = ticker;

  setTimeout(() => {
    closeUpload();
    setTimeout(() => {
      _uploadFiles = [];
      _renderUploadFileList();
      successEl.classList.add("hidden");
      errorEl.classList.add("hidden");
      progressFill.style.width = "0%";
      submitBtn.disabled = false;
    }, 400);
  }, 3000);
}

function showUploadError(msg) {
  const el = document.getElementById("up-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
