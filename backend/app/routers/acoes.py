"""Rotas do módulo de Ações Judiciais Gerais — página de gestão de caso.

Espelha o módulo de Precatórios: fila de leads + "Assumir", gestão comercial,
histórico de contatos, timeline e segregação por responsável.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..scope import (
    is_admin,
    area_permitida,
    condicao_busca_documento,
    ensure_area,
    filtrar_area,
    require_edit,
    require_excluir,
    require_view,
    validar_cliente_do_corpo,
    ve_tudo,
)

router = APIRouter(prefix="/api/acoes", tags=["acoes"])


def _scope_acao(query, user):
    """Advogado vê as próprias ações + as SEM dono (fila). Admin vê todas.

    Soma-se a permissão de ÁREA: se o admin restringiu o usuário a certas
    áreas (ex.: só Trabalhista), as demais somem da consulta.
    """
    if is_admin(user):
        return query
    # O estagiário assiste o escritório inteiro: pula a trava de dono, mas
    # continua limitado às áreas que o admin liberou para ele.
    if not ve_tudo(user):
        query = query.filter(
            or_(models.Acao.owner_id == user.id, models.Acao.owner_id.is_(None))
        )
    return filtrar_area(query, models.Acao, user)


def _ensure_acesso(a, user):
    """Valida dono e área — barra o acesso direto por ID a uma área proibida."""
    if is_admin(user):
        return
    if not ve_tudo(user) and a.owner_id is not None and a.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sem acesso a esta ação")
    ensure_area(a, user)


_SENSIVEIS = ["parte_cpf", "parte_rg", "parte_telefone", "parte_email", "parte_endereco"]


def _mascara_ativa(a, user) -> bool:
    """Máscara anti-vazamento: lead da FILA (sem dono) visto por quem NÃO enxerga
    o escritório todo. Admin e estagiário (ve_tudo) veem tudo."""
    return not ve_tudo(user) and a.owner_id is None


def _mascarar(a, user):
    out = schemas.AcaoOut.model_validate(a)
    if _mascara_ativa(a, user):
        for campo in _SENSIVEIS:
            setattr(out, campo, None)
    return out


@router.get("", response_model=List[schemas.AcaoOut])
def list_acoes(
    area: Optional[str] = None,
    status_lead: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "acoes")
    query = _scope_acao(db.query(models.Acao), current_user)
    if area:
        query = query.filter(models.Acao.area == area)
    if status_lead:
        query = query.filter(models.Acao.status_lead == status_lead)
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                models.Acao.parte_nome.ilike(like),
                # CPF só pela regra que respeita a máscara da fila (scope.py).
                condicao_busca_documento(
                    models.Acao.parte_cpf, models.Acao.owner_id, search, current_user,
                ),
                models.Acao.numero_processo.ilike(like),
            )
        )
    return [_mascarar(a, current_user) for a in query.order_by(models.Acao.id.desc()).all()]


@router.post("", response_model=schemas.AcaoOut)
def create_acao(
    payload: schemas.AcaoCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "acoes")
    data = payload.model_dump()
    owner = data.pop("owner_id", None)
    if not area_permitida(current_user, data.get("area")):
        raise HTTPException(status_code=403, detail="Sem permissão para esta área de ação")
    validar_cliente_do_corpo(db, data.get("client_id"), None, current_user)
    a = models.Acao(**data)
    # Novos leads entram na FILA; só o admin pode já atribuir um responsável.
    a.owner_id = owner if (is_admin(current_user) and owner) else None
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


@router.get("/{acao_id}", response_model=schemas.AcaoOut)
def get_acao(
    acao_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "acoes")
    a = db.query(models.Acao).get(acao_id)
    if not a:
        raise HTTPException(status_code=404, detail="Ação não encontrada")
    _ensure_acesso(a, current_user)
    from ..seguranca import registrar_acesso
    # Nome junto do ID: se a ação for excluída depois, é o que sobra na trilha.
    registrar_acesso(
        db, current_user, "VIEW",
        f"ação #{a.id}" + (f" — {a.parte_nome}" if a.parte_nome else ""),
    )
    return _mascarar(a, current_user)


@router.put("/{acao_id}", response_model=schemas.AcaoOut)
def update_acao(
    acao_id: int,
    payload: schemas.AcaoUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "acoes")
    a = db.query(models.Acao).get(acao_id)
    if not a:
        raise HTTPException(status_code=404, detail="Ação não encontrada")
    _ensure_acesso(a, current_user)
    data = payload.model_dump(exclude_unset=True)
    owner = data.pop("owner_id", None)
    # Simetria com a máscara de leitura: quem não vê os dados sensíveis de um
    # lead da fila também não os sobrescreve (senão o save do formulário apaga).
    if _mascara_ativa(a, current_user):
        for campo in _SENSIVEIS:
            data.pop(campo, None)
    # Impede migrar a ação para uma área fora da permissão do usuário.
    if "area" in data and not area_permitida(current_user, data["area"]):
        raise HTTPException(status_code=403, detail="Sem permissão para esta área de ação")
    # Repontar para o cliente de um colega não pode (ver scope.validar_cliente_do_corpo).
    validar_cliente_do_corpo(db, data.get("client_id"), a.client_id, current_user)
    for field, value in data.items():
        setattr(a, field, value)
    if owner is not None and is_admin(current_user):
        a.owner_id = owner
    db.commit()
    db.refresh(a)
    # 🚨 Mascarar a RESPOSTA também — mesmo vazamento do update_precatorio:
    # `PUT {}` devolvia os dados pessoais da parte de um lead da fila em claro.
    return _mascarar(a, current_user)


@router.delete("/{acao_id}")
def delete_acao(
    acao_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode excluir leads.")
    a = db.query(models.Acao).get(acao_id)
    if not a:
        raise HTTPException(status_code=404, detail="Ação não encontrada")
    db.delete(a)
    db.commit()
    return {"ok": True}


@router.post("/{acao_id}/assumir", response_model=schemas.AcaoOut)
def assumir_acao(
    acao_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """O advogado assume um lead da fila e passa a ser o responsável exclusivo."""
    require_edit(current_user, "acoes")
    a = db.query(models.Acao).get(acao_id)
    if not a:
        raise HTTPException(status_code=404, detail="Ação não encontrada")
    if a.owner_id is not None and a.owner_id != current_user.id and not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Este caso já tem um responsável.")
    ensure_area(a, current_user)
    a.owner_id = current_user.id
    db.commit()
    db.refresh(a)
    return a


@router.post("/{acao_id}/liberar", response_model=schemas.AcaoOut)
def liberar_acao(
    acao_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Devolve o caso para a FILA (sem dono). Permitido ao admin ou ao responsável."""
    require_edit(current_user, "acoes")
    a = db.query(models.Acao).get(acao_id)
    if not a:
        raise HTTPException(status_code=404, detail="Ação não encontrada")
    if not is_admin(current_user) and a.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Apenas o responsável ou o admin podem liberar este caso.")
    ensure_area(a, current_user)
    a.owner_id = None
    db.commit()
    db.refresh(a)
    return a


# ---------------- Histórico de contatos ----------------
def _get_acao(acao_id, db, current_user):
    a = db.query(models.Acao).get(acao_id)
    if not a:
        raise HTTPException(status_code=404, detail="Ação não encontrada")
    _ensure_acesso(a, current_user)
    return a


@router.get("/{acao_id}/contatos", response_model=List[schemas.AcaoContatoOut])
def list_contatos(
    acao_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "acoes")
    _get_acao(acao_id, db, current_user)
    return (
        db.query(models.AcaoContato)
        .filter(models.AcaoContato.acao_id == acao_id)
        .order_by(models.AcaoContato.data.desc())
        .all()
    )


@router.post("/{acao_id}/contatos", response_model=schemas.AcaoContatoOut)
def add_contato(
    acao_id: int,
    payload: schemas.ContatoCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "acoes")
    a = _get_acao(acao_id, db, current_user)
    data = payload.model_dump()
    if not data.get("data"):
        data["data"] = datetime.utcnow()
    contato = models.AcaoContato(acao_id=acao_id, owner_id=current_user.id, **data)
    db.add(contato)
    a.data_ultimo_contato = data["data"].date() if hasattr(data["data"], "date") else data["data"]
    db.commit()
    db.refresh(contato)
    return contato


@router.delete("/{acao_id}/contatos/{contato_id}")
def delete_contato(
    acao_id: int,
    contato_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "acoes")
    require_excluir(current_user)
    _get_acao(acao_id, db, current_user)
    contato = db.query(models.AcaoContato).get(contato_id)
    if not contato or contato.acao_id != acao_id:
        raise HTTPException(status_code=404, detail="Contato não encontrado")
    db.delete(contato)
    db.commit()
    return {"ok": True}


# ---------------- Timeline ----------------
@router.get("/{acao_id}/timeline")
def acao_timeline(
    acao_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "acoes")
    a = _get_acao(acao_id, db, current_user)
    events = []
    if a.created_at:
        events.append({
            "tipo": "acao", "data": a.created_at.isoformat(),
            "titulo": "Caso cadastrado", "detalhe": a.parte_nome or f"Ação #{a.id}",
        })
    for ct in a.contatos:
        if ct.data:
            events.append({
                "tipo": "contato", "data": ct.data.isoformat(),
                "titulo": f"Contato • {ct.tipo}", "detalhe": ct.descricao or "",
            })
    docs = db.query(models.Document).filter(models.Document.acao_id == acao_id).all()
    for d in docs:
        if d.uploaded_at:
            events.append({
                "tipo": "documento", "data": d.uploaded_at.isoformat(),
                "titulo": d.original_name or "Documento",
                "detalhe": _rotulo_categoria_doc(d.categoria),
            })
    events.sort(key=lambda e: e["data"], reverse=True)
    return {"acao": a.parte_nome or f"Ação #{a.id}", "events": events}


def _rotulo_categoria_doc(categoria):
    """Rótulo legível da categoria do documento ("Petição", não "peticao").

    Import local: `ficha` importa routers que importam este módulo, e o
    dicionário canônico de rótulos mora lá (um teste garante que ele cobre toda
    a lista fechada `DOC_CATEGORIAS`)."""
    from .ficha import _DOC_CATEGORIAS
    if not categoria:
        return "Documento"
    return _DOC_CATEGORIAS.get(categoria) or categoria.replace("_", " ")
