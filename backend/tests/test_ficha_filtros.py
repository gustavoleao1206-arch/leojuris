"""Filtros novos das listas (fichas) e a busca nova de Clientes/Processos.

A regra de ouro dos filtros: SÓ RESTRINGEM. `?client_id=`, `?process_id=` etc.
são aplicados DEPOIS do escopo da tela de cada módulo — nunca devolvem um
registro que a mesma pessoa não veria na listagem sem filtro. O teste de régua
roda cada filtro para os quatro perfis e compara com a listagem do módulo.

E o export de Processos segue a tela: busca (`q`), responsável e "só com prazo
vencido" entram na mesma `query_processes` — e o termo da busca vai para a
trilha pseudonimizado, nunca cru (é nome de cliente / de parte / nº de processo).
"""
import re
from datetime import date, datetime, timedelta

import pytest

from app import models
from app.prazos import hoje_local


@pytest.fixture
def mistura(db, cenario):
    """Coisa do Bruno presa ao cliente da Ana, em todos os módulos com filtro novo."""
    pb = models.Process(client_id=cenario.cli_ana, case_number="0801234-56.2026.4.05.8000",
                        owner_id=cenario.bruno, assunto="Revisão de benefício")
    db.add(pb)
    db.commit()
    db.add_all([
        models.Deadline(process_id=pb.id, date=date(2026, 11, 1), description="Prazo do Bruno",
                        owner_id=cenario.bruno),
        models.Appointment(process_id=pb.id, date_time=datetime(2026, 11, 2, 10, 0),
                           location="Vara do Bruno", owner_id=cenario.bruno),
        models.Document(process_id=pb.id, client_id=cenario.cli_ana, original_name="do-bruno.pdf",
                        file_path="x", owner_id=cenario.bruno),
        models.Document(process_id=cenario.proc_ana, original_name="so-do-processo.pdf",
                        file_path="x", owner_id=cenario.ana),
        models.Honorario(process_id=pb.id, total_value=7, paid_value=0, status="pendente",
                         owner_id=cenario.bruno, created_by=cenario.bruno),
        models.Honorario(process_id=cenario.proc_ana, total_value=9, paid_value=0,
                         status="pendente", owner_id=cenario.ana, created_by=cenario.ana),
        models.Publicacao(external_id="F1", hash="hf1", process_id=pb.id, client_id=cenario.cli_ana,
                          owner_id=cenario.bruno, texto="teor do Bruno", lida=0,
                          data_disponibilizacao=date(2026, 9, 1)),
        models.Publicacao(external_id="F2", hash="hf2", process_id=cenario.proc_ana,
                          client_id=cenario.cli_ana, owner_id=cenario.ana, texto="teor da Ana",
                          lida=0, data_disponibilizacao=date(2026, 9, 2)),
        models.Publicacao(external_id="F3", hash="hf3", process_id=cenario.proc_ana,
                          owner_id=cenario.ana, texto="teor arquivado", lida=1, arquivada=1,
                          data_disponibilizacao=date(2026, 8, 2)),
    ])
    db.commit()
    return pb.id


# (rota, parâmetros do filtro) — {cli}/{proc} viram ids do cenário
FILTROS = [
    ("/api/deadlines", {"client_id": "{cli}"}),
    ("/api/deadlines", {"process_id": "{proc}"}),
    ("/api/appointments", {"client_id": "{cli}"}),
    ("/api/appointments", {"process_id": "{proc}"}),
    ("/api/documents", {"client_id": "{cli}", "incluir_processos": "1"}),
    ("/api/documents", {"process_id": "{proc}"}),
    ("/api/honorarios", {"client_id": "{cli}"}),
    ("/api/honorarios", {"process_id": "{proc}"}),
    ("/api/assinaturas", {"client_id": "{cli}"}),
    ("/api/publicacoes", {"client_id": "{cli}"}),
    ("/api/publicacoes", {"process_id": "{proc}"}),
    ("/api/processes", {"client_id": "{cli}"}),
]


def _ids(resp):
    return {item["id"] for item in resp.json()} if resp.status_code == 200 else set()


@pytest.mark.parametrize("papel", ["ana", "bruno", "estag", "admin"])
@pytest.mark.parametrize("rota,params", FILTROS)
def test_filtro_nunca_traz_mais_que_a_listagem(client, cenario, mistura, rota, params, papel):
    h = cenario.auth[papel]
    p = {k: v.format(cli=cenario.cli_ana, proc=cenario.proc_ana) for k, v in params.items()}
    filtrado = client.get(rota, params=p, headers=h)
    # Publicações: a listagem sem filtro mostra caixa OU arquivo; com filtro
    # mostra os dois — a régua é a união das duas listagens.
    sem_filtro = _ids(client.get(rota, headers=h))
    if rota == "/api/publicacoes":
        sem_filtro |= _ids(client.get(rota, params={"arquivadas": 1}, headers=h))
    assert filtrado.status_code in (200, 403)
    assert _ids(filtrado) <= sem_filtro, f"{rota} {p} ({papel}) trouxe {_ids(filtrado) - sem_filtro}"


def test_filtros_da_ficha_trazem_o_que_devem(client, cenario, mistura):
    h = cenario.auth["ana"]
    assert _ids(client.get("/api/deadlines", params={"client_id": cenario.cli_ana}, headers=h)) \
        == {cenario.prazo_ana}
    assert _ids(client.get("/api/appointments", params={"process_id": cenario.proc_ana}, headers=h)) \
        == {cenario.agenda_ana}
    docs = client.get("/api/documents", params={"client_id": cenario.cli_ana,
                                                "incluir_processos": 1}, headers=h).json()
    nomes = {d["original_name"] for d in docs}
    assert nomes == {"rg.pdf", "so-do-processo.pdf"}           # nada do Bruno
    # Sem incluir_processos, só o que tem client_id (comportamento antigo).
    docs = client.get("/api/documents", params={"client_id": cenario.cli_ana}, headers=h).json()
    assert {d["original_name"] for d in docs} == {"rg.pdf"}
    # Honorário lançado SÓ no processo do cliente entra no filtro do cliente.
    hons = client.get("/api/honorarios", params={"client_id": cenario.cli_ana}, headers=h).json()
    assert 9 in {x["total_value"] for x in hons} and 7 not in {x["total_value"] for x in hons}


def test_publicacoes_da_ficha_trazem_teor_nao_marcam_lida_e_incluem_arquivo(client, db, cenario, mistura):
    h = cenario.auth["ana"]
    r = client.get("/api/publicacoes", params={"process_id": cenario.proc_ana}, headers=h)
    assert r.status_code == 200
    itens = r.json()
    assert {p["texto"] for p in itens} == {"teor da Ana", "teor arquivado"}
    assert {p["arquivada"] for p in itens} == {0, 1}
    assert "teor do Bruno" not in r.text
    db.expire_all()
    # Listar NÃO marca como lida (o campo é único para o escritório inteiro).
    assert db.query(models.Publicacao).filter_by(external_id="F2").one().lida == 0
    # A caixa do Monitoramento continua igual: sem teor e sem arquivadas.
    caixa = client.get("/api/publicacoes", headers=h).json()
    assert all("texto" not in p for p in caixa)
    assert all(p["arquivada"] == 0 for p in caixa)


# ------------------------------- busca de clientes -------------------------------
@pytest.mark.parametrize("termo", ["97777", "(82) 9", "222222", "222.222.222-22", "ana@"])
def test_busca_de_cliente_por_digitos_e_email(client, db, cenario, termo):
    db.query(models.Client).filter_by(id=cenario.cli_ana).update({
        "celular": "(82) 97777-1234", "email": "ana@cliente.test"})
    db.commit()
    r = client.get("/api/clients", params={"search": termo}, headers=cenario.auth["ana"])
    assert r.status_code == 200
    assert cenario.cli_ana in _ids(r), termo


def test_busca_de_cliente_por_digitos_nao_alcanca_o_colega(client, cenario):
    # CPF_BRUNO "333.333.333-33": a Ana busca e não acha (scope primeiro).
    r = client.get("/api/clients", params={"search": "333333"}, headers=cenario.auth["ana"])
    assert r.json() == []
    r = client.get("/api/clients", params={"search": "333333"}, headers=cenario.auth["admin"])
    assert cenario.cli_bruno in _ids(r)


def test_busca_com_menos_de_3_digitos_nao_casa_digitos(client, cenario):
    # "22" está no CPF da Ana, mas 2 dígitos casariam meio mundo.
    r = client.get("/api/clients", params={"search": "22"}, headers=cenario.auth["ana"])
    assert r.json() == []


def test_lista_de_clientes_conta_so_processos_alcancaveis(client, db, cenario, mistura):
    r = client.get("/api/clients", headers=cenario.auth["ana"])
    item = next(c for c in r.json() if c["id"] == cenario.cli_ana)
    assert item["processos_count"] == 1                       # o do Bruno não conta
    r = client.get("/api/clients", headers=cenario.auth["admin"])
    item = next(c for c in r.json() if c["id"] == cenario.cli_ana)
    assert item["processos_count"] == 2


# ------------------------------- busca/filtros de processos -------------------------------
@pytest.mark.parametrize("termo", ["08012345", "0801234-56", "80123456202", "Revisão de benef",
                                   "Empresa Ré"])
def test_q_de_processo(client, db, cenario, mistura, termo):
    # O processo do Bruno é achado pelo admin; a parte contrária está no da Ana.
    r = client.get("/api/processes", params={"q": termo}, headers=cenario.auth["admin"])
    assert r.status_code == 200
    esperado = cenario.proc_ana if termo == "Empresa Ré" else mistura
    assert esperado in _ids(r), termo


def test_q_por_nome_do_cliente_e_escopo(client, cenario, mistura):
    r = client.get("/api/processes", params={"q": "Cliente da Ana"}, headers=cenario.auth["ana"])
    assert _ids(r) == {cenario.proc_ana}                      # o do Bruno fica de fora
    r = client.get("/api/processes", params={"q": "Cliente da Ana"}, headers=cenario.auth["admin"])
    assert _ids(r) == {cenario.proc_ana, mistura}


def test_item_de_processo_traz_proximo_prazo_e_partes_contrarias(client, cenario, mistura):
    r = client.get("/api/processes", headers=cenario.auth["ana"])
    item = next(p for p in r.json() if p["id"] == cenario.proc_ana)
    assert item["proximo_prazo"] == "2026-12-01"
    assert item["partes_contrarias"] == "Empresa Ré Ltda"


def test_proximo_prazo_ignora_cumprido(client, db, cenario):
    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update({"done": 1})
    db.commit()
    item = client.get(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"]).json()
    assert item["proximo_prazo"] is None


def test_responsavel(client, cenario, mistura):
    # Admin filtra por qualquer pessoa.
    r = client.get("/api/processes", params={"responsavel": cenario.bruno}, headers=cenario.auth["admin"])
    assert _ids(r) == {cenario.proc_bruno, mistura}
    # Para os demais, id de outra pessoa vira "meus".
    r = client.get("/api/processes", params={"responsavel": cenario.bruno}, headers=cenario.auth["ana"])
    assert _ids(r) == {cenario.proc_ana}
    r = client.get("/api/processes", params={"responsavel": cenario.bruno}, headers=cenario.auth["estag"])
    assert _ids(r) == set()
    r = client.get("/api/processes", params={"responsavel": "meus"}, headers=cenario.auth["ana"])
    assert _ids(r) == {cenario.proc_ana}
    assert client.get("/api/processes", params={"responsavel": "xyz"},
                      headers=cenario.auth["ana"]).status_code == 400


def test_vencido(client, db, cenario, mistura):
    ontem = hoje_local() - timedelta(days=1)
    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update({"date": ontem})
    db.commit()
    r = client.get("/api/processes", params={"vencido": 1}, headers=cenario.auth["admin"])
    assert _ids(r) == {cenario.proc_ana}
    # Cumprido não conta; e vencendo HOJE ainda não venceu.
    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update({"date": hoje_local()})
    db.commit()
    assert _ids(client.get("/api/processes", params={"vencido": 1},
                           headers=cenario.auth["admin"])) == set()


def test_vencido_so_conta_prazo_que_a_pessoa_ve(client, db, cenario):
    # Prazo vencido do Bruno no processo da Ana (gravado direto): ela não o
    # vê na tela de Prazos, então ele não marca o processo dela como vencido.
    db.add(models.Deadline(process_id=cenario.proc_ana, date=hoje_local() - timedelta(days=3),
                           description="do Bruno", owner_id=cenario.bruno))
    db.commit()
    assert _ids(client.get("/api/processes", params={"vencido": 1},
                           headers=cenario.auth["ana"])) == set()
    assert _ids(client.get("/api/processes", params={"vencido": 1},
                           headers=cenario.auth["admin"])) == {cenario.proc_ana}


# ------------------------------- export -------------------------------
def _ultimo_export(db):
    db.expire_all()
    return (db.query(models.AuditLog).filter(models.AuditLog.method == "EXPORT")
            .order_by(models.AuditLog.id.desc()).first().path)


def _linhas(path):
    return int(re.search(r"\[(\d+) registro", path).group(1))


def test_export_de_processos_segue_q_responsavel_e_vencido(client, db, cenario, mistura):
    h = cenario.auth["admin"]
    assert client.get("/api/export/processos", headers=h).status_code == 200
    assert _linhas(_ultimo_export(db)) == 3

    assert client.get("/api/export/processos", params={"q": "0801234"}, headers=h).status_code == 200
    trilha = _ultimo_export(db)
    assert _linhas(trilha) == 1
    # O termo da busca vai pseudonimizado — nunca cru na auditoria.
    assert "0801234" not in trilha and re.search(r"q=#[0-9a-f]{10}", trilha)

    client.get("/api/export/processos", params={"responsavel": cenario.bruno}, headers=h)
    assert _linhas(_ultimo_export(db)) == 2

    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update(
        {"date": hoje_local() - timedelta(days=2)})
    db.commit()
    client.get("/api/export/processos", params={"vencido": 1}, headers=h)
    assert _linhas(_ultimo_export(db)) == 1


def test_export_de_clientes_segue_a_busca_nova(client, db, cenario):
    client.get("/api/export/clientes", params={"search": "222222"}, headers=cenario.auth["admin"])
    assert _linhas(_ultimo_export(db)) == 1


def test_dias_restantes_do_prazo_contam_pelo_dia_de_brasilia(client, db, cenario, monkeypatch):
    # Às 22h de Brasília o `date.today()` do servidor (UTC) já é amanhã: o
    # prazo que vence HOJE saía com days_left = -1 (vencido).
    from app.routers import deadlines
    hoje = date(2026, 12, 1)
    monkeypatch.setattr(deadlines, "hoje_local", lambda: hoje)
    db.query(models.Deadline).filter_by(id=cenario.prazo_ana).update({"date": hoje})
    db.commit()
    prazos = client.get("/api/deadlines", params={"process_id": cenario.proc_ana},
                        headers=cenario.auth["ana"]).json()
    assert [p["days_left"] for p in prazos] == [0]
