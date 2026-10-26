"""Exportação de listas (clientes, processos, precatórios) em Excel ou PDF."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import models
from ..auth import get_current_user
from ..database import get_db
from ..exportador import to_xlsx, to_pdf_table
from ..scope import PREC_CLASSIFICACOES
# Mesmas consultas que alimentam as TELAS (RBAC + filtros): o arquivo exportado
# precisa bater com o que o usuário está vendo. FUNIL_LABELS são os rótulos das
# 10 etapas do funil — reaproveitados para a planilha não imprimir a chave crua
# ("contrato_assinado") nem divergir da tela com o tempo.
from .precatorios import query_precatorios, FUNIL_LABELS
from .clients import query_clients
from .processes import query_processes

router = APIRouter(prefix="/api/export", tags=["export"])

CLIENT_STATUS = {"lead": "Lead", "negociacao": "Em negociação", "ativo": "Cliente ativo", "arquivado": "Arquivado"}

# Filtros de TEXTO LIVRE: vão pseudonimizados para a trilha (ver `exportar`).
_TERMOS_LIVRES = {"search", "q"}


def _dataset(entidade: str, db: Session, current_user, filtros: Optional[dict] = None):
    f = filtros or {}
    if entidade == "clientes":
        headers = ["Nome", "CPF/CNPJ", "Telefone", "E-mail", "Status"]
        rows = [
            [c.name, c.cpf_cnpj, c.phone, c.email, CLIENT_STATUS.get(c.status, c.status)]
            for c in query_clients(db, current_user, status=f.get("status"),
                                   search=f.get("search"))
                        .order_by(models.Client.name).all()
        ]
        return "Clientes", headers, rows
    if entidade == "processos":
        headers = ["Nº do processo", "Cliente", "Tipo", "Status", "Descrição"]
        rows = [
            [p.case_number, (p.client.name if p.client else ""), p.type, p.status, p.description]
            # Chave a chave, como em Precatórios (ver o comentário lá embaixo).
            for p in query_processes(db, current_user, status=f.get("status"),
                                     sistema=f.get("sistema"), tipo=f.get("tipo"),
                                     q=f.get("q"), responsavel=f.get("responsavel"),
                                     vencido=bool(f.get("vencido")))
                        .order_by(models.Process.created_at.desc()).all()
        ]
        return "Processos", headers, rows
    if entidade == "precatorios":
        # "Classificação" vem do campo REAL (p.classificacao). Antes esta coluna
        # lia `status_precatorio`, um campo legado que ninguém mais escreve: todo
        # precatório saía como "Compra de crédito", mesmo os de habilitação de
        # herdeiros — a planilha afirmava a classificação errada.
        headers = ["Requerente", "CPF", "Nº Processo TRF", "Nº originário", "Tribunal",
                   "Classificação", "Banco", "Assunto", "Valor (R$)", "% Honor.", "Advogado", "Etapa do funil"]
        rows = [
            [p.requerente_nome, p.requerente_cpf, p.processo_id, p.numero_originario,
             (p.tribunal or "").upper(),
             PREC_CLASSIFICACOES.get(p.classificacao, p.classificacao or ""),
             p.banco, (p.assunto or p.tema), p.valor_caso, p.percentual_honorarios,
             p.advogado, FUNIL_LABELS.get(p.status_lead, p.status_lead or "")]
            # Chaves passadas UMA A UMA de propósito: o dict de filtros atende as
            # três entidades, e um **filtros cego estouraria TypeError ao receber
            # chave de outra tela (ex.: "sistema", de Processos).
            for p in query_precatorios(
                        db, current_user,
                        tribunal=f.get("tribunal"), classificacao=f.get("classificacao"),
                        status_precatorio=f.get("status_precatorio"),
                        status_lead=f.get("status_lead"),
                        responsavel=f.get("responsavel"), search=f.get("search"))
                        .order_by(models.Precatorio.id.desc()).all()
        ]
        return "Precatorios", headers, rows
    raise HTTPException(status_code=404, detail="Entidade não suportada")


@router.get("/{entidade}")
def exportar(
    entidade: str,
    formato: str = "xlsx",
    # Filtros das telas — o arquivo sai igual ao que está na lista.
    # Precatórios: tribunal/classificacao/status_lead/responsavel/search.
    # Clientes: status/search.
    # Processos: status/sistema/tipo/q/responsavel/vencido — os mesmos da lista
    # nova (query_processes); sem eles a planilha ignorava a busca, o
    # responsável e o "só com prazo vencido" que a tela estava mostrando.
    tribunal: Optional[str] = None,
    classificacao: Optional[str] = None,
    status_precatorio: Optional[str] = None,
    status_lead: Optional[str] = None,
    responsavel: Optional[str] = None,
    search: Optional[str] = None,
    status: Optional[str] = None,
    sistema: Optional[str] = None,
    tipo: Optional[str] = None,
    q: Optional[str] = None,
    vencido: bool = False,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    # Exportação de listas é restrita ao administrador (evita extração em massa)
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Apenas administradores podem exportar listas.")
    filtros = {
        "tribunal": tribunal, "classificacao": classificacao,
        "status_precatorio": status_precatorio, "status_lead": status_lead,
        "responsavel": responsavel, "search": search,
        "status": status, "sistema": sistema, "tipo": tipo,
        "q": q, "vencido": 1 if vencido else None,
    }
    # Monta o dataset ANTES de auditar: entidade inexistente ou filtro inválido
    # levantam exceção aqui, e a trilha não fica com um "EXPORT 200" de algo que
    # nunca saiu do sistema.
    titulo, headers, rows = _dataset(entidade, db, current_user, filtros)
    from ..seguranca import pseudonimo, registrar_acesso
    # Registra TAMBÉM os filtros e o volume: sem isso a trilha não diz o que de
    # fato foi extraído.
    # ⚠️ `search` é texto livre e a busca de Precatórios/Ações o compara contra
    # COLUNA DE CPF — gravá-lo cru fazia o CPF do cliente virar registro
    # permanente na auditoria. Vai pseudonimizado: o mesmo termo dá sempre o
    # mesmo rótulo (dá para ver que a pessoa foi exportada 5 vezes), mas o
    # valor não volta. Ver seguranca.pseudonimo.
    # `q` (busca de Processos) entra na mesma regra: o termo é nome de cliente,
    # nome da parte contrária ou número do processo digitado — dado pessoal que
    # não pode ficar 24 meses cru na trilha.
    usados = "&".join(
        f"{k}={pseudonimo(v) if k in _TERMOS_LIVRES else v}"
        for k, v in filtros.items() if v
    )
    registrar_acesso(
        db, current_user, "EXPORT",
        f"/api/export/{entidade}?formato={formato}"
        + (f"&{usados}" if usados else "")
        + f" [{len(rows)} registro(s)]",
    )
    if formato == "pdf":
        buf = to_pdf_table(headers, rows, titulo)
        media = "application/pdf"
        fname = f"{entidade}.pdf"
    else:
        buf = to_xlsx(headers, rows, titulo)
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        fname = f"{entidade}.xlsx"
    return StreamingResponse(
        buf, media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
