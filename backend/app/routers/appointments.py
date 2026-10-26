"""Rotas de Audiências / Agenda (CRUD). Vinculadas a um processo."""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..scope import scope, ensure_owner, require_view, require_edit, require_excluir

router = APIRouter(prefix="/api/appointments", tags=["appointments"])


def _to_out(appt: models.Appointment) -> schemas.AppointmentOut:
    data = schemas.AppointmentOut.model_validate(appt)
    if appt.process:
        label = appt.process.case_number or f"Processo #{appt.process.id}"
        if appt.process.client:
            label += f" — {appt.process.client.name}"
        data.process_label = label
    return data


@router.get("", response_model=List[schemas.AppointmentOut])
def list_appointments(
    upcoming: Optional[bool] = None,
    process_id: Optional[int] = None,
    client_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lista audiências. upcoming=true retorna apenas as futuras.

    `process_id`/`client_id` (fichas): filtros sobre a MESMA consulta com
    `scope` — a ficha nunca mostra audiência que a Agenda esconderia.
    """
    require_view(current_user, "appointments")
    query = scope(db.query(models.Appointment), models.Appointment, current_user)
    if upcoming:
        query = query.filter(models.Appointment.date_time >= datetime.now())
    if process_id:
        query = query.filter(models.Appointment.process_id == process_id)
    if client_id:
        procs = db.query(models.Process.id).filter(
            models.Process.client_id == client_id
        ).scalar_subquery()
        query = query.filter(models.Appointment.process_id.in_(procs))
    appts = query.order_by(models.Appointment.date_time).all()
    return [_to_out(a) for a in appts]


@router.post("", response_model=schemas.AppointmentOut)
def create_appointment(
    payload: schemas.AppointmentCreate,
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    require_edit(_, "appointments")
    # Mesma regra dos prazos: o processo precisa existir E ser alcançável.
    # Sem `ensure_owner`, a audiência herda o dono do processo (linha abaixo) e
    # vai parar na agenda de outro advogado, sumindo da tela de quem criou.
    process = db.query(models.Process).get(payload.process_id)
    if not process:
        raise HTTPException(status_code=400, detail="Processo vinculado não existe")
    ensure_owner(process, _, "processo")
    appt = models.Appointment(**payload.model_dump())
    appt.owner_id = process.owner_id  # herda o dono do processo
    db.add(appt)
    db.commit()
    db.refresh(appt)
    return _to_out(appt)


@router.get("/{appointment_id}", response_model=schemas.AppointmentOut)
def get_appointment(
    appointment_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "appointments")
    appt = db.query(models.Appointment).get(appointment_id)
    if not appt:
        raise HTTPException(status_code=404, detail="Audiência não encontrada")
    ensure_owner(appt, current_user, "audiência")
    return _to_out(appt)


@router.put("/{appointment_id}", response_model=schemas.AppointmentOut)
def update_appointment(
    appointment_id: int,
    payload: schemas.AppointmentUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "appointments")
    appt = db.query(models.Appointment).get(appointment_id)
    if not appt:
        raise HTTPException(status_code=404, detail="Audiência não encontrada")
    ensure_owner(appt, current_user, "audiência")
    data = payload.model_dump(exclude_unset=True)
    # `AppointmentUpdate` aceita `process_id` — repontar é a outra porta do create.
    novo_proc = data.get("process_id")
    alvo = None
    if novo_proc is not None and novo_proc != appt.process_id:
        alvo = db.query(models.Process).get(novo_proc)
        if not alvo:
            raise HTTPException(status_code=400, detail="Processo vinculado não existe")
        ensure_owner(alvo, current_user, "processo")
    for field, value in data.items():
        setattr(appt, field, value)
    if alvo is not None:
        # Mudou de processo → dono do processo de destino (ver update_deadline).
        appt.owner_id = alvo.owner_id
    db.commit()
    db.refresh(appt)
    return _to_out(appt)


@router.delete("/{appointment_id}")
def delete_appointment(
    appointment_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "appointments")
    require_excluir(current_user)
    appt = db.query(models.Appointment).get(appointment_id)
    if not appt:
        raise HTTPException(status_code=404, detail="Audiência não encontrada")
    ensure_owner(appt, current_user, "audiência")
    db.delete(appt)
    db.commit()
    return {"ok": True}
