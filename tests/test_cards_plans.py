"""Tarjetas: planes a meses (MSI / con intereses / diferido), pago del mes, compras a meses y cargos recurrentes.
El «hoy» de la app se fija en cada prueba para poder cruzar fechas de corte sin depender del reloj."""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_finance import Base, H  # noqa: E402
import cards  # noqa: E402
import ledger  # noqa: E402
import more  # noqa: E402
import notify  # noqa: E402

MODS = (ledger, more, cards, notify)


class Clock(Base):
    def setUp(self):
        super().setUp()
        self._orig = [m.today_for for m in MODS]
        self.set_today("2026-09-15")
        self.register(self.c)
        self.post(self.c, "/api/onboarding", {"currency": "MXN", "accounts": []})
        self.bank = self.account(self.c, "Banco", "50000.00")
        self.exp = self.cat(self.c, "expense")

    def tearDown(self):
        for m, f in zip(MODS, self._orig):
            m.today_for = f

    def set_today(self, iso):
        d = date.fromisoformat(iso)
        for m in MODS:
            m.today_for = lambda tz, d=d: d

    def card(self, **kw):
        body = {"name": "Visa", "type": "credit", "currency": "MXN", "credit_limit": "50000", "cut_day": 10, "due_day": 30, "opened_on": "2026-09-15", **kw}
        r = self.post(self.c, "/api/accounts", body)
        return r

    def card_info(self, aid):
        return next(x for x in self.c.get("/api/cards").get_json()["cards"] if x["id"] == aid)

    def interest_txs(self, aid):
        return [t for t in self.c.get(f"/api/transactions?account_id={aid}&per_page=100").get_json()["transactions"] if t["description"].startswith("Intereses")]


class TestOpeningPlans(Clock):
    def make(self):
        r = self.card(owed_now="1000", plans=[
            {"kind": "msi", "description": "Pantalla", "monthly_amount": "500", "months_total": 6, "months_remaining": 4},
            {"kind": "mci", "description": "Laptop", "monthly_amount": "1200", "months_total": 12, "months_remaining": 10, "principal_remaining": "10000", "interest_rate": "38"},
        ])
        self.assertEqual(r.status_code, 201, r.data)
        return r.get_json()["account"]["id"]

    def test_opening_split_and_monthly_payment(self):
        aid = self.make()
        self.assertEqual(self.bal(self.c)[aid], -1300000)                 # 1000 + 2000 (4×500) + 10000
        c = self.card_info(aid)
        self.assertEqual(c["statement"]["pending"], 100000)               # solo lo que no está a meses
        self.assertEqual(c["deferred_now"], 1200000)
        self.assertEqual(len(c["plans"]), 2)
        msi = next(p for p in c["plans"] if p["kind"] == "msi")
        self.assertEqual((msi["installments_done"], msi["months_left"], msi["next_date"]), (2, 4, "2026-10-10"))

    def test_cut_bills_installment_and_interest_once(self):
        aid = self.make()
        self.set_today("2026-10-12")
        c = self.card_info(aid)
        # entra 1 mensualidad de cada plan: 1000 (sin meses) + 500 + 1000 de capital + 200 de interés
        self.assertEqual(c["statement"]["pending"], 270000)
        self.assertEqual(self.bal(self.c)[aid], -1320000)                 # el interés es un gasto real en la tarjeta
        self.assertEqual(len(self.interest_txs(aid)), 1)
        self.assertEqual(len(self.interest_txs(aid)), 1)                  # consultar otra vez no lo duplica
        self.assertIn("(3/12)", self.interest_txs(aid)[0]["description"])
        self.assertEqual(self.post(self.c, f"/api/cards/{aid}/pay", {"from_account_id": self.bank, "amount": "2700", "date": "2026-10-12"}).status_code, 201)
        self.assertEqual(self.card_info(aid)["statement"]["pending"], 0)

    def test_plans_finish_and_interest_count(self):
        aid = self.make()
        self.set_today("2027-02-11")                                        # 5 cortes después
        c = self.card_info(aid)
        msi = next(p for p in c["plans"] if p["kind"] == "msi")
        mci = next(p for p in c["plans"] if p["kind"] == "mci")
        self.assertTrue(msi["finished"])
        self.assertEqual((mci["installments_done"], mci["months_left"]), (7, 5))
        self.assertEqual(len(self.interest_txs(aid)), 5)
        cats = {x["name"] for x in self.c.get("/api/categories").get_json()["categories"]}
        self.assertIn("Intereses de tarjeta", cats)

    def test_validation(self):
        r = self.card(cut_day=0, owed_now="100", plans=[{"kind": "msi", "monthly_amount": "100", "months_total": 3, "months_remaining": 2}])
        self.assertEqual(r.status_code, 400)
        r = self.card(owed_now="100", plans=[{"kind": "msi", "monthly_amount": "100", "months_total": 3, "months_remaining": 5}])
        self.assertEqual((r.status_code, r.get_json()["field"]), (400, "plans.0.months_remaining"))
        r = self.card(owed_now="100", plans=[{"kind": "mci", "monthly_amount": "100", "months_total": 3, "months_remaining": 2, "principal_remaining": "500"}])
        self.assertEqual(r.status_code, 400)                              # capital mayor a mensualidad × meses
        self.assertEqual(self.card(owed_now="-5").status_code, 400)       # la deuda se escribe en positivo

    def test_add_and_delete_existing_plan_keeps_balance(self):
        r = self.card(owed_now="3000")
        aid = r.get_json()["account"]["id"]
        self.assertEqual(self.card_info(aid)["statement"]["pending"], 300000)
        r = self.post(self.c, f"/api/cards/{aid}/plans", {"kind": "msi", "description": "Celular", "monthly_amount": "500", "months_total": 12, "months_remaining": 4})
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(self.bal(self.c)[aid], -300000)                  # no cambia la deuda total
        self.assertEqual(self.card_info(aid)["statement"]["pending"], 100000)
        self.assertEqual(self.c.delete(f"/api/cards/plans/{r.get_json()['plan']['id']}", headers=H).status_code, 200)
        self.assertEqual(self.card_info(aid)["statement"]["pending"], 300000)

    def test_isolation(self):
        aid = self.make()
        pid = self.card_info(aid)["plans"][0]["id"]
        o = self.client()
        self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.delete(f"/api/cards/plans/{pid}", headers=H).status_code, 404)
        self.assertEqual(self.post(o, f"/api/cards/{aid}/plans", {"kind": "msi", "monthly_amount": "1", "months_total": 2, "months_remaining": 1}).status_code, 404)


class TestPurchases(Clock):
    def setUp(self):
        super().setUp()
        self.visa = self.card(owed_now="0").get_json()["account"]["id"]

    def buy(self, amount="1200", date_="2026-09-12", **inst):
        return self.post(self.c, "/api/transactions", {"type": "expense", "amount": amount, "date": date_, "account_id": self.visa,
                                                       "category_id": self.exp, "description": "Audífonos", "installments": inst or None})

    def test_msi_purchase(self):
        r = self.buy(kind="msi", months=3)
        self.assertEqual(r.status_code, 201, r.data)
        t = r.get_json()["transaction"]
        self.assertEqual((t["plan_kind"], t["plan_months"], t["plan_monthly"]), ("msi", 3, 40000))
        self.assertEqual(self.bal(self.c)[self.visa], -120000)
        self.assertEqual(self.card_info(self.visa)["statement"]["pending"], 0)       # la compra fue después del corte
        self.set_today("2026-10-12")
        self.assertEqual(self.card_info(self.visa)["statement"]["pending"], 40000)   # solo la 1.ª mensualidad

    def test_edit_before_and_after_billing(self):
        tid = self.buy(kind="msi", months=3).get_json()["transaction"]["id"]
        base = {"type": "expense", "date": "2026-09-12", "account_id": self.visa, "category_id": self.exp, "description": "Audífonos"}
        r = self.post(self.c, f"/api/transactions/{tid}", {**base, "amount": "1500"}, method="put")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.get_json()["transaction"]["plan_monthly"], 50000)         # el plan sigue a la compra
        # mismo plan reenviado por el formulario: no cuenta como cambio
        r = self.post(self.c, f"/api/transactions/{tid}", {**base, "amount": "1500", "installments": {"kind": "msi", "months": 3}}, method="put")
        self.assertEqual(r.status_code, 200, r.data)
        self.set_today("2026-10-12")
        r = self.post(self.c, f"/api/transactions/{tid}", {**base, "amount": "1800"}, method="put")
        self.assertEqual(r.status_code, 400)                                          # ya hay una mensualidad cobrada
        r = self.post(self.c, f"/api/transactions/{tid}", {**base, "amount": "1500", "description": "Audífonos BT"}, method="put")
        self.assertEqual(r.status_code, 200, r.data)

    def test_mci_purchase_interest_and_delete(self):
        r = self.buy(amount="1000", kind="mci", months=3, monthly_amount="400")
        self.assertEqual(r.status_code, 201, r.data)
        tid = r.get_json()["transaction"]["id"]
        self.set_today("2026-10-12")
        its = self.interest_txs(self.visa)
        self.assertEqual([t["amount"] for t in its], [6667])                          # 400 − 333.33 de capital = 66.67
        self.assertEqual(self.c.delete(f"/api/transactions/{tid}", headers=H).status_code, 200)
        self.assertEqual(self.interest_txs(self.visa), [])                            # sus intereses se van con ella
        self.assertEqual(self.bal(self.c)[self.visa], 0)

    def test_purchase_validation(self):
        self.assertEqual(self.buy(amount="1000", kind="mci", months=3, monthly_amount="300").status_code, 400)
        r = self.post(self.c, "/api/transactions", {"type": "expense", "amount": "100", "date": "2026-09-12", "account_id": self.bank,
                                                    "installments": {"kind": "msi", "months": 3}})
        self.assertEqual(r.status_code, 400)                                          # débito no es a meses
        self.assertEqual(self.buy(kind="msi", months=1).status_code, 400)
        n = len(self.c.get("/api/transactions?per_page=100").get_json()["transactions"])
        self.assertEqual(n, 0)                                                        # nada a medias (atómico)


class TestRecurring(Clock):
    def setUp(self):
        super().setUp()
        self.visa = self.card(owed_now="0").get_json()["account"]["id"]

    def rec(self, c=None, **kw):
        body = {"description": "Netflix", "amount": "199", "account_id": self.visa, "category_id": self.exp, "frequency": "monthly", "next_date": "2026-08-31", **kw}
        return self.post(c or self.c, "/api/recurring", body)

    def txs(self):
        return [t for t in self.c.get("/api/transactions?per_page=100").get_json()["transactions"] if t["recurring"]]

    def test_catch_up_anchor_and_idempotent(self):
        r = self.rec()
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.get_json()["item"]["next_date"], "2026-09-30")
        self.assertEqual([t["date"] for t in self.txs()], ["2026-08-31"])
        self.set_today("2026-11-02")
        self.assertEqual(sorted(t["date"] for t in self.txs()), ["2026-08-31", "2026-09-30", "2026-10-31"])  # vuelve al 31
        self.assertEqual(len(self.txs()), 3)
        self.assertEqual(self.bal(self.c)[self.visa], -59700)
        n = self.c.get("/api/notifications").get_json()
        self.assertTrue(any("Netflix" in x["title"] for x in n["items"]))

    def test_pause_edit_delete_and_list(self):
        rid = self.rec(next_date="2026-09-20").get_json()["item"]["id"]
        self.assertEqual(self.txs(), [])
        self.assertEqual(self.post(self.c, f"/api/recurring/{rid}", {"active": False}, method="patch").status_code, 200)
        self.set_today("2026-12-05")
        self.assertEqual(self.txs(), [])
        lst = self.c.get("/api/recurring").get_json()
        self.assertEqual((len(lst["items"]), lst["monthly_total"]), (1, 0))
        self.assertEqual(self.c.delete(f"/api/recurring/{rid}", headers=H).status_code, 200)
        self.assertEqual(self.c.get("/api/recurring").get_json()["items"], [])

    def test_weekly_and_yearly(self):
        self.rec(description="Gym", frequency="weekly", next_date="2026-09-15", amount="100")
        self.rec(description="Dominio", frequency="yearly", next_date="2026-09-15", amount="300")
        self.set_today("2026-09-29")
        dates = sorted((t["description"], t["date"]) for t in self.txs())
        self.assertEqual(dates, [("Dominio", "2026-09-15"), ("Gym", "2026-09-15"), ("Gym", "2026-09-22"), ("Gym", "2026-09-29")])

    def test_validation_isolation_and_archived(self):
        self.assertEqual(self.rec(amount="0").status_code, 400)
        self.assertEqual(self.rec(frequency="daily").status_code, 400)
        rid = self.rec(next_date="2026-10-01").get_json()["item"]["id"]
        o = self.client()
        self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.get("/api/recurring").get_json()["items"], [])
        self.assertEqual(self.post(o, f"/api/recurring/{rid}", {"amount": "1"}, method="patch").status_code, 404)
        self.assertEqual(o.delete(f"/api/recurring/{rid}", headers=H).status_code, 404)
        self.assertEqual(self.rec(c=o).status_code, 400)                              # no puede usar la tarjeta de otro
        self.post(self.c, f"/api/accounts/{self.visa}", {"archived": True}, method="patch")
        self.set_today("2026-10-02")
        item = self.c.get("/api/recurring").get_json()["items"][0]
        self.assertFalse(item["active"])                                              # tarjeta archivada: se pausa y avisa
        self.assertEqual(self.txs(), [])


if __name__ == "__main__":
    unittest.main()


class TestDemoCards(Clock):
    def test_demo_has_plan_and_subscriptions_and_cleans_up(self):
        self.assertEqual(self.post(self.c, "/api/demo", {}).status_code, 200)
        self.assertEqual(len(self.c.get("/api/recurring").get_json()["items"]), 3)
        visa = next(x for x in self.c.get("/api/cards").get_json()["cards"] if "DEMO" in x["name"])
        self.assertEqual([p["kind"] for p in visa["plans"]], ["msi"])
        self.assertEqual(self.c.delete("/api/demo", headers=H).status_code, 200)
        self.assertEqual(self.c.get("/api/recurring").get_json()["items"], [])
        self.assertEqual([x for x in self.c.get("/api/cards").get_json()["cards"] if "DEMO" in x["name"]], [])
