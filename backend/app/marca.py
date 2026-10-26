"""Marca exibida pelo sistema (white-label, out/2026).

Tudo o que a tela mostra como identidade — nome, logos, nome do app instalado
(PWA), emissor do 2FA e o encarregado de LGPD — sai daqui. O padrão é o
dicionário `PADRAO` abaixo; cada item pode ser trocado por variável de
ambiente, sem mexer no código.

O padrão é o do escritório de propósito: a produção não depende de nenhuma
configuração de painel (configuração de painel não é versionada e muda sem
deixar rastro). A versão pública do projeto, LeoJuris, é gerada trocando SÓ o
bloco `PADRAO` — por isso ele é delimitado e não deve ser espalhado pelo
resto do código.

Variáveis (todas opcionais):
  MARCA_NOME              nome completo  (título da página, PWA, alt dos logos)
  MARCA_NOME_CURTO        nome curto     (ícone do app, sufixo da aba)
  MARCA_SUBTITULO         linha de baixo do nome, quando ele aparece em texto
  MARCA_DESCRICAO         descrição do app instalado (PWA)
  MARCA_LOGO_HORIZONTAL   logo da barra lateral; vazio = símbolo + nome em texto
  MARCA_LOGO_VERTICAL     selo do login e ícone do PWA
  MARCA_EMISSOR_2FA       nome que aparece no app autenticador
  LGPD_ENCARREGADO_NOME   encarregado (art. 41 da LGPD); vazio = o bloco da
  LGPD_ENCARREGADO_EMAIL  barra lateral não aparece

Os valores vão para o HTML sempre por `html.escape` (ver `renderizar_index`):
variável de ambiente não é entrada de usuário, mas um `<` no nome não pode
virar marcação.
"""
import html
import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# >>> PADRAO
PADRAO = {
    "nome": "LeoJuris",
    "nome_curto": "LeoJuris",
    "subtitulo": "Gestão jurídica",
    "descricao": "Sistema de gestão jurídica — LeoJuris.",
    "logo_horizontal": "",
    "logo_vertical": "/static/assets/VERTICAL%2001.png",
    "emissor_2fa": "LeoJuris",
    "encarregado_nome": "",
    "encarregado_email": "",
}
# <<< PADRAO


@dataclass(frozen=True)
class Marca:
    nome: str
    nome_curto: str
    subtitulo: str
    descricao: str
    logo_horizontal: str
    logo_vertical: str
    emissor_2fa: str
    encarregado_nome: str
    encarregado_email: str


def _env(nome: str):
    """Valor da variável, ou None quando ela não existe.

    Vazio é diferente de ausente: `MARCA_LOGO_HORIZONTAL=""` pede a barra sem
    logo horizontal, e `LGPD_ENCARREGADO_NOME=""` esconde o bloco.
    """
    v = os.environ.get(nome)
    return None if v is None else v.strip()


def obter() -> Marca:
    """Lê a marca a cada chamada (barato, e os testes trocam o ambiente)."""
    def texto(var, chave):
        return _env(var) or PADRAO[chave]          # nome vazio não faz sentido

    def opcional(var, chave):
        v = _env(var)
        return PADRAO[chave] if v is None else v

    nome = texto("MARCA_NOME", "nome")
    trocou_nome = nome != PADRAO["nome"]
    return Marca(
        nome=nome,
        nome_curto=texto("MARCA_NOME_CURTO", "nome_curto"),
        subtitulo=texto("MARCA_SUBTITULO", "subtitulo"),
        # Quem troca só o nome não deve herdar a descrição e o emissor do padrão.
        descricao=_env("MARCA_DESCRICAO") or (
            f"Sistema de gestão jurídica — {nome}." if trocou_nome else PADRAO["descricao"]
        ),
        logo_horizontal=opcional("MARCA_LOGO_HORIZONTAL", "logo_horizontal"),
        logo_vertical=texto("MARCA_LOGO_VERTICAL", "logo_vertical"),
        emissor_2fa=_env("MARCA_EMISSOR_2FA") or (nome if trocou_nome else PADRAO["emissor_2fa"]),
        encarregado_nome=opcional("LGPD_ENCARREGADO_NOME", "encarregado_nome"),
        encarregado_email=opcional("LGPD_ENCARREGADO_EMAIL", "encarregado_email"),
    )


def _tipo_imagem(caminho: str) -> str:
    return "image/svg+xml" if caminho.lower().endswith(".svg") else "image/png"


def _bloco_encarregado(m: Marca) -> str:
    """Bloco da barra lateral. Sem nome configurado, não aparece nada.

    Fica na barra lateral, e não numa tela de "sobre" que ninguém abre: o
    valor prático é a equipe saber para onde encaminhar o pedido de um
    cliente sobre os próprios dados, no momento em que ele chega.
    """
    if not m.encarregado_nome:
        return ""
    email = ""
    if m.encarregado_email:
        e = html.escape(m.encarregado_email)
        email = f'\n        <a href="mailto:{e}">{e}</a>'
    return (
        '<div class="sidebar-lgpd" title="Pedido de cliente sobre os próprios dados '
        '(acesso, correção ou exclusão) deve ser encaminhado a este canal.">\n'
        '        <div class="sl-t">Encarregado · LGPD</div>\n'
        f"        <div><b>{html.escape(m.encarregado_nome)}</b></div>{email}\n"
        "      </div>"
    )


def _topo_barra(m: Marca) -> str:
    """Topo da barra lateral: o logo horizontal, ou o símbolo com o nome ao lado."""
    nome = html.escape(m.nome)
    curto = html.escape(m.nome_curto)
    sub = html.escape(m.subtitulo)
    if m.logo_horizontal:
        return (
            f'<img src="{html.escape(m.logo_horizontal)}" class="sidebar-logo" alt="{nome}"\n'
            '             data-on-error="acImgMarcaFallback" />\n'
            '        <div id="brand-fallback" class="brand-fallback" style="display:none">'
            f"{curto}<br><small>{sub}</small></div>"
        )
    return (
        '<div class="brand-lockup">\n'
        f'          <img src="{html.escape(m.logo_vertical)}" class="brand-simbolo" alt=""\n'
        '               data-on-error="acImgOcultar" />\n'
        f'          <div class="brand-texto">{curto}<small>{sub}</small></div>\n'
        "        </div>"
    )


@lru_cache(maxsize=4)
def _ler_modelo(caminho: str, _mtime: float) -> str:
    return Path(caminho).read_bytes().decode("utf-8")


def renderizar_index(caminho_index: Path) -> str:
    """O index.html com os marcadores `{{MARCA_*}}` trocados pela marca.

    ⚠️ Os marcadores ficam FORA dos <script> inline de propósito: a CSP guarda
    o hash desses scripts calculado do arquivo (`main._hashes_scripts_inline`),
    e qualquer troca dentro deles derrubaria o tema e o service worker.
    """
    m = obter()
    texto = _ler_modelo(str(caminho_index), caminho_index.stat().st_mtime)
    trocas = {
        "{{MARCA_NOME}}": html.escape(m.nome),
        "{{MARCA_NOME_CURTO}}": html.escape(m.nome_curto),
        "{{MARCA_SUBTITULO}}": html.escape(m.subtitulo),
        "{{MARCA_LOGO_VERTICAL}}": html.escape(m.logo_vertical),
        "{{MARCA_TOPO_BARRA}}": _topo_barra(m),
        "{{LGPD_ENCARREGADO}}": _bloco_encarregado(m),
    }
    for marcador, valor in trocas.items():
        texto = texto.replace(marcador, valor)
    return texto


def manifesto() -> dict:
    """manifest.json do PWA (nome e ícone do app instalado)."""
    m = obter()
    tipo = _tipo_imagem(m.logo_vertical)
    tamanhos = ["any"] if tipo == "image/svg+xml" else ["192x192", "512x512"]
    return {
        "name": m.nome,
        "short_name": m.nome_curto,
        "description": m.descricao,
        "lang": "pt-BR",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "portrait",
        "background_color": "#0c1827",
        "theme_color": "#14283d",
        "icons": [
            {"src": m.logo_vertical, "sizes": t, "type": tipo, "purpose": "any"}
            for t in tamanhos
        ],
    }


def manifesto_json() -> str:
    return json.dumps(manifesto(), ensure_ascii=False, indent=2)
