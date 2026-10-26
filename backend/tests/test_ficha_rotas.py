"""Ficha única — atendimentos, contatos, partes e andamentos (routers/ficha.py).

O que estes testes seguram, além do "funciona":

  * NADA AQUI TEM DONO: o acesso herda do cliente/processo da URL. O advogado
    vê, na ficha do PRÓPRIO cliente, o atendimento que a estagiária registrou
    — e não alcança nada do cliente/processo do colega (IDOR, Ana × Bruno).
  * O filho pertence ao pai da URL: trocar só o id do filho não apaga/edita o
    registro de outro cliente/processo (404).
  * Alvo do CORPO (`process_id` do atendimento): existe, é DESTE cliente e a
    pessoa o alcança — senão 400/403 e NADA gravado.
  * Listas fechadas → 422 na entrada; valor fora da lista já gravado (por
    código antigo, importação, banco editado) NÃO quebra a leitura.
  * Campos obrigatórios: `null`/`""` → 422, nunca 500 de IntegrityError.
"""
from datetime import date, datetime

import pytest

from app import models


def _qtd(db, modelo, **filtro):
    db.expire_all()
    return db.query(modelo).filter_by(**filtro).count()


# ------------------------------- atendimentos -------------------------------
def test_atendimento_criar_listar_e_autoria(client, cenario):
    url = f"/api/clients/{cenario.cli_ana}/atendimentos"
    r = client.post(url, headers=cenario.auth["ana"], json={
        "tipo": "whatsapp", "descricao": "Enviou os documentos",
        "data": "2099-01-03T14:30:00", "process_id": cenario.proc_ana,
        "proximo_retorno": "2099-01-10",
    })
    assert r.status_code == 200, r.text
    corpo = r.json()
    assert corpo["autor_id"] == cenario.ana and corpo["autor_nome"] == "Ana Advogada"
    assert corpo["process_id"] == cenario.proc_ana and corpo["process_number"] == "PROC-ANA"
    # A hora que o navegador mandou é a hora que fica (hora local, sem fuso).
    assert corpo["data"].startswith("2099-01-03T14:30")

    lista = client.get(url, headers=cenario.auth["ana"]).json()
    assert [a["id"] for a in lista][0] == corpo["id"]     # mais recente primeiro
    assert {a["id"] for a in lista} == {corpo["id"], cenario.atend_ana}


def test_atendimento_sem_data_usa_hora_de_brasilia(client, cenario):
    from app.prazos import agora_local
    r = client.post(f"/api/clients/{cenario.cli_ana}/atendimentos",
                    headers=cenario.auth["ana"], json={"descricao": "Sem data"})
    assert r.status_code == 200, r.text
    assert r.json()["tipo"] == "nota"
    gravada = datetime.fromisoformat(r.json()["data"])
    assert abs((gravada - agora_local()).total_seconds()) < 120


def test_atendimento_com_fuso_e_convertido_para_brasilia(client, cenario):
    r = client.post(f"/api/clients/{cenario.cli_ana}/atendimentos",
                    headers=cenario.auth["ana"],
                    json={"descricao": "Com fuso", "data": "2026-10-03T14:30:00Z"})
    assert r.status_code == 200, r.text
    assert r.json()["data"].startswith("2026-10-03T11:30")


def test_estagiaria_registra_e_advogado_dono_ve(client, cenario):
    # O cenário mais comum: quem registra é a estagiária. Se alguém aplicar
    # `scope()` no atendimento, a Ana deixa de ver na ficha do próprio cliente.
    r = client.post(f"/api/clients/{cenario.cli_ana}/atendimentos",
                    headers=cenario.auth["estag"], json={"descricao": "Atendi no balcão"})
    assert r.status_code == 200, r.text
    ids = {a["id"] for a in client.get(f"/api/clients/{cenario.cli_ana}/atendimentos",
                                       headers=cenario.auth["ana"]).json()}
    assert r.json()["id"] in ids


def test_atendimento_process_id_de_outro_cliente_400_e_nada_gravado(client, db, cenario):
    antes = _qtd(db, models.Atendimento)
    r = client.post(f"/api/clients/{cenario.cli_ana}/atendimentos", headers=cenario.auth["admin"],
                    json={"descricao": "x", "process_id": cenario.proc_bruno})
    assert r.status_code == 400, r.text
    assert _qtd(db, models.Atendimento) == antes


def test_atendimento_process_id_inexistente_400(client, db, cenario):
    antes = _qtd(db, models.Atendimento)
    r = client.post(f"/api/clients/{cenario.cli_ana}/atendimentos", headers=cenario.auth["ana"],
                    json={"descricao": "x", "process_id": 999999})
    assert r.status_code == 400, r.text
    assert _qtd(db, models.Atendimento) == antes


@pytest.fixture
def proc_bruno_no_cliente_da_ana(db, cenario):
    """Processo do Bruno preso ao cliente da Ana (o admin escolhe o dono)."""
    p = models.Process(client_id=cenario.cli_ana, case_number="PROC-BRUNO-NA-ANA",
                       owner_id=cenario.bruno)
    db.add(p)
    db.commit()
    return p.id


def test_atendimento_com_processo_do_colega_recusado_e_nada_gravado(client, db, cenario,
                                                                    proc_bruno_no_cliente_da_ana):
    antes = _qtd(db, models.Atendimento)
    url = f"/api/clients/{cenario.cli_ana}/atendimentos"
    r = client.post(url, headers=cenario.auth["ana"],
                    json={"descricao": "x", "process_id": proc_bruno_no_cliente_da_ana})
    # 400 IGUAL ao de processo inexistente (era 403 — e o 403 x 400 era o oráculo
    # que dizia à Ana quais processos do Bruno estão presos ao cliente dela).
    inexistente = client.post(url, headers=cenario.auth["ana"], json={"descricao": "x", "process_id": 999999})
    assert r.status_code == 400, r.text
    assert (r.status_code, r.text) == (inexistente.status_code, inexistente.text)
    assert "PROC-BRUNO" not in r.text
    assert _qtd(db, models.Atendimento) == antes


def test_atendimento_ligado_a_processo_do_bruno_aparece_sem_o_processo(
        client, db, cenario, proc_bruno_no_cliente_da_ana):
    # Gravado por quem alcança tudo (admin/estagiária). A Ana é dona do
    # cliente, então vê o atendimento — mas não o processo do Bruno.
    a = models.Atendimento(client_id=cenario.cli_ana, process_id=proc_bruno_no_cliente_da_ana,
                           tipo="reuniao", descricao="Reunião sobre o processo do Bruno",
                           autor_id=cenario.admin)
    db.add(a)
    db.commit()
    r = client.get(f"/api/clients/{cenario.cli_ana}/atendimentos", headers=cenario.auth["ana"])
    assert r.status_code == 200
    item = next(x for x in r.json() if x["id"] == a.id)
    assert item["process_id"] is None and item["process_number"] is None
    assert "PROC-BRUNO-NA-ANA" not in r.text
    # Filtrar pelo processo invisível não confirma o vínculo: lista vazia.
    r2 = client.get(f"/api/clients/{cenario.cli_ana}/atendimentos",
                    params={"process_id": proc_bruno_no_cliente_da_ana}, headers=cenario.auth["ana"])
    assert r2.status_code == 200 and r2.json() == []
    # Controle: o admin vê o vínculo.
    adm = client.get(f"/api/clients/{cenario.cli_ana}/atendimentos", headers=cenario.auth["admin"])
    item = next(x for x in adm.json() if x["id"] == a.id)
    assert item["process_id"] == proc_bruno_no_cliente_da_ana


@pytest.mark.parametrize("corpo", [
    {"tipo": "telepatia", "descricao": "x"},
    {"tipo": None, "descricao": "x"},
    {"tipo": "", "descricao": "x"},
    {"descricao": ""},
    {"descricao": "   "},
    {"descricao": None},
    {},
])
def test_atendimento_entrada_invalida_422(client, db, cenario, corpo):
    antes = _qtd(db, models.Atendimento)
    r = client.post(f"/api/clients/{cenario.cli_ana}/atendimentos",
                    headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    assert _qtd(db, models.Atendimento) == antes


def test_atendimento_tipo_fora_da_lista_ja_gravado_nao_quebra_leitura(client, db, cenario):
    db.add(models.Atendimento(client_id=cenario.cli_ana, tipo="<img src=x>", descricao="legado"))
    db.commit()
    r = client.get(f"/api/clients/{cenario.cli_ana}/atendimentos", headers=cenario.auth["ana"])
    assert r.status_code == 200
    r = client.get(f"/api/clients/{cenario.cli_ana}/timeline", headers=cenario.auth["ana"])
    assert r.status_code == 200
    # A linha do tempo usa rótulo, nunca a chave crua.
    assert "<img" not in r.text


def test_atendimento_excluir_de_outro_cliente_pela_url_404(client, db, cenario):
    # Atendimento do cliente do Bruno; a Ana usa o cliente DELA na URL.
    a = models.Atendimento(client_id=cenario.cli_bruno, tipo="nota", descricao="do Bruno")
    db.add(a)
    db.commit()
    r = client.delete(f"/api/clients/{cenario.cli_ana}/atendimentos/{a.id}",
                      headers=cenario.auth["ana"])
    assert r.status_code == 404
    assert _qtd(db, models.Atendimento, id=a.id) == 1


def test_atendimento_advogado_exclui_o_proprio(client, db, cenario):
    r = client.delete(f"/api/clients/{cenario.cli_ana}/atendimentos/{cenario.atend_ana}",
                      headers=cenario.auth["ana"])
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert _qtd(db, models.Atendimento, id=cenario.atend_ana) == 0


# ------------------------------- contatos -------------------------------
def test_contato_principal_e_unico(client, db, cenario):
    url = f"/api/clients/{cenario.cli_ana}/contatos"
    r = client.post(url, headers=cenario.auth["ana"],
                    json={"nome": "João Sócio", "papel": "socio", "principal": True})
    assert r.status_code == 200, r.text
    novo = r.json()
    assert novo["principal"] is True
    lista = client.get(url, headers=cenario.auth["ana"]).json()
    assert lista[0]["id"] == novo["id"]                       # principal primeiro
    principais = [c["id"] for c in lista if c["principal"]]
    assert principais == [novo["id"]]                         # o antigo foi desmarcado

    # PUT marcando o antigo devolve a coroa para ele.
    r = client.put(f"{url}/{cenario.contato_cli_ana}", headers=cenario.auth["ana"],
                   json={"principal": True})
    assert r.status_code == 200, r.text
    lista = client.get(url, headers=cenario.auth["ana"]).json()
    assert [c["id"] for c in lista if c["principal"]] == [cenario.contato_cli_ana]


@pytest.mark.parametrize("corpo", [
    {"papel": "socio"},                          # sem nome, telefone nem e-mail
    {"nome": "  ", "telefone": "", "email": None},
    {"nome": "Fulano", "papel": "amante"},       # papel fora da lista
])
def test_contato_entrada_invalida_422(client, db, cenario, corpo):
    antes = _qtd(db, models.ClienteContato)
    r = client.post(f"/api/clients/{cenario.cli_ana}/contatos",
                    headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    assert _qtd(db, models.ClienteContato) == antes


def test_contato_so_telefone_ou_so_email_passa(client, cenario):
    url = f"/api/clients/{cenario.cli_ana}/contatos"
    assert client.post(url, headers=cenario.auth["ana"], json={"telefone": "82 3333-0000"}).status_code == 200
    assert client.post(url, headers=cenario.auth["ana"], json={"email": "x@exemplo.test"}).status_code == 200


def test_contato_put_que_apaga_tudo_422_e_nada_muda(client, db, cenario):
    r = client.put(f"/api/clients/{cenario.cli_ana}/contatos/{cenario.contato_cli_ana}",
                   headers=cenario.auth["ana"], json={"nome": None, "telefone": None})
    assert r.status_code == 422, r.text
    db.expire_all()
    c = db.query(models.ClienteContato).get(cenario.contato_cli_ana)
    assert c.nome == "Maria Representante" and c.telefone


def test_contato_de_outro_cliente_pela_url_404(client, db, cenario):
    c = models.ClienteContato(client_id=cenario.cli_bruno, nome="Contato do Bruno")
    db.add(c)
    db.commit()
    url = f"/api/clients/{cenario.cli_ana}/contatos/{c.id}"
    assert client.put(url, headers=cenario.auth["ana"], json={"nome": "invadido"}).status_code == 404
    assert client.delete(url, headers=cenario.auth["ana"]).status_code == 404
    db.expire_all()
    assert db.query(models.ClienteContato).get(c.id).nome == "Contato do Bruno"


def test_contato_papel_fora_da_lista_ja_gravado_nao_quebra_leitura(client, db, cenario):
    db.add(models.ClienteContato(client_id=cenario.cli_ana, nome="Legado", papel="papel-antigo"))
    db.commit()
    assert client.get(f"/api/clients/{cenario.cli_ana}/contatos",
                      headers=cenario.auth["ana"]).status_code == 200


# ------------------------------- partes -------------------------------
def test_parte_crud(client, db, cenario):
    url = f"/api/processes/{cenario.proc_ana}/partes"
    r = client.post(url, headers=cenario.auth["ana"], json={
        "nome": "  Banco X S.A. ", "tipo": "litisconsorte", "polo": "passivo",
        "cpf_cnpj": "00.000.000/0001-00", "advogado": "Dr. Y", "oab": "AL 1234",
    })
    assert r.status_code == 200, r.text
    parte = r.json()
    assert parte["nome"] == "Banco X S.A."          # espaços das pontas saem
    lista = client.get(url, headers=cenario.auth["ana"]).json()
    assert lista[0]["tipo"] == "contraria"          # parte contrária primeiro
    r = client.put(f"{url}/{parte['id']}", headers=cenario.auth["ana"], json={"tipo": "contraria"})
    assert r.status_code == 200 and r.json()["tipo"] == "contraria"
    assert client.delete(f"{url}/{parte['id']}", headers=cenario.auth["ana"]).json() == {"ok": True}


@pytest.mark.parametrize("metodo,corpo", [
    ("POST", {"nome": "X", "tipo": "inimigo"}),
    ("POST", {"nome": "X", "tipo": "contraria", "polo": "lateral"}),
    ("POST", {"nome": "", "tipo": "contraria"}),
    ("POST", {"nome": "X"}),
    ("POST", {"nome": None, "tipo": "contraria"}),
    ("PUT", {"nome": None}),
    ("PUT", {"nome": ""}),
    ("PUT", {"tipo": None}),
    ("PUT", {"tipo": ""}),
    ("PUT", {"tipo": "inimigo"}),
])
def test_parte_entrada_invalida_422(client, db, cenario, metodo, corpo):
    url = f"/api/processes/{cenario.proc_ana}/partes"
    if metodo == "PUT":
        url += f"/{cenario.parte_ana}"
    antes = _qtd(db, models.ProcessoParte)
    r = client.request(metodo, url, headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    assert _qtd(db, models.ProcessoParte) == antes
    db.expire_all()
    p = db.query(models.ProcessoParte).get(cenario.parte_ana)
    assert p.nome == "Empresa Ré Ltda" and p.tipo == "contraria"


def test_parte_tipo_fora_da_lista_ja_gravado_nao_quebra_leitura(client, db, cenario):
    db.add(models.ProcessoParte(process_id=cenario.proc_ana, nome="Legado", tipo="tipo-antigo",
                                polo="polo-antigo"))
    db.commit()
    assert client.get(f"/api/processes/{cenario.proc_ana}/partes",
                      headers=cenario.auth["ana"]).status_code == 200
    r = client.get(f"/api/processes/{cenario.proc_ana}/timeline", headers=cenario.auth["ana"])
    assert r.status_code == 200
    assert "tipo-antigo" not in r.text


def test_parte_de_outro_processo_pela_url_404(client, db, cenario):
    p = models.ProcessoParte(process_id=cenario.proc_bruno, nome="Parte do Bruno", tipo="contraria")
    db.add(p)
    db.commit()
    url = f"/api/processes/{cenario.proc_ana}/partes/{p.id}"
    assert client.put(url, headers=cenario.auth["ana"], json={"nome": "x"}).status_code == 404
    assert client.delete(url, headers=cenario.auth["ana"]).status_code == 404
    assert _qtd(db, models.ProcessoParte, id=p.id) == 1


# ------------------------------- andamentos -------------------------------
def test_andamento_crud(client, db, cenario):
    url = f"/api/processes/{cenario.proc_ana}/andamentos"
    r = client.post(url, headers=cenario.auth["estag"], json={
        "data": "2026-10-01", "titulo": "Despacho de citação", "descricao": "Cite-se.",
    })
    assert r.status_code == 200, r.text
    novo = r.json()
    assert novo["autor_nome"] == "Estela Estagiária" and novo["data"] == "2026-10-01"
    lista = client.get(url, headers=cenario.auth["ana"]).json()
    assert [a["id"] for a in lista] == [novo["id"], cenario.andamento_ana]   # mais recente primeiro
    # A estagiária registra, mas não apaga; a Ana (dona do processo) apaga.
    assert client.delete(f"{url}/{novo['id']}", headers=cenario.auth["estag"]).status_code == 403
    assert client.delete(f"{url}/{novo['id']}", headers=cenario.auth["ana"]).status_code == 200


@pytest.mark.parametrize("corpo", [
    {"titulo": "Sem data"},
    {"data": "2026-10-01", "titulo": ""},
    {"data": "2026-10-01", "titulo": None},
    {"data": None, "titulo": "X"},
])
def test_andamento_entrada_invalida_422(client, db, cenario, corpo):
    antes = _qtd(db, models.ProcessoAndamento)
    r = client.post(f"/api/processes/{cenario.proc_ana}/andamentos",
                    headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    assert _qtd(db, models.ProcessoAndamento) == antes


def test_andamento_de_outro_processo_pela_url_404(client, db, cenario):
    a = models.ProcessoAndamento(process_id=cenario.proc_bruno, data=date(2026, 9, 1), titulo="do Bruno")
    db.add(a)
    db.commit()
    r = client.delete(f"/api/processes/{cenario.proc_ana}/andamentos/{a.id}",
                      headers=cenario.auth["ana"])
    assert r.status_code == 404
    assert _qtd(db, models.ProcessoAndamento, id=a.id) == 1


# ------------------------------- permissão de módulo -------------------------------
@pytest.fixture
def ana_sem_clientes(db, cenario):
    """A Ana com o módulo Clientes desligado (o resto liberado)."""
    import json
    from app.scope import MODULOS
    from conftest import headers_de
    u = db.query(models.User).get(cenario.ana)
    u.permissions = json.dumps({"modules": {
        m: {"view": m != "clients", "edit": m != "clients"} for m in MODULOS}})
    db.commit()
    return headers_de(u)


def test_sem_modulo_clientes_nao_le_nem_grava_atendimento(client, db, cenario, ana_sem_clientes):
    url = f"/api/clients/{cenario.cli_ana}/atendimentos"
    assert client.get(url, headers=ana_sem_clientes).status_code == 403
    assert client.post(url, headers=ana_sem_clientes, json={"descricao": "x"}).status_code == 403
    # E a linha do tempo do processo DELA abre, mas sem o bloco de atendimentos.
    r = client.get(f"/api/processes/{cenario.proc_ana}/timeline", headers=ana_sem_clientes)
    assert r.status_code == 200
    assert not [e for e in r.json()["events"] if e["tipo"] == "atendimento"]


# ------------------------------- IDOR nos filhos (Ana × Bruno) -------------------------------
@pytest.fixture
def filhos_do_bruno(db, cenario):
    """Um registro de cada filho pendurado no cliente/processo do BRUNO."""
    regs = {
        "atendimento": models.Atendimento(client_id=cenario.cli_bruno, tipo="nota",
                                          descricao="Atendimento do Bruno"),
        "contato": models.ClienteContato(client_id=cenario.cli_bruno, nome="Contato do Bruno"),
        "parte": models.ProcessoParte(process_id=cenario.proc_bruno, nome="Parte do Bruno",
                                      tipo="contraria"),
        "andamento": models.ProcessoAndamento(process_id=cenario.proc_bruno, data=date(2026, 9, 1),
                                              titulo="Andamento do Bruno"),
    }
    db.add_all(regs.values())
    db.commit()
    return {k: v.id for k, v in regs.items()}


# (método, url com {pai}/{filho}, corpo, filho, modelo)
ESCRITAS_FILHOS = [
    ("DELETE", "/api/clients/{cli}/atendimentos/{id}", None, "atendimento", models.Atendimento),
    ("PUT", "/api/clients/{cli}/contatos/{id}", {"nome": "invadido"}, "contato", models.ClienteContato),
    ("DELETE", "/api/clients/{cli}/contatos/{id}", None, "contato", models.ClienteContato),
    ("PUT", "/api/processes/{proc}/partes/{id}", {"nome": "invadido"}, "parte", models.ProcessoParte),
    ("DELETE", "/api/processes/{proc}/partes/{id}", None, "parte", models.ProcessoParte),
    ("DELETE", "/api/processes/{proc}/andamentos/{id}", None, "andamento", models.ProcessoAndamento),
]


@pytest.mark.parametrize("metodo,url,corpo,filho,modelo", ESCRITAS_FILHOS)
def test_ana_nao_altera_nem_apaga_filho_do_bruno(client, db, cenario, filhos_do_bruno,
                                                  metodo, url, corpo, filho, modelo):
    rid = filhos_do_bruno[filho]
    alvo = url.format(cli=cenario.cli_bruno, proc=cenario.proc_bruno, id=rid)
    r = client.request(metodo, alvo, headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 403, r.text
    assert "do Bruno" not in r.text
    db.expire_all()
    reg = db.query(modelo).get(rid)
    assert reg is not None, "respondeu 403 mas apagou"
    assert "invadido" not in (getattr(reg, "nome", "") or "")


@pytest.mark.parametrize("metodo,url,corpo,filho,modelo", ESCRITAS_FILHOS)
def test_filho_inexistente_no_pai_alheio_tambem_e_403(client, cenario, metodo, url, corpo,
                                                       filho, modelo):
    # Sem oráculo: o 403 do PAI vem antes do 404 do filho — a resposta não
    # diz se aquele id de atendimento/contato/parte existe no cliente do colega.
    alvo = url.format(cli=cenario.cli_bruno, proc=cenario.proc_bruno, id=999999)
    assert client.request(metodo, alvo, headers=cenario.auth["ana"], json=corpo).status_code == 403


def test_controle_admin_altera_e_apaga_filho_do_bruno(client, cenario, filhos_do_bruno):
    # Controle: a rota funciona para quem alcança o pai — o 403 acima é a trava.
    url = f"/api/clients/{cenario.cli_bruno}/contatos/{filhos_do_bruno['contato']}"
    assert client.put(url, headers=cenario.auth["admin"], json={"nome": "Novo"}).status_code == 200
    assert client.delete(url, headers=cenario.auth["admin"]).status_code == 200


# ------------------------------- tamanho das colunas -------------------------------
@pytest.mark.parametrize("url_fmt,corpo,campo", [
    ("/api/clients/{cli}/contatos", {"nome": "x" * 151}, "nome"),
    ("/api/clients/{cli}/contatos", {"nome": "Fulano", "cpf": "1" * 21}, "cpf"),
    # E-mail em formato válido (o contato valida o formato): 121 → 422; tirando
    # o último caractere fica "...@exemplo.co", 120, ainda válido.
    ("/api/clients/{cli}/contatos", {"email": "a" * 109 + "@exemplo.com"}, "email"),
    ("/api/processes/{proc}/partes", {"nome": "x" * 151, "tipo": "contraria"}, "nome"),
    ("/api/processes/{proc}/partes", {"nome": "X", "tipo": "contraria", "oab": "9" * 31}, "oab"),
    ("/api/processes/{proc}/andamentos", {"data": "2026-10-01", "titulo": "x" * 201}, "titulo"),
])
def test_texto_maior_que_a_coluna_422_e_nao_500(client, cenario, url_fmt, corpo, campo):
    # O SQLite aceitaria; o PostgreSQL de produção estouraria DataError (500).
    url = url_fmt.format(cli=cenario.cli_ana, proc=cenario.proc_ana)
    r = client.post(url, headers=cenario.auth["ana"], json=corpo)
    assert r.status_code == 422, r.text
    # Um caractere a menos — exatamente o tamanho da coluna — passa.
    no_limite = dict(corpo, **{campo: corpo[campo][:-1]})
    assert client.post(url, headers=cenario.auth["ana"], json=no_limite).status_code == 200
