"""Avisos: recordatorios de tarjeta y precios objetivo. Precios = FIXTURE falso (FakeMarket)."""
import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_finance import Base, H  # noqa: E402
from test_import_portfolio import FakeMarket  # noqa: E402
import notify  # noqa: E402
import portfolio  # noqa: E402
from db import get_db  # noqa: E402


class N(Base):
    def setUp(self):
        super().setUp()
        self._q, self._h = portfolio.Market.quote, portfolio.Market.history
        portfolio.Market.quote, portfolio.Market.history = FakeMarket.quote, FakeMarket.history
        FakeMarket.fail = False
        FakeMarket.prices = {"AAPL": 200.0, "VOO": 500.0}
        FakeMarket.currencies = {}
        portfolio._last_manual_refresh.clear()
        self.register(self.c)
        self.today = date.fromisoformat(self.c.get("/api/dashboard").get_json()["period"]["today"])
        self.bank = self.account(self.c, "Banco", "10000.00")
        self.inv = self.account(self.c, "Broker", "10000.00", typ="investment")
        self.exp = self.cat(self.c, "expense")

    def tearDown(self):
        portfolio.Market.quote, portfolio.Market.history = self._q, self._h

    def notifs(self, c=None):
        return (c or self.c).get("/api/notifications").get_json()

    def buy(self, sym="AAPL"):
        return self.c.post("/api/portfolio/ops", json={"date": "2026-09-01", "account_id": self.inv, "kind": "buy", "symbol": sym,
                                                        "quantity": "1", "price": "100"}, headers=H)

    def refresh(self):
        portfolio._last_manual_refresh.clear()
        return self.c.post("/api/portfolio/refresh", headers=H)

    def alert(self, **d):
        return self.c.put("/api/price-alerts", json={"symbol": "AAPL", **d}, headers=H)


class TestCardReminders(N):
    def card_with_debt(self, days):
        due = (self.today + timedelta(days=days)).day
        card = self.account(self.c, "Visa", "0", typ="credit", credit_limit="5000", cut_day=1, due_day=due)
        self.tx(self.c, type="expense", amount="800.00", account_id=card, category_id=self.exp)
        return card

    def test_reminder_created_once_per_stage(self):
        self.card_with_debt(3)
        n = self.notifs()
        self.assertEqual(n["unread"], 1)
        self.assertIn("Visa", n["items"][0]["title"])
        self.assertIn("800.00", n["items"][0]["body"])
        self.assertEqual(self.notifs()["unread"], 1)               # consultar de nuevo no duplica

    def test_far_due_date_and_no_debt(self):
        due = (self.today + timedelta(days=12)).day
        card = self.account(self.c, "Visa", "0", typ="credit", credit_limit="5000", cut_day=1, due_day=due)
        self.tx(self.c, type="expense", amount="800.00", account_id=card, category_id=self.exp)
        self.assertEqual(self.notifs()["unread"], 0)               # faltan más de 5 días
        due2 = (self.today + timedelta(days=1)).day
        self.account(self.c, "Master", "0", typ="credit", credit_limit="5000", cut_day=1, due_day=due2)
        self.assertEqual(self.notifs()["unread"], 0)               # sin deuda no hay recordatorio

    def test_new_stage_new_notification(self):
        self.card_with_debt(0)
        n = self.notifs()["items"]
        self.assertEqual(len(n), 1)
        self.assertIn("hoy", n[0]["title"])

    def test_read_delete_and_isolation(self):
        self.card_with_debt(2)
        nid = self.notifs()["items"][0]["id"]
        other = self.client()
        self.register(other, "otra@x.com", "Otra")
        self.assertEqual(self.notifs(other)["items"], [])
        other.post("/api/notifications/read", json={"all": True}, headers=H)
        other.delete(f"/api/notifications/{nid}", headers=H)        # no puede tocar avisos ajenos
        self.assertEqual(self.notifs()["unread"], 1)
        self.assertEqual(self.c.post("/api/notifications/read", json={"ids": [nid]}, headers=H).status_code, 200)
        self.assertEqual(self.notifs()["unread"], 0)
        self.assertEqual(self.c.delete(f"/api/notifications/{nid}", headers=H).status_code, 200)
        self.assertEqual(self.notifs()["items"], [])


class TestPriceTargets(N):
    def test_upper_target_fires_once_and_rearms(self):
        self.buy()
        self.assertEqual(self.alert(lower="150", upper="250").status_code, 200)
        self.assertEqual(self.notifs()["unread"], 0)               # 200 está dentro del rango
        FakeMarket.prices["AAPL"] = 260.0
        self.refresh()
        n = self.notifs()
        self.assertEqual(n["unread"], 1)
        self.assertEqual(n["items"][0]["kind"], "price_high")
        self.refresh()                                              # sigue arriba: no repite
        self.assertEqual(self.notifs()["unread"], 1)
        FakeMarket.prices["AAPL"] = 200.0
        self.refresh()                                              # vuelve al rango: se rearma
        FakeMarket.prices["AAPL"] = 100.0
        self.refresh()
        n = self.notifs()
        self.assertEqual([i["kind"] for i in n["items"]], ["price_low", "price_high"])

    def test_immediate_and_manual_price(self):
        self.buy()
        r = self.alert(upper="150")                                 # ya está por encima (200)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.notifs()["unread"], 1)
        self.c.post("/api/portfolio/price", json={"symbol": "AAPL", "price": "90"}, headers=H)
        self.alert(lower="95")
        self.assertEqual(self.notifs()["items"][0]["kind"], "price_low")

    def test_inactive_and_delete_and_validation(self):
        self.buy()
        self.assertEqual(self.alert(lower="300", upper="250").status_code, 400)
        self.assertEqual(self.alert().status_code, 400)
        self.assertEqual(self.alert(lower="-5").status_code, 400)
        self.assertEqual(self.c.put("/api/price-alerts", json={"symbol": "VOO", "upper": "1"}, headers=H).status_code, 404)
        self.alert(upper="150", active=False)
        self.assertEqual(self.notifs()["unread"], 0)
        lst = self.c.get("/api/price-alerts").get_json()
        self.assertEqual((len(lst), lst[0]["active"], lst[0]["price"]), (1, False, 200.0))
        self.assertEqual(self.c.delete("/api/price-alerts/AAPL", headers=H).status_code, 200)
        self.assertEqual(self.c.get("/api/price-alerts").get_json(), [])

    def test_scheduler_hook(self):
        self.buy()
        self.alert(upper="250")
        FakeMarket.prices["AAPL"] = 300.0
        db = get_db_from(self)
        portfolio.refresh_symbols(db, ["AAPL"], force=True, market=FakeMarket)
        notify.run_all(db)
        self.assertEqual(self.notifs()["unread"], 1)


class TestWatchlist(N):
    """Vigilancia: tablita manual de precios objetivo, sin necesitar tener el símbolo en el portafolio."""

    def watch(self, sym="MELI", **d):
        return self.c.put("/api/watchlist", json={"symbol": sym, **d}, headers=H)

    def test_works_without_holding_the_symbol(self):
        FakeMarket.prices["MELI"] = 1800.0
        r = self.watch(entry_price="1750", exit_price="1960")
        self.assertEqual(r.status_code, 200)
        row = r.get_json()
        self.assertEqual((row["symbol"], row["price"], row["state"]), ("MELI", 1800.0, "in_range"))
        self.assertEqual(portfolio.held_symbols(get_db_from(self), 1), [])   # nunca se compró

    def test_state_above_below_and_no_price(self):
        FakeMarket.prices["META"] = 700.0
        row = self.watch("META", entry_price="510", exit_price="650").get_json()
        self.assertEqual(row["state"], "above")                              # 700 >= 650
        FakeMarket.prices["GOOGL"] = 300.0
        row = self.watch("GOOGL", entry_price="330", exit_price="400").get_json()
        self.assertEqual(row["state"], "below")                              # 300 < 330
        row = self.watch("OSCR", entry_price="25", exit_price="35").get_json()   # símbolo sin cotización en el fixture
        self.assertEqual((row["price"], row["state"]), (None, None))

    def test_validation_and_upsert_and_delete(self):
        self.assertEqual(self.watch(symbol="").status_code, 400)
        self.assertEqual(self.watch(entry_price="100", exit_price="50").status_code, 400)   # entrada >= salida
        FakeMarket.prices["MELI"] = 1800.0
        self.watch(company="MercadoLibre", entry_price="1750", exit_price="1960")
        self.watch(company="MercadoLibre", entry_price="1700", exit_price="2000")            # mismo símbolo: actualiza
        lst = self.c.get("/api/watchlist").get_json()
        self.assertEqual((len(lst), lst[0]["entry_price"], lst[0]["exit_price"]), (1, 1700.0, 2000.0))
        self.assertEqual(self.c.delete("/api/watchlist/MELI", headers=H).status_code, 200)
        self.assertEqual(self.c.get("/api/watchlist").get_json(), [])

    def test_isolation(self):
        self.watch(entry_price="1750", exit_price="1960")
        other = self.client()
        self.register(other, "otra@x.com", "Otra")
        self.assertEqual(other.get("/api/watchlist").get_json(), [])
        self.assertEqual(other.delete("/api/watchlist/MELI", headers=H).status_code, 200)     # no borra lo ajeno (no-op silencioso)
        self.assertEqual(len(self.c.get("/api/watchlist").get_json()), 1)

    def test_report_date_reminder_stages_and_dedupe(self):
        self.watch(report_date=(self.today + timedelta(days=3)).isoformat())
        n = self.notifs()
        self.assertEqual(n["unread"], 1)
        self.assertIn("MELI", n["items"][0]["title"])
        self.assertEqual(self.notifs()["unread"], 1)                          # no duplica en la misma etapa
        self.watch(report_date=(self.today + timedelta(days=1)).isoformat())  # cambia de etapa: avisa de nuevo
        self.assertEqual(self.notifs()["unread"], 2)
        self.watch(report_date=(self.today - timedelta(days=1)).isoformat())  # ya pasó: no avisa
        self.assertEqual(self.notifs()["unread"], 2)

    def test_fx_rate_shown_for_foreign_currency_symbol(self):
        # MELI cotiza en dólares (fixture); el usuario tiene MXN como moneda principal.
        FakeMarket.prices["MELI"] = 1800.0
        FakeMarket.currencies["MELI"] = "USD"
        FakeMarket.prices["MXN=X"] = 18.5           # 1 USD = 18.50 MXN
        row = self.watch(entry_price="1750", exit_price="1960").get_json()
        self.assertEqual((row["currency"], row["main_currency"], row["fx_rate"]), ("USD", "MXN", 18.5))
        lst = self.c.get("/api/watchlist").get_json()
        self.assertEqual((lst[0]["currency"], lst[0]["fx_rate"]), ("USD", 18.5))

    def test_fx_rate_none_when_conversion_unavailable(self):
        # MELI en dólares, pero sin tipo de cambio USD->MXN disponible (fixture no lo tiene): fx_rate es None,
        # no truena ni inventa un número.
        FakeMarket.prices["MELI"] = 1800.0
        FakeMarket.currencies["MELI"] = "USD"
        row = self.watch(entry_price="1750", exit_price="1960").get_json()
        self.assertEqual((row["currency"], row["fx_rate"]), ("USD", None))

    def test_fx_rate_is_one_when_same_currency(self):
        # MELI en la fixture por defecto cotiza en MXN, igual que la moneda principal del usuario: no hace
        # falta convertir.
        FakeMarket.prices["MELI"] = 1800.0
        row = self.watch(entry_price="1750", exit_price="1960").get_json()
        self.assertEqual((row["currency"], row["main_currency"], row["fx_rate"]), ("MXN", "MXN", 1.0))


class TestFxRate(N):
    def test_direct_usd_to_other_and_back(self):
        db = get_db_from(self)
        FakeMarket.prices["MXN=X"] = 18.5
        self.assertEqual(portfolio.get_fx_rate(db, "USD", "MXN", market=FakeMarket), 18.5)
        self.assertAlmostEqual(portfolio.get_fx_rate(db, "MXN", "USD", market=FakeMarket), 1 / 18.5)

    def test_bridges_between_two_non_usd_currencies(self):
        db = get_db_from(self)
        FakeMarket.prices["MXN=X"] = 18.5           # 1 USD = 18.50 MXN
        FakeMarket.prices["EUR=X"] = 0.92            # 1 USD = 0.92 EUR
        rate = portfolio.get_fx_rate(db, "EUR", "MXN", market=FakeMarket)  # 1 EUR = 18.5/0.92 MXN
        self.assertAlmostEqual(rate, 18.5 / 0.92)

    def test_same_currency_is_one_without_any_lookup(self):
        db = get_db_from(self)
        self.assertEqual(portfolio.get_fx_rate(db, "MXN", "MXN", market=FakeMarket), 1.0)

    def test_missing_rate_returns_none(self):
        db = get_db_from(self)
        self.assertIsNone(portfolio.get_fx_rate(db, "USD", "MXN", market=FakeMarket))  # MXN=X no está en la fixture


def get_db_from(t):
    import sqlite3
    conn = sqlite3.connect(t.app.config["DATABASE"], isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


if __name__ == "__main__":
    unittest.main()


class MiniSMTP:
    """Servidor SMTP mínimo en un hilo, para probar el envío real por el protocolo (sin internet)."""
    def __init__(self):
        import socketserver, threading
        self.msgs = []
        outer = self

        class H(socketserver.StreamRequestHandler):
            def handle(self):
                w = lambda t: self.wfile.write((t + "\r\n").encode())
                w("220 mini ESMTP")
                data, in_data = [], False
                for raw in self.rfile:
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if in_data:
                        if line == ".":
                            in_data = False; outer.msgs.append("\n".join(data)); data = []; w("250 ok")
                        else:
                            data.append(line[1:] if line.startswith("..") else line)
                        continue
                    c = line.upper()
                    if c.startswith("EHLO") or c.startswith("HELO"): w("250 mini")
                    elif c.startswith("DATA"): in_data = True; w("354 go")
                    elif c.startswith("QUIT"): w("221 bye"); return
                    else: w("250 ok")
        self.srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown(); self.srv.server_close()


class TestEmail(N):
    def setUp(self):
        super().setUp()
        import mailer
        self.mailer = mailer
        mailer.ASYNC = False
        self.smtp = MiniSMTP()
        self._env = {k: os.environ.get(k) for k in ("FIPO_SMTP_HOST", "FIPO_SMTP_PORT", "FIPO_SMTP_TLS", "FIPO_PUBLIC_URL")}

    def tearDown(self):
        self.smtp.close()
        self.mailer.ASYNC = True
        for k, v in self._env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        super().tearDown()

    def smtp_on(self):
        os.environ.update({"FIPO_SMTP_HOST": "127.0.0.1", "FIPO_SMTP_PORT": str(self.smtp.port), "FIPO_SMTP_TLS": "0", "FIPO_PUBLIC_URL": "https://fipo.example"})

    def due_card(self):
        due = (self.today + timedelta(days=1)).day
        card = self.account(self.c, "Visa", "0", typ="credit", credit_limit="5000", cut_day=1, due_day=due)
        self.tx(self.c, type="expense", amount="800.00", account_id=card, category_id=self.exp)

    def test_cannot_enable_without_smtp(self):
        for k in ("FIPO_SMTP_HOST", "OLIVA_SMTP_HOST"):
            os.environ.pop(k, None)
        r = self.c.patch("/api/me", json={"notify_email": True}, headers=H)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(self.c.get("/api/me").get_json()["user"]["notify_email"])
        self.assertFalse(self.c.get("/api/me").get_json()["email_available"])

    def test_email_sent_once_when_enabled(self):
        self.smtp_on()
        self.assertTrue(self.c.get("/api/me").get_json()["email_available"])
        self.assertEqual(self.c.patch("/api/me", json={"notify_email": True}, headers=H).status_code, 200)
        self.due_card()
        self.notifs(); self.notifs()                              # dos consultas: un solo correo
        self.assertEqual(len(self.smtp.msgs), 1)
        m = self.smtp.msgs[0]
        self.assertIn("Subject: FIPO", m); self.assertIn("a@x.com", m); self.assertIn("800.00", m); self.assertIn("https://fipo.example/#/cards", m)

    def test_no_email_when_not_opted_in_and_price_alert_email(self):
        self.smtp_on()
        self.due_card(); self.notifs()
        self.assertEqual(self.smtp.msgs, [])                      # sin activar no se manda nada
        self.c.patch("/api/me", json={"notify_email": True}, headers=H)
        self.buy(); self.alert(upper="150")                        # AAPL cotiza 200 en el fixture
        self.refresh()
        self.assertEqual(len(self.smtp.msgs), 1)
        self.assertIn("AAPL", self.smtp.msgs[0])

    def test_smtp_failure_does_not_break(self):
        self.smtp_on(); os.environ["FIPO_SMTP_PORT"] = "1"        # puerto cerrado
        self.c.patch("/api/me", json={"notify_email": True}, headers=H)
        self.due_card()
        self.assertEqual(self.notifs()["unread"], 1)              # el aviso en la app se crea igual
