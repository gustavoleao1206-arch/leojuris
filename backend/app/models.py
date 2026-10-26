"""Modelos do banco de dados (tabelas) do CRM Jurídico.

Relacionamentos principais:
- Um Cliente possui muitos Processos e muitos Documentos.
- Um Processo pertence a um Cliente e possui muitos Prazos, Audiências e Documentos.
- Todo Prazo está ligado a um Processo.
- Todo Documento está ligado a um Cliente e/ou Processo.
"""
from datetime import datetime

from sqlalchemy import (
    Column,
    Integer,
    Float,
    String,
    Text,
    DateTime,
    Date,
    ForeignKey,
)
from sqlalchemy.orm import relationship

from .database import Base
from .prazos import agora_local


class User(Base):
    """Usuários do sistema (advogados / administradores)."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    email = Column(String(120), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(40), default="advogado")  # admin | advogado
    totp_secret = Column(String(64), nullable=True)        # segredo do 2FA (TOTP)
    # Segredo NOVO esperando confirmação (out/2026). O /2fa/setup grava aqui;
    # só o /2fa/enable, com um código DESTA chave, o promove a `totp_secret`.
    # Até lá o login e o /2fa/disable seguem conferindo o segredo atual. A
    # coluna sobe pelo `main._migrar_colunas_ficha` (ver COLUNAS_USUARIO).
    # 🔒 Nunca entra em schema de saída: é segredo, como o `totp_secret`.
    totp_pending_secret = Column(String(64), nullable=True)
    totp_enabled = Column(Integer, default=0)              # 0 = desativado, 1 = ativado (2FA)
    avatar = Column(Text, nullable=True)                   # foto de perfil (data URI base64)
    # Permissões granulares (JSON serializado em texto).
    # NULL ou vazio = acesso total (mantém compatibilidade com usuários antigos).
    # O admin ignora este campo: sempre enxerga e edita tudo.
    # Formato:
    #   {
    #     "modules": {"precatorios": {"view": true, "edit": false}, ...},
    #     "precatorios_classificacoes": ["com_alvara"],   # [] ou ausente = todas
    #     "acoes_areas": ["civel"]                         # [] ou ausente = todas
    #   }
    permissions = Column(Text, nullable=True)
    # Revogação de sessão. O JWT carrega este número; qualquer incremento
    # invalida na hora TODOS os tokens já emitidos para o usuário.
    # Sem isso, trocar a senha (ou demitir alguém) deixava o token antigo
    # funcionando por até 8 horas — achado da auditoria de ago/2026.
    token_version = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Client(Base):
    """Clientes do escritório. O campo status alimenta o funil de clientes."""
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(150), nullable=False)
    cpf_cnpj = Column(String(20))
    phone = Column(String(40))
    email = Column(String(120))
    # Status / etapa do funil: lead | negociacao | ativo | arquivado
    status = Column(String(30), default="lead", index=True)
    notes = Column(Text)

    # --- Dados pessoais (Fase 8) ---
    rg = Column(String(30))
    orgao_expedidor = Column(String(40))
    data_nascimento = Column(Date)
    sexo = Column(String(20))
    estado_civil = Column(String(30))
    nacionalidade = Column(String(60))
    profissao = Column(String(80))
    # --- Dados trabalhistas ---
    pis_pasep = Column(String(30))
    ctps = Column(String(40))
    # --- Contato ---
    celular = Column(String(40))
    telefone_secundario = Column(String(40))
    whatsapp = Column(String(40))
    # --- Endereço ---
    cep = Column(String(12))
    estado = Column(String(40))
    cidade = Column(String(80))
    bairro = Column(String(80))
    rua = Column(String(160))
    numero = Column(String(20))
    complemento = Column(String(80))
    # --- Ficha única (out/2026): PF/PJ e captação ---
    # Colunas criadas pelo migrate_db (main.py) nos bancos que já existem.
    tipo_pessoa = Column(String(2))        # PF | PJ (scope.TIPOS_PESSOA)
    nome_fantasia = Column(String(150))    # só PJ
    origem = Column(String(30))            # canal de captação (scope.CLIENTE_ORIGENS)
    indicado_por = Column(String(150))     # quem indicou, quando origem = indicação

    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # advogado responsável
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relacionamentos
    processes = relationship(
        "Process", back_populates="client", cascade="all, delete-orphan"
    )
    documents = relationship(
        "Document", back_populates="client", cascade="all, delete-orphan"
    )
    # Tabelas-filhas da ficha: SEM a cascata, excluir o cliente estouraria FK
    # (500 no Postgres) assim que ele tivesse um atendimento registrado.
    atendimentos = relationship(
        "Atendimento", back_populates="client", cascade="all, delete-orphan",
        foreign_keys="Atendimento.client_id",
    )
    contatos = relationship(
        "ClienteContato", back_populates="client", cascade="all, delete-orphan",
    )


class Process(Base):
    """Processos jurídicos. Todo processo está vinculado a um cliente."""
    __tablename__ = "processes"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    case_number = Column(String(60))  # número do processo (CNJ)
    type = Column(String(40))  # área: civel | trabalhista | previdenciario | familia | consumidor | outros
    subcategoria = Column(String(80))  # subcategoria da área (ex.: Cobrança, Horas Extras)
    classe = Column(String(120))  # classe processual (ex.: Procedimento Comum Cível)
    assunto = Column(String(200))  # assunto principal
    foro = Column(String(160))  # foro/comarca
    vara = Column(String(120))  # vara
    tribunal = Column(String(120))  # tribunal (ex.: TJSP, TRT-2)
    orgao_julgador = Column(String(160))  # órgão julgador
    data_distribuicao = Column(Date)  # data de distribuição
    fase_processual = Column(String(60))  # fase (ex.: conhecimento, recursal, execução)
    sistema_eletronico = Column(String(40))  # PJe | e-Proc | Projudi | e-SAJ | CRETA | Apolo | Tucujuris | Outros
    valor_causa = Column(Float)  # valor da causa
    status = Column(String(30), default="ativo", index=True)  # ativo | suspenso | encerrado
    description = Column(Text)  # observações
    # --- Ficha única (out/2026) --- colunas criadas pelo migrate_db (main.py)
    polo_cliente = Column(String(20))  # em que polo o cliente está (scope.PARTE_POLOS)
    instancia = Column(String(20))     # primeiro_grau | segundo_grau | superior (scope.INSTANCIAS)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # advogado responsável
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relacionamentos
    client = relationship("Client", back_populates="processes")
    deadlines = relationship(
        "Deadline", back_populates="process", cascade="all, delete-orphan"
    )
    appointments = relationship(
        "Appointment", back_populates="process", cascade="all, delete-orphan"
    )
    documents = relationship("Document", back_populates="process")
    partes = relationship(
        "ProcessoParte", back_populates="process", cascade="all, delete-orphan",
    )
    andamentos = relationship(
        "ProcessoAndamento", back_populates="process", cascade="all, delete-orphan",
    )
    # 🚨 SEM delete, de propósito: o atendimento é do CLIENTE e o processo é só
    # um vínculo opcional. Ao excluir o processo o ORM anula o `process_id` e o
    # histórico fica no cliente. A relação precisa existir mesmo assim — sem
    # ela o ORM não sabe que há linhas apontando para cá e o DELETE estoura FK.
    atendimentos = relationship(
        "Atendimento", back_populates="process",
        foreign_keys="Atendimento.process_id",
    )


class Atendimento(Base):
    """Histórico de atendimento do cliente (ligação, reunião, WhatsApp, nota...).

    🚨 NÃO TEM DONO. `autor_id` é só autoria: a visibilidade e a edição herdam
    do CLIENTE da URL. Nunca aplique `scope()`/`ensure_owner` aqui — com isso o
    advogado deixaria de ver, na ficha do PRÓPRIO cliente, o atendimento que a
    estagiária registrou (ela é quem mais registra), sem erro nenhum na tela.
    """
    __tablename__ = "atendimentos"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    # Opcional: o atendimento pode ser sobre um processo específico do cliente.
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=True, index=True)
    # Hora LOCAL (Brasília), como o navegador manda — ver prazos.agora_local.
    data = Column(DateTime, nullable=False, default=agora_local)
    tipo = Column(String(20), nullable=False, default="nota")  # scope.ATENDIMENTO_TIPOS
    descricao = Column(Text, nullable=False)
    proximo_retorno = Column(Date, nullable=True)   # "agendar retorno"
    autor_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="atendimentos", foreign_keys=[client_id])
    process = relationship("Process", back_populates="atendimentos", foreign_keys=[process_id])


class ClienteContato(Base):
    """Contatos adicionais e representantes do cliente (sócio, procurador...).

    Dado pessoal novo (LGPD): fica FORA do `ia._snapshot` e do export até
    decisão do dono. Sem dono próprio — herda do cliente, como o atendimento.
    """
    __tablename__ = "cliente_contatos"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    nome = Column(String(150))
    papel = Column(String(30))          # scope.CONTATO_PAPEIS
    cpf = Column(String(20))
    telefone = Column(String(40))
    email = Column(String(120))
    observacao = Column(Text)
    principal = Column(Integer, default=0)   # 1 = contato principal (um por cliente)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="contatos")


class ProcessoParte(Base):
    """Partes do processo além do cliente (parte contrária, litisconsorte...).

    Sem dono próprio: herda do PROCESSO da URL.
    """
    __tablename__ = "processo_partes"

    id = Column(Integer, primary_key=True, index=True)
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=False, index=True)
    nome = Column(String(150), nullable=False)
    cpf_cnpj = Column(String(20))
    tipo = Column(String(20), nullable=False)   # scope.PARTE_TIPOS
    polo = Column(String(20), nullable=True)    # scope.PARTE_POLOS
    advogado = Column(String(150))              # advogado da parte (texto livre)
    oab = Column(String(30))
    observacoes = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)

    process = relationship("Process", back_populates="partes")


class ProcessoAndamento(Base):
    """Andamento registrado à mão na ficha do processo.

    🚨 NÃO TEM DONO, pela mesma razão do Atendimento: `autor_id` é só autoria e
    o acesso herda do PROCESSO da URL.
    """
    __tablename__ = "processo_andamentos"

    id = Column(Integer, primary_key=True, index=True)
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=False, index=True)
    data = Column(Date, nullable=False)          # data do andamento (pura, sem hora)
    titulo = Column(String(200), nullable=False)
    descricao = Column(Text)
    autor_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    process = relationship("Process", back_populates="andamentos")


class Deadline(Base):
    """Prazos legais. Todo prazo está vinculado a um processo."""
    __tablename__ = "deadlines"

    id = Column(Integer, primary_key=True, index=True)
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=False, index=True)
    date = Column(Date, nullable=False)
    description = Column(String(255), nullable=False)
    urgency_level = Column(String(20), default="media")  # baixa | media | alta
    done = Column(Integer, default=0)  # 0 = pendente, 1 = cumprido
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # advogado responsável
    created_at = Column(DateTime, default=datetime.utcnow)

    process = relationship("Process", back_populates="deadlines")


class Appointment(Base):
    """Audiências / compromissos. Vinculados a um processo."""
    __tablename__ = "appointments"

    id = Column(Integer, primary_key=True, index=True)
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=False, index=True)
    date_time = Column(DateTime, nullable=False)
    location = Column(String(200))
    notes = Column(Text)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # advogado responsável
    created_at = Column(DateTime, default=datetime.utcnow)

    process = relationship("Process", back_populates="appointments")


class Document(Base):
    """Documentos enviados. Vinculados a um cliente e/ou processo."""
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=True, index=True)
    precatorio_id = Column(Integer, ForeignKey("precatorios.id"), nullable=True, index=True)
    acao_id = Column(Integer, ForeignKey("acoes.id"), nullable=True, index=True)
    categoria = Column(String(40))  # lista fechada: schemas.DOC_CATEGORIAS
    original_name = Column(String(255))
    file_path = Column(String(500), nullable=False)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # advogado responsável
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="documents")
    process = relationship("Process", back_populates="documents")


class Honorario(Base):
    """Honorários (módulo Financeiro). Pode ser vinculado a cliente e/ou processo."""
    __tablename__ = "honorarios"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    # 🚨 O caso pode morar em QUALQUER uma das três tabelas — processes,
    # precatorios ou acoes. Até set/2026 só `process_id` era oferecido na tela,
    # e como a carteira é majoritariamente de precatórios o campo "Processo
    # vinculado" parecia estar escondendo registros: ele nunca conheceu as
    # outras duas tabelas. Os três são mutuamente exclusivos na prática (a tela
    # deixa escolher um), mas o banco não impõe isso — quem valida é
    # `financeiro._validar_vinculos`.
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=True, index=True)
    acao_id = Column(Integer, ForeignKey("acoes.id"), nullable=True, index=True)
    precatorio_id = Column(Integer, ForeignKey("precatorios.id"), nullable=True, index=True)
    type = Column(String(20), default="contratual")  # contratual | extrajudicial
    total_value = Column(Float, default=0)
    paid_value = Column(Float, default=0)
    status = Column(String(20), default="pendente")  # pago | parcial | pendente
    due_date = Column(Date, nullable=True)
    notes = Column(Text)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)   # advogado responsável
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # usuário que criou
    # Modelo de parceria
    origem = Column(String(20), default="proprio")    # proprio | parceria
    parceiro_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # advogado parceiro
    pct_escritorio = Column(Float)                    # % do escritório
    pct_parceiro = Column(Float)                      # % do advogado parceiro
    # Rateio de sócios (honorário de precatório). Quando rateio=1, o valor recebido
    # é distribuído em cascata: reserva -> parceiro -> fundo + sócios.
    rateio = Column(Integer, default=0)               # 0 = simples | 1 = distribui entre sócios
    pct_reserva = Column(Float, nullable=True)        # snapshot do % de caixa reserva usado
    rateio_config = Column(Text, nullable=True)       # snapshot JSON da regra interna (fundo + sócios)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client")
    process = relationship("Process")
    acao = relationship("Acao")
    precatorio = relationship("Precatorio")
    rateios = relationship(
        "HonorarioRateio", back_populates="honorario",
        cascade="all, delete-orphan",
    )


class Precatorio(Base):
    """Precatório Federal — página de gestão de caso completa.

    Reúne dados do requerente, dados processuais, classificação do precatório,
    gestão comercial (funil próprio) e vínculos de documentos/contatos.
    """
    __tablename__ = "precatorios"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)  # cliente vinculado (opcional)

    # ----- Dados do requerente -----
    requerente_nome = Column(String(160), index=True)
    requerente_cpf = Column(String(20), index=True)
    requerente_rg = Column(String(30))
    requerente_nascimento = Column(Date, nullable=True)
    requerente_telefone = Column(String(40))
    requerente_email = Column(String(120))
    requerente_endereco = Column(Text)

    # ----- Dados processuais -----
    processo_id = Column(String(60))          # ID interno do processo (texto livre)
    numero_originario = Column(String(60))    # nº do processo originário
    numero_precatorio = Column(String(60))    # nº do precatório
    tribunal = Column(String(10))             # TRF1..TRF5
    vara = Column(String(120))
    classe = Column(String(120))
    tema = Column(String(200))
    assunto = Column(String(200))
    observacoes = Column(Text)                # observações processuais
    banco = Column(String(20))                # caixa | bb

    # ----- Classificação do precatório -----
    # habilitacao_herdeiros | cancelado | reexpedicao | com_alvara | sem_alvara
    classificacao = Column(String(30))
    status_precatorio = Column(String(20), default="sem_alvara")  # legado: sem_alvara | com_alvara

    # ----- Gestão comercial (funil próprio) -----
    # novo_lead | negociacao | doc_pendente | assinatura | fechado | perdido | arquivado
    status_lead = Column(String(20), default="novos_leads")
    probabilidade = Column(Integer)           # legado (0-100)
    probabilidade_nivel = Column(String(20))  # pouco_provavel | possivel | muito_provavel
    valor_caso = Column(Float)                # valor do caso (R$)
    percentual_honorarios = Column(Float)     # % de honorários contratado
    data_ultimo_contato = Column(Date, nullable=True)
    data_proximo_contato = Column(Date, nullable=True)
    advogado = Column(String(120))            # nome livre (legado)
    anotacoes = Column(Text)                  # anotações comerciais

    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # advogado responsável
    created_at = Column(DateTime, default=datetime.utcnow)

    contatos = relationship(
        "PrecatorioContato", back_populates="precatorio",
        cascade="all, delete-orphan", order_by="PrecatorioContato.data.desc()",
    )


class PrecatorioContato(Base):
    """Histórico de contatos comerciais de um precatório."""
    __tablename__ = "precatorio_contatos"

    id = Column(Integer, primary_key=True, index=True)
    precatorio_id = Column(Integer, ForeignKey("precatorios.id"), nullable=False, index=True)
    data = Column(DateTime, default=datetime.utcnow)
    tipo = Column(String(20), default="ligacao")  # ligacao | whatsapp | email | reuniao | outro
    descricao = Column(Text)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    precatorio = relationship("Precatorio", back_populates="contatos")


class Assinatura(Base):
    """Documento gerado para assinatura (procuração/contrato) e seu status.

    O envio ao Clicksign é preparado para uma etapa futura (campo clicksign_key).
    """
    __tablename__ = "assinaturas"

    id = Column(Integer, primary_key=True, index=True)
    titulo = Column(String(200))
    tipo = Column(String(20))   # procuracao | contrato
    area = Column(String(20))   # precatorios | civel | trabalhista
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    precatorio_id = Column(Integer, ForeignKey("precatorios.id"), nullable=True, index=True)
    signatario_nome = Column(String(160))
    signatario_cpf = Column(String(20))
    signatario_email = Column(String(120))
    # rascunho | enviado | visualizado | assinado | recusado | expirado
    status = Column(String(20), default="rascunho")
    file_path = Column(String(500))           # PDF gerado
    clicksign_key = Column(String(120))        # uso futuro (Clicksign)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Acao(Base):
    """Ação judicial geral — página de gestão de caso (espelha o Precatório).

    Áreas: cível, trabalhista, previdenciário, consumidor, bancário, tributário,
    família, sucessões e outras.
    """
    __tablename__ = "acoes"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)  # cliente vinculado (opcional)
    area = Column(String(30))                  # civel | trabalhista | previdenciario | ...

    # ----- Parte / cliente -----
    parte_nome = Column(String(160), index=True)
    parte_cpf = Column(String(20), index=True)
    parte_rg = Column(String(30))
    parte_nascimento = Column(Date, nullable=True)
    parte_telefone = Column(String(40))
    parte_email = Column(String(120))
    parte_endereco = Column(Text)

    # ----- Dados processuais -----
    numero_processo = Column(String(60))
    vara = Column(String(120))
    comarca = Column(String(120))
    classe = Column(String(120))
    assunto = Column(String(200))
    observacoes = Column(Text)
    valor_causa = Column(Float)
    percentual_honorarios = Column(Float)

    # ----- Gestão comercial -----
    status_lead = Column(String(20), default="novos_leads")
    probabilidade_nivel = Column(String(20))   # pouco_provavel | possivel | muito_provavel
    data_ultimo_contato = Column(Date, nullable=True)
    data_proximo_contato = Column(Date, nullable=True)
    anotacoes = Column(Text)

    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # responsável
    created_at = Column(DateTime, default=datetime.utcnow)

    contatos = relationship(
        "AcaoContato", back_populates="acao",
        cascade="all, delete-orphan", order_by="AcaoContato.data.desc()",
    )


class AcaoContato(Base):
    """Histórico de contatos comerciais de uma ação."""
    __tablename__ = "acao_contatos"

    id = Column(Integer, primary_key=True, index=True)
    acao_id = Column(Integer, ForeignKey("acoes.id"), nullable=False, index=True)
    data = Column(DateTime, default=datetime.utcnow)
    tipo = Column(String(20), default="ligacao")
    descricao = Column(Text)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    acao = relationship("Acao", back_populates="contatos")


class Monitor(Base):
    """Processo monitorado via API Pública do DataJud (CNJ)."""
    __tablename__ = "monitores"

    id = Column(Integer, primary_key=True, index=True)
    numero = Column(String(40))          # número CNJ (com ou sem formatação)
    tribunal = Column(String(20))        # alias DataJud: trf1, tjsp, trt2 ...
    descricao = Column(String(200))      # rótulo livre (ex.: cliente/assunto)
    last_checked = Column(DateTime, nullable=True)
    last_movement = Column(String(400))  # nome da última movimentação
    last_movement_date = Column(String(40))
    movements_json = Column(Text)        # snapshot das movimentações (JSON)
    has_news = Column(Integer, default=0)  # 1 = há movimentação nova ainda não vista
    created_at = Column(DateTime, default=datetime.utcnow)


class AuditLog(Base):
    """Trilha de auditoria: registra ações de criação/edição/exclusão na API."""
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    method = Column(String(10))          # POST | PUT | DELETE
    path = Column(String(300))           # rota acessada
    status = Column(Integer)             # código HTTP da resposta
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class OabMonitorada(Base):
    """OAB do escritório monitorada no DJEN (captura tudo no nome do advogado)."""
    __tablename__ = "oabs_monitoradas"

    id = Column(Integer, primary_key=True, index=True)
    numero = Column(String(20), index=True)   # só dígitos, ex.: "12345"
    uf = Column(String(2))                     # ex.: "AL"
    nome = Column(String(160))                 # rótulo livre (ex.: nome do advogado)
    ativo = Column(Integer, default=1)         # 1 = sincroniza; 0 = pausado
    created_at = Column(DateTime, default=datetime.utcnow)


class Publicacao(Base):
    """Publicação/intimação capturada no DJEN (Diário de Justiça Eletrônico Nacional).

    Fonte oficial de onde correm os prazos (desde 16/05/2025). Guarda o inteiro
    teor e permite vincular a cliente/processo e gerar um prazo sugerido.
    """
    __tablename__ = "publicacoes"

    id = Column(Integer, primary_key=True, index=True)
    external_id = Column(String(40), index=True)   # id da comunicação no DJEN (dedupe)
    hash = Column(String(80), index=True)          # hash do DJEN (dedupe secundário)
    tribunal = Column(String(20))                  # siglaTribunal
    numero_processo = Column(String(40), index=True)  # com máscara
    tipo_comunicacao = Column(String(60))          # Citação | Intimação | ...
    orgao = Column(String(200))
    classe = Column(String(200))
    meio = Column(String(40))
    data_disponibilizacao = Column(Date, index=True)
    texto = Column(Text)                           # inteiro teor (já sem entidades HTML)
    link = Column(Text)
    destinatarios = Column(Text)                   # JSON: advogados + partes
    oab_captura = Column(String(24))               # ex.: "12345/AL" — qual OAB capturou
    # Vínculos e workflow
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=True, index=True)
    process_id = Column(Integer, ForeignKey("processes.id"), nullable=True, index=True)
    deadline_id = Column(Integer, ForeignKey("deadlines.id"), nullable=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    lida = Column(Integer, default=0)              # 0 = nova; 1 = já vista
    # 🚨 ARQUIVAR em vez de APAGAR, e a razão é técnica, não de gosto.
    #
    # A deduplicação da sincronização (publicacoes.py) monta o conjunto de
    # `external_id`/`hash` a partir das linhas QUE EXISTEM no banco. Apagar de
    # verdade tira a linha do conjunto — e como a busca do DJEN varre uma janela
    # FIXA de 30 dias e roda sozinha ao abrir o CRM (a cada ~6h), tudo que fosse
    # apagado dentro dessa janela voltaria na sincronização seguinte, e voltaria
    # como NÃO LIDA. O "excluir" pioraria exatamente a poluição que ele resolve.
    #
    # A linha arquivada continua no conjunto de dedupe: some da tela e não volta.
    # E preserva a intimação, que é a prova de quando o prazo começou a correr.
    arquivada = Column(Integer, default=0, index=True, nullable=False, server_default="0")
    created_at = Column(DateTime, default=datetime.utcnow)


class PublicacaoExcluida(Base):
    """Impressão digital de uma publicação do DJEN EXCLUÍDA em definitivo.

    🚨 Por que esta tabela existe, e por que ela não guarda o teor.

    A deduplicação da sincronização (publicacoes.py) monta o conjunto de
    `external_id`/`hash` a partir das linhas que EXISTEM. Se a exclusão apenas
    apagasse a Publicacao, a chave sairia do conjunto — e como o DJEN varre uma
    janela FIXA de 30 dias sozinho a cada ~6h, tudo que fosse excluído dentro
    dessa janela VOLTARIA na sincronização seguinte, como não lida. Foi por isso
    que o sistema nasceu só com "arquivar" (Publicacao.arquivada).

    Guardar aqui a chave (e só a chave, mais uns campos de rastro) permite a
    exclusão DE VERDADE da publicação sem a ressurreição: a dedupe passa a
    consultar também esta tabela (_chaves_existentes). O inteiro teor — que é o
    que o dono quer sumir — some com a Publicacao. Fica um rastro mínimo
    (processo, data, quem excluiu) porque a intimação é prova de quando o prazo
    começou; a trilha de auditoria (AuditLog) registra o evento em paralelo.
    """
    __tablename__ = "publicacoes_excluidas"

    id = Column(Integer, primary_key=True, index=True)
    external_id = Column(String(40), index=True)   # chave primária de dedupe do DJEN
    hash = Column(String(80), index=True)          # chave secundária de dedupe
    numero_processo = Column(String(40))           # rastro: qual processo
    tribunal = Column(String(20))
    data_disponibilizacao = Column(Date)           # rastro: quando o prazo teria começado
    oab_captura = Column(String(24))
    deleted_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    deleted_at = Column(DateTime, default=datetime.utcnow)


class Setting(Base):
    """Configurações globais do sistema (chave -> valor JSON em texto).

    Usada, entre outras coisas, para a regra de distribuição de honorários.
    """
    __tablename__ = "settings"

    key = Column(String(80), primary_key=True)
    value = Column(Text)                 # JSON serializado
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class HonorarioRateio(Base):
    """Livro-razão do rateio de um honorário (uma linha por destinatário).

    Cada linha é uma fatia calculada em cascata sobre o valor recebido:
    Caixa Reserva, Advogado parceiro, Fundo e cada sócio. É a fonte de verdade
    para o dashboard (parte real de cada um) e para recibos/auditoria.
    """
    __tablename__ = "honorario_rateios"

    id = Column(Integer, primary_key=True, index=True)
    honorario_id = Column(Integer, ForeignKey("honorarios.id"), nullable=False, index=True)
    tipo = Column(String(20))            # reserva | parceiro | fundo | socio
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # parceiro/sócio
    nome = Column(String(120))           # rótulo no momento do cálculo (snapshot)
    pct = Column(Float)                  # % aplicado na etapa
    base = Column(Float)                 # valor sobre o qual o % incidiu
    valor = Column(Float)                # R$ desta fatia
    created_at = Column(DateTime, default=datetime.utcnow)

    honorario = relationship("Honorario", back_populates="rateios")
