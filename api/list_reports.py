"""
list_reports.py — /api/list_reports endpoint.

Queries the reports table joined with companies to get sector.
Returns a flat JSON array ordered by uploaded_at descending.
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
        resp = (
            client.table("reports")
            .select("id, company_name, period, report_type, uploaded_at, companies(sector)")
            .order("uploaded_at", desc=True)
            .execute()
        )
    except Exception as exc:
        print(f"[list_reports] Supabase query error:\n{traceback.format_exc()}")
        return jsonify({"error": f"Database query failed: {exc}"}), 500

    rows = []
    for row in (resp.data or []):
        sector = ""
        if isinstance(row.get("companies"), dict):
            sector = row["companies"].get("sector") or ""
        rows.append({
            "id":           row.get("id") or "",
            "company_name": row.get("company_name") or "",
            "sector":       sector,
            "period":       row.get("period") or "",
            "report_type":  row.get("report_type") or "",
            "uploaded_at":  row.get("uploaded_at") or "",
        })

    return jsonify(rows)
