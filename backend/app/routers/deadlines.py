"""Rotas de Prazos (CRUD + alertas). Todo prazo está ligado a um processo."""
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..prazos import add_dias_uteis, add_dias_corridos, hoje_local
from ..scope import scope, ensure_owner, require_view, require_edit, require_excluir

router = APIRouter(prefix="/api/deadlines", tags=["deadlines"])


@router.get("/calcular")
def calcular_prazo(
    base: str,
    dias: int,
    tipo: str = "uteis",
    _: models.User = Depends(get_current_user),
):
    """Calcula a data de um prazo a partir de uma data base.

    tipo = "uteis" (dias úteis, considerando feriados e suspensão do CPC)
    ou "corridos" (dias corridos, prorrogando para o próximo dia útil).
    """
    require_view(_, "deadlines")
    try:
        base_d = date.fromisoformat(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="Data base inválida")
    if dias < 0:
        raise HTTPException(status_code=400, detail="Número de dias inválido")
    resultado = (
        add_dias_corridos(base_d, dias) if tipo == "corridos"
        else add_dias_uteis(base_d, dias)
    )
    return {"data": resultado.isoformat(), "tipo": tipo, "dias": dias}


def _to_out(deadline: models.Deadline) -> schemas.DeadlineOut:
    """Acrescenta rótulo do processo e dias restantes (alerta)."""
    data = schemas.DeadlineOut.model_validate(deadline)
    if deadline.process:
        label = deadline.process.case_number or f"Processo #{deadline.process.id}"
        if deadline.process.client:
            label += f" — {deadline.process.client.name}"
        data.process_label = label
    # "Hoje" de Brasília, não o do servidor (UTC): entre 21h e meia-noite o
    # `date.today()` do Render já é amanhã e o prazo de hoje aparecia vencido.
    data.days_left = (deadline.date - hoje_local()).days
    return data


@router.get("", response_model=List[schemas.DeadlineOut])
def list_deadlines(
    process_id: Optional[int] = None,
    client_id: Optional[int] = None,
    upcoming_days: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lista prazos. Use upcoming_days=7 para alertar prazos dos próximos N dias.

    `client_id` (ficha do cliente): os prazos de todos os processos do cliente.
    É só um FILTRO sobre a mesma consulta com `scope` — nunca devolve prazo que
    a tela de Prazos esconderia da mesma pessoa.
    """
    require_view(current_user, "deadlines")
    query = scope(db.query(models.Deadline), models.Deadline, current_user)
    if process_id:
        query = query.filter(models.Deadline.process_id == process_id)
    if client_id:
        procs = db.query(models.Process.id).filter(
            models.Process.client_id == client_id
        ).scalar_subquery()
        query = query.filter(models.Deadline.process_id.in_(procs))
    deadlines = query.order_by(models.Deadline.date).all()
    result = [_to_out(d) for d in deadlines]
    if upcoming_days is not None:
        # Filtra prazos pendentes que vencem dentro da janela de dias
        result = [
            d for d in result
            if not d.done and d.days_left is not None and 0 <= d.days_left <= upcoming_days
        ]
    return result


@router.post("", response_model=schemas.DeadlineOut)
def create_deadline(
    payload: schemas.DeadlineCreate,
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    require_edit(_, "deadlines")
    # O processo vinculado precisa existir E ser alcançável por quem está criando.
    #
    # 🚨 A existência sozinha (como era até ago/2026) tinha DOIS efeitos ruins,
    # e o segundo é pior que vazamento:
    #  1. a resposta devolvia número CNJ e nome do cliente de um processo que a
    #     pessoa não pode ler;
    #  2. como o prazo HERDA o dono do processo (linha abaixo), dava para
    #     plantar prazo na agenda de outro advogado — e ele sumia da tela de
    #     quem criou, então nem o autor via o que tinha feito.
    process = db.query(models.Process).get(payload.process_id)
    if not process:
        raise HTTPException(status_code=400, detail="Processo vinculado não existe")
    ensure_owner(process, _, "processo")
    deadline = models.Deadline(**payload.model_dump())
    deadline.owner_id = process.owner_id  # herda o dono do processo
    db.add(deadline)
    db.commit()
    db.refresh(deadline)
    return _to_out(deadline)


@router.get("/{deadline_id}", response_model=schemas.DeadlineOut)
def get_deadline(
    deadline_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "deadlines")
    deadline = db.query(models.Deadline).get(deadline_id)
    if not deadline:
        raise HTTPException(status_code=404, detail="Prazo não encontrado")
    ensure_owner(deadline, current_user, "prazo")
    return _to_out(deadline)


@router.put("/{deadline_id}", response_model=schemas.DeadlineOut)
def update_deadline(
    deadline_id: int,
    payload: schemas.DeadlineUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "deadlines")
    deadline = db.query(models.Deadline).get(deadline_id)
    if not deadline:
        raise HTTPException(status_code=404, detail="Prazo não encontrado")
    ensure_owner(deadline, current_user, "prazo")
    data = payload.model_dump(exclude_unset=True)
    # `DeadlineUpdate` aceita `process_id`: sem isto dava para repontar um prazo
    # próprio para o processo de um colega — mesma porta do create, invertida.
    novo_proc = data.get("process_id")
    alvo = None
    if novo_proc is not None and novo_proc != deadline.process_id:
        alvo = db.query(models.Process).get(novo_proc)
        if not alvo:
            raise HTTPException(status_code=400, detail="Processo vinculado não existe")
        ensure_owner(alvo, current_user, "processo")
    for field, value in data.items():
        setattr(deadline, field, value)
    if alvo is not None:
        # 🚨 Mudou de processo → passa a ser do dono do processo de DESTINO, como
        # no create. Sem isto o prazo movido (pelo admin ou pela estagiária, que
        # alcançam qualquer processo) continuava do dono antigo: sumia da tela
        # de quem agora responde pelo processo e era apagado em cascata quando
        # esse processo fosse excluído. Só na troca — PUT que não muda o
        # processo não re-deriva nada.
        deadline.owner_id = alvo.owner_id
    db.commit()
    db.refresh(deadline)
    return _to_out(deadline)


@router.delete("/{deadline_id}")
def delete_deadline(
    deadline_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "deadlines")
    require_excluir(current_user)
    deadline = db.query(models.Deadline).get(deadline_id)
    if not deadline:
        raise HTTPException(status_code=404, detail="Prazo não encontrado")
    ensure_owner(deadline, current_user, "prazo")
    # 🚨 O prazo gerado a partir de uma publicação do DJEN fica apontado por
    # `publicacoes.deadline_id` (FK). Apagar direto dava 500 no Postgres — e
    # esse é justamente o prazo mais comum. A publicação continua lá (é a prova
    # de quando o prazo começou), só sem o vínculo com o prazo excluído.
    desvincular_publicacoes_do_prazo(db, [deadline.id])
    db.delete(deadline)
    db.commit()
    return {"ok": True}


def desvincular_publicacoes_do_prazo(db: Session, deadline_ids):
    """Anula `publicacoes.deadline_id` dos prazos que vão ser apagados.

    Mantém o dono da publicação: ela NÃO volta para a fila (fila = todo
    advogado lê o inteiro teor). Sem commit — roda dentro da transação de quem
    apaga, para o vínculo só sumir se o DELETE der certo.
    """
    ids = [i for i in deadline_ids if i is not None]
    if not ids:
        return
    db.query(models.Publicacao).filter(
        models.Publicacao.deadline_id.in_(ids)
    ).update({models.Publicacao.deadline_id: None}, synchronize_session=False)
