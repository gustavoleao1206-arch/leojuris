"""Rotas de Clientes (CRUD) com controle de acesso por dono."""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..scope import (
    scope, ensure_owner, is_admin, ve_tudo, require_view, require_edit, require_excluir,
    can_view, validar_responsavel,
)
# O escopo de honorário (dono OU parceiro) e a "parte do parceiro" são regras
# do Financeiro — importadas, não copiadas, para o painel não divergir da tela.
from .financeiro import _scope_hon, _viewer_share, filtro_honorarios_do_cliente
# Mesma régua das telas de cada módulo — o painel nunca mostra mais que elas.
from .documents import query_documents
from .precatorios import _scope_prec
from .acoes import _scope_acao
from .processes import bloquear_exclusao_de_alheios, bloquear_exclusao_por_vinculos

router = APIRouter(prefix="/api/clients", tags=["clients"])

# Pontuação de telefone/CPF/CNPJ ignorada na busca por dígitos.
_PONTUACAO = (".", "-", "/", " ", "(", ")", "+")


def _digitos_sql(coluna):
    expr = coluna
    for ch in _PONTUACAO:
        expr = func.replace(expr, ch, "")
    return expr


def query_clients(db: Session, user, *, status: Optional[str] = None,
                  search: Optional[str] = None):
    """Consulta de clientes com o RBAC + os filtros da tela.

    Ponto único usado pela listagem E pelo export — assim a planilha sai com
    exatamente o que o usuário está vendo.

    A busca olha nome e e-mail e, quando o termo tem 3 dígitos ou mais, os
    DÍGITOS do CPF/CNPJ e dos telefones — "82 99999" acha "(82) 99999-0000".
    Não vira oráculo como a busca da fila de precatórios: cliente não tem fila,
    e a consulta já está restrita ao `scope` (só os clientes da pessoa).
    """
    query = scope(db.query(models.Client), models.Client, user)
    if status:
        query = query.filter(models.Client.status == status)
    termo = (search or "").strip()
    if termo:
        like = f"%{termo}%"
        conds = [models.Client.name.ilike(like), models.Client.email.ilike(like)]
        digitos = "".join(c for c in termo if c in "0123456789")
        if len(digitos) >= 3:
            for col in (models.Client.cpf_cnpj, models.Client.phone, models.Client.celular,
                        models.Client.whatsapp, models.Client.telefone_secundario):
                conds.append(_digitos_sql(col).like(f"%{digitos}%"))
        query = query.filter(or_(*conds))
    return query


def _contar_processos(db: Session, user, clientes) -> dict:
    """client_id → quantos processos dele o usuário ALCANÇA.

    Pelo `scope` de Processos, não pelo vínculo: o processo de outro advogado
    preso ao cliente não entra na conta (não entra na lista dele também).
    Sem o módulo Processos, nada é contado — quem chama devolve `None`.
    """
    ids = [c.id for c in clientes]
    if not ids:
        return {}
    q = scope(db.query(models.Process.client_id, func.count(models.Process.id)),
              models.Process, user)
    return dict(q.filter(models.Process.client_id.in_(ids))
                .group_by(models.Process.client_id).all())


def _clientes_out(db: Session, user, clientes) -> List[schemas.ClientOut]:
    contagem = _contar_processos(db, user, clientes) if can_view(user, "processes") else None
    saida = []
    for c in clientes:
        out = schemas.ClientOut.model_validate(c)
        out.processos_count = None if contagem is None else contagem.get(c.id, 0)
        saida.append(out)
    return saida


@router.get("", response_model=List[schemas.ClientOut])
def list_clients(
    status: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lista clientes (apenas os do advogado; admin vê todos)."""
    require_view(current_user, "clients")
    clientes = query_clients(db, current_user, status=status, search=search) \
        .order_by(models.Client.name).all()
    return _clientes_out(db, current_user, clientes)


@router.post("", response_model=schemas.ClientOut)
def create_client(
    payload: schemas.ClientCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "clients")
    data = payload.model_dump()
    owner = data.pop("owner_id", None)
    client = models.Client(**data)
    if is_admin(current_user) and owner:
        validar_responsavel(db, owner)
    client.owner_id = owner if (is_admin(current_user) and owner) else current_user.id
    db.add(client)
    db.commit()
    db.refresh(client)
    return _clientes_out(db, current_user, [client])[0]


@router.get("/{client_id}", response_model=schemas.ClientOut)
def get_client(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "clients")
    client = db.query(models.Client).get(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    ensure_owner(client, current_user, "cliente")
    return _clientes_out(db, current_user, [client])[0]


@router.get("/{client_id}/overview")
def client_overview(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Visão 360° do cliente: tudo que está vinculado a ele em um só lugar.

    🚨 RÉGUA EM TODOS OS BLOCOS (out/2026): cada bloco nunca mostra mais do
    que a tela do próprio módulo mostraria à mesma pessoa. Até aqui só
    honorários e contratos seguiam a régua; processos, documentos, precatórios
    e ações filtravam só pelo vínculo — o processo do colega preso ao cliente
    aparecia, e quem não tinha o módulo via os itens assim mesmo.
    tests/test_painel_360.py confere bloco a bloco contra cada listagem.
    """
    require_view(current_user, "clients")
    client = db.query(models.Client).get(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    ensure_owner(client, current_user, "cliente")

    def _fmt(d):
        return d.isoformat() if d else None

    processos = (
        scope(db.query(models.Process), models.Process, current_user)
        .filter(models.Process.client_id == client_id).all()
        if can_view(current_user, "processes") else []
    )

    # 💰 O bloco financeiro respeita a permissão do módulo "financeiro".
    #
    # Sem isto, o painel 360º era uma porta lateral para o Financeiro: o
    # estagiário tem esse módulo bloqueado por REGRA FIXA de perfil
    # (ESTAGIARIO_BLOQUEADOS), levava 403 na tela de Financeiro — e via os
    # valores aqui assim mesmo. Achado da auditoria de ago/2026.
    #
    # Não é 403: o painel continua abrindo normalmente, apenas sem o que o
    # usuário não tem direito de ver.
    pode_financeiro = can_view(current_user, "financeiro")
    # 🚨 E o escopo por DONO também, não só o do módulo. Filtrar só por
    # `client_id` mostrava ao dono do cliente os honorários de OUTRO advogado
    # presos a ele (o caso comum: o admin transfere o cliente e o que já estava
    # lançado segue com o dono antigo) — valores que a tela de Financeiro
    # esconde dessa mesma pessoa. A régua é: o painel nunca mostra mais que o
    # Financeiro. Pego pela suíte de testes (tests/test_painel_360.py), set/2026.
    # E nem MENOS (out/2026): a mesma condição da aba Financeiro da ficha
    # (`?client_id=`) — do cliente OU de um processo dele. Só `client_id`
    # deixava de fora o honorário lançado apenas no processo, e o total do
    # painel não batia com a soma da aba.
    honorarios = (
        _scope_hon(
            db.query(models.Honorario).filter(filtro_honorarios_do_cliente(db, client_id)),
            current_user,
        ).all()
        if pode_financeiro else []
    )
    # Na parceria, quem é SÓ o parceiro vê a parte dele, como no Financeiro.
    valores = {h.id: _viewer_share(h, current_user) for h in honorarios}
    # Documentos: `query_documents` é a consulta da tela de Documentos (módulo,
    # dono e recorte de precatório/ação proibidos) — a mesma, não uma cópia.
    documentos = query_documents(db, current_user, client_id=client_id).all()

    # Precatórios e ações "do cliente": pelo vínculo formal OU pelo NOME.
    #
    # Precatório entra por importação de planilha, que não grava `client_id`
    # (ver financeiro.casos_vinculaveis) — só pelo vínculo, o bloco sairia
    # vazio para quase todo cliente. O nome casa sem diferenciar maiúsculas,
    # como no Financeiro; `vinculo` diz à tela qual dos dois casou ("mesmo
    # nome" não é prova de que é a mesma pessoa).
    #
    # 🚨 Casar por nome traz leads da FILA para o advogado. Por isso cada item
    # leva SÓ id, número, tribunal/área, assunto, etapa, valor, dono e vínculo
    # — NUNCA um campo de `_SENSIVEIS` (CPF, RG, telefone, e-mail, endereço da
    # parte). Senão este painel viraria a porta lateral da máscara da fila.
    nome = (client.name or "").strip().lower()

    def _do_cliente(query, model, campo_nome):
        cond = [model.client_id == client_id]
        if nome:
            cond.append(func.lower(func.trim(campo_nome)) == nome)
        return query.filter(or_(*cond))

    def _vinculo(obj):
        return "cadastro" if obj.client_id == client_id else "nome"

    precatorios = (
        _do_cliente(_scope_prec(db.query(models.Precatorio), current_user),
                    models.Precatorio, models.Precatorio.requerente_nome)
        .order_by(models.Precatorio.id.desc()).all()
        if can_view(current_user, "precatorios") else []
    )
    acoes = (
        _do_cliente(_scope_acao(db.query(models.Acao), current_user),
                    models.Acao, models.Acao.parte_nome)
        .order_by(models.Acao.id.desc()).all()
        if can_view(current_user, "acoes") else []
    )
    # Mesmo defeito dos honorários: o contrato do colega preso a este cliente
    # aparecia aqui, mas não na tela de Assinaturas — que usa `scope()`.
    contratos = (
        scope(
            db.query(models.Assinatura).filter(models.Assinatura.client_id == client_id),
            models.Assinatura, current_user,
        ).all()
        if can_view(current_user, "assinaturas") else []
    )

    total_honorarios = sum(total for total, _pago in valores.values())
    return {
        "processos": [{
            "id": p.id, "case_number": p.case_number, "type": p.type,
            "assunto": p.assunto, "subcategoria": p.subcategoria,
            "fase_processual": p.fase_processual, "status": p.status,
            "sistema_eletronico": p.sistema_eletronico,
            "valor_causa": p.valor_causa,
        } for p in processos],
        "precatorios": [{
            "id": pr.id, "numero_precatorio": pr.numero_precatorio,
            "tribunal": pr.tribunal, "assunto": pr.assunto,
            "status_lead": pr.status_lead, "valor_caso": pr.valor_caso,
            "owner_id": pr.owner_id, "vinculo": _vinculo(pr),
        } for pr in precatorios],
        "acoes": [{
            "id": a.id, "area": a.area, "numero_processo": a.numero_processo,
            "assunto": a.assunto, "status_lead": a.status_lead, "valor_causa": a.valor_causa,
            "owner_id": a.owner_id, "vinculo": _vinculo(a),
        } for a in acoes],
        "honorarios": [{
            "id": h.id, "description": h.notes or h.type, "amount": valores[h.id][0],
            "paid": valores[h.id][1], "status": h.status, "due_date": _fmt(h.due_date),
        } for h in honorarios],
        "documentos": [{
            "id": d.id, "original_name": d.original_name,
            "categoria": d.categoria, "uploaded_at": _fmt(d.uploaded_at),
        } for d in documentos],
        "contratos": [{
            "id": c.id, "titulo": c.titulo, "tipo": c.tipo,
            "status": c.status,
        } for c in contratos],
        "resumo": {
            "total_processos": len(processos),
            "total_precatorios": len(precatorios),
            "total_acoes": len(acoes),
            "total_documentos": len(documentos),
            "total_contratos": len(contratos),
            "total_honorarios": total_honorarios,
        },
    }


@router.put("/{client_id}", response_model=schemas.ClientOut)
def update_client(
    client_id: int,
    payload: schemas.ClientUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "clients")
    client = db.query(models.Client).get(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    ensure_owner(client, current_user, "cliente")
    data = payload.model_dump(exclude_unset=True)
    # `name` é NOT NULL: `{"name": null}` virava IntegrityError (500).
    if "name" in data and not (data["name"] or "").strip():
        raise HTTPException(status_code=422, detail="O nome do cliente é obrigatório.")
    owner = data.pop("owner_id", None)
    dono_antigo = client.owner_id
    for field, value in data.items():
        setattr(client, field, value)
    if owner is not None and is_admin(current_user):  # só admin reatribui responsável
        validar_responsavel(db, owner)
        client.owner_id = owner
    if client.owner_id != dono_antigo:
        _propagar_dono_do_cliente(db, client.id, client.owner_id)
    db.commit()       # na mesma transação: ou troca tudo, ou nada
    db.refresh(client)
    return _clientes_out(db, current_user, [client])[0]


def _propagar_dono_do_cliente(db: Session, client_id: int, novo_dono):
    """O admin trocou o responsável do cliente: o que pende SÓ do cliente vai junto.

    Documento e publicação recebem o dono ao nascer, e o `scope()` filtra por
    ele — sem propagar, o novo responsável abriria a ficha e não veria os
    documentos pessoais do cliente nem as intimações ligadas a ele.

    Só o que é do cliente e de mais nada: documento sem processo/precatório/
    ação (os do processo seguem o dono do PROCESSO, que é transferido à parte)
    e publicação sem processo. Processos NÃO vão junto — transferir cada um é
    decisão do admin, processo a processo. Honorários e assinaturas também
    não: são registros de quem os lançou (régua do painel 360).
    """
    db.query(models.Document).filter(
        models.Document.client_id == client_id,
        models.Document.process_id.is_(None),
        models.Document.precatorio_id.is_(None),
        models.Document.acao_id.is_(None),
    ).update({models.Document.owner_id: novo_dono}, synchronize_session=False)
    db.query(models.Publicacao).filter(
        models.Publicacao.client_id == client_id,
        models.Publicacao.process_id.is_(None),
    ).update({models.Publicacao.owner_id: novo_dono}, synchronize_session=False)


@router.delete("/{client_id}")
def delete_client(
    client_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Exclui o cliente — e, em cascata, processos, prazos, audiências, partes,
    andamentos, atendimentos, contatos e documentos dele (registro E arquivo).

    Ordem obrigatória — cada passo antes do seguinte para nenhum virar oráculo
    (o 409 contando registros a quem nem pode excluir, ou a quem não alcança
    o cliente): require_edit → require_excluir → 404 → ensure_owner →
    bloqueios 409 (processos de outro dono; documentos/prazos/audiências de
    outro dono; honorário/contrato) → anulações + delete, num commit só.
    """
    require_edit(current_user, "clients")
    require_excluir(current_user)
    client = db.query(models.Client).get(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    ensure_owner(client, current_user, "cliente")

    # (a) 🚨 A cascata apaga os PROCESSOS do cliente — inclusive os de outro
    # advogado (o admin escolhe o dono de cada processo, e cliente transferido
    # deixa processo com o dono antigo). Sem isto a Ana excluía o próprio
    # cliente e levava junto processos, prazos e andamentos do Bruno, que ela
    # nem enxerga. Só o admin decide isso; para os demais, arquivar.
    if not ve_tudo(current_user):
        alheios = db.query(models.Process.id).filter(
            models.Process.client_id == client_id,
            or_(models.Process.owner_id != current_user.id, models.Process.owner_id.is_(None)),
        ).count()
        if alheios:
            raise HTTPException(
                status_code=409,
                detail="Este cliente tem processos de outro responsável. Só o "
                       "administrador pode excluí-lo; arquive o cliente.",
            )

    processos = [p for (p,) in db.query(models.Process.id).filter(
        models.Process.client_id == client_id).all()]

    # (a2) Mesmo com todos os processos dela, a cascata ainda apagaria
    # documentos, prazos e audiências de OUTRO dono (ou sem dono) presos ao
    # cliente/aos processos — que a Ana não vê. Também só o admin.
    bloquear_exclusao_de_alheios(
        db, current_user, process_ids=processos, client_id=client_id,
        alvo="Este cliente tem documentos, prazos ou audiências",
        saida="arquive o cliente",
    )

    # (b) honorário do cliente OU de um processo dele; (c) contrato/procuração.
    bloquear_exclusao_por_vinculos(
        db, current_user,
        db.query(models.Honorario).filter(filtro_honorarios_do_cliente(db, client_id)),
        db.query(models.Assinatura).filter(models.Assinatura.client_id == client_id),
        "este cliente",
        "Exclua ou desvincule esses registros antes, ou arquive o cliente.",
    )

    prazos =[d for (d,) in db.query(models.Deadline.id).filter(
        models.Deadline.process_id.in_(processos)).all()] if processos else []

    # Publicações do DJEN ligadas ao cliente, a um processo dele ou a um prazo
    # desses processos: perdem os TRÊS vínculos, mas MANTÊM o dono — zerar o
    # dono as mandaria para a fila, que todo advogado lê.
    cond_pub = [models.Publicacao.client_id == client_id]
    if processos:
        cond_pub.append(models.Publicacao.process_id.in_(processos))
    if prazos:
        cond_pub.append(models.Publicacao.deadline_id.in_(prazos))
    db.query(models.Publicacao).filter(or_(*cond_pub)).update({
        models.Publicacao.client_id: None,
        models.Publicacao.process_id: None,
        models.Publicacao.deadline_id: None,
    }, synchronize_session=False)
    # Precatórios e ações só perdem o vínculo: são casos com vida própria.
    for modelo in (models.Precatorio, models.Acao):
        db.query(modelo).filter(modelo.client_id == client_id).update(
            {modelo.client_id: None}, synchronize_session=False)
    # Documento que também é de um precatório/ação continua lá, preso ao caso.
    db.query(models.Document).filter(
        models.Document.client_id == client_id,
        or_(models.Document.precatorio_id.isnot(None), models.Document.acao_id.isnot(None)),
    ).update({models.Document.client_id: None}, synchronize_session=False)
    # Documento preso SÓ a um processo do cliente vai junto com o cliente, como
    # os demais documentos dele — sem isto ficaria órfão (o ORM anula o
    # process_id ao apagar o processo) e aparecendo solto na tela de Documentos.
    if processos:
        db.query(models.Document).filter(
            models.Document.process_id.in_(processos),
            models.Document.client_id.is_(None),
            models.Document.precatorio_id.is_(None),
            models.Document.acao_id.is_(None),
        ).update({models.Document.client_id: client_id}, synchronize_session=False)
    # Os UPDATEs acima foram direto ao banco; o ORM recarrega as coleções
    # (documentos, processos) já com o estado novo antes de cascatear.
    db.expire_all()
    # Depois das anulações, `client_id == este` é EXATAMENTE o que a cascata
    # vai apagar: os do cliente e os que eram só de um processo dele.
    arquivos = [c for (c,) in db.query(models.Document.file_path).filter(
        models.Document.client_id == client_id).all()]
    client = db.query(models.Client).get(client_id)
    db.delete(client)
    db.commit()
    # Só DEPOIS do commit: se ele falhar, o registro continua e o arquivo
    # também — apagar antes deixaria documento apontando para o nada.
    apagar_arquivos_de_upload(arquivos)
    return {"ok": True}


def apagar_arquivos_de_upload(caminhos):
    """Apaga do disco os arquivos de documentos que a cascata removeu do banco.

    🔒 LGPD: a exclusão direta do documento (`documents.py`) sempre apagou o
    arquivo, mas a cascata do cliente apagava só o REGISTRO — RG, laudo e
    procuração ficavam em `uploads/` sem nada no sistema apontando para eles,
    impossíveis de achar para atender a um pedido de exclusão do titular.

    Tolerante: arquivo já inexistente (o disco do Render é efêmero) ou que não
    sai não derruba a resposta — o banco já foi alterado. E só apaga DENTRO da
    pasta de uploads: `file_path` é texto do banco, e um caminho relativo ou
    de outro lugar nunca pode virar exclusão de arquivo do servidor.
    """
    import os
    from pathlib import Path

    from ..config import UPLOAD_DIR

    raiz = Path(UPLOAD_DIR).resolve()
    for caminho in caminhos:
        if not caminho:
            continue
        try:
            alvo = Path(caminho).resolve()
            if alvo.parent != raiz:
                continue
            os.remove(alvo)
        except OSError:
            pass
