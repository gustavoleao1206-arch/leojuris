"""(b) TOKEN — sem Authorization é 401; token adulterado é 401.

A varredura percorre TODAS as rotas /api registradas no app, em vez de uma
lista escrita à mão: rota criada amanhã sem `get_current_user` quebra este
teste no mesmo PR. Só `login` e `health` são públicas, de propósito.
"""
import base64
import json
import re
from datetime import datetime, timedelta

import jwt
import pytest

from app import models
from app.config import ALGORITHM, SECRET_KEY

from conftest import SENHA, rotas_api_do_app

ROTAS_PUBLICAS = {
    ("POST", "/api/auth/login"),   # é onde o token nasce
    ("GET", "/api/health"),        # health check do Render
}


def _rotas_api():
    # `app.routes` deixou de ser lista plana no FastAPI 0.137: ver o conftest.
    for metodo, caminho in rotas_api_do_app():
        if caminho.startswith("/api"):
            yield metodo, caminho


def _url(caminho: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", caminho)


@pytest.mark.parametrize("metodo,caminho", sorted(set(_rotas_api()) - ROTAS_PUBLICAS))
def test_rota_sem_authorization_da_401(client, cenario, metodo, caminho):
    resp = client.request(metodo, _url(caminho), json={})
    assert resp.status_code == 401, f"{metodo} {caminho} respondeu sem token: {resp.status_code}"


def test_varredura_cobre_as_rotas_esperadas():
    # Sanidade da própria varredura: se o app deixasse de registrar os
    # routers, o teste acima passaria sem testar nada.
    rotas = set(_rotas_api())
    assert len(rotas) > 100
    assert ("GET", "/api/precatorios/{precatorio_id}") in rotas
    assert ROTAS_PUBLICAS <= rotas


# --------------------------- token adulterado ---------------------------
ROTAS_SENSIVEIS = ["/api/auth/me", "/api/precatorios", "/api/clients", "/api/honorarios"]


def _b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def _token_de(headers) -> str:
    return headers["Authorization"].split(" ", 1)[1]


def _variantes_adulteradas(c):
    """(nome, valor do header Authorization) — nenhum deve passar."""
    legitimo = _token_de(c.auth["ana"])
    cabecalho, carga, assinatura = legitimo.split(".")
    carga_dict = json.loads(base64.urlsafe_b64decode(carga + "=" * (-len(carga) % 4)))

    # Ana troca o próprio "sub" pelo do admin e mantém a assinatura original:
    # é o equivalente, no token, a "editar a resposta no proxy".
    escalada = dict(carga_dict, sub=str(c.admin))
    # ⚠️ Troca o PRIMEIRO caractere, nunca o último: a assinatura HS256 tem 32
    # bytes = 43 caracteres base64url, e os 2 bits finais do último caractere
    # são enchimento descartado na decodificação. Trocar "B" por "A" no fim não
    # muda byte nenhum — o token continuava válido e o teste falhava ao acaso.
    primeiro = assinatura[0]
    assinatura_trocada = ("A" if primeiro != "A" else "B") + assinatura[1:]
    exp_futuro = datetime.utcnow() + timedelta(hours=1)

    return [
        ("lixo", "Bearer isto-nao-e-um-jwt"),
        ("sem_esquema_bearer", legitimo),
        ("assinatura_alterada", f"Bearer {cabecalho}.{carga}.{assinatura_trocada}"),
        ("sub_trocado_para_admin", f"Bearer {cabecalho}.{_b64(escalada)}.{assinatura}"),
        ("sem_assinatura", f"Bearer {cabecalho}.{carga}."),
        ("alg_none", "Bearer " + _b64({"alg": "none", "typ": "JWT"}) + "."
                     + _b64({"sub": str(c.admin), "tv": 0}) + "."),
        ("outra_chave", "Bearer " + jwt.encode(
            {"sub": str(c.admin), "tv": 0, "exp": exp_futuro},
            "chave-que-o-atacante-inventou-com-mais-de-32-bytes", algorithm=ALGORITHM)),
        ("expirado", "Bearer " + jwt.encode(
            {"sub": str(c.ana), "tv": 0, "exp": datetime.utcnow() - timedelta(minutes=1)},
            SECRET_KEY, algorithm=ALGORITHM)),
        ("sub_nao_numerico", "Bearer " + jwt.encode(
            {"sub": "admin", "tv": 0, "exp": exp_futuro}, SECRET_KEY, algorithm=ALGORITHM)),
        ("sub_de_usuario_inexistente", "Bearer " + jwt.encode(
            {"sub": "999999", "tv": 0, "exp": exp_futuro}, SECRET_KEY, algorithm=ALGORITHM)),
        ("sem_sub", "Bearer " + jwt.encode(
            {"tv": 0, "exp": exp_futuro}, SECRET_KEY, algorithm=ALGORITHM)),
    ]


_NOMES_VARIANTES = [
    "lixo", "sem_esquema_bearer", "assinatura_alterada", "sub_trocado_para_admin",
    "sem_assinatura", "alg_none", "outra_chave", "expirado", "sub_nao_numerico",
    "sub_de_usuario_inexistente", "sem_sub",
]


@pytest.mark.parametrize("variante", _NOMES_VARIANTES)
@pytest.mark.parametrize("rota", ROTAS_SENSIVEIS)
def test_token_adulterado_da_401(client, cenario, variante, rota):
    header = dict(_variantes_adulteradas(cenario))[variante]
    resp = client.get(rota, headers={"Authorization": header})
    assert resp.status_code == 401, f"{variante} em {rota}: {resp.status_code} {resp.text[:200]}"


def test_lista_de_variantes_esta_completa(cenario):
    assert [n for n, _ in _variantes_adulteradas(cenario)] == _NOMES_VARIANTES


def test_controle_token_legitimo_passa(client, cenario):
    # Sem este controle, um app que recusasse TUDO passaria nos testes acima.
    for rota in ROTAS_SENSIVEIS:
        assert client.get(rota, headers=cenario.auth["ana"]).status_code == 200, rota


def test_troca_de_senha_revoga_token_antigo(client, cenario):
    antigo = cenario.auth["ana"]
    resp = client.post(
        "/api/auth/me/password", headers=antigo,
        json={"senha_atual": SENHA, "nova_senha": "Nova-Senha-456"},
    )
    assert resp.status_code == 200
    novo = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    assert client.get("/api/auth/me", headers=antigo).status_code == 401
    assert client.get("/api/auth/me", headers=novo).status_code == 200


def test_rebaixamento_pelo_admin_revoga_token(client, db, cenario):
    antigo = cenario.auth["ana"]
    resp = client.put(
        f"/api/auth/users/{cenario.ana}", headers=cenario.auth["admin"],
        json={"role": "estagiario"},
    )
    assert resp.status_code == 200
    assert client.get("/api/precatorios", headers=antigo).status_code == 401
    db.expire_all()
    assert db.query(models.User).get(cenario.ana).token_version == 1
