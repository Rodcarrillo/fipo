"""Actualización automática desde GitHub.

GitHub avisa a POST /api/deploy cada vez que subes cambios (webhook). FIPO comprueba la firma con la
clave secreta guardada en <carpeta de datos>/deploy.key, hace `git pull` del código y se recarga sola.
Si no existe deploy.key, la dirección no existe (404): nada se puede disparar desde fuera.
Tus datos (base de datos, claves, comprobantes) viven fuera del código y git nunca los toca.
"""
import glob
import hashlib
import hmac
import os
import subprocess

from flask import jsonify, request

BASE = os.path.dirname(os.path.abspath(__file__))


def _key(data_dir):
    try:
        with open(os.path.join(data_dir, "deploy.key")) as f:
            return f.read().strip() or None
    except OSError:
        return None


def valid_signature(key, body, header):
    if not key or not header or not header.startswith("sha256="):
        return False
    good = hmac.new(key.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("sha256=" + good, header)


def reload_app():
    """En PythonAnywhere, tocar el archivo WSGI recarga la app web."""
    files = [os.environ["FIPO_WSGI_FILE"]] if os.environ.get("FIPO_WSGI_FILE") else glob.glob("/var/www/*_wsgi.py")
    done = []
    for f in files:
        try:
            os.utime(f, None)
            done.append(f)
        except OSError:
            pass
    return done


def register(app, data_dir, api_error):
    @app.post("/api/deploy")
    def autodeploy():
        key = _key(data_dir)
        if not key:
            return api_error("No encontrado.", 404)
        if not valid_signature(key, request.get_data(), request.headers.get("X-Hub-Signature-256", "")):
            return api_error("Firma no válida.", 403)
        if request.headers.get("X-GitHub-Event") == "ping":
            return jsonify({"ok": True, "pong": True})
        try:
            r = subprocess.run(["git", "-C", BASE, "pull", "--ff-only", "-q"], capture_output=True, text=True, timeout=90)
        except Exception as e:  # git no instalado, tiempo agotado…
            return api_error("No se pudo actualizar: " + str(e), 500)
        if r.returncode != 0:
            return api_error("git pull falló: " + (r.stderr or r.stdout)[-400:], 500)
        return jsonify({"ok": True, "reloaded": reload_app()})
