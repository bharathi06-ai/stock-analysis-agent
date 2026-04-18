"""
db.py — Supabase caching layer for stock analysis results.

Table schema (already exists in Supabase):
    stock_ai_cache (
        ticker       TEXT PRIMARY KEY,
        analysis_json JSONB,
        data_hash    TEXT,
        generated_at TIMESTAMPTZ
    )

All functions degrade gracefully: if SUPABASE_URL / SUPABASE_ANON_KEY are
absent, or if the Supabase call fails, they return None / False so the
pipeline continues without caching.
"""

import hashlib
import json
import os
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv

load_dotenv()

_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        return None

    try:
        from supabase import create_client
        _client = create_client(url, key)
        return _client
    except Exception as exc:
        print(f"[db] Supabase client init failed: {exc}")
        return None


def get_cached_analysis(ticker: str) -> dict | None:
    client = _get_client()
    if client is None:
        return None

    try:
        resp = (
            client.table("stock_ai_cache")
            .select("analysis_json")
            .eq("ticker", ticker)
            .limit(1)
            .execute()
        )
        rows = resp.data
        if rows and rows[0].get("analysis_json"):
            print(f"[db] Cache hit for {ticker}")
            return rows[0]["analysis_json"]
        return None
    except Exception as exc:
        print(f"[db] get_cached_analysis error: {exc}")
        return None


def save_analysis(ticker: str, data: dict) -> None:
    client = _get_client()
    if client is None:
        return

    try:
        payload_str = json.dumps(data, ensure_ascii=False, sort_keys=True)
        data_hash = hashlib.md5(payload_str.encode()).hexdigest()
        now_iso = datetime.now(timezone.utc).isoformat()

        client.table("stock_ai_cache").upsert(
            {
                "ticker": ticker,
                "analysis_json": data,
                "data_hash": data_hash,
                "generated_at": now_iso,
            },
            on_conflict="ticker",
        ).execute()
        print(f"[db] Saved analysis for {ticker} (hash={data_hash[:8]}…)")
    except Exception as exc:
        print(f"[db] save_analysis error: {exc}")


def is_cache_valid(ticker: str, max_age_days: int = 90) -> bool:
    return False  # temporarily disabled to force fresh data
    client = _get_client()
    if client is None:
        return False

    try:
        resp = (
            client.table("stock_ai_cache")
            .select("generated_at")
            .eq("ticker", ticker)
            .limit(1)
            .execute()
        )
        rows = resp.data
        if not rows or not rows[0].get("generated_at"):
            return False

        generated_at = datetime.fromisoformat(rows[0]["generated_at"])
        if generated_at.tzinfo is None:
            generated_at = generated_at.replace(tzinfo=timezone.utc)

        age = datetime.now(timezone.utc) - generated_at
        valid = age < timedelta(days=max_age_days)
        print(f"[db] Cache for {ticker}: age={age.days}d, max={max_age_days}d, valid={valid}")
        return valid
    except Exception as exc:
        print(f"[db] is_cache_valid error: {exc}")
        return False
