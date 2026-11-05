"""Outros caminhos por onde o dado pessoal de um lead da FILA chegava ao advogado.

A máscara (`_mascara_ativa`) protege os CAMPOS do precatório/ação. Estes testes
cobrem o que ficava em volta deles, achado numa revisão de segurança (nov/2026):

1. A linha do tempo listava os anexos do caso sem o escopo de documentos, e
   nome de arquivo costuma trazer CPF ("RG e CPF 111... .pdf").
2. A importação de Excel mandava "Nome da mãe" para o NOME do requerente,
   "Conta" para o telefone (por "contato") e PIS/estado civil/profissão para
   `observacoes`, que não é mascarado.
3. Ao liberar ou trocar o responsável, anexos e procurações ficavam com o
   antigo dono — que continuava baixando o RG de um lead que já não alcança —
   e quem assumia depois não via nenhum dos dois.
"""
import io
from datetime import datetime

import openpyxl
import pytest

from app import models
from app.routers.precatorios import DESCARTAR, _parece_dado_pessoal, _resolver_cabecalhos

from conftest import CPF_ANA, CPF_FILA

NOME_ARQUIVO_FILA = f"RG e CPF {CPF_FILA} - Requerente Fila.pdf"


def _salvar(db, obj):
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj.id


# ------------------------------ 1. timeline ------------------------------
@pytest.mark.parametrize("entidade,campo_fk,lead", [
    ("precatorios", "precatorio_id", "prec_fila"),
    ("acoes", "acao_id", "acao_fila"),
])
def test_timeline_nao_mostra_anexo_que_a_tela_de_documentos_esconde(
        client, db, cenario, entidade, campo_fk, lead):
    caso = getattr(cenario, lead)
    _salvar(db, models.Document(
        original_name=NOME_ARQUIVO_FILA, file_path="x.pdf", categoria="identificacao",
        owner_id=cenario.admin, **{campo_fk: caso},
    ))
    # A tela de Documentos já escondia da advogada...
    docs = client.get(f"/api/documents?{campo_fk}={caso}", headers=cenario.auth["ana"])
    assert docs.status_code == 200 and docs.json() == []
    # ...e a linha do tempo tem de dizer o mesmo.
    resp = client.get(f"/api/{entidade}/{caso}/timeline", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    assert CPF_FILA not in resp.text
    assert all(e["tipo"] != "documento" for e in resp.json()["events"])

    # Controle: quem vê o documento continua vendo o evento.
    resp = client.get(f"/api/{entidade}/{caso}/timeline", headers=cenario.auth["admin"])
    assert NOME_ARQUIVO_FILA in [e["titulo"] for e in resp.json()["events"]]


# ------------------------------ 2. importação ------------------------------
@pytest.mark.parametrize("cabecalho,esperado", [
    # dado de TERCEIRO (família): nunca vira campo do requerente
    ("Nome da mãe", DESCARTAR),           # ia para o NOME, apagando o do requerente
    ("CPF do cônjuge", DESCARTAR),        # iria para o CPF do requerente
    ("Filiação", DESCARTAR),
    ("Genitores", DESCARTAR),             # plural em "-es"
    # dado pessoal sem campo próprio: não vai para observações
    ("Estado civil", DESCARTAR),
    ("PIS", DESCARTAR),
    ("Profissões", DESCARTAR),
    ("Conta", DESCARTAR),                 # antes casava com "contato" -> telefone
    ("Conta corrente", DESCARTAR),
    ("Doença grave", DESCARTAR),          # saúde: dado sensível
    ("Dados bancários", DESCARTAR),
    ("Nº do benefício", DESCARTAR),
    ("Representante legal", DESCARTAR),
    # habilitação: o requerente é o TITULAR, mesmo falecido (decisão do dono)
    ("Nome do falecido", "requerente_nome"),
    ("CPF do falecido", "requerente_cpf"),
    ("Nome do herdeiro", None),           # nome do herdeiro vai para observações
    ("CPF do herdeiro", DESCARTAR),       # sobrescrevia o CPF do titular
    ("CPF do sucessor", DESCARTAR),
    ("Telefone do herdeiro", DESCARTAR),
    ("Endereço do herdeiro", DESCARTAR),
    ("Habilitação de herdeiros", None),   # vai para observações (triagem)
    # advogado: dado profissional, nunca campo do requerente
    ("Nome do Advogado", None),           # sobrescrevia o NOME do requerente
    ("Telefone do procurador", None),
    ("Honorários do advogado", "percentual_honorarios"),
    # aproximação por palavra inteira, com plural
    ("Cargo", None),                      # casava com "rg"
    ("Documentação", None),               # casava com "doc" -> CPF
    ("Documento do beneficiário", "requerente_cpf"),  # ia para o NOME
    ("Beneficiários", "requerente_nome"),
    ("Credores", "requerente_nome"),
    ("Valores", "valor_caso"),
    ("Celulares", "requerente_telefone"),
    ("Processos", "processo_id"),         # não pode cair no originário
    ("Valor Requisitado (R$)", "valor_caso"),
    ("Nº Precatório", "numero_precatorio"),
    ("Banco do depósito", "banco"),       # o banco do depósito é dado do caso
    ("Imposto de renda", None),
    ("Data Base", None),
    # núcleo do cabeçalho primeiro; nome só pela 1ª palavra
    ("Banco do beneficiário", "banco"),   # ia para o NOME
    ("Situação do requisitório", "classificacao"),  # sobrescrevia o nº do requisitório
    ("Cota-parte", None),                 # ia para o NOME ("parte")
    ("#", None),                          # sem palavra: ia para o NOME
    ("%", None),
])
def test_resolucao_de_cabecalho(cabecalho, esperado):
    (campo, _, _), = _resolver_cabecalhos([cabecalho]).values()
    assert campo == esperado


@pytest.mark.parametrize("valor,pessoal", [
    ("123.456.789-00", True), ("12.345.678/0001-90", True), ("123.45678.90-1", True),
    ("(82) 98888-7777", True), ("fulano@exemplo.com.br", True),
    ("98888-7777", False),                # sem DDD: igual a "Ofício 91234-2024"
    # o que NÃO é: descartar à toa apaga dado do caso
    ("2024-07-01 00:00:00", False),       # data do Excel
    ("20230089123", False),               # nº de RPV/requisição
    ("12345678.9", False),                # valor em float
    ("R$ 1.234.567,89", False),
    ("0801234-56.2026.4.05.8000", False),  # CNJ
    ("Ofício 91234-2024", False),         # parecia celular sem DDD
    ("82 99999-0000", True),
    ("Alimentar", False),
])
def test_parece_dado_pessoal(valor, pessoal):
    assert _parece_dado_pessoal(valor) is pessoal


def _xlsx(linhas):
    wb = openpyxl.Workbook()
    for linha in linhas:
        wb.active.append(linha)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_importacao_nao_troca_campos_nem_vaza_por_observacoes(client, db, cenario):
    planilha = _xlsx([
        ["Nome", "CPF", "Data de nascimento", "Estado civil", "PIS", "Nome da mãe",
         "Profissão", "Conta", "Código interno", "Natureza", "Data Base", "RPV", "Saldo",
         "Honorários do advogado", "Nome do Advogado"],
        ["Fulano Importado", "555.555.555-55", "02/01/1950", "Casado", "123.45678.90-1",
         "Maria Mãe do Fulano", "Aposentado", "0012345678", "(82) 98888-7777", "Alimentar",
         datetime(2024, 7, 1), "20230089123", 12345678.9, 20, "Dr. Patrono Público"],
    ])
    resp = client.post(
        "/api/precatorios/importar", headers=cenario.auth["admin"],
        files={"file": ("lista.xlsx", planilha,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    assert corpo["criados"] == 1

    p = db.query(models.Precatorio).filter_by(requerente_cpf="555.555.555-55").one()
    assert p.requerente_nome == "Fulano Importado"      # nem o da mãe, nem o do advogado
    assert p.requerente_telefone is None                # "Conta" não caiu no telefone
    assert p.percentual_honorarios == 20
    obs = p.observacoes or ""
    # O que não é pessoal continua, inclusive o que tem muito dígito.
    for mantido in ("Natureza: Alimentar", "Data Base: 2024-07-01", "RPV: 20230089123",
                    "Saldo: 12345678.9", "Nome do Advogado: Dr. Patrono Público"):
        assert mantido in obs, f"{mantido!r} sumiu de observações"
    for vazado in ("Casado", "123.45678.90-1", "Maria", "Aposentado", "0012345678", "98888"):
        assert vazado not in obs, f"{vazado!r} foi parar em observações"

    # O admin fica sabendo do que não entrou, coluna por coluna.
    avisos = " ".join(corpo["avisos"])
    for coluna in ("Estado civil", "PIS", "Nome da mãe", "Profissão", "Conta", "Código interno"):
        assert coluna in avisos
    for coluna in ("Data Base", "RPV", "Saldo", "Natureza"):
        assert coluna not in avisos

    # E a advogada, que vê o lead na fila, não lê nada disso.
    resp = client.get(f"/api/precatorios/{p.id}", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    for vazado in ("555.555.555-55", "Casado", "Maria", "123.45678.90-1", "98888"):
        assert vazado not in resp.text


# -------------------- 3. anexos e procurações acompanham --------------------
def _anexos_do_caso(db, cenario):
    doc = _salvar(db, models.Document(
        original_name="RG da requerente.pdf", file_path="rg.pdf", categoria="identificacao",
        precatorio_id=cenario.prec_ana, owner_id=cenario.ana,
    ))
    proc = _salvar(db, models.Assinatura(
        titulo="Procuração — Requerente Ana", tipo="procuracao", area="precatorios",
        precatorio_id=cenario.prec_ana, signatario_cpf=CPF_ANA, owner_id=cenario.ana,
    ))
    return doc, proc


def _ve(client, cenario, papel, doc_id, assin_id):
    docs = client.get(f"/api/documents?precatorio_id={cenario.prec_ana}", headers=cenario.auth[papel])
    assins = client.get("/api/assinaturas", headers=cenario.auth[papel])
    return (doc_id in [d["id"] for d in docs.json()],
            assin_id in [a["id"] for a in assins.json()])


def test_liberar_tira_anexos_e_procuracao_do_antigo_dono(client, db, cenario):
    doc, proc = _anexos_do_caso(db, cenario)
    assert _ve(client, cenario, "ana", doc, proc) == (True, True)

    resp = client.post(f"/api/precatorios/{cenario.prec_ana}/liberar", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    assert _ve(client, cenario, "ana", doc, proc) == (False, False)
    # Ficam com quem enxerga a fila inteira, como o próprio lead.
    assert _ve(client, cenario, "admin", doc, proc) == (True, True)


def test_quem_assume_recebe_anexos_e_procuracao(client, db, cenario):
    doc, proc = _anexos_do_caso(db, cenario)
    client.post(f"/api/precatorios/{cenario.prec_ana}/liberar", headers=cenario.auth["ana"])

    resp = client.post(f"/api/precatorios/{cenario.prec_ana}/assumir", headers=cenario.auth["bruno"])
    assert resp.status_code == 200
    assert _ve(client, cenario, "bruno", doc, proc) == (True, True)
    assert _ve(client, cenario, "ana", doc, proc) == (False, False)


def test_admin_trocando_o_responsavel_leva_os_anexos(client, db, cenario):
    doc, proc = _anexos_do_caso(db, cenario)
    resp = client.put(
        f"/api/precatorios/{cenario.prec_ana}", headers=cenario.auth["admin"],
        json={"owner_id": cenario.bruno},
    )
    assert resp.status_code == 200
    assert _ve(client, cenario, "bruno", doc, proc) == (True, True)
    assert _ve(client, cenario, "ana", doc, proc) == (False, False)


def test_liberar_lote_tira_os_anexos(client, db, cenario):
    doc, proc = _anexos_do_caso(db, cenario)
    resp = client.post(
        "/api/precatorios/liberar-lote", headers=cenario.auth["admin"],
        json={"ids": [cenario.prec_ana]},
    )
    assert resp.status_code == 200 and resp.json()["liberados"] == 1
    assert _ve(client, cenario, "ana", doc, proc) == (False, False)


def test_acao_liberada_e_assumida_leva_os_anexos(client, db, cenario):
    doc = _salvar(db, models.Document(
        original_name="RG da parte.pdf", file_path="rg.pdf", categoria="identificacao",
        acao_id=cenario.acao_ana, owner_id=cenario.ana,
    ))

    def ve(papel):
        r = client.get(f"/api/documents?acao_id={cenario.acao_ana}", headers=cenario.auth[papel])
        return doc in [d["id"] for d in r.json()]

    assert ve("ana")
    assert client.post(f"/api/acoes/{cenario.acao_ana}/liberar", headers=cenario.auth["ana"]).status_code == 200
    assert not ve("ana")
    assert client.post(f"/api/acoes/{cenario.acao_ana}/assumir", headers=cenario.auth["bruno"]).status_code == 200
    assert ve("bruno")


def test_anexo_do_cliente_fica_com_o_dono_do_cliente(client, db, cenario):
    # Anexo ligado ao caso E a um cliente nasce com o dono do cliente
    # (documents._validar_vinculos_upload). Liberar o caso não pode tirá-lo dela.
    doc = _salvar(db, models.Document(
        original_name="Contrato da cliente.pdf", file_path="c.pdf", categoria="contrato",
        precatorio_id=cenario.prec_ana, client_id=cenario.cli_ana, owner_id=cenario.ana,
    ))
    proc = _salvar(db, models.Assinatura(
        titulo="Procuração — cliente", tipo="procuracao", area="precatorios",
        precatorio_id=cenario.prec_ana, client_id=cenario.cli_ana, owner_id=cenario.ana,
    ))
    client.post(f"/api/precatorios/{cenario.prec_ana}/liberar", headers=cenario.auth["ana"])
    client.post(f"/api/precatorios/{cenario.prec_ana}/assumir", headers=cenario.auth["bruno"])

    docs = client.get(f"/api/documents?client_id={cenario.cli_ana}", headers=cenario.auth["ana"])
    assert doc in [d["id"] for d in docs.json()]
    assins = client.get("/api/assinaturas", headers=cenario.auth["ana"])
    assert proc in [a["id"] for a in assins.json()]
    assert _ve(client, cenario, "bruno", doc, proc) == (False, False)


@pytest.mark.parametrize("entidade,caso,fk", [
    ("precatorios", "prec_ana", "precatorio_id"),
    ("acoes", "acao_ana", "acao_id"),
])
def test_reassumir_o_proprio_caso_nao_mexe_em_anexo_de_colega(client, db, cenario, entidade, caso, fk):
    # Anexo do caso da Ana ligado ao PROCESSO do Bruno é do Bruno. "Assumir"
    # de novo o que já é dela não pode puxá-lo.
    doc = _salvar(db, models.Document(
        original_name="Peça do processo.pdf", file_path="p.pdf", categoria="peticao",
        process_id=cenario.proc_bruno, owner_id=cenario.bruno, **{fk: getattr(cenario, caso)},
    ))
    resp = client.post(f"/api/{entidade}/{getattr(cenario, caso)}/assumir", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    db.expire_all()
    assert db.query(models.Document).get(doc).owner_id == cenario.bruno


def test_admin_trocando_o_responsavel_da_acao_leva_os_anexos(client, db, cenario):
    doc = _salvar(db, models.Document(
        original_name="RG da parte.pdf", file_path="rg.pdf", categoria="identificacao",
        acao_id=cenario.acao_ana, owner_id=cenario.ana,
    ))
    resp = client.put(f"/api/acoes/{cenario.acao_ana}", headers=cenario.auth["admin"],
                      json={"owner_id": cenario.bruno})
    assert resp.status_code == 200
    db.expire_all()
    assert db.query(models.Document).get(doc).owner_id == cenario.bruno


def test_habilitacao_requerente_e_o_titular(client, db, cenario):
    planilha = _xlsx([
        ["Requisitório", "Nome do falecido", "CPF do falecido", "Nome do herdeiro",
         "CPF do herdeiro", "Telefone do herdeiro"],
        ["20240077777", "Titular Falecido", "666.666.666-66", "Herdeira Contato",
         "777.777.777-77", "(82) 97777-6666"],
    ])
    resp = client.post(
        "/api/precatorios/importar", headers=cenario.auth["admin"],
        files={"file": ("habilitacao.xlsx", planilha,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert resp.status_code == 200, resp.text
    p = db.query(models.Precatorio).filter_by(numero_precatorio="20240077777").one()
    # Um lead de UMA pessoa: o titular.
    assert p.requerente_nome == "Titular Falecido"
    assert p.requerente_cpf == "666.666.666-66"
    assert p.requerente_telefone is None
    obs = p.observacoes or ""
    assert "Nome do herdeiro: Herdeira Contato" in obs
    assert "777.777.777-77" not in obs and "97777" not in obs
    avisos = " ".join(resp.json()["avisos"])
    assert "CPF do herdeiro" in avisos and "Telefone do herdeiro" in avisos


# Cada filtro de _propagar_dono_* pinado por um teste próprio: a revisão mostrou
# que, sem isto, tirar um filtro deixava a suíte verde.
@pytest.mark.parametrize("vinculo", ["client_id", "process_id"])
def test_anexo_de_cliente_ou_processo_nao_acompanha_o_precatorio(client, db, cenario, vinculo):
    alvo = {"client_id": cenario.cli_ana, "process_id": cenario.proc_ana}[vinculo]
    doc = _salvar(db, models.Document(
        original_name="Do cliente.pdf", file_path="c.pdf", categoria="contrato",
        precatorio_id=cenario.prec_ana, owner_id=cenario.ana, **{vinculo: alvo},
    ))
    client.post(f"/api/precatorios/{cenario.prec_ana}/liberar", headers=cenario.auth["ana"])
    db.expire_all()
    assert db.query(models.Document).get(doc).owner_id == cenario.ana


@pytest.mark.parametrize("vinculo", ["client_id", "process_id", "precatorio_id"])
def test_anexo_de_outro_vinculo_nao_acompanha_a_acao(client, db, cenario, vinculo):
    alvo = {"client_id": cenario.cli_ana, "process_id": cenario.proc_ana,
            "precatorio_id": cenario.prec_ana}[vinculo]
    doc = _salvar(db, models.Document(
        original_name="De outro vínculo.pdf", file_path="v.pdf", categoria="contrato",
        acao_id=cenario.acao_ana, owner_id=cenario.ana, **{vinculo: alvo},
    ))
    client.post(f"/api/acoes/{cenario.acao_ana}/liberar", headers=cenario.auth["ana"])
    db.expire_all()
    assert db.query(models.Document).get(doc).owner_id == cenario.ana


def test_reassumir_acerta_anexo_antigo_so_do_caso(client, db, cenario):
    # Anexo SÓ do caso que ficou com o dono antigo (liberado antes da propagação
    # existir): reassumir o leva para quem é dono do caso.
    doc = _salvar(db, models.Document(
        original_name="Antigo.pdf", file_path="a.pdf", categoria="identificacao",
        precatorio_id=cenario.prec_ana, owner_id=cenario.bruno,
    ))
    resp = client.post(f"/api/precatorios/{cenario.prec_ana}/assumir", headers=cenario.auth["ana"])
    assert resp.status_code == 200
    db.expire_all()
    assert db.query(models.Document).get(doc).owner_id == cenario.ana
