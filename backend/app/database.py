"""Configuração do banco de dados (SQLAlchemy).

Funciona tanto com SQLite (local) quanto com PostgreSQL (produção/Render),
de acordo com a DATABASE_URL definida em config.py.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from .config import DATABASE_URL, IS_SQLITE

# check_same_thread só é necessário/válido para SQLite.
connect_args = {"check_same_thread": False} if IS_SQLITE else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    # pool_pre_ping evita erros de conexão "morta" no PostgreSQL gerenciado.
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Classe base para todos os modelos ORM
Base = declarative_base()


def get_db():
    """Dependência do FastAPI: fornece uma sessão de banco por requisição."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
