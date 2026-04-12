"""
tools.py — Phase 4 (PDF-primary data pipeline)

Data source hierarchy
─────────────────────
  get_price_data             yfinance  → price, 52-week, market cap, chart,
                                         beta, institutional holders, company meta
  extract_financials         Claude    → parse PDF text → P&L, BS, CF, ratios, quarters
  fetch_reports              pdf_fetcher → download + extract PDF text
  search_news                Claude + web_search → recent news
  find_peers                 Claude + web_search → peer tickers

Nothing that comes from a company's own published reports (income statement,
balance sheet, cash flow, EPS, DPS, margins, ROE …) is taken from yfinance.
"""

import json
import os
import re
import time as _time_mod

import anthropic
import yfinance as yf
from dotenv import load_dotenv

from pdf_fetcher import get_company_reports, ticker_to_name

load_dotenv()


# ── Generic helpers ───────────────────────────────────────────────────────────

def _safe(d, key, default=None):
    v = d.get(key, default) if isinstance(d, dict) else default
    if v is None:
        return default
    try:
        import math
        if isinstance(v, float) and math.isnan(v):
            return default
    except Exception:
        pass
    return v


def _m(value):
    """Raw number → MSEK (millions), 1 dp."""
    if value is None:
        return None
    try:
        import math
        if math.isnan(float(value)):
            return None
        return round(float(value) / 1_000_000, 1)
    except Exception:
        return None


def _pct(value):
    """0.065 → 6.5%"""
    if value is None:
        return None
    try:
        import math
        if math.isnan(float(value)):
            return None
        return round(float(value) * 100, 2)
    except Exception:
        return None


def _r(value, dp=2):
    if value is None:
        return None
    try:
        return round(float(value), dp)
    except Exception:
        return None


def _df_val(df, row_key, col):
    try:
        if row_key in df.index:
            import pandas as pd
            v = df.loc[row_key, col]
            if pd.isna(v):
                return None
            return float(v)
    except Exception:
        pass
    return None


# ── Cache helpers ─────────────────────────────────────────────────────────────

_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".yf_cache")


def _safe_ticker(ticker: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", ticker)


def _load_cache(path: str, ttl_hours: float) -> dict | None:
    try:
        if os.path.exists(path):
            age = _time_mod.time() - os.path.getmtime(path)
            if age < ttl_hours * 3600:
                with open(path) as f:
                    data = json.load(f)
                print(f"  [cache] Hit: {os.path.basename(path)} (age {int(age//60)}m)")
                return data
    except Exception:
        pass
    return None


def _save_cache(path: str, data: dict) -> None:
    os.makedirs(_CACHE_DIR, exist_ok=True)
    try:
        with open(path, "w") as f:
            json.dump(data, f)
    except Exception:
        pass


def _price_cache(ticker: str) -> str:
    return os.path.join(_CACHE_DIR, f"{_safe_ticker(ticker)}_price.json")


def _extract_cache(ticker: str) -> str:
    return os.path.join(_CACHE_DIR, f"{_safe_ticker(ticker)}_extract.json")


# ── yfinance retry ────────────────────────────────────────────────────────────

def _yf_retry(fn, retries=3, base_wait=10):
    for attempt in range(retries):
        try:
            return fn()
        except Exception as e:
            err = str(e)
            if "Too Many Requests" in err or "429" in err or "Rate" in err:
                wait = base_wait * (attempt + 1)
                print(f"  [yfinance] Rate limited, waiting {wait}s (attempt {attempt+1})…")
                _time_mod.sleep(wait)
            else:
                raise
    raise RuntimeError("yfinance rate limited after all retries")


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 1 — get_price_data
#  yfinance: price, 52-week, market cap, price chart, beta, holders
#  Company meta (name, sector, description) also from yfinance
#  NO financials, NO ratios from yfinance
# ══════════════════════════════════════════════════════════════════════════════

def get_price_data(ticker: str) -> dict:
    """
    Fetch live price + chart data from yfinance.
    Returns price, currency, market cap, 52-week range, 1-year chart,
    beta, institutional holders, and basic company meta (name/sector/description).
    Financial statements and ratios are NOT fetched here — those come from PDFs.
    """
    cached = _load_cache(_price_cache(ticker), ttl_hours=8)
    if cached:
        return cached

    print(f"  [yfinance] Fetching price data for {ticker}…")
    try:
        stock = yf.Ticker(ticker)

        # ── fast_info: lightweight, rarely rate-limited ──
        fi = _yf_retry(lambda: stock.fast_info)
        price      = getattr(fi, "last_price",  None)
        currency   = getattr(fi, "currency",    "SEK")
        mc         = getattr(fi, "market_cap",  None)
        w52_high   = getattr(fi, "year_high",   None)
        w52_low    = getattr(fi, "year_low",    None)
        shares_out = getattr(fi, "shares",      None)

        # ── Market-cap currency correction ───────────────────────────────────
        # Dual-listed Nordic stocks (e.g. Nordea NDA-SE.ST) expose a mismatch:
        #   fast_info.currency  = "EUR"  (Helsinki primary)
        #   fast_info.last_price = SEK   (Stockholm quote)
        #   fast_info.market_cap = shares × EUR_price  ← ~10.86× too small in SEK
        #
        # Strategy: if currency ≠ SEK, recompute from the SEK price we already
        # have multiplied by shares_outstanding (avoids any FX call).
        # Fallback: fetch live EUR/SEK from yfinance if shares are missing.
        print(f"  [yfinance] raw market_cap={mc!r}  fast_info.currency={currency!r}")
        if currency != "SEK" and mc is not None:
            if price is not None and shares_out is not None and shares_out > 0:
                mc_corrected = price * shares_out
                print(f"  [yfinance] Non-SEK market_cap detected "
                      f"({currency}, raw={mc:,.0f}). "
                      f"Recomputing: {price:.2f} SEK × {int(shares_out):,} shares "
                      f"= {mc_corrected:,.0f} SEK")
                mc = mc_corrected
            else:
                # Fallback: live EUR/SEK rate (or hardcoded default)
                eur_sek = 10.86
                try:
                    fx = yf.Ticker("EURSEK=X")
                    rate = getattr(fx.fast_info, "last_price", None)
                    if rate and 8.0 < float(rate) < 16.0:
                        eur_sek = float(rate)
                except Exception:
                    pass
                mc_corrected = mc * eur_sek
                print(f"  [yfinance] Non-SEK market_cap detected "
                      f"({currency}, raw={mc:,.0f}). "
                      f"EUR/SEK={eur_sek:.4f} → {mc_corrected:,.0f} SEK")
                mc = mc_corrected
            currency = "SEK"   # price and market_cap are now both in SEK

        # ── .info: company meta + beta only (no financials) ──
        info = {}
        try:
            info = _yf_retry(lambda: stock.info, retries=2, base_wait=5) or {}
        except Exception as e:
            print(f"  [yfinance] .info unavailable ({e}), using fast_info only")

        # ── 1-year price history for chart ──
        hist = _yf_retry(lambda: stock.history(period="1y"))
        chart_labels  = [d.strftime("%Y-%m-%d") for d in hist.index]
        chart_prices  = [_r(p, 2) for p in hist["Close"].tolist()]
        chart_volumes = [int(v) for v in hist["Volume"].tolist()]

        # ── Institutional holders ──
        investors = []
        try:
            ih = _yf_retry(lambda: stock.institutional_holders, retries=2, base_wait=5)
            if ih is not None and not ih.empty:
                for _, row in ih.head(10).iterrows():
                    pct_val = row.get("% Out", row.get("pctHeld", None))
                    investors.append({
                        "name":   str(row.get("Holder", row.get("Name", ""))),
                        "shares": int(row.get("Shares", 0)),
                        "pct":    _pct(pct_val),
                        "value":  _m(row.get("Value", None)),
                    })
        except Exception:
            pass

        result = {
            "success": True,
            "company": {
                "name":        _safe(info, "longName", ticker_to_name(ticker)),
                "ticker":      ticker,
                "sector":      _safe(info, "sector",   "N/A"),
                "industry":    _safe(info, "industry", "N/A"),
                "description": _safe(info, "longBusinessSummary", ""),
                "website":     _safe(info, "website",  ""),
                "employees":   _safe(info, "fullTimeEmployees"),
                "country":     _safe(info, "country",  "Sweden"),
                "exchange":    _safe(info, "exchange", "STO"),
            },
            "market": {
                "price":              price or _safe(info, "currentPrice"),
                "currency":           currency,
                "market_cap_m":       _m(mc),
                "week_52_high":       w52_high or _safe(info, "fiftyTwoWeekHigh"),
                "week_52_low":        w52_low  or _safe(info, "fiftyTwoWeekLow"),
                "shares_outstanding_m": _m(shares_out or _safe(info, "sharesOutstanding")),
                "avg_volume":         _safe(info, "averageVolume"),
                # beta is a technical/market metric, not a financial statement item
                "beta":               _r(_safe(info, "beta")),
            },
            "investors": investors,
            "chart": {
                "labels":  chart_labels[-252:],
                "prices":  chart_prices[-252:],
                "volumes": chart_volumes[-252:],
            },
        }

        print(f"  [yfinance] OK — price={price} {currency}, "
              f"market_cap={_m(mc)} MSEK, "
              f"chart={len(chart_labels)} pts")
        _save_cache(_price_cache(ticker), result)
        return result

    except Exception as e:
        print(f"  [yfinance] Error: {e}")
        return {"success": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 2 — fetch_reports (PDF download + text extraction)
#  Unchanged from Phase 2/3, but with larger text limits for extraction
# ══════════════════════════════════════════════════════════════════════════════

# Increased limits so the extraction call gets enough table data
_MAX_ANNUAL    = 35_000   # chars  (was 12_000)
_MAX_QUARTERLY =  8_000   # chars per quarter (was 4_000)


def fetch_reports(ticker: str) -> dict:
    """
    Fetch annual + quarterly report PDFs and return extracted text.
    Text limits are generous so extract_financials_from_reports
    can read full financial tables.
    """
    print(f"  [pdf_fetcher] Fetching reports for {ticker}…")
    try:
        reports = get_company_reports(ticker)

        annual_data = None
        if reports["annual"]:
            annual_data = {
                "year": reports["annual"]["year"],
                "url":  reports["annual"]["url"],
                "text": reports["annual"]["text"][:_MAX_ANNUAL],
            }

        quarterly_data = []
        for q in reports["quarterly"]:
            quarterly_data.append({
                "period": q["quarter"],
                "url":    q["url"],
                "text":   q["text"][:_MAX_QUARTERLY],
            })

        print(f"  [pdf_fetcher] annual={'found' if annual_data else 'missing'}, "
              f"quarterly={len(quarterly_data)}")
        return {
            "success":   True,
            "company":   reports["company"],
            "annual":    annual_data,
            "quarterly": quarterly_data,
        }
    except Exception as e:
        print(f"  [pdf_fetcher] Error: {e}")
        return {"success": False, "error": str(e), "annual": None, "quarterly": []}


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 3 — extract_financials_from_reports
#  Uses Claude sonnet to parse PDF text → structured financial JSON.
#  This is the primary source for P&L, BS, CF, ratios, and quarterly data.
# ══════════════════════════════════════════════════════════════════════════════

_EXTRACT_SYSTEM = """\
You are a financial statement parser specialising in Swedish company reports (Nasdaq Stockholm).
Your task: extract key financial figures from PDF-extracted report text and return structured JSON.

RULES:
1. ALL monetary values must be in MSEK (millions of Swedish kronor).
   - If report uses BSEK (billions): multiply by 1000
   - If report uses KSEK (thousands): divide by 1000
   - If report uses MEUR: multiply by ~11.5
   - If report uses BEUR: multiply by ~11500
2. Extract figures for up to 5 fiscal years from annual reports (most recent first).
3. For quarterly reports: extract the 3-MONTH period figures ONLY — NOT cumulative YTD totals.
   (Look for column headers like "Q1 2025", "Jan–Mar 2025", "Kvartal 1" etc.)
4. Use null for any field not found. Never invent or estimate numbers.
5. For banks (Nordea, SEB, Handelsbanken, Swedbank, etc.):
   - "revenue" = total operating income (Summa rörelseintäkter / Total operating income)
   - "gross_profit" = null (banks don't report this)
   - "operating_income" = profit before credit losses or pre-tax profit
6. Return ONLY valid JSON — no markdown fences, no explanation text.

Swedish financial terminology:
• Income statement (Resultaträkning):
  Nettoomsättning / Rörelseintäkter / Summa intäkter = revenue (industrial)
  Räntenetto (NII) + Provisionsnetto + Övriga intäkter = total income (banks)
  Bruttoresultat = gross profit
  Rörelseresultat / EBIT = operating income
  Periodens/Årets resultat = net income
  Vinst/Resultat per aktie = EPS (SEK)
  EBITDA = Rörelseresultat + avskrivningar/amortiseringar
• Balance sheet (Balansräkning):
  Summa/Totala tillgångar = total assets
  Summa skulder / Totala skulder = total liabilities
  Eget kapital = equity
  Kassa / Likvida medel = cash
  Räntebärande skulder / Upplåning = total debt
  Bokfört värde per aktie = book value per share
• Cash flow (Kassaflödesanalys):
  Löpande verksamheten = operating cash flow
  Investeringsverksamheten = investing cash flow
  Finansieringsverksamheten = financing cash flow
  Investeringar i anläggningstillgångar = capex (typically negative)
• Ratios (Nyckeltal):
  Avkastning på eget kapital (ROE) = return on equity %
  Avkastning på tillgångar (ROA) = return on assets %
  Rörelsemarginal = operating margin %
  Nettomarginal = net margin %
  Utdelning per aktie = dividend per share (SEK)
  Utdelningsandel / Pay-out ratio = payout ratio %
  Soliditet = equity ratio (NOT the same as debt-to-equity)
  Skuldsättningsgrad = debt-to-equity ratio
  Balansomslutning = total assets (for banks)"""


def _empty_financials() -> dict:
    return {
        "currency_unit": "MSEK",
        "profit_loss":   [],
        "balance_sheet": [],
        "cash_flow":     [],
        "key_ratios":    {},
        "quarters":      [],
    }


def _clean_financials(data: dict) -> dict:
    """Coerce extracted data: string numbers → float, null → None."""
    for section in ("profit_loss", "balance_sheet", "cash_flow", "quarters"):
        if not isinstance(data.get(section), list):
            data[section] = []
        cleaned = []
        for row in data[section]:
            if not isinstance(row, dict):
                continue
            clean_row = {}
            for k, v in row.items():
                if v is None or v == "null" or v == "":
                    clean_row[k] = None
                elif k in ("year",):
                    try:
                        clean_row[k] = int(float(str(v)))
                    except Exception:
                        clean_row[k] = v
                elif k == "period":
                    clean_row[k] = str(v)
                else:
                    try:
                        fv = float(str(v).replace(",", ".").replace(" ", ""))
                        clean_row[k] = round(fv, 1)
                    except Exception:
                        clean_row[k] = None
            cleaned.append(clean_row)
        data[section] = cleaned

    if not isinstance(data.get("key_ratios"), dict):
        data["key_ratios"] = {}
    kr = {}
    for k, v in data["key_ratios"].items():
        if v is None or v == "null" or v == "":
            kr[k] = None
        else:
            try:
                kr[k] = round(float(str(v).replace(",", ".").replace(" ", "")), 2)
            except Exception:
                kr[k] = None
    data["key_ratios"] = kr
    return data


# JSON schema template sent to Claude in the extraction prompt
_EXTRACT_SCHEMA = {
    "currency_unit": "MSEK",
    "profit_loss": [
        {
            "year": 2024,
            "revenue": None,
            "gross_profit": None,
            "operating_income": None,
            "net_income": None,
            "ebitda": None,
            "eps": None,
        }
    ],
    "balance_sheet": [
        {
            "year": 2024,
            "total_assets": None,
            "total_liabilities": None,
            "equity": None,
            "cash": None,
            "total_debt": None,
            "book_value_per_share": None,
        }
    ],
    "cash_flow": [
        {
            "year": 2024,
            "operating_cf": None,
            "investing_cf": None,
            "financing_cf": None,
            "capex": None,
            "free_cf": None,
        }
    ],
    "key_ratios": {
        "roe_pct": None,
        "roa_pct": None,
        "operating_margin_pct": None,
        "net_margin_pct": None,
        "gross_margin_pct": None,
        "debt_to_equity": None,
        "current_ratio": None,
        "dividend_per_share": None,
        "payout_ratio_pct": None,
        "shares_outstanding_m": None,
    },
    "quarters": [
        {
            "period": "Q1 2025",
            "revenue": None,
            "gross_profit": None,
            "net_income": None,
            "eps": None,
        }
    ],
}


def extract_financials_from_reports(
    company: str,
    annual_text: str,
    quarterly_reports: list,
    ticker: str,
) -> dict:
    """
    Parse PDF report text with Claude and return structured financial data.

    annual_text      : extracted text from the annual PDF (up to 35k chars)
    quarterly_reports: list of {period, text} dicts, most recent first
    Returns          : {profit_loss, balance_sheet, cash_flow, key_ratios, quarters}

    Cached for 24 hours (PDFs don't change intra-day).
    """
    # ── Cache check ──
    cache_path = _extract_cache(ticker)
    cached = _load_cache(cache_path, ttl_hours=24)
    if cached:
        return cached

    if not annual_text and not quarterly_reports:
        print("  [extract] No PDF text available — returning empty financials")
        return _empty_financials()

    # ── Build quarterly text block ──
    q_blocks = []
    for q in quarterly_reports[:4]:
        period = q.get("period", "Unknown")
        text   = q.get("text", "")[:_MAX_QUARTERLY]
        q_blocks.append(f"=== {period} (3-month figures only) ===\n{text}")
    quarterly_text = "\n\n".join(q_blocks) if q_blocks else "(no quarterly reports available)"

    # ── Build extraction prompt ──
    schema_str = json.dumps(_EXTRACT_SCHEMA, indent=2, ensure_ascii=False)

    user_msg = f"""Extract all financial data for {company} from the report text below.

━━━ ANNUAL REPORT ━━━
{annual_text[:35_000]}

━━━ QUARTERLY REPORTS ━━━
{quarterly_text}

Return ONLY this JSON with extracted values. Replace null with the actual number wherever found.
Include up to 5 years in profit_loss / balance_sheet / cash_flow (most recent first).
Include up to 8 quarters (most recent first).

{schema_str}"""

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    print(f"  [extract] Parsing financials for {company}…")

    try:
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            system=_EXTRACT_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
        )

        raw = "".join(getattr(b, "text", "") or "" for b in resp.content).strip()

        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw.strip())

        # Find first { in case there's a preamble
        brace_start = raw.find("{")
        if brace_start > 0:
            raw = raw[brace_start:]

        # Use raw_decode so trailing commentary after the JSON doesn't break parsing
        decoder = json.JSONDecoder()
        result, _ = decoder.raw_decode(raw)
        result = _clean_financials(result)

        pl_n = len(result.get("profit_loss", []))
        bs_n = len(result.get("balance_sheet", []))
        cf_n = len(result.get("cash_flow", []))
        q_n  = len(result.get("quarters", []))
        print(f"  [extract] OK — P&L={pl_n}y, BS={bs_n}y, CF={cf_n}y, Q={q_n}")

        # Log the first P&L year as a sanity check
        if result.get("profit_loss"):
            r0 = result["profit_loss"][0]
            print(f"  [extract] Latest year: {r0.get('year')} | "
                  f"revenue={r0.get('revenue')} | net_income={r0.get('net_income')} MSEK")

        _save_cache(cache_path, result)
        return result

    except (json.JSONDecodeError, ValueError) as e:
        print(f"  [extract] JSON parse error: {e}")
        print(f"  [extract] Raw (first 400): {raw[:400]}")
        return _empty_financials()
    except Exception as e:
        print(f"  [extract] Error: {e}")
        return _empty_financials()


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 4 — search_news  (unchanged)
# ══════════════════════════════════════════════════════════════════════════════

def search_news(company: str, ticker: str) -> list:
    """Search for recent news using Claude haiku + web_search."""
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    print(f"  [news] Searching for {company} news…")

    prompt = (
        f"Search for the 5 most recent important news articles about {company} "
        f"(Stockholm stock ticker: {ticker}) from 2024 or 2025.\n\n"
        "Focus on: earnings, acquisitions, strategy, analyst ratings, dividends.\n\n"
        "Reply ONLY with a JSON array, no other text:\n"
        '[{"title":"...","summary":"one sentence","date":"YYYY-MM-DD","sentiment":"positive|negative|neutral"}]'
    )

    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=800,
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(getattr(b, "text", "") or "" for b in resp.content)
        m = re.search(r"\[[\s\S]*\]", text)
        if m:
            return json.loads(m.group())
    except Exception as e:
        print(f"  [news] Error: {e}")
    return []


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 5 — find_peers  (unchanged)
# ══════════════════════════════════════════════════════════════════════════════

def find_peers(company: str, sector: str, ticker: str) -> list:
    """Find peer companies listed on Nasdaq Stockholm using web_search."""
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    print(f"  [peers] Finding peers for {company}…")

    prompt = (
        f"Find 5 peer or competitor companies to {company} ({sector}) "
        f"listed on Nasdaq Stockholm or major Nordic exchanges.\n\n"
        "For each peer also search for approximate current key metrics "
        "(P/E ratio, return on equity %, dividend yield %, and revenue growth % YoY) "
        "from recent public filings or market data. Use null if not found.\n\n"
        "Reply ONLY with a JSON array, no other text:\n"
        '[{"name":"...","ticker":"XXXX.ST","relationship":"direct competitor|same sector|regional peer",'
        '"pe":null,"roe_pct":null,"dividend_yield_pct":null,"revenue_growth_pct":null}]'
    )

    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=600,
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(getattr(b, "text", "") or "" for b in resp.content)
        m = re.search(r"\[[\s\S]*\]", text)
        if m:
            return json.loads(m.group())
    except Exception as e:
        print(f"  [peers] Error: {e}")
    return []
