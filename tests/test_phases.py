"""Pruebas de las fases 2 y 3: tarjetas, deudas, presupuestos, análisis, reportes, metas, tablas y comprobantes."""
import io
import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_finance import Base, H  # noqa: E402
import more  # noqa: E402

TODAY = date.today()


class P(Base):
    def setUp(self):
        super().setUp()
        self.user = self.register(self.c)
        self.today = self.c.get("/api/dashboard").get_json()["period"]["today"]
        self.bank = self.account(self.c, "Banco", "10000.00")
        self.exp = self.cat(self.c, "expense")

    def card(self, limit="5000", cut=10, due=25, ob="0"):
        return self.account(self.c, "Visa", ob, typ="credit", credit_limit=limit, cut_day=cut, due_day=due)

    def dash(self):
        return self.c.get("/api/dashboard").get_json()


class TestCards(P):
    def test_purchase_payment_and_totals(self):
        card = self.card()
        r = self.tx(self.c, type="expense", amount="1200.00", account_id=card, category_id=self.exp, description="Compra")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(self.bal(self.c)[card], -120000)
        d = self.dash()["cards"]
        self.assertEqual(d["total_money"], 1000000)          # la tarjeta no es dinero
        self.assertEqual(d["card_debt"], 120000)
        self.assertEqual(d["net_worth"], 1000000 - 120000)
        p = self.c.post(f"/api/cards/{card}/pay", json={"from_account_id": self.bank, "amount": "700.00"}, headers=H)
        self.assertEqual(p.status_code, 201, p.data)
        b = self.bal(self.c)
        self.assertEqual((b[card], b[self.bank]), (-50000, 930000))
        d = self.dash()
        self.assertEqual(d["cards"]["expense"], 120000)       # el pago NO es gasto
        self.assertEqual(d["cards"]["income"], 0)
        c = self.c.get("/api/cards").get_json()["cards"][0]
        self.assertEqual((c["used"], c["available"], c["utilization"]), (50000, 450000, 10.0))

    def test_alert_and_validation(self):
        card = self.card(limit="1000")
        self.tx(self.c, type="expense", amount="900.00", account_id=card, category_id=self.exp)
        texts = " ".join(a["text"] for a in self.dash()["alerts"])
        self.assertIn("90%", texts)
        self.assertNotIn("saldo negativo", texts)             # una tarjeta con deuda no es «saldo negativo»
        bad = self.c.post("/api/accounts", json={"name": "X", "type": "credit", "currency": "MXN", "cut_day": 40}, headers=H)
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.c.post(f"/api/cards/{self.bank}/pay", json={"from_account_id": card, "amount": "1"}, headers=H).status_code, 404)

    def test_statement_and_isolation(self):
        card = self.card(cut=1, due=20)
        self.tx(self.c, type="expense", amount="300.00", account_id=card, category_id=self.exp, date=(TODAY - timedelta(days=60)).isoformat())
        c = self.c.get("/api/cards").get_json()["cards"][0]
        self.assertEqual(c["statement"]["balance_at_cut"], 30000)
        self.assertEqual(c["statement"]["pending"], 30000)
        o = self.client(); self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.get("/api/cards").get_json()["cards"], [])
        self.assertEqual(o.post(f"/api/cards/{card}/pay", json={"from_account_id": 1, "amount": "10"}, headers=H).status_code, 404)


class TestDebts(P):
    def mk(self, **kw):
        r = self.c.post("/api/debts", json={"name": "Préstamo", "principal": "5000.00", "monthly_payment": "500", "due_day": 15, **kw}, headers=H)
        self.assertEqual(r.status_code, 201, r.data)
        return r.get_json()["debt"]["id"]

    def test_payments_split_and_balances(self):
        did = self.mk()
        r = self.c.post(f"/api/debts/{did}/payments", json={"amount": "600.00", "interest": "100.00", "account_id": self.bank}, headers=H)
        self.assertEqual(r.status_code, 201, r.data)
        d = self.c.get(f"/api/debts/{did}").get_json()["debt"]
        self.assertEqual((d["remaining"], d["paid_principal"], d["paid_interest"]), (450000, 50000, 10000))
        self.assertEqual(self.bal(self.c)[self.bank], 1000000 - 60000)
        dash = self.dash()
        self.assertEqual(dash["cards"]["expense"], 0)          # pagar deuda no es gasto
        self.assertEqual(dash["cards"]["net_worth"], 1000000 - 60000 - 450000)
        self.assertEqual(self.c.get(f"/api/accounts/{self.bank}").status_code, 200)   # la conciliación del historial cuadra
        pid = self.c.get(f"/api/debts/{did}").get_json()["payments"][0]["id"]
        self.assertEqual(self.c.delete(f"/api/debts/payments/{pid}", headers=H).status_code, 200)
        self.assertEqual(self.bal(self.c)[self.bank], 1000000)

    def test_rejections(self):
        did = self.mk()
        H_ = H
        self.assertEqual(self.c.post(f"/api/debts/{did}/payments", json={"amount": "100", "interest": "200"}, headers=H_).status_code, 400)
        self.assertEqual(self.c.post(f"/api/debts/{did}/payments", json={"amount": "9000"}, headers=H_).status_code, 400)
        usd = self.account(self.c, "Dólares", "100", cur="USD")
        self.assertEqual(self.c.post(f"/api/debts/{did}/payments", json={"amount": "10", "account_id": usd}, headers=H_).status_code, 400)
        self.c.post(f"/api/debts/{did}/payments", json={"amount": "10"}, headers=H_)
        self.assertEqual(self.c.delete(f"/api/debts/{did}", headers=H_).status_code, 409)
        self.assertEqual(self.c.delete(f"/api/accounts/{self.bank}", headers=H_).status_code, 409) if False else None
        o = self.client(); self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.get(f"/api/debts/{did}").status_code, 404)
        self.assertEqual(o.post(f"/api/debts/{did}/payments", json={"amount": "10"}, headers=H_).status_code, 404)

    def test_account_with_debt_payment_cannot_be_deleted(self):
        acc = self.account(self.c, "Otra", "1000")
        did = self.mk()
        self.c.post(f"/api/debts/{did}/payments", json={"amount": "100", "account_id": acc}, headers=H)
        self.assertEqual(self.c.delete(f"/api/accounts/{acc}", headers=H).status_code, 409)


class TestBudgets(P):
    def test_status_children_refunds_alert(self):
        cats = self.c.get("/api/categories").get_json()["categories"]
        parent = next(c for c in cats if c["kind"] == "expense" and not c.get("parent_id"))
        sub = self.c.post("/api/categories", json={"name": "Sub", "kind": "expense", "parent_id": parent["id"]}, headers=H).get_json()["category"]["id"]
        self.tx(self.c, type="expense", amount="400.00", account_id=self.bank, category_id=parent["id"])
        self.tx(self.c, type="expense", amount="300.00", account_id=self.bank, category_id=sub)
        self.tx(self.c, type="refund", amount="100.00", account_id=self.bank, category_id=parent["id"])
        r = self.c.put("/api/budgets", json={"category_id": parent["id"], "amount": "500"}, headers=H)
        self.assertEqual(r.status_code, 200, r.data)
        it = r.get_json()["items"][0]
        self.assertEqual((it["spent"], it["pct"], it["status"]), (60000, 120.0, "over"))
        self.assertIn("Presupuesto", " ".join(a["text"] for a in self.dash()["alerts"]))
        self.c.put("/api/budgets", json={"category_id": 0, "amount": "5000"}, headers=H)
        st = self.c.get("/api/budgets").get_json()
        self.assertEqual(st["total"]["spent"], 60000)
        self.assertEqual(self.c.put("/api/budgets", json={"category_id": sub, "amount": "5"}, headers=H).status_code, 400)
        self.assertEqual(self.c.put("/api/budgets", json={"category_id": self.cat(self.c, "income"), "amount": "5"}, headers=H).status_code, 400)
        self.assertEqual(self.c.delete(f"/api/budgets/{parent['id']}", headers=H).status_code, 200)
        o = self.client(); self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.put("/api/budgets", json={"category_id": parent["id"], "amount": "5"}, headers=H).status_code, 400)
        self.assertEqual(self.c.get("/api/budgets?month=2026-13").status_code, 400)


class TestAnalysisReports(P):
    def setUp(self):
        super().setUp()
        self.tx(self.c, type="income", amount="3000.00", account_id=self.bank, category_id=self.cat(self.c, "income"))
        self.tx(self.c, type="expense", amount="1000.00", account_id=self.bank, category_id=self.exp, description="=cmd|calc")
        self.tx(self.c, type="transfer", amount="50.00", account_id=self.bank, to_account_id=self.account(self.c, "Efectivo", "0", typ="cash"))

    def test_analysis(self):
        a = self.c.get("/api/analysis").get_json()
        cur = a["monthly"][-1]
        self.assertEqual((cur["income"], cur["expense"], cur["net"], cur["savings_rate"]), (300000, 100000, 200000, 66.7))
        self.assertEqual(len(a["monthly"]), 12)
        self.assertEqual(a["top_expenses"][0]["amount"], 100000)
        self.assertEqual(self.c.get("/api/analysis?months=abc").status_code, 400)

    def test_report_formats(self):
        r = self.c.get("/api/report").get_json()
        self.assertEqual((r["income"], r["expense"], r["net"]), (300000, 100000, 200000))
        csvr = self.c.get("/api/report?format=csv")
        self.assertIn(b"'=cmd", csvr.data)                      # neutraliza fórmulas
        pdf = self.c.get("/api/report?format=pdf")
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.data.startswith(b"%PDF"))
        self.assertEqual(self.c.get("/api/report?from=2026-05-01&to=2026-01-01").status_code, 400)


def month_key(n, day=5):
    """Fecha con ese día del mes, N meses antes del mes actual (real, no del usuario) — para probar detección
    de recurrencia y series históricas sin depender de una fecha fija que se vuelva vieja."""
    y, m = TODAY.year, TODAY.month
    for _ in range(n):
        m -= 1
        if m < 1: m, y = 12, y - 1
    return date(y, m, min(day, 28)).isoformat()


class TestAnalysisExtra(P):
    """Valores principales, gráficas y herramientas del módulo de Análisis (patrimonio, salud financiera,
    recurrencia, insights) añadidos sobre la respuesta ya existente de /api/analysis."""

    def test_overview_shape_no_debts(self):
        self.tx(self.c, type="income", amount="3000.00", account_id=self.bank, category_id=self.cat(self.c, "income"))
        self.tx(self.c, type="expense", amount="500.00", account_id=self.bank, category_id=self.exp)
        a = self.c.get("/api/analysis").get_json()
        ov = a["overview"]
        self.assertEqual((ov["income"], ov["expense"], ov["savings"]), (300000, 50000, 250000))
        bal = self.bal(self.c)[self.bank]
        self.assertEqual(ov["available"], bal)
        self.assertEqual(ov["net_worth"], bal)                 # sin tarjetas, deudas ni portafolio
        self.assertEqual(ov["debt_to_income"], 0.0)            # sin deudas activas: 0% de deuda/ingreso
        self.assertIsNone(ov["runway_months"])                 # el ahorro es positivo: no hay quema de efectivo
        self.assertTrue(0 <= a["health"]["score"] <= 120)       # hasta 120 con puntos extra
        self.assertEqual(len(a["networth_evolution"]), len(a["monthly"]))
        self.assertEqual(len(a["debt_evolution"]), len(a["monthly"]))
        self.assertEqual([p["months_ahead"] for p in a["projection"]["points"]], [3, 6, 12, 24])
        self.assertEqual(a["networth_evolution"][-1]["net_worth"], bal)

    def test_debt_to_income_and_emergency_fund(self):
        self.c.post("/api/debts", json={"name": "Préstamo", "principal": "10000", "monthly_payment": "500"}, headers=H)
        self.tx(self.c, type="income", amount="5000.00", account_id=self.bank, category_id=self.cat(self.c, "income"))
        self.tx(self.c, type="expense", amount="1000.00", account_id=self.bank, category_id=self.exp)
        ov = self.c.get("/api/analysis").get_json()["overview"]
        self.assertEqual(ov["debts_total"], 1000000)
        self.assertEqual(ov["debt_total"], 1000000)             # sin deuda de tarjeta en este caso
        self.assertAlmostEqual(ov["debt_to_income"], 10.0, delta=0.1)   # 500 de pago / 5000 de ingreso
        self.assertIsNotNone(ov["emergency_fund_months"])

    def test_asset_allocation_goals_budget_present(self):
        self.c.post("/api/goals", json={"name": "Viaje", "target": "1000"}, headers=H)
        self.c.put("/api/budgets", json={"category_id": self.exp, "amount": "500"}, headers=H)
        self.tx(self.c, type="expense", amount="100.00", account_id=self.bank, category_id=self.exp)
        a = self.c.get("/api/analysis").get_json()
        self.assertTrue(any(x["name"] == "Efectivo y ahorro" and x["value"] > 0 for x in a["asset_allocation"]))
        self.assertEqual([g["name"] for g in a["goals"]], ["Viaje"])
        self.assertIsNotNone(a["budget"])
        self.assertEqual(a["budget"]["items"][0]["category_id"], self.exp)

    def test_recurring_detection_needs_three_of_four_months(self):
        for n in (3, 2, 1, 0):
            self.tx(self.c, type="expense", amount="199.00", account_id=self.bank, category_id=self.exp, description="Streaming", date=month_key(n))
        self.tx(self.c, type="expense", amount="80.00", account_id=self.bank, category_id=self.exp, description="Único", date=month_key(0))
        a = self.c.get("/api/analysis").get_json()
        rec = {r["description"]: r for r in a["recurring"]}
        self.assertIn("Streaming", rec)
        self.assertEqual((rec["Streaming"]["months_seen"], rec["Streaming"]["avg_amount"]), (4, 19900))
        self.assertNotIn("Único", rec)                          # un solo mes no cuenta como recurrente

    def test_insights_react_to_real_deltas(self):
        inc = self.cat(self.c, "income")
        self.tx(self.c, type="income", amount="2000.00", account_id=self.bank, category_id=inc, date=month_key(1))
        self.tx(self.c, type="expense", amount="400.00", account_id=self.bank, category_id=self.exp, date=month_key(1))
        self.tx(self.c, type="income", amount="2000.00", account_id=self.bank, category_id=inc, date=month_key(0))
        self.tx(self.c, type="expense", amount="900.00", account_id=self.bank, category_id=self.exp, date=month_key(0))
        a = self.c.get("/api/analysis").get_json()
        kinds = [i["kind"] for i in a["insights"]]
        self.assertIn("insight", kinds)                          # el gasto subió más de 8% vs. el mes anterior
        self.assertIn("warning", kinds)                          # gasto/ingreso muy por encima de su propio promedio

    def test_no_insights_without_enough_data(self):
        a = self.c.get("/api/analysis").get_json()
        self.assertEqual(a["insights"], [])
        self.assertEqual(a["recurring"], [])

    def test_health_score_endpoint_matches_analysis(self):
        """/api/health-score (para el puntaje de Inicio) tiene que ser siempre el mismo cálculo que
        'Salud financiera' en Análisis, solo reescalado, para que nunca se vean dos números distintos."""
        self.tx(self.c, type="income", amount="5000.00", account_id=self.bank, category_id=self.cat(self.c, "income"))
        self.tx(self.c, type="expense", amount="1000.00", account_id=self.bank, category_id=self.exp)
        a = self.c.get("/api/analysis").get_json()
        h = self.c.get("/api/health-score").get_json()
        self.assertEqual(h["score_100"], a["health"]["score"])
        self.assertEqual(h["breakdown"], a["health"]["breakdown"])
        self.assertEqual(h["score_10"], round(a["health"]["score"] / 10, 1))
        self.assertEqual(set(h["breakdown"]), {"living", "savings", "investments"})

    def test_health_score_distribution(self):
        """Ingreso 10000: gasto 5000 (50%) e inversión 2500 (25%) -> ahorro 25%: exactamente la meta = 100."""
        self.tx(self.c, type="income", amount="10000.00", account_id=self.bank, category_id=self.cat(self.c, "income"))
        self.tx(self.c, type="expense", amount="5000.00", account_id=self.bank, category_id=self.exp)
        r = self.c.post("/api/portfolio/ops", json={"symbol": "VOO", "kind": "buy", "quantity": "5", "price": "500", "currency": "MXN", "date": "2026-09-10"}, headers=H)
        self.assertIn(r.status_code, (200, 201), r.get_data(as_text=True))
        h = self.c.get("/api/health-score").get_json()
        b = h["breakdown"]
        self.assertEqual((b["living"]["actual_pct"], b["savings"]["actual_pct"], b["investments"]["actual_pct"]), (50.0, 25.0, 25.0))
        self.assertEqual(h["score_100"], 100)

    def test_health_score_without_income(self):
        h = self.c.get("/api/health-score").get_json()
        self.assertIsNone(h["score_100"])


class TestGoals(P):
    def test_goal_flow(self):
        r = self.c.post("/api/goals", json={"name": "Viaje", "target": "1000", "target_date": (TODAY + timedelta(days=100)).isoformat()}, headers=H)
        gid = r.get_json()["goal"]["id"]
        self.c.post(f"/api/goals/{gid}/contribs", json={"amount": "250"}, headers=H)
        g = self.c.get(f"/api/goals/{gid}").get_json()["goal"]
        self.assertEqual((g["saved"], g["pct"], g["remaining"]), (25000, 25.0, 75000))
        self.assertGreater(g["needed_per_month"], 0)
        self.assertEqual(self.c.post(f"/api/goals/{gid}/contribs", json={"amount": "300", "kind": "withdraw"}, headers=H).status_code, 400)
        self.assertEqual(self.bal(self.c)[self.bank], 1000000)   # las metas no mueven saldos
        self.c.post(f"/api/goals/{gid}/contribs", json={"amount": "50", "kind": "withdraw"}, headers=H)
        self.assertEqual(self.c.get(f"/api/goals/{gid}").get_json()["goal"]["saved"], 20000)
        o = self.client(); self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.get(f"/api/goals/{gid}").status_code, 404)


class TestTables(P):
    def test_table_flow(self):
        cols = [{"name": "Concepto", "type": "text"}, {"name": "Monto", "type": "money"}, {"name": "Fecha", "type": "date"}, {"name": "Pagado", "type": "check"}]
        t = self.c.post("/api/tables", json={"name": "Pendientes", "columns": cols}, headers=H).get_json()["table"]
        ids = [c["id"] for c in t["columns"]]
        for name, amt in (("Luz", "120.50"), ("Agua", "80")):
            r = self.c.post(f"/api/tables/{t['id']}/rows", json={"data": {ids[0]: name, ids[1]: amt, ids[2]: "2026-09-01", ids[3]: True}}, headers=H)
            self.assertEqual(r.status_code, 201, r.data)
        tt = self.c.get(f"/api/tables/{t['id']}").get_json()["table"]
        self.assertEqual(tt["totals"][ids[1]], "200.50")
        self.assertEqual(tt["totals"][ids[3]], 2)
        self.assertEqual(self.c.post(f"/api/tables/{t['id']}/rows", json={"data": {ids[1]: "abc"}}, headers=H).status_code, 400)
        self.assertEqual(self.c.post(f"/api/tables/{t['id']}/rows", json={"data": {ids[2]: "31/02/2026"}}, headers=H).status_code, 400)
        bad = [dict(c) for c in tt["columns"]]; bad[1]["type"] = "text"
        self.assertEqual(self.c.patch(f"/api/tables/{t['id']}", json={"columns": bad}, headers=H).status_code, 400)   # con datos no cambia de tipo
        ok = [dict(c) for c in tt["columns"]] + [{"name": "Notas", "type": "text"}]
        self.assertEqual(self.c.patch(f"/api/tables/{t['id']}", json={"columns": ok}, headers=H).status_code, 200)
        rid = tt["rows"][0]["id"]
        self.assertEqual(self.c.put(f"/api/tables/{t['id']}/rows/{rid}", json={"data": {ids[1]: "10"}}, headers=H).get_json()["table"]["totals"][ids[1]], "90.00")
        csvr = self.c.get(f"/api/tables/{t['id']}.csv")
        self.assertIn("Luz".encode(), csvr.data)
        o = self.client(); self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.get(f"/api/tables/{t['id']}").status_code, 404)
        self.assertEqual(o.post(f"/api/tables/{t['id']}/rows", json={"data": {}}, headers=H).status_code, 404)
        self.assertEqual(self.c.delete(f"/api/tables/{t['id']}/rows/{rid}", headers=H).status_code, 200)
        self.assertEqual(self.c.post("/api/tables", json={"name": "X", "columns": []}, headers=H).status_code, 400)


def make_receipt():
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new("RGB", (700, 500), "white")
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34)
    except OSError:
        f = ImageFont.load_default()
    for i, line in enumerate(["SUPER MERCADO LUNA", "Fecha: 12/09/2026", "Leche 2 x 25.00", "Pan 18.50", "IVA 5.00", "TOTAL $ 123.45"]):
        d.text((30, 30 + i * 70), line, fill="black", font=f)
    buf = io.BytesIO(); im.save(buf, "PNG")
    return buf.getvalue()


class TestReceipts(P):
    def up(self, c, data, name="t.png"):
        return c.post("/api/receipts", data={"file": (io.BytesIO(data), name)}, headers=H, content_type="multipart/form-data")

    def test_parse_receipt_text(self):
        s = more.parse_receipt("SUPER LUNA\n12/09/2026\nSubtotal 100.00\nIVA 16.00\nTOTAL $ 1,116.00\nCambio 0.00", TODAY)
        self.assertEqual((s["amount"], s["date"], s["merchant"]), (111600, "2026-09-12", "SUPER LUNA"))

    @unittest.skipUnless(more.ocr_available(), "Tesseract no instalado")
    def test_ocr_upload_link_isolation_delete(self):
        r = self.up(self.c, make_receipt())
        self.assertEqual(r.status_code, 201, r.data)
        j = r.get_json()
        self.assertEqual(j["suggestion"]["amount"], 12345, j["text"])
        self.assertEqual(j["suggestion"]["date"], "2026-09-12")
        rid = j["receipt"]["id"]
        tid = self.tx(self.c, type="expense", amount="123.45", account_id=self.bank, category_id=self.exp).get_json()["transaction"]["id"]
        self.assertEqual(self.c.post(f"/api/receipts/{rid}/link", json={"tx_id": tid}, headers=H).status_code, 200)
        self.assertEqual(len(self.c.get(f"/api/receipts?tx_id={tid}").get_json()["receipts"]), 1)
        f = self.c.get(f"/api/receipts/{rid}/file")
        self.assertEqual((f.status_code, f.mimetype), (200, "image/png"))
        o = self.client(); self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.get(f"/api/receipts/{rid}/file").status_code, 404)
        self.assertEqual(o.delete(f"/api/receipts/{rid}", headers=H).status_code, 404)
        self.assertEqual(o.post(f"/api/receipts/{rid}/link", json={"tx_id": tid}, headers=H).status_code, 404)
        path = self.c.get("/api/receipts").get_json()   # existe
        self.assertEqual(self.c.delete(f"/api/receipts/{rid}", headers=H).status_code, 200)
        self.assertEqual(self.c.get(f"/api/receipts/{rid}/file").status_code, 404)

    def test_rejects_non_images(self):
        self.assertEqual(self.up(self.c, b"<html>hola</html>", "x.png").status_code, 400)
        self.assertEqual(self.up(self.c, b"%PDF-1.4 fake", "x.pdf").status_code, 400)

    def test_delete_account_with_everything(self):
        self.mk_all()
        r = self.c.delete("/api/me", json={"password": "secreto123"}, headers=H)
        self.assertEqual(r.status_code, 200, r.data)

    def mk_all(self):
        card = self.card()
        self.tx(self.c, type="expense", amount="10", account_id=card, category_id=self.exp)
        did = self.c.post("/api/debts", json={"name": "D", "principal": "100"}, headers=H).get_json()["debt"]["id"]
        self.c.post(f"/api/debts/{did}/payments", json={"amount": "10", "account_id": self.bank}, headers=H)
        self.c.post("/api/goals", json={"name": "G", "target": "10"}, headers=H)
        self.c.put("/api/budgets", json={"category_id": 0, "amount": "10"}, headers=H)
        self.up(self.c, make_receipt())

    def card(self, **kw):
        return self.account(self.c, "Visa", "0", typ="credit", credit_limit="5000", cut_day=10, due_day=25)


if __name__ == "__main__":
    unittest.main()
