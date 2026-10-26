"""Configurações globais do escritório (apenas admin).

Por enquanto: a regra de distribuição (rateio) de honorários de precatório.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import distribuicao, models
from ..auth import get_current_user
from ..database import get_db

router = APIRouter(prefix="/api/config", tags=["config"])


def _require_admin(user: models.User):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Apenas administradores")


class DistribuicaoConfigIn(BaseModel):
    ativo: Optional[bool] = True
    pct_reserva: float = 5.0
    reserva_nome: str = "Caixa Reserva"
    pct_parceiro_padrao: float = 20.0
    fundo_nome: str = "Fundo"
    pct_fundo: float = 35.0
    socios: list = []


def _usuarios_elegiveis(db: Session):
    """Usuários que podem ser sócios/parceiros (todos, exceto os desativados)."""
    users = db.query(models.User).order_by(models.User.name).all()
    return [{"id": u.id, "name": u.name, "role": u.role} for u in users]


@router.get("/distribuicao")
def get_distribuicao(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Regra atual + catálogo de usuários para escolher sócios e parceiros."""
    _require_admin(current_user)
    cfg = distribuicao.load_config(db)
    return {
        "config": cfg,
        "usuarios": _usuarios_elegiveis(db),
        "exemplo_base": 100000.0,  # o frontend mostra a prévia sobre este valor
    }


@router.put("/distribuicao")
def put_distribuicao(
    payload: DistribuicaoConfigIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Salva a regra global (valida que Fundo + sócios somam 100%)."""
    _require_admin(current_user)
    try:
        cfg = distribuicao.save_config(db, payload.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Recalcula o livro-razão dos honorários que seguem a regra global
    # (sem override próprio), para a mudança refletir no dashboard na hora.
    rateados = (
        db.query(models.Honorario)
        .filter(models.Honorario.rateio == 1, models.Honorario.rateio_config.is_(None))
        .all()
    )
    for h in rateados:
        distribuicao.aplicar_rateio(db, h)
    db.commit()
    return {"config": cfg, "recalculados": len(rateados)}


@router.post("/distribuicao/recalcular")
def recalcular_distribuicao(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Reaplica a regra atual a TODOS os honorários rateados que seguem o padrão
    global. Útil quando os sócios foram configurados depois de marcar o honorário.
    """
    _require_admin(current_user)
    rateados = (
        db.query(models.Honorario)
        .filter(models.Honorario.rateio == 1, models.Honorario.rateio_config.is_(None))
        .all()
    )
    for h in rateados:
        distribuicao.aplicar_rateio(db, h)
    db.commit()
    return {"recalculados": len(rateados)}
