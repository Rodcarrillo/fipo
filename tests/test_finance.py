"""Pruebas del motor financiero y la seguridad. Ejecutar: python3 -m unittest discover -s tests -v"""
import os
import re
import sqlite3
import sys
import tempfile
import unittest

os.environ["FIPO_NO_AUTOAPP"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import create_app  # noqa: E402

H = {"X-Requested-With": "fipo"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "t.db")
        self.app = create_app(self.path, testing=True)
        self.c = self.app.test_client()

    def client(self):
        return self.app.test_client()

    def post(self, c, url, data=None, method="post"):
        return getattr(c, method)(url, json=data, headers=H)

    def register(self, c, email="a@x.com", name="Ana"):
        r = self.post(c, "/api/auth/register", {"name": name, "email": email, "password": "secreto123"})
        self.assertEqual(r.status_code, 201, r.data)
        return r.get_json()["user"]

    def account(self, c, name, ob="0", typ="bank", cur="MXN", **kw):
        r = self.post(c, "/api/accounts", {"name": name, "type": typ, "currency": cur, "opening_balance": ob, "opened_on": "2026-01-01", **kw})
        self.assertEqual(r.status_code, 201, r.data)
        return r.get_json()["account"]["id"]

    def cat(self, c, kind="expense"):
        cats = c.get("/api/categories").get_json()["categories"]
        return next(x["id"] for x in cats if x["kind"] == kind)

    def tx(self, c, **d):
        r = self.post(c, "/api/transactions", {"date": "2026-09-10", **d})
        return r

    def bal(self, c):
        return {a["id"]: a["balance"] for a in c.get("/api/accounts").get_json()["accounts"]}


class TestLedger(Base):
    def setUp(self):
        super().setUp()
        self.register(self.c)
        self.a = self.account(self.c, "Banco", "1000.00")
        self.b = self.account(self.c, "Efectivo", "200.00", typ="cash")
        self.exp = self.cat(self.c, "expense")
        self.inc = self.cat(self.c, "income")

    def test_income_expense_balances(self):
        self.assertEqual(self.tx(self.c, type="income", amount="500.50", account_id=self.a, category_id=self.inc).status_code, 201)
        self.assertEqual(self.tx(self.c, type="expense", amount="120.25", account_id=self.a, category_id=self.exp).status_code, 201)
        self.assertEqual(self.bal(self.c)[self.a], 100000 + 50050 - 12025)

    def test_transfer_moves_both_accounts_and_is_not_income_or_expense(self):
        r = self.tx(self.c, type="transfer", amount="300", account_id=self.a, to_account_id=self.b)
        self.assertEqual(r.status_code, 201, r.data)
        bal = self.bal(self.c)
        self.assertEqual(bal[self.a], 70000)
        self.assertEqual(bal[self.b], 50000)
        d = self.c.get("/api/dashboard?period=year").get_json()
        self.assertEqual(d["cards"]["income"], 0)
        self.assertEqual(d["cards"]["expense"], 0)
        self.assertEqual(d["cards"]["total_money"], 120000)  # el patrimonio no cambia por transferir

    def test_refund_reduces_expense_and_adds_cash(self):
        self.tx(self.c, type="expense", amount="100", account_id=self.a, category_id=self.exp)
        self.tx(self.c, type="refund", amount="30", account_id=self.a, category_id=self.exp)
        self.assertEqual(self.bal(self.c)[self.a], 100000 - 10000 + 3000)
        d = self.c.get("/api/dashboard?period=year").get_json()
        self.assertEqual(d["cards"]["expense"], 7000)
        self.assertEqual(d["cards"]["income"], 0)
        self.assertEqual(d["categories"][0]["total"], 7000)

    def test_edit_recalculates_and_delete_restores(self):
        tid = self.tx(self.c, type="expense", amount="50", account_id=self.a, category_id=self.exp).get_json()["transaction"]["id"]
        self.assertEqual(self.bal(self.c)[self.a], 95000)
        r = self.post(self.c, f"/api/transactions/{tid}", {"type": "expense", "amount": "80", "date": "2026-09-10", "account_id": self.b, "category_id": self.exp}, "put")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(self.bal(self.c), {self.a: 100000, self.b: 12000})
        self.assertEqual(self.post(self.c, f"/api/transactions/{tid}", method="delete").status_code, 200)
        self.assertEqual(self.bal(self.c), {self.a: 100000, self.b: 20000})

    def test_edit_transfer_changes_type_to_expense(self):
        tid = self.tx(self.c, type="transfer", amount="100", account_id=self.a, to_account_id=self.b).get_json()["transaction"]["id"]
        self.post(self.c, f"/api/transactions/{tid}", {"type": "expense", "amount": "100", "date": "2026-09-10", "account_id": self.a}, "put")
        self.assertEqual(self.bal(self.c), {self.a: 90000, self.b: 20000})

    def test_adjustment_creates_movement_not_income(self):
        r = self.post(self.c, f"/api/accounts/{self.a}/adjust", {"new_balance": "1250.00", "date": "2026-09-11", "note": "conciliación"})
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(self.bal(self.c)[self.a], 125000)
        d = self.c.get("/api/dashboard?period=year").get_json()
        self.assertEqual(d["cards"]["income"], 0)
        types = [t["type"] for t in self.c.get("/api/transactions").get_json()["transactions"]]
        self.assertIn("adjustment", types)
        self.assertEqual(self.post(self.c, f"/api/accounts/{self.a}/adjust", {"new_balance": "1250"}).status_code, 400)

    def test_history_reconstructs_balance(self):
        self.tx(self.c, type="income", amount="10", account_id=self.a, category_id=self.inc, date="2026-02-01")
        self.tx(self.c, type="transfer", amount="5", account_id=self.b, to_account_id=self.a, date="2026-03-01")
        h = self.c.get(f"/api/accounts/{self.a}").get_json()  # incluye aserción interna saldo == reconstrucción
        self.assertEqual(h["series"][-1]["balance"], h["account"]["balance"])
        self.assertEqual(h["account"]["balance"], 100000 + 1000 + 500)

    def test_validation_and_atomicity(self):
        before = self.bal(self.c)
        bad = [
            dict(type="expense", amount="0", account_id=self.a),
            dict(type="expense", amount="-5", account_id=self.a),
            dict(type="expense", amount="abc", account_id=self.a),
            dict(type="expense", amount="5", account_id=99999),
            dict(type="expense", amount="5", account_id=self.a, category_id=self.inc),  # categoría de ingreso en gasto
            dict(type="transfer", amount="5", account_id=self.a, to_account_id=self.a),
            dict(type="transfer", amount="5", account_id=self.a),
            dict(type="nope", amount="5", account_id=self.a),
            dict(type="expense", amount="5", account_id=self.a, date="2026-13-40"),
        ]
        for b in bad:
            d = {"date": "2026-09-10", **b}
            self.assertEqual(self.post(self.c, "/api/transactions", d).status_code, 400, b)
        self.assertEqual(self.bal(self.c), before)
        self.assertEqual(self.c.get("/api/transactions").get_json()["total"], 0)

    def test_multi_currency_transfer_requires_destination_amount(self):
        usd = self.account(self.c, "USD", "0", cur="USD")
        r = self.tx(self.c, type="transfer", amount="100", account_id=self.a, to_account_id=usd)
        self.assertEqual(r.status_code, 400)
        r = self.tx(self.c, type="transfer", amount="100", to_amount="5.50", account_id=self.a, to_account_id=usd)
        self.assertEqual(r.status_code, 201, r.data)
        bal = self.bal(self.c)
        self.assertEqual((bal[self.a], bal[usd]), (90000, 550))
        d = self.c.get("/api/dashboard?period=year").get_json()
        self.assertEqual(len(d["excluded_accounts"]), 1)  # no se suma USD a MXN sin tipo de cambio

    def test_filters_search_sort_pagination(self):
        for i in range(30):
            self.tx(self.c, type="expense", amount=str(i + 1), account_id=self.a, category_id=self.exp, description=f"compra {i}")
        self.tx(self.c, type="income", amount="9", account_id=self.b, category_id=self.inc, description="venta especial")
        j = self.c.get("/api/transactions?per_page=10&page=2&sort=amount&dir=asc").get_json()
        self.assertEqual(j["total"], 31)
        self.assertEqual(len(j["transactions"]), 10)
        self.assertEqual(self.c.get("/api/transactions?q=especial").get_json()["total"], 1)
        self.assertEqual(self.c.get(f"/api/transactions?account_id={self.b}").get_json()["total"], 1)
        self.assertEqual(self.c.get("/api/transactions?type=income").get_json()["total"], 1)

    def test_csv_export_and_formula_injection(self):
        self.tx(self.c, type="expense", amount="10", account_id=self.a, description="=HYPERLINK(\"x\")")
        r = self.c.get("/api/transactions.csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("'=HYPERLINK", r.data.decode("utf-8-sig"))

    def test_dashboard_periods(self):
        self.tx(self.c, type="expense", amount="10", account_id=self.a, date="2020-01-15")
        for p in ("today", "week", "month", "3months", "year"):
            self.assertEqual(self.c.get(f"/api/dashboard?period={p}").status_code, 200)
        d = self.c.get("/api/dashboard?period=custom&from=2020-01-01&to=2020-01-31").get_json()
        self.assertEqual(d["cards"]["expense"], 1000)
        self.assertEqual(sum(x["expense"] for x in d["series"]), 1000)
        self.assertEqual(self.c.get("/api/dashboard?period=custom&from=2020-02-01&to=2020-01-01").status_code, 400)

    def test_account_delete_rules(self):
        self.tx(self.c, type="expense", amount="1", account_id=self.a)
        self.assertEqual(self.post(self.c, f"/api/accounts/{self.a}", method="delete").status_code, 409)
        self.assertEqual(self.post(self.c, f"/api/accounts/{self.a}", {"archived": True}, "patch").status_code, 200)
        self.assertEqual(self.tx(self.c, type="expense", amount="1", account_id=self.a).status_code, 400)  # archivada
        self.assertEqual(self.post(self.c, f"/api/accounts/{self.b}", method="delete").status_code, 200)

    def test_low_balance_alert_is_real(self):
        self.post(self.c, f"/api/accounts/{self.b}", {"low_balance_alert": "500"}, "patch")
        alerts = self.c.get("/api/dashboard").get_json()["alerts"]
        self.assertTrue(any("Efectivo" in a["text"] for a in alerts))


class TestSecurity(Base):
    def test_isolation_between_users(self):
        self.register(self.c, "a@x.com", "Ana")
        a = self.account(self.c, "Ana Banco", "100")
        cat = self.cat(self.c)
        tid = self.tx(self.c, type="expense", amount="10", account_id=a, category_id=cat).get_json()["transaction"]["id"]

        c2 = self.client()
        self.register(c2, "b@x.com", "Beto")
        self.assertEqual(c2.get("/api/accounts").get_json()["accounts"], [])
        self.assertEqual(c2.get("/api/transactions").get_json()["total"], 0)
        self.assertEqual(c2.get(f"/api/transactions/{tid}").status_code, 404)
        self.assertEqual(c2.get(f"/api/accounts/{a}").status_code, 404)
        self.assertEqual(self.post(c2, f"/api/transactions/{tid}", method="delete").status_code, 404)
        self.assertEqual(self.post(c2, f"/api/transactions/{tid}", {"type": "expense", "amount": "1", "date": "2026-09-10", "account_id": a}, "put").status_code, 404)
        self.assertEqual(self.post(c2, f"/api/accounts/{a}", {"name": "hack"}, "patch").status_code, 404)
        self.assertEqual(self.post(c2, f"/api/accounts/{a}/adjust", {"new_balance": "1"}).status_code, 404)
        self.assertEqual(self.post(c2, f"/api/accounts/{a}", method="delete").status_code, 404)
        # no puede registrar movimientos en la cuenta ni con la categoría de otro usuario
        b = self.account(c2, "Beto Banco", "0")
        self.assertEqual(self.tx(c2, type="expense", amount="1", account_id=a).status_code, 400)
        self.assertEqual(self.tx(c2, type="expense", amount="1", account_id=b, category_id=cat).status_code, 400)
        self.assertEqual(self.tx(c2, type="transfer", amount="1", account_id=b, to_account_id=a).status_code, 400)
        # datos de Ana intactos
        self.assertEqual(self.bal(self.c)[a], 9000)

    def test_auth_required(self):
        for url in ("/api/accounts", "/api/transactions", "/api/dashboard", "/api/categories", "/api/export.json", "/api/me"):
            self.assertEqual(self.c.get(url).status_code, 401, url)

    def test_csrf_header_required(self):
        self.register(self.c)
        self.assertEqual(self.c.post("/api/accounts", json={"name": "x"}).status_code, 403)

    def test_password_is_hashed_and_login_flow(self):
        self.register(self.c)
        raw = sqlite3.connect(self.path).execute("select password_hash from users").fetchone()[0]
        self.assertNotIn("secreto123", raw)
        self.assertTrue(raw.startswith(("scrypt:", "pbkdf2:")))
        self.post(self.c, "/api/auth/logout")
        self.assertEqual(self.c.get("/api/me").status_code, 401)
        self.assertEqual(self.post(self.c, "/api/auth/login", {"email": "a@x.com", "password": "mala"}).status_code, 401)
        self.assertEqual(self.post(self.c, "/api/auth/login", {"email": "A@X.com", "password": "secreto123"}).status_code, 200)

    def test_registration_validation(self):
        for d in ({"name": "", "email": "a@x.com", "password": "secreto123"}, {"name": "A", "email": "malo", "password": "secreto123"},
                  {"name": "A", "email": "a@x.com", "password": "corta"}):
            self.assertEqual(self.post(self.client(), "/api/auth/register", d).status_code, 400)
        self.register(self.c)
        self.assertEqual(self.post(self.client(), "/api/auth/register", {"name": "B", "email": "A@x.com", "password": "secreto123"}).status_code, 409)

    def test_login_throttle(self):
        self.register(self.c)
        c = self.client()
        codes = [self.post(c, "/api/auth/login", {"email": "a@x.com", "password": "x"}).status_code for _ in range(10)]
        self.assertEqual(codes[-1], 429)
        self.assertEqual(self.post(c, "/api/auth/login", {"email": "a@x.com", "password": "secreto123"}).status_code, 429)

    def test_password_change_and_reset(self):
        self.register(self.c)
        c2 = self.client()
        self.post(c2, "/api/auth/login", {"email": "a@x.com", "password": "secreto123"})
        r = self.post(self.c, "/api/me/password", {"current": "secreto123", "password": "nuevaclave1"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c2.get("/api/me").status_code, 401)   # otras sesiones se cierran
        self.assertEqual(self.c.get("/api/me").status_code, 200)
        self.assertEqual(self.post(self.c, "/api/me/password", {"current": "mal", "password": "otraclave12"}).status_code, 400)
        # recuperación: el token solo existe en el enlace (consola); lo leemos capturando stdout
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(self.post(self.client(), "/api/auth/forgot", {"email": "a@x.com"}).status_code, 200)
        token = re.search(r"#/reset/([\w-]+)", buf.getvalue()).group(1)
        self.assertEqual(self.post(self.client(), "/api/auth/forgot", {"email": "noexiste@x.com"}).get_json(), {"ok": True})
        self.assertEqual(self.post(self.client(), "/api/auth/reset", {"token": token, "password": "recuperada99"}).status_code, 200)
        self.assertEqual(self.post(self.client(), "/api/auth/reset", {"token": token, "password": "recuperada98"}).status_code, 400)  # un solo uso
        self.assertEqual(self.post(self.client(), "/api/auth/login", {"email": "a@x.com", "password": "recuperada99"}).status_code, 200)

    def test_persistence_across_restart_and_relogin(self):
        self.register(self.c)
        a = self.account(self.c, "Banco", "100")
        self.tx(self.c, type="expense", amount="25", account_id=a)
        self.post(self.c, "/api/auth/logout")
        app2 = create_app(self.path, testing=True)   # "reinicio" del servidor con la misma BD
        c2 = app2.test_client()
        self.assertEqual(c2.post("/api/auth/login", json={"email": "a@x.com", "password": "secreto123"}, headers=H).status_code, 200)
        self.assertEqual({x["id"]: x["balance"] for x in c2.get("/api/accounts").get_json()["accounts"]}[a], 7500)
        self.assertEqual(c2.get("/api/transactions").get_json()["total"], 1)

    def test_onboarding_and_profile(self):
        self.register(self.c)
        r = self.post(self.c, "/api/onboarding", {"currency": "USD", "accounts": [{"name": "Caja", "type": "cash", "opening_balance": "50"}]})
        self.assertEqual(r.status_code, 200, r.data)
        self.assertTrue(r.get_json()["user"]["onboarded"])
        self.assertEqual(self.c.get("/api/accounts").get_json()["accounts"][0]["currency"], "USD")
        r = self.post(self.c, "/api/me", {"timezone": "America/Merida", "theme": "dark", "name": "Ana P"}, "patch")
        self.assertEqual(r.get_json()["user"]["theme"], "dark")
        self.assertEqual(self.post(self.c, "/api/me", {"timezone": "Marte/Olimpo"}, "patch").status_code, 400)

    def test_delete_account_removes_only_own_data(self):
        self.register(self.c)
        self.account(self.c, "A", "1")
        c2 = self.client()
        self.register(c2, "b@x.com")
        b = self.account(c2, "B", "1")
        self.assertEqual(self.post(self.c, "/api/me", {"password": "secreto123"}, "delete").status_code, 200)
        self.assertEqual(len(c2.get("/api/accounts").get_json()["accounts"]), 1)
        self.assertEqual(self.bal(c2)[b], 100)


class TestDemo(Base):
    def test_demo_is_isolated_and_removable(self):
        self.register(self.c)
        real = self.account(self.c, "Mi banco real", "777")
        cat = self.cat(self.c)
        self.tx(self.c, type="expense", amount="7", account_id=real, category_id=cat)
        self.assertEqual(self.post(self.c, "/api/demo").status_code, 200)
        self.assertEqual(self.post(self.c, "/api/demo").status_code, 400)  # no duplicar
        accs = self.c.get("/api/accounts").get_json()["accounts"]
        self.assertTrue(all(a["name"].startswith("[DEMO]") for a in accs if a["is_demo"]))
        self.assertEqual(self.bal(self.c)[real], 77700 - 700)  # el saldo real no cambia
        self.assertEqual(self.post(self.c, "/api/demo", method="delete").status_code, 200)
        accs = self.c.get("/api/accounts").get_json()["accounts"]
        self.assertEqual([a["name"] for a in accs], ["Mi banco real"])
        self.assertEqual(self.c.get("/api/transactions").get_json()["total"], 1)
        self.assertFalse(any(c["is_demo"] for c in self.c.get("/api/categories").get_json()["categories"]))

    def test_demo_delete_refuses_when_real_tx_uses_demo_account(self):
        self.register(self.c)
        self.post(self.c, "/api/demo")
        demo_acc = next(a["id"] for a in self.c.get("/api/accounts").get_json()["accounts"] if a["is_demo"])
        self.assertEqual(self.tx(self.c, type="expense", amount="5", account_id=demo_acc).status_code, 201)
        self.assertEqual(self.post(self.c, "/api/demo", method="delete").status_code, 400)


if __name__ == "__main__":
    unittest.main()
