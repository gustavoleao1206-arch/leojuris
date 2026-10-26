"""(d) IDOR — trocar o ID na URL não alcança registro de outro advogado.

A Ana (advogada) tenta ler e editar o que é do Bruno (advogado) em
Precatórios, Ações e Clientes, direto pela API. O resultado aceitável é 403
(ou lista vazia) — nunca o dado. Nas escritas não basta o status: o registro
do Bruno é fotografado antes e depois, porque uma rota que responde 403 DEPOIS
de gravar também é falha.

Os controles no fim fazem a mesma operação no registro da PRÓPRIA Ana e
esperam sucesso — sem eles, uma rota quebrada (que recusa todo mundo) passaria
por "protegida".
"""
import pytest
from sqlalchemy import inspect

from app import models

from conftest import CPF_BRUNO

ALVO_BRUNO = {"precatorios": "prec_bruno", "acoes": "acao_bruno", "clients": "cli_bruno",
              "processes": "proc_bruno"}
ALVO_ANA = {"precatorios": "prec_ana", "acoes": "acao_ana", "clients": "cli_ana",
            "processes": "proc_ana"}
MODELO = {"precatorios": models.Precatorio, "acoes": models.Acao, "clients": models.Client,
          "processes": models.Process}
NOMES_DO_BRUNO = ("Requerente Bruno", "Parte Bruno", "Cliente do Bruno", "PROC-BRUNO")

LEITURAS = [
    ("precatorios", "/api/precatorios/{id}"),
    ("precatorios", "/api/precatorios/{id}/contatos"),
    ("precatorios", "/api/precatorios/{id}/timeline"),
    ("acoes", "/api/acoes/{id}"),
    ("acoes", "/api/acoes/{id}/contatos"),
    ("acoes", "/api/acoes/{id}/timeline"),
    ("clients", "/api/clients/{id}"),
    ("clients", "/api/clients/{id}/overview"),
    # Ficha única (out/2026): os filhos herdam o acesso do pai da URL.
    ("clients", "/api/clients/{id}/atendimentos"),
    ("clients", "/api/clients/{id}/contatos"),
    ("clients", "/api/clients/{id}/timeline"),
    ("processes", "/api/processes/{id}"),
    ("processes", "/api/processes/{id}/partes"),
    ("processes", "/api/processes/{id}/andamentos"),
    ("processes", "/api/processes/{id}/timeline"),
]

ESCRITAS = [
    ("precatorios", "PUT", "/api/precatorios/{id}", {"anotacoes": "invadido", "requerente_cpf": "000"}),
    ("precatorios", "POST", "/api/precatorios/{id}/mover", {"status_lead": "perdido"}),
    ("precatorios", "POST", "/api/precatorios/{id}/contatos", {"tipo": "ligacao", "descricao": "invadido"}),
    ("precatorios", "POST", "/api/precatorios/{id}/assumir", None),
    ("precatorios", "POST", "/api/precatorios/{id}/liberar", None),
    ("acoes", "PUT", "/api/acoes/{id}", {"anotacoes": "invadido", "parte_cpf": "000"}),
    ("acoes", "POST", "/api/acoes/{id}/contatos", {"tipo": "ligacao", "descricao": "invadido"}),
    ("acoes", "POST", "/api/acoes/{id}/assumir", None),
    ("acoes", "POST", "/api/acoes/{id}/liberar", None),
    ("clients", "PUT", "/api/clients/{id}", {"name": "Invadido", "notes": "invadido"}),
    ("clients", "DELETE", "/api/clients/{id}", None),
    ("clients", "POST", "/api/clients/{id}/atendimentos", {"tipo": "nota", "descricao": "invadido"}),
    ("clients", "POST", "/api/clients/{id}/contatos", {"nome": "Invasor"}),
    ("processes", "PUT", "/api/processes/{id}", {"description": "invadido"}),
    ("processes", "DELETE", "/api/processes/{id}", None),
    ("processes", "POST", "/api/processes/{id}/partes", {"nome": "Invasor", "tipo": "contraria"}),
    ("processes", "POST", "/api/processes/{id}/andamentos", {"data": "2026-10-01", "titulo": "invadido"}),
]


def _foto(db, entidade, registro_id):
    """Todas as colunas do registro + quantos contatos ele tem."""
    db.expire_all()
    obj = db.query(MODELO[entidade]).get(registro_id)
    if obj is None:
        return None
    foto = {col.key: getattr(obj, col.key) for col in inspect(obj).mapper.column_attrs}
    if entidade == "precatorios":
        foto["_contatos"] = db.query(models.PrecatorioContato).filter_by(precatorio_id=registro_id).count()
    elif entidade == "acoes":
        foto["_contatos"] = db.query(models.AcaoContato).filter_by(acao_id=registro_id).count()
    elif entidade == "clients":
        # Os filhos da ficha também: um POST que responde 403 DEPOIS de gravar
        # o atendimento no cliente do colega também é falha.
        foto["_atendimentos"] = db.query(models.Atendimento).filter_by(client_id=registro_id).count()
        foto["_contatos"] = db.query(models.ClienteContato).filter_by(client_id=registro_id).count()
    elif entidade == "processes":
        foto["_partes"] = db.query(models.ProcessoParte).filter_by(process_id=registro_id).count()
        foto["_andamentos"] = db.query(models.ProcessoAndamento).filter_by(process_id=registro_id).count()
    return foto


def _sem_dado_do_bruno(texto: str):
    assert CPF_BRUNO not in texto
    for nome in NOMES_DO_BRUNO:
        assert nome not in texto


@pytest.mark.parametrize("entidade,rota", LEITURAS)
def test_advogado_nao_le_registro_de_outro_dono(client, cenario, entidade, rota):
    alvo = getattr(cenario, ALVO_BRUNO[entidade])
    resp = client.get(rota.format(id=alvo), headers=cenario.auth["ana"])
    assert resp.status_code == 403, resp.text[:200]
    _sem_dado_do_bruno(resp.text)


@pytest.mark.parametrize("entidade,metodo,rota,corpo", ESCRITAS)
def test_advogado_nao_edita_registro_de_outro_dono(client, db, cenario, entidade, metodo, rota, corpo):
    alvo = getattr(cenario, ALVO_BRUNO[entidade])
    antes = _foto(db, entidade, alvo)

    kwargs = {"json": corpo} if corpo is not None else {}
    resp = client.request(metodo, rota.format(id=alvo), headers=cenario.auth["ana"], **kwargs)

    assert resp.status_code == 403, resp.text[:200]
    _sem_dado_do_bruno(resp.text)
    assert _foto(db, entidade, alvo) == antes, "a rota recusou, mas o registro mudou"


@pytest.mark.parametrize("entidade,base", [
    ("precatorios", "/api/precatorios"), ("acoes", "/api/acoes"), ("clients", "/api/clients"),
    ("processes", "/api/processes"),
])
def test_lista_nao_traz_registro_de_outro_dono(client, cenario, entidade, base):
    resp = client.get(base, headers=cenario.auth["ana"])
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()}
    assert getattr(cenario, ALVO_BRUNO[entidade]) not in ids
    assert getattr(cenario, ALVO_ANA[entidade]) in ids
    _sem_dado_do_bruno(resp.text)


def test_filtro_por_responsavel_com_id_do_colega_devolve_vazio(client, cenario):
    # O ID na query string é o outro "trocar o ID": `_filtrar_responsavel`
    # devolve consulta vazia, não os casos do colega.
    resp = client.get(f"/api/precatorios?responsavel={cenario.bruno}", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    assert resp.json() == []


# ------------------------------- controles -------------------------------
@pytest.mark.parametrize("entidade,rota", LEITURAS)
def test_controle_advogado_le_o_proprio_registro(client, cenario, entidade, rota):
    alvo = getattr(cenario, ALVO_ANA[entidade])
    assert client.get(rota.format(id=alvo), headers=cenario.auth["ana"]).status_code == 200


@pytest.mark.parametrize("entidade,metodo,rota,corpo", [
    e for e in ESCRITAS if e[1] == "PUT"
])
def test_controle_advogado_edita_o_proprio_registro(client, db, cenario, entidade, metodo, rota, corpo):
    alvo = getattr(cenario, ALVO_ANA[entidade])
    resp = client.request(metodo, rota.format(id=alvo), headers=cenario.auth["ana"], json=corpo)
    assert resp.status_code == 200
    assert _foto(db, entidade, alvo) is not None
