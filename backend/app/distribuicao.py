"""Motor de distribuição (rateio) de honorários de precatório.

A repartição é uma CASCATA sobre o valor RECEBIDO (regime de caixa):

  1. Caixa Reserva  = pct_reserva % do total          (sai primeiro, do total geral)
  2. Parceiro       = pct_parceiro % do que sobrou     (só quando há parceria)
  3. Escritório     = o restante, dividido entre:
        - Fundo     = pct_fundo % do restante
        - cada Sócio = pct_socio % do restante
     (Fundo + sócios devem somar 100%.)

Exemplo (R$ 100.000 recebidos, parceiro 20%, regra padrão):
  Reserva 5%           -> R$  5.000   (sobra 95.000)
  Parceiro 20% de 95k  -> R$ 19.000   (sobra 76.000 para o escritório)
  Fundo 35% de 76k     -> R$ 26.600
  Sócio A 32,5% de 76k -> R$ 24.700
  Sócio B 32,5% de 76k -> R$ 24.700
  Soma = 100.000  (fecha exatamente)

O resultado é uma lista de fatias {tipo, user_id, nome, pct, base, valor}.
A última fatia absorve a sobra de arredondamento para somar exatamente ao total.
"""
import json
from typing import List, Optional


# Regra padrão de fábrica (o admin edita em Configurações do Financeiro).
# Os user_id dos sócios ficam None até o admin escolher quem são.
DEFAULT_CONFIG = {
    "ativo": True,
    "pct_reserva": 5.0,
    "reserva_nome": "Caixa Reserva",
    "pct_parceiro_padrao": 20.0,
    "fundo_nome": "Fundo",
    "pct_fundo": 35.0,
    # Cada sócio: {"user_id": int|None, "nome": str, "pct": float}
    "socios": [
        {"user_id": None, "nome": "Sócio 1", "pct": 32.5},
        {"user_id": None, "nome": "Sócio 2", "pct": 32.5},
    ],
}


def _num(v, default=0.0) -> float:
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return default


def merge_config(cfg: Optional[dict]) -> dict:
    """Completa o config com os defaults, tolerando campos ausentes."""
    base = json.loads(json.dumps(DEFAULT_CONFIG))  # cópia profunda
    if isinstance(cfg, dict):
        for k, v in cfg.items():
            base[k] = v
    # normaliza sócios
    socios = []
    for i, s in enumerate(base.get("socios") or []):
        if not isinstance(s, dict):
            continue
        socios.append({
            "user_id": s.get("user_id"),
            "nome": (s.get("nome") or f"Sócio {i + 1}").strip(),
            "pct": _num(s.get("pct")),
        })
    base["socios"] = socios
    return base


def validar_config(cfg: dict) -> List[str]:
    """Retorna a lista de erros (vazia = válido)."""
    cfg = merge_config(cfg)
    erros = []
    pr = _num(cfg.get("pct_reserva"))
    if pr < 0 or pr >= 100:
        erros.append("A reserva deve ficar entre 0% e 100%.")
    pp = _num(cfg.get("pct_parceiro_padrao"))
    if pp < 0 or pp > 100:
        erros.append("O percentual padrão do parceiro deve ficar entre 0% e 100%.")
    interno = _num(cfg.get("pct_fundo")) + sum(_num(s.get("pct")) for s in cfg["socios"])
    # tolerância de 0,01 para arredondamento
    if abs(interno - 100.0) > 0.01:
        erros.append(
            f"Fundo + sócios devem somar 100% (atual: {interno:.2f}%)."
        )
    if not cfg["socios"]:
        erros.append("Defina ao menos um sócio.")
    return erros


def calcular_rateio(
    recebido: float,
    cfg: Optional[dict],
    origem: str = "proprio",
    parceiro_id: Optional[int] = None,
    parceiro_nome: Optional[str] = None,
    pct_parceiro: Optional[float] = None,
) -> List[dict]:
    """Calcula as fatias da cascata sobre o valor recebido.

    Retorna [] se não houver valor recebido. A soma das fatias é exatamente
    igual a `recebido` (a última fatia absorve o resíduo de centavos).
    """
    cfg = merge_config(cfg)
    total = _num(recebido)
    if total <= 0:
        return []

    fatias = []

    def _clamp(p):
        """Mantém o percentual entre 0 e 100 (evita fatia negativa por engano)."""
        return min(100.0, max(0.0, _num(p)))

    # Etapa 1 — Caixa Reserva (do total geral)
    pct_reserva = _clamp(cfg.get("pct_reserva"))
    reserva = round(total * pct_reserva / 100, 2)
    if reserva > 0:
        fatias.append({
            "tipo": "reserva", "user_id": None,
            "nome": cfg.get("reserva_nome") or "Caixa Reserva",
            "pct": pct_reserva, "base": total, "valor": reserva,
        })
    pos_reserva = round(max(total - reserva, 0), 2)

    # Etapa 2 — Advogado parceiro (sobre o que sobrou da reserva)
    parceiro = 0.0
    if origem == "parceria" and parceiro_id:
        pp = _clamp(pct_parceiro if pct_parceiro is not None else cfg.get("pct_parceiro_padrao"))
        parceiro = round(pos_reserva * pp / 100, 2)
        fatias.append({
            "tipo": "parceiro", "user_id": parceiro_id,
            "nome": parceiro_nome or "Parceiro",
            "pct": pp, "base": pos_reserva, "valor": parceiro,
        })
    distribuivel = round(max(pos_reserva - parceiro, 0), 2)

    # Etapa 3 — Escritório: Fundo + sócios (sobre o distribuível)
    internos = []
    internos.append({
        "tipo": "fundo", "user_id": None,
        "nome": cfg.get("fundo_nome") or "Fundo",
        "pct": _num(cfg.get("pct_fundo")),
    })
    for s in cfg["socios"]:
        internos.append({
            "tipo": "socio", "user_id": s.get("user_id"),
            "nome": s.get("nome") or "Sócio", "pct": _num(s.get("pct")),
        })
    for item in internos:
        item["base"] = distribuivel
        item["valor"] = round(distribuivel * item["pct"] / 100, 2)
        fatias.append(item)

    # Ajuste de arredondamento: a última fatia absorve a sobra para fechar no total.
    soma = round(sum(f["valor"] for f in fatias), 2)
    resto = round(total - soma, 2)
    if fatias and abs(resto) >= 0.01:
        fatias[-1]["valor"] = round(fatias[-1]["valor"] + resto, 2)

    return fatias


def resumo_config(cfg: Optional[dict]) -> dict:
    """Versão enxuta do config para o frontend (com os defaults aplicados)."""
    return merge_config(cfg)


# --------------------------------------------------------------------------
# Persistência (tabela Setting) e aplicação no livro-razão (HonorarioRateio)
# --------------------------------------------------------------------------
SETTING_KEY = "distribuicao_honorarios"


def load_config(db) -> dict:
    """Lê a regra global do banco (ou os defaults, se ainda não configurada)."""
    from . import models
    row = db.query(models.Setting).get(SETTING_KEY)
    if not row or not row.value:
        return merge_config(None)
    try:
        return merge_config(json.loads(row.value))
    except Exception:
        return merge_config(None)


def save_config(db, cfg: dict) -> dict:
    """Grava a regra global (valida antes). Levanta ValueError se inválida."""
    from . import models
    erros = validar_config(cfg)
    if erros:
        raise ValueError("; ".join(erros))
    cfg = merge_config(cfg)
    row = db.query(models.Setting).get(SETTING_KEY)
    if not row:
        row = models.Setting(key=SETTING_KEY)
        db.add(row)
    row.value = json.dumps(cfg, ensure_ascii=False)
    db.commit()
    return cfg


def _config_do_honorario(db, h) -> dict:
    """Regra a usar para um honorário: snapshot próprio, senão a global."""
    cfg = None
    if getattr(h, "rateio_config", None):
        try:
            cfg = json.loads(h.rateio_config)
        except Exception:
            cfg = None
    if cfg is None:
        cfg = load_config(db)
    cfg = merge_config(cfg)
    # A reserva pode ser sobrescrita por honorário (ajuste pontual).
    if getattr(h, "pct_reserva", None) is not None:
        cfg["pct_reserva"] = _num(h.pct_reserva)
    return cfg


def aplicar_rateio(db, h) -> list:
    """(Re)gera o livro-razão de um honorário a partir do valor pago.

    Apaga as fatias anteriores e recria. NÃO faz commit (o chamador decide).
    Retorna a lista de fatias criadas (vazia se o honorário não é rateado).
    """
    from . import models
    db.query(models.HonorarioRateio).filter(
        models.HonorarioRateio.honorario_id == h.id
    ).delete(synchronize_session=False)

    if not getattr(h, "rateio", 0):
        return []

    cfg = _config_do_honorario(db, h)
    parceiro_nome = None
    if h.parceiro_id:
        u = db.query(models.User).get(h.parceiro_id)
        parceiro_nome = u.name if u else "Parceiro"

    fatias = calcular_rateio(
        h.paid_value or 0, cfg, origem=(h.origem or "proprio"),
        parceiro_id=h.parceiro_id, parceiro_nome=parceiro_nome,
        pct_parceiro=h.pct_parceiro,
    )
    # Resolve o nome real dos sócios pelo user_id (não confia no rótulo do config).
    for f in fatias:
        if f["tipo"] == "socio" and f.get("user_id"):
            u = db.query(models.User).get(f["user_id"])
            if u:
                f["nome"] = u.name
        db.add(models.HonorarioRateio(
            honorario_id=h.id, tipo=f["tipo"], user_id=f.get("user_id"),
            nome=f["nome"], pct=f["pct"], base=f["base"], valor=f["valor"],
        ))
    db.flush()
    return fatias


# --------------------------------------------------------------------------
# Auto-verificação: roda com `python -m app.distribuicao` (ou import em teste).
# --------------------------------------------------------------------------
def _selftest():
    cfg = merge_config({
        "pct_reserva": 5.0, "pct_fundo": 35.0,
        "socios": [
            {"user_id": 1, "nome": "Sócio A", "pct": 32.5},
            {"user_id": 2, "nome": "Sócio B", "pct": 32.5},
        ],
    })
    assert validar_config(cfg) == [], validar_config(cfg)
    fatias = calcular_rateio(100000, cfg, origem="parceria",
                             parceiro_id=9, parceiro_nome="Parceiro X", pct_parceiro=20)
    got = {f["nome"]: f["valor"] for f in fatias}
    esperado = {"Caixa Reserva": 5000.0, "Parceiro X": 19000.0,
                "Fundo": 26600.0, "Sócio A": 24700.0, "Sócio B": 24700.0}
    assert got == esperado, f"esperado {esperado}, obtido {got}"
    assert round(sum(f["valor"] for f in fatias), 2) == 100000.0
    # Sem parceiro: reserva 5% -> 95.000 distribuível para fundo+sócios
    f2 = calcular_rateio(100000, cfg, origem="proprio")
    g2 = {f["nome"]: f["valor"] for f in f2}
    assert g2 == {"Caixa Reserva": 5000.0, "Fundo": 33250.0,
                  "Sócio A": 30875.0, "Sócio B": 30875.0}, g2
    assert round(sum(f["valor"] for f in f2), 2) == 100000.0
    print("distribuicao._selftest OK")


if __name__ == "__main__":
    _selftest()
