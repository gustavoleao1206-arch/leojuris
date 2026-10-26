"""Ponto de entrada da aplicação CRM Jurídico (FastAPI).

Inicializa o banco, cria um admin inicial se necessário, registra os routers
da API e serve o frontend estático (HTML + Bootstrap). Roda igual em local
(SQLite) e em produção (PostgreSQL no Render).
"""
import base64
import hashlib
import mimetypes
import os
import re

# A imagem de producao (python:3.11-slim) nao tem /etc/mime.types e o mimetypes
# do 3.11 nao conhece .woff2 - o StaticFiles serviria as fontes auto-hospedadas
# como text/plain. Navegador aceita (nosniff nao bloqueia fonte), mas MIME certo
# nao pode depender do SO onde o container roda. No Windows local o registro do
# sistema mascarava isso: so' apareceria no Render.
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, Response

from .config import FRONTEND_DIR, CORS_ORIGINS, ADMIN_EMAIL, ADMIN_PASSWORD, IS_SQLITE
from .database import Base, engine, SessionLocal
from . import models
from .auth import hash_password, verify_password
from .routers import (
    auth,
    config,
    clients,
    processes,
    deadlines,
    appointments,
    documents,
    pipeline,
    financeiro,
    precatorios,
    monitor,
    publicacoes,
    export,
    auditoria,
    assinaturas,
    acoes,
    ia,
    ficha,
)

# Cria as tabelas no banco (caso ainda não existam).
# Funciona tanto para SQLite quanto para PostgreSQL.
Base.metadata.create_all(bind=engine)


# Colunas da ficha única de Cliente e Processo (out/2026). Tipos portáveis
# (valem igual no SQLite local e no PostgreSQL do Render), todas anuláveis e
# sem DEFAULT: registro antigo fica com NULL, que a tela trata como "não
# preenchido".
COLUNAS_FICHA = {
    "clients": {
        "tipo_pessoa": "VARCHAR(2)",
        "nome_fantasia": "VARCHAR(150)",
        "origem": "VARCHAR(30)",
        "indicado_por": "VARCHAR(150)",
    },
    "processes": {
        "polo_cliente": "VARCHAR(20)",
        "instancia": "VARCHAR(20)",
    },
}

# Segredo do 2FA esperando confirmação (out/2026, ver routers/auth.py). Segue a
# MESMA régua das colunas da ficha, e com mais razão: `User` mapeia a coluna, e
# sem ela todo select de usuário dá 500 — o login inclusive, ninguém entraria.
# Por isso ela também é conferida na subida (`conferir_colunas_ficha`).
COLUNAS_USUARIO = {
    "users": {
        "totp_pending_secret": "VARCHAR(64)",
    },
}


def _migrar_colunas_ficha():
    """Cria as colunas da ficha UMA A UMA, cada uma na sua transação.

    🚨 POR QUE NÃO ENTRAM NO BLOCO DO `migrate_db` LOGO ABAIXO. Ali todos os
    ALTERs rodam numa transação só e qualquer exceção é engolida em silêncio:
    no PostgreSQL, um ALTER que falhe aborta a transação e cancela os outros
    junto. Para estas colunas isso derrubaria o CRM inteiro, sem log nenhum —
    elas estão mapeadas em `Client`/`Process`, então TODO select desses
    modelos (lista de clientes, processos, prazos, agenda, financeiro, que
    carregam o processo/cliente) passaria a dar 500 "column does not exist".

    Aqui cada coluna é independente: uma que falhe não impede as outras, e o
    erro vai para o log do Render com o traceback (`logging.exception`) em vez
    de sumir. Usa o `engine` do módulo no momento da chamada — é o que permite
    ao teste (tests/test_migracao_ficha.py) apontá-lo para um banco antigo.

    Cria também `COLUNAS_USUARIO` (2FA), pelo mesmo motivo: `User` a mapeia.
    """
    import logging
    from sqlalchemy import inspect as sa_inspect, text

    log = logging.getLogger("crm.migracao")
    for rotulo, mapa in (("migração da ficha", COLUNAS_FICHA), ("migração do 2FA", COLUNAS_USUARIO)):
        for tabela, colunas in mapa.items():
            try:
                existentes = {c["name"] for c in sa_inspect(engine).get_columns(tabela)}
            except Exception:
                log.exception("%s: não consegui ler as colunas de %s", rotulo, tabela)
                continue
            for coluna, tipo in colunas.items():
                if coluna in existentes:
                    continue
                try:
                    with engine.begin() as conn:
                        conn.execute(text(f"ALTER TABLE {tabela} ADD COLUMN {coluna} {tipo}"))
                    log.info("%s: coluna %s.%s criada", rotulo, tabela, coluna)
                except Exception:
                    log.exception("%s: falhou ao criar %s.%s", rotulo, tabela, coluna)


def migrate_db():
    """Micro-migração idempotente: adiciona colunas novas em tabelas já existentes.

    O create_all() só cria tabelas que faltam, não altera colunas — então
    adicionamos manualmente as colunas de 2FA caso o banco seja antigo.
    """
    from sqlalchemy import inspect as sa_inspect, text
    # Primeiro, e FORA do try de baixo: um ALTER antigo que falhe lá não pode
    # impedir estas colunas de existirem (ver a docstring).
    _migrar_colunas_ficha()
    try:
        insp = sa_inspect(engine)
        stmts = []
        # Colunas de 2FA na tabela users
        ucols = [c["name"] for c in insp.get_columns("users")]
        if "totp_secret" not in ucols:
            stmts.append("ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64)")
        if "totp_enabled" not in ucols:
            stmts.append("ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0")
        if "avatar" not in ucols:
            stmts.append("ALTER TABLE users ADD COLUMN avatar TEXT")
        # Permissões granulares por usuário (JSON em texto). NULL = acesso total.
        if "permissions" not in ucols:
            stmts.append("ALTER TABLE users ADD COLUMN permissions TEXT")
        # Revogação de sessão: incrementar invalida os tokens já emitidos.
        # DEFAULT 0 e NOT NULL — os usuários existentes entram com 0, que é
        # exatamente o que os tokens atuais carregam (ver auth.py), então
        # ninguém é deslogado pela migração.
        if "token_version" not in ucols:
            stmts.append("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0 NOT NULL")
        # Coluna de responsável (owner_id) nas entidades principais
        for tabela in ("clients", "processes", "honorarios", "precatorios", "deadlines", "appointments", "documents"):
            try:
                cols = [c["name"] for c in insp.get_columns(tabela)]
            except Exception:
                cols = []
            if cols and "owner_id" not in cols:
                stmts.append(f"ALTER TABLE {tabela} ADD COLUMN owner_id INTEGER")

        # Fase 8: cadastro completo de clientes
        cli_novas = {
            "rg": "VARCHAR(30)", "orgao_expedidor": "VARCHAR(40)", "data_nascimento": "DATE",
            "sexo": "VARCHAR(20)", "estado_civil": "VARCHAR(30)", "nacionalidade": "VARCHAR(60)",
            "profissao": "VARCHAR(80)", "pis_pasep": "VARCHAR(30)", "ctps": "VARCHAR(40)",
            "celular": "VARCHAR(40)", "telefone_secundario": "VARCHAR(40)", "whatsapp": "VARCHAR(40)",
            "cep": "VARCHAR(12)", "estado": "VARCHAR(40)", "cidade": "VARCHAR(80)",
            "bairro": "VARCHAR(80)", "rua": "VARCHAR(160)", "numero": "VARCHAR(20)",
            "complemento": "VARCHAR(80)",
        }
        try:
            clcols = [c["name"] for c in insp.get_columns("clients")]
        except Exception:
            clcols = []
        for col, tipo in cli_novas.items():
            if clcols and col not in clcols:
                stmts.append(f"ALTER TABLE clients ADD COLUMN {col} {tipo}")

        # Fase 7: novos campos processuais (processos robustos)
        proc_novas = {
            "subcategoria": "VARCHAR(80)",
            "classe": "VARCHAR(120)",
            "assunto": "VARCHAR(200)",
            "foro": "VARCHAR(160)",
            "vara": "VARCHAR(120)",
            "tribunal": "VARCHAR(120)",
            "orgao_julgador": "VARCHAR(160)",
            "data_distribuicao": "DATE",
            "fase_processual": "VARCHAR(60)",
            "sistema_eletronico": "VARCHAR(40)",
            "valor_causa": "DOUBLE PRECISION",
        }
        try:
            prcols = [c["name"] for c in insp.get_columns("processes")]
        except Exception:
            prcols = []
        for col, tipo in proc_novas.items():
            if prcols and col not in prcols:
                stmts.append(f"ALTER TABLE processes ADD COLUMN {col} {tipo}")

        # Fase B: novas colunas do módulo de Precatórios (página de caso completa)
        prec_novas = {
            "requerente_rg": "VARCHAR(30)",
            "requerente_nascimento": "DATE",
            "requerente_telefone": "VARCHAR(40)",
            "requerente_email": "VARCHAR(120)",
            "requerente_endereco": "TEXT",
            "numero_precatorio": "VARCHAR(60)",
            "vara": "VARCHAR(120)",
            "classe": "VARCHAR(120)",
            "assunto": "VARCHAR(200)",
            "classificacao": "VARCHAR(30)",
            "probabilidade": "INTEGER",
            "probabilidade_nivel": "VARCHAR(20)",
            "valor_caso": "DOUBLE PRECISION",
            "percentual_honorarios": "DOUBLE PRECISION",
            "data_proximo_contato": "DATE",
            "anotacoes": "TEXT",
        }
        try:
            pcols = [c["name"] for c in insp.get_columns("precatorios")]
        except Exception:
            pcols = []
        for col, tipo in prec_novas.items():
            if pcols and col not in pcols:
                stmts.append(f"ALTER TABLE precatorios ADD COLUMN {col} {tipo}")

        # Fase 9: vínculo opcional de precatórios e ações a um cliente cadastrado
        for tabela in ("precatorios", "acoes"):
            try:
                _c = [c["name"] for c in insp.get_columns(tabela)]
            except Exception:
                _c = []
            if _c and "client_id" not in _c:
                stmts.append(f"ALTER TABLE {tabela} ADD COLUMN client_id INTEGER")

        # Arquivamento de publicações do DJEN (limpar a lista sem apagar a
        # intimação). NOT NULL com DEFAULT 0: as linhas que já existem entram
        # como não-arquivadas, que é o estado correto para todas elas.
        try:
            pubcols = [c["name"] for c in insp.get_columns("publicacoes")]
        except Exception:
            pubcols = []
        if pubcols and "arquivada" not in pubcols:
            stmts.append("ALTER TABLE publicacoes ADD COLUMN arquivada INTEGER DEFAULT 0 NOT NULL")

        # Fase B: vínculo de documentos a precatório + categoria
        try:
            dcols = [c["name"] for c in insp.get_columns("documents")]
        except Exception:
            dcols = []
        if dcols and "precatorio_id" not in dcols:
            stmts.append("ALTER TABLE documents ADD COLUMN precatorio_id INTEGER")
        if dcols and "acao_id" not in dcols:
            stmts.append("ALTER TABLE documents ADD COLUMN acao_id INTEGER")
        if dcols and "categoria" not in dcols:
            stmts.append("ALTER TABLE documents ADD COLUMN categoria VARCHAR(40)")

        # Fase 3: criador + modelo de parceria nos honorários
        # + rateio de sócios (precatórios): flag, snapshot da reserva e da regra interna
        hon_novas = {
            "created_by": "INTEGER",
            "origem": "VARCHAR(20)",
            "parceiro_id": "INTEGER",
            "pct_escritorio": "DOUBLE PRECISION",
            "pct_parceiro": "DOUBLE PRECISION",
            "acao_id": "INTEGER",
            "precatorio_id": "INTEGER",
            "rateio": "INTEGER DEFAULT 0",
            "pct_reserva": "DOUBLE PRECISION",
            "rateio_config": "TEXT",
        }
        try:
            hcols = [c["name"] for c in insp.get_columns("honorarios")]
        except Exception:
            hcols = []
        for col, tipo in hon_novas.items():
            if hcols and col not in hcols:
                stmts.append(f"ALTER TABLE honorarios ADD COLUMN {col} {tipo}")

        # Fase 5: flag de novidade no monitoramento
        try:
            mcols = [c["name"] for c in insp.get_columns("monitores")]
        except Exception:
            mcols = []
        if mcols and "has_news" not in mcols:
            stmts.append("ALTER TABLE monitores ADD COLUMN has_news INTEGER DEFAULT 0")

        if stmts:
            with engine.begin() as conn:
                for s in stmts:
                    conn.execute(text(s))
        # Backfill: registros sem dono ficam com o admin (recomeço limpo)
        with engine.begin() as conn:
            row = conn.execute(
                text("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")
            ).fetchone()
            if not row:
                row = conn.execute(text("SELECT id FROM users ORDER BY id LIMIT 1")).fetchone()
            if row:
                admin_id = row[0]
                # Precatórios ficam de fora: leads sem dono permanecem na "fila" (owner_id NULL)
                for tabela in ("clients", "processes", "honorarios", "deadlines", "appointments", "documents"):
                    try:
                        conn.execute(text(
                            f"UPDATE {tabela} SET owner_id={admin_id} WHERE owner_id IS NULL"
                        ))
                    except Exception:
                        pass
        # Funil ampliado: renomeia as etapas antigas do status_lead para as novas (10 etapas)
        _funil_map = {
            "novo_lead": "novos_leads",
            "negociacao": "interesse",
            "doc_pendente": "analise_doc",
            "assinatura": "contrato_enviado",
            "fechado": "contrato_assinado",
            "arquivado": "concluido",
        }
        with engine.begin() as conn:
            for tabela in ("precatorios", "acoes"):
                for antigo, novo in _funil_map.items():
                    try:
                        conn.execute(text(
                            f"UPDATE {tabela} SET status_lead='{novo}' WHERE status_lead='{antigo}'"
                        ))
                    except Exception:
                        pass

        # Unifica Tema+Assunto: copia 'tema' para 'assunto' quando o assunto está vazio
        with engine.begin() as conn:
            try:
                conn.execute(text(
                    "UPDATE precatorios SET assunto = tema "
                    "WHERE (assunto IS NULL OR assunto = '') AND tema IS NOT NULL AND tema <> ''"
                ))
            except Exception:
                pass
    except Exception:
        # Migração é best-effort; nunca deve impedir a subida do app.
        pass


# Cópia congelada: o teste de migração troca `COLUNAS_FICHA` por uma lista com
# uma coluna propositalmente inválida, e a conferência não pode exigir essa.
_COLUNAS_FICHA_EXIGIDAS = {t: tuple(c) for t, c in COLUNAS_FICHA.items()}
_COLUNAS_USUARIO_EXIGIDAS = {t: tuple(c) for t, c in COLUNAS_USUARIO.items()}


def conferir_colunas_ficha():
    """Aborta a subida se faltar alguma das 6 colunas da ficha. Sem exceção a isto.

    Confere também `users.totp_pending_secret` (2FA): sem ela nem o login
    funciona, que é pior ainda que a ficha fora do ar.

    🚨 POR QUE DERRUBAR EM VEZ DE SEGUIR. `Client` e `Process` mapeiam essas
    colunas: sem elas, TODO select desses modelos dá 500 ("column does not
    exist") — clientes, processos, prazos, agenda, financeiro, o CRM inteiro
    fora do ar, mas com o health check respondendo 200. Já o `migrate_db` é
    best-effort de propósito e só LOGA a falha. Estourando aqui, no import, o
    `uvicorn app.main:app` não sobe, o deploy do Render falha e a versão
    ANTERIOR continua no ar — barulhento e reversível, em vez de silencioso.

    Fica FORA do `migrate_db`/`_migrar_colunas_ficha` de propósito: aqueles
    continuam tolerantes (tests/test_migracao_ficha.py exige que uma coluna
    ruim não impeça as outras), e esta é a trava da inicialização.
    """
    import logging
    from sqlalchemy import inspect as sa_inspect

    faltando = []
    for tabela, colunas in {**_COLUNAS_FICHA_EXIGIDAS, **_COLUNAS_USUARIO_EXIGIDAS}.items():
        try:
            existentes = {c["name"] for c in sa_inspect(engine).get_columns(tabela)}
        except Exception:
            existentes = set()
        faltando += [f"{tabela}.{c}" for c in colunas if c not in existentes]
    if faltando:
        msg = (
            "Subida abortada: colunas da ficha/2FA ausentes no banco "
            f"({', '.join(faltando)}). A migração automática não conseguiu criá-las "
            "— veja no log as linhas 'migração da ficha' / 'migração do 2FA' com o "
            "motivo. Sem elas todo SELECT de clientes/processos/usuários daria 500; "
            "por isso o app não sobe."
        )
        logging.getLogger("crm.migracao").critical(msg)
        raise RuntimeError(msg)


def inicializar_banco():
    """Caminho de subida: migra (best-effort) e confere o que é indispensável."""
    migrate_db()
    conferir_colunas_ficha()


inicializar_banco()


def bootstrap_admin():
    """Garante o usuário admin a partir de ADMIN_EMAIL / ADMIN_PASSWORD.

    - Se o admin (ADMIN_EMAIL) não existe, cria — assim o login funciona logo
      após o deploy.
    - Se já existe, mantém a senha em sincronia com ADMIN_PASSWORD. Ou seja,
      para trocar a senha do admin em produção, basta alterar a variável
      ADMIN_PASSWORD no Render e fazer um novo deploy.
    """
    db = SessionLocal()
    try:
        admin = db.query(models.User).filter(models.User.email == ADMIN_EMAIL).first()
        if admin is None:
            db.add(
                models.User(
                    name="Administrador",
                    email=ADMIN_EMAIL,
                    password_hash=hash_password(ADMIN_PASSWORD),
                    role="admin",
                )
            )
            db.commit()
        elif not verify_password(ADMIN_PASSWORD, admin.password_hash):
            # Senha mudou via variável de ambiente -> atualiza
            admin.password_hash = hash_password(ADMIN_PASSWORD)
            admin.role = "admin"
            db.commit()
    finally:
        db.close()


# /docs, /redoc e /openapi.json ficam ABERTOS em produção por padrão no FastAPI
# — o ZAP confirmou HTTP 200 sem autenticação. Não é vulnerabilidade por si,
# mas entrega o mapa completo da API (rotas, parâmetros, schemas) e poupa todo
# o trabalho de reconhecimento de quem for atacar. Em desenvolvimento continuam
# ligados, porque ali são úteis de verdade.
_DOCS_LIGADAS = IS_SQLITE or os.getenv("CRM_DOCS", "0") == "1"

app = FastAPI(
    title="CRM Jurídico",
    description="Sistema de gestão para escritório de advocacia",
    version="1.0.0",
    docs_url="/docs" if _DOCS_LIGADAS else None,
    redoc_url="/redoc" if _DOCS_LIGADAS else None,
    openapi_url="/openapi.json" if _DOCS_LIGADAS else None,
)


# ---------------------------------------------------------------------------
# Query string fora do access log
#
# O uvicorn registra a URL COMPLETA de cada requisição, e no Render isso vira
# log do serviço. A busca de Clientes/Processos/Precatórios manda o termo
# digitado na query string — e o pessoal digita CPF ali, porque a busca
# compara contra coluna de CPF. Resultado: CPF de cliente em log de
# infraestrutura, sem retenção definida e fora do alcance da trilha.
#
# Filtrar, e não desligar (`--no-access-log`): o access log é o que registra
# 4xx/5xx e ajuda a diagnosticar produção. Perder isso para resolver a query
# string seria trocar um problema por outro.
#
# O uvicorn passa os campos em record.args = (cliente, método, caminho,
# versão, status). Só o caminho é reescrito; o resto da linha continua igual.
# ---------------------------------------------------------------------------
def _instalar_filtro_de_log():
    import logging

    class SemQueryString(logging.Filter):
        def filter(self, record):
            try:
                args = record.args
                if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
                    caminho = args[2]
                    if "?" in caminho:
                        base = caminho.split("?", 1)[0]
                        record.args = args[:2] + (base + "?(omitido)",) + args[3:]
            except Exception:
                pass          # log nunca pode derrubar requisição
            return True

    logging.getLogger("uvicorn.access").addFilter(SemQueryString())


_instalar_filtro_de_log()


def _start_monitor_scheduler():
    """Agendador interno: verifica o DataJud periodicamente (servidor sempre ligado).

    Desative com MONITOR_AUTOCHECK=0. Intervalo via MONITOR_INTERVAL_HOURS (padrão 12).
    """
    if os.getenv("MONITOR_AUTOCHECK", "1") != "1":
        return
    import threading
    import time

    intervalo = max(1, int(os.getenv("MONITOR_INTERVAL_HOURS", "12"))) * 3600

    def loop():
        time.sleep(90)  # deixa o app estabilizar antes da primeira rodada
        while True:
            try:
                from .routers.monitor import verificar_todos
                db = SessionLocal()
                try:
                    verificar_todos(db, enviar_email=True)
                finally:
                    db.close()
            except Exception:
                pass
            time.sleep(intervalo)

    threading.Thread(target=loop, daemon=True).start()


def _start_retencao_scheduler():
    """Thread da RETENÇÃO de dados (ver retencao.py) — separada do scheduler do
    DataJud de propósito: MONITOR_AUTOCHECK=0 desliga o monitor inteiro, e a
    retenção não pode morrer junto por acidente. Interruptor próprio:
    RETENCAO_AUTOEXEC=0. A cadência real (1x/dia) é controlada por Setting no
    banco, então o sleep aqui é só o passo de verificação — reinício do
    processo não duplica execução."""
    if os.getenv("RETENCAO_AUTOEXEC", "1") != "1":
        return
    import threading
    import time

    def loop():
        time.sleep(300)   # o app primeiro; expurgo não é urgência de boot
        while True:
            try:
                from . import retencao
                db = SessionLocal()
                try:
                    if retencao.deve_executar(db):
                        retencao.executar_retencao(db)
                finally:
                    db.close()
            except Exception:
                pass      # retenção nunca derruba o app; a ausência da linha
                          # RETENCAO na auditoria é o alarme de que falhou
            time.sleep(6 * 3600)

    threading.Thread(target=loop, daemon=True).start()


@app.on_event("startup")
def on_startup():
    bootstrap_admin()
    _start_monitor_scheduler()
    _start_retencao_scheduler()


# CORS configurável por variável de ambiente (CORS_ORIGINS). A lista chega
# pronta do config.py, que RECUSA "*" fora do ambiente local — o porquê, e a
# severidade real (baixa), estão documentados lá.
#
# Esta linha dizia que o `*` era seguro por causa do `allow_credentials=False`.
# A premissa está certa e continua valendo; a CONCLUSÃO é que estava larga
# demais: sem credenciais o `*` não vaza sessão, mas também não protege nada,
# e liberar origem que ninguém usa é abrir mão de graça de uma camada.
#
# ⚠️ `allow_credentials=False` é o que segura o risco em baixo e NÃO pode virar
# True sem revisar o resto: com credenciais ligadas o navegador passaria a mandar
# cookie para a origem liberada, e aí a lista de origens deixaria de ser defesa
# em profundidade para virar a ÚNICA defesa. Hoje o login é Bearer token em
# localStorage, que origem estranha nenhuma consegue ler.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Headers de segurança
#
# A auditoria de ago/2026 encontrou os 6 principais AUSENTES em produção
# (confirmado também pelo OWASP ZAP).
#
# ⚠️ SOBRE A CSP — leia antes de mexer.
#
# FASE B, concluída em ago/2026: `script-src` NÃO tem mais 'unsafe-inline'.
# É isso que faz a diretiva PREVENIR XSS em vez de apenas conter: um <script>
# injetado agora simplesmente não executa.
#
# Antes disso ela já valia por três motivos, que continuam de pé:
#   1. connect-src fecha o destino: um XSS até rodava, mas não conseguia MANDAR
#      os dados para fora (o fetch para o servidor do atacante é bloqueado).
#   2. script-src com allowlist impede injetar <script src="evil.com">, que é
#      o caminho mais comum, e cobre o cenário de CDN comprometido.
#   3. frame-ancestors mata clickjacking; form-action impede sequestro de POST;
#      object-src/base-uri fecham vetores antigos.
#
# O que destravou a Fase B foi a refatoração que trocou os 157 handlers inline
# (onclick=, onchange=...) por delegação de eventos. Hoje sobram ZERO — as
# únicas ocorrências de "onclick=" no app.js estão dentro de comentários.
#
# 🚨 SE VOLTAR UM SÓ `onclick=` NO HTML, ELE NÃO VAI FUNCIONAR e a falha é
# silenciosa para quem escreveu (o navegador só reclama no console). Use
# `data-on-click="nomeDaAcao"` + `registrarAcoes`, como todo o resto do arquivo.
#
# `style-src` mantém 'unsafe-inline' de propósito: o app usa muitos atributos
# `style=` e o Bootstrap injeta estilo inline. Atributo de estilo não executa
# script — o risco é incomparavelmente menor que o de script-src, e fechá-lo
# exigiria varrer o app.js inteiro sem ganho de segurança equivalente.


def _hashes_scripts_inline(caminho) -> list:
    """SHA-256 dos <script> inline do index.html, no formato da CSP.

    Sobraram DOIS, os dois legítimos e necessários:
      1. no <head>, aplica o tema salvo ANTES da primeira pintura (sem ele o
         usuário vê um flash branco antes do tema escuro);
      2. no fim do <body>, define toggleTheme/_syncThemeIcon e registra o
         service worker do PWA.
    Externalizar os dois é possível, mas o do <head> passaria a custar uma
    ida à rede antes da primeira pintura — que é exatamente o que ele existe
    para evitar. Hash resolve sem mudar comportamento nenhum.

    🚨 O HASH É CALCULADO DO ARQUIVO, NUNCA FIXADO À MÃO. Hash escrito na mão
    sai de sincronia na primeira edição do index.html, e a falha é silenciosa:
    o tema para de ser aplicado e o service worker deixa de registrar, sem
    erro nenhum no servidor.

    ⚠️ E A NORMALIZAÇÃO DE NEWLINE NÃO É DETALHE. O `index.html` está com CRLF
    no Windows e com LF no Render (o `.gitattributes` criado em set/2026 só
    marca binários — não fixa eol, então a divergência continua), mas o
    parser de HTML normaliza CRLF/CR para LF ANTES de calcular o hash do
    script. Hashear os bytes crus daria certo num sistema operacional e errado
    no outro — passando no teste local e quebrando em produção, ou o inverso.
    """
    if not caminho.exists():
        return []
    texto = caminho.read_bytes().decode("utf-8")
    texto = texto.replace("\r\n", "\n").replace("\r", "\n")
    achados = []
    for m in re.finditer(r"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", texto, re.S):
        digest = hashlib.sha256(m.group(1).encode("utf-8")).digest()
        achados.append("'sha256-" + base64.b64encode(digest).decode("ascii") + "'")
    if not achados:
        # Melhor não subir do que subir com uma CSP que bloqueia o próprio app.
        raise RuntimeError(
            "CSP: nenhum <script> inline encontrado em index.html. "
            "Se eles foram externalizados de propósito, remova esta checagem; "
            "caso contrário o regex quebrou e a CSP sairia bloqueando o tema "
            "e o service worker."
        )
    return achados


_HASHES_INLINE = _hashes_scripts_inline(FRONTEND_DIR / "index.html")

# LGPD (set/2026): Bootstrap, Bootstrap Icons, Chart.js, qrcodejs e as fontes
# passaram a ser servidos de /static (frontend/vendor e frontend/assets/fontes).
# Antes, cada carregamento do CRM pedia recursos a DOIS hosts de terceiros -
# fonts.googleapis/gstatic (Google) e cdnjs (Cloudflare) - entregando IP e
# User-Agent de quem esta logado a cada um. Precisao que a revisao cobrou: o
# que acabou foi o cdnjs como HOST DE RECURSO; o trafego do proprio CRM segue
# atravessando o proxy do Render, que e' Cloudflare como infraestrutura - isso
# nao muda por aqui. Os arquivos sao byte a byte os que o cdnjs entregava (os
# SHA-512 dos `integrity` antigos foram conferidos no download). Por isso a
# CSP fechou: nenhuma origem externa em script/style/font.
#
# Se alguem reintroduzir uma tag de CDN no index.html, a CSP vai BLOQUEAR e o
# sintoma e' tela sem estilo - abra o console antes de mexer aqui.
_CSP = "; ".join([
    "default-src 'self'",
    # Sem 'unsafe-inline' e sem 'unsafe-eval'. Os hashes cobrem exatamente os
    # dois scripts inline do index.html — e nada mais.
    "script-src 'self' " + " ".join(_HASHES_INLINE),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    # Só o próprio backend e as APIs que o navegador realmente chama.
    # É isto que impede um XSS de exfiltrar dados do escritório.
    # BrasilAPI (out/2026): "Buscar na Receita" do cadastro de PJ. A consulta
    # sai do navegador e leva SÓ o CNPJ — CPF nunca vai para lá (ficha.js).
    # Liberada só no CAMINHO da consulta de CNPJ (a barra final casa o
    # prefixo): o domínio inteiro abriria todos os outros endpoints dela como
    # destino de um XSS. Se o ficha.js passar a chamar outro caminho, a CSP
    # bloqueia — e o sintoma aparece no console do navegador.
    "connect-src 'self' https://comunicaapi.pje.jus.br https://viacep.com.br "
    "https://brasilapi.com.br/api/cnpj/v1/",
    "frame-ancestors 'none'",     # clickjacking
    "form-action 'self'",         # POST não pode ser redirecionado para fora
    "base-uri 'self'",            # <base> injetado não reescreve URLs relativas
    "object-src 'none'",          # <object>/<embed> legados
])


@app.middleware("http")
async def security_headers_middleware(request, call_next):
    response = await call_next(request)
    h = response.headers
    # Assets imutaveis (versao no caminho ou hash no nome): um ano de cache.
    # Sem isto o navegador re-baixa ~800 KB de biblioteca a cada visita - o
    # cdnjs mandava `immutable` e o StaticFiles do Starlette nao manda nada.
    # fontes.css fica de fora de proposito: o caminho dele nao tem versao.
    caminho = request.url.path
    if caminho.startswith("/static/vendor/") or (
        caminho.startswith("/static/assets/fontes/") and caminho.endswith(".woff2")
    ):
        h.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    h.setdefault("Content-Security-Policy", _CSP)
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    h.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()")
    # HSTS só faz sentido sob HTTPS.
    #
    # ⚠️ `request.url.scheme` é "http" em produção: o TLS termina no proxy do
    # Render e a aplicação recebe a requisição já em texto puro na rede interna.
    # Checar só o scheme fazia o HSTS NUNCA ser enviado — foi o que a
    # verificação em produção mostrou. Quem diz o protocolo original é o
    # cabeçalho X-Forwarded-Proto, posto pelo proxy.
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    if proto.split(",")[0].strip() == "https":
        h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    # Não revelar a stack do servidor.
    # ⚠️ MutableHeaders do Starlette NÃO tem .pop() — usar del, protegido.
    # Nota: o `x-render-origin-server` é acrescentado pelo proxy do Render
    # DEPOIS desta resposta, então removê-lo aqui não o elimina de fato; fica
    # o que está sob nosso controle.
    for cabecalho in ("server", "x-powered-by"):
        try:
            del h[cabecalho]
        except KeyError:
            pass
    return response


@app.middleware("http")
async def audit_middleware(request, call_next):
    """Registra na trilha de auditoria toda ação de criação/edição/exclusão.

    É tolerante a falhas: qualquer erro no log nunca interrompe a requisição.
    """
    response = await call_next(request)
    try:
        if request.method in ("POST", "PUT", "DELETE"):
            path = request.url.path
            if path.startswith("/api/") and not path.startswith("/api/auth/login"):
                uid = None
                auth = request.headers.get("authorization", "")
                if auth.lower().startswith("bearer "):
                    import jwt          # PyJWT (ver nota em auth.py)
                    from .config import SECRET_KEY, ALGORITHM
                    try:
                        payload = jwt.decode(auth[7:], SECRET_KEY, algorithms=[ALGORITHM])
                        sub = payload.get("sub")
                        uid = int(sub) if sub else None
                    except Exception:
                        uid = None
                db = SessionLocal()
                try:
                    db.add(models.AuditLog(
                        user_id=uid, method=request.method,
                        path=path[:300], status=response.status_code,
                    ))
                    db.commit()
                finally:
                    db.close()
    except Exception:
        pass
    return response

# Registra todos os routers da API
app.include_router(auth.router)
app.include_router(config.router)
app.include_router(clients.router)
app.include_router(processes.router)
app.include_router(deadlines.router)
app.include_router(appointments.router)
app.include_router(documents.router)
app.include_router(pipeline.router)
app.include_router(financeiro.router)
app.include_router(precatorios.router)
app.include_router(monitor.router)
app.include_router(publicacoes.router)
app.include_router(export.router)
app.include_router(auditoria.router)
app.include_router(assinaturas.router)
app.include_router(acoes.router)
app.include_router(ia.router)
# Ficha única de Cliente e Processo: atendimentos, contatos, partes, andamentos
# e as linhas do tempo. Rotas em /api/clients/{id}/... e /api/processes/{id}/...
app.include_router(ficha.router)


@app.get("/api/health")
def health():
    """Usado pelo health check do Render."""
    return {"status": "ok"}


# --- Servir o frontend estático ---
# A pasta /frontend contém index.html, app.js e style.css.
if FRONTEND_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(directory=str(FRONTEND_DIR)),
        name="static",
    )

    # O index.html é um MODELO: a marca (nome, logos, encarregado de LGPD) entra
    # na hora de servir, a partir das variáveis MARCA_* (ver app/marca.py). Por
    # isso não é mais FileResponse — e por isso o arquivo cru em /static não é
    # o que o navegador usa.
    @app.get("/")
    def serve_index():
        from .marca import renderizar_index
        return HTMLResponse(renderizar_index(FRONTEND_DIR / "index.html"))

    # Servidos na raiz para o PWA: o service worker precisa de escopo "/"
    @app.get("/sw.js")
    def service_worker():
        return FileResponse(
            str(FRONTEND_DIR / "sw.js"), media_type="application/javascript"
        )

    @app.get("/manifest.json")
    def web_manifest():
        # Gerado a partir da marca: o nome e o ícone do app instalado são os
        # mesmos que a tela mostra (ver app/marca.py).
        from .marca import manifesto_json
        return Response(manifesto_json(), media_type="application/manifest+json")
