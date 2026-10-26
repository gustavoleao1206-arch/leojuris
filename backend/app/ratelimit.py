"""Rate limiting simples, em memória (janela deslizante).

Por que em memória e não Redis: o CRM roda em UMA instância no Render, sem
Redis contratado. Um limitador em processo cobre o caso real (força bruta de
um atacante contra o login) sem adicionar infraestrutura.

⚠️ LIMITAÇÃO CONHECIDA — leia antes de confiar demais:
  - O contador vive no processo. Se um dia o serviço escalar para 2+
    instâncias, cada uma terá o próprio contador e o limite efetivo será
    N × o configurado. Nesse dia, troque por Redis.
  - Reinício do processo zera os contadores.
  - A identificação é por IP + rota. Atrás do Cloudflare/Render o IP real vem
    em X-Forwarded-For; usamos o primeiro da lista.

Mesmo com essas ressalvas, é ordens de magnitude melhor que o estado anterior:
nenhum limite. Um atacante testava senhas na velocidade da rede.
"""
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_lock = threading.Lock()
_hits: dict = defaultdict(deque)      # chave -> deque[timestamps]

# Quantas chaves distintas guardamos antes de fazer faxina (evita crescer sem
# limite se alguém rotacionar IP — o próprio limitador não pode virar um DoS
# de memória contra nós mesmos).
_MAX_CHAVES = 20000


def ip_do_request(request: Request) -> str:
    """IP real do cliente, considerando o proxy na frente do app.

    🚨 A ORDEM AQUI É A CORREÇÃO, não estilo. Até ago/2026 esta função lia o
    `X-Forwarded-For` PRIMEIRO e pegava o item [0] — que é justamente o pedaço
    que o cliente escolhe. Bastava mandar `X-Forwarded-For: 1.2.3.4` com um
    valor diferente a cada tentativa para ganhar um balde novo por requisição:
    o limitador continuava contando, só que nunca a mesma coisa duas vezes.
    E o `cf-connecting-ip` — o único que o atacante NÃO forja — era código
    morto, porque atrás do proxy o XFF nunca está ausente.

    Confirmado em ago/2026 por requisição real: o domínio de produção responde
    com `Server: cloudflare` + `CF-RAY`, e `x-render-origin-server: uvicorn`. Ou
    seja, Cloudflare na frente do Render — `cf-connecting-ip` chega sempre, e é
    escrito pela Cloudflare por cima do que o cliente tiver mandado.

    ⚠️ O ramo do XFF pega o ÚLTIMO item, não o primeiro: cada proxy APENDA quem
    o procurou, então o final da lista é o que o proxy mais próximo escreveu, e
    o começo é o que veio do cliente. Na prática esse ramo só roda em
    desenvolvimento — em produção a Cloudflare resolve antes.
    """
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    xff = request.headers.get("x-forwarded-for", "")
    partes = [p.strip() for p in xff.split(",") if p.strip()]
    if partes:
        return partes[-1]
    return request.client.host if request.client else "desconhecido"


def _limpar_se_preciso(agora: float, janela: int):
    if len(_hits) <= _MAX_CHAVES:
        return
    mortas = [k for k, dq in _hits.items() if not dq or agora - dq[-1] > janela]
    for k in mortas:
        _hits.pop(k, None)


def consumir(chave: str, limite: int, janela_seg: int) -> tuple:
    """Registra um acesso. Devolve (permitido, segundos_para_liberar)."""
    agora = time.time()
    with _lock:
        _limpar_se_preciso(agora, janela_seg)
        dq = _hits[chave]
        while dq and agora - dq[0] > janela_seg:
            dq.popleft()
        if len(dq) >= limite:
            return False, int(janela_seg - (agora - dq[0])) + 1
        dq.append(agora)
        return True, 0


def limitar(request: Request, nome: str, limite: int, janela_seg: int, extra: str = ""):
    """Aplica o limite e levanta 429 quando estourado.

    Duas dimensões, e cada chamada escolhe UMA:
      - sem `extra`  → limite por IP    (barra quem varre senhas de um lugar só)
      - com `extra`  → limite por CONTA (barra quem distribui as tentativas por
                       vários IPs contra o mesmo usuário)

    🚨 O IP SAIU DA CHAVE QUANDO HÁ `extra`, e é isto que conserta a promessa.
    Até ago/2026 a chave era `f"{nome}:{ip}:{extra}"` — com o IP em TODAS as
    dimensões, inclusive na "por conta". O efeito: trocar de IP zerava também o
    contador da conta, então o limite por conta simplesmente não existia, ao
    contrário do que esta docstring afirmava. Quem distribuísse por N IPs
    ganhava 8×N tentativas contra o mesmo e-mail, e 6×N contra o código 2FA —
    que com `valid_window=1` tem 3 códigos válidos por janela.

    Quem cobre a dimensão do IP é a chamada SEM `extra`, que o `auth.py` já faz
    em paralelo (`login-ip`). Por isso não é preciso somar as duas aqui: somar
    puniria o escritório inteiro, que compartilha um IP, com o limite estreito
    pensado para conta.
    """
    chave = f"{nome}:conta:{extra}" if extra else f"{nome}:ip:{ip_do_request(request)}"
    ok, espera = consumir(chave, limite, janela_seg)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail=f"Muitas tentativas. Aguarde {espera}s e tente novamente.",
            headers={"Retry-After": str(espera)},
        )
