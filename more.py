"""Fases 2 y 3: tarjetas, deudas, presupuestos, análisis, reportes, metas, tablas personalizadas y comprobantes (OCR)."""
import csv
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from flask import Response, jsonify, request, send_file

import cards
import health as health_mod
import ledger
import portfolio
from db import atomic, get_db
from ledger import ValidationError, clean_text, owned, parse_date, to_cents, today_for


# ---------------------------------------------------------------- utilidades
def month_bounds(key, today):
    if key:
        try:
            y, m = int(key[:4]), int(key[5:7])
            if key[4] != "-" or not (1990 <= y <= 2100 and 1 <= m <= 12) or len(key) != 7:
                raise ValueError
        except (ValueError, IndexError):
            raise ValidationError("Mes no válido (AAAA-MM).", "month")
    else:
        y, m = today.year, today.month
    return y, m, date(y, m, 1), date(y, m, monthrange(y, m)[1])


def money_txt(c):
    return f"{'-' if c < 0 else ''}${abs(c) / 100:,.2f}"


def category_spend(db, uid, s, e, cur):
    """Gasto neto (gastos - reembolsos) por categoría de primer nivel: las subcategorías suman a su padre."""
    rows = db.execute("""
        SELECT COALESCE(c.parent_id, c.id) AS cid,
               SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END) AS total
        FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.user_id=? AND t.date BETWEEN ? AND ? AND a.currency=? AND t.type IN ('expense','refund')
        GROUP BY cid""", (uid, s.isoformat(), e.isoformat(), cur)).fetchall()
    return {r["cid"] or 0: r["total"] for r in rows}


def cat_names(db, uid):
    return {r["id"]: r["name"] for r in db.execute("SELECT id, name FROM categories WHERE user_id=?", (uid,))}


# ---------------------------------------------------------------- tarjetas
def balance_as_of(db, uid, account_id, d):
    """Saldo de la cuenta considerando solo lo ocurrido hasta la fecha d (inclusive): la misma fórmula que el
    saldo actual (BALANCE_SQL en ledger.py: movimientos, operaciones de portafolio y abonos a deudas ligados
    a la cuenta), pero cortada en una fecha, para poder reconstruir saldos históricos."""
    iso = d.isoformat()
    a = db.execute("SELECT opening_balance FROM accounts WHERE id=? AND user_id=?", (account_id, uid)).fetchone()
    r = db.execute("""SELECT
        COALESCE((SELECT SUM(CASE t.type WHEN 'income' THEN t.amount WHEN 'refund' THEN t.amount WHEN 'adjustment' THEN t.amount
                                         WHEN 'expense' THEN -t.amount WHEN 'transfer' THEN -t.amount END)
                  FROM transactions t WHERE t.account_id=? AND t.date<=?),0)
      + COALESCE((SELECT SUM(t.to_amount) FROM transactions t WHERE t.to_account_id=? AND t.type='transfer' AND t.date<=?),0)
      + COALESCE((SELECT SUM(CASE h.kind WHEN 'buy' THEN -(h.gross + h.fee) ELSE (h.gross - h.fee) END)
                  FROM holding_ops h WHERE h.account_id=? AND h.date<=?),0)
      - COALESCE((SELECT SUM(p.principal_part + p.interest_part) FROM debt_payments p WHERE p.account_id=? AND p.date<=?),0)""",
                   (account_id, iso, account_id, iso, account_id, iso, account_id, iso)).fetchone()[0]
    return a["opening_balance"] + r


def prev_day(today, day):
    """Última fecha (<= hoy) con ese día del mes."""
    y, m = today.year, today.month
    for _ in range(3):
        d = date(y, m, min(day, monthrange(y, m)[1]))
        if d <= today:
            return d
        m -= 1
        if m < 1: m = 12; y -= 1
    return None


def card_row(db, user, a, bal):
    uid, today = user["id"], today_for(user["timezone"])
    used = max(0, -bal)
    out = {"id": a["id"], "name": a["name"], "institution": a["institution"], "currency": a["currency"], "archived": bool(a["archived"]),
           "balance": bal, "used": used, "credit_in_favor": max(0, bal), "limit": a["credit_limit"],
           "available": (a["credit_limit"] - used) if a["credit_limit"] else None,
           "utilization": round(used * 100 / a["credit_limit"], 1) if a["credit_limit"] else None,
           "cut_day": a["cut_day"], "due_day": a["due_day"], "next_cut": None, "next_due": None, "statement": None}
    nc, nd = ledger.next_day(today, a["cut_day"]), ledger.next_day(today, a["due_day"])
    out["next_cut"], out["next_due"] = (nc.isoformat() if nc else None), (nd.isoformat() if nd else None)
    lc = prev_day(today, a["cut_day"]) if a["cut_day"] else None
    ex = cards.card_extras(db, uid, a, today, lc)
    out.update({"plans": ex["plans"], "deferred_now": ex["deferred_now"], "installments_monthly": ex["installments_monthly"]})
    if a["cut_day"]:
        if lc:
            stmt_balance = max(0, -balance_as_of(db, uid, a["id"], lc))
            paid = db.execute("SELECT COALESCE(SUM(to_amount),0) FROM transactions WHERE user_id=? AND to_account_id=? AND type='transfer' AND date>?",
                              (uid, a["id"], lc.isoformat())).fetchone()[0]
            # «pago para no generar intereses»: lo que entró al estado de cuenta (sin el capital a meses que aún no tocaba)
            to_pay = max(0, stmt_balance - ex["deferred_at_cut"])
            out["statement"] = {"cut_date": lc.isoformat(), "balance_at_cut": stmt_balance, "deferred_at_cut": min(ex["deferred_at_cut"], stmt_balance),
                                "to_pay_at_cut": to_pay, "paid_since": paid, "pending": max(0, to_pay - paid),
                                "new_charges": db.execute("""SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount WHEN type='refund' THEN -amount WHEN type='adjustment' THEN -amount END),0)
                                    FROM transactions WHERE user_id=? AND account_id=? AND date>?""", (uid, a["id"], lc.isoformat())).fetchone()[0]}
    return out


# ---------------------------------------------------------------- deudas
def debt_row(db, d, today):
    pays = db.execute("SELECT * FROM debt_payments WHERE debt_id=? ORDER BY date, id", (d["id"],)).fetchall()
    paid_p, paid_i = sum(p["principal_part"] for p in pays), sum(p["interest_part"] for p in pays)
    remaining = d["principal"] - paid_p
    nd = ledger.next_day(today, d["due_day"]) if remaining > 0 else None
    months = None
    if remaining > 0 and d["monthly_payment"]:
        months = -(-remaining // d["monthly_payment"])   # aproximación sin interés futuro
    return {"id": d["id"], "name": d["name"], "creditor": d["creditor"], "currency": d["currency"], "principal": d["principal"],
            "interest_rate": d["interest_rate"], "start_date": d["start_date"], "monthly_payment": d["monthly_payment"], "due_day": d["due_day"],
            "notes": d["notes"], "archived": bool(d["archived"]), "paid_principal": paid_p, "paid_interest": paid_i, "remaining": remaining,
            "progress": round(paid_p * 100 / d["principal"], 1) if d["principal"] else 0, "next_due": nd.isoformat() if nd else None,
            "months_left": months, "payment_count": len(pays)}


def validate_pay_account(db, uid, account_id, currency):
    if account_id in (None, ""):
        return None
    acc = owned(db, "accounts", account_id, uid)
    if not acc:
        raise ValidationError("Selecciona una cuenta válida.", "account_id")
    if acc["archived"]:
        raise ValidationError("La cuenta está archivada.", "account_id")
    if acc["type"] == "credit":
        raise ValidationError("Paga desde una cuenta de dinero, no desde una tarjeta de crédito.", "account_id")
    if acc["currency"] != currency:
        raise ValidationError(f"La deuda está en {currency} y la cuenta en {acc['currency']}.", "account_id")
    return acc["id"]


# ---------------------------------------------------------------- presupuestos
def budget_status(db, user, month_key=None):
    uid, cur = user["id"], user["currency"]
    today = today_for(user["timezone"])
    y, m, s, e = month_bounds(month_key, today)
    spend = category_spend(db, uid, s, e, cur)
    names = cat_names(db, uid)
    rows = db.execute("SELECT * FROM budgets WHERE user_id=?", (uid,)).fetchall()
    total_spent = sum(v for v in spend.values())
    elapsed = min(1.0, max(0.0, ((min(today, e) - s).days + 1) / ((e - s).days + 1))) if today >= s else 0.0

    def item(cid, amount, spent, name):
        pct = round(spent * 100 / amount, 1) if amount else 0
        return {"category_id": cid, "name": name, "amount": amount, "spent": max(0, spent), "remaining": amount - spent, "pct": pct,
                "status": "over" if spent > amount else "warn" if pct >= 80 else "ok"}
    items = [item(r["category_id"], r["amount"], spend.get(r["category_id"], 0), names.get(r["category_id"], "Categoría eliminada"))
             for r in rows if r["category_id"] != 0]
    items.sort(key=lambda i: -i["pct"])
    tot = next((r for r in rows if r["category_id"] == 0), None)
    budgeted = {r["category_id"] for r in rows}
    unb = [{"category_id": k or None, "name": names.get(k, "Sin categoría") if k else "Sin categoría", "spent": v}
           for k, v in sorted(spend.items(), key=lambda kv: -kv[1]) if v > 0 and k not in budgeted]
    return {"month": f"{y:04d}-{m:02d}", "currency": cur, "elapsed_pct": round(elapsed * 100),
            "total": item(0, tot["amount"], total_spent, "Presupuesto total") if tot else None, "items": items, "unbudgeted": unb}


def budget_alerts(db, user):
    try:
        st = budget_status(db, user)
    except Exception:
        return []
    out = []
    if st["total"] and st["total"]["status"] != "ok":
        t = st["total"]
        out.append({"level": "danger" if t["status"] == "over" else "warn", "text": f"Presupuesto total del mes: llevas {t['pct']:.0f}% ({money_txt(t['spent'])} de {money_txt(t['amount'])}).", "link": "#/budgets"})
    for i in st["items"]:
        if i["status"] != "ok":
            out.append({"level": "danger" if i["status"] == "over" else "warn", "text": f"Presupuesto de «{i['name']}»: llevas {i['pct']:.0f}% ({money_txt(i['spent'])} de {money_txt(i['amount'])}).", "link": "#/budgets"})
    return out[:4]


# ---------------------------------------------------------------- análisis
def analysis(db, user, months=12):
    uid, cur = user["id"], user["currency"]
    today = today_for(user["timezone"])
    months = max(2, min(24, months))
    y, m = today.year, today.month
    keys = []
    for _ in range(months):
        keys.append((y, m))
        m -= 1
        if m < 1: m = 12; y -= 1
    keys.reverse()
    first = date(keys[0][0], keys[0][1], 1)
    rows = db.execute("""
        SELECT strftime('%Y-%m', t.date) AS k,
               COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount END),0) AS income,
               COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount WHEN t.type='refund' THEN -t.amount END),0) AS expense
        FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE t.user_id=? AND t.date>=? AND a.currency=? AND t.type IN ('income','expense','refund') GROUP BY k""", (uid, first.isoformat(), cur)).fetchall()
    by = {r["k"]: r for r in rows}
    monthly = []
    for (yy, mm) in keys:
        k = f"{yy:04d}-{mm:02d}"
        inc, exp = (by[k]["income"], by[k]["expense"]) if k in by else (0, 0)
        monthly.append({"key": k, "income": inc, "expense": exp, "net": inc - exp, "savings_rate": round((inc - exp) * 100 / inc, 1) if inc > 0 else None})
    _, _, cs, ce = month_bounds(None, today)
    py, pm = (cs.year, cs.month - 1) if cs.month > 1 else (cs.year - 1, 12)
    ps, pe = date(py, pm, 1), date(py, pm, monthrange(py, pm)[1])
    cur_sp, prev_sp = category_spend(db, uid, cs, ce, cur), category_spend(db, uid, ps, pe, cur)
    names = cat_names(db, uid)
    cats = []
    for k in set(cur_sp) | set(prev_sp):
        c, p = max(0, cur_sp.get(k, 0)), max(0, prev_sp.get(k, 0))
        if c or p:
            cats.append({"category_id": k or None, "name": names.get(k, "Sin categoría") if k else "Sin categoría", "current": c, "previous": p, "delta": c - p,
                         "delta_pct": round((c - p) * 100 / p, 1) if p else None})
    cats.sort(key=lambda x: -max(x["current"], x["previous"]))
    top = db.execute("""SELECT t.id, t.date, t.amount, t.description, c.name AS category_name FROM transactions t JOIN accounts a ON a.id=t.account_id
        LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=? AND t.type='expense' AND t.date BETWEEN ? AND ? AND a.currency=?
        ORDER BY t.amount DESC LIMIT 5""", (uid, cs.isoformat(), ce.isoformat(), cur)).fetchall()
    dow = db.execute("""SELECT CAST(strftime('%w', t.date) AS INTEGER) AS d, SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END) AS total
        FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.user_id=? AND t.type IN ('expense','refund') AND t.date>=? AND a.currency=?
        GROUP BY d""", (uid, (today - timedelta(days=90)).isoformat(), cur)).fetchall()
    dmap = {r["d"]: max(0, r["total"]) for r in dow}
    names_dow = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
    spent = sum(v for v in cur_sp.values())
    dim = monthrange(cs.year, cs.month)[1]
    past = [x["expense"] for x in monthly[:-1] if x["expense"] > 0][-3:]
    with_data = [x for x in monthly if x["income"] or x["expense"]]
    out = {"currency": cur, "monthly": monthly, "categories": cats[:10], "top_expenses": [dict(r) for r in top],
           "weekday": [{"day": names_dow[i], "total": dmap.get(i, 0)} for i in (1, 2, 3, 4, 5, 6, 0)],
           "this_month": {"spent": spent, "day": today.day, "days": dim, "daily_avg": spent // max(1, today.day),
                          "projected": int(spent / max(1, today.day) * dim), "prev_avg": int(sum(past) / len(past)) if past else None},
           "totals": {"income": sum(x["income"] for x in monthly), "expense": sum(x["expense"] for x in monthly), "months_with_data": len(with_data),
                      "avg_savings_rate": (round(sum(x["net"] for x in with_data) * 100 / sum(x["income"] for x in with_data), 1)
                                           if sum(x["income"] for x in with_data) > 0 else None)}}
    out.update(analysis_extra(db, user, uid, cur, today, keys, monthly, cats, with_data))
    return out


# ---------------------------------------------------------------- análisis (patrimonio, metas, portafolio, salud, insights)
ASSET_TYPE_ES = {"stock": "Acciones", "etf": "ETF", "crypto": "Cripto", "bond": "Bonos", "fund": "Fondos", "gold": "Oro", "other": "Otros"}


def debts_remaining_as_of(db, uid, cur, d):
    """Deuda (capital) pendiente a una fecha: solo deudas que ya existían para entonces, restando lo abonado hasta esa fecha."""
    iso = d.isoformat()
    rows = db.execute("SELECT id, principal FROM debts WHERE user_id=? AND currency=? AND start_date<=?", (uid, cur, iso)).fetchall()
    total = 0
    for r in rows:
        paid = db.execute("SELECT COALESCE(SUM(principal_part),0) FROM debt_payments WHERE debt_id=? AND date<=?", (r["id"], iso)).fetchone()[0]
        total += max(0, r["principal"] - paid)
    return total


def net_worth_as_of(db, uid, cur, d, accounts):
    """Patrimonio (líquido + inversión, menos tarjetas y deudas) a una fecha. No incluye el valor de mercado
    del portafolio: solo se conoce la cotización actual, no la histórica, así que esa parte del patrimonio
    solo se refleja en el valor de hoy, nunca en la serie histórica."""
    liquid = sum(balance_as_of(db, uid, a["id"], d) for a in accounts if a["type"] in ledger.LIQUID_TYPES)
    invested = sum(balance_as_of(db, uid, a["id"], d) for a in accounts if a["type"] == "investment")
    card_debt = sum(max(0, -balance_as_of(db, uid, a["id"], d)) for a in accounts if a["type"] == "credit")
    debts_total = debts_remaining_as_of(db, uid, cur, d)
    return {"liquid": liquid, "invested": invested, "card_debt": card_debt, "debts_total": debts_total,
            "net_worth": liquid + invested - card_debt - debts_total}


def recurring_expenses(db, uid, cur, today):
    """Gastos que se repiten mes a mes con un monto parecido (suscripciones, servicios fijos, etc.),
    detectados en los últimos 4 meses: misma cuenta y descripción (sin números), en al menos 3 de esos
    meses, con una variación de monto de 15% o menos. Nunca se inventa: si no hay suficiente historial, no aparece nada."""
    y, m = today.year, today.month
    for _ in range(3):
        m -= 1
        if m < 1: m, y = 12, y - 1
    start = date(y, m, 1)
    rows = db.execute("""SELECT t.account_id, t.amount, t.date, t.description FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE t.user_id=? AND t.type='expense' AND t.date>=? AND a.currency=? ORDER BY t.date""", (uid, start.isoformat(), cur)).fetchall()
    groups = {}
    for r in rows:
        desc = re.sub(r"\s+", " ", re.sub(r"\d+", "", (r["description"] or "").strip().lower())).strip()
        if not desc:
            continue
        g = groups.setdefault((r["account_id"], desc), {"by_month": {}, "last_date": r["date"]})
        g["by_month"].setdefault(r["date"][:7], []).append(r["amount"])
        g["last_date"] = max(g["last_date"], r["date"])
    out = []
    for (acc, desc), g in groups.items():
        months = g["by_month"]
        if len(months) < 3:
            continue
        amounts = [sum(v) / len(v) for v in months.values()]
        avg = sum(amounts) / len(amounts)
        if avg <= 0 or any(abs(a - avg) / avg > 0.15 for a in amounts):
            continue
        out.append({"description": desc[:1].upper() + desc[1:], "account_id": acc, "months_seen": len(months),
                     "avg_amount": int(round(avg)), "last_date": g["last_date"]})
    out.sort(key=lambda x: -x["avg_amount"])
    return out[:15]


def invested_by_month(db, uid, cur, first):
    """Lo aportado al portafolio por mes (compras: importe + comisión), convertido a la moneda principal con
    el tipo de cambio guardado. Una compra en una moneda sin tipo de cambio no se suma (no se inventa)."""
    rows = db.execute("""SELECT strftime('%Y-%m', date) AS k, currency, SUM(gross + fee) AS s FROM holding_ops
        WHERE user_id=? AND kind='buy' AND date>=? GROUP BY k, currency""", (uid, first)).fetchall()
    rates = portfolio.fx_rates(db, cur, [r["currency"] for r in rows], fetch=False)
    out = {}
    for r in rows:
        if rates.get(r["currency"]):
            out[r["k"]] = out.get(r["k"], 0) + round(r["s"] * rates[r["currency"]])
    return out


SAVINGS_TYPES, INVEST_TYPES = ("savings",), ("investment",)


def flows_by_month(db, uid, cur, first, types):
    """Lo que metiste (neto) por mes a cuentas de esos tipos, en la moneda principal: transferencias que ENTRAN desde
    cuentas de otro tipo suman y las que SALEN hacia otro tipo restan. Entre cuentas del mismo tipo no cuenta
    (p. ej. pasar de GBM Smart Cash a GBM USD no es invertir más). Sin tipo de cambio guardado no se suma (no se inventa)."""
    rows = db.execute("""SELECT strftime('%Y-%m', t.date) AS k, t.amount, t.to_amount, a.type AS ft, a.currency AS fc, b.type AS tt, b.currency AS tc
        FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN accounts b ON b.id = t.to_account_id
        WHERE t.user_id=? AND t.type='transfer' AND t.date>=?""", (uid, first)).fetchall()
    rates = portfolio.fx_rates(db, cur, [r["fc"] for r in rows] + [r["tc"] for r in rows], fetch=False)
    out = {}
    for r in rows:
        into, outof = r["tt"] in types, r["ft"] in types
        if into == outof:
            continue
        v, c = ((r["to_amount"] if r["to_amount"] is not None else r["amount"]), r["tc"]) if into else (-r["amount"], r["fc"])
        if rates.get(c):
            out[r["k"]] = out.get(r["k"], 0) + round(v * rates[c])
    return out


def savings_and_assets(db, user):
    """Saldo de hoy en tus cuentas de ahorro y tus activos totales (cuentas sin tarjetas + valor del portafolio),
    en la moneda principal. Otras monedas se convierten con el tipo de cambio guardado (si no hay, no se suman)."""
    cur = user["currency"]
    accs = [a for a in ledger.list_accounts(db, user["id"], include_archived=False) if a["type"] != "credit"]
    rates = portfolio.fx_rates(db, cur, [a["currency"] for a in accs], fetch=False)
    val = lambda a: round(a["balance"] * rates[a["currency"]]) if rates.get(a["currency"]) else 0
    savings = sum(val(a) for a in accs if a["type"] in SAVINGS_TYPES)
    try:
        pf = portfolio.overview_all(db, user, fetch=False)["totals_all"]["market_value"] or 0
    except Exception:
        pf = 0
    has = any(a["type"] in SAVINGS_TYPES for a in accs)
    return {"has_savings_accounts": has, "savings_balance": savings, "assets_total": sum(max(0, val(a)) for a in accs) + pf}


def allocation_by_month(db, uid, cur, first):
    """(ahorro, inversión) por mes. Si tienes cuentas marcadas como «Cuenta de ahorro» / «Cuenta de inversión», salen de lo
    que les transferiste. Sin cuentas de ahorro, el ahorro es lo que sobra (ingresos − gastos − inversión);
    sin cuentas de inversión, la inversión son las compras del portafolio."""
    has = lambda types: db.execute(f"SELECT 1 FROM accounts WHERE user_id=? AND archived=0 AND type IN ({','.join('?' * len(types))}) LIMIT 1", (uid, *types)).fetchone()
    saved = flows_by_month(db, uid, cur, first, SAVINGS_TYPES) if has(SAVINGS_TYPES) else None
    invested = flows_by_month(db, uid, cur, first, INVEST_TYPES) if has(INVEST_TYPES) else invested_by_month(db, uid, cur, first)
    return saved, invested


def health_score(monthly, invested, saved=None):
    """Puntaje de salud financiera: qué tan cerca está tu distribución de ingresos de la objetivo
    (50% vida/gastos, 25% ahorro, 25% inversión; ver health.py). Contrato de /api/health-score:
    score_100, score_10, breakdown. Sin ingresos en ningún mes devuelve score None."""
    r = health_mod.from_monthly(monthly, invested, saved)
    if r is None:
        return {"score": None, "breakdown": None, "month": None}
    inc = next(x["income"] for x in reversed(monthly) if x["key"] == r["month"])
    return {"score": r["score_100"], "breakdown": r["breakdown"], "month": r["month"], "is_current_month": r["is_current_month"],
            "amounts": r["amounts"], "income": inc, "unassigned": inc - sum(r["amounts"].values()),
            "savings_source": "accounts" if saved is not None else "leftover"}


def build_insights(db, uid, cur, today, monthly, cats, goals_list):
    """Insights en lenguaje natural, generados solo a partir de lo que ya está calculado (nunca texto fijo):
    cambio de gasto vs. mes anterior (con la categoría que más influyó), tendencia del ahorro promedio,
    proporción gasto/ingreso vs. tu propio promedio, y tiempo estimado para alcanzar tu meta más cercana
    según tu ritmo de aportes reciente. Si no hay suficientes datos para un cálculo confiable, ese insight
    simplemente no aparece."""
    out = []
    with_data = [x for x in monthly if x["income"] or x["expense"]]
    if len(with_data) >= 2 and with_data[-2]["expense"] > 0:
        cur_m, prev_m = with_data[-1], with_data[-2]
        delta_pct = round((cur_m["expense"] - prev_m["expense"]) * 100 / prev_m["expense"], 1)
        if abs(delta_pct) >= 8:
            pool = [c for c in cats if c["delta"] > 0] if delta_pct > 0 else [c for c in cats if c["delta"] < 0]
            drivers = sorted(pool, key=lambda c: -abs(c["delta"]))[:2]
            verb = "aumentaron" if delta_pct > 0 else "bajaron"
            text = f"Este mes tus gastos {verb} {abs(delta_pct):.0f}% respecto al mes anterior"
            text += f", principalmente por {' y '.join(d['name'] for d in drivers)}." if drivers else "."
            out.append({"kind": "insight", "icon": "💡", "title": "Insight", "text": text})
    if len(with_data) >= 4:
        half = len(with_data) // 2
        first, second = with_data[:half], with_data[half:]
        avg1, avg2 = sum(x["net"] for x in first) / len(first), sum(x["net"] for x in second) / len(second)
        if abs(avg2 - avg1) >= max(100, abs(avg1) * 0.05):
            out.append({"kind": "trend", "icon": "📈", "title": "Tendencia",
                         "text": f"Tu ahorro mensual promedio pasó de {money_txt(int(avg1))} a {money_txt(int(avg2))} en los últimos {len(with_data)} meses."})
    if with_data and with_data[-1]["income"] > 0:
        cur_m = with_data[-1]
        ratio = cur_m["expense"] * 100 / cur_m["income"]
        others = [x for x in with_data[:-1] if x["income"] > 0]
        if others:
            avg_ratio = sum(x["expense"] * 100 / x["income"] for x in others) / len(others)
            if ratio - avg_ratio >= 8:
                out.append({"kind": "warning", "icon": "⚠️", "title": "Atención",
                             "text": f"Tus gastos representan {ratio:.0f}% de tus ingresos este mes, {ratio - avg_ratio:.0f} puntos por encima de tu promedio."})
    best = None
    for g in goals_list:
        if g["done"] or g["remaining"] <= 0:
            continue
        y, m = today.year, today.month
        for _ in range(2):
            m -= 1
            if m < 1: m, y = 12, y - 1
        start3 = date(y, m, 1)
        paced = db.execute("SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=? AND date>=?", (g["id"], start3.isoformat())).fetchone()[0]
        pace = paced / max(1, (today - start3).days / 30.4)
        if pace > 0:
            months_needed = g["remaining"] / pace
            if best is None or months_needed < best[1]:
                best = (g, months_needed)
    if best:
        g, months_needed = best
        out.append({"kind": "goal", "icon": "🎯", "title": "Meta",
                     "text": f"Si mantienes tu ritmo actual de aportes, alcanzarías «{g['name']}» en aproximadamente {max(1, round(months_needed))} meses."})
    return out


def analysis_extra(db, user, uid, cur, today, keys, monthly, cats, with_data):
    """Todo lo adicional del módulo de Análisis (valores principales, gráficas y herramientas), como claves
    nuevas y aditivas: nunca se tocan ni se recalculan las claves que ya existían antes de esta función."""
    accounts = ledger.list_accounts(db, uid, include_archived=False)
    rates = portfolio.fx_rates(db, cur, [a["currency"] for a in accounts], fetch=False)
    main_accounts = [{**a, "balance": round(a["balance"] * rates[a["currency"]])} for a in accounts if rates.get(a["currency"])]
    liquid_now = sum(a["balance"] for a in main_accounts if a["type"] in ledger.LIQUID_TYPES)
    invested_now = sum(a["balance"] for a in main_accounts if a["type"] == "investment")
    other_now = sum(a["balance"] for a in main_accounts if a["type"] == "other")          # p. ej. dinero que te deben
    card_debt_now = sum(max(0, -a["balance"]) for a in main_accounts if a["type"] == "credit")
    debts_total_now = ledger.debts_remaining(db, uid, cur)
    pf = portfolio.summary(db, user)
    pf_value = portfolio.value_in_main(db, user, fetch=False)
    net_worth_now = liquid_now + invested_now + other_now + pf_value - card_debt_now - debts_total_now

    avg_income = (sum(x["income"] for x in with_data) / len(with_data)) if with_data else 0
    avg_expense = (sum(x["expense"] for x in with_data) / len(with_data)) if with_data else 0
    avg_net = (sum(x["net"] for x in with_data) / len(with_data)) if with_data else 0
    cur_m = monthly[-1]

    debt_rows = db.execute("SELECT * FROM debts WHERE user_id=? AND currency=? AND archived=0", (uid, cur)).fetchall()
    debt_monthly_payment = sum(r["monthly_payment"] for r in debt_rows if debt_row(db, r, today)["remaining"] > 0)
    debt_to_income = round(debt_monthly_payment * 100 / avg_income, 1) if avg_income > 0 else None
    emergency_fund_months = round(liquid_now / avg_expense, 1) if avg_expense > 0 else None
    deficit = avg_expense - avg_income
    runway_months = round((liquid_now + invested_now + pf_value) / deficit, 1) if deficit > 0 else None

    overview = {
        "net_worth": net_worth_now, "available": liquid_now, "income": cur_m["income"], "expense": cur_m["expense"],
        "savings": cur_m["net"], "savings_rate": cur_m["savings_rate"],
        "debt_total": card_debt_now + debts_total_now, "card_debt": card_debt_now, "debts_total": debts_total_now,
        "debt_to_income": debt_to_income, "emergency_fund_months": emergency_fund_months,
        "burn_rate": int(round(avg_expense)), "runway_months": runway_months,
        "investment_return_pct": pf["totals"]["unrealized_pct"], "portfolio_value": pf_value,
    }

    savings_evolution, cum = [], 0
    for x in monthly:
        cum += x["net"]
        savings_evolution.append({"key": x["key"], "cumulative": cum})

    networth_evolution, debt_evolution = [], []
    for (yy, mm), x in zip(keys, monthly):
        d = min(date(yy, mm, monthrange(yy, mm)[1]), today)
        nw = net_worth_as_of(db, uid, cur, d, accounts)
        networth_evolution.append({"key": x["key"], "net_worth": nw["net_worth"], "liquid": nw["liquid"], "invested": nw["invested"]})
        debt_evolution.append({"key": x["key"], "card_debt": nw["card_debt"], "debts_total": nw["debts_total"], "total": nw["card_debt"] + nw["debts_total"]})

    asset_allocation = [{"name": "Efectivo y ahorro", "value": liquid_now}, {"name": "Cuentas de inversión (sin invertir)", "value": invested_now}]
    by_type = {}
    for it in pf["positions"]:
        if it["currency"] == cur and it["market_value"]:
            by_type[it["asset_type"]] = by_type.get(it["asset_type"], 0) + it["market_value"]
    for k, v in by_type.items():
        asset_allocation.append({"name": ASSET_TYPE_ES.get(k, k), "value": v})
    asset_allocation = [a for a in asset_allocation if a["value"] > 0]

    try:
        budget = budget_status(db, user)
    except Exception:
        budget = None
    budget_ok_pct = (sum(1 for i in budget["items"] if i["status"] == "ok") * 100 / len(budget["items"])) if budget and budget["items"] else None

    today_goals = db.execute("SELECT * FROM goals WHERE user_id=? AND archived=0 AND currency=? ORDER BY name COLLATE NOCASE", (uid, cur)).fetchall()
    goals_list = [goal_row(db, g, today) for g in today_goals]

    projection = [{"months_ahead": n, "projected": int(net_worth_now + avg_net * n)} for n in (3, 6, 12, 24)]

    recurring = recurring_expenses(db, uid, cur, today)
    saved_m, invested_m = allocation_by_month(db, uid, cur, f"{monthly[0]['key']}-01")
    health = health_score(monthly, invested_m, saved_m)
    insights = build_insights(db, uid, cur, today, monthly, cats, goals_list)

    return {
        "overview": overview,
        "savings_evolution": savings_evolution, "networth_evolution": networth_evolution, "debt_evolution": debt_evolution,
        "asset_allocation": asset_allocation,
        "budget": budget,
        "goals": goals_list,
        "portfolio": {"currency": pf["currency"], "totals": pf["totals"], "positions": pf["positions"]},
        "projection": {"avg_monthly_net": int(round(avg_net)), "points": projection},
        "recurring": recurring,
        "health": health,
        "insights": insights,
    }


# ---------------------------------------------------------------- reportes
def build_report(db, user, s, e):
    uid, cur = user["id"], user["currency"]
    inc, exp = ledger.sum_period(db, uid, s, e, cur)
    names = cat_names(db, uid)
    spend = category_spend(db, uid, s, e, cur)
    by_exp = sorted(([names.get(k, "Sin categoría") if k else "Sin categoría", v] for k, v in spend.items() if v > 0), key=lambda x: -x[1])
    irows = db.execute("""SELECT COALESCE(c.name,'Sin categoría') AS name, SUM(t.amount) AS total FROM transactions t JOIN accounts a ON a.id=t.account_id
        LEFT JOIN categories c ON c.id=t.category_id WHERE t.user_id=? AND t.type='income' AND t.date BETWEEN ? AND ? AND a.currency=? GROUP BY c.id ORDER BY total DESC""",
                       (uid, s.isoformat(), e.isoformat(), cur)).fetchall()
    txs, total, _, _ = ledger.query_transactions(db, uid, {"from": s.isoformat(), "to": e.isoformat(), "sort": "date", "dir": "asc"}, paginate=False)
    accs = [a for a in ledger.list_accounts(db, uid, include_archived=False)]
    return {"from": s.isoformat(), "to": e.isoformat(), "currency": cur, "income": inc, "expense": exp, "net": inc - exp,
            "savings_rate": round((inc - exp) * 100 / inc, 1) if inc > 0 else None,
            "expense_by_category": [{"name": n, "total": v, "pct": round(v * 100 / exp, 1) if exp > 0 else 0} for n, v in by_exp],
            "income_by_category": [{"name": r["name"], "total": r["total"]} for r in irows],
            "accounts": [{"name": a["name"], "type": a["type"], "currency": a["currency"], "balance": a["balance"]} for a in accs],
            "transactions": txs, "transaction_count": total}


TYPE_ES = {"expense": "Gasto", "income": "Ingreso", "transfer": "Transferencia", "refund": "Reembolso", "adjustment": "Ajuste"}


def csv_safe(v):
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def report_csv(rep):
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Fecha", "Tipo", "Descripción", "Categoría", "Cuenta", "Cuenta destino", "Importe"])
    for t in rep["transactions"]:
        w.writerow([t["date"], TYPE_ES.get(t["type"], t["type"]), csv_safe(t["description"]), csv_safe(t.get("category_name")), csv_safe(t["account_name"]),
                    csv_safe(t.get("to_account_name")), f"{t['amount'] / 100:.2f}"])
    return "﻿" + out.getvalue()


def report_pdf(rep, user, budgets=None):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=1.8 * cm, rightMargin=1.8 * cm, topMargin=1.6 * cm, bottomMargin=1.6 * cm, title="Reporte FIPO")
    st = getSampleStyleSheet()
    olive = colors.HexColor("#556B2F")
    st["Title"].textColor = olive
    def esc(x):
        return str(x).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    def table(data, widths, right_cols=(), header=True):
        t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
        style = [("FONTSIZE", (0, 0), (-1, -1), 8.5), ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#D7E0C3")),
                 ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F7F2")]), ("VALIGN", (0, 0), (-1, -1), "TOP")]
        if header:
            style += [("BACKGROUND", (0, 0), (-1, 0), olive), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")]
        for c in right_cols:
            style.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
        t.setStyle(TableStyle(style))
        return t
    el = [Paragraph("FIPO · Reporte financiero", st["Title"]),
          Paragraph(f"{esc(user['name'])} · Periodo {rep['from']} a {rep['to']} · Moneda {rep['currency']}", st["Normal"]), Spacer(1, 10)]
    sr = f"{rep['savings_rate']}%" if rep["savings_rate"] is not None else "—"
    el += [table([["Ingresos", "Gastos", "Balance neto", "Tasa de ahorro"], [money_txt(rep["income"]), money_txt(rep["expense"]), money_txt(rep["net"]), sr]], [4.2 * cm] * 4), Spacer(1, 12)]
    if rep["expense_by_category"]:
        el += [Paragraph("Gastos por categoría", st["Heading3"]), table([["Categoría", "Total", "%"]] + [[esc(c["name"]), money_txt(c["total"]), f"{c['pct']}%"] for c in rep["expense_by_category"]],
                                                                     [9 * cm, 4 * cm, 3 * cm], right_cols=(1, 2)), Spacer(1, 10)]
    if rep["income_by_category"]:
        el += [Paragraph("Ingresos por categoría", st["Heading3"]), table([["Categoría", "Total"]] + [[esc(c["name"]), money_txt(c["total"])] for c in rep["income_by_category"]], [9 * cm, 4 * cm], right_cols=(1,)), Spacer(1, 10)]
    if budgets and (budgets["items"] or budgets["total"]):
        rowsb = ([budgets["total"]] if budgets["total"] else []) + budgets["items"]
        el += [Paragraph(f"Presupuestos de {budgets['month']}", st["Heading3"]),
               table([["Presupuesto", "Límite", "Gastado", "%"]] + [[esc(b["name"]), money_txt(b["amount"]), money_txt(b["spent"]), f"{b['pct']:.0f}%"] for b in rowsb], [7 * cm, 3.5 * cm, 3.5 * cm, 2 * cm], right_cols=(1, 2, 3)), Spacer(1, 10)]
    el += [Paragraph("Saldos actuales de cuentas", st["Heading3"]), table([["Cuenta", "Tipo", "Moneda", "Saldo"]] + [[esc(a["name"]), a["type"], a["currency"], money_txt(a["balance"])] for a in rep["accounts"]],
                                                                       [7 * cm, 3 * cm, 2 * cm, 4 * cm], right_cols=(3,)), Spacer(1, 10)]
    txs = rep["transactions"][:300]
    el += [Paragraph(f"Movimientos ({rep['transaction_count']})", st["Heading3"]),
           table([["Fecha", "Tipo", "Descripción", "Cuenta", "Importe"]] + [[t["date"], TYPE_ES.get(t["type"], t["type"]), esc((t["description"] or t.get("category_name") or "")[:40]),
                                                                          esc(t["account_name"][:22]), money_txt(t["amount"])] for t in txs], [2.1 * cm, 2.4 * cm, 6.2 * cm, 3.6 * cm, 2.9 * cm], right_cols=(4,))]
    if rep["transaction_count"] > len(txs):
        el.append(Paragraph(f"Se muestran los primeros {len(txs)} movimientos; descarga el CSV para verlos todos.", st["Italic"]))
    doc.build(el)
    return buf.getvalue()


# ---------------------------------------------------------------- metas
def goal_row(db, g, today):
    saved = db.execute("SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=?", (g["id"],)).fetchone()[0]
    out = {"id": g["id"], "name": g["name"], "target": g["target"], "target_date": g["target_date"], "currency": g["currency"], "notes": g["notes"],
           "archived": bool(g["archived"]), "saved": saved, "remaining": max(0, g["target"] - saved), "pct": round(min(100, saved * 100 / g["target"]), 1) if g["target"] else 0,
           "done": saved >= g["target"], "days_left": None, "needed_per_month": None}
    if g["target_date"] and not out["done"]:
        td = date.fromisoformat(g["target_date"])
        out["days_left"] = (td - today).days
        if td > today:
            months = max(1, round((td - today).days / 30.4))
            out["needed_per_month"] = -(-out["remaining"] // months)
    return out


# ---------------------------------------------------------------- tablas personalizadas
COL_TYPES = ("text", "number", "money", "date", "check")


def clean_columns(cols, existing=None, used_cols=None):
    if not isinstance(cols, list) or not cols:
        raise ValidationError("Agrega al menos una columna.", "columns")
    if len(cols) > 30:
        raise ValidationError("Máximo 30 columnas.", "columns")
    old = {c["id"]: c for c in (existing or [])}
    out, names, n = [], set(), max([int(c["id"][1:]) for c in (existing or [])] + [0])
    for c in cols:
        if not isinstance(c, dict):
            raise ValidationError("Columna no válida.", "columns")
        name, typ = clean_text(c.get("name"), "columns", 60, required=True), c.get("type", "text")
        if typ not in COL_TYPES:
            raise ValidationError("Tipo de columna no válido.", "columns")
        if name.lower() in names:
            raise ValidationError(f"Hay dos columnas llamadas «{name}».", "columns")
        names.add(name.lower())
        cid = c.get("id")
        if cid in old:
            if old[cid]["type"] != typ and used_cols and cid in used_cols:
                raise ValidationError(f"«{old[cid]['name']}» ya tiene datos; para cambiar su tipo crea una columna nueva.", "columns")
        else:
            n += 1
            cid = f"c{n}"
        out.append({"id": cid, "name": name, "type": typ})
    return out


def clean_cell(v, typ, name):
    if v is None or v == "":
        return None
    if typ == "check":
        return bool(v) and v not in ("false", "0", "no")
    if typ == "date":
        return parse_date(v, name)
    if typ in ("number", "money"):
        s = str(v).replace(",", "").replace("$", "").strip()
        try:
            d = Decimal(s)
        except InvalidOperation:
            raise ValidationError(f"«{name}» debe ser un número.", name)
        if not d.is_finite() or abs(d) > Decimal("1e12"):
            raise ValidationError(f"«{name}»: número fuera de rango.", name)
        return format(d.quantize(Decimal("0.01")) if typ == "money" else d.normalize(), "f")
    return clean_text(str(v), name, 500)


def table_payload(db, uid, t):
    cols = json.loads(t["columns"])
    rows = [{"id": r["id"], "data": json.loads(r["data"])} for r in db.execute("SELECT * FROM custom_rows WHERE table_id=? AND user_id=? ORDER BY position, id", (t["id"], uid))]
    totals = {}
    for c in cols:
        if c["type"] in ("number", "money"):
            totals[c["id"]] = format(sum((Decimal(r["data"][c["id"]]) for r in rows if r["data"].get(c["id"]) not in (None, "")), Decimal(0)), "f")
        elif c["type"] == "check":
            totals[c["id"]] = sum(1 for r in rows if r["data"].get(c["id"]))
    return {"id": t["id"], "name": t["name"], "columns": cols, "rows": rows, "totals": totals}


# ---------------------------------------------------------------- comprobantes / OCR
ALLOWED_IMG = {"JPEG": ("image/jpeg", ".jpg"), "PNG": ("image/png", ".png"), "WEBP": ("image/webp", ".webp")}


def ocr_available():
    return shutil.which("tesseract") is not None


def ocr_langs():
    try:
        out = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10).stdout.split()
    except Exception:
        return "eng"
    return "spa+eng" if "spa" in out else "eng"


def run_ocr(path):
    """Devuelve (texto, error). Preprocesa la imagen para mejorar la lectura de tickets."""
    if not ocr_available():
        return "", "El motor de lectura (Tesseract) no está instalado en el servidor. Puedes capturar el movimiento a mano."
    from PIL import Image, ImageOps
    tmp = tempfile.mkdtemp()
    try:
        im = Image.open(path)
        im = ImageOps.exif_transpose(im).convert("L")
        if max(im.size) < 1600:
            f = 1600 / max(im.size)
            im = im.resize((int(im.width * f), int(im.height * f)))
        im = ImageOps.autocontrast(im)
        p = os.path.join(tmp, "in.png")
        im.save(p)
        r = subprocess.run(["tesseract", p, "stdout", "-l", ocr_langs(), "--psm", "6"], capture_output=True, text=True, timeout=40)
        return r.stdout.strip()[:20000], ("" if r.returncode == 0 else "No se pudo leer el texto de la imagen.")
    except subprocess.TimeoutExpired:
        return "", "La lectura tardó demasiado. Prueba con una foto más pequeña o más clara."
    except Exception:
        return "", "No se pudo leer el texto de la imagen."
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


AMOUNT_RE = re.compile(r"(?<![\d.,])\$?\s*(\d{1,3}(?:[,\s]\d{3})*|\d+)[.,](\d{2})(?![\d])")
MONTHS = {"ene": 1, "jan": 1, "feb": 2, "mar": 3, "abr": 4, "apr": 4, "may": 5, "jun": 6, "jul": 7, "ago": 8, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dic": 12, "dec": 12}


def parse_receipt(text, today):
    """Sugerencias (monto, fecha, comercio) a partir del texto OCR. Son sugerencias: el usuario confirma."""
    sug = {"amount": None, "date": None, "merchant": ""}
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    def amounts(line):
        out = []
        for m in AMOUNT_RE.finditer(line):
            whole = re.sub(r"[,\s]", "", m.group(1))
            out.append(int(whole) * 100 + int(m.group(2)))
        return out
    key = re.compile(r"\b(total|importe|a pagar|monto|amount due|total a pagar|grand total)\b", re.I)
    sub = re.compile(r"sub\s*-?\s*total|iva|tax|cambio|change|propina", re.I)
    cands = [a for l in lines if key.search(l) and not sub.search(l) for a in amounts(l)]
    if cands:
        sug["amount"] = max(cands)
    else:
        allv = [a for l in lines for a in amounts(l)]
        if allv:
            sug["amount"] = max(allv)
    for l in lines:
        m = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", l)
        if m:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        else:
            m = re.search(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})", l)
            if m:
                d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
                y += 2000 if y < 100 else 0
                if mo > 12 >= d:
                    d, mo = mo, d
            else:
                m = re.search(r"(\d{1,2})\s*(?:de\s+)?([A-Za-z]{3,4})[a-z]*\.?\s*(?:de\s+)?(\d{2,4})", l)
                if not (m and m.group(2).lower()[:3] in MONTHS or (m and m.group(2).lower() in MONTHS)):
                    continue
                d, mo, y = int(m.group(1)), MONTHS.get(m.group(2).lower(), MONTHS.get(m.group(2).lower()[:3])), int(m.group(3))
                y += 2000 if y < 100 else 0
        try:
            dd = date(y, mo, d)
        except (ValueError, TypeError):
            continue
        if date(2000, 1, 1) <= dd <= today + timedelta(days=1):
            sug["date"] = dd.isoformat()
            break
    for l in lines[:6]:
        letters = sum(c.isalpha() for c in l)
        if letters >= 3 and letters >= len(l) * 0.5 and not re.search(r"\b(rfc|factura|ticket|folio|fecha)\b", l, re.I):
            sug["merchant"] = l[:60]
            break
    return sug


def receipt_dict(r):
    return {"id": r["id"], "tx_id": r["tx_id"], "filename": r["filename"], "mime": r["mime"], "size": r["size"], "created_at": r["created_at"], "has_text": bool(r["ocr_text"])}


# ================================================================ rutas
def register(app, login_required, current_user, json_body, api_error):
    def me():
        return current_user()

    # ---------- tarjetas
    @app.get("/api/cards")
    @login_required
    def cards_list():
        u, db = me(), get_db()
        bal = ledger.balances(db, u["id"])
        cards = [card_row(db, u, a, bal[a["id"]]) for a in db.execute("SELECT * FROM accounts WHERE user_id=? AND type='credit' ORDER BY archived, name COLLATE NOCASE", (u["id"],))]
        act = [c for c in cards if not c["archived"] and c["currency"] == u["currency"]]
        return jsonify({"cards": cards, "currency": u["currency"], "totals": {"used": sum(c["used"] for c in act), "limit": sum(c["limit"] for c in act),
                                                                       "pending": sum((c["statement"] or {}).get("pending", 0) for c in act)}})

    @app.post("/api/cards/<int:aid>/pay")
    @login_required
    def card_pay(aid):
        u, d, db = me(), json_body(), get_db()
        card = owned(db, "accounts", aid, u["id"])
        if not card or card["type"] != "credit":
            raise ValidationError("Tarjeta no encontrada.", status=404)
        src = owned(db, "accounts", d.get("from_account_id"), u["id"])
        if not src or src["type"] == "credit":
            raise ValidationError("Elige la cuenta desde la que pagas.", "from_account_id")
        if src["currency"] != card["currency"]:
            raise ValidationError(f"La tarjeta está en {card['currency']} y la cuenta en {src['currency']}. Registra la transferencia manualmente indicando el importe recibido.", "from_account_id")
        amt = to_cents(d.get("amount"), "amount")
        with atomic(db):
            tid = ledger.insert_tx(db, u["id"], {"type": "transfer", "amount": f"{amt // 100}.{amt % 100:02d}", "date": d.get("date") or today_for(u["timezone"]).isoformat(),
                                                  "account_id": src["id"], "to_account_id": card["id"], "description": f"Pago de tarjeta {card['name']}"})
        return jsonify({"ok": True, "transaction_id": tid}), 201

    # ---------- deudas
    @app.get("/api/debts")
    @login_required
    def debts_list():
        u, db = me(), get_db()
        today = today_for(u["timezone"])
        rows = [debt_row(db, r, today) for r in db.execute("SELECT * FROM debts WHERE user_id=? ORDER BY archived, name COLLATE NOCASE", (u["id"],))]
        act = [r for r in rows if not r["archived"] and r["currency"] == u["currency"]]
        return jsonify({"debts": rows, "currency": u["currency"], "totals": {"remaining": sum(r["remaining"] for r in act), "monthly": sum(r["monthly_payment"] for r in act if r["remaining"] > 0),
                                                                        "paid_interest": sum(r["paid_interest"] for r in rows if r["currency"] == u["currency"])}})

    def debt_fields(d, u, cur_row=None):
        cur = d.get("currency", cur_row["currency"] if cur_row else u["currency"])
        if cur not in ledger.CURRENCIES:
            raise ValidationError("Moneda no compatible.", "currency")
        try:
            rate = float(d.get("interest_rate", cur_row["interest_rate"] if cur_row else 0) or 0)
        except (TypeError, ValueError):
            raise ValidationError("La tasa debe ser un número.", "interest_rate")
        if not 0 <= rate <= 1000:
            raise ValidationError("La tasa debe estar entre 0 y 1000.", "interest_rate")
        try:
            due = int(d.get("due_day", cur_row["due_day"] if cur_row else 0) or 0)
        except (TypeError, ValueError):
            raise ValidationError("Indica un día entre 1 y 31.", "due_day")
        if not 0 <= due <= 31:
            raise ValidationError("Indica un día entre 1 y 31.", "due_day")
        return {"name": clean_text(d.get("name", cur_row["name"] if cur_row else None), "name", 80, required=True),
                "creditor": clean_text(d.get("creditor", cur_row["creditor"] if cur_row else ""), "creditor", 80),
                "currency": cur, "principal": to_cents(d.get("principal", (cur_row["principal"] / 100) if cur_row else None), "principal"),
                "interest_rate": rate, "start_date": parse_date(d.get("start_date", cur_row["start_date"] if cur_row else today_for(u["timezone"]).isoformat()), "start_date"),
                "monthly_payment": to_cents(d.get("monthly_payment", (cur_row["monthly_payment"] / 100) if cur_row else 0) or 0, "monthly_payment", allow_zero=True),
                "due_day": due, "notes": clean_text(d.get("notes", cur_row["notes"] if cur_row else ""), "notes", 500)}

    @app.post("/api/debts")
    @login_required
    def debts_create():
        u, d, db = me(), json_body(), get_db()
        f = debt_fields(d, u)
        with atomic(db):
            did = db.execute("INSERT INTO debts (user_id,name,creditor,currency,principal,interest_rate,start_date,monthly_payment,due_day,notes) VALUES (?,?,?,?,?,?,?,?,?,?)",
                             (u["id"], f["name"], f["creditor"], f["currency"], f["principal"], f["interest_rate"], f["start_date"], f["monthly_payment"], f["due_day"], f["notes"])).lastrowid
        return jsonify({"debt": debt_row(db, db.execute("SELECT * FROM debts WHERE id=?", (did,)).fetchone(), today_for(u["timezone"]))}), 201

    @app.get("/api/debts/<int:did>")
    @login_required
    def debts_get(did):
        u, db = me(), get_db()
        d = owned(db, "debts", did, u["id"])
        if not d:
            raise ValidationError("Deuda no encontrada.", status=404)
        pays = [dict(p) | {"total": p["principal_part"] + p["interest_part"]} for p in db.execute("SELECT p.*, a.name AS account_name FROM debt_payments p LEFT JOIN accounts a ON a.id=p.account_id WHERE p.debt_id=? ORDER BY p.date DESC, p.id DESC", (did,))]
        return jsonify({"debt": debt_row(db, d, today_for(u["timezone"])), "payments": pays})

    @app.patch("/api/debts/<int:did>")
    @login_required
    def debts_update(did):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            row = owned(db, "debts", did, u["id"])
            if not row:
                raise ValidationError("Deuda no encontrada.", status=404)
            f = debt_fields(d, u, row)
            if f["currency"] != row["currency"] and db.execute("SELECT 1 FROM debt_payments WHERE debt_id=?", (did,)).fetchone():
                raise ValidationError("No puedes cambiar la moneda de una deuda con pagos.", "currency")
            paid = db.execute("SELECT COALESCE(SUM(principal_part),0) FROM debt_payments WHERE debt_id=?", (did,)).fetchone()[0]
            if f["principal"] < paid:
                raise ValidationError("El monto original no puede ser menor a lo que ya has abonado al capital.", "principal")
            db.execute("UPDATE debts SET name=?,creditor=?,currency=?,principal=?,interest_rate=?,start_date=?,monthly_payment=?,due_day=?,notes=?,archived=? WHERE id=? AND user_id=?",
                       (f["name"], f["creditor"], f["currency"], f["principal"], f["interest_rate"], f["start_date"], f["monthly_payment"], f["due_day"], f["notes"],
                        1 if d.get("archived", row["archived"]) else 0, did, u["id"]))
        return jsonify({"debt": debt_row(db, db.execute("SELECT * FROM debts WHERE id=?", (did,)).fetchone(), today_for(u["timezone"]))})

    @app.delete("/api/debts/<int:did>")
    @login_required
    def debts_delete(did):
        u, db = me(), get_db()
        with atomic(db):
            if not owned(db, "debts", did, u["id"]):
                raise ValidationError("Deuda no encontrada.", status=404)
            if db.execute("SELECT 1 FROM debt_payments WHERE debt_id=?", (did,)).fetchone():
                raise ValidationError("La deuda tiene pagos registrados. Archívala en lugar de eliminarla, o elimina primero sus pagos.", status=409)
            db.execute("DELETE FROM debts WHERE id=? AND user_id=?", (did, u["id"]))
        return jsonify({"ok": True})

    @app.post("/api/debts/<int:did>/payments")
    @login_required
    def debt_pay(did):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            debt = owned(db, "debts", did, u["id"])
            if not debt:
                raise ValidationError("Deuda no encontrada.", status=404)
            total = to_cents(d.get("amount"), "amount")
            interest = to_cents(d.get("interest") or 0, "interest", allow_zero=True)
            if interest > total:
                raise ValidationError("Los intereses no pueden ser mayores que el pago.", "interest")
            principal_part = total - interest
            remaining = debt_row(db, debt, today_for(u["timezone"]))["remaining"]
            if principal_part > remaining:
                raise ValidationError(f"Ese pago abona {money_txt(principal_part)} al capital y solo quedan {money_txt(remaining)}. Si el resto son intereses, indícalo en «de los cuales intereses».", "amount")
            acc = validate_pay_account(db, u["id"], d.get("account_id"), debt["currency"])
            pid = db.execute("INSERT INTO debt_payments (user_id,debt_id,date,principal_part,interest_part,account_id,notes) VALUES (?,?,?,?,?,?,?)",
                             (u["id"], did, parse_date(d.get("date") or today_for(u["timezone"]).isoformat(), "date"), principal_part, interest, acc,
                              clean_text(d.get("notes"), "notes", 300))).lastrowid
        return jsonify({"ok": True, "payment_id": pid}), 201

    @app.delete("/api/debts/payments/<int:pid>")
    @login_required
    def debt_pay_delete(pid):
        u, db = me(), get_db()
        with atomic(db):
            if db.execute("DELETE FROM debt_payments WHERE id=? AND user_id=?", (pid, u["id"])).rowcount == 0:
                raise ValidationError("Pago no encontrado.", status=404)
        return jsonify({"ok": True})

    # ---------- presupuestos
    @app.get("/api/budgets")
    @login_required
    def budgets_get():
        return jsonify(budget_status(get_db(), me(), request.args.get("month")))

    @app.put("/api/budgets")
    @login_required
    def budgets_put():
        u, d, db = me(), json_body(), get_db()
        try:
            cid = int(d.get("category_id") or 0)
        except (TypeError, ValueError):
            raise ValidationError("Categoría no válida.", "category_id")
        amount = to_cents(d.get("amount"), "amount")
        with atomic(db):
            if cid:
                c = owned(db, "categories", cid, u["id"])
                if not c or c["kind"] != "expense":
                    raise ValidationError("Elige una categoría de gasto.", "category_id")
                if c["parent_id"]:
                    raise ValidationError("Los presupuestos se definen en la categoría principal; sus subcategorías se suman a ella.", "category_id")
            db.execute("INSERT INTO budgets (user_id, category_id, amount) VALUES (?,?,?) ON CONFLICT(user_id, category_id) DO UPDATE SET amount=excluded.amount", (u["id"], cid, amount))
        return jsonify(budget_status(db, u, d.get("month")))

    @app.delete("/api/budgets/<int:cid>")
    @login_required
    def budgets_delete(cid):
        u, db = me(), get_db()
        with atomic(db):
            if db.execute("DELETE FROM budgets WHERE user_id=? AND category_id=?", (u["id"], cid)).rowcount == 0:
                raise ValidationError("Presupuesto no encontrado.", status=404)
        return jsonify({"ok": True})

    # ---------- análisis y reportes
    @app.get("/api/analysis")
    @login_required
    def analysis_get():
        try:
            months = int(request.args.get("months", 12))
        except ValueError:
            raise ValidationError("Número de meses no válido.")
        return jsonify(analysis(get_db(), me(), months))

    @app.get("/api/health-score")
    @login_required
    def health_score_get():
        """El mismo puntaje de 'Salud financiera' que se ve en Análisis (0-100), reescalado a 1-10 con un
        decimal para mostrarlo en Inicio. Reusa analysis() tal cual para que nunca se desincronicen los dos
        lugares. La fórmula (distribución objetivo 50/25/25
        con puntos extra) vive en health.py."""
        h = analysis(get_db(), me(), 12)["health"]
        sa = savings_and_assets(get_db(), me())
        return jsonify({**sa, "score_100": h["score"], "score_10": None if h["score"] is None else round(h["score"] / 10, 1),
                        "breakdown": h["breakdown"], "month": h["month"], "amounts": h.get("amounts"), "income": h.get("income"),
                        "unassigned": h.get("unassigned"), "savings_source": h.get("savings_source"),
                        "is_current_month": h.get("is_current_month")})

    @app.get("/api/report")
    @login_required
    def report_get():
        u, db = me(), get_db()
        today = today_for(u["timezone"])
        if request.args.get("from") or request.args.get("to"):
            s, e = date.fromisoformat(parse_date(request.args.get("from"), "from")), date.fromisoformat(parse_date(request.args.get("to"), "to"))
            if e < s:
                raise ValidationError("La fecha final es anterior a la inicial.", "to")
            if (e - s).days > 800:
                raise ValidationError("El rango máximo de un reporte es de aproximadamente 2 años.", "to")
        else:
            _, _, s, e = month_bounds(request.args.get("month"), today)
        rep = build_report(db, u, s, e)
        fmt = request.args.get("format", "json")
        stem = f"fipo-reporte-{s.isoformat()}_{e.isoformat()}"
        if fmt == "csv":
            return Response(report_csv(rep), mimetype="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{stem}.csv"'})
        if fmt == "pdf":
            bud = budget_status(db, u, f"{s.year:04d}-{s.month:02d}") if s.day == 1 and (e - s).days <= 31 else None
            return Response(report_pdf(rep, u, bud), mimetype="application/pdf", headers={"Content-Disposition": f'attachment; filename="{stem}.pdf"'})
        if fmt != "json":
            raise ValidationError("Formato no válido.")
        rep["transactions"] = rep["transactions"][:50]
        return jsonify(rep)

    # ---------- metas
    @app.get("/api/goals")
    @login_required
    def goals_list():
        u, db = me(), get_db()
        today = today_for(u["timezone"])
        return jsonify({"goals": [goal_row(db, g, today) for g in db.execute("SELECT * FROM goals WHERE user_id=? ORDER BY archived, name COLLATE NOCASE", (u["id"],))]})

    def goal_fields(d, u, row=None):
        cur = d.get("currency", row["currency"] if row else u["currency"])
        if cur not in ledger.CURRENCIES:
            raise ValidationError("Moneda no compatible.", "currency")
        td = d.get("target_date", row["target_date"] if row else None)
        return {"name": clean_text(d.get("name", row["name"] if row else None), "name", 80, required=True), "currency": cur,
                "target": to_cents(d.get("target", (row["target"] / 100) if row else None), "target"),
                "target_date": parse_date(td, "target_date") if td else None, "notes": clean_text(d.get("notes", row["notes"] if row else ""), "notes", 500)}

    @app.post("/api/goals")
    @login_required
    def goals_create():
        u, d, db = me(), json_body(), get_db()
        f = goal_fields(d, u)
        with atomic(db):
            gid = db.execute("INSERT INTO goals (user_id,name,target,target_date,currency,notes) VALUES (?,?,?,?,?,?)", (u["id"], f["name"], f["target"], f["target_date"], f["currency"], f["notes"])).lastrowid
        return jsonify({"goal": goal_row(db, db.execute("SELECT * FROM goals WHERE id=?", (gid,)).fetchone(), today_for(u["timezone"]))}), 201

    @app.get("/api/goals/<int:gid>")
    @login_required
    def goals_get(gid):
        u, db = me(), get_db()
        g = owned(db, "goals", gid, u["id"])
        if not g:
            raise ValidationError("Meta no encontrada.", status=404)
        return jsonify({"goal": goal_row(db, g, today_for(u["timezone"])), "contribs": [dict(r) for r in db.execute("SELECT * FROM goal_contribs WHERE goal_id=? ORDER BY date DESC, id DESC", (gid,))]})

    @app.patch("/api/goals/<int:gid>")
    @login_required
    def goals_update(gid):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            g = owned(db, "goals", gid, u["id"])
            if not g:
                raise ValidationError("Meta no encontrada.", status=404)
            f = goal_fields(d, u, g)
            if f["currency"] != g["currency"] and db.execute("SELECT 1 FROM goal_contribs WHERE goal_id=?", (gid,)).fetchone():
                raise ValidationError("No puedes cambiar la moneda de una meta con aportaciones.", "currency")
            db.execute("UPDATE goals SET name=?,target=?,target_date=?,currency=?,notes=?,archived=? WHERE id=? AND user_id=?",
                       (f["name"], f["target"], f["target_date"], f["currency"], f["notes"], 1 if d.get("archived", g["archived"]) else 0, gid, u["id"]))
        return jsonify({"goal": goal_row(db, db.execute("SELECT * FROM goals WHERE id=?", (gid,)).fetchone(), today_for(u["timezone"]))})

    @app.delete("/api/goals/<int:gid>")
    @login_required
    def goals_delete(gid):
        u, db = me(), get_db()
        with atomic(db):
            if db.execute("DELETE FROM goals WHERE id=? AND user_id=?", (gid, u["id"])).rowcount == 0:
                raise ValidationError("Meta no encontrada.", status=404)
        return jsonify({"ok": True})

    @app.post("/api/goals/<int:gid>/contribs")
    @login_required
    def goal_contrib(gid):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            g = owned(db, "goals", gid, u["id"])
            if not g:
                raise ValidationError("Meta no encontrada.", status=404)
            amt = to_cents(d.get("amount"), "amount")
            if d.get("kind") == "withdraw":
                saved = goal_row(db, g, today_for(u["timezone"]))["saved"]
                if amt > saved:
                    raise ValidationError(f"Solo tienes {money_txt(saved)} ahorrados en esta meta.", "amount")
                amt = -amt
            cid = db.execute("INSERT INTO goal_contribs (user_id,goal_id,date,amount,notes) VALUES (?,?,?,?,?)",
                             (u["id"], gid, parse_date(d.get("date") or today_for(u["timezone"]).isoformat(), "date"), amt, clean_text(d.get("notes"), "notes", 300))).lastrowid
        return jsonify({"ok": True, "id": cid}), 201

    @app.delete("/api/goals/contribs/<int:cid>")
    @login_required
    def goal_contrib_delete(cid):
        u, db = me(), get_db()
        with atomic(db):
            c = owned(db, "goal_contribs", cid, u["id"])
            if not c:
                raise ValidationError("Aportación no encontrada.", status=404)
            saved = db.execute("SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=?", (c["goal_id"],)).fetchone()[0]
            if saved - c["amount"] < 0:
                raise ValidationError("No puedes eliminar esta aportación porque dejaría la meta con saldo negativo.", status=409)
            db.execute("DELETE FROM goal_contribs WHERE id=?", (cid,))
        return jsonify({"ok": True})

    # ---------- tablas personalizadas
    @app.get("/api/tables")
    @login_required
    def tables_list():
        u, db = me(), get_db()
        return jsonify({"tables": [{"id": t["id"], "name": t["name"], "columns": len(json.loads(t["columns"])),
                                    "rows": db.execute("SELECT COUNT(*) FROM custom_rows WHERE table_id=?", (t["id"],)).fetchone()[0]}
                                   for t in db.execute("SELECT * FROM custom_tables WHERE user_id=? ORDER BY name COLLATE NOCASE", (u["id"],))]})

    @app.post("/api/tables")
    @login_required
    def tables_create():
        u, d, db = me(), json_body(), get_db()
        if db.execute("SELECT COUNT(*) FROM custom_tables WHERE user_id=?", (u["id"],)).fetchone()[0] >= 50:
            raise ValidationError("Máximo 50 tablas.")
        cols = clean_columns(d.get("columns"))
        with atomic(db):
            tid = db.execute("INSERT INTO custom_tables (user_id,name,columns) VALUES (?,?,?)", (u["id"], clean_text(d.get("name"), "name", 80, required=True), json.dumps(cols))).lastrowid
        return jsonify({"table": table_payload(db, u["id"], db.execute("SELECT * FROM custom_tables WHERE id=?", (tid,)).fetchone())}), 201

    @app.get("/api/tables/<int:tid>")
    @login_required
    def tables_get(tid):
        u, db = me(), get_db()
        t = owned(db, "custom_tables", tid, u["id"])
        if not t:
            raise ValidationError("Tabla no encontrada.", status=404)
        return jsonify({"table": table_payload(db, u["id"], t)})

    @app.patch("/api/tables/<int:tid>")
    @login_required
    def tables_update(tid):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            t = owned(db, "custom_tables", tid, u["id"])
            if not t:
                raise ValidationError("Tabla no encontrada.", status=404)
            old = json.loads(t["columns"])
            cols = old
            if "columns" in d:
                used = set()
                for r in db.execute("SELECT data FROM custom_rows WHERE table_id=?", (tid,)):
                    used |= {k for k, v in json.loads(r["data"]).items() if v not in (None, "", False)}
                cols = clean_columns(d["columns"], old, used)
                gone = {c["id"] for c in old} - {c["id"] for c in cols}
                if gone:
                    for r in db.execute("SELECT id, data FROM custom_rows WHERE table_id=?", (tid,)).fetchall():
                        data = json.loads(r["data"])
                        db.execute("UPDATE custom_rows SET data=? WHERE id=?", (json.dumps({k: v for k, v in data.items() if k not in gone}), r["id"]))
            db.execute("UPDATE custom_tables SET name=?, columns=? WHERE id=?", (clean_text(d.get("name", t["name"]), "name", 80, required=True), json.dumps(cols), tid))
        return jsonify({"table": table_payload(db, u["id"], db.execute("SELECT * FROM custom_tables WHERE id=?", (tid,)).fetchone())})

    @app.delete("/api/tables/<int:tid>")
    @login_required
    def tables_delete(tid):
        u, db = me(), get_db()
        with atomic(db):
            if db.execute("DELETE FROM custom_tables WHERE id=? AND user_id=?", (tid, u["id"])).rowcount == 0:
                raise ValidationError("Tabla no encontrada.", status=404)
        return jsonify({"ok": True})

    def clean_row(cols, data):
        if not isinstance(data, dict):
            raise ValidationError("Fila no válida.")
        out = {}
        for c in cols:
            v = clean_cell(data.get(c["id"]), c["type"], c["name"])
            if v is not None:
                out[c["id"]] = v
        return out

    @app.post("/api/tables/<int:tid>/rows")
    @login_required
    def rows_create(tid):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            t = owned(db, "custom_tables", tid, u["id"])
            if not t:
                raise ValidationError("Tabla no encontrada.", status=404)
            n = db.execute("SELECT COUNT(*), COALESCE(MAX(position),0) FROM custom_rows WHERE table_id=?", (tid,)).fetchone()
            if n[0] >= 5000:
                raise ValidationError("Máximo 5,000 filas por tabla.")
            rid = db.execute("INSERT INTO custom_rows (user_id,table_id,data,position) VALUES (?,?,?,?)",
                             (u["id"], tid, json.dumps(clean_row(json.loads(t["columns"]), d.get("data") or {})), n[1] + 1)).lastrowid
        return jsonify({"table": table_payload(db, u["id"], t), "row_id": rid}), 201

    @app.put("/api/tables/<int:tid>/rows/<int:rid>")
    @login_required
    def rows_update(tid, rid):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            t = owned(db, "custom_tables", tid, u["id"])
            r = db.execute("SELECT * FROM custom_rows WHERE id=? AND table_id=? AND user_id=?", (rid, tid, u["id"])).fetchone() if t else None
            if not r:
                raise ValidationError("Fila no encontrada.", status=404)
            cols = json.loads(t["columns"])
            data = json.loads(r["data"])
            data.update(clean_row(cols, {k: v for k, v in (d.get("data") or {}).items()}))
            for c in cols:                               # celdas enviadas vacías se borran
                if c["id"] in (d.get("data") or {}) and clean_cell(d["data"][c["id"]], c["type"], c["name"]) is None:
                    data.pop(c["id"], None)
            db.execute("UPDATE custom_rows SET data=? WHERE id=?", (json.dumps(data), rid))
        return jsonify({"table": table_payload(db, u["id"], t)})

    @app.delete("/api/tables/<int:tid>/rows/<int:rid>")
    @login_required
    def rows_delete(tid, rid):
        u, db = me(), get_db()
        with atomic(db):
            if db.execute("DELETE FROM custom_rows WHERE id=? AND table_id=? AND user_id=?", (rid, tid, u["id"])).rowcount == 0:
                raise ValidationError("Fila no encontrada.", status=404)
        t = owned(db, "custom_tables", tid, u["id"])
        return jsonify({"table": table_payload(db, u["id"], t)})

    @app.get("/api/tables/<int:tid>.csv")
    @login_required
    def tables_csv(tid):
        u, db = me(), get_db()
        t = owned(db, "custom_tables", tid, u["id"])
        if not t:
            raise ValidationError("Tabla no encontrada.", status=404)
        p = table_payload(db, u["id"], t)
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow([csv_safe(c["name"]) for c in p["columns"]])
        for r in p["rows"]:
            w.writerow([("Sí" if r["data"].get(c["id"]) else "") if c["type"] == "check" else csv_safe(r["data"].get(c["id"], "")) for c in p["columns"]])
        return Response("﻿" + out.getvalue(), mimetype="text/csv; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="tabla.csv"'})

    # ---------- comprobantes
    def receipts_dir(uid):
        base = app.config.get("RECEIPTS_DIR")
        path = os.path.join(base, str(uid))
        os.makedirs(path, exist_ok=True)
        return path

    @app.post("/api/receipts")
    @login_required
    def receipts_upload():
        from PIL import Image, UnidentifiedImageError
        Image.MAX_IMAGE_PIXELS = 60_000_000
        u, db = me(), get_db()
        f = request.files.get("file")
        if not f or not f.filename:
            raise ValidationError("Selecciona una foto del comprobante.", "file")
        data = f.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise ValidationError("La imagen es demasiado grande (máximo 8 MB).", "file")
        try:
            im = Image.open(io.BytesIO(data))
            fmt = im.format
            im.verify()
        except (UnidentifiedImageError, Exception):
            raise ValidationError("El archivo no es una imagen válida. Usa JPG, PNG o WEBP.", "file")
        if fmt not in ALLOWED_IMG:
            raise ValidationError("Formato no compatible. Usa JPG, PNG o WEBP.", "file")
        if db.execute("SELECT COUNT(*) FROM receipts WHERE user_id=?", (u["id"],)).fetchone()[0] >= 1000:
            raise ValidationError("Llegaste al máximo de 1,000 comprobantes.")
        mime, ext = ALLOWED_IMG[fmt]
        path = os.path.join(receipts_dir(u["id"]), secrets.token_hex(12) + ext)
        with open(path, "wb") as fh:
            fh.write(data)
        text, err = run_ocr(path)
        with atomic(db):
            rid = db.execute("INSERT INTO receipts (user_id,filename,mime,path,size,ocr_text) VALUES (?,?,?,?,?,?)",
                             (u["id"], clean_text(os.path.basename(f.filename), "file", 120), mime, path, len(data), text)).lastrowid
        r = db.execute("SELECT * FROM receipts WHERE id=?", (rid,)).fetchone()
        return jsonify({"receipt": receipt_dict(r), "text": text, "ocr_available": ocr_available(), "ocr_error": err,
                        "suggestion": parse_receipt(text, today_for(u["timezone"])) if text else None}), 201

    @app.get("/api/receipts")
    @login_required
    def receipts_list():
        u, db = me(), get_db()
        q, p = "SELECT * FROM receipts WHERE user_id=?", [u["id"]]
        if request.args.get("unlinked") == "1":
            q += " AND tx_id IS NULL"
        if request.args.get("tx_id"):
            q += " AND tx_id=?"
            p.append(int(request.args["tx_id"]) if request.args["tx_id"].isdigit() else -1)
        return jsonify({"receipts": [receipt_dict(r) for r in db.execute(q + " ORDER BY id DESC LIMIT 200", p)], "ocr_available": ocr_available()})

    @app.get("/api/receipts/<int:rid>/file")
    @login_required
    def receipts_file(rid):
        u, db = me(), get_db()
        r = owned(db, "receipts", rid, u["id"])
        if not r or not os.path.isfile(r["path"]):
            raise ValidationError("Comprobante no encontrado.", status=404)
        resp = send_file(r["path"], mimetype=r["mime"], conditional=True)
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    @app.get("/api/receipts/<int:rid>")
    @login_required
    def receipts_get(rid):
        u, db = me(), get_db()
        r = owned(db, "receipts", rid, u["id"])
        if not r:
            raise ValidationError("Comprobante no encontrado.", status=404)
        return jsonify({"receipt": receipt_dict(r), "text": r["ocr_text"],
                        "suggestion": parse_receipt(r["ocr_text"], today_for(u["timezone"])) if r["ocr_text"] else None})

    @app.post("/api/receipts/<int:rid>/link")
    @login_required
    def receipts_link(rid):
        u, d, db = me(), json_body(), get_db()
        with atomic(db):
            r = owned(db, "receipts", rid, u["id"])
            if not r:
                raise ValidationError("Comprobante no encontrado.", status=404)
            tx = None if d.get("tx_id") in (None, "") else owned(db, "transactions", d.get("tx_id"), u["id"])
            if d.get("tx_id") not in (None, "") and not tx:
                raise ValidationError("Movimiento no encontrado.", status=404)
            db.execute("UPDATE receipts SET tx_id=? WHERE id=?", (tx["id"] if tx else None, rid))
        return jsonify({"ok": True})

    @app.delete("/api/receipts/<int:rid>")
    @login_required
    def receipts_delete(rid):
        u, db = me(), get_db()
        with atomic(db):
            r = owned(db, "receipts", rid, u["id"])
            if not r:
                raise ValidationError("Comprobante no encontrado.", status=404)
            db.execute("DELETE FROM receipts WHERE id=?", (rid,))
        try:
            os.remove(r["path"])
        except OSError:
            pass
        return jsonify({"ok": True})
