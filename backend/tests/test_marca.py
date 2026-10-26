"""Marca configurável (white-label, out/2026).

O padrão (`marca.PADRAO`) é o do escritório; a versão pública LeoJuris troca
só esse bloco. Por isso os testes não fixam um nome: comparam com o PADRAO e
valem nos dois repositórios. O que eles garantem:
  1. sem nenhuma variável, a tela, o manifest do PWA e o 2FA mostram o PADRAO;
  2. com as variáveis, tudo isso troca junto — inclusive para uma marca sem
     logo horizontal e sem encarregado, como a LeoJuris;
  3. o valor da variável vai escapado para o HTML;
  4. os marcadores ficam fora dos <script> inline (a CSP guarda o hash deles);
  5. tudo o que o service worker pré-carrega existe (cache.addAll falha
     inteiro com um único 404).
"""
import html
import json
import re
from pathlib import Path

import pyotp
import pytest

from app import main, marca

from conftest import criar_usuario, headers_de

FRONTEND = Path(main.FRONTEND_DIR)
P = marca.PADRAO

VARS = (
    "MARCA_NOME", "MARCA_NOME_CURTO", "MARCA_SUBTITULO", "MARCA_DESCRICAO",
    "MARCA_LOGO_HORIZONTAL", "MARCA_LOGO_VERTICAL", "MARCA_EMISSOR_2FA",
    "LGPD_ENCARREGADO_NOME", "LGPD_ENCARREGADO_EMAIL",
)


@pytest.fixture
def sem_marca(monkeypatch):
    for v in VARS:
        monkeypatch.delenv(v, raising=False)


@pytest.fixture
def leojuris(monkeypatch, sem_marca):
    """Marca sem logo horizontal e sem encarregado — o caso da vitrine pública."""
    monkeypatch.setenv("MARCA_NOME", "LeoJuris")
    monkeypatch.setenv("MARCA_NOME_CURTO", "LeoJuris")
    monkeypatch.setenv("MARCA_SUBTITULO", "Gestão jurídica")
    monkeypatch.setenv("MARCA_LOGO_HORIZONTAL", "")
    monkeypatch.setenv("LGPD_ENCARREGADO_NOME", "")
    monkeypatch.setenv("LGPD_ENCARREGADO_EMAIL", "")


@pytest.fixture
def escritorio(monkeypatch, sem_marca):
    valores = {
        "MARCA_NOME": "Escritório Exemplo Advocacia",
        "MARCA_NOME_CURTO": "Exemplo",
        "MARCA_SUBTITULO": "Advocacia",
        "MARCA_LOGO_HORIZONTAL": "/static/assets/exemplo-h.png",
        "MARCA_LOGO_VERTICAL": "/static/assets/exemplo-v.png",
        "LGPD_ENCARREGADO_NOME": "Fulana de Tal",
        "LGPD_ENCARREGADO_EMAIL": "dpo@exemplo.test",
    }
    for k, v in valores.items():
        monkeypatch.setenv(k, v)
    return valores


def test_sem_variaveis_vale_o_padrao(client, sem_marca):
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    pagina = r.text
    assert f"<title>{html.escape(P['nome'])}</title>" in pagina
    assert "{{" not in pagina                       # nenhum marcador sobrou
    if P["logo_horizontal"]:
        assert f'src="{P["logo_horizontal"]}" class="sidebar-logo"' in pagina
    else:
        assert 'class="brand-lockup"' in pagina
    assert ("sidebar-lgpd" in pagina) == bool(P["encarregado_nome"])

    dados = json.loads(client.get("/manifest.json").text)
    assert dados["name"] == P["nome"] and dados["short_name"] == P["nome_curto"]
    assert dados["description"] == P["descricao"]
    assert all(i["src"] == P["logo_vertical"] for i in dados["icons"])


def test_leojuris_sem_logo_horizontal_e_sem_encarregado(client, leojuris):
    pagina = client.get("/").text
    assert "<title>LeoJuris</title>" in pagina
    assert 'alt="LeoJuris"' in pagina
    # Sem logo horizontal: símbolo + nome em texto (o PNG horizontal traz o
    # nome do escritório escrito na imagem).
    assert 'class="brand-lockup"' in pagina and "sidebar-logo" not in pagina
    assert '<div class="brand-texto">LeoJuris<small>Gestão jurídica</small></div>' in pagina
    assert "sidebar-lgpd" not in pagina             # sem encarregado, sem bloco
    if P["nome"] != "LeoJuris":
        assert html.escape(P["nome"]) not in pagina

    dados = json.loads(client.get("/manifest.json").text)
    assert dados["name"] == "LeoJuris"
    assert dados["description"] == "Sistema de gestão jurídica — LeoJuris."


def test_variaveis_trocam_tela_e_manifest_juntos(client, escritorio):
    pagina = client.get("/").text
    assert "<title>Escritório Exemplo Advocacia</title>" in pagina
    assert 'content="Exemplo"' in pagina            # nome curto do PWA/aba
    assert 'src="/static/assets/exemplo-h.png" class="sidebar-logo"' in pagina
    assert "brand-lockup" not in pagina
    assert 'src="/static/assets/exemplo-v.png"' in pagina
    assert "Fulana de Tal" in pagina and "mailto:dpo@exemplo.test" in pagina

    m = client.get("/manifest.json")
    assert m.status_code == 200
    assert m.headers["content-type"].startswith("application/manifest+json")
    dados = json.loads(m.text)
    assert dados["name"] == "Escritório Exemplo Advocacia"
    assert dados["short_name"] == "Exemplo"
    assert {i["sizes"] for i in dados["icons"]} == {"192x192", "512x512"}
    assert all(i["src"] == "/static/assets/exemplo-v.png" for i in dados["icons"])


def test_valor_da_variavel_vai_escapado(client, sem_marca, monkeypatch):
    monkeypatch.setenv("MARCA_NOME", 'X"><script>alert(1)</script>')
    monkeypatch.setenv("LGPD_ENCARREGADO_NOME", "<img src=x onerror=alert(1)>")
    pagina = client.get("/").text
    assert "<script>alert(1)</script>" not in pagina
    assert "<img src=x onerror" not in pagina
    assert "&lt;script&gt;" in pagina


def test_marcadores_ficam_fora_dos_scripts_inline():
    # A CSP guarda o hash dos <script> inline calculado do ARQUIVO. Marcador
    # dentro de um deles mudaria o script servido e o hash deixaria de bater.
    modelo = (FRONTEND / "index.html").read_text(encoding="utf-8")
    for corpo in re.findall(r"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", modelo, re.S):
        assert "{{" not in corpo


def test_scripts_inline_servidos_batem_com_a_csp(client, escritorio):
    r = client.get("/")
    csp = r.headers["content-security-policy"]
    for h in main._hashes_scripts_inline(FRONTEND / "index.html"):
        assert h in csp


def test_emissor_do_2fa_segue_a_marca(client, db, monkeypatch, sem_marca):
    u = criar_usuario(db, "Marca 2FA", "marca2fa@teste.local", "advogado")

    def emissor():
        r = client.post("/api/auth/2fa/setup", headers=headers_de(u))
        assert r.status_code == 200, r.text
        return pyotp.parse_uri(r.json()["otpauth_uri"]).issuer

    assert emissor() == P["emissor_2fa"]
    monkeypatch.setenv("MARCA_NOME", "LeoJuris")      # trocou o nome: o emissor acompanha
    assert emissor() == "LeoJuris"
    monkeypatch.setenv("MARCA_EMISSOR_2FA", "Exemplo Advocacia")
    assert emissor() == "Exemplo Advocacia"


def test_tudo_que_o_service_worker_precarrega_existe(client, sem_marca):
    # cache.addAll falha inteiro se UM item der 404 — e o PWA deixa de instalar.
    sw = (FRONTEND / "sw.js").read_text(encoding="utf-8")
    shell = re.search(r"const SHELL = \[(.*?)\];", sw, re.S).group(1)
    urls = re.findall(r'"([^"]+)"', shell)
    assert P["logo_vertical"] in urls
    for url in urls:
        r = client.get(url.split("?")[0])
        assert r.status_code == 200, url
