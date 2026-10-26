"""2FA — a sessão sozinha não troca mais o segundo fator de ninguém.

Achado da auditoria (out/2026): com o 2FA LIGADO, o POST /api/auth/2fa/setup
gerava e GRAVAVA um segredo novo em `totp_secret`, sem pedir senha nem código.
Quem tivesse só o token de uma sessão (fica no localStorage) trocava o 2FA da
vítima: o app autenticador dela parava de funcionar, o atacante ficava com o
segredo, e o /2fa/disable passava a aceitar o código DELE.

O que estes testes garantem:
  1. com o 2FA ligado, trocar de aparelho exige senha atual + código do app
     atual — sem os dois, nada muda no banco;
  2. a primeira ativação funciona, e LIGAR o 2FA exige a senha atual (ver
     test_senha_atual.py — sem ela, uma sessão roubada ativava o 2FA com a
     chave do atacante);
  3. o segredo novo nasce PENDENTE: o antigo segue valendo no login e no
     disable até o /2fa/enable confirmar a troca com um código do novo;
  4. login, troca e desativação gastam o MESMO limite de tentativas;
  5. o segredo pendente nunca sai na API;
  6. a coluna nova sobe sozinha num banco antigo (e a subida aborta sem ela).
"""
import shutil
import tempfile
import time
from pathlib import Path

import pyotp
import pytest
from sqlalchemy import create_engine, inspect, text

from app import database, main, models

from conftest import SENHA, criar_usuario, headers_de

SETUP = "/api/auth/2fa/setup"
ENABLE = "/api/auth/2fa/enable"
DISABLE = "/api/auth/2fa/disable"
LOGIN = "/api/auth/login"


def _agora(segredo: str) -> str:
    return pyotp.TOTP(segredo).now()


def _valido(segredo: str, codigo: str) -> bool:
    """A mesma janela que o servidor aceita (valid_window=1)."""
    return pyotp.TOTP(segredo).verify(codigo, valid_window=1)


def _errado(segredo: str) -> str:
    """Um código que o servidor com certeza recusa para este segredo agora."""
    t = pyotp.TOTP(segredo)
    aceitos = {t.at(time.time() + d) for d in (-30, 0, 30)}
    return next(c for c in ("000000", "111111", "222222", "333333") if c not in aceitos)


def _login(client, email, otp=None, senha=SENHA):
    dados = {"username": email, "password": senha}
    if otp is not None:
        dados["otp"] = otp
    return client.post(LOGIN, data=dados)


def _estado(db, user_id):
    db.expire_all()
    u = db.query(models.User).get(user_id)
    return u.totp_enabled, u.totp_secret, u.totp_pending_secret


@pytest.fixture
def sem_2fa(db):
    u = criar_usuario(db, "Sem 2FA", "sem2fa@teste.local", "advogado")
    return u, headers_de(u)


@pytest.fixture
def com_2fa(db):
    segredo = pyotp.random_base32()
    u = criar_usuario(db, "Com 2FA", "com2fa@teste.local", "advogado",
                      totp_secret=segredo, totp_enabled=1)
    return u, headers_de(u), segredo


# ------------------------- primeira ativação -------------------------
def test_primeira_ativacao_funciona_com_a_senha(client, db, sem_2fa):
    u, h = sem_2fa
    r = client.post(SETUP, headers=h)                 # sem corpo, como a tela manda
    assert r.status_code == 200, r.text
    novo = r.json()["secret"]
    assert r.json()["otpauth_uri"].startswith("otpauth://totp/")
    # Pendente: ainda não vale para nada, o login segue sem código.
    assert _estado(db, u.id) == (0, None, novo)
    assert _login(client, u.email).status_code == 200

    r = client.post(ENABLE, headers=h, json={"code": _agora(novo), "senha_atual": SENHA})
    assert r.status_code == 200, r.text
    assert _estado(db, u.id) == (1, novo, None)

    assert _login(client, u.email).json() == {"detail": "2FA_REQUIRED"}
    assert _login(client, u.email, otp=_agora(novo)).status_code == 200


def test_enable_sem_setup_antes_e_recusado(client, db, sem_2fa):
    u, h = sem_2fa
    r = client.post(ENABLE, headers=h, json={"code": "123456", "senha_atual": SENHA})
    assert r.status_code == 400
    assert _estado(db, u.id) == (0, None, None)


def test_setup_ignora_corpo_na_primeira_ativacao(client, db, sem_2fa):
    # Quem ainda não tem 2FA não tem segundo fator a proteger: mandar (ou
    # errar) senha e código aqui não muda nada.
    u, h = sem_2fa
    r = client.post(SETUP, headers=h, json={"senha_atual": "errada", "code": "000000"})
    assert r.status_code == 200, r.text
    assert _estado(db, u.id)[2] == r.json()["secret"]


# ------------------- 2FA ligado: a sessão sozinha não basta -------------------
@pytest.mark.parametrize("corpo", [
    None,                                   # o ataque original: só o token
    {},
    {"senha_atual": SENHA},                 # senha sem o código
    {"code": "PLACEHOLDER"},                # código sem a senha
])
def test_sessao_com_2fa_ativo_nao_troca_o_segredo_sem_senha_e_codigo(client, db, com_2fa, corpo):
    u, h, segredo = com_2fa
    if corpo and corpo.get("code") == "PLACEHOLDER":
        corpo = {"code": _agora(segredo)}
    r = client.post(SETUP, headers=h, json=corpo) if corpo is not None else client.post(SETUP, headers=h)
    assert r.status_code == 409, r.text
    assert "secret" not in r.json()
    assert _estado(db, u.id) == (1, segredo, None)
    # O 2FA de verdade continua o mesmo.
    assert _login(client, u.email, otp=_agora(segredo)).status_code == 200


@pytest.mark.parametrize("caso", ["senha_errada", "codigo_errado", "codigo_de_outro_segredo"])
def test_senha_ou_codigo_errado_nao_troca_e_nao_diz_qual_errou(client, db, com_2fa, caso):
    u, h, segredo = com_2fa
    corpo = {"senha_atual": SENHA, "code": _agora(segredo)}
    if caso == "senha_errada":
        corpo["senha_atual"] = "senha-errada"
    elif caso == "codigo_errado":
        corpo["code"] = _errado(segredo)
    else:
        outro = pyotp.random_base32()
        corpo["code"] = _agora(outro)
        if _valido(segredo, corpo["code"]):        # colisão de 3 em 1 milhão
            corpo["code"] = _errado(segredo)
    r = client.post(SETUP, headers=h, json=corpo)
    # 400 e nunca 401: o frontend trata 401 como sessão expirada e desloga.
    assert r.status_code == 400, r.text
    assert r.json() == {"detail": "Senha atual ou código do app inválidos."}
    assert _estado(db, u.id) == (1, segredo, None)


def test_tentativas_de_troca_gastam_o_limite_do_2fa(client, db, com_2fa):
    u, h, segredo = com_2fa
    for _ in range(6):
        r = client.post(SETUP, headers=h, json={"senha_atual": SENHA, "code": _errado(segredo)})
        assert r.status_code == 400
    # Na 7ª nem as credenciais certas passam — e o balde é o mesmo do login.
    r = client.post(SETUP, headers=h, json={"senha_atual": SENHA, "code": _agora(segredo)})
    assert r.status_code == 429
    assert _estado(db, u.id) == (1, segredo, None)
    assert _login(client, u.email, otp=_agora(segredo)).status_code == 429


def test_disable_tambem_tem_limite(client, db, com_2fa):
    # Sem limite, uma sessão roubada chutava os 6 dígitos no /2fa/disable,
    # desligava o 2FA e caía na primeira ativação — que não pede senha.
    u, h, segredo = com_2fa
    for _ in range(6):
        assert client.post(DISABLE, headers=h, json={"code": _errado(segredo)}).status_code == 400
    assert client.post(DISABLE, headers=h, json={"code": _agora(segredo)}).status_code == 429
    assert _estado(db, u.id) == (1, segredo, None)


# ---------------- troca de aparelho: o antigo vale até confirmar ----------------
def _iniciar_troca(client, h, segredo):
    r = client.post(SETUP, headers=h, json={"senha_atual": SENHA, "code": _agora(segredo)})
    assert r.status_code == 200, r.text
    novo = r.json()["secret"]
    assert novo != segredo
    return novo


def test_troca_com_senha_e_codigo_guarda_o_novo_como_pendente(client, db, com_2fa):
    u, h, segredo = com_2fa
    novo = _iniciar_troca(client, h, segredo)
    assert _estado(db, u.id) == (1, segredo, novo)


def test_segredo_antigo_segue_valendo_ate_a_confirmacao(client, db, com_2fa):
    u, h, segredo = com_2fa
    novo = _iniciar_troca(client, h, segredo)

    # Login: o antigo entra, o novo (ainda pendente) não.
    assert _login(client, u.email, otp=_agora(segredo)).status_code == 200
    codigo_novo = _agora(novo)
    if not _valido(segredo, codigo_novo):          # colisão de 3 em 1 milhão
        assert _login(client, u.email, otp=codigo_novo).json() == {"detail": "Código 2FA inválido"}
        # Disable também só aceita o antigo.
        assert client.post(DISABLE, headers=h, json={"code": codigo_novo}).status_code == 400
    # Confirmar a troca com um código do ANTIGO não promove o pendente.
    codigo_antigo = _agora(segredo)
    if not _valido(novo, codigo_antigo):
        assert client.post(ENABLE, headers=h, json={"code": codigo_antigo}).status_code == 400
    assert _estado(db, u.id) == (1, segredo, novo)

    # Confirmou com o novo: só agora o antigo deixa de valer.
    r = client.post(ENABLE, headers=h, json={"code": _agora(novo)})
    assert r.status_code == 200, r.text
    assert _estado(db, u.id) == (1, novo, None)
    assert _login(client, u.email, otp=_agora(novo)).status_code == 200
    codigo_antigo = _agora(segredo)
    if not _valido(novo, codigo_antigo):
        assert _login(client, u.email, otp=codigo_antigo).json() == {"detail": "Código 2FA inválido"}


def test_desistir_da_troca_nao_tranca_ninguem(client, db, com_2fa):
    u, h, segredo = com_2fa
    _iniciar_troca(client, h, segredo)
    _iniciar_troca(client, h, segredo)              # gerou outra chave e desistiu de novo
    assert _login(client, u.email, otp=_agora(segredo)).status_code == 200
    # Desativar com o código antigo funciona e limpa também o pendente.
    r = client.post(DISABLE, headers=h, json={"code": _agora(segredo)})
    assert r.status_code == 200, r.text
    assert _estado(db, u.id) == (0, None, None)


def test_segredo_pendente_nunca_sai_na_api(client, db, cenario, com_2fa):
    u, h, segredo = com_2fa
    novo = _iniciar_troca(client, h, segredo)
    for url, headers in (("/api/auth/me", h), ("/api/auth/users", cenario.auth["admin"])):
        r = client.get(url, headers=headers)
        assert r.status_code == 200
        assert novo not in r.text and segredo not in r.text, url
        assert "totp_pending_secret" not in r.text and "totp_secret" not in r.text, url


# ------------------------- migração da coluna nova -------------------------
@pytest.fixture
def banco_sem_a_coluna(monkeypatch):
    pasta = Path(tempfile.mkdtemp(prefix="crm-2fa-"))
    engine = create_engine(f"sqlite:///{(pasta / 'antigo.db').as_posix()}")
    database.Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE users DROP COLUMN totp_pending_secret"))
        conn.execute(text(
            "INSERT INTO users (name, email, password_hash, role, totp_secret, totp_enabled, token_version) "
            "VALUES ('Antiga', 'antiga@teste.local', 'x', 'advogado', 'ABCDEFGHIJKLMNOP', 1, 0)"
        ))
    monkeypatch.setattr(main, "engine", engine)
    yield engine
    engine.dispose()           # no Windows o arquivo fica travado sem isto
    shutil.rmtree(pasta, ignore_errors=True)


def _colunas_users(engine):
    return {c["name"] for c in inspect(engine).get_columns("users")}


def test_migracao_cria_a_coluna_num_banco_antigo(banco_sem_a_coluna):
    assert "totp_pending_secret" not in _colunas_users(banco_sem_a_coluna)   # sanidade
    main.inicializar_banco()
    assert "totp_pending_secret" in _colunas_users(banco_sem_a_coluna)
    with banco_sem_a_coluna.connect() as conn:
        linha = conn.execute(text(
            "SELECT email, totp_secret, totp_enabled, totp_pending_secret FROM users"
        )).one()
    # O 2FA de quem já tinha continua intacto.
    assert tuple(linha) == ("antiga@teste.local", "ABCDEFGHIJKLMNOP", 1, None)


def test_subida_aborta_se_a_coluna_nao_for_criada(banco_sem_a_coluna, monkeypatch):
    # Sem a coluna, todo SELECT de User daria 500 — login inclusive. Melhor o
    # deploy falhar (e a versão anterior seguir no ar) do que subir assim.
    monkeypatch.setattr(main, "_migrar_colunas_ficha", lambda: None)
    with pytest.raises(RuntimeError) as erro:
        main.inicializar_banco()
    assert "users.totp_pending_secret" in str(erro.value)
