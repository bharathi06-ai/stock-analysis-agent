"""
pdf_fetcher.py — Phase 2

Finds, downloads, and extracts text from Swedish company annual/quarterly
report PDFs.

Strategy
--------
1. One Claude call (with web_search) that finds ALL report URLs at once.
   Returns a JSON block with annual + quarterly PDF URLs.
2. Download each PDF with requests.
3. Extract text with pdfplumber.
"""

import io
import json
import os
import re
import time
from datetime import date
import requests
import pdfplumber
import anthropic
from dotenv import load_dotenv

load_dotenv()


# ── Company name lookup ───────────────────────────────────────────────────────

KNOWN_COMPANIES = {
    "NDA-SE.ST":  "Nordea Bank",
    "ERIC-B.ST":  "Ericsson",
    "VOLV-B.ST":  "Volvo Group",
    "INVE-B.ST":  "Investor AB",
    "SEB-A.ST":   "SEB",
    "SWED-A.ST":  "Swedbank",
    "ATCO-A.ST":  "Atlas Copco",
    "HM-B.ST":    "H&M Group",
    "SAND.ST":    "Sandvik",
    "SKF-B.ST":   "SKF",
    "ALFA.ST":    "Alfa Laval",
    "AZN.ST":     "AstraZeneca",
    "BOL.ST":     "Boliden",
    "ASSA-B.ST":  "Assa Abloy",
}


def ticker_to_name(ticker: str) -> str:
    t = ticker.upper().strip()
    if t in KNOWN_COMPANIES:
        return KNOWN_COMPANIES[t]
    base = re.sub(r"-[A-Z]$", "", t.replace(".ST", "").replace("-SE", ""))
    return base


# ── URL cache (avoids repeated haiku calls for the same company) ──────────────

_URL_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".yf_cache")


def _url_cache_path(company: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", company)
    return os.path.join(_URL_CACHE_DIR, f"urls_{safe}.json")


def _load_url_cache(company: str) -> dict | None:
    path = _url_cache_path(company)
    try:
        if os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            if age < 24 * 3600:   # 24-hour TTL — PDF URLs don't change daily
                with open(path) as f:
                    data = json.load(f)
                print(f"  [claude] Using cached PDF URLs (age {int(age//3600)}h)")
                return data
    except Exception:
        pass
    return None


def _save_url_cache(company: str, data: dict) -> None:
    os.makedirs(_URL_CACHE_DIR, exist_ok=True)
    try:
        with open(_url_cache_path(company), "w") as f:
            json.dump(data, f)
    except Exception:
        pass


# ── Dynamic year / quarter helpers ───────────────────────────────────────────

def _annual_year_keys() -> list[str]:
    """Return [current_year_key, prev_year_key] e.g. ['annual_2026', 'annual_2025']."""
    today = date.today()
    return [f"annual_{today.year}", f"annual_{today.year - 1}"]


def _recent_quarters(n: int = 4) -> list[str]:
    """
    Return the n most recently *completed* quarter labels, newest first.
    E.g. on 2026-04-12 → ['Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025']
    """
    today = date.today()
    # Quarter the current month belongs to (1-based)
    current_q = (today.month - 1) // 3 + 1
    # Step back one quarter to the last *completed* one
    q, y = current_q - 1, today.year
    if q == 0:
        q, y = 4, y - 1
    labels = []
    for _ in range(n):
        labels.append(f"Q{q} {y}")
        q -= 1
        if q == 0:
            q, y = 4, y - 1
    return labels


# ── Single Claude call to find ALL report URLs ────────────────────────────────

def find_report_urls(company: str) -> dict:
    """
    Ask Claude (with web_search) to find annual + quarterly report PDF URLs
    for a Swedish company in ONE call. Years are computed dynamically from
    today's date — no hardcoded year literals.

    Returns:
      {
        "annual_2026": "https://...",   # or null  (current year)
        "annual_2025": "https://...",   # fallback  (previous year)
        "quarterly": [
          {"period": "Q1 2026", "url": "https://..."},
          ...
        ]
      }
    """
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    year_keys   = _annual_year_keys()           # e.g. ['annual_2026', 'annual_2025']
    quarters    = _recent_quarters(n=4)         # e.g. ['Q1 2026', 'Q4 2025', ...]
    annual_years = [k.split("_")[1] for k in year_keys]   # ['2026', '2025']

    annual_json  = "\n  ".join(f'"{k}": "URL or null",' for k in year_keys)
    quarterly_json = "\n    ".join(
        f'{{"period": "{q}", "url": "URL or null"}},' for q in quarters
    )

    prompt = f"""You are a financial research assistant. Search the web and find direct PDF download URLs for {company}'s investor reports.

Find:
1. The most recent annual report PDF ({annual_years[0]} preferred, {annual_years[1]} as fallback)
2. The 4 most recent quarterly/interim report PDFs

Search the company's official investor relations page and any direct PDF links.

Respond ONLY with a JSON object in this exact format (no other text):
{{
  {annual_json}
  "quarterly": [
    {quarterly_json}
  ]
}}

Use null (not "null") for any URL you cannot find. Only include real, direct .pdf URLs."""

    # Return cached URLs if available (avoids repeated haiku calls)
    cached = _load_url_cache(company)
    if cached:
        return cached

    print(f"  [claude] Searching for {company} report URLs...")
    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1000,
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
            messages=[{"role": "user", "content": prompt}],
        )

        # Extract text from all content blocks
        full_text = ""
        for block in response.content:
            if hasattr(block, "text") and block.text:
                full_text += block.text

        # Parse JSON from response
        json_match = re.search(r"\{[\s\S]*\}", full_text)
        if json_match:
            data = json.loads(json_match.group())
            print(f"  [claude] Response received, parsing URLs...")
            _save_url_cache(company, data)
            return data

    except json.JSONDecodeError as e:
        print(f"  [claude] JSON parse error: {e}\n  Raw: {full_text[:300]}")
    except Exception as e:
        print(f"  [claude] Error: {e}")

    # Return empty structure on failure
    return {k: None for k in _annual_year_keys()} | {"quarterly": []}


# ── HTTP download ─────────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
    ),
}


def _download_pdf(url: str, timeout: int = 30) -> bytes | None:
    """Download URL and return bytes if it is a PDF, else None."""
    if not url or url == "null":
        return None
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "").lower()
        if "pdf" in ct or resp.content[:4] == b"%PDF":
            return resp.content
        print(f"    [not a pdf] content-type: {ct}, url: {url}")
    except Exception as e:
        print(f"    [download error] {url}: {e}")
    return None


# ── Text extraction ───────────────────────────────────────────────────────────

def _extract_text(pdf_bytes: bytes, max_pages: int = 40) -> str:
    """Extract and clean text from PDF bytes using pdfplumber."""
    parts = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            n = min(len(pdf.pages), max_pages)
            for page in pdf.pages[:n]:
                t = page.extract_text()
                if t:
                    parts.append(t)
    except Exception as e:
        print(f"    [pdfplumber error] {e}")

    text = "\n\n".join(parts)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ── Main entry point ──────────────────────────────────────────────────────────

def get_company_reports(ticker: str) -> dict:
    """
    Fetch all available reports for a ticker.
    Returns:
      { ticker, company, annual, quarterly, summary }
    """
    company = ticker_to_name(ticker)
    print(f"\n{'='*60}")
    print(f"Fetching reports: {ticker}  ({company})")
    print(f"{'='*60}")

    # One Claude call to get all URLs
    urls = find_report_urls(company)

    # ── Annual report ──
    annual = None
    for year_key in _annual_year_keys():
        url = urls.get(year_key)
        if not url or url == "null":
            continue
        year = int(year_key.split("_")[1])
        print(f"\n  [annual {year}] Downloading: {url}")
        pdf_bytes = _download_pdf(url)
        if pdf_bytes:
            text = _extract_text(pdf_bytes, max_pages=40)
            if len(text) > 500:
                print(f"  OK — {len(text):,} chars extracted")
                annual = {
                    "type": "annual",
                    "year": year,
                    "url": url,
                    "text": text,
                    "char_count": len(text),
                }
                break
        print(f"  [annual {year}] download failed or empty")

    # ── Quarterly reports ──
    quarterly = []
    for item in urls.get("quarterly", []):
        url = item.get("url")
        period = item.get("period", "")
        if not url or url == "null":
            print(f"  [quarterly] {period}: no URL found")
            continue
        print(f"\n  [quarterly {period}] Downloading: {url}")
        pdf_bytes = _download_pdf(url)
        if pdf_bytes:
            text = _extract_text(pdf_bytes, max_pages=20)
            if len(text) > 300:
                print(f"  OK — {len(text):,} chars")
                quarterly.append({
                    "type": "quarterly",
                    "quarter": period,
                    "url": url,
                    "text": text,
                    "char_count": len(text),
                })
            else:
                print(f"  [quarterly {period}] too little text ({len(text)} chars)")
        else:
            print(f"  [quarterly {period}] download failed")

    total_chars = (annual["char_count"] if annual else 0) + sum(
        q["char_count"] for q in quarterly
    )

    return {
        "ticker": ticker,
        "company": company,
        "annual": annual,
        "quarterly": quarterly,
        "summary": {
            "annual_found": annual is not None,
            "quarterly_found": len(quarterly),
            "total_chars": total_chars,
        },
    }


# ── Quick test ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    result = get_company_reports("NDA-SE.ST")

    print(f"\n{'='*60}")
    print("TEST RESULTS")
    print(f"{'='*60}")
    print(f"Ticker  : {result['ticker']}")
    print(f"Company : {result['company']}")
    print(f"Annual  : {'FOUND ✓' if result['annual'] else 'NOT FOUND ✗'}")
    if result["annual"]:
        print(f"  URL   : {result['annual']['url']}")
        print(f"  Chars : {result['annual']['char_count']:,}")
        print(f"  Preview (first 500 chars):")
        print("  " + result["annual"]["text"][:500].replace("\n", "\n  "))
    print(f"\nQuarterly reports found: {result['summary']['quarterly_found']}")
    for q in result["quarterly"]:
        print(f"  {q['quarter']}: {q['char_count']:,} chars — {q['url']}")
    print(f"\nTotal text extracted: {result['summary']['total_chars']:,} chars")
