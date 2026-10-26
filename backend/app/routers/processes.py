"""Rotas de Processos (CRUD completo). Todo processo está ligado a um cliente."""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, false, func, or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..prazos import hoje_local
from ..scope import (
    scope, ensure_owner, is_admin, is_estagiario, can_view, validar_responsavel,
    require_view, require_edit, require_excluir,
)
from .deadlines import desvincular_publicacoes_do_prazo

router = APIRouter(prefix="/api/processes", tags=["processes"])


def _to_out(process: models.Process) -> schemas.ProcessOut:
    """Adiciona o nome do cliente ao objeto de saída."""
    data = schemas.ProcessOut.model_validate(process)
    data.client_name = process.client.name if process.client else None
    return data


def _prazos_visiveis(db: Session, user):
    """Prazos que este usuário veria na tela de Prazos (módulo + dono).

    Tudo que a LISTA de processos deriva de prazo — `proximo_prazo` e o filtro
    "só com prazo vencido" — passa por aqui: a lista não pode revelar prazo
    que a tela de Prazos esconderia da mesma pessoa. Sem o módulo, nenhum.
    """
    q = db.query(models.Deadline)
    if not can_view(user, "deadlines"):
        return q.filter(false())
    return scope(q, models.Deadline, user)


def _so_digitos_sql(coluna):
    """A coluna sem a pontuação do número CNJ (0801234-56.2026.4.05.8000)."""
    expr = coluna
    for ch in (".", "-", "/", " "):
        expr = func.replace(expr, ch, "")
    return expr


def query_processes(db: Session, user, *, client_id: Optional[int] = None,
                    status: Optional[str] = None, sistema: Optional[str] = None,
                    tipo: Optional[str] = None, q: Optional[str] = None,
                    responsavel: Optional[str] = None, vencido: bool = False):
    """Consulta de processos com o RBAC + os filtros da tela.

    Ponto único usado pela listagem E pelo export — assim a planilha sai com
    exatamente o que o usuário está vendo. **Filtro novo entra aqui.**

    * `q` — número (pelos dígitos, a partir de 4: acha o processo digitado com
      ou sem pontuação), assunto, classe, nome do cliente e nome das partes
      contrárias. Tudo DENTRO do `scope`: só restringe.
    * `responsavel` — `meus` ou o id de um usuário. Id de OUTRA pessoa só vale
      para o admin; para os demais vira "meus" (o advogado já só enxerga os
      dele, e o estagiário vê "Atribuído" no lugar do nome — não filtra por
      colega).
    * `vencido` — tem prazo NÃO cumprido com data anterior a hoje (Brasília),
      contando só os prazos que a pessoa vê (`_prazos_visiveis`).
    """
    query = scope(db.query(models.Process), models.Process, user)
    if client_id:
        query = query.filter(models.Process.client_id == client_id)
    if status:
        query = query.filter(models.Process.status == status)
    if sistema:
        query = query.filter(models.Process.sistema_eletronico == sistema)
    if tipo:
        query = query.filter(models.Process.type == tipo)
    termo = (q or "").strip()
    if termo:
        like = f"%{termo}%"
        clientes = db.query(models.Client.id).filter(
            models.Client.name.ilike(like)
        ).scalar_subquery()
        contrarias = db.query(models.ProcessoParte.process_id).filter(
            models.ProcessoParte.tipo == "contraria",
            models.ProcessoParte.nome.ilike(like),
        ).scalar_subquery()
        conds = [
            models.Process.case_number.ilike(like),
            models.Process.assunto.ilike(like),
            models.Process.classe.ilike(like),
            models.Process.client_id.in_(clientes),
            models.Process.id.in_(contrarias),
        ]
        digitos = "".join(c for c in termo if c in "0123456789")
        if len(digitos) >= 4:
            conds.append(_so_digitos_sql(models.Process.case_number).like(f"%{digitos}%"))
        query = query.filter(or_(*conds))
    resp = (responsavel or "").strip()
    if resp:
        if resp == "meus":
            uid = user.id
        else:
            try:
                uid = int(resp)
            except ValueError:
                raise HTTPException(status_code=400, detail="Filtro de responsável inválido.")
            if not is_admin(user):
                uid = user.id
        query = query.filter(models.Process.owner_id == uid)
    if vencido:
        vencidos = _prazos_visiveis(db, user).filter(
            models.Deadline.done == 0,
            models.Deadline.date < hoje_local(),
        ).with_entities(models.Deadline.process_id).scalar_subquery()
        query = query.filter(models.Process.id.in_(vencidos))
    return query


def _enriquecer(db: Session, user, processos) -> List[schemas.ProcessOut]:
    """`_to_out` + `proximo_prazo` e `partes_contrarias`, em 2 consultas no total.

    O próximo prazo vem só dos prazos que a pessoa vê (`_prazos_visiveis`).
    Parte contrária herda a visibilidade do processo, que já passou pelo scope.
    """
    if not processos:
        return []
    ids = [p.id for p in processos]
    proximos = dict(
        _prazos_visiveis(db, user)
        .filter(models.Deadline.process_id.in_(ids), models.Deadline.done == 0)
        .with_entities(models.Deadline.process_id, func.min(models.Deadline.date))
        .group_by(models.Deadline.process_id)
        .all()
    )
    contrarias = {}
    for pid, nome in (
        db.query(models.ProcessoParte.process_id, models.ProcessoParte.nome)
        .filter(models.ProcessoParte.process_id.in_(ids),
                models.ProcessoParte.tipo == "contraria")
        .order_by(models.ProcessoParte.id)
        .all()
    ):
        contrarias.setdefault(pid, []).append(nome)
    saida = []
    for p in processos:
        out = _to_out(p)
        out.proximo_prazo = proximos.get(p.id)
        nomes = contrarias.get(p.id)
        out.partes_contrarias = ", ".join(nomes) if nomes else None
        saida.append(out)
    return saida


@router.get("", response_model=List[schemas.ProcessOut])
def list_processes(
    client_id: Optional[int] = None,
    status: Optional[str] = None,
    sistema: Optional[str] = None,
    tipo: Optional[str] = None,
    q: Optional[str] = None,
    responsavel: Optional[str] = None,
    vencido: bool = False,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "processes")
    processes = query_processes(
        db, current_user, client_id=client_id, status=status,
        sistema=sistema, tipo=tipo, q=q, responsavel=responsavel, vencido=vencido,
    ).order_by(models.Process.created_at.desc()).all()
    return _enriquecer(db, current_user, processes)


@router.post("", response_model=schemas.ProcessOut)
def create_process(
    payload: schemas.ProcessCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "processes")
    # O cliente vinculado precisa existir E ser alcançável por quem está criando.
    #
    # 🚨 Só a checagem de existência (como era até ago/2026) vaza: `require_edit`
    # responde "esta pessoa pode criar processo?", não "pode usar ESTE cliente?".
    # `GET /api/clients/<id>` de outro dono devolve 403, mas mandar o mesmo id
    # aqui no corpo devolvia 200 **com o nome do cliente do colega** — varrendo
    # ids, o advogado montava a lista de clientes do escritório inteiro. E o
    # processo criado ainda aparecia no painel 360 do outro.
    client = db.query(models.Client).get(payload.client_id)
    if not client:
        raise HTTPException(status_code=400, detail="Cliente vinculado não existe")
    ensure_owner(client, current_user, "cliente")
    data = payload.model_dump()
    owner = data.pop("owner_id", None)
    process = models.Process(**data)
    # Quem é o dono:
    #   * admin: quem ele escolher (ou ele mesmo);
    #   * advogado: ele — só cria em cliente DELE (ensure_owner acima);
    #   * estagiário: o DONO DO CLIENTE, quando o cliente tem dono.
    # 🚨 Por que o estagiário não fica com o processo: ele assiste o escritório
    # (ve_tudo) e cadastra processo na ficha do cliente de um advogado. Sendo o
    # dono, o processo — e todo prazo e audiência criados nele, que herdam o
    # dono do processo — sumia para o advogado responsável pelo cliente (o
    # scope dele é `owner_id == ele`): prazo processual que ninguém vê é prazo
    # perdido. E a exclusão do cliente pelo advogado passava a levar 409.
    if is_admin(current_user) and owner:
        validar_responsavel(db, owner)
        process.owner_id = owner
    elif is_estagiario(current_user) and client.owner_id:
        process.owner_id = client.owner_id
    else:
        process.owner_id = current_user.id
    db.add(process)
    db.commit()
    db.refresh(process)
    return _enriquecer(db, current_user, [process])[0]


@router.get("/duplicados")
def listar_duplicados(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Auditoria: processos com o MESMO número (comparando só os dígitos).

    Não apaga nada — lista para o admin decidir. Comparar por dígitos faz
    "0801234-56.2026.8.02.0001" bater com "08012345620268020001".
    Fica ANTES de /{process_id}: o FastAPI resolve na ordem de registro.
    """
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode auditar duplicidades.")
    regs = db.query(models.Process).order_by(models.Process.id).all()
    mapa = {}
    for p in regs:
        d = "".join(ch for ch in str(p.case_number or "") if ch.isdigit())
        if len(d) >= 6:
            mapa.setdefault(d, []).append(p)
    grupos = []
    for chave, itens in mapa.items():
        if len(itens) < 2:
            continue
        grupos.append({"chave": chave, "registros": [{
            "id": p.id, "case_number": p.case_number,
            "cliente": (p.client.name if p.client else None),
            "client_id": p.client_id, "type": p.type, "status": p.status,
            "tribunal": p.tribunal, "owner_id": p.owner_id,
            "criado_em": p.created_at.isoformat() if getattr(p, "created_at", None) else None,
        } for p in itens]})
    return {
        "total_processos": len(regs),
        "por_numero": sorted(grupos, key=lambda g: -len(g["registros"])),
        "excedentes_por_numero": sum(len(g["registros"]) - 1 for g in grupos),
    }


@router.get("/{process_id}", response_model=schemas.ProcessOut)
def get_process(
    process_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "processes")
    process = db.query(models.Process).get(process_id)
    if not process:
        raise HTTPException(status_code=404, detail="Processo não encontrado")
    ensure_owner(process, current_user, "processo")
    return _enriquecer(db, current_user, [process])[0]


# A linha do tempo do processo (`GET /{process_id}/timeline`) mudou para
# routers/ficha.py em out/2026: ela passou a reunir andamentos, partes,
# publicações, atendimentos e honorários, cada bloco com a régua do seu módulo.


@router.put("/{process_id}", response_model=schemas.ProcessOut)
def update_process(
    process_id: int,
    payload: schemas.ProcessUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "processes")
    process = db.query(models.Process).get(process_id)
    if not process:
        raise HTTPException(status_code=404, detail="Processo não encontrado")
    ensure_owner(process, current_user, "processo")
    data = payload.model_dump(exclude_unset=True)
    # Todo processo tem cliente (coluna NOT NULL): `{"client_id": null}` gravaria
    # NULL e estouraria IntegrityError (500). Vira 422, como validação.
    if "client_id" in data and data["client_id"] is None:
        raise HTTPException(status_code=422, detail="O processo precisa de um cliente.")
    # `ProcessUpdate` aceita `client_id`: sem esta checagem dava para REPONTAR um
    # processo próprio para o cliente de um colega — mesmo vazamento do create,
    # por outra porta. Só valida quando o campo veio no corpo E muda de fato.
    cliente_antigo = process.client_id
    novo_client = data.get("client_id")
    if novo_client is not None and novo_client != process.client_id:
        alvo = db.query(models.Client).get(novo_client)
        if not alvo:
            raise HTTPException(status_code=400, detail="Cliente vinculado não existe")
        ensure_owner(alvo, current_user, "cliente")
    owner = data.pop("owner_id", None)
    dono_antigo = process.owner_id
    for field, value in data.items():
        setattr(process, field, value)
    if owner is not None and is_admin(current_user):
        validar_responsavel(db, owner)
        process.owner_id = owner
    if process.owner_id != dono_antigo:
        _propagar_dono(db, process.id, process.owner_id)
    if process.client_id != cliente_antigo:
        _ajustar_vinculos_ao_trocar_cliente(db, process.id, cliente_antigo, process.client_id)
    db.commit()       # tudo acima numa transação só: ou troca tudo, ou nada
    db.refresh(process)
    return _enriquecer(db, current_user, [process])[0]


def _propagar_dono(db: Session, process_id: int, novo_dono):
    """O admin trocou o responsável: o que pende do processo vai junto.

    🚨 Prazo, audiência, documento e publicação recebem o dono SÓ ao nascer
    (herdado do processo) — e o `scope()` filtra por esse dono. Sem propagar,
    depois da transferência o novo responsável abre a ficha e encontra a aba
    de prazos VAZIA, sem alerta de prazo vencido, e o filtro "só com prazo
    vencido" não acha nada: prazo processual perdido. E o responsável antigo
    continua vendo na agenda prazos de um processo que já não abre.

    Honorários e assinaturas NÃO mudam de dono, de propósito: são registros
    financeiros/contratuais de quem os lançou (mesma régua do painel 360).

    🚨 Documento que também é de um PRECATÓRIO ou de uma AÇÃO fica com o dono
    que tem: ele pertence ao caso, que tem dono próprio. Ir junto fazia o
    documento sumir para a dona do precatório (o `scope` de Documentos é por
    `owner_id`), mesmo ela continuando dona do caso.
    Sem commit — roda na transação do PUT.
    """
    for modelo in (models.Deadline, models.Appointment, models.Publicacao):
        db.query(modelo).filter(modelo.process_id == process_id).update(
            {modelo.owner_id: novo_dono}, synchronize_session=False,
        )
    db.query(models.Document).filter(
        models.Document.process_id == process_id,
        models.Document.precatorio_id.is_(None),
        models.Document.acao_id.is_(None),
    ).update({models.Document.owner_id: novo_dono}, synchronize_session=False)


def _ajustar_vinculos_ao_trocar_cliente(db: Session, process_id: int, antigo, novo):
    """O processo mudou de cliente: o que era "deste processo neste cliente".

    * Atendimento é do CLIENTE: o que foi registrado no cliente antigo fica lá
      (é histórico dele), só perde o vínculo com um processo que não é mais
      dele — senão aparecia na ficha errada e sumia da aba do processo.
    * Documento do processo acompanha o processo: a regra do upload é "o
      cliente do documento é o do processo", e sem isto o mesmo arquivo
      apareceria em duas fichas (cliente antigo pelo `client_id`, cliente novo
      pelo processo).
    * Publicação do DJEN vinculada ao processo idem: o `vincular` grava cliente
      E processo, e o filtro da ficha do cliente é "do cliente OU de um
      processo dele" — sem acompanhar, a intimação aparecia nas duas fichas.
      O dono NÃO muda (quem lê a publicação é decidido pelo `owner_id`).
    * Honorário do processo lançado no cliente antigo idem: a aba Financeiro
      da ficha filtra "do cliente OU de um processo dele", então ele aparecia
      nas DUAS fichas — e ainda bloqueava (409) a exclusão do cliente antigo,
      que já não tem nada a ver com ele. O dono NÃO muda (régua do 360:
      honorário é de quem o lançou). Honorário do processo preso a um
      TERCEIRO cliente não é "do antigo" e fica como está.
    """
    db.query(models.Atendimento).filter(
        models.Atendimento.process_id == process_id,
        models.Atendimento.client_id != novo,
    ).update({models.Atendimento.process_id: None}, synchronize_session=False)
    for modelo in (models.Document, models.Publicacao, models.Honorario):
        db.query(modelo).filter(
            modelo.process_id == process_id,
            modelo.client_id == antigo,
        ).update({modelo.client_id: novo}, synchronize_session=False)


# --------------------------------------------------------------------------
# Exclusão: bloqueio por vínculo financeiro/contratual
# --------------------------------------------------------------------------
def _qtd(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def bloquear_exclusao_por_vinculos(db: Session, user, honorarios_q, assinaturas_q,
                                   alvo: str, saida: str):
    """409 se houver honorário ou assinatura presos ao que vai ser excluído.

    Por que bloquear e não apagar junto: honorário é dinheiro e assinatura é
    contrato — sumir com eles numa exclusão em cascata é perda que ninguém
    percebe. E sem bloquear, o Postgres estoura a FK (500).

    🚨 A MENSAGEM NÃO PODE VIRAR ORÁCULO. O admin recebe as contagens. Os
    demais recebem só o que a tela deles mostraria — honorários só com o
    módulo Financeiro e pelo `_scope_hon`; contratos pelo `scope` — e, se
    houver mais, um aviso SEM número. Senão o 409 contaria à Ana os
    honorários do Bruno presos ao cliente dela, que o painel 360 esconde.
    """
    from .financeiro import _scope_hon

    total_hon = honorarios_q.count()
    total_ass = assinaturas_q.count() if assinaturas_q is not None else 0
    if not (total_hon or total_ass):
        return
    if is_admin(user):
        vis_hon, vis_ass = total_hon, total_ass
    else:
        vis_hon = _scope_hon(honorarios_q, user).count() if can_view(user, "financeiro") else 0
        vis_ass = (
            scope(assinaturas_q, models.Assinatura, user).count()
            if assinaturas_q is not None and can_view(user, "assinaturas") else 0
        )
    partes = []
    if vis_hon:
        partes.append(_qtd(vis_hon, "honorário", "honorários"))
    if vis_ass:
        partes.append(_qtd(vis_ass, "contrato/procuração", "contratos/procurações"))
    ocultos = (total_hon - vis_hon) + (total_ass - vis_ass)
    if partes:
        msg = f"Não é possível excluir: {alvo} tem {' e '.join(partes)} vinculado(s)"
        if ocultos:
            msg += ", e outros registros de outro responsável — fale com o administrador"
    else:
        msg = (f"Não é possível excluir: {alvo} tem registros de outro responsável "
               "vinculados — fale com o administrador")
    raise HTTPException(status_code=409, detail=f"{msg}. {saida}")


def bloquear_exclusao_de_alheios(db: Session, user, *, process_ids, client_id=None,
                                 alvo: str, saida: str):
    """409 SEM números se a cascata fosse apagar registro de outro dono ou sem dono.

    🚨 O `ensure_owner` confere só o PAI (cliente/processo). A cascata do ORM
    apaga os filhos sem olhar o dono deles — e o advogado só enxerga o que é
    dele. Era assim que a Ana excluía o próprio cliente e levava junto o
    laudo que o Bruno anexou antes da transferência, ou o prazo do Bruno que a
    estagiária repôs no processo dela: registros que ela nem via.

    O que a cascata APAGA (e é o que entra na conta):
      * prazos e audiências dos processos que vão embora;
      * documentos, só na exclusão do CLIENTE: os do cliente e os presos SÓ a
        um processo dele (`delete_client` os passa para o cliente antes de
        apagar). Documento de precatório/ação não entra — perde o vínculo e
        fica no caso. Na exclusão do PROCESSO nenhum documento é apagado (o
        órfão vira do cliente), então eles não entram.
    "Alheio" inclui o SEM dono (NULL): o advogado também não o vê.

    Sem números e sem dizer qual dos tipos, de propósito: o 409 não pode
    contar a quem pede o que a tela dele esconde. O admin decide — ele vê tudo.
    """
    if is_admin(user):
        return

    def _alheio(modelo):
        return or_(modelo.owner_id != user.id, modelo.owner_id.is_(None))

    consultas = []
    if process_ids:
        for modelo in (models.Deadline, models.Appointment):
            consultas.append(db.query(modelo.id).filter(
                modelo.process_id.in_(process_ids), _alheio(modelo)))
    if client_id is not None:
        do_cliente = [models.Document.client_id == client_id]
        if process_ids:
            do_cliente.append(and_(models.Document.process_id.in_(process_ids),
                                   models.Document.client_id.is_(None)))
        consultas.append(db.query(models.Document.id).filter(
            or_(*do_cliente),
            models.Document.precatorio_id.is_(None),
            models.Document.acao_id.is_(None),
            _alheio(models.Document),
        ))
    if any(q.first() is not None for q in consultas):
        raise HTTPException(
            status_code=409,
            detail=f"{alvo} de outro responsável. Só o administrador pode excluí-lo; {saida}.",
        )


@router.delete("/{process_id}")
def delete_process(
    process_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Exclui o processo (com prazos, audiências, partes e andamentos).

    Ordem obrigatória — cada passo antes do seguinte para nenhum virar oráculo
    (ex.: o 409 contando registros a quem nem pode excluir):
    require_edit → require_excluir → 404 → ensure_owner → bloqueios 409
    (prazo/audiência de outro dono; honorário) → anulações + delete, num
    commit só.
    """
    require_edit(current_user, "processes")
    require_excluir(current_user)   # estagiário nunca exclui — regra fixa do perfil
    process = db.query(models.Process).get(process_id)
    if not process:
        raise HTTPException(status_code=404, detail="Processo não encontrado")
    ensure_owner(process, current_user, "processo")

    bloquear_exclusao_de_alheios(
        db, current_user, process_ids=[process_id],
        alvo="Este processo tem prazos ou audiências",
        saida="encerre o processo",
    )
    bloquear_exclusao_por_vinculos(
        db, current_user,
        db.query(models.Honorario).filter(models.Honorario.process_id == process_id),
        None, "este processo",
        "Exclua ou desvincule os honorários antes, ou encerre o processo.",
    )

    prazos = [d for (d,) in db.query(models.Deadline.id).filter(
        models.Deadline.process_id == process_id).all()]
    # Publicações do DJEN: perdem o vínculo com o processo e com os prazos
    # dele, mas MANTÊM o dono. Zerar o dono as mandaria para a fila — e a
    # fila é lida por todo advogado (inteiro teor da intimação).
    db.query(models.Publicacao).filter(
        models.Publicacao.process_id == process_id
    ).update({models.Publicacao.process_id: None}, synchronize_session=False)
    desvincular_publicacoes_do_prazo(db, prazos)
    # Documento preso SÓ ao processo ficaria sem vínculo nenhum (o ORM anula o
    # process_id) — invisível em todas as fichas. Passa a ser do cliente.
    db.query(models.Document).filter(
        models.Document.process_id == process_id,
        models.Document.client_id.is_(None),
    ).update({models.Document.client_id: process.client_id}, synchronize_session=False)
    # Os UPDATEs acima foram direto ao banco; o ORM recarrega as coleções
    # (documentos, atendimentos) já com o estado novo antes de cascatear.
    db.expire_all()
    process = db.query(models.Process).get(process_id)
    db.delete(process)   # atendimentos: o ORM anula o process_id (ficam no cliente)
    db.commit()
    return {"ok": True}
