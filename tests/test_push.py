"""Avisos push (Web Push) y revisión automática (/api/cron/<clave>)."""
import json
import os
import sys
import unittest

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_cards_plans import Clock  # noqa: E402
import notify  # noqa: E402
import webpush  # noqa: E402

APPLE = "https://web.push.apple.com/QGuQyavXutnMH8Ncz2NBdUHd"


def ua_keys():
    """Llaves de un «navegador» falso para poder descifrar lo que manda el servidor."""
    k = ec.generate_private_key(ec.SECP256R1())
    pub = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return k, webpush.b64u(pub), webpush.b64u(os.urandom(16))


def decrypt(body, ua_priv, ua_pub_b64, auth_b64):
    """Descifrado aes128gcm independiente (lado del navegador) para verificar lo que se envía."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, idlen = body[:16], body[20]
    as_pub = body[21:21 + idlen]
    ct = body[21 + idlen:]
    secret = ua_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    ua_pub = webpush.unb64u(ua_pub_b64)
    ikm = webpush._hmac(webpush._hmac(webpush.unb64u(auth_b64), secret), b"WebPush: info\x00" + ua_pub + as_pub + b"\x01")
    prk = webpush._hmac(salt, ikm)
    plain = AESGCM(webpush._hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]).decrypt(webpush._hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12], ct, None)
    assert plain.endswith(b"\x02")
    return json.loads(plain[:-1])


class TestCrypto(unittest.TestCase):
    def test_rfc8291_vector(self):
        u = webpush.unb64u
        as_priv = ec.derive_private_key(int.from_bytes(u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"), ec.SECP256R1())
        out = webpush.encrypt(u("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
                              "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
                              as_private=as_priv, salt=u("DGv6ra1nlYgDCS1FRnbzlw"))
        expected = u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8") + \
            u("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ")
        self.assertEqual(out, expected)

    def test_vapid_jwt_is_valid_es256(self):
        key = ec.generate_private_key(ec.SECP256R1())
        h = webpush.vapid_header(key, APPLE, "https://ana.pythonanywhere.com")
        t = h.split("t=")[1].split(",")[0]
        claims = jwt.decode(t, key.public_key(), algorithms=["ES256"], audience="https://web.push.apple.com")
        self.assertEqual(claims["sub"], "https://ana.pythonanywhere.com")
        self.assertIn("k=" + webpush.public_key_b64(key), h)

    def test_only_known_push_services(self):
        self.assertTrue(webpush.allowed_endpoint(APPLE))
        self.assertTrue(webpush.allowed_endpoint("https://fcm.googleapis.com/fcm/send/abc"))
        for bad in ("http://web.push.apple.com/x", "https://evil.com/x", "https://push.apple.com.evil.com/x", "https://localhost/x"):
            self.assertFalse(webpush.allowed_endpoint(bad), bad)


class TestPushFlow(Clock):
    def setUp(self):
        super().setUp()
        self.sent = []
        self._orig_t = webpush.transport
        webpush.transport = lambda ep, body, headers: (self.sent.append((ep, body, headers)) or (self.status, ""))
        self.status = 201
        self.priv, self.pub, self.auth = ua_keys()

    def tearDown(self):
        webpush.transport = self._orig_t
        super().tearDown()

    def subscribe(self, endpoint=APPLE):
        return self.post(self.c, "/api/push/subscribe", {"endpoint": endpoint, "keys": {"p256dh": self.pub, "auth": self.auth}, "device": "iPhone (app)"})

    def test_subscribe_validation_and_test_push(self):
        self.assertEqual(self.subscribe("https://evil.com/x").status_code, 400)
        bad = self.post(self.c, "/api/push/subscribe", {"endpoint": APPLE, "keys": {"p256dh": "abc", "auth": self.auth}})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.subscribe().status_code, 200)
        self.assertEqual(self.subscribe().status_code, 200)                     # repetir no duplica
        info = self.c.get("/api/push").get_json()
        self.assertEqual(info["devices"], 1)
        self.assertEqual(len(webpush.unb64u(info["public_key"])), 65)
        r = self.post(self.c, "/api/push/test")
        self.assertEqual(r.status_code, 200, r.data)
        ep, body, headers = self.sent[-1]
        self.assertEqual(headers["Content-Encoding"], "aes128gcm")
        self.assertTrue(headers["Authorization"].startswith("vapid t="))
        msg = decrypt(body, self.priv, self.pub, self.auth)
        self.assertEqual(msg["title"], "FIPO")

    def test_cron_generates_and_pushes_then_forgets_dead_devices(self):
        self.subscribe()
        self.post(self.c, "/api/recurring", {"description": "Netflix", "amount": "219", "frequency": "monthly",
                                             "account_id": self.bank, "next_date": "2026-09-20"})
        anon = self.app.test_client()                                           # la revisión no necesita sesión
        self.assertEqual(anon.get("/api/cron/equivocada").status_code, 404)
        token = notify.cron_token(os.path.dirname(self.path))
        self.set_today("2026-09-20")
        r = anon.get(f"/api/cron/{token}").get_json()
        self.assertFalse(r["skipped"])
        self.assertEqual(r["posted"], 1)
        webpush.wait(10)
        msgs = [decrypt(b, self.priv, self.pub, self.auth) for _, b, _ in self.sent]
        self.assertTrue(any("Netflix" in m["title"] for m in msgs), msgs)
        self.assertTrue(all(m["url"].startswith("/#/") for m in msgs))
        again = anon.get(f"/api/cron/{token}").get_json()                        # llamarla seguido no repite el trabajo
        self.assertTrue(again["skipped"])
        # el dispositivo desinstaló la app: Apple responde 410 y FIPO lo olvida
        self.status = 410
        self.post(self.c, "/api/push/test")
        self.assertEqual(self.c.get("/api/push").get_json()["devices"], 0)

    def test_unsubscribe(self):
        self.subscribe()
        self.post(self.c, "/api/push/unsubscribe", {"endpoint": APPLE})
        self.assertEqual(self.c.get("/api/push").get_json()["devices"], 0)
        self.assertEqual(self.post(self.c, "/api/push/test").status_code, 400)


if __name__ == "__main__":
    unittest.main()
