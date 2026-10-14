"""«Cargar mis datos»: prueba sin guardar, carga todo-o-nada, tarjetas con meses y pago final, inversiones sin duplicar."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_cards_plans import Clock  # noqa: E402
import portfolio  # noqa: E402


class NoNet:
    @staticmethod
    def quote(symbol):
        raise RuntimeError("sin red en pruebas")


def payload():
    return {"format": "fipo-carga", "version": 1, "fx": [{"currency": "MXN", "per_usd": "17.22", "date": "2026-09-19"}],
            "accounts": [
                {"name": "BBVA", "type": "bank", "currency": "MXN", "balance": "2446.66"},
                {"name": "Rappi", "type": "credit", "currency": "MXN", "credit_limit": "35000", "cut_day": 15, "due_day": 5,
                 "statement_balance": "6454.97", "after_cut": "7799.08",
                 "plans": [{"kind": "diferido", "description": "Diferido", "monthly_amount": "1350.95", "months_total": 2, "months_remaining": 2},
                           {"kind": "msi", "description": "Amazon", "monthly_amount": "338.66", "months_total": 2, "months_remaining": 2}]},
                {"name": "Banamex", "type": "credit", "currency": "MXN", "credit_limit": "21000", "cut_day": 8, "due_day": 28, "statement_balance": "2853",
                 "plans": [{"kind": "msi", "description": "iPhone", "monthly_amount": "579", "months_total": 24, "months_remaining": 12},
                           {"kind": "msi", "description": "iPhone (pago final)", "monthly_amount": "6682", "months_total": 1, "months_remaining": 1, "starts_after_cuts": 12}]},
                {"name": "GBM USA", "type": "investment", "currency": "USD", "total_value": "100.00", "prices": {"AAA": "20", "BBB": "5"},
                 "holdings": [{"symbol": "AAA", "kind": "buy", "quantity": "3", "price": "10", "date": "2026-08-10"},
                              {"symbol": "BBB", "kind": "buy", "quantity": "4", "price": "6", "date": "2026-08-11"},
                              {"symbol": "AAA", "kind": "sell", "quantity": "1", "price": "15", "date": "2026-09-01"}]},
                {"name": "Por cobrar: Rafa", "type": "other", "currency": "MXN", "balance": "3640"}]}


class TestRestore(Clock):
    def setUp(self):
        super().setUp()
        self.set_today("2026-09-30")
        self._m = portfolio.Market
        portfolio.Market = NoNet
        self.bank_before = len(self.c.get("/api/accounts").get_json()["accounts"])

    def tearDown(self):
        portfolio.Market = self._m
        super().tearDown()

    def load(self, dry=True, data=None):
        return self.post(self.c, "/api/restore", {"data": data or payload(), "dry_run": dry})

    def test_dry_run_saves_nothing_and_matches_commit(self):
        r = self.load(True)
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(len(self.c.get("/api/accounts").get_json()["accounts"]), self.bank_before)
        preview = {a["name"]: a for a in r.get_json()["accounts"]}
        self.assertEqual(self.load(False).status_code, 200)
        cards = {c["name"]: c for c in self.c.get("/api/cards").get_json()["cards"]}
        self.assertEqual(cards["Rappi"]["used"], 1763327)                        # 6454.97 + 3379.22 + 7799.08
        self.assertEqual(cards["Rappi"]["statement"]["pending"], 645497)        # pago del mes = lo del estado de cuenta
        self.assertEqual(cards["Rappi"]["statement"]["new_charges"], 779908)    # lo posterior al corte se ve como cargos nuevos
        self.assertEqual(preview["Rappi"]["to_pay"], 645497)
        bx = cards["Banamex"]
        self.assertEqual(bx["used"], 285300 + 57900 * 12 + 668200)
        self.assertEqual(bx["statement"]["pending"], 285300)
        final = next(p for p in bx["plans"] if "final" in p["description"])
        self.assertEqual(final["next_date"], "2027-10-08")                      # se cobra después de las 12 mensualidades

    def test_investments_not_duplicated(self):
        self.load(False)
        acc = next(a for a in self.c.get("/api/accounts").get_json()["accounts"] if a["name"] == "GBM USA")
        # acciones: AAA 2 × 20 + BBB 4 × 5 = 60; efectivo = 100 − 60 = 40
        self.assertEqual((acc["holdings_value"], acc["balance"], acc["total_value"]), (6000, 4000, 10000))
        self.assertEqual(acc["total_value_main"], 172200)                        # con el tipo de cambio de la hoja
        dash = self.c.get("/api/dashboard").get_json()["cards"]
        # patrimonio: BBVA + banco de la prueba + por cobrar + GBM (efectivo 40 + acciones 60 USD a 17.22) − tarjetas
        rappi, banamex = 1763327, 285300 + 57900 * 12 + 668200
        self.assertEqual(dash["net_worth"], 5000000 + 244666 + 364000 + 172200 - rappi - banamex)
        pf = self.c.get("/api/portfolio").get_json()
        self.assertEqual(pf["totals_all"]["market_value"], 103320)
        self.assertEqual(pf["accounts"][0]["total"], 10000)

    def test_all_or_nothing_and_no_duplicates(self):
        bad = payload()
        bad["accounts"][3]["total_value"] = "10"                               # acciones valen más que el total: no cuadra
        r = self.load(False, bad)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(len(self.c.get("/api/accounts").get_json()["accounts"]), self.bank_before)
        self.assertEqual(self.load(False).status_code, 200)
        again = self.load(True)
        self.assertEqual(again.status_code, 400)
        self.assertIn("Ya tienes cuentas", again.get_json()["error"])

    def test_rejects_other_files(self):
        self.assertEqual(self.load(True, {"format": "otro"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
