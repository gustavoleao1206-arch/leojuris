"""Rotas do módulo de Assinaturas: gera modelos (procuração/contrato) em PDF,
acompanha o status e prepara o envio ao Clicksign (etapa futura).
"""
import os
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..config import UPLOAD_DIR
from ..database import get_db
from ..scope import (
    scope, ensure_owner, is_admin, require_view, require_edit, require_excluir,
    ensure_classificacao,
)
from ..modelos_pdf import gerar_pdf, TIPO_LABEL
from .. import clicksign

router = APIRouter(prefix="/api/assinaturas", tags=["assinaturas"])

STATUS_VALIDOS = ["rascunho", "enviado", "visualizado", "assinado", "recusado", "expirado"]
# Categorias para documentos anexados (upload)
CATEGORIA_LABEL = {
    "procuracao": "Procuração", "contrato": "Contrato", "declaracao": "Declaração",
    "peticao": "Petição", "termo": "Termo", "outro": "Documento",
}


def _enrich(a: models.Assinatura, db: Session) -> schemas.AssinaturaOut:
    data = schemas.AssinaturaOut.model_validate(a)
    if a.client_id:
        c = db.query(models.Client).get(a.client_id)
        data.client_name = c.name if c else None
    if a.precatorio_id:
        p = db.query(models.Precatorio).get(a.precatorio_id)
        data.precatorio_label = (p.requerente_nome or f"Precatório #{p.id}") if p else None
    return data


@router.get("", response_model=List[schemas.AssinaturaOut])
def list_assinaturas(
    client_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "assinaturas")
    query = scope(db.query(models.Assinatura), models.Assinatura, current_user)
    if client_id:
        # Filtro da ficha do cliente: dentro do mesmo `scope` da tela.
        query = query.filter(models.Assinatura.client_id == client_id)
    items = query.order_by(models.Assinatura.id.desc()).all()
    return [_enrich(a, db) for a in items]


@router.post("", response_model=schemas.AssinaturaOut)
def create_assinatura(
    payload: schemas.AssinaturaCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "assinaturas")
    if payload.tipo not in ("procuracao", "contrato"):
        raise HTTPException(status_code=400, detail="Tipo de modelo inválido")

    dados = {}
    owner = current_user.id

    # 🚨 O cliente do corpo é conferido SEMPRE que vier — inclusive junto de um
    # precatório. Antes, a cadeia `if/elif` abaixo só olhava o precatório: com
    # um precatório próprio + `client_id` de qualquer cliente, a assinatura era
    # gravada e a resposta devolvia o NOME do cliente alheio (`_enrich`).
    # Varrendo ids, saía a lista de clientes do escritório inteiro. E buscar
    # antes importa: `ensure_owner(None)` passa calado e o id inexistente só
    # estourava na FK.
    cli_corpo = None
    if payload.client_id:
        cli_corpo = db.query(models.Client).get(payload.client_id)
        if not cli_corpo:
            raise HTTPException(status_code=400, detail="Cliente não encontrado")
        ensure_owner(cli_corpo, current_user, "cliente")

    # Preenche os dados a partir do precatório ou do cliente vinculado
    if payload.precatorio_id:
        p = db.query(models.Precatorio).get(payload.precatorio_id)
        if not p:
            raise HTTPException(status_code=400, detail="Precatório não encontrado")
        ensure_owner(p, current_user, "precatório")
        # Não gera procuração/contrato (com PII do requerente) de classificação proibida
        ensure_classificacao(p, current_user)
        if p.owner_id:
            owner = p.owner_id
        dados.update({
            "nome": p.requerente_nome, "cpf": p.requerente_cpf, "rg": p.requerente_rg,
            "endereco": p.requerente_endereco, "email": p.requerente_email,
            "telefone": p.requerente_telefone, "numero_precatorio": p.numero_precatorio,
            "numero_originario": p.numero_originario, "tribunal": p.tribunal,
        })
    elif cli_corpo is not None:
        c = cli_corpo     # já conferido (existe + ensure_owner) lá em cima
        if c.owner_id:
            owner = c.owner_id
        dados.update({
            "nome": c.name, "cpf": c.cpf_cnpj, "email": c.email, "telefone": c.phone,
        })
    else:
        raise HTTPException(status_code=400, detail="Vincule a um precatório ou cliente")

    # Sobrescreve com os dados informados manualmente (se houver)
    if payload.signatario_nome:
        dados["nome"] = payload.signatario_nome
    if payload.signatario_cpf:
        dados["cpf"] = payload.signatario_cpf
    if payload.signatario_email:
        dados["email"] = payload.signatario_email

    # Gera o PDF e salva no disco
    buf = gerar_pdf(payload.tipo, payload.area, dados)
    stored_name = f"{uuid.uuid4().hex}.pdf"
    dest = UPLOAD_DIR / stored_name
    with open(dest, "wb") as f:
        f.write(buf.read())

    nome = dados.get("nome") or "—"
    a = models.Assinatura(
        titulo=f"{TIPO_LABEL.get(payload.tipo)} — {nome}",
        tipo=payload.tipo, area=payload.area,
        client_id=payload.client_id, precatorio_id=payload.precatorio_id,
        signatario_nome=nome, signatario_cpf=dados.get("cpf"),
        signatario_email=dados.get("email") or payload.signatario_email,
        status="rascunho", file_path=str(dest), owner_id=owner,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _enrich(a, db)


@router.post("/upload", response_model=schemas.AssinaturaOut)
def upload_assinatura(
    file: UploadFile = File(...),
    categoria: str = Form("outro"),
    client_id: int = Form(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Cria uma assinatura a partir de um documento ANEXADO (PDF próprio),
    vinculado a um cliente do sistema. O signatário é o cliente cadastrado.
    """
    require_edit(current_user, "assinaturas")
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext != ".pdf":
        raise HTTPException(status_code=400, detail="Anexe um arquivo PDF (.pdf).")

    c = db.query(models.Client).get(client_id)
    if not c:
        raise HTTPException(status_code=400, detail="Cliente não encontrado")
    ensure_owner(c, current_user, "cliente")
    owner = c.owner_id or current_user.id

    stored_name = f"{uuid.uuid4().hex}.pdf"
    dest = UPLOAD_DIR / stored_name
    with open(dest, "wb") as f:
        f.write(file.file.read())

    label = CATEGORIA_LABEL.get(categoria, "Documento")
    a = models.Assinatura(
        titulo=f"{label} — {c.name}",
        tipo=categoria, area="anexo",
        client_id=client_id, precatorio_id=None,
        signatario_nome=c.name, signatario_cpf=c.cpf_cnpj, signatario_email=c.email,
        status="rascunho", file_path=str(dest), owner_id=owner,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _enrich(a, db)


@router.get("/{assinatura_id}/pdf")
def baixar_pdf(
    assinatura_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "assinaturas")
    a = db.query(models.Assinatura).get(assinatura_id)
    if not a:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(a, current_user, "documento")
    if not a.file_path or not os.path.exists(a.file_path):
        raise HTTPException(status_code=404, detail="Arquivo PDF não encontrado")
    from ..seguranca import registrar_acesso
    registrar_acesso(db, current_user, "DOWNLOAD", f"assinatura #{a.id} {a.titulo or ''}")
    fname = (a.titulo or "documento").replace(" ", "_").replace("—", "-") + ".pdf"
    return FileResponse(a.file_path, media_type="application/pdf", filename=fname)


@router.put("/{assinatura_id}", response_model=schemas.AssinaturaOut)
def update_assinatura(
    assinatura_id: int,
    payload: schemas.AssinaturaUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "assinaturas")
    a = db.query(models.Assinatura).get(assinatura_id)
    if not a:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(a, current_user, "documento")
    data = payload.model_dump(exclude_unset=True)
    owner = data.pop("owner_id", None)
    if "status" in data and data["status"] not in STATUS_VALIDOS:
        raise HTTPException(status_code=400, detail="Status inválido")
    for field, value in data.items():
        setattr(a, field, value)
    if owner is not None and is_admin(current_user):
        a.owner_id = owner
    db.commit()
    db.refresh(a)
    return _enrich(a, db)


@router.post("/{assinatura_id}/enviar", response_model=schemas.AssinaturaOut)
def enviar_clicksign(
    assinatura_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Envia o documento ao Clicksign para assinatura digital (API v3)."""
    require_edit(current_user, "assinaturas")
    a = db.query(models.Assinatura).get(assinatura_id)
    if not a:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(a, current_user, "documento")
    if not clicksign.configurado():
        raise HTTPException(
            status_code=400,
            detail="Integração Clicksign não configurada. Defina CLICKSIGN_ACCESS_TOKEN no servidor.",
        )
    if a.clicksign_key:
        raise HTTPException(status_code=400, detail="Este documento já foi enviado ao Clicksign.")
    if not a.signatario_email:
        raise HTTPException(
            status_code=400,
            detail="O signatário não tem e-mail cadastrado. Edite o cadastro (cliente/precatório) e gere o documento novamente.",
        )
    if not a.file_path or not os.path.exists(a.file_path):
        raise HTTPException(status_code=404, detail="PDF do documento não encontrado")

    with open(a.file_path, "rb") as f:
        pdf_bytes = f.read()
    filename = (a.titulo or "documento").replace(" ", "_").replace("—", "-") + ".pdf"
    try:
        env_id = clicksign.enviar_para_assinatura(
            nome=a.signatario_nome, email=a.signatario_email, cpf=a.signatario_cpf,
            pdf_bytes=pdf_bytes, filename=filename, titulo=a.titulo or "Documento",
        )
    except clicksign.ClicksignError as e:
        raise HTTPException(status_code=400, detail=str(e))

    a.clicksign_key = env_id
    a.status = "enviado"
    db.commit()
    db.refresh(a)
    return _enrich(a, db)


@router.post("/{assinatura_id}/sincronizar", response_model=schemas.AssinaturaOut)
def sincronizar_status(
    assinatura_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Consulta o Clicksign e atualiza o status do documento."""
    require_edit(current_user, "assinaturas")
    a = db.query(models.Assinatura).get(assinatura_id)
    if not a:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(a, current_user, "documento")
    if not a.clicksign_key:
        raise HTTPException(status_code=400, detail="Este documento ainda não foi enviado ao Clicksign.")
    try:
        novo = clicksign.status_interno(a.clicksign_key)
    except clicksign.ClicksignError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if novo and novo != a.status:
        a.status = novo
        db.commit()
        db.refresh(a)
    return _enrich(a, db)


@router.post("/{assinatura_id}/notificar")
def renotificar(
    assinatura_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Reenvia o e-mail de solicitação de assinatura ao signatário."""
    require_edit(current_user, "assinaturas")
    a = db.query(models.Assinatura).get(assinatura_id)
    if not a:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(a, current_user, "documento")
    if not a.clicksign_key:
        raise HTTPException(status_code=400, detail="Este documento ainda não foi enviado ao Clicksign.")
    try:
        clicksign.notificar(a.clicksign_key)
    except clicksign.ClicksignError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "mensagem": "Notificação reenviada ao signatário."}


@router.delete("/{assinatura_id}")
def delete_assinatura(
    assinatura_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "assinaturas")
    require_excluir(current_user)
    a = db.query(models.Assinatura).get(assinatura_id)
    if not a:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(a, current_user, "documento")
    if a.file_path and os.path.exists(a.file_path):
        try:
            os.remove(a.file_path)
        except Exception:
            pass
    db.delete(a)
    db.commit()
    return {"ok": True}
