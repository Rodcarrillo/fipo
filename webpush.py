"""Avisos en el teléfono aunque FIPO esté cerrada (Web Push estándar: RFC 8030 / 8291 / 8292).

El iPhone (iOS 16.4 o más nuevo) los recibe si FIPO está agregada a la pantalla de inicio y aceptaste los avisos.
Cada aviso nuevo del centro de notificaciones (tarjeta por vencer, precio objetivo, cargo recurrente…) se envía
también como push a los dispositivos que activaste.

- Cifrado del mensaje: aes128gcm (RFC 8291) con la biblioteca `cryptography` (ya viene con pdfplumber).
- Identificación del servidor: VAPID (RFC 8292). Las llaves se generan solas la primera vez y se guardan en la
  carpeta de datos (vapid.pem), igual que la clave de sesiones.
- Solo se envía a servicios de push conocidos (Apple, Google, Mozilla, Microsoft): el servidor nunca hace
  peticiones a direcciones arbitrarias que alguien registre.
"""
import base64
import json
import os
import secrets
import sqlite3
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, hmac, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PUSH_HOSTS = ("push.apple.com", "fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com")
TTL = 24 * 3600
_threads = []
_lock = threading.Lock()


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(s):
    s = s.strip().replace(" ", "")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ------------------------------------------------------------------ llaves VAPID
_KEY = {}


def load_key(data_dir):
    """Llave privada P-256 del servidor; se crea una vez y se reutiliza (si cambiara, los dispositivos tendrían que reactivarse)."""
    path = os.path.join(data_dir, "vapid.pem")
    if path in _KEY:
        return _KEY[path]
    if not os.path.exists(path):
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
    with open(path, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    _KEY[path] = key
    return key


def public_key_b64(key):
    return b64u(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


def vapid_header(key, endpoint, subject, now=None):
    """Authorization: vapid t=<JWT ES256>, k=<llave pública>."""
    u = urllib.parse.urlsplit(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int((now or time.time()) + 12 * 3600), "sub": subject},
                             separators=(",", ":")).encode())
    signing_input = f"{head}.{claims}".encode()
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    sig = b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={head}.{claims}.{sig}, k={public_key_b64(key)}"


# ------------------------------------------------------------------ cifrado aes128gcm (RFC 8291)
def _hmac(key, data):
    h = hmac.HMAC(key, hashes.SHA256())
    h.update(data)
    return h.finalize()


def encrypt(payload, ua_public_b64, auth_b64, as_private=None, salt=None):
    """Cifra `payload` (bytes) para la suscripción. as_private y salt solo se pasan en pruebas (vector del RFC)."""
    ua_public = unb64u(ua_public_b64)
    auth = unb64u(auth_b64)
    if len(ua_public) != 65 or ua_public[0] != 4 or len(auth) != 16:
        raise ValueError("Suscripción no válida.")
    as_private = as_private or ec.generate_private_key(ec.SECP256R1())
    salt = salt or secrets.token_bytes(16)
    as_public = as_private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    ecdh_secret = as_private.exchange(ec.ECDH(), ua_key)
    prk_key = _hmac(auth, ecdh_secret)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)      # 0x02: último (y único) registro
    header = salt + struct.pack("!IB", 4096, len(as_public)) + as_public
    return header + ciphertext


# ------------------------------------------------------------------ envío
def allowed_endpoint(endpoint):
    try:
        u = urllib.parse.urlsplit(endpoint)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)


def _post(endpoint, body, headers, timeout=20):
    req = urllib.request.Request(endpoint, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode(errors="replace")
    except (urllib.error.URLError, OSError) as e:
        return 0, str(getattr(e, "reason", e))


transport = _post          # las pruebas lo reemplazan


def send_one(key, sub, payload, subject):
    """Envía un push. Devuelve (status, detalle). 404/410 = la suscripción ya no existe."""
    if not allowed_endpoint(sub["endpoint"]):
        return 400, "Servicio de push no permitido."
    body = encrypt(json.dumps(payload, ensure_ascii=False).encode(), sub["p256dh"], sub["auth"])
    headers = {"Authorization": vapid_header(key, sub["endpoint"], subject), "TTL": str(TTL), "Urgency": "normal",
               "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream"}
    if payload.get("tag"):
        headers["Topic"] = "".join(c for c in payload["tag"] if c.isalnum())[:32] or "fipo"
    return transport(sub["endpoint"], body, headers)


def deliver(db_path, data_dir, user_id, payload):
    """Envía `payload` a todos los dispositivos del usuario y limpia los que ya no existen. Usa su propia conexión."""
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        subs = conn.execute("SELECT * FROM push_subscriptions WHERE user_id=?", (user_id,)).fetchall()
        if not subs:
            return 0
        key = load_key(data_dir)
        sent = 0
        for s in subs:
            st, detail = send_one(key, s, payload, s["subject"] or "mailto:fipo@localhost")
            if 200 <= st < 300:
                sent += 1
                conn.execute("UPDATE push_subscriptions SET last_ok=datetime('now'), failures=0, last_error='' WHERE id=?", (s["id"],))
            elif st in (404, 410):
                conn.execute("DELETE FROM push_subscriptions WHERE id=?", (s["id"],))
            else:
                conn.execute("UPDATE push_subscriptions SET failures=failures+1, last_error=? WHERE id=?", (f"{st} {detail}"[:300], s["id"]))
        conn.commit()
        return sent
    finally:
        conn.close()


def _committed(db_path, user_id, key, timeout=10.0):
    """El aviso se crea dentro de una transacción: se envía solo cuando de verdad quedó guardado (si se deshizo, no)."""
    end = time.time() + timeout
    while True:
        conn = sqlite3.connect(db_path, timeout=30)
        try:
            if conn.execute("SELECT 1 FROM notifications WHERE user_id=? AND dedupe_key=?", (user_id, key)).fetchone():
                return True
        finally:
            conn.close()
        if time.time() >= end:
            return False
        time.sleep(0.25)


def queue(db_path, data_dir, user_id, payload, confirm_key=None):
    """En segundo plano para no hacer esperar a la pantalla; wait() espera a que terminen (lo usa la revisión automática)."""
    def run():
        try:
            if confirm_key is not None and not _committed(db_path, user_id, confirm_key):
                return
            deliver(db_path, data_dir, user_id, payload)
        except Exception as e:                       # un push fallido nunca debe tumbar nada
            print(f"[FIPO] No se pudo enviar el aviso push: {e}", flush=True)
    t = threading.Thread(target=run, name="fipo-push", daemon=True)
    with _lock:
        _threads[:] = [x for x in _threads if x.is_alive()]
        _threads.append(t)
    t.start()
    return t


def wait(timeout=25):
    end = time.time() + timeout
    with _lock:
        pending = list(_threads)
    for t in pending:
        t.join(max(0, end - time.time()))
