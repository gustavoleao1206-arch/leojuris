"""(a) LOGIN — o servidor só emite token para quem provou a senha (e o 2FA).

Por que isto responde à pergunta do "alterar a resposta no proxy":

Um proxy de interceptação (Burp, ZAP...) consegue reescrever a resposta
`401 {"detail": "E-mail ou senha inválidos"}` para `200` antes de ela chegar
ao navegador. Isso NÃO é bypass, e estes testes mostram o porquê em duas
partes:

  1. A resposta de falha não carrega token NENHUM — não existe credencial
     escondida no 401 que o atacante possa "desembrulhar". Trocar o status
     não dá ao navegador nada com que chamar a API.
  2. Inventar um token também não serve: todo token é conferido por
     assinatura no servidor a cada requisição (ver test_token.py — token
     adulterado, assinado com outra chave ou com `alg: none` levam 401).

Ou seja: a decisão de autenticar acontece no servidor e só produz efeito na
forma de um token que só o servidor sabe assinar.
"""
import pyotp
import pytest

from app import models

from conftest import SENHA, criar_usuario

LOGIN = "/api/auth/login"


def _login(client, email, senha, otp=None):
    dados = {"username": email, "password": senha}
    if otp is not None:
        dados["otp"] = otp
    return client.post(LOGIN, data=dados)


def _sem_token(resp):
    """Nada que pareça um JWT ou o campo do token, em lugar nenhum da resposta."""
    corpo = resp.text
    assert "access_token" not in corpo
    assert "eyJ" not in corpo          # todo JWT começa com o header base64 "eyJ"
    assert "authorization" not in {k.lower() for k in resp.headers}


@pytest.fixture
def usuario(db):
    return criar_usuario(db, "Usuária Login", "login@teste.local", "advogado")


@pytest.fixture
def usuario_2fa(db):
    segredo = pyotp.random_base32()
    u = criar_usuario(
        db, "Usuária 2FA", "doisfatores@teste.local", "advogado",
        totp_secret=segredo, totp_enabled=1,
    )
    return u, segredo


# ------------------------------ sem 2FA ------------------------------
def test_senha_errada_401_sem_token(client, usuario):
    resp = _login(client, usuario.email, "senha-errada")
    assert resp.status_code == 401
    assert resp.json() == {"detail": "E-mail ou senha inválidos"}
    _sem_token(resp)


def test_usuario_inexistente_mesma_resposta_da_senha_errada(client, usuario):
    # Mesma mensagem nos dois casos: a rota não revela quais e-mails existem.
    resp = _login(client, "ninguem@teste.local", SENHA)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "E-mail ou senha inválidos"}
    _sem_token(resp)


def test_senha_vazia_nao_autentica(client, usuario):
    resp = _login(client, usuario.email, "")
    assert resp.status_code in (401, 422)
    _sem_token(resp)


def test_senha_certa_devolve_token_que_funciona(client, usuario):
    resp = _login(client, usuario.email, SENHA)
    assert resp.status_code == 200
    corpo = resp.json()
    assert corpo["token_type"] == "bearer"
    assert corpo["access_token"].startswith("eyJ")

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {corpo['access_token']}"})
    assert me.status_code == 200
    assert me.json()["email"] == usuario.email


# ------------------------------ com 2FA ------------------------------
def test_2fa_ativo_senha_certa_sem_codigo_pede_2fa(client, usuario_2fa):
    u, _ = usuario_2fa
    resp = _login(client, u.email, SENHA)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "2FA_REQUIRED"}
    _sem_token(resp)


def test_2fa_ativo_codigo_errado_401_sem_token(client, usuario_2fa):
    u, segredo = usuario_2fa
    certo = pyotp.TOTP(segredo).now()
    errado = "000000" if certo != "000000" else "111111"
    resp = _login(client, u.email, SENHA, otp=errado)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Código 2FA inválido"}
    _sem_token(resp)


def test_2fa_codigo_valido_nao_substitui_a_senha(client, usuario_2fa):
    # Código TOTP válido + senha errada: a senha é conferida ANTES, e o 2FA
    # não é atalho para quem só tem o celular da vítima.
    u, segredo = usuario_2fa
    resp = _login(client, u.email, "senha-errada", otp=pyotp.TOTP(segredo).now())
    assert resp.status_code == 401
    assert resp.json() == {"detail": "E-mail ou senha inválidos"}
    _sem_token(resp)


def test_2fa_senha_e_codigo_certos_devolve_token(client, usuario_2fa):
    u, segredo = usuario_2fa
    resp = _login(client, u.email, SENHA, otp=pyotp.TOTP(segredo).now())
    assert resp.status_code == 200
    assert resp.json()["access_token"].startswith("eyJ")


def test_2fa_desligado_ignora_segredo_antigo(client, db, usuario_2fa):
    # totp_enabled=0 com segredo ainda gravado (2FA iniciado e não concluído):
    # não pode exigir código de quem nunca terminou de configurar.
    u, _ = usuario_2fa
    registro = db.query(models.User).get(u.id)
    registro.totp_enabled = 0
    db.commit()
    assert _login(client, u.email, SENHA).status_code == 200


# --------------------------- força bruta ---------------------------
def test_forca_bruta_trava_a_conta_antes_de_emitir_token(client, usuario):
    # Limite por CONTA: 8 tentativas em 5 min. Na 9ª, nem a senha certa entra
    # — o 429 vem antes da conferência da senha e também não traz token.
    for _ in range(8):
        assert _login(client, usuario.email, "chute").status_code == 401
    resp = _login(client, usuario.email, SENHA)
    assert resp.status_code == 429
    _sem_token(resp)
