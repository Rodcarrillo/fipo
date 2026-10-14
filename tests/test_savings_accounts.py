"""Ahorro e Inversión del mes salen de las cuentas marcadas como «Cuenta de ahorro» / «Cuenta de inversión»."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_finance import Base, H  # noqa: E402


class TestSavingsAccounts(Base):
    def setUp(self):
        super().setUp()
        self.register(self.c)
        self.bank = self.account(self.c, "Nómina", "0")
        self.inc, self.exp = self.cat(self.c, "income"), self.cat(self.c, "expense")
        self.tx(self.c, type="income", amount="20000", account_id=self.bank, category_id=self.inc)
        self.tx(self.c, type="expense", amount="8000", account_id=self.bank, category_id=self.exp)

    def hs(self):
        return self.c.get("/api/health-score").get_json()

    def test_without_savings_accounts_savings_is_leftover(self):
        h = self.hs()
        self.assertEqual(h["savings_source"], "leftover")
        self.assertEqual(h["amounts"], {"living": 800000, "savings": 1200000, "investments": 0})

    def test_savings_and_investment_come_from_transfers(self):
        rev = self.account(self.c, "Revolut", "0", typ="savings")
        gbm = self.account(self.c, "GBM Smart Cash", "0", typ="investment")
        gbm2 = self.account(self.c, "GBM otra", "0", typ="investment")
        self.tx(self.c, type="transfer", amount="5000", account_id=self.bank, to_account_id=rev)
        self.tx(self.c, type="transfer", amount="1000", account_id=rev, to_account_id=self.bank)       # sacaste 1,000 del ahorro
        self.tx(self.c, type="transfer", amount="3000", account_id=self.bank, to_account_id=gbm)
        self.tx(self.c, type="transfer", amount="2000", account_id=gbm, to_account_id=gbm2)           # entre inversiones: no cuenta
        h = self.hs()
        self.assertEqual(h["savings_source"], "accounts")
        self.assertEqual(h["amounts"], {"living": 800000, "savings": 400000, "investments": 300000})
        self.assertEqual(h["unassigned"], 2000000 - 800000 - 400000 - 300000)
        # en Inicio el ahorro es el saldo de hoy en cuentas de ahorro, como % de los activos (cuentas + portafolio)
        self.assertTrue(h["has_savings_accounts"])
        self.assertEqual(h["savings_balance"], 400000)
        self.assertEqual(h["assets_total"], 1200000)

    def test_changing_account_type_moves_it(self):
        rev = self.account(self.c, "Revolut", "0")                                                    # dada de alta como banco
        self.tx(self.c, type="transfer", amount="5000", account_id=self.bank, to_account_id=rev)
        self.assertEqual(self.hs()["savings_source"], "leftover")
        r = self.c.patch(f"/api/accounts/{rev}", json={"type": "savings"}, headers=H)
        self.assertEqual(r.status_code, 200, r.data)
        h = self.hs()
        self.assertEqual((h["savings_source"], h["amounts"]["savings"]), ("accounts", 500000))


if __name__ == "__main__":
    unittest.main()
