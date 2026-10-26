"""Correções da revisão independente da ficha única (out/2026) — itens B1 a B15.

Cada bloco nasceu de um achado reproduzido (vários também num PostgreSQL 18
real). O padrão dos testes: o ataque/defeito exato, e um CONTROLE provando que
o caminho legítimo continua funcionando — teste que só confere a recusa passa
também quando a rota inteira quebra.

Três famílias:
  * integridade: `null`/texto longo no PUT que viravam 500 (B1, B2, B3);
  * dono: cascata que apagava o que é do colega, registro que nascia ou ficava
    com o dono errado e sumia de quem precisa vê-lo (B4, B5, B7, B8, B9, B10);
  * miudezas de segurança e operação (B6, B11–B15).
"""
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

import pytest
from sqlalchemy import String, create_engine, inspect, text

from app import database, main, models, schemas

PDF = b"%PDF-1.4\n%teste\n"


def _salvar(db, obj):
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj.id


def _get(db, modelo, rid):
    db.expire_all()
    return db.query(modelo).get(rid)


def _ids(resp):
    assert resp.status_code == 200, resp.text[:300]
    return {item["id"] for item in resp.json()}


def _sem_honorarios_nem_contratos(db, client_id):
    """Tira do cliente o que bloqueia por dinheiro/contrato (409 de outra regra)."""
    db.query(models.Honorario).filter(models.Honorario.client_id == client_id).delete()
    db.query(models.Assinatura).filter(models.Assinatura.client_id == client_id).delete()
    db.commit()


def _upload(client, headers, **campos):
    dados = {k: str(v) for k, v in campos.items() if v is not None}
    return client.post("/api/documents", headers=headers, data=dados,
                       files={"file": ("teste.pdf", PDF, "application/pdf")})


@pytest.fixture
def limpar_uploads(db):
    """Apaga do disco os arquivos que os uploads bem-sucedidos gravaram."""
    yield
    db.expire_all()
    for d in db.query(models.Document).all():
        if d.file_path and os.path.basename(d.file_path) != "x" and os.path.exists(d.file_path):
            os.remove(d.file_path)


# =====================================================================
# B1 — `done` do prazo: null derrubava GET /api/deadlines para todo mundo
# =====================================================================
def test_B1_put_done_nulo_422_e_lista_continua_de_pe(client, db, cenario):
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", headers=cenario.auth["ana"],
                   json={"done": None})
    assert r.status_code == 422, r.text
    assert _get(db, models.Deadline, cenario.prazo_ana).done == 0
    for papel in ("ana", "admin", "estag"):
        assert client.get("/api/deadlines", headers=cenario.auth[papel]).status_code == 200, papel


@pytest.mark.parametrize("valor", [2, -1, 10])
def test_B1_done_so_aceita_0_ou_1(client, cenario, valor):
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", headers=cenario.auth["ana"],
                   json={"done": valor})
    assert r.status_code == 422, r.text
    r = client.post("/api/deadlines", headers=cenario.auth["ana"], json={
        "process_id": cenario.proc_ana, "date": "2026-12-20", "description": "x",
        "urgency_level": "media", "done": valor})
    assert r.status_code == 422, r.text


def test_B1_controle_done_0_e_1_continuam_valendo(client, cenario):
    url = f"/api/deadlines/{cenario.prazo_ana}"
    for valor in (1, 0):
        r = client.put(url, headers=cenario.auth["ana"], json={"done": valor})
        assert r.status_code == 200 and r.json()["done"] == valor
    r = client.post("/api/deadlines", headers=cenario.auth["ana"], json={
        "process_id": cenario.proc_ana, "date": "2026-12-20", "description": "x",
        "urgency_level": "media", "done": 1})
    assert r.status_code == 200 and r.json()["done"] == 1


# =====================================================================
# B2 — audiência: date_time/process_id nulos davam IntegrityError (500)
# =====================================================================
@pytest.mark.parametrize("corpo", [{"date_time": None}, {"process_id": None}])
def test_B2_put_de_audiencia_com_obrigatorio_nulo_422(client, db, cenario, corpo):
    r = client.put(f"/api/appointments/{cenario.agenda_ana}", headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    a = _get(db, models.Appointment, cenario.agenda_ana)
    assert a.process_id == cenario.proc_ana and a.date_time == datetime(2026, 12, 2, 14, 0)
    assert client.get("/api/appointments", headers=cenario.auth["ana"]).status_code == 200


def test_B2_controle_put_parcial_da_audiencia(client, cenario):
    r = client.put(f"/api/appointments/{cenario.agenda_ana}", headers=cenario.auth["ana"],
                   json={"location": "Sala 2"})
    assert r.status_code == 200 and r.json()["location"] == "Sala 2"


# =====================================================================
# B3 — texto maior que a coluna: DataError (500) só no PostgreSQL
# =====================================================================
# Campos de lista fechada já dão 422 por outro motivo: ficam fora, senão o
# teste "n caracteres passa" falharia por causa da lista e não do tamanho.
# (O `status` do PROCESSO não é lista fechada — esse entra.)
_LISTA_FECHADA = {
    models.Client: {"status", "tipo_pessoa", "origem"},
    models.Process: {"polo_cliente", "instancia"},
    models.Deadline: {"urgency_level"},
}


def _colunas_de_texto(modelo, schema):
    """{campo: tamanho} das colunas String(n) do modelo que o schema recebe."""
    campos = set(schema.model_fields) - _LISTA_FECHADA.get(modelo, set())
    return {
        c.key: c.type.length for c in modelo.__table__.columns
        if isinstance(c.type, String) and c.type.length and c.key in campos
    }


# (método, url, corpo-base, modelo, schema). {cli}/{proc}/{prazo}/{agenda} viram ids.
_ROTAS_TEXTO = [
    ("post", "/api/clients", {"name": "Cliente Novo"}, models.Client, schemas.ClientCreate),
    ("put", "/api/clients/{cli}", {}, models.Client, schemas.ClientUpdate),
    ("post", "/api/processes", {"client_id": "{cli}"}, models.Process, schemas.ProcessCreate),
    ("put", "/api/processes/{proc}", {}, models.Process, schemas.ProcessUpdate),
    ("post", "/api/deadlines", {"process_id": "{proc}", "date": "2026-12-20", "description": "x",
                                "urgency_level": "media"}, models.Deadline, schemas.DeadlineCreate),
    ("put", "/api/deadlines/{prazo}", {}, models.Deadline, schemas.DeadlineUpdate),
    ("post", "/api/appointments", {"process_id": "{proc}", "date_time": "2026-12-20T10:00:00"},
     models.Appointment, schemas.AppointmentCreate),
    ("put", "/api/appointments/{agenda}", {}, models.Appointment, schemas.AppointmentUpdate),
]

_CASOS_TEXTO = [
    pytest.param(metodo, url, base, campo, n, id=f"{schema.__name__}.{campo}")
    for metodo, url, base, modelo, schema in _ROTAS_TEXTO
    for campo, n in sorted(_colunas_de_texto(modelo, schema).items())
]


def _montar(cenario, url, base):
    ids = dict(cli=cenario.cli_ana, proc=cenario.proc_ana, prazo=cenario.prazo_ana,
               agenda=cenario.agenda_ana)
    corpo = {}
    for k, v in base.items():
        corpo[k] = int(v.format(**ids)) if isinstance(v, str) and v.startswith("{") else v
    return url.format(**ids), corpo


def test_B3_a_varredura_cobre_as_colunas_conhecidas():
    # Sanidade do próprio teste: se a introspecção falhar, a parametrização
    # vira vazia e "passa" sem testar nada.
    ids = {c.id for c in _CASOS_TEXTO}
    for esperado in ("ClientUpdate.complemento", "ClientCreate.name", "ProcessUpdate.case_number",
                     "DeadlineCreate.description", "DeadlineUpdate.description",
                     "AppointmentUpdate.location"):
        assert esperado in ids, esperado
    assert len(ids) > 60


@pytest.mark.parametrize("metodo,url,base,campo,n", _CASOS_TEXTO)
def test_B3_texto_maior_que_a_coluna_422(client, cenario, metodo, url, base, campo, n):
    url, corpo = _montar(cenario, url, base)
    corpo[campo] = "x" * (n + 1)
    r = getattr(client, metodo)(url, headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, f"{campo} com {n + 1} caracteres -> {r.status_code}"
    assert f"{n} caracteres" in r.text


@pytest.mark.parametrize("metodo,url,base,campo,n", _CASOS_TEXTO)
def test_B3_controle_texto_do_tamanho_exato_passa(client, cenario, metodo, url, base, campo, n):
    url, corpo = _montar(cenario, url, base)
    corpo[campo] = "x" * n
    r = getattr(client, metodo)(url, headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 200, f"{campo} com {n} caracteres -> {r.status_code}: {r.text[:200]}"


def test_B3_o_caso_real_complemento_da_receita(client, cenario):
    # A BrasilAPI devolve complemento de sala comercial com 90 caracteres.
    r = client.put(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"],
                   json={"complemento": "SALA 1201 " * 9})
    assert r.status_code == 422


def test_B3_valor_antigo_maior_que_a_coluna_nao_quebra_a_leitura(client, db, cenario):
    # O limite vale só na ENTRADA. O SQLite guarda o que vier: um registro antigo
    # maior que a coluna não pode derrubar a lista (o validador fica fora da Base).
    db.query(models.Client).filter_by(id=cenario.cli_ana).update({"complemento": "y" * 200})
    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update({"description": "y" * 400})
    db.commit()
    for url in ("/api/clients", f"/api/clients/{cenario.cli_ana}", "/api/deadlines"):
        assert client.get(url, headers=cenario.auth["ana"]).status_code == 200, url
    # E um PUT de OUTRO campo continua valendo (só o que vem no corpo é conferido).
    r = client.put(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"], json={"notes": "ok"})
    assert r.status_code == 200


# =====================================================================
# B4 — excluir cliente/processo não leva registro de outro dono
# =====================================================================
def _sem_digitos(msg):
    return not re.search(r"\d", msg)


@pytest.mark.parametrize("dono", ["bruno", None])
def test_B4_cliente_com_documento_alheio_ou_sem_dono_409(client, db, cenario, dono):
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    owner = cenario.bruno if dono else None
    doc = _salvar(db, models.Document(client_id=cenario.cli_ana, original_name="laudo.pdf",
                                      file_path="x", owner_id=owner))
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409, r.text
    msg = r.json()["detail"]
    assert "outro responsável" in msg and "Só o administrador" in msg and "arquive" in msg
    assert _sem_digitos(msg), msg
    assert _get(db, models.Document, doc) is not None
    assert _get(db, models.Client, cenario.cli_ana) is not None
    assert _get(db, models.Process, cenario.proc_ana) is not None


def test_B4_documento_so_do_processo_entra_na_conta_do_cliente(client, db, cenario):
    # Preso SÓ ao processo do cliente: a exclusão o move para o cliente e apaga.
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    doc = _salvar(db, models.Document(process_id=cenario.proc_ana, original_name="p.pdf",
                                      file_path="x", owner_id=cenario.bruno))
    assert client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"]).status_code == 409
    assert _get(db, models.Document, doc) is not None


@pytest.mark.parametrize("modelo", ["prazo", "audiencia"])
def test_B4_cliente_com_prazo_ou_audiencia_alheios_409(client, db, cenario, modelo):
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    if modelo == "prazo":
        rid = _salvar(db, models.Deadline(process_id=cenario.proc_ana, date=date(2026, 12, 5),
                                          description="do Bruno", owner_id=cenario.bruno))
        cls = models.Deadline
    else:
        rid = _salvar(db, models.Appointment(process_id=cenario.proc_ana,
                                             date_time=datetime(2026, 12, 5, 9, 0), owner_id=cenario.bruno))
        cls = models.Appointment
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409, r.text
    assert _sem_digitos(r.json()["detail"])
    assert _get(db, cls, rid) is not None
    # O admin decide: ele exclui.
    assert client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["admin"]).status_code == 200
    assert _get(db, cls, rid) is None


@pytest.mark.parametrize("modelo", ["prazo", "audiencia"])
def test_B4_processo_com_prazo_ou_audiencia_alheios_409(client, db, cenario, modelo):
    if modelo == "prazo":
        rid = _salvar(db, models.Deadline(process_id=cenario.proc_ana, date=date(2026, 12, 5),
                                          description="do Bruno", owner_id=cenario.bruno))
        cls = models.Deadline
    else:
        rid = _salvar(db, models.Appointment(process_id=cenario.proc_ana,
                                             date_time=datetime(2026, 12, 5, 9, 0), owner_id=None))
        cls = models.Appointment
    r = client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409, r.text
    msg = r.json()["detail"]
    assert "outro responsável" in msg and "Só o administrador" in msg and _sem_digitos(msg)
    assert _get(db, cls, rid) is not None and _get(db, models.Process, cenario.proc_ana) is not None
    assert client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["admin"]).status_code == 200
    assert _get(db, cls, rid) is None


def test_B4_controle_documento_que_sobrevive_a_cascata_nao_bloqueia(client, db, cenario):
    # Documento de precatório e documento de processo preso a OUTRO cliente não
    # são apagados pela exclusão (só perdem o vínculo) — não podem dar 409.
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    doc_prec = _salvar(db, models.Document(client_id=cenario.cli_ana, precatorio_id=cenario.prec_bruno,
                                           original_name="prec.pdf", file_path="x", owner_id=cenario.bruno))
    doc_outro = _salvar(db, models.Document(process_id=cenario.proc_ana, client_id=cenario.cli_bruno,
                                            original_name="outro.pdf", file_path="x", owner_id=cenario.bruno))
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 200, r.text
    d = _get(db, models.Document, doc_prec)
    assert d is not None and d.client_id is None and d.precatorio_id == cenario.prec_bruno
    d = _get(db, models.Document, doc_outro)
    assert d is not None and d.process_id is None and d.client_id == cenario.cli_bruno


def test_B4_controle_so_coisa_propria_exclui_normalmente(client, db, cenario):
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    assert client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"]).status_code == 200
    assert client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"]).status_code == 200


def test_B4_ordem_quem_nao_alcanca_leva_403_e_nao_409(client, db, cenario):
    _salvar(db, models.Deadline(process_id=cenario.proc_ana, date=date(2026, 12, 5),
                                description="do Bruno", owner_id=cenario.bruno))
    assert client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["bruno"]).status_code == 403
    assert client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["estag"]).status_code == 403
    assert client.delete("/api/processes/999999", headers=cenario.auth["ana"]).status_code == 404


# =====================================================================
# B5 — processo criado pelo ESTAGIÁRIO fica com o dono do cliente
# =====================================================================
def test_B5_processo_da_estagiaria_e_do_dono_do_cliente(client, db, cenario):
    r = client.post("/api/processes", headers=cenario.auth["estag"],
                    json={"client_id": cenario.cli_ana, "case_number": "NOVO-EST", "owner_id": cenario.bruno})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert r.json()["owner_id"] == cenario.ana        # nem a estagiária, nem o owner_id do corpo
    assert pid in _ids(client.get("/api/processes", params={"client_id": cenario.cli_ana},
                                  headers=cenario.auth["ana"]))
    # O prazo criado nele pela estagiária herda a Ana — e aparece para ela.
    r = client.post("/api/deadlines", headers=cenario.auth["estag"], json={
        "process_id": pid, "date": "2026-10-10", "description": "Contestação urgente",
        "urgency_level": "alta"})
    assert r.status_code == 200
    assert _get(db, models.Deadline, r.json()["id"]).owner_id == cenario.ana
    assert r.json()["id"] in _ids(client.get("/api/deadlines", params={"client_id": cenario.cli_ana},
                                             headers=cenario.auth["ana"]))
    # E a Ana continua podendo excluir o próprio cliente sem 409 de "outro responsável".
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    assert client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"]).status_code == 200


def test_B5_cliente_sem_dono_o_processo_fica_com_a_estagiaria(client, db, cenario):
    cli = _salvar(db, models.Client(name="Cliente sem dono", owner_id=None))
    r = client.post("/api/processes", headers=cenario.auth["estag"], json={"client_id": cli})
    assert r.status_code == 200 and r.json()["owner_id"] == cenario.estag


def test_B5_controle_admin_escolhe_e_advogado_e_dono(client, cenario):
    r = client.post("/api/processes", headers=cenario.auth["admin"],
                    json={"client_id": cenario.cli_ana, "owner_id": cenario.bruno})
    assert r.status_code == 200 and r.json()["owner_id"] == cenario.bruno
    r = client.post("/api/processes", headers=cenario.auth["ana"], json={"client_id": cenario.cli_ana})
    assert r.status_code == 200 and r.json()["owner_id"] == cenario.ana


def test_B5_prazo_audiencia_e_documento_da_estagiaria_herdam_o_dono(client, db, cenario, limpar_uploads):
    # Prova do que já funcionava: o que a estagiária cria no processo/cliente da
    # Ana nasce da Ana — e aparece para ela.
    h = cenario.auth["estag"]
    r = client.post("/api/deadlines", headers=h, json={
        "process_id": cenario.proc_ana, "date": "2026-12-20", "description": "p", "urgency_level": "media"})
    assert r.status_code == 200
    assert _get(db, models.Deadline, r.json()["id"]).owner_id == cenario.ana
    r = client.post("/api/appointments", headers=h, json={
        "process_id": cenario.proc_ana, "date_time": "2026-12-20T10:00:00"})
    assert r.status_code == 200
    assert _get(db, models.Appointment, r.json()["id"]).owner_id == cenario.ana
    for campos in ({"process_id": cenario.proc_ana}, {"client_id": cenario.cli_ana}):
        r = _upload(client, h, **campos)
        assert r.status_code == 200, r.text
        assert _get(db, models.Document, r.json()["id"]).owner_id == cenario.ana, campos
        assert r.json()["id"] in _ids(client.get(
            "/api/documents", params={"client_id": cenario.cli_ana, "incluir_processos": 1},
            headers=cenario.auth["ana"]))


# =====================================================================
# B6 — atendimento com process_id não vira oráculo dos processos do colega
# =====================================================================
def test_B6_processo_alheio_e_inexistente_respondem_igual(client, db, cenario):
    alheio_no_meu = _salvar(db, models.Process(client_id=cenario.cli_ana, case_number="SEGREDO-B",
                                               owner_id=cenario.bruno))
    url = f"/api/clients/{cenario.cli_ana}/atendimentos"
    corpo = {"tipo": "nota", "descricao": "sondagem"}
    respostas = [
        client.post(url, headers=cenario.auth["ana"], json={**corpo, "process_id": pid})
        for pid in (alheio_no_meu, cenario.proc_bruno, 999999)
    ]
    assinaturas = {(r.status_code, r.text) for r in respostas}
    assert len(assinaturas) == 1, assinaturas
    assert respostas[0].status_code in (400, 403, 404)
    assert "SEGREDO" not in respostas[0].text
    db.expire_all()
    assert db.query(models.Atendimento).filter_by(descricao="sondagem").count() == 0


def test_B6_controle_processo_proprio_de_outro_cliente_400_e_do_cliente_200(client, db, cenario):
    outro_cli = _salvar(db, models.Client(name="Outro da Ana", owner_id=cenario.ana))
    proc_outro = _salvar(db, models.Process(client_id=outro_cli, case_number="ANA-OUTRO",
                                            owner_id=cenario.ana))
    url = f"/api/clients/{cenario.cli_ana}/atendimentos"
    r = client.post(url, headers=cenario.auth["ana"],
                    json={"tipo": "nota", "descricao": "x", "process_id": proc_outro})
    assert r.status_code == 400 and "não é deste cliente" in r.json()["detail"]
    r = client.post(url, headers=cenario.auth["ana"],
                    json={"tipo": "nota", "descricao": "x", "process_id": cenario.proc_ana})
    assert r.status_code == 200 and r.json()["process_id"] == cenario.proc_ana


# =====================================================================
# B7 — trocar o dono do processo não leva o documento do PRECATÓRIO junto
# =====================================================================
def test_B7_documento_de_precatorio_fica_com_a_dona_do_precatorio(client, db, cenario):
    doc_prec = _salvar(db, models.Document(process_id=cenario.proc_ana, precatorio_id=cenario.prec_ana,
                                           client_id=cenario.cli_ana, original_name="p.pdf",
                                           file_path="x", owner_id=cenario.ana))
    doc_acao = _salvar(db, models.Document(process_id=cenario.proc_ana, acao_id=cenario.acao_ana,
                                           original_name="a.pdf", file_path="x", owner_id=cenario.ana))
    doc_proc = _salvar(db, models.Document(process_id=cenario.proc_ana, client_id=cenario.cli_ana,
                                           original_name="so-do-processo.pdf", file_path="x",
                                           owner_id=cenario.ana))
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["admin"],
                   json={"owner_id": cenario.bruno})
    assert r.status_code == 200
    assert _get(db, models.Document, doc_prec).owner_id == cenario.ana
    assert _get(db, models.Document, doc_acao).owner_id == cenario.ana
    assert doc_prec in _ids(client.get("/api/documents", params={"precatorio_id": cenario.prec_ana},
                                       headers=cenario.auth["ana"]))
    # Controle: o documento só do processo acompanha o novo responsável.
    assert _get(db, models.Document, doc_proc).owner_id == cenario.bruno


# =====================================================================
# B8 — processo muda de cliente: o honorário do processo acompanha
# =====================================================================
def test_B8_honorario_do_processo_acompanha_o_cliente_novo(client, db, cenario):
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    h = _salvar(db, models.Honorario(client_id=cenario.cli_ana, process_id=cenario.proc_ana,
                                     total_value=100, paid_value=0, status="pendente",
                                     owner_id=cenario.ana, created_by=cenario.ana))
    # Honorário do processo lançado num TERCEIRO cliente: não era "do cliente
    # antigo", então fica como está.
    cli3 = _salvar(db, models.Client(name="Terceiro", owner_id=cenario.ana))
    terceiro = _salvar(db, models.Honorario(client_id=cli3, process_id=cenario.proc_ana,
                                            total_value=5, paid_value=0, status="pendente",
                                            owner_id=cenario.ana, created_by=cenario.ana))
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["admin"],
                   json={"client_id": cenario.cli_bruno})
    assert r.status_code == 200, r.text
    hon = _get(db, models.Honorario, h)
    assert hon.client_id == cenario.cli_bruno and hon.owner_id == cenario.ana   # dono não muda
    adm = cenario.auth["admin"]
    assert h not in _ids(client.get("/api/honorarios", params={"client_id": cenario.cli_ana}, headers=adm))
    assert h in _ids(client.get("/api/honorarios", params={"client_id": cenario.cli_bruno}, headers=adm))
    assert _get(db, models.Honorario, terceiro).client_id == cli3
    # E o cliente antigo deixa de ser bloqueado por um honorário que não é mais dele.
    assert client.delete(f"/api/clients/{cenario.cli_ana}", headers=adm).status_code == 200
    assert _get(db, models.Honorario, h) is not None


# =====================================================================
# B9 — prazo/audiência que muda de processo passa a ser do dono do destino
# =====================================================================
@pytest.mark.parametrize("rota,modelo,campo_id", [
    ("/api/deadlines", models.Deadline, "prazo_ana"),
    ("/api/appointments", models.Appointment, "agenda_ana"),
])
def test_B9_admin_move_para_processo_do_bruno(client, db, cenario, rota, modelo, campo_id):
    rid = getattr(cenario, campo_id)
    r = client.put(f"{rota}/{rid}", headers=cenario.auth["admin"], json={"process_id": cenario.proc_bruno})
    assert r.status_code == 200
    assert _get(db, modelo, rid).owner_id == cenario.bruno
    assert rid in _ids(client.get(rota, params={"process_id": cenario.proc_bruno}, headers=cenario.auth["bruno"]))
    assert rid not in _ids(client.get(rota, headers=cenario.auth["ana"]))


@pytest.mark.parametrize("rota,modelo", [("/api/deadlines", models.Deadline),
                                         ("/api/appointments", models.Appointment)])
def test_B9_estagiaria_repoe_item_do_bruno_no_processo_da_ana(client, db, cenario, rota, modelo):
    p_ana2 = _salvar(db, models.Process(client_id=cenario.cli_ana, case_number="ANA-2", owner_id=cenario.ana))
    if modelo is models.Deadline:
        rid = _salvar(db, models.Deadline(process_id=cenario.proc_bruno, date=date(2026, 12, 9),
                                          description="Prazo do Bruno", owner_id=cenario.bruno))
    else:
        rid = _salvar(db, models.Appointment(process_id=cenario.proc_bruno,
                                             date_time=datetime(2026, 12, 9, 9, 0), owner_id=cenario.bruno))
    r = client.put(f"{rota}/{rid}", headers=cenario.auth["estag"], json={"process_id": p_ana2})
    assert r.status_code == 200
    assert _get(db, modelo, rid).owner_id == cenario.ana
    assert rid in _ids(client.get(rota, params={"process_id": p_ana2}, headers=cenario.auth["ana"]))


def test_B9_controle_put_sem_trocar_processo_nao_mexe_no_dono(client, db, cenario):
    # Prazo com dono divergente do processo (dado legado): marcar como cumprido
    # não pode re-derivar o dono — só a troca de processo faz isso.
    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update({"owner_id": cenario.bruno})
    db.commit()
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", headers=cenario.auth["admin"],
                   json={"done": 1, "process_id": cenario.proc_ana})
    assert r.status_code == 200
    assert _get(db, models.Deadline, cenario.prazo_ana).owner_id == cenario.bruno


# =====================================================================
# B10 — desvincular a publicação não a devolve à FILA
# =====================================================================
@pytest.mark.parametrize("corpo", [{}, {"client_id": None, "process_id": None}])
def test_B10_desvincular_mantem_o_dono(client, db, cenario, corpo):
    pub = _salvar(db, models.Publicacao(external_id="B10", hash="hb10", texto="TEOR DA ANA", tribunal="TRF5",
                                        client_id=cenario.cli_ana, process_id=cenario.proc_ana,
                                        owner_id=cenario.ana, lida=1, arquivada=0))
    r = client.post(f"/api/publicacoes/{pub}/vincular", headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 200, r.text
    p = _get(db, models.Publicacao, pub)
    assert (p.client_id, p.process_id) == (None, None)
    assert p.owner_id == cenario.ana
    r = client.get(f"/api/publicacoes/{pub}", headers=cenario.auth["bruno"])
    assert r.status_code == 403 and "TEOR DA ANA" not in r.text


def test_B10_controle_vincular_herda_o_dono_do_alvo(client, db, cenario):
    pub = _salvar(db, models.Publicacao(external_id="B10c", hash="hb10c", texto="t", tribunal="TRF5",
                                        owner_id=None, lida=0, arquivada=0))
    r = client.post(f"/api/publicacoes/{pub}/vincular", headers=cenario.auth["admin"],
                    json={"process_id": cenario.proc_bruno})
    assert r.status_code == 200
    assert _get(db, models.Publicacao, pub).owner_id == cenario.bruno


# =====================================================================
# B11 — subir SEM as colunas da ficha aborta, em vez de subir quebrado
# =====================================================================
_COLUNAS_FICHA = {
    "clients": ["tipo_pessoa", "nome_fantasia", "origem", "indicado_por"],
    "processes": ["polo_cliente", "instancia"],
}


def _banco_antigo(pasta: Path) -> Path:
    arquivo = pasta / "antigo.db"
    engine = create_engine(f"sqlite:///{arquivo.as_posix()}")
    database.Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        for tabela, colunas in _COLUNAS_FICHA.items():
            for col in colunas:
                conn.execute(text(f"ALTER TABLE {tabela} DROP COLUMN {col}"))
    engine.dispose()
    return arquivo


@pytest.fixture
def pasta_temp():
    pasta = Path(tempfile.mkdtemp(prefix="crm-b11-"))
    yield pasta
    for f in pasta.iterdir():
        try:
            os.chmod(f, stat.S_IWRITE | stat.S_IREAD)
        except OSError:
            pass
    shutil.rmtree(pasta, ignore_errors=True)


def test_B11_inicializacao_aborta_se_a_migracao_nao_criou_as_colunas(pasta_temp, monkeypatch):
    engine = create_engine(f"sqlite:///{_banco_antigo(pasta_temp).as_posix()}")
    monkeypatch.setattr(main, "engine", engine)
    # A migração "roda" e falha em silêncio (o que aconteceria com um ALTER
    # negado no Postgres): a checagem do caminho de subida tem que pegar.
    monkeypatch.setattr(main, "_migrar_colunas_ficha", lambda: None)
    try:
        with pytest.raises(RuntimeError) as erro:
            main.inicializar_banco()
        msg = str(erro.value)
        for col in ("clients.tipo_pessoa", "clients.indicado_por", "processes.instancia"):
            assert col in msg, msg
    finally:
        engine.dispose()


def test_B11_controle_com_a_migracao_de_verdade_sobe(pasta_temp, monkeypatch):
    engine = create_engine(f"sqlite:///{_banco_antigo(pasta_temp).as_posix()}")
    monkeypatch.setattr(main, "engine", engine)
    try:
        main.inicializar_banco()              # cria as 6 e confere: sem exceção
        cols = {c["name"] for c in inspect(engine).get_columns("clients")}
        assert set(_COLUNAS_FICHA["clients"]) <= cols
    finally:
        engine.dispose()


def test_B11_o_import_do_app_falha_com_o_banco_sem_as_colunas(pasta_temp):
    """Ponta a ponta: o `uvicorn app.main:app` do Render é um import. Com o banco
    somente-leitura o ALTER falha de verdade — e o import tem que estourar, para
    o deploy falhar e a versão anterior continuar no ar."""
    arquivo = _banco_antigo(pasta_temp)
    os.chmod(arquivo, stat.S_IREAD)
    env = dict(os.environ)
    env.update({
        "DATABASE_URL": f"sqlite:///{arquivo.as_posix()}",
        "MONITOR_AUTOCHECK": "0", "RETENCAO_AUTOEXEC": "0",
        "SECRET_KEY": "chave-exclusiva-dos-testes-" + "x" * 40,
        "ADMIN_PASSWORD": "senha-do-bootstrap-nao-usada",
    })
    backend = Path(__file__).resolve().parents[1]
    proc = subprocess.run([sys.executable, "-c", "import app.main"], cwd=str(backend), env=env,
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "colunas da ficha" in proc.stderr and "clients.tipo_pessoa" in proc.stderr, proc.stderr[-2000:]


# =====================================================================
# B12 — excluir usuário que só registrou atendimento/andamento
# =====================================================================
def test_B12_autoria_de_atendimento_e_andamento_nao_trava_a_exclusao(client, db, cenario):
    ex = models.User(name="Ex-estagiária", email="ex@teste.local", role="estagiario", password_hash="x")
    db.add(ex)
    db.commit()
    at = _salvar(db, models.Atendimento(client_id=cenario.cli_ana, tipo="nota", descricao="ligou",
                                        autor_id=ex.id))
    an = _salvar(db, models.ProcessoAndamento(process_id=cenario.proc_ana, data=date(2026, 9, 1),
                                              titulo="Juntada", autor_id=ex.id))
    r = client.delete(f"/api/auth/users/{ex.id}", headers=cenario.auth["admin"])
    assert r.status_code == 200, r.text
    assert _get(db, models.User, ex.id) is None
    # O histórico fica; só perde a autoria.
    a = _get(db, models.Atendimento, at)
    assert a is not None and a.autor_id is None and a.descricao == "ligou"
    n = _get(db, models.ProcessoAndamento, an)
    assert n is not None and n.autor_id is None


def test_B12_controle_quem_tem_registro_proprio_continua_409_sem_perder_autoria(client, db, cenario):
    r = client.delete(f"/api/auth/users/{cenario.ana}", headers=cenario.auth["admin"])
    assert r.status_code == 409
    assert "atendimentos" not in r.json()["detail"]          # autoria não é o que trava
    # A anulação só acontece quando a exclusão vai em frente.
    assert _get(db, models.Atendimento, cenario.atend_ana).autor_id == cenario.ana
    assert _get(db, models.ProcessoAndamento, cenario.andamento_ana).autor_id == cenario.ana


# =====================================================================
# B13 — CSP: a BrasilAPI só no caminho da consulta de CNPJ
# =====================================================================
def test_B13_connect_src_libera_so_o_caminho_do_cnpj(client):
    csp = client.get("/api/health").headers["content-security-policy"]
    fontes = next(d for d in csp.split("; ") if d.startswith("connect-src")).split()
    assert "https://brasilapi.com.br/api/cnpj/v1/" in fontes
    assert "https://brasilapi.com.br" not in fontes
    assert not any(f.startswith("https://brasilapi.com.br") and f != "https://brasilapi.com.br/api/cnpj/v1/"
                   for f in fontes)


# =====================================================================
# B14 — o total de honorários do painel usa a régua da aba Financeiro
# =====================================================================
def test_B14_total_inclui_o_honorario_lancado_so_no_processo(client, db, cenario):
    so_proc = _salvar(db, models.Honorario(process_id=cenario.proc_ana, total_value=9, paid_value=0,
                                           status="pendente", owner_id=cenario.ana, created_by=cenario.ana))
    # Processo do Bruno preso ao cliente da Ana, com honorário dele: a Ana não vê.
    pb = _salvar(db, models.Process(client_id=cenario.cli_ana, case_number="PB", owner_id=cenario.bruno))
    do_bruno = _salvar(db, models.Honorario(process_id=pb, total_value=700, paid_value=0, status="pendente",
                                            owner_id=cenario.bruno, created_by=cenario.bruno))
    for papel in ("ana", "admin"):
        h = cenario.auth[papel]
        painel = client.get(f"/api/clients/{cenario.cli_ana}/overview", headers=h).json()
        aba = client.get("/api/honorarios", params={"client_id": cenario.cli_ana}, headers=h).json()
        assert {x["id"] for x in painel["honorarios"]} == {x["id"] for x in aba}, papel
        assert painel["resumo"]["total_honorarios"] == pytest.approx(sum(x["total_value"] for x in aba)), papel
        assert so_proc in {x["id"] for x in painel["honorarios"]}, papel
    ana = client.get(f"/api/clients/{cenario.cli_ana}/overview", headers=cenario.auth["ana"]).json()
    assert do_bruno not in {x["id"] for x in ana["honorarios"]}
    assert ana["resumo"]["total_honorarios"] == pytest.approx(1000 + 3000 + 9)


# =====================================================================
# B15 — e-mail do contato do cliente (tabela nova) com formato válido
# =====================================================================
@pytest.mark.parametrize("email", ["nao-e-email", "a@b", "javascript:alert(1)@x.com", "x y@z.com",
                                   "a@b..com", "@exemplo.com"])
def test_B15_email_invalido_do_contato_422(client, cenario, email):
    url = f"/api/clients/{cenario.cli_ana}/contatos"
    r = client.post(url, headers=cenario.auth["ana"], json={"nome": "Fulano", "email": email})
    assert r.status_code == 422, (email, r.text)
    r = client.put(f"{url}/{cenario.contato_cli_ana}", headers=cenario.auth["ana"], json={"email": email})
    assert r.status_code == 422, (email, r.text)


@pytest.mark.parametrize("email", ["joao@exemplo.com.br", "maria.silva+adv@escritorio-x.adv.br", "", None])
def test_B15_controle_email_valido_ou_vazio_passa(client, cenario, email):
    url = f"/api/clients/{cenario.cli_ana}/contatos"
    r = client.post(url, headers=cenario.auth["ana"], json={"nome": "Fulano", "email": email})
    assert r.status_code == 200, (email, r.text)
    r = client.put(f"{url}/{cenario.contato_cli_ana}", headers=cenario.auth["ana"], json={"email": email})
    assert r.status_code == 200, (email, r.text)


def test_B15_email_do_cliente_continua_sem_validacao_de_formato(client, cenario):
    # Dado legado: o formulário manda o e-mail do cliente em todo salvar.
    r = client.put(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"],
                   json={"email": "contato (antigo)"})
    assert r.status_code == 200


# =====================================================================
# B16 — honorário com valor pago maior que o total
# =====================================================================
_MSG_PAGO = "O valor pago não pode ser maior que o total."


def test_B16_criar_com_pago_maior_que_o_total_422(client, db, cenario):
    db.expire_all()
    antes = db.query(models.Honorario).count()
    r = client.post("/api/honorarios", headers=cenario.auth["ana"], json={
        "client_id": cenario.cli_ana, "total_value": 5, "paid_value": 1000})
    assert r.status_code == 422, r.text
    assert _MSG_PAGO in r.text
    db.expire_all()
    assert db.query(models.Honorario).count() == antes


@pytest.mark.parametrize("gravado,corpo", [
    ({"total_value": 1000, "paid_value": 0}, {"paid_value": 1500}),        # só o pago vem
    ({"total_value": 1000, "paid_value": 500}, {"total_value": 10}),       # só o total vem
    ({"total_value": 1000, "paid_value": 0}, {"total_value": 5, "paid_value": 1000}),
])
def test_B16_put_com_pago_maior_que_o_total_422(client, db, cenario, gravado, corpo):
    db.query(models.Honorario).filter_by(id=cenario.hon_ana).update(gravado)
    db.commit()
    r = client.put(f"/api/honorarios/{cenario.hon_ana}", headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    assert _MSG_PAGO in r.text
    h = _get(db, models.Honorario, cenario.hon_ana)
    assert (h.total_value, h.paid_value) == (gravado["total_value"], gravado["paid_value"])


def test_B16_controle_pago_igual_ao_total_e_parcelar(client, db, cenario):
    r = client.post("/api/honorarios", headers=cenario.auth["ana"], json={
        "client_id": cenario.cli_ana, "total_value": 100, "paid_value": 100})
    assert r.status_code == 200 and r.json()["status"] == "pago"
    r = client.put(f"/api/honorarios/{cenario.hon_ana}", headers=cenario.auth["ana"],
                   json={"paid_value": 1000})
    assert r.status_code == 200 and r.json()["status"] == "pago"
    r = client.post("/api/honorarios/parcelar", headers=cenario.auth["ana"], json={
        "client_id": cenario.cli_ana, "total_value": 900, "parcelas": 3,
        "primeiro_vencimento": "2026-11-10"})
    assert r.status_code == 200 and [h["total_value"] for h in r.json()] == [300, 300, 300]


def test_B16_controle_registro_antigo_invalido_ainda_edita_outros_campos(client, db, cenario):
    # Gravado antes da trava: editar a observação não pode ficar bloqueado. Só
    # quando o PUT mexe em total/pago é que a regra é conferida.
    db.query(models.Honorario).filter_by(id=cenario.hon_ana).update({"total_value": 5, "paid_value": 1000})
    db.commit()
    r = client.put(f"/api/honorarios/{cenario.hon_ana}", headers=cenario.auth["ana"], json={"notes": "ok"})
    assert r.status_code == 200, r.text


# =====================================================================
# B17 — exclusão em cascata apaga também o ARQUIVO do documento (LGPD)
# =====================================================================
@pytest.fixture
def arquivos_upload():
    """Cria arquivos de verdade na pasta de uploads e garante a limpeza."""
    import uuid
    from app.config import UPLOAD_DIR
    criados = []

    def _novo():
        caminho = UPLOAD_DIR / f"teste-b17-{uuid.uuid4().hex}.pdf"
        caminho.write_bytes(PDF)
        criados.append(caminho)
        return caminho

    yield _novo
    for c in criados:
        if c.exists():
            c.unlink()


def test_B17_excluir_cliente_apaga_os_arquivos_dos_documentos(client, db, cenario, arquivos_upload):
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    do_cliente, so_do_processo, de_precatorio = arquivos_upload(), arquivos_upload(), arquivos_upload()
    _salvar(db, models.Document(client_id=cenario.cli_ana, original_name="rg.pdf",
                                file_path=str(do_cliente), owner_id=cenario.ana))
    _salvar(db, models.Document(process_id=cenario.proc_ana, original_name="peticao.pdf",
                                file_path=str(so_do_processo), owner_id=cenario.ana))
    # Documento de precatório só perde o vínculo: o arquivo FICA.
    doc_prec = _salvar(db, models.Document(client_id=cenario.cli_ana, precatorio_id=cenario.prec_ana,
                                           original_name="prec.pdf", file_path=str(de_precatorio),
                                           owner_id=cenario.ana))
    # doc_ana (conftest) aponta para arquivo que não existe: tem que ser tolerado.
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 200, r.text
    assert not do_cliente.exists()
    assert not so_do_processo.exists()
    assert de_precatorio.exists() and _get(db, models.Document, doc_prec) is not None


def test_B17_commit_que_falha_nao_apaga_arquivo(client, db, cenario, arquivos_upload, monkeypatch):
    from sqlalchemy.orm import Session
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    arq = arquivos_upload()
    doc = _salvar(db, models.Document(client_id=cenario.cli_ana, original_name="rg.pdf",
                                      file_path=str(arq), owner_id=cenario.ana))

    def _falha(self):
        raise RuntimeError("commit falhou")

    monkeypatch.setattr(Session, "commit", _falha)
    with pytest.raises(RuntimeError):
        client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    monkeypatch.undo()
    assert arq.exists()
    assert _get(db, models.Document, doc) is not None


def test_B17_arquivo_fora_da_pasta_de_uploads_nunca_e_apagado(client, db, cenario, pasta_temp):
    _sem_honorarios_nem_contratos(db, cenario.cli_ana)
    fora = pasta_temp / "nao-e-upload.pdf"
    fora.write_bytes(PDF)
    _salvar(db, models.Document(client_id=cenario.cli_ana, original_name="x.pdf",
                                file_path=str(fora), owner_id=cenario.ana))
    assert client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"]).status_code == 200
    assert fora.exists()


def test_B17_controle_excluir_processo_nao_apaga_documento_nem_arquivo(client, db, cenario, arquivos_upload):
    # Na exclusão do PROCESSO o documento não vai embora: passa para o cliente.
    arq = arquivos_upload()
    doc = _salvar(db, models.Document(process_id=cenario.proc_ana, original_name="peticao.pdf",
                                      file_path=str(arq), owner_id=cenario.ana))
    assert client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"]).status_code == 200
    d = _get(db, models.Document, doc)
    assert d is not None and d.client_id == cenario.cli_ana
    assert arq.exists()


# =====================================================================
# B18 — categorias novas de documento
# =====================================================================
@pytest.mark.parametrize("categoria", ["peticao", "decisao", "laudo", "procuracao", "outro"])
def test_B18_categorias_aceitas_no_upload(client, cenario, categoria, limpar_uploads):
    r = _upload(client, cenario.auth["ana"], client_id=cenario.cli_ana, categoria=categoria)
    assert r.status_code == 200, r.text
    assert r.json()["categoria"] == categoria


def test_B18_toda_categoria_aceita_tem_rotulo_na_linha_do_tempo():
    # Categoria nova sem rótulo sairia sem detalhe na linha do tempo.
    from app.routers import ficha
    assert set(ficha._DOC_CATEGORIAS) == set(schemas.DOC_CATEGORIAS)


def test_B18_categoria_fora_da_lista_continua_400(client, cenario, limpar_uploads):
    r = _upload(client, cenario.auth["ana"], client_id=cenario.cli_ana, categoria="<b>x</b>")
    assert r.status_code == 400


@pytest.mark.parametrize("categoria,rotulo", [("peticao", "Petição"), ("decisao", "Decisão/Sentença"),
                                              ("laudo", "Laudo")])
def test_B18_linha_do_tempo_mostra_o_rotulo_e_nao_a_chave(client, db, cenario, categoria, rotulo):
    _salvar(db, models.Document(client_id=cenario.cli_ana, original_name="arq.pdf", file_path="x",
                                categoria=categoria, owner_id=cenario.ana))
    ev = client.get(f"/api/clients/{cenario.cli_ana}/timeline", headers=cenario.auth["ana"]).json()["events"]
    doc = next(e for e in ev if e["tipo"] == "documento" and e["titulo"].endswith("arq.pdf"))
    assert doc["detalhe"] == rotulo
