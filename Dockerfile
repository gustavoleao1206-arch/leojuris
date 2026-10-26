# ============================================================
#  CRM Jurídico — imagem de produção (FastAPI + PostgreSQL)
#  Usada pelo Render (runtime: docker) e para rodar localmente.
# ============================================================
FROM python:3.11-slim

# Evita .pyc e força logs sem buffer (melhor para o Render)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependências do sistema necessárias para o psycopg2/bcrypt
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Instala dependências Python primeiro (melhor cache de camadas)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copia o código do backend e o frontend estático
COPY backend ./backend
COPY frontend ./frontend

# Script de inicialização
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

# 🔒 Usuário sem privilégio.
# Por padrão o container roda como root: se um dia alguém explorar uma falha de
# execução remota (foi exatamente o risco da CVE de escrita arbitrária no
# python-multipart), fazer isso como root dá controle total do container. Como
# usuário comum, o estrago fica contido.
# A pasta de uploads precisa ser gravável por ele.
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && mkdir -p /app/backend/uploads \
    && chown -R appuser:appuser /app

# A aplicação roda a partir da pasta backend (módulo app.main:app)
WORKDIR /app/backend

USER appuser

# O Render injeta a variável PORT; localmente usamos 8000 como padrão.
ENV PORT=8000
EXPOSE 8000

CMD ["/app/start.sh"]
