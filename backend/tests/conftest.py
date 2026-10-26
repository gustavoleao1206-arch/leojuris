"""Infraestrutura da suíte de testes do backend.

Três garantias, em ordem de importância:

1. 🚨 NUNCA TOCA BANCO REAL. O `config.py` lê `DATABASE_URL` NA IMPORTAÇÃO e o
   `main.py` roda `create_all()` + `migrate_db()` também na importação — ou
   seja, basta importar o app com a variável errada para escrever no banco
   errado. Por isso a variável é SOBRESCRITA aqui (nunca `setdefault`: quem
   tiver `DATABASE_URL` de produção exportada no terminal continuaria nela)
   ANTES de qualquer import do app, e logo depois há uma checagem que aborta a
   suíte se o engine não estiver apontando para o SQLite temporário.
   `backend/crm.db` não é aberto em momento nenhum.

2. NUNCA SAI PARA A REDE. Todo acesso externo do app passa por
   `urllib.request.urlopen` (DataJud, DJEN, Gemini, Clicksign) ou
   `smtplib.SMTP` (e-mail). Os dois são trocados por uma função que ESTOURA,
   e `socket.connect`/`getaddrinfo` também — rede de segurança para o dia em
   que alguém adicionar um cliente HTTP novo. Estourar, e não devolver um
   valor falso, é de propósito: um teste que dependa de rede sem saber falha
   alto, em vez de passar por acaso.

3. CADA TESTE COMEÇA DO ZERO. Todas as tabelas são esvaziadas e o limitador
   de tentativas (`ratelimit._hits`, que vive em memória) é zerado antes de
   cada teste — senão os logins de um teste contariam no limite do próximo.

Os usuários de teste recebem o token pelo MESMO caminho do login
(`routers.auth._claims` + `auth.create_access_token`). Só os testes de login
passam pela rota `/api/auth/login` de verdade — bcrypt é lento de propósito,
e fazer login em todo teste deixaria a suíte arrastada.
"""
import os
import shutil
import socket
import smtplib
import sys
import tempfile
import urllib.request
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import event

# --------------------------------------------------------------------------
# Ambiente — TEM que vir antes de qualquer `import app...`
# --------------------------------------------------------------------------
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    # Permite rodar `pytest` tanto de backend/ quanto da raiz do repositório.
    sys.path.insert(0, str(BACKEND_DIR))

_TMP = Path(tempfile.mkdtemp(prefix="crm-testes-"))
_DB_TESTE = _TMP / "teste.db"

os.environ["DATABASE_URL"] = f"sqlite:///{_DB_TESTE.as_posix()}"
os.environ["SECRET_KEY"] = "chave-exclusiva-dos-testes-" + "x" * 40
os.environ.pop("CRM_SECRET_KEY", None)
os.environ["ADMIN_PASSWORD"] = "senha-do-bootstrap-nao-usada"
os.environ["CORS_ORIGINS"] = "*"
# Sem threads de fundo: o scheduler do DataJud consultaria o CNJ.
os.environ["MONITOR_AUTOCHECK"] = "0"
os.environ["RETENCAO_AUTOEXEC"] = "0"
# Sem integrações configuradas, mesmo que o terminal de quem roda tenha as chaves.
for _var in ("GEMINI_API_KEY", "CLICKSIGN_ACCESS_TOKEN", "SMTP_USER", "SMTP_PASS"):
    os.environ.pop(_var, None)

from fastapi.routing import APIRoute, iter_route_contexts  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import auth as app_auth  # noqa: E402
from app import database, models, ratelimit  # noqa: E402
from app.main import app  # noqa: E402
from app.routers.auth import _claims  # noqa: E402
from app.scope import normalizar_permissoes  # noqa: E402

# Trava de segurança: se o engine não for o SQLite temporário, PARA TUDO.
_url = database.engine.url
if _url.get_backend_name() != "sqlite" or Path(_url.database).resolve() != _DB_TESTE.resolve():
    raise RuntimeError(
        f"Suíte abortada: o engine aponta para {_url!r}, não para o banco "
        f"temporário {_DB_TESTE}. Nenhum teste roda fora do banco isolado."
    )


# 🔗 Chave estrangeira LIGADA, como no PostgreSQL de produção. O SQLite não a
# aplica por padrão, e isso já escondeu um erro: excluir cliente com honorário
# passava aqui e estoura ForeignKeyViolation (500) no Postgres. Teste que só
# passa porque o banco é mais permissivo que o de produção é teste mentindo.
@event.listens_for(database.engine, "connect")
def _sqlite_com_chave_estrangeira(conexao_dbapi, _registro):
    conexao_dbapi.execute("PRAGMA foreign_keys=ON")


# As conexões abertas na importação (create_all/migrate_db) nasceram sem o PRAGMA.
database.engine.dispose()

SENHA = "Senha-Correta-123"
# Um hash só para todos os usuários: bcrypt custa ~0,2 s por chamada.
_HASH_SENHA = app_auth.hash_password(SENHA)


def pytest_sessionfinish(session, exitstatus):
    database.engine.dispose()          # no Windows o arquivo fica travado sem isto
    shutil.rmtree(_TMP, ignore_errors=True)


# --------------------------------------------------------------------------
# Garantias automáticas (valem para todo teste)
# --------------------------------------------------------------------------
class RedeBloqueada(RuntimeError):
    """Um teste tentou acessar a rede. A suíte precisa rodar offline."""


@pytest.fixture(autouse=True)
def _sem_rede(monkeypatch):
    def _bloqueado(*args, **kwargs):
        raise RedeBloqueada(f"acesso à rede bloqueado nos testes: {args[:1]!r}")

    monkeypatch.setattr(urllib.request, "urlopen", _bloqueado)
    monkeypatch.setattr(smtplib, "SMTP", _bloqueado)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _bloqueado)
    monkeypatch.setattr(socket, "getaddrinfo", _bloqueado)

    conectar_original = socket.socket.connect
    conectar_ex_original = socket.socket.connect_ex

    # O event loop Proactor do Windows monta o proprio self-pipe com um socket
    # em 127.0.0.1 -- sem esta excecao o TestClient (que sobe o loop) tropeca no
    # bloqueio e a suite inteira falha SO no Windows. Loopback nao e rede: nao
    # sai da maquina. Host externo (DataJud, DJEN, SMTP...) continua barrado.
    _LOOPBACK = ("127.0.0.1", "::1", "localhost")

    def _e_loopback(endereco):
        return isinstance(endereco, (tuple, list)) and bool(endereco) and endereco[0] in _LOOPBACK

    def _connect(self, endereco):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _e_loopback(endereco):
            _bloqueado(endereco)
        return conectar_original(self, endereco)

    def _connect_ex(self, endereco):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _e_loopback(endereco):
            _bloqueado(endereco)
        return conectar_ex_original(self, endereco)

    monkeypatch.setattr(socket.socket, "connect", _connect)
    monkeypatch.setattr(socket.socket, "connect_ex", _connect_ex)


@pytest.fixture(autouse=True)
def _banco_limpo():
    with database.engine.begin() as conn:
        for tabela in reversed(database.Base.metadata.sorted_tables):
            conn.execute(tabela.delete())
    ratelimit._hits.clear()
    yield


# --------------------------------------------------------------------------
# Fixtures básicas
# --------------------------------------------------------------------------
@pytest.fixture
def db():
    sessao = database.SessionLocal()
    try:
        yield sessao
    finally:
        sessao.close()


@pytest.fixture
def client():
    # Sem `with`: o evento de startup (bootstrap do admin + threads de
    # agendamento) não roda. Os usuários são criados pelas fixtures.
    return TestClient(app)


def rotas_api_do_app():
    """(método, caminho) de TODA rota HTTP do app, inclusive as dos routers.

    🚨 Não troque por `for r in app.routes`. Desde o FastAPI 0.137 o
    `include_router` não copia mais as rotas para o app: cada router incluído
    vira UM nó na lista, com as rotas dentro. Iterando `app.routes` direto, as
    varreduras de segurança (token obrigatório, DELETE × estagiário) passaram
    a enxergar só as rotas declaradas no próprio `main.py` — e o teste de
    token não falhou: ficou com zero casos e o pytest o PULOU em silêncio.
    `iter_route_contexts` é a API pública que o FastAPI criou para este uso e
    devolve o caminho efetivo (já com o prefixo do router).
    """
    for ctx in iter_route_contexts(app.routes):
        if isinstance(ctx.original_route, APIRoute):
            for metodo in sorted(ctx.methods or ()):
                yield metodo, ctx.path


def headers_de(user: models.User) -> dict:
    """Authorization de um usuário, emitido como o login emite."""
    token = app_auth.create_access_token(_claims(user))
    return {"Authorization": f"Bearer {token}"}


def criar_usuario(db, nome, email, role, permissions=None, **extra) -> models.User:
    u = models.User(
        name=nome, email=email, role=role, password_hash=_HASH_SENHA,
        permissions=permissions, **extra,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _salvar(db, obj):
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj.id


# Dados pessoais de exemplo. Todos fictícios; o CPF da fila é o que os testes
# de máscara procuram na resposta — se ele aparecer, vazou.
CPF_FILA = "111.111.111-11"
CPF_ANA = "222.222.222-22"
CPF_BRUNO = "333.333.333-33"


def _dados_requerente(sufixo, cpf):
    return dict(
        requerente_nome=f"Requerente {sufixo}",
        requerente_cpf=cpf,
        requerente_rg=f"RG-{sufixo}",
        requerente_telefone=f"(82) 90000-{sufixo[:4].ljust(4, '0')}",
        requerente_email=f"{sufixo.lower()}@exemplo.test",
        requerente_endereco=f"Rua {sufixo}, 100",
    )


def _dados_parte(sufixo, cpf):
    return dict(
        parte_nome=f"Parte {sufixo}",
        parte_cpf=cpf,
        parte_rg=f"RG-{sufixo}",
        parte_telefone=f"(82) 98888-{sufixo[:4].ljust(4, '0')}",
        parte_email=f"parte.{sufixo.lower()}@exemplo.test",
        parte_endereco=f"Avenida {sufixo}, 200",
    )


@pytest.fixture
def cenario(db):
    """O escritório de teste.

    Pessoas: um admin, dois advogados (Ana e Bruno — "dono" e "colega" nos
    testes de IDOR) e uma estagiária criada com o PRESET_ESTAGIARIO, como a
    tela cria hoje.

    Registros: para Precatórios e Ações, um caso NA FILA (owner_id nulo) e um
    de cada advogado; clientes, processos, prazos, agenda, documentos,
    honorários, assinaturas e contatos com dono definido — o suficiente para
    exercitar cada rota DELETE com um alvo que EXISTE (ver
    test_delete_estagiario.py).

    Os honorários e a assinatura do Bruno presos ao cliente da Ana reproduzem
    o caso real do painel 360: o admin transfere o cliente de um advogado para
    outro, e o que já estava lançado continua com o dono antigo.
    """
    admin = criar_usuario(db, "Admin Teste", "admin@teste.local", "admin")
    ana = criar_usuario(db, "Ana Advogada", "ana@teste.local", "advogado")
    bruno = criar_usuario(db, "Bruno Advogado", "bruno@teste.local", "advogado")
    estag = criar_usuario(
        db, "Estela Estagiária", "estela@teste.local", "estagiario",
        permissions=normalizar_permissoes(None, "estagiario"),
    )
    sem_vinculo = criar_usuario(db, "Sem Vínculo", "sem.vinculo@teste.local", "advogado")

    c = SimpleNamespace()
    c.admin, c.ana, c.bruno, c.estag, c.sem_vinculo = (
        admin.id, ana.id, bruno.id, estag.id, sem_vinculo.id
    )
    c.auth = {
        "admin": headers_de(admin),
        "ana": headers_de(ana),
        "bruno": headers_de(bruno),
        "estag": headers_de(estag),
    }

    # ---------------- Precatórios ----------------
    c.prec_fila = _salvar(db, models.Precatorio(
        **_dados_requerente("Fila", CPF_FILA), classificacao="com_alvara",
        numero_precatorio="0000001-11.2026.4.05.0000", owner_id=None,
    ))
    c.prec_ana = _salvar(db, models.Precatorio(
        **_dados_requerente("Ana", CPF_ANA), classificacao="com_alvara", owner_id=ana.id,
    ))
    c.prec_bruno = _salvar(db, models.Precatorio(
        **_dados_requerente("Bruno", CPF_BRUNO), classificacao="com_alvara", owner_id=bruno.id,
    ))
    c.contato_prec = _salvar(db, models.PrecatorioContato(
        precatorio_id=c.prec_ana, tipo="ligacao", descricao="Primeiro contato", owner_id=ana.id,
    ))

    # ---------------- Ações ----------------
    c.acao_fila = _salvar(db, models.Acao(**_dados_parte("Fila", CPF_FILA), area="civel", owner_id=None))
    c.acao_ana = _salvar(db, models.Acao(**_dados_parte("Ana", CPF_ANA), area="civel", owner_id=ana.id))
    c.acao_bruno = _salvar(db, models.Acao(**_dados_parte("Bruno", CPF_BRUNO), area="civel", owner_id=bruno.id))
    c.contato_acao = _salvar(db, models.AcaoContato(
        acao_id=c.acao_ana, tipo="ligacao", descricao="Primeiro contato", owner_id=ana.id,
    ))

    # ---------------- Clientes e o que pende deles ----------------
    c.cli_ana = _salvar(db, models.Client(name="Cliente da Ana", cpf_cnpj=CPF_ANA, owner_id=ana.id))
    c.cli_bruno = _salvar(db, models.Client(name="Cliente do Bruno", cpf_cnpj=CPF_BRUNO, owner_id=bruno.id))
    c.proc_ana = _salvar(db, models.Process(client_id=c.cli_ana, case_number="PROC-ANA", owner_id=ana.id))
    c.proc_bruno = _salvar(db, models.Process(client_id=c.cli_bruno, case_number="PROC-BRUNO", owner_id=bruno.id))

    c.prazo_ana = _salvar(db, models.Deadline(
        process_id=c.proc_ana, date=date(2026, 12, 1), description="Contestação", owner_id=ana.id,
    ))
    c.agenda_ana = _salvar(db, models.Appointment(
        process_id=c.proc_ana, date_time=datetime(2026, 12, 2, 14, 0), location="Fórum", owner_id=ana.id,
    ))
    c.doc_ana = _salvar(db, models.Document(
        client_id=c.cli_ana, original_name="rg.pdf", categoria="documento_pessoal",
        file_path=str(_TMP / "arquivo-que-nao-existe.pdf"), owner_id=ana.id,
    ))

    # ---------------- Ficha única (atendimento, contato, parte, andamento) ----------------
    # Pendurados em cli_ana/proc_ana: são os alvos das 4 rotas DELETE novas em
    # ROTAS_DELETE. O atendimento aponta para o proc_ana de propósito — o
    # controle do admin apaga o proc_ana, e isso exercita o caminho real do ORM
    # anulando `atendimentos.process_id` (com a FK ligada, como no Postgres).
    c.atend_ana = _salvar(db, models.Atendimento(
        client_id=c.cli_ana, process_id=c.proc_ana, tipo="ligacao",
        descricao="Cliente ligou pedindo notícias", autor_id=ana.id,
    ))
    c.contato_cli_ana = _salvar(db, models.ClienteContato(
        client_id=c.cli_ana, nome="Maria Representante", papel="representante_legal",
        telefone="(82) 97777-0000", principal=1,
    ))
    c.parte_ana = _salvar(db, models.ProcessoParte(
        process_id=c.proc_ana, nome="Empresa Ré Ltda", tipo="contraria", polo="passivo",
    ))
    c.andamento_ana = _salvar(db, models.ProcessoAndamento(
        process_id=c.proc_ana, data=date(2026, 9, 15), titulo="Petição inicial protocolada",
        autor_id=ana.id,
    ))

    # Honorários ligados ao cliente da Ana: um dela, um SÓ do Bruno e uma
    # parceria em que o Bruno é o dono e a Ana a parceira (30%).
    c.hon_ana = _salvar(db, models.Honorario(
        client_id=c.cli_ana, total_value=1000, paid_value=0, status="pendente",
        notes="Honorário da Ana", owner_id=ana.id, created_by=ana.id,
    ))
    c.hon_bruno = _salvar(db, models.Honorario(
        client_id=c.cli_ana, total_value=50000, paid_value=50000, status="pago",
        notes="Honorário SÓ do Bruno", owner_id=bruno.id, created_by=bruno.id,
    ))
    c.hon_parceria = _salvar(db, models.Honorario(
        client_id=c.cli_ana, total_value=10000, paid_value=4000, status="parcial",
        notes="Parceria Bruno + Ana", owner_id=bruno.id, created_by=bruno.id,
        origem="parceria", parceiro_id=ana.id, pct_escritorio=70, pct_parceiro=30,
    ))

    c.assin_ana = _salvar(db, models.Assinatura(
        titulo="Procuração — Cliente da Ana", tipo="procuracao", area="civel",
        client_id=c.cli_ana, status="rascunho", owner_id=ana.id,
    ))
    c.assin_bruno = _salvar(db, models.Assinatura(
        titulo="Contrato do Bruno", tipo="contrato", area="civel",
        client_id=c.cli_ana, status="assinado", owner_id=bruno.id,
    ))

    # ---------------- Módulos só do admin ----------------
    c.monitor = _salvar(db, models.Monitor(numero="00000011120264050000", tribunal="trf5"))
    c.oab = _salvar(db, models.OabMonitorada(numero="12345", uf="AL", nome="OAB de teste"))

    return c
