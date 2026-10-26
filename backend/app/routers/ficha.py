"""Ficha única de Cliente e de Processo (out/2026).

Os "módulos de preenchimento" que vivem DENTRO das fichas:
  * atendimentos e contatos/representantes, pendurados no CLIENTE;
  * partes e andamentos, pendurados no PROCESSO;
  * as duas linhas do tempo, que reúnem tudo o que aconteceu com cada um.

🚨 A REGRA QUE SEGURA ESTE ARQUIVO: nada aqui tem dono próprio. Atendimento,
contato, parte e andamento herdam o acesso do cliente/processo da URL — o
"ensure_owner" é SEMPRE no pai, nunca no filho (`autor_id` é só autoria). Se
alguém aplicar `scope()` num atendimento, o advogado deixa de ver, na ficha do
PRÓPRIO cliente, o atendimento que a estagiária registrou — sem erro nenhum.

E o filho pertence ao pai da URL: `/clients/1/atendimentos/9` só apaga o
atendimento 9 se ele for do cliente 1 (404 se não for). Sem isso, quem alcança
o cliente 1 apagaria o atendimento de qualquer cliente trocando o número.

Toda rota DELETE daqui chama `require_excluir` (estagiário nunca exclui) e
está em `tests/test_delete_estagiario.py::ROTAS_DELETE`.
"""
from datetime import date, datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..prazos import FUSO_BRASILIA, agora_local, utc_para_local
from ..scope import (
    ATENDIMENTO_TIPOS, PARTE_POLOS, PARTE_TIPOS, URGENCIAS,
    alcanca, can_view, ensure_owner, require_edit, require_excluir, require_view, scope,
)
from .documents import query_documents
from .financeiro import _brl, _scope_hon, _viewer_share
from .publicacoes import _escopo_pub

router = APIRouter(tags=["ficha"])

# Teto da linha do tempo: a ficha mostra o recente; 300 eventos cobrem anos
# de um processo comum e mantêm a resposta leve no celular.
TETO_EVENTOS = 300


# --------------------------------------------------------------------------
# Acesso ao pai (cliente / processo) — o único "ensure_owner" deste arquivo
# --------------------------------------------------------------------------
def _cliente(db: Session, client_id: int, user, *, editar: bool = False) -> models.Client:
    """Módulo Clientes (ver ou editar) → 404 → dono. Nesta ordem.

    A permissão do módulo vem ANTES do 404 de propósito: quem não tem o módulo
    não pode usar a rota para descobrir quais ids de cliente existem.
    """
    (require_edit if editar else require_view)(user, "clients")
    c = db.query(models.Client).get(client_id)
    if not c:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    ensure_owner(c, user, "cliente")
    return c


def _processo(db: Session, process_id: int, user, *, editar: bool = False) -> models.Process:
    (require_edit if editar else require_view)(user, "processes")
    p = db.query(models.Process).get(process_id)
    if not p:
        raise HTTPException(status_code=404, detail="Processo não encontrado")
    ensure_owner(p, user, "processo")
    return p


def _usuarios(db: Session) -> dict:
    return {u.id: u.name for u in db.query(models.User.id, models.User.name).all()}


def _processo_visivel(p, user) -> bool:
    """O usuário veria este processo na tela de Processos? (módulo + dono)"""
    return p is not None and can_view(user, "processes") and alcanca(p, user)


# --------------------------------------------------------------------------
# Atendimentos (do cliente)
# --------------------------------------------------------------------------
def _atendimento_out(a: models.Atendimento, user, nomes: dict) -> schemas.AtendimentoOut:
    """Saída do atendimento, com o processo vinculado SÓ se o leitor o alcança.

    🚨 O dono do cliente pode não ser o dono do processo (o admin escolhe o
    dono de cada processo; cliente transferido deixa processo com o dono
    antigo). Devolver o número de um processo que a pessoa não abre em
    /api/processes seria vazar pelo atendimento o que a tela esconde.
    """
    proc = a.process
    visivel = _processo_visivel(proc, user)
    return schemas.AtendimentoOut(
        id=a.id, client_id=a.client_id,
        process_id=a.process_id if visivel else None,
        process_number=(proc.case_number or f"Processo #{proc.id}") if visivel else None,
        data=a.data, tipo=a.tipo, descricao=a.descricao,
        proximo_retorno=a.proximo_retorno, autor_id=a.autor_id,
        autor_nome=nomes.get(a.autor_id), created_at=a.created_at,
    )


def _data_local(dt: Optional[datetime]) -> datetime:
    """Data do atendimento como o banco guarda: hora de Brasília, sem fuso.

    O formulário manda a hora local SEM fuso (é o normal). Se vier com fuso,
    converte para Brasília em vez de descartar o deslocamento — descartar
    faria "14:30Z" virar 14:30 em vez de 11:30.
    """
    if dt is None:
        return agora_local()
    if dt.tzinfo is not None:
        return dt.astimezone(FUSO_BRASILIA).replace(tzinfo=None)
    return dt


@router.get("/api/clients/{client_id}/atendimentos", response_model=List[schemas.AtendimentoOut])
def listar_atendimentos(
    client_id: int,
    process_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Atendimentos do cliente, mais recentes primeiro.

    `?process_id=` restringe aos ligados a um processo — e só funciona para um
    processo que a pessoa alcança. Filtrar por um processo invisível devolve
    lista vazia: senão o filtro diria quais atendimentos estão ligados a um
    processo cujo vínculo a própria saída esconde.
    """
    _cliente(db, client_id, current_user)
    q = db.query(models.Atendimento).filter(models.Atendimento.client_id == client_id)
    if process_id:
        proc = db.query(models.Process).get(process_id)
        if not _processo_visivel(proc, current_user):
            return []
        q = q.filter(models.Atendimento.process_id == process_id)
    nomes = _usuarios(db)
    itens = q.order_by(models.Atendimento.data.desc(), models.Atendimento.id.desc()).all()
    return [_atendimento_out(a, current_user, nomes) for a in itens]


@router.post("/api/clients/{client_id}/atendimentos", response_model=schemas.AtendimentoOut)
def criar_atendimento(
    client_id: int,
    payload: schemas.AtendimentoCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _cliente(db, client_id, current_user, editar=True)
    if payload.process_id:
        # Alvo vindo do CORPO: a pessoa o alcança, e ele é DESTE cliente.
        #
        # 🚨 A ORDEM É A CORREÇÃO. Comparar o `client_id` antes do acesso fazia
        # três respostas diferentes — 403 (processo do colega NESTE cliente),
        # 400 "não é deste cliente" (do colega, em outro) e 400 "não existe" —
        # e varrendo ids a Ana mapeava os processos do Bruno presos ao cliente
        # dela, que a lista e a contagem escondem. Agora "do colega" e
        # "inexistente" respondem IGUAL; o "não é deste cliente" só sai para
        # processo que a pessoa já alcança. O módulo vem primeiro: ele depende
        # só de quem pede, não do id, então não revela nada.
        require_view(current_user, "processes")
        proc = db.query(models.Process).get(payload.process_id)
        if not alcanca(proc, current_user):          # None também cai aqui
            raise HTTPException(status_code=400, detail="Processo vinculado não encontrado")
        if proc.client_id != client_id:
            raise HTTPException(status_code=400, detail="Este processo não é deste cliente")
    a = models.Atendimento(
        client_id=client_id, process_id=payload.process_id or None,
        data=_data_local(payload.data), tipo=payload.tipo, descricao=payload.descricao,
        proximo_retorno=payload.proximo_retorno, autor_id=current_user.id,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _atendimento_out(a, current_user, _usuarios(db))


@router.delete("/api/clients/{client_id}/atendimentos/{atendimento_id}")
def excluir_atendimento(
    client_id: int,
    atendimento_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "clients")
    require_excluir(current_user)          # estagiário nunca exclui
    _cliente(db, client_id, current_user, editar=True)
    a = db.query(models.Atendimento).get(atendimento_id)
    if not a or a.client_id != client_id:
        raise HTTPException(status_code=404, detail="Atendimento não encontrado")
    db.delete(a)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Contatos e representantes (do cliente)
# --------------------------------------------------------------------------
def _um_so_principal(db: Session, client_id: int, manter_id: int):
    """Marcar um contato como principal desmarca os outros do MESMO cliente."""
    db.query(models.ClienteContato).filter(
        models.ClienteContato.client_id == client_id,
        models.ClienteContato.id != manter_id,
        models.ClienteContato.principal == 1,
    ).update({models.ClienteContato.principal: 0}, synchronize_session=False)


@router.get("/api/clients/{client_id}/contatos", response_model=List[schemas.ClienteContatoOut])
def listar_contatos(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _cliente(db, client_id, current_user)
    return (
        db.query(models.ClienteContato)
        .filter(models.ClienteContato.client_id == client_id)
        .order_by(models.ClienteContato.principal.desc(), models.ClienteContato.id)
        .all()
    )


@router.post("/api/clients/{client_id}/contatos", response_model=schemas.ClienteContatoOut)
def criar_contato(
    client_id: int,
    payload: schemas.ClienteContatoCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _cliente(db, client_id, current_user, editar=True)
    dados = payload.model_dump()
    dados["principal"] = 1 if dados.get("principal") else 0
    c = models.ClienteContato(client_id=client_id, **dados)
    db.add(c)
    db.flush()                       # precisa do id para desmarcar "os outros"
    if c.principal:
        _um_so_principal(db, client_id, c.id)
    db.commit()
    db.refresh(c)
    return c


def _contato_do_cliente(db: Session, client_id: int, contato_id: int) -> models.ClienteContato:
    c = db.query(models.ClienteContato).get(contato_id)
    if not c or c.client_id != client_id:
        raise HTTPException(status_code=404, detail="Contato não encontrado")
    return c


@router.put("/api/clients/{client_id}/contatos/{contato_id}", response_model=schemas.ClienteContatoOut)
def editar_contato(
    client_id: int,
    contato_id: int,
    payload: schemas.ClienteContatoUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _cliente(db, client_id, current_user, editar=True)
    c = _contato_do_cliente(db, client_id, contato_id)
    dados = payload.model_dump(exclude_unset=True)
    if "principal" in dados:
        dados["principal"] = 1 if dados["principal"] else 0
    for campo, valor in dados.items():
        setattr(c, campo, valor)
    # A mesma regra do POST, conferida no registro JÁ mesclado: um PUT que
    # apague nome, telefone e e-mail deixaria uma linha que não é ninguém.
    if not schemas.tem_texto(c.nome, c.telefone, c.email):
        raise HTTPException(
            status_code=422,
            detail="Informe ao menos o nome, o telefone ou o e-mail do contato.",
        )
    if c.principal:
        _um_so_principal(db, client_id, c.id)
    db.commit()
    db.refresh(c)
    return c


@router.delete("/api/clients/{client_id}/contatos/{contato_id}")
def excluir_contato(
    client_id: int,
    contato_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "clients")
    require_excluir(current_user)          # estagiário nunca exclui
    _cliente(db, client_id, current_user, editar=True)
    c = _contato_do_cliente(db, client_id, contato_id)
    db.delete(c)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Partes do processo
# --------------------------------------------------------------------------
@router.get("/api/processes/{process_id}/partes", response_model=List[schemas.ProcessoParteOut])
def listar_partes(
    process_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _processo(db, process_id, current_user)
    # Parte contrária primeiro: é a que a ficha mostra no cabeçalho e na lista.
    contraria_primeiro = case((models.ProcessoParte.tipo == "contraria", 0), else_=1)
    return (
        db.query(models.ProcessoParte)
        .filter(models.ProcessoParte.process_id == process_id)
        .order_by(contraria_primeiro, models.ProcessoParte.id)
        .all()
    )


@router.post("/api/processes/{process_id}/partes", response_model=schemas.ProcessoParteOut)
def criar_parte(
    process_id: int,
    payload: schemas.ProcessoParteCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _processo(db, process_id, current_user, editar=True)
    p = models.ProcessoParte(process_id=process_id, **payload.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _parte_do_processo(db: Session, process_id: int, parte_id: int) -> models.ProcessoParte:
    p = db.query(models.ProcessoParte).get(parte_id)
    if not p or p.process_id != process_id:
        raise HTTPException(status_code=404, detail="Parte não encontrada")
    return p


@router.put("/api/processes/{process_id}/partes/{parte_id}", response_model=schemas.ProcessoParteOut)
def editar_parte(
    process_id: int,
    parte_id: int,
    payload: schemas.ProcessoParteUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _processo(db, process_id, current_user, editar=True)
    p = _parte_do_processo(db, process_id, parte_id)
    for campo, valor in payload.model_dump(exclude_unset=True).items():
        setattr(p, campo, valor)
    db.commit()
    db.refresh(p)
    return p


@router.delete("/api/processes/{process_id}/partes/{parte_id}")
def excluir_parte(
    process_id: int,
    parte_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "processes")
    require_excluir(current_user)          # estagiário nunca exclui
    _processo(db, process_id, current_user, editar=True)
    p = _parte_do_processo(db, process_id, parte_id)
    db.delete(p)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Andamentos do processo
# --------------------------------------------------------------------------
def _andamento_out(a: models.ProcessoAndamento, nomes: dict) -> schemas.ProcessoAndamentoOut:
    return schemas.ProcessoAndamentoOut(
        id=a.id, process_id=a.process_id, data=a.data, titulo=a.titulo,
        descricao=a.descricao, autor_id=a.autor_id, autor_nome=nomes.get(a.autor_id),
        created_at=a.created_at,
    )


@router.get("/api/processes/{process_id}/andamentos",
            response_model=List[schemas.ProcessoAndamentoOut])
def listar_andamentos(
    process_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _processo(db, process_id, current_user)
    nomes = _usuarios(db)
    itens = (
        db.query(models.ProcessoAndamento)
        .filter(models.ProcessoAndamento.process_id == process_id)
        .order_by(models.ProcessoAndamento.data.desc(), models.ProcessoAndamento.id.desc())
        .all()
    )
    return [_andamento_out(a, nomes) for a in itens]


@router.post("/api/processes/{process_id}/andamentos", response_model=schemas.ProcessoAndamentoOut)
def criar_andamento(
    process_id: int,
    payload: schemas.ProcessoAndamentoCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _processo(db, process_id, current_user, editar=True)
    a = models.ProcessoAndamento(
        process_id=process_id, data=payload.data, titulo=payload.titulo,
        descricao=payload.descricao, autor_id=current_user.id,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _andamento_out(a, _usuarios(db))


@router.delete("/api/processes/{process_id}/andamentos/{andamento_id}")
def excluir_andamento(
    process_id: int,
    andamento_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "processes")
    require_excluir(current_user)          # estagiário nunca exclui
    _processo(db, process_id, current_user, editar=True)
    a = db.query(models.ProcessoAndamento).get(andamento_id)
    if not a or a.process_id != process_id:
        raise HTTPException(status_code=404, detail="Andamento não encontrado")
    db.delete(a)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------
# Linhas do tempo
# --------------------------------------------------------------------------
# Rótulos dos campos que entram nos títulos. A linha do tempo NUNCA mostra
# chave crua ("documento_pessoal", "parcial"): o front só escapa o texto.
_DOC_CATEGORIAS = {
    "procuracao": "Procuração", "contrato": "Contrato",
    "documento_pessoal": "Documento pessoal", "comprovante": "Comprovante",
    "outro": "Outro",
    "peticao": "Petição", "decisao": "Decisão/Sentença", "laudo": "Laudo",
}
_HON_STATUS = {"pago": "Pago", "parcial": "Pago em parte", "pendente": "Pendente"}
_HON_TIPOS = {"contratual": "Contratual", "extrajudicial": "Extrajudicial"}
_ASSIN_STATUS = {
    "rascunho": "Rascunho", "enviado": "Enviado para assinatura",
    "visualizado": "Visualizado", "assinado": "Assinado",
    "recusado": "Recusado", "expirado": "Expirado",
}


def _br(d) -> str:
    """dd/mm/aaaa (data) ou dd/mm/aaaa hh:mm (data e hora)."""
    if isinstance(d, datetime):
        return d.strftime("%d/%m/%Y %H:%M")
    if isinstance(d, date):
        return d.strftime("%d/%m/%Y")
    return ""


def _iso(d) -> Optional[str]:
    return d.isoformat() if d else None


def _carimbo(dt) -> Optional[str]:
    """Carimbo gerado pelo SERVIDOR (UTC) → horário de Brasília, sem fuso.

    🚨 Todas as datas-hora da linha do tempo saem em Brasília: a do atendimento
    já vem assim do navegador, e os `created_at` (UTC) são convertidos aqui.
    Misturar os dois faria o front mostrar o carimbo 3h adiantado e embaralhar
    a ordem dos eventos de um mesmo dia. Data pura (andamento, publicação) sai
    como `AAAA-MM-DD` — o front não pode passá-la por `new Date()`.
    """
    return _iso(utc_para_local(dt))


def _rotulo(mapa: dict, chave) -> str:
    return mapa.get(chave) or "Outro"


def _evento(tipo, data, titulo, detalhe=None, *, processo=None, ref_id=None, autor=None):
    return {
        "tipo": tipo, "data": data, "titulo": titulo, "detalhe": detalhe or None,
        "processo_id": processo.id if processo is not None else None,
        "processo_numero": (
            (processo.case_number or f"Processo #{processo.id}") if processo is not None else None
        ),
        "ref_id": ref_id, "autor": autor,
    }


def _junta(*partes) -> Optional[str]:
    texto = " · ".join(p for p in partes if p)
    return texto or None


def _eventos_de_processos(db, user, processos, nomes, *, cadastro_tipo: str):
    """Eventos ligados a processos JÁ CONFERIDOS (o chamador garantiu o acesso).

    Cada bloco com a régua do próprio módulo — a mesma da tela dele:
    prazos (módulo + scope), audiências (módulo + scope), honorários (módulo +
    `_scope_hon` + a parte do parceiro), publicações (`_escopo_pub`).
    Partes e andamentos herdam do processo. Documentos ficam com o chamador,
    porque o cliente também tem os dele (dedupe por id lá).
    """
    eventos = []
    if not processos:
        return eventos
    por_id = {p.id: p for p in processos}
    ids = list(por_id)

    for p in processos:
        if p.created_at:
            eventos.append(_evento(
                cadastro_tipo, _carimbo(p.created_at), "Processo cadastrado",
                _junta(p.case_number or "Processo sem número", p.assunto),
                processo=p, ref_id=p.id,
            ))

    if can_view(user, "deadlines"):
        for d in scope(db.query(models.Deadline), models.Deadline, user).filter(
                models.Deadline.process_id.in_(ids)).all():
            eventos.append(_evento(
                "prazo", _carimbo(d.created_at) or _iso(d.date),
                f"Prazo cadastrado: {d.description}",
                _junta(f"vence {_br(d.date)}",
                       f"urgência {URGENCIAS.get(d.urgency_level, '').lower()}"
                       if d.urgency_level in URGENCIAS else None,
                       "cumprido" if d.done else None),
                processo=por_id.get(d.process_id), ref_id=d.id,
            ))

    if can_view(user, "appointments"):
        for a in scope(db.query(models.Appointment), models.Appointment, user).filter(
                models.Appointment.process_id.in_(ids)).all():
            eventos.append(_evento(
                "audiencia", _carimbo(a.created_at) or _iso(a.date_time),
                f"Audiência marcada para {_br(a.date_time)}",
                _junta(a.location, a.notes),
                processo=por_id.get(a.process_id), ref_id=a.id,
            ))

    for an in db.query(models.ProcessoAndamento).filter(
            models.ProcessoAndamento.process_id.in_(ids)).all():
        eventos.append(_evento(
            "andamento", _iso(an.data), an.titulo, an.descricao,
            processo=por_id.get(an.process_id), ref_id=an.id, autor=nomes.get(an.autor_id),
        ))

    for pt in db.query(models.ProcessoParte).filter(
            models.ProcessoParte.process_id.in_(ids)).all():
        eventos.append(_evento(
            "parte", _carimbo(pt.created_at), f"Parte incluída: {pt.nome}",
            _junta(_rotulo(PARTE_TIPOS, pt.tipo),
                   PARTE_POLOS.get(pt.polo) if pt.polo else None),
            processo=por_id.get(pt.process_id), ref_id=pt.id,
        ))
    return eventos


def _eventos_honorarios(user, honorarios, por_id, nomes):
    eventos = []
    for h in honorarios:
        total, pago = _viewer_share(h, user)   # o parceiro vê só a parte dele
        status = "pendente" if pago <= 0 else ("pago" if pago >= total else "parcial")
        eventos.append(_evento(
            "honorario", _carimbo(h.created_at),
            f"Honorário lançado: {_brl(total)}",
            _junta(_HON_TIPOS.get(h.type), h.notes,
                   f"vence {_br(h.due_date)}" if h.due_date else None,
                   _HON_STATUS.get(status)),
            processo=por_id.get(h.process_id), ref_id=h.id, autor=nomes.get(h.created_by),
        ))
    return eventos


def _eventos_publicacoes(pubs, por_id):
    return [_evento(
        "publicacao", _iso(pb.data_disponibilizacao) or _carimbo(pb.created_at),
        f"{pb.tipo_comunicacao or 'Publicação'} no Diário de Justiça",
        _junta(pb.tribunal, pb.orgao),
        processo=por_id.get(pb.process_id), ref_id=pb.id,
    ) for pb in pubs]


def _eventos_documentos(docs, por_id):
    return [_evento(
        "documento", _carimbo(d.uploaded_at), f"Documento anexado: {d.original_name or 'sem nome'}",
        _DOC_CATEGORIAS.get(d.categoria) if d.categoria else None,
        processo=por_id.get(d.process_id), ref_id=d.id,
    ) for d in docs]


def _eventos_atendimentos(atendimentos, por_id, nomes):
    """`por_id` só tem os processos que o leitor alcança: vínculo com processo
    invisível sai nulo, como em `_atendimento_out`."""
    return [_evento(
        "atendimento", _iso(a.data), f"Atendimento · {_rotulo(ATENDIMENTO_TIPOS, a.tipo)}",
        _junta(a.descricao,
               f"retorno {_br(a.proximo_retorno)}" if a.proximo_retorno else None),
        processo=por_id.get(a.process_id), ref_id=a.id, autor=nomes.get(a.autor_id),
    ) for a in atendimentos]


def _ordenar(eventos):
    """Mais recente primeiro, sem repetir (tipo, id), no máximo TETO_EVENTOS.

    Data pura ("2026-10-03") ordena como o INÍCIO do dia diante de data-hora
    do mesmo dia — comparação de texto ISO faz isso sozinha.
    """
    vistos, unicos = set(), []
    for e in eventos:
        chave = (e["tipo"], e["ref_id"])
        if e["data"] is None or chave in vistos:
            continue
        vistos.add(chave)
        unicos.append(e)
    unicos.sort(key=lambda e: (e["data"], e["ref_id"] or 0), reverse=True)
    return unicos[:TETO_EVENTOS]


@router.get("/api/processes/{process_id}/timeline")
def linha_do_tempo_processo(
    process_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Tudo o que aconteceu no processo, cada bloco com a régua do seu módulo.

    Antes lia `p.deadlines`/`p.appointments`/`p.documents` pela relação, SEM
    escopo nem módulo: quem não tinha Prazos via os prazos aqui, e o
    documento preso a precatório proibido aparecia pelo nome.

    Atendimentos só entram se a pessoa tem o módulo Clientes E alcança o
    CLIENTE do processo — o processo pode ser dela e o cliente não. Sem isso o
    bloco some (não é 403: a linha do tempo abre sem ele).
    """
    p = _processo(db, process_id, current_user)
    nomes = _usuarios(db)
    por_id = {p.id: p}
    eventos = _eventos_de_processos(db, current_user, [p], nomes, cadastro_tipo="cadastro")
    eventos += _eventos_documentos(
        query_documents(db, current_user, process_id=process_id).all(), por_id)
    if can_view(current_user, "financeiro"):
        hons = _scope_hon(db.query(models.Honorario), current_user).filter(
            models.Honorario.process_id == process_id).all()
        eventos += _eventos_honorarios(current_user, hons, por_id, nomes)
    eventos += _eventos_publicacoes(
        _escopo_pub(db.query(models.Publicacao), current_user)
        .filter(models.Publicacao.process_id == process_id).all(), por_id)
    if can_view(current_user, "clients") and alcanca(p.client, current_user):
        eventos += _eventos_atendimentos(
            db.query(models.Atendimento).filter(
                models.Atendimento.process_id == process_id).all(),
            por_id, nomes)
    return {
        "processo": p.case_number or f"Processo #{p.id}",
        "cliente": p.client.name if p.client else None,
        "events": _ordenar(eventos),
    }


@router.get("/api/clients/{client_id}/timeline")
def linha_do_tempo_cliente(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Eventos do cliente + os de cada processo dele que a pessoa ALCANÇA.

    "Alcança" = módulo Processos + dono (a mesma regra da lista de processos).
    Processo do colega preso ao cliente não entra — nem os prazos, partes e
    andamentos dele — e o que é do cliente mas aponta para esse processo
    (documento, honorário, atendimento) aparece SEM o vínculo.
    """
    c = _cliente(db, client_id, current_user)
    nomes = _usuarios(db)
    processos = (
        scope(db.query(models.Process), models.Process, current_user)
        .filter(models.Process.client_id == client_id).all()
        if can_view(current_user, "processes") else []
    )
    por_id = {p.id: p for p in processos}
    ids = list(por_id)

    eventos = []
    if c.created_at:
        eventos.append(_evento("cadastro", _carimbo(c.created_at), "Cliente cadastrado",
                               c.name, ref_id=c.id))
    eventos += _eventos_de_processos(db, current_user, processos, nomes, cadastro_tipo="processo")
    eventos += _eventos_atendimentos(
        db.query(models.Atendimento).filter(models.Atendimento.client_id == client_id).all(),
        por_id, nomes)

    docs = query_documents(db, current_user, client_id=client_id).all()
    if ids:
        docs += query_documents(db, current_user).filter(
            models.Document.process_id.in_(ids)).all()
    eventos += _eventos_documentos(docs, por_id)          # _ordenar tira o repetido

    if can_view(current_user, "financeiro"):
        cond = models.Honorario.client_id == client_id
        if ids:
            cond = cond | models.Honorario.process_id.in_(ids)
        hons = _scope_hon(db.query(models.Honorario), current_user).filter(cond).all()
        eventos += _eventos_honorarios(current_user, hons, por_id, nomes)

    cond_pub = models.Publicacao.client_id == client_id
    if ids:
        cond_pub = cond_pub | models.Publicacao.process_id.in_(ids)
    eventos += _eventos_publicacoes(
        _escopo_pub(db.query(models.Publicacao), current_user).filter(cond_pub).all(), por_id)

    if can_view(current_user, "assinaturas"):
        for a in scope(db.query(models.Assinatura), models.Assinatura, current_user).filter(
                models.Assinatura.client_id == client_id).all():
            eventos.append(_evento(
                "assinatura", _carimbo(a.created_at),
                a.titulo or "Documento para assinatura",
                _ASSIN_STATUS.get(a.status), ref_id=a.id,
            ))

    return {"cliente": c.name, "events": _ordenar(eventos)}
