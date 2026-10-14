"""Motor financiero: reglas de saldos, validación de movimientos y agregados.

Reglas:
  income      +importe a la cuenta                 -> cuenta como ingreso
  expense     -importe a la cuenta                 -> cuenta como gasto
  refund      +importe a la cuenta                 -> reduce el gasto de su categoría
  transfer    -importe origen, +to_amount destino  -> NO es ingreso ni gasto
  adjustment  +/-importe (con signo)               -> NO es ingreso ni gasto
El saldo de una cuenta NUNCA se guarda: = saldo inicial + suma de efectos.
"""
import re
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from zoneinfo import ZoneInfo

from db import atomic

TX_TYPES = ("expense", "income", "transfer", "refund", "adjustment")
ACCOUNT_TYPES = ("bank", "cash", "savings", "digital", "credit", "investment", "other")
LIQUID_TYPES = ("bank", "cash", "savings", "digital")
CURRENCIES = ("MXN", "USD", "EUR", "GBP", "CAD", "COP", "ARS", "CLP", "PEN", "BRL")
MAX_CENTS = 10 ** 13


class ValidationError(Exception):
    def __init__(self, message, field=None, status=400):
        super().__init__(message)
        self.message = message
        self.field = field
        self.status = status


# ---------------------------------------------------------------- utilidades
def to_cents(value, field="importe", allow_negative=False, allow_zero=False):
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValidationError("Introduce un importe.", field)
    try:
        d = Decimal(str(value).replace(",", "").replace("$", "").strip())
    except InvalidOperation:
        raise ValidationError("El importe no es un número válido.", field)
    if not d.is_finite():
        raise ValidationError("El importe no es válido.", field)
    cents = int((d * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    if abs(cents) > MAX_CENTS:
        raise ValidationError("El importe es demasiado grande.", field)
    if cents < 0 and not allow_negative:
        raise ValidationError("El importe no puede ser negativo.", field)
    if cents == 0 and not allow_zero:
        raise ValidationError("El importe debe ser mayor que cero.", field)
    return cents


def parse_date(value, field="fecha"):
    try:
        d = datetime.strptime(str(value), "%Y-%m-%d").date()
    except (ValueError, TypeError):
        raise ValidationError("La fecha no es válida (AAAA-MM-DD).", field)
    if d.year < 1990 or d.year > 2100:
        raise ValidationError("La fecha está fuera de rango.", field)
    return d.isoformat()


def today_for(tz_name):
    try:
        return datetime.now(ZoneInfo(tz_name)).date()
    except Exception:
        return date.today()


def clean_text(value, field, maxlen, required=False):
    s = (value or "").strip() if isinstance(value, str) or value is None else str(value).strip()
    if required and not s:
        raise ValidationError("Este campo es obligatorio.", field)
    if len(s) > maxlen:
        raise ValidationError(f"Máximo {maxlen} caracteres.", field)
    return s


# ---------------------------------------------------------------- saldos
BALANCE_SQL = """
SELECT a.id,
       a.opening_balance
       + COALESCE((SELECT SUM(CASE t.type
                    WHEN 'income' THEN t.amount WHEN 'refund' THEN t.amount
                    WHEN 'adjustment' THEN t.amount
                    WHEN 'expense' THEN -t.amount WHEN 'transfer' THEN -t.amount END)
                   FROM transactions t WHERE t.account_id = a.id), 0)
       + COALESCE((SELECT SUM(t.to_amount) FROM transactions t
                   WHERE t.to_account_id = a.id AND t.type = 'transfer'), 0)
       + COALESCE((SELECT SUM(CASE h.kind WHEN 'buy' THEN -(h.gross + h.fee) ELSE (h.gross - h.fee) END)
                   FROM holding_ops h WHERE h.account_id = a.id), 0)
       - COALESCE((SELECT SUM(p.principal_part + p.interest_part) FROM debt_payments p WHERE p.account_id = a.id), 0) AS balance
FROM accounts a WHERE a.user_id = ?
"""


def balances(db, user_id):
    return {r["id"]: r["balance"] for r in db.execute(BALANCE_SQL, (user_id,))}


def account_row(a, balance):
    return {
        "id": a["id"], "name": a["name"], "institution": a["institution"], "type": a["type"],
        "currency": a["currency"], "opening_balance": a["opening_balance"], "opened_on": a["opened_on"],
        "low_balance_alert": a["low_balance_alert"], "archived": bool(a["archived"]),
        "is_demo": bool(a["is_demo"]), "balance": balance,
        "credit_limit": a["credit_limit"], "cut_day": a["cut_day"], "due_day": a["due_day"],
    }


def list_accounts(db, user_id, include_archived=True):
    bal = balances(db, user_id)
    q = "SELECT * FROM accounts WHERE user_id = ?" + ("" if include_archived else " AND archived = 0") + " ORDER BY archived, name COLLATE NOCASE"
    return [account_row(a, bal.get(a["id"], 0)) for a in db.execute(q, (user_id,))]


def op_cash_effect(o):
    """Efecto en efectivo de una operación de portafolio ligada a una cuenta."""
    return -(o["gross"] + o["fee"]) if o["kind"] == "buy" else (o["gross"] - o["fee"])


def signed_effect_for_account(tx, account_id):
    """Efecto de un movimiento (dict/Row) en el saldo de una cuenta concreta."""
    t = tx["type"]
    eff = 0
    if tx["account_id"] == account_id:
        if t in ("income", "refund", "adjustment"):
            eff += tx["amount"]
        elif t in ("expense", "transfer"):
            eff -= tx["amount"]
    if t == "transfer" and tx["to_account_id"] == account_id:
        eff += tx["to_amount"]
    return eff


# ---------------------------------------------------------------- validación de movimientos
def owned(db, table, row_id, user_id):
    if row_id in (None, ""):
        return None
    try:
        row_id = int(row_id)
    except (ValueError, TypeError):
        return None
    return db.execute(f"SELECT * FROM {table} WHERE id = ? AND user_id = ?", (row_id, user_id)).fetchone()


def normalize_tx(db, user_id, data, existing=None):
    """Valida y normaliza un movimiento. Lanza ValidationError si algo no cuadra."""
    ttype = data.get("type")
    if ttype not in TX_TYPES:
        raise ValidationError("Tipo de movimiento no válido.", "type")
    if existing is not None and existing["type"] != ttype and (ttype == "adjustment" or existing["type"] == "adjustment"):
        raise ValidationError("Un ajuste no puede convertirse en otro tipo de movimiento.", "type")

    tx = {"type": ttype}
    tx["amount"] = to_cents(data.get("amount"), "amount", allow_negative=(ttype == "adjustment"))
    tx["date"] = parse_date(data.get("date"))

    acc = owned(db, "accounts", data.get("account_id"), user_id)
    if not acc:
        raise ValidationError("Selecciona una cuenta válida.", "account_id")
    unchanged_acc = existing is not None and existing["account_id"] == acc["id"]
    if acc["archived"] and not unchanged_acc:
        raise ValidationError("La cuenta está archivada.", "account_id")
    tx["account_id"] = acc["id"]
    tx["to_account_id"] = None
    tx["to_amount"] = None

    if ttype == "transfer":
        dest = owned(db, "accounts", data.get("to_account_id"), user_id)
        if not dest:
            raise ValidationError("Selecciona la cuenta de destino.", "to_account_id")
        if dest["id"] == acc["id"]:
            raise ValidationError("El origen y el destino deben ser distintos.", "to_account_id")
        unchanged_dest = existing is not None and existing["to_account_id"] == dest["id"]
        if dest["archived"] and not unchanged_dest:
            raise ValidationError("La cuenta de destino está archivada.", "to_account_id")
        tx["to_account_id"] = dest["id"]
        if dest["currency"] == acc["currency"]:
            tx["to_amount"] = tx["amount"]
        else:
            if data.get("to_amount") in (None, ""):
                raise ValidationError(
                    f"Las cuentas usan monedas distintas ({acc['currency']} → {dest['currency']}). "
                    "Indica el importe que recibe la cuenta destino.", "to_amount")
            tx["to_amount"] = to_cents(data.get("to_amount"), "to_amount")
        tx["category_id"] = None
    elif ttype == "adjustment":
        tx["category_id"] = None
    else:
        cat = owned(db, "categories", data.get("category_id"), user_id) if data.get("category_id") not in (None, "") else None
        if data.get("category_id") not in (None, "") and not cat:
            raise ValidationError("La categoría no es válida.", "category_id")
        if cat:
            need = "income" if ttype == "income" else "expense"
            if cat["kind"] != need:
                raise ValidationError("La categoría no corresponde al tipo de movimiento.", "category_id")
            unchanged_cat = existing is not None and existing["category_id"] == cat["id"]
            if cat["archived"] and not unchanged_cat:
                raise ValidationError("La categoría está archivada.", "category_id")
        tx["category_id"] = cat["id"] if cat else None

    tx["description"] = clean_text(data.get("description"), "description", 200)
    tx["payment_method"] = clean_text(data.get("payment_method"), "payment_method", 60)
    tx["notes"] = clean_text(data.get("notes"), "notes", 2000)
    tags = data.get("tags") or ""
    if isinstance(tags, list):
        tags = ",".join(str(t) for t in tags)
    tags = ",".join(t.strip() for t in re.split(r"[,;]", str(tags)) if t.strip())
    tx["tags"] = clean_text(tags, "tags", 300)
    tx["recurring"] = 1 if data.get("recurring") else 0
    return tx


TX_COLS = ("type", "amount", "to_amount", "date", "account_id", "to_account_id", "category_id",
           "description", "payment_method", "tags", "notes", "recurring")


def insert_tx(db, user_id, data, is_demo=0, import_id=None):
    """Valida e inserta un movimiento. Debe llamarse dentro de una transacción atómica."""
    tx = normalize_tx(db, user_id, data)
    cur = db.execute(
        f"INSERT INTO transactions (user_id, is_demo, import_id, {', '.join(TX_COLS)}) VALUES (?, ?, ?, {', '.join('?' * len(TX_COLS))})",
        (user_id, is_demo, import_id, *[tx[c] for c in TX_COLS]))
    return cur.lastrowid


def create_tx(db, user_id, data, is_demo=0):
    with atomic(db):
        return insert_tx(db, user_id, data, is_demo)


def update_tx(db, user_id, tx_id, data, before=None, after=None):
    """before(existing, tx) / after(existing, tx): ganchos dentro de la misma transacción atómica (p. ej. compras a meses)."""
    with atomic(db):
        existing = owned(db, "transactions", tx_id, user_id)
        if not existing:
            raise ValidationError("Movimiento no encontrado.", status=404)
        tx = normalize_tx(db, user_id, data, existing)
        if before:
            before(existing, tx)
        sets = ", ".join(f"{c} = ?" for c in TX_COLS)
        # un movimiento demo que pasa a una cuenta real deja de ser demo (protege datos reales)
        ids = [tx["account_id"]] + ([tx["to_account_id"]] if tx["to_account_id"] else [])
        all_demo = all(db.execute("SELECT is_demo FROM accounts WHERE id=?", (i,)).fetchone()[0] for i in ids)
        db.execute(f"UPDATE transactions SET {sets}, is_demo = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
                   (*[tx[c] for c in TX_COLS], 1 if (existing["is_demo"] and all_demo) else 0, existing["id"], user_id))
        if after:
            after(existing, tx)
        return existing["id"]


def delete_tx(db, user_id, tx_id, before=None):
    with atomic(db):
        if before:
            before(tx_id)
        cur = db.execute("DELETE FROM transactions WHERE id = ? AND user_id = ?", (tx_id, user_id))
        if cur.rowcount == 0:
            raise ValidationError("Movimiento no encontrado.", status=404)


TX_SELECT = """
SELECT t.*, a.name AS account_name, a.currency AS account_currency,
       ta.name AS to_account_name, c.name AS category_name,
       p.kind AS plan_kind, p.months_total AS plan_months, p.monthly_amount AS plan_monthly
FROM transactions t
JOIN accounts a ON a.id = t.account_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN card_plans p ON p.transaction_id = t.id
"""


def tx_dict(r):
    d = {k: r[k] for k in r.keys()}
    d["recurring"] = bool(d["recurring"])
    d["is_demo"] = bool(d["is_demo"])
    return d


def query_transactions(db, user_id, args, paginate=True):
    where, params = ["t.user_id = ?"], [user_id]
    q = (args.get("q") or "").strip()
    if q:
        like = f"%{q}%"
        where.append("(t.description LIKE ? OR t.notes LIKE ? OR t.tags LIKE ? OR c.name LIKE ? OR a.name LIKE ?)")
        params += [like] * 5
    if args.get("from"):
        where.append("t.date >= ?"); params.append(parse_date(args["from"], "from"))
    if args.get("to"):
        where.append("t.date <= ?"); params.append(parse_date(args["to"], "to"))
    if args.get("account_id"):
        where.append("(t.account_id = ? OR t.to_account_id = ?)"); params += [args["account_id"]] * 2
    if args.get("category_id"):
        where.append("t.category_id = ?"); params.append(args["category_id"])
    if args.get("type") in TX_TYPES:
        where.append("t.type = ?"); params.append(args["type"])
    sort_map = {"date": "t.date", "description": "t.description COLLATE NOCASE", "category": "c.name COLLATE NOCASE",
                "account": "a.name COLLATE NOCASE", "type": "t.type", "amount": "t.amount"}
    col = sort_map.get(args.get("sort"), "t.date")
    direction = "ASC" if args.get("dir") == "asc" else "DESC"
    order = f"ORDER BY {col} {direction}, t.id {direction}"
    w = " WHERE " + " AND ".join(where)
    total = db.execute(f"SELECT COUNT(*) FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id{w}", params).fetchone()[0]
    sql = f"{TX_SELECT}{w} {order}"
    page = per_page = None
    if paginate:
        try:
            page = max(1, int(args.get("page", 1)))
            per_page = min(100, max(5, int(args.get("per_page", 25))))
        except ValueError:
            page, per_page = 1, 25
        sql += " LIMIT ? OFFSET ?"
        params = params + [per_page, (page - 1) * per_page]
    rows = [tx_dict(r) for r in db.execute(sql, params)]
    return rows, total, page, per_page


# ---------------------------------------------------------------- periodos y dashboard
def period_range(period, today, start=None, end=None):
    if period == "today":
        return today, today
    if period == "week":
        s = today - timedelta(days=today.weekday())
        return s, s + timedelta(days=6)
    if period == "3months":
        m = today.month - 2
        y = today.year
        if m < 1:
            m += 12; y -= 1
        return date(y, m, 1), today
    if period == "year":
        return date(today.year, 1, 1), date(today.year, 12, 31)
    if period == "custom":
        s, e = date.fromisoformat(parse_date(start, "from")), date.fromisoformat(parse_date(end, "to"))
        if e < s:
            raise ValidationError("La fecha final es anterior a la inicial.", "to")
        return s, e
    return date(today.year, today.month, 1), (date(today.year + (today.month == 12), today.month % 12 + 1, 1) - timedelta(days=1))


PREV_LABEL = {"today": "vs. ayer", "week": "vs. la semana pasada", "month": "vs. el mes pasado", "3months": "vs. los 3 meses anteriores",
              "year": "vs. el año pasado", "custom": "vs. el periodo anterior"}


def _shift_months(d, n):
    m0 = d.month - 1 + n
    y, m = d.year + m0 // 12, m0 % 12 + 1
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(d.day, last))


def previous_period(period, s, e, today):
    """Periodo anterior comparable, recortado al mismo avance: si hoy es miércoles, «esta semana» (lun-mié) se compara
    contra lun-mié de la semana pasada, no contra la semana completa."""
    end = e if period == "custom" else min(e, today)
    if end < s:
        return None
    if period == "custom":
        n = (e - s).days + 1
        return s - timedelta(days=n), s - timedelta(days=1)
    if period in ("today", "week"):
        n = 1 if period == "today" else 7
        return s - timedelta(days=n), end - timedelta(days=n)
    months = {"3months": 3, "year": 12}.get(period, 1)
    return _shift_months(s, -months), min(_shift_months(end, -months), s - timedelta(days=1))


def sum_period(db, user_id, s, e, currency):
    """Ingresos y gastos netos (gastos - reembolsos) del periodo. Solo cuentas en la moneda principal."""
    r = db.execute("""
        SELECT COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount END),0) AS income,
               COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount WHEN t.type='refund' THEN -t.amount END),0) AS expense
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id=? AND t.date BETWEEN ? AND ? AND a.currency=? AND t.type IN ('income','expense','refund')""",
        (user_id, s.isoformat(), e.isoformat(), currency)).fetchone()
    return r["income"], r["expense"]


def dashboard(db, user, args):
    uid, cur = user["id"], user["currency"]
    today = today_for(user["timezone"])
    period = args.get("period", "month")
    s, e = period_range(period, today, args.get("from"), args.get("to"))
    accounts = list_accounts(db, uid, include_archived=False)
    # cuentas en otra moneda (p. ej. un portafolio en dólares): se suman convertidas si hay tipo de cambio
    import portfolio                                       # import tardío: portfolio importa ledger
    rates = portfolio.fx_rates(db, cur, [a["currency"] for a in accounts if a["currency"] != cur]) if any(a["currency"] != cur for a in accounts) else {}
    converted = []
    for a in accounts:
        r = rates.get(a["currency"])
        if a["currency"] != cur and r:
            a = dict(a); a["balance_original"], a["balance"] = a["balance"], round(a["balance"] * r)
            converted.append(a)
    main = [a for a in accounts if a["currency"] == cur] + converted
    other = [a for a in accounts if a["currency"] != cur and not rates.get(a["currency"])]
    cards_ = [a for a in main if a["type"] == "credit"]
    total_money = sum(a["balance"] for a in main if a["type"] != "credit")     # las tarjetas son deuda, no dinero
    card_debt = sum(-a["balance"] for a in cards_)                               # un saldo a favor en tarjeta resta deuda
    liquid = sum(a["balance"] for a in main if a["type"] in LIQUID_TYPES)
    invested = sum(a["balance"] for a in main if a["type"] == "investment")
    income, expense = sum_period(db, uid, s, e, cur)
    prev = None
    pp = previous_period(period, s, e, today)
    if pp:
        p_inc, p_exp = sum_period(db, uid, pp[0], pp[1], cur)
        prev = {"from": pp[0].isoformat(), "to": pp[1].isoformat(), "income": p_inc, "expense": p_exp, "label": PREV_LABEL.get(period, PREV_LABEL["custom"]),
                "expense_change_pct": round((expense - p_exp) * 100 / p_exp, 2) if p_exp > 0 else None}

    # serie ingresos vs gastos
    monthly = (e - s).days > 62
    fmt = "%Y-%m" if monthly else "%Y-%m-%d"
    rows = db.execute(f"""
        SELECT strftime('{fmt}', t.date) AS k,
               COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount END),0) AS income,
               COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount WHEN t.type='refund' THEN -t.amount END),0) AS expense
        FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE t.user_id=? AND t.date BETWEEN ? AND ? AND a.currency=? AND t.type IN ('income','expense','refund')
        GROUP BY k ORDER BY k""", (uid, s.isoformat(), e.isoformat(), cur)).fetchall()
    by_key = {r["k"]: r for r in rows}
    series, d = [], s
    if monthly:
        y, m = s.year, s.month
        while (y, m) <= (e.year, e.month):
            k = f"{y:04d}-{m:02d}"
            r = by_key.get(k)
            series.append({"key": k, "income": r["income"] if r else 0, "expense": r["expense"] if r else 0})
            m += 1
            if m > 12: m = 1; y += 1
    else:
        end = min(e, today) if period != "custom" else e
        while d <= max(end, s):
            k = d.isoformat()
            r = by_key.get(k)
            series.append({"key": k, "income": r["income"] if r else 0, "expense": r["expense"] if r else 0})
            d += timedelta(days=1)

    cats = db.execute("""
        SELECT c.id, COALESCE(c.name, 'Sin categoría') AS name,
               SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END) AS total
        FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id
        WHERE t.user_id=? AND t.date BETWEEN ? AND ? AND a.currency=? AND t.type IN ('expense','refund')
        GROUP BY c.id HAVING total > 0 ORDER BY total DESC""", (uid, s.isoformat(), e.isoformat(), cur)).fetchall()

    latest, _, _, _ = query_transactions(db, uid, {"per_page": 8, "sort": "date", "dir": "desc"})

    return {
        "period": {"key": period, "from": s.isoformat(), "to": e.isoformat(), "today": today.isoformat()},
        "currency": cur,
        "cards": {"total_money": total_money, "available": liquid, "invested": invested,
                  "income": income, "expense": expense, "net": income - expense,
                  "card_debt": card_debt, "debts_total": debts_remaining(db, uid, cur),
                  "investments_value": invested, "net_worth": total_money - card_debt - debts_remaining(db, uid, cur)},
        "excluded_accounts": [{"name": a["name"], "currency": a["currency"], "balance": a["balance"]} for a in other],
        "converted_accounts": [{"name": a["name"], "currency": a["currency"], "balance": a["balance_original"], "balance_main": a["balance"]} for a in converted],
        "fx": portfolio.fx_info(db, cur, rates),
        "series": series, "series_unit": "month" if monthly else "day",
        "categories": [{"id": c["id"], "name": c["name"], "total": c["total"]} for c in cats],
        "latest": latest, "previous": prev,
        "alerts": build_alerts(db, user, accounts, today),
    }


def debts_remaining(db, user_id, cur):
    r = db.execute("""SELECT COALESCE(SUM(d.principal - COALESCE((SELECT SUM(p.principal_part) FROM debt_payments p WHERE p.debt_id = d.id), 0)), 0)
                      FROM debts d WHERE d.user_id = ? AND d.currency = ? AND d.archived = 0""", (user_id, cur)).fetchone()[0]
    return max(0, r)


def next_day(today, day):
    """Próxima fecha con ese día del mes (ajustada a meses cortos); day 0 = sin configurar."""
    if not day:
        return None
    y, m = today.year, today.month
    for _ in range(3):
        last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
        d = date(y, m, min(day, last))
        if d >= today:
            return d
        m += 1
        if m > 12: m = 1; y += 1
    return None


def build_alerts(db, user, accounts, today):
    alerts = []
    for a in accounts:
        if a["type"] == "credit":
            used = -a["balance"]
            if a["credit_limit"] and used > 0 and used >= a["credit_limit"] * 0.8:
                alerts.append({"level": "danger" if used >= a["credit_limit"] else "warn",
                               "text": f"La tarjeta «{a['name']}» usa {round(used * 100 / a['credit_limit'])}% de su límite.", "account_id": a["id"], "link": "#/cards"})
            due = next_day(today, a["due_day"])
            if due and used > 0 and (due - today).days <= 5:
                import more                                # import tardío: more importa ledger
                row = db.execute("SELECT * FROM accounts WHERE id=?", (a["id"],)).fetchone()
                st = more.card_row(db, user, row, a["balance"])["statement"]
                if st and st["pending"] <= 0:
                    continue                               # el pago del mes ya está cubierto
                owe = st["pending"] if st else used
                what = "el pago del mes es" if st else "debes"
                alerts.append({"level": "warn", "text": f"La tarjeta «{a['name']}» vence el {due.isoformat()} y {what} {owe / 100:,.2f}.", "account_id": a["id"], "link": "#/cards"})
            continue
        if a["balance"] < 0:
            alerts.append({"level": "danger", "text": f"La cuenta «{a['name']}» tiene saldo negativo.", "account_id": a["id"], "link": f"#/accounts/{a['id']}"})
        elif a["low_balance_alert"] and a["balance"] < a["low_balance_alert"]:
            alerts.append({"level": "warn", "text": f"La cuenta «{a['name']}» está por debajo de tu límite de saldo bajo.", "account_id": a["id"], "link": f"#/accounts/{a['id']}"})
    cur, uid = user["currency"], user["id"]
    m0 = date(today.year, today.month, 1)
    # promedio de los 3 meses anteriores con gasto
    totals = []
    y, m = today.year, today.month
    for _ in range(3):
        m -= 1
        if m < 1: m = 12; y -= 1
        s = date(y, m, 1)
        e = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
        _, ex = sum_period(db, uid, s, e, cur)
        if ex > 0: totals.append(ex)
    if totals:
        avg = sum(totals) / len(totals)
        _, ex_now = sum_period(db, uid, m0, today, cur)
        # comparación proporcional al avance del mes
        days_in_month = (date(today.year + (today.month == 12), today.month % 12 + 1, 1) - m0).days
        expected = avg * today.day / days_in_month
        if today.day >= 7 and ex_now > expected * 1.3:
            alerts.append({"level": "warn", "text": "Tus gastos de este mes van por encima de tu promedio habitual (últimos meses con datos).", "link": "#/analysis"})
    return alerts


# ---------------------------------------------------------------- historial de cuenta
def account_history(db, user_id, account_id, today):
    a = owned(db, "accounts", account_id, user_id)
    if not a:
        raise ValidationError("Cuenta no encontrada.", status=404)
    txs = db.execute(f"{TX_SELECT} WHERE t.user_id = ? AND (t.account_id = ? OR t.to_account_id = ?) ORDER BY t.date, t.id",
                     (user_id, account_id, account_id)).fetchall()
    ops = db.execute("SELECT * FROM holding_ops WHERE user_id = ? AND account_id = ? ORDER BY date, id", (user_id, account_id)).fetchall()
    points, running, by_day = [], a["opening_balance"], {}
    for t in txs:
        by_day[t["date"]] = by_day.get(t["date"], 0) + signed_effect_for_account(t, account_id)
    for o in ops:
        by_day[o["date"]] = by_day.get(o["date"], 0) + op_cash_effect(o)
    dps = db.execute("""SELECT p.*, d.name AS debt_name FROM debt_payments p JOIN debts d ON d.id = p.debt_id
                        WHERE p.user_id = ? AND p.account_id = ? ORDER BY p.date, p.id""", (user_id, account_id)).fetchall()
    for p_ in dps:
        by_day[p_["date"]] = by_day.get(p_["date"], 0) - (p_["principal_part"] + p_["interest_part"])
    points.append({"date": a["opened_on"], "balance": running})
    for d in sorted(by_day):
        running += by_day[d]
        points.append({"date": d, "balance": running})
    if points[-1]["date"] < today.isoformat():
        points.append({"date": today.isoformat(), "balance": running})
    bal = balances(db, user_id)[account_id]
    assert bal == running, "Inconsistencia de saldo"
    recent = [tx_dict(t) for t in reversed(txs)]
    for r in recent:
        r["effect"] = signed_effect_for_account(r, account_id)
    label = {"buy": "Compra", "sell": "Venta", "dividend": "Dividendo", "interest": "Intereses"}
    for o in ops:                                     # operaciones de inversión ligadas a esta cuenta
        desc = f"{label[o['kind']]} {o['symbol']}" + (f" · {o['quantity']} × {o['price']}" if o["kind"] in ("buy", "sell") else "")
        recent.append({"id": o["id"], "op": True, "symbol": o["symbol"], "type": "investment", "date": o["date"], "description": desc,
                       "category_name": None, "to_account_name": None, "account_id": account_id, "effect": op_cash_effect(o)})
    for p_ in dps:                                    # pagos de deudas ligados a esta cuenta
        recent.append({"id": p_["id"], "op": True, "debt_id": p_["debt_id"], "type": "debt_payment", "date": p_["date"], "description": f"Pago de deuda: {p_['debt_name']}",
                       "category_name": None, "to_account_name": None, "account_id": account_id, "effect": -(p_["principal_part"] + p_["interest_part"])})
    recent.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
    return {"account": account_row(a, bal), "series": points, "transactions": recent[:100]}


def adjust_account(db, user_id, account_id, new_balance, on_date, note):
    with atomic(db):
        a = owned(db, "accounts", account_id, user_id)
        if not a:
            raise ValidationError("Cuenta no encontrada.", status=404)
        target = to_cents(new_balance, "new_balance", allow_negative=True, allow_zero=True)
        current = balances(db, user_id)[a["id"]]
        diff = target - current
        if diff == 0:
            raise ValidationError("El saldo indicado es igual al saldo actual.", "new_balance")
        db.execute("""INSERT INTO transactions (user_id, type, amount, date, account_id, description, notes)
                      VALUES (?, 'adjustment', ?, ?, ?, ?, ?)""",
                   (user_id, diff, parse_date(on_date), a["id"], "Ajuste de saldo", clean_text(note, "note", 500)))
        return diff


# ---------------------------------------------------------------- categorías por defecto
DEFAULT_EXPENSE_CATS = ["Comida", "Transporte", "Vivienda", "Entretenimiento", "Salud", "Educación",
                        "Viajes", "Servicios", "Suscripciones", "Compras", "Inversiones"]
DEFAULT_INCOME_CATS = ["Nómina", "Ventas", "Negocio", "Rendimientos", "Reembolsos", "Otros ingresos"]


def seed_categories(db, user_id):
    for n in DEFAULT_EXPENSE_CATS:
        db.execute("INSERT INTO categories (user_id, name, kind) VALUES (?, ?, 'expense')", (user_id, n))
    for n in DEFAULT_INCOME_CATS:
        db.execute("INSERT INTO categories (user_id, name, kind) VALUES (?, ?, 'income')", (user_id, n))


# ---------------------------------------------------------------- datos de demostración (aislados)
DEMO_SYMBOLS = ("DEMOACCA", "DEMOFND1")   # símbolos sintéticos, nunca chocan con un ticker real de Yahoo


def load_demo(db, user_id, today):
    """Crea cuentas, tarjeta, deuda, presupuestos, metas y portafolio de ejemplo, todo marcado is_demo=1.
    Cubre ~10 meses para que las tendencias, gráficas e insights de Análisis tengan algo que mostrar.
    Nunca toca datos reales; se puede borrar de un clic con delete_demo."""
    with atomic(db):
        if db.execute("SELECT 1 FROM accounts WHERE user_id=? AND is_demo=1", (user_id,)).fetchone():
            raise ValidationError("Los datos de demostración ya están cargados.")
        cur = db.execute("SELECT currency FROM users WHERE id=?", (user_id,)).fetchone()["currency"]
        first = today.replace(day=1)
        for _ in range(9):
            first = (first - timedelta(days=1)).replace(day=1)
        start = first.isoformat()
        n = 0

        ids = {}
        for key, name, typ, ob, cl, cutd, dued in (
            ("bank", "[DEMO] Cuenta de nómina", "bank", 1500000, 0, 0, 0),
            ("cash", "[DEMO] Efectivo", "cash", 800000, 0, 0, 0),
            ("sav", "[DEMO] Ahorro", "savings", 1200000, 0, 0, 0),
            ("card", "[DEMO] Visa", "credit", 0, 5000000, 20, 5),
            ("inv", "[DEMO] Inversiones", "investment", 1500000, 0, 0, 0),
        ):
            ids[key] = db.execute(
                "INSERT INTO accounts (user_id,name,institution,type,currency,opening_balance,opened_on,credit_limit,cut_day,due_day,is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
                (user_id, name, "Demostración", typ, cur, ob, start, cl, cutd, dued)).lastrowid

        cats = {}
        for cname, k in (("[DEMO] Comida", "expense"), ("[DEMO] Transporte", "expense"), ("[DEMO] Servicios", "expense"),
                         ("[DEMO] Entretenimiento", "expense"), ("[DEMO] Suscripciones", "expense"),
                         ("[DEMO] Nómina", "income"), ("[DEMO] Ventas", "income")):
            cats[cname] = db.execute("INSERT INTO categories (user_id,name,kind,is_demo) VALUES (?,?,?,1)", (user_id, cname, k)).lastrowid

        # --- movimientos del día a día (cuentas líquidas y tarjeta)
        # A partir del mes 6 hay un pequeño "aumento" de sueldo: crea una tendencia de ahorro real (no solo
        # ruido) entre la primera y la segunda mitad del historial, para que el insight de Tendencia tenga
        # algo genuino que reportar.
        def midx(dt):
            return (dt.year - first.year) * 12 + (dt.month - first.month)

        rows = []
        d, i = first, 0
        while d <= today:
            i += 1
            if d.day in (1, 15):
                rows.append(("income", 2000000 if midx(d) >= 6 else 1800000, d, "bank", "[DEMO] Nómina", "Pago quincenal"))
            if d.day == 20 and (i // 30) % 3 == 0:
                rows.append(("income", 350000 + (i % 4) * 40000, d, "bank", "[DEMO] Ventas", "Venta extra"))
            if d.weekday() in (1, 4):
                rows.append(("expense", 25000 + (i % 5) * 4500, d, "cash", "[DEMO] Comida", "Comida"))
            if d.weekday() == 0:
                rows.append(("expense", 12000 + (i % 3) * 3000, d, "bank", "[DEMO] Transporte", "Transporte"))
            if d.day == 5:
                rows.append(("expense", 95000, d, "bank", "[DEMO] Servicios", "Renta de internet y luz"))
            if d.weekday() == 5:
                rows.append(("expense", 40000 + (i % 4) * 6000, d, "bank", "[DEMO] Entretenimiento", "Salida de fin de semana"))
            if d.day == 3:
                rows.append(("expense", 19900, d, "bank", "[DEMO] Suscripciones", "Streaming de video"))
            if d.day == 8:
                rows.append(("expense", 11500, d, "bank", "[DEMO] Suscripciones", "Música en streaming"))
            if d.weekday() == 2:
                rows.append(("expense", 18000 + (i % 3) * 5000, d, "card", "[DEMO] Entretenimiento", "Cena o salida"))
            d += timedelta(days=1)
        # gasto puntual (no recurrente) unos días antes de hoy: da pie a un insight de Atención real, con
        # transporte y entretenimiento como los responsables, tal como pidió el usuario de ejemplo
        for desc, amt, days_before, cat in (("Reparación del auto", 350000, 4, "[DEMO] Transporte"), ("Concierto", 250000, 2, "[DEMO] Entretenimiento")):
            sd = today - timedelta(days=days_before)
            if sd >= first:
                rows.append(("expense", amt, sd, "bank", cat, desc))
        for typ, amt, dd, acc, cat, desc in rows:
            db.execute("""INSERT INTO transactions (user_id,type,amount,date,account_id,category_id,description,is_demo)
                          VALUES (?,?,?,?,?,?,?,1)""", (user_id, typ, amt, dd.isoformat(), ids[acc], cats[cat], desc))
        n += len(rows)

        # --- ahorro mensual y pago de tarjeta
        mstart, transfers = first, 0
        while mstart <= today:
            save_day = mstart.replace(day=min(20, monthrange(mstart.year, mstart.month)[1]))
            if save_day <= today:
                amt = 280000 + transfers * 15000
                db.execute("""INSERT INTO transactions (user_id,type,amount,to_amount,date,account_id,to_account_id,description,is_demo)
                              VALUES (?,'transfer',?,?,?,?,?,?,1)""", (user_id, amt, amt, save_day.isoformat(), ids["bank"], ids["sav"], "Ahorro mensual"))
                n += 1; transfers += 1
            pay_day = mstart.replace(day=min(27, monthrange(mstart.year, mstart.month)[1]))
            if pay_day <= today and mstart > first:
                db.execute("""INSERT INTO transactions (user_id,type,amount,to_amount,date,account_id,to_account_id,description,is_demo)
                              VALUES (?,'transfer',?,?,?,?,?,?,1)""", (user_id, 60000, 60000, pay_day.isoformat(), ids["bank"], ids["card"], "Pago de tarjeta Visa"))
                n += 1
            cash_day = mstart.replace(day=min(10, monthrange(mstart.year, mstart.month)[1]))
            if cash_day <= today:
                db.execute("""INSERT INTO transactions (user_id,type,amount,to_amount,date,account_id,to_account_id,description,is_demo)
                              VALUES (?,'transfer',?,?,?,?,?,?,1)""", (user_id, 320000, 320000, cash_day.isoformat(), ids["bank"], ids["cash"], "Retiro de efectivo"))
                n += 1
            mstart = (mstart.replace(day=28) + timedelta(days=4)).replace(day=1)

        # --- deuda de ejemplo con abonos mensuales
        debt_id = db.execute("""INSERT INTO debts (user_id,name,creditor,currency,principal,interest_rate,start_date,monthly_payment,due_day,notes,is_demo)
                                VALUES (?,?,?,?,?,?,?,?,?,?,1)""",
                             (user_id, "[DEMO] Préstamo auto", "Banco Demo", cur, 8000000, 13.5, start, 250000, 10, "Ejemplo de demostración")).lastrowid
        mstart = first
        while mstart <= today:
            pd = mstart.replace(day=min(10, monthrange(mstart.year, mstart.month)[1]))
            if pd <= today and mstart > first:
                db.execute("INSERT INTO debt_payments (user_id,debt_id,date,principal_part,interest_part,notes) VALUES (?,?,?,?,?,?)",
                          (user_id, debt_id, pd.isoformat(), 218000, 32000, "Abono mensual"))
                n += 1
            mstart = (mstart.replace(day=28) + timedelta(days=4)).replace(day=1)

        # --- tarjeta: una compra a meses sin intereses y cargos recurrentes de ejemplo
        buy_day = today - timedelta(days=75)
        pantalla = 1199900
        tid = db.execute("""INSERT INTO transactions (user_id,type,amount,date,account_id,category_id,description,is_demo)
                            VALUES (?,'expense',?,?,?,?,?,1)""", (user_id, pantalla, buy_day.isoformat(), ids["card"], cats["[DEMO] Entretenimiento"], "Pantalla 55 pulgadas")).lastrowid
        n += 1
        db.execute("""INSERT INTO card_plans (user_id,account_id,kind,description,monthly_amount,months_total,months_remaining,principal_remaining,interest_rate,start_date,transaction_id,is_demo)
                      VALUES (?,?,'msi',?,?,12,12,?,0,?,?,1)""", (user_id, ids["card"], "Pantalla 55 pulgadas", (pantalla + 6) // 12, pantalla, buy_day.isoformat(), tid))
        for desc, amt, acc_key, cat_name, ahead in (("Netflix", 21900, "card", "[DEMO] Suscripciones", 6), ("Spotify", 12900, "card", "[DEMO] Suscripciones", 13),
                                                    ("Plan de teléfono", 39900, "card", "[DEMO] Servicios", 20)):
            nd = today + timedelta(days=ahead)
            db.execute("""INSERT INTO recurring (user_id,account_id,category_id,description,amount,frequency,anchor_day,next_date,is_demo)
                          VALUES (?,?,?,?,?,'monthly',?,?,1)""", (user_id, ids[acc_key], cats[cat_name], desc, amt, nd.day, nd.isoformat()))

        # --- presupuestos
        for cname, amount in (("[DEMO] Comida", 900000), ("[DEMO] Entretenimiento", 350000), ("[DEMO] Transporte", 250000)):
            db.execute("INSERT INTO budgets (user_id, category_id, amount) VALUES (?,?,?) ON CONFLICT(user_id, category_id) DO UPDATE SET amount=excluded.amount",
                      (user_id, cats[cname], amount))

        # --- metas de ahorro
        g1 = db.execute("INSERT INTO goals (user_id,name,target,target_date,currency,notes,is_demo) VALUES (?,?,?,?,?,?,1)",
                        (user_id, "[DEMO] Fondo de emergencia", 5000000, (today + timedelta(days=150)).isoformat(), cur, "")).lastrowid
        g2 = db.execute("INSERT INTO goals (user_id,name,target,target_date,currency,notes,is_demo) VALUES (?,?,?,?,?,?,1)",
                        (user_id, "[DEMO] Vacaciones", 2000000, (today + timedelta(days=240)).isoformat(), cur, "")).lastrowid
        mstart, k = first, 0
        while mstart <= today:
            cd = mstart.replace(day=min(18, monthrange(mstart.year, mstart.month)[1]))
            if cd <= today:
                db.execute("INSERT INTO goal_contribs (user_id,goal_id,date,amount,notes) VALUES (?,?,?,?,?)", (user_id, g1, cd.isoformat(), 320000, ""))
                n += 1
                if k % 2 == 0:
                    db.execute("INSERT INTO goal_contribs (user_id,goal_id,date,amount,notes) VALUES (?,?,?,?,?)", (user_id, g2, cd.isoformat(), 150000, ""))
                    n += 1
            mstart = (mstart.replace(day=28) + timedelta(days=4)).replace(day=1); k += 1

        # --- portafolio de ejemplo (símbolos sintéticos: nunca se consultan en Yahoo)
        for sym, name, atype, buys, unit_cost in ((DEMO_SYMBOLS[0], "Demo Acciones SA", "stock", 4, 18000), (DEMO_SYMBOLS[1], "Demo Fondo Índice", "etf", 3, 42000)):
            mstart, done = first, 0
            while mstart <= today and done < buys:
                bd = mstart.replace(day=min(12, monthrange(mstart.year, mstart.month)[1]))
                if bd <= today:
                    qty = "10" if atype == "stock" else "5"
                    gross = unit_cost * (10 if atype == "stock" else 5)
                    db.execute("""INSERT INTO holding_ops (user_id,symbol,name,asset_type,kind,quantity,price,gross,fee,currency,date,account_id,notes,is_demo)
                                  VALUES (?,?,?,?,'buy',?,?,?,0,?,?,?,'',1)""",
                              (user_id, sym, name, atype, qty, str(unit_cost / 100), gross, cur, bd.isoformat(), ids["inv"]))
                    n += 1; done += 1
                mstart = (mstart.replace(day=28) + timedelta(days=4)).replace(day=1)
            price = round(unit_cost * 1.15)
            now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            db.execute("""INSERT INTO quotes (symbol, name, currency, price, prev_close, source, price_time, updated_at, last_attempt, last_error)
                          VALUES (?,?,?,?,?,'manual',?,?,?,'') ON CONFLICT(symbol) DO UPDATE SET price=excluded.price, prev_close=excluded.prev_close""",
                      (sym, name, cur, price / 100, price / 100 * 0.98, now, now, now))

        # --- vigilancia de ejemplo (símbolos reales: sin precio hasta que se actualicen de verdad,
        # aquí solo se guardan tus datos; nunca se inventa un precio)
        for sym, company, entry, exit_p, days_ahead in (
            ("GOOGL", "Alphabet Inc.", 330, 400, 15), ("META", "Meta Platforms, Inc.", 510, 650, 16),
            ("MELI", "MercadoLibre, Inc.", 1750, 1960, 23), ("OSCR", "Oscar Health, Inc.", 25.5, 35, 29)):
            db.execute("""INSERT INTO watchlist (user_id, symbol, company, report_date, entry_price, exit_price, is_demo)
                          VALUES (?,?,?,?,?,?,1)""",
                      (user_id, sym, company, (today + timedelta(days=days_ahead)).isoformat(), entry, exit_p))
            n += 1

        return n


def delete_demo(db, user_id):
    with atomic(db):
        acc_ids = [r["id"] for r in db.execute("SELECT id FROM accounts WHERE user_id=? AND is_demo=1", (user_id,))]
        # Protección: nunca se borran movimientos reales. Si alguno usa una cuenta demo, se pide resolverlo antes.
        for aid in acc_ids:
            real = db.execute("SELECT COUNT(*) FROM transactions WHERE user_id=? AND is_demo=0 AND (account_id=? OR to_account_id=?)",
                              (user_id, aid, aid)).fetchone()[0]
            if real:
                raise ValidationError("Hay movimientos reales que usan cuentas de demostración. "
                                      "Edítalos o elimínalos primero para no perder tu información real.")
        for r in db.execute("SELECT id FROM recurring WHERE user_id=? AND is_demo=1", (user_id,)).fetchall():
            db.execute("DELETE FROM notifications WHERE user_id=? AND (dedupe_key LIKE ? OR dedupe_key LIKE ?)", (user_id, f"rec:{r[0]}:%", f"rec-paused:{r[0]}:%"))
        db.execute("DELETE FROM recurring WHERE user_id=? AND is_demo=1", (user_id,))
        db.execute("DELETE FROM card_plans WHERE user_id=? AND is_demo=1", (user_id,))
        n = db.execute("DELETE FROM transactions WHERE user_id=? AND is_demo=1", (user_id,)).rowcount
        for aid in acc_ids:
            db.execute("DELETE FROM notifications WHERE user_id=? AND dedupe_key LIKE ?", (user_id, f"card:{aid}:%"))
        db.execute("DELETE FROM debt_payments WHERE user_id=? AND debt_id IN (SELECT id FROM debts WHERE user_id=? AND is_demo=1)", (user_id, user_id))
        db.execute("DELETE FROM debts WHERE user_id=? AND is_demo=1", (user_id,))
        db.execute("DELETE FROM goal_contribs WHERE user_id=? AND goal_id IN (SELECT id FROM goals WHERE user_id=? AND is_demo=1)", (user_id, user_id))
        db.execute("DELETE FROM goals WHERE user_id=? AND is_demo=1", (user_id,))
        demo_syms = [r["symbol"] for r in db.execute("SELECT DISTINCT symbol FROM holding_ops WHERE user_id=? AND is_demo=1", (user_id,))]
        db.execute("DELETE FROM holding_ops WHERE user_id=? AND is_demo=1", (user_id,))
        for sym in demo_syms:
            db.execute("DELETE FROM quotes WHERE symbol=? AND NOT EXISTS (SELECT 1 FROM holding_ops WHERE symbol=?)", (sym, sym))
        db.execute("DELETE FROM watchlist WHERE user_id=? AND is_demo=1", (user_id,))  # deja la cotización en caché: son símbolos reales (GOOGL, META...) útiles si vuelves a vigilarlos
        db.execute("DELETE FROM accounts WHERE user_id=? AND is_demo=1", (user_id,))
        db.execute("DELETE FROM budgets WHERE user_id=? AND category_id IN (SELECT id FROM categories WHERE user_id=? AND is_demo=1)", (user_id, user_id))
        db.execute("UPDATE transactions SET category_id=NULL WHERE user_id=? AND category_id IN (SELECT id FROM categories WHERE user_id=? AND is_demo=1)", (user_id, user_id))
        db.execute("DELETE FROM categories WHERE user_id=? AND is_demo=1", (user_id,))
        return n
