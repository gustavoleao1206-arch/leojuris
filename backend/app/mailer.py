"""Envio de e-mail por SMTP (ex.: Gmail) — usado para o push de novidades.

Configuração por variáveis de ambiente (no Render), nunca no código:
  SMTP_HOST  (padrão smtp.gmail.com)
  SMTP_PORT  (padrão 587)
  SMTP_USER  (seu e-mail do Gmail)
  SMTP_PASS  (SENHA DE APP do Google — 16 caracteres, com 2FA ativo)
  SMTP_FROM  (opcional; padrão = SMTP_USER)
  MONITOR_NOTIFY_EMAIL (destinatário dos avisos; padrão = SMTP_USER)
"""
import os
import smtplib
from email.message import EmailMessage


def email_configurado() -> bool:
    return bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASS"))


def destinatario_padrao() -> str:
    return os.getenv("MONITOR_NOTIFY_EMAIL") or os.getenv("SMTP_USER") or ""


def send_email(subject: str, body: str, to: str = None) -> bool:
    """Envia um e-mail simples. Retorna True se enviado, False se não configurado/falhou."""
    if not email_configurado():
        return False
    host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    pwd = os.getenv("SMTP_PASS")
    sender = os.getenv("SMTP_FROM", user)
    to = to or destinatario_padrao()
    if not to:
        return False
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to
    msg.set_content(body)
    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.ehlo()
            s.starttls()
            s.login(user, pwd)
            s.send_message(msg)
        return True
    except Exception:
        return False
