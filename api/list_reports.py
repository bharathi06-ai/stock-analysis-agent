"""
list_reports.py — /api/list_reports endpoint.

Returns all entries from stock_ai_cache grouped by ticker,
without fetching extracted_data (too large).
"""

import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import jsonify


def handle_list_reports():
    """Call this from the Flask route."""
    try:
        return _handle_list_reports_inner()
    except Exception as e:
        print(f"[list_reports] Unhandled exception: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500


def _handle_list_reports_inner():
    from db import _get_client

    client = _get_client()
    if client is None:
        return jsonify({"error": "Database not configured — missing Supabase env vars"}), 500

    try:
        cache_resp = (
            client.table("stock_ai_cache")
            .select("ticker, period, report_type, generated_at")
            .order("ticker", desc=False)
            .order("period", desc=False)
            .execute()
        )
        pdf_resp = (
            client.table("stock_pdf_store")
            .select("ticker, period, report_type, filename")
            .execute()
        )
    except Exception as exc:
        print(f"[list_reports] Supabase query error:\n{traceback.format_exc()}")
        return jsonify({"error": f"Database query failed: {exc}"}), 500

    # Build filename lookup keyed by (ticker, period, report_type)
    filename_lookup: dict = {}
    for row in (pdf_resp.data or []):
        key = (row["ticker"], row.get("period", ""), row.get("report_type", ""))
        filename_lookup[key] = row.get("filename")

    rows = cache_resp.data or []

    # Group by ticker, preserving alphabetical order
    ticker_map: dict = {}
    for row in rows:
        t = row["ticker"]
        period      = row.get("period")      or ""
        report_type = row.get("report_type") or ""
        key         = (t, period, report_type)
        if t not in ticker_map:
            ticker_map[t] = []
        ticker_map[t].append({
            "period":      period,
            "report_type": report_type,
            "filename":    filename_lookup.get(key),
            "created_at":  row.get("generated_at") or "",
        })

    tickers = [
        {"ticker": t, "reports": reports}
        for t, reports in sorted(ticker_map.items())
    ]

    return jsonify({"tickers": tickers})
