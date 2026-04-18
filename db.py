"""
db.py — Supabase caching layer for stock analysis results and PDF store.

Tables (already exist in Supabase):
    stock_ai_cache (
        ticker        TEXT PRIMARY KEY,
        analysis_json JSONB,
        data_hash     TEXT,
        generated_at  TIMESTAMPTZ
    )
    stock_pdf_store (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ticker      TEXT NOT NULL,
        report_type TEXT NOT NULL,   -- 'annual' | 'quarterly'
        period      TEXT NOT NULL,   -- e.g. '2024', 'Q1 2025'
        pdf_text    TEXT NOT NULL,
        uploaded_at TIMESTAMPTZ DEFAULT now()
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
    # Accept both naming conventions (local .env uses SUPABASE_ANON_KEY; Vercel may use SUPABASE_KEY)
    key = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_KEY")
    if not url or not key:
        print(f"[db] Missing env vars — SUPABASE_URL={'set' if url else 'MISSING'}, key={'set' if key else 'MISSING'}")
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


# ── PDF store ─────────────────────────────────────────────────────────────────

def save_pdf_text(ticker: str, report_type: str, period: str, pdf_text: str) -> bool:
    """
    Upsert one PDF's extracted text into stock_pdf_store.
    Matches on (ticker, report_type, period) — re-uploading the same period
    overwrites the previous text.
    """
    client = _get_client()
    if client is None:
        return False
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        # Delete existing row for the same (ticker, report_type, period) first,
        # then insert — Supabase free tier doesn't support composite upsert easily.
        client.table("stock_pdf_store") \
            .delete() \
            .eq("ticker", ticker) \
            .eq("report_type", report_type) \
            .eq("period", period) \
            .execute()
        client.table("stock_pdf_store").insert({
            "ticker":      ticker,
            "report_type": report_type,
            "period":      period,
            "pdf_text":    pdf_text,
            "uploaded_at": now_iso,
        }).execute()
        print(f"[db] Saved {report_type} PDF for {ticker} period={period} ({len(pdf_text):,} chars)")
        return True
    except Exception as exc:
        print(f"[db] save_pdf_text error: {exc}")
        return False


def get_pdf_texts(ticker: str) -> dict:
    """
    Fetch all uploaded PDFs for a ticker and return a dict structured
    identically to what fetch_reports() previously returned, so the
    rest of the pipeline (extract_financials_from_reports) needs no changes.

    Returns:
      {
        "success": bool,
        "company": str,
        "annual":  {"year": int, "url": "", "text": str} | None,
        "quarterly": [{"period": str, "url": "", "text": str}, ...]
      }
    """
    from pdf_fetcher import ticker_to_name
    company = ticker_to_name(ticker)

    client = _get_client()
    if client is None:
        return {"success": False, "company": company, "annual": None, "quarterly": []}

    try:
        resp = (
            client.table("stock_pdf_store")
            .select("report_type, period, pdf_text, uploaded_at")
            .eq("ticker", ticker)
            .order("uploaded_at", desc=True)
            .execute()
        )
        rows = resp.data or []

        annual = None
        quarterly = []
        seen_periods = set()

        for row in rows:
            rtype  = row["report_type"]
            period = row["period"]
            text   = row["pdf_text"] or ""

            if rtype == "annual" and annual is None:
                try:
                    year = int(period)
                except ValueError:
                    year = 0
                annual = {"year": year, "url": "", "text": text}

            elif rtype == "quarterly" and period not in seen_periods and len(quarterly) < 4:
                quarterly.append({"period": period, "url": "", "text": text})
                seen_periods.add(period)

        print(f"[db] PDF store for {ticker}: annual={'found' if annual else 'missing'}, "
              f"quarterly={len(quarterly)}")
        return {
            "success":   True,
            "company":   company,
            "annual":    annual,
            "quarterly": quarterly,
        }
    except Exception as exc:
        print(f"[db] get_pdf_texts error: {exc}")
        return {"success": False, "company": company, "annual": None, "quarterly": []}


def clear_analysis_cache(ticker: str) -> None:
    """Delete cached analysis for a ticker so the next run fetches fresh data."""
    print(f"[db] clear_analysis_cache called for {ticker}")
    client = _get_client()
    if client is None:
        print(f"[db] clear_analysis_cache: Supabase client is None — cache NOT cleared")
        return
    try:
        resp = client.table("stock_ai_cache").delete().eq("ticker", ticker).execute()
        deleted = len(resp.data) if resp.data else 0
        print(f"[db] clear_analysis_cache: deleted {deleted} row(s) for {ticker}")
    except Exception as exc:
        print(f"[db] clear_analysis_cache error: {exc}")


# ── Analysis cache ─────────────────────────────────────────────────────────────

def is_cache_valid(ticker: str, max_age_hours: int = 24) -> bool:
    client = _get_client()
    if client is None:
        print(f"[db] is_cache_valid: Supabase client is None — returning False")
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
        valid = age < timedelta(hours=max_age_hours)
        print(f"[db] Cache for {ticker}: age={int(age.total_seconds()//3600)}h, max={max_age_hours}h, valid={valid}")
        return valid
    except Exception as exc:
        print(f"[db] is_cache_valid error: {exc}")
        return False
