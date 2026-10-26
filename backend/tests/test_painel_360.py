"""(f) PAINEL 360 — /api/clients/{id}/overview não traz dinheiro nem contrato do colega.

Cenário real (conftest): o cliente é da Ana, mas estão presos a ele
  * um honorário SÓ do Bruno (R$ 50.000);
  * uma parceria em que o Bruno é o dono e a Ana a parceira (30%);
  * um contrato (assinatura) do Bruno.
Acontece quando o admin transfere o cliente de um advogado para outro: o que
já estava lançado continua com o dono antigo.

A régua é a tela de Financeiro: o painel nunca pode mostrar MAIS do que a
própria pessoa veria em /api/honorarios. Na parceria isso inclui o valor —
o parceiro vê só a parte dele, não o total do colega.
"""
import pytest


def _overview(client, cenario, papel):
    resp = client.get(f"/api/clients/{cenario.cli_ana}/overview", headers=cenario.auth[papel])
    assert resp.status_code == 200, resp.text[:200]
    return resp


def test_advogado_nao_ve_honorario_so_do_colega(client, cenario):
    resp = _overview(client, cenario, "ana")
    ids = {h["id"] for h in resp.json()["honorarios"]}
    assert cenario.hon_bruno not in ids
    assert "Honorário SÓ do Bruno" not in resp.text
    assert ids == {cenario.hon_ana, cenario.hon_parceria}


def test_advogado_nao_ve_contrato_do_colega(client, cenario):
    resp = _overview(client, cenario, "ana")
    ids = {c["id"] for c in resp.json()["contratos"]}
    assert cenario.assin_bruno not in ids
    assert "Contrato do Bruno" not in resp.text
    assert ids == {cenario.assin_ana}
    assert resp.json()["resumo"]["total_contratos"] == 1


def test_parceira_ve_so_a_propria_parte(client, cenario):
    corpo = _overview(client, cenario, "ana").json()
    parceria = next(h for h in corpo["honorarios"] if h["id"] == cenario.hon_parceria)
    assert parceria["amount"] == pytest.approx(3000)   # 30% de 10.000
    assert parceria["paid"] == pytest.approx(1200)     # 30% de 4.000


def test_total_soma_so_o_que_a_pessoa_ve(client, cenario):
    corpo = _overview(client, cenario, "ana").json()
    # 1.000 (dela) + 3.000 (a parte dela na parceria). Nem os 50.000 do Bruno,
    # nem os 7.000 que são a parte dele na parceria.
    assert corpo["resumo"]["total_honorarios"] == pytest.approx(4000)


@pytest.mark.parametrize("papel", ["ana", "admin"])
def test_painel_mostra_exatamente_a_aba_financeiro_do_cliente(client, db, cenario, papel):
    # A régua: nem mais, nem menos que /api/honorarios?client_id= (a aba
    # Financeiro da ficha) — inclusive o honorário lançado SÓ no processo do
    # cliente, que o painel deixava de fora (o total não batia com a aba).
    from app import models
    db.add(models.Honorario(process_id=cenario.proc_ana, total_value=9, paid_value=0,
                            status="pendente", owner_id=cenario.ana, created_by=cenario.ana))
    db.commit()
    corpo = _overview(client, cenario, papel).json()
    financeiro = client.get("/api/honorarios", params={"client_id": cenario.cli_ana},
                            headers=cenario.auth[papel])
    assert financeiro.status_code == 200
    por_id = {h["id"]: h for h in financeiro.json()}
    assert {h["id"] for h in corpo["honorarios"]} == set(por_id)
    for h in corpo["honorarios"]:
        assert h["amount"] == pytest.approx(por_id[h["id"]]["total_value"])
        assert h["paid"] == pytest.approx(por_id[h["id"]]["paid_value"])
    assert corpo["resumo"]["total_honorarios"] == pytest.approx(
        sum(h["total_value"] for h in por_id.values()))


# ------------------- a régua em TODOS os blocos (out/2026) -------------------
# bloco do painel -> listagem do módulo que é a régua dele
BLOCOS = {
    "processos": "/api/processes",
    "documentos": "/api/documents",
    "precatorios": "/api/precatorios",
    "acoes": "/api/acoes",
    "contratos": "/api/assinaturas",
    "honorarios": "/api/honorarios",
}


@pytest.fixture
def cliente_com_tudo_misturado(db, cenario):
    """O cliente da Ana com coisa do Bruno presa a ele em TODOS os blocos.

    Chamado "Requerente Fila" de propósito: o casamento por NOME traz o
    precatório da fila (sem dono) para o painel — o caso que a máscara da fila
    protege. Os demais itens do Bruno não podem aparecer para a Ana.
    """
    from app import models
    cli = models.Client(name="Requerente Fila", owner_id=cenario.ana)
    db.add(cli)
    db.commit()
    db.add_all([
        models.Process(client_id=cli.id, case_number="PROC-ANA-2", owner_id=cenario.ana),
        models.Process(client_id=cli.id, case_number="PROC-BRUNO-2", owner_id=cenario.bruno),
        models.Document(client_id=cli.id, original_name="da-ana.pdf", file_path="x",
                        owner_id=cenario.ana),
        models.Document(client_id=cli.id, original_name="do-bruno.pdf", file_path="x",
                        owner_id=cenario.bruno),
        models.Assinatura(titulo="Contrato do Bruno 2", tipo="contrato", area="civel",
                          client_id=cli.id, status="rascunho", owner_id=cenario.bruno),
    ])
    # Precatório/ação do Bruno presos pelo vínculo formal: fora do alcance da Ana.
    db.query(models.Precatorio).filter_by(id=cenario.prec_bruno).update({"client_id": cli.id})
    db.query(models.Acao).filter_by(id=cenario.acao_bruno).update({"client_id": cli.id})
    db.commit()
    return cli.id


@pytest.mark.parametrize("papel", ["ana", "bruno", "estag", "admin"])
@pytest.mark.parametrize("bloco", sorted(BLOCOS))
def test_cada_bloco_nunca_mostra_mais_que_o_modulo(client, cenario, cliente_com_tudo_misturado,
                                                  bloco, papel):
    headers = cenario.auth[papel]
    resp = client.get(f"/api/clients/{cliente_com_tudo_misturado}/overview", headers=headers)
    if papel == "bruno":
        assert resp.status_code == 403     # o cliente é da Ana
        return
    assert resp.status_code == 200, resp.text[:200]
    painel = {item["id"] for item in resp.json()[bloco]}
    modulo = client.get(BLOCOS[bloco], headers=headers)
    visiveis = {item["id"] for item in modulo.json()} if modulo.status_code == 200 else set()
    assert painel <= visiveis, f"{bloco}: {painel - visiveis} no painel, fora do módulo ({papel})"


def test_painel_casa_precatorio_da_fila_pelo_nome_sem_dado_sensivel(client, cenario,
                                                                    cliente_com_tudo_misturado):
    from conftest import CPF_FILA
    resp = client.get(f"/api/clients/{cliente_com_tudo_misturado}/overview",
                      headers=cenario.auth["ana"])
    corpo = resp.json()
    item = next(p for p in corpo["precatorios"] if p["id"] == cenario.prec_fila)
    assert item["vinculo"] == "nome" and item["owner_id"] is None
    # Só os campos de identificação do caso — nunca os de _SENSIVEIS.
    assert set(item) == {"id", "numero_precatorio", "tribunal", "assunto", "status_lead",
                         "valor_caso", "owner_id", "vinculo"}
    assert CPF_FILA not in resp.text
    assert "fila@exemplo.test" not in resp.text and "Rua Fila" not in resp.text
    # E nada do Bruno.
    for proibido in ("PROC-BRUNO-2", "do-bruno.pdf", "Contrato do Bruno 2", "Requerente Bruno",
                     "Parte Bruno"):
        assert proibido not in resp.text, proibido


def test_vinculo_cadastro_vence_o_nome(client, db, cenario):
    from app import models
    db.query(models.Precatorio).filter_by(id=cenario.prec_ana).update({"client_id": cenario.cli_ana})
    db.commit()
    corpo = client.get(f"/api/clients/{cenario.cli_ana}/overview", headers=cenario.auth["ana"]).json()
    item = next(p for p in corpo["precatorios"] if p["id"] == cenario.prec_ana)
    assert item["vinculo"] == "cadastro"


def test_sem_modulo_o_bloco_vem_vazio(client, db, cenario, cliente_com_tudo_misturado):
    import json
    from app import models
    from app.scope import MODULOS
    from conftest import headers_de
    u = db.query(models.User).get(cenario.ana)
    so_clientes = {m: {"view": m == "clients", "edit": m == "clients"} for m in MODULOS}
    u.permissions = json.dumps({"modules": so_clientes})
    db.commit()
    corpo = client.get(f"/api/clients/{cliente_com_tudo_misturado}/overview",
                       headers=headers_de(u)).json()
    for bloco in BLOCOS:
        assert corpo[bloco] == [], bloco


# ------------------------------- controles -------------------------------
def test_admin_ve_tudo_do_cliente(client, cenario):
    corpo = _overview(client, cenario, "admin").json()
    assert {h["id"] for h in corpo["honorarios"]} == {
        cenario.hon_ana, cenario.hon_bruno, cenario.hon_parceria,
    }
    assert {c["id"] for c in corpo["contratos"]} == {cenario.assin_ana, cenario.assin_bruno}
    assert corpo["resumo"]["total_honorarios"] == pytest.approx(1000 + 50000 + 10000)


def test_estagiario_nao_ve_financeiro_no_painel(client, cenario):
    # Regra fixa do perfil (Financeiro bloqueado) — o painel abre, sem o bloco.
    corpo = _overview(client, cenario, "estag").json()
    assert corpo["honorarios"] == []
    assert corpo["resumo"]["total_honorarios"] == 0
