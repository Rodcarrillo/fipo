#!/usr/bin/env sh
# Arranque local sin Docker: crea el entorno, instala dependencias y abre FIPO en http://127.0.0.1:5000
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
command -v tesseract >/dev/null || echo "Aviso: Tesseract no está instalado; la lectura automática de comprobantes no funcionará (instala 'tesseract-ocr' y 'tesseract-ocr-spa')."
exec python3 app.py
