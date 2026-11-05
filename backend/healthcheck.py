"""Health check do container, chamado pelo Coolify a cada poucos segundos.

Por que um arquivo, e não `curl` ou `python3 -c "..."`:
- a imagem é `python:3.11-slim`, que não traz `curl` nem `wget`, e o health check
  HTTP padrão do Coolify depende de um dos dois (sem eles, todo deploy é dado como
  "unhealthy" e revertido);
- o Coolify só aceita no comando de health check letras, dígitos, espaço e
  `-_./:=@,+`. Aspas e parênteses são recusados, então um one-liner em Python
  não passa.

Comando configurado no Coolify: `python3 /app/backend/healthcheck.py`.
Sai com 0 quando `/api/health` responde 200 na porta do app; 1 em qualquer outro caso.
"""
import os
import sys
import urllib.request


def main() -> int:
    porta = os.environ.get("PORT", "8000")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{porta}/api/health", timeout=5) as resposta:
            return 0 if resposta.status == 200 else 1
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
