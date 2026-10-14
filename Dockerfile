FROM python:3.12-slim
# Tesseract (OCR de comprobantes) con español e inglés
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV FIPO_DATA_DIR=/data FIPO_HTTPS=1 PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
# Un solo proceso (varios hilos): la actualización horaria de precios corre dentro del proceso.
CMD ["sh", "-c", "gunicorn -w 1 --threads 4 --timeout 90 -b 0.0.0.0:${PORT:-8000} app:app"]
