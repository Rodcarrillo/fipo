"""Inicio: comparación del gasto contra el periodo anterior (mismo avance) y enlaces de las alertas."""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_cards_plans import Clock  # noqa: E402
import ledger  # noqa: E402


class TestPreviousPeriod(unittest.TestCase):
    def pp(self, period, today):
        t = date.fromisoformat(today)
        s, e = ledger.period_range(period, t)
        return [d.isoformat() for d in ledger.previous_period(period, s, e, t)]

    def test_same_progress_windows(self):
        self.assertEqual(self.pp("today", "2026-09-30"), ["2026-09-29", "2026-09-29"])
        self.assertEqual(self.pp("week", "2026-09-30"), ["2026-09-21", "2026-09-23"])        # lun-mié vs lun-mié
        self.assertEqual(self.pp("month", "2026-03-31"), ["2026-02-01", "2026-02-28"])
        self.assertEqual(self.pp("3months", "2026-09-30"), ["2026-04-01", "2026-06-30"])
        self.assertEqual(self.pp("year", "2024-02-29"), ["2023-01-01", "2023-02-28"])

    def test_custom_is_preceding_block(self):
        r = ledger.previous_period("custom", date(2026, 9, 1), date(2026, 9, 10), date(2026, 9, 30))
        self.assertEqual([d.isoformat() for d in r], ["2026-08-22", "2026-08-31"])


class TestDashboardCompare(Clock):
    def test_expense_change_and_links(self):
        self.set_today("2026-09-15")
        for d, amt in (("2026-08-05", "100.00"), ("2026-08-20", "999.00"), ("2026-09-03", "150.00")):
            self.tx(self.c, type="expense", amount=amt, date=d, account_id=self.bank, category_id=self.exp)
        r = self.c.get("/api/dashboard?period=month").get_json()
        p = r["previous"]
        self.assertEqual((p["from"], p["to"]), ("2026-08-01", "2026-08-15"))    # el 20 de agosto no cuenta: mismo avance
        self.assertEqual(p["expense"], 10000)
        self.assertEqual(p["expense_change_pct"], 50.0)
        self.assertEqual(p["label"], "vs. el mes pasado")

    def test_no_percentage_without_previous_spending(self):
        r = self.c.get("/api/dashboard?period=month").get_json()
        self.assertIsNone(r["previous"]["expense_change_pct"])

    def test_alerts_have_links(self):
        self.tx(self.c, type="expense", amount="60000.00", date="2026-09-10", account_id=self.bank)
        alerts = self.c.get("/api/dashboard").get_json()["alerts"]
        neg = [a for a in alerts if "saldo negativo" in a["text"]]
        self.assertEqual(neg[0]["link"], f"#/accounts/{self.bank}")
        self.post(self.c, "/api/budgets", {"category_id": self.exp, "amount": "100"}, method="put")
        self.tx(self.c, type="expense", amount="150.00", date="2026-09-11", account_id=self.bank, category_id=self.exp)
        alerts = self.c.get("/api/dashboard").get_json()["alerts"]
        self.assertTrue(any(a.get("link") == "#/budgets" for a in alerts))


if __name__ == "__main__":
    unittest.main()
