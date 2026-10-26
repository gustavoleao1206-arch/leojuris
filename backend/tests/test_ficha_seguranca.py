"""Correções de segurança no caminho da ficha (spec §3.4).

Cada uma é um alvo vindo do CORPO que só a primeira checagem via:
  * upload de documento — a cadeia `if/elif` checava só o 1º vínculo;
  * assinatura — com precatório próprio, o `client_id` de qualquer cliente
    passava e a resposta devolvia o NOME dele (oráculo de clientes);
  * precatório/ação — `client_id` do corpo sem checagem nenhuma.
E as listas fechadas novas (urgência, PF/PJ, origem, polo, instância).
"""
import os
from datetime import date

import pytest

from app import models

PDF = b"%PDF-1.4\n%teste\n"


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


def _docs(db):
    db.expire_all()
    return db.query(models.Document).count()


# ------------------------------- upload de documento -------------------------------
def test_cliente_e_processo_de_clientes_diferentes_400(client, db, cenario, limpar_uploads):
    antes = _docs(db)
    r = _upload(client, cenario.auth["admin"], client_id=cenario.cli_bruno, process_id=cenario.proc_ana)
    assert r.status_code == 400, r.text
    assert _docs(db) == antes


def test_cliente_proprio_com_processo_do_colega_403(client, db, cenario, limpar_uploads):
    antes = _docs(db)
    r = _upload(client, cenario.auth["ana"], client_id=cenario.cli_ana, process_id=cenario.proc_bruno)
    assert r.status_code == 403, r.text
    assert "PROC-BRUNO" not in r.text
    assert _docs(db) == antes


@pytest.mark.parametrize("campo", ["client_id", "process_id", "precatorio_id", "acao_id"])
def test_vinculo_inexistente_400(client, db, cenario, campo, limpar_uploads):
    antes = _docs(db)
    r = _upload(client, cenario.auth["ana"], **{campo: 999999})
    assert r.status_code == 400, r.text
    assert _docs(db) == antes


def test_so_process_id_herda_cliente_e_dono_do_processo(client, db, cenario, limpar_uploads):
    # Processo do Bruno preso ao cliente da Ana: o Bruno anexa no PRÓPRIO
    # processo sem precisar alcançar o cliente (antes era 403 se mandasse client_id).
    pb = models.Process(client_id=cenario.cli_ana, case_number="PB", owner_id=cenario.bruno)
    db.add(pb)
    db.commit()
    r = _upload(client, cenario.auth["bruno"], process_id=pb.id)
    assert r.status_code == 200, r.text
    assert r.json()["client_id"] == cenario.cli_ana
    db.expire_all()
    assert db.query(models.Document).get(r.json()["id"]).owner_id == cenario.bruno


def test_acao_e_precatorio_da_fila_aceitos(client, db, cenario, limpar_uploads):
    for campo, alvo in (("acao_id", cenario.acao_fila), ("precatorio_id", cenario.prec_fila)):
        r = _upload(client, cenario.auth["ana"], **{campo: alvo})
        assert r.status_code == 200, (campo, r.text)


def test_acao_e_precatorio_do_colega_403(client, db, cenario, limpar_uploads):
    antes = _docs(db)
    for campo, alvo in (("acao_id", cenario.acao_bruno), ("precatorio_id", cenario.prec_bruno)):
        r = _upload(client, cenario.auth["ana"], **{campo: alvo})
        assert r.status_code == 403, (campo, r.text)
    assert _docs(db) == antes


def test_precatorio_de_classificacao_proibida_403(client, db, cenario, limpar_uploads):
    import json
    from conftest import headers_de
    u = db.query(models.User).get(cenario.ana)
    u.permissions = json.dumps({"precatorios_classificacoes": ["sem_alvara"]})
    db.commit()
    antes = _docs(db)
    r = _upload(client, headers_de(u), precatorio_id=cenario.prec_fila)    # com_alvara
    assert r.status_code == 403, r.text
    assert _docs(db) == antes


# ------------------------------- assinatura -------------------------------
def test_assinatura_com_precatorio_proprio_e_cliente_alheio_403(client, db, cenario):
    db.expire_all()
    antes = db.query(models.Assinatura).count()
    r = client.post("/api/assinaturas", headers=cenario.auth["ana"], json={
        "tipo": "procuracao", "area": "precatorios",
        "precatorio_id": cenario.prec_ana, "client_id": cenario.cli_bruno,
    })
    assert r.status_code == 403, r.text
    assert "Cliente do Bruno" not in r.text
    db.expire_all()
    assert db.query(models.Assinatura).count() == antes


def test_assinatura_com_cliente_inexistente_400(client, db, cenario):
    r = client.post("/api/assinaturas", headers=cenario.auth["ana"], json={
        "tipo": "procuracao", "area": "precatorios",
        "precatorio_id": cenario.prec_ana, "client_id": 999999,
    })
    assert r.status_code == 400, r.text


# ------------------------------- precatório / ação: client_id -------------------------------
@pytest.mark.parametrize("base,alvo_fila", [("/api/precatorios", "prec_fila"), ("/api/acoes", "acao_fila")])
def test_lead_da_fila_ligado_a_cliente_alheio_salva_sem_mexer_no_vinculo(client, db, cenario, base, alvo_fila):
    # O admin ligou o lead da fila ao cliente da Ana. O Bruno edita uma
    # anotação: a tela manda o client_id atual junto — tem que salvar.
    modelo = models.Precatorio if base.endswith("precatorios") else models.Acao
    rid = getattr(cenario, alvo_fila)
    db.query(modelo).filter_by(id=rid).update({"client_id": cenario.cli_ana})
    db.commit()
    r = client.put(f"{base}/{rid}", headers=cenario.auth["bruno"],
                   json={"anotacoes": "liguei", "client_id": cenario.cli_ana})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(modelo).get(rid).client_id == cenario.cli_ana

    # Trocar PARA o cliente da Ana (de nenhum/outro) é que não pode.
    db.query(modelo).filter_by(id=rid).update({"client_id": None})
    db.commit()
    r = client.put(f"{base}/{rid}", headers=cenario.auth["bruno"], json={"client_id": cenario.cli_ana})
    assert r.status_code == 403, r.text
    db.expire_all()
    assert db.query(modelo).get(rid).client_id is None


@pytest.mark.parametrize("base,corpo", [
    ("/api/precatorios", {"requerente_nome": "Novo", "classificacao": "com_alvara"}),
    ("/api/acoes", {"parte_nome": "Nova", "area": "civel"}),
])
def test_criar_caso_com_cliente_alheio_ou_inexistente(client, db, cenario, base, corpo):
    r = client.post(base, headers=cenario.auth["ana"], json=dict(corpo, client_id=cenario.cli_bruno))
    assert r.status_code == 403, r.text
    r = client.post(base, headers=cenario.auth["ana"], json=dict(corpo, client_id=999999))
    assert r.status_code == 400, r.text
    r = client.post(base, headers=cenario.auth["ana"], json=dict(corpo, client_id=cenario.cli_ana))
    assert r.status_code == 200, r.text


# ------------------------------- listas fechadas -------------------------------
@pytest.mark.parametrize("valor", ["urgentissimo", "<b>x</b>"])
def test_urgencia_fora_da_lista_422(client, db, cenario, valor):
    r = client.post("/api/deadlines", headers=cenario.auth["ana"], json={
        "process_id": cenario.proc_ana, "date": "2026-12-20", "description": "x",
        "urgency_level": valor})
    assert r.status_code == 422
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", headers=cenario.auth["ana"],
                   json={"urgency_level": valor})
    assert r.status_code == 422
    pub = models.Publicacao(external_id="U1", hash="hu1", process_id=cenario.proc_ana,
                            owner_id=cenario.ana, data_disponibilizacao=date(2026, 9, 1))
    db.add(pub)
    db.commit()
    r = client.post(f"/api/publicacoes/{pub.id}/gerar-prazo", headers=cenario.auth["ana"],
                    json={"dias": 15, "urgency_level": valor})
    assert r.status_code == 422


def test_urgencia_fora_da_lista_ja_gravada_nao_quebra_leitura(client, db, cenario):
    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update({"urgency_level": "legado"})
    db.commit()
    assert client.get("/api/deadlines", headers=cenario.auth["ana"]).status_code == 200


def test_campos_novos_persistem_no_put(client, db, cenario):
    # ClientUpdate/ProcessUpdate NÃO herdam da Base: campo esquecido ali é
    # descartado em silêncio e o PUT responde 200 sem gravar.
    r = client.put(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"], json={
        "tipo_pessoa": "PJ", "nome_fantasia": "Padaria da Ana", "origem": "indicacao",
        "indicado_por": "Dr. Fulano"})
    assert r.status_code == 200, r.text
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"], json={
        "polo_cliente": "ativo", "instancia": "segundo_grau"})
    assert r.status_code == 200, r.text
    db.expire_all()
    c = db.query(models.Client).get(cenario.cli_ana)
    assert (c.tipo_pessoa, c.nome_fantasia, c.origem, c.indicado_por) == \
        ("PJ", "Padaria da Ana", "indicacao", "Dr. Fulano")
    p = db.query(models.Process).get(cenario.proc_ana)
    assert (p.polo_cliente, p.instancia) == ("ativo", "segundo_grau")
    # E saem na leitura.
    assert client.get(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"]).json()["origem"] == "indicacao"
    assert client.get(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"]).json()["instancia"] == "segundo_grau"


@pytest.mark.parametrize("url_fmt,corpo", [
    ("/api/clients/{cli}", {"tipo_pessoa": "PX"}),
    ("/api/clients/{cli}", {"origem": "tiktok"}),
    ("/api/processes/{proc}", {"polo_cliente": "lateral"}),
    ("/api/processes/{proc}", {"instancia": "terceiro_grau"}),
])
def test_campos_novos_fora_da_lista_422(client, cenario, url_fmt, corpo):
    url = url_fmt.format(cli=cenario.cli_ana, proc=cenario.proc_ana)
    assert client.put(url, headers=cenario.auth["ana"], json=corpo).status_code == 422


def test_criar_com_campos_novos(client, cenario):
    r = client.post("/api/clients", headers=cenario.auth["ana"], json={
        "name": "Empresa Nova", "tipo_pessoa": "PJ", "origem": "site"})
    assert r.status_code == 200 and r.json()["tipo_pessoa"] == "PJ"
    assert r.json()["processos_count"] == 0
    r = client.post("/api/clients", headers=cenario.auth["ana"], json={"name": "X", "origem": "radio"})
    assert r.status_code == 422
    r = client.post("/api/processes", headers=cenario.auth["ana"], json={
        "client_id": cenario.cli_ana, "polo_cliente": "passivo", "instancia": "primeiro_grau"})
    assert r.status_code == 200 and r.json()["polo_cliente"] == "passivo"


def test_valor_fora_da_lista_ja_gravado_nao_quebra_leitura(client, db, cenario):
    db.query(models.Client).filter_by(id=cenario.cli_ana).update(
        {"tipo_pessoa": "XX", "origem": "legado"})
    db.query(models.Process).filter_by(id=cenario.proc_ana).update(
        {"polo_cliente": "legado", "instancia": "legado"})
    db.commit()
    for url in ("/api/clients", f"/api/clients/{cenario.cli_ana}", "/api/processes",
                f"/api/processes/{cenario.proc_ana}"):
        assert client.get(url, headers=cenario.auth["ana"]).status_code == 200, url


def test_nome_do_cliente_nulo_422(client, cenario):
    r = client.put(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"], json={"name": None})
    assert r.status_code == 422


def test_csp_libera_brasilapi(client):
    csp = client.get("/api/health").headers["content-security-policy"]
    connect = next(d for d in csp.split("; ") if d.startswith("connect-src"))
    assert "https://brasilapi.com.br/api/cnpj/v1/" in connect.split()   # só o caminho do CNPJ
    assert "'unsafe-inline'" not in next(d for d in csp.split("; ") if d.startswith("script-src"))


# ------------------------------- null em coluna obrigatória -------------------------------
# O padrão `exclude_unset` + `setattr` dos PUT grava o `null` que vier no corpo.
# Em coluna NOT NULL isso era 500 (IntegrityError); em campo que o `*Out` lê como
# `str` (status, urgência) era PIOR: gravava, e a LISTAGEM inteira do módulo
# passava a dar 500 para todo mundo que enxerga aquele registro.
@pytest.mark.parametrize("corpo", [
    {"urgency_level": None}, {"urgency_level": ""},
    {"description": None}, {"description": "  "},
    {"date": None}, {"process_id": None},
])
def test_put_de_prazo_com_obrigatorio_nulo_422_e_lista_continua_de_pe(client, db, cenario, corpo):
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    assert client.get("/api/deadlines", headers=cenario.auth["ana"]).status_code == 200
    db.expire_all()
    d = db.query(models.Deadline).get(cenario.prazo_ana)
    assert (d.urgency_level, d.description) == ("media", "Contestação")


def test_put_de_prazo_so_com_done_continua_valendo(client, cenario):
    # A caixa "Cumprido" manda só `done`: o validator só roda no campo enviado.
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", headers=cenario.auth["ana"], json={"done": 1})
    assert r.status_code == 200 and r.json()["done"] == 1


@pytest.mark.parametrize("valor", [None, ""])
def test_criar_prazo_sem_urgencia_valida_422(client, cenario, valor):
    r = client.post("/api/deadlines", headers=cenario.auth["ana"], json={
        "process_id": cenario.proc_ana, "date": "2026-12-20", "description": "x",
        "urgency_level": valor})
    assert r.status_code == 422


@pytest.mark.parametrize("url_fmt", ["/api/clients/{cli}", "/api/processes/{proc}"])
def test_status_nulo_422_e_lista_continua_de_pe(client, cenario, url_fmt):
    url = url_fmt.format(cli=cenario.cli_ana, proc=cenario.proc_ana)
    assert client.put(url, headers=cenario.auth["ana"], json={"status": None}).status_code == 422
    lista = "/api/clients" if "clients" in url else "/api/processes"
    assert client.get(lista, headers=cenario.auth["ana"]).status_code == 200


@pytest.mark.parametrize("nome", ["", "   "])
def test_criar_cliente_sem_nome_422(client, cenario, nome):
    assert client.post("/api/clients", headers=cenario.auth["ana"], json={"name": nome}).status_code == 422


@pytest.mark.parametrize("campo", ["nome_fantasia", "indicado_por"])
def test_campo_novo_do_cliente_maior_que_a_coluna_422(client, cenario, campo):
    url = f"/api/clients/{cenario.cli_ana}"
    assert client.put(url, headers=cenario.auth["ana"], json={campo: "x" * 151}).status_code == 422
    assert client.put(url, headers=cenario.auth["ana"], json={campo: "x" * 150}).status_code == 200
    assert client.post("/api/clients", headers=cenario.auth["ana"],
                       json={"name": "Y", campo: "x" * 151}).status_code == 422
