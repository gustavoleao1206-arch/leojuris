"""Rotas de Documentos: upload, listagem e download.

Todo documento deve estar vinculado a um cliente e/ou processo.
"""
import os
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..config import UPLOAD_DIR
from ..database import get_db
from ..scope import (
    scope, ensure_owner, is_admin, require_view, require_edit, require_excluir,
    acao_areas, area_permitida, classificacao_permitida, prec_classificacoes,
    can_view,
)

router = APIRouter(prefix="/api/documents", tags=["documents"])

# ---------------------------------------------------------------------------
# Validação de upload
#
# Regra: nunca confiar no que o navegador diz. Nem na extensão, nem no
# Content-Type, nem no tamanho declarado. Tudo é verificado sobre os bytes.
# ---------------------------------------------------------------------------
MAX_UPLOAD_BYTES = 25 * 1024 * 1024        # 25 MB por arquivo

# Só o que um escritório precisa anexar. Note o que está FORA de propósito:
# .html, .svg, .js, .exe, .sh — formatos que o navegador executa ou que o
# sistema roda.
EXTENSOES_PERMITIDAS = {
    ".pdf", ".doc", ".docx", ".odt", ".rtf", ".txt",
    ".xls", ".xlsx", ".ods", ".csv",
    ".jpg", ".jpeg", ".png", ".webp", ".heic", ".zip",
}

# Primeiros bytes ("magic bytes") de cada formato. Serve para pegar o arquivo
# renomeado: um .exe salvo como "contrato.pdf" não tem a assinatura do PDF.
_ASSINATURAS = {
    ".pdf": [b"%PDF-"],
    ".jpg": [b"\xff\xd8\xff"], ".jpeg": [b"\xff\xd8\xff"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".webp": [b"RIFF"],
    # docx/xlsx/odt/ods são ZIP por dentro
    ".docx": [b"PK\x03\x04"], ".xlsx": [b"PK\x03\x04"],
    ".odt": [b"PK\x03\x04"], ".ods": [b"PK\x03\x04"], ".zip": [b"PK\x03\x04"],
    ".doc": [b"\xd0\xcf\x11\xe0"], ".xls": [b"\xd0\xcf\x11\xe0"],
}


def _ler_limitado(file: UploadFile) -> bytes:
    """Lê o arquivo cortando no limite — sem carregar 5 GB na memória.

    Ler 1 byte a mais que o teto é o suficiente para saber que estourou.
    """
    dados = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(dados) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Arquivo muito grande. O limite é {MAX_UPLOAD_BYTES // (1024*1024)} MB.",
        )
    if not dados:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")
    return dados


def _extensao_valida(nome: str) -> str:
    """Extensão em minúsculas, validada contra a allowlist."""
    ext = os.path.splitext(nome or "")[1].lower()
    if ext not in EXTENSOES_PERMITIDAS:
        permitidas = ", ".join(sorted(EXTENSOES_PERMITIDAS))
        raise HTTPException(
            status_code=400,
            detail=f"Tipo de arquivo não permitido ({ext or 'sem extensão'}). Aceitos: {permitidas}",
        )
    return ext


def _conferir_assinatura(ext: str, conteudo: bytes):
    """O conteúdo bate com a extensão declarada?

    Formatos sem assinatura estável (txt, csv, rtf, heic) passam — para esses
    a allowlist já é a proteção, porque não são executáveis no navegador.
    """
    esperadas = _ASSINATURAS.get(ext)
    if not esperadas:
        return
    if not any(conteudo.startswith(a) for a in esperadas):
        raise HTTPException(
            status_code=400,
            detail=f"O conteúdo do arquivo não corresponde a um {ext}. "
                   "Renomear a extensão não muda o tipo real do arquivo.",
        )


def _filtrar_por_vinculo(query, db, user):
    """Some com documentos presos a precatórios/ações que o usuário não pode ver."""
    if is_admin(user):
        return query
    permitidas = prec_classificacoes(user)
    if permitidas is not None:
        # scalar_subquery(): forma correta de usar uma subconsulta em in_() no SQLAlchemy 2.x
        sub = db.query(models.Precatorio.id).filter(
            models.Precatorio.classificacao.in_(permitidas)
        ).scalar_subquery()
        query = query.filter(
            or_(models.Document.precatorio_id.is_(None),
                models.Document.precatorio_id.in_(sub))
        )
    areas = acao_areas(user)
    if areas is not None:
        sub = db.query(models.Acao.id).filter(
            models.Acao.area.in_(areas)
        ).scalar_subquery()
        query = query.filter(
            or_(models.Document.acao_id.is_(None), models.Document.acao_id.in_(sub))
        )
    return query


def _ensure_vinculo(doc, db, user):
    """403 se o documento estiver ligado a um precatório/ação fora da permissão."""
    if is_admin(user) or doc is None:
        return
    if doc.precatorio_id:
        p = db.query(models.Precatorio).get(doc.precatorio_id)
        if p and not classificacao_permitida(user, p.classificacao):
            raise HTTPException(status_code=403, detail="Sem permissão para este documento")
    if doc.acao_id:
        a = db.query(models.Acao).get(doc.acao_id)
        if a and not area_permitida(user, a.area):
            raise HTTPException(status_code=403, detail="Sem permissão para este documento")


@router.get("/modelos")
def listar_modelos(_: models.User = Depends(get_current_user)):
    """Lista os modelos de documento disponíveis para geração."""
    require_view(_, "documents")
    from ..documentos_modelos import MODELOS
    return [{"id": k, "nome": v} for k, v in MODELOS.items()]


@router.get("/modelo")
def gerar_modelo_docx(
    modelo: str,
    client_id: int,
    process_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Gera um documento .docx (procuração/contrato) com os dados do cliente/processo."""
    require_view(current_user, "documents")
    cliente = db.query(models.Client).get(client_id)
    if not cliente:
        raise HTTPException(status_code=400, detail="Cliente não encontrado")
    ensure_owner(cliente, current_user, "cliente")
    processo = db.query(models.Process).get(process_id) if process_id else None
    if processo:
        ensure_owner(processo, current_user, "processo")

    from ..documentos_modelos import gerar_modelo, MODELOS
    if modelo not in MODELOS:
        raise HTTPException(status_code=400, detail="Modelo inválido")
    buf = gerar_modelo(modelo, cliente, processo)
    fname = f"{modelo}-{(cliente.name or 'cliente').split()[0].lower()}.docx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


def query_documents(db: Session, user, *, client_id: Optional[int] = None,
                    process_id: Optional[int] = None, precatorio_id: Optional[int] = None,
                    acao_id: Optional[int] = None, incluir_processos: bool = False):
    """Os documentos que este usuário pode ver — a MESMA régua em todo lugar.

    🚨 Ponto único para listar OU contar documentos: a tela de Documentos, o
    painel 360, as duas linhas do tempo e os contadores da ficha. Antes cada um
    montava a própria consulta e o painel/timeline esqueciam ora o dono, ora o
    recorte por classificação/área — documento de precatório proibido aparecia
    (nome do arquivo e contagem) fora da tela de Documentos.

    As três camadas: módulo `documents` (sem ele, consulta vazia — quem chama
    esconde o bloco; a rota da tela levanta 403 antes), `scope` de dono e
    `_filtrar_por_vinculo` (precatório/ação fora da permissão).

    `incluir_processos` (só com `client_id`): traz também os documentos presos
    apenas a um processo do cliente — que o filtro por `client_id` sozinho não
    alcança. A visibilidade continua sendo a do documento (dono), não a do
    processo.
    """
    from sqlalchemy import false
    query = db.query(models.Document)
    if not can_view(user, "documents"):
        return query.filter(false())
    query = scope(query, models.Document, user)
    query = _filtrar_por_vinculo(query, db, user)
    if client_id:
        if incluir_processos:
            procs = db.query(models.Process.id).filter(
                models.Process.client_id == client_id
            ).scalar_subquery()
            query = query.filter(or_(models.Document.client_id == client_id,
                                     models.Document.process_id.in_(procs)))
        else:
            query = query.filter(models.Document.client_id == client_id)
    if process_id:
        query = query.filter(models.Document.process_id == process_id)
    if precatorio_id:
        query = query.filter(models.Document.precatorio_id == precatorio_id)
    if acao_id:
        query = query.filter(models.Document.acao_id == acao_id)
    return query


@router.get("", response_model=List[schemas.DocumentOut])
def list_documents(
    client_id: Optional[int] = None,
    process_id: Optional[int] = None,
    precatorio_id: Optional[int] = None,
    acao_id: Optional[int] = None,
    incluir_processos: bool = False,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "documents")
    return query_documents(
        db, current_user, client_id=client_id, process_id=process_id,
        precatorio_id=precatorio_id, acao_id=acao_id,
        incluir_processos=incluir_processos,
    ).order_by(models.Document.uploaded_at.desc()).all()


def _validar_vinculos_upload(db, user, client_id, process_id, precatorio_id, acao_id):
    """Confere CADA vínculo do upload e decide o cliente e o dono do documento.

    Devolve `(client_id, owner_id)` — o `client_id` pode mudar (ver abaixo).

    🚨 Era uma cadeia `if/elif`: só o PRIMEIRO vínculo recebia checagem. Com
    `client_id` próprio + `process_id` de um colega, o documento ia parar no
    processo alheio (e na linha do tempo dele); e um id inexistente passava
    pelo `ensure_owner(None)`, que não reclama, e só estourava na FK (500).

    Regras (spec da ficha, §3.4):
      * todo vínculo enviado precisa EXISTIR → 400;
      * cliente e processo → `ensure_owner`;
      * precatório e ação → `_ensure_acesso` DO PRÓPRIO MÓDULO, que aceita a
        FILA (owner_id nulo — o genérico a recusaria, e anexar em lead da fila
        é o fluxo normal) e confere classificação/área, a 2ª camada do RBAC;
      * com `process_id`, o cliente do documento é o DO PROCESSO: outro
        `client_id` no corpo → 400 (senão o documento aparece na ficha errada
        e, com `incluir_processos`, em duas fichas). Não se exige acesso ao
        cliente — o dono do processo pode não ser o do cliente, e anexar no
        próprio processo não pode dar 403. O dono do documento é o do processo.
    """
    # Import local: os routers de precatório/ação são carregados depois deste.
    from .precatorios import _ensure_acesso as prec_ensure_acesso
    from .acoes import _ensure_acesso as acao_ensure_acesso

    owner = user.id
    proc = cli = None
    if process_id:
        proc = db.query(models.Process).get(process_id)
        if not proc:
            raise HTTPException(status_code=400, detail="Processo vinculado não existe")
        ensure_owner(proc, user, "processo")
        if client_id and client_id != proc.client_id:
            raise HTTPException(
                status_code=400,
                detail="O cliente informado não é o cliente deste processo",
            )
        client_id = proc.client_id
    elif client_id:
        cli = db.query(models.Client).get(client_id)
        if not cli:
            raise HTTPException(status_code=400, detail="Cliente vinculado não existe")
        ensure_owner(cli, user, "cliente")
    if precatorio_id:
        pr = db.query(models.Precatorio).get(precatorio_id)
        if not pr:
            raise HTTPException(status_code=400, detail="Precatório vinculado não existe")
        prec_ensure_acesso(pr, user)
        if not proc and not cli and pr.owner_id:
            owner = pr.owner_id
    if acao_id:
        ac = db.query(models.Acao).get(acao_id)
        if not ac:
            raise HTTPException(status_code=400, detail="Ação vinculada não existe")
        acao_ensure_acesso(ac, user)
        if not proc and not cli and not precatorio_id and ac.owner_id:
            owner = ac.owner_id
    # O dono vem do processo quando há processo (antes vinha do cliente, que
    # pode ser de outro advogado); senão do cliente; senão do precatório ou da
    # ação; e, se o caso está na fila, de quem anexou.
    if proc and proc.owner_id:
        owner = proc.owner_id
    elif cli and cli.owner_id:
        owner = cli.owner_id
    return client_id, owner


@router.post("", response_model=schemas.DocumentOut)
def upload_document(
    file: UploadFile = File(...),
    client_id: Optional[int] = Form(None),
    process_id: Optional[int] = Form(None),
    precatorio_id: Optional[int] = Form(None),
    acao_id: Optional[int] = Form(None),
    categoria: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "documents")

    # `categoria` vem de multipart/form-data, então não passa por schema Pydantic:
    # a validação precisa ser aqui. A tela renderiza este valor como rótulo
    # (DICIONARIO[categoria] || categoria) e um valor fora da lista caía cru no
    # HTML — era XSS armazenado. Lista fechada mata a classe inteira na entrada.
    from ..schemas import DOC_CATEGORIAS
    if categoria and categoria not in DOC_CATEGORIAS:
        raise HTTPException(
            status_code=400,
            detail=f"Categoria inválida. Use uma de: {', '.join(sorted(DOC_CATEGORIAS))}",
        )

    # Regra: documento precisa de pelo menos um vínculo
    if not client_id and not process_id and not precatorio_id and not acao_id:
        raise HTTPException(
            status_code=400,
            detail="Informe ao menos um cliente, processo, precatório ou ação para vincular o documento",
        )

    client_id, owner = _validar_vinculos_upload(
        db, current_user, client_id, process_id, precatorio_id, acao_id,
    )

    # ---------------- Upload: validação antes de gravar ----------------
    # Antes aceitava qualquer extensão, qualquer tamanho, sem olhar o conteúdo.
    # Um arquivo de 5 GB enchia o disco do Render; um .html ou .svg com script
    # ficava guardado esperando ser servido em algum contexto perigoso.
    conteudo = _ler_limitado(file)
    ext = _extensao_valida(file.filename)
    _conferir_assinatura(ext, conteudo)

    # Nome no disco é SEMPRE gerado por nós (uuid + extensão da allowlist).
    # O nome original vai só para o banco, como rótulo — assim um nome tipo
    # "../../etc/passwd" ou "a.pdf.exe" não vira caminho nem executável.
    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOAD_DIR / stored_name
    with open(dest, "wb") as f:
        f.write(conteudo)

    doc = models.Document(
        client_id=client_id,
        process_id=process_id,
        precatorio_id=precatorio_id,
        acao_id=acao_id,
        categoria=categoria,
        original_name=file.filename,
        file_path=str(dest),
        owner_id=owner,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


@router.get("/{document_id}/download")
def download_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "documents")
    doc = db.query(models.Document).get(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(doc, current_user, "documento")
    _ensure_vinculo(doc, db, current_user)
    if not os.path.exists(doc.file_path):
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")
    from ..seguranca import registrar_acesso
    registrar_acesso(db, current_user, "DOWNLOAD", f"documento #{doc.id} {doc.original_name or ''}")
    return FileResponse(doc.file_path, filename=doc.original_name)


@router.delete("/{document_id}")
def delete_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "documents")
    require_excluir(current_user)
    doc = db.query(models.Document).get(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Documento não encontrado")
    ensure_owner(doc, current_user, "documento")
    # Remove o arquivo físico, se existir
    if os.path.exists(doc.file_path):
        os.remove(doc.file_path)
    db.delete(doc)
    db.commit()
    return {"ok": True}
