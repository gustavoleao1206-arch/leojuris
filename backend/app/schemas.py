"""Schemas Pydantic (validação de entrada/saída da API)."""
import json
import re
from datetime import datetime, date
from datetime import date as _date  # para campos chamados `date` (ver DeadlineUpdate)
from typing import List, Optional

from pydantic import BaseModel, EmailStr, ConfigDict, Field, ValidationInfo, field_validator, model_validator
from sqlalchemy import String

from . import models
from .scope import (
    ROLES,
    CLIENT_STATUS,
    PREC_CLASSIFICACOES,
    FUNIL_LABELS,
    PREC_PROBABILIDADES,
    ACAO_AREAS,
    ASSIN_TIPOS,
    ASSIN_AREAS,
    ATENDIMENTO_TIPOS,
    CONTATO_PAPEIS,
    PARTE_TIPOS,
    PARTE_POLOS,
    CLIENTE_ORIGENS,
    TIPOS_PESSOA,
    INSTANCIAS,
    URGENCIAS,
)


def _lista_fechada(campo: str, valores, rotulo: str):
    """Validator reaproveitável: recusa valor fora da lista canônica.

    🚨 POR QUE ISTO EXISTE — foi XSS armazenado de verdade (ago/2026).
    Os campos validados aqui são renderizados no `app.js` com o padrão
    `DICT[x] || x`: quando o valor não está no dicionário de rótulos, ele cai
    CRU no HTML. Sendo `str` livre, um funcionário gravava
    `<img src=x onerror=...>` no status de um cliente ou na classificação de um
    precatório, e o código executava na sessão de QUEM ABRISSE a tela — na
    prática, na sessão do admin.

    ⚠️ ONDE APLICAR: só em `Create`/`Update`, NUNCA na `Base`.
    `ClientOut`, `PrecatorioOut` e `AcaoOut` herdam da Base. Um validator lá
    rodaria também na SAÍDA, e aí um registro já envenenado (gravado antes
    desta correção) faria a listagem inteira estourar 500 — tirando do admin
    exatamente a tela onde ele veria e limparia o lixo.

    Vazio e `None` passam: são "campo não preenchido", que o front já trata.
    """
    def _valida(v):
        if v is None or v == "":
            return v
        if v not in valores:
            raise ValueError(f"{rotulo} inválido. Use um de: {', '.join(sorted(valores))}")
        return v

    return field_validator(campo)(_valida)


def _lista_fechada_obrigatoria(campo: str, valores, rotulo: str):
    """Como `_lista_fechada`, mas para coluna NOT NULL: vazio e `None` → 422.

    O `_lista_fechada` deixa passar vazio de propósito (campo opcional). Num
    campo obrigatório isso viraria IntegrityError (500) com `null`, ou gravaria
    uma parte sem tipo com `""`.
    """
    def _valida(v):
        if v is None or (isinstance(v, str) and not v.strip()):
            raise ValueError(f"{rotulo} é obrigatório.")
        if v not in valores:
            raise ValueError(f"{rotulo} inválido. Use um de: {', '.join(sorted(valores))}")
        return v

    return field_validator(campo)(_valida)


def _obrigatorio(*campos: str):
    """Texto obrigatório e não vazio — `null`, `""` e só espaços dão 422.

    🚨 Num `Update` todo campo é `Optional` (o PUT manda só o que mudou), e o
    padrão `exclude_unset` + `setattr` dos routers GRAVA o `null` que vier no
    corpo. Sem este validator, `PUT {"nome": null}` numa coluna NOT NULL dava
    500 (IntegrityError) em vez de 422. O validator só roda quando o campo VEM
    no corpo — omitir continua sendo "não mexer".
    """
    def _valida(v):
        if v is None:
            raise ValueError("Campo obrigatório.")
        if isinstance(v, str):
            v = v.strip()
            if not v:
                raise ValueError("Campo obrigatório.")
        return v

    return field_validator(*campos)(_valida)


def _tamanho_max(limite: int, *campos: str):
    """Texto com no máximo `limite` caracteres (o tamanho da coluna) → senão 422.

    🚨 O SQLite da suíte não confere `VARCHAR(n)`, mas o PostgreSQL de produção
    confere: texto maior que a coluna estourava `DataError` (500) só lá — o
    tipo de falha que nenhum teste local pega. Só em `Create`/`Update` (nunca
    na Base, que o `*Out` herda: valor antigo maior não pode quebrar a leitura).
    """
    def _valida(v):
        if isinstance(v, str) and len(v) > limite:
            raise ValueError(f"Use no máximo {limite} caracteres.")
        return v

    return field_validator(*campos)(_valida)


def _tamanho_das_colunas(modelo):
    """`_tamanho_max` em TODO campo texto do schema, com o tamanho da coluna.

    O limite de cada campo é o `String(n)` da coluna homônima em `modelo`
    (models.py) — derivado, não copiado: alargar uma coluna lá alarga a
    validação aqui, e campo novo entra sozinho. Uma lista escrita à mão já
    tinha deixado de fora o complemento do endereço (80) e a descrição do
    prazo (255): texto maior estourava `DataError` (500) só no PostgreSQL.
    `Text` é subclasse de `String` sem tamanho — fica de fora, como deve.

    ⚠️ Mesma regra do `_tamanho_max`: só em `Create`/`Update`, nunca na Base.
    """
    limites = {
        c.key: c.type.length for c in modelo.__table__.columns
        if isinstance(c.type, String) and c.type.length
    }

    def _valida(v, info: ValidationInfo):
        limite = limites.get(info.field_name)
        if limite and isinstance(v, str) and len(v) > limite:
            raise ValueError(f"Use no máximo {limite} caracteres.")
        return v

    return field_validator("*")(_valida)


def _zero_ou_um(*campos: str):
    """Flag inteira (0/1) — qualquer outro número → 422.

    `done` é lido como "cumprido?" em todo lugar (`if d.done`, `done == 0`).
    Um 2 gravado parecia cumprido numa tela e pendente na outra. `None` passa
    aqui: a obrigatoriedade no PUT é do `_obrigatorio`.
    """
    def _valida(v):
        if v is not None and v not in (0, 1):
            raise ValueError("Use 0 (pendente) ou 1 (cumprido).")
        return v

    return field_validator(*campos)(_valida)


# ----------------------- Auth / Users -----------------------
class UserBase(BaseModel):
    name: str
    email: str
    role: str = "advogado"


class UserCreate(UserBase):
    password: str
    # Permissões já na criação do usuário (somente admin envia).
    permissions: Optional[dict] = None

    # ⚠️ Este validator estava na `UserBase`, que `UserOut` herda — mesma
    # armadilha que derrubou 17 casos pelo `ContatoBase` (ver ali). Hoje todos
    # os papéis no banco são válidos, então não quebrava nada; mas bastaria um
    # papel novo no código, ou um registro antigo, para a tela de Usuários
    # inteira passar a dar 500 — justamente a tela onde o admin consertaria.
    @field_validator("role")
    @classmethod
    def _papel_valido(cls, v):
        if v not in ROLES:
            raise ValueError(f"Papel inválido. Use um de: {', '.join(ROLES)}")
        return v


class UserAdminUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    password: Optional[str] = None
    # Formulário completo de permissões; {} restaura o acesso total.
    permissions: Optional[dict] = None

    @field_validator("role")
    @classmethod
    def _papel_valido(cls, v):
        if v is not None and v not in ROLES:
            raise ValueError(f"Papel inválido. Use um de: {', '.join(ROLES)}")
        return v


class UserOut(UserBase):
    id: int
    created_at: datetime
    totp_enabled: int = 0
    avatar: Optional[str] = None
    # No banco é texto JSON; na API sai como dicionário (ou null = acesso total).
    permissions: Optional[dict] = None
    model_config = ConfigDict(from_attributes=True)

    @field_validator("permissions", mode="before")
    @classmethod
    def _parse_permissions(cls, v):
        """Aceita tanto o texto JSON vindo do banco quanto um dict pronto."""
        if v is None or v == "":
            return None
        if isinstance(v, dict):
            return v
        try:
            data = json.loads(v)
        except Exception:
            return None
        return data if isinstance(data, dict) else None


class AvatarUpdate(BaseModel):
    avatar: Optional[str] = None  # data URI base64 (ou null para remover)


class TwoFACode(BaseModel):
    code: str  # código do app autenticador (TOTP)


class TwoFASetup(BaseModel):
    """Corpo do POST /api/auth/2fa/setup.

    Na PRIMEIRA ativação a rota não pede nada (o corpo pode nem existir). Com o
    2FA já ligado — troca de aparelho — os dois campos são obrigatórios: quem
    tem só o token da sessão não pode trocar o segundo fator de ninguém.
    """
    senha_atual: Optional[str] = Field(None, max_length=200)
    code: Optional[str] = Field(None, max_length=16)  # código do app ATUAL


class TwoFAEnable(BaseModel):
    """Corpo do POST /api/auth/2fa/enable.

    `senha_atual` é obrigatória na PRIMEIRA ativação (sem ela, uma sessão
    roubada ligava o 2FA com a chave do atacante). Na troca de aparelho a
    senha já foi conferida no /2fa/setup e o campo é ignorado.
    """
    code: str = Field(..., max_length=16)
    senha_atual: Optional[str] = Field(None, max_length=200)


class LoginRequest(BaseModel):
    email: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ----------------------- Clients -----------------------
class ClientBase(BaseModel):
    name: str
    cpf_cnpj: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    status: str = "lead"
    notes: Optional[str] = None
    # Dados pessoais
    rg: Optional[str] = None
    orgao_expedidor: Optional[str] = None
    data_nascimento: Optional[date] = None
    sexo: Optional[str] = None
    estado_civil: Optional[str] = None
    nacionalidade: Optional[str] = None
    profissao: Optional[str] = None
    # Dados trabalhistas
    pis_pasep: Optional[str] = None
    ctps: Optional[str] = None
    # Contato
    celular: Optional[str] = None
    telefone_secundario: Optional[str] = None
    whatsapp: Optional[str] = None
    # Endereço
    cep: Optional[str] = None
    estado: Optional[str] = None
    cidade: Optional[str] = None
    bairro: Optional[str] = None
    rua: Optional[str] = None
    numero: Optional[str] = None
    complemento: Optional[str] = None
    # Ficha única (out/2026): PF/PJ e captação
    tipo_pessoa: Optional[str] = None
    nome_fantasia: Optional[str] = None
    origem: Optional[str] = None
    indicado_por: Optional[str] = None


class ClientCreate(ClientBase):
    owner_id: Optional[int] = None  # admin pode definir o responsável na criação

    _nome = _obrigatorio("name")          # "" ou só espaços → 422 (cliente sem nome)
    _status_valido = _lista_fechada("status", CLIENT_STATUS, "Status de cliente")
    _tipo_pessoa_valido = _lista_fechada("tipo_pessoa", TIPOS_PESSOA, "Tipo de pessoa")
    _origem_valida = _lista_fechada("origem", CLIENTE_ORIGENS, "Origem do cliente")
    _tamanhos = _tamanho_das_colunas(models.Client)


class ClientUpdate(BaseModel):
    name: Optional[str] = None
    cpf_cnpj: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    rg: Optional[str] = None
    orgao_expedidor: Optional[str] = None
    data_nascimento: Optional[date] = None
    sexo: Optional[str] = None
    estado_civil: Optional[str] = None
    nacionalidade: Optional[str] = None
    profissao: Optional[str] = None
    pis_pasep: Optional[str] = None
    ctps: Optional[str] = None
    celular: Optional[str] = None
    telefone_secundario: Optional[str] = None
    whatsapp: Optional[str] = None
    cep: Optional[str] = None
    estado: Optional[str] = None
    cidade: Optional[str] = None
    bairro: Optional[str] = None
    rua: Optional[str] = None
    numero: Optional[str] = None
    complemento: Optional[str] = None
    # ⚠️ Repetidos aqui porque esta classe NÃO herda da Base: campo que faltar
    # nesta lista é descartado em silêncio pelo Pydantic e o PUT responde 200
    # sem gravar (tests/test_ficha_seguranca.py::test_campos_novos_persistem_no_put).
    tipo_pessoa: Optional[str] = None
    nome_fantasia: Optional[str] = None
    origem: Optional[str] = None
    indicado_por: Optional[str] = None
    owner_id: Optional[int] = None  # admin pode reatribuir o responsável

    # `status: null` gravava NULL, e o `ClientOut` (status: str) derrubava com
    # 500 a lista INTEIRA de clientes de quem enxerga aquele registro.
    _status_obrigatorio = _obrigatorio("status")
    # É por AQUI que o XSS entrava: `PUT /api/clients/<id>` com status forjado.
    _status_valido = _lista_fechada("status", CLIENT_STATUS, "Status de cliente")
    _tipo_pessoa_valido = _lista_fechada("tipo_pessoa", TIPOS_PESSOA, "Tipo de pessoa")
    _origem_valida = _lista_fechada("origem", CLIENTE_ORIGENS, "Origem do cliente")
    _tamanhos = _tamanho_das_colunas(models.Client)


class ClientOut(ClientBase):
    id: int
    created_at: datetime
    owner_id: Optional[int] = None
    # Quantos processos do cliente o usuário ALCANÇA (scope de Processos). `None`
    # quando ele não tem o módulo Processos — "não sei" e não "zero".
    processos_count: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Processes -----------------------
class ProcessBase(BaseModel):
    client_id: int
    case_number: Optional[str] = None
    type: Optional[str] = None
    subcategoria: Optional[str] = None
    classe: Optional[str] = None
    assunto: Optional[str] = None
    foro: Optional[str] = None
    vara: Optional[str] = None
    tribunal: Optional[str] = None
    orgao_julgador: Optional[str] = None
    data_distribuicao: Optional[date] = None
    fase_processual: Optional[str] = None
    sistema_eletronico: Optional[str] = None
    valor_causa: Optional[float] = None
    status: str = "ativo"
    description: Optional[str] = None
    # Ficha única (out/2026)
    polo_cliente: Optional[str] = None
    instancia: Optional[str] = None


class ProcessCreate(ProcessBase):
    owner_id: Optional[int] = None  # admin pode definir o advogado responsável na criação

    _polo_valido = _lista_fechada("polo_cliente", PARTE_POLOS, "Polo do cliente")
    _instancia_valida = _lista_fechada("instancia", INSTANCIAS, "Instância")
    _tamanhos = _tamanho_das_colunas(models.Process)


class ProcessUpdate(BaseModel):
    client_id: Optional[int] = None
    case_number: Optional[str] = None
    type: Optional[str] = None
    subcategoria: Optional[str] = None
    classe: Optional[str] = None
    assunto: Optional[str] = None
    foro: Optional[str] = None
    vara: Optional[str] = None
    tribunal: Optional[str] = None
    orgao_julgador: Optional[str] = None
    data_distribuicao: Optional[date] = None
    fase_processual: Optional[str] = None
    sistema_eletronico: Optional[str] = None
    valor_causa: Optional[float] = None
    status: Optional[str] = None
    description: Optional[str] = None
    # ⚠️ Repetidos: esta classe NÃO herda da Base (ver ClientUpdate).
    polo_cliente: Optional[str] = None
    instancia: Optional[str] = None
    owner_id: Optional[int] = None

    # `status: null` gravava NULL, e o `ProcessOut` (status: str) derrubava com
    # 500 a lista INTEIRA de processos. `client_id: null` é barrado no router
    # (mensagem própria: "O processo precisa de um cliente").
    _status_obrigatorio = _obrigatorio("status")
    _polo_valido = _lista_fechada("polo_cliente", PARTE_POLOS, "Polo do cliente")
    _instancia_valida = _lista_fechada("instancia", INSTANCIAS, "Instância")
    _tamanhos = _tamanho_das_colunas(models.Process)


class ProcessOut(ProcessBase):
    id: int
    created_at: datetime
    client_name: Optional[str] = None
    owner_id: Optional[int] = None
    # Calculados na listagem (processes.py::_enriquecer), dentro do escopo de
    # quem pergunta: o menor prazo NÃO cumprido que ele enxerga e os nomes das
    # partes contrárias separados por ", " (null quando não há).
    proximo_prazo: Optional[date] = None
    partes_contrarias: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Deadlines -----------------------
class DeadlineBase(BaseModel):
    process_id: int
    date: date
    description: str
    urgency_level: str = "media"
    done: int = 0


class DeadlineCreate(DeadlineBase):
    # Lista fechada na entrada; a Base (que o DeadlineOut herda) fica livre para
    # não derrubar a leitura de algum valor antigo já gravado.
    # OBRIGATÓRIA (vazio/null → 422), não só fechada: o `DeadlineOut` lê
    # `urgency_level: str`, e um prazo gravado com NULL derrubava com 500 a
    # listagem INTEIRA de prazos de quem o enxerga.
    _urgencia_valida = _lista_fechada_obrigatoria("urgency_level", URGENCIAS, "Urgência")
    _descricao = _obrigatorio("description")
    _done_valido = _zero_ou_um("done")
    _tamanhos = _tamanho_das_colunas(models.Deadline)


class DeadlineUpdate(BaseModel):
    process_id: Optional[int] = None
    # ⚠️ `_date`, não `date`: num campo COM valor padrão o Python grava `date = None`
    # no corpo da classe ANTES de avaliar a anotação, e `Optional[date]` virava
    # `Optional[None]` — todo PUT com data voltava 422 "Input should be None"
    # (editar a data de um prazo nunca funcionou). `DeadlineBase.date: date` não
    # sofre disso porque não tem padrão.
    date: Optional[_date] = None
    description: Optional[str] = None
    urgency_level: Optional[str] = None
    done: Optional[int] = None

    _urgencia_valida = _lista_fechada_obrigatoria("urgency_level", URGENCIAS, "Urgência")
    # Colunas NOT NULL: `{"description": null}` gravava NULL e estourava
    # IntegrityError (500). Só rodam quando o campo VEM no corpo — omitir
    # continua sendo "não mexer" (a caixa "Cumprido" manda só `done`).
    # 🚨 `done` não é NOT NULL no banco, e por isso era PIOR: `{"done": null}`
    # gravava, e o `DeadlineOut` (done: int) derrubava com 500 o
    # GET /api/deadlines de TODO MUNDO que enxerga o prazo.
    _obrigatorios = _obrigatorio("process_id", "date", "description", "done")
    _done_valido = _zero_ou_um("done")
    _tamanhos = _tamanho_das_colunas(models.Deadline)


class DeadlineOut(DeadlineBase):
    id: int
    created_at: datetime
    process_label: Optional[str] = None
    days_left: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Appointments -----------------------
class AppointmentBase(BaseModel):
    process_id: int
    date_time: datetime
    location: Optional[str] = None
    notes: Optional[str] = None


class AppointmentCreate(AppointmentBase):
    _tamanhos = _tamanho_das_colunas(models.Appointment)


class AppointmentUpdate(BaseModel):
    process_id: Optional[int] = None
    date_time: Optional[datetime] = None
    location: Optional[str] = None
    notes: Optional[str] = None

    # Colunas NOT NULL: `null` no PUT virava IntegrityError (500). Omitir
    # continua sendo "não mexer".
    _obrigatorios = _obrigatorio("process_id", "date_time")
    _tamanhos = _tamanho_das_colunas(models.Appointment)


class AppointmentOut(AppointmentBase):
    id: int
    created_at: datetime
    process_label: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Documents -----------------------
class DocumentOut(BaseModel):
    id: int
    client_id: Optional[int] = None
    process_id: Optional[int] = None
    precatorio_id: Optional[int] = None
    acao_id: Optional[int] = None
    categoria: Optional[str] = None
    original_name: Optional[str] = None
    file_path: str
    uploaded_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Dashboard -----------------------
class DashboardStats(BaseModel):
    total_clients: int
    active_processes: int
    urgent_deadlines: int
    upcoming_appointments: int


# ----------------------- Honorários (Financeiro) -----------------------
class HonorarioBase(BaseModel):
    client_id: Optional[int] = None
    # O caso vinculado pode ser processo, precatório ou ação (ver models.Honorario).
    process_id: Optional[int] = None
    acao_id: Optional[int] = None
    precatorio_id: Optional[int] = None
    type: str = "contratual"  # contratual | extrajudicial
    total_value: float = 0
    paid_value: float = 0
    due_date: Optional[date] = None
    notes: Optional[str] = None
    # Modelo de parceria
    origem: Optional[str] = "proprio"        # proprio | parceria
    parceiro_id: Optional[int] = None        # advogado parceiro (usuário do sistema)
    pct_escritorio: Optional[float] = None
    pct_parceiro: Optional[float] = None
    # Rateio de sócios (honorário de precatório)
    rateio: Optional[int] = 0                 # 1 = distribui entre sócios (cascata)
    pct_reserva: Optional[float] = None       # sobrescreve o % de reserva do config global


MSG_PAGO_MAIOR_QUE_TOTAL = "O valor pago não pode ser maior que o total."


def pago_excede_total(total, pago) -> bool:
    """Pago > total, em centavos (float de reais não compara bem). `None` = 0.

    Usado aqui (create) e no PUT do router, que confere contra o valor JÁ
    gravado quando o corpo traz só um dos dois — coisa que o schema não vê.
    """
    return round(pago or 0, 2) > round(total or 0, 2)


class HonorarioCreate(HonorarioBase):
    owner_id: Optional[int] = None

    @model_validator(mode="after")
    def _pago_cabe_no_total(self):
        # 🚨 Total 5,00 com pago 1.000,00 era aceito e o status virava "pago";
        # o rateio (regime de caixa, base = valor PAGO) distribuía mais do que
        # o contratado, e o dashboard somava receita que não existe.
        if pago_excede_total(self.total_value, self.paid_value):
            raise ValueError(MSG_PAGO_MAIOR_QUE_TOTAL)
        return self


class HonorarioUpdate(BaseModel):
    # 🚨 Esta classe NÃO herda de HonorarioBase (de propósito: aqui tudo é
    # opcional). A consequência é que CAMPO NOVO PRECISA SER REPETIDO AQUI —
    # o Pydantic 2 descarta campo extra em silêncio, então um PUT com um FK
    # que falte nesta lista devolve 200 sem gravar nada. Foi exatamente o que
    # aconteceu com precatorio_id/acao_id: o `process_id: None` era aplicado e
    # o vínculo novo ia para o lixo, deixando o honorário órfão sem erro nenhum.
    client_id: Optional[int] = None
    process_id: Optional[int] = None
    acao_id: Optional[int] = None
    precatorio_id: Optional[int] = None
    type: Optional[str] = None
    total_value: Optional[float] = None
    paid_value: Optional[float] = None
    due_date: Optional[date] = None
    notes: Optional[str] = None
    owner_id: Optional[int] = None
    origem: Optional[str] = None
    parceiro_id: Optional[int] = None
    pct_escritorio: Optional[float] = None
    pct_parceiro: Optional[float] = None
    rateio: Optional[int] = None
    pct_reserva: Optional[float] = None


class RateioFatiaOut(BaseModel):
    tipo: str                 # reserva | parceiro | fundo | socio
    user_id: Optional[int] = None
    nome: Optional[str] = None
    pct: Optional[float] = None
    base: Optional[float] = None
    valor: Optional[float] = None
    model_config = ConfigDict(from_attributes=True)


class HonorarioOut(HonorarioBase):
    id: int
    status: str
    pending_value: float = 0
    client_name: Optional[str] = None
    process_label: Optional[str] = None
    created_at: datetime
    owner_id: Optional[int] = None
    created_by: Optional[int] = None
    created_by_name: Optional[str] = None
    owner_name: Optional[str] = None
    parceiro_name: Optional[str] = None
    valor_escritorio: Optional[float] = None
    valor_parceiro: Optional[float] = None
    minha_parte: Optional[bool] = False   # True quando os valores exibidos são a parte do parceiro
    rateio: Optional[int] = 0
    pct_reserva: Optional[float] = None
    rateio_fatias: Optional[List[RateioFatiaOut]] = None  # livro-razão da distribuição
    model_config = ConfigDict(from_attributes=True)


class FinanceSummary(BaseModel):
    total: float
    recebido: float
    pendente: float


class ParcelarRequest(BaseModel):
    client_id: Optional[int] = None
    # Os três tipos de caso, como no honorário avulso — honorário de precatório
    # é justamente o que mais se parcela aqui.
    process_id: Optional[int] = None
    acao_id: Optional[int] = None
    precatorio_id: Optional[int] = None
    type: str = "contratual"
    total_value: float
    parcelas: int
    primeiro_vencimento: date
    intervalo_dias: int = 30
    notes: Optional[str] = None


# ----------------------- Precatórios -----------------------
class PrecatorioBase(BaseModel):
    client_id: Optional[int] = None  # cliente cadastrado vinculado (opcional)
    # Dados do requerente
    requerente_nome: Optional[str] = None
    requerente_cpf: Optional[str] = None
    requerente_rg: Optional[str] = None
    requerente_nascimento: Optional[date] = None
    requerente_telefone: Optional[str] = None
    requerente_email: Optional[str] = None
    requerente_endereco: Optional[str] = None
    # Dados processuais
    processo_id: Optional[str] = None
    numero_originario: Optional[str] = None
    numero_precatorio: Optional[str] = None
    tribunal: Optional[str] = None
    vara: Optional[str] = None
    classe: Optional[str] = None
    tema: Optional[str] = None
    assunto: Optional[str] = None
    observacoes: Optional[str] = None
    banco: Optional[str] = None
    # Classificação
    classificacao: Optional[str] = None
    status_precatorio: Optional[str] = "sem_alvara"
    # Gestão comercial
    status_lead: Optional[str] = "novos_leads"
    probabilidade: Optional[int] = None
    probabilidade_nivel: Optional[str] = None      # pouco_provavel | possivel | muito_provavel
    valor_caso: Optional[float] = None             # valor do caso (R$)
    percentual_honorarios: Optional[float] = None  # % de honorários contratado
    data_ultimo_contato: Optional[date] = None
    data_proximo_contato: Optional[date] = None
    advogado: Optional[str] = None
    anotacoes: Optional[str] = None


# Os três campos abaixo alimentam `precBadge()` no `app.js`, que renderiza
# `map[k] || k` — ou seja, valor fora do dicionário aparece CRU em 5 telas
# (lista de Precatórios, cartão do Funil, página do caso, lista de Ações,
# página da ação). Eram `str` livre até ago/2026.
class PrecatorioCreate(PrecatorioBase):
    owner_id: Optional[int] = None

    _classif_valida = _lista_fechada("classificacao", PREC_CLASSIFICACOES, "Classificação")
    _lead_valido = _lista_fechada("status_lead", FUNIL_LABELS, "Status comercial")
    _prob_valida = _lista_fechada("probabilidade_nivel", PREC_PROBABILIDADES, "Nível de probabilidade")


class PrecatorioUpdate(PrecatorioBase):
    owner_id: Optional[int] = None

    _classif_valida = _lista_fechada("classificacao", PREC_CLASSIFICACOES, "Classificação")
    _lead_valido = _lista_fechada("status_lead", FUNIL_LABELS, "Status comercial")
    _prob_valida = _lista_fechada("probabilidade_nivel", PREC_PROBABILIDADES, "Nível de probabilidade")


class PrecatorioOut(PrecatorioBase):
    id: int
    created_at: datetime
    owner_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


# Listas fechadas dos campos que a tela renderiza como rótulo.
#
# Motivo: a tela usa DICIONARIO[valor] || valor — quando o valor não está no
# dicionário, ele cai CRU no HTML. Isso era um XSS armazenado (ago/2026). O
# frontend agora escapa, mas a defesa boa é a entrada nunca aceitar lixo:
# um POST direto na API gravava qualquer string aqui.
CONTATO_TIPOS = {"ligacao", "whatsapp", "email", "reuniao", "outro"}
# ⚠️ Categoria nova entra AQUI e nos rótulos: `ficha._DOC_CATEGORIAS` (linha do
# tempo) e `PREC_DOC_CAT` no frontend/app.js — senão a tela mostra a chave crua.
DOC_CATEGORIAS = {
    "procuracao", "contrato", "documento_pessoal", "comprovante", "outro",
    "peticao", "decisao", "laudo",          # out/2026
}


class ContatoBase(BaseModel):
    tipo: str = "ligacao"
    descricao: Optional[str] = None
    data: Optional[datetime] = None


class ContatoCreate(ContatoBase):
    """Contato criado por uma PESSOA, pela API. Aqui a lista fecha.

    🚨 O VALIDATOR ESTAVA NA `ContatoBase` E DERRUBOU 17 CASOS EM PRODUÇÃO.

    `ContatoOut` herda da Base, então a lista fechada rodava também na SAÍDA.
    E o próprio sistema grava `tipo="etapa"` ao mover um caso no funil
    (`precatorios.py`, na rota de mover) — um valor legítimo que nunca esteve
    em `CONTATO_TIPOS`, porque a lista foi escrita pensando só no que o
    usuário digita.

    Resultado: todo caso que já tinha sido movido no funil passou a estourar
    500 ao ser aberto — inclusive para o ADMIN, que por definição pode ver
    tudo. Eram 53 contatos, 17 precatórios. O dono achou dois e reportou.

    A regra que vale (e que estava documentada com a lista de classes
    incompleta): **lista fechada vai em `Create`/`Update`, NUNCA na `Base`.**
    Validar a saída transforma qualquer dado inesperado — inclusive o que o
    seu próprio código escreve — em erro 500 numa tela de leitura.

    `etapa` continua FORA da lista de propósito: é marcador que o sistema
    escreve internamente (o router monta o model direto, sem passar por aqui),
    não algo que alguém deva conseguir forjar por POST.
    """

    @field_validator("tipo")
    @classmethod
    def _tipo_valido(cls, v):
        if v and v not in CONTATO_TIPOS:
            raise ValueError(f"Tipo de contato inválido. Use um de: {', '.join(sorted(CONTATO_TIPOS))}")
        return v


class ContatoOut(ContatoBase):
    id: int
    precatorio_id: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Ações Judiciais Gerais -----------------------
class AcaoBase(BaseModel):
    client_id: Optional[int] = None  # cliente cadastrado vinculado (opcional)
    area: Optional[str] = None
    parte_nome: Optional[str] = None
    parte_cpf: Optional[str] = None
    parte_rg: Optional[str] = None
    parte_nascimento: Optional[date] = None
    parte_telefone: Optional[str] = None
    parte_email: Optional[str] = None
    parte_endereco: Optional[str] = None
    numero_processo: Optional[str] = None
    vara: Optional[str] = None
    comarca: Optional[str] = None
    classe: Optional[str] = None
    assunto: Optional[str] = None
    observacoes: Optional[str] = None
    valor_causa: Optional[float] = None
    percentual_honorarios: Optional[float] = None
    status_lead: Optional[str] = "novos_leads"
    probabilidade_nivel: Optional[str] = None
    data_ultimo_contato: Optional[date] = None
    data_proximo_contato: Optional[date] = None
    anotacoes: Optional[str] = None


class AcaoCreate(AcaoBase):
    owner_id: Optional[int] = None

    # Mesmo sink `precBadge` dos precatórios — ver comentário lá em cima.
    #
    # `area` entrou na validação em ago/2026, depois que a divergência de chave
    # foi resolvida: o backend usava `outros` e o frontend `outras`, e fechar a
    # lista antes disso recusaria justamente o cadastro de "Outras" que a tela
    # envia. Hoje ambos usam **`outras`** (decisão do dono).
    _area_valida = _lista_fechada("area", ACAO_AREAS, "Área da ação")
    _lead_valido = _lista_fechada("status_lead", FUNIL_LABELS, "Status comercial")
    _prob_valida = _lista_fechada("probabilidade_nivel", PREC_PROBABILIDADES, "Nível de probabilidade")


class AcaoUpdate(AcaoBase):
    owner_id: Optional[int] = None

    _area_valida = _lista_fechada("area", ACAO_AREAS, "Área da ação")
    _lead_valido = _lista_fechada("status_lead", FUNIL_LABELS, "Status comercial")
    _prob_valida = _lista_fechada("probabilidade_nivel", PREC_PROBABILIDADES, "Nível de probabilidade")


class AcaoOut(AcaoBase):
    id: int
    created_at: datetime
    owner_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


class AcaoContatoOut(ContatoBase):
    id: int
    acao_id: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Assinaturas (modelos + status) -----------------------
class AssinaturaBase(BaseModel):
    tipo: str = "procuracao"          # procuracao | contrato
    area: str = "precatorios"         # precatorios | civel | trabalhista
    client_id: Optional[int] = None
    precatorio_id: Optional[int] = None
    signatario_nome: Optional[str] = None
    signatario_cpf: Optional[str] = None
    signatario_email: Optional[str] = None


class AssinaturaCreate(AssinaturaBase):
    # `area` cai crua em `app.js:3591` (`ASSIN_AREA[a.area] || a.area`) e vinha
    # direto do payload para o banco — terceiro XSS armazenado, achado só na
    # reauditoria de ago/2026.
    #
    # ⚠️ A trava fica AQUI e não na Base: `assinaturas.py::upload` grava
    # `area="anexo"` com `tipo` vindo das categorias de documento, e devolve
    # `AssinaturaOut` — que herda da Base. Validar lá dentro faria todo anexo
    # existente estourar na leitura.
    _tipo_valido = _lista_fechada("tipo", ASSIN_TIPOS, "Tipo de assinatura")
    _area_valida = _lista_fechada("area", ASSIN_AREAS, "Área da assinatura")


class AssinaturaUpdate(BaseModel):
    titulo: Optional[str] = None
    status: Optional[str] = None
    signatario_nome: Optional[str] = None
    signatario_cpf: Optional[str] = None
    signatario_email: Optional[str] = None
    owner_id: Optional[int] = None


class AssinaturaOut(AssinaturaBase):
    id: int
    titulo: Optional[str] = None
    status: str
    file_path: Optional[str] = None
    clicksign_key: Optional[str] = None
    client_name: Optional[str] = None
    precatorio_label: Optional[str] = None
    owner_id: Optional[int] = None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Monitoramento (DataJud) -----------------------
class MonitorBase(BaseModel):
    numero: str
    tribunal: str
    descricao: Optional[str] = None


class MonitorCreate(MonitorBase):
    pass


class MonitorOut(MonitorBase):
    id: int
    last_checked: Optional[datetime] = None
    last_movement: Optional[str] = None
    last_movement_date: Optional[str] = None
    has_news: int = 0
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


# ----------------------- Ficha única de Cliente e Processo -----------------------
# Atendimentos, contatos, partes e andamentos NÃO têm dono próprio: herdam do
# cliente/processo da URL (ver models.Atendimento). Por isso nenhum destes
# schemas aceita `owner_id`.
#
# Listas fechadas só em Create/Update, como no resto do arquivo — o `*Out` lê
# qualquer valor já gravado sem quebrar (tests/test_ficha_rotas.py grava um
# tipo inventado direto no banco e exige GET 200).

class AtendimentoCreate(BaseModel):
    tipo: str = "nota"
    descricao: str
    # Hora LOCAL do navegador (o formulário sempre manda). Sem ela, o servidor
    # usa a hora de Brasília — nunca a UTC dele (prazos.agora_local).
    data: Optional[datetime] = None
    process_id: Optional[int] = None
    proximo_retorno: Optional[date] = None

    _tipo_valido = _lista_fechada_obrigatoria("tipo", ATENDIMENTO_TIPOS, "Tipo de atendimento")
    _descricao = _obrigatorio("descricao")


class AtendimentoOut(BaseModel):
    id: int
    client_id: int
    # 🚨 `process_id`/`process_number` saem NULOS quando o processo vinculado
    # está fora do alcance de quem lê (ver ficha.py::_atendimento_out). O
    # atendimento é do cliente; o processo pode ser de outro advogado.
    process_id: Optional[int] = None
    process_number: Optional[str] = None
    data: datetime
    tipo: str
    descricao: str
    proximo_retorno: Optional[date] = None
    autor_id: Optional[int] = None
    autor_nome: Optional[str] = None
    created_at: Optional[datetime] = None


# Sem espaço, `:`, `(`, aspas: o e-mail do contato vira `mailto:` na ficha.
_EMAIL_CONTATO = re.compile(r"^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")


class _ContatoCampos(BaseModel):
    nome: Optional[str] = None
    papel: Optional[str] = None
    cpf: Optional[str] = None
    telefone: Optional[str] = None
    email: Optional[str] = None
    observacao: Optional[str] = None
    principal: Optional[bool] = None

    # Base só de Create/Update (o Out é outra classe): o limite vale na entrada.
    _tam_150 = _tamanho_max(150, "nome")
    _tam_120 = _tamanho_max(120, "email")
    _tam_40 = _tamanho_max(40, "telefone")
    _tam_20 = _tamanho_max(20, "cpf")

    @field_validator("email")
    @classmethod
    def _email_valido(cls, v):
        """Formato de e-mail na ENTRADA — o valor vira link `mailto:` na ficha.

        Pode validar porque a tabela é nova: não há dado legado a quebrar.
        ⚠️ NÃO copie isto para o e-mail do CLIENTE: lá há cadastro antigo fora
        do formato, e o formulário manda o e-mail em todo salvar — validar
        travaria a edição desses cadastros. Vazio/`None` = sem e-mail.
        """
        if v is None:
            return v
        v = v.strip()
        if v and not _EMAIL_CONTATO.match(v):
            raise ValueError("E-mail inválido. Use o formato nome@dominio.com.")
        return v


def tem_texto(*valores) -> bool:
    """Ao menos um dos valores é texto não vazio (espaços não contam)."""
    return any(isinstance(v, str) and v.strip() for v in valores)


class ClienteContatoCreate(_ContatoCampos):
    principal: bool = False

    _papel_valido = _lista_fechada("papel", CONTATO_PAPEIS, "Papel do contato")

    @model_validator(mode="after")
    def _identificavel(self):
        # Um contato sem nome, telefone e e-mail é uma linha vazia na ficha:
        # não identifica ninguém e não serve para contatar ninguém.
        if not tem_texto(self.nome, self.telefone, self.email):
            raise ValueError("Informe ao menos o nome, o telefone ou o e-mail do contato.")
        return self


class ClienteContatoUpdate(_ContatoCampos):
    # O "ao menos um de nome/telefone/e-mail" do PUT é conferido no router,
    # sobre o registro JÁ mesclado (o corpo do PUT traz só o que mudou).
    _papel_valido = _lista_fechada("papel", CONTATO_PAPEIS, "Papel do contato")


class ClienteContatoOut(BaseModel):
    id: int
    client_id: int
    nome: Optional[str] = None
    papel: Optional[str] = None
    cpf: Optional[str] = None
    telefone: Optional[str] = None
    email: Optional[str] = None
    observacao: Optional[str] = None
    principal: bool = False
    created_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)

    @field_validator("principal", mode="before")
    @classmethod
    def _principal_bool(cls, v):
        return bool(v)


class ProcessoParteCreate(BaseModel):
    nome: str
    tipo: str
    cpf_cnpj: Optional[str] = None
    polo: Optional[str] = None
    advogado: Optional[str] = None
    oab: Optional[str] = None
    observacoes: Optional[str] = None

    _nome = _obrigatorio("nome")
    _tipo_valido = _lista_fechada_obrigatoria("tipo", PARTE_TIPOS, "Tipo de parte")
    _polo_valido = _lista_fechada("polo", PARTE_POLOS, "Polo")
    _tam_150 = _tamanho_max(150, "nome", "advogado")
    _tam_30 = _tamanho_max(30, "oab")
    _tam_20 = _tamanho_max(20, "cpf_cnpj")


class ProcessoParteUpdate(BaseModel):
    nome: Optional[str] = None
    tipo: Optional[str] = None
    cpf_cnpj: Optional[str] = None
    polo: Optional[str] = None
    advogado: Optional[str] = None
    oab: Optional[str] = None
    observacoes: Optional[str] = None

    # Só rodam quando o campo VEM no corpo: `{"nome": null}` → 422, omitir → não mexe.
    _nome = _obrigatorio("nome")
    _tipo_valido = _lista_fechada_obrigatoria("tipo", PARTE_TIPOS, "Tipo de parte")
    _polo_valido = _lista_fechada("polo", PARTE_POLOS, "Polo")
    _tam_150 = _tamanho_max(150, "nome", "advogado")
    _tam_30 = _tamanho_max(30, "oab")
    _tam_20 = _tamanho_max(20, "cpf_cnpj")


class ProcessoParteOut(BaseModel):
    id: int
    process_id: int
    nome: str
    cpf_cnpj: Optional[str] = None
    tipo: str
    polo: Optional[str] = None
    advogado: Optional[str] = None
    oab: Optional[str] = None
    observacoes: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)


class ProcessoAndamentoCreate(BaseModel):
    data: date
    titulo: str
    descricao: Optional[str] = None

    _titulo = _obrigatorio("titulo")
    _tam_200 = _tamanho_max(200, "titulo")


class ProcessoAndamentoOut(BaseModel):
    id: int
    process_id: int
    data: date
    titulo: str
    descricao: Optional[str] = None
    autor_id: Optional[int] = None
    autor_nome: Optional[str] = None
    created_at: Optional[datetime] = None
