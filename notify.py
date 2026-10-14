"""Avisos dentro de FIPO: pagos de tarjeta y precios objetivo del portafolio."""
import os
from datetime import date

from flask import jsonify, request

import ledger
import mailer
import more
import portfolio
import webpush
from db import atomic, get_db
from ledger import ValidationError, today_for, clean_text, parse_date

CARD_STAGES = (5, 1, 0)          # días antes del vencimiento en que se avisa
WATCH_STAGES = (3, 1, 0)         # días antes de un reporte trimestral en que se avisa


def _money(cents, cur):
    return f"${cents / 100:,.2f} {cur}"


def add(db, user_id, kind, title, body, link, key):
    """Inserta un aviso; devuelve True si es nuevo (la clave evita duplicados)."""
    cur = db.execute("INSERT OR IGNORE INTO notifications (user_id, kind, title, body, link, dedupe_key) VALUES (?,?,?,?,?,?)",
                     (user_id, kind, title, body, link, key))
    if cur.rowcount > 0:
        _email(db, user_id, title, body, link)
        _push(db, user_id, kind, title, body, link, key)
        return True
    return False


def _push(db, user_id, kind, title, body, link, key):
    """Aviso en el teléfono aunque FIPO esté cerrada (solo si el usuario activó los avisos en ese dispositivo)."""
    if not db.execute("SELECT 1 FROM push_subscriptions WHERE user_id=? LIMIT 1", (user_id,)).fetchone():
        return
    db_path = db.execute("PRAGMA database_list").fetchone()[2]
    if not db_path:
        return
    webpush.queue(db_path, os.path.dirname(db_path), user_id,
                  {"title": title, "body": body, "url": "/" + (link or ""), "tag": kind}, confirm_key=key)


def _email(db, user_id, title, body, link):
    """Si el usuario activó los avisos por correo y el servidor tiene SMTP, manda el aviso (así llega con la app cerrada)."""
    if not mailer.configured():
        return
    u = db.execute("SELECT email, notify_email FROM users WHERE id=?", (user_id,)).fetchone()
    if not u or not u["notify_email"]:
        return
    base = (mailer.env("PUBLIC_URL") or "").rstrip("/")
    text = f"{body}\n\n" + (f"Ábrelo en FIPO: {base}/{link}\n" if base else "Ábrelo en FIPO para ver el detalle.\n")
    mailer.send_bg(u["email"], "FIPO · " + title, text)


# ------------------------------------------------------------ tarjetas
def check_cards(db, user_id=None):
    users = db.execute("SELECT * FROM users" + (" WHERE id=?" if user_id else ""), (user_id,) if user_id else ()).fetchall()
    new = 0
    for u in users:
        today = today_for(u["timezone"])
        bal = None
        for a in db.execute("SELECT * FROM accounts WHERE user_id=? AND type='credit' AND archived=0 AND due_day>0", (u["id"],)).fetchall():
            if bal is None:
                bal = ledger.balances(db, u["id"])
            c = more.card_row(db, u, a, bal[a["id"]])
            if not c["next_due"] or c["used"] <= 0:
                continue
            days = (date.fromisoformat(c["next_due"]) - today).days
            stage = next((s for s in sorted(CARD_STAGES) if days <= s), None)
            if stage is None:
                continue
            owe = c["statement"]["pending"] if c["statement"] and c["statement"]["pending"] > 0 else c["used"]
            when = "hoy" if days == 0 else ("mañana" if days == 1 else f"en {days} días")
            title = f"Pago de {c['name']} vence {when}"
            body = f"Fecha límite: {c['next_due']}. Por pagar: {_money(owe, c['currency'])} (deuda total {_money(c['used'], c['currency'])})."
            new += add(db, u["id"], "card_due", title, body, "#/cards", f"card:{a['id']}:{c['next_due']}:{stage}")
    return new


# ------------------------------------------------------------ precios objetivo
def check_prices(db, symbols=None, user_id=None):
    q = "SELECT a.*, u.currency AS ucur FROM price_alerts a JOIN users u ON u.id=a.user_id WHERE a.active=1"
    args = []
    if user_id:
        q += " AND a.user_id=?"; args.append(user_id)
    new = 0
    for a in db.execute(q, args).fetchall():
        if symbols is not None and a["symbol"] not in symbols:
            continue
        quote = db.execute("SELECT price, currency FROM quotes WHERE symbol=?", (a["symbol"],)).fetchone()
        if not quote or quote["price"] is None:
            continue
        price, lo, up = quote["price"], a["lower"], a["upper"]
        cur = quote["currency"] or a["ucur"]
        lo_hit, up_hit = a["lower_hit"], a["upper_hit"]
        link = f"#/portfolio/{a['symbol']}"
        if lo is not None and price <= lo:
            if not lo_hit:
                new += add(db, a["user_id"], "price_low", f"{a['symbol']} tocó tu límite inferior",
                           f"Precio actual {price:,.2f} {cur} (límite inferior {lo:,.2f}).", link, f"price:{a['id']}:low:{_stamp(db)}")
                lo_hit = 1
        else:
            lo_hit = 0
        if up is not None and price >= up:
            if not up_hit:
                new += add(db, a["user_id"], "price_high", f"{a['symbol']} alcanzó tu precio objetivo superior",
                           f"Precio actual {price:,.2f} {cur} (objetivo superior {up:,.2f}).", link, f"price:{a['id']}:high:{_stamp(db)}")
                up_hit = 1
        else:
            up_hit = 0
        if (lo_hit, up_hit) != (a["lower_hit"], a["upper_hit"]):
            db.execute("UPDATE price_alerts SET lower_hit=?, upper_hit=? WHERE id=?", (lo_hit, up_hit, a["id"]))
    return new


def _stamp(db):
    return db.execute("SELECT strftime('%Y%m%d%H%M%f','now')").fetchone()[0]


# ------------------------------------------------------------ vigilancia (símbolos no necesariamente en cartera)
def check_watchlist(db, user_id=None):
    """Avisa 3 días antes, 1 día antes y el mismo día del reporte trimestral que guardaste para cada símbolo."""
    users = db.execute("SELECT * FROM users" + (" WHERE id=?" if user_id else ""), (user_id,) if user_id else ()).fetchall()
    new = 0
    for u in users:
        today = today_for(u["timezone"])
        for w in db.execute("SELECT * FROM watchlist WHERE user_id=? AND report_date IS NOT NULL", (u["id"],)).fetchall():
            days = (date.fromisoformat(w["report_date"]) - today).days
            if days < 0:
                continue
            stage = next((s for s in sorted(WATCH_STAGES) if days <= s), None)
            if stage is None:
                continue
            when = "hoy" if days == 0 else ("mañana" if days == 1 else f"en {days} días")
            new += add(db, u["id"], "watch_report", f"{w['symbol']} reporta {when}",
                       f"Fecha del reporte: {w['report_date']}.", "#/portfolio", f"watch:{w['id']}:{w['report_date']}:{stage}")
    return new


def run_all(db, symbols=None):
    """Lo llama el planificador tras cada actualización de precios."""
    return check_prices(db, symbols) + check_cards(db) + check_watchlist(db)


# ------------------------------------------------------------ rutas
def _num(v, field):
    if v in (None, ""):
        return None
    try:
        x = float(str(v).replace(",", ""))
    except ValueError:
        raise ValidationError("Escribe un precio válido.", field)
    if not x > 0 or x > 1e12 or x != x:
        raise ValidationError("El precio debe ser mayor que cero.", field)
    return x


def alert_row(db, a):
    q = db.execute("SELECT price, currency FROM quotes WHERE symbol=?", (a["symbol"],)).fetchone()
    return {"id": a["id"], "symbol": a["symbol"], "lower": a["lower"], "upper": a["upper"], "active": bool(a["active"]),
            "lower_hit": bool(a["lower_hit"]), "upper_hit": bool(a["upper_hit"]),
            "price": q["price"] if q else None, "currency": (q["currency"] if q else "")}


def watch_row(db, w, today=None):
    """Fila de la tablita de vigilancia: tus datos + precio actual (si ya se consultó) + el estado según tu
    propia entrada/salida (mismo criterio que tu hoja: verde = en/sobre salida, amarillo = en rango, rojo = bajo entrada)."""
    q = db.execute("SELECT price, currency FROM quotes WHERE symbol=?", (w["symbol"],)).fetchone()
    price = q["price"] if q else None
    state = None
    if price is not None:
        if w["exit_price"] is not None and price >= w["exit_price"]:
            state = "above"
        elif w["entry_price"] is not None and price < w["entry_price"]:
            state = "below"
        elif w["entry_price"] is not None or w["exit_price"] is not None:
            state = "in_range"
    days = (date.fromisoformat(w["report_date"]) - today).days if w["report_date"] and today else None
    return {"id": w["id"], "symbol": w["symbol"], "company": w["company"], "report_date": w["report_date"],
            "entry_price": w["entry_price"], "exit_price": w["exit_price"], "notes": w["notes"],
            "price": price, "currency": (q["currency"] if q else "") or "", "state": state, "days_to_report": days}


def _attach_fx(db, items, main):
    """Agrega a cada fila cuánto vale su moneda en la moneda principal del usuario (fx_rate), para el botón
    «ver en <moneda principal>» sin recalcular nada del lado del cliente. None = no se pudo consultar el tipo
    de cambio (por ejemplo sin conexión); el cliente entonces muestra la moneda original."""
    need = sorted({i["currency"] for i in items if i["currency"] and i["currency"] != main})
    fx = {c: portfolio.get_fx_rate(db, c, main) for c in need}
    for i in items:
        i["main_currency"] = main
        i["fx_rate"] = 1.0 if not i["currency"] or i["currency"] == main else fx.get(i["currency"])
    return items


def register(app, login_required, current_user, json_body, api_error):
    @app.get("/api/notifications")
    @login_required
    def notif_list():
        u, db = current_user(), get_db()
        check_cards(db, u["id"])                      # los recordatorios de tarjeta se generan al consultar
        check_prices(db, user_id=u["id"])
        check_watchlist(db, u["id"])
        rows = db.execute("SELECT * FROM notifications WHERE user_id=? AND dismissed=0 ORDER BY id DESC LIMIT 100", (u["id"],)).fetchall()
        unread = db.execute("SELECT COUNT(*) FROM notifications WHERE user_id=? AND dismissed=0 AND read_at IS NULL", (u["id"],)).fetchone()[0]
        return jsonify({"unread": unread, "items": [{k: r[k] for k in ("id", "kind", "title", "body", "link", "created_at", "read_at")} for r in rows]})

    @app.post("/api/notifications/read")
    @login_required
    def notif_read():
        u, d, db = current_user(), json_body(), get_db()
        if d.get("all"):
            db.execute("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL", (u["id"],))
        else:
            ids = [int(i) for i in (d.get("ids") or []) if str(i).isdigit()]
            for i in ids:
                db.execute("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND id=? AND read_at IS NULL", (u["id"], i))
        return jsonify({"ok": True})

    @app.delete("/api/notifications/<int:nid>")
    @login_required
    def notif_delete(nid):
        get_db().execute("UPDATE notifications SET dismissed=1, read_at=COALESCE(read_at, datetime('now')) WHERE user_id=? AND id=?", (current_user()["id"], nid))
        return jsonify({"ok": True})

    @app.delete("/api/notifications")
    @login_required
    def notif_clear():
        get_db().execute("UPDATE notifications SET dismissed=1 WHERE user_id=? AND read_at IS NOT NULL", (current_user()["id"],))
        return jsonify({"ok": True})

    @app.get("/api/price-alerts")
    @login_required
    def alerts_list():
        u, db = current_user(), get_db()
        return jsonify([alert_row(db, a) for a in db.execute("SELECT * FROM price_alerts WHERE user_id=? ORDER BY symbol", (u["id"],))])

    @app.put("/api/price-alerts")
    @login_required
    def alerts_put():
        u, d, db = current_user(), json_body(), get_db()
        sym = portfolio.clean_symbol(d.get("symbol"))
        if sym not in portfolio.held_symbols(db, u["id"]):
            return api_error("Solo puedes poner objetivos a activos de tu portafolio.", 404)
        lo, up = _num(d.get("lower"), "lower"), _num(d.get("upper"), "upper")
        if lo is None and up is None:
            raise ValidationError("Escribe al menos un límite (inferior o superior).", "lower")
        if lo is not None and up is not None and lo >= up:
            raise ValidationError("El límite inferior debe ser menor que el superior.", "lower")
        active = 0 if d.get("active") is False else 1
        with atomic(db):
            db.execute("""INSERT INTO price_alerts (user_id, symbol, lower, upper, active) VALUES (?,?,?,?,?)
                          ON CONFLICT(user_id, symbol) DO UPDATE SET lower=excluded.lower, upper=excluded.upper, active=excluded.active,
                          lower_hit=0, upper_hit=0""", (u["id"], sym, lo, up, active))
        check_prices(db, [sym], u["id"])              # si ya está fuera del rango, avisa de inmediato
        return jsonify(alert_row(db, db.execute("SELECT * FROM price_alerts WHERE user_id=? AND symbol=?", (u["id"], sym)).fetchone()))

    @app.delete("/api/price-alerts/<symbol>")
    @login_required
    def alerts_del(symbol):
        get_db().execute("DELETE FROM price_alerts WHERE user_id=? AND symbol=?", (current_user()["id"], portfolio.clean_symbol(symbol)))
        return jsonify({"ok": True})

    # -------------------------------------------------------- vigilancia (tablita de símbolos que sigues,
    # los tengas o no en tu portafolio: símbolo, fecha del reporte, precio de entrada y de salida)
    @app.get("/api/watchlist")
    @login_required
    def watch_list():
        u, db = current_user(), get_db()
        today = today_for(u["timezone"])
        rows = db.execute("SELECT * FROM watchlist WHERE user_id=? ORDER BY report_date IS NULL, report_date, symbol", (u["id"],)).fetchall()
        return jsonify(_attach_fx(db, [watch_row(db, w, today) for w in rows], u["currency"]))

    @app.put("/api/watchlist")
    @login_required
    def watch_put():
        u, d, db = current_user(), json_body(), get_db()
        sym = portfolio.clean_symbol(d.get("symbol"))
        if not sym:
            raise ValidationError("Escribe un símbolo.", "symbol")
        entry, exitp = _num(d.get("entry_price"), "entry_price"), _num(d.get("exit_price"), "exit_price")
        if entry is not None and exitp is not None and entry >= exitp:
            raise ValidationError("El precio de entrada debe ser menor que el de salida.", "entry_price")
        report_date = parse_date(d.get("report_date"), "report_date") if d.get("report_date") else None
        company = clean_text(d.get("company"), "company", 120)
        notes = clean_text(d.get("notes"), "notes", 300)
        with atomic(db):
            db.execute("""INSERT INTO watchlist (user_id, symbol, company, report_date, entry_price, exit_price, notes) VALUES (?,?,?,?,?,?,?)
                          ON CONFLICT(user_id, symbol) DO UPDATE SET company=excluded.company, report_date=excluded.report_date,
                          entry_price=excluded.entry_price, exit_price=excluded.exit_price, notes=excluded.notes""",
                       (u["id"], sym, company, report_date, entry, exitp, notes))
        portfolio.refresh_symbols(db, [sym])           # para ver el precio de una vez, aunque nunca lo hayas tenido en cartera
        w = db.execute("SELECT * FROM watchlist WHERE user_id=? AND symbol=?", (u["id"], sym)).fetchone()
        item = _attach_fx(db, [watch_row(db, w, today_for(u["timezone"]))], u["currency"])[0]
        return jsonify(item)

    @app.delete("/api/watchlist/<symbol>")
    @login_required
    def watch_del(symbol):
        get_db().execute("DELETE FROM watchlist WHERE user_id=? AND symbol=?", (current_user()["id"], portfolio.clean_symbol(symbol)))
        return jsonify({"ok": True})


# ------------------------------------------------------------ avisos push y revisión automática
CRON_MIN_GAP = 60                    # segundos: si alguien llama la dirección muchas veces seguidas, no se repite el trabajo


def cron_token(data_dir):
    """Clave secreta de la dirección de revisión automática; se crea una vez y vive en la carpeta de datos."""
    path = os.path.join(data_dir, "cron.key")
    if not os.path.exists(path):
        import secrets
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(24))
    with open(path) as f:
        return f.read().strip()


def _state(db, key, value=None):
    if value is None:
        r = db.execute("SELECT value FROM app_state WHERE key=?", (key,)).fetchone()
        return r[0] if r else None
    db.execute("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def run_cron(db, refresh_prices=True):
    """Lo que haría una tarea programada: cargos recurrentes e intereses al corte, precios, y avisos. Idempotente."""
    import cards
    started = db.execute("SELECT strftime('%s','now')").fetchone()[0]
    last = _state(db, "cron_last_run_epoch")
    if last and int(started) - int(last) < CRON_MIN_GAP:
        return {"skipped": True, "reason": "Se ejecutó hace menos de un minuto."}
    _state(db, "cron_last_run_epoch", str(started))
    out = {"skipped": False, "posted": 0, "notifications": 0, "prices_ok": 0, "prices_failed": 0}
    for u in db.execute("SELECT * FROM users").fetchall():
        try:
            out["posted"] += cards.materialize(db, u)
        except Exception as e:                                   # un usuario con datos raros no detiene a los demás
            print(f"[FIPO] revisión automática, usuario {u['id']}: {e}", flush=True)
    syms = []
    if refresh_prices:
        syms = sorted(set(portfolio.held_symbols(db)) | set(portfolio.watchlist_symbols(db)))
        if syms:
            ok, failed = portfolio.refresh_symbols(db, syms, max_age=portfolio.REFRESH_SECONDS - 600)
            out["prices_ok"], out["prices_failed"] = len(ok), len(failed)
    out["notifications"] = run_all(db, syms or None)
    _state(db, "cron_last_run", db.execute("SELECT datetime('now')").fetchone()[0])
    webpush.wait(25)                                             # que los push salgan antes de responder
    return out


def register_push(app, login_required, current_user, json_body, api_error):
    def data_dir():
        return os.path.dirname(os.path.abspath(app.config["DATABASE"]))

    def site():
        root = request.url_root.rstrip("/")
        if os.environ.get("FIPO_HTTPS") == "1" and root.startswith("http://"):       # detrás del proxy HTTPS de PythonAnywhere
            root = "https://" + root[len("http://"):]
        return root

    def subject():
        root = site()
        host = request.host.split(":")[0]
        if root.startswith("https://") and host not in ("localhost", "127.0.0.1"):
            return root
        return "mailto:" + current_user()["email"]

    @app.get("/api/push")
    @login_required
    def push_info():
        u, db = current_user(), get_db()
        last = _state(db, "cron_last_run")
        return jsonify({"supported": True, "public_key": webpush.public_key_b64(webpush.load_key(data_dir())),
                        "devices": db.execute("SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?", (u["id"],)).fetchone()[0],
                        "cron": {"url": site() + "/api/cron/" + cron_token(data_dir()), "last_run": last}})

    @app.post("/api/push/subscribe")
    @login_required
    def push_subscribe():
        u, d, db = current_user(), json_body(), get_db()
        endpoint = str(d.get("endpoint") or "")
        keys = d.get("keys") or {}
        if len(endpoint) > 1000 or not webpush.allowed_endpoint(endpoint):
            raise ValidationError("Este navegador usa un servicio de avisos que FIPO no reconoce.")
        try:
            p256dh, auth = str(keys.get("p256dh") or ""), str(keys.get("auth") or "")
            if len(webpush.unb64u(p256dh)) != 65 or len(webpush.unb64u(auth)) != 16:
                raise ValueError
        except (ValueError, TypeError):
            raise ValidationError("La suscripción de avisos no es válida.")
        device = clean_text(d.get("device"), "device", 80)
        with atomic(db):
            db.execute("""INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, subject, device) VALUES (?,?,?,?,?,?)
                          ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth,
                            subject=excluded.subject, device=excluded.device, failures=0, last_error=''""",
                       (u["id"], endpoint, p256dh, auth, subject(), device))
        return jsonify({"ok": True})

    @app.post("/api/push/unsubscribe")
    @login_required
    def push_unsubscribe():
        u, d, db = current_user(), json_body(), get_db()
        db.execute("DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?", (u["id"], str(d.get("endpoint") or "")))
        return jsonify({"ok": True})

    @app.post("/api/push/test")
    @login_required
    def push_test():
        u, db = current_user(), get_db()
        n = db.execute("SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?", (u["id"],)).fetchone()[0]
        if not n:
            raise ValidationError("Activa primero los avisos en este dispositivo.")
        sent = webpush.deliver(app.config["DATABASE"], data_dir(), u["id"],
                               {"title": "FIPO", "body": "¡Listo! Así te llegarán los avisos aunque FIPO esté cerrada.", "url": "/#/dashboard", "tag": "test"})
        errs = [r[0] for r in db.execute("SELECT last_error FROM push_subscriptions WHERE user_id=? AND last_error!=''", (u["id"],))]
        if not sent:
            raise ValidationError("No se pudo enviar el aviso de prueba" + (f" ({errs[0]})." if errs else "."))
        return jsonify({"ok": True, "sent": sent, "devices": n})

    @app.get("/api/cron/<token>")
    def cron(token):
        import secrets
        if not secrets.compare_digest(token.encode(), cron_token(data_dir()).encode()):
            return api_error("No encontrado.", 404)
        return jsonify(run_cron(get_db(), refresh_prices=not app.config.get("TESTING")))
