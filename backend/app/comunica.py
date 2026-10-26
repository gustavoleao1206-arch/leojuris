"""Cliente da API pública do DJEN/Comunica (CNJ) — publicações/intimações.

A CONSULTA é aberta (sem login). Espelha o estilo do cliente do DataJud:
chamadas simples via urllib, com normalização do JSON de resposta.

Contrato validado (jul/2026):
  GET {COMUNICA_BASE}/comunicacao?numeroOab=&ufOab=&numeroProcesso=
      &siglaTribunal=&dataDisponibilizacaoInicio=&dataDisponibilizacaoFim=
      &meio=D&pagina=&itensPorPagina=
  Resposta: { status, message, count, items: [ {...} ] }
  itensPorPagina tem mínimo efetivo ~5 (valores menores são ignorados).
"""
import html
import json
import re
import urllib.parse
import urllib.request
import urllib.error
from datetime import date, datetime
from typing import List, Optional

from .config import COMUNICA_BASE

# Limite de segurança de páginas por consulta (evita varrer volume gigante).
MAX_PAGINAS = 20
ITENS_POR_PAGINA = 100


def _http_get(params: dict) -> dict:
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    url = f"{COMUNICA_BASE}/comunicacao?{qs}"
    # Headers "de navegador": alguns WAFs recusam clientes que não parecem browser.
    req = urllib.request.Request(url, method="GET", headers={
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
        "Referer": "https://comunica.pje.jus.br/",
        "Origin": "https://comunica.pje.jus.br",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code} {e.reason} {body}".strip())
    except Exception as e:
        raise RuntimeError(f"{type(e).__name__}: {e}")


def _limpar_texto(txt: Optional[str]) -> str:
    """Remove entidades HTML e tags, deixando o inteiro teor legível."""
    if not txt:
        return ""
    t = html.unescape(txt)
    t = re.sub(r"<[^>]+>", " ", t)          # tira tags, se houver
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n\s*\n\s*\n+", "\n\n", t)
    return t.strip()


def _parse_data(s) -> Optional[date]:
    if not s:
        return None
    s = str(s)[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def normalizar(item: dict) -> dict:
    """Converte um item cru da API no formato que guardamos."""
    advs = []
    for a in (item.get("destinatarioadvogados") or []):
        adv = (a or {}).get("advogado") or {}
        advs.append({"nome": adv.get("nome"), "oab": adv.get("numero_oab"), "uf": adv.get("uf_oab")})
    partes = [p.get("nome") for p in (item.get("destinatarios") or []) if isinstance(p, dict)]
    return {
        "external_id": str(item.get("id") or ""),
        "hash": (item.get("hash") or "")[:80],
        "tribunal": item.get("siglaTribunal"),
        "numero_processo": item.get("numeroprocessocommascara") or item.get("numero_processo"),
        "tipo_comunicacao": item.get("tipoComunicacao"),
        "orgao": item.get("nomeOrgao"),
        "classe": item.get("nomeClasse"),
        "meio": item.get("meiocompleto") or item.get("meio"),
        "data_disponibilizacao": _parse_data(item.get("data_disponibilizacao") or item.get("datadisponibilizacao")),
        "texto": _limpar_texto(item.get("texto")),
        "link": item.get("link"),
        "destinatarios": json.dumps({"advogados": advs, "partes": partes}, ensure_ascii=False),
    }


def _paginar(base_params: dict) -> List[dict]:
    """Percorre as páginas e devolve os itens crus (respeita MAX_PAGINAS)."""
    itens: List[dict] = []
    pagina = 1
    while pagina <= MAX_PAGINAS:
        p = dict(base_params)
        p["pagina"] = pagina
        p["itensPorPagina"] = ITENS_POR_PAGINA
        data = _http_get(p)
        lote = data.get("items") or []
        itens.extend(lote)
        if len(lote) < ITENS_POR_PAGINA:
            break
        pagina += 1
    return itens


def consultar_bruto(params: dict) -> dict:
    """Chamada crua (retorna o JSON inteiro) — usada pelo diagnóstico."""
    return _http_get(params)


def consultar_por_oab(numero: str, uf: str, data_ini: str, data_fim: str) -> List[dict]:
    """Publicações no nome de uma OAB, num intervalo de datas (YYYY-MM-DD)."""
    numero = "".join(ch for ch in (numero or "") if ch.isdigit())
    if not numero or not uf:
        return []
    return _paginar({
        "numeroOab": numero, "ufOab": uf.upper(),
        "dataDisponibilizacaoInicio": data_ini, "dataDisponibilizacaoFim": data_fim,
    })


def consultar_por_processo(numero_processo: str, data_ini: str, data_fim: str) -> List[dict]:
    """Publicações de um processo específico, num intervalo de datas."""
    if not numero_processo:
        return []
    return _paginar({
        "numeroProcesso": numero_processo,
        "dataDisponibilizacaoInicio": data_ini, "dataDisponibilizacaoFim": data_fim,
    })
