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
        resp = (
            client.table("stock_ai_cache")
            .select("ticker, period, report_type, filename, generated_at")
            .order("ticker", desc=False)
            .order("period", desc=False)
            .execute()
        )
    except Exception as exc:
        print(f"[list_reports] Supabase query error:\n{traceback.format_exc()}")
        return jsonify({"error": f"Database query failed: {exc}"}), 500

    rows = resp.data or []

    # Group by ticker, preserving alphabetical order
    ticker_map: dict = {}
    for row in rows:
        t = row["ticker"]
        if t not in ticker_map:
            ticker_map[t] = []
        ticker_map[t].append({
            "period":      row.get("period")      or "",
            "report_type": row.get("report_type") or "",
            "filename":    row.get("filename")    or "",
            "created_at":  row.get("generated_at") or row.get("created_at") or "",
        })

    tickers = [
        {"ticker": t, "reports": reports}
        for t, reports in sorted(ticker_map.items())
    ]

    return jsonify({"tickers": tickers})
