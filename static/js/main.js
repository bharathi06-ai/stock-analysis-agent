"use strict";

/* ═══════════════════════════════════════════════════════════
   StockDesk — Screen 1 (Upload)
═══════════════════════════════════════════════════════════ */

// ── pdf.js worker ─────────────────────────────────────────
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ── Helpers ───────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(s) {
  if (!s) return "—";
  return String(s).slice(0, 10);
}

function capitalize(s) {
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("inp-year").value = new Date().getFullYear();

  document.querySelectorAll("input[name='file_type']").forEach(r =>
    r.addEventListener("change", onFileTypeChange)
  );

  document.getElementById("file-input").addEventListener("change", onFileChosen);
  document.getElementById("upload-form").addEventListener("submit", onUploadSubmit);

  loadReports();

  // ── Navigation ────────────────────────────────────────
  document.querySelectorAll(".sd-nav-link").forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      const screen = link.dataset.screen;

      document.querySelectorAll(".sd-nav-link").forEach(l =>
        l.classList.toggle("sd-nav-link--active", l === link)
      );

      document.getElementById("screen-upload").classList.toggle("hidden", screen !== "upload");
      document.getElementById("screen-companies").classList.toggle("hidden", screen !== "companies");

      if (screen === "companies") initCompanyView();
    });
  });
});

// ── File type toggle ──────────────────────────────────────
function onFileTypeChange() {
  const ft = document.querySelector("input[name='file_type']:checked").value;
  const fi = document.getElementById("file-input");
  fi.accept = ft === "pdf" ? ".pdf" : ".xlsx,.xls";
  fi.value  = "";
  _chosenFile = null;
  document.getElementById("file-chosen").textContent = "No file chosen";
}

// ── File chosen ───────────────────────────────────────────
let _chosenFile = null;

function onFileChosen(e) {
  _chosenFile = e.target.files[0] || null;
  document.getElementById("file-chosen").textContent =
    _chosenFile ? _chosenFile.name : "No file chosen";
  e.target.value = "";
}

// ═══════════════════════════════════════════════════════════
//  UPLOAD FORM SUBMIT
// ═══════════════════════════════════════════════════════════

async function onUploadSubmit(e) {
  e.preventDefault();

  const companyName = document.getElementById("inp-company").value.trim();
  const sector      = document.getElementById("inp-sector").value;
  const fileType    = document.querySelector("input[name='file_type']:checked").value;
  const periodType  = document.getElementById("inp-period").value;
  const year        = document.getElementById("inp-year").value;

  // Format: "2024_Q1" or "2024_annual"
  const period     = periodType === "annual" ? `${year}_annual` : `${year}_${periodType}`;
  const reportType = periodType === "annual" ? "annual" : "quarterly";

  clearMessages();

  if (!companyName) { showError("Company name is required."); return; }
  if (!sector)      { showError("Please select a sector."); return; }
  if (!_chosenFile) { showError("Please choose a file."); return; }

  const submitBtn = document.getElementById("upload-btn");
  submitBtn.disabled = true;

  // ── PDF: extract text in browser ──
  let extractedText = "";
  if (fileType === "pdf") {
    setStatus("Extracting text from PDF…");
    try {
      extractedText = await extractPdfText(_chosenFile);
    } catch (_) {
      showError("Could not read PDF — is it scanned or image-only?");
      submitBtn.disabled = false;
      hideStatus();
      return;
    }
    if (!extractedText || extractedText.trim().length < 100) {
      showError("Extracted text too short — is this a scanned PDF?");
      submitBtn.disabled = false;
      hideStatus();
      return;
    }
  }

  // ── Upload ──
  setStatus("Uploading…");

  try {
    const fd = new FormData();
    fd.append("company_name",   companyName);
    fd.append("sector",         sector);
    fd.append("period",         period);
    fd.append("report_type",    reportType);
    fd.append("file_type",      fileType);
    fd.append("file",           _chosenFile, _chosenFile.name);
    if (fileType === "pdf") {
      fd.append("extracted_text", extractedText);
    }

    const resp = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || !data.success) {
      showError(data.error || `Upload failed (HTTP ${resp.status})`);
      submitBtn.disabled = false;
      hideStatus();
      return;
    }

    hideStatus();
    showSuccess("Report uploaded successfully.");

    // Reset file selection
    _chosenFile = null;
    document.getElementById("file-chosen").textContent = "No file chosen";

    loadReports();

    setTimeout(() => {
      document.getElementById("upload-success").classList.add("hidden");
      submitBtn.disabled = false;
    }, 4000);

  } catch (err) {
    showError("Network error: " + err.message);
    submitBtn.disabled = false;
    hideStatus();
  }
}

// ── PDF text extraction ───────────────────────────────────
async function extractPdfText(file) {
  const buf  = await file.arrayBuffer();
  const pdf  = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const n    = pdf.numPages;
  const MAX  = 400;

  const coverEnd  = Math.min(30, n);
  const bodyStart = Math.max(coverEnd + 1, Math.floor(n * 0.40));
  const bodyEnd   = Math.min(n, bodyStart + (MAX - coverEnd));

  const pageNums = [];
  for (let i = 1; i <= coverEnd; i++)   pageNums.push(i);
  for (let i = bodyStart; i <= bodyEnd; i++) pageNums.push(i);

  const parts = [];
  for (const i of pageNums) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text    = content.items.map(it => it.str).join(" ");
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n\n");
}

// ── Status helpers ────────────────────────────────────────
function setStatus(msg) {
  document.getElementById("upload-status-msg").textContent = msg;
  document.getElementById("upload-status").classList.remove("hidden");
}

function hideStatus() {
  document.getElementById("upload-status").classList.add("hidden");
}

function showSuccess(msg) {
  const el = document.getElementById("upload-success");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function showError(msg) {
  const el = document.getElementById("upload-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function clearMessages() {
  document.getElementById("upload-success").classList.add("hidden");
  document.getElementById("upload-error").classList.add("hidden");
}

// ═══════════════════════════════════════════════════════════
//  REPORTS TABLE
// ═══════════════════════════════════════════════════════════

async function loadReports() {
  const wrap = document.getElementById("reports-wrap");
  wrap.innerHTML = '<p class="sd-state-text">Loading…</p>';

  try {
    const resp = await fetch("/api/list_reports");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderReportsTable(Array.isArray(data) ? data : []);
  } catch (err) {
    wrap.innerHTML =
      `<p class="sd-state-text">Could not load reports — ${esc(err.message)}</p>`;
  }
}

function renderReportsTable(reports) {
  const wrap = document.getElementById("reports-wrap");

  if (!reports.length) {
    wrap.innerHTML = '<p class="sd-state-text">No reports uploaded yet.</p>';
    return;
  }

  const tbody = reports.map((r, i) => `
    <tr>
      <td class="td-company">${esc(r.company_name)}</td>
      <td>${esc(r.sector || "—")}</td>
      <td class="td-period">${esc(r.period || "—")}</td>
      <td>${esc(capitalize(r.report_type || "—"))}</td>
      <td class="td-date">${esc(fmtDate(r.uploaded_at))}</td>
      <td>
        <button class="sd-btn-delete"
          data-idx="${i}"
          data-company="${esc(r.company_name)}"
          data-period="${esc(r.period || "")}"
          data-type="${esc(r.report_type || "")}"
          data-id="${esc(r.id || "")}">
          Delete
        </button>
      </td>
    </tr>`).join("");

  wrap.innerHTML = `
    <div class="sd-table-scroll">
      <table class="sd-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Sector</th>
            <th>Period</th>
            <th>Type</th>
            <th>Uploaded</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

  wrap.querySelectorAll(".sd-btn-delete").forEach(btn =>
    btn.addEventListener("click", () => onDeleteReport(btn))
  );
}

// ── Delete a report ───────────────────────────────────────
async function onDeleteReport(btn) {
  const company = btn.dataset.company;
  const period  = btn.dataset.period;
  const type    = btn.dataset.type;
  const id      = btn.dataset.id || null;

  const label = `${period} ${type} report for ${company}`;
  if (!confirm(`Delete ${label}?\nThis cannot be undone.`)) return;

  btn.disabled    = true;
  btn.textContent = "Deleting…";

  try {
    const payload = id
      ? { id }
      : { company_name: company, period, report_type: type };

    const resp = await fetch("/api/delete_report", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || data.error) {
      alert(data.error || "Failed to delete report.");
      btn.disabled    = false;
      btn.textContent = "Delete";
      return;
    }

    loadReports();
  } catch (err) {
    alert("Network error: " + err.message);
    btn.disabled    = false;
    btn.textContent = "Delete";
  }
}

// ═══════════════════════════════════════════════════════════
//  SCREEN 2 — COMPANY VIEW
// ═══════════════════════════════════════════════════════════

let _financialData  = [];
let _activePeriod   = "quarterly";
let _activeTab      = "income";
let _cvInitialized  = false;

// ── Row definitions ───────────────────────────────────────

const INCOME_ROWS = [
  { key: "net_interest_income",          label: "Net interest income",           bold: false },
  { key: "net_commission_income",        label: "Net commission income",         bold: false },
  { key: "net_gains_on_financial_items", label: "Net gains on financial items",  bold: false },
  { key: "other_income",                 label: "Other income",                  bold: false },
  { key: "total_income",                 label: "Total income",                  bold: true  },
  { key: "staff_costs",                  label: "Staff costs",                   bold: false },
  { key: "other_expenses",               label: "Other expenses",                bold: false },
  { key: "total_expenses",               label: "Total expenses",                bold: true  },
  { key: "profit_before_impairments",    label: "Profit before impairments",     bold: true  },
  { key: "credit_impairments",           label: "Credit impairments",            bold: false },
  { key: "profit_before_tax",            label: "Profit before tax",             bold: true  },
  { key: "tax",                          label: "Tax",                           bold: false },
  { key: "net_profit",                   label: "Net profit",                    bold: true  },
];

const BALANCE_ROWS = [
  { key: "loans_to_customers",     label: "Loans to customers",     bold: false },
  { key: "deposits_from_customers",label: "Deposits from customers",bold: false },
  { key: "total_assets",           label: "Total assets",           bold: true  },
  { key: "total_equity",           label: "Total equity",           bold: true  },
  { key: "risk_exposure_amount",   label: "Risk exposure amount",   bold: false },
];

const RATIOS_ROWS = [
  { key: "return_on_equity_pct",        label: "Return on equity %",        bold: false },
  { key: "cost_income_ratio",           label: "Cost/income ratio",          bold: false },
  { key: "eps_diluted",                 label: "EPS diluted",                bold: false },
  { key: "cet1_capital_ratio_pct",      label: "CET1 capital ratio %",       bold: false },
  { key: "credit_impairment_ratio_pct", label: "Credit impairment ratio %",  bold: false },
  { key: "net_interest_margin_pct",     label: "Net interest margin %",      bold: false },
];

// ── Initialise once ───────────────────────────────────────

function initCompanyView() {
  if (_cvInitialized) return;
  _cvInitialized = true;

  // Period toggle
  document.querySelectorAll(".cv-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cv-toggle-btn").forEach(b =>
        b.classList.toggle("cv-toggle-btn--active", b === btn)
      );
      _activePeriod = btn.dataset.period;
      renderTables();
    });
  });

  // Tab bar
  document.querySelectorAll(".cv-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".cv-tab").forEach(t =>
        t.classList.toggle("cv-tab--active", t === tab)
      );
      _activeTab = tab.dataset.tab;
      document.querySelectorAll(".cv-panel").forEach(p => p.classList.add("hidden"));
      document.getElementById(`cv-panel-${_activeTab}`).classList.remove("hidden");
    });
  });

  // Company dropdown
  document.getElementById("cv-company-sel").addEventListener("change", e => {
    loadFinancials(e.target.value);
  });

  loadCompanies();
}

// ── Data loading ──────────────────────────────────────────

async function loadCompanies() {
  const sel = document.getElementById("cv-company-sel");
  sel.innerHTML = '<option value="">Loading…</option>';

  try {
    const resp = await fetch("/api/companies");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const companies = await resp.json();

    if (!Array.isArray(companies) || !companies.length) {
      sel.innerHTML = '<option value="">No companies available</option>';
      cvShowState("No companies found. Upload a report first.");
      return;
    }

    sel.innerHTML = companies
      .map(c => `<option value="${esc(c.company_name)}">${esc(c.company_name)}</option>`)
      .join("");

    loadFinancials(companies[0].company_name);
  } catch (err) {
    sel.innerHTML = '<option value="">Error</option>';
    cvShowState("Could not load companies: " + err.message);
  }
}

async function loadFinancials(company) {
  if (!company) return;
  cvShowState("Loading…");
  clearTables();

  try {
    const resp = await fetch(`/api/financials?company=${encodeURIComponent(company)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _financialData = await resp.json();
    cvHideState();
    renderTables();
  } catch (err) {
    cvShowState("Could not load financials: " + err.message);
  }
}

// ── Rendering ─────────────────────────────────────────────

function getFilteredPeriods() {
  const rows  = _financialData.filter(r => r.report_type === _activePeriod);
  const limit = _activePeriod === "quarterly" ? 12 : 5;
  return rows.slice(-limit);
}

function periodLabel(period, reportType) {
  if (!period) return "—";
  const parts  = period.split("_");
  const year   = parts[0];
  const suffix = (parts[1] || "").toLowerCase();
  if (reportType === "annual" || !suffix || suffix === "annual") return year;
  return suffix.toUpperCase() + " " + year;
}

function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function renderTables() {
  const periods = getFilteredPeriods();

  if (!periods.length) {
    const label = _activePeriod === "quarterly" ? "quarterly" : "annual";
    cvShowState(`No ${label} data available for this company.`);
    clearTables();
    return;
  }

  cvHideState();
  renderTable("cv-table-income",  INCOME_ROWS,  periods, "income_statement");
  renderTable("cv-table-balance", BALANCE_ROWS, periods, "balance_sheet");
  renderTable("cv-table-ratios",  RATIOS_ROWS,  periods, "key_ratios");
}

function renderTable(tableId, rowDefs, periods, dataKey) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const currency    = (periods[periods.length - 1] || {}).currency || "";
  const periodCols  = periods.map(p => periodLabel(p.period, p.report_type));
  const colCount    = periods.length;

  // thead: currency row + period-label row
  const thead = `
    <thead>
      <tr class="cv-currency-row">
        <th></th>
        <th colspan="${colCount}" class="cv-currency-cell">${esc(currency)}</th>
      </tr>
      <tr class="cv-period-row">
        <th></th>
        ${periodCols.map(lbl => `<th>${esc(lbl)}</th>`).join("")}
      </tr>
    </thead>`;

  // tbody: one row per metric
  let tbodyRows = "";
  for (const row of rowDefs) {
    let cells = `<td>${esc(row.label)}</td>`;
    for (const period of periods) {
      const obj = period[dataKey] || {};
      const val = obj[row.key];
      if (val === null || val === undefined) {
        cells += `<td class="cv-num">—</td>`;
      } else {
        const n       = Number(val);
        const negCls  = !isNaN(n) && n < 0 ? " cv-neg" : "";
        cells += `<td class="cv-num${negCls}">${esc(fmtNum(val))}</td>`;
      }
    }
    tbodyRows += `<tr class="${row.bold ? "cv-bold" : ""}">${cells}</tr>`;
  }

  table.innerHTML = thead + `<tbody>${tbodyRows}</tbody>`;
}

// ── State helpers ─────────────────────────────────────────

function cvShowState(msg) {
  const el = document.getElementById("cv-state-msg");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function cvHideState() {
  document.getElementById("cv-state-msg").classList.add("hidden");
}

function clearTables() {
  ["cv-table-income", "cv-table-balance", "cv-table-ratios"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });
}
