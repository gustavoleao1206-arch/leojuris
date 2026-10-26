"""Senha atual conferida com a sessão aberta — não pode virar atalho.

Dois achados da revisão de out/2026, depois da correção da troca de aparelho:

  1. LIGAR o 2FA pela primeira vez bastava a sessão. Quem roubasse o token de
     alguém SEM 2FA ativava o 2FA com a chave DELE e trancava o dono fora da
     conta. Agora o /2fa/enable exige a senha atual na primeira ativação (na
     troca de aparelho, não: lá o /2fa/setup já conferiu senha + código).
  2. O /me/password conferia a senha atual sem limite nenhum: com uma sessão
     roubada dava para chutar a senha na velocidade da rede. Agora ele gasta o
     MESMO balde por conta do login (`login-conta`, por e-mail) — e a 1ª
     ativação do 2FA também.

Erros são sempre 400/429, nunca 401: o frontend trata 401 como sessão
expirada e desloga.
"""
import time

import pyotp
import pytest

from app import models
from app.auth import verify_password

from conftest import SENHA, criar_usuario, headers_de

SETUP = "/api/auth/2fa/setup"
ENABLE = "/api/auth/2fa/enable"
SENHA_URL = "/api/auth/me/password"
LOGIN = "/api/auth/login"


def _errado(segredo: str) -> str:
    t = pyotp.TOTP(segredo)
    aceitos = {t.at(time.time() + d) for d in (-30, 0, 30)}
    return next(c for c in ("000000", "111111", "222222", "333333") if c not in aceitos)


def _estado(db, user_id):
    db.expire_all()
    u = db.query(models.User).get(user_id)
    return u.totp_enabled, u.totp_secret, u.totp_pending_secret


@pytest.fixture
def usuario(db):
    u = criar_usuario(db, "Sem 2FA", "senha-atual@teste.local", "advogado")
    return u, headers_de(u)


def _setup(client, h):
    r = client.post(SETUP, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["secret"]


# ------------------- 1ª ativação do 2FA exige a senha -------------------
@pytest.mark.parametrize("corpo", [
    {},                                     # o ataque: só o token e o código da chave dele
    {"senha_atual": ""},
    {"senha_atual": "senha-errada"},
])
def test_sessao_roubada_nao_liga_o_2fa_sem_a_senha(client, db, usuario, corpo):
    u, h = usuario
    segredo_do_atacante = _setup(client, h)
    r = client.post(ENABLE, headers=h, json={"code": pyotp.TOTP(segredo_do_atacante).now(), **corpo})
    assert r.status_code == 400, r.text
    # Nada ligado: o dono continua entrando só com a senha.
    assert _estado(db, u.id) == (0, None, segredo_do_atacante)
    assert client.post(LOGIN, data={"username": u.email, "password": SENHA}).status_code == 200


def test_senha_certa_e_codigo_errado_nao_liga(client, db, usuario):
    u, h = usuario
    novo = _setup(client, h)
    r = client.post(ENABLE, headers=h, json={"code": _errado(novo), "senha_atual": SENHA})
    assert r.status_code == 400
    assert r.json() == {"detail": "Código inválido"}
    assert _estado(db, u.id) == (0, None, novo)


def test_senha_errada_na_ativacao_gasta_o_limite_do_login(client, db, usuario):
    u, h = usuario
    novo = _setup(client, h)
    for _ in range(8):
        r = client.post(ENABLE, headers=h, json={"code": pyotp.TOTP(novo).now(), "senha_atual": "errada"})
        assert r.status_code == 400
    # Na 9ª nem a senha certa passa — e o login da mesma conta também trava.
    r = client.post(ENABLE, headers=h, json={"code": pyotp.TOTP(novo).now(), "senha_atual": SENHA})
    assert r.status_code == 429
    assert _estado(db, u.id) == (0, None, novo)
    assert client.post(LOGIN, data={"username": u.email, "password": SENHA}).status_code == 429


def test_confirmacao_do_pendente_tem_limite_de_codigo(client, db, usuario):
    # Um pendente abandonado não pode virar chute ilimitado de 6 dígitos.
    u, h = usuario
    novo = _setup(client, h)
    errado = _errado(novo)
    for _ in range(7):                              # 7 < 8: não estoura o balde da senha
        assert client.post(ENABLE, headers=h, json={"code": errado, "senha_atual": SENHA}).status_code == 400
    # Esgota o balde do código sem gastar mais senha: a partir daqui o limite
    # que barra é o "2fa-confirmar".
    from app import ratelimit
    ratelimit._hits.pop(f"login-conta:conta:{u.email.lower()}", None)
    for _ in range(3):
        assert client.post(ENABLE, headers=h, json={"code": errado, "senha_atual": SENHA}).status_code == 400
    r = client.post(ENABLE, headers=h, json={"code": pyotp.TOTP(novo).now(), "senha_atual": SENHA})
    assert r.status_code == 429
    assert _estado(db, u.id) == (0, None, novo)


# ------------------- /me/password com limite -------------------
def test_troca_de_senha_tem_limite_por_conta(client, db, usuario):
    u, h = usuario
    for _ in range(8):
        r = client.post(SENHA_URL, headers=h, json={"senha_atual": "errada", "nova_senha": "nova-senha-123"})
        assert r.status_code == 400
    # Na 9ª nem a senha certa troca nada.
    r = client.post(SENHA_URL, headers=h, json={"senha_atual": SENHA, "nova_senha": "nova-senha-123"})
    assert r.status_code == 429
    db.expire_all()
    assert verify_password(SENHA, db.query(models.User).get(u.id).password_hash)


def test_tentativas_de_login_e_de_troca_de_senha_somam(client, db, usuario):
    # Sem isso, a sessão roubada seria um canal paralelo para testar senhas.
    u, h = usuario
    for _ in range(8):
        assert client.post(LOGIN, data={"username": u.email, "password": "errada"}).status_code == 401
    r = client.post(SENHA_URL, headers=h, json={"senha_atual": SENHA, "nova_senha": "nova-senha-123"})
    assert r.status_code == 429


def test_troca_de_senha_continua_funcionando(client, db, usuario):
    u, h = usuario
    r = client.post(SENHA_URL, headers=h, json={"senha_atual": SENHA, "nova_senha": "nova-senha-123"})
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]
    db.expire_all()
    assert verify_password("nova-senha-123", db.query(models.User).get(u.id).password_hash)
