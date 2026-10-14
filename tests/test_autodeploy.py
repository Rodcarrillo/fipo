"""Actualización automática: solo con la firma secreta de GitHub; sin deploy.key la dirección no existe."""
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["FIPO_NO_SCHEDULER"] = "1"


class TestAutodeploy(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ["FIPO_DATA_DIR"] = self.dir
        import app as appmod
        self.app = appmod.create_app(os.path.join(self.dir, "t.db"))
        self.c = self.app.test_client()

    def tearDown(self):
        os.environ.pop("FIPO_DATA_DIR", None)
        shutil.rmtree(self.dir, ignore_errors=True)

    def sign(self, key, body):
        return "sha256=" + hmac.new(key.encode(), body, hashlib.sha256).hexdigest()

    def post(self, body, sig=None, event="push"):
        h = {"X-GitHub-Event": event, "Content-Type": "application/json"}
        if sig:
            h["X-Hub-Signature-256"] = sig
        return self.c.post("/api/deploy", data=body, headers=h)

    def test_without_key_does_not_exist(self):
        self.assertEqual(self.post(b"{}", "sha256=x").status_code, 404)

    def test_bad_signature_rejected_and_good_one_pulls(self):
        with open(os.path.join(self.dir, "deploy.key"), "w") as f:
            f.write("secreto123")
        body = json.dumps({"ref": "refs/heads/main"}).encode()
        self.assertEqual(self.post(body).status_code, 403)
        self.assertEqual(self.post(body, self.sign("otra", body)).status_code, 403)
        self.assertEqual(self.post(b"{}", self.sign("secreto123", b"{}"), "ping").get_json(), {"ok": True, "pong": True})
        ok = subprocess.CompletedProcess([], 0, "", "")
        with mock.patch("autodeploy.subprocess.run", return_value=ok) as run, mock.patch("autodeploy.reload_app", return_value=["/var/www/x_wsgi.py"]):
            r = self.post(body, self.sign("secreto123", body))
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(run.call_args[0][0][:4], ["git", "-C", os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pull"])
        self.assertEqual(r.get_json()["reloaded"], ["/var/www/x_wsgi.py"])


if __name__ == "__main__":
    unittest.main()
