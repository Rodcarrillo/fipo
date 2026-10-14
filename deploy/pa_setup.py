"""Crea (o actualiza) la app web de FIPO en PythonAnywhere con su API oficial.

Lo ejecuta instalar_pythonanywhere.sh; no hace falta correrlo a mano. Dos pasos:

  API_TOKEN=... python pa_setup.py pick 3.13 3.12 3.11 3.10
      ¿Existe la app web <usuario>.pythonanywhere.com? Si no, la crea. Luego le pone la versión de Python más nueva
      que PythonAnywhere ACEPTE para apps web (la consola puede tener versiones que las apps web todavía no aceptan)
      e imprime  PYVER=<versión elegida>.  El instalador arma el entorno virtual con esa misma versión.

  API_TOKEN=... python pa_setup.py finish 3.12
      Carpeta del código, virtualenv, HTTPS, /static/ directo, archivo WSGI y recarga.

Documentación: https://help.pythonanywhere.com/pages/API/
Solo usa la biblioteca estándar de Python. Nunca imprime ni guarda el token.
Códigos de salida: 0 bien · 2 falta token · 3 token rechazado · 4 sin conexión · 5-8 fallo de la API · 9 ninguna versión aceptada.
"""
import getpass
import json
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def version_formats(v, current=""):
    """La API ha usado «python312» y también «3.12»; se prueba primero el formato que ya usa tu app web."""
    compact, dotted = "python" + v.replace(".", ""), v
    return [dotted, compact] if "." in str(current or "") and not str(current).startswith("python") else [compact, dotted]


def is_version_error(body):
    return isinstance(body, dict) and "python_version" in body


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("pick", "finish"):
        print("Uso: API_TOKEN=... python pa_setup.py pick 3.13 3.12 …   |   python pa_setup.py finish 3.12")
        return 64
    mode, versions = sys.argv[1], sys.argv[2:]
    token = os.environ.get("API_TOKEN", "").strip()
    if not token:
        print("Falta el API token.")
        return 2
    user = os.environ.get("PYTHONANYWHERE_USERNAME") or getpass.getuser()
    site = os.environ.get("PYTHONANYWHERE_SITE", "www.pythonanywhere.com")       # PythonAnywhere lo define solo (EE. UU. o UE)
    base_domain = os.environ.get("PYTHONANYWHERE_DOMAIN", "pythonanywhere.com")
    api = os.environ.get("FIPO_PA_API", f"https://{site}/api/v0/user/{user}")    # FIPO_PA_API: solo para pruebas
    home = os.path.expanduser("~")
    project, venv = os.path.join(home, "fipo"), os.path.join(home, "fipo", "venv")
    domain = f"{user}.{base_domain}"
    wsgi_path = os.path.join(os.environ.get("FIPO_PA_WSGI_DIR", "/var/www"), domain.replace(".", "_") + "_wsgi.py")

    def call(method, path, data=None):
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        req = urllib.request.Request(api + path, data=body, method=method, headers={"Authorization": "Token " + token})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw.decode(errors="replace")[:300]
        except urllib.error.URLError as e:
            return 0, str(e.reason)

    def ok(status):
        return 200 <= status < 300

    st, app = call("GET", f"/webapps/{domain}/")
    if st in (401, 403):
        print("  ✖ PythonAnywhere rechazó el API token (¿lo copiaste completo?). Revisa Account → API token.")
        return 3
    if st == 0:
        print(f"  ✖ No pude conectar con la API de PythonAnywhere: {app}")
        return 4
    if st != 404 and not ok(st):
        print(f"  ✖ Respuesta inesperada de PythonAnywhere ({st}): {app}")
        return 5

    if mode == "pick":
        print(f"  · Tu dirección será: https://{domain}")
        exists = ok(st)
        current = (app or {}).get("python_version", "") if exists else ""
        print("  · La app web ya existía; la actualizo." if exists else "  · Creando la app web…")
        rejected = []
        for v in versions:
            for fmt in version_formats(v, current):
                if exists:
                    st, body = call("PATCH", f"/webapps/{domain}/", {"python_version": fmt})
                else:
                    st, body = call("POST", "/webapps/", {"domain_name": domain, "python_version": fmt})
                if ok(st):
                    if rejected:
                        print(f"  · PythonAnywhere todavía no acepta Python {', '.join(rejected)} para apps web; uso Python {v}.")
                    print(f"PYVER={v}")
                    return 0
                if not is_version_error(body):
                    print(f"  ✖ No se pudo {'configurar' if exists else 'crear'} la app web ({st}): {body}")
                    return 5
            rejected.append(v)
        print(f"  ✖ PythonAnywhere no aceptó ninguna de estas versiones de Python para apps web: {', '.join(versions)}.")
        return 9

    # finish
    if not ok(st):
        print("  ✖ La app web no existe todavía; corre el instalador completo.")
        return 5
    pyver = versions[0]
    st, body = call("PATCH", f"/webapps/{domain}/", {"source_directory": project, "virtualenv_path": venv, "force_https": "True"})
    if not ok(st):
        print(f"  ✖ No se pudo configurar la app web ({st}): {body}")
        return 6

    st, maps = call("GET", f"/webapps/{domain}/static_files/")
    if ok(st) and isinstance(maps, list) and not any(m.get("url") == "/static/" for m in maps):
        st2, body = call("POST", f"/webapps/{domain}/static_files/", {"url": "/static/", "path": os.path.join(project, "static")})
        if not ok(st2):
            print(f"  · (Aviso) No pude agregar /static/ ({st2}); la app funciona igual, solo un poco más lenta.")

    try:
        shutil.copyfile(os.path.join(HERE, "pythonanywhere_wsgi.py"), wsgi_path)
        print(f"  · Archivo WSGI listo: {wsgi_path}")
    except OSError as e:
        print(f"  ✖ No pude escribir {wsgi_path}: {e}")
        return 7

    st, body = call("POST", f"/webapps/{domain}/reload/")
    if not ok(st):
        print(f"  ✖ La app quedó configurada pero no se pudo recargar ({st}): {body}. Dale 'Reload' en la pestaña Web.")
        return 8
    print(f"  · App web con Python {pyver}, recargada.")
    print(f"DOMAIN={domain}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
