"""Retenção de dados: a rotina que EXECUTA os prazos, em vez de só prometê-los.

── Por que este módulo existe ────────────────────────────────────────────────
A auditoria de LGPD (Fase 3, set/2026) constatou que nenhuma tabela do CRM
tinha expurgo: a trilha de auditoria crescia para sempre — com NOME DE CLIENTE
dentro, porque o VIEW grava "precatório #486 — Fulano" de propósito — e as
publicações do DJEN (inteiro teor de intimação, com nomes das partes) nunca
saíam do banco. "Guardamos pelo tempo necessário" era promessa sem código.

O que este módulo expurga, e por quê ESTES prazos:

1. TRILHA DE AUDITORIA (audit_logs) — padrão 24 meses.
   ⚠️ O PISO É 13 MESES E NÃO É AJUSTE FINO: o relatório de casos parados
   (precatorios.py, `GET /parados?dias=N`) calcula a última movimentação LENDO
   a trilha, e aceita `dias` até 365. Expurgar linhas mais novas que isso faria
   o relatório cair no fallback de `created_at` e marcar caso ativo antigo como
   parado — quebra silenciosa, a pior espécie. 13 meses = 365 dias + folga.

2. PUBLICAÇÕES DO DJEN (publicacoes) — padrão 24 meses, e SÓ as que:
   - estão ARQUIVADAS (decisão humana de que já foram tratadas);
   - NÃO geraram prazo (deadline_id IS NULL). Publicação com prazo é a prova
     de quando ele começou a correr — o prazo de guarda dessa é decisão
     jurídica (vida do processo + prescrição), não deste módulo.
     VALIDAÇÃO JURÍDICA NECESSÁRIA antes de incluí-las aqui.
   - têm data_disponibilizacao conhecida e fora da janela de sincronização.
     ⚠️ A sync do DJEN varre uma janela FIXA de 30 dias e o dedupe é contra as
     linhas EXISTENTES (ver models.py::Publicacao): apagar dentro da janela
     faz a publicação VOLTAR como não lida. O piso de 2 meses garante isso
     por construção, mesmo que alguém configure errado.

O que NÃO se expurga aqui, de propósito: clientes, processos, precatórios,
ações e contatos. O prazo desses é prescricional/contratual — decisão do dono
com o jurídico, registrada em política, antes de virar código.

── Operação ──────────────────────────────────────────────────────────────────
Roda numa thread própria (main.py), independente do scheduler do DataJud —
desligar o monitor (MONITOR_AUTOCHECK=0) não pode desligar a retenção junto.
No máximo uma execução por dia, controlada por Setting("retencao_ultima_execucao"),
então reinício de processo não duplica. Cada execução escreve UMA linha na
própria trilha (method="RETENCAO", user_id NULL) com as contagens — o admin vê
na tela de Auditoria que a rotina está viva e o que ela levou.

Env:
  RETENCAO_TRILHA_MESES       padrão 24 · 0 desliga a parte da trilha · piso 13
  RETENCAO_PUBLICACOES_MESES  padrão 24 · 0 desliga a parte do DJEN   · piso 2
  RETENCAO_AUTOEXEC           padrão 1  · 0 desliga a thread inteira
"""
import json
import os
from datetime import datetime, timedelta

from . import models

# Pisos de segurança — ver o porquê de cada um na docstring do módulo.
_PISO_TRILHA_MESES = 13
_PISO_PUBLICACOES_MESES = 2
_UM_DIA = timedelta(hours=24)
_CHAVE_ULTIMA = "retencao_ultima_execucao"


def _meses(nome_env: str, padrao: int, piso: int) -> int:
    """Lê o prazo em meses do ambiente. 0 = desligado; qualquer outro valor
    respeita o piso (configurar abaixo dele seria quebrar outra parte do
    sistema sem perceber — melhor clampar e registrar do que obedecer)."""
    try:
        v = int(os.getenv(nome_env, str(padrao)))
    except ValueError:
        v = padrao
    if v == 0:
        return 0
    return max(v, piso)


def deve_executar(db) -> bool:
    """No máximo uma vez por dia, sobrevivendo a reinícios do processo."""
    s = db.query(models.Setting).get(_CHAVE_ULTIMA)
    if not s or not s.value:
        return True
    try:
        ultima = datetime.fromisoformat(json.loads(s.value))
    except (ValueError, TypeError):
        return True
    return datetime.utcnow() - ultima >= _UM_DIA


def executar_retencao(db) -> dict:
    """Aplica os prazos e devolve as contagens. Idempotente: rodar duas vezes
    seguidas apaga zero na segunda."""
    agora = datetime.utcnow()
    trilha_meses = _meses("RETENCAO_TRILHA_MESES", 24, _PISO_TRILHA_MESES)
    pub_meses = _meses("RETENCAO_PUBLICACOES_MESES", 24, _PISO_PUBLICACOES_MESES)

    # timedelta não tem "meses"; 30 dias/mês encurta ~1,8% ao ano, sempre no
    # sentido de guardar MENOS tempo que o nominal — nunca mais.
    n_trilha = 0
    if trilha_meses:
        corte = agora - timedelta(days=30 * trilha_meses)
        n_trilha = (
            db.query(models.AuditLog)
            .filter(models.AuditLog.created_at < corte)
            .delete(synchronize_session=False)
        )

    n_pub = 0
    if pub_meses:
        corte_pub = agora - timedelta(days=30 * pub_meses)
        n_pub = (
            db.query(models.Publicacao)
            .filter(
                models.Publicacao.arquivada == 1,
                models.Publicacao.deadline_id.is_(None),
                models.Publicacao.data_disponibilizacao.isnot(None),
                models.Publicacao.data_disponibilizacao < corte_pub.date(),
            )
            .delete(synchronize_session=False)
        )

    # Registro da execução na PRÓPRIA trilha (user_id NULL = sistema). Se tudo
    # deu zero, registra mesmo assim: "a rotina rodou e não havia nada vencido"
    # é informação — silêncio seria indistinguível de rotina morta, que é
    # exatamente o defeito que este módulo veio corrigir.
    parte_trilha = (f"{n_trilha} linha(s) da trilha (> {trilha_meses} meses)"
                    if trilha_meses else "trilha: desligada (RETENCAO_TRILHA_MESES=0)")
    parte_pub = (f"{n_pub} publicação(ões) arquivada(s) do DJEN "
                 f"(> {pub_meses} meses, sem prazo vinculado)"
                 if pub_meses else "DJEN: desligado (RETENCAO_PUBLICACOES_MESES=0)")
    db.add(models.AuditLog(
        user_id=None, method="RETENCAO", status=200,
        path=f"expurgo automático: {parte_trilha}; {parte_pub}"[:300],
    ))

    s = db.query(models.Setting).get(_CHAVE_ULTIMA)
    if s is None:
        s = models.Setting(key=_CHAVE_ULTIMA, value=json.dumps(agora.isoformat()))
        db.add(s)
    else:
        s.value = json.dumps(agora.isoformat())
    db.commit()
    return {"trilha": n_trilha, "publicacoes": n_pub,
            "trilha_meses": trilha_meses, "publicacoes_meses": pub_meses}
