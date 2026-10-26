"""Migração das 6 colunas da ficha num banco ANTIGO (main.migrate_db).

A suíte cria o banco do zero com `create_all`, então o caminho do ALTER nunca
rodaria nos testes — e é justamente ele que roda em produção no primeiro
deploy. Se falhar lá, todo SELECT de Client/Process dá 500 ("column does not
exist") e o CRM cai. Aqui um SQLite temporário faz o papel do banco antigo:
nasce com `create_all` e perde as 6 colunas por `DROP COLUMN`.
"""
import logging
import shutil
import tempfile
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

from app import database, main

NOVAS = {
    "clients": {"tipo_pessoa", "nome_fantasia", "origem", "indicado_por"},
    "processes": {"polo_cliente", "instancia"},
}


@pytest.fixture
def banco_antigo(monkeypatch):
    pasta = Path(tempfile.mkdtemp(prefix="crm-migracao-"))
    engine = create_engine(f"sqlite:///{(pasta / 'antigo.db').as_posix()}")
    database.Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        for tabela, colunas in NOVAS.items():
            for col in sorted(colunas):
                conn.execute(text(f"ALTER TABLE {tabela} DROP COLUMN {col}"))
        # Uma linha antiga em cada tabela: o ALTER não pode exigir valor.
        conn.execute(text("INSERT INTO clients (name, status) VALUES ('Cliente antigo', 'ativo')"))
        conn.execute(text("INSERT INTO processes (client_id, case_number, status) VALUES (1, 'P-1', 'ativo')"))
    monkeypatch.setattr(main, "engine", engine)
    yield engine
    engine.dispose()           # no Windows o arquivo fica travado sem isto
    shutil.rmtree(pasta, ignore_errors=True)


def _colunas(engine, tabela):
    return {c["name"] for c in inspect(engine).get_columns(tabela)}


def test_banco_antigo_realmente_nao_tem_as_colunas(banco_antigo):
    # Sanidade do próprio teste: sem isto, o de baixo passaria sem migrar nada.
    for tabela, colunas in NOVAS.items():
        assert not (colunas & _colunas(banco_antigo, tabela))


def test_migrate_db_cria_as_6_colunas(banco_antigo):
    main.migrate_db()
    for tabela, colunas in NOVAS.items():
        assert colunas <= _colunas(banco_antigo, tabela), tabela
    with banco_antigo.connect() as conn:
        linha = conn.execute(text("SELECT name, tipo_pessoa, origem FROM clients")).one()
    assert tuple(linha) == ("Cliente antigo", None, None)     # o registro antigo segue intacto


def test_migrate_db_e_idempotente(banco_antigo):
    main.migrate_db()
    main.migrate_db()          # segunda subida do app: nada a fazer, nada quebra
    for tabela, colunas in NOVAS.items():
        assert colunas <= _colunas(banco_antigo, tabela)


def test_uma_coluna_ruim_nao_impede_as_outras_e_aparece_no_log(banco_antigo, monkeypatch, caplog):
    # Um ALTER que falha (aqui, palavra reservada como nome: erro de sintaxe
    # até no SQLite, que aceita quase tudo) não pode cancelar os demais — era
    # o que o bloco antigo, numa transação só e com `except: pass`, fazia.
    ruins = {
        "clients": {"select": "VARCHAR(2)", **main.COLUNAS_FICHA["clients"]},
        "processes": dict(main.COLUNAS_FICHA["processes"]),
    }
    monkeypatch.setattr(main, "COLUNAS_FICHA", ruins)
    with caplog.at_level(logging.ERROR, logger="crm.migracao"):
        main.migrate_db()
    for tabela, colunas in NOVAS.items():
        assert colunas <= _colunas(banco_antigo, tabela), tabela
    assert any("clients.select" in r.getMessage() for r in caplog.records)
