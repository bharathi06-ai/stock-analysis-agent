"""
financials.py — /api/financials endpoint.

GET /api/financials?company=SHB-A
Returns all financial records for the company ordered by period_date ascending.
"""

import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import jsonify, request


def handle_financials():
    try:
        return _handle_inner()
    except Exception as e:
        print(f"[financials] Unhandled exception: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500


def _handle_inner():
    from db import _get_client

    company = (request.args.get("company") or "").strip()
    if not company:
        return jsonify({"error": "company query parameter is required"}), 400

    client = _get_client()
    if client is None:
        return jsonify({"error": "Database not configured — missing Supabase env vars"}), 500

    try:
        resp = (
            client.table("financials")
            .select("*")
            .eq("company_name", company)
            .order("period_date", desc=False)
            .execute()
        )
    except Exception as exc:
        print(f"[financials] Supabase query error:\n{traceback.format_exc()}")
        return jsonify({"error": f"Database query failed: {exc}"}), 500

    return jsonify(resp.data or [])
