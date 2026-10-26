"""Linhas do tempo do cliente e do processo + troca de responsável.

Linha do tempo: cada bloco com a régua do PRÓPRIO módulo. A versão antiga lia
`p.deadlines`/`p.documents` pela relação, sem escopo nem módulo — quem não
tinha Prazos via os prazos ali, e o novo responsável de um processo
transferido via o que a tela de Prazos lhe escondia (ou o contrário).

Troca de responsável: prazo/audiência/documento/publicação recebem o dono só
ao nascer. Se o admin transfere o processo e nada vai junto, a ficha do novo
responsável abre com a aba de prazos VAZIA — prazo processual perdido.
"""
from datetime import date

import pytest

from app import models

TIPOS = {"cadastro", "processo", "prazo", "audiencia", "documento", "andamento", "publicacao",
         "atendimento", "honorario", "parte", "assinatura"}
CAMPOS = {"tipo", "data", "titulo", "detalhe", "processo_id", "processo_numero", "ref_id", "autor"}


def _tl(client, cenario, papel, url):
    r = client.get(url, headers=cenario.auth[papel])
    assert r.status_code == 200, r.text[:200]
    return r.json()


def test_formato_da_timeline_do_processo(client, db, cenario):
    db.add(models.Publicacao(external_id="T1", hash="ht1", process_id=cenario.proc_ana,
                             owner_id=cenario.ana, tipo_comunicacao="Intimação", tribunal="TJAL",
                             data_disponibilizacao=date(2026, 9, 20), texto="x"))
    db.commit()
    corpo = _tl(client, cenario, "ana", f"/api/processes/{cenario.proc_ana}/timeline")
    assert set(corpo) == {"processo", "cliente", "events"}
    assert corpo["processo"] == "PROC-ANA" and corpo["cliente"] == "Cliente da Ana"
    eventos = corpo["events"]
    assert all(set(e) == CAMPOS for e in eventos)
    assert {e["tipo"] for e in eventos} <= TIPOS
    tipos = {e["tipo"] for e in eventos}
    assert {"cadastro", "prazo", "audiencia", "andamento", "parte", "publicacao",
            "atendimento"} <= tipos
    # Mais recente primeiro.
    datas = [e["data"] for e in eventos]
    assert datas == sorted(datas, reverse=True)
    prazo = next(e for e in eventos if e["tipo"] == "prazo")
    assert prazo["titulo"] == "Prazo cadastrado: Contestação"
    assert "vence 01/12/2026" in prazo["detalhe"]
    aud = next(e for e in eventos if e["tipo"] == "audiencia")
    assert aud["titulo"] == "Audiência marcada para 02/12/2026 14:00"
    assert all(e["processo_id"] == cenario.proc_ana for e in eventos)
    andamento = next(e for e in eventos if e["tipo"] == "andamento")
    assert andamento["data"] == "2026-09-15" and andamento["autor"] == "Ana Advogada"


def test_timeline_do_cliente_reune_cliente_e_processos(client, cenario):
    corpo = _tl(client, cenario, "ana", f"/api/clients/{cenario.cli_ana}/timeline")
    assert set(corpo) == {"cliente", "events"}
    tipos = {e["tipo"] for e in corpo["events"]}
    assert {"cadastro", "processo", "prazo", "audiencia", "documento", "andamento",
            "atendimento", "honorario", "parte", "assinatura"} <= tipos
    # Nunca chave crua nos títulos.
    for e in corpo["events"]:
        assert "documento_pessoal" not in (e["titulo"] or "") + (e["detalhe"] or "")
        assert "ligacao" not in (e["titulo"] or "")


def test_timeline_sem_financeiro_nao_traz_honorario(client, cenario):
    for url in (f"/api/clients/{cenario.cli_ana}/timeline",
                f"/api/processes/{cenario.proc_ana}/timeline"):
        corpo = _tl(client, cenario, "estag", url)
        assert not [e for e in corpo["events"] if e["tipo"] == "honorario"], url
        assert "Honorário" not in str(corpo)


def test_timeline_do_cliente_nao_traz_honorario_nem_contrato_do_colega(client, cenario):
    corpo = _tl(client, cenario, "ana", f"/api/clients/{cenario.cli_ana}/timeline")
    hons = {e["ref_id"] for e in corpo["events"] if e["tipo"] == "honorario"}
    assert hons == {cenario.hon_ana, cenario.hon_parceria}
    # A parceria aparece com a PARTE dela (30% de 10.000), não com o total.
    parceria = next(e for e in corpo["events"]
                    if e["tipo"] == "honorario" and e["ref_id"] == cenario.hon_parceria)
    assert "3.000,00" in parceria["titulo"]
    assinaturas = {e["ref_id"] for e in corpo["events"] if e["tipo"] == "assinatura"}
    assert assinaturas == {cenario.assin_ana}


def test_timeline_do_cliente_omite_processo_do_colega(client, db, cenario):
    pb = models.Process(client_id=cenario.cli_ana, case_number="PROC-BRUNO-X", owner_id=cenario.bruno)
    db.add(pb)
    db.commit()
    db.add_all([
        models.Deadline(process_id=pb.id, date=date(2026, 11, 9), description="Prazo secreto",
                        owner_id=cenario.bruno),
        models.ProcessoAndamento(process_id=pb.id, data=date(2026, 9, 9), titulo="Andamento secreto"),
        models.Atendimento(client_id=cenario.cli_ana, process_id=pb.id, descricao="Sobre o do Bruno"),
    ])
    db.commit()
    r = client.get(f"/api/clients/{cenario.cli_ana}/timeline", headers=cenario.auth["ana"])
    assert "PROC-BRUNO-X" not in r.text
    assert "Prazo secreto" not in r.text and "Andamento secreto" not in r.text
    at = next(e for e in r.json()["events"] if e["detalhe"] == "Sobre o do Bruno")
    assert at["processo_id"] is None and at["processo_numero"] is None
    # Controle: o admin vê tudo isso.
    r = client.get(f"/api/clients/{cenario.cli_ana}/timeline", headers=cenario.auth["admin"])
    assert "PROC-BRUNO-X" in r.text and "Prazo secreto" in r.text


def test_timeline_do_processo_sem_acesso_ao_cliente_omite_atendimentos(client, db, cenario):
    # Processo do Bruno preso ao cliente da Ana: ele abre o processo, mas o
    # cliente não é dele — os atendimentos (que são do cliente) ficam de fora.
    pb = models.Process(client_id=cenario.cli_ana, case_number="PROC-BRUNO-Y", owner_id=cenario.bruno)
    db.add(pb)
    db.commit()
    db.add(models.Atendimento(client_id=cenario.cli_ana, process_id=pb.id, descricao="Conversa com a Ana"))
    db.commit()
    corpo = _tl(client, cenario, "bruno", f"/api/processes/{pb.id}/timeline")
    assert not [e for e in corpo["events"] if e["tipo"] == "atendimento"]
    assert "Conversa com a Ana" not in str(corpo)
    corpo = _tl(client, cenario, "admin", f"/api/processes/{pb.id}/timeline")
    assert [e for e in corpo["events"] if e["tipo"] == "atendimento"]


def test_timeline_respeita_documento_de_precatorio_proibido(client, db, cenario):
    # Documento do processo da Ana preso a um precatório que ela não pode ver
    # (classificação restrita): some da linha do tempo como some de Documentos.
    import json
    from conftest import headers_de
    prec = models.Precatorio(requerente_nome="Proibido", classificacao="cancelado", owner_id=cenario.ana)
    db.add(prec)
    db.commit()
    db.add(models.Document(process_id=cenario.proc_ana, precatorio_id=prec.id,
                           original_name="proibido.pdf", file_path="x", owner_id=cenario.ana))
    u = db.query(models.User).get(cenario.ana)
    u.permissions = json.dumps({"precatorios_classificacoes": ["com_alvara"]})
    db.commit()
    r = client.get(f"/api/processes/{cenario.proc_ana}/timeline", headers=headers_de(u))
    assert r.status_code == 200 and "proibido.pdf" not in r.text


# ------------------------------- troca de responsável -------------------------------
def test_admin_passa_processo_ao_bruno_e_os_prazos_vao_junto(client, db, cenario):
    pub = models.Publicacao(external_id="R1", hash="hr1", process_id=cenario.proc_ana,
                            owner_id=cenario.ana, texto="x", data_disponibilizacao=date(2026, 9, 1))
    doc = models.Document(process_id=cenario.proc_ana, client_id=cenario.cli_ana,
                          original_name="peca.pdf", file_path="x", owner_id=cenario.ana)
    db.add_all([pub, doc])
    db.commit()
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["admin"],
                   json={"owner_id": cenario.bruno})
    assert r.status_code == 200, r.text

    url = f"/api/deadlines?process_id={cenario.proc_ana}"
    assert {d["id"] for d in client.get(url, headers=cenario.auth["bruno"]).json()} == {cenario.prazo_ana}
    assert client.get(url, headers=cenario.auth["ana"]).json() == []
    agenda = client.get(f"/api/appointments?process_id={cenario.proc_ana}", headers=cenario.auth["bruno"])
    assert {a["id"] for a in agenda.json()} == {cenario.agenda_ana}

    tl = _tl(client, cenario, "bruno", f"/api/processes/{cenario.proc_ana}/timeline")
    assert {"prazo", "audiencia", "documento", "publicacao"} <= {e["tipo"] for e in tl["events"]}
    assert client.get(f"/api/processes/{cenario.proc_ana}/timeline",
                      headers=cenario.auth["ana"]).status_code == 403

    db.expire_all()
    assert db.query(models.Publicacao).filter_by(external_id="R1").one().owner_id == cenario.bruno
    # Honorário e assinatura NÃO mudam de dono.
    assert db.query(models.Honorario).get(cenario.hon_ana).owner_id == cenario.ana


def test_advogado_nao_troca_responsavel(client, db, cenario):
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"],
                   json={"owner_id": cenario.bruno})
    assert r.status_code == 200
    db.expire_all()
    assert db.query(models.Process).get(cenario.proc_ana).owner_id == cenario.ana
    assert db.query(models.Deadline).get(cenario.prazo_ana).owner_id == cenario.ana


def test_responsavel_inexistente_400(client, db, cenario):
    for url in (f"/api/processes/{cenario.proc_ana}", f"/api/clients/{cenario.cli_ana}"):
        r = client.put(url, headers=cenario.auth["admin"], json={"owner_id": 99999})
        assert r.status_code == 400, url
    db.expire_all()
    assert db.query(models.Process).get(cenario.proc_ana).owner_id == cenario.ana


def test_admin_passa_cliente_ao_bruno_e_os_documentos_dele_vao_junto(client, db, cenario):
    doc_proc = models.Document(process_id=cenario.proc_ana, client_id=cenario.cli_ana,
                               original_name="do-processo.pdf", file_path="x", owner_id=cenario.ana)
    pub_cli = models.Publicacao(external_id="R2", hash="hr2", client_id=cenario.cli_ana,
                                owner_id=cenario.ana, texto="x")
    db.add_all([doc_proc, pub_cli])
    db.commit()
    doc_proc_id = doc_proc.id
    r = client.put(f"/api/clients/{cenario.cli_ana}", headers=cenario.auth["admin"],
                   json={"owner_id": cenario.bruno})
    assert r.status_code == 200, r.text
    db.expire_all()
    # Documento SÓ do cliente acompanha; o do processo segue o dono do processo.
    assert db.query(models.Document).get(cenario.doc_ana).owner_id == cenario.bruno
    assert db.query(models.Document).get(doc_proc_id).owner_id == cenario.ana
    assert db.query(models.Publicacao).filter_by(external_id="R2").one().owner_id == cenario.bruno
    # Processo não vai junto (decisão processo a processo).
    assert db.query(models.Process).get(cenario.proc_ana).owner_id == cenario.ana


def test_processo_muda_de_cliente_e_atendimento_fica_no_cliente_antigo(client, db, cenario):
    novo = models.Client(name="Outro cliente da Ana", owner_id=cenario.ana)
    doc = models.Document(process_id=cenario.proc_ana, client_id=cenario.cli_ana,
                          original_name="peca.pdf", file_path="x", owner_id=cenario.ana)
    db.add_all([novo, doc])
    db.commit()
    novo_id, doc_id = novo.id, doc.id
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"],
                   json={"client_id": novo_id})
    assert r.status_code == 200, r.text
    db.expire_all()
    a = db.query(models.Atendimento).get(cenario.atend_ana)
    assert a.client_id == cenario.cli_ana and a.process_id is None
    assert db.query(models.Document).get(doc_id).client_id == novo_id


def test_processo_sem_cliente_422(client, cenario):
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"],
                   json={"client_id": None})
    assert r.status_code == 422


def test_processo_muda_de_cliente_e_publicacao_acompanha_sem_mudar_de_dono(client, db, cenario):
    # O `vincular` do DJEN grava cliente E processo. Sem acompanhar, a intimação
    # aparecia na ficha do cliente antigo (pelo client_id) e na do novo (pelo
    # processo) ao mesmo tempo.
    novo = models.Client(name="Outro cliente da Ana", owner_id=cenario.ana)
    pub = models.Publicacao(external_id="R3", hash="hr3", process_id=cenario.proc_ana,
                            client_id=cenario.cli_ana, owner_id=cenario.ana, texto="x",
                            data_disponibilizacao=date(2026, 9, 1))
    db.add_all([novo, pub])
    db.commit()
    novo_id = novo.id
    r = client.put(f"/api/processes/{cenario.proc_ana}", headers=cenario.auth["ana"],
                   json={"client_id": novo_id})
    assert r.status_code == 200, r.text
    db.expire_all()
    p = db.query(models.Publicacao).filter_by(external_id="R3").one()
    assert (p.client_id, p.process_id, p.owner_id) == (novo_id, cenario.proc_ana, cenario.ana)
    antigos = client.get("/api/publicacoes", params={"client_id": cenario.cli_ana},
                         headers=cenario.auth["ana"]).json()
    assert p.id not in {x["id"] for x in antigos}
