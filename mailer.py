"""Correo saliente por SMTP (recuperar contraseña y avisos). Sin FIPO_SMTP_HOST no se envía nada."""
import os
import smtplib
import threading
from email.message import EmailMessage

ASYNC = True          # las pruebas lo ponen en False


def env(name, default=None):
    return os.environ.get("FIPO_" + name, os.environ.get("OLIVA_" + name, default))


def configured():
    return bool(env("SMTP_HOST"))


def send(to, subject, body):
    """Envía un correo. Lanza excepción si falla (quien llama decide qué hacer)."""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = env("SMTP_FROM", "no-reply@fipo.local")
    msg["To"] = to
    msg.set_content(body)
    port = int(env("SMTP_PORT", "587"))
    if port == 465:
        s = smtplib.SMTP_SSL(env("SMTP_HOST"), port, timeout=20)
    else:
        s = smtplib.SMTP(env("SMTP_HOST"), port, timeout=20)
        if env("SMTP_TLS", "1") != "0":
            s.starttls()
    try:
        if env("SMTP_USER"):
            s.login(env("SMTP_USER"), env("SMTP_PASS", ""))
        s.send_message(msg)
    finally:
        try:
            s.quit()
        except Exception:
            pass


def send_bg(to, subject, body):
    """Envío que nunca bloquea ni tumba la petición: los fallos solo se registran."""
    def run():
        try:
            send(to, subject, body)
        except Exception as e:
            print(f"[FIPO] No se pudo enviar el aviso por correo a {to}: {e}", flush=True)
    if ASYNC:
        threading.Thread(target=run, daemon=True).start()
    else:
        run()
