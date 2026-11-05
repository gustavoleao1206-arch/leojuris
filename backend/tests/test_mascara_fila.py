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


# ----------- escritas que devolvem o registro: o liberar é a perigosa -----------
@pytest.mark.parametrize("entidade", ENTIDADES)
def test_liberar_devolve_mascarado(client, cenario, entidade):
    # Liberar transforma o caso em lead da FILA no mesmo commit: a resposta já
    # tem de sair como a fila sai para o advogado. Antes ela voltava crua, com
    # CPF, telefone e endereço de um lead que ele não alcança mais.
    base, _, meu, campos, _ = ENTIDADES[entidade]
    resp = client.post(f"{base}/{getattr(cenario, meu)}/liberar", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    corpo = resp.json()
    assert corpo["owner_id"] is None
    for campo in campos:
        assert corpo.get(campo) is None, f"{campo} vazou: {corpo.get(campo)!r}"
    assert CPF_ANA not in resp.text


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_admin_libera_e_continua_vendo(client, cenario, entidade):
    # Controle: a máscara depende de quem lê, não da rota.
    base, _, meu, campos, _ = ENTIDADES[entidade]
    resp = client.post(f"{base}/{getattr(cenario, meu)}/liberar", headers=cenario.auth["admin"])
    assert resp.status_code == 200
    assert resp.json()["owner_id"] is None
    _assert_visivel(resp.json(), campos)
    assert resp.json()[campos[0]] == CPF_ANA


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_assumir_devolve_o_caso_inteiro(client, cenario, entidade):
    # Quem assume vira dono: passar pela máscara não pode esconder nada dele.
    base, fila, _, campos, _ = ENTIDADES[entidade]
    resp = client.post(f"{base}/{getattr(cenario, fila)}/assumir", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    _assert_visivel(resp.json(), campos)
    assert resp.json()[campos[0]] == CPF_FILA


@pytest.mark.parametrize("entidade", ENTIDADES)
def test_criar_na_fila_devolve_mascarado(client, cenario, entidade):
    # O advogado cria o lead, que nasce sem dono: a resposta sai como a fila sai
    # para ele (o GET seguinte diria o mesmo). A tela só usa o id da resposta.
    base, _, _, campos, _ = ENTIDADES[entidade]
    dados = {campo: "dado digitado" for campo in campos}
    dados[campos[0]] = CPF_FILA
    resp = client.post(base, headers=cenario.auth["ana"], json=dados)
    assert resp.status_code == 200
    assert resp.json()["owner_id"] is None
    _assert_mascarado(resp.json(), campos, resp.text)


def _retornos_crus(modulo, schema_out):
    """Rotas que devolvem `schema_out` (ou List[...]) com algum `return` que não
    passa por `_mascarar`. Pega a rota NOVA que alguém criar amanhã.

    Conta como rota que devolve o registro tanto o `response_model=` do
    decorator quanto a anotação de retorno (`-> schemas.PrecatorioOut`), que o
    FastAPI também usa. Regra de estilo: o `_mascarar` vai no próprio `return`
    (ou na list comprehension do `return`); guardar numa variável antes é
    acusado, de propósito, para a regra continuar verificável."""
    import ast
    import inspect

    rotas = (ast.FunctionDef, ast.AsyncFunctionDef)

    def _returns_da_propria(fn):
        # Desce no corpo sem entrar em funções aninhadas: o `return` de um
        # helper interno não é a resposta da rota.
        pilha = list(fn.body)
        while pilha:
            no = pilha.pop()
            if isinstance(no, rotas + (ast.Lambda, ast.ClassDef)):
                continue
            if isinstance(no, ast.Return):
                yield no
            pilha.extend(ast.iter_child_nodes(no))

    arvore = ast.parse(inspect.getsource(modulo))
    crus = []
    for fn in ast.walk(arvore):
        if not isinstance(fn, rotas):
            continue
        no_decorator = any(
            isinstance(d, ast.Call) and any(
                k.arg == "response_model" and schema_out in ast.unparse(k.value)
                for k in d.keywords
            )
            for d in fn.decorator_list
        )
        na_anotacao = fn.returns is not None and schema_out in ast.unparse(fn.returns)
        if not (no_decorator or na_anotacao):
            continue
        for no in _returns_da_propria(fn):
            if no.value is None:
                continue
            alvo = no.value.elt if isinstance(no.value, ast.ListComp) else no.value
            chamada = isinstance(alvo, ast.Call) and ast.unparse(alvo.func) == "_mascarar"
            if not chamada:
                crus.append(f"{fn.name}: return {ast.unparse(no.value)}")
    return crus


def test_a_trava_acusa_o_que_promete():
    # Contraprova: sem ela, "lista vazia" e "trava quebrada" dão o mesmo verde.
    import types
    import textwrap

    falso = types.ModuleType("rotas_falsas")
    falso.__file__ = __file__
    codigo = textwrap.dedent('''
        @router.get("/a", response_model=schemas.PrecatorioOut)
        def crua(p):
            return p

        @router.get("/b", response_model=schemas.PrecatorioOut)
        async def assincrona(p):
            return p

        @router.get("/c")
        def anotada(p) -> schemas.PrecatorioOut:
            return p

        @router.get("/d", response_model=List[schemas.PrecatorioOut])
        def lista_certa(ps, u):
            return [_mascarar(p, u) for p in ps]

        @router.get("/e", response_model=schemas.PrecatorioOut)
        def com_helper(p, u):
            def _id(x):
                return x.id
            return _mascarar(p, u)
    ''')
    import inspect
    original = inspect.getsource
    inspect.getsource = lambda m: codigo if m is falso else original(m)
    try:
        acusadas = {linha.split(":")[0] for linha in _retornos_crus(falso, "PrecatorioOut")}
    finally:
        inspect.getsource = original
    assert acusadas == {"crua", "assincrona", "anotada"}


def test_toda_rota_que_devolve_o_registro_passa_pela_mascara():
    # A regra do projeto ("toda rota que devolva PrecatorioOut/AcaoOut
    # passa por _mascarar") já foi esquecida no PUT e depois no liberar.
    assert _retornos_crus(prec_router, "PrecatorioOut") == []
    assert _retornos_crus(acoes_router, "AcaoOut") == []
