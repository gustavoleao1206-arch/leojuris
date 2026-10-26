"""Editar a DATA de um prazo.

Nunca funcionou: o `DeadlineUpdate` declarava `date: Optional[date] = None`, e
num campo com valor padrão o Python grava `date = None` no corpo da classe antes
de avaliar a anotação — o tipo virava `Optional[None]` e todo PUT com data
voltava 422 "Input should be None". A tela de Prazos e a aba da ficha mandam a
data em todo "Editar", então o erro aparecia sempre que alguém tentava corrigir
um vencimento.
"""
from app import models


def test_put_com_nova_data_grava(client, db, cenario):
    r = client.put(
        f"/api/deadlines/{cenario.prazo_ana}",
        json={"date": "2027-01-15", "description": "Contestação (nova data)", "urgency_level": "alta"},
        headers=cenario.auth["ana"],
    )
    assert r.status_code == 200, r.text
    assert r.json()["date"] == "2027-01-15"
    db.expire_all()
    prazo = db.get(models.Deadline, cenario.prazo_ana)
    assert prazo.date.isoformat() == "2027-01-15"


def test_put_sem_data_nao_mexe_na_data(client, db, cenario):
    antes = db.get(models.Deadline, cenario.prazo_ana).date
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", json={"done": 1}, headers=cenario.auth["ana"])
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.get(models.Deadline, cenario.prazo_ana).date == antes


def test_put_com_data_nula_continua_recusado(client, cenario):
    # Coluna NOT NULL: mandar null explicitamente segue sendo 422, não 500.
    r = client.put(f"/api/deadlines/{cenario.prazo_ana}", json={"date": None}, headers=cenario.auth["ana"])
    assert r.status_code == 422
