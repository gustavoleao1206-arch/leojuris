"""Rotas do módulo de Precatórios Federais — página de gestão de caso."""
import io
import re
import unicodedata
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import false, or_
from sqlalchemy.orm import Session

from .. import ia, models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..scope import (
    scope,
    ensure_owner,
    is_admin,
    classificacao_permitida,
    condicao_busca_documento,
    ensure_classificacao,
    filtrar_classificacao,
    require_edit,
    require_excluir,
    require_view,
    validar_cliente_do_corpo,
    ve_tudo,
    PREC_CLASSIFICACOES,
    FUNIL_LABELS,
)
from ..seguranca import alvo_do_log

router = APIRouter(prefix="/api/precatorios", tags=["precatorios"])

# Rótulos das classificações (a chave "sem_alvara" passou a se chamar "Compra de crédito")
CLASSIF_LABELS = {
    "habilitacao_herdeiros": "Habilitação de herdeiros",
    "cancelado": "Cancelado",
    "reexpedicao": "Reexpedição",
    "com_alvara": "Com alvará",
    "sem_alvara": "Compra de crédito",
}


def _scope_prec(query, user):
    """Advogado vê os próprios casos + os SEM dono (fila). Admin vê todos.

    Some-se a isso a permissão de classificação: se o admin restringiu o
    usuário a certas classificações (ex.: só "Com alvará"), as demais somem
    da consulta — inclusive as da fila.
    """
    if is_admin(user):
        return query
    # O estagiário assiste o escritório inteiro: pula a trava de dono, mas
    # continua limitado às classificações que o admin liberou para ele.
    if not ve_tudo(user):
        query = query.filter(
            or_(models.Precatorio.owner_id == user.id, models.Precatorio.owner_id.is_(None))
        )
    return filtrar_classificacao(query, models.Precatorio, user)


def _ensure_acesso(p, user):
    """Acesso liberado ao admin, ao dono, ou a leads sem dono (fila).

    Além do dono, valida a permissão de classificação — impede que alguém
    restrito alcance um caso proibido chamando a rota direto pelo ID.
    """
    if is_admin(user):
        return
    if not ve_tudo(user) and p.owner_id is not None and p.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Sem acesso a este precatório")
    ensure_classificacao(p, user)


_SENSIVEIS = ["requerente_cpf", "requerente_rg", "requerente_telefone",
              "requerente_email", "requerente_endereco"]


def _mascara_ativa(p, user) -> bool:
    """A máscara anti-vazamento vale para lead da FILA (sem dono) visto por quem
    NÃO enxerga o escritório todo. Admin e estagiário (ve_tudo) veem tudo; o
    advogado continua sem os dados pessoais das partes que não são dele."""
    return not ve_tudo(user) and p.owner_id is None


def _mascarar(p, user):
    out = schemas.PrecatorioOut.model_validate(p)
    if _mascara_ativa(p, user):
        for campo in _SENSIVEIS:
            setattr(out, campo, None)
    return out


def _filtrar_responsavel(query, responsavel: str, user):
    """Filtro por responsável: "meus", "fila", "atribuidos" ou o ID de um usuário.

    Categorias (`meus`/`fila`/`atribuidos`) valem para qualquer perfil, dentro do
    que ele já enxerga. Filtrar por um advogado ESPECÍFICO (ID) é exclusivo do
    admin — quem não for admin e pedir um ID que não é o seu recebe consulta
    VAZIA, em vez de alcançar os casos do colega.

    ⚠️ Para o ADVOGADO isso é barreira de verdade: o `_scope_prec` já o impede de
    ler caso de outro dono. Para o ESTAGIÁRIO é apenas CONVENIÊNCIA DE TELA: ele
    legitimamente lê todos os casos, e a resposta ainda traz `owner_id` — cruzando
    com `/api/auth/colegas` (aberto a qualquer autenticado) dá para remontar quem
    atende quem. Se um dia isso precisar ser confidencial de fato, não basta esta
    trava: seria preciso (1) fechar `/api/auth/colegas` por permissão — cuidado,
    o advogado usa a rota no rateio de honorários —, (2) trocar `owner_id` por um
    derivado ("meu"/"atribuido"/"fila") na resposta e (3) mascarar o campo de
    texto livre `advogado`.
    """
    valor = (responsavel or "").strip()
    if not valor:
        return query
    if valor == "meus":
        return query.filter(models.Precatorio.owner_id == user.id)
    if valor == "fila":
        return query.filter(models.Precatorio.owner_id.is_(None))
    if valor == "atribuidos":
        return query.filter(models.Precatorio.owner_id.isnot(None))
    try:
        uid = int(valor)
    except ValueError:
        raise HTTPException(status_code=400, detail="Filtro de responsável inválido.")
    if not is_admin(user) and uid != user.id:
        return query.filter(false())
    return query.filter(models.Precatorio.owner_id == uid)


def aplicar_filtros_precatorio(
    query,
    user,
    *,
    tribunal: Optional[str] = None,
    classificacao: Optional[str] = None,
    status_precatorio: Optional[str] = None,
    status_lead: Optional[str] = None,
    responsavel: Optional[str] = None,
    search: Optional[str] = None,
):
    """Filtros da lista de precatórios.

    Compartilhado pela TELA e pelo EXPORT — é o que garante que a planilha saia
    exatamente com o que o usuário está vendo. Filtro novo entra aqui, e os dois
    lados ganham juntos.
    """
    if responsavel:
        query = _filtrar_responsavel(query, responsavel, user)
    if tribunal:
        query = query.filter(models.Precatorio.tribunal == tribunal)
    if classificacao:
        query = query.filter(models.Precatorio.classificacao == classificacao)
    if status_precatorio:
        query = query.filter(models.Precatorio.status_precatorio == status_precatorio)
    if status_lead:
        query = query.filter(models.Precatorio.status_lead == status_lead)
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                models.Precatorio.requerente_nome.ilike(like),
                # CPF por `condicao_busca_documento`, nunca ILIKE direto: no
                # lead da fila o CPF é mascarado e a busca parcial o
                # reconstruía (ver a docstring lá no scope.py).
                condicao_busca_documento(
                    models.Precatorio.requerente_cpf, models.Precatorio.owner_id,
                    search, user,
                ),
            )
        )
    return query


def query_precatorios(db: Session, user, **filtros):
    """Consulta de precatórios com o RBAC (escopo por dono/classificação) + filtros.

    Ponto único de entrada para quem precisa da MESMA lista que a tela mostra —
    hoje a listagem e o export.
    """
    return aplicar_filtros_precatorio(
        _scope_prec(db.query(models.Precatorio), user), user, **filtros
    )


@router.get("", response_model=List[schemas.PrecatorioOut])
def list_precatorios(
    tribunal: Optional[str] = None,
    classificacao: Optional[str] = None,
    status_precatorio: Optional[str] = None,
    status_lead: Optional[str] = None,
    responsavel: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lista precatórios com filtros e busca por nome/CPF.

    O usuário só recebe as classificações que o admin liberou para ele
    (quando nada foi restrito, recebe todas) — sempre respeitada a
    segregação por dono/fila.
    """
    require_view(current_user, "precatorios")
    query = query_precatorios(
        db, current_user,
        tribunal=tribunal, classificacao=classificacao,
        status_precatorio=status_precatorio, status_lead=status_lead,
        responsavel=responsavel, search=search,
    )
    return [_mascarar(p, current_user) for p in query.order_by(models.Precatorio.id.desc()).all()]


@router.post("", response_model=schemas.PrecatorioOut)
def create_precatorio(
    payload: schemas.PrecatorioCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "precatorios")
    data = payload.model_dump()
    owner = data.pop("owner_id", None)
    # Impede criar um caso numa classificação à qual o usuário não tem acesso.
    if not classificacao_permitida(current_user, data.get("classificacao")):
        raise HTTPException(
            status_code=403, detail="Sem permissão para esta classificação de precatório"
        )
    validar_cliente_do_corpo(db, data.get("client_id"), None, current_user)
    p = models.Precatorio(**data)
    # Novos leads entram na FILA (sem dono); só o admin pode já atribuir um responsável.
    p.owner_id = owner if (is_admin(current_user) and owner) else None
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


# ----------------------- Importação de Excel -----------------------
def _norm(s) -> str:
    """Normaliza um texto: minúsculas, sem acentos, sem espaços extras."""
    if s is None:
        return ""
    s = str(s).strip().lower()
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if unicodedata.category(c) != "Mn")
    return s


# Cabeçalho da planilha (normalizado) -> campo do modelo.
# Os aliases exatos das colunas do escritório vêm primeiro (match exato tem prioridade).
_COLMAP = {
    "requerente_nome": ["reqte", "requerente", "nome", "nome do requerente", "cliente",
                        "nome completo", "beneficiario", "credor", "parte", "exequente"],
    "requerente_cpf": ["cpf", "cpf/cnpj", "cpf cnpj", "documento", "doc"],
    "requerente_rg": ["rg", "identidade"],
    "requerente_nascimento": ["nascimento", "data de nascimento", "data nascimento",
                              "dt nascimento", "dn"],
    "requerente_telefone": ["telefone", "fone", "celular", "contato", "tel", "whatsapp"],
    # "endereco eletronico" é e-mail — sem este alias ele caía na parte de
    # endereço (e o e-mail acabava junto com a rua).
    "requerente_email": ["email", "e-mail", "endereco eletronico"],
    # Endereço NÃO mora aqui: vem de _ENDERECO_PARTES, logo abaixo.
    # "Processo" = processo principal (TRF). "Processo de execução" = originário.
    "numero_originario": ["processo de execucao", "execucao", "numero originario",
                          "numero de origem", "processo originario", "origem", "n originario"],
    "processo_id": ["processo", "numero do processo", "numero processo", "n processo",
                    "processo trf", "numero do processo trf", "autos", "numero cnj", "cnj"],
    "numero_precatorio": ["numero do requisitorio", "requisitorio", "numero requisitorio",
                          "precatorio", "numero do precatorio", "numero precatorio"],
    "tribunal": ["tribunal", "trf", "corte"],
    "vara": ["vara", "juizo"],
    "classe": ["classe", "classe processual"],
    "assunto": ["assunto", "assunto do caso"],
    "tema": ["tema"],
    "banco": ["banco do deposito", "banco do deposito", "banco", "deposito"],
    "classificacao": ["com ou sem", "com/sem", "com ou sem alvara", "alvara", "situacao"],
    "observacoes": ["observacao", "observacoes", "obs", "anotacoes", "anotacao"],
    "valor_caso": ["valor", "valor do caso", "valor da causa", "valor do precatorio",
                   "valor liquido", "valor bruto", "montante", "valor requisitado"],
    "percentual_honorarios": ["honorarios", "percentual de honorarios", "pct honorarios",
                              "honorario"],
}

# --------------------------------------------------------------------------
# Endereço em colunas separadas
# --------------------------------------------------------------------------
# 🚨 Endereço é MASCARADO para o advogado nos leads da fila — mas só quando
# mora em `requerente_endereco` (_SENSIVEIS). Até set/2026 só "Endereço" e
# "Logradouro" chegavam lá: Rua, Bairro, Cidade, UF, CEP e Complemento não
# casavam com alias nenhum e caíam em `observacoes` ("Bairro: X | CEP: Y"),
# que NÃO é mascarado — e todo lead importado entra justamente na FILA. Pior:
# o casamento por aproximação mandava "Número" para o processo originário e
# "CEP do requerente" para o NOME, sobrescrevendo-o.
#
# Agora toda parte de endereço compõe `requerente_endereco`, nesta ordem.
_ENDERECO_PARTES = {
    "logradouro": ["logradouro", "rua", "avenida", "endereco", "endereco completo",
                   "endereco residencial"],
    "numero": [],      # só por posição — ver _NUMERO_DA_CASA
    "complemento": ["complemento", "compl", "apto", "apartamento"],
    "bairro": ["bairro"],
    "cidade": ["cidade", "municipio", "cidade/uf", "municipio/uf", "cidade - uf"],
    "uf": ["uf", "estado"],
    "cep": ["cep"],
}
# Palavra que, em QUALQUER posição do cabeçalho, identifica a parte ("CEP do
# requerente", "Bairro de residência"). Das mais específicas para as mais
# gerais: "Endereço - CEP" é o CEP. "estado" e "número" ficam de fora de
# propósito — "Estado civil" e "Número do processo" não são endereço.
_ENDERECO_PALAVRAS = {
    "cep": "cep", "bairro": "bairro", "complemento": "complemento",
    "cidade": "cidade", "municipio": "cidade", "uf": "uf",
    "logradouro": "logradouro", "rua": "logradouro", "avenida": "logradouro",
    "endereco": "logradouro",
}
# ...a não ser que o cabeçalho fale de outro campo ("Endereço de e-mail").
_ENDERECO_VETO = {"mail", "email", "eletronico", "civil", "telefone", "fone", "celular"}
# 🚨 Mesma armadilha, nos outros campos PESSOAIS: a aproximação percorre
# primeiro os aliases do NOME ("requerente", "cliente", "credor", "parte"...),
# então "CPF do requerente", "Telefone do cliente" ou "E-mail do credor" iam
# para `requerente_nome` — que NÃO é mascarado — e ainda apagavam o nome. A
# palavra do campo pessoal, em qualquer posição do cabeçalho, vence.
# "contato" segue o _COLMAP, que já o trata como telefone.
_PALAVRAS_PESSOAIS = {
    "cpf": "requerente_cpf", "cnpj": "requerente_cpf",
    "rg": "requerente_rg", "identidade": "requerente_rg",
    "telefone": "requerente_telefone", "fone": "requerente_telefone",
    "celular": "requerente_telefone", "whatsapp": "requerente_telefone",
    "contato": "requerente_telefone",
    "email": "requerente_email", "mail": "requerente_email",
    "nascimento": "requerente_nascimento",
}
# "Número"/"Nº" só é o número da casa LOGO DEPOIS da coluna do logradouro
# ("Rua | Nº"). Em outra posição costuma ser contador de linha ou nº de
# processo, e segue o caminho de sempre.
_NUMERO_DA_CASA = {"numero", "num", "nro", "no", "n", "nº", "n°",
                   "numero da casa", "numero residencial"}


def _resolver_cabecalhos(headers) -> dict:
    """Coluna -> (campo do modelo, cabeçalho original, parte do endereço ou None).

    Ordem de precedência: alias exato do _COLMAP → alias exato de parte de
    endereço → palavra de campo pessoal no cabeçalho → palavra de endereço no
    cabeçalho → "Nº" colado na rua → aproximação do _COLMAP. Tudo que é dado
    pessoal vem ANTES da aproximação, porque é ela que transformava "CPF do
    requerente" e "CEP do requerente" em NOME.
    """
    rev = {}
    for campo, aliases in _COLMAP.items():
        for a in aliases:
            rev[_norm(a)] = campo
    rev_endereco = {_norm(a): parte for parte, aliases in _ENDERECO_PARTES.items() for a in aliases}

    col_field = {}
    parte_anterior = None
    for ci, h in enumerate(headers):
        nh = _norm(h)
        if not nh:
            parte_anterior = None
            continue
        palavras = set(re.findall(r"[a-z0-9]+", nh))
        campo, parte = rev.get(nh), None
        if not campo:
            parte = rev_endereco.get(nh)
        if not campo and not parte:
            campo = next((c for w, c in _PALAVRAS_PESSOAIS.items() if w in palavras), None)
        if not campo and not parte and not palavras & _ENDERECO_VETO:
            parte = next((p for w, p in _ENDERECO_PALAVRAS.items() if w in palavras), None)
        if not campo and not parte and nh in _NUMERO_DA_CASA and parte_anterior == "logradouro":
            parte = "numero"
        if parte:
            campo = "requerente_endereco"
        if not campo:
            for a, fld in rev.items():
                if a and (a in nh or nh in a):
                    campo = fld
                    break
        col_field[ci] = (campo, h, parte)
        parte_anterior = parte
    return col_field


def _parse_cep(v) -> str:
    """CEP como 00000-000. O Excel grava CEP numérico sem o zero à esquerda
    (01310-100 vira 1310100) — só nesse caso os zeros voltam."""
    txt = _cell_to_str(v)
    digitos = "".join(c for c in txt if c in "0123456789")
    if isinstance(v, (int, float)) and 0 < len(digitos) < 8:
        digitos = digitos.zfill(8)
    return f"{digitos[:5]}-{digitos[5:]}" if len(digitos) == 8 else txt


def _compor_endereco(partes: dict) -> Optional[str]:
    """"Rua X, 123, Apto 2, Centro, Maceió/AL, CEP 57000-000" — só o que veio."""
    p = {k: ", ".join(v) for k, v in partes.items() if v}
    cidade, uf = p.get("cidade"), p.get("uf")
    local = f"{cidade}/{uf}" if cidade and uf else (cidade or uf)
    blocos = [p.get("logradouro"), p.get("numero"), p.get("complemento"),
              p.get("bairro"), local, f"CEP {p['cep']}" if p.get("cep") else None]
    return ", ".join(b for b in blocos if b) or None


# Limites (em caracteres) por campo, para nunca estourar a coluna do banco
_LIMITS = {
    "requerente_nome": 160, "requerente_cpf": 20, "requerente_rg": 30,
    "requerente_telefone": 40, "requerente_email": 120, "processo_id": 60,
    "numero_originario": 60, "numero_precatorio": 60, "tribunal": 10,
    "vara": 120, "classe": 120, "assunto": 200, "tema": 200, "banco": 20,
}
_FLOAT_FIELDS = {"valor_caso", "percentual_honorarios"}
_DATE_FIELDS = {"requerente_nascimento"}


# --------------------------------------------------------------------------
# Detecção de duplicidade (usada na importação e na auditoria)
# --------------------------------------------------------------------------
def _so_digitos(v) -> str:
    return "".join(ch for ch in str(v or "") if ch.isdigit())


def _campo(origem, nome):
    """Lê um campo tanto de um dict (linha da planilha) quanto do modelo."""
    if isinstance(origem, dict):
        return origem.get(nome)
    return getattr(origem, nome, None)


# Campos que IDENTIFICAM um precatório específico.
# ⚠️ `numero_originario` (processo originário / de execução) está FORA de
# propósito: numa ação coletiva dezenas de autores dividem o MESMO originário,
# então usá-lo como chave transformava cada ação coletiva num falso grupo de
# duplicados. O que individualiza é o requisitório e o processo no TRF.
_CAMPOS_NUMERO = ("numero_precatorio", "processo_id")


def _chaves_numero(origem) -> set:
    """Números que identificam o precatório, normalizados só com os dígitos.

    Comparar por dígitos faz "0801234-56.2026.4.05.8000" bater com
    "08012345620264058000": a mesma planilha costuma vir com formatações
    diferentes. Exige 6+ dígitos para não casar lixo tipo "1" ou "12".
    """
    chaves = set()
    for nome in _CAMPOS_NUMERO:
        d = _so_digitos(_campo(origem, nome))
        if len(d) >= 6:
            chaves.add(d)
    return chaves


def _chave_nome(origem) -> str:
    """Nome do requerente normalizado — a 3ª referência de duplicidade.

    Vale como sinal porque cada autor tem o SEU requisitório: o mesmo nome
    aparecendo duas vezes normalmente é a mesma linha importada de novo.
    Homônimo existe, então quem for barrado por aqui sai listado no relatório
    da importação, para o admin conferir e cadastrar à mão se for outra pessoa.
    """
    return _norm(_campo(origem, "requerente_nome"))


def _cell_to_str(v) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _to_float(v):
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("R$", "").replace(" ", "").strip()
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except Exception:
        return None


def _to_date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except Exception:
            pass
    return None


def _parse_banco(v):
    """'Caixa' -> caixa ; 'Banco do Brasil' -> bb."""
    n = _norm(v)
    if "caixa" in n or n == "cef":
        return "caixa"
    if "brasil" in n or n in ("bb", "b.b"):
        return "bb"
    return _cell_to_str(v)[:20]


def _parse_classif(v):
    """Coluna 'Com ou Sem' -> com_alvara | sem_alvara (decisão do escritório)."""
    n = _norm(v)
    if not n:
        return None
    if n.startswith("sem") or n == "s":
        return "sem_alvara"
    if n.startswith("com") or n == "c":
        return "com_alvara"
    if "habilita" in n:
        return "habilitacao_herdeiros"
    return None


@router.post("/importar")
def importar_excel(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Importa precatórios de uma planilha .xlsx (apenas administrador).

    Os registros entram na FILA (sem dono) e SEM classificação — o admin define
    depois (com alvará / sem alvará / habilitação). Ao final, a IA do CRM gera
    uma análise da importação (se a chave da IA estiver configurada).
    """
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode importar.")
    nome = (file.filename or "").lower()
    if not nome.endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Envie um arquivo Excel (.xlsx).")

    try:
        import openpyxl
    except Exception:
        raise HTTPException(status_code=500, detail="Leitor de Excel indisponível no servidor.")

    conteudo = file.file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(conteudo), data_only=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Não consegui ler o Excel. Verifique o arquivo.")

    ws = wb.active
    linhas = list(ws.iter_rows(values_only=True))
    if not linhas:
        raise HTTPException(status_code=400, detail="A planilha está vazia.")

    # Acha a linha de cabeçalho (primeira com 2+ células preenchidas)
    header_idx = 0
    for i, r in enumerate(linhas[:15]):
        if len([c for c in r if c not in (None, "")]) >= 2:
            header_idx = i
            break
    headers = linhas[header_idx]

    # Resolve cada coluna -> campo (e, se for endereço, qual parte dele)
    col_field = _resolver_cabecalhos(headers)

    # Índice do que JÁ existe no CRM, para não recriar. A mesma planilha costuma
    # ser reenviada com linhas de importações anteriores.
    existentes_num, existentes_nome = set(), set()
    for reg in db.query(
        models.Precatorio.numero_precatorio, models.Precatorio.processo_id,
        models.Precatorio.requerente_nome,
    ).all():
        d = {"numero_precatorio": reg[0], "processo_id": reg[1], "requerente_nome": reg[2]}
        existentes_num |= _chaves_numero(d)
        k = _chave_nome(d)
        if k:
            existentes_nome.add(k)

    criados = 0
    ignorados = []   # duplicados que NÃO foram importados
    # 🚨 LGPD: o resumo da IA usa só AGREGADOS — contagens e somas, nunca o
    # registro da pessoa. Antes, um laço mandava nome completo + CPF de até 200
    # titulares ao Gemini (Google, EUA) a cada importação, sem opt-in nem aviso
    # (achado crítico, ago/2026). Titular de precatório não é nem cliente do
    # escritório. Agregar aqui elimina o vazamento na origem.
    resumo = {
        "por_banco": {}, "por_classificacao": {},
        "soma_valores": 0.0, "menor_valor": None, "maior_valor": None,
        "sem_cpf": 0, "sem_processo": 0,
    }

    def _contar(dados):
        b = dados.get("banco") or "não informado"
        resumo["por_banco"][b] = resumo["por_banco"].get(b, 0) + 1
        c = dados.get("classificacao") or "sem classificação"
        resumo["por_classificacao"][c] = resumo["por_classificacao"].get(c, 0) + 1
        v = dados.get("valor_caso")
        if v is not None:
            resumo["soma_valores"] += v
            resumo["menor_valor"] = v if resumo["menor_valor"] is None else min(resumo["menor_valor"], v)
            resumo["maior_valor"] = v if resumo["maior_valor"] is None else max(resumo["maior_valor"], v)
        if not dados.get("requerente_cpf"):
            resumo["sem_cpf"] += 1
        if not (dados.get("processo_id") or dados.get("numero_originario") or dados.get("numero_precatorio")):
            resumo["sem_processo"] += 1
    for r in linhas[header_idx + 1:]:
        if all(c in (None, "") for c in r):
            continue
        dados = {}
        extras = []
        endereco = {}
        for ci, val in enumerate(r):
            if val in (None, ""):
                continue
            campo, orig, parte = col_field.get(ci, (None, None, None))
            if parte:
                txt = _parse_cep(val) if parte == "cep" else _cell_to_str(val)
                if txt:
                    endereco.setdefault(parte, []).append(txt)
            elif campo == "valor_caso":
                # A planilha traz o valor em milhares (ex.: 141 = R$ 141.000,00)
                v = _to_float(val)
                dados[campo] = v * 1000 if v is not None else None
            elif campo in _FLOAT_FIELDS:
                dados[campo] = _to_float(val)
            elif campo in _DATE_FIELDS:
                dados[campo] = _to_date(val)
            elif campo == "banco":
                dados[campo] = _parse_banco(val)
            elif campo == "classificacao":
                c = _parse_classif(val)
                if c:
                    dados[campo] = c
            elif campo:
                txt = _cell_to_str(val)
                lim = _LIMITS.get(campo)
                dados[campo] = txt[:lim] if lim else txt
            elif orig:
                extras.append(f"{orig}: {_cell_to_str(val)}")
        if endereco:
            dados["requerente_endereco"] = _compor_endereco(endereco)

        # precisa de ao menos uma identificação para criar
        ident = ("requerente_nome", "requerente_cpf", "numero_precatorio",
                 "processo_id", "numero_originario")
        if not any(dados.get(k) for k in ident):
            continue

        # ---- Duplicidade ----------------------------------------------------
        # Três referências, a pedido do escritório: nº do requisitório, nº do
        # processo no TRF e NOME do requerente. O processo originário/execução
        # NÃO entra: numa ação coletiva vários autores compartilham o mesmo.
        nums = _chaves_numero(dados)
        nome_k = _chave_nome(dados)
        rotulo = dados.get("requerente_nome") or dados.get("requerente_cpf") or "(sem nome)"
        numero_visivel = dados.get("numero_precatorio") or dados.get("processo_id") or ""
        if nums & existentes_num:
            ignorados.append({"requerente": rotulo, "numero": numero_visivel,
                              "motivo": "nº do requisitório/processo TRF já cadastrado"})
            continue
        if nome_k and nome_k in existentes_nome:
            ignorados.append({"requerente": rotulo, "numero": numero_visivel,
                              "motivo": "requerente com esse nome já cadastrado"})
            continue
        # Passa a valer para as próximas linhas: pega repetição DENTRO do arquivo.
        existentes_num |= nums
        if nome_k:
            existentes_nome.add(nome_k)
        # ---------------------------------------------------------------------

        if extras:
            base = dados.get("observacoes", "")
            dados["observacoes"] = (base + " | " if base else "") + " | ".join(extras)

        p = models.Precatorio(**dados)
        p.owner_id = None            # entra na fila (triagem); só o admin enxerga
        db.add(p)
        criados += 1
        _contar(dados)

    # Planilha inteira já cadastrada NÃO é erro — é o resultado esperado de um
    # reenvio. Só é erro quando não veio linha aproveitável nenhuma.
    if criados == 0 and not ignorados:
        raise HTTPException(
            status_code=400,
            detail="Nenhuma linha válida encontrada. Confira se a planilha tem cabeçalhos (nome, CPF, processo, etc.).",
        )
    db.commit()

    # Análise automática pela IA do CRM (opcional — só se configurada)
    analise = None
    if ia.ia_configurada():
        try:
            pergunta = (
                "Analise este RESUMO AGREGADO de uma importação de precatórios para triagem. "
                "Faça um texto objetivo em português com: total de registros criados; "
                "distribuição por banco (Caixa/BB); contagem por classificação (Com alvará / "
                "Compra de crédito / sem classificação); soma e faixa de valores; e quantos "
                "estão sem CPF ou sem número de processo. Os duplicados já foram filtrados na "
                "importação — o número de ignorados vem no campo 'duplicados_ignorados'. "
                "Não invente classificação para quem está sem ela; relate apenas o que existe. "
                "O resumo NÃO contém nome nem CPF de ninguém, de propósito (LGPD) — não peça "
                "nem invente esses dados."
            )
            contexto = {
                "total_importado": criados,
                "duplicados_ignorados": len(ignorados),
                "resumo": resumo,
            }
            # Trava LGPD: garante que só agregado sai daqui para a IA (Google).
            ia.conferir_sem_pii(contexto)
            analise = ia.assistente(pergunta, contexto)
        except Exception:
            analise = None

    return {
        "ok": True,
        "criados": criados,
        "ignorados": len(ignorados),
        "detalhe_ignorados": ignorados[:200],
        "analise": analise,
    }


@router.get("/duplicados")
def listar_duplicados(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Auditoria: agrupa precatórios que parecem repetidos, para o admin revisar.

    NÃO apaga nada — só mostra. Dois níveis, porque a confiança é diferente:
      • por_numero .: mesmo nº de precatório/processo/originário. É duplicidade
                      de verdade — o mesmo requisitório cadastrado 2x.
      • por_pessoa .: mesmo nome+CPF com números diferentes. PODE ser legítimo
                      (a pessoa tem mais de um precatório), então é só um alerta.
    Fica ANTES da rota /{precatorio_id} de propósito: o FastAPI resolve na ordem
    de registro e tentaria ler "duplicados" como um ID.
    """
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode auditar duplicidades.")

    regs = db.query(models.Precatorio).order_by(models.Precatorio.id).all()

    def resumo(p):
        return {
            "id": p.id, "requerente": p.requerente_nome, "cpf": p.requerente_cpf,
            "numero_precatorio": p.numero_precatorio, "processo_id": p.processo_id,
            "numero_originario": p.numero_originario, "tribunal": p.tribunal,
            "classificacao": p.classificacao, "status_lead": p.status_lead,
            "valor_caso": p.valor_caso, "owner_id": p.owner_id,
            "criado_em": p.created_at.isoformat() if getattr(p, "created_at", None) else None,
        }

    por_numero, ja_agrupados = [], set()
    mapa = {}
    for p in regs:
        for k in _chaves_numero(p):
            mapa.setdefault(k, []).append(p)
    for chave, itens in mapa.items():
        # dedup por id: um registro com 2 números iguais entraria 2x
        unicos = {p.id: p for p in itens}
        if len(unicos) < 2:
            continue
        por_numero.append({"chave": chave, "registros": [resumo(p) for p in unicos.values()]})
        ja_agrupados |= set(unicos)

    por_nome = []
    mapa_n = {}
    for p in regs:
        k = _chave_nome(p)
        if k:
            mapa_n.setdefault(k, []).append(p)
    for _chave, itens in mapa_n.items():
        if len(itens) < 2:
            continue
        # se o grupo já saiu pelo número, não repete
        if all(p.id in ja_agrupados for p in itens):
            continue
        nome = (itens[0].requerente_nome or "").strip() or "(sem nome)"
        por_nome.append({"chave": nome, "registros": [resumo(p) for p in itens]})

    # Quantos registros sobrariam se cada grupo ficasse com 1 só
    exc_num = sum(len(g["registros"]) - 1 for g in por_numero)
    exc_nome = sum(len(g["registros"]) - 1 for g in por_nome)
    return {
        "total_precatorios": len(regs),
        "por_numero": sorted(por_numero, key=lambda g: -len(g["registros"])),
        "por_nome": sorted(por_nome, key=lambda g: -len(g["registros"])),
        "excedentes_por_numero": exc_num,
        "excedentes_por_nome": exc_nome,
    }


@router.get("/parados")
def listar_parados(
    dias: int = 20,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Casos COM responsável que não recebem uma ação há N dias.

    Serve para o admin decidir se devolve o caso à fila e dá a chance a outro
    advogado. Fica ANTES de /{precatorio_id}: o FastAPI resolve na ordem de
    registro e leria "parados" como ID.

    ⚠️ O que conta como movimentação, e por quê:

    `Precatorio` não tem coluna `updated_at`. Criar uma agora não resolveria
    este relatório — todo registro existente nasceria marcado como "tocado
    hoje" e a tela só serviria daqui a N dias. A data real vem da TRILHA DE
    AUDITORIA, que já guarda esse histórico e responde de forma retroativa.

    Consideramos movimentação apenas EDIÇÃO (POST/PUT/DELETE em
    /api/precatorios/<id>..., o que inclui mover no funil, assumir e registrar
    contato). Abrir o caso NÃO conta: o objetivo é encontrar quem está sentado
    em cima do lead sem trabalhar nele, e só visualizar não é trabalho.
    Mesmo assim devolvemos `ultima_visualizacao` junto, porque um caso visto
    ontem e nunca editado é uma conversa diferente de um caso esquecido há
    meses — e quem decide isso é o admin, não o relatório.

    Quando não há NENHUM registro na trilha, cai para `created_at`: um caso
    cadastrado há 60 dias e nunca tocado é exatamente o que se procura aqui.
    """
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode auditar casos parados.")

    dias = max(1, min(int(dias or 20), 365))
    corte = datetime.utcnow() - timedelta(days=dias)

    # Só faz sentido para casos COM dono — os da fila já estão disponíveis.
    casos = (
        db.query(models.Precatorio)
        .filter(models.Precatorio.owner_id.isnot(None))
        .all()
    )
    if not casos:
        return {"dias": dias, "total": 0, "casos": []}

    ids = {c.id for c in casos}

    # Última EDIÇÃO e última VISUALIZAÇÃO por caso, lidas da trilha.
    # Uma query só, do mais recente para o mais antigo: a primeira ocorrência
    # de cada ID já é a mais recente, então paramos de olhar aquele ID.
    ultima_edicao, ultima_view = {}, {}
    logs = (
        db.query(models.AuditLog)
        .filter(models.AuditLog.path.like("%precat%"))
        .order_by(models.AuditLog.created_at.desc())
        .limit(50000)
        .all()
    )
    for l in logs:
        alvo = alvo_do_log(l.path)
        if not alvo or alvo[0] != "precatorios" or alvo[1] not in ids:
            continue
        pid = alvo[1]
        if l.method in ("POST", "PUT", "DELETE") and pid not in ultima_edicao:
            ultima_edicao[pid] = l.created_at
        elif l.method == "VIEW" and pid not in ultima_view:
            ultima_view[pid] = l.created_at

    donos = {u.id: u.name for u in db.query(models.User).all()}
    agora = datetime.utcnow()
    saida = []
    for c in casos:
        referencia = ultima_edicao.get(c.id) or c.created_at
        if referencia is None or referencia > corte:
            continue
        visto = ultima_view.get(c.id)
        saida.append({
            "id": c.id,
            "nome": c.requerente_nome or c.numero_precatorio or f"Precatório #{c.id}",
            "numero_precatorio": c.numero_precatorio,
            "classificacao": c.classificacao,
            "classificacao_label": PREC_CLASSIFICACOES.get(c.classificacao, c.classificacao or "—"),
            "status_lead": c.status_lead,
            "status_label": FUNIL_LABELS.get(c.status_lead, c.status_lead or "—"),
            "valor_caso": c.valor_caso,
            "owner_id": c.owner_id,
            "responsavel": donos.get(c.owner_id, "—"),
            "ultima_movimentacao": referencia.isoformat() if referencia else None,
            "nunca_editado": c.id not in ultima_edicao,
            "dias_parado": (agora - referencia).days if referencia else None,
            "ultima_visualizacao": visto.isoformat() if visto else None,
            "dias_sem_ver": (agora - visto).days if visto else None,
        })

    saida.sort(key=lambda x: x["dias_parado"] or 0, reverse=True)
    return {"dias": dias, "total": len(saida), "casos": saida}


class LiberarLote(BaseModel):
    ids: List[int]


@router.post("/liberar-lote")
def liberar_lote(
    payload: LiberarLote,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Devolve vários casos para a FILA de uma vez. Exclusivo do administrador.

    Não é automático de propósito: o admin escolhe quais, um a um, na tela de
    casos parados. Devolver sozinho depois de N dias tiraria caso de advogado
    que está negociando fora do sistema.
    """
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode liberar em lote.")
    liberados, ignorados = 0, 0
    for pid in (payload.ids or []):
        p = db.query(models.Precatorio).get(pid)
        if not p:
            ignorados += 1
            continue
        if p.owner_id is None:      # já estava na fila
            ignorados += 1
            continue
        p.owner_id = None
        liberados += 1
    db.commit()
    return {"ok": True, "liberados": liberados, "ignorados": ignorados}


@router.get("/{precatorio_id}", response_model=schemas.PrecatorioOut)
def get_precatorio(
    precatorio_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "precatorios")
    p = db.query(models.Precatorio).get(precatorio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Precatório não encontrado")
    _ensure_acesso(p, current_user)
    from ..seguranca import registrar_acesso
    # O nome vai gravado junto, e não só o ID: se o precatório for excluído
    # depois, a trilha ainda precisa dizer QUEM foi acessado. A tela resolve o
    # nome pelo ID quando o registro existe — este rótulo é o que sobra quando
    # não existe mais.
    registrar_acesso(
        db, current_user, "VIEW",
        f"precatório #{p.id}" + (f" — {p.requerente_nome}" if p.requerente_nome else ""),
    )
    return _mascarar(p, current_user)


@router.put("/{precatorio_id}", response_model=schemas.PrecatorioOut)
def update_precatorio(
    precatorio_id: int,
    payload: schemas.PrecatorioUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "precatorios")
    p = db.query(models.Precatorio).get(precatorio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Precatório não encontrado")
    _ensure_acesso(p, current_user)
    data = payload.model_dump(exclude_unset=True)
    owner = data.pop("owner_id", None)
    # Simetria com a máscara de LEITURA: quem não pode VER os dados sensíveis de
    # um lead da fila também não pode SOBRESCREVÊ-LOS. Sem isso, salvar o
    # formulário (que mostra esses campos vazios) apagaria CPF/RG/telefone/etc.
    # do banco — perda de dado silenciosa.
    if _mascara_ativa(p, current_user):
        for campo in _SENSIVEIS:
            data.pop(campo, None)
    # Não deixa "fugir" da restrição reclassificando o caso para uma classe proibida.
    if "classificacao" in data and not classificacao_permitida(current_user, data["classificacao"]):
        raise HTTPException(
            status_code=403, detail="Sem permissão para esta classificação de precatório"
        )
    # Repontar para o cliente de um colega não pode (ver scope.validar_cliente_do_corpo).
    validar_cliente_do_corpo(db, data.get("client_id"), p.client_id, current_user)
    for field, value in data.items():
        setattr(p, field, value)
    if owner is not None and is_admin(current_user):
        p.owner_id = owner
    db.commit()
    db.refresh(p)
    # 🚨 A RESPOSTA passa pela máscara também. Devolvia `p` cru: um `PUT {}`
    # não alterava nada e trazia o CPF/RG/telefone/e-mail/endereço do lead da
    # fila em claro — a máscara do GET virava decoração, bastava trocar o verbo.
    # Pego pela suíte de testes (tests/test_mascara_fila.py), set/2026.
    return _mascarar(p, current_user)


@router.delete("/{precatorio_id}")
def delete_precatorio(
    precatorio_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode excluir leads.")
    p = db.query(models.Precatorio).get(precatorio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Precatório não encontrado")
    db.delete(p)
    db.commit()
    return {"ok": True}


# As etapas do funil (FUNIL_LABELS) MUDARAM DE LUGAR em ago/2026: a definição
# agora é `scope.FUNIL_LABELS`, importada no topo deste arquivo.
#
# Motivo: o `schemas.py` passou a precisar dela para barrar `status_lead`
# inventado na ENTRADA (era vetor de XSS armazenado), e schemas importar de um
# router criaria ciclo — routers importam schemas.
#
# O import no topo mantém o nome no namespace deste módulo, então
# `from .precatorios import query_precatorios, FUNIL_LABELS` no `export.py`
# continua valendo sem alteração. **Etapa nova entra no `scope.py`.**


class MoverEtapa(BaseModel):
    status_lead: str


@router.post("/{precatorio_id}/mover")
def mover_etapa(
    precatorio_id: int,
    payload: MoverEtapa,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Move o precatório para outra etapa do funil e registra no histórico."""
    require_edit(current_user, "precatorios")
    p = db.query(models.Precatorio).get(precatorio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Precatório não encontrado")
    _ensure_acesso(p, current_user)
    etapa = payload.status_lead
    if etapa not in FUNIL_LABELS:
        raise HTTPException(status_code=400, detail="Etapa inválida.")
    anterior = p.status_lead
    if etapa != anterior:
        p.status_lead = etapa
        db.add(models.PrecatorioContato(
            precatorio_id=p.id, tipo="etapa", owner_id=current_user.id,
            descricao=f"Etapa alterada de '{FUNIL_LABELS.get(anterior, anterior or '—')}' "
                      f"para '{FUNIL_LABELS[etapa]}'.",
        ))
        db.commit()
        db.refresh(p)
    return {"ok": True, "status_lead": p.status_lead}


class ExcluirLote(BaseModel):
    ids: List[int]


@router.post("/excluir-lote")
def excluir_lote(
    payload: ExcluirLote,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Exclui vários precatórios de uma vez. Exclusivo do administrador."""
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Apenas o administrador pode excluir em lote.")
    apagados = 0
    for pid in (payload.ids or []):
        p = db.query(models.Precatorio).get(pid)
        if not p:
            continue
        try:
            _ensure_acesso(p, current_user)
        except HTTPException:
            continue  # sem acesso a este: ignora
        db.delete(p)
        apagados += 1
    db.commit()
    return {"ok": True, "apagados": apagados}


@router.post("/{precatorio_id}/assumir", response_model=schemas.PrecatorioOut)
def assumir_precatorio(
    precatorio_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """O advogado assume um lead da fila e passa a ser o responsável exclusivo."""
    require_edit(current_user, "precatorios")
    p = db.query(models.Precatorio).get(precatorio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Precatório não encontrado")
    # Só é possível assumir um caso sem dono (ou que já seja seu). Admin pode sempre.
    if p.owner_id is not None and p.owner_id != current_user.id and not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Este caso já tem um responsável.")
    # Não pode assumir caso de uma classificação que ele nem tem permissão de ver.
    ensure_classificacao(p, current_user)
    p.owner_id = current_user.id
    db.commit()
    db.refresh(p)
    return p


@router.post("/{precatorio_id}/liberar", response_model=schemas.PrecatorioOut)
def liberar_precatorio(
    precatorio_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Devolve o caso para a FILA (sem dono), para outro advogado poder assumir.

    Permitido ao admin ou ao próprio responsável atual.
    """
    require_edit(current_user, "precatorios")
    p = db.query(models.Precatorio).get(precatorio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Precatório não encontrado")
    if not is_admin(current_user) and p.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Apenas o responsável ou o admin podem liberar este caso.")
    ensure_classificacao(p, current_user)
    p.owner_id = None
    db.commit()
    db.refresh(p)
    return p


# ---------------- Histórico de contatos (gestão comercial) ----------------
def _get_prec(precatorio_id, db, current_user):
    p = db.query(models.Precatorio).get(precatorio_id)
    if not p:
        raise HTTPException(status_code=404, detail="Precatório não encontrado")
    _ensure_acesso(p, current_user)
    return p


@router.get("/{precatorio_id}/contatos", response_model=List[schemas.ContatoOut])
def list_contatos(
    precatorio_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_view(current_user, "precatorios")
    _get_prec(precatorio_id, db, current_user)
    return (
        db.query(models.PrecatorioContato)
        .filter(models.PrecatorioContato.precatorio_id == precatorio_id)
        .order_by(models.PrecatorioContato.data.desc())
        .all()
    )


@router.post("/{precatorio_id}/contatos", response_model=schemas.ContatoOut)
def add_contato(
    precatorio_id: int,
    payload: schemas.ContatoCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "precatorios")
    p = _get_prec(precatorio_id, db, current_user)
    data = payload.model_dump()
    if not data.get("data"):
        data["data"] = datetime.utcnow()
    contato = models.PrecatorioContato(
        precatorio_id=precatorio_id, owner_id=current_user.id, **data
    )
    db.add(contato)
    # Atualiza o "último contato" do precatório
    p.data_ultimo_contato = data["data"].date() if hasattr(data["data"], "date") else data["data"]
    db.commit()
    db.refresh(contato)
    return contato


@router.delete("/{precatorio_id}/contatos/{contato_id}")
def delete_contato(
    precatorio_id: int,
    contato_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    require_edit(current_user, "precatorios")
    require_excluir(current_user)
    _get_prec(precatorio_id, db, current_user)
    contato = db.query(models.PrecatorioContato).get(contato_id)
    if not contato or contato.precatorio_id != precatorio_id:
        raise HTTPException(status_code=404, detail="Contato não encontrado")
    db.delete(contato)
    db.commit()
    return {"ok": True}


# ---------------- Timeline do caso ----------------
@router.get("/{precatorio_id}/timeline")
def precatorio_timeline(
    precatorio_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Linha do tempo: criação, contatos e documentos do precatório, em ordem."""
    require_view(current_user, "precatorios")
    p = _get_prec(precatorio_id, db, current_user)
    events = []
    if p.created_at:
        events.append({
            "tipo": "precatorio", "data": p.created_at.isoformat(),
            "titulo": "Precatório cadastrado",
            "detalhe": p.requerente_nome or f"Precatório #{p.id}",
        })
    for ct in p.contatos:
        if ct.data:
            events.append({
                "tipo": "contato", "data": ct.data.isoformat(),
                "titulo": f"Contato • {ct.tipo}",
                "detalhe": ct.descricao or "",
            })
    docs = (
        db.query(models.Document)
        .filter(models.Document.precatorio_id == precatorio_id)
        .all()
    )
    for d in docs:
        if d.uploaded_at:
            events.append({
                "tipo": "documento", "data": d.uploaded_at.isoformat(),
                "titulo": d.original_name or "Documento",
                "detalhe": _rotulo_categoria_doc(d.categoria),
            })
    events.sort(key=lambda e: e["data"], reverse=True)
    return {"precatorio": p.requerente_nome or f"Precatório #{p.id}", "events": events}


def _rotulo_categoria_doc(categoria):
    """Rótulo legível da categoria do documento ("Petição", não "peticao").

    Import local: `ficha` importa routers que importam este módulo, e o
    dicionário canônico de rótulos mora lá (um teste garante que ele cobre toda
    a lista fechada `DOC_CATEGORIAS`)."""
    from .ficha import _DOC_CATEGORIAS
    if not categoria:
        return "Documento"
    return _DOC_CATEGORIAS.get(categoria) or categoria.replace("_", " ")
