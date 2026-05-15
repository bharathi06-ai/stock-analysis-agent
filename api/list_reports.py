"""
list_reports.py — /api/list_reports endpoint.

Returns all companies from stock_pdf_store grouped by company_name (stored in
the ticker column), annotated with whether each has been analysed
(exists in stock_ai_cache).
"""

import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import jsonify


def handle_list_reports():
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
        # All PDFs (company_name stored in ticker column)
        pdf_resp = (
            client.table("stock_pdf_store")
            .select("ticker, period, report_type, filename, uploaded_at")
            .order("ticker", desc=False)
            .order("uploaded_at", desc=True)
            .execute()
        )
        # All analysed entries (one row per company/period/type)
        cache_resp = (
            client.table("stock_ai_cache")
            .select("ticker, generated_at")
            .execute()
        )
    except Exception as exc:
        print(f"[list_reports] Supabase query error:\n{traceback.format_exc()}")
        return jsonify({"error": f"Database query failed: {exc}"}), 500

    # Build analysed set and latest generated_at per company
    analysed_set: set = set()
    analysed_dates: dict = {}
    for row in (cache_resp.data or []):
        t = row["ticker"]
        analysed_set.add(t)
        g = row.get("generated_at") or ""
        if t not in analysed_dates or g > analysed_dates[t]:
            analysed_dates[t] = g

    # Group PDFs by company_name (ticker column)
    company_map: dict = {}
    for row in (pdf_resp.data or []):
        name = row["ticker"]
        if name not in company_map:
            company_map[name] = []
        company_map[name].append({
            "period":      row.get("period") or "",
            "report_type": row.get("report_type") or "",
            "filename":    row.get("filename") or "",
            "uploaded_at": row.get("uploaded_at") or "",
        })

    # Also include companies that are in cache but not in pdf_store
    for name in analysed_set:
        if name not in company_map:
            company_map[name] = []

    companies = [
        {
            "company_name": name,
            "analysed":     name in analysed_set,
            "last_updated": analysed_dates.get(name, ""),
            "reports":      reports,
        }
        for name, reports in sorted(company_map.items())
    ]

    return jsonify({"companies": companies})
