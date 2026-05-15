"""
companies.py — /api/companies endpoint.

Returns all companies ordered alphabetically: [{ company_name, sector }, ...]
"""

import sys
import os
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import jsonify


def handle_companies():
    try:
        return _handle_inner()
    except Exception as e:
        print(f"[companies] Unhandled exception: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500


def _handle_inner():
    from db import _get_client

    client = _get_client()
    if client is None:
        return jsonify({"error": "Database not configured — missing Supabase env vars"}), 500

    try:
        resp = (
            client.table("companies")
            .select("company_name, sector")
            .order("company_name")
            .execute()
        )
    except Exception as exc:
        print(f"[companies] Supabase query error:\n{traceback.format_exc()}")
        return jsonify({"error": f"Database query failed: {exc}"}), 500

    rows = [
        {"company_name": r.get("company_name") or "", "sector": r.get("sector") or ""}
        for r in (resp.data or [])
    ]
    return jsonify(rows)
