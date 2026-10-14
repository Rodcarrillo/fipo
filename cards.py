"""Tarjetas de crédito: planes a meses (MSI, meses con intereses, saldo diferido) y cargos recurrentes.

Reglas (las mismas del resto de FIPO: saldos reconstruibles con saldo inicial + movimientos, nada inventado):
- El capital de un plan YA está dentro del saldo de la tarjeta (por el saldo inicial o por la compra ligada).
  El plan solo dice qué parte todavía NO entra al estado de cuenta: cada fecha de corte entra una mensualidad.
- "Pago del mes" = saldo al último corte − capital a meses que aún no se cobraba en ese corte − pagos desde el corte.
- En los planes con intereses, la parte de interés de cada mensualidad (mensualidad − capital) se registra como un
  gasto real "Intereses de tarjeta" en la fecha de corte, una sola vez (tabla card_plan_charges).
- Los cargos recurrentes se registran solos como gasto el día que toca (y se ponen al día si pasaron varios).
"""
from calendar import monthrange
from datetime import date, timedelta

from flask import jsonify, request

import ledger
from db import atomic, get_db
from ledger import ValidationError, clean_text, owned, parse_date, to_cents, today_for

KINDS = {"msi": "Meses sin intereses", "mci": "Meses con intereses", "diferido": "Saldo diferido"}
FREQS = {"weekly": "Cada semana", "monthly": "Cada mes", "yearly": "Cada año"}
INTEREST_CATEGORY = "Intereses de tarjeta"
MAX_CATCHUP = 60                  # tope de cargos recurrentes que se ponen al día de una vez


def money_str(cents):
    sign = "-" if cents < 0 else ""
    c = abs(cents)
    return f"{sign}{c // 100}.{c % 100:02d}"


def clamp_day(y, m, day):
    return date(y, m, min(day, monthrange(y, m)[1]))


def add_months(d, n, anchor_day):
    m0 = d.month - 1 + n
    return clamp_day(d.year + m0 // 12, m0 % 12 + 1, anchor_day)


def cuts_between(start, end, cut_day):
    """Fechas de corte c con start < c <= end."""
    if not cut_day or end <= start:
        return []
    out, y, m = [], start.year, start.month
    while True:
        c = clamp_day(y, m, cut_day)
        if c > end:
            return out
        if c > start:
            out.append(c)
        m += 1
        if m > 12:
            m, y = 1, y + 1


def nth_cut_after(start, cut_day, n):
    """La n-ésima fecha de corte posterior a start (n >= 1)."""
    y, m, found = start.year, start.month, 0
    while True:
        c = clamp_day(y, m, cut_day)
        if c > start:
            found += 1
            if found == n:
                return c
        m += 1
        if m > 12:
            m, y = 1, y + 1


# ------------------------------------------------------------------ planes a meses
def plan_state(p, cut_day, as_of):
    """Estado de un plan en una fecha: mensualidades cobradas desde que se registró, capital pendiente, etc."""
    m, principal = p["months_remaining"], p["principal_remaining"]
    start = date.fromisoformat(p["start_date"])
    billed = min(len(cuts_between(start, as_of, cut_day)), m) if cut_day else 0
    base = principal // m
    remaining = 0 if billed >= m else principal - base * billed
    interest = max(0, p["monthly_amount"] - base) if p["kind"] != "msi" else 0
    return {
        "billed": billed, "remaining_principal": remaining, "base": base, "interest_per_installment": interest,
        "left": m - billed, "done": (p["months_total"] - m) + billed,
        "next_date": nth_cut_after(start, cut_day, billed + 1).isoformat() if cut_day and billed < m else None,
        "end_date": nth_cut_after(start, cut_day, m).isoformat() if cut_day else None,
    }


def plan_row(p, cut_day, today):
    st = plan_state(p, cut_day, today)
    return {"id": p["id"], "account_id": p["account_id"], "kind": p["kind"], "kind_label": KINDS[p["kind"]],
            "description": p["description"], "monthly_amount": p["monthly_amount"], "months_total": p["months_total"],
            "installments_done": st["done"], "months_left": st["left"], "principal_left": st["remaining_principal"],
            "interest_per_installment": st["interest_per_installment"], "interest_rate": p["interest_rate"],
            "next_date": st["next_date"], "end_date": st["end_date"], "finished": st["left"] == 0,
            "transaction_id": p["transaction_id"], "start_date": p["start_date"], "is_demo": bool(p["is_demo"])}


def plans_for(db, uid, account_id):
    return db.execute("SELECT * FROM card_plans WHERE user_id=? AND account_id=? ORDER BY start_date, id", (uid, account_id)).fetchall()


def card_extras(db, uid, a, today, last_cut):
    """Lo que la tarjeta necesita de sus planes: capital a meses aún no cobrado al último corte y hoy."""
    plans = plans_for(db, uid, a["id"])
    cut = a["cut_day"]
    deferred_at_cut = 0
    if last_cut:
        for p in plans:
            if p["transaction_id"] is not None and p["start_date"] > last_cut.isoformat():
                continue                          # compra hecha después del corte: aún no estaba en ese saldo
            deferred_at_cut += plan_state(p, cut, last_cut)["remaining_principal"]
    rows = [plan_row(p, cut, today) for p in plans]
    active = [r for r in rows if not r["finished"]]
    return {"plans": rows, "deferred_at_cut": deferred_at_cut, "deferred_now": sum(r["principal_left"] for r in active),
            "installments_monthly": sum(r["monthly_amount"] for r in active)}


def parse_plan(d, cut_day, field_prefix=""):
    """Valida un plan que YA traías (al dar de alta la tarjeta o desde la tarjeta). Regresa un dict listo para insertar."""
    f = lambda k: field_prefix + k
    if not cut_day:
        raise ValidationError("Para usar meses, primero indica el día de corte de la tarjeta.", "cut_day")
    kind = d.get("kind")
    if kind not in KINDS:
        raise ValidationError("Elige el tipo de plan.", f("kind"))
    monthly = to_cents(d.get("monthly_amount"), f("monthly_amount"))
    try:
        total = int(d.get("months_total") or 0)
        left = int(d.get("months_remaining") or 0)
    except (TypeError, ValueError):
        raise ValidationError("Los meses deben ser números enteros.", f("months_remaining"))
    if not 1 <= total <= 120:
        raise ValidationError("El plazo debe ser de 1 a 120 meses.", f("months_total"))
    if not 1 <= left <= total:
        raise ValidationError("Los meses que faltan deben estar entre 1 y el plazo total.", f("months_remaining"))
    top = monthly * left
    raw = d.get("principal_remaining")
    if kind == "msi" or raw in (None, ""):
        principal = top                     # MSI: sin intereses, el capital pendiente es mensualidad × meses que faltan
    else:
        principal = to_cents(raw, f("principal_remaining"))
        if principal > top:
            raise ValidationError("El saldo pendiente no puede ser mayor que mensualidad × meses que faltan.", f("principal_remaining"))
    try:
        rate = float(d.get("interest_rate") or 0) if kind != "msi" else 0.0
    except (TypeError, ValueError):
        raise ValidationError("La tasa debe ser un número.", f("interest_rate"))
    if not 0 <= rate <= 1000:
        raise ValidationError("La tasa debe estar entre 0 y 1000.", f("interest_rate"))
    desc = clean_text(d.get("description"), f("description"), 80) or KINDS[kind]
    return {"kind": kind, "description": desc, "monthly_amount": monthly, "months_total": total, "months_remaining": left,
            "principal_remaining": principal, "interest_rate": rate}


def insert_plan(db, uid, account_id, p, start_date, transaction_id=None, is_demo=0):
    return db.execute("""INSERT INTO card_plans (user_id, account_id, kind, description, monthly_amount, months_total, months_remaining,
                         principal_remaining, interest_rate, start_date, transaction_id, is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                      (uid, account_id, p["kind"], p["description"], p["monthly_amount"], p["months_total"], p["months_remaining"],
                       p["principal_remaining"], p["interest_rate"], start_date, transaction_id, is_demo)).lastrowid


def parse_purchase_plan(spec, amount, account):
    """Compra nueva a meses: {kind: msi|mci, months, monthly_amount (solo mci), interest_rate}."""
    if account["type"] != "credit":
        raise ValidationError("Solo las compras con tarjeta de crédito pueden ser a meses.", "installments")
    if not account["cut_day"]:
        raise ValidationError("Para comprar a meses, indica primero el día de corte de la tarjeta (edítala en Cuentas).", "installments")
    kind = spec.get("kind")
    if kind not in ("msi", "mci"):
        raise ValidationError("Elige meses sin intereses o con intereses.", "installments")
    try:
        n = int(spec.get("months") or 0)
    except (TypeError, ValueError):
        raise ValidationError("Elige a cuántos meses.", "installments")
    if not 2 <= n <= 60:
        raise ValidationError("Elige entre 2 y 60 meses.", "installments")
    if kind == "msi":
        monthly, rate = (amount + n // 2) // n, 0.0
    else:
        monthly = to_cents(spec.get("monthly_amount"), "monthly_amount")
        if monthly * n < amount:
            raise ValidationError("Con intereses, la mensualidad × meses no puede ser menor que el importe de la compra.", "monthly_amount")
        try:
            rate = float(spec.get("interest_rate") or 0)
        except (TypeError, ValueError):
            raise ValidationError("La tasa debe ser un número.", "interest_rate")
    return {"kind": kind, "description": "", "monthly_amount": monthly, "months_total": n, "months_remaining": n,
            "principal_remaining": amount, "interest_rate": rate}


def attach_purchase_plan(db, uid, tx_id, spec, is_demo=0):
    """Liga (o reemplaza) el plan a meses de una compra. spec None/{} = una sola exhibición."""
    t = db.execute("SELECT * FROM transactions WHERE id=? AND user_id=?", (tx_id, uid)).fetchone()
    db.execute("DELETE FROM card_plans WHERE transaction_id=? AND user_id=?", (tx_id, uid))
    if not spec or not spec.get("kind"):
        return None
    if t["type"] != "expense":
        raise ValidationError("Solo los gastos pueden ser a meses.", "installments")
    acc = db.execute("SELECT * FROM accounts WHERE id=?", (t["account_id"],)).fetchone()
    p = parse_purchase_plan(spec, t["amount"], acc)
    p["description"] = (t["description"] or "Compra")[:80]
    return insert_plan(db, uid, acc["id"], p, t["date"], tx_id, is_demo or t["is_demo"])


def spec_differs(db, uid, tx_id, spec):
    """¿La forma de pago pedida es distinta al plan que ya tiene la compra?"""
    p = db.execute("SELECT * FROM card_plans WHERE transaction_id=? AND user_id=?", (tx_id, uid)).fetchone()
    want = spec.get("kind") if spec else None
    if not p or not want:
        return bool(p) != bool(want)
    if want != p["kind"] or str(spec.get("months")) != str(p["months_total"]):
        return True
    return want == "mci" and to_cents(spec.get("monthly_amount") or 0, "monthly_amount", allow_zero=True) != p["monthly_amount"]


def purchase_plan_guard(db, uid, existing, new_tx, spec_given):
    """Antes de editar una compra a meses: si ya se cobró alguna mensualidad no se puede cambiar lo que la define."""
    p = db.execute("SELECT * FROM card_plans WHERE transaction_id=? AND user_id=?", (existing["id"], uid)).fetchone()
    if not p:
        return
    acc = db.execute("SELECT cut_day, timezone FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=?", (p["account_id"],)).fetchone()
    billed = plan_state(p, acc["cut_day"], today_for(acc["timezone"]))["billed"]
    changed = (new_tx["amount"] != existing["amount"] or new_tx["account_id"] != existing["account_id"]
               or new_tx["date"] != existing["date"] or new_tx["type"] != existing["type"] or spec_given)
    if billed and changed:
        raise ValidationError("Esta compra a meses ya tiene mensualidades en tus estados de cuenta; para cambiar el importe, la fecha, la tarjeta o los meses, bórrala y regístrala de nuevo.", "amount")


def resync_purchase_plan(db, uid, tx_id):
    """Tras editar una compra a meses sin mensualidades cobradas: el plan sigue a la compra (importe, fecha, tarjeta)."""
    p = db.execute("SELECT * FROM card_plans WHERE transaction_id=? AND user_id=?", (tx_id, uid)).fetchone()
    if not p:
        return
    t = db.execute("SELECT * FROM transactions WHERE id=?", (tx_id,)).fetchone()
    acc = db.execute("SELECT * FROM accounts WHERE id=?", (t["account_id"],)).fetchone()
    if t["type"] != "expense" or acc["type"] != "credit":
        db.execute("DELETE FROM card_plans WHERE id=?", (p["id"],))
        return
    monthly = (t["amount"] + p["months_total"] // 2) // p["months_total"] if p["kind"] == "msi" else max(p["monthly_amount"], -(-t["amount"] // p["months_total"]))
    db.execute("UPDATE card_plans SET account_id=?, principal_remaining=?, monthly_amount=?, start_date=?, description=? WHERE id=?",
               (acc["id"], t["amount"], monthly, t["date"], (t["description"] or "Compra")[:80], p["id"]))


def before_delete_tx(db, uid, tx_id):
    """Al borrar una compra a meses se borran también los intereses que FIPO le había registrado."""
    for r in db.execute("""SELECT c.transaction_id FROM card_plan_charges c JOIN card_plans p ON p.id=c.plan_id
                           WHERE p.transaction_id=? AND p.user_id=? AND c.transaction_id IS NOT NULL""", (tx_id, uid)).fetchall():
        db.execute("DELETE FROM transactions WHERE id=? AND user_id=?", (r[0], uid))


def interest_category(db, uid):
    r = db.execute("SELECT id FROM categories WHERE user_id=? AND kind='expense' AND name=? AND archived=0", (uid, INTEREST_CATEGORY)).fetchone()
    if r:
        return r[0]
    return db.execute("INSERT INTO categories (user_id, name, kind) VALUES (?,?, 'expense')", (uid, INTEREST_CATEGORY)).lastrowid


# ------------------------------------------------------------------ cargos recurrentes
def next_occurrence(d, freq, anchor):
    if freq == "weekly":
        return d + timedelta(days=7)
    return add_months(d, 12 if freq == "yearly" else 1, anchor)


def recurring_row(r):
    monthly = r["amount"] * (52 / 12 if r["frequency"] == "weekly" else 1 / 12 if r["frequency"] == "yearly" else 1)
    return {"id": r["id"], "description": r["description"], "amount": r["amount"], "frequency": r["frequency"],
            "frequency_label": FREQS[r["frequency"]], "next_date": r["next_date"], "active": bool(r["active"]),
            "account_id": r["account_id"], "account_name": r["account_name"], "account_type": r["account_type"], "currency": r["currency"],
            "category_id": r["category_id"], "category_name": r["category_name"], "monthly_equivalent": round(monthly), "is_demo": bool(r["is_demo"])}


RECURRING_SELECT = """SELECT r.*, a.name AS account_name, a.type AS account_type, a.currency AS currency, c.name AS category_name
                      FROM recurring r JOIN accounts a ON a.id=r.account_id LEFT JOIN categories c ON c.id=r.category_id"""


def parse_recurring(db, uid, d, cur=None):
    g = lambda k: d.get(k, cur[k] if cur else None)
    desc = clean_text(g("description"), "description", 80, required=True)
    amount = to_cents(d.get("amount", (cur["amount"] / 100) if cur else None), "amount")
    acc = owned(db, "accounts", g("account_id"), uid)
    if not acc:
        raise ValidationError("Elige la cuenta o tarjeta donde se cobra.", "account_id")
    if acc["archived"] and not (cur and cur["account_id"] == acc["id"]):
        raise ValidationError("Esa cuenta está archivada.", "account_id")
    cat = None
    if g("category_id") not in (None, ""):
        c = owned(db, "categories", g("category_id"), uid)
        if not c or c["kind"] != "expense":
            raise ValidationError("Elige una categoría de gasto.", "category_id")
        cat = c["id"]
    freq = g("frequency")
    if freq not in FREQS:
        raise ValidationError("Elige cada cuánto se cobra.", "frequency")
    nd = parse_date(g("next_date"), "next_date")
    return {"description": desc, "amount": amount, "account_id": acc["id"], "category_id": cat, "frequency": freq,
            "next_date": nd, "anchor_day": date.fromisoformat(nd).day}


# ------------------------------------------------------------------ poner al día (se llama en cada petición)
def materialize(db, u):
    """Registra lo que ya tocaba: intereses de planes con intereses y cargos recurrentes vencidos. Idempotente."""
    uid, today = u["id"], today_for(u["timezone"])
    t_iso = today.isoformat()
    due_rec = db.execute("SELECT 1 FROM recurring WHERE user_id=? AND active=1 AND next_date<=? LIMIT 1", (uid, t_iso)).fetchone()
    plans = db.execute("""SELECT p.*, a.cut_day AS cut_day FROM card_plans p JOIN accounts a ON a.id=p.account_id
                          WHERE p.user_id=? AND p.kind!='msi' AND a.cut_day>0""", (uid,)).fetchall()
    pending = []
    for p in plans:
        st = plan_state(p, p["cut_day"], today)
        if not st["interest_per_installment"] or not st["billed"]:
            continue
        cuts = cuts_between(date.fromisoformat(p["start_date"]), today, p["cut_day"])[:st["billed"]]
        last = db.execute("SELECT MAX(cut_date) FROM card_plan_charges WHERE plan_id=?", (p["id"],)).fetchone()[0]
        done = db.execute("SELECT COUNT(*) FROM card_plan_charges WHERE plan_id=?", (p["id"],)).fetchone()[0]
        for i, c in enumerate(cuts):
            if (last is None or c.isoformat() > last) and done < st["billed"]:
                pending.append((p, c, (p["months_total"] - p["months_remaining"]) + i + 1, st["interest_per_installment"]))
                done += 1
    if not due_rec and not pending:
        return 0
    posted = 0
    with atomic(db):
        if pending:
            cat = interest_category(db, uid)
            for p, c, k, interest in pending:
                tid = None
                try:
                    tid = ledger.insert_tx(db, uid, {"type": "expense", "amount": money_str(interest), "date": c.isoformat(),
                                                     "account_id": p["account_id"], "category_id": cat,
                                                     "description": f"Intereses · {p['description']} ({k}/{p['months_total']})",
                                                     "notes": "Registrado por FIPO al corte: parte de intereses de la mensualidad."}, is_demo=p["is_demo"])
                    posted += 1
                except ValidationError:
                    pass                               # p. ej. tarjeta archivada: no se inventa nada, se marca como revisado
                db.execute("INSERT OR IGNORE INTO card_plan_charges (plan_id, cut_date, transaction_id) VALUES (?,?,?)", (p["id"], c.isoformat(), tid))
        if due_rec:
            posted += _run_recurring(db, u, today)
    return posted


def _run_recurring(db, u, today):
    import notify                                      # import tardío: notify importa more, que importa cards
    uid, posted = u["id"], 0
    rules = db.execute(RECURRING_SELECT + " WHERE r.user_id=? AND r.active=1 AND r.next_date<=?", (uid, today.isoformat())).fetchall()
    for r in rules:
        d, n = date.fromisoformat(r["next_date"]), 0
        acc = db.execute("SELECT * FROM accounts WHERE id=?", (r["account_id"],)).fetchone()
        if acc["archived"]:
            db.execute("UPDATE recurring SET active=0 WHERE id=?", (r["id"],))
            notify.add(db, uid, "recurring", f"Pausé «{r['description']}»", f"La cuenta {acc['name']} está archivada; elige otra para seguir registrándolo.",
                       "#/recurring", f"rec-paused:{r['id']}:{d.isoformat()}")
            continue
        cat = r["category_id"]
        if cat and db.execute("SELECT archived FROM categories WHERE id=?", (cat,)).fetchone()[0]:
            cat = None
        while d <= today and n < MAX_CATCHUP:
            ledger.insert_tx(db, uid, {"type": "expense", "amount": money_str(r["amount"]), "date": d.isoformat(), "account_id": r["account_id"],
                                       "category_id": cat, "description": r["description"], "recurring": 1,
                                       "notes": "Cargo recurrente registrado automáticamente por FIPO."}, is_demo=r["is_demo"])
            notify.add(db, uid, "recurring", f"Se registró {r['description']}", f"{notify._money(r['amount'], acc['currency'])} en {acc['name']} ({d.isoformat()}).",
                       "#/movements", f"rec:{r['id']}:{d.isoformat()}")
            d, n, posted = next_occurrence(d, r["frequency"], r["anchor_day"]), n + 1, posted + 1
        db.execute("UPDATE recurring SET next_date=? WHERE id=?", (d.isoformat(), r["id"]))
    return posted


# ------------------------------------------------------------------ rutas
def register(app, login_required, current_user, json_body, api_error):
    @app.before_request
    def _catch_up():
        if not request.path.startswith("/api/") or request.path.startswith("/api/auth/"):
            return
        u = current_user()
        if not u:
            return
        try:
            materialize(get_db(), u)
        except Exception:                                  # nunca tumbar la app por esto; se reintenta en la siguiente petición
            app.logger.exception("No se pudieron registrar cargos automáticos")
            if app.config.get("TESTING"):
                raise

    def card_or_404(db, uid, aid):
        a = owned(db, "accounts", aid, uid)
        if not a or a["type"] != "credit":
            raise ValidationError("Tarjeta no encontrada.", status=404)
        return a

    @app.post("/api/cards/<int:aid>/plans")
    @login_required
    def plan_create(aid):
        u, d, db = current_user(), json_body(), get_db()
        with atomic(db):
            a = card_or_404(db, u["id"], aid)
            pid = insert_plan(db, u["id"], a["id"], parse_plan(d, a["cut_day"]), today_for(u["timezone"]).isoformat())
        p = db.execute("SELECT * FROM card_plans WHERE id=?", (pid,)).fetchone()
        return jsonify({"plan": plan_row(p, a["cut_day"], today_for(u["timezone"]))}), 201

    @app.delete("/api/cards/plans/<int:pid>")
    @login_required
    def plan_delete(pid):
        u, db = current_user(), get_db()
        with atomic(db):
            p = owned(db, "card_plans", pid, u["id"])
            if not p:
                raise ValidationError("Plan no encontrado.", status=404)
            db.execute("DELETE FROM card_plans WHERE id=?", (pid,))
        return jsonify({"ok": True})

    @app.get("/api/recurring")
    @login_required
    def recurring_list():
        u, db = current_user(), get_db()
        rows = [recurring_row(r) for r in db.execute(RECURRING_SELECT + " WHERE r.user_id=? ORDER BY r.active DESC, r.next_date, r.id", (u["id"],))]
        total = sum(r["monthly_equivalent"] for r in rows if r["active"] and r["currency"] == u["currency"])
        return jsonify({"items": rows, "currency": u["currency"], "monthly_total": total})

    @app.post("/api/recurring")
    @login_required
    def recurring_create():
        u, d, db = current_user(), json_body(), get_db()
        with atomic(db):
            f = parse_recurring(db, u["id"], d)
            rid = db.execute("""INSERT INTO recurring (user_id, account_id, category_id, description, amount, frequency, anchor_day, next_date)
                                VALUES (?,?,?,?,?,?,?,?)""", (u["id"], f["account_id"], f["category_id"], f["description"], f["amount"],
                                                              f["frequency"], f["anchor_day"], f["next_date"])).lastrowid
        materialize(db, u)                             # si la primera fecha ya pasó o es hoy, se registra de una vez
        return jsonify({"item": recurring_row(db.execute(RECURRING_SELECT + " WHERE r.id=?", (rid,)).fetchone())}), 201

    @app.patch("/api/recurring/<int:rid>")
    @login_required
    def recurring_update(rid):
        u, d, db = current_user(), json_body(), get_db()
        with atomic(db):
            cur = owned(db, "recurring", rid, u["id"])
            if not cur:
                raise ValidationError("Cargo no encontrado.", status=404)
            f = parse_recurring(db, u["id"], d, cur)
            active = (1 if d["active"] else 0) if "active" in d else cur["active"]
            db.execute("""UPDATE recurring SET account_id=?, category_id=?, description=?, amount=?, frequency=?, anchor_day=?, next_date=?, active=?
                          WHERE id=? AND user_id=?""", (f["account_id"], f["category_id"], f["description"], f["amount"], f["frequency"],
                                                         f["anchor_day"], f["next_date"], active, rid, u["id"]))
        materialize(db, u)
        return jsonify({"item": recurring_row(db.execute(RECURRING_SELECT + " WHERE r.id=?", (rid,)).fetchone())})

    @app.delete("/api/recurring/<int:rid>")
    @login_required
    def recurring_delete(rid):
        u, db = current_user(), get_db()
        with atomic(db):
            if not owned(db, "recurring", rid, u["id"]):
                raise ValidationError("Cargo no encontrado.", status=404)
            db.execute("DELETE FROM recurring WHERE id=? AND user_id=?", (rid, u["id"]))
        return jsonify({"ok": True})
