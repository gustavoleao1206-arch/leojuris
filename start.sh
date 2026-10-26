#!/usr/bin/env bash
# ============================================================
#  Script de inicialização — compatível com Render
#  - Sobe o servidor em host 0.0.0.0 e na porta $PORT (Render)
#  - A criação das tabelas e do admin inicial acontece no startup do app
# ============================================================
set -e

cd /app/backend

# Render define a variável PORT automaticamente; 8000 é o padrão local.
PORT="${PORT:-8000}"

echo "Iniciando CRM Jurídico em 0.0.0.0:${PORT}..."
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"
