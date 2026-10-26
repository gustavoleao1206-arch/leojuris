"""Rotas do módulo Financeiro (honorários contratuais e extrajudiciais)."""
import io
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import distribuicao, models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..scope import (
    scope, ensure_owner, is_admin, require_view, require_edit, require_excluir,
    can_view, ensure_classificacao, ensure_area, filtrar_classificacao, filtrar_area,
)
# Escopos de precatório/ação vêm dos routers donos deles porque incluem a FILA
# (owner_id IS NULL), que o `scope()` genérico não tem. Import de router para
# router é o padrão já usado aqui (export.py faz o mesmo com FUNIL_LABELS).
from .precatorios import _scope_prec, _ensure_acesso as _prec_ensure_acesso
from .acoes import _scope_acao, _ensure_acesso as _acao_ensure_acesso

# Teto por tipo no seletor de casos. A carteira tem centenas de precatórios;
# um <select> com tudo trava o navegador e ninguém rola até o fim. Quando o
# usuário escolhe o cliente a lista já vem curta — o teto só protege o caso
# "sem cliente selecionado", e a busca por texto alcança o que ficar de fora.
_TETO_CASOS = 300


def _scope_hon(query, user):
    """Não-admin vê honorários onde é o responsável OU o advogado parceiro."""
    if is_admin(user):
        return query
    return query.filter(
        or_(models.Honorario.owner_id == user.id, models.Honorario.parceiro_id == user.id)
    )


def filtro_honorarios_do_cliente(db, client_id):
    """Condição "honorário DESTE cliente": `client_id` OU processo do cliente.

    🚨 Só `client_id` deixava de fora o honorário lançado apenas no processo —
    o cliente é opcional no formulário, então ele existe. Ficava fora da aba
    Financeiro da ficha e do "A receber", e (pior) o DELETE do cliente não o
    via: o processo ia embora em cascata e o Postgres estourava a FK (500).
    É uma CONDIÇÃO, não uma consulta: quem usa continua aplicando `_scope_hon`.
    """
    procs = db.query(models.Process.id).filter(
        models.Process.client_id == client_id
    ).scalar_subquery()
    return or_(models.Honorario.client_id == client_id,
               models.Honorario.process_id.in_(procs))


def _ensure_view(h, user):
    """Acesso de leitura: admin, responsável ou parceiro."""
    if is_admin(user):
        return
    if h.owner_id == user.id or h.parceiro_id == user.id:
        return
    raise HTTPException(status_code=403, detail="Sem acesso a este honorário")


def _users_map(db):
    return {u.id: u.name for u in db.query(models.User).all()}


def _so_parceiro(h, user):
    """True quando o usuário é APENAS o parceiro (não dono nem admin) deste honorário."""
    return (
        not is_admin(user)
        and h.origem == "parceria"
        and h.parceiro_id == user.id
        and h.owner_id != user.id
    )


def _viewer_share(h, user):
    """Valores (total, pago) na ótica do usuário: o parceiro vê apenas a parte dele."""
    total = h.total_value or 0
    paid = h.paid_value or 0
    if _so_parceiro(h, user):
        pct = (h.pct_parceiro or 0) / 100
        return round(total * pct, 2), round(paid * pct, 2)
    return total, paid

router = APIRouter(prefix="/api/honorarios", tags=["financeiro"])


def _compute_status(total: float, paid: float) -> str:
    """Deriva o status a partir dos valores."""
    total = total or 0
    paid = paid or 0
    if paid <= 0:
        return "pendente"
    if paid >= total:
        return "pago"
    return "parcial"


def _to_out(h: models.Honorario, users: dict = None, viewer=None) -> schemas.HonorarioOut:
    users = users or {}
    data = schemas.HonorarioOut.model_validate(h)
    data.client_name = h.client.name if h.client else None
    # O rótulo do caso serve para os TRÊS tipos. Antes só conhecia processo, e
    # honorário de precatório/ação aparecia sem vínculo na tela mesmo tendo um.
    if h.process:
        data.process_label = h.process.case_number or f"Processo #{h.process.id}"
    elif getattr(h, "precatorio", None):
        pr = h.precatorio
        data.process_label = (
            pr.numero_precatorio or pr.processo_id or f"Precatório #{pr.id}"
        )
    elif getattr(h, "acao", None):
        data.process_label = h.acao.numero_processo or f"Ação #{h.acao.id}"
    data.owner_name = users.get(h.owner_id)
    data.created_by_name = users.get(h.created_by)
    data.parceiro_name = users.get(h.parceiro_id)

    # Livro-razão da distribuição — só o admin enxerga a repartição interna
    # (quanto vai para cada sócio, fundo e reserva é informação sensível).
    # Fail-closed: sem viewer identificado, não expõe (is_admin(None) == False).
    if getattr(h, "rateio", 0) and is_admin(viewer):
        data.rateio_fatias = [
            schemas.RateioFatiaOut.model_validate(r)
            for r in sorted(h.rateios, key=lambda r: r.id)
        ]

    # Rateio da parceria sobre o valor recebido (visão completa)
    if h.origem == "parceria":
        base = h.paid_value or 0
        data.valor_escritorio = round(base * (h.pct_escritorio or 0) / 100, 2)
        data.valor_parceiro = round(base * (h.pct_parceiro or 0) / 100, 2)

    # Se quem vê é APENAS o parceiro, mostra somente a parte dele
    if viewer is not None and _so_parceiro(h, viewer):
        data.total_value, data.paid_value = _viewer_share(h, viewer)
        data.minha_parte = True
    data.status = _compute_status(data.total_value, data.paid_value)
    data.pending_value = max((data.total_value or 0) - (data.paid_value or 0), 0)
    return data


@router.get("", response_model=List[schemas.HonorarioOut])
def list_honorarios(
    type: Optional[str] = None,
    status: Optional[str] = None,
    acao_id: Optional[int] = None,
    precatorio_id: Optional[int] = None,
    client_id: Optional[int] = None,
    process_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "financeiro")
    query = _scope_hon(db.query(models.Honorario), current_user)
    if client_id:
        query = query.filter(filtro_honorarios_do_cliente(db, client_id))
    if process_id:
        query = query.filter(models.Honorario.process_id == process_id)
    if type:
        query = query.filter(models.Honorario.type == type)
    if precatorio_id:
        query = query.filter(models.Honorario.precatorio_id == precatorio_id)
    if acao_id:
        query = query.filter(models.Honorario.acao_id == acao_id)
    items = query.order_by(models.Honorario.due_date.is_(None), models.Honorario.due_date).all()
    users = _users_map(db)
    result = [_to_out(h, users, current_user) for h in items]
    if status:
        result = [h for h in result if h.status == status]
    return result


@router.get("/casos")
def casos_vinculaveis(
    client_id: Optional[int] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Casos que o usuário pode amarrar a um honorário — as TRÊS tabelas.

    Existe porque o seletor da tela só conhecia `processes`, e a carteira deste
    escritório é majoritariamente de precatórios: o campo "Processo vinculado"
    parecia esconder registros quando na verdade nunca havia listado as outras
    duas tabelas.

    🚨 O filtro por cliente NÃO pode ser só `client_id`. Precatório entra por
    importação de planilha e **nada no sistema escreve `Precatorio.client_id`**
    (conferido: zero ocorrências no router) — filtrar só por ele devolveria
    lista vazia justamente no tipo de caso mais comum daqui. O vínculo real é
    o NOME: a própria importação usa `_chave_nome` para deduplicar. Por isso
    casa `client_id` OU nome do requerente/parte igual ao do cliente.

    ⚠️ Sem `client_id` devolve tudo que o usuário alcança — é o comportamento
    antigo do seletor, preservado de propósito para que nenhum caso que era
    selecionável ontem deixe de ser hoje.

    RBAC: as duas camadas de cada módulo. `scope` (dono/fila) para os três,
    mais `filtrar_classificacao` em precatórios e `filtrar_area` em ações.
    """
    require_view(current_user, "financeiro")

    nome_cliente = None
    if client_id:
        cli = db.query(models.Client).get(client_id)
        if not cli:
            raise HTTPException(status_code=400, detail="Cliente não encontrado")
        ensure_owner(cli, current_user, "cliente")
        nome_cliente = (cli.name or "").strip()

    termo = (q or "").strip()
    like = f"%{termo}%" if termo else None

    def _por_cliente(query, model, campo_nome):
        """Restringe ao cliente: pelo vínculo formal OU pelo nome, que é como
        precatório e ação realmente se ligam a uma pessoa neste sistema.

        `campo_nome=None` para quem tem client_id confiável (processo).
        """
        if not client_id:
            return query
        cond = [model.client_id == client_id]
        if nome_cliente and campo_nome is not None:
            cond.append(func.lower(campo_nome) == nome_cliente.lower())
        return query.filter(or_(*cond))

    # ---- Processos (têm client_id de verdade: o form exige) ----
    qp = scope(db.query(models.Process), models.Process, current_user)
    if can_view(current_user, "processes"):
        if like:
            qp = qp.filter(models.Process.case_number.ilike(like))
        else:
            # Processo tem client_id de verdade (o formulário exige), então
            # `campo_nome=None` desliga o casamento por nome — que aqui não faz
            # sentido nenhum: comparar número CNJ com nome de cliente nunca
            # casaria, e deixar o argumento errado ensinaria o padrão errado a
            # quem for reusar este helper.
            qp = _por_cliente(qp, models.Process, None)
        processos = qp.order_by(models.Process.created_at.desc()).limit(_TETO_CASOS).all()
    else:
        processos = []

    # ---- Precatórios ----
    # 🚨 `_scope_prec`, NÃO o `scope()` genérico: precatório e ação têm FILA
    # (owner_id IS NULL) que o advogado enxerga. Com o scope genérico o caso da
    # fila aparecia na tela de Precatórios mas sumia daqui — o advogado veria o
    # lead e não conseguiria lançar o honorário dele. É o mesmo padrão de erro
    # que já apareceu em outras telas: a permissão "funciona", mas o registro
    # desaparece para um perfil.
    if can_view(current_user, "precatorios"):
        qpr = _scope_prec(db.query(models.Precatorio), current_user)
        qpr = filtrar_classificacao(qpr, models.Precatorio, current_user)
        if like:
            qpr = qpr.filter(or_(
                models.Precatorio.requerente_nome.ilike(like),
                models.Precatorio.numero_precatorio.ilike(like),
                models.Precatorio.processo_id.ilike(like),
            ))
        else:
            qpr = _por_cliente(qpr, models.Precatorio, models.Precatorio.requerente_nome)
        precatorios = qpr.order_by(models.Precatorio.id.desc()).limit(_TETO_CASOS).all()
    else:
        precatorios = []

    # ---- Ações ---- (mesma razão: `_scope_acao` inclui a fila)
    if can_view(current_user, "acoes"):
        qa = _scope_acao(db.query(models.Acao), current_user)
        qa = filtrar_area(qa, models.Acao, current_user)
        if like:
            qa = qa.filter(or_(
                models.Acao.parte_nome.ilike(like),
                models.Acao.numero_processo.ilike(like),
            ))
        else:
            qa = _por_cliente(qa, models.Acao, models.Acao.parte_nome)
        acoes = qa.order_by(models.Acao.id.desc()).limit(_TETO_CASOS).all()
    else:
        acoes = []

    return {
        "processos": [
            {"id": p.id, "label": p.case_number or f"Processo #{p.id}",
             "sub": (p.client.name if p.client else None)}
            for p in processos
        ],
        "precatorios": [
            {"id": p.id,
             "label": p.numero_precatorio or p.processo_id or f"Precatório #{p.id}",
             "sub": p.requerente_nome}
            for p in precatorios
        ],
        "acoes": [
            {"id": a.id, "label": a.numero_processo or f"Ação #{a.id}",
             "sub": a.parte_nome}
            for a in acoes
        ],
    }


@router.get("/summary", response_model=schemas.FinanceSummary)
def summary(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Totais financeiros: total contratado, recebido e pendente.

    Para o advogado parceiro, considera apenas a parte dele.
    """
    require_view(current_user, "financeiro")
    items = _scope_hon(db.query(models.Honorario), current_user).all()
    total = recebido = 0
    for h in items:
        t, p = _viewer_share(h, current_user)
        total += t
        recebido += p
    return schemas.FinanceSummary(
        total=total, recebido=recebido, pendente=max(total - recebido, 0)
    )


@router.get("/relatorio")
def relatorio(
    meses: int = 6,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Relatório financeiro: contratado x recebido por mês (vencimento) + indicadores."""
    require_view(current_user, "financeiro")
    items = _scope_hon(db.query(models.Honorario), current_user).all()
    hoje = date.today()

    # Monta os últimos N meses
    buckets = []
    y, m = hoje.year, hoje.month
    for i in range(meses - 1, -1, -1):
        mm, yy = m - i, y
        while mm <= 0:
            mm += 12
            yy -= 1
        buckets.append((yy, mm))

    # Valores na ótica do usuário (o parceiro enxerga apenas a parte dele)
    vals = {h.id: _viewer_share(h, current_user) for h in items}
    labels, contratado, recebido = [], [], []
    for (yy, mm) in buckets:
        labels.append(f"{mm:02d}/{yy}")
        cont = sum(vals[h.id][0] for h in items
                   if h.due_date and h.due_date.year == yy and h.due_date.month == mm)
        rec = sum(vals[h.id][1] for h in items
                  if h.due_date and h.due_date.year == yy and h.due_date.month == mm)
        contratado.append(round(cont, 2))
        recebido.append(round(rec, 2))

    a_receber = sum(max(vals[h.id][0] - vals[h.id][1], 0) for h in items)
    inadimplencia = sum(
        max(vals[h.id][0] - vals[h.id][1], 0)
        for h in items
        if h.due_date and h.due_date < hoje and vals[h.id][1] < vals[h.id][0]
    )
    return {
        "labels": labels,
        "contratado": contratado,
        "recebido": recebido,
        "a_receber": round(a_receber, 2),
        "inadimplencia": round(inadimplencia, 2),
    }


def _validar_vinculos(db, user, client_id=None, process_id=None, acao_id=None,
                      precatorio_id=None):
    """O cliente/processo/precatório/ação informados no CORPO existem e são alcançáveis?

    O `require_edit("financeiro")` responde "esta pessoa pode mexer em
    honorários?", mas não "pode mexer NESTE cliente?". Sem esta checagem, um
    advogado criava honorário preso ao cliente de um colega passando o
    `client_id` direto na API — e o valor aparecia no painel 360 do outro.

    🚨 Precatório e ação têm DUAS camadas de RBAC: a
    segregação por dono E o recorte por classificação/área. `ensure_owner`
    sozinho deixaria um advogado sem a classificação "compra de crédito"
    amarrar um honorário a um precatório dessa classificação — e o rótulo do
    caso voltaria para ele na listagem do financeiro. Por isso as duas.
    """
    # O caso é UM só. A tela só deixa escolher um, mas a API é aberta a
    # qualquer usuário com edição em financeiro — e dois FKs preenchidos fariam
    # o rótulo e o relatório escolherem um deles por ordem de `if`, calados.
    if sum(1 for x in (process_id, acao_id, precatorio_id) if x) > 1:
        raise HTTPException(
            status_code=400,
            detail="O honorário aceita um único caso vinculado (processo, precatório ou ação)",
        )
    if client_id:
        c = db.query(models.Client).get(client_id)
        if not c:
            raise HTTPException(status_code=400, detail="Cliente não encontrado")
        ensure_owner(c, user, "cliente")
    if process_id:
        p = db.query(models.Process).get(process_id)
        if not p:
            raise HTTPException(status_code=400, detail="Processo não encontrado")
        ensure_owner(p, user, "processo")
    # 🚨 Precatório e ação usam o `_ensure_acesso` DO PRÓPRIO MÓDULO, não o
    # `ensure_owner` genérico. O genérico reprova `owner_id IS NULL`, que é
    # justamente a FILA — e a fila é a maioria dos precatórios (a importação de
    # planilha grava owner_id=None). Com o genérico aqui, o seletor oferecia o
    # lead da fila e o Salvar respondia 403: as duas metades da mesma mudança
    # se contradiziam. `_ensure_acesso` libera admin/dono/fila E já valida
    # classificação (precatório) e área (ação) — as duas camadas, num lugar só.
    if acao_id:
        a = db.query(models.Acao).get(acao_id)
        if not a:
            raise HTTPException(status_code=400, detail="Ação não encontrada")
        _acao_ensure_acesso(a, user)
    if precatorio_id:
        pr = db.query(models.Precatorio).get(precatorio_id)
        if not pr:
            raise HTTPException(status_code=400, detail="Precatório não encontrado")
        _prec_ensure_acesso(pr, user)


@router.post("/parcelar", response_model=List[schemas.HonorarioOut])
def parcelar(
    payload: schemas.ParcelarRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Gera N parcelas de honorário com vencimentos automáticos."""
    require_edit(current_user, "financeiro")
    _validar_vinculos(db, current_user, payload.client_id, payload.process_id,
                      payload.acao_id, payload.precatorio_id)
    if payload.parcelas < 1:
        raise HTTPException(status_code=400, detail="Número de parcelas inválido")
    total = round(payload.total_value or 0, 2)
    base_parcela = round(total / payload.parcelas, 2)
    criados = []
    for i in range(payload.parcelas):
        # Última parcela ajusta a diferença de arredondamento
        valor = base_parcela if i < payload.parcelas - 1 else round(total - base_parcela * (payload.parcelas - 1), 2)
        venc = payload.primeiro_vencimento + timedelta(days=payload.intervalo_dias * i)
        h = models.Honorario(
            client_id=payload.client_id,
            process_id=payload.process_id,
            acao_id=payload.acao_id,
            precatorio_id=payload.precatorio_id,
            type=payload.type,
            total_value=valor,
            paid_value=0,
            due_date=venc,
            notes=(payload.notes + " — " if payload.notes else "") + f"Parcela {i + 1}/{payload.parcelas}",
        )
        h.status = _compute_status(h.total_value, h.paid_value)
        h.owner_id = current_user.id
        h.created_by = current_user.id
        db.add(h)
        criados.append(h)
    db.commit()
    users = _users_map(db)
    for h in criados:
        db.refresh(h)
    return [_to_out(h, users) for h in criados]


@router.post("", response_model=schemas.HonorarioOut)
def create_honorario(
    payload: schemas.HonorarioCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "financeiro")
    _validar_vinculos(db, current_user, payload.client_id, payload.process_id,
                      payload.acao_id, payload.precatorio_id)
    data = payload.model_dump()
    owner = data.pop("owner_id", None)
    h = models.Honorario(**data)
    h.status = _compute_status(h.total_value, h.paid_value)
    h.created_by = current_user.id                      # quem criou (imutável)
    h.owner_id = owner if (is_admin(current_user) and owner) else current_user.id  # responsável
    db.add(h)
    db.commit()
    db.refresh(h)
    # Gera o livro-razão da distribuição (se for honorário de precatório rateado)
    distribuicao.aplicar_rateio(db, h)
    db.commit()
    db.refresh(h)
    return _to_out(h, _users_map(db), current_user)


@router.get("/{honorario_id}", response_model=schemas.HonorarioOut)
def get_honorario(
    honorario_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "financeiro")
    h = db.query(models.Honorario).get(honorario_id)
    if not h:
        raise HTTPException(status_code=404, detail="Honorário não encontrado")
    _ensure_view(h, current_user)
    return _to_out(h, _users_map(db), current_user)


def _brl(v) -> str:
    s = f"{(v or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return "R$ " + s


@router.get("/{honorario_id}/recibo")
def recibo(
    honorario_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Gera um recibo de honorários em PDF."""
    require_view(current_user, "financeiro")
    h = db.query(models.Honorario).get(honorario_id)
    if not h:
        raise HTTPException(status_code=404, detail="Honorário não encontrado")
    ensure_owner(h, current_user, "honorário")

    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.pdfgen import canvas

    cliente = h.client.name if h.client else "—"
    valor = h.paid_value or 0
    tipo = "contratuais" if h.type == "contratual" else "extrajudiciais"

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, hgt = A4

    # Cabeçalho
    c.setFillColorRGB(0.10, 0.16, 0.24)
    c.rect(0, hgt - 3 * cm, w, 3 * cm, fill=1, stroke=0)
    c.setFillColorRGB(0.79, 0.63, 0.29)
    c.setFont("Helvetica-Bold", 20)
    c.drawCentredString(w / 2, hgt - 1.7 * cm, "LEOJURIS")
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Helvetica", 10)
    c.drawCentredString(w / 2, hgt - 2.3 * cm, "Recibo de Honorários")

    # Corpo
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica-Bold", 16)
    c.drawCentredString(w / 2, hgt - 4.6 * cm, "RECIBO")
    c.setFont("Helvetica-Bold", 14)
    c.drawCentredString(w / 2, hgt - 5.6 * cm, _brl(valor))

    texto = (
        f"Recebi de {cliente} a importância de {_brl(valor)}, "
        f"referente a honorários advocatícios {tipo}"
    )
    # O recibo sai do escritório para o CLIENTE: omitir o caso quando ele é
    # precatório ou ação (que passaram a existir aqui) deixaria o documento
    # sem a única referência que identifica a que se refere o pagamento.
    if h.process:
        texto += f", do processo {h.process.case_number or ('#' + str(h.process.id))}"
    elif getattr(h, "precatorio", None):
        pr = h.precatorio
        texto += f", do precatório {pr.numero_precatorio or pr.processo_id or ('#' + str(pr.id))}"
    elif getattr(h, "acao", None):
        texto += f", da ação {h.acao.numero_processo or ('#' + str(h.acao.id))}"
    texto += "."

    c.setFont("Helvetica", 12)
    # Quebra simples de linha
    y = hgt - 7.2 * cm
    palavras = texto.split()
    linha = ""
    for p in palavras:
        if c.stringWidth(linha + " " + p, "Helvetica", 12) < (w - 4 * cm):
            linha = (linha + " " + p).strip()
        else:
            c.drawString(2 * cm, y, linha)
            y -= 0.7 * cm
            linha = p
    if linha:
        c.drawString(2 * cm, y, linha)

    if h.notes:
        c.setFont("Helvetica-Oblique", 10)
        c.drawString(2 * cm, y - 1.0 * cm, f"Obs.: {h.notes}")

    # Data e assinatura
    hoje = datetime.now().strftime("%d/%m/%Y")
    c.setFont("Helvetica", 12)
    c.drawString(2 * cm, 7 * cm, f"Data: {hoje}")
    c.line(w / 2 - 4 * cm, 4.5 * cm, w / 2 + 4 * cm, 4.5 * cm)
    c.setFont("Helvetica", 10)
    c.drawCentredString(w / 2, 4 * cm, "LeoJuris")

    c.showPage()
    c.save()
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="recibo-{h.id}.pdf"'},
    )


@router.put("/{honorario_id}", response_model=schemas.HonorarioOut)
def update_honorario(
    honorario_id: int,
    payload: schemas.HonorarioUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "financeiro")
    h = db.query(models.Honorario).get(honorario_id)
    if not h:
        raise HTTPException(status_code=404, detail="Honorário não encontrado")
    ensure_owner(h, current_user, "honorário")
    data = payload.model_dump(exclude_unset=True)
    # 🚨 O `ensure_owner(h)` acima diz "posso mexer NESTE honorário", mas o corpo
    # pode REAPONTAR o honorário para o cliente/processo de um colega — o create
    # (e o parcelar) já barram isso com _validar_vinculos, o update não barrava.
    # Confirmado em pentest (ago/2026): advogado repontava o próprio honorário
    # para o cliente de outro via PUT (BOLA de escrita). Revalida os alvos NOVOS.
    _validar_vinculos(
        db, current_user,
        data.get("client_id"), data.get("process_id"), data.get("acao_id"),
        data.get("precatorio_id"),
    )
    # Pago > total: conferido sobre o registro JÁ MESCLADO, porque o PUT pode
    # trazer só um dos dois (o schema não enxerga o valor gravado). Só quando o
    # corpo mexe em algum deles: um registro antigo já inconsistente continua
    # editável nos outros campos (observação, vencimento...).
    if "total_value" in data or "paid_value" in data:
        total = data["total_value"] if "total_value" in data else h.total_value
        pago = data["paid_value"] if "paid_value" in data else h.paid_value
        if schemas.pago_excede_total(total, pago):
            raise HTTPException(status_code=422, detail=schemas.MSG_PAGO_MAIOR_QUE_TOTAL)
    owner = data.pop("owner_id", None)
    for field, value in data.items():
        setattr(h, field, value)
    if owner is not None and is_admin(current_user):
        h.owner_id = owner
    h.status = _compute_status(h.total_value, h.paid_value)
    db.commit()
    db.refresh(h)
    # Recalcula o livro-razão: mudou valor pago, parceiro, rateio, etc.
    distribuicao.aplicar_rateio(db, h)
    db.commit()
    db.refresh(h)
    return _to_out(h, _users_map(db), current_user)


@router.delete("/{honorario_id}")
def delete_honorario(
    honorario_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "financeiro")
    require_excluir(current_user)
    h = db.query(models.Honorario).get(honorario_id)
    if not h:
        raise HTTPException(status_code=404, detail="Honorário não encontrado")
    ensure_owner(h, current_user, "honorário")
    db.delete(h)
    db.commit()
    return {"ok": True}
