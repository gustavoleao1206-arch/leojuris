"""A suíte está isolada de verdade? Se estes falharem, nenhum outro vale nada.

Prova que o banco é o SQLite temporário (nunca `backend/crm.db`, nunca
produção) e que as saídas de rede do app estão bloqueadas — inclusive as
chamadas reais ao DataJud e ao DJEN, não só o `urlopen` isolado.
"""
import smtplib
import socket
import urllib.request
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import comunica, database
from app.routers import monitor

from conftest import BACKEND_DIR, RedeBloqueada, _DB_TESTE


def test_banco_e_o_sqlite_temporario():
    url = database.engine.url
    assert url.get_backend_name() == "sqlite"
    assert Path(url.database).resolve() == _DB_TESTE.resolve()
    assert Path(url.database).resolve() != (BACKEND_DIR / "crm.db").resolve()


def test_saidas_de_rede_estouram():
    with pytest.raises(RedeBloqueada):
        urllib.request.urlopen("https://api-publica.datajud.cnj.jus.br")
    with pytest.raises(RedeBloqueada):
        smtplib.SMTP("smtp.gmail.com", 587)
    with pytest.raises(RedeBloqueada):
        socket.create_connection(("1.1.1.1", 443), timeout=1)
    with pytest.raises(RedeBloqueada):
        socket.getaddrinfo("viacep.com.br", 443)


def test_datajud_e_djen_nao_saem_do_processo():
    # As funções reais do app, não só a primitiva. As duas embrulham o erro
    # (DataJud vira 502, DJEN vira RuntimeError), então a prova de que foi a
    # trava — e não uma resposta de verdade — é a mensagem dela lá dentro.
    with pytest.raises(HTTPException) as erro_datajud:
        monitor._consultar_datajud("trf5", "0000001-11.2026.4.05.0000")
    assert "bloqueado" in erro_datajud.value.detail

    with pytest.raises(RuntimeError, match="bloqueado"):
        comunica.consultar_por_oab("12345", "AL", "2026-09-01", "2026-09-24")


def test_banco_de_teste_aplica_chave_estrangeira():
    # Como o Postgres de produção. Sem isto, um DELETE que estoura FK em
    # produção passaria verde aqui (ver conftest.py).
    with database.engine.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
