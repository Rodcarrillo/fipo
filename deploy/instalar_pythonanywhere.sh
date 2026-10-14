#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------
# FIPO — instalador para PythonAnywhere (plan gratis "Beginner").
#
# Uso (en una consola Bash de PythonAnywhere, después de subir fipo.zip en la pestaña Files):
#     unzip -o fipo.zip && bash fipo/deploy/instalar_pythonanywhere.sh
#
# Hace todo solo: instala lo que FIPO necesita, crea tu app web, la configura y la enciende.
# Para ACTUALIZAR FIPO más adelante: sube el fipo.zip nuevo y corre exactamente la misma línea.
# Tus datos viven en ~/fipo_data y nunca se tocan al actualizar.
# ---------------------------------------------------------------------------------------------
set -uo pipefail

say()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

HOME_DIR="${HOME:-/home/$USER}"
APP_DIR="$HOME_DIR/fipo"
DATA_DIR="$HOME_DIR/fipo_data"
WEB_DOMAIN="$USER.${PYTHONANYWHERE_DOMAIN:-pythonanywhere.com}"

[ -f "$APP_DIR/app.py" ] || fail "No encuentro $APP_DIR/app.py. Sube fipo.zip en la pestaña Files (a /home/$USER) y corre:  unzip -o fipo.zip && bash fipo/deploy/instalar_pythonanywhere.sh"
if [ -z "${PYTHONANYWHERE_SITE:-}" ] && [ ! -d /var/www ]; then
  note "(Aviso: parece que esto no es una consola de PythonAnywhere; continúo de todos modos.)"
fi

cd "$APP_DIR" || fail "No pude entrar a $APP_DIR"

# 1) Versiones de Python de tu cuenta --------------------------------------------------------
say "1/5 Buscando las versiones de Python…"
AVAIL=""
for v in ${FIPO_PY_VERSIONS:-3.13 3.12 3.11 3.10}; do   # FIPO_PY_VERSIONS: solo para pruebas
  if command -v "python$v" >/dev/null 2>&1; then AVAIL="$AVAIL $v"; fi
done
AVAIL="${AVAIL# }"
[ -n "$AVAIL" ] || fail "Tu cuenta no tiene Python 3.10 o más nuevo. En la pestaña Account → System image elige la imagen más reciente y vuelve a intentar."
if [ -n "${FIPO_PY:-}" ]; then AVAIL="$FIPO_PY"; fi       # FIPO_PY=3.11 fuerza una versión
BOOT_PY="python${AVAIL%% *}"
note "En tu consola hay: $AVAIL"

# 2) App web: se crea o actualiza con la versión más nueva que PythonAnywhere acepte ---------
#    (la consola puede traer una versión que las apps web todavía no aceptan)
say "2/5 Creando y configurando tu app web…"
TOKEN="${API_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  note "Necesito tu API token (solo esta vez, no se guarda en ningún lado):"
  note "  pestaña Account → API token → 'Create a new API token' → copia el texto largo."
  read -r -s -p "  Pega aquí tu API token y presiona Enter (no se verá mientras lo pegas): " TOKEN
  echo
fi
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
API_OK=0
PYVER="${AVAIL%% *}"
if [ -n "$TOKEN" ]; then
  # shellcheck disable=SC2086
  if OUT="$(API_TOKEN="$TOKEN" "$BOOT_PY" deploy/pa_setup.py pick $AVAIL)"; then
    printf '%s\n' "$OUT" | grep -v '^PYVER='
    PYVER="$(printf '%s\n' "$OUT" | sed -n 's/^PYVER=//p')"
    API_OK=1
  else
    CODE=$?
    printf '%s\n' "$OUT"
    [ "$CODE" = 9 ] && fail "Revisa en la pestaña Web qué versiones ofrece «Python version» y mándame una captura."
    note "Sigo sin la API; al final te digo los clics que faltan."
  fi
fi
note "Usaré Python $PYVER"

# 3) Entorno virtual + dependencias ----------------------------------------------------------
say "3/5 Instalando lo que FIPO necesita (puede tardar 5–10 minutos la primera vez en el plan gratis)…"
if [ -x venv/bin/python ] && ! venv/bin/python -c "import sys; sys.exit(0 if '%d.%d' % sys.version_info[:2] == '$PYVER' else 1)"; then
  note "El entorno anterior era de otra versión de Python; lo recreo."
  rm -rf venv   && note "Listo el borrado; ahora descargo las librerías (verás el avance abajo)…"
fi
if [ ! -x venv/bin/python ]; then
  "python$PYVER" -m venv venv 2>/dev/null || virtualenv -p "python$PYVER" venv >/dev/null || fail "No pude crear el entorno virtual."
fi
venv/bin/pip install --disable-pip-version-check --progress-bar on -r deploy/requirements-pythonanywhere.txt || fail "Falló la instalación de dependencias (arriba está el detalle). Vuelve a correr la misma línea; si se repite, mándame una captura."
note "Listo."

# 4) Carpeta de datos + prueba de que la app arranca + encender ------------------------------
say "4/5 Preparando tu carpeta de datos, probando que FIPO arranca y encendiendo la app…"
mkdir -p "$DATA_DIR"
FIPO_DATA_DIR="$DATA_DIR" FIPO_NO_SCHEDULER=1 venv/bin/python -c "from app import app; print('  FIPO arranca bien.')" \
  || fail "FIPO no pudo arrancar (arriba está el error). Mándame una captura de esta consola."
note "Tus datos quedarán en $DATA_DIR"

OUT=""
if [ "$API_OK" = 1 ] && OUT="$(API_TOKEN="$TOKEN" venv/bin/python deploy/pa_setup.py finish "$PYVER")"; then
  printf '%s\n' "$OUT" | grep -v '^DOMAIN='
  WEB_DOMAIN="$(printf '%s\n' "$OUT" | sed -n 's/^DOMAIN=//p')"
else
  [ -n "$OUT" ] && printf '%s\n' "$OUT"
  # Plan B sin API (token vacío o rechazado): hago lo que se puede desde aquí y explico lo poquito que falta.
  WSGI="/var/www/${WEB_DOMAIN//./_}_wsgi.py"
  if [ -f "$WSGI" ] && cp deploy/pythonanywhere_wsgi.py "$WSGI" 2>/dev/null; then
    cat <<EOF

  Hazlo a mano (tu archivo WSGI ya quedó listo, solo faltan unos clics en la pestaña Web):
   a) "Python version": elige $PYVER. Si no aparece en la lista, corre esta línea con una que sí aparezca, p. ej.:
         FIPO_PY=3.12 bash fipo/deploy/instalar_pythonanywhere.sh
   b) Sección "Virtualenv": escribe  $APP_DIR/venv  y dale a la palomita.
   c) Botón verde "Reload" arriba. Luego abre https://$WEB_DOMAIN
EOF
  else
    cat <<EOF

  Hazlo a mano:
   a) Pestaña Web → "Add a new web app" → Next → "Manual configuration" → Python $PYVER → Next.
   b) Regresa a esta consola y corre otra vez:  bash fipo/deploy/instalar_pythonanywhere.sh
      (cuando te pida el token, solo presiona Enter; te dirá los clics que faltan).
EOF
  fi
  exit 1
fi

CRON_KEY="$(FIPO_DATA_DIR="$DATA_DIR" FIPO_NO_SCHEDULER=1 venv/bin/python -c "import notify; print(notify.cron_token('$DATA_DIR'))" 2>/dev/null)"

# 5) Listo ------------------------------------------------------------------------------------
say "5/5 ¡FIPO está en línea!"
cat <<EOF

  Abre:  https://$WEB_DOMAIN
  1. Crea tu cuenta (es tu cuenta real; los datos de la vista previa no se pasan solos).
  2. En tu iPhone abre esa misma dirección en Safari → Compartir → "Agregar a inicio".

  Avisos en tu iPhone aunque FIPO esté cerrada (una sola vez):
   · Abre FIPO desde el ícono de tu pantalla de inicio → campana → «Activar avisos en este dispositivo».
   · En cron-job.org (gratis) crea un cronjob «Every 30 minutes» con esta dirección:
       https://$WEB_DOMAIN/api/cron/$CRON_KEY

  Para actualizar FIPO en el futuro: sube el fipo.zip nuevo en Files y corre la misma línea:
      unzip -o fipo.zip && bash fipo/deploy/instalar_pythonanywhere.sh
  Recordatorio del plan gratis: entra a la pestaña Web UNA VEZ AL MES y da clic en
  "Run until 1 month from today"; si no, PythonAnywhere apaga la app (tus datos no se borran).
EOF
