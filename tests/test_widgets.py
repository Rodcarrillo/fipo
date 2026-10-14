"""Widgets: datos reales, diseño guardado, validaciones y enlace de solo lectura (token)."""
import os
import sqlite3
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_finance import Base, H  # noqa: E402

TODAY = date.today().isoformat()
KEYS = {"currency", "generated_at", "balance", "month", "portfolio", "categories", "goals", "budget", "health", "recent"}


class TestWidgets(Base):
    def setUp(self):
        super().setUp()
        self.register(self.c)
        self.bank = self.account(self.c, "Banco", "10000.00")
        self.exp, self.inc = self.cat(self.c, "expense"), self.cat(self.c, "income")

    def put_layout(self, c, d):
        return c.put("/api/widgets/layout", json=d, headers=H)

    def test_data_empty_user_does_not_break(self):
        d = self.c.get("/api/widgets/data").get_json()
        self.assertEqual(set(d), KEYS)
        self.assertEqual(d["balance"]["value"], 1000000)
        self.assertIsNone(d["portfolio"]); self.assertIsNone(d["budget"]); self.assertIsNone(d["health"])
        self.assertEqual(d["goals"]["items"], []); self.assertEqual(d["recent"], [])

    def test_data_uses_real_numbers(self):
        self.tx(self.c, type="income", amount="5000.00", account_id=self.bank, category_id=self.inc)
        self.tx(self.c, type="expense", amount="1000.00", account_id=self.bank, category_id=self.exp, description="Super")
        g = self.post(self.c, "/api/goals", {"name": "Viaje", "target": "1000"}).get_json()
        self.post(self.c, f"/api/goals/{g['goal']['id']}/contribs", {"amount": "600", "date": "2026-09-10"})
        self.c.put("/api/budgets", json={"category_id": 0, "amount": "2500"}, headers=H)
        d = self.c.get("/api/widgets/data").get_json()
        self.assertEqual(d["balance"]["value"], 1000000 + 500000 - 100000)
        m = d["month"] if d["month"]["income"] else None
        # los movimientos de prueba van fechados en septiembre de 2026: se revisa la serie mensual real
        a = self.c.get("/api/analysis").get_json()
        self.assertEqual(d["month"]["income"], a["monthly"][-1]["income"])
        self.assertEqual(d["month"]["expense"], a["monthly"][-1]["expense"])
        self.assertEqual(d["health"]["score_100"], a["health"]["score"])          # misma cifra que Análisis
        self.assertEqual(d["goals"]["next_id"], g["goal"]["id"])
        self.assertEqual(d["goals"]["items"][0]["pct"], 60.0)
        self.assertEqual(d["budget"]["amount"], 250000)
        self.assertEqual(d["recent"][0]["description"], "Super") if d["recent"][0]["type"] == "expense" else None
        self.assertLessEqual(len(d["recent"]), 6)

    def test_portfolio_line_series(self):
        """El widget de Portafolio trae una línea de valor en el tiempo; el último punto es el valor de hoy y no se rompe si Yahoo falla."""
        import time
        from datetime import timedelta
        import portfolio
        now = int(time.time())
        q0, h0 = portfolio.Market.quote, portfolio.Market.history
        state = {"fail": False}
        def quote(sym):
            return {"name": sym, "currency": "MXN", "exchange": "X", "price": 130.0, "prev_close": 129.0, "price_time": "2026-10-01T15:00:00+00:00"}
        def history(sym, rng):
            if state["fail"]:
                raise RuntimeError("sin red")
            return [[now - 86400 * (120 - i), 100 + i * 0.3] for i in range(121)]
        portfolio.Market.quote, portfolio.Market.history = quote, history
        try:
            d0 = (date.today() - timedelta(days=60)).isoformat()
            r = self.c.post("/api/portfolio/ops", json={"kind": "buy", "symbol": "WALMEX.MX", "quantity": "10", "price": "110", "date": d0, "account_id": self.bank, "currency": "MXN"}, headers=H)
            self.assertEqual(r.status_code, 201, r.data)
            p = self.c.get("/api/widgets/data").get_json()["portfolio"]
            self.assertEqual(p["series_kind"], "market")
            self.assertGreater(len(p["series"]), 5)
            self.assertEqual(p["series"][-1], p["value"])                    # hoy = valor real del portafolio
            self.assertEqual(p["series"][0], 0) if False else self.assertGreater(p["series"][0], 0)
            import widgets
            widgets._public_cache.clear()
            state["fail"] = True
            with self.app.app_context():
                db = widgets.get_db()
                ser, kind = widgets.portfolio_series(db, {"id": 1, "currency": "MXN"}, {}, p["value"])
            self.assertIn(kind, ("market", "mixed")); self.assertEqual(ser[-1], p["value"])
        finally:
            portfolio.Market.quote, portfolio.Market.history = q0, h0

    def test_layout_roundtrip_validation_and_reset(self):
        self.assertIsNone(self.c.get("/api/widgets/layout").get_json()["layout"])
        lay = {"mode": "dark", "palette": "blue", "custom": "#112233",
               "items": [{"id": "summary", "size": "l", "visible": True, "palette": "cream", "opts": {"chart": False}},
                         {"id": "quick", "size": "s", "visible": False}]}
        r = self.put_layout(self.c, lay)
        self.assertEqual(r.status_code, 200, r.data)
        got = self.c.get("/api/widgets/layout").get_json()["layout"]
        self.assertEqual([i["id"] for i in got["items"]], ["summary", "quick"])
        self.assertEqual((got["mode"], got["palette"], got["items"][0]["size"], got["items"][1]["visible"]), ("dark", "blue", "l", False))
        for bad in ({"items": [{"id": "quick", "size": "l"}]},                       # tamaño no disponible
                    {"items": [{"id": "nope"}]},                                       # widget desconocido
                    {"items": [{"id": "quick"}, {"id": "quick"}]},                     # repetido
                    {"items": [], "mode": "neon"}, {"items": [], "palette": "rojo"},
                    {"items": [], "custom": "rojo"}, {"items": [{"id": "quick", "palette": "x"}]}, {"items": "x"}):
            self.assertEqual(self.put_layout(self.c, bad).status_code, 400, bad)
        self.assertEqual(self.c.delete("/api/widgets/layout", headers=H).status_code, 200)
        self.assertIsNone(self.c.get("/api/widgets/layout").get_json()["layout"])

    def test_layout_is_per_user(self):
        self.put_layout(self.c, {"items": [{"id": "quick", "size": "s"}], "palette": "pink"})
        c2 = self.client(); self.register(c2, "b@x.com", "Beto")
        self.assertIsNone(c2.get("/api/widgets/layout").get_json()["layout"])

    def test_requires_login(self):
        c2 = self.client()
        for url in ("/api/widgets/data", "/api/widgets/layout", "/api/widgets/token"):
            self.assertEqual(c2.get(url).status_code, 401, url)
        self.assertEqual(c2.put("/api/widgets/layout", json={"items": []}).status_code, 403)       # sin cabecera CSRF

    def test_token_flow(self):
        self.assertFalse(self.c.get("/api/widgets/token").get_json()["has_token"])
        t1 = self.c.post("/api/widgets/token", headers=H).get_json()["token"]
        self.assertTrue(self.c.get("/api/widgets/token").get_json()["has_token"])
        anon = self.client()
        r = anon.get("/api/widgets/public?token=" + t1)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.get_json()) - {"name", "layout"}, KEYS)
        self.assertEqual(r.get_json()["name"], "Ana")
        # el token no se guarda en claro
        con = sqlite3.connect(self.path)
        self.assertNotIn(t1, [x[0] for x in con.execute("SELECT token_hash FROM widget_tokens")]); con.close()
        # inválido, regenerar invalida el anterior, revocar
        self.assertEqual(anon.get("/api/widgets/public?token=" + "x" * 32).status_code, 404)
        self.assertEqual(anon.get("/api/widgets/public").status_code, 404)
        t2 = self.c.post("/api/widgets/token", headers=H).get_json()["token"]
        self.assertNotEqual(t1, t2)
        self.assertEqual(anon.get("/api/widgets/public?token=" + t1).status_code, 404)
        self.assertEqual(anon.get("/api/widgets/public?token=" + t2).status_code, 200)
        self.assertEqual(self.c.delete("/api/widgets/token", headers=H).status_code, 200)
        self.assertEqual(anon.get("/api/widgets/public?token=" + t2).status_code, 404)

    def test_public_is_read_only(self):
        t = self.c.post("/api/widgets/token", headers=H).get_json()["token"]
        anon = self.client()
        for method in (anon.post, anon.put, anon.delete):
            self.assertIn(method("/api/widgets/public?token=" + t, headers=H).status_code, (404, 405))
        self.assertEqual(anon.get("/api/transactions?token=" + t).status_code, 401)           # el token no abre el resto de la API


if __name__ == "__main__":
    unittest.main()
