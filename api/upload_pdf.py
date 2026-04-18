"""
upload_pdf.py — /api/upload endpoint logic.

Accepts multipart/form-data POST:
  ticker      TEXT  required
  report_type TEXT  'annual' | 'quarterly'
  period      TEXT  e.g. '2024' or 'Q1 2025'
  pdf         FILE  .pdf binary

Extracts text server-side with pdfplumber, stores in stock_pdf_store,
clears the analysis cache so the next /api/analyse runs fresh.
"""

import io
import re
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pdfplumber
from flask import request, jsonify

TICKER_RE = re.compile(r"^[A-Za-z0-9\-\.]{1,20}$")
MAX_PDF_BYTES = 30 * 1024 * 1024   # 30 MB hard cap
MAX_PAGES     = 60                  # pages to extract


def _extract_text(pdf_bytes: bytes) -> str:
    parts = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            n = min(len(pdf.pages), MAX_PAGES)
            for page in pdf.pages[:n]:
                t = page.extract_text()
                if t:
                    parts.append(t)
    except Exception as e:
        raise ValueError(f"PDF text extraction failed: {e}")
    text = "\n\n".join(parts)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) < 200:
        raise ValueError("Extracted text too short — is this a scanned/image PDF?")
    return text


def handle_upload():
    """Call this from the Flask route."""
    ticker      = (request.form.get("ticker") or "").strip().upper()
    report_type = (request.form.get("report_type") or "").strip().lower()
    period      = (request.form.get("period") or "").strip()
    pdf_file    = request.files.get("pdf")

    # ── Validate ──────────────────────────────────────────────────────────────
    if not ticker or not TICKER_RE.match(ticker):
        return jsonify({"error": "Invalid or missing ticker"}), 400
    if report_type not in ("annual", "quarterly"):
        return jsonify({"error": "report_type must be 'annual' or 'quarterly'"}), 400
    if not period:
        return jsonify({"error": "period is required (e.g. '2024' or 'Q1 2025')"}), 400
    if pdf_file is None or pdf_file.filename == "":
        return jsonify({"error": "No PDF file provided"}), 400

    pdf_bytes = pdf_file.read()
    if len(pdf_bytes) == 0:
        return jsonify({"error": "Uploaded file is empty"}), 400
    if len(pdf_bytes) > MAX_PDF_BYTES:
        return jsonify({"error": f"PDF exceeds {MAX_PDF_BYTES // (1024*1024)} MB limit"}), 400

    # ── Extract text ──────────────────────────────────────────────────────────
    try:
        pdf_text = _extract_text(pdf_bytes)
    except ValueError as e:
        return jsonify({"error": str(e)}), 422

    # ── Store in Supabase ─────────────────────────────────────────────────────
    from db import save_pdf_text, clear_analysis_cache
    saved = save_pdf_text(ticker, report_type, period, pdf_text)
    if not saved:
        return jsonify({"error": "Failed to save to database — check Supabase connection"}), 500

    # Invalidate cached analysis so next /api/analyse runs fresh
    clear_analysis_cache(ticker)

    return jsonify({
        "success":     True,
        "ticker":      ticker,
        "report_type": report_type,
        "period":      period,
        "chars":       len(pdf_text),
        "message":     f"{report_type.capitalize()} report ({period}) uploaded — {len(pdf_text):,} chars extracted. Run analysis to refresh.",
    })
