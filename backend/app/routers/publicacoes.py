"""Publicações do DJEN (Diário de Justiça Eletrônico Nacional).

Captura por OAB do escritório e por processo monitorado; guarda o inteiro teor.
Sob demanda (botão "Sincronizar") — adequado ao plano gratuito que hiberna.
"""
import json
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import comunica, models
from ..auth import get_current_user
from ..database import get_db
from ..scope import URGENCIAS, ensure_owner, require_excluir, ve_tudo

router = APIRouter(prefix="/api/publicacoes", tags=["publicacoes"])


def _require_admin(user: models.User):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Apenas administradores")


# ----------------------------- OABs monitoradas -----------------------------
class OabIn(BaseModel):
    numero: str
    uf: str
    nome: Optional[str] = None
    ativo: Optional[int] = 1


def _oab_out(o: models.OabMonitorada) -> dict:
    return {"id": o.id, "numero": o.numero, "uf": o.uf, "nome": o.nome, "ativo": o.ativo}


@router.get("/oabs")
def list_oabs(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    return [_oab_out(o) for o in db.query(models.OabMonitorada).order_by(models.OabMonitorada.id).all()]


@router.post("/oabs")
def create_oab(payload: OabIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    numero = "".join(ch for ch in (payload.numero or "") if ch.isdigit())
    uf = (payload.uf or "").strip().upper()[:2]
    if not numero or not uf:
        raise HTTPException(status_code=400, detail="Informe número da OAB e UF.")
    o = models.OabMonitorada(numero=numero, uf=uf, nome=(payload.nome or "").strip() or None,
                             ativo=1 if payload.ativo is None else int(payload.ativo))
    db.add(o)
    db.commit()
    db.refresh(o)
    return _oab_out(o)


@router.put("/oabs/{oab_id}")
def update_oab(oab_id: int, payload: OabIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    o = db.query(models.OabMonitorada).get(oab_id)
    if not o:
        raise HTTPException(status_code=404, detail="OAB não encontrada")
    if payload.numero is not None:
        o.numero = "".join(ch for ch in payload.numero if ch.isdigit()) or o.numero
    if payload.uf:
        o.uf = payload.uf.strip().upper()[:2]
    if payload.nome is not None:
        o.nome = payload.nome.strip() or None
    if payload.ativo is not None:
        o.ativo = int(payload.ativo)
    db.commit()
    return _oab_out(o)


@router.delete("/oabs/{oab_id}")
def delete_oab(oab_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    o = db.query(models.OabMonitorada).get(oab_id)
    if not o:
        raise HTTPException(status_code=404, detail="OAB não encontrada")
    db.delete(o)
    db.commit()
    return {"ok": True}


# ------------------------------ Sincronização ------------------------------
def _chaves_existentes(db: Session) -> set:
    """Conjunto de external_id/hash que a dedupe NÃO deve reinserir.

    Reúne as publicações que existem MAIS as que foram excluídas em definitivo
    (PublicacaoExcluida). Sem a segunda parte, uma publicação excluída dentro da
    janela de 30 dias do DJEN voltaria na próxima sincronização — a ressurreição
    que o modelo documenta. A tabela de excluídas guarda só a chave, não o teor.
    """
    existentes = set()
    for ext, h in db.query(models.Publicacao.external_id, models.Publicacao.hash).all():
        if ext:
            existentes.add(ext)
        if h:
            existentes.add(h)
    for ext, h in db.query(
        models.PublicacaoExcluida.external_id, models.PublicacaoExcluida.hash
    ).all():
        if ext:
            existentes.add(ext)
        if h:
            existentes.add(h)
    return existentes


def sincronizar(db: Session, dias: int = 30) -> dict:
    """Busca publicações novas (últimos N dias) por OAB ativa e por processo
    monitorado no DataJud; deduplica por external_id/hash e grava as inéditas.
    """
    fim = date.today()
    ini = fim - timedelta(days=max(1, dias))
    ini_s, fim_s = ini.isoformat(), fim.isoformat()

    brutos = []  # (item_cru, oab_tag)
    erros = []   # mensagens de falha (para diagnóstico, ex.: WAF/rede)
    for oab in db.query(models.OabMonitorada).filter(models.OabMonitorada.ativo == 1).all():
        try:
            for it in comunica.consultar_por_oab(oab.numero, oab.uf, ini_s, fim_s):
                brutos.append((it, f"{oab.numero}/{oab.uf}"))
        except Exception as e:
            erros.append(f"OAB {oab.numero}/{oab.uf}: {e}")
    # Também busca por processos já monitorados (reaproveita a tabela do DataJud)
    for m in db.query(models.Monitor).all():
        if not m.numero:
            continue
        try:
            for it in comunica.consultar_por_processo(m.numero, ini_s, fim_s):
                brutos.append((it, None))
        except Exception as e:
            erros.append(f"Processo {m.numero}: {e}")

    # Dedupe contra o banco pela MESMA chave usada abaixo (external_id OU hash),
    # para não reinserir publicações que só têm hash — inclui as excluídas em
    # definitivo, senão elas ressuscitariam dentro da janela de 30 dias.
    existentes = _chaves_existentes(db)
    vistos = set()
    novas = 0
    for it, oab_tag in brutos:
        norm = comunica.normalizar(it)
        chave = norm.get("external_id") or norm.get("hash")
        if not chave or chave in vistos or chave in existentes:
            continue
        vistos.add(chave)
        pub = models.Publicacao(oab_captura=oab_tag, lida=0, **norm)
        db.add(pub)
        novas += 1
    db.commit()
    return {"novas": novas, "consultadas": len(brutos),
            "erros": erros[:5], "periodo": {"de": ini_s, "ate": fim_s}}


class ImportarIn(BaseModel):
    oab: Optional[str] = None      # tag de captura, ex.: "12345/AL"
    items: list = []               # itens CRUS vindos da API do DJEN (buscados no navegador)


@router.post("/importar")
def importar(payload: ImportarIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Recebe publicações CRUAS que o NAVEGADOR buscou no DJEN (a API geo-bloqueia
    o servidor). Normaliza, deduplica por external_id/hash e grava as inéditas.
    """
    _require_admin(current_user)
    existentes = _chaves_existentes(db)   # inclui as excluídas em definitivo (não ressuscita)
    vistos = set()
    novas = 0
    for it in (payload.items or []):
        if not isinstance(it, dict):
            continue
        norm = comunica.normalizar(it)
        chave = norm.get("external_id") or norm.get("hash")
        if not chave or chave in vistos or chave in existentes:
            continue
        vistos.add(chave)
        db.add(models.Publicacao(oab_captura=payload.oab, lida=0, **norm))
        novas += 1
    db.commit()
    return {"novas": novas, "recebidas": len(payload.items or [])}


@router.post("/sincronizar")
def sincronizar_endpoint(dias: int = 30, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    if not db.query(models.OabMonitorada).filter(models.OabMonitorada.ativo == 1).count() \
       and not db.query(models.Monitor).count():
        raise HTTPException(status_code=400, detail="Cadastre ao menos uma OAB monitorada antes de sincronizar.")
    return sincronizar(db, dias=dias)


# ------------------------------- Listagem -------------------------------
def _pub_out(p: models.Publicacao, full: bool = False) -> dict:
    out = {
        "id": p.id, "external_id": p.external_id, "tribunal": p.tribunal,
        "numero_processo": p.numero_processo, "tipo_comunicacao": p.tipo_comunicacao,
        "orgao": p.orgao, "classe": p.classe, "meio": p.meio,
        "data_disponibilizacao": p.data_disponibilizacao.isoformat() if p.data_disponibilizacao else None,
        "oab_captura": p.oab_captura, "lida": p.lida, "arquivada": p.arquivada,
        "client_id": p.client_id, "process_id": p.process_id, "deadline_id": p.deadline_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }
    if full:
        out["texto"] = p.texto
        out["link"] = p.link
        try:
            out["destinatarios"] = json.loads(p.destinatarios) if p.destinatarios else {}
        except Exception:
            out["destinatarios"] = {}
    return out


def _escopo_pub(q, user):
    """Restringe as publicações que o usuário alcança.

    A auditoria de ago/2026 encontrou esta consulta SEM escopo: qualquer
    advogado lia o inteiro teor das intimações de processos de todos os
    colegas — conteúdo sigiloso de cliente que não é dele.

    Regra (espelha a da FILA de precatórios): admin e estagiário veem tudo;
    o advogado vê as publicações vinculadas a ele MAIS as ainda não vinculadas.
    As não vinculadas precisam continuar visíveis porque é exatamente esse o
    fluxo — a publicação chega do DJEN sem dono e alguém a vincula.
    """
    if ve_tudo(user):
        return q
    return q.filter(
        or_(models.Publicacao.owner_id == user.id,
            models.Publicacao.owner_id.is_(None))
    )


def _pub_alcancavel(pub_id, db, user):
    """Busca a publicação por id aplicando o MESMO escopo da listagem.

    🚨 Toda rota por-id precisa passar por aqui. Sem isso o escopo da lista é
    decorativo: basta trocar o id na URL. O pentest de ago/2026 achou
    `gerar-prazo`, `prazo-preview` e `lida` operando sem esta checagem — um
    advogado gerava prazo no processo do colega e confirmava a existência de
    publicações que não podia ver. Publicação da fila (sem dono) continua
    alcançável por todos, exatamente como na lista — é o fluxo de triagem.
    """
    p = db.query(models.Publicacao).get(pub_id)
    if not p:
        raise HTTPException(status_code=404, detail="Publicação não encontrada")
    if not ve_tudo(user) and p.owner_id is not None and p.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sem acesso a esta publicação")
    return p


@router.get("")
def list_publicacoes(
    lida: Optional[int] = None,
    tribunal: Optional[str] = None,
    tipo: Optional[str] = None,
    search: Optional[str] = None,
    arquivadas: Optional[int] = None,
    client_id: Optional[int] = None,
    process_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Caixa (ou arquivo) de publicações do DJEN, no escopo de quem pede.

    Com `client_id`/`process_id` é a visão da FICHA (decisão do dono, out/2026:
    quem alcança o processo vê as intimações dele, inclusive o advogado — a
    tela de Monitoramento continua só admin + estagiário). Três diferenças:
      * cada item traz o `texto` (inteiro teor). A ficha mostra o teor e NÃO
        pode chamar `GET /{id}` para isso: aquela rota MARCA COMO LIDA, e `lida`
        é um campo único do escritório — abrir a aba apagaria o alerta de todos;
      * esta listagem nunca marca nada como lida (nem antes marcava);
      * sem `arquivadas` explícito, vêm caixa E arquivo: na ficha a intimação
        é histórico do processo, e o item traz `arquivada` para a tela separar.
    O escopo (`_escopo_pub`) é o mesmo: o filtro só restringe, nunca amplia.
    """
    q = _escopo_pub(db.query(models.Publicacao), current_user)
    visao_ficha = bool(client_id or process_id)
    if process_id:
        q = q.filter(models.Publicacao.process_id == process_id)
    if client_id:
        # Do cliente OU de um processo dele — o vínculo pode ter vindo só pelo
        # processo (mesma regra dos honorários).
        procs = db.query(models.Process.id).filter(
            models.Process.client_id == client_id
        ).scalar_subquery()
        q = q.filter(or_(models.Publicacao.client_id == client_id,
                         models.Publicacao.process_id.in_(procs)))
    # A lista mostra o ARQUIVO ou a caixa, nunca os dois misturados — misturar
    # devolveria a poluição que o arquivamento existe para resolver. (Na visão
    # da ficha, só quando pedido explicitamente — ver a docstring.)
    if arquivadas is not None or not visao_ficha:
        q = q.filter(models.Publicacao.arquivada == (1 if arquivadas else 0))
    if lida is not None:
        q = q.filter(models.Publicacao.lida == lida)
    if tribunal:
        q = q.filter(models.Publicacao.tribunal == tribunal)
    if tipo:
        q = q.filter(models.Publicacao.tipo_comunicacao == tipo)
    if search:
        like = f"%{search}%"
        q = q.filter(
            (models.Publicacao.numero_processo.ilike(like)) | (models.Publicacao.texto.ilike(like))
        )
    # Mais recentes primeiro: por data de disponibilização (desc), id como desempate.
    itens = q.order_by(
        models.Publicacao.data_disponibilizacao.desc(),
        models.Publicacao.id.desc(),
    ).limit(300).all()
    if visao_ficha:
        # Só o teor — `link`/`destinatarios` (lista de advogados e partes)
        # continuam exclusivos do detalhe.
        return [dict(_pub_out(p), texto=p.texto) for p in itens]
    return [_pub_out(p) for p in itens]


@router.get("/novidades")
def novidades(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Conta apenas o que o usuário pode ver — senão o contador do sino revela
    # o volume de publicações dos outros.
    q = _escopo_pub(db.query(models.Publicacao), current_user)
    # Arquivada não conta no sino: ela saiu da caixa por decisão de alguém.
    return {"count": q.filter(models.Publicacao.lida == 0,
                              models.Publicacao.arquivada == 0).count()}


# --------------------------- Arquivar / desarquivar ---------------------------
# ⚠️ Estas rotas ficam ANTES de `/{pub_id}`: o FastAPI resolve na ordem de
# registro e leria "arquivar-lote" como um id.
class ArquivarLote(BaseModel):
    ids: List[int] = []
    todas_lidas: bool = False       # atalho: tudo que já foi lido, no escopo do usuário
    incluir_com_prazo: bool = False  # confirmação explícita para as que geraram prazo


_LOTE_MAX = 1000


@router.post("/arquivar-lote")
def arquivar_lote(
    payload: ArquivarLote,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Tira publicações da lista SEM apagar a intimação.

    ── Por que arquivar e não excluir ────────────────────────────────────────
    A dedupe da sincronização monta o conjunto de `external_id`/`hash` a partir
    das linhas existentes. Apagar tiraria a linha do conjunto, e como a busca do
    DJEN varre uma janela FIXA de 30 dias rodando sozinha a cada ~6h, tudo que
    fosse apagado dentro dessa janela voltaria — como NÃO LIDA. Arquivar mantém
    a linha no conjunto: some da tela, não volta, e a intimação fica.

    ── A trava do prazo ──────────────────────────────────────────────────────
    Publicação com `deadline_id` originou um prazo na agenda: ela é a prova de
    quando esse prazo começou a correr. Por isso o lote a IGNORA por padrão e
    devolve a contagem — quem quiser arquivar assim mesmo manda
    `incluir_com_prazo`, de forma consciente, nunca por acidente num "arquivar
    tudo".
    """
    require_excluir(current_user)   # estagiário nunca; regra fixa do perfil
    q = _escopo_pub(db.query(models.Publicacao), current_user).filter(
        models.Publicacao.arquivada == 0
    )
    if payload.todas_lidas:
        alvos = q.filter(models.Publicacao.lida == 1).limit(_LOTE_MAX).all()
    else:
        ids = (payload.ids or [])[:_LOTE_MAX]
        if not ids:
            raise HTTPException(status_code=400, detail="Selecione ao menos uma publicação.")
        # `in_` dentro do escopo: id fora do alcance simplesmente não casa.
        alvos = q.filter(models.Publicacao.id.in_(ids)).all()

    arquivadas, com_prazo = 0, 0
    for p in alvos:
        if p.deadline_id and not payload.incluir_com_prazo:
            com_prazo += 1
            continue
        p.arquivada = 1
        arquivadas += 1
    if arquivadas:
        from ..seguranca import registrar_acesso
        registrar_acesso(db, current_user, "ARQUIVAR",
                         f"publicações DJEN [{arquivadas} registro(s)]")
    db.commit()
    return {"ok": True, "arquivadas": arquivadas, "ignoradas_com_prazo": com_prazo}


class DesarquivarLote(BaseModel):
    ids: List[int] = []
    todas: bool = False


@router.post("/desarquivar-lote")
def desarquivar_lote(
    payload: DesarquivarLote,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Devolve publicações arquivadas para a lista. Arquivar é reversível."""
    require_excluir(current_user)
    q = _escopo_pub(db.query(models.Publicacao), current_user).filter(
        models.Publicacao.arquivada == 1
    )
    if payload.todas:
        alvos = q.limit(_LOTE_MAX).all()
    else:
        ids = (payload.ids or [])[:_LOTE_MAX]
        if not ids:
            raise HTTPException(status_code=400, detail="Selecione ao menos uma publicação.")
        alvos = q.filter(models.Publicacao.id.in_(ids)).all()
    for p in alvos:
        p.arquivada = 0
    db.commit()
    return {"ok": True, "desarquivadas": len(alvos)}


# ------------------------------ Exclusão definitiva ------------------------------
class ExcluirLote(BaseModel):
    ids: List[int] = []
    incluir_com_prazo: bool = False  # confirmação explícita para as que geraram prazo


@router.post("/excluir-lote")
def excluir_lote(
    payload: ExcluirLote,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """EXCLUI EM DEFINITIVO publicações ARQUIVADAS. Admin-only, irreversível.

    ── Diferença para o arquivar ──────────────────────────────────────────────
    Arquivar tira da lista e é reversível; isto APAGA a publicação (o inteiro
    teor some). Por ser irreversível e por a intimação ser prova de quando o
    prazo começou, é decisão do dono restrita ao ADMIN (não usa require_excluir,
    que ainda deixaria o advogado; aqui é _require_admin).

    ── Só o que já foi arquivado ──────────────────────────────────────────────
    O filtro `arquivada == 1` é a rede: nada some direto da caixa; primeiro
    arquiva-se (reversível), depois exclui-se do arquivo (definitivo).

    ── Sem ressurreição ───────────────────────────────────────────────────────
    Antes de apagar, grava a chave em PublicacaoExcluida. A dedupe da
    sincronização consulta essa tabela (_chaves_existentes), então a publicação
    não volta no próximo ciclo do DJEN — o problema que fez o sistema nascer só
    com "arquivar". Ver o modelo PublicacaoExcluida.

    ── A trava do prazo ───────────────────────────────────────────────────────
    Publicação com `deadline_id` originou um prazo: é a prova de quando ele
    começou. O lote a IGNORA por padrão e devolve a contagem; excluir assim mesmo
    exige `incluir_com_prazo`, nunca por acidente num "excluir tudo".
    """
    _require_admin(current_user)
    ids = (payload.ids or [])[:_LOTE_MAX]
    if not ids:
        raise HTTPException(status_code=400, detail="Selecione ao menos uma publicação.")
    # Admin vê tudo, mas o filtro arquivada==1 continua: só exclui do arquivo.
    alvos = db.query(models.Publicacao).filter(
        models.Publicacao.id.in_(ids),
        models.Publicacao.arquivada == 1,
    ).all()

    excluidas, com_prazo, rastros = 0, 0, []
    for p in alvos:
        if p.deadline_id and not payload.incluir_com_prazo:
            com_prazo += 1
            continue
        db.add(models.PublicacaoExcluida(
            external_id=p.external_id, hash=p.hash,
            numero_processo=p.numero_processo, tribunal=p.tribunal,
            data_disponibilizacao=p.data_disponibilizacao,
            oab_captura=p.oab_captura, deleted_by=current_user.id,
        ))
        rastros.append(p.numero_processo or p.external_id or f"#{p.id}")
        db.delete(p)
        excluidas += 1

    if excluidas:
        from ..seguranca import registrar_acesso
        registrar_acesso(
            db, current_user, "EXCLUIR",
            f"publicações DJEN [{excluidas} registro(s)]: {', '.join(rastros[:20])}",
        )
    db.commit()
    return {"ok": True, "excluidas": excluidas, "ignoradas_com_prazo": com_prazo}


@router.get("/diagnostico")
def diagnostico(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Mostra o que o SERVIDOR consegue da API do DJEN, OAB por OAB.

    Serve para diferenciar: (a) OAB não cadastrada/ativa; (b) API respondendo
    vazio ao servidor; (c) bloqueio/erro de rede.
    """
    _require_admin(current_user)
    from .. import comunica  # local para evitar custo no import do módulo
    fim = date.today()
    ini = fim - timedelta(days=30)
    oabs = db.query(models.OabMonitorada).all()
    res = {
        "hoje": fim.isoformat(), "periodo": {"de": ini.isoformat(), "ate": fim.isoformat()},
        "oabs_total": len(oabs), "oabs_ativas": sum(1 for o in oabs if o.ativo),
        "monitores": db.query(models.Monitor).count(),
        "publicacoes_no_banco": db.query(models.Publicacao).count(),
        "detalhe": [],
    }
    for o in oabs:
        info = {"oab": f"{o.numero}/{o.uf}", "ativo": o.ativo}
        try:
            data = comunica.consultar_bruto({
                "numeroOab": "".join(c for c in (o.numero or "") if c.isdigit()),
                "ufOab": o.uf,
                "dataDisponibilizacaoInicio": ini.isoformat(),
                "dataDisponibilizacaoFim": fim.isoformat(),
                "pagina": 1, "itensPorPagina": 5,
            })
            info["api_status"] = data.get("status")
            info["api_count"] = data.get("count")
            info["n_items"] = len(data.get("items") or [])
        except Exception as e:
            info["erro"] = str(e)
        res["detalhe"].append(info)
    return res


@router.get("/{pub_id}")
def get_publicacao(pub_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    p = db.query(models.Publicacao).get(pub_id)
    if not p:
        raise HTTPException(status_code=404, detail="Publicação não encontrada")
    # Mesma regra da listagem: sem isto, o escopo da lista seria decorativo —
    # bastava trocar o ID na URL para ler a intimação do colega (IDOR).
    if not ve_tudo(current_user) and p.owner_id is not None and p.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Sem acesso a esta publicação")
    if p.lida == 0:                      # abrir marca como lida
        p.lida = 1
        db.commit()
    return _pub_out(p, full=True)


class VincularIn(BaseModel):
    client_id: Optional[int] = None
    process_id: Optional[int] = None


@router.post("/{pub_id}/vincular")
def vincular(pub_id: int, payload: VincularIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Vincula a publicação a um cliente e/ou processo; herda o dono deles.

    Duas checagens que faltavam (auditoria ago/2026):

    1. Acesso à PRÓPRIA publicação — sem isso bastava trocar o ID na URL para
       mexer na intimação de um colega.
    2. Acesso ao ALVO (cliente/processo informados no corpo). O efeito aqui não
       é vazar dado, é o contrário: o advogado apontava a publicação para o
       processo de OUTRO, a publicação herdava o dono do alvo e sumia da tela
       de quem vinculou — poluindo silenciosamente a caixa do colega.

    Corpo vazio (`{}` ou os dois nulos) = DESVINCULAR, mantendo o dono.
    """
    p = db.query(models.Publicacao).get(pub_id)
    if not p:
        raise HTTPException(status_code=404, detail="Publicação não encontrada")
    if not ve_tudo(current_user) and p.owner_id is not None and p.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Sem acesso a esta publicação")

    # Desvincular (cliente E processo vazios) não mexe no dono. 🚨 Antes o
    # `owner = None` daqui zerava o dono, e a intimação voltava para a FILA,
    # que todo advogado lê na íntegra — a mesma razão pela qual as exclusões
    # de cliente/processo/prazo desvinculam mantendo o dono.
    owner = p.owner_id if not (payload.process_id or payload.client_id) else None
    if payload.process_id:
        proc = db.query(models.Process).get(payload.process_id)
        if not proc:
            raise HTTPException(status_code=400, detail="Processo não encontrado")
        ensure_owner(proc, current_user, "processo")
        owner = proc.owner_id
    if payload.client_id:
        cli = db.query(models.Client).get(payload.client_id)
        if not cli:
            raise HTTPException(status_code=400, detail="Cliente não encontrado")
        ensure_owner(cli, current_user, "cliente")
        if owner is None:
            owner = cli.owner_id

    p.client_id = payload.client_id
    p.process_id = payload.process_id
    p.owner_id = owner
    db.commit()
    return _pub_out(p, full=True)


@router.get("/{pub_id}/prazo-preview")
def prazo_preview(pub_id: int, dias: int = 15, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Prévia do prazo sugerido (publicação + vencimento em dias úteis)."""
    from ..prazos import sugerir_prazo
    p = _pub_alcancavel(pub_id, db, current_user)
    if not p.data_disponibilizacao:
        raise HTTPException(status_code=400, detail="Publicação sem data de disponibilização.")
    if dias < 1 or dias > 365:
        raise HTTPException(status_code=400, detail="Número de dias inválido.")
    return sugerir_prazo(p.data_disponibilizacao, dias)


class GerarPrazoIn(BaseModel):
    dias: int = 15
    descricao: Optional[str] = None
    urgency_level: Optional[str] = "media"

    # Mesma lista fechada do DeadlineCreate: este é o OUTRO caminho que grava
    # `urgency_level`, e o valor cai num atributo `class` da tela de Prazos.
    @field_validator("urgency_level")
    @classmethod
    def _urgencia_valida(cls, v):
        if v and v not in URGENCIAS:
            raise ValueError(f"Urgência inválida. Use uma de: {', '.join(sorted(URGENCIAS))}")
        return v


@router.post("/{pub_id}/gerar-prazo")
def gerar_prazo(pub_id: int, payload: GerarPrazoIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Cria um Prazo na agenda a partir da publicação (confirmação do advogado)."""
    from ..prazos import sugerir_prazo
    p = _pub_alcancavel(pub_id, db, current_user)
    if not p.process_id:
        raise HTTPException(status_code=400, detail="Vincule a publicação a um processo antes de gerar o prazo.")
    if not p.data_disponibilizacao:
        raise HTTPException(status_code=400, detail="Publicação sem data de disponibilização.")
    process = db.query(models.Process).get(p.process_id)
    if not process:
        raise HTTPException(status_code=400, detail="Processo vinculado não existe.")
    sug = sugerir_prazo(p.data_disponibilizacao, max(1, min(365, payload.dias)))
    venc = date.fromisoformat(sug["vencimento"])
    desc = (payload.descricao or "").strip() or (
        f"{p.tipo_comunicacao or 'Prazo'} — {p.numero_processo or ''} "
        f"(DJEN {p.data_disponibilizacao.isoformat()})"
    )
    d = models.Deadline(
        process_id=p.process_id, date=venc, description=desc[:255],
        urgency_level=(payload.urgency_level or "media"), done=0, owner_id=process.owner_id,
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    p.deadline_id = d.id
    db.commit()
    return {"ok": True, "deadline_id": d.id, "vencimento": sug["vencimento"],
            "publicacao": sug["publicacao"]}


@router.post("/{pub_id}/lida")
def marcar_lida(pub_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    p = _pub_alcancavel(pub_id, db, current_user)
    p.lida = 1
    db.commit()
    return {"ok": True}


@router.post("/visto-todos")
def marcar_todas(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    db.query(models.Publicacao).filter(models.Publicacao.lida == 0).update({"lida": 1})
    db.commit()
    return {"ok": True}
