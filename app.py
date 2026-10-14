"""FIPO - servidor Flask (API JSON + aplicación de una sola página)."""
import csv
import hashlib
import io
import json
import os
import re
import secrets
import smtplib
from datetime import datetime, timedelta
from email.message import EmailMessage
from functools import wraps
from zoneinfo import ZoneInfo, available_timezones

from flask import Flask, Response, g, jsonify, request, session, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

import cards
import importer
import ledger
import more
import mailer
import notify
import widgets
import autodeploy
import portfolio
import restore
from db import atomic, close_db, get_db, init_db
from ledger import ValidationError, clean_text, to_cents, parse_date

BASE = os.path.dirname(os.path.abspath(__file__))


def env(name, default=None):
    """Lee FIPO_<name>; acepta también el nombre anterior OLIVA_<name>."""
    return os.environ.get("FIPO_" + name, os.environ.get("OLIVA_" + name, default))
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TIMEZONES = sorted(available_timezones())


def create_app(db_path=None, testing=False):
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    inst = env("DATA_DIR", os.path.join(BASE, "instance"))
    os.makedirs(inst, exist_ok=True)
    legacy = os.path.join(inst, "oliva.db")
    default_db = legacy if os.path.exists(legacy) and not os.path.exists(os.path.join(inst, "fipo.db")) else os.path.join(inst, "fipo.db")
    app.config["DATABASE"] = db_path or env("DB", default_db)
    app.config["TESTING"] = testing
    app.config["RECEIPTS_DIR"] = os.path.join(os.path.dirname(db_path), "receipts") if db_path else env("RECEIPTS_DIR", os.path.join(inst, "receipts"))
    app.config["SECRET_KEY"] = _secret_key(inst)
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = env("HTTPS") == "1"
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=14)
    app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
    init_db(app.config["DATABASE"])
    app.teardown_appcontext(close_db)
    register_routes(app)
    notify.register(app, login_required, current_user, json_body, api_error)
    notify.register_push(app, login_required, current_user, json_body, api_error)
    more.register(app, login_required, current_user, json_body, api_error)
    cards.register(app, login_required, current_user, json_body, api_error)
    widgets.register(app, login_required, current_user, json_body, api_error)
    autodeploy.register(app, inst, api_error)
    if not testing and env("NO_SCHEDULER") != "1":
        portfolio.start_scheduler(app.config["DATABASE"], interval=int(env("REFRESH_SECONDS", portfolio.REFRESH_SECONDS)),
                                   after=notify.run_all)
    return app


def _secret_key(inst):
    configured = env("SECRET")
    if configured:
        return configured
    path = os.path.join(inst, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
        os.chmod(path, 0o600)
    with open(path) as f:
        return f.read().strip()


# ------------------------------------------------------------------ helpers
def api_error(message, status=400, field=None):
    return jsonify({"error": message, "field": field}), status


def current_user():
    if "user" in g:
        return g.user
    g.user = None
    uid = session.get("uid")
    if uid:
        u = get_db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if u and u["session_ver"] == session.get("ver"):
            g.user = u
    return g.user


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not current_user():
            return api_error("Inicia sesión para continuar.", 401)
        return fn(*a, **kw)
    return wrapper


def user_dict(u):
    return {"id": u["id"], "name": u["name"], "email": u["email"], "currency": u["currency"],
            "timezone": u["timezone"], "theme": u["theme"], "onboarded": bool(u["onboarded"]),
            "notify_email": bool(u["notify_email"])}


def json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValidationError("Solicitud no válida.")
    return data


def check_password(pw):
    if not isinstance(pw, str) or len(pw) < 8:
        raise ValidationError("La contraseña debe tener al menos 8 caracteres.", "password")
    if len(pw) > 200:
        raise ValidationError("La contraseña es demasiado larga.", "password")


def throttled(db, key, limit=8, minutes=15):
    n = db.execute("SELECT COUNT(*) FROM login_attempts WHERE key=? AND at > datetime('now', ?)",
                   (key, f"-{minutes} minutes")).fetchone()[0]
    return n >= limit


def start_session(user):
    session.clear()
    session.permanent = True
    session["uid"] = user["id"]
    session["ver"] = user["session_ver"]


def send_reset(email, link):
    if not mailer.configured():
        print(f"\n[FIPO] Enlace de recuperación para {email}:\n  {link}\n", flush=True)
        return
    mailer.send(email, "Recupera tu contraseña de FIPO",
                f"Usa este enlace para crear una contraseña nueva (válido 1 hora):\n\n{link}\n\nSi no lo solicitaste, ignora este correo.")


def csv_safe(v):
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def money(c):
    return f"{c / 100:.2f}"


# ------------------------------------------------------------------ rutas
def register_routes(app):

    @app.after_request
    def security_headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "same-origin"
        resp.headers["Content-Security-Policy"] = ("default-src 'self'; img-src 'self' data:; "
                                                   "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        elif "Cache-Control" not in resp.headers or request.path == "/" or request.path.startswith("/static/"):
            # la página y sus archivos se revisan siempre con el servidor (ETag): al subir un zip nuevo, el iPhone
            # ya no se queda con la versión vieja guardada
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.before_request
    def csrf_guard():
        if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS") and request.path != "/api/deploy":
            if request.headers.get("X-Requested-With") != "fipo":   # /api/deploy lo protege la firma de GitHub
                return api_error("Solicitud rechazada.", 403)

    @app.errorhandler(ValidationError)
    def on_validation(e):
        return api_error(e.message, e.status, e.field)

    @app.errorhandler(404)
    def on_404(_e):
        if request.path.startswith("/api/"):
            return api_error("No encontrado.", 404)
        return send_from_directory(os.path.join(BASE, "templates"), "index.html")

    @app.errorhandler(413)
    def on_413(_e):
        return api_error("La solicitud es demasiado grande.", 413)

    @app.errorhandler(500)
    def on_500(_e):
        return api_error("Ocurrió un error inesperado. Intenta de nuevo.", 500)

    @app.get("/sw.js")
    def service_worker():
        # en la raíz para que controle toda la app; sin caché para que las actualizaciones lleguen
        resp = send_from_directory(os.path.join(BASE, "static"), "sw.js", mimetype="application/javascript", max_age=0)
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/healthz")
    def healthz():
        get_db().execute("SELECT 1")
        return jsonify({"ok": True})

    @app.get("/")
    def index():
        return send_from_directory(os.path.join(BASE, "templates"), "index.html")

    # ---------------- autenticación
    @app.post("/api/auth/register")
    def register():
        d, db = json_body(), get_db()
        name = clean_text(d.get("name"), "name", 80, required=True)
        email = clean_text(d.get("email"), "email", 200, required=True).lower()
        if not EMAIL_RE.match(email):
            raise ValidationError("Correo electrónico no válido.", "email")
        check_password(d.get("password"))
        with atomic(db):
            if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
                raise ValidationError("Ya existe una cuenta con ese correo.", "email", 409)
            uid = db.execute("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
                             (name, email, generate_password_hash(d["password"]))).lastrowid
            ledger.seed_categories(db, uid)
        user = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        start_session(user)
        return jsonify({"user": user_dict(user)}), 201

    @app.post("/api/auth/login")
    def login():
        d, db = json_body(), get_db()
        email = str(d.get("email", "")).strip().lower()
        key = f"{email}|{request.remote_addr}"
        if throttled(db, key):
            return api_error("Demasiados intentos. Espera unos minutos e inténtalo de nuevo.", 429)
        u = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        ok = check_password_hash(u["password_hash"], str(d.get("password", ""))) if u else False
        if not ok:
            db.execute("INSERT INTO login_attempts (key) VALUES (?)", (key,))
            return api_error("Correo o contraseña incorrectos.", 401)
        db.execute("DELETE FROM login_attempts WHERE key = ?", (key,))
        start_session(u)
        return jsonify({"user": user_dict(u)})

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return jsonify({"ok": True})

    @app.post("/api/auth/forgot")
    def forgot():
        d, db = json_body(), get_db()
        email = str(d.get("email", "")).strip().lower()
        key = f"forgot|{request.remote_addr}"
        if throttled(db, key, limit=5, minutes=15):
            return api_error("Demasiadas solicitudes. Inténtalo más tarde.", 429)
        db.execute("INSERT INTO login_attempts (key) VALUES (?)", (key,))
        u = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if u:
            token = secrets.token_urlsafe(32)
            db.execute("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 hour'))",
                       (u["id"], hashlib.sha256(token.encode()).hexdigest()))
            try:
                send_reset(email, f"{request.host_url}#/reset/{token}")
            except Exception as exc:  # el fallo de correo no debe revelar si la cuenta existe
                print(f"[FIPO] No se pudo enviar el correo: {exc}", flush=True)
        # Respuesta idéntica exista o no la cuenta
        return jsonify({"ok": True})

    @app.post("/api/auth/reset")
    def reset():
        d, db = json_body(), get_db()
        check_password(d.get("password"))
        th = hashlib.sha256(str(d.get("token", "")).encode()).hexdigest()
        with atomic(db):
            r = db.execute("SELECT * FROM password_resets WHERE token_hash=? AND used=0 AND expires_at > datetime('now')", (th,)).fetchone()
            if not r:
                raise ValidationError("El enlace no es válido o ya expiró. Solicita uno nuevo.")
            db.execute("UPDATE password_resets SET used=1 WHERE id=?", (r["id"],))
            db.execute("UPDATE users SET password_hash=?, session_ver=session_ver+1 WHERE id=?",
                       (generate_password_hash(d["password"]), r["user_id"]))
        return jsonify({"ok": True})

    # ---------------- perfil
    @app.get("/api/me")
    def me():
        u = current_user()
        if not u:
            return api_error("No autenticado.", 401)
        return jsonify({"user": user_dict(u), "currencies": list(ledger.CURRENCIES), "timezones": TIMEZONES, "email_available": mailer.configured()})

    @app.patch("/api/me")
    @login_required
    def update_me():
        u, d, db = current_user(), json_body(), get_db()
        name = clean_text(d.get("name", u["name"]), "name", 80, required=True)
        currency = d.get("currency", u["currency"])
        if currency not in ledger.CURRENCIES:
            raise ValidationError("Moneda no compatible.", "currency")
        tz = d.get("timezone", u["timezone"])
        if tz not in TIMEZONES:
            raise ValidationError("Zona horaria no válida.", "timezone")
        theme = d.get("theme", u["theme"])
        if theme not in ("light", "dark"):
            raise ValidationError("Tema no válido.", "theme")
        ne = bool(d["notify_email"]) if "notify_email" in d else bool(u["notify_email"])
        if ne and not mailer.configured():
            raise ValidationError("Este servidor no tiene correo configurado (FIPO_SMTP_HOST), así que no puede enviar avisos por correo.", "notify_email")
        db.execute("UPDATE users SET name=?, currency=?, timezone=?, theme=?, notify_email=? WHERE id=?", (name, currency, tz, theme, int(ne), u["id"]))
        g.pop("user", None)
        return jsonify({"user": user_dict(current_user())})

    @app.post("/api/me/password")
    @login_required
    def change_password():
        u, d, db = current_user(), json_body(), get_db()
        if not check_password_hash(u["password_hash"], str(d.get("current", ""))):
            raise ValidationError("La contraseña actual no es correcta.", "current")
        check_password(d.get("password"))
        db.execute("UPDATE users SET password_hash=?, session_ver=session_ver+1 WHERE id=?",
                   (generate_password_hash(d["password"]), u["id"]))
        new = db.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
        start_session(new)  # cierra las demás sesiones, mantiene esta
        return jsonify({"ok": True})

    @app.post("/api/onboarding")
    @login_required
    def onboarding():
        u, d, db = current_user(), json_body(), get_db()
        currency = d.get("currency", u["currency"])
        if currency not in ledger.CURRENCIES:
            raise ValidationError("Moneda no compatible.", "currency")
        accounts = d.get("accounts") or []
        if not isinstance(accounts, list) or len(accounts) > 20:
            raise ValidationError("Lista de cuentas no válida.")
        today = ledger.today_for(u["timezone"]).isoformat()
        with atomic(db):
            db.execute("UPDATE users SET currency=? WHERE id=?", (currency, u["id"]))
            for a in accounts:
                create_account(db, u["id"], a, default_currency=currency, default_date=today)
            db.execute("UPDATE users SET onboarded=1 WHERE id=?", (u["id"],))
        g.pop("user", None)
        return jsonify({"user": user_dict(current_user())})

    # ---------------- cuentas
    def credit_fields(d, typ, a=None):
        """Límite, día de corte y día de pago (solo tarjetas de crédito)."""
        if typ != "credit":
            return 0, 0, 0
        limit = to_cents(d.get("credit_limit", (a["credit_limit"] / 100) if a else 0) or 0, "credit_limit", allow_zero=True)
        days = []
        for k in ("cut_day", "due_day"):
            try:
                v = int(d.get(k, a[k] if a else 0) or 0)
            except (TypeError, ValueError):
                raise ValidationError("Indica un día entre 1 y 31.", k)
            if not 0 <= v <= 31:
                raise ValidationError("Indica un día entre 1 y 31.", k)
            days.append(v)
        return limit, days[0], days[1]

    def create_account(db, uid, d, default_currency="MXN", default_date=None):
        typ = d.get("type", "bank")
        if typ not in ledger.ACCOUNT_TYPES:
            raise ValidationError("Tipo de cuenta no válido.", "type")
        cur = d.get("currency") or default_currency
        if cur not in ledger.CURRENCIES:
            raise ValidationError("Moneda no compatible.", "currency")
        low = to_cents(d.get("low_balance_alert", 0) or 0, "low_balance_alert", allow_zero=True)
        limit, cut, due = credit_fields(d, typ)
        plans = []
        if typ == "credit" and ("owed_now" in d or "plans" in d):
            # Tarjeta: "¿cuánto debes hoy?" en positivo (el teclado del iPhone no tiene signo menos), separado en lo
            # que no está a meses y los planes a meses que ya traes. El saldo inicial es la suma, en negativo (deuda).
            owed = to_cents(d.get("owed_now") or 0, "owed_now", allow_zero=True)
            in_favor = to_cents(d.get("credit_in_favor") or 0, "credit_in_favor", allow_zero=True)
            raw = d.get("plans") or []
            if not isinstance(raw, list) or len(raw) > 30:
                raise ValidationError("Lista de planes no válida.", "plans")
            plans = [cards.parse_plan(p or {}, cut, field_prefix=f"plans.{i}.") for i, p in enumerate(raw)]
            ob = in_favor - owed - sum(p["principal_remaining"] for p in plans)
        else:
            ob = to_cents(d.get("opening_balance", 0) or 0, "opening_balance", allow_negative=True, allow_zero=True)
        aid = db.execute(
            "INSERT INTO accounts (user_id,name,institution,type,currency,opening_balance,opened_on,low_balance_alert,credit_limit,cut_day,due_day) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uid, clean_text(d.get("name"), "name", 80, required=True), clean_text(d.get("institution"), "institution", 80),
             typ, cur, ob, parse_date(d.get("opened_on") or default_date, "opened_on"), low, limit, cut, due)).lastrowid
        for p in plans:
            cards.insert_plan(db, uid, aid, p, default_date or parse_date(d.get("opened_on"), "opened_on"))
        return aid

    @app.post("/api/restore")
    @login_required
    def restore_data():
        """«Cargar mis datos»: dry_run=true muestra exactamente lo que quedaría, sin guardar; false lo guarda (todo o nada)."""
        u, d, db = current_user(), json_body(), get_db()
        return jsonify(restore.load(db, u, d.get("data"), create_account, dry_run=d.get("dry_run", True) is not False))

    def enrich_accounts(db, u, rows):
        """Cuentas de inversión: total = efectivo + acciones ligadas. Otras monedas: equivalente en tu moneda principal
        (solo con el tipo de cambio ya guardado: esta lista se consulta muy seguido)."""
        hold = portfolio.account_holdings(db, u["id"])
        rates = portfolio.fx_rates(db, u["currency"], [r["currency"] for r in rows], fetch=False)
        for r in rows:
            h = hold.get(r["id"])
            r["holdings_value"] = h["value"] if h else 0
            r["holdings_positions"] = h["positions"] if h else 0
            r["holdings_unpriced"] = h["unpriced"] if h else []
            r["total_value"] = r["balance"] + r["holdings_value"]
            rate = rates.get(r["currency"])
            r["fx_rate"] = rate
            r["total_value_main"] = round(r["total_value"] * rate) if rate else None
        return rows

    @app.get("/api/accounts")
    @login_required
    def accounts_list():
        u, db = current_user(), get_db()
        return jsonify({"accounts": enrich_accounts(db, u, ledger.list_accounts(db, u["id"]))})

    @app.post("/api/accounts")
    @login_required
    def accounts_create():
        u, db = current_user(), get_db()
        today = ledger.today_for(u["timezone"]).isoformat()
        with atomic(db):
            aid = create_account(db, u["id"], json_body(), u["currency"], today)
        a = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        return jsonify({"account": ledger.account_row(a, ledger.balances(db, u["id"])[aid])}), 201

    @app.get("/api/accounts/<int:aid>")
    @login_required
    def account_get(aid):
        u, db = current_user(), get_db()
        h = ledger.account_history(db, u["id"], aid, ledger.today_for(u["timezone"]))
        enrich_accounts(db, u, [h["account"]])
        return jsonify(h)

    @app.patch("/api/accounts/<int:aid>")
    @login_required
    def account_update(aid):
        u, d, db = current_user(), json_body(), get_db()
        with atomic(db):
            a = ledger.owned(db, "accounts", aid, u["id"])
            if not a:
                raise ValidationError("Cuenta no encontrada.", status=404)
            typ = d.get("type", a["type"])
            if typ not in ledger.ACCOUNT_TYPES:
                raise ValidationError("Tipo de cuenta no válido.", "type")
            used = db.execute("SELECT COUNT(*) FROM transactions WHERE user_id=? AND (account_id=? OR to_account_id=?)",
                              (u["id"], aid, aid)).fetchone()[0]
            cur = d.get("currency", a["currency"])
            if cur != a["currency"] and used:
                raise ValidationError("No puedes cambiar la moneda de una cuenta con movimientos.", "currency")
            if cur not in ledger.CURRENCIES:
                raise ValidationError("Moneda no compatible.", "currency")
            low = to_cents(d.get("low_balance_alert", a["low_balance_alert"] / 100) or 0, "low_balance_alert", allow_zero=True)
            limit, cut, due = credit_fields(d, typ, a)
            db.execute("UPDATE accounts SET name=?, institution=?, type=?, currency=?, low_balance_alert=?, archived=?, opened_on=?, credit_limit=?, cut_day=?, due_day=? WHERE id=? AND user_id=?",
                       (clean_text(d.get("name", a["name"]), "name", 80, required=True),
                        clean_text(d.get("institution", a["institution"]), "institution", 80), typ, cur, low,
                        1 if d.get("archived", a["archived"]) else 0, parse_date(d.get("opened_on", a["opened_on"]), "opened_on"), limit, cut, due, aid, u["id"]))
        a = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        return jsonify({"account": ledger.account_row(a, ledger.balances(db, u["id"])[aid])})

    @app.delete("/api/accounts/<int:aid>")
    @login_required
    def account_delete(aid):
        u, db = current_user(), get_db()
        with atomic(db):
            if not ledger.owned(db, "accounts", aid, u["id"]):
                raise ValidationError("Cuenta no encontrada.", status=404)
            used = db.execute("SELECT COUNT(*) FROM transactions WHERE user_id=? AND (account_id=? OR to_account_id=?)",
                              (u["id"], aid, aid)).fetchone()[0]
            used += db.execute("SELECT (SELECT COUNT(*) FROM debt_payments WHERE account_id=?) + (SELECT COUNT(*) FROM holding_ops WHERE account_id=?)", (aid, aid)).fetchone()[0]
            if used:
                raise ValidationError("La cuenta tiene movimientos. Archívala en lugar de eliminarla.", status=409)
            db.execute("DELETE FROM accounts WHERE id=? AND user_id=?", (aid, u["id"]))
        return jsonify({"ok": True})

    @app.post("/api/accounts/<int:aid>/adjust")
    @login_required
    def account_adjust(aid):
        u, d, db = current_user(), json_body(), get_db()
        today = ledger.today_for(u["timezone"]).isoformat()
        diff = ledger.adjust_account(db, u["id"], aid, d.get("new_balance"), d.get("date") or today, d.get("note"))
        return jsonify({"ok": True, "difference": diff})

    # ---------------- categorías
    @app.get("/api/categories")
    @login_required
    def categories_list():
        rows = get_db().execute("""SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id=c.id) AS uses
                                   FROM categories c WHERE c.user_id=? ORDER BY c.archived, c.kind, c.name COLLATE NOCASE""",
                                (current_user()["id"],)).fetchall()
        return jsonify({"categories": [{"id": r["id"], "name": r["name"], "kind": r["kind"], "parent_id": r["parent_id"],
                                         "archived": bool(r["archived"]), "is_demo": bool(r["is_demo"]), "uses": r["uses"]} for r in rows]})

    @app.post("/api/categories")
    @login_required
    def categories_create():
        u, d, db = current_user(), json_body(), get_db()
        kind = d.get("kind")
        if kind not in ("expense", "income"):
            raise ValidationError("Tipo de categoría no válido.", "kind")
        name = clean_text(d.get("name"), "name", 60, required=True)
        parent = None
        if d.get("parent_id"):
            p = ledger.owned(db, "categories", d["parent_id"], u["id"])
            if not p or p["kind"] != kind or p["parent_id"]:
                raise ValidationError("Categoría principal no válida.", "parent_id")
            parent = p["id"]
        if db.execute("SELECT 1 FROM categories WHERE user_id=? AND kind=? AND name=? COLLATE NOCASE AND archived=0 AND IFNULL(parent_id,0)=IFNULL(?,0)",
                      (u["id"], kind, name, parent)).fetchone():
            raise ValidationError("Ya existe una categoría con ese nombre.", "name", 409)
        cid = db.execute("INSERT INTO categories (user_id,name,kind,parent_id) VALUES (?,?,?,?)", (u["id"], name, kind, parent)).lastrowid
        return jsonify({"category": {"id": cid, "name": name, "kind": kind, "parent_id": parent, "archived": False, "uses": 0}}), 201

    @app.patch("/api/categories/<int:cid>")
    @login_required
    def categories_update(cid):
        u, d, db = current_user(), json_body(), get_db()
        c = ledger.owned(db, "categories", cid, u["id"])
        if not c:
            raise ValidationError("Categoría no encontrada.", status=404)
        db.execute("UPDATE categories SET name=?, archived=? WHERE id=? AND user_id=?",
                   (clean_text(d.get("name", c["name"]), "name", 60, required=True), 1 if d.get("archived", c["archived"]) else 0, cid, u["id"]))
        return jsonify({"ok": True})

    @app.delete("/api/categories/<int:cid>")
    @login_required
    def categories_delete(cid):
        u, db = current_user(), get_db()
        with atomic(db):
            if not ledger.owned(db, "categories", cid, u["id"]):
                raise ValidationError("Categoría no encontrada.", status=404)
            if db.execute("SELECT COUNT(*) FROM transactions WHERE category_id=?", (cid,)).fetchone()[0]:
                raise ValidationError("La categoría tiene movimientos. Archívala en lugar de eliminarla.", status=409)
            db.execute("UPDATE categories SET parent_id=NULL WHERE parent_id=? AND user_id=?", (cid, u["id"]))
            db.execute("DELETE FROM categories WHERE id=? AND user_id=?", (cid, u["id"]))
        return jsonify({"ok": True})

    # ---------------- movimientos
    @app.get("/api/transactions")
    @login_required
    def tx_list():
        rows, total, page, per = ledger.query_transactions(get_db(), current_user()["id"], request.args)
        return jsonify({"transactions": rows, "total": total, "page": page, "per_page": per})

    @app.post("/api/transactions")
    @login_required
    def tx_create():
        u, db, d = current_user(), get_db(), json_body()
        with atomic(db):
            tid = ledger.insert_tx(db, u["id"], d)
            if d.get("installments"):
                cards.attach_purchase_plan(db, u["id"], tid, d["installments"])
        return jsonify({"transaction": ledger.tx_dict(db.execute(ledger.TX_SELECT + " WHERE t.id=?", (tid,)).fetchone())}), 201

    @app.get("/api/transactions/<int:tid>")
    @login_required
    def tx_get(tid):
        r = get_db().execute(ledger.TX_SELECT + " WHERE t.id=? AND t.user_id=?", (tid, current_user()["id"])).fetchone()
        if not r:
            return api_error("Movimiento no encontrado.", 404)
        return jsonify({"transaction": ledger.tx_dict(r)})

    @app.put("/api/transactions/<int:tid>")
    @login_required
    def tx_update(tid):
        u, db, d = current_user(), get_db(), json_body()
        spec_given = "installments" in d and cards.spec_differs(db, u["id"], tid, d.get("installments"))
        def after(existing, tx):
            if spec_given:
                cards.attach_purchase_plan(db, u["id"], tid, d["installments"])
            else:
                cards.resync_purchase_plan(db, u["id"], tid)
        ledger.update_tx(db, u["id"], tid, d, before=lambda ex, tx: cards.purchase_plan_guard(db, u["id"], ex, tx, spec_given), after=after)
        return jsonify({"transaction": ledger.tx_dict(db.execute(ledger.TX_SELECT + " WHERE t.id=?", (tid,)).fetchone())})

    @app.delete("/api/transactions/<int:tid>")
    @login_required
    def tx_delete(tid):
        db, uid = get_db(), current_user()["id"]
        ledger.delete_tx(db, uid, tid, before=lambda t: cards.before_delete_tx(db, uid, t))
        return jsonify({"ok": True})

    @app.get("/api/transactions.csv")
    @login_required
    def tx_csv():
        rows, _, _, _ = ledger.query_transactions(get_db(), current_user()["id"], request.args, paginate=False)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["Fecha", "Tipo", "Descripción", "Categoría", "Cuenta", "Cuenta destino", "Importe", "Importe destino",
                    "Método de pago", "Etiquetas", "Notas", "Recurrente"])
        for r in rows:
            w.writerow([r["date"], r["type"], csv_safe(r["description"]), csv_safe(r["category_name"]), csv_safe(r["account_name"]),
                        csv_safe(r["to_account_name"]), money(r["amount"]), money(r["to_amount"]) if r["to_amount"] is not None else "",
                        csv_safe(r["payment_method"]), csv_safe(r["tags"]), csv_safe(r["notes"]), "sí" if r["recurring"] else "no"])
        return Response("﻿" + buf.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=movimientos.csv"})

    # ---------------- dashboard, demo, exportación
    @app.get("/api/dashboard")
    @login_required
    def dash():
        u, db = current_user(), get_db()
        d = ledger.dashboard(db, u, request.args)
        pv = portfolio.value_in_main(db, u)                 # valor de mercado del portafolio (con precio real; otras monedas convertidas)
        d["alerts"] = d["alerts"] + more.budget_alerts(db, u)
        d["cards"]["portfolio_value"] = pv
        d["cards"]["investments_value"] += pv
        d["cards"]["net_worth"] += pv
        return jsonify(d)

    @app.post("/api/demo")
    @login_required
    def demo_load():
        u = current_user()
        n = ledger.load_demo(get_db(), u["id"], ledger.today_for(u["timezone"]))
        return jsonify({"ok": True, "created": n})

    @app.delete("/api/demo")
    @login_required
    def demo_delete():
        return jsonify({"ok": True, "deleted": ledger.delete_demo(get_db(), current_user()["id"])})

    @app.get("/api/export.json")
    @login_required
    def export_all():
        u, db = current_user(), get_db()
        out = {"exported_at": datetime.utcnow().isoformat() + "Z", "user": user_dict(u),
               "accounts": ledger.list_accounts(db, u["id"]),
               "categories": [dict(r) for r in db.execute("SELECT id,name,kind,parent_id,archived FROM categories WHERE user_id=?", (u["id"],))],
               "transactions": ledger.query_transactions(db, u["id"], {}, paginate=False)[0]}
        return Response(json.dumps(out, ensure_ascii=False, indent=2), mimetype="application/json",
                        headers={"Content-Disposition": "attachment; filename=fipo-datos.json"})

    @app.delete("/api/me")
    @login_required
    def delete_me():
        u, d, db = current_user(), json_body(), get_db()
        if not check_password_hash(u["password_hash"], str(d.get("password", ""))):
            raise ValidationError("La contraseña no es correcta.", "password")
        with atomic(db):
            files = [r["path"] for r in db.execute("SELECT path FROM receipts WHERE user_id=?", (u["id"],))]
            for tbl in ("receipts", "debt_payments", "holding_ops", "price_alerts", "notifications"):
                db.execute(f"DELETE FROM {tbl} WHERE user_id=?", (u["id"],))
            db.execute("DELETE FROM transactions WHERE user_id=?", (u["id"],))
            db.execute("DELETE FROM imports WHERE user_id=?", (u["id"],))
            db.execute("DELETE FROM accounts WHERE user_id=?", (u["id"],))
            db.execute("DELETE FROM categories WHERE user_id=?", (u["id"],))
            db.execute("DELETE FROM users WHERE id=?", (u["id"],))
        for f_ in files:
            try:
                os.remove(f_)
            except OSError:
                pass
        session.clear()
        return jsonify({"ok": True})

    # ---------------- importar estados de cuenta
    MAX_UPLOAD = 6 * 1024 * 1024

    @app.post("/api/import/parse")
    @login_required
    def import_parse():
        u, db = current_user(), get_db()
        f = request.files.get("file")
        if not f or not f.filename:
            raise ValidationError("Selecciona un archivo.", "file")
        acc = ledger.owned(db, "accounts", request.form.get("account_id"), u["id"])
        if not acc:
            raise ValidationError("Elige la cuenta a la que pertenece el estado de cuenta.", "account_id")
        data = f.read(MAX_UPLOAD + 1)
        if len(data) > MAX_UPLOAD:
            raise ValidationError("El archivo es demasiado grande (máximo 6 MB).", "file")
        mapping = None
        if request.form.get("mapping"):
            try:
                raw = json.loads(request.form["mapping"])
                mapping = {k: int(v) for k, v in raw.items() if k in ("date", "description", "amount", "debit", "credit", "balance") and str(v) != ""}
            except (ValueError, TypeError, AttributeError):
                raise ValidationError("Selección de columnas no válida.")
        year = request.form.get("default_year")
        try:
            default_year = int(year) if year else None
        except ValueError:
            raise ValidationError("Año no válido.", "default_year")
        try:
            res = importer.parse_statement(f.filename, data, mapping, request.form.get("day_first", "1") != "0", default_year, request.form.get("invert") == "1")
        except importer.ImportError_ as e:
            raise ValidationError(str(e), "file")
        if res.get("error"):
            raise ValidationError(res["error"], "file")
        rows = res["rows"]
        if rows:
            existing = db.execute("""SELECT type, amount, date, description, category_id FROM transactions
                                     WHERE user_id=? AND account_id=? AND date BETWEEN ? AND ? AND type IN ('income','expense','refund')""",
                                  (u["id"], acc["id"], min(r["date"] for r in rows), max(r["date"] for r in rows))).fetchall()
            pool = [(e["date"], e["amount"] if e["type"] != "expense" else -e["amount"], importer.norm_desc(e["description"])) for e in existing]
            hist = {}
            for h in db.execute("""SELECT t.description, t.category_id, c.kind FROM transactions t JOIN categories c ON c.id = t.category_id
                                   WHERE t.user_id=? AND t.type IN ('income','expense') AND c.archived = 0 ORDER BY t.date, t.id""", (u["id"],)):
                if h["description"]:
                    hist[(importer.norm_desc(h["description"]), h["kind"])] = h["category_id"]
            for i, r in enumerate(rows):
                nd = importer.norm_desc(r["description"])
                r["idx"], r["duplicate"] = i, False
                for j, (d, a, ed) in enumerate(pool):
                    if d == r["date"] and a == r["amount"] and (ed == nd or not ed or not nd):
                        r["duplicate"] = True
                        pool.pop(j)
                        break
                r["category_id"] = hist.get((nd, "income" if r["amount"] > 0 else "expense")) if nd else None
        res["rows"] = rows
        res["filename"] = f.filename
        res["account"] = {"id": acc["id"], "name": acc["name"], "currency": acc["currency"]}
        return jsonify(res)

    @app.post("/api/import/commit")
    @login_required
    def import_commit():
        u, d, db = current_user(), json_body(), get_db()
        rows = d.get("rows")
        if not isinstance(rows, list) or not rows:
            raise ValidationError("No hay movimientos para guardar.")
        if len(rows) > 2000:
            raise ValidationError("Máximo 2,000 movimientos por importación.")
        with atomic(db):
            acc = ledger.owned(db, "accounts", d.get("account_id"), u["id"])
            if not acc:
                raise ValidationError("Cuenta no válida.", "account_id")
            imp = db.execute("INSERT INTO imports (user_id, account_id, filename, kind, row_count) VALUES (?,?,?,?,?)",
                             (u["id"], acc["id"], clean_text(d.get("filename"), "filename", 200), clean_text(d.get("kind"), "kind", 20), len(rows))).lastrowid
            for i, r in enumerate(rows):
                try:
                    cents = r.get("amount")
                    if isinstance(cents, bool) or not isinstance(cents, int) or cents == 0 or abs(cents) > 10**12:
                        raise ValidationError("Importe no válido.", "amount")
                    ledger.insert_tx(db, u["id"], {
                        "type": "income" if cents > 0 else "expense", "amount": f"{abs(cents) // 100}.{abs(cents) % 100:02d}", "date": r.get("date"),
                        "account_id": acc["id"], "category_id": r.get("category_id") or None, "description": r.get("description") or ""}, import_id=imp)
                except ValidationError as e:
                    raise ValidationError(f"Fila {i + 1}: {e.message}", e.field)
        return jsonify({"ok": True, "import_id": imp, "created": len(rows)}), 201

    @app.get("/api/imports")
    @login_required
    def imports_list():
        rows = get_db().execute("""SELECT i.id, i.filename, i.kind, i.created_at, a.name AS account_name,
                                   (SELECT COUNT(*) FROM transactions t WHERE t.import_id = i.id) AS remaining
                                   FROM imports i JOIN accounts a ON a.id = i.account_id WHERE i.user_id=? ORDER BY i.id DESC LIMIT 30""",
                                (current_user()["id"],)).fetchall()
        return jsonify({"imports": [dict(r) for r in rows]})

    @app.delete("/api/imports/<int:iid>")
    @login_required
    def imports_undo(iid):
        u, db = current_user(), get_db()
        with atomic(db):
            if not ledger.owned(db, "imports", iid, u["id"]):
                raise ValidationError("Importación no encontrada.", status=404)
            n = db.execute("DELETE FROM transactions WHERE import_id=? AND user_id=?", (iid, u["id"])).rowcount
            db.execute("DELETE FROM imports WHERE id=? AND user_id=?", (iid, u["id"]))
        return jsonify({"ok": True, "deleted": n})

    # ---------------- portafolio
    @app.get("/api/portfolio")
    @login_required
    def pf_summary():
        u, db = current_user(), get_db()
        stale = [s for s in portfolio.held_symbols(db, u["id"])]
        return jsonify(portfolio.summary(db, u) | {"symbols": stale} | portfolio.overview_all(db, u))

    @app.get("/api/fx")
    @login_required
    def fx_get():
        """Tipo de cambio hacia tu moneda principal para las monedas de tus cuentas (para ver montos en USD o MXN
        en los formularios). Si no hay tipo de cambio disponible, esa moneda va en null: no se inventa."""
        u, db = current_user(), get_db()
        main = u["currency"]
        curs = {x["currency"] for x in ledger.list_accounts(db, u["id"], include_archived=False)} - {main}
        try:
            rates = portfolio.fx_rates(db, main, curs)
        except Exception:
            rates = {c: None for c in curs}
        info = {f["currency"]: f for f in portfolio.fx_info(db, main, rates)}
        return jsonify({"main": main, "rates": {c: info.get(c) for c in sorted(curs)}})

    @app.get("/api/portfolio/ops")
    @login_required
    def pf_ops():
        u, db = current_user(), get_db()
        sym = request.args.get("symbol")
        q, p = "SELECT * FROM holding_ops WHERE user_id=?", [u["id"]]
        if sym:
            q += " AND symbol=?"; p.append(portfolio.clean_symbol(sym))
        rows = db.execute(q + " ORDER BY date DESC, id DESC", p).fetchall()
        return jsonify({"ops": [portfolio.op_row(r) for r in rows]})

    @app.post("/api/portfolio/ops")
    @login_required
    def pf_op_create():
        u, db = current_user(), get_db()
        oid = portfolio.save_op(db, u["id"], json_body())
        return jsonify({"op": portfolio.op_row(db.execute("SELECT * FROM holding_ops WHERE id=?", (oid,)).fetchone())}), 201

    @app.put("/api/portfolio/ops/<int:oid>")
    @login_required
    def pf_op_update(oid):
        u, db = current_user(), get_db()
        portfolio.save_op(db, u["id"], json_body(), op_id=oid)
        return jsonify({"op": portfolio.op_row(db.execute("SELECT * FROM holding_ops WHERE id=?", (oid,)).fetchone())})

    @app.delete("/api/portfolio/ops/<int:oid>")
    @login_required
    def pf_op_delete(oid):
        portfolio.delete_op(get_db(), current_user()["id"], oid)
        return jsonify({"ok": True})

    @app.post("/api/portfolio/refresh")
    @login_required
    def pf_refresh():
        u, db = current_user(), get_db()
        last = portfolio._last_manual_refresh.get(u["id"], 0)
        import time as _t
        if _t.time() - last < 60:
            return api_error("Ya se actualizó hace un momento. Espera un minuto para volver a intentarlo.", 429)
        portfolio._last_manual_refresh[u["id"]] = _t.time()
        syms = list(set(portfolio.held_symbols(db, u["id"])) | set(portfolio.watchlist_symbols(db, u["id"])))
        ok, failed = portfolio.refresh_symbols(db, syms, force=True)
        notify.check_prices(db, ok)
        return jsonify({"updated": ok, "failed": failed})

    @app.post("/api/portfolio/price")
    @login_required
    def pf_price():
        d = json_body()
        portfolio.set_manual_price(get_db(), current_user()["id"], d.get("symbol"), d.get("price"))
        notify.check_prices(get_db(), [portfolio.clean_symbol(d.get("symbol"))])
        return jsonify({"ok": True})

    @app.get("/api/portfolio/history")
    @login_required
    def pf_history():
        u, db = current_user(), get_db()
        sym = portfolio.clean_symbol(request.args.get("symbol"))
        if sym not in portfolio.held_symbols(db, u["id"]):
            return api_error("Símbolo no encontrado en tu portafolio.", 404)
        return jsonify(portfolio.get_history(db, sym, request.args.get("range", "6mo")))


app = create_app() if env("NO_AUTOAPP") != "1" else None

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"FIPO en http://127.0.0.1:{port}")
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=port, debug=False)
