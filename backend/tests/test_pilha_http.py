"""Pilha HTTP (FastAPI 0.141 + Starlette 1.3) — o que a troca de versão garante.

A starlette 0.37.2, que vinha junto do fastapi 0.111, tinha 7 CVEs. Três delas
alcançam este app de um jeito concreto, e por isso viraram teste:

  - CVE-2026-54283: limites do formulário IGNORADOS em x-www-form-urlencoded;
  - CVE-2024-47874: campo multipart sem filename guardado em memória sem limite.
    As duas sem login: o /api/auth/login lê o formulário ANTES de autenticar,
    então era DoS de memória numa instância de 512 MB;
  - CVE-2026-48710: Host malformado envenenava `request.url.path`. O
    `audit_middleware` decide por esse caminho se registra a escrita — qualquer
    usuário logado gravava SEM deixar rastro na trilha de auditoria.

Os testes provam que as correções estão ativas NO APP (rodam contra a versão
antiga e falham), não só que o número da versão mudou. O resto cobre o que a
troca podia quebrar sem ninguém notar: o evento de startup (`on_event` saiu da
Starlette 1.0 e o FastAPI o reimplementou), as duas middlewares e o formato do
422 que o `api()` do frontend lê.
"""
from fastapi.testclient import TestClient

from app import models
from app.config import ADMIN_EMAIL
from app.main import app

from conftest import SENHA, criar_usuario, headers_de

LOGIN = "/api/auth/login"
AVATAR = "/api/auth/me/avatar"


def _ultimo_log(db):
    db.expire_all()
    return db.query(models.AuditLog).order_by(models.AuditLog.id.desc()).first()


# ------------------------------ CVEs, sem login ------------------------------
def test_formulario_urlencoded_respeita_o_limite_de_campos(client):
    # CVE-2026-54283. Na 0.37.2 os 1.003 campos eram todos lidos e a rota
    # respondia 401 normalmente — o limite simplesmente não existia.
    corpo = "&".join(f"c{i}=x" for i in range(1001)) + "&username=a@b.c&password=x"
    r = client.post(LOGIN, content=corpo,
                    headers={"content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 400
    assert "Too many fields" in r.json()["detail"]


def test_campo_multipart_sem_arquivo_tem_limite_de_tamanho(client):
    # CVE-2024-47874: campo sem filename passava inteiro para a memória.
    r = client.post(LOGIN, data={"username": "a@b.c", "password": "x" * (1024 * 1024 + 1)},
                    files={"anexo": ("a.txt", b"1", "text/plain")})
    assert r.status_code == 400
    assert "1024KB" in r.json()["detail"]


# ------------------------------ trilha de auditoria ------------------------------
def test_trilha_registra_escrita_e_ignora_leitura_e_login(client, db):
    u = criar_usuario(db, "Usuária Trilha", "trilha@teste.local", "advogado")
    h = headers_de(u)

    assert client.put(AVATAR, headers=h, json={"avatar": None}).status_code == 200
    log = _ultimo_log(db)
    assert (log.user_id, log.method, log.path, log.status) == (u.id, "PUT", AVATAR, 200)

    total = db.query(models.AuditLog).count()
    assert client.get("/api/auth/me", headers=h).status_code == 200            # leitura
    assert client.post(LOGIN, data={"username": u.email, "password": "errada"}).status_code == 401
    db.expire_all()
    assert db.query(models.AuditLog).count() == total


def test_host_malformado_nao_apaga_a_escrita_da_trilha(client, db):
    # CVE-2026-48710. Na 0.37.2, com `Host: evil.test/x?` o request.url virava
    # http://evil.test/x?/api/auth/me/avatar: o caminho lido pela middleware
    # era "/x", que não começa com /api/, e a escrita sumia da trilha.
    u = criar_usuario(db, "Usuária Host", "host@teste.local", "advogado")
    h = {**headers_de(u), "host": "evil.test/x?"}
    assert client.put(AVATAR, headers=h, json={"avatar": None}).status_code == 200
    log = _ultimo_log(db)
    assert log is not None and (log.user_id, log.path) == (u.id, AVATAR)


# ------------------------------ o que podia quebrar ------------------------------
def test_evento_de_startup_ainda_roda(db):
    # A Starlette 1.0 removeu `on_event`; o FastAPI o reimplementou (0.128.3).
    # Se parasse de rodar, o admin do ADMIN_EMAIL não seria criado no deploy.
    assert db.query(models.User).filter_by(email=ADMIN_EMAIL).first() is None
    with TestClient(app):
        pass
    db.expire_all()
    assert db.query(models.User).filter_by(email=ADMIN_EMAIL).first() is not None


def test_headers_de_seguranca_continuam_saindo(client):
    r = client.get("/api/health", headers={"x-forwarded-proto": "https"})
    assert r.status_code == 200
    h = r.headers
    assert h["content-security-policy"].startswith("default-src 'self'")
    assert "'unsafe-inline'" not in next(d for d in h["content-security-policy"].split("; ")
                                         if d.startswith("script-src"))
    assert h["x-frame-options"] == "DENY"
    assert h["x-content-type-options"] == "nosniff"
    assert h["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "strict-transport-security" in h
    assert "server" not in h


def test_422_mantem_o_formato_que_o_frontend_le(client, db):
    # O api() do app.js monta a mensagem a partir de `loc`, `msg` e `type`
    # ("missing" vira "Campo obrigatório: ..."). Pydantic novo não pode mudar isso.
    u = criar_usuario(db, "Usuária 422", "v422@teste.local", "advogado")
    r = client.post("/api/auth/me/password", headers=headers_de(u), json={})
    assert r.status_code == 422
    detalhe = r.json()["detail"]
    assert {d["loc"][-1] for d in detalhe} == {"senha_atual", "nova_senha"}
    assert all(d["type"] == "missing" and d["msg"] for d in detalhe)


def test_json_sem_content_type_de_json_e_recusado(client, db):
    # Mudança de comportamento do FastAPI 0.132 (strict_content_type): corpo
    # JSON só é lido com Content-Type de JSON. O frontend sempre manda o
    # cabeçalho (ver api() no app.js); este teste documenta a regra para quem
    # integrar outro cliente — e prova que a senha não muda por esse caminho.
    u = criar_usuario(db, "Usuária CT", "ct@teste.local", "advogado")
    corpo = '{"senha_atual": "%s", "nova_senha": "outra-senha-123"}' % SENHA
    r = client.post("/api/auth/me/password", content=corpo,
                    headers={**headers_de(u), "content-type": "text/plain"})
    assert r.status_code == 422
    r = client.post("/api/auth/me/password", content=corpo,
                    headers={**headers_de(u), "content-type": "application/json"})
    assert r.status_code == 200
