"""A BUSCA da lista não pode virar oráculo do CPF mascarado da fila.

Complemento de test_mascara_fila.py. Até set/2026 a busca comparava o termo
com o CPF da parte por `ILIKE '%termo%'` em todo registro visível — inclusive
nos leads da FILA, cujo CPF o advogado não vê. O GET devolvia None e a lista
entregava o número: sondando posição a posição com curinga (`1__.___.___-__`),
ou crescendo uma substring, o CPF inteiro saía em algumas dezenas de consultas.

Regra (decisão do dono, `scope.condicao_busca_documento`): no lead da fila o
advogado encontra por CPF/CNPJ só com o número COMPLETO — confirma um
documento que já tem, não extrai um que não tem. Nos casos dele, e para admin
e estagiário, a busca parcial continua.

Os ataques abaixo são os de verdade, executados contra a API. O controle roda
o MESMO ataque contra o caso da própria advogada e espera sucesso: sem ele,
um ataque mal escrito passaria "por acaso".
"""
import pytest

from app import models

from conftest import CPF_ANA, CPF_BRUNO, CPF_FILA

# (rota, lead da fila, caso da Ana, campo do CPF, nome visível do lead da fila, modelo)
ENTIDADES = {
    "precatorios": ("/api/precatorios", "prec_fila", "prec_ana", "requerente_cpf",
                    "Requerente Fila", models.Precatorio),
    "acoes": ("/api/acoes", "acao_fila", "acao_ana", "parte_cpf", "Parte Fila", models.Acao),
}

ALFABETO = "0123456789.-/"


def _achados(client, base, headers, termo) -> dict:
    resp = client.get(base, params={"search": termo}, headers=headers)
    assert resp.status_code == 200, resp.text[:200]
    return {r["id"]: r for r in resp.json()}


def _ataque_curinga(client, base, headers, alvo_id, tamanho=14) -> str:
    """Fixa uma posição por vez: "1" + 13 curingas casa se o CPF começa com 1."""
    achado = ""
    for posicao in range(tamanho):
        for ch in ALFABETO:
            if alvo_id in _achados(client, base, headers, achado + ch + "_" * (tamanho - posicao - 1)):
                achado += ch
                break
        else:
            break
    return achado


def _ataque_substring(client, base, headers, alvo_id, limite=20) -> str:
    """Sem curinga nenhum: cresce um trecho literal enquanto ele continuar casando."""
    achado = ""
    while len(achado) < limite:
        for ch in ALFABETO:
            if alvo_id in _achados(client, base, headers, achado + ch):
                achado += ch
                break
        else:
            break
    return achado


# ------------------------------- ataques -------------------------------
@pytest.mark.parametrize("entidade", ENTIDADES)
@pytest.mark.parametrize("ataque", [_ataque_curinga, _ataque_substring], ids=["curinga", "substring"])
def test_ataque_nao_extrai_nada_do_cpf_da_fila(client, cenario, entidade, ataque):
    base, fila, *_ = ENTIDADES[entidade]
    extraido = ataque(client, base, cenario.auth["ana"], getattr(cenario, fila))
    assert extraido == "", f"a busca vazou {extraido!r} do CPF {CPF_FILA}"


@pytest.mark.parametrize("entidade", ENTIDADES)
@pytest.mark.parametrize("ataque", [_ataque_curinga, _ataque_substring], ids=["curinga", "substring"])
def test_controle_o_mesmo_ataque_funciona_onde_e_permitido(client, cenario, entidade, ataque):
    # No caso da própria Ana a busca parcial é legítima — e o ataque, que é o
    # mesmo código, reconstrói o CPF inteiro. É isso que dá valor ao teste acima.
    base, _, meu, *_ = ENTIDADES[entidade]
    extraido = ataque(client, base, cenario.auth["ana"], getattr(cenario, meu))
    assert CPF_ANA in extraido


@pytest.mark.parametrize("termo", [
    "1", "111", "111.111", "111.111.111-1", "1111111111", "11111111111"[1:],
    "1__.___.___-__", "___.___.___-__", "%1%", "111.111.111-1_", "_11.111.111-11",
])
@pytest.mark.parametrize("entidade", ENTIDADES)
def test_cpf_parcial_nao_acha_lead_da_fila(client, cenario, entidade, termo):
    # Nenhum destes termos casa o NOME ("Requerente Fila"/"Parte Fila" não têm
    # dígito, ponto nem hífen), então se o lead aparecer foi pelo CPF.
    base, fila, *_ = ENTIDADES[entidade]
    assert getattr(cenario, fila) not in _achados(client, base, cenario.auth["ana"], termo)


# ------------------------- o que continua funcionando -------------------------
@pytest.mark.parametrize("termo", [CPF_FILA, "11111111111", f"  {CPF_FILA}  "])
@pytest.mark.parametrize("entidade", ENTIDADES)
def test_cpf_completo_acha_lead_da_fila_e_continua_mascarado(client, cenario, entidade, termo):
    base, fila, _, campo_cpf, *_ = ENTIDADES[entidade]
    achados = _achados(client, base, cenario.auth["ana"], termo)
    assert getattr(cenario, fila) in achados
    assert achados[getattr(cenario, fila)][campo_cpf] is None


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_busca_por_nome_continua_achando_a_fila(client, cenario, entidade):
    base, fila, _, _, nome, _ = ENTIDADES[entidade]
    assert getattr(cenario, fila) in _achados(client, base, cenario.auth["ana"], nome.split()[-1])


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_advogado_busca_cpf_parcial_nos_proprios_casos(client, cenario, entidade):
    base, _, meu, *_ = ENTIDADES[entidade]
    assert getattr(cenario, meu) in _achados(client, base, cenario.auth["ana"], CPF_ANA[:5])


@pytest.mark.parametrize("papel", ["admin", "estag"])
@pytest.mark.parametrize("entidade", ENTIDADES)
def test_admin_e_estagiario_buscam_cpf_parcial_na_fila(client, cenario, entidade, papel):
    base, fila, *_ = ENTIDADES[entidade]
    assert getattr(cenario, fila) in _achados(client, base, cenario.auth[papel], CPF_FILA[:5])


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_cpf_completo_do_colega_nao_acha_o_caso_dele(client, cenario, entidade):
    base, *_ = ENTIDADES[entidade]
    alvo = getattr(cenario, "prec_bruno" if entidade == "precatorios" else "acao_bruno")
    assert alvo not in _achados(client, base, cenario.auth["ana"], CPF_BRUNO)


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_cpf_que_a_importacao_gravou_sem_zero_a_esquerda(client, db, cenario, entidade):
    # Excel com CPF numérico: 012.345.678-90 chega ao banco como "1234567890".
    base, _, _, campo_cpf, _, modelo = ENTIDADES[entidade]
    lead = modelo(**{campo_cpf: "1234567890"}, owner_id=None)
    db.add(lead)
    db.commit()
    assert lead.id in _achados(client, base, cenario.auth["ana"], "012.345.678-90")
    assert lead.id not in _achados(client, base, cenario.auth["ana"], "012.345.678-9")


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_cnpj_completo_acha_e_parcial_nao(client, db, cenario, entidade):
    base, _, _, campo_cpf, _, modelo = ENTIDADES[entidade]
    lead = modelo(**{campo_cpf: "12.345.678/0001-90"}, owner_id=None)
    db.add(lead)
    db.commit()
    assert lead.id in _achados(client, base, cenario.auth["ana"], "12345678000190")
    assert lead.id not in _achados(client, base, cenario.auth["ana"], "12.345.678/0001")
