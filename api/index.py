import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import os
import queue
import re
import threading
from flask import Flask, render_template, request, jsonify, Response, stream_with_context, session, redirect, url_for
from dotenv import load_dotenv

load_dotenv()

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(__name__,
    template_folder=os.path.join(_root, 'templates'),
    static_folder=os.path.join(_root, 'static')
)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# Company name: letters, digits, spaces, hyphens, periods, ampersands — max 80 chars
COMPANY_RE = re.compile(r"^[A-Za-z0-9\s\-\.&,()]{1,80}$")


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
    return jsonify({"status": "ok", "message": "StockDesk is running"})


@app.route("/api/analyse", methods=["POST"])
def analyse():
    data = request.get_json(silent=True) or {}
    # Accept company_name (new) or ticker (legacy)
    raw_name = data.get("company_name") or data.get("ticker")
    company_name = (raw_name or "").strip()

    if not company_name:
        return jsonify({"error": "No company name provided"}), 400
    if not COMPANY_RE.match(company_name):
        return jsonify({"error": "Invalid company name format"}), 400

    q = queue.Queue()

    def run():
        from agent import analyse_stock

        def on_progress(message, step, total):
            q.put({"type": "progress", "message": message,
                   "step": step, "total": total})

        try:
            # company_name is stored in the ticker column throughout the pipeline
            result = analyse_stock(company_name, progress_callback=on_progress)
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
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/refresh", methods=["POST"])
def refresh():
    """Force re-run of the full pipeline, bypassing the cache."""
    data = request.get_json(silent=True) or {}
    raw_name = data.get("company_name") or data.get("ticker")
    company_name = (raw_name or "").strip()

    if not company_name:
        return jsonify({"error": "No company name provided"}), 400
    if not COMPANY_RE.match(company_name):
        return jsonify({"error": "Invalid company name format"}), 400

    q = queue.Queue()

    def run():
        from agent import analyse_stock

        def on_progress(message, step, total):
            q.put({"type": "progress", "message": message,
                   "step": step, "total": total})

        try:
            result = analyse_stock(company_name, progress_callback=on_progress,
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


@app.route("/api/delete_report", methods=["POST"])
def delete_report():
    """Delete a single report row from the reports table."""
    data = request.get_json(silent=True) or {}
    report_id    = (data.get("id") or "").strip()
    company_name = (data.get("company_name") or "").strip()
    period       = (data.get("period") or "").strip()
    report_type  = (data.get("report_type") or "").strip().lower()

    if not report_id and not company_name:
        return jsonify({"error": "id or company_name is required"}), 400

    from db import _get_client
    client = _get_client()
    if client is None:
        return jsonify({"error": "Database not configured"}), 500

    try:
        if report_id:
            client.table("reports").delete().eq("id", report_id).execute()
            print(f"[delete_report] Deleted report id={report_id}")
        else:
            if not period:
                return jsonify({"error": "period is required"}), 400
            if report_type not in ("annual", "quarterly"):
                return jsonify({"error": "report_type must be 'annual' or 'quarterly'"}), 400
            client.table("reports") \
                .delete() \
                .eq("company_name", company_name) \
                .eq("period", period) \
                .eq("report_type", report_type) \
                .execute()
            print(f"[delete_report] Deleted {company_name} / {period} / {report_type}")
        return jsonify({"success": True})
    except Exception as exc:
        print(f"[delete_report] Error: {exc}")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/list_reports", methods=["GET"])
def list_reports():
    from api.list_reports import handle_list_reports
    return handle_list_reports()


@app.route("/api/upload", methods=["POST"])
def upload():
    from api.upload import handle_upload
    return handle_upload()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=True, port=port)
