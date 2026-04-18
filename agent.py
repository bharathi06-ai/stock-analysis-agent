"""
agent.py — Phase 4 (PDF-primary pipeline)

Data source hierarchy
─────────────────────
  yfinance   → price, 52-week, market cap, chart, beta, institutional holders
  PDF annual → P&L (5 years), Balance Sheet (5 years), Cash Flow (5 years), Ratios
  PDF qtly   → Quarterly P&L (last 8 quarters)
  web_search → News, Peer companies
  Claude     → Investment analysis, risks, opportunities, recommendation

Flow
────
  1. get_price_data()             → live price + chart (yfinance)
  2. fetch_reports()              → PDF text (annual + quarterly)
  3. extract_financials()         → structured financials from PDF text (Claude)
  4. search_news()                → recent news (Claude + web_search)
  5. find_peers()                 → peer companies (Claude + web_search)
  6. generate_analysis()          → analysis text + recommendation (Claude)
  7. compute_ratios()             → P/E, P/B, P/S from PDF data + live price
  8. assemble dashboard JSON
"""

import json
import os
import re
from datetime import datetime, timezone

import anthropic
from dotenv import load_dotenv

from pdf_fetcher import get_company_reports
from tools import (
    get_price_data,
    fetch_reports,
    extract_financials_from_reports,
    search_news,
    find_peers,
    _r,
)
from db import get_cached_analysis, save_analysis, is_cache_valid

load_dotenv()


# ══════════════════════════════════════════════════════════════════════════════
#  Step 6 — Investment analysis (pure Claude, no tool use)
# ══════════════════════════════════════════════════════════════════════════════

def generate_analysis(
    company_name: str,
    ticker: str,
    price_data: dict,
    pdf_financials: dict,
    news: list,
    peers: list,
) -> dict:
    """
    Generate professional investment analysis using the structured financial data.
    Returns: {analysis, risks, opportunities, recommendation}
    """
    mkt = price_data["market"]
    pl  = pdf_financials.get("profit_loss", [])
    bs  = pdf_financials.get("balance_sheet", [])
    kr  = pdf_financials.get("key_ratios", {})

    # Build a compact financial summary for the prompt
    fin_summary_rows = []
    for row in pl[:3]:
        fin_summary_rows.append(
            f"  {row.get('year')}: revenue={row.get('revenue')} MSEK, "
            f"net_income={row.get('net_income')} MSEK, EPS={row.get('eps')} SEK"
        )
    fin_summary = "\n".join(fin_summary_rows) if fin_summary_rows else "  (not available)"

    latest_bs = bs[0] if bs else {}
    bs_summary = (
        f"  Total assets: {latest_bs.get('total_assets')} MSEK | "
        f"Equity: {latest_bs.get('equity')} MSEK | "
        f"Cash: {latest_bs.get('cash')} MSEK"
    )

    ratios_summary = (
        f"  ROE: {kr.get('roe_pct')}% | Net margin: {kr.get('net_margin_pct')}% | "
        f"Dividend/share: {kr.get('dividend_per_share')} SEK | "
        f"Payout ratio: {kr.get('payout_ratio_pct')}%"
    )

    prompt = f"""You are a senior Swedish equity analyst at a major Nordic investment bank.

COMPANY: {company_name} ({ticker}) — Nasdaq Stockholm

LIVE MARKET DATA (from yfinance):
  Price: {mkt.get('price')} {mkt.get('currency', 'SEK')}
  Market cap: {round(mkt.get('market_cap_m', 0) / 1000, 1) if mkt.get('market_cap_m') else 'N/A'} BSEK
  52-week range: {mkt.get('week_52_low')} – {mkt.get('week_52_high')} SEK
  Beta: {mkt.get('beta')}

FINANCIAL PERFORMANCE (from company's own published reports):
{fin_summary}

BALANCE SHEET (latest year, from annual report):
{bs_summary}

KEY RATIOS (from annual report):
{ratios_summary}

RECENT NEWS:
{json.dumps(news[:5], ensure_ascii=False, indent=2)}

PEER COMPANIES:
{json.dumps(peers[:5], ensure_ascii=False, indent=2)}

Return ONLY valid JSON (no markdown, no extra text):
{{
  "verdict": "2-3 sentences in plain, simple English for someone who is NOT a financial expert. Explain what the company does, why you rate it Buy/Hold/Sell, and one key thing to watch. No jargon.",
  "key_strengths": [
    "3 plain-English strengths. Avoid jargon. Example: 'Pays investors a 6% dividend every year — well above the bank average'",
    "strength 2",
    "strength 3"
  ],
  "key_risks": [
    "3 plain-English risks. Explain clearly. Example: 'If interest rates fall, the bank earns less on loans and profits could shrink'",
    "risk 2",
    "risk 3"
  ],
  "analysis": "Four professional paragraphs: (1) business model and market position, (2) financial performance and health based on the report data, (3) competitive landscape and peer comparison, (4) outlook, catalysts and key considerations.",
  "risks": ["4 specific technical investment risks"],
  "opportunities": ["3 specific growth or value opportunities"],
  "recommendation": {{
    "rating": "Buy|Hold|Sell",
    "rationale": "One concise sentence justifying the rating."
  }}
}}"""

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    print("  [analysis] Generating investment analysis…")

    try:
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = "".join(getattr(b, "text", "") or "" for b in resp.content).strip()

        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw.strip())
        start = raw.find("{")
        if start > 0:
            raw = raw[start:]

        decoder = json.JSONDecoder()
        result, _ = decoder.raw_decode(raw)
        print("  [analysis] OK")
        return result

    except Exception as e:
        print(f"  [analysis] Error: {e}")
        return {
            "analysis": "Analysis unavailable.",
            "risks": [],
            "opportunities": [],
            "recommendation": {"rating": "Hold", "rationale": "Analysis incomplete."},
        }


# ══════════════════════════════════════════════════════════════════════════════
#  Step 7 — Compute ratios
#  P/E, P/B, P/S derived from PDF financials + live price.
#  Everything else comes directly from the annual report.
# ══════════════════════════════════════════════════════════════════════════════

def compute_ratios(price_data: dict, pdf_financials: dict) -> dict:
    """
    Build the ratios dict for the dashboard.
    Valuation multiples (P/E, P/B, P/S) are computed from PDF data + yfinance price.
    All margin / profitability / leverage ratios come directly from the annual report.
    """
    mkt          = price_data["market"]
    price        = mkt.get("price")
    market_cap_m = mkt.get("market_cap_m")

    pl = pdf_financials.get("profit_loss", [])
    bs = pdf_financials.get("balance_sheet", [])
    kr = pdf_financials.get("key_ratios", {})

    latest_pl = pl[0] if pl else {}
    latest_bs = bs[0] if bs else {}

    eps       = latest_pl.get("eps")
    revenue_m = latest_pl.get("revenue")   # MSEK
    equity_m  = latest_bs.get("equity")    # MSEK
    bvps      = latest_bs.get("book_value_per_share")
    shares_m  = kr.get("shares_outstanding_m")   # millions

    # Derive book value per share if not in PDF
    # equity is MSEK, shares_m is millions → BVPS = equity / shares_m  (both ×10^6 cancel)
    if not bvps and equity_m and shares_m and shares_m > 0:
        bvps = _r(equity_m / shares_m, 2)

    # Valuation multiples (need live price)
    pe = _r(price / eps,            2) if price and eps       and eps       > 0 else None
    pb = _r(price / bvps,           2) if price and bvps      and bvps      > 0 else None
    ps = _r(market_cap_m / revenue_m, 2) if market_cap_m and revenue_m and revenue_m > 0 else None

    # Dividend yield from PDF DPS + live price
    dps      = kr.get("dividend_per_share")
    div_yield = _r(dps / price * 100, 2) if dps and price and price > 0 else None

    return {
        # Valuation — computed from PDF + price
        "pe":               pe,
        "forward_pe":       None,        # not in PDFs
        "pb":               pb,
        "ps":               ps,
        # From annual report directly
        "roe":              kr.get("roe_pct"),
        "roa":              kr.get("roa_pct"),
        "gross_margin":     kr.get("gross_margin_pct"),
        "operating_margin": kr.get("operating_margin_pct"),
        "net_margin":       kr.get("net_margin_pct"),
        "current_ratio":    kr.get("current_ratio"),
        "debt_to_equity":   kr.get("debt_to_equity"),
        "payout_ratio":     kr.get("payout_ratio_pct"),
        # Dividend yield computed from PDF DPS + price
        "dividend_yield":   div_yield,
        "dividend_per_share": dps,
        # Per share — from PDF
        "eps":              eps,
        # Beta — from yfinance (market/technical metric, not in PDFs)
        "beta":             mkt.get("beta"),
    }


# ══════════════════════════════════════════════════════════════════════════════
#  Main orchestrator
# ══════════════════════════════════════════════════════════════════════════════

def analyse_stock(ticker: str, progress_callback=None, force_refresh: bool = False) -> dict:
    print(f"  [agent-debug] analyse_stock received ticker: {ticker!r}")
    """
    Full stock analysis pipeline.

    Returns the complete dashboard JSON consumed by the 9-tab frontend.
    All financial tables (P&L, BS, CF, Quarters, Ratios) are sourced from
    the company's own published PDF reports. Only price, chart and holders
    come from yfinance.

    progress_callback(message, step, total) is called before each long step
    so the caller can stream progress to the UI.
    """
    TOTAL_STEPS = 6

    def _emit(msg: str, step: int):
        print(f"\n[{step}/{TOTAL_STEPS}] {msg}")
        if progress_callback:
            progress_callback(msg, step, TOTAL_STEPS)

    print(f"\n{'='*60}")
    print(f"StockGPT for Siva — analysing: {ticker}")
    print(f"{'='*60}")

    # ── 0. Supabase cache check ────────────────────────────────────────────────
    if not force_refresh and is_cache_valid(ticker):
        cached = get_cached_analysis(ticker)
        if cached is not None:
            if progress_callback:
                progress_callback("Loaded from cache", 6, TOTAL_STEPS)
            print(f"  [cache] Returning cached result for {ticker}")
            return cached

    # ── 1. Live price + chart (yfinance) ─────────────────────────────────────
    _emit("Fetching live price data…", 1)
    price_data = get_price_data(ticker)
    if not price_data.get("success"):
        return {"error": f"Could not fetch price data: {price_data.get('error')}"}

    company_name = price_data["company"]["name"]
    sector       = price_data["company"]["sector"]
    print(f"      → {company_name}, {price_data['market']['price']} {price_data['market']['currency']}")

    # ── 2. Download PDF reports ───────────────────────────────────────────────
    _emit(f"Downloading annual & quarterly reports for {company_name}…", 2)
    reports = fetch_reports(ticker)
    annual_text      = (reports.get("annual") or {}).get("text", "")
    quarterly_reports = reports.get("quarterly", [])
    print(f"      → annual: {len(annual_text):,} chars | "
          f"quarterly: {len(quarterly_reports)} reports")

    # ── 3. Extract structured financials from PDFs ────────────────────────────
    _emit("Extracting financials from PDF reports…", 3)
    pdf_financials = extract_financials_from_reports(
        company=company_name,
        annual_text=annual_text,
        quarterly_reports=quarterly_reports,
        ticker=ticker,
    )

    # ── 4. Search recent news ──────────────────────────────────────────────
    _emit("Searching for recent news…", 4)
    news = search_news(company_name, ticker)
    print(f"      → {len(news)} news items")

    # ── 5. Find peer companies ────────────────────────────────────────────────
    _emit("Finding peer companies…", 5)
    peers = find_peers(company_name, sector, ticker)
    print(f"      → {len(peers)} peers")

    # ── 6. Generate investment analysis ───────────────────────────────────────
    _emit("Generating AI investment analysis…", 6)
    analysis_output = generate_analysis(
        company_name=company_name,
        ticker=ticker,
        price_data=price_data,
        pdf_financials=pdf_financials,
        news=news,
        peers=peers,
    )

    # ── 7. Compute ratios ──────────────────────────────────────────────────────
    ratios = compute_ratios(price_data, pdf_financials)

    # ── 8. Assemble dashboard payload ─────────────────────────────────────────
    dashboard = {
        # Company meta (yfinance .info)
        "company": price_data["company"],
        # Live price + 52w + market cap (yfinance fast_info)
        "market":  price_data["market"],
        # Price chart — 1 year (yfinance history)
        "chart":   price_data["chart"],
        # Institutional holders (yfinance)
        "investors": price_data.get("investors", []),
        # ── ALL of the below from company's own published reports ──
        "profit_loss":   pdf_financials.get("profit_loss", []),
        "balance_sheet": pdf_financials.get("balance_sheet", []),
        "cash_flow":     pdf_financials.get("cash_flow", []),
        "quarters":      pdf_financials.get("quarters", []),
        # Ratios: margins/ROE/ROA from PDF; P/E, P/B, P/S computed from PDF + price
        "ratios":  ratios,
        # AI-generated (Claude)
        "peers":          peers,
        "news":           news,
        "analysis":       analysis_output.get("analysis", ""),
        "verdict":        analysis_output.get("verdict", ""),
        "key_strengths":  analysis_output.get("key_strengths", []),
        "key_risks":      analysis_output.get("key_risks", []),
        "risks":          analysis_output.get("risks", []),
        "opportunities":  analysis_output.get("opportunities", []),
        "recommendation": analysis_output.get("recommendation", {}),
        # Data provenance
        "data_sources": {
            "price_chart":  "Yahoo Finance — live",
            "financials":   "Company Annual Reports (PDF)",
            "quarters":     "Company Quarterly Reports (PDF)",
            "ratios":       "Annual Report (PDF) + live price",
            "news":         "Claude AI web search",
            "peers":        "Claude AI web search",
            "analysis":     "Claude AI",
        },
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "ticker": ticker,
    }

    print(f"\n{'='*60}")
    print(f"Analysis complete: {company_name}")
    print(f"  P&L years : {len(dashboard['profit_loss'])}")
    print(f"  BS years  : {len(dashboard['balance_sheet'])}")
    print(f"  CF years  : {len(dashboard['cash_flow'])}")
    print(f"  Quarters  : {len(dashboard['quarters'])}")
    print(f"  Peers     : {len(dashboard['peers'])}")
    print(f"  News      : {len(dashboard['news'])}")
    print(f"  Rating    : {dashboard['recommendation'].get('rating')}")
    print(f"{'='*60}\n")

    # ── 9. Persist to Supabase cache ──────────────────────────────────────────
    save_analysis(ticker, dashboard)

    return dashboard


# ── Quick test ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    result = analyse_stock("NDA-SE.ST")

    print("\nKEY RESULTS")
    print("-" * 50)
    print(f"Company  : {result.get('company', {}).get('name')}")
    print(f"Price    : {result.get('market', {}).get('price')} "
          f"{result.get('market', {}).get('currency')}")
    print(f"Market cap: {result.get('market', {}).get('market_cap_m')} MSEK")

    print("\nP&L (from Annual Report PDF):")
    for row in result.get("profit_loss", []):
        print(f"  {row.get('year')}: revenue={row.get('revenue')} MSEK, "
              f"net_income={row.get('net_income')} MSEK, EPS={row.get('eps')} SEK")

    print("\nBalance Sheet (from Annual Report PDF):")
    for row in result.get("balance_sheet", []):
        print(f"  {row.get('year')}: assets={row.get('total_assets')} MSEK, "
              f"equity={row.get('equity')} MSEK")

    print("\nQuarters (from Quarterly Report PDFs):")
    for q in result.get("quarters", []):
        print(f"  {q.get('period')}: revenue={q.get('revenue')} MSEK, "
              f"net_income={q.get('net_income')} MSEK")

    print("\nRatios (PDF-primary):")
    r = result.get("ratios", {})
    print(f"  P/E={r.get('pe')} | P/B={r.get('pb')} | P/S={r.get('ps')}")
    print(f"  ROE={r.get('roe')}% | Net margin={r.get('net_margin')}%")
    print(f"  Dividend yield={r.get('dividend_yield')}% | DPS={r.get('dividend_per_share')} SEK")

    print(f"\nRating : {result.get('recommendation', {}).get('rating')}")
    print(f"Sources: {result.get('data_sources')}")
    print(f"\nJSON size: {len(json.dumps(result)):,} chars")
