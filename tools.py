"""
tools.py — Phase 4 (PDF-primary data pipeline)

Data source hierarchy
─────────────────────
  get_price_data             Finnhub   → price, 52-week, market cap, chart,
                                         beta, company meta
  extract_financials         Claude    → parse PDF text → P&L, BS, CF, ratios, quarters
  fetch_reports              pdf_fetcher → download + extract PDF text
  search_news                Claude + web_search → recent news
  find_peers                 Claude + web_search → peer tickers

Nothing that comes from a company's own published reports (income statement,
balance sheet, cash flow, EPS, DPS, margins, ROE …) is taken from Finnhub.
"""

import json
import os
import random
import re
import time as _time_mod

import anthropic
import requests
from dotenv import load_dotenv

from pdf_fetcher import get_company_reports, ticker_to_name, KNOWN_COMPANIES

load_dotenv()

# ── Finnhub config ────────────────────────────────────────────────────────────
_FINNHUB_BASE = "https://finnhub.io/api/v1"

# Map yfinance-style tickers (used everywhere in the app) → Finnhub symbols
_TICKER_MAP: dict[str, str] = {
    "NDA-SE.ST":  "NDA-SE",
    "NDA-SE-ST":  "NDA-SE",       # fallback if dot is lost in transit
    "ERIC-B.ST":  "ERIC-B:OMX",
    "VOLV-B.ST":  "VOLV-B:OMX",
    "SEB-A.ST":   "SEB-A:OMX",
    "SAND.ST":    "SAND:OMX",
    "INVE-B.ST":  "INVE-B:OMX",
    "ATCO-B.ST":  "ATCO-B:OMX",
}


def _to_finnhub_ticker(ticker: str) -> str:
    """Convert yfinance ticker format to Finnhub symbol format."""
    if ticker in _TICKER_MAP:
        return _TICKER_MAP[ticker]
    # Generic fallback: XXXX.ST → XXXX (drop exchange suffix)
    if ticker.endswith(".ST"):
        return ticker[:-3]
    return ticker

# Manual overrides for tickers where Finnhub returns the wrong company name
# (e.g. US-listed names for dual-listed Swedish shares)
_COMPANY_NAME_OVERRIDES: dict[str, str] = {
    # yfinance (.ST) form          # correct display name
    "SEB-A.ST":    "SEB",
    "ERIC-B.ST":   "Ericsson",
    "VOLV-B.ST":   "Volvo",
    "NDA-SE.ST":   "Nordea",
    "SWED-A.ST":   "Swedbank",
    "INVE-B.ST":   "Investor",
    "SAND.ST":     "Sandvik",
    "SKF-B.ST":    "SKF",
    "ATCO-A.ST":   "Atlas Copco",
    "ATCO-B.ST":   "Atlas Copco",
    "SHB-A.ST":    "Handelsbanken",
    # bare forms (in case .ST suffix was stripped)
    "SEB-A":       "SEB",
    "ERIC-B":      "Ericsson",
    "VOLV-B":      "Volvo",
    "NDA-SE":      "Nordea",
    "SWED-A":      "Swedbank",
    "INVE-B":      "Investor",
    "SAND":        "Sandvik",
    "SKF-B":       "SKF",
    "ATCO-A":      "Atlas Copco",
    "ATCO-B":      "Atlas Copco",
    "SHB-A":       "Handelsbanken",
}

# ── In-memory ticker cache (5-minute TTL) ────────────────────────────────────
_mem_cache: dict = {}   # {ticker: {"ts": float, "data": dict}}
_MEM_TTL = 300          # seconds


def _mem_get(ticker: str) -> dict | None:
    entry = _mem_cache.get(ticker)
    if entry and (_time_mod.time() - entry["ts"]) < _MEM_TTL:
        print(f"  [mem-cache] Hit for {ticker}")
        return entry["data"]
    return None


def _mem_set(ticker: str, data: dict) -> None:
    _mem_cache[ticker] = {"ts": _time_mod.time(), "data": data}


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

_CACHE_DIR = os.path.join(os.environ.get("CACHE_DIR", "/tmp"), ".yf_cache")


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


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 1 — get_price_data
#  Finnhub: price, 52-week, market cap, 1-year chart, beta, company meta
#  NO financials, NO ratios from Finnhub
# ══════════════════════════════════════════════════════════════════════════════

def get_price_data(ticker: str) -> dict:
    """
    Fetch live price + chart data from Finnhub.
    Returns price, currency, market cap, 52-week range, 1-year daily chart,
    beta, and basic company meta (name/sector).
    Financial statements and ratios are NOT fetched here — those come from PDFs.
    Institutional holders are a Finnhub paid feature; investors returns [].
    """
    mem = _mem_get(ticker)
    if mem:
        return mem

    cached = _load_cache(_price_cache(ticker), ttl_hours=8)
    if cached:
        _mem_set(ticker, cached)
        return cached

    api_key   = os.environ.get("FINNHUB_KEY", "")
    fh_ticker = _to_finnhub_ticker(ticker)
    print(f"  [finnhub] Fetching price data for {ticker} ({fh_ticker})…")

    try:
        session = requests.Session()

        def _fh(endpoint: str, params: dict | None = None) -> dict:
            p = params or {}
            p["token"] = api_key
            r = session.get(f"{_FINNHUB_BASE}{endpoint}", params=p, timeout=15)
            r.raise_for_status()
            return r.json()

        # ── Company profile ──────────────────────────────────────────────────
        profile = _fh("/stock/profile2", {"symbol": fh_ticker})

        # ── Quote (current price) ────────────────────────────────────────────
        print(f"  [finnhub-debug] fh_ticker={fh_ticker!r}")
        quote = _fh("/quote", {"symbol": fh_ticker})
        print(f"  [finnhub-debug] quote attempt 1 ({fh_ticker!r}) raw={quote}")

        # If c=0 the symbol wasn't recognised; retry with :OMX suffix
        if not quote.get("c"):
            fh_ticker_omx = fh_ticker + ":OMX"
            quote_omx = _fh("/quote", {"symbol": fh_ticker_omx})
            print(f"  [finnhub-debug] quote attempt 2 ({fh_ticker_omx!r}) raw={quote_omx}")
            if quote_omx.get("c"):
                fh_ticker = fh_ticker_omx
                quote = quote_omx
                profile = _fh("/stock/profile2", {"symbol": fh_ticker})
                print(f"  [finnhub-debug] using fallback ticker {fh_ticker!r}, profile2 raw={profile}")
            else:
                print(f"  [finnhub-debug] both attempts returned c=0")
        else:
            print(f"  [finnhub-debug] profile2 raw={profile}")

        price   = quote.get("c")
        currency = profile.get("currency", "SEK")

        chart_labels, chart_prices, chart_volumes = [], [], []

        # ── Metrics (52-week range, beta, avg volume) ─────────────────────────
        metrics = _fh("/stock/metric", {"symbol": fh_ticker, "metric": "all"})
        m = metrics.get("metric", {})

        w52_high = m.get("52WeekHigh")
        w52_low  = m.get("52WeekLow")
        avg_vol  = m.get("10DayAverageTradingVolume")
        if avg_vol:
            avg_vol = int(avg_vol * 1_000_000)   # Finnhub returns in millions

        # ── Market cap: price × shares (keeps everything in SEK) ─────────────
        shares_m    = _r(profile.get("shareOutstanding"), 2)   # already millions
        market_cap_m = _r(price * shares_m, 0) if price and shares_m else None

        result = {
            "success": True,
            "company": {
                "name":        _COMPANY_NAME_OVERRIDES.get(ticker) or KNOWN_COMPANIES.get(ticker) or profile.get("name") or ticker_to_name(ticker),
                "ticker":      ticker,
                "sector":      profile.get("finnhubIndustry", "N/A"),
                "industry":    profile.get("finnhubIndustry", "N/A"),
                "description": "",   # not available on Finnhub free tier
                "website":     profile.get("weburl", ""),
                "employees":   profile.get("employeeTotal"),
                "country":     profile.get("country", "Sweden"),
                "exchange":    profile.get("exchange", "STO"),
            },
            "market": {
                "price":                price,
                "currency":             currency,
                "market_cap_m":         market_cap_m,
                "week_52_high":         _r(w52_high, 2),
                "week_52_low":          _r(w52_low, 2),
                "shares_outstanding_m": shares_m,
                "avg_volume":           avg_vol,
                "beta":                 _r(m.get("beta"), 2),
            },
            "investors": [],   # institutional holders require Finnhub paid plan
            "chart": {
                "labels":  chart_labels[-252:],
                "prices":  chart_prices[-252:],
                "volumes": chart_volumes[-252:],
            },
        }

        print(f"  [finnhub] OK — price={price} {currency}, market_cap={market_cap_m} MSEK")
        _save_cache(_price_cache(ticker), result)
        _mem_set(ticker, result)
        return result

    except Exception as e:
        print(f"  [finnhub] Error: {e}")
        return {"success": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 2 — fetch_reports (PDF download + text extraction)
#  Unchanged from Phase 2/3, but with larger text limits for extraction
# ══════════════════════════════════════════════════════════════════════════════

# Increased limits so the extraction call gets enough table data
_MAX_ANNUAL        = 500_000  # chars stored in Supabase — full document
_MAX_ANNUAL_PROMPT =  80_000  # chars sent to Claude — anchored to financial section
_MAX_QUARTERLY     =  20_000  # chars per quarter


def fetch_reports(ticker: str) -> dict:
    """
    Phase C: read manually-uploaded PDF texts from Supabase (stock_pdf_store).
    Auto-download via pdf_fetcher is disabled — PDFs must be uploaded via /api/upload.
    Text is truncated to pipeline limits before returning.
    """
    from db import get_pdf_texts
    print(f"  [pdf_store] Loading uploaded PDFs for {ticker}…")
    try:
        data = get_pdf_texts(ticker)

        annual_data = None
        if data.get("annual"):
            a = data["annual"]
            annual_data = {
                "year": a["year"],
                "url":  a["url"],
                "text": a["text"][:_MAX_ANNUAL],
            }

        quarterly_data = []
        for q in data.get("quarterly", []):
            quarterly_data.append({
                "period": q["period"],
                "url":    q["url"],
                "text":   q["text"][:_MAX_QUARTERLY],
            })

        print(f"  [pdf_store] annual={'found' if annual_data else 'missing'}, "
              f"quarterly={len(quarterly_data)}")
        return {
            "success":   data.get("success", False),
            "company":   data.get("company", ""),
            "annual":    annual_data,
            "quarterly": quarterly_data,
        }
    except Exception as e:
        print(f"  [pdf_store] Error: {e}")
        return {"success": False, "error": str(e), "annual": None, "quarterly": []}


# ══════════════════════════════════════════════════════════════════════════════
#  TOOL 3 — extract_financials_from_reports
#  Uses Claude sonnet to parse PDF text → structured financial JSON.
#  This is the primary source for P&L, BS, CF, ratios, and quarterly data.
# ══════════════════════════════════════════════════════════════════════════════

_EXTRACT_SYSTEM = """\
You are a financial statement parser specialising in Nordic company annual reports.
Extract figures from PDF text and return structured JSON only.

RULES
1. Extract monetary values in the EXACT unit used in the report — do NOT convert currencies.
   Detect the reporting currency unit from the document and set "currency_unit" accordingly:
     • SEKm  — millions of Swedish kronor  (Sv: MSEK / mkr)
     • EURm  — millions of euros           (e.g. Nordea, Assa Abloy international reports)
     • DKKm  — millions of Danish krone    (Sv: MDKK)
     • NOKm  — millions of Norwegian krone (Sv: MNOK)
   If the report uses billions (e.g. BSEKbn, EURbn), scale to millions (×1 000) for all fields.
   If the report uses thousands (e.g. KSEK, TEUR), scale to millions (÷1 000) for all fields.
2. Extract up to 5 fiscal years (most recent first) for profit_loss / balance_sheet / cash_flow / key_figures.
3. Quarterly reports: extract 3-MONTH figures ONLY — never cumulative YTD.
4. Use null for any field not found. Never invent or estimate.
5. Return ONLY valid JSON — no markdown fences, no prose.

════════════════════════════════════════════════════════════
INCOME STATEMENT — field mapping
════════════════════════════════════════════════════════════
"nii"                     Net interest income
                          Sv: Räntenetto
"fee_income"              Net fee and commission income
                          Sv: Provisionsnetto
"insurance_result"        Net insurance result
                          Sv: Nettoresultat livförsäkring / Försäkringsresultat
"fair_value"              Net result from items at fair value
                          Sv: Nettoresultat finansiella poster till verkligt värde
"other_income"            Other operating income (not captured above)
                          Sv: Övriga rörelseintäkter
"revenue"                 Total Operating Income  ← sum of all income lines
                          Sv: Summa rörelseintäkter / Totala rörelseintäkter

"staff_costs"             Staff costs  [NEGATIVE MSEK]
                          Sv: Personalkostnader
"other_expenses"          Other expenses  [NEGATIVE MSEK]
                          Sv: Övriga administrationskostnader / Rörelsekostnader
"reg_fees"                Regulatory fees / resolution fund  [NEGATIVE MSEK]
                          Sv: Avgifter till resolutionsfonden / Stabilitetsavgift
"da"                      Depreciation, amortisation and impairment  [NEGATIVE MSEK]
                          Sv: Av- och nedskrivningar
"total_expenses"          Total Operating Expenses  [NEGATIVE MSEK]  ← sum of expense lines
                          Sv: Summa rörelsekostnader / Totala kostnader

"profit_before_loan_losses"  Profit Before Loan Losses  = revenue + total_expenses
                              Sv: Rörelseresultat före kreditförluster
                              En: Profit before loan losses / Operating profit before provisions
"net_result_loans_fv"     Net result on loans at fair value
                          Sv: Nettoresultat på utlåning till verkligt värde
"net_loan_losses"         Net loan losses / credit losses  [negative = losses]
                          Sv: Kreditförluster netto / Nettokreditförluster
"operating_profit"        Operating Profit  = profit_before_loan_losses + net_loan_losses + net_result_loans_fv
                          Sv: Rörelseresultat / Rörelsevinst
"income_tax"              Income tax expense  [NEGATIVE MSEK]
                          Sv: Skatt / Inkomstskatt
"net_income"              Net Profit for the year
                          Sv: Årets/Periodens resultat / Nettoresultat

════════════════════════════════════════════════════════════
BALANCE SHEET — field mapping
════════════════════════════════════════════════════════════
ASSETS
"cash_central_banks"          Cash and balances with central banks
                              Sv: Kassa och tillgodohavanden hos centralbanker
"loans_credit_institutions"   Loans to central banks and credit institutions
                              Sv: Utlåning till kreditinstitut
"loans_public"                Loans to the public
                              Sv: Utlåning till allmänheten
"securities"                  Interest-bearing securities and pledged instruments
                              Sv: Räntebärande värdepapper / Obligationer / Pantsatta instrument
"pooled_unit_linked"          Assets in pooled schemes and unit-linked contracts
                              Sv: Tillgångar i poolade fonder / Fondförsäkring
"derivatives_assets"          Derivatives assets
                              Sv: Derivat (tillgångssidan)
"other_assets"                Other assets (remainder)
                              Sv: Övriga tillgångar
"total_assets"                Total Assets
                              Sv: Summa tillgångar / Balansomslutning

LIABILITIES
"deposits_credit_institutions"  Deposits by credit institutions
                                Sv: Skulder till kreditinstitut
"deposits_public"               Deposits and borrowings from the public
                                Sv: In- och upplåning från allmänheten
"deposits_pooled"               Deposits in pooled schemes and unit-linked contracts
                                Sv: Skulder i poolade fonder / Fondförsäkring
"insurance_liabilities"         Insurance contract liabilities
                                Sv: Försäkringsavtalsskulder / Livförsäkringsskulder
"debt_securities"               Debt securities in issue
                                Sv: Emitterade värdepapper / Upplåning via värdepapper
"derivatives_liabilities"       Derivatives liabilities
                                Sv: Derivat (skuldsidan)
"subordinated_liabilities"      Subordinated liabilities
                                Sv: Efterställda skulder / Förlagslån
"other_liabilities"             Other liabilities
                                Sv: Övriga skulder
"total_liabilities"             Total Liabilities
                                Sv: Summa skulder
EQUITY
"equity"                        Total Equity
                                Sv: Eget kapital totalt
"total_liabilities_equity"      Total Liabilities and Equity  [= total_assets]
                                Sv: Summa skulder och eget kapital

════════════════════════════════════════════════════════════
CASH FLOW — field mapping
════════════════════════════════════════════════════════════
"operating_profit_cf"     Operating profit (starting line of cash flow statement)
"non_cash_adjustments"    Adjustments for non-cash items  (depreciation, provisions, etc.)
"income_taxes_paid"       Income taxes paid  [NEGATIVE MSEK]
"cf_before_changes"       Cash flow before changes in operating assets and liabilities
"change_loans_public"     Change in loans to the public  (negative = growth in loans)
"change_deposits_public"  Change in deposits from the public  (positive = growth in deposits)
"operating_cf"            Cash flow from operating activities  ← section total
                          Sv: Kassaflöde från rörelseverksamheten
"capex_ppe"               Acquisition of property and equipment  [NEGATIVE MSEK]
"capex_intangibles"       Acquisition of intangible assets  [NEGATIVE MSEK]
"investing_cf"            Cash flow from investing activities  ← section total
                          Sv: Kassaflöde från investeringsverksamheten
"dividend_paid"           Dividend paid  [NEGATIVE MSEK]
"share_repurchase"        Repurchase of own shares  [NEGATIVE MSEK]
"issued_subordinated"     Issued subordinated liabilities
"financing_cf"            Cash flow from financing activities  ← section total
                          Sv: Kassaflöde från finansieringsverksamheten
"net_cash_flow"           Net cash flow for the year
                          Sv: Årets kassaflöde / Förändring likvida medel

════════════════════════════════════════════════════════════
KEY FIGURES — field mapping (per year; ratios as %, amounts as MSEK unless noted)
════════════════════════════════════════════════════════════
"basic_eps"               Basic earnings per share  [SEK]
"diluted_eps"             Diluted earnings per share  [SEK]
"share_price"             Share price at year-end  [SEK]
"dividend_per_share"      Dividend per share  [SEK]
"equity_per_share"        Equity per share / book value per share  [SEK]
"shares_outstanding_m"    Shares outstanding  [millions]
"roe_pct"                 Return on equity  [%]  Sv: Avkastning på eget kapital
"cost_to_income_pct"      Cost-to-income ratio  [%]  Sv: K/I-tal
"net_loan_loss_ratio_pct" Net loan loss ratio  [%]  Sv: Kreditförlustnivå
"aum_bn"                  Assets under management  [EURbn]  Sv: Förvaltat kapital
"cet1_ratio_pct"          CET1 capital ratio  [%]  Sv: Kärnprimärkapitalrelation
"tier1_ratio_pct"         Tier 1 capital ratio  [%]  Sv: Primärkapitalrelation
"total_capital_ratio_pct" Total capital ratio  [%]  Sv: Total kapitalrelation
"tier1_capital"           Tier 1 capital  [MSEK]
"rea"                     Risk exposure amount / Risk-weighted assets  [MSEK]
"employees"               Number of employees (FTE)  [integer]"""


def _empty_financials() -> dict:
    return {
        "currency_unit": "SEKm",
        "profit_loss":   [],
        "balance_sheet": [],
        "cash_flow":     [],
        "key_figures":   [],
        "quarters":      [],
    }


def _clean_financials(data: dict) -> dict:
    """Coerce extracted data: string numbers → float, null → None."""
    _INT_KEYS  = {"year", "employees"}
    _STR_KEYS  = {"period"}

    for section in ("profit_loss", "balance_sheet", "cash_flow", "key_figures", "quarters"):
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
                elif k in _INT_KEYS:
                    try:
                        clean_row[k] = int(float(str(v)))
                    except Exception:
                        clean_row[k] = v
                elif k in _STR_KEYS:
                    clean_row[k] = str(v)
                else:
                    try:
                        fv = float(str(v).replace(",", ".").replace(" ", ""))
                        clean_row[k] = round(fv, 1)
                    except Exception:
                        clean_row[k] = None
            cleaned.append(clean_row)
        data[section] = cleaned

    # Backward-compat: keep key_ratios as empty dict if absent
    if not isinstance(data.get("key_ratios"), dict):
        data["key_ratios"] = {}
    return data


# JSON schema template sent to Claude in the extraction prompt
_EXTRACT_SCHEMA = {
    "currency_unit": "DETECT",
    "profit_loss": [
        {
            "year": 2024,
            "nii": None, "fee_income": None, "insurance_result": None,
            "fair_value": None, "other_income": None,
            "revenue": None,
            "staff_costs": None, "other_expenses": None, "reg_fees": None, "da": None,
            "total_expenses": None,
            "profit_before_loan_losses": None,
            "net_result_loans_fv": None, "net_loan_losses": None,
            "operating_profit": None,
            "income_tax": None,
            "net_income": None,
        }
    ],
    "balance_sheet": [
        {
            "year": 2024,
            "cash_central_banks": None, "loans_credit_institutions": None,
            "loans_public": None, "securities": None,
            "pooled_unit_linked": None, "derivatives_assets": None,
            "other_assets": None, "total_assets": None,
            "deposits_credit_institutions": None, "deposits_public": None,
            "deposits_pooled": None, "insurance_liabilities": None,
            "debt_securities": None, "derivatives_liabilities": None,
            "subordinated_liabilities": None, "other_liabilities": None,
            "total_liabilities": None,
            "equity": None, "total_liabilities_equity": None,
        }
    ],
    "cash_flow": [
        {
            "year": 2024,
            "operating_profit_cf": None, "non_cash_adjustments": None,
            "income_taxes_paid": None, "cf_before_changes": None,
            "change_loans_public": None, "change_deposits_public": None,
            "operating_cf": None,
            "capex_ppe": None, "capex_intangibles": None,
            "investing_cf": None,
            "dividend_paid": None, "share_repurchase": None,
            "issued_subordinated": None,
            "financing_cf": None,
            "net_cash_flow": None,
        }
    ],
    "key_figures": [
        {
            "year": 2024,
            "basic_eps": None, "diluted_eps": None,
            "share_price": None, "dividend_per_share": None,
            "equity_per_share": None, "shares_outstanding_m": None,
            "roe_pct": None, "cost_to_income_pct": None,
            "net_loan_loss_ratio_pct": None, "aum_bn": None,
            "cet1_ratio_pct": None, "tier1_ratio_pct": None,
            "total_capital_ratio_pct": None,
            "tier1_capital": None, "rea": None,
            "employees": None,
        }
    ],
    "quarters": [
        {
            "period": "Q1 2025",
            "revenue": None, "gross_profit": None,
            "net_income": None, "eps": None,
        }
    ],
}


# Ordered by specificity — first match wins as the anchor point.
_FINANCIAL_SECTION_ANCHORS = [
    # Swedish — most specific first
    "resultaträkning",
    "balansräkning",
    "kassaflödesanalys",
    "räntenetto",
    "provisionsnetto",
    "summa rörelseintäkter",
    "rörelseintäkter",
    "nettoomsättning",
    # English
    "income statement",
    "profit and loss",
    "net interest income",
    "balance sheet",
    "cash flow statement",
    "total operating income",
]


def _select_financial_pages(text: str, char_budget: int) -> str:
    """
    Find the earliest occurrence of a financial-section keyword in the full
    document text, then return char_budget characters starting from that
    position. Falls back to the last (char_budget) chars of the document when
    no keyword is found (financials are usually at the end of annual reports).
    """
    lower = text.lower()
    anchor = len(text)  # default: no match found

    for kw in _FINANCIAL_SECTION_ANCHORS:
        pos = lower.find(kw)
        if pos != -1 and pos < anchor:
            anchor = pos
            print(f"  [extract] financial section anchor: {kw!r} at char {pos:,}")
            break  # first (earliest) match in priority order is enough

    if anchor == len(text):
        # No keyword found — take the last chunk (financials live at the end)
        print(f"  [extract] no anchor found — using last {char_budget:,} chars")
        return text[-char_budget:]

    selected = text[anchor: anchor + char_budget]
    print(f"  [extract] extracted {len(selected):,} chars from position {anchor:,}")
    return selected


def extract_financials_from_reports(
    company: str,
    annual_text: str,
    quarterly_reports: list,
    ticker: str,
    force_refresh: bool = False,
) -> dict:
    """
    Parse PDF report text with Claude and return structured financial data.

    annual_text      : extracted text from the annual PDF (up to 35k chars)
    quarterly_reports: list of {period, text} dicts, most recent first
    force_refresh    : skip /tmp file cache (set True after a new PDF upload)
    Returns          : {profit_loss, balance_sheet, cash_flow, key_ratios, quarters}

    Cached for 24 hours (PDFs don't change intra-day).
    """
    # ── Cache check ──
    cache_path = _extract_cache(ticker)
    print(f"  [extract] cache_path={cache_path} | force_refresh={force_refresh} | exists={os.path.exists(cache_path)}")
    if not force_refresh:
        cached = _load_cache(cache_path, ttl_hours=24)
        if cached:
            print(f"  [extract] CACHE HIT — returning cached result (delete {cache_path} to re-extract)")
            return cached
        print(f"  [extract] cache miss — running Claude extraction")
    else:
        print(f"  [extract] force_refresh=True — skipping /tmp extraction cache, running Claude")

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
    annual_prompt_text = _select_financial_pages(annual_text, _MAX_ANNUAL_PROMPT)

    user_msg = f"""Extract all financial data for {company} from the report text below.

━━━ ANNUAL REPORT ━━━
{annual_prompt_text}

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
        print(f"  [extract] Claude raw output (first 1000 chars):\n{raw[:1000]}")

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

        # Log first profit_loss row to confirm bank fields are populated
        if result.get("profit_loss"):
            r0 = result["profit_loss"][0]
            print(f"  [extract] First P&L row: {json.dumps(r0, ensure_ascii=False)}")

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
