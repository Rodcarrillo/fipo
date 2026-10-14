"""Portafolio de inversiones: operaciones, posiciones (costo promedio), cotizaciones y gráfica.

Reglas:
  - compra: suma unidades y costo (cantidad x precio + comisión). Vende: reduce unidades y costo al costo promedio.
  - ganancia realizada = ingreso neto de la venta - costo promedio de lo vendido (+ dividendos e intereses aparte).
  - ganancia no realizada = valor de mercado - costo de las unidades que aún se tienen.
  - una operación ligada a una cuenta mueve el efectivo de esa cuenta, pero NO cuenta como gasto ni ingreso.
Los precios nunca se inventan: vienen de Yahoo Finance, se capturan a mano o no existen (se muestra sin valor).
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from db import atomic
from ledger import ValidationError, clean_text, owned, parse_date, to_cents

KINDS = ("buy", "sell", "dividend", "interest")
ASSET_TYPES = ("stock", "etf", "crypto", "bond", "fund", "gold", "other")
SYMBOL_RE = re.compile(r"^[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,19}$")
REFRESH_SECONDS = 3600
HISTORY_RANGES = {"1mo": ("1mo", "1d"), "6mo": ("6mo", "1d"), "1y": ("1y", "1d"), "5y": ("5y", "1wk")}
_last_manual_refresh = {}


def utcnow():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def parse_iso(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def yahoo_link(symbol):
    return "https://finance.yahoo.com/quote/" + urllib.parse.quote(symbol, safe="")


def clean_symbol(v):
    s = str(v or "").strip().upper()
    if not SYMBOL_RE.match(s):
        raise ValidationError("Símbolo no válido. Usa el ticker, por ejemplo AAPL, VOO o BTC-USD.", "symbol")
    return s


def to_decimal(v, field, max_dec=8, allow_zero=False):
    if v is None or (isinstance(v, str) and not v.strip()):
        raise ValidationError("Este campo es obligatorio.", field)
    try:
        d = Decimal(str(v).replace(",", "").replace("$", "").strip())
    except InvalidOperation:
        raise ValidationError("Número no válido.", field)
    if not d.is_finite() or d < 0 or (d == 0 and not allow_zero) or d > Decimal("1e12"):
        raise ValidationError("Debe ser un número mayor que cero.", field)
    if d.normalize().as_tuple().exponent < -max_dec:
        raise ValidationError(f"Máximo {max_dec} decimales.", field)
    return d


def dec_text(d):
    s = format(d.normalize(), "f")
    return s if "." not in s else s.rstrip("0").rstrip(".")


def cents(d):
    return int((d * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


# ------------------------------------------------------------------ Yahoo Finance (API no oficial)
def _http_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; FIPO/1.0)", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError("Yahoo Finance no encontró este símbolo.")
        if e.code in (401, 403, 429):
            raise RuntimeError("Yahoo Finance rechazó o limitó la consulta. Se reintentará en la próxima actualización.")
        raise RuntimeError(f"Yahoo Finance respondió con error {e.code}.")
    except Exception:
        raise RuntimeError("No se pudo conectar con Yahoo Finance.")


def _chart(symbol, rng, interval):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(symbol, safe="^=.-")
           + f"?range={rng}&interval={interval}&includePrePost=false")
    j = _http_json(url)
    try:
        res = j["chart"]["result"][0]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("Yahoo Finance no devolvió datos para este símbolo.")
    return res


def yahoo_quote(symbol):
    r = _chart(symbol, "1d", "1d")
    m = r.get("meta") or {}
    price = m.get("regularMarketPrice")
    if price is None:
        raise RuntimeError("Yahoo Finance no devolvió precio para este símbolo.")
    prev = m.get("chartPreviousClose", m.get("previousClose"))
    cur = m.get("currency") or ""
    if cur in ("GBp", "GBX"):                       # Londres cotiza en peniques
        price, prev, cur = price / 100, (prev / 100 if prev is not None else None), "GBP"
    t = m.get("regularMarketTime")
    return {"price": float(price), "prev_close": float(prev) if prev is not None else None, "currency": cur.upper(),
            "name": m.get("longName") or m.get("shortName") or symbol, "exchange": m.get("fullExchangeName") or m.get("exchangeName") or "",
            "price_time": iso(datetime.fromtimestamp(t, timezone.utc)) if t else None}


def yahoo_history(symbol, rng):
    rr, itv = HISTORY_RANGES[rng]
    r = _chart(symbol, rr, itv)
    ts = r.get("timestamp") or []
    closes = ((r.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    pts = [[t, round(c, 6)] for t, c in zip(ts, closes) if c is not None]
    if len(pts) < 2:
        raise RuntimeError("Yahoo Finance no devolvió historial suficiente.")
    scale = 0.01 if ((r.get("meta") or {}).get("currency") in ("GBp", "GBX")) else 1
    return [[t, round(c * scale, 6)] for t, c in pts]


class Market:
    """Fuente de precios reemplazable (las pruebas inyectan una falsa)."""
    quote = staticmethod(yahoo_quote)
    history = staticmethod(yahoo_history)


# ------------------------------------------------------------------ cotizaciones
def refresh_symbols(db, symbols, force=False, market=Market, max_age=REFRESH_SECONDS - 300):
    """Actualiza cotizaciones. Un fallo no borra el último precio: solo guarda el error y la hora del intento."""
    ok, failed = [], {}
    now = utcnow()
    for sym in symbols:
        q = db.execute("SELECT * FROM quotes WHERE symbol=?", (sym,)).fetchone()
        if q and not force and q["source"] == "yahoo" and q["updated_at"]:
            t = parse_iso(q["updated_at"])
            if t and (now - t).total_seconds() < max_age:
                continue
        try:
            d = market.quote(sym)
        except Exception as e:
            msg = str(e) or "Error desconocido."
            db.execute("""INSERT INTO quotes (symbol, last_attempt, last_error) VALUES (?, ?, ?)
                          ON CONFLICT(symbol) DO UPDATE SET last_attempt=excluded.last_attempt, last_error=excluded.last_error""",
                       (sym, iso(now), msg))
            failed[sym] = msg
            continue
        db.execute("""INSERT INTO quotes (symbol, name, currency, exchange, price, prev_close, source, price_time, updated_at, last_attempt, last_error)
                      VALUES (?,?,?,?,?,?, 'yahoo', ?, ?, ?, '')
                      ON CONFLICT(symbol) DO UPDATE SET name=excluded.name, currency=excluded.currency, exchange=excluded.exchange, price=excluded.price,
                        prev_close=excluded.prev_close, source='yahoo', price_time=excluded.price_time, updated_at=excluded.updated_at,
                        last_attempt=excluded.last_attempt, last_error=''""",
                   (sym, d["name"], d["currency"], d["exchange"], d["price"], d["prev_close"], d["price_time"], iso(now), iso(now)))
        ok.append(sym)
        time.sleep(0.2)
    return ok, failed


def held_symbols(db, user_id=None):
    if user_id is None:
        rows = db.execute("SELECT symbol FROM holding_ops GROUP BY symbol").fetchall()
    else:
        rows = db.execute("SELECT symbol FROM holding_ops WHERE user_id=? GROUP BY symbol", (user_id,)).fetchall()
    return [r["symbol"] for r in rows]


def watchlist_symbols(db, user_id=None):
    """Símbolos en vigilancia (no necesariamente en cartera): también se actualizan cada hora y con el botón manual."""
    if user_id is None:
        rows = db.execute("SELECT symbol FROM watchlist GROUP BY symbol").fetchall()
    else:
        rows = db.execute("SELECT symbol FROM watchlist WHERE user_id=? GROUP BY symbol", (user_id,)).fetchall()
    return [r["symbol"] for r in rows]


def get_fx_rate(db, from_cur, to_cur, market=Market, max_age=REFRESH_SECONDS - 300, fetch=True):
    """Cuántas unidades de to_cur equivalen a 1 from_cur, o None si no se pudo consultar. Usa los tickers de
    tipo de cambio de Yahoo Finance ('MXN=X' = dólares a pesos), cacheados en la tabla quotes como cualquier
    símbolo (se reutiliza refresh_symbols, así que respeta el mismo caché de una hora y nunca inventa un dato)."""
    from_cur, to_cur = (from_cur or "").upper(), (to_cur or "").upper()
    if not from_cur or not to_cur or from_cur == to_cur:
        return 1.0

    def usd_per(cur):                    # unidades de `cur` por 1 USD
        if cur == "USD":
            return 1.0
        sym = cur + "=X"
        q = db.execute("SELECT last_attempt, price FROM quotes WHERE symbol=?", (sym,)).fetchone()
        t = parse_iso(q["last_attempt"]) if q and q["last_attempt"] else None
        if fetch and not (q and q["price"] is not None and t and (utcnow() - t).total_seconds() < 600):   # no reintentar a cada rato
            refresh_symbols(db, [sym], market=market, max_age=max_age)
        q = db.execute("SELECT price FROM quotes WHERE symbol=?", (sym,)).fetchone()
        return q["price"] if q and q["price"] is not None else None

    r_from, r_to = usd_per(from_cur), usd_per(to_cur)
    if not r_from or r_to is None:
        return None
    return r_to / r_from


def start_scheduler(db_path, interval=REFRESH_SECONDS, market=Market, initial_delay=15, after=None):
    """Hilo en segundo plano: actualiza los precios de todos los símbolos en cartera cada hora."""
    import sqlite3

    def loop():
        time.sleep(initial_delay)
        while True:
            try:
                conn = sqlite3.connect(db_path, isolation_level=None, timeout=30)
                conn.row_factory = sqlite3.Row
                syms = list(set(held_symbols(conn)) | set(watchlist_symbols(conn)))
                refresh_symbols(conn, syms, market=market, max_age=interval * 0.9)
                if after:
                    after(conn)                         # avisos: precios objetivo y pagos de tarjeta
                conn.close()
            except Exception as e:                      # nunca debe tumbar el servidor
                print(f"[FIPO] Error al actualizar precios: {e}", flush=True)
            time.sleep(interval)

    t = threading.Thread(target=loop, name="fipo-quotes", daemon=True)
    t.start()
    return t


def get_history(db, symbol, rng, market=Market):
    """Historial para la gráfica. Si no se puede obtener, avisa y ofrece el enlace a Yahoo Finance."""
    if rng not in HISTORY_RANGES:
        raise ValidationError("Rango no válido.", "range")
    row = db.execute("SELECT * FROM quote_history WHERE symbol=? AND range=?", (symbol, rng)).fetchone()
    now = utcnow()
    if row:
        t = parse_iso(row["fetched_at"])
        if t and (now - t).total_seconds() < REFRESH_SECONDS:
            return {"available": True, "points": json.loads(row["points"]), "fetched_at": row["fetched_at"], "stale": False, "link": yahoo_link(symbol)}
    try:
        pts = market.history(symbol, rng)
    except Exception as e:
        if row:
            return {"available": True, "points": json.loads(row["points"]), "fetched_at": row["fetched_at"], "stale": True, "link": yahoo_link(symbol), "note": str(e)}
        return {"available": False, "link": yahoo_link(symbol), "note": str(e) or "No se pudo obtener el historial."}
    db.execute("INSERT OR REPLACE INTO quote_history (symbol, range, points, fetched_at) VALUES (?,?,?,?)", (symbol, rng, json.dumps(pts), iso(now)))
    return {"available": True, "points": pts, "fetched_at": iso(now), "stale": False, "link": yahoo_link(symbol)}


def set_manual_price(db, user_id, symbol, price, currency=None):
    symbol = clean_symbol(symbol)
    if symbol not in held_symbols(db, user_id):
        raise ValidationError("Solo puedes fijar el precio de activos que tengas en tu portafolio.", "symbol", 404)
    p = to_decimal(price, "price", 8)
    q = db.execute("SELECT * FROM quotes WHERE symbol=?", (symbol,)).fetchone()
    op = db.execute("SELECT currency, name FROM holding_ops WHERE user_id=? AND symbol=? ORDER BY date DESC, id DESC", (user_id, symbol)).fetchone()
    now = iso(utcnow())
    db.execute("""INSERT INTO quotes (symbol, name, currency, price, prev_close, source, price_time, updated_at, last_attempt, last_error)
                  VALUES (?,?,?,?,?, 'manual', ?, ?, ?, '')
                  ON CONFLICT(symbol) DO UPDATE SET price=excluded.price, source='manual', price_time=excluded.price_time, updated_at=excluded.updated_at,
                    last_error='', prev_close=CASE WHEN quotes.source='manual' THEN quotes.prev_close ELSE quotes.price END""",
               (symbol, (q["name"] if q else "") or op["name"], (q["currency"] if q else "") or op["currency"], float(p), None, now, now, now))


# ------------------------------------------------------------------ operaciones
def op_row(o):
    return {"id": o["id"], "symbol": o["symbol"], "name": o["name"], "asset_type": o["asset_type"], "kind": o["kind"],
            "quantity": o["quantity"], "price": o["price"], "gross": o["gross"], "fee": o["fee"], "currency": o["currency"],
            "date": o["date"], "account_id": o["account_id"], "notes": o["notes"]}


def _simulate(ops):
    """Recorre las operaciones en orden cronológico. Devuelve posiciones o lanza error si se vende más de lo que hay."""
    pos = {}
    for o in sorted(ops, key=lambda r: (r["date"], r["id"])):
        p = pos.setdefault(o["symbol"], {"qty": Decimal(0), "cost": Decimal(0), "realized": Decimal(0), "income": Decimal(0),
                                         "fees": Decimal(0), "bought": Decimal(0), "sold": Decimal(0), "name": o["name"], "type": o["asset_type"],
                                         "currency": o["currency"], "first": o["date"], "last": o["date"]})
        p["name"], p["type"], p["last"] = (o["name"] or p["name"]), o["asset_type"], o["date"]
        q = Decimal(o["quantity"])
        if o["kind"] == "buy":
            p["qty"] += q
            p["cost"] += Decimal(o["gross"] + o["fee"])
            p["bought"] += Decimal(o["gross"] + o["fee"])
            p["fees"] += Decimal(o["fee"])
        elif o["kind"] == "sell":
            if q > p["qty"]:
                raise ValidationError(f"No tienes suficientes unidades de {o['symbol']} al {o['date']} (tenías {dec_text(p['qty'])}, intentas vender {dec_text(q)}).", "quantity")
            basis = p["cost"] * q / p["qty"] if p["qty"] else Decimal(0)
            p["realized"] += Decimal(o["gross"] - o["fee"]) - basis
            p["cost"] -= basis
            p["qty"] -= q
            p["sold"] += Decimal(o["gross"] - o["fee"])
            p["fees"] += Decimal(o["fee"])
            if p["qty"] == 0:
                p["cost"] = Decimal(0)
        else:
            p["income"] += Decimal(o["gross"] - o["fee"])
            p["fees"] += Decimal(o["fee"])
    return pos


def _all_ops(db, user_id, exclude_id=None):
    rows = db.execute("SELECT * FROM holding_ops WHERE user_id=?", (user_id,)).fetchall()
    return [dict(r) for r in rows if r["id"] != exclude_id]


def normalize_op(db, user_id, d, existing=None, market=Market, allow_fetch=True):
    kind = d.get("kind")
    if kind not in KINDS:
        raise ValidationError("Tipo de operación no válido.", "kind")
    symbol = clean_symbol(d.get("symbol"))
    date = parse_date(d.get("date"))
    asset_type = d.get("asset_type") or "stock"
    if asset_type not in ASSET_TYPES:
        raise ValidationError("Tipo de activo no válido.", "asset_type")
    o = {"symbol": symbol, "kind": kind, "date": date, "asset_type": asset_type, "notes": clean_text(d.get("notes"), "notes", 500)}

    acc = None
    if d.get("account_id") not in (None, ""):
        acc = owned(db, "accounts", d["account_id"], user_id)
        if not acc:
            raise ValidationError("Selecciona una cuenta válida.", "account_id")
        if acc["archived"] and not (existing and existing["account_id"] == acc["id"]):
            raise ValidationError("La cuenta está archivada.", "account_id")
    o["account_id"] = acc["id"] if acc else None

    # moneda y nombre: de lo que ya se conoce del símbolo, de la cotización o de lo que capture el usuario
    prev = db.execute("SELECT currency, name FROM holding_ops WHERE user_id=? AND symbol=? AND id IS NOT ? ORDER BY date, id LIMIT 1",
                      (user_id, symbol, existing["id"] if existing else None)).fetchone()
    quote = db.execute("SELECT * FROM quotes WHERE symbol=?", (symbol,)).fetchone()
    if not prev and allow_fetch and (not quote or not quote["currency"]):
        try:
            refresh_symbols(db, [symbol], force=True, market=market)
        except Exception:
            pass
        quote = db.execute("SELECT * FROM quotes WHERE symbol=?", (symbol,)).fetchone()
    cur = (prev["currency"] if prev else None) or (quote["currency"] if quote and quote["currency"] else None) or (acc["currency"] if acc else None) \
        or (str(d.get("currency") or "").upper() or None)
    if not cur:
        u = db.execute("SELECT currency FROM users WHERE id=?", (user_id,)).fetchone()
        cur = u["currency"]
    if not re.fullmatch(r"[A-Z]{3}", cur):
        raise ValidationError("Moneda no válida.", "currency")
    if acc and acc["currency"] != cur:
        raise ValidationError(f"{symbol} cotiza en {cur} y la cuenta está en {acc['currency']}. Elige una cuenta en {cur} o deja el efectivo sin ligar.", "account_id")
    o["currency"] = cur
    o["name"] = clean_text(d.get("name"), "name", 120) or (prev["name"] if prev and prev["name"] else "") or (quote["name"] if quote and quote["name"] else "") or symbol

    fee = to_cents(d.get("fee") or 0, "fee", allow_zero=True)
    if kind in ("buy", "sell"):
        q = to_decimal(d.get("quantity"), "quantity", 8)
        p = to_decimal(d.get("price"), "price", 8)
        o["quantity"], o["price"] = dec_text(q), dec_text(p)
        o["gross"] = cents(q * p)
        if o["gross"] <= 0:
            raise ValidationError("El importe de la operación es demasiado pequeño.", "price")
    else:
        o["quantity"], o["price"] = "0", "0"
        o["gross"] = to_cents(d.get("amount"), "amount")
    o["fee"] = fee
    return o


OP_COLS = ("symbol", "name", "asset_type", "kind", "quantity", "price", "gross", "fee", "currency", "date", "account_id", "notes")


def save_op(db, user_id, data, op_id=None, market=Market):
    with atomic(db):
        existing = owned(db, "holding_ops", op_id, user_id) if op_id else None
        if op_id and not existing:
            raise ValidationError("Operación no encontrada.", status=404)
        o = normalize_op(db, user_id, data, existing, market)
        others = _all_ops(db, user_id, exclude_id=existing["id"] if existing else None)
        for x in others:                                    # una moneda por símbolo
            if x["symbol"] == o["symbol"] and x["currency"] != o["currency"]:
                raise ValidationError(f"{o['symbol']} ya está registrado en {x['currency']}.", "symbol")
        _simulate(others + [{**o, "id": existing["id"] if existing else 10 ** 12}])
        if existing:
            db.execute(f"UPDATE holding_ops SET {', '.join(c + ' = ?' for c in OP_COLS)} WHERE id = ? AND user_id = ?",
                       (*[o[c] for c in OP_COLS], existing["id"], user_id))
            return existing["id"]
        cur = db.execute(f"INSERT INTO holding_ops (user_id, {', '.join(OP_COLS)}) VALUES (?, {', '.join('?' * len(OP_COLS))})", (user_id, *[o[c] for c in OP_COLS]))
        return cur.lastrowid


def delete_op(db, user_id, op_id):
    with atomic(db):
        if not owned(db, "holding_ops", op_id, user_id):
            raise ValidationError("Operación no encontrada.", status=404)
        _simulate(_all_ops(db, user_id, exclude_id=int(op_id)))      # no puede dejar ventas sin unidades
        db.execute("DELETE FROM holding_ops WHERE id=? AND user_id=?", (op_id, user_id))


# ------------------------------------------------------------------ resumen del portafolio
def summary(db, user, market=Market):
    uid, main = user["id"], user["currency"]
    ops = _all_ops(db, uid)
    pos = _simulate(ops)
    quotes = {r["symbol"]: r for r in db.execute("SELECT * FROM quotes")}
    now = utcnow()
    items, closed = [], []
    for sym, p in sorted(pos.items()):
        q = quotes.get(sym)
        price = Decimal(str(q["price"])) if q and q["price"] is not None else None
        prev = Decimal(str(q["prev_close"])) if q and q["prev_close"] is not None else None
        held = p["qty"] > 0
        mv = cents(p["qty"] * price) if (held and price is not None) else None
        cost = int(p["cost"].quantize(Decimal(1), rounding=ROUND_HALF_UP))
        unreal = (mv - cost) if mv is not None else None
        day = cents(p["qty"] * (price - prev)) if (held and price is not None and prev is not None and q["source"] == "yahoo") else None
        item = {
            "symbol": sym, "name": (q["name"] if q and q["name"] else p["name"]) or sym, "asset_type": p["type"], "currency": p["currency"],
            "quantity": dec_text(p["qty"]), "avg_cost": dec_text((p["cost"] / p["qty"] / 100).quantize(Decimal("0.0001"))) if held else None,
            "cost": cost, "price": float(price) if price is not None else None, "market_value": mv,
            "unrealized": unreal, "unrealized_pct": round(float(Decimal(unreal) / Decimal(cost) * 100), 2) if (unreal is not None and cost) else None,
            "day_change": day, "day_change_pct": round(float((price - prev) / prev * 100), 2) if (price is not None and prev and q["source"] == "yahoo") else None,
            "realized": int(p["realized"].quantize(Decimal(1), rounding=ROUND_HALF_UP)), "income": int(p["income"]), "fees": int(p["fees"]),
            "price_source": q["source"] if q and q["price"] is not None else None,
            "updated_at": q["updated_at"] if q else None, "price_time": q["price_time"] if q else None,
            "last_error": q["last_error"] if q else "", "link": yahoo_link(sym), "first_date": p["first"], "last_date": p["last"],
        }
        (items if held else closed).append(item)
    inmain = [i for i in items if i["currency"] == main]
    priced = [i for i in inmain if i["market_value"] is not None]
    totals = {
        "market_value": sum(i["market_value"] for i in priced), "cost": sum(i["cost"] for i in priced),
        "unrealized": sum(i["unrealized"] for i in priced), "day_change": sum(i["day_change"] or 0 for i in priced),
        "realized": sum(i["realized"] for i in inmain + [c for c in closed if c["currency"] == main]),
        "income": sum(i["income"] for i in inmain + [c for c in closed if c["currency"] == main]),
        "unpriced": [i["symbol"] for i in inmain if i["market_value"] is None],
    }
    totals["unrealized_pct"] = round(totals["unrealized"] / totals["cost"] * 100, 2) if totals["cost"] else None
    times = [parse_iso(i["updated_at"]) for i in items if i["updated_at"] and i["price_source"] == "yahoo"]
    times = [t for t in times if t]
    return {
        "currency": main, "positions": items, "closed": closed, "totals": totals,
        "other_currency": [{"symbol": i["symbol"], "currency": i["currency"], "market_value": i["market_value"], "cost": i["cost"]} for i in items if i["currency"] != main],
        "last_update": iso(max(times)) if times else None, "refresh_seconds": REFRESH_SECONDS, "server_time": iso(now),
        "any_error": any(i["last_error"] for i in items),
    }


def fx_rates(db, main, currencies, market=Market, fetch=True):
    """{moneda: pesos (o moneda principal) por 1 unidad} para las monedas dadas; None si no hay tipo de cambio.
    fetch=False: solo lo que ya está guardado (para pantallas que se consultan seguido)."""
    return {c: (1.0 if c == main else get_fx_rate(db, c, main, market=market, fetch=fetch)) for c in set(currencies)}


def fx_info(db, main, rates):
    """Para mostrar de dónde sale cada tipo de cambio (Yahoo o el que capturaste) y de cuándo es."""
    out = []
    for c, r in sorted(rates.items()):
        if c == main or r is None:
            continue
        q = db.execute("SELECT source, price_time, updated_at FROM quotes WHERE symbol=?", ((main if c == "USD" else c) + "=X",)).fetchone()
        out.append({"currency": c, "rate": r, "source": q["source"] if q else "", "as_of": (q["price_time"] or q["updated_at"]) if q else None})
    return out


def value_in_main(db, user, fetch=True):
    """Valor de mercado de TODAS las posiciones con precio, convertido a la moneda principal cuando hay tipo de cambio."""
    s = summary(db, user)
    rates = fx_rates(db, user["currency"], [i["currency"] for i in s["positions"]], fetch=fetch)
    return sum(round(i["market_value"] * rates[i["currency"]]) for i in s["positions"] if i["market_value"] is not None and rates.get(i["currency"]))


def account_holdings(db, user_id):
    """Por cuenta ligada: valor de mercado de sus acciones (en la moneda de la cuenta), con el último precio conocido.
    Es lo que convierte a una cuenta de inversión en «efectivo + acciones» sin contar dos veces el mismo dinero."""
    ops = [dict(r) for r in db.execute("SELECT * FROM holding_ops WHERE user_id=? AND account_id IS NOT NULL", (user_id,))]
    quotes = {r["symbol"]: r["price"] for r in db.execute("SELECT symbol, price FROM quotes")}
    out = {}
    for aid in {o["account_id"] for o in ops}:
        pos = _simulate([o for o in ops if o["account_id"] == aid])
        held = {s: p for s, p in pos.items() if p["qty"] > 0}
        value, cost, unpriced = 0, 0, []
        for s, p in held.items():
            cost += int(p["cost"].quantize(Decimal(1), rounding=ROUND_HALF_UP))
            if quotes.get(s) is None:
                unpriced.append(s)
            else:
                value += cents(p["qty"] * Decimal(str(quotes[s])))
        out[aid] = {"value": value, "cost": cost, "positions": len(held), "unpriced": unpriced, "symbols": sorted(held)}
    return out


def overview_all(db, user, fetch=False):
    """Para ver todo junto: totales en la moneda principal (con las otras monedas convertidas) y un resumen por cuenta
    ligada (p. ej. «GBM Portafolio USA» en dólares y «GBM Portafolio MX» en pesos): efectivo + acciones = total."""
    main = user["currency"]
    s = summary(db, user)
    pos = s["positions"]
    rates = fx_rates(db, main, [p["currency"] for p in pos] + [r["currency"] for r in db.execute(
        "SELECT DISTINCT a.currency FROM holding_ops h JOIN accounts a ON a.id=h.account_id WHERE h.user_id=?", (user["id"],))], fetch=fetch)
    conv = [p for p in pos if p["market_value"] is not None and rates.get(p["currency"])]
    mv = sum(round(p["market_value"] * rates[p["currency"]]) for p in conv)
    cost = sum(round(p["cost"] * rates[p["currency"]]) for p in conv)
    day = sum(round((p["day_change"] or 0) * rates[p["currency"]]) for p in conv)
    all_t = {"market_value": mv, "cost": cost, "unrealized": mv - cost, "unrealized_pct": round((mv - cost) * 100 / cost, 2) if cost else None,
             "day_change": day, "missing": [p["symbol"] for p in pos if p not in conv]}
    # por cuenta ligada
    hold = account_holdings(db, user["id"])
    accounts = []
    from ledger import balances
    bal = balances(db, user["id"])
    for aid, h in hold.items():
        a = db.execute("SELECT id, name, currency, archived FROM accounts WHERE id=?", (aid,)).fetchone()
        r = rates.get(a["currency"])
        cash = bal.get(aid, 0)
        accounts.append({"id": a["id"], "name": a["name"], "currency": a["currency"], "cash": cash, "holdings_value": h["value"], "cost": h["cost"],
                         "total": cash + h["value"], "unrealized": h["value"] - h["cost"], "positions": h["positions"], "symbols": h["symbols"],
                         "unpriced": h["unpriced"], "fx_rate": r, "total_main": round((cash + h["value"]) * r) if r else None})
    accounts.sort(key=lambda x: x["name"].lower())
    by_symbol = {}
    for acc in accounts:
        for sym in acc["symbols"]:
            by_symbol.setdefault(sym, []).append(acc["name"])
    return {"totals_all": all_t, "fx": fx_info(db, main, rates), "accounts": accounts,
            "position_accounts": {k: v for k, v in by_symbol.items()}}


def portfolio_value_main(db, user):
    """Valor de mercado (moneda principal) de las posiciones con precio; usado por el dashboard."""
    s = summary(db, user)
    return s["totals"]["market_value"]
