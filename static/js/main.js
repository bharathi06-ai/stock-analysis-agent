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
