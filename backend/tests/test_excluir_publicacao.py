"""Exclusão definitiva de publicações do DJEN arquivadas.

Regras (decisão do dono, set/2026):
  - Só o ADMIN exclui em definitivo (advogado e estagiário recebem 403).
  - Só publicação ARQUIVADA sai — a da caixa não é excluída direto.
  - Publicação que gerou prazo só sai com `incluir_com_prazo` (é a prova de
    quando o prazo começou a correr).
  - Não ressuscita: a chave fica em PublicacaoExcluida e a dedupe a consulta,
    senão o DJEN a traria de volta dentro da janela de 30 dias (ver o modelo).

Cada teste cria as próprias publicações (o banco reseta a cada teste), para não
mexer no cenário compartilhado nem esbarrar na varredura de rotas DELETE.
"""
from datetime import date

import pytest

from app import models
from app.routers.publicacoes import _chaves_existentes


def _nova_pub(db, owner_id, *, arquivada=1, deadline_id=None, ext="DJEN-X", h="h-x"):
    p = models.Publicacao(
        external_id=ext, hash=h, tribunal="trf5",
        numero_processo="0000001-11.2026.4.05.9001", tipo_comunicacao="Intimação",
        data_disponibilizacao=date(2026, 9, 1), texto="inteiro teor",
        oab_captura="12345/AL", lida=1, arquivada=arquivada,
        owner_id=owner_id, deadline_id=deadline_id,
    )
    db.add(p)
    db.commit()
    return p.id


def _excluir(client, cenario, papel, ids, incluir_com_prazo=False):
    return client.post(
        "/api/publicacoes/excluir-lote",
        headers=cenario.auth[papel],
        json={"ids": ids, "incluir_com_prazo": incluir_com_prazo},
    )


def test_admin_exclui_arquivada(client, cenario, db):
    pid = _nova_pub(db, cenario.ana, ext="DJEN-ARQ-1", h="h-arq-1")
    r = _excluir(client, cenario, "admin", [pid])
    assert r.status_code == 200, r.text
    assert r.json()["excluidas"] == 1
    db.expire_all()
    assert db.query(models.Publicacao).get(pid) is None            # sumiu de verdade
    # Rastro (tombstone) preservado — sem o teor, com quem/qual/quando.
    t = db.query(models.PublicacaoExcluida).filter_by(external_id="DJEN-ARQ-1").one()
    assert t.numero_processo == "0000001-11.2026.4.05.9001"
    assert t.deleted_by == cenario.admin


@pytest.mark.parametrize("papel", ["ana", "estag"])
def test_nao_admin_nao_exclui(client, cenario, db, papel):
    pid = _nova_pub(db, cenario.ana)
    r = _excluir(client, cenario, papel, [pid])
    assert r.status_code == 403, r.text
    db.expire_all()
    assert db.query(models.Publicacao).get(pid) is not None         # continua lá


def test_nao_exclui_da_caixa(client, cenario, db):
    """Só arquivadas: uma publicação na caixa não sai nem por engano."""
    pid = _nova_pub(db, cenario.ana, arquivada=0)
    r = _excluir(client, cenario, "admin", [pid])
    assert r.status_code == 200
    assert r.json()["excluidas"] == 0
    db.expire_all()
    assert db.query(models.Publicacao).get(pid) is not None


def test_prazo_exige_confirmacao(client, cenario, db):
    # Deadline dedicado, num processo do cenário que este teste não exclui.
    prazo = models.Deadline(
        process_id=cenario.proc_ana, date=date(2026, 12, 9),
        description="Prazo da publicação", owner_id=cenario.ana,
    )
    db.add(prazo)
    db.commit()
    pid = _nova_pub(db, cenario.ana, deadline_id=prazo.id, ext="DJEN-PRZ", h="h-prz")

    r1 = _excluir(client, cenario, "admin", [pid])
    assert r1.status_code == 200
    assert r1.json() == {"ok": True, "excluidas": 0, "ignoradas_com_prazo": 1}
    db.expire_all()
    assert db.query(models.Publicacao).get(pid) is not None         # protegida por padrão

    r2 = _excluir(client, cenario, "admin", [pid], incluir_com_prazo=True)
    assert r2.status_code == 200
    assert r2.json()["excluidas"] == 1
    db.expire_all()
    assert db.query(models.Publicacao).get(pid) is None


def test_lista_vazia_e_400(client, cenario):
    assert _excluir(client, cenario, "admin", []).status_code == 400


def test_nao_ressuscita_apos_excluir(client, cenario, db):
    """A chave da excluída continua no conjunto de dedupe — não volta no DJEN."""
    pid = _nova_pub(db, cenario.ana, ext="DJEN-RESS", h="h-ress")
    r = _excluir(client, cenario, "admin", [pid])
    assert r.status_code == 200 and r.json()["excluidas"] == 1
    db.expire_all()
    chaves = _chaves_existentes(db)
    assert "DJEN-RESS" in chaves and "h-ress" in chaves
