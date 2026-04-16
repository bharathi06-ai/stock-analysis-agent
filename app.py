import json
import os
import queue
import re
import threading
from flask import Flask, render_template, request, jsonify, Response, stream_with_context, session, redirect, url_for
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# Valid ticker pattern: letters, digits, hyphens, dots — max 20 chars
TICKER_RE = re.compile(r"^[A-Za-z0-9\-\.]{1,20}$")


@app.before_request
def require_login():
    if request.endpoint in ("login", "logout", "static"):
        return
    if not session.get("auth"):
        return redirect(url_for("login", next=request.path))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        password = request.form.get("password", "")
        expected = os.environ.get("LOGIN_PASSWORD", "")
        if password == expected:
            session["auth"] = True
            next_url = request.args.get("next") or url_for("index")
            return redirect(next_url)
        error = "Incorrect password"
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok", "message": "Swedish Stock Analysis Agent is running"})


@app.route("/api/demo")
def demo():
    """Return a rich mock payload to test the full 9-tab dashboard UI."""
    import math
    import random
    from datetime import date, timedelta

    random.seed(42)

    # 1-year price history — starting near 131.50 SEK (corrected from 171.35)
    start = date(2025, 4, 12)
    labels, prices, volumes = [], [], []
    price = 131.50
    for i in range(252):
        d = start + timedelta(days=i)
        if d.weekday() >= 5:
            continue
        labels.append(d.strftime("%Y-%m-%d"))
        price *= 1 + random.gauss(0, 0.012)
        prices.append(round(price, 2))
        volumes.append(random.randint(5_000_000, 40_000_000))

    pl = [
        {"year": 2024, "revenue": 47200, "gross_profit": 42100, "operating_income": 9800, "net_income": 8100, "ebitda": 11200},
        {"year": 2023, "revenue": 45100, "gross_profit": 40200, "operating_income": 9200, "net_income": 7600, "ebitda": 10800},
        {"year": 2022, "revenue": 41500, "gross_profit": 37100, "operating_income": 8100, "net_income": 6900, "ebitda": 9700},
        {"year": 2021, "revenue": 38200, "gross_profit": 34100, "operating_income": 7400, "net_income": 6100, "ebitda": 8900},
    ]
    bs = [
        {"year": 2024, "total_assets": 620000, "total_liabilities": 576000, "equity": 44000, "cash": 22000, "total_debt": 15000},
        {"year": 2023, "total_assets": 600000, "total_liabilities": 557000, "equity": 43000, "cash": 20000, "total_debt": 16000},
    ]
    cf = [
        {"year": 2024, "operating_cf": 10200, "investing_cf": -3400, "financing_cf": -5100, "free_cf": 6800, "capex": -3400},
        {"year": 2023, "operating_cf": 9700,  "investing_cf": -2900, "financing_cf": -4800, "free_cf": 6800, "capex": -2900},
        {"year": 2022, "operating_cf": 8800,  "investing_cf": -2400, "financing_cf": -4200, "free_cf": 6400, "capex": -2400},
    ]
    quarters = [
        {"period": "Q1 2025", "revenue": 12100, "gross_profit": 10800, "net_income": 2100},
        {"period": "Q4 2024", "revenue": 12800, "gross_profit": 11400, "net_income": 2300},
        {"period": "Q3 2024", "revenue": 11900, "gross_profit": 10600, "net_income": 1950},
        {"period": "Q2 2024", "revenue": 11400, "gross_profit": 10200, "net_income": 1850},
        {"period": "Q1 2024", "revenue": 11000, "gross_profit": 9800,  "net_income": 1750},
        {"period": "Q4 2023", "revenue": 11700, "gross_profit": 10400, "net_income": 2000},
        {"period": "Q3 2023", "revenue": 11200, "gross_profit": 9900,  "net_income": 1800},
        {"period": "Q2 2023", "revenue": 10900, "gross_profit": 9700,  "net_income": 1700},
    ]
    return jsonify({
        "ticker": "NDA-SE.ST",
        "company": {
            "name": "Nordea Bank Abp",
            "ticker": "NDA-SE.ST",
            "sector": "Financial Services",
            "industry": "Banks—Regional",
            "description": (
                "Nordea Bank Abp is the largest financial services group in the Nordic region, "
                "offering retail banking, corporate banking, asset management and private banking "
                "across Denmark, Finland, Norway and Sweden. With over 200 years of history, "
                "Nordea serves approximately 10 million personal and 500,000 corporate clients."
            ),
            "website": "https://www.nordea.com",
            "employees": 28000,
            "country": "Finland",
            "exchange": "XHEL / STO",
        },
        "market": {
            # Only what yfinance provides in the new pipeline.
            # market_cap_m is in MSEK — corrected from yfinance EUR→SEK bug
            # (raw yfinance returns market_cap in EUR for NDA-SE.ST; must multiply by EUR/SEK).
            # Real Nordea: ~3,970M shares × ~131 SEK ≈ 520,000 MSEK (520 BSEK).
            "price": 131.50,
            "currency": "SEK",
            "market_cap_m": 522_000,       # ~522 BSEK (corrected)
            "week_52_high": 155.20,
            "week_52_low": 116.40,
            "beta": 0.91,
            "avg_volume": 18200000,
            "shares_outstanding_m": 3_970,  # real Nordea share count (millions)
        },
        "profit_loss":   pl,
        "balance_sheet": bs,
        "cash_flow":     cf,
        "quarters":      quarters,
        "ratios": {
            # Valuation multiples: PDF earnings + live price (131.50 SEK)
            # EPS ~14.6 SEK → P/E ~9x; book value ~77 SEK → P/B ~1.7x
            "pe": 9.00, "forward_pe": None, "pb": 1.71, "ps": 2.74,
            # From annual report PDF
            "roe": 15.4, "roa": 1.2, "gross_margin": None,
            "operating_margin": 20.7, "net_margin": 17.1,
            "current_ratio": None, "debt_to_equity": 340.2,
            "dividend_yield": 8.37, "payout_ratio": 72.0,
            "dividend_per_share": 11.0,
            # Beta from yfinance
            "beta": 0.91,
            # EPS from annual report
            "eps": 14.6,
        },
        "data_sources": {
            "price_chart":  "Yahoo Finance — live",
            "financials":   "Company Annual Reports (PDF)",
            "quarters":     "Company Quarterly Reports (PDF)",
            "ratios":       "Annual Report (PDF) + live price",
            "news":         "Claude AI web search",
            "peers":        "Claude AI web search",
            "analysis":     "Claude AI",
        },
        "investors": [
            {"name": "Sampo Plc",              "shares": 810_000_000, "pct": 16.2, "value": 138800},
            {"name": "Nordea Fonder AB",        "shares": 210_000_000, "pct": 4.2,  "value": 35900},
            {"name": "BlackRock Inc.",          "shares": 148_000_000, "pct": 3.0,  "value": 25300},
            {"name": "Vanguard Group",          "shares": 112_000_000, "pct": 2.3,  "value": 19200},
            {"name": "State Street Corp.",      "shares": 95_000_000,  "pct": 1.9,  "value": 16300},
            {"name": "Swedbank Robur",          "shares": 82_000_000,  "pct": 1.7,  "value": 14000},
            {"name": "Fidelity Investments",    "shares": 78_000_000,  "pct": 1.6,  "value": 13400},
            {"name": "Capital Group",           "shares": 64_000_000,  "pct": 1.3,  "value": 10900},
        ],
        "chart": {"labels": labels, "prices": prices, "volumes": volumes},
        "analysis": (
            "Nordea Bank Abp stands as the undisputed leader in Nordic retail and corporate banking, "
            "with a market position built over two centuries of operations across Denmark, Finland, "
            "Norway and Sweden. The bank's diversified four-segment model — Personal Banking, Business Banking, "
            "Large Corporates & Institutions, and Asset & Wealth Management — provides resilience through "
            "economic cycles. Net interest income remains the dominant revenue driver, benefiting from "
            "the elevated Nordic rate environment, while fee income from asset management adds a stable "
            "recurring revenue stream.\n\n"
            "Financially, Nordea has demonstrated consistent capital generation, with a CET1 ratio "
            "comfortably above regulatory requirements and a progressive dividend policy returning "
            "significant capital to shareholders. Return on equity has expanded to ~15%, approaching "
            "management's mid-teens target ahead of schedule. Cost efficiency initiatives, including "
            "further digitisation of retail operations, have compressed the cost-income ratio to "
            "competitive levels among European peers.\n\n"
            "The competitive landscape is characterised by four dominant incumbent banks across the "
            "Nordics, limiting disruptive competition, though digital challengers and payment fintechs "
            "are gradually encroaching on transaction and payment services. Regulatory capital requirements "
            "and anti-money laundering compliance costs remain elevated following historical compliance "
            "issues, and macro sensitivity to Nordic housing markets represents a key tail risk.\n\n"
            "Valuation at ~11x earnings and 1.7x book is modest relative to European banking peers and "
            "the bank's quality franchise. The 6%+ dividend yield provides an attractive total return "
            "floor. With rate cuts likely gradual and the Nordic economy resilient, Nordea screens as "
            "a high-quality income holding at current prices."
        ),
        "peers": [
            {"name": "SEB",            "ticker": "SEB-A.ST",  "relationship": "Direct competitor",   "pe": 10.8, "roe_pct": 14.2, "dividend_yield_pct": 5.8,  "revenue_growth_pct": 2.1},
            {"name": "Handelsbanken",  "ticker": "SHB-A.ST",  "relationship": "Direct competitor",   "pe":  9.5, "roe_pct": 11.8, "dividend_yield_pct": 6.5,  "revenue_growth_pct": 1.4},
            {"name": "Swedbank",       "ticker": "SWED-A.ST", "relationship": "Direct competitor",   "pe": 10.2, "roe_pct": 16.1, "dividend_yield_pct": 7.1,  "revenue_growth_pct": 3.2},
            {"name": "Danske Bank",    "ticker": "DANSKE.CO", "relationship": "Regional peer",       "pe":  9.1, "roe_pct": 13.5, "dividend_yield_pct": 4.9,  "revenue_growth_pct": 1.8},
            {"name": "DNB Bank",       "ticker": "DNB.OL",    "relationship": "Regional peer",       "pe": 10.5, "roe_pct": 13.9, "dividend_yield_pct": 5.2,  "revenue_growth_pct": 2.4},
        ],
        "news": [
            {
                "title": "Nordea raises 2025 dividend guidance after strong Q1",
                "summary": "Nordea Bank reported Q1 2025 net profit above consensus and guided for a higher full-year dividend as NII held up despite first ECB rate cut.",
                "date": "2025-04-24",
                "sentiment": "positive",
            },
            {
                "title": "Nordea completes €1.5bn share buyback programme",
                "summary": "The bank completed its latest buyback ahead of schedule, having repurchased shares at an average price of SEK 175, further boosting earnings per share.",
                "date": "2025-03-12",
                "sentiment": "positive",
            },
            {
                "title": "Nordic housing market softening raises provisioning concerns",
                "summary": "Analysts flagged rising Swedish residential mortgage default rates as a risk to Nordea's credit quality, though provisioning remained well within guidance.",
                "date": "2025-02-28",
                "sentiment": "negative",
            },
            {
                "title": "Nordea Asset Management reaches €400bn AUM milestone",
                "summary": "Strong inflows and market appreciation pushed NAM past the €400bn mark, supporting fee income diversification strategy.",
                "date": "2025-01-15",
                "sentiment": "positive",
            },
            {
                "title": "ECB signals three rate cuts in 2025 — mixed for Nordic banks",
                "summary": "While rate reductions will compress NII margins, analysts note Nordea's liability mix is better positioned than peers to absorb the impact.",
                "date": "2024-12-18",
                "sentiment": "neutral",
            },
        ],
        "risks": [
            "NII compression if ECB/Riksbank rate cuts accelerate beyond market pricing",
            "Nordic residential real estate correction impacting mortgage credit quality",
            "Heightened AML/compliance costs and regulatory scrutiny in multiple jurisdictions",
            "Digital disruption from payment fintechs eroding retail transaction fee income",
        ],
        "opportunities": [
            "Progressive dividend and buyback programme delivering above-market total returns",
            "Asset & Wealth Management AUM growth driving recurring fee income expansion",
            "Continued cost-efficiency gains from digital branch transformation",
            "Potential M&A optionality in Baltic or Central European markets",
        ],
        "verdict": (
            "Nordea is a safe, well-run bank that pays generous dividends. At current prices it looks cheap "
            "compared to similar banks in Europe — a solid choice for investors who want steady income from a "
            "company with over 200 years of history."
        ),
        "key_strengths": [
            "Pays investors a 6% dividend every year — one of the highest among European banks",
            "Very low risk: CET1 capital ratio of 16.8% is well above what regulators require",
            "Strong market position: the largest bank in the Nordic region with 10 million customers",
        ],
        "key_risks": [
            "If interest rates fall, Nordea earns less profit on loans — reducing future dividends",
            "If Swedish and Finnish house prices drop sharply, more customers may struggle to repay mortgages",
            "Ongoing regulatory costs from past money-laundering investigations add unpredictable expenses",
        ],
        "recommendation": {
            "rating": "Buy",
            "rationale": "Attractive 8%+ yield, disciplined capital return, and ~9x P/E offer compelling risk/reward for the Nordic region's largest bank.",
        },
        "key_metrics_from_reports": {
            "revenue_latest": 47200,
            "net_income_latest": 8100,
            "dividend_per_share": 10.5,
            "notes": "CET1 ratio 16.8% (Q1 2025), cost-income ratio 44.2%, NIM 1.74%.",
        },
        "last_updated": "2026-04-12 06:25 UTC (demo data)",
    })


@app.route("/api/analyse", methods=["POST"])
def analyse():
    data = request.get_json(silent=True) or {}
    ticker = (data.get("ticker") or "").strip().upper()

    if not ticker:
        return jsonify({"error": "No ticker provided"}), 400
    if not TICKER_RE.match(ticker):
        return jsonify({"error": "Invalid ticker format"}), 400

    # Use a queue so the background thread can push progress events and the
    # final result to the SSE generator without blocking either side.
    q = queue.Queue()

    def run():
        from agent import analyse_stock

        def on_progress(message, step, total):
            q.put({"type": "progress", "message": message,
                   "step": step, "total": total})

        try:
            result = analyse_stock(ticker, progress_callback=on_progress)
            if "error" in result:
                q.put({"type": "error", "message": result["error"]})
            else:
                q.put({"type": "done", "result": result})
        except Exception as exc:
            q.put({"type": "error", "message": str(exc)})

    threading.Thread(target=run, daemon=True).start()

    def generate():
        while True:
            try:
                event = q.get(timeout=180)   # 3-minute hard cap per step
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Analysis timed out after 3 minutes'})}\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                break

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # tell nginx / Render not to buffer
        },
    )


@app.route("/api/refresh", methods=["POST"])
def refresh():
    """Force re-run of the full pipeline for a ticker, bypassing the cache."""
    data = request.get_json(silent=True) or {}
    ticker = (data.get("ticker") or "").strip().upper()

    if not ticker:
        return jsonify({"error": "No ticker provided"}), 400
    if not TICKER_RE.match(ticker):
        return jsonify({"error": "Invalid ticker format"}), 400

    q = queue.Queue()

    def run():
        from agent import analyse_stock

        def on_progress(message, step, total):
            q.put({"type": "progress", "message": message,
                   "step": step, "total": total})

        try:
            result = analyse_stock(ticker, progress_callback=on_progress,
                                   force_refresh=True)
            if "error" in result:
                q.put({"type": "error", "message": result["error"]})
            else:
                q.put({"type": "done", "result": result})
        except Exception as exc:
            q.put({"type": "error", "message": str(exc)})

    threading.Thread(target=run, daemon=True).start()

    def generate():
        while True:
            try:
                event = q.get(timeout=180)
            except queue.Empty:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Refresh timed out after 3 minutes'})}\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                break

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=True, port=port)
