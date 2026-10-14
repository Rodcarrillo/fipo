"""Pruebas de importación de estados de cuenta y del portafolio.
IMPORTANTE: los precios de mercado aquí son un FIXTURE falso (FakeMarket). No se consulta Yahoo Finance real."""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_finance import Base, H  # noqa: E402
import portfolio  # noqa: E402

CSV = ("Fecha,Descripción,Cargo,Abono,Saldo\n"
       "05/09/2026,OXXO CENTRO,120.50,,879.50\n"
       "06/09/2026,NOMINA EMPRESA,,5000.00,5879.50\n"
       "07/09/2026,SUPER WALMART,\"1,234.10\",,4645.40\n").encode("utf-8")


class FakeMarket:
    prices = {"AAPL": 200.0, "VOO": 500.0}
    currencies = {}                      # símbolo -> moneda; por defecto MXN (no rompe las pruebas existentes)
    fail = False

    @classmethod
    def quote(cls, sym):
        if cls.fail or sym not in cls.prices:
            raise RuntimeError("sin conexión (fixture)")
        p = cls.prices[sym]
        return {"name": sym + " Inc", "currency": cls.currencies.get(sym, "MXN"), "exchange": "FAKE", "price": p, "prev_close": p - 2, "price_time": "2026-09-24T15:00:00+00:00"}

    @classmethod
    def history(cls, sym, rng):
        return {"points": [[1, 1.0], [2, 2.0]], "currency": "MXN"}


class TestImport(Base):
    def setUp(self):
        super().setUp()
        self.register(self.c)
        self.a = self.account(self.c, "Banco", "1000.00")

    def parse(self, data, name="e.csv", **extra):
        form = {"file": (io.BytesIO(data), name), "account_id": str(self.a), **extra}
        return self.c.post("/api/import/parse", data=form, headers=H, content_type="multipart/form-data")

    def test_csv_parse_and_commit_and_undo(self):
        r = self.parse(CSV)
        self.assertEqual(r.status_code, 200, r.data)
        rows = r.get_json()["rows"]
        self.assertEqual([x["amount"] for x in rows], [-12050, 500000, -123410])
        self.assertEqual(rows[0]["date"], "2026-09-05")
        c = self.c.post("/api/import/commit", json={"account_id": self.a, "filename": "e.csv", "kind": "csv", "rows": rows}, headers=H)
        self.assertEqual(c.status_code, 201, c.data)
        self.assertEqual(self.bal(self.c)[self.a], 100000 - 12050 + 500000 - 123410)
        # segunda vez: se marcan duplicados
        rows2 = self.parse(CSV).get_json()["rows"]
        self.assertTrue(all(x["duplicate"] for x in rows2))
        # deshacer
        iid = c.get_json()["import_id"]
        u = self.c.delete(f"/api/imports/{iid}", headers=H)
        self.assertEqual(u.get_json()["deleted"], 3)
        self.assertEqual(self.bal(self.c)[self.a], 100000)

    def test_isolation_and_bad_input(self):
        self.assertEqual(self.parse(b"", "x.csv").status_code, 400)
        self.assertEqual(self.parse(b"hola", "x.doc").status_code, 400)
        o = self.client()
        self.register(o, "b@x.com", "Beto")
        form = {"file": (io.BytesIO(CSV), "e.csv"), "account_id": str(self.a)}
        self.assertEqual(o.post("/api/import/parse", data=form, headers=H, content_type="multipart/form-data").status_code, 400)
        self.assertEqual(o.post("/api/import/commit", json={"account_id": self.a, "rows": [{"date": "2026-09-01", "amount": -100}]}, headers=H).status_code, 400)

    def test_excel(self):
        import openpyxl
        wb = openpyxl.Workbook(); ws = wb.active
        ws.append(["Fecha", "Concepto", "Importe"])
        ws.append(["2026-09-01", "Cafe", -45.5]); ws.append(["2026-09-02", "Pago", 300])
        buf = io.BytesIO(); wb.save(buf)
        r = self.parse(buf.getvalue(), "e.xlsx")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual([x["amount"] for x in r.get_json()["rows"]], [-4550, 30000])


class TestPortfolio(Base):
    def setUp(self):
        super().setUp()
        self._q, self._h = portfolio.Market.quote, portfolio.Market.history
        portfolio.Market.quote, portfolio.Market.history = FakeMarket.quote, FakeMarket.history
        FakeMarket.fail = False
        portfolio._last_manual_refresh.clear()
        self.register(self.c)
        self.a = self.account(self.c, "Broker", "10000.00", typ="investment")

    def tearDown(self):
        portfolio.Market.quote, portfolio.Market.history = self._q, self._h

    def op(self, **d):
        return self.c.post("/api/portfolio/ops", json={"date": "2026-09-01", "account_id": self.a, **d}, headers=H)

    def test_buy_sell_avg_cost_and_cash(self):
        self.assertEqual(self.op(kind="buy", symbol="aapl", quantity="10", price="100", fee="10").status_code, 201)
        self.assertEqual(self.bal(self.c)[self.a], 1000000 - 100000 - 1000)
        self.assertEqual(self.op(kind="buy", symbol="AAPL", quantity="10", price="120").status_code, 201)
        self.assertEqual(self.op(kind="sell", symbol="AAPL", quantity="5", price="150", date="2026-09-02").status_code, 201)
        s = self.c.get("/api/portfolio").get_json()
        p = s["positions"][0]
        self.assertEqual(p["quantity"], "15")
        # costo promedio = (1000+10 + 1200)/20 = 110.5 ; vende 5 -> realizado 5*(150-110.5)=197.5
        self.assertEqual(p["realized"], 19750)
        self.assertEqual(p["price"], 200.0)  # precio del FIXTURE
        self.assertEqual(p["market_value"], 15 * 200 * 100)
        # saldo: 10000 -1010 -1200 +750
        self.assertEqual(self.bal(self.c)[self.a], 1000000 - 101000 - 120000 + 75000)

    def test_fx_endpoint_and_usd_purchase_from_account(self):
        """+ Movimiento → Acciones: la compra va al portafolio, descuenta la cuenta en USD y /api/fx da el tipo de cambio."""
        self.assertEqual(self.c.get("/api/fx").get_json(), {"main": "MXN", "rates": {}})       # solo cuentas en MXN
        FakeMarket.prices["MXN=X"], FakeMarket.currencies["AAPL"] = 18.0, "USD"
        try:
            usd = self.account(self.c, "Broker USD", "1000.00", typ="investment", cur="USD")
            fx = self.c.get("/api/fx").get_json()
            self.assertEqual(fx["rates"]["USD"]["rate"], 18.0)
            r = self.c.post("/api/portfolio/ops", json={"kind": "buy", "symbol": "aapl", "quantity": "2", "price": "150", "fee": "1",
                            "date": "2026-09-01", "account_id": usd, "currency": "USD"}, headers=H)
            self.assertEqual(r.status_code, 201, r.data)
            self.assertEqual(self.bal(self.c)[usd], 100000 - 30000 - 100)          # US$ 698.99... en centavos
            p = [x for x in self.c.get("/api/portfolio").get_json()["positions"] if x["symbol"] == "AAPL"][0]
            self.assertEqual((p["currency"], p["quantity"]), ("USD", "2"))
            # moneda de la cuenta distinta a la de la acción: se rechaza con un mensaje claro
            r = self.c.post("/api/portfolio/ops", json={"kind": "buy", "symbol": "aapl", "quantity": "1", "price": "150",
                            "date": "2026-09-01", "account_id": self.a}, headers=H)
            self.assertEqual(r.status_code, 400)
        finally:
            FakeMarket.prices.pop("MXN=X", None); FakeMarket.currencies.pop("AAPL", None)

    def test_convert_pesos_to_dollars_then_buy(self):
        """Flujo GBM: Smart Cash (MXN) → cuenta USD como transferencia entre monedas y luego la compra de la acción
        desde la cuenta USD. Se refleja en las dos cuentas y nada cuenta como ingreso ni gasto."""
        FakeMarket.currencies["AAPL"] = "USD"
        try:
            smart = self.account(self.c, "Smart Cash", "20000.00", typ="savings")
            usd = self.account(self.c, "GBM USD", "50.00", typ="investment", cur="USD")
            r = self.c.post("/api/transactions", json={"type": "transfer", "account_id": smart, "to_account_id": usd, "amount": "5500.00",
                            "to_amount": "300.00", "date": "2026-09-01", "description": "Compra de USD"}, headers=H)
            self.assertEqual(r.status_code, 201, r.data)
            r = self.c.post("/api/portfolio/ops", json={"kind": "buy", "symbol": "AAPL", "quantity": "2", "price": "150", "fee": "1",
                            "date": "2026-09-01", "account_id": usd, "currency": "USD"}, headers=H)
            self.assertEqual(r.status_code, 201, r.data)
            b = self.bal(self.c)
            self.assertEqual((b[smart], b[usd]), (2000000 - 550000, 5000 + 30000 - 30100))
            d = self.c.get("/api/dashboard?period=year").get_json()["cards"]
            self.assertEqual((d["income"], d["expense"]), (0, 0))
        finally:
            FakeMarket.currencies.pop("AAPL", None)

    def test_oversell_rejected_and_not_income(self):
        self.assertEqual(self.op(kind="buy", symbol="VOO", quantity="1", price="400").status_code, 201)
        r = self.op(kind="sell", symbol="VOO", quantity="2", price="400", date="2026-09-02")
        self.assertEqual(r.status_code, 400)
        d = self.c.get("/api/dashboard").get_json()
        self.assertEqual(d["cards"]["income"] if "income" in d["cards"] else 0, 0)

    def test_yahoo_failure_keeps_last_price_and_manual(self):
        self.op(kind="buy", symbol="AAPL", quantity="1", price="100")
        FakeMarket.fail = True
        r = self.c.post("/api/portfolio/refresh", headers=H)
        self.assertEqual(r.status_code, 200)
        p = self.c.get("/api/portfolio").get_json()["positions"][0]
        self.assertEqual(p["price"], 200.0)
        self.assertTrue(p["last_error"])
        self.assertIn("finance.yahoo.com", p["link"])
        self.assertEqual(self.c.post("/api/portfolio/refresh", headers=H).status_code, 429)

    def test_unknown_symbol_manual_price(self):
        self.assertEqual(self.op(kind="buy", symbol="ZZZ", quantity="2", price="10").status_code, 201)
        p = self.c.get("/api/portfolio").get_json()
        self.assertIsNone(p["positions"][0]["price"])
        self.assertEqual(p["totals"]["unpriced"], ["ZZZ"])
        self.assertEqual(self.c.post("/api/portfolio/price", json={"symbol": "ZZZ", "price": "12"}, headers=H).status_code, 200)
        p = self.c.get("/api/portfolio").get_json()["positions"][0]
        self.assertEqual(p["market_value"], 2400)
        self.assertEqual(p["price_source"], "manual")

    def test_isolation_and_dashboard(self):
        self.op(kind="buy", symbol="AAPL", quantity="1", price="100")
        o = self.client(); self.register(o, "b@x.com", "Beto")
        self.assertEqual(o.get("/api/portfolio").get_json()["positions"], [])
        self.assertEqual(o.get("/api/portfolio/history?symbol=AAPL").status_code, 404)
        d = self.c.get("/api/dashboard").get_json()["cards"]
        self.assertEqual(d["portfolio_value"], 20000)

    def test_delete_op_restores_cash(self):
        oid = self.op(kind="buy", symbol="AAPL", quantity="1", price="100").get_json()["op"]["id"]
        self.c.delete(f"/api/portfolio/ops/{oid}", headers=H)
        self.assertEqual(self.bal(self.c)[self.a], 1000000)


if __name__ == "__main__":
    unittest.main()


class TestScheduler(Base):
    def test_scheduler_refreshes_held_symbols(self):
        import time
        from db import get_db
        FakeMarket.fail = False
        self.register(self.c)
        acc = self.account(self.c, "Broker", "1000.00")
        old = portfolio.Market.quote; portfolio.Market.quote = FakeMarket.quote
        try:
            self.c.post("/api/portfolio/ops", json={"kind": "buy", "symbol": "VOO", "quantity": "1", "price": "10", "date": "2026-09-01", "account_id": acc}, headers=H)
            with self.app.app_context():
                get_db().execute("UPDATE quotes SET updated_at='2020-01-01T00:00:00+00:00', price=1 WHERE symbol='VOO'")
            portfolio.start_scheduler(self.path, interval=1, market=FakeMarket, initial_delay=0)
            time.sleep(3)
            p = self.c.get("/api/portfolio").get_json()["positions"][0]
            self.assertEqual(p["price"], 500.0)
        finally:
            portfolio.Market.quote = old
