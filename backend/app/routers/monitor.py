"""Monitoramento de processos via API Pública do DataJud (CNJ).

Consulta as movimentações de um processo pelo número CNJ no endpoint do
tribunal correspondente. Sob demanda (botão "Atualizar") — adequado ao plano
gratuito, que não mantém tarefas em segundo plano de forma confiável.
"""
import json
import urllib.request
import urllib.error
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..config import DATAJUD_BASE, DATAJUD_API_KEY
from ..database import get_db
from ..scope import is_admin, require_excluir


def _somente_admin(current_user: models.User = Depends(get_current_user)):
    """Gate de administrador do módulo de Monitoramento."""
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas administradores")
    return current_user


# 🔒 O gate fica no ROUTER, não em cada rota, de propósito.
#
# A auditoria de ago/2026 encontrou este módulo inteiro aberto: qualquer usuário
# autenticado (inclusive estagiário) listava, criava e EXCLUÍA monitoramentos de
# processos de todo o escritório, e disparava consultas ao CNJ em nome dele.
# A tela sempre foi admin-only — mas a tela não é autoridade, o backend é.
#
# Declarado aqui, o gate vale para TODA rota do módulo, inclusive as que alguém
# criar amanhã sem lembrar de proteger. Guard por rota é guard que um dia falta.
router = APIRouter(
    prefix="/api/monitor",
    tags=["monitoramento"],
    dependencies=[Depends(_somente_admin)],
)


def _consultar_datajud(alias: str, numero: str) -> dict:
    """Chama a API do DataJud e retorna capa + movimentações (ordenadas)."""
    digits = "".join(ch for ch in (numero or "") if ch.isdigit())
    if not digits:
        raise HTTPException(status_code=400, detail="Número do processo inválido")
    if not alias:
        raise HTTPException(status_code=400, detail="Tribunal não informado")

    url = f"{DATAJUD_BASE}/api_publica_{alias}/_search"
    body = json.dumps({"query": {"match": {"numeroProcesso": digits}}, "size": 1}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"APIKey {DATAJUD_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"DataJud retornou erro {e.code}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha ao consultar o DataJud: {e}")

    hits = (data.get("hits") or {}).get("hits") or []
    if not hits:
        return {"found": False, "capa": None, "movimentos": []}

    src = hits[0].get("_source", {})
    movs = src.get("movimentos", []) or []
    movimentos = sorted(
        [
            {"nome": m.get("nome"), "data": m.get("dataHora")}
            for m in movs
            if m.get("nome")
        ],
        key=lambda x: x["data"] or "",
        reverse=True,
    )
    capa = {
        "classe": (src.get("classe") or {}).get("nome"),
        "orgao": (src.get("orgaoJulgador") or {}).get("nome"),
        "tribunal": src.get("tribunal"),
        "ajuizamento": src.get("dataAjuizamento"),
        "grau": src.get("grau"),
    }
    return {"found": True, "capa": capa, "movimentos": movimentos}


def _aplicar_resultado(m, result, mark_seen=False) -> bool:
    """Atualiza o monitor com o resultado e retorna True se houve movimentação NOVA.

    Só considera "nova" quando o topo mudou E já existia um snapshot anterior
    (evita marcar tudo como novidade na primeira verificação).
    """
    m.last_checked = datetime.utcnow()
    nova = False
    if result.get("found") and result.get("movimentos"):
        topo = result["movimentos"][0]
        nome = (topo.get("nome") or "")[:400]
        data = topo.get("data")
        anterior = (m.last_movement, m.last_movement_date)
        if anterior != (nome, data) and anterior != (None, None):
            nova = True
        m.movements_json = json.dumps(result["movimentos"], ensure_ascii=False)
        m.last_movement = nome
        m.last_movement_date = data
    if mark_seen:
        m.has_news = 0
    elif nova:
        m.has_news = 1
    return nova


def verificar_todos(db: Session, enviar_email: bool = False) -> dict:
    """Consulta o DataJud para TODOS os monitores e marca novidades.

    Usado pelo agendador automático (enviar_email=True) e pelo botão manual.
    """
    monitores = db.query(models.Monitor).all()
    checados, novidades = 0, 0
    novos = []
    for m in monitores:
        try:
            result = _consultar_datajud(m.tribunal, m.numero)
            if _aplicar_resultado(m, result, mark_seen=False):
                novidades += 1
                novos.append(m)
            checados += 1
            db.commit()
        except Exception:
            db.rollback()
    if enviar_email and novos:
        try:
            from ..mailer import send_email
            linhas = [
                f"• {m.descricao or m.numero} ({(m.tribunal or '').upper()}): "
                f"{m.last_movement or '—'}"
                for m in novos
            ]
            corpo = (
                "Foram detectadas novas movimentações nos processos monitorados:\n\n"
                + "\n".join(linhas)
                + "\n\nAcesse o CRM para ver os detalhes.\n— LeoJuris"
            )
            send_email(
                f"[CRM] {len(novos)} processo(s) com nova movimentação", corpo
            )
        except Exception:
            pass
    return {"checados": checados, "novidades": novidades}


@router.get("", response_model=List[schemas.MonitorOut])
def list_monitores(
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    return db.query(models.Monitor).order_by(models.Monitor.created_at.desc()).all()


@router.post("", response_model=schemas.MonitorOut)
def create_monitor(
    payload: schemas.MonitorCreate,
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    m = models.Monitor(**payload.model_dump())
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


@router.delete("/{monitor_id}")
def delete_monitor(
    monitor_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_excluir(current_user)
    m = db.query(models.Monitor).get(monitor_id)
    if not m:
        raise HTTPException(status_code=404, detail="Monitoramento não encontrado")
    db.delete(m)
    db.commit()
    return {"ok": True}


@router.post("/{monitor_id}/consultar")
def consultar(
    monitor_id: int,
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    """Consulta o DataJud, atualiza o snapshot e devolve as movimentações."""
    m = db.query(models.Monitor).get(monitor_id)
    if not m:
        raise HTTPException(status_code=404, detail="Monitoramento não encontrado")

    result = _consultar_datajud(m.tribunal, m.numero)
    # O usuário está vendo o resultado agora -> marca como visto
    _aplicar_resultado(m, result, mark_seen=True)
    db.commit()
    return result


@router.post("/verificar-todos")
def verificar_todos_endpoint(
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    """Verifica todos os processos monitorados de uma vez (no DataJud)."""
    return verificar_todos(db)


@router.get("/novidades")
def novidades(
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    """Quantidade de processos com movimentação nova ainda não vista."""
    count = db.query(models.Monitor).filter(models.Monitor.has_news == 1).count()
    return {"count": count}


@router.post("/{monitor_id}/visto")
def marcar_visto(
    monitor_id: int,
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    m = db.query(models.Monitor).get(monitor_id)
    if not m:
        raise HTTPException(status_code=404, detail="Monitoramento não encontrado")
    m.has_news = 0
    db.commit()
    return {"ok": True}


@router.post("/visto-todos")
def marcar_todos_vistos(
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    db.query(models.Monitor).filter(models.Monitor.has_news == 1).update({"has_news": 0})
    db.commit()
    return {"ok": True}


@router.post("/testar-email")
def testar_email(_: models.User = Depends(get_current_user)):
    """Envia um e-mail de teste para validar a configuração SMTP (Gmail)."""
    from ..mailer import email_configurado, send_email, destinatario_padrao
    if not email_configurado():
        raise HTTPException(
            status_code=400,
            detail="E-mail não configurado. Defina SMTP_USER e SMTP_PASS (senha de app do Gmail) no servidor.",
        )
    ok = send_email(
        "[CRM] Teste de e-mail",
        "Este é um e-mail de teste do LeoJuris. Se você recebeu, "
        "o push por e-mail está funcionando corretamente.",
    )
    if not ok:
        raise HTTPException(
            status_code=502,
            detail="Não foi possível enviar. Verifique o e-mail e a SENHA DE APP do Gmail.",
        )
    return {"ok": True, "destinatario": destinatario_padrao()}


@router.get("/{monitor_id}/movimentos")
def movimentos(
    monitor_id: int,
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    """Retorna o último snapshot salvo (sem chamar o DataJud novamente)."""
    m = db.query(models.Monitor).get(monitor_id)
    if not m:
        raise HTTPException(status_code=404, detail="Monitoramento não encontrado")
    movs = json.loads(m.movements_json) if m.movements_json else []
    if m.has_news:                       # o usuário abriu -> marca como visto
        m.has_news = 0
        db.commit()
    return {"movimentos": movs, "last_checked": m.last_checked}
