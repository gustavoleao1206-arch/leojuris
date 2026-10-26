"""Importação de Excel: endereço em colunas separadas vai para o campo MASCARADO.

Até set/2026 só "Endereço"/"Logradouro" chegavam a `requerente_endereco`.
Rua, Bairro, Cidade, UF, CEP e Complemento caíam em `observacoes` — que não é
mascarado —, e todo lead importado entra na FILA: o advogado lia o endereço
que a máscara promete esconder. O casamento por aproximação ainda mandava
"Número" para o processo originário e "CEP do requerente" para o NOME.

Duas camadas de teste: a resolução de cabeçalho (onde o defeito mora) e a
importação de ponta a ponta, vista pelos olhos da advogada.
"""
import io

import openpyxl
import pytest

from app import models
from app.routers.precatorios import _resolver_cabecalhos

END = "requerente_endereco"


def _resolve(headers):
    return {h: (campo, parte) for campo, h, parte in _resolver_cabecalhos(headers).values()}


# ---------------------- resolução de cabeçalho, um a um ----------------------
@pytest.mark.parametrize("cabecalho,esperado", [
    # partes de endereço
    ("Logradouro", (END, "logradouro")),
    ("Rua", (END, "logradouro")),
    ("Endereço", (END, "logradouro")),
    ("Endereço residencial", (END, "logradouro")),
    ("Complemento", (END, "complemento")),
    ("Bairro", (END, "bairro")),
    ("Cidade", (END, "cidade")),
    ("Município", (END, "cidade")),
    ("Cidade/UF", (END, "cidade")),
    ("UF", (END, "uf")),
    ("Estado", (END, "uf")),
    ("CEP", (END, "cep")),
    # armadilhas do casamento por aproximação
    ("CEP do requerente", (END, "cep")),            # ia para o NOME
    ("Bairro do requerente", (END, "bairro")),      # ia para o NOME
    ("Endereço de e-mail", ("requerente_email", None)),
    ("Endereço eletrônico", ("requerente_email", None)),
    ("Estado civil", (None, None)),                 # não é endereço
    ("Telefone residencial", ("requerente_telefone", None)),
    # a mesma armadilha nos outros campos pessoais: todos iam para o NOME
    ("CPF do requerente", ("requerente_cpf", None)),
    ("CPF do credor", ("requerente_cpf", None)),
    ("CPF/CNPJ do beneficiário", ("requerente_cpf", None)),
    ("RG do requerente", ("requerente_rg", None)),
    ("Telefone do cliente", ("requerente_telefone", None)),
    ("Celular do credor", ("requerente_telefone", None)),
    ("WhatsApp do requerente", ("requerente_telefone", None)),
    ("Contato do requerente", ("requerente_telefone", None)),
    ("E-mail do requerente", ("requerente_email", None)),
    ("Data de nascimento do requerente", ("requerente_nascimento", None)),
    ("Endereço da parte", (END, "logradouro")),
    # o que não muda
    ("Nome do requerente", ("requerente_nome", None)),
    ("Nome", ("requerente_nome", None)),
    ("CPF", ("requerente_cpf", None)),
    ("E-mail", ("requerente_email", None)),
    ("Número do processo", ("processo_id", None)),
    ("Número", ("numero_originario", None)),        # sozinho, longe da rua: como antes
    ("Nº", (None, None)),                           # contador de linha: como antes
])
def test_cabecalho_isolado(cabecalho, esperado):
    assert _resolve([cabecalho])[cabecalho] == esperado


@pytest.mark.parametrize("numero", ["Número", "Nº", "N°", "Num"])
def test_numero_logo_depois_da_rua_e_o_numero_da_casa(numero):
    assert _resolve(["Nome", "Rua", numero, "Bairro"])[numero] == (END, "numero")


def test_numero_longe_da_rua_nao_vira_endereco():
    r = _resolve(["Nº", "Nome", "Rua", "Bairro", "Número"])
    assert r["Nº"] == (None, None)                      # contador na 1ª coluna
    assert r["Número"] == ("numero_originario", None)   # depois do bairro, não da rua


# ------------------------- importação de ponta a ponta -------------------------
CABECALHO = ["Nº", "Nome", "CPF", "Logradouro", "Número", "Complemento", "Bairro",
             "Cidade", "UF", "CEP", "Requisitório"]
LINHA = [1, "Fulana Importada", "444.444.444-44", "Rua das Flores", 123, "Apto 2",
         "Centro", "Maceió", "AL", 1310100, "0009999-99.2026.4.05.0000"]   # CEP numérico sem o zero
PEDACOS = ["Rua das Flores", "Flores", "Apto 2", "Centro", "Maceió", "01310-100", "1310100"]
ENDERECO_ESPERADO = "Rua das Flores, 123, Apto 2, Centro, Maceió/AL, CEP 01310-100"


def _xlsx(cabecalho, *linhas) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(cabecalho)
    for linha in linhas:
        ws.append(linha)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _importar(client, headers, conteudo):
    return client.post(
        "/api/precatorios/importar", headers=headers,
        files={"file": ("planilha.xlsx", conteudo,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )


@pytest.fixture
def importado(client, db, cenario):
    resp = _importar(client, cenario.auth["admin"], _xlsx(CABECALHO, LINHA))
    assert resp.status_code == 200, resp.text[:300]
    assert resp.json()["criados"] == 1
    db.expire_all()
    return db.query(models.Precatorio).filter_by(requerente_nome="Fulana Importada").one()


def test_endereco_separado_vai_inteiro_para_o_campo_mascarado(importado):
    assert importado.owner_id is None                        # entra na FILA
    assert importado.requerente_endereco == ENDERECO_ESPERADO
    for pedaco in PEDACOS:
        assert pedaco not in (importado.observacoes or ""), pedaco
    assert "Nº: 1" in (importado.observacoes or "")          # o contador segue onde sempre esteve


def test_advogado_nao_le_o_endereco_importado(client, cenario, importado):
    ana = cenario.auth["ana"]
    for resp in (client.get(f"/api/precatorios/{importado.id}", headers=ana),
                 client.get("/api/precatorios", headers=ana)):
        assert resp.status_code == 200
        for pedaco in PEDACOS:
            assert pedaco not in resp.text, f"{pedaco!r} vazou para a advogada"


def test_admin_le_o_endereco_importado(client, cenario, importado):
    resp = client.get(f"/api/precatorios/{importado.id}", headers=cenario.auth["admin"])
    assert resp.json()["requerente_endereco"] == ENDERECO_ESPERADO


def test_cep_do_requerente_nao_sobrescreve_o_nome(client, db, cenario):
    resp = _importar(client, cenario.auth["admin"], _xlsx(
        ["Nome", "CPF", "CEP do requerente"], ["Beltrana Teste", "555.555.555-55", "57000-000"],
    ))
    assert resp.json()["criados"] == 1
    db.expire_all()
    p = db.query(models.Precatorio).filter_by(requerente_cpf="555.555.555-55").one()
    assert p.requerente_nome == "Beltrana Teste"
    assert p.requerente_endereco == "CEP 57000-000"


def test_so_a_coluna_endereco_continua_como_antes(client, db, cenario):
    resp = _importar(client, cenario.auth["admin"], _xlsx(
        ["Nome", "Endereço"], ["Ciclana Teste", "Av. Brasil, 10 - Centro"],
    ))
    assert resp.json()["criados"] == 1
    db.expire_all()
    p = db.query(models.Precatorio).filter_by(requerente_nome="Ciclana Teste").one()
    assert p.requerente_endereco == "Av. Brasil, 10 - Centro"


def test_cpf_qualificado_nao_vira_nome_nem_vaza(client, db, cenario):
    # "CPF do requerente" ia para o NOME: apagava o nome e deixava o CPF visível
    # ao advogado, porque o nome não é mascarado.
    resp = _importar(client, cenario.auth["admin"], _xlsx(
        ["Nome do requerente", "CPF do requerente", "Telefone do cliente", "E-mail do credor"],
        ["Fulano Qualificado", "666.666.666-66", "(82) 95555-4444", "fulano@exemplo.test"],
    ))
    assert resp.json()["criados"] == 1
    db.expire_all()
    p = db.query(models.Precatorio).filter_by(requerente_cpf="666.666.666-66").one()
    assert p.requerente_nome == "Fulano Qualificado"
    assert p.requerente_telefone == "(82) 95555-4444"
    assert p.requerente_email == "fulano@exemplo.test"

    vista = client.get(f"/api/precatorios/{p.id}", headers=cenario.auth["ana"])
    for dado in ("666.666.666-66", "95555-4444", "fulano@exemplo.test"):
        assert dado not in vista.text, f"{dado} vazou para a advogada"
