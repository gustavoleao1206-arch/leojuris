"""Exclusão de cliente, processo e prazo — os 409 e as anulações.

A ficha ganhou um botão "Excluir" visível, e a cascata do ORM apaga muito:
cliente → processos → prazos/audiências/partes/andamentos, mais atendimentos,
contatos e documentos. Três riscos que estes testes seguram:

  1. APAGAR O QUE É DE OUTRO: a Ana excluindo o próprio cliente levava junto
     processos do Bruno presos a ele. Agora: 409 para quem não é admin.
  2. 500 NO POSTGRES: honorário, assinatura e publicação apontam para cliente/
     processo/prazo sem cascata. Honorário e assinatura BLOQUEIAM (409 — é
     dinheiro e contrato); publicação é desvinculada e fica.
  3. O 409 VIRAR ORÁCULO: a mensagem da Ana não pode contar os honorários e
     contratos do Bruno que o painel 360 esconde dela.

Publicações de teste são criadas DENTRO de cada teste (nunca no `cenario`),
como em test_excluir_publicacao.py — senão quebrariam a varredura de DELETE.
"""
from datetime import date

import pytest

from app import models


def _existe(db, modelo, rid):
    db.expire_all()
    return db.query(modelo).get(rid) is not None


def _pub(db, *, owner_id, client_id=None, process_id=None, deadline_id=None, ext="DJEN-T"):
    p = models.Publicacao(
        external_id=ext, hash=f"h-{ext}", tribunal="trf5",
        numero_processo="0000001-11.2026.4.05.9001", tipo_comunicacao="Intimação",
        data_disponibilizacao=date(2026, 9, 1), texto="inteiro teor", lida=0,
        owner_id=owner_id, client_id=client_id, process_id=process_id, deadline_id=deadline_id,
    )
    db.add(p)
    db.commit()
    return p.id


def _sem_honorarios_nem_contratos_na_ana(db, cenario):
    """Tira do cli_ana o que bloqueia — para testar o caminho que exclui."""
    db.query(models.Honorario).filter(models.Honorario.client_id == cenario.cli_ana).delete()
    db.query(models.Assinatura).filter(models.Assinatura.client_id == cenario.cli_ana).delete()
    db.commit()


# ------------------------------- cliente: bloqueios -------------------------------
def test_estagiario_nao_exclui_cliente_403_antes_de_tudo(client, db, cenario):
    # 403 (perfil), não 409: o bloqueio por vínculo vem DEPOIS do require_excluir.
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["estag"])
    assert r.status_code == 403
    assert _existe(db, models.Client, cenario.cli_ana)


def test_bruno_nao_alcanca_cliente_da_ana_403_sem_contagem(client, db, cenario):
    # Ensure_owner antes do 409: senão a mensagem contaria registros de um
    # cliente que ele nem pode ver.
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["bruno"])
    assert r.status_code == 403
    assert "honorário" not in r.text


def test_ana_com_processo_do_bruno_no_cliente_409_e_nada_apagado(client, db, cenario):
    _sem_honorarios_nem_contratos_na_ana(db, cenario)
    p = models.Process(client_id=cenario.cli_ana, case_number="PROC-BRUNO-NA-ANA",
                       owner_id=cenario.bruno)
    db.add(p)
    db.commit()
    prazo = models.Deadline(process_id=p.id, date=date(2026, 12, 3), description="Prazo do Bruno",
                            owner_id=cenario.bruno)
    db.add(prazo)
    db.commit()
    proc_id, prazo_id = p.id, prazo.id

    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409, r.text
    assert "outro responsável" in r.json()["detail"]
    assert "arquive" in r.json()["detail"]
    for modelo, rid in ((models.Client, cenario.cli_ana), (models.Process, proc_id),
                        (models.Deadline, prazo_id), (models.Process, cenario.proc_ana)):
        assert _existe(db, modelo, rid), modelo.__name__

    # O admin decide: ele exclui (e leva o processo do Bruno junto).
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["admin"])
    assert r.status_code == 200, r.text
    assert not _existe(db, models.Process, proc_id)


def test_409_da_ana_nao_conta_o_que_e_do_bruno(client, db, cenario):
    # No cenário: hon_ana (dela), hon_bruno (SÓ dele), parceria (dele, Ana parceira),
    # assin_ana (dela) e assin_bruno (dele) — todos presos ao cli_ana.
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409, r.text
    msg = r.json()["detail"]
    # Ela vê 2 honorários (o dela e a parceria) e 1 contrato — e só isso de número.
    assert "2 honorários" in msg and "1 contrato/procuração" in msg
    assert "outros registros de outro responsável" in msg
    assert "3 honorários" not in msg and "2 contratos" not in msg
    assert "Bruno" not in msg and "50" not in msg
    assert _existe(db, models.Client, cenario.cli_ana)


def test_409_do_admin_traz_as_contagens(client, db, cenario):
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["admin"])
    assert r.status_code == 409, r.text
    msg = r.json()["detail"]
    assert "3 honorários" in msg and "2 contratos/procurações" in msg
    assert "outro responsável" not in msg


def test_honorario_so_no_processo_bloqueia_a_exclusao_do_cliente(client, db, cenario):
    _sem_honorarios_nem_contratos_na_ana(db, cenario)
    h = models.Honorario(process_id=cenario.proc_ana, total_value=500, paid_value=0,
                         status="pendente", owner_id=cenario.ana, created_by=cenario.ana)
    db.add(h)
    db.commit()
    for papel in ("ana", "admin"):
        r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth[papel])
        assert r.status_code == 409, (papel, r.text)
    for modelo, rid in ((models.Client, cenario.cli_ana), (models.Process, cenario.proc_ana),
                        (models.Deadline, cenario.prazo_ana), (models.Honorario, h.id),
                        (models.Atendimento, cenario.atend_ana)):
        assert _existe(db, modelo, rid), modelo.__name__


def test_assinatura_bloqueia_a_exclusao_do_cliente(client, db, cenario):
    db.query(models.Honorario).filter(models.Honorario.client_id == cenario.cli_ana).delete()
    db.query(models.Assinatura).filter(models.Assinatura.id == cenario.assin_bruno).delete()
    db.commit()
    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409
    assert "1 contrato/procuração" in r.json()["detail"]
    assert "outro responsável" not in r.json()["detail"]


# ------------------------------- cliente: anulações -------------------------------
def test_admin_exclui_cliente_e_publicacao_fica_desvinculada_com_o_mesmo_dono(client, db, cenario):
    _sem_honorarios_nem_contratos_na_ana(db, cenario)
    # Publicação que gerou o prazo do processo do cliente: 3 FKs para o que some.
    pub_prazo = _pub(db, owner_id=cenario.ana, client_id=cenario.cli_ana,
                     process_id=cenario.proc_ana, deadline_id=cenario.prazo_ana, ext="P1")
    pub_cliente = _pub(db, owner_id=cenario.ana, client_id=cenario.cli_ana, ext="P2")

    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["admin"])
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
    db.expire_all()
    for pid in (pub_prazo, pub_cliente):
        p = db.query(models.Publicacao).get(pid)
        assert p is not None, "a intimação é prova de prazo: não pode sumir"
        assert (p.client_id, p.process_id, p.deadline_id) == (None, None, None)
        # 🚨 O MESMO dono: zerar mandaria para a fila, que todo advogado lê.
        assert p.owner_id == cenario.ana
    # E o Bruno continua sem acesso a ela.
    assert client.get(f"/api/publicacoes/{pub_prazo}", headers=cenario.auth["bruno"]).status_code == 403
    # O que ia junto, foi.
    for modelo, rid in ((models.Process, cenario.proc_ana), (models.Deadline, cenario.prazo_ana),
                        (models.Atendimento, cenario.atend_ana),
                        (models.ClienteContato, cenario.contato_cli_ana),
                        (models.ProcessoParte, cenario.parte_ana),
                        (models.ProcessoAndamento, cenario.andamento_ana),
                        (models.Document, cenario.doc_ana)):
        assert not _existe(db, modelo, rid), modelo.__name__


def test_excluir_cliente_solta_precatorio_acao_e_documento_de_caso(client, db, cenario):
    _sem_honorarios_nem_contratos_na_ana(db, cenario)
    db.query(models.Precatorio).filter_by(id=cenario.prec_ana).update({"client_id": cenario.cli_ana})
    db.query(models.Acao).filter_by(id=cenario.acao_ana).update({"client_id": cenario.cli_ana})
    doc_caso = models.Document(client_id=cenario.cli_ana, precatorio_id=cenario.prec_ana,
                               original_name="do-precatorio.pdf", file_path="x", owner_id=cenario.ana)
    # Documento preso SÓ a um processo do cliente: vai junto com o cliente.
    doc_proc = models.Document(process_id=cenario.proc_ana, original_name="do-processo.pdf",
                               file_path="x", owner_id=cenario.ana)
    db.add_all([doc_caso, doc_proc])
    db.commit()
    caso_id, proc_doc_id = doc_caso.id, doc_proc.id

    r = client.delete(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(models.Precatorio).get(cenario.prec_ana).client_id is None
    assert db.query(models.Acao).get(cenario.acao_ana).client_id is None
    d = db.query(models.Document).get(caso_id)
    assert d is not None and d.client_id is None and d.precatorio_id == cenario.prec_ana
    assert db.query(models.Document).get(proc_doc_id) is None


# ------------------------------- processo -------------------------------
def test_processo_com_honorario_409(client, db, cenario):
    h = models.Honorario(process_id=cenario.proc_ana, total_value=500, paid_value=0,
                         status="pendente", owner_id=cenario.ana, created_by=cenario.ana)
    db.add(h)
    db.commit()
    r = client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409, r.text
    assert "1 honorário" in r.json()["detail"]
    assert _existe(db, models.Process, cenario.proc_ana)
    assert _existe(db, models.Deadline, cenario.prazo_ana)


def test_processo_com_honorario_de_outro_dono_409_sem_numero(client, db, cenario):
    h = models.Honorario(process_id=cenario.proc_ana, total_value=500, paid_value=0,
                         status="pendente", owner_id=cenario.bruno, created_by=cenario.admin)
    db.add(h)
    db.commit()
    r = client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 409
    msg = r.json()["detail"]
    assert "outro responsável" in msg and "1 honorário" not in msg


def test_excluir_processo_desvincula_publicacao_e_preserva_o_resto(client, db, cenario):
    pub = _pub(db, owner_id=cenario.ana, client_id=cenario.cli_ana,
               process_id=cenario.proc_ana, deadline_id=cenario.prazo_ana, ext="P3")
    doc_proc = models.Document(process_id=cenario.proc_ana, original_name="peticao.pdf",
                               file_path="x", owner_id=cenario.ana)
    db.add(doc_proc)
    db.commit()
    doc_id = doc_proc.id

    r = client.delete(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 200, r.text
    db.expire_all()
    p = db.query(models.Publicacao).get(pub)
    assert p.process_id is None and p.deadline_id is None
    assert p.client_id == cenario.cli_ana and p.owner_id == cenario.ana
    # Documento do processo passa a ser do cliente (não fica órfão).
    d = db.query(models.Document).get(doc_id)
    assert d.process_id is None and d.client_id == cenario.cli_ana
    # Atendimento fica no cliente, sem o processo.
    a = db.query(models.Atendimento).get(cenario.atend_ana)
    assert a is not None and a.process_id is None
    assert not _existe(db, models.ProcessoParte, cenario.parte_ana)
    assert not _existe(db, models.ProcessoAndamento, cenario.andamento_ana)


def test_estagiario_nao_exclui_processo(client, db, cenario):
    assert client.delete(f"/api/processes/{cenario.proc_ana}",
                         headers=cenario.auth["estag"]).status_code == 403
    assert _existe(db, models.Process, cenario.proc_ana)


# ------------------------------- prazo -------------------------------
def test_excluir_prazo_gerado_por_publicacao_200(client, db, cenario):
    pub = _pub(db, owner_id=cenario.ana, process_id=cenario.proc_ana,
               deadline_id=cenario.prazo_ana, ext="P4")
    r = client.delete(f"/api/deadlines/{cenario.prazo_ana}", headers=cenario.auth["ana"])
    assert r.status_code == 200, r.text
    db.expire_all()
    p = db.query(models.Publicacao).get(pub)
    assert p is not None and p.deadline_id is None
    assert p.process_id == cenario.proc_ana and p.owner_id == cenario.ana


def test_prazo_gerado_pelo_djen_e_excluido_pela_api(client, db, cenario):
    # O fluxo real: gerar-prazo a partir da publicação e depois excluir o prazo.
    pub = _pub(db, owner_id=cenario.ana, client_id=cenario.cli_ana,
               process_id=cenario.proc_ana, ext="P5")
    r = client.post(f"/api/publicacoes/{pub}/gerar-prazo", headers=cenario.auth["ana"],
                    json={"dias": 15})
    assert r.status_code == 200, r.text
    prazo = r.json()["deadline_id"]
    assert client.delete(f"/api/deadlines/{prazo}", headers=cenario.auth["ana"]).status_code == 200
    db.expire_all()
    assert db.query(models.Publicacao).get(pub).deadline_id is None
