"""
upload_pdf.py — /api/upload endpoint logic.

Accepts JSON POST:
  ticker      TEXT  required
  report_type TEXT  'annual' | 'quarterly'
  period      TEXT  e.g. '2024' or 'Q1 2025'
  pdf_text    TEXT  pre-extracted text from the PDF (done client-side via pdf.js)

Stores in stock_pdf_store, clears analysis cache so the next /api/analyse runs fresh.
"""

import re
import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import request, jsonify

TICKER_RE = re.compile(r"^[A-Za-z0-9\-\.]{1,20}$")
MIN_TEXT_LEN = 200


def handle_upload():
    """Call this from the Flask route."""
    try:
        return _handle_upload_inner()
    except Exception as e:
        print(f"[upload] Unhandled exception: {traceback.format_exc()}")
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


def _handle_upload_inner():
    print("[upload] handler reached — parsing request body")
    body = request.get_json(silent=True) or {}

    ticker      = (body.get("ticker") or "").strip().upper()
    report_type = (body.get("report_type") or "").strip().lower()
    period      = (body.get("period") or "").strip()
    pdf_text    = (body.get("pdf_text") or "").strip()

    print(f"[upload] ticker={ticker!r} report_type={report_type!r} period={period!r} pdf_text_len={len(pdf_text)}")

    if not ticker or not TICKER_RE.match(ticker):
        return jsonify({"error": "Invalid or missing ticker"}), 400
    if report_type not in ("annual", "quarterly"):
        return jsonify({"error": "report_type must be 'annual' or 'quarterly'"}), 400
    if not period:
        return jsonify({"error": "period is required (e.g. '2024' or 'Q1 2025')"}), 400
    if len(pdf_text) < MIN_TEXT_LEN:
        return jsonify({"error": "Extracted text too short — is this a scanned/image PDF?"}), 422

    print("[upload] validation passed — importing db")
    from db import save_pdf_text, clear_analysis_cache, _get_client

    client = _get_client()
    print(f"[upload] Supabase client={'OK' if client else 'None (env vars missing?)'}")
    if client is None:
        return jsonify({"error": "Database not configured — missing Supabase env vars on server"}), 500

    print(f"[upload] calling save_pdf_text for {ticker}")
    try:
        saved = save_pdf_text(ticker, report_type, period, pdf_text)
    except Exception as exc:
        tb = traceback.format_exc()
        print(f"[upload] save_pdf_text raised:\n{tb}")
        return jsonify({"error": f"Database error: {exc}", "trace": tb}), 500

    print(f"[upload] save_pdf_text returned {saved}")
    if not saved:
        return jsonify({"error": "Failed to save to database — check Vercel logs for details"}), 500

    clear_analysis_cache(ticker)

    return jsonify({
        "success":     True,
        "ticker":      ticker,
        "report_type": report_type,
        "period":      period,
        "chars":       len(pdf_text),
        "message":     f"{report_type.capitalize()} report ({period}) uploaded — {len(pdf_text):,} chars extracted. Run analysis to refresh.",
    })
