"""Configurações centrais da aplicação (CRM Jurídico).

Em produção (Render), o banco e os segredos vêm de variáveis de ambiente.
Localmente, há padrões para facilitar o desenvolvimento.
"""
import os
from pathlib import Path

# Diretório base do backend (.../backend)
BASE_DIR = Path(__file__).resolve().parent.parent


def _normalize_db_url(url: str) -> str:
    """SQLAlchemy exige o prefixo 'postgresql://'.
    Render/Heroku fornecem 'postgres://' — convertemos automaticamente.
    Também força o driver psycopg2.
    """
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
    return url


# --- Banco de dados ---
# Produção: usa a variável de ambiente DATABASE_URL (PostgreSQL no Render).
# Desenvolvimento local: cai para um arquivo SQLite.
_env_db = os.getenv("DATABASE_URL")
if _env_db:
    DATABASE_URL = _normalize_db_url(_env_db)
else:
    DATABASE_URL = f"sqlite:///{BASE_DIR / 'crm.db'}"

IS_SQLITE = DATABASE_URL.startswith("sqlite")

# Pasta onde os documentos enviados são armazenados.
# OBS.: no plano gratuito do Render o disco é efêmero — os arquivos são
# perdidos a cada redeploy/restart. Para produção real, use um Disk
# persistente do Render ou armazenamento externo (S3, etc.).
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# Pasta do frontend estático (HTML + Bootstrap)
FRONTEND_DIR = BASE_DIR.parent / "frontend"

# --- Segurança / JWT ---
# 🔑 A SECRET_KEY assina os tokens de login. Quem a conhece FORJA um token de
# admin e entra sem senha e sem 2FA — é comprometimento total do sistema.
#
# Por isso o fallback de desenvolvimento NÃO pode valer em produção: ele está
# publicado no repositório. Antes esta variável caía silenciosamente para uma
# constante conhecida; agora o app se RECUSA A SUBIR sem chave própria fora do
# ambiente local. Falhar no deploy é barulhento e reversível; subir com chave
# pública é uma porta aberta que ninguém percebe.
#
# "Ambiente local" = banco SQLite. Produção usa PostgreSQL (DATABASE_URL), e é
# exatamente esse o sinal usado abaixo.
_SECRET_DEV = "troque-esta-chave-secreta-em-producao-please"
SECRET_KEY = os.getenv("SECRET_KEY") or os.getenv("CRM_SECRET_KEY") or ""

if not SECRET_KEY:
    if IS_SQLITE and os.getenv("CRM_ALLOW_DEV_SECRET", "1") == "1":
        SECRET_KEY = _SECRET_DEV
    else:
        raise RuntimeError(
            "SECRET_KEY não definida. Defina a variável de ambiente SECRET_KEY "
            "com um valor aleatório longo antes de subir a aplicação. "
            "Gere com: python -c \"import secrets;print(secrets.token_urlsafe(64))\""
        )
elif SECRET_KEY == _SECRET_DEV and not IS_SQLITE:
    raise RuntimeError(
        "SECRET_KEY está com o valor de desenvolvimento, que é público no "
        "repositório. Troque por um valor aleatório longo."
    )
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 8  # 8 horas

# --- CORS ---
# Lista de origens permitidas, separadas por vírgula.
#
# 🔸 SEVERIDADE HONESTA, porque o rótulo errado atrapalha: o `*` que ficava aqui
# é risco BAIXO, não crítico — e a razão importa mais que a nota. O frontend é
# servido pelo PRÓPRIO backend, na mesma origem, então a operação normal do CRM
# não passa por CORS em momento nenhum. Somado a isso, `allow_credentials` é
# False (main.py) e o login é Bearer token guardado em localStorage, não cookie:
# um site malicioso não consegue LER o token de outra origem nem fazer requisição
# autenticada em nome de quem está logado. O que o `*` fazia era remover uma
# barreira de defesa em profundidade sem entregar nada em troca — ninguém
# precisava dela.
#
# Mesmo assim ele não sobrevive em produção, pela MESMA decisão de projeto da
# SECRET_KEY/ADMIN_PASSWORD acima: valor perigoso não é aceito em silêncio.
# Falhar no boot é barulhento e reversível — o Render só manda tráfego para a
# instância nova depois que ela sobe, então um deploy recusado deixa a versão
# anterior no ar. Cair para uma lista embutida seria PIOR aqui: a variável do
# painel continuaria dizendo `*` enquanto o código fizesse outra coisa, e
# divergência entre painel e código é exatamente a deriva que nenhum `git diff`
# denuncia (foi o que já aconteceu com a allow list de IP do banco).
#
# "Produção" = PostgreSQL, o mesmo sinal (IS_SQLITE) usado nos blocos acima.
# Local (SQLite) segue aceitando `*` — restringir ali quebraria quem desenvolve
# sem proteger nada.
#
# Exemplo usado só na mensagem de erro abaixo: a lista real vem da
# variável de ambiente CORS_ORIGINS, nunca do código.
_ORIGENS_PRODUCAO = "https://crm.example.com"

_origins = os.getenv("CORS_ORIGINS", "*").strip()
CORS_ORIGINS = [o.strip() for o in _origins.split(",") if o.strip()]

if "*" in CORS_ORIGINS or not CORS_ORIGINS:
    if IS_SQLITE:
        CORS_ORIGINS = ["*"]
    else:
        raise RuntimeError(
            'CORS_ORIGINS não pode ser "*" (nem ficar vazia) fora do ambiente '
            "local. Defina a lista explícita de origens, separadas por vírgula. "
            f"Exemplo: CORS_ORIGINS={_ORIGENS_PRODUCAO}"
        )

# --- Bootstrap do admin inicial ---
# Na primeira subida (banco vazio), cria um usuário admin para login imediato.
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@escritorio.com")

# Mesma lógica da SECRET_KEY: "admin123" está publicado no repositório, então
# não pode ser o padrão de um sistema com dado real de cliente. Em produção
# (PostgreSQL) a variável é obrigatória.
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD") or ""
if not ADMIN_PASSWORD:
    if IS_SQLITE:
        ADMIN_PASSWORD = "admin123"
    else:
        raise RuntimeError(
            "ADMIN_PASSWORD não definida. Defina uma senha forte na variável de "
            "ambiente antes de subir a aplicação."
        )

# --- Inteligência Artificial (Google Gemini) ---
# A chave NUNCA fica no código. Obtenha gratuitamente em aistudio.google.com
# (sem cartão) e defina GEMINI_API_KEY nas variáveis de ambiente do Render.
# O modelo pode ser trocado por env GEMINI_MODEL.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview").strip()
GEMINI_BASE = os.getenv(
    "GEMINI_BASE", "https://generativelanguage.googleapis.com"
).strip()

# --- DataJud (API Pública do CNJ) ---
# Base e chave PÚBLICA publicadas na wiki do CNJ (a chave pode ser trocada pelo
# CNJ a qualquer momento; se parar de funcionar, atualize via env DATAJUD_API_KEY).
DATAJUD_BASE = os.getenv("DATAJUD_BASE", "https://api-publica.datajud.cnj.jus.br")
DATAJUD_API_KEY = os.getenv(
    "DATAJUD_API_KEY",
    "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==",
)

# --- DJEN / Comunica (Diário de Justiça Eletrônico Nacional) ---
# API pública de publicações/intimações do CNJ. A CONSULTA é aberta (sem login).
# Produção: comunicaapi.pje.jus.br | Homologação: hcomunicaapi.cnj.jus.br
COMUNICA_BASE = os.getenv("COMUNICA_BASE", "https://comunicaapi.pje.jus.br/api/v1")
