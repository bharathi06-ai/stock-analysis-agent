/* ═══════════════════════════════════════════════════════
   StockGPT for Siva — Dashboard JS (Phase 4)
   9-tab Screener UI with Chart.js
═══════════════════════════════════════════════════════ */

"use strict";

// ── Chart colour palette ──────────────────────────────
const C = {
  blue:   "#4f7eff",
  teal:   "#39d5c4",
  green:  "#3fb950",
  red:    "#f85149",
  yellow: "#d29922",
  purple: "#bc8cff",
  orange: "#f0883e",
  gray:   "#8b949e",
};

const GRID_COLOR  = "rgba(255,255,255,0.06)";
const LABEL_COLOR = "#8b949e";
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Chart.js global defaults
Chart.defaults.color      = LABEL_COLOR;
Chart.defaults.font.family = FONT_FAMILY;
Chart.defaults.font.size  = 11;

// Keep track of Chart.js instances so we can destroy before redraw
const _charts = {};

// Full chart data stored for range-button filtering
let _chartData    = null;
// Sliced arrays for the active range (read by tooltip handler)
let _activeLabels  = [];
let _activePrices  = [];
let _activeVolumes = [];

// ── Crosshair plugin — vertical + horizontal lines ───
const crosshairPlugin = {
  id: "crosshair",
  afterEvent(chart, args) {
    if (!chart.options.plugins?.crosshair?.enabled) return;
    const e = args.event;
    if (e.type === "mousemove") {
      chart._crosshairX = e.x;
      // Snap Y to the nearest data-point element so the H-line rides the curve
      const els = chart.getElementsAtEventForMode(
        e.native, "index", { intersect: false }, false
      );
      chart._crosshairY = els.length ? els[0].element.y : null;
      args.changed = true;
    } else if (e.type === "mouseout") {
      chart._crosshairX = null;
      chart._crosshairY = null;
      args.changed = true;
    }
  },
  afterDraw(chart) {
    if (!chart.options.plugins?.crosshair?.enabled) return;
    if (chart._crosshairX == null) return;
    const { ctx, chartArea: { top, bottom, left, right } } = chart;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    // Vertical line
    ctx.beginPath();
    ctx.moveTo(chart._crosshairX, top);
    ctx.lineTo(chart._crosshairX, bottom);
    ctx.stroke();
    // Horizontal line snapped to data point Y
    if (chart._crosshairY != null) {
      ctx.beginPath();
      ctx.moveTo(left,  chart._crosshairY);
      ctx.lineTo(right, chart._crosshairY);
      ctx.stroke();
    }
    ctx.restore();
  },
};
Chart.register(crosshairPlugin);

// ── Custom HTML tooltip for price chart ──────────────
function priceTooltipHandler({ chart, tooltip }) {
  const wrapEl = chart.canvas.parentNode;

  // Create tooltip element once
  let ttEl = wrapEl.querySelector(".price-tt");
  if (!ttEl) {
    ttEl = document.createElement("div");
    ttEl.className = "price-tt";
    wrapEl.appendChild(ttEl);
  }

  if (tooltip.opacity === 0) { ttEl.style.opacity = "0"; return; }

  const dp = tooltip.dataPoints?.[0];
  if (!dp) { ttEl.style.opacity = "0"; return; }

  const idx    = dp.dataIndex;
  const price  = _activePrices[idx];
  const volume = _activeVolumes[idx];
  const prev   = idx > 0 ? _activePrices[idx - 1] : null;
  const pct    = (prev != null && prev !== 0) ? ((price - prev) / prev) * 100 : null;

  // Format date: "2025-04-12" → "12 Apr 2025"
  const dateStr = new Date(_activeLabels[idx] + "T12:00:00").toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });

  const pctHtml = pct != null
    ? `<span class="tt-chg ${pct >= 0 ? "pos" : "neg"}">${pct >= 0 ? "▲" : "▼"}&thinsp;${Math.abs(pct).toFixed(2)}%</span>`
    : `<span class="tt-val">—</span>`;

  ttEl.innerHTML = `
    <div class="tt-date">${dateStr}</div>
    <div class="tt-row"><span class="tt-lbl">Price</span><span class="tt-val">${fmt(price, 2)} SEK</span></div>
    <div class="tt-row"><span class="tt-lbl">Volume</span><span class="tt-val">${volume != null ? Number(volume).toLocaleString("sv-SE") : "—"}</span></div>
    <div class="tt-row"><span class="tt-lbl">Day change</span>${pctHtml}</div>
  `;

  // Position relative to the chart-wrap (which is position:relative)
  const wrapRect   = wrapEl.getBoundingClientRect();
  const canvasRect = chart.canvas.getBoundingClientRect();
  const cOffX = canvasRect.left - wrapRect.left;
  const cOffY = canvasRect.top  - wrapRect.top;

  const GAP  = 14;
  const ttW  = ttEl.offsetWidth  || 175;
  const ttH  = ttEl.offsetHeight || 108;
  const wrapW = wrapEl.offsetWidth;
  const wrapH = wrapEl.offsetHeight;

  // Default: tooltip to the right of cursor; flip left if it'd overflow
  let x = cOffX + tooltip.caretX + GAP;
  if (x + ttW + 6 > wrapW) x = cOffX + tooltip.caretX - GAP - ttW;

  // Vertically centred on the data point; clamped inside wrap
  let y = cOffY + (chart._crosshairY != null ? chart._crosshairY : tooltip.caretY) - ttH / 2;
  y = Math.max(4, Math.min(y, wrapH - ttH - 4));

  ttEl.style.left    = x + "px";
  ttEl.style.top     = y + "px";
  ttEl.style.opacity = "1";
}

function mkChart(id, config) {
  if (_charts[id]) { _charts[id].destroy(); }
  const ctx = document.getElementById(id);
  if (!ctx) return;
  _charts[id] = new Chart(ctx, config);
}

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

// ── Range button listener ──────────────────────────────
document.getElementById("price-range-btns").addEventListener("click", e => {
  const btn = e.target.closest(".range-btn");
  if (!btn) return;
  document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  drawPriceChart(btn.dataset.range);
});

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
    document.querySelector('.tab-btn[data-tab="overview"]').classList.add("active");
    document.getElementById("tab-overview").classList.add("active");
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

async function runAnalysis() {
  const ticker = document.getElementById("ticker-input").value.trim().toUpperCase();
  if (!ticker) return;

  const btn = document.getElementById("analyse-btn");
  btn.disabled = true;
  showStatus(`Starting analysis for ${ticker}…`);
  document.getElementById("dashboard").classList.add("hidden");

  try {
    const resp = await fetch("/api/analyse", {
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
          document.querySelector('.tab-btn[data-tab="overview"]').classList.add("active");
          document.getElementById("tab-overview").classList.add("active");

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
//  RENDER DASHBOARD
// ════════════════════════════════════════════════════════
function renderDashboard(d) {
  renderHero(d);
  renderMetricPills(d);
  renderOverview(d);
  renderPriceChart(d);
  renderPLChart(d);
  renderBSChart(d);
  renderCFChart(d);
  renderQuartersChart(d);
  renderRatios(d);
  renderShareholders(d);
  renderAnalysis(d);
  renderSourceChips(d);
  document.getElementById("last-updated").textContent =
    "Last updated: " + (d.last_updated || "—");
}

// ── SOURCE CHIPS ──────────────────────────────────────
function renderSourceChips(d) {
  const src = d.data_sources || {};
  const map = {
    "price-source-chip":    { icon: "📈", text: src.price_chart },
    "pl-source-chip":       { icon: "📄", text: src.financials },
    "bs-source-chip":       { icon: "📄", text: src.financials },
    "cf-source-chip":       { icon: "📄", text: src.financials },
    "q-source-chip":        { icon: "📄", text: src.quarters },
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
  // P/E, P/B, dividend yield, ROE, EPS now come from PDF-extracted ratios
  const pills = [
    { label: "Market Cap",    value: fmtCap(mkt.market_cap_m) },
    { label: "P/E Ratio",     value: fmtPE(rat.pe),  cls: rat.pe != null && rat.pe < 0 ? "red" : "accent" },
    { label: "P/B Ratio",     value: fmtPE(rat.pb),  cls: "accent" },
    { label: "Dividend Yield",value: fmtPct(rat.dividend_yield), cls: rat.dividend_yield > 0 ? "green" : "" },
    { label: "ROE",           value: fmtPct(rat.roe), cls: rat.roe > 10 ? "green" : rat.roe < 0 ? "red" : "" },
    { label: "EPS",           value: rat.eps != null ? fmt(rat.eps, 2) + " SEK" : "—" },
    { label: "Beta",          value: mkt.beta != null ? fmt(mkt.beta, 2) : "—" },
    { label: "Shares Out",    value: mkt.shares_outstanding_m != null ? fmt(mkt.shares_outstanding_m, 0) + "M" : "—" },
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

// ── OVERVIEW TAB ──────────────────────────────────────
function renderOverview(d) {
  const co  = d.company || {};
  const rec = d.recommendation || {};

  document.getElementById("company-desc").textContent =
    co.description || "No company description available.";

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

// ── PRICE CHART ───────────────────────────────────────
function renderPriceChart(d) {
  _chartData = d.chart || {};
  // Reset active range button to 1Y
  document.querySelectorAll(".range-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.range === "1Y");
  });
  drawPriceChart("1Y");
}

function drawPriceChart(range) {
  if (!_chartData) return;

  const allLabels  = _chartData.labels  || [];
  const allPrices  = _chartData.prices  || [];
  const allVolumes = _chartData.volumes || [];

  const counts = { "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252, "5Y": 1260 };
  const n = counts[range] || allLabels.length;

  // Store sliced data globally so the tooltip handler can read them
  _activeLabels  = allLabels.slice(-n);
  _activePrices  = allPrices.slice(-n);
  _activeVolumes = allVolumes.slice(-n);

  // Remove stale tooltip div before recreating chart
  const priceCanvas = document.getElementById("chart-price");
  if (priceCanvas) {
    const old = priceCanvas.parentNode.querySelector(".price-tt");
    if (old) old.remove();
  }

  mkChart("chart-price", {
    type: "line",
    data: {
      labels: _activeLabels,
      datasets: [{
        label: "Price (SEK)",
        data: _activePrices,
        borderColor: C.blue,
        backgroundColor: "rgba(79,126,255,0.08)",
        borderWidth: 1.5,
        fill: true,
        tension: 0.3,
        // Invisible by default; dot appears only on hover
        pointRadius: 0,
        pointHitRadius: 20,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: C.blue,
        pointHoverBorderColor: "#ffffff",
        pointHoverBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        // Disable built-in tooltip; use custom HTML card instead
        tooltip: { enabled: false, external: priceTooltipHandler },
        crosshair: { enabled: true },
      },
      scales: {
        x: {
          grid: { color: GRID_COLOR },
          ticks: { maxTicksLimit: 12, maxRotation: 0, color: LABEL_COLOR },
        },
        y: {
          grid: { color: GRID_COLOR },
          ticks: { color: LABEL_COLOR },
        },
      },
    },
  });

  mkChart("chart-volume", {
    type: "bar",
    data: {
      labels: _activeLabels,
      datasets: [{
        label: "Volume",
        data: _activeVolumes,
        backgroundColor: "rgba(79,126,255,0.35)",
        hoverBackgroundColor: "rgba(79,126,255,0.65)",
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12, color: LABEL_COLOR } },
        y: { grid: { color: GRID_COLOR }, ticks: { color: LABEL_COLOR } },
      },
    },
  });
}

// ── P&L CHART ────────────────────────────────────────
function renderPLChart(d) {
  const pl = (d.profit_loss || []).slice().reverse();
  if (!pl.length) return;

  const labels = pl.map(r => String(r.year));
  mkChart("chart-pl", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Revenue",          data: pl.map(r => r.revenue),          backgroundColor: C.blue,   borderRadius: 4 },
        { label: "Gross Profit",     data: pl.map(r => r.gross_profit),     backgroundColor: C.teal,   borderRadius: 4 },
        { label: "Operating Income", data: pl.map(r => r.operating_income), backgroundColor: C.purple, borderRadius: 4 },
        { label: "Net Income",       data: pl.map(r => r.net_income),       backgroundColor: C.green,  borderRadius: 4 },
      ],
    },
    options: barOpts(),
  });

  document.getElementById("pl-table-wrap").innerHTML = makeTable(
    ["Year", "Revenue", "Gross Profit", "Op. Income", "Net Income", "EBITDA"],
    pl.map(r => [r.year, fmtM(r.revenue), fmtM(r.gross_profit),
                 fmtM(r.operating_income), fmtM(r.net_income), fmtM(r.ebitda)])
  );
}

// ── BALANCE SHEET CHART ──────────────────────────────
function renderBSChart(d) {
  const bs = (d.balance_sheet || []).slice().reverse();
  if (!bs.length) return;

  const labels = bs.map(r => String(r.year));
  mkChart("chart-bs", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Total Assets",      data: bs.map(r => r.total_assets),      backgroundColor: C.blue,   borderRadius: 4 },
        { label: "Total Liabilities", data: bs.map(r => r.total_liabilities), backgroundColor: C.red,    borderRadius: 4 },
        { label: "Equity",            data: bs.map(r => r.equity),            backgroundColor: C.green,  borderRadius: 4 },
        { label: "Cash",              data: bs.map(r => r.cash),              backgroundColor: C.teal,   borderRadius: 4 },
      ],
    },
    options: barOpts(),
  });

  document.getElementById("bs-table-wrap").innerHTML = makeTable(
    ["Year", "Total Assets", "Liabilities", "Equity", "Cash", "Total Debt"],
    bs.map(r => [r.year, fmtM(r.total_assets), fmtM(r.total_liabilities),
                 fmtM(r.equity), fmtM(r.cash), fmtM(r.total_debt)])
  );
}

// ── CASH FLOW CHART ──────────────────────────────────
function renderCFChart(d) {
  const cf = (d.cash_flow || []).slice().reverse();
  if (!cf.length) return;

  const labels = cf.map(r => String(r.year));
  mkChart("chart-cf", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Operating CF", data: cf.map(r => r.operating_cf), backgroundColor: C.green,  borderRadius: 4 },
        { label: "Investing CF", data: cf.map(r => r.investing_cf), backgroundColor: C.red,    borderRadius: 4 },
        { label: "Financing CF", data: cf.map(r => r.financing_cf), backgroundColor: C.yellow, borderRadius: 4 },
        { label: "Free CF",      data: cf.map(r => r.free_cf),      backgroundColor: C.teal,   borderRadius: 4 },
      ],
    },
    options: barOpts(),
  });

  document.getElementById("cf-table-wrap").innerHTML = makeTable(
    ["Year", "Operating CF", "Investing CF", "Financing CF", "Free CF", "CapEx"],
    cf.map(r => [r.year, fmtM(r.operating_cf), fmtM(r.investing_cf),
                 fmtM(r.financing_cf), fmtM(r.free_cf), fmtM(r.capex)])
  );
}

// ── QUARTERLY CHART ───────────────────────────────────
function renderQuartersChart(d) {
  const q = (d.quarters || []).slice().reverse();
  if (!q.length) return;

  const labels = q.map(r => r.period);
  mkChart("chart-quarters", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Revenue",    data: q.map(r => r.revenue),    backgroundColor: C.blue,  borderRadius: 4 },
        { label: "Net Income", data: q.map(r => r.net_income), backgroundColor: C.green, borderRadius: 4 },
      ],
    },
    options: barOpts(),
  });

  document.getElementById("q-table-wrap").innerHTML = makeTable(
    ["Period", "Revenue", "Gross Profit", "Net Income"],
    q.map(r => [r.period, fmtM(r.revenue), fmtM(r.gross_profit), fmtM(r.net_income)])
  );
}

// ── RATIOS ────────────────────────────────────────────
function renderRatios(d) {
  const r   = d.ratios  || {};
  const m   = d.market  || {};
  const src = d.data_sources || {};
  // Show data provenance banner
  const tab = document.getElementById("tab-ratios");
  let banner = tab.querySelector(".source-banner");
  if (!banner) {
    banner = el("div", "source-banner");
    tab.insertBefore(banner, tab.firstChild);
  }
  banner.innerHTML =
    `<span class="src-item pdf">📄 Margins, ROE, ROA, DPS, Payout — <em>${src.financials || "Annual Report PDF"}</em></span>` +
    `<span class="src-item calc">🔢 P/E, P/B, P/S — <em>PDF earnings × live price</em></span>` +
    `<span class="src-item yf">📈 Beta — <em>${src.price_chart || "Yahoo Finance"}</em></span>`;

  const sections = {
    "ratios-val": [
      ["P/E Ratio",          r.pe,             fmtPE],
      ["Forward P/E",        r.forward_pe,     fmtPE],
      ["P/B Ratio",          r.pb,             fmtPE],
      ["P/S Ratio",          r.ps,             fmtPE],
      ["EPS (TTM)",          r.eps,            v => fmt(v, 2) + " SEK"],
      ["Forward EPS",        r.forward_eps,    v => fmt(v, 2) + " SEK"],
      ["Beta",               r.beta,           v => fmt(v, 2)],
    ],
    "ratios-prof": [
      ["ROE",                r.roe,            fmtPct],
      ["ROA",                r.roa,            fmtPct],
      ["Gross Margin",       r.gross_margin,   fmtPct],
      ["Operating Margin",   r.operating_margin, fmtPct],
      ["Net Margin",         r.net_margin,     fmtPct],
    ],
    "ratios-lev": [
      ["Current Ratio",      r.current_ratio,  v => fmt(v, 2)],
      ["Debt / Equity",      r.debt_to_equity, v => fmt(v, 2)],
      ["Dividend Yield",     r.dividend_yield, fmtPct],
      ["Payout Ratio",       r.payout_ratio,   fmtPct],
    ],
  };

  Object.entries(sections).forEach(([id, rows]) => {
    const grid = document.getElementById(id);
    grid.innerHTML = "";
    rows.forEach(([label, val, fmt_fn]) => {
      const card = el("div", "ratio-card");
      const fmted = fmt_fn && val != null ? fmt_fn(val) : (val != null ? val : "—");
      const cls = ratColor(label, val);
      card.innerHTML = `
        <div class="rc-label">${label}</div>
        <div class="rc-value ${cls}">${fmted}</div>
      `;
      grid.appendChild(card);
    });
  });
}

// ── SHAREHOLDERS ──────────────────────────────────────
function renderShareholders(d) {
  const investors = d.investors || [];

  if (!investors.length) {
    document.getElementById("sh-table-wrap").innerHTML =
      '<p class="empty-state">No institutional holder data available.</p>';
    return;
  }

  document.getElementById("sh-table-wrap").innerHTML = makeTable(
    ["Holder", "Shares", "% Out", "Value (MSEK)"],
    investors.map(r => [
      r.name,
      r.shares ? Number(r.shares).toLocaleString("sv-SE") : "—",
      fmtPct(r.pct),
      fmtM(r.value),
    ])
  );

  // Donut chart (top 8 + other)
  const top8 = investors.slice(0, 8);
  const topPct = top8.reduce((s, r) => s + (r.pct || 0), 0);
  const labels = top8.map(r => r.name);
  const data   = top8.map(r => r.pct || 0);
  if (topPct < 95) {
    labels.push("Other");
    data.push(Math.max(0, 100 - topPct));
  }

  const palette = [C.blue, C.teal, C.green, C.purple, C.orange, C.yellow, C.red, C.gray, "#60a5fa", "#a78bfa"];

  mkChart("chart-shareholders", {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: palette.slice(0, labels.length),
        borderColor: "#0d1117",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { color: LABEL_COLOR, font: { size: 10 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${fmt(ctx.raw, 2)}%`,
          },
        },
      },
    },
  });
}

// ── ANALYSIS TAB ──────────────────────────────────────
function renderAnalysis(d) {
  document.getElementById("analysis-text").textContent =
    d.analysis || "No analysis available.";

  const pl = document.getElementById("peers-list");
  pl.innerHTML = "";
  (d.peers || []).forEach(p => {
    const item = el("div", "peer-item");
    item.innerHTML = `
      <div>
        <div class="peer-name">${p.name || "—"}</div>
        <div class="peer-rel">${p.relationship || ""}</div>
      </div>
      <span class="peer-ticker">${p.ticker || "—"}</span>
    `;
    pl.appendChild(item);
  });
  if (!d.peers || !d.peers.length)
    pl.innerHTML = '<p class="empty-state">No peer data.</p>';

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

// ── Chart helpers ─────────────────────────────────────
function barOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: LABEL_COLOR, boxWidth: 12, padding: 14, font: { size: 11 } } },
      tooltip: { mode: "index", intersect: false },
    },
    scales: {
      x: { grid: { color: GRID_COLOR }, ticks: { color: LABEL_COLOR } },
      y: { grid: { color: GRID_COLOR }, ticks: { color: LABEL_COLOR } },
    },
  };
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
