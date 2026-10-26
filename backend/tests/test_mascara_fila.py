"""(c) MÁSCARA DA FILA — o advogado não vê os dados pessoais de um lead sem dono.

Regra (`_mascara_ativa` em precatorios.py e acoes.py): lead da FILA
(owner_id nulo) visto por quem NÃO é `ve_tudo` — ou seja, pelo advogado — sai
com CPF/RG/telefone/e-mail/endereço da parte ocultos. Admin e estagiário veem.

A máscara tem três saídas para cobrir, e o PUT é a que mais importa: é a
resposta de uma ESCRITA, fácil de esquecer porque ninguém pensa nela como
leitura. Um `PUT {}` não altera nada no banco, mas a resposta traz o registro
inteiro — se ela não passar pela máscara, qualquer advogado lê o CPF de toda
a fila com uma requisição vazia por caso.

E a simetria do lado da escrita: quem não vê o campo também não pode
sobrescrevê-lo, senão salvar o formulário (que mostra os campos vazios)
apagaria o dado no banco.
"""
import pytest

from app import models
from app.routers import acoes as acoes_router
from app.routers import precatorios as prec_router

from conftest import CPF_ANA, CPF_FILA

CAMPOS_PRECATORIO = [
    "requerente_cpf", "requerente_rg", "requerente_telefone",
    "requerente_email", "requerente_endereco",
]
CAMPOS_ACAO = ["parte_cpf", "parte_rg", "parte_telefone", "parte_email", "parte_endereco"]

# (rota base, atributo do cenário do lead da fila, do lead da Ana, campos, (campo, valor) do nome)
ENTIDADES = {
    "precatorios": ("/api/precatorios", "prec_fila", "prec_ana", CAMPOS_PRECATORIO,
                    ("requerente_nome", "Requerente Fila")),
    "acoes": ("/api/acoes", "acao_fila", "acao_ana", CAMPOS_ACAO,
              ("parte_nome", "Parte Fila")),
}


def _assert_mascarado(registro: dict, campos, texto_resposta: str):
    for campo in campos:
        assert registro.get(campo) is None, f"{campo} vazou: {registro.get(campo)!r}"
    # Varredura bruta também: o CPF não pode aparecer em NENHUM campo.
    assert CPF_FILA not in texto_resposta


def _assert_visivel(registro: dict, campos):
    for campo in campos:
        assert registro.get(campo), f"{campo} deveria estar visível"


def test_listas_sensiveis_dos_routers_cobrem_os_campos():
    # Tirar um campo de _SENSIVEIS reabre o vazamento em silêncio.
    assert set(CAMPOS_PRECATORIO) <= set(prec_router._SENSIVEIS)
    assert set(CAMPOS_ACAO) <= set(acoes_router._SENSIVEIS)


# ------------------------- advogado: tudo mascarado -------------------------
@pytest.mark.parametrize("entidade", ENTIDADES)
def test_get_mascarado_para_advogado(client, cenario, entidade):
    base, fila, _, campos, nome = ENTIDADES[entidade]
    resp = client.get(f"{base}/{getattr(cenario, fila)}", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    corpo = resp.json()
    campo_nome, valor_nome = nome
    assert corpo[campo_nome] == valor_nome        # o lead aparece...
    _assert_mascarado(corpo, campos, resp.text)   # ...sem os dados pessoais


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_list_mascarado_para_advogado(client, cenario, entidade):
    base, fila, _, campos, _ = ENTIDADES[entidade]
    resp = client.get(base, headers=cenario.auth["ana"])
    assert resp.status_code == 200
    por_id = {r["id"]: r for r in resp.json()}
    assert getattr(cenario, fila) in por_id, "o lead da fila deveria aparecer na lista"
    _assert_mascarado(por_id[getattr(cenario, fila)], campos, resp.text)


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_put_vazio_nao_devolve_cpf_em_claro(client, cenario, entidade):
    base, fila, _, campos, _ = ENTIDADES[entidade]
    resp = client.put(f"{base}/{getattr(cenario, fila)}", headers=cenario.auth["ana"], json={})
    assert resp.status_code == 200
    _assert_mascarado(resp.json(), campos, resp.text)


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_put_com_alteracao_devolve_mascarado(client, cenario, entidade):
    base, fila, _, campos, _ = ENTIDADES[entidade]
    resp = client.put(
        f"{base}/{getattr(cenario, fila)}", headers=cenario.auth["ana"],
        json={"anotacoes": "liguei, não atendeu"},
    )
    assert resp.status_code == 200
    assert resp.json()["anotacoes"] == "liguei, não atendeu"
    _assert_mascarado(resp.json(), campos, resp.text)


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_put_do_advogado_nao_apaga_nem_troca_dado_mascarado(client, db, cenario, entidade):
    # O formulário mostra os campos vazios; salvá-lo manda None/"" neles.
    base, fila, _, campos, _ = ENTIDADES[entidade]
    lixo = {campo: None for campo in campos}
    lixo[campos[0]] = "999.999.999-99"      # e uma tentativa de TROCAR o CPF
    resp = client.put(f"{base}/{getattr(cenario, fila)}", headers=cenario.auth["ana"], json=lixo)
    assert resp.status_code == 200

    db.expire_all()
    modelo = models.Precatorio if entidade == "precatorios" else models.Acao
    registro = db.query(modelo).get(getattr(cenario, fila))
    assert getattr(registro, campos[0]) == CPF_FILA
    for campo in campos:
        assert getattr(registro, campo), f"{campo} foi apagado pelo PUT mascarado"


# ------------- controles: a máscara é dirigida, não um apagão -------------
@pytest.mark.parametrize("papel", ["admin", "estag"])
@pytest.mark.parametrize("entidade", ENTIDADES)
def test_admin_e_estagiario_veem_a_fila(client, cenario, entidade, papel):
    base, fila, _, campos, _ = ENTIDADES[entidade]
    resp = client.get(f"{base}/{getattr(cenario, fila)}", headers=cenario.auth[papel])
    assert resp.status_code == 200
    _assert_visivel(resp.json(), campos)
    assert resp.json()[campos[0]] == CPF_FILA


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_advogado_ve_os_dados_do_proprio_caso(client, cenario, entidade):
    base, _, meu, campos, _ = ENTIDADES[entidade]
    resp = client.get(f"{base}/{getattr(cenario, meu)}", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    _assert_visivel(resp.json(), campos)
    assert resp.json()[campos[0]] == CPF_ANA

    resp = client.put(f"{base}/{getattr(cenario, meu)}", headers=cenario.auth["ana"], json={})
    assert resp.json()[campos[0]] == CPF_ANA


def test_estagiario_alimenta_dado_de_precatorio_da_fila(client, cenario):
    # É o trabalho dele: completar CPF/telefone de lead sem dono.
    # Só Precatórios: o PRESET_ESTAGIARIO deixa Ações apenas para consulta.
    resp = client.put(
        f"/api/precatorios/{cenario.prec_fila}", headers=cenario.auth["estag"],
        json={"requerente_telefone": "(82) 97777-0000"},
    )
    assert resp.status_code == 200
    assert resp.json()["requerente_telefone"] == "(82) 97777-0000"
    assert resp.json()["requerente_cpf"] == CPF_FILA
