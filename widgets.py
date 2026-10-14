"""Widgets de FIPO.

- widget_data(): un resumen compacto con TODO lo que muestran los widgets, calculado con las mismas funciones que usa
  el resto de la app (Análisis, presupuestos, metas, portafolio), para que nunca se vean cifras distintas.
- Diseño de los widgets por usuario (orden, tamaño, color, visibilidad), validado y guardado en la base.
- Enlace de solo lectura con token (para widgets nativos de iPhone, p. ej. con Scriptable): el token se guarda con hash,
  se muestra una sola vez y se puede regenerar o revocar.
"""
import hashlib
import json
import re
import secrets
import time
from datetime import datetime, timezone

from flask import jsonify, request

import ledger
import more
import portfolio
from db import get_db
from ledger import ValidationError

# Debe coincidir con el registro de static/widgets.js
WIDGET_SIZES = {
    "quick": ("s",), "summary": ("m", "l"), "portfolio": ("m", "l"), "categories": ("s", "m"), "goal": ("s",),
    "goals": ("m", "l"), "recent": ("m", "l"), "health": ("m", "l"), "budget": ("s", "m"),
}
PALETTES = ("olive", "forest", "cream", "black", "blue", "purple", "pink", "gray", "custom")
MODES = ("auto", "light", "dark")
OPT_KEYS = ("chart", "details")                      # información mostrada (se puede apagar el gráfico o los detalles)
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
PUBLIC_TTL = 120                                     # segundos: el enlace de iPhone no recalcula todo en cada consulta
_public_cache, _fails = {}, {}


# ---------------------------------------------------------------- datos
def _total_money(db, user):
    """Dinero en cuentas (sin tarjetas), en la moneda principal; las otras monedas se convierten si hay tipo de cambio."""
    cur = user["currency"]
    accounts = ledger.list_accounts(db, user["id"], include_archived=False)
    rates = portfolio.fx_rates(db, cur, [a["currency"] for a in accounts], fetch=False)
    return sum(round(a["balance"] * rates[a["currency"]]) for a in accounts if a["type"] != "credit" and rates.get(a["currency"]))


def _goal_pick(goals):
    """Meta con mayor prioridad: la que vence antes (si tiene fecha); si no, la más avanzada que aún no se completa."""
    open_ = [g for g in goals if not g["done"]]
    dated = sorted([g for g in open_ if g["target_date"] and (g["days_left"] or 0) >= 0], key=lambda g: g["days_left"])
    if dated:
        return dated[0]
    return sorted(open_, key=lambda g: -g["pct"])[0] if open_ else None


def portfolio_series(db, user, rate, current_value, points=24, days=180, budget=6.0):
    """Valor del portafolio (moneda principal) a lo largo del tiempo, para la línea de fondo del widget.
    Usa las cantidades que tenías en cada fecha (operaciones) y el historial de precios de Yahoo (con caché de 1 h).
    Si un activo no tiene historial, se valúa a su costo (línea plana) y `kind` pasa a «mixed»."""
    from datetime import date, timedelta
    ops = [o for o in portfolio._all_ops(db, user["id"]) if o["kind"] in ("buy", "sell")]
    if not ops:
        return None, None
    today = datetime.now(timezone.utc).date()
    first = min(o["date"] for o in ops)
    start = max(date.fromisoformat(first), today - timedelta(days=days))
    if start >= today:
        return None, None
    step = max(1, (today - start).days // (points - 1))
    dates = [start + timedelta(days=step * i) for i in range(points) if start + timedelta(days=step * i) < today] + [today]
    hist, t0, ok = {}, time.time(), True
    for sym in sorted({o["symbol"] for o in ops}):
        pts = None
        if time.time() - t0 < budget:
            try:
                h = portfolio.get_history(db, sym, "6mo")
                if h.get("available"):
                    pts = sorted((datetime.fromtimestamp(t if t < 1e12 else t / 1000, timezone.utc).date(), p) for t, p in h["points"])
            except Exception:
                pts = None
        hist[sym] = pts
        ok = ok and pts is not None
    series = []
    for d in dates:
        ds, total = d.isoformat(), 0.0
        by = {}
        for o in sorted((o for o in ops if o["date"] <= ds), key=lambda r: (r["date"], r["id"])):
            b = by.setdefault(o["symbol"], {"q": 0.0, "last": 0.0, "cur": o["currency"]})
            q = float(o["quantity"])
            b["q"] += q if o["kind"] == "buy" else -q
            b["last"] = float(o["price"] or 0) or b["last"]
        for sym, b in by.items():
            if b["q"] <= 1e-12:
                continue
            price = b["last"]
            if hist.get(sym):
                prior = [p for dd, p in hist[sym] if dd <= d]
                price = prior[-1] if prior else hist[sym][0][1]
            r = 1.0 if b["cur"] == user["currency"] else rate.get(b["cur"])
            if r:
                total += b["q"] * price * 100 * r
        series.append(round(total))
    if current_value is not None:
        series[-1] = current_value                         # el último punto siempre es el valor de hoy
    if max(series) <= 0:
        return None, None
    return series, ("market" if ok else "mixed")


def widget_data(db, user):
    uid, cur = user["id"], user["currency"]
    a = more.analysis(db, user, 12)
    monthly, nw = a["monthly"], a["networth_evolution"]
    now_total = _total_money(db, user)

    # saldo total: serie mensual (efectivo + cuentas de inversión) y el valor de hoy como último punto
    series = [x["liquid"] + x["invested"] for x in nw]
    if series:
        series[-1] = now_total
    prev = series[-2] if len(series) >= 2 else None
    balance = {"value": now_total, "series": series,
               "change_pct": round((now_total - prev) * 100 / abs(prev), 2) if prev else None}

    m = monthly[-1]
    month = {"key": m["key"], "income": m["income"], "expense": m["expense"], "savings": m["net"], "savings_rate": m["savings_rate"]}

    # portafolio (todo en la moneda principal; las otras monedas se convierten si hay tipo de cambio)
    pos = portfolio.summary(db, user)["positions"]
    pf = None
    if pos:
        ov = portfolio.overview_all(db, user, fetch=False)
        t, rate = ov["totals_all"], {f["currency"]: f["rate"] for f in ov["fx"]}
        rows = []
        for p in pos:
            r = 1.0 if p["currency"] == cur else rate.get(p["currency"])
            if p["market_value"] is not None and r:
                rows.append({"symbol": p["symbol"], "pct": p["unrealized_pct"], "value": round(p["market_value"] * r)})
        rows.sort(key=lambda x: -x["value"])
        pf = {"value": t["market_value"], "cost": t["cost"], "gain": t["unrealized"], "gain_pct": t["unrealized_pct"],
              "day_change": t["day_change"], "positions": rows[:8], "missing": t["missing"]}
        try:
            pf["series"], pf["series_kind"] = portfolio_series(db, user, rate, t["market_value"])
        except Exception:                                  # la línea es un adorno: nunca debe tumbar el widget
            pf["series"], pf["series_kind"] = None, None

    cats = sorted([c for c in a["categories"] if c["current"] > 0], key=lambda c: -c["current"])
    spent = a["this_month"]["spent"]
    shown = cats[:3]
    others = max(0, spent - sum(c["current"] for c in shown))
    categories = {"spent": spent, "items": [{"name": c["name"], "amount": c["current"]} for c in shown], "others": others}

    goals = a["goals"]
    pick = _goal_pick(goals)
    goals_out = {"next_id": pick["id"] if pick else None,
                 "items": [{k: g[k] for k in ("id", "name", "target", "saved", "pct", "done", "target_date", "days_left")} for g in
                           sorted(goals, key=lambda g: (g["done"], g["days_left"] is None, g["days_left"] or 0, -g["pct"]))[:6]]}

    budget = None
    b = a.get("budget")
    if b and (b["total"] or b["items"]):
        tot = b["total"]
        if not tot and b["items"]:                      # sin presupuesto total: se suma el de las categorías
            amount, spent_b = sum(i["amount"] for i in b["items"]), sum(i["spent"] for i in b["items"])
            pct = round(spent_b * 100 / amount, 1) if amount else 0
            tot = {"amount": amount, "spent": spent_b, "remaining": amount - spent_b, "pct": pct,
                   "status": "over" if spent_b > amount else "warn" if pct >= 80 else "ok"}
        budget = {k: tot[k] for k in ("amount", "spent", "remaining", "pct", "status")}

    h = a["health"]
    health = None if h["score"] is None else {"score_100": h["score"], "score_10": round(h["score"] / 10, 1), "breakdown": h["breakdown"], "month": h["month"]}

    latest, _, _, _ = ledger.query_transactions(db, uid, {"per_page": 6, "sort": "date", "dir": "desc"})
    recent = [{"id": t["id"], "date": t["date"], "type": t["type"], "amount": t["amount"], "description": t["description"],
               "category_name": t.get("category_name"), "account_name": t.get("account_name"), "currency": t.get("currency") or cur} for t in latest]

    return {"currency": cur, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "balance": balance, "month": month,
            "portfolio": pf, "categories": categories, "goals": goals_out, "budget": budget, "health": health, "recent": recent}


# ---------------------------------------------------------------- diseño guardado
def default_layout():
    return None                                       # el cliente trae el diseño predeterminado (static/widgets.js)


def clean_layout(d):
    if not isinstance(d, dict):
        raise ValidationError("Diseño de widgets no válido.")
    mode, palette, custom = d.get("mode", "auto"), d.get("palette", "olive"), d.get("custom") or ""
    if mode not in MODES:
        raise ValidationError("Modo no válido.", "mode")
    if palette not in PALETTES:
        raise ValidationError("Color no válido.", "palette")
    if custom and not HEX.match(str(custom)):
        raise ValidationError("Color personalizado no válido (usa #RRGGBB).", "custom")
    items = d.get("items")
    if not isinstance(items, list) or len(items) > len(WIDGET_SIZES):
        raise ValidationError("Lista de widgets no válida.", "items")
    out, seen = [], set()
    for it in items:
        if not isinstance(it, dict) or it.get("id") not in WIDGET_SIZES or it["id"] in seen:
            raise ValidationError("Widget no válido o repetido.", "items")
        wid = it["id"]
        seen.add(wid)
        size = it.get("size") or WIDGET_SIZES[wid][0]
        if size not in WIDGET_SIZES[wid]:
            raise ValidationError(f"Tamaño no disponible para «{wid}».", "items")
        pal = it.get("palette")
        if pal is not None and pal not in PALETTES:
            raise ValidationError("Color no válido.", "items")
        ccol = it.get("custom") or ""
        if ccol and not HEX.match(str(ccol)):
            raise ValidationError("Color personalizado no válido (usa #RRGGBB).", "items")
        opts = it.get("opts") or {}
        if not isinstance(opts, dict):
            raise ValidationError("Opciones no válidas.", "items")
        out.append({"id": wid, "size": size, "visible": bool(it.get("visible", True)), "palette": pal, "custom": ccol,
                    "opts": {k: bool(opts[k]) for k in OPT_KEYS if k in opts}})
    return {"v": 1, "mode": mode, "palette": palette, "custom": custom, "items": out}


# ---------------------------------------------------------------- token de solo lectura
def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def register(app, login_required, current_user, json_body, api_error):
    @app.get("/api/widgets/data")
    @login_required
    def widgets_data():
        return jsonify(widget_data(get_db(), current_user()))

    @app.get("/api/portfolio/series")
    @login_required
    def portfolio_value_series():
        """Valor del portafolio en el tiempo (moneda principal) para la gráfica detrás del monto en Portafolio."""
        db, user = get_db(), current_user()
        if not portfolio.summary(db, user)["positions"]:
            return jsonify({"series": None})
        ov = portfolio.overview_all(db, user, fetch=False)
        rate = {f["currency"]: f["rate"] for f in ov["fx"]}
        try:
            series, kind = portfolio_series(db, user, rate, ov["totals_all"]["market_value"])
        except Exception:
            series, kind = None, None
        return jsonify({"series": series, "kind": kind})

    @app.get("/api/widgets/layout")
    @login_required
    def widgets_layout_get():
        r = get_db().execute("SELECT data FROM widget_prefs WHERE user_id=?", (current_user()["id"],)).fetchone()
        return jsonify({"layout": json.loads(r["data"]) if r else None})

    @app.put("/api/widgets/layout")
    @login_required
    def widgets_layout_put():
        lay = clean_layout(json_body())
        db = get_db()
        db.execute("""INSERT INTO widget_prefs (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
                      ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at""", (current_user()["id"], json.dumps(lay)))
        _public_cache.clear()
        return jsonify({"layout": lay})

    @app.delete("/api/widgets/layout")
    @login_required
    def widgets_layout_reset():
        get_db().execute("DELETE FROM widget_prefs WHERE user_id=?", (current_user()["id"],))
        _public_cache.clear()
        return jsonify({"layout": None})

    # ---- enlace de solo lectura para widgets nativos (iPhone)
    @app.get("/api/widgets/token")
    @login_required
    def widgets_token_status():
        r = get_db().execute("SELECT created_at FROM widget_tokens WHERE user_id=?", (current_user()["id"],)).fetchone()
        return jsonify({"has_token": bool(r), "created_at": r["created_at"] if r else None})

    @app.post("/api/widgets/token")
    @login_required
    def widgets_token_create():
        """Crea o REGENERA el token (el anterior deja de funcionar). Solo aquí se muestra completo."""
        db, uid = get_db(), current_user()["id"]
        token = secrets.token_urlsafe(24)
        db.execute("""INSERT INTO widget_tokens (user_id, token_hash, created_at) VALUES (?, ?, datetime('now'))
                      ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at""", (uid, _hash(token)))
        _public_cache.clear()
        return jsonify({"token": token}), 201

    @app.delete("/api/widgets/token")
    @login_required
    def widgets_token_revoke():
        get_db().execute("DELETE FROM widget_tokens WHERE user_id=?", (current_user()["id"],))
        _public_cache.clear()
        return jsonify({"ok": True})

    @app.get("/api/widgets/public")
    def widgets_public():
        """Solo lectura, sin sesión: la consulta el widget de iPhone con ?token=. No permite modificar nada."""
        ip, now = request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip(), time.time()
        fails = [t for t in _fails.get(ip, []) if now - t < 600]
        if len(fails) >= 30:
            return api_error("Demasiados intentos. Espera unos minutos.", 429)
        token = request.args.get("token", "")
        db = get_db()
        r = db.execute("SELECT user_id FROM widget_tokens WHERE token_hash=?", (_hash(token),)).fetchone() if 16 <= len(token) <= 80 else None
        if not r:
            _fails[ip] = fails + [now]
            return api_error("Enlace no válido o revocado.", 404)
        hit = _public_cache.get(r["user_id"])
        if hit and now - hit[0] < PUBLIC_TTL:
            return jsonify(hit[1])
        user = db.execute("SELECT * FROM users WHERE id=?", (r["user_id"],)).fetchone()
        lay = db.execute("SELECT data FROM widget_prefs WHERE user_id=?", (r["user_id"],)).fetchone()
        data = widget_data(db, user) | {"name": (user["name"] or "").split(" ")[0], "layout": json.loads(lay["data"]) if lay else None}   # el layout trae tus colores: el widget del iPhone se ve igual que en la web
        _public_cache[r["user_id"]] = (now, data)
        return jsonify(data)
