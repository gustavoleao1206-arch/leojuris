"""Consulta da trilha de auditoria (somente admin)."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models
from ..auth import get_current_user
from ..database import get_db
from ..seguranca import alvo_do_log, mapa_de_nomes

router = APIRouter(prefix="/api/auditoria", tags=["auditoria"])


@router.get("/alertas")
def contar_alertas_endpoint(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Quantidade de alertas de segurança nas últimas 24h (somente admin)."""
    if current_user.role != "admin":
        return {"count": 0}
    from ..seguranca import contar_alertas
    return {"count": contar_alertas(db)}


@router.get("")
def listar_auditoria(
    limit: int = 200,
    method: Optional[str] = None,
    search: Optional[str] = None,
    user_id: Optional[int] = None,
    role: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Trilha de auditoria, com filtros.

    Sem filtro a tela mostra só os últimos registros, e uma ação antiga
    (ex.: "quem apagou este processo?") simplesmente não aparece. Os filtros
    existem para conseguir responder esse tipo de pergunta:
      method  — DELETE | POST | PUT | VIEW | DOWNLOAD | EXPORT | ALERTA
      search  — trecho do caminho (ex.: "/api/processes")
      user_id — um usuário específico
      role    — todos os usuários de um papel (ex.: todo estagiário)
    """
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Apenas administradores")

    usuarios = db.query(models.User).all()
    nomes = {u.id: u.name for u in usuarios}
    papeis = {u.id: u.role for u in usuarios}

    q = db.query(models.AuditLog)
    if method:
        q = q.filter(models.AuditLog.method == method.upper())
    if search:
        q = q.filter(models.AuditLog.path.ilike(f"%{search}%"))
    if user_id:
        q = q.filter(models.AuditLog.user_id == user_id)
    if role:
        ids = [u.id for u in usuarios if u.role == role]
        # sem ninguém nesse papel, a lista tem de vir vazia (e não "tudo")
        q = q.filter(models.AuditLog.user_id.in_(ids or [-1]))

    logs = q.order_by(models.AuditLog.created_at.desc()).limit(min(limit, 1000)).all()

    # Resolve o nome do caso de cada linha, em lote (2 a 4 queries no total,
    # não uma por registro).
    alvos = {}
    for l in logs:
        alvo = alvo_do_log(l.path)
        if alvo:
            alvos[l.id] = alvo
    mapa = mapa_de_nomes(db, set(alvos.values()))

    saida = []
    for l in logs:
        alvo = alvos.get(l.id)
        nome_alvo = mapa.get(alvo) if alvo else None
        saida.append({
            "id": l.id,
            "user": nomes.get(l.user_id, "—"),
            "role": papeis.get(l.user_id),
            "method": l.method,
            "path": l.path,
            "status": l.status,
            "created_at": l.created_at.isoformat() if l.created_at else None,
            # Nome do caso. Vem null quando o registro foi APAGADO depois do
            # acesso — e nesse caso o rótulo gravado no `path` é a única coisa
            # que sobrou, por isso ele continua sendo exibido do lado.
            "alvo_nome": nome_alvo,
            "alvo_id": alvo[1] if alvo else None,
            "alvo_tipo": alvo[0] if alvo else None,
        })
    return saida
