#!/usr/bin/env bash
# Conecta tu FIPO de PythonAnywhere con tu repositorio privado de GitHub (se corre UNA sola vez).
# Después, cada cambio que se suba a GitHub llega solo a tu FIPO (webhook) — ya no hay que subir zips.
#
# Uso (en una consola Bash de PythonAnywhere):   bash ~/fipo/deploy/conectar_github.sh
# Tus datos viven en ~/fipo_data y no se tocan.

set -uo pipefail
REPO="${FIPO_GH_REPO:-Rodcarrillo/fipo}"
APP_DIR="$HOME/fipo"
DATA_DIR="${FIPO_DATA_DIR:-$HOME/fipo_data}"
fail() { echo; echo "❌ $1"; exit 1; }

[ -d "$APP_DIR" ] || fail "No encuentro la carpeta $APP_DIR."
command -v git >/dev/null || fail "No encuentro git."

echo "Conectando $APP_DIR con github.com/$REPO"
echo "Pega tu token de GitHub (solo lectura del repositorio) y presiona Enter."
echo "(No se ve mientras lo pegas; es normal.)"
read -rs TOKEN; echo
[ -n "$TOKEN" ] || fail "No pegaste el token."

cd "$APP_DIR" || exit 1
[ -d .git ] || git init -q
git remote remove origin 2>/dev/null
git remote add origin "${FIPO_GH_URL:-https://x-access-token:${TOKEN}@github.com/${REPO}.git}"
git fetch -q --depth 1 origin main || fail "No pude descargar de GitHub: revisa el token (que tenga acceso a $REPO, permiso Contents: Read)."
git reset -q --hard origin/main || fail "No pude dejar el código igual al de GitHub."
git checkout -q -B main origin/main || fail "No pude crear la rama main."
git config pull.ff only

mkdir -p "$DATA_DIR"
if [ ! -s "$DATA_DIR/deploy.key" ]; then
  python3 -c 'import secrets; print(secrets.token_hex(24))' > "$DATA_DIR/deploy.key"
  chmod 600 "$DATA_DIR/deploy.key"
fi
SECRET="$(cat "$DATA_DIR/deploy.key")"

for f in /var/www/*_wsgi.py; do [ -f "$f" ] && touch "$f"; done
DOMAIN="$(ls /var/www/*_wsgi.py 2>/dev/null | head -1 | sed 's#/var/www/##; s#_wsgi.py##; s#_#.#g')"

echo
echo "✅ Listo: tu FIPO ya sale de GitHub (versión $(git log -1 --format=%h))."
echo
echo "Último paso (una vez): en GitHub abre tu repositorio → Settings → Webhooks → Add webhook"
echo "  Payload URL:   https://${DOMAIN:-TU-USUARIO.pythonanywhere.com}/api/deploy"
echo "  Content type:  application/json"
echo "  Secret:        $SECRET"
echo "  Deja «Just the push event» y toca «Add webhook»."
echo
echo "Si algún día quieres actualizar a mano:  cd ~/fipo && git pull && touch /var/www/*_wsgi.py"
