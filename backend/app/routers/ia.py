"""Rotas do Módulo de Inteligência Artificial (Google Gemini).

Restrito a administradores. Dois recursos:
1. Importação inteligente de documentos: a IA lê um PDF/imagem, extrai os dados
   e devolve uma PRÉVIA. Nada é criado sem a aprovação do admin (endpoint /criar).
2. Assistente jurídico: responde perguntas em linguagem natural sobre o CRM.
"""
from datetime import date, timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config, ia, models
from ..auth import get_current_user
from ..database import get_db

router = APIRouter(prefix="/api/ia", tags=["ia"])


def _admin(user: models.User):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Recurso exclusivo do administrador.")


# ------------------------------ Status ------------------------------
@router.get("/status")
def ia_status(current_user: models.User = Depends(get_current_user)):
    _admin(current_user)
    return {"configurada": ia.ia_configurada(), "modelo": config.GEMINI_MODEL}


# --------------------- Importação inteligente -----------------------
@router.post("/importar")
async def importar_documento(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lê o documento com a IA e devolve os dados extraídos (apenas prévia)."""
    _admin(current_user)
    conteudo = await file.read()
    if not conteudo:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")
    if len(conteudo) > 12 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Arquivo muito grande (máx. 12 MB).")

    nome = (file.filename or "").lower()
    media = file.content_type or ""
    if media not in ("application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"):
        # Deduz pelo nome do arquivo quando o content-type vem genérico
        if nome.endswith(".pdf"):
            media = "application/pdf"
        elif nome.endswith((".jpg", ".jpeg")):
            media = "image/jpeg"
        elif nome.endswith(".png"):
            media = "image/png"
        else:
            raise HTTPException(status_code=400, detail="Envie um PDF, JPG ou PNG.")
    try:
        dados = ia.extrair_documento(conteudo, media, file.filename or "")
    except ia.IAError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "filename": file.filename, "dados": dados}


# ------------------- Criação a partir da prévia ---------------------
class CriarPayload(BaseModel):
    cliente: Optional[Dict[str, Any]] = None
    processo: Optional[Dict[str, Any]] = None
    acao: Optional[Dict[str, Any]] = None
    precatorio: Optional[Dict[str, Any]] = None
    criar_cliente: bool = False
    criar_processo: bool = False
    criar_acao: bool = False
    criar_precatorio: bool = False
    client_id: Optional[int] = None  # cliente já existente, se o admin escolher vincular


def _limpa(d: Dict[str, Any], campos) -> Dict[str, Any]:
    """Mantém só os campos do modelo e remove vazios."""
    out = {}
    for k in campos:
        v = (d or {}).get(k)
        if v not in (None, "", []):
            out[k] = v
    return out


_CAMPOS_CLIENTE = ["name", "cpf_cnpj", "rg", "orgao_expedidor", "data_nascimento", "sexo",
    "estado_civil", "nacionalidade", "profissao", "email", "celular", "phone",
    "cep", "estado", "cidade", "bairro", "rua", "numero", "complemento"]
_CAMPOS_PROCESSO = ["case_number", "type", "subcategoria", "classe", "assunto", "foro",
    "vara", "tribunal", "orgao_julgador", "data_distribuicao", "fase_processual", "valor_causa"]
_CAMPOS_ACAO = ["area", "numero_processo", "comarca", "vara", "classe", "assunto", "valor_causa"]
_CAMPOS_PREC = ["numero_precatorio", "numero_originario", "tribunal", "vara", "classe",
    "assunto", "valor_caso"]


@router.post("/criar")
def criar_registros(
    payload: CriarPayload,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Cria os registros aprovados pelo admin a partir da prévia da IA."""
    _admin(current_user)
    criados = {}
    client_id = payload.client_id

    # 1) Cliente
    if payload.criar_cliente and payload.cliente:
        dados = _limpa(payload.cliente, _CAMPOS_CLIENTE)
        if not dados.get("name"):
            raise HTTPException(status_code=400, detail="Nome do cliente é obrigatório.")
        if dados.get("celular") and not dados.get("phone"):
            dados["phone"] = dados["celular"]
        cli = models.Client(**dados)
        cli.owner_id = current_user.id
        db.add(cli); db.flush()
        client_id = cli.id
        criados["cliente_id"] = cli.id

    # 2) Processo (exige cliente)
    if payload.criar_processo and payload.processo:
        if not client_id:
            raise HTTPException(status_code=400, detail="Processo exige um cliente vinculado.")
        dados = _limpa(payload.processo, _CAMPOS_PROCESSO)
        dados["client_id"] = client_id
        proc = models.Process(**dados)
        proc.owner_id = current_user.id
        db.add(proc); db.flush()
        criados["processo_id"] = proc.id

    # 3) Ação geral
    if payload.criar_acao and payload.acao:
        dados = _limpa(payload.acao, _CAMPOS_ACAO)
        if client_id:
            dados["client_id"] = client_id
        ac = models.Acao(**dados)
        ac.owner_id = current_user.id
        db.add(ac); db.flush()
        criados["acao_id"] = ac.id

    # 4) Precatório
    if payload.criar_precatorio and payload.precatorio:
        dados = _limpa(payload.precatorio, _CAMPOS_PREC)
        if client_id:
            dados["client_id"] = client_id
        pr = models.Precatorio(**dados)
        pr.owner_id = current_user.id
        db.add(pr); db.flush()
        criados["precatorio_id"] = pr.id

    if not criados:
        raise HTTPException(status_code=400, detail="Nada foi selecionado para criação.")
    db.commit()
    return {"ok": True, "criados": criados, "client_id": client_id}


# ------------------------ Assistente jurídico -----------------------
class PerguntaPayload(BaseModel):
    pergunta: str


def _snapshot(db: Session) -> dict:
    """Monta um retrato compacto do CRM para servir de contexto à IA.

    ⚠️ TUDO O QUE ESTA FUNÇÃO RETORNA É ENVIADO AO GOOGLE (API do Gemini).
    Antes de acrescentar campo aqui, pergunte se ele pode sair do escritório.

    A rota que a consome é admin-only, então NÃO há falha de RBAC: o admin já
    enxerga tudo. A questão relevante é de PROTEÇÃO DE DADOS (LGPD), não de
    controle de acesso — por isso o inventário abaixo, e não um filtro de dono
    que aqui não protegeria ninguém.

    O que SAI hoje:
      - Contagens e totais agregados (clientes por status, honorários somados).
      - Até 150 processos: número CNJ, área, assunto, fase, status, valor.
      - Até 150 precatórios: número, tribunal, assunto, etapa, valor, data do
        último contato.
      - Até 150 ações: área, número, assunto, etapa, valor.
      - Nomes dos ADVOGADOS (funcionários) e quantos leads cada um tem.
      - Até 80 prazos dos próximos 30 dias, com a DESCRIÇÃO em texto livre.

    O que NÃO sai (e deve continuar assim):
      - CPF, RG, telefone, e-mail e endereço de qualquer parte.
      - Nome de cliente/requerente/parte.
      - Conteúdo de documentos ou de publicações do DJEN.

    🔸 Ponto de atenção conhecido: `descricao` do prazo é texto livre digitado
    pelo advogado e frequentemente contém o nome do cliente ("Contestação —
    Fulano de Tal"). É o campo com maior chance de vazar identificação por
    descuido. Removê-lo tornaria o assistente incapaz de responder "quais
    prazos vencem esta semana" — é uma escolha de produto, e está registrada
    aqui para ser feita de forma consciente, não por acidente.
    """
    hoje = date.today()

    clientes = db.query(models.Client).all()
    cli_por_status: Dict[str, int] = {}
    for c in clientes:
        cli_por_status[c.status or "?"] = cli_por_status.get(c.status or "?", 0) + 1

    processos = db.query(models.Process).all()
    proc_por_area: Dict[str, int] = {}
    proc_por_status: Dict[str, int] = {}
    for p in processos:
        proc_por_area[p.type or "?"] = proc_por_area.get(p.type or "?", 0) + 1
        proc_por_status[p.status or "?"] = proc_por_status.get(p.status or "?", 0) + 1

    precatorios = db.query(models.Precatorio).all()
    prec_por_lead: Dict[str, int] = {}
    for pr in precatorios:
        prec_por_lead[pr.status_lead or "?"] = prec_por_lead.get(pr.status_lead or "?", 0) + 1

    acoes = db.query(models.Acao).all()
    acao_por_area: Dict[str, int] = {}
    for a in acoes:
        acao_por_area[a.area or "?"] = acao_por_area.get(a.area or "?", 0) + 1

    honorarios = db.query(models.Honorario).all()
    total_hon = sum((h.total_value or 0) for h in honorarios)
    pago_hon = sum((h.paid_value or 0) for h in honorarios)

    usuarios = db.query(models.User).all()
    nome_user = {u.id: u.name for u in usuarios}
    # Leads (precatórios + ações) por advogado responsável
    leads_por_adv: Dict[str, int] = {}
    for item in list(precatorios) + list(acoes):
        if item.owner_id:
            nome = nome_user.get(item.owner_id, f"#{item.owner_id}")
            leads_por_adv[nome] = leads_por_adv.get(nome, 0) + 1

    deadlines = db.query(models.Deadline).all()
    prazos_proximos = []
    for d in deadlines:
        if d.date and not d.done and hoje <= d.date <= hoje + timedelta(days=30):
            prazos_proximos.append({"data": d.date.isoformat(), "descricao": d.description,
                                    "urgencia": d.urgency_level})

    return {
        "data_de_hoje": hoje.isoformat(),
        "clientes": {"total": len(clientes), "por_status": cli_por_status},
        "processos": {"total": len(processos), "por_area": proc_por_area, "por_status": proc_por_status,
                      "lista": [{"numero": p.case_number, "area": p.type, "assunto": p.assunto,
                                 "fase": p.fase_processual, "status": p.status,
                                 "valor_causa": p.valor_causa} for p in processos[:150]]},
        "precatorios": {"total": len(precatorios), "por_status_lead": prec_por_lead,
                        "lista": [{"numero": pr.numero_precatorio, "tribunal": pr.tribunal,
                                   "assunto": pr.assunto, "status_lead": pr.status_lead,
                                   "valor": pr.valor_caso,
                                   "ultimo_contato": pr.data_ultimo_contato.isoformat() if pr.data_ultimo_contato else None}
                                  for pr in precatorios[:150]]},
        "acoes": {"total": len(acoes), "por_area": acao_por_area,
                  "lista": [{"area": a.area, "numero": a.numero_processo, "assunto": a.assunto,
                             "status_lead": a.status_lead, "valor": a.valor_causa}
                            for a in acoes[:150]]},
        "honorarios": {"total_contratado": total_hon, "total_recebido": pago_hon,
                       "a_receber": total_hon - pago_hon},
        "advogados": {"total": len(usuarios), "leads_por_advogado": leads_por_adv},
        "prazos_proximos_30_dias": prazos_proximos[:80],
    }


@router.post("/assistente")
def assistente(
    payload: PerguntaPayload,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _admin(current_user)
    pergunta = (payload.pergunta or "").strip()
    if not pergunta:
        raise HTTPException(status_code=400, detail="Digite uma pergunta.")
    try:
        contexto = _snapshot(db)
        resposta = ia.assistente(pergunta, contexto)
    except ia.IAError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "resposta": resposta}
