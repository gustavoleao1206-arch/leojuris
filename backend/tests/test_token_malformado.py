"""Token malformado é credencial inválida (401), nunca erro do servidor (500).

O PyJWT até a 2.13.0 estourava `RecursionError` ao ler um cabeçalho de token com
JSON aninhado fundo demais (Dependabot #10, GHSA da família "uncaught
RecursionError in jwt.decode"). Como o `get_current_user` só tratava
`PyJWTError`/`ValueError`/`TypeError`, qualquer pessoa SEM login conseguia
arrancar um 500 de qualquer rota protegida mandando esse token. Não dá acesso a
nada, mas é erro do servidor sob controle de um anônimo — e o frontend só desloga
no 401.

A correção tem duas camadas: PyJWT 2.15.1 (que não estoura mais) e o
`RecursionError` tratado como credencial inválida no `auth.py`, para o dia em
que outra lib de parse fizer o mesmo.
"""
import base64
import json

from fastapi.testclient import TestClient

from app.main import app


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _token_com_cabecalho_aninhado(profundidade: int = 100_000) -> str:
    cabecalho = ('{"a":' * profundidade) + "1" + ("}" * profundidade)
    payload = json.dumps({"sub": "1"}).encode()
    return f"{_b64(cabecalho.encode())}.{_b64(payload)}.{_b64(b'assinatura')}"


def test_token_com_cabecalho_aninhado_e_401_e_nao_500():
    # raise_server_exceptions=False: queremos a RESPOSTA que o navegador veria
    # (um 500 de verdade), e não a exceção propagada pelo TestClient.
    cliente = TestClient(app, raise_server_exceptions=False)
    r = cliente.get(
        "/api/auth/me",
        headers={"Authorization": "Bearer " + _token_com_cabecalho_aninhado()},
    )
    assert r.status_code == 401, (r.status_code, r.text[:200])


def test_token_lixo_continua_401():
    # Controle: token que nem é JWT segue no caminho de sempre.
    cliente = TestClient(app, raise_server_exceptions=False)
    r = cliente.get("/api/auth/me", headers={"Authorization": "Bearer isto-nao-e-um-jwt"})
    assert r.status_code == 401
