"""Cálculo de prazos processuais em dias úteis.

Considera fins de semana, feriados nacionais (fixos e móveis, derivados da Páscoa)
e a suspensão de prazos prevista no art. 220 do CPC (20/12 a 20/01).

OBS.: é um AUXÍLIO. Feriados estaduais/municipais e feriados forenses específicos
de cada tribunal podem variar — confira sempre o prazo final.
"""
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache


# ---------------------------------------------------------------------------
# "Hoje" e "agora" no horário de Brasília
#
# O servidor do Render roda em UTC: entre 21h e meia-noite de Brasília o
# `date.today()` dele já é o dia SEGUINTE. Para "prazo vencido" isso significa
# marcar como vencido, às 21h, o prazo que vence hoje — e o contrário no filtro
# "só com prazo vencido". Tudo que compara com "hoje" na ficha passa por aqui.
#
# Deslocamento FIXO de -3h, de propósito: o Brasil não tem horário de verão
# desde 2019, e um fuso fixo não depende de a imagem do container trazer a base
# tzdata (a python:3.11-slim nem sempre traz) — falhar aqui derrubaria o import.
# ---------------------------------------------------------------------------
FUSO_BRASILIA = timezone(timedelta(hours=-3))


def agora_local() -> datetime:
    """Data e hora de Brasília, SEM fuso (naive) — o formato que o banco guarda."""
    return datetime.now(FUSO_BRASILIA).replace(tzinfo=None)


def hoje_local() -> date:
    """A data de hoje em Brasília (não a do servidor, que está em UTC)."""
    return agora_local().date()


def utc_para_local(dt):
    """Converte um `created_at` (gravado com `datetime.utcnow`) para Brasília.

    A linha do tempo mistura datas que o NAVEGADOR mandou (hora local, como a do
    atendimento) com carimbos que o SERVIDOR gerou (UTC). Sem converter, o
    `new Date('...T12:00:00')` do front mostra o carimbo 3h adiantado e a ordem
    dos eventos de um mesmo dia sai trocada.
    """
    if dt is None:
        return None
    if not isinstance(dt, datetime):
        return dt
    return dt - timedelta(hours=3)


def _pascoa(ano: int) -> date:
    """Domingo de Páscoa (algoritmo de Gauss/anônimo gregoriano)."""
    a = ano % 19
    b = ano // 100
    c = ano % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes = (h + l - 7 * m + 114) // 31
    dia = ((h + l - 7 * m + 114) % 31) + 1
    return date(ano, mes, dia)


@lru_cache(maxsize=64)
def feriados_nacionais(ano: int) -> frozenset:
    """Conjunto de feriados nacionais (fixos + móveis) do ano."""
    pascoa = _pascoa(ano)
    fixos = [
        date(ano, 1, 1),    # Confraternização Universal
        date(ano, 4, 21),   # Tiradentes
        date(ano, 5, 1),    # Dia do Trabalho
        date(ano, 9, 7),    # Independência
        date(ano, 10, 12),  # Nossa Senhora Aparecida
        date(ano, 11, 2),   # Finados
        date(ano, 11, 15),  # Proclamação da República
        date(ano, 12, 25),  # Natal
    ]
    moveis = [
        pascoa - timedelta(days=48),  # Segunda de Carnaval
        pascoa - timedelta(days=47),  # Terça de Carnaval
        pascoa - timedelta(days=2),   # Sexta-feira Santa
        pascoa + timedelta(days=60),  # Corpus Christi
    ]
    return frozenset(fixos + moveis)


def _suspensao_cpc(d: date) -> bool:
    """Suspensão de prazos processuais (CPC art. 220): 20/12 a 20/01."""
    return (d.month == 12 and d.day >= 20) or (d.month == 1 and d.day <= 20)


def eh_dia_util(d: date) -> bool:
    """True se for dia útil para fins de prazo processual."""
    if d.weekday() >= 5:  # 5=sábado, 6=domingo
        return False
    if d in feriados_nacionais(d.year):
        return False
    if _suspensao_cpc(d):
        return False
    return True


def add_dias_uteis(base: date, dias: int) -> date:
    """Soma 'dias' dias úteis a partir do dia seguinte à data base.

    A contagem dos prazos processuais começa no primeiro dia útil seguinte
    (exclui-se o dia do começo, inclui-se o do vencimento — CPC art. 224).
    """
    d = base
    contados = 0
    while contados < dias:
        d = d + timedelta(days=1)
        if eh_dia_util(d):
            contados += 1
    # Se o vencimento cair em dia não útil, prorroga para o próximo dia útil
    while not eh_dia_util(d):
        d = d + timedelta(days=1)
    return d


def add_dias_corridos(base: date, dias: int) -> date:
    """Soma dias corridos; se vencer em dia não útil, prorroga para o próximo útil."""
    d = base + timedelta(days=dias)
    while not eh_dia_util(d):
        d = d + timedelta(days=1)
    return d


def proximo_dia_util(base: date) -> date:
    """Primeiro dia útil ESTRITAMENTE após a data base."""
    d = base + timedelta(days=1)
    while not eh_dia_util(d):
        d = d + timedelta(days=1)
    return d


def sugerir_prazo(disponibilizacao: date, dias: int) -> dict:
    """Sugere o prazo a partir da data de disponibilização no DJEN.

    Regra (Lei 11.419/2006 art. 4º §3º e CPC arts. 224 e 231):
      - Publicação = primeiro dia útil seguinte à disponibilização;
      - Início da contagem = primeiro dia útil seguinte à publicação;
      - Vencimento = contagem de N dias úteis (exclui o começo, inclui o fim).
    É uma SUGESTÃO — feriados locais/forenses variam; o advogado confirma.
    """
    publicacao = proximo_dia_util(disponibilizacao)
    inicio = proximo_dia_util(publicacao)
    vencimento = add_dias_uteis(publicacao, dias)
    return {
        "disponibilizacao": disponibilizacao.isoformat(),
        "publicacao": publicacao.isoformat(),
        "inicio_contagem": inicio.isoformat(),
        "vencimento": vencimento.isoformat(),
        "dias": dias,
    }
