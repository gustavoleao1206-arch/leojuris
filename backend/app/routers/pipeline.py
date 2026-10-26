"""Rotas do Funil de clientes (pipeline) e do Dashboard.

Etapas do funil: lead -> negociacao -> ativo -> arquivado
"""
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..scope import (
    scope, ensure_owner, is_admin, can_view, filtrar_classificacao, filtrar_area,
    ve_tudo, require_edit,
)

router = APIRouter(prefix="/api", tags=["pipeline"])

# Etapas oficiais do funil, em ordem
PIPELINE_STAGES = ["lead", "negociacao", "ativo", "arquivado"]
STAGE_LABELS = {
    "lead": "Lead",
    "negociacao": "Em negociação",
    "ativo": "Cliente ativo",
    "arquivado": "Arquivado",
}


@router.get("/pipeline")
def get_pipeline(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Retorna os clientes agrupados por etapa do funil."""
    result = []
    for stage in PIPELINE_STAGES:
        clients = (
            scope(db.query(models.Client), models.Client, current_user)
            .filter(models.Client.status == stage)
            .order_by(models.Client.name)
            .all()
        )
        result.append(
            {
                "stage": stage,
                "label": STAGE_LABELS[stage],
                "count": len(clients),
                "clients": [
                    {
                        "id": c.id,
                        "name": c.name,
                        "phone": c.phone,
                        "email": c.email,
                    }
                    for c in clients
                ],
            }
        )
    return result


@router.put("/pipeline/{client_id}")
def move_pipeline(
    client_id: int,
    stage: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Move um cliente para outra etapa do funil."""
    # É ESCRITA no cliente: exige a permissão de edição do módulo, não só a de
    # dono. Sem isto, quem tivesse Clientes como somente-leitura ainda arrastava
    # o card no funil e alterava o status — a tela escondia o controle, mas a
    # API aceitava a chamada direta.
    require_edit(current_user, "clients")
    if stage not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail="Etapa inválida")
    client = db.query(models.Client).get(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    ensure_owner(client, current_user, "cliente")
    client.status = stage
    db.commit()
    return {"ok": True, "stage": stage}


@router.get("/dashboard", response_model=schemas.DashboardStats)
def dashboard(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Indicadores do painel: clientes, processos ativos, prazos urgentes, audiências."""
    total_clients = scope(db.query(models.Client), models.Client, current_user).count()
    active_processes = (
        scope(db.query(models.Process), models.Process, current_user)
        .filter(models.Process.status == "ativo").count()
    )

    # Prazos urgentes = pendentes que vencem nos próximos 7 dias
    limit_date = date.today() + timedelta(days=7)
    urgent_deadlines = (
        scope(db.query(models.Deadline), models.Deadline, current_user)
        .filter(
            models.Deadline.done == 0,
            models.Deadline.date >= date.today(),
            models.Deadline.date <= limit_date,
        )
        .count()
    )

    upcoming_appointments = (
        scope(db.query(models.Appointment), models.Appointment, current_user)
        .filter(models.Appointment.date_time >= datetime.now())
        .count()
    )

    return schemas.DashboardStats(
        total_clients=total_clients,
        active_processes=active_processes,
        urgent_deadlines=urgent_deadlines,
        upcoming_appointments=upcoming_appointments,
    )


def _build_buckets(period: str):
    """Monta as faixas (label, início, fim) para os gráficos por dia/semana/mês."""
    today = date.today()
    buckets = []
    if period == "month":
        y, m = today.year, today.month
        for i in range(5, -1, -1):
            mm, yy = m - i, y
            while mm <= 0:
                mm += 12
                yy -= 1
            start = date(yy, mm, 1)
            nxt = date(yy + 1, 1, 1) if mm == 12 else date(yy, mm + 1, 1)
            buckets.append((f"{mm:02d}/{yy}", start, nxt - timedelta(days=1)))
    elif period == "week":
        monday = today - timedelta(days=today.weekday())
        for i in range(7, -1, -1):
            start = monday - timedelta(weeks=i)
            buckets.append((start.strftime("%d/%m"), start, start + timedelta(days=6)))
    else:  # day -> últimos 14 dias
        for i in range(13, -1, -1):
            d = today - timedelta(days=i)
            buckets.append((d.strftime("%d/%m"), d, d))
    return buckets


@router.get("/dashboard/charts")
def dashboard_charts(
    period: str = "day",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Demandas (prazos + audiências) agregadas por dia, semana ou mês.

    Agregação feita em Python para funcionar igual em SQLite e PostgreSQL.
    """
    buckets = _build_buckets(period)
    deadlines = scope(db.query(models.Deadline), models.Deadline, current_user).all()
    appts = scope(db.query(models.Appointment), models.Appointment, current_user).all()

    labels, prazos, audiencias, demandas = [], [], [], []
    for label, start, end in buckets:
        pc = sum(1 for x in deadlines if x.date and start <= x.date <= end)
        ac = sum(1 for x in appts if x.date_time and start <= x.date_time.date() <= end)
        labels.append(label)
        prazos.append(pc)
        audiencias.append(ac)
        demandas.append(pc + ac)

    return {
        "period": period,
        "labels": labels,
        "prazos": prazos,
        "audiencias": audiencias,
        "demandas": demandas,
    }


# ============================================================
#  DASHBOARD EXECUTIVO (agregações consolidadas, RBAC-aware)
#  Novo endpoint — não altera os anteriores.
# ============================================================

# --- Rótulos e mapeamentos ---
LEAD_ORDER = [
    "novos_leads", "interesse", "analise_doc", "qualificacao",
    "contrato_enviado", "contrato_assinado", "concluido", "perdido",
]
LEAD_LABELS = {
    "novos_leads": "Novos leads", "interesse": "Interesse",
    "analise_doc": "Análise documental", "qualificacao": "Qualificação",
    "contrato_enviado": "Contrato enviado", "contrato_assinado": "Contrato assinado",
    "concluido": "Concluído", "perdido": "Perdido",
}
_LEAD_LEGACY = {
    "novo_lead": "novos_leads", "negociacao": "interesse", "doc_pendente": "analise_doc",
    "assinatura": "contrato_enviado", "fechado": "contrato_assinado", "arquivado": "concluido",
}
_LEAD_CONVERTIDO = {"contrato_assinado", "concluido"}
_LEAD_ENCERRADO = {"concluido", "perdido"}

CLASSIF_LABELS = {
    "com_alvara": "Com alvará", "sem_alvara": "Sem alvará",
    "habilitacao_herdeiros": "Habilitação de herdeiros",
    "reexpedicao": "Reexpedição", "cancelado": "Cancelado",
}
# Rotula área de PROCESSO e de AÇÃO no mesmo gráfico, por isso tem as duas
# chaves de "outros": processo usa o masculino (`PROC_CATEGORIAS`), ação usa o
# feminino (`scope.ACAO_AREAS`). Não são duplicata — são listas diferentes que
# caem no mesmo painel.
AREA_LABELS = {
    "civel": "Cível", "trabalhista": "Trabalhista", "previdenciario": "Previdenciário",
    "familia": "Família", "consumidor": "Consumidor", "tributario": "Tributário",
    "bancario": "Bancário", "sucessoes": "Sucessões",
    "outros": "Outros",    # processos (e honorário sem processo/ação)
    "outras": "Outras",    # ações
    "precatorios": "Precatórios",
}


def _canon_stage(s):
    """Normaliza status_lead legado para o vocabulário oficial de 8 etapas."""
    return _LEAD_LEGACY.get(s or "", s or "novos_leads")


def _dscope(query, model, user, advogado_id):
    """Escopo do dashboard: admin vê tudo (ou de um advogado); advogado vê só o seu.

    Aplica também as permissões de classificação (Precatorio) e de área (Acao),
    para o painel não agregar casos que o usuário não pode enxergar.
    """
    if is_admin(user):
        if advogado_id:
            return query.filter(model.owner_id == advogado_id)
        return query
    # O estagiário enxerga os números do escritório inteiro; o advogado, só os
    # seus. Ambos seguem limitados por classificação/área.
    if not ve_tudo(user):
        query = query.filter(model.owner_id == user.id)
    if model is models.Precatorio:
        query = filtrar_classificacao(query, model, user)
    elif model is models.Acao:
        query = filtrar_area(query, model, user)
    return query


def _period_range(period: str):
    """Retorna (inicio, fim) como datas para métricas de fluxo."""
    today = date.today()
    if period == "hoje":
        return today, today
    if period == "7d":
        return today - timedelta(days=6), today
    if period == "ano":
        return date(today.year, 1, 1), today
    if period == "tudo":
        return date(2000, 1, 1), today
    # padrão: mês corrente
    return date(today.year, today.month, 1), today


def _as_date(v):
    """Aceita date ou datetime e devolve date (ou None)."""
    if v is None:
        return None
    return v.date() if isinstance(v, datetime) else v


@router.get("/dashboard/executive")
def dashboard_executive(
    period: str = "mes",
    advogado_id: int = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Painel executivo consolidado: cards, comercial, jurídico, financeiro,
    equipe (admin), agenda e insights. Respeita a segregação por dono."""
    admin = is_admin(current_user)
    if not admin:
        advogado_id = None  # advogado nunca filtra por outro usuário
    start, end = _period_range(period)
    today = date.today()

    # ---- Coleta única das listas (já com escopo) ----
    clients = _dscope(db.query(models.Client), models.Client, current_user, advogado_id).all()
    processes = _dscope(db.query(models.Process), models.Process, current_user, advogado_id).all()
    deadlines = _dscope(db.query(models.Deadline), models.Deadline, current_user, advogado_id).all()
    appts = _dscope(db.query(models.Appointment), models.Appointment, current_user, advogado_id).all()
    honos = _dscope(db.query(models.Honorario), models.Honorario, current_user, advogado_id).all()
    precs = _dscope(db.query(models.Precatorio), models.Precatorio, current_user, advogado_id).all()
    acoes = _dscope(db.query(models.Acao), models.Acao, current_user, advogado_id).all()

    proc_area = {p.id: (p.type or "outros") for p in processes}
    acao_area = {a.id: (a.area or "outras") for a in acoes}   # ação: feminino

    def _in_period(d):
        d = _as_date(d)
        return d is not None and start <= d <= end

    # ================= BLOCO 1 · CARDS =================
    clientes_ativos = sum(1 for c in clients if c.status == "ativo")
    novos_clientes = sum(1 for c in clients if _in_period(c.created_at))
    processos_ativos = sum(1 for p in processes if p.status == "ativo")

    def _prec_ativo(p):
        return _canon_stage(p.status_lead) not in _LEAD_ENCERRADO and p.classificacao != "cancelado"
    precatorios_ativos = sum(1 for p in precs if _prec_ativo(p))

    receita_periodo = sum((h.paid_value or 0) for h in honos if _in_period(h.created_at))
    lim72 = today + timedelta(days=3)
    prazos_criticos = sum(1 for d in deadlines if d.done == 0 and d.date and today <= d.date <= lim72)
    honorarios_pendentes = sum(((h.total_value or 0) - (h.paid_value or 0)) for h in honos if h.status != "pago")

    cards = {
        "clientes_ativos": clientes_ativos,
        "novos_clientes": novos_clientes,
        "processos_ativos": processos_ativos,
        "precatorios_ativos": precatorios_ativos,
        "receita_periodo": round(receita_periodo, 2),
        "prazos_criticos_72h": prazos_criticos,
        "honorarios_pendentes": round(honorarios_pendentes, 2),
    }

    # ================= BLOCO 2 · COMERCIAL =================
    # Funil (precatórios + ações) por etapa canônica
    funil_counts = {s: 0 for s in LEAD_ORDER}
    for item in list(precs) + list(acoes):
        st = _canon_stage(item.status_lead)
        if st in funil_counts:
            funil_counts[st] += 1
    funil = [{"stage": s, "label": LEAD_LABELS[s], "count": funil_counts[s]} for s in LEAD_ORDER]

    # Leads por área (ações por área + precatórios agrupados)
    leads_area = {}
    for a in acoes:
        k = a.area or "outras"
        leads_area[k] = leads_area.get(k, 0) + 1
    if precs:
        leads_area["precatorios"] = leads_area.get("precatorios", 0) + len(precs)
    leads_por_area = [{"area": k, "label": AREA_LABELS.get(k, k.title()), "count": v}
                      for k, v in sorted(leads_area.items(), key=lambda x: -x[1])]

    # Conversão no período
    itens_comercial = list(precs) + list(acoes)
    total_leads_periodo = sum(1 for i in itens_comercial if _in_period(i.created_at))
    convertidos_periodo = sum(1 for i in itens_comercial
                              if _in_period(i.created_at) and _canon_stage(i.status_lead) in _LEAD_CONVERTIDO)
    taxa_conversao = round(100 * convertidos_periodo / total_leads_periodo, 1) if total_leads_periodo else 0.0

    # Série novos x convertidos (6 meses)
    buckets_m = _build_buckets("month")
    serie_novos, serie_conv = [], []
    for _label, b0, b1 in buckets_m:
        serie_novos.append(sum(1 for i in itens_comercial if b0 <= (_as_date(i.created_at) or date(1900, 1, 1)) <= b1))
        serie_conv.append(sum(1 for i in itens_comercial
                              if b0 <= (_as_date(i.created_at) or date(1900, 1, 1)) <= b1
                              and _canon_stage(i.status_lead) in _LEAD_CONVERTIDO))

    # Leads quentes (muito provável, ainda abertos)
    leads_quentes = []
    for i in itens_comercial:
        if i.probabilidade_nivel == "muito_provavel" and _canon_stage(i.status_lead) not in _LEAD_ENCERRADO:
            nome = getattr(i, "requerente_nome", None) or getattr(i, "parte_nome", None) or "—"
            leads_quentes.append({
                "id": i.id,
                "tipo": "precatorio" if hasattr(i, "requerente_nome") else "acao",
                "nome": nome,
                "valor": getattr(i, "valor_caso", None) or getattr(i, "valor_causa", None) or 0,
                "proximo_contato": (i.data_proximo_contato.isoformat() if i.data_proximo_contato else None),
            })
    leads_quentes = leads_quentes[:8]

    comercial = {
        "funil": funil,
        "leads_por_area": leads_por_area,
        "serie": {"labels": [b[0] for b in buckets_m], "novos": serie_novos, "convertidos": serie_conv},
        "taxa_conversao": taxa_conversao,
        "leads_quentes": leads_quentes,
    }
    if not admin:
        # fila de leads sem dono (prospecção compartilhada)
        fila = (db.query(models.Precatorio).filter(models.Precatorio.owner_id.is_(None)).count()
                + db.query(models.Acao).filter(models.Acao.owner_id.is_(None)).count())
        comercial["fila_leads"] = fila

    # ================= BLOCO 3 · JURÍDICA =================
    proc_status = {"ativo": 0, "suspenso": 0, "encerrado": 0}
    proc_por_area, proc_por_tribunal = {}, {}
    for p in processes:
        proc_status[p.status] = proc_status.get(p.status, 0) + 1
        proc_por_area[p.type or "outros"] = proc_por_area.get(p.type or "outros", 0) + 1
        if p.tribunal:
            proc_por_tribunal[p.tribunal] = proc_por_tribunal.get(p.tribunal, 0) + 1

    prec_classif = {}
    for p in precs:
        k = p.classificacao or "sem_alvara"
        prec_classif[k] = prec_classif.get(k, 0) + 1

    # Processos ativos sem próximo passo (sem prazo pendente futuro e sem audiência futura)
    proc_com_prazo = {d.process_id for d in deadlines if d.done == 0 and d.date and d.date >= today}
    proc_com_audiencia = {a.process_id for a in appts if a.date_time and a.date_time >= datetime.now()}
    parados = [p for p in processes if p.status == "ativo"
               and p.id not in proc_com_prazo and p.id not in proc_com_audiencia]
    processos_parados = [{"id": p.id, "case_number": p.case_number, "type": p.type,
                          "tribunal": p.tribunal} for p in parados[:12]]

    juridica = {
        "processos_status": proc_status,
        "processos_por_area": [{"area": k, "label": AREA_LABELS.get(k, k.title()), "count": v}
                               for k, v in sorted(proc_por_area.items(), key=lambda x: -x[1])],
        "processos_por_tribunal": [{"tribunal": k, "count": v}
                                   for k, v in sorted(proc_por_tribunal.items(), key=lambda x: -x[1])],
        "precatorios_por_classificacao": [{"classe": k, "label": CLASSIF_LABELS.get(k, k), "count": v}
                                          for k, v in prec_classif.items()],
        "habilitacoes": prec_classif.get("habilitacao_herdeiros", 0),
        "reexpedicoes": prec_classif.get("reexpedicao", 0),
        "processos_parados": processos_parados,
        "processos_parados_total": len(parados),
    }
    if admin:
        juridica["datajud_novidades"] = db.query(models.Monitor).filter(models.Monitor.has_news == 1).count()
        juridica["datajud_total"] = db.query(models.Monitor).count()

    # ================= BLOCO 4 · FINANCEIRO =================
    contratado = sum((h.total_value or 0) for h in honos)
    recebido = sum((h.paid_value or 0) for h in honos)
    pendente = contratado - recebido
    inadimplencia = sum(((h.total_value or 0) - (h.paid_value or 0)) for h in honos
                        if h.status != "pago" and h.due_date and h.due_date < today)
    ticket_medio = round(contratado / len(honos), 2) if honos else 0.0

    fin_contratado_m, fin_recebido_m = [], []
    for _label, b0, b1 in buckets_m:
        fin_contratado_m.append(round(sum((h.total_value or 0) for h in honos
                                          if b0 <= (_as_date(h.created_at) or date(1900, 1, 1)) <= b1), 2))
        fin_recebido_m.append(round(sum((h.paid_value or 0) for h in honos
                                        if b0 <= (_as_date(h.created_at) or date(1900, 1, 1)) <= b1), 2))

    receita_area = {}
    for h in honos:
        if h.process_id and h.process_id in proc_area:
            k = proc_area[h.process_id]
        elif h.acao_id and h.acao_id in acao_area:
            k = acao_area[h.acao_id]
        else:
            k = "outros"
        receita_area[k] = receita_area.get(k, 0) + (h.total_value or 0)

    parc = [h for h in honos if h.origem == "parceria"]
    parc_total = sum((h.total_value or 0) for h in parc)
    parc_escritorio = sum((h.total_value or 0) * ((h.pct_escritorio or 0) / 100) for h in parc)

    financeiro = {
        "contratado": round(contratado, 2), "recebido": round(recebido, 2),
        "pendente": round(pendente, 2), "inadimplencia": round(inadimplencia, 2),
        "ticket_medio": ticket_medio,
        "serie": {"labels": [b[0] for b in buckets_m], "contratado": fin_contratado_m, "recebido": fin_recebido_m},
        "receita_por_area": [{"area": k, "label": AREA_LABELS.get(k, k.title()), "valor": round(v, 2)}
                             for k, v in sorted(receita_area.items(), key=lambda x: -x[1])],
        "parcerias": {"total": round(parc_total, 2), "escritorio": round(parc_escritorio, 2),
                      "parceiro": round(parc_total - parc_escritorio, 2), "qtd": len(parc)},
    }

    # ---- Distribuição (rateio de sócios) — livro-razão; SÓ admin, pois expõe a
    #      repartição interna nominal por sócio (informação sensível). ----
    if admin:
        hon_ids = {h.id for h in honos}
        rateios = [r for r in db.query(models.HonorarioRateio).all() if r.honorario_id in hon_ids]
        reserva_total = 0.0
        fundos_map = {}              # nome -> R$
        socios_list = {}            # user_id -> {nome, valor}
        parceiros_list = {}         # user_id -> {nome, valor}
        for r in rateios:
            v = r.valor or 0
            if r.tipo == "reserva":
                reserva_total += v
            elif r.tipo == "fundo":
                fundos_map[r.nome or "Fundo"] = fundos_map.get(r.nome or "Fundo", 0) + v
            elif r.tipo == "socio":
                # Mostra a fatia mesmo sem dono vinculado (aparece pelo nome do
                # config, ex.: "Sócio 1"), para o dinheiro nunca sumir do painel.
                key = r.user_id if r.user_id else ("n:" + (r.nome or "Sócio"))
                s = socios_list.setdefault(key, {"user_id": r.user_id, "nome": r.nome or "Sócio", "valor": 0})
                s["valor"] += v
            elif r.tipo == "parceiro" and r.user_id:
                p = parceiros_list.setdefault(r.user_id, {"user_id": r.user_id, "nome": r.nome, "valor": 0})
                p["valor"] += v
        financeiro["distribuicao"] = {
            "reserva": round(reserva_total, 2),
            "fundos": [{"nome": k, "valor": round(v, 2)} for k, v in sorted(fundos_map.items(), key=lambda x: -x[1])],
            "socios": [{"user_id": s["user_id"], "nome": s["nome"], "valor": round(s["valor"], 2)}
                       for s in sorted(socios_list.values(), key=lambda x: -x["valor"])],
            "parceiros": [{"user_id": p["user_id"], "nome": p["nome"], "valor": round(p["valor"], 2)}
                          for p in sorted(parceiros_list.values(), key=lambda x: -x["valor"])],
            "total": round(sum((r.valor or 0) for r in rateios), 2),
            "qtd_honorarios": len({r.honorario_id for r in rateios}),
        }

    # ================= BLOCO 5 · EQUIPE (admin) =================
    equipe = []
    if admin:
        users = db.query(models.User).all()
        allc = db.query(models.Client).all()
        allp = db.query(models.Process).all()
        allpr = db.query(models.Precatorio).all()
        allac = db.query(models.Acao).all()
        allh = db.query(models.Honorario).all()
        alld = db.query(models.Deadline).all()
        allrat = db.query(models.HonorarioRateio).all()
        # Honorário CREDITADO a cada pessoa = sua fatia real (regime de caixa):
        #  - honorários rateados: soma das fatias de sócio/parceiro que são dele;
        #  - honorários simples (sem rateio): o responsável recebe o valor pago.
        hono_por_user = {}
        for r in allrat:
            if r.tipo in ("socio", "parceiro") and r.user_id:
                hono_por_user[r.user_id] = hono_por_user.get(r.user_id, 0) + (r.valor or 0)
        for h in allh:
            if not getattr(h, "rateio", 0) and h.owner_id:
                hono_por_user[h.owner_id] = hono_por_user.get(h.owner_id, 0) + (h.paid_value or 0)
        for u in users:
            u_proc = sum(1 for p in allp if p.owner_id == u.id)
            u_cli = sum(1 for c in allc if c.owner_id == u.id)
            u_prec = sum(1 for p in allpr if p.owner_id == u.id)
            u_acao = sum(1 for a in allac if a.owner_id == u.id)
            u_hono = hono_por_user.get(u.id, 0)   # fatia real da pessoa
            u_conv = (sum(1 for p in allpr if p.owner_id == u.id and _canon_stage(p.status_lead) in _LEAD_CONVERTIDO)
                      + sum(1 for a in allac if a.owner_id == u.id and _canon_stage(a.status_lead) in _LEAD_CONVERTIDO))
            u_prazos_ok = sum(1 for d in alld if d.owner_id == u.id and d.done == 1)
            # Índice de produtividade: volume de casos (proc+prec+ações) + resultados (conversões) + prazos + receita real
            indice = round(u_proc * 2 + u_prec * 2 + u_acao * 2 + u_conv * 5 + u_prazos_ok * 1 + (u_hono / 10000), 1)
            equipe.append({
                "id": u.id, "nome": u.name, "role": u.role,
                "processos": u_proc, "clientes": u_cli, "precatorios": u_prec, "acoes": u_acao,
                "honorarios": round(u_hono, 2), "convertidos": u_conv, "indice": indice,
            })
        equipe.sort(key=lambda x: -x["indice"])

    # ================= BLOCO 6 · AGENDA =================
    now = datetime.now()
    prox_audiencias = sorted([a for a in appts if a.date_time and a.date_time >= now],
                             key=lambda a: a.date_time)[:8]
    prazos_lista = sorted([d for d in deadlines if d.done == 0 and d.date and d.date <= lim72],
                          key=lambda d: d.date)[:12]
    proc_case = {p.id: p.case_number for p in processes}
    semana = []
    for i in range(7):
        dd = today + timedelta(days=i)
        semana.append({
            "data": dd.isoformat(),
            "prazos": sum(1 for d in deadlines if d.done == 0 and d.date == dd),
            "audiencias": sum(1 for a in appts if a.date_time and a.date_time.date() == dd),
        })
    agenda = {
        "semana": semana,
        "prazos_criticos": [{"id": d.id, "date": d.date.isoformat(), "descricao": d.description,
                             "urgencia": d.urgency_level, "processo": proc_case.get(d.process_id)}
                            for d in prazos_lista],
        "proximas_audiencias": [{"id": a.id, "date_time": a.date_time.isoformat(), "local": a.location,
                                 "processo": proc_case.get(a.process_id)} for a in prox_audiencias],
        "tarefas_pendentes": sum(1 for d in deadlines if d.done == 0),
    }

    # ================= BLOCO 7 · INSIGHTS =================
    insights = []
    sem_contato = sum(1 for i in itens_comercial
                      if (i.data_ultimo_contato is None) or (i.data_ultimo_contato < today - timedelta(days=60)))
    if sem_contato:
        insights.append({"tipo": "relacionamento", "sev": "warn",
                         "texto": f"{sem_contato} lead(s)/caso(s) sem contato há mais de 60 dias.",
                         "link": "/precatorios"})
    aguardando_doc = sum(1 for i in itens_comercial if _canon_stage(i.status_lead) == "analise_doc")
    if aguardando_doc:
        insights.append({"tipo": "juridico", "sev": "info",
                         "texto": f"{aguardando_doc} caso(s) em análise documental aguardando andamento.",
                         "link": "/precatorios"})
    if prazos_criticos:
        insights.append({"tipo": "prazo", "sev": "bad",
                         "texto": f"{prazos_criticos} prazo(s) crítico(s) vencem nas próximas 72h.",
                         "link": "/agenda"})
    contratos_parados = _dscope(db.query(models.Assinatura), models.Assinatura, current_user, advogado_id).filter(
        models.Assinatura.status == "enviado").all()
    contratos_parados = sum(1 for a in contratos_parados
                            if a.created_at and _as_date(a.created_at) < today - timedelta(days=7))
    if contratos_parados:
        insights.append({"tipo": "comercial", "sev": "warn",
                         "texto": f"{contratos_parados} contrato(s) enviado(s) há mais de 7 dias sem assinatura.",
                         "link": "/assinaturas"})
    # média de honorários (comparativo simples do mês vs média dos 6 meses)
    media_6m = (sum(fin_recebido_m) / len(fin_recebido_m)) if fin_recebido_m else 0
    if media_6m and fin_recebido_m and fin_recebido_m[-1] < media_6m * 0.82:
        insights.append({"tipo": "financeiro", "sev": "warn",
                         "texto": "Honorários recebidos neste mês estão abaixo da média dos últimos 6 meses.",
                         "link": "/financeiro"})

    # Defesa em profundidade: quem não tem permissão para ver o módulo também
    # não recebe os agregados dele pelo dashboard.
    if not can_view(current_user, "financeiro"):
        financeiro = {}
        insights = [i for i in insights if i.get("link") != "/financeiro"]
        # Os cards do topo também carregam dinheiro — sem eles o painel do
        # estagiário (ou de quem perdeu o módulo) não expõe valor nenhum.
        cards.pop("receita_periodo", None)
        cards.pop("honorarios_pendentes", None)
    if not can_view(current_user, "precatorios"):
        juridica.pop("precatorios_por_classificacao", None)

    return {
        "profile": current_user.role or "advogado",
        "period": period,
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "cards": cards,
        "comercial": comercial,
        "juridica": juridica,
        "financeiro": financeiro,
        "equipe": equipe,
        "agenda": agenda,
        "insights": insights,
    }
