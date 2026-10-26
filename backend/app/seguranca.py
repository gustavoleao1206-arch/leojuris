"""Segurança: registro de acessos sensíveis + detecção de comportamento suspeito.

Reaproveita a tabela audit_logs usando o campo `method` como tipo de evento:
  VIEW     -> visualização de um lead/caso
  DOWNLOAD -> download de documento/PDF
  EXPORT   -> exportação de listas
  ALERTA   -> alerta de comportamento suspeito (gerado automaticamente)
"""
import hashlib
import hmac
import re
from datetime import datetime, timedelta

from . import models


# ---------------------------------------------------------------------------
# Termo de busca na trilha: pseudônimo, nunca o valor
#
# A busca de Precatórios/Ações compara o termo digitado contra COLUNA DE CPF.
# Gravar esse termo cru na auditoria fazia o CPF de um cliente virar registro
# permanente num segundo lugar — dado pessoal duplicado num log que ninguém
# revisa e que a política de retenção não alcança.
#
# Apagar o termo resolveria a exposição e estragaria a auditoria: some a
# resposta para "esse admin exportou a mesma pessoa cinco vezes?", que é
# justamente o abuso que a trilha existe para detectar.
#
# HMAC com a SECRET_KEY resolve os dois: o mesmo termo gera sempre o mesmo
# pseudônimo (dá para correlacionar), e não dá para voltar ao valor.
#
# 🚨 HASH SIMPLES NÃO SERVIRIA AQUI. CPF tem 11 dígitos — 10^11 combinações
# são varridas em minutos numa GPU, então um sha256 puro seria reversível na
# prática. É a chave que torna o pseudônimo irreversível, não o algoritmo.
# ---------------------------------------------------------------------------
def pseudonimo(valor: str) -> str:
    """Devolve um rótulo curto e estável para um termo sensível."""
    from .config import SECRET_KEY
    limpo = (valor or "").strip().lower()
    if not limpo:
        return ""
    mac = hmac.new(str(SECRET_KEY).encode(), limpo.encode(), hashlib.sha256)
    return "#" + mac.hexdigest()[:10]

# Janela de análise e limiares (eventos do mesmo tipo dentro da janela)
JANELA_MIN = 10
LIMIARES = {"VIEW": 25, "DOWNLOAD": 12, "EXPORT": 4}


# ---------------------------------------------------------------------------
# Como a trilha aponta para um registro
#
# São duas formas, dependendo de quem escreveu a linha:
#   1. Rótulo livre de registrar_acesso        -> "precatório #486 — Fulano"
#   2. Caminho REST gravado pelo middleware    -> "/api/precatorios/486/mover"
#
# Fica aqui, e não dentro de um router, porque mais de um lugar precisa
# interpretar isso (a tela de auditoria e o relatório de casos parados). Regex
# duplicada em dois arquivos é regex que diverge.
# ---------------------------------------------------------------------------
_RE_ROTULO = re.compile(r"\b(precat[óo]rio|a[çc][ãa]o|cliente|processo)\s*#(\d+)", re.IGNORECASE)
_RE_REST = re.compile(r"/api/(precatorios|acoes|clients|processes)/(\d+)")

_ENTIDADE_POR_ROTULO = {
    "precatorio": "precatorios", "precatório": "precatorios",
    "acao": "acoes", "ação": "acoes",
    "cliente": "clients",
    "processo": "processes",
}

# (modelo, coluna do nome, coluna usada quando o nome está vazio)
_FONTES_DE_NOME = {
    "precatorios": ("Precatorio", "requerente_nome", "numero_precatorio"),
    "acoes": ("Acao", "parte_nome", "numero_processo"),
    "clients": ("Client", "name", None),
    "processes": ("Process", "case_number", None),
}


def alvo_do_log(path: str):
    """(entidade, id) do registro que a linha da trilha aponta. None se não houver."""
    if not path:
        return None
    m = _RE_REST.search(path)
    if m:
        return (m.group(1), int(m.group(2)))
    m = _RE_ROTULO.search(path)
    if m:
        ent = _ENTIDADE_POR_ROTULO.get(m.group(1).lower())
        if ent:
            return (ent, int(m.group(2)))
    return None


def mapa_de_nomes(db, alvos) -> dict:
    """Nome de cada (entidade, id), em lote — uma query por entidade."""
    por_entidade = {}
    for ent, rid in alvos:
        por_entidade.setdefault(ent, set()).add(rid)

    nomes = {}
    for ent, ids in por_entidade.items():
        nome_modelo, campo, alternativa = _FONTES_DE_NOME.get(ent, (None, None, None))
        modelo = getattr(models, nome_modelo, None) if nome_modelo else None
        if modelo is None or not ids:
            continue
        for reg in db.query(modelo).filter(modelo.id.in_(list(ids))).all():
            valor = (getattr(reg, campo, None) or "").strip()
            if not valor and alternativa:
                valor = (getattr(reg, alternativa, None) or "").strip()
            if valor:
                nomes[(ent, reg.id)] = valor
    return nomes


def registrar_acesso(db, user, tipo: str, alvo: str = ""):
    """Registra um acesso sensível e dispara um ALERTA se o padrão for suspeito."""
    if user is None:
        return
    try:
        db.add(models.AuditLog(user_id=user.id, method=tipo, path=(alvo or "")[:300], status=200))
        db.commit()
    except Exception:
        db.rollback()
        return

    # O admin tem visão global legítima — não gera alerta sobre ele mesmo.
    if getattr(user, "role", None) == "admin":
        return

    try:
        janela = datetime.utcnow() - timedelta(minutes=JANELA_MIN)
        n = (
            db.query(models.AuditLog)
            .filter(
                models.AuditLog.user_id == user.id,
                models.AuditLog.created_at >= janela,
                models.AuditLog.method == tipo,
            )
            .count()
        )
        limiar = LIMIARES.get(tipo)
        # Dispara exatamente ao cruzar o limiar (evita repetir a cada evento)
        if limiar and n == limiar:
            ja_alertou = (
                db.query(models.AuditLog)
                .filter(
                    models.AuditLog.user_id == user.id,
                    models.AuditLog.method == "ALERTA",
                    models.AuditLog.created_at >= janela,
                )
                .count()
            )
            if not ja_alertou:
                rotulo = {"VIEW": "leads visualizados", "DOWNLOAD": "downloads", "EXPORT": "exportações"}.get(tipo, tipo)
                msg = f"Comportamento suspeito: {user.name} fez {n}+ {rotulo} em {JANELA_MIN} min"
                db.add(models.AuditLog(user_id=user.id, method="ALERTA", path=msg[:300], status=0))
                db.commit()
    except Exception:
        db.rollback()


def contar_alertas(db, minutos: int = 24 * 60) -> int:
    """Quantidade de alertas de segurança recentes (para o aviso ao admin)."""
    desde = datetime.utcnow() - timedelta(minutes=minutos)
    return (
        db.query(models.AuditLog)
        .filter(models.AuditLog.method == "ALERTA", models.AuditLog.created_at >= desde)
        .count()
    )
