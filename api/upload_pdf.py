"""
upload_pdf.py — /api/upload endpoint logic.

Accepts JSON POST:
  company_name TEXT  required  (stored in the ticker column)
  report_type  TEXT  'annual' | 'quarterly'
  period       TEXT  e.g. '2024' or 'Q1 2025'
  pdf_text     TEXT  pre-extracted text from the PDF (done client-side via pdf.js)
  filename     TEXT  optional original filename

Stores in stock_pdf_store, clears analysis cache so the next /api/analyse runs fresh.
"""

import re
import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import request, jsonify

# Company names: letters, digits, spaces, hyphens, periods, ampersands — max 80 chars
COMPANY_RE = re.compile(r"^[A-Za-z0-9\s\-\.&,()]{1,80}$")
MIN_TEXT_LEN = 200


def handle_upload():
    print("[upload] handler reached")
    try:
        return _handle_upload_inner()
    except Exception as e:
        print(f"[upload] Unhandled exception: {traceback.format_exc()}")
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


def _handle_upload_inner():
    body = request.get_json(silent=True) or {}

    # Accept company_name (new) or ticker (legacy)
    company_name = (body.get("company_name") or body.get("ticker") or "").strip()
    report_type  = (body.get("report_type") or "").strip().lower()
    period       = (body.get("period") or "").strip()
    pdf_text     = (body.get("pdf_text") or "").strip()
    filename     = (body.get("filename") or "").strip()

    print(f"[upload] company={company_name!r} report_type={report_type!r} period={period!r} "
          f"filename={filename!r} pdf_text_len={len(pdf_text)}")

    if not company_name or not COMPANY_RE.match(company_name):
        return jsonify({"error": "Invalid or missing company name"}), 400
    if report_type not in ("annual", "quarterly"):
        return jsonify({"error": "report_type must be 'annual' or 'quarterly'"}), 400
    if not period:
        return jsonify({"error": "period is required (e.g. '2024' or 'Q1 2025')"}), 400
    if len(pdf_text) < MIN_TEXT_LEN:
        return jsonify({"error": "Extracted text too short — is this a scanned/image PDF?"}), 422

    from db import save_pdf_text, clear_analysis_cache, _get_client

    client = _get_client()
    if client is None:
        return jsonify({"error": "Database not configured — missing Supabase env vars on server"}), 500

    # company_name is stored in the ticker column
    try:
        saved = save_pdf_text(company_name, report_type, period, pdf_text, filename)
    except Exception as exc:
        tb = traceback.format_exc()
        print(f"[upload] save_pdf_text raised:\n{tb}")
        return jsonify({"error": f"Database error: {exc}", "trace": tb}), 500

    if not saved:
        return jsonify({"error": "Failed to save to database — check logs for details"}), 500

    clear_analysis_cache(company_name)

    return jsonify({
        "success":      True,
        "company_name": company_name,
        "report_type":  report_type,
        "period":       period,
        "chars":        len(pdf_text),
        "message":      f"{report_type.capitalize()} report ({period}) uploaded — {len(pdf_text):,} chars extracted.",
    })
