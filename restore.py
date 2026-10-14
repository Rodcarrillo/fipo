"""«Cargar mis datos»: da de alta en una sola operación las cuentas, tarjetas (con sus compras a meses) e inversiones
que vienen en un archivo de carga de FIPO (JSON, formato "fipo-carga" v1). Se usa para empezar con tus datos reales.

Reglas (las de siempre en FIPO):
- Todo o nada: si algo no cuadra no se guarda nada.
- Primero se puede «probar» (dry run): se ejecuta todo dentro de la transacción, se calcula el resumen con las mismas
  funciones de la app (saldos, pago del mes, valor de inversiones) y se deshace. Lo que ves es lo que quedará.
- Nada se inventa: los saldos salen del archivo; lo que el archivo no detalla (compras después del corte sin desglose)
  queda como un ajuste de saldo claramente marcado, que no cuenta como gasto ni ingreso.
- Inversiones: el saldo de la cuenta es el efectivo sin invertir; las acciones se registran como operaciones ligadas a
  esa cuenta. Así el total de la cuenta (efectivo + acciones) y el portafolio son el mismo dinero y el patrimonio no se
  duplica.
"""
from datetime import date
from decimal import Decimal

import cards
import ledger
import more
import portfolio
from db import atomic
from ledger import ValidationError, clean_text, parse_date, to_cents, today_for


class _DryRun(Exception):
    def __init__(self, result):
        self.result = result


def _money(v, field, allow_negative=False, allow_zero=True):
    return to_cents(str(v), field, allow_negative=allow_negative, allow_zero=allow_zero)


def load(db, user, data, create_account, dry_run=True):
    if not isinstance(data, dict) or data.get("format") != "fipo-carga" or data.get("version") != 1:
        raise ValidationError("Este archivo no es un archivo de carga de FIPO.", "file")
    uid, today = user["id"], today_for(user["timezone"])
    accounts = data.get("accounts")
    if not isinstance(accounts, list) or not accounts or len(accounts) > 60:
        raise ValidationError("El archivo no trae cuentas para cargar.", "file")
    try:
        with atomic(db):
            result = _load(db, user, uid, today, data, accounts, create_account)
            if dry_run:
                raise _DryRun(result)
        return result
    except _DryRun as d:
        return d.result


def _load(db, user, uid, today, data, accounts, create_account):
    existing = {r[0].lower() for r in db.execute("SELECT name FROM accounts WHERE user_id=?", (uid,))}
    names = [clean_text(a.get("name"), "name", 80, required=True) for a in accounts]
    clash = [n for n in names if n.lower() in existing]
    if clash:
        raise ValidationError("Ya tienes cuentas con estos nombres: " + ", ".join(clash) + ". No se cargó nada (así no se duplica). "
                              "Si quieres cargar de nuevo, primero elimina o renombra esas cuentas.")
    if len({n.lower() for n in names}) != len(names):
        raise ValidationError("El archivo repite nombres de cuenta.")

    warnings, created = list(data.get("notes") or []), []
    for a, name in zip(accounts, names):
        typ = a.get("type", "bank")
        base = {"name": name, "institution": a.get("institution") or "", "type": typ, "currency": a.get("currency") or user["currency"]}
        if typ == "credit":
            created.append(_card(db, uid, today, a, base, create_account))
        elif a.get("holdings"):
            created.append(_investment(db, user, uid, today, a, base, create_account, warnings))
        else:
            aid = create_account(db, uid, {**base, "opening_balance": str(a.get("balance", 0)), "opened_on": a.get("opened_on") or today.isoformat()},
                                 user["currency"], today.isoformat())
            created.append(aid)

    for fx in data.get("fx") or []:                     # tipo de cambio de respaldo (el tuyo); Yahoo lo reemplaza al actualizar
        cur = str(fx.get("currency") or "").upper()
        if cur and cur != "USD" and not db.execute("SELECT 1 FROM quotes WHERE symbol=? AND price IS NOT NULL", (cur + "=X",)).fetchone():
            db.execute("""INSERT INTO quotes (symbol, name, currency, price, source, price_time, updated_at) VALUES (?,?,?,?, 'manual', ?, ?)
                          ON CONFLICT(symbol) DO UPDATE SET price=excluded.price, source='manual', price_time=excluded.price_time""",
                       (cur + "=X", f"USD/{cur}", cur, float(Decimal(str(fx["per_usd"]))), fx.get("date"), portfolio.iso(portfolio.utcnow())))
    return _summary(db, user, created, warnings)


def _card(db, uid, today, a, base, create_account):
    cut, due = int(a.get("cut_day") or 0), int(a.get("due_day") or 0)
    if not cut:
        raise ValidationError(f"{base['name']}: falta el día de corte.")
    last_cut = more.prev_day(today, cut)
    statement = _money(a.get("statement_balance", 0), "statement_balance")
    after_cut = _money(a.get("after_cut", 0), "after_cut")
    plans = []
    for i, p in enumerate(a.get("plans") or []):
        parsed = cards.parse_plan(p, cut, field_prefix=f"{base['name']}.plans.{i}.")
        n = int(p.get("starts_after_cuts") or 0)       # p. ej. el pago final de un plan: se cobra después de N cortes
        start = cards.nth_cut_after(last_cut, cut, n) if n else last_cut
        plans.append((parsed, start))
    ob = -(statement + sum(p["principal_remaining"] for p, _ in plans))
    aid = create_account(db, uid, {**base, "credit_limit": str(a.get("credit_limit", 0)), "cut_day": cut, "due_day": due,
                                   "opening_balance": cards.money_str(ob),
                                   "opened_on": last_cut.isoformat()}, base["currency"], last_cut.isoformat())
    for p, start in plans:
        cards.insert_plan(db, uid, aid, p, start.isoformat())
    if after_cut:
        db.execute("""INSERT INTO transactions (user_id, type, amount, date, account_id, description, notes)
                      VALUES (?, 'adjustment', ?, ?, ?, ?, ?)""",
                   (uid, -after_cut, today.isoformat(), aid, "Cargos después del corte (saldo inicial)",
                    "Cargado con «Cargar mis datos»: parte de tu deuda que aún no entra al estado de cuenta, sin desglose. No cuenta como gasto."))
    return aid


def _investment(db, user, uid, today, a, base, create_account, warnings):
    """Cuenta de inversión con acciones: efectivo = valor total − valor de las acciones a los precios del archivo."""
    total = Decimal(str(a.get("total_value")))
    prices = {str(k).upper(): Decimal(str(v)) for k, v in (a.get("prices") or {}).items()}
    aid = create_account(db, uid, {**base, "opening_balance": "0", "opened_on": today.isoformat()}, user["currency"], today.isoformat())
    ops = []
    for i, h in enumerate(sorted(a["holdings"], key=lambda h: (h["date"], 0 if h["kind"] == "buy" else 1))):
        o = portfolio.normalize_op(db, uid, {**h, "account_id": aid, "currency": base["currency"]}, allow_fetch=False)
        if o["currency"] != base["currency"]:
            raise ValidationError(f"{o['symbol']} está en {o['currency']} y la cuenta {base['name']} en {base['currency']}.")
        ops.append({**o, "id": 10 ** 12 + i})
    others = [dict(r) for r in db.execute("SELECT * FROM holding_ops WHERE user_id=?", (uid,))]
    pos = portfolio._simulate(others + ops)                     # valida que ninguna venta deje unidades negativas
    mine = portfolio._simulate(ops)
    mv = Decimal(0)
    for sym, p in mine.items():
        if p["qty"] > 0:
            if sym not in prices:
                raise ValidationError(f"Falta el precio actual de {sym} en el archivo.")
            mv += (p["qty"] * prices[sym]).quantize(Decimal("0.01"))
    cash = total - mv
    if cash < Decimal("-0.01"):
        raise ValidationError(f"{base['name']}: las acciones valen {mv} y el total de la cuenta es {total}; no cuadra.")
    flows = sum(-(o["gross"] + o["fee"]) if o["kind"] == "buy" else (o["gross"] - o["fee"]) for o in ops)
    opening = int((cash * 100).quantize(Decimal(1))) - flows
    first = min(o["date"] for o in ops)
    db.execute("UPDATE accounts SET opening_balance=?, opened_on=? WHERE id=?", (opening, first, aid))
    for o in ops:
        db.execute(f"INSERT INTO holding_ops (user_id, {', '.join(portfolio.OP_COLS)}) VALUES (?, {', '.join('?' * len(portfolio.OP_COLS))})",
                   (uid, *[o[c] for c in portfolio.OP_COLS]))
    now = portfolio.iso(portfolio.utcnow())
    for sym, px in prices.items():                               # precio de partida; Yahoo lo actualiza después
        db.execute("""INSERT INTO quotes (symbol, name, currency, price, source, price_time, updated_at) VALUES (?,?,?,?, 'manual', ?, ?)
                      ON CONFLICT(symbol) DO NOTHING""", (sym, (pos.get(sym) or {}).get("name") or sym, base["currency"], float(px),
                                                          a.get("prices_date"), now))
    for s in a.get("skipped") or []:
        warnings.append(f"{base['name']}: {s}")
    return aid


def _summary(db, user, ids, warnings):
    uid = user["id"]
    bal = ledger.balances(db, uid)
    inv = portfolio.account_holdings(db, uid)
    out = []
    for aid in ids:
        a = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        row = {"name": a["name"], "type": a["type"], "currency": a["currency"], "balance": bal.get(aid, 0)}
        if a["type"] == "credit":
            c = more.card_row(db, user, a, bal.get(aid, 0))
            row.update({"debt": c["used"], "limit": c["limit"], "available": c["available"],
                        "to_pay": (c["statement"] or {}).get("pending"), "due": c["next_due"], "deferred": c["deferred_now"],
                        "plans": [{"description": p["description"], "monthly": p["monthly_amount"], "left": p["months_left"], "next": p["next_date"]}
                                  for p in c["plans"] if not p["finished"]]})
        h = inv.get(aid)
        if h:
            row.update({"holdings_value": h["value"], "positions": h["positions"], "unpriced": h["unpriced"]})
        out.append(row)
    return {"accounts": out, "warnings": warnings}
