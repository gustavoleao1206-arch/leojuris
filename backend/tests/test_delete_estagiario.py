"""(e) DELETE + ESTAGIÁRIO — nenhuma rota de exclusão aceita o estagiário.

Regra FIXA do perfil (scope.require_excluir): o estagiário nunca exclui,
em módulo nenhum, nem se o admin liberar edição em tudo. Já falhou em
produção por esquecimento — `delete_process` ficou sem a trava na primeira
leva e o estagiário apagava processos.

Como a cobertura é garantida, em vez de confiada à memória:

  * `ROTAS_DELETE` tem UMA entrada por rota DELETE do app, com um alvo que
    EXISTE no cenário. Alvo existente importa: sem a trava, a rota apagaria
    (200) em vez de responder 404 — é isso que faz o teste pegar a regressão.
  * `test_toda_rota_delete_esta_coberta` compara a tabela com as rotas
    REGISTRADAS no app. Rota DELETE nova sem entrada aqui quebra a suíte —
    substitui a varredura manual de `@router.delete` que antes se fazia.
  * Dois perfis de estagiário: o PRESET (como a tela cria) e "tudo liberado"
    (o admin marcou editar em todos os módulos). No preset, algumas rotas já
    caem no `require_edit`; no "tudo liberado" o único obstáculo que sobra é o
    `require_excluir` — ou o gate de admin, nas rotas que só o admin usa.
  * O controle com o admin prova que cada alvo é apagável de verdade.
"""
import pytest

from app import models
from app.scope import MODULOS, normalizar_permissoes

from conftest import criar_usuario, headers_de, rotas_api_do_app

# rota -> (atributos do cenário que preenchem os {parâmetros}, na ordem; modelo do alvo)
# O ÚLTIMO atributo é o registro que a rota apagaria.
ROTAS_DELETE = {
    "/api/auth/users/{user_id}": (["sem_vinculo"], models.User),
    # O cliente do Bruno, e não o da Ana: o da Ana tem honorários e assinaturas
    # presos a ele, e desde out/2026 isso dá 409 (antes estourava FK no
    # Postgres) — ver tests/test_ficha_exclusao.py. O do Bruno só tem processo,
    # que o ORM apaga em cascata — o controle do admin testa o caminho real.
    "/api/clients/{client_id}": (["cli_bruno"], models.Client),
    "/api/processes/{process_id}": (["proc_ana"], models.Process),
    "/api/deadlines/{deadline_id}": (["prazo_ana"], models.Deadline),
    "/api/appointments/{appointment_id}": (["agenda_ana"], models.Appointment),
    "/api/documents/{document_id}": (["doc_ana"], models.Document),
    "/api/honorarios/{honorario_id}": (["hon_ana"], models.Honorario),
    "/api/precatorios/{precatorio_id}": (["prec_ana"], models.Precatorio),
    "/api/precatorios/{precatorio_id}/contatos/{contato_id}": (
        ["prec_ana", "contato_prec"], models.PrecatorioContato),
    "/api/acoes/{acao_id}": (["acao_ana"], models.Acao),
    "/api/acoes/{acao_id}/contatos/{contato_id}": (["acao_ana", "contato_acao"], models.AcaoContato),
    "/api/assinaturas/{assinatura_id}": (["assin_ana"], models.Assinatura),
    "/api/monitor/{monitor_id}": (["monitor"], models.Monitor),
    "/api/publicacoes/oabs/{oab_id}": (["oab"], models.OabMonitorada),
    # Ficha única (out/2026): os filhos herdam o acesso do cliente/processo da
    # URL — o primeiro atributo é o pai, o último o registro que sai.
    "/api/clients/{client_id}/atendimentos/{atendimento_id}": (
        ["cli_ana", "atend_ana"], models.Atendimento),
    "/api/clients/{client_id}/contatos/{contato_id}": (
        ["cli_ana", "contato_cli_ana"], models.ClienteContato),
    "/api/processes/{process_id}/partes/{parte_id}": (
        ["proc_ana", "parte_ana"], models.ProcessoParte),
    "/api/processes/{process_id}/andamentos/{andamento_id}": (
        ["proc_ana", "andamento_ana"], models.ProcessoAndamento),
}


def _url_e_alvo(cenario, rota):
    attrs, modelo = ROTAS_DELETE[rota]
    ids = [getattr(cenario, a) for a in attrs]
    url = rota
    for valor in ids:
        inicio = url.index("{")
        url = url[:inicio] + str(valor) + url[url.index("}") + 1:]
    return url, modelo, ids[-1]


def _existe(db, modelo, registro_id) -> bool:
    db.expire_all()
    return db.query(modelo).get(registro_id) is not None


def test_toda_rota_delete_esta_coberta():
    # `app.routes` deixou de ser lista plana no FastAPI 0.137: ver o conftest.
    registradas = {caminho for metodo, caminho in rotas_api_do_app() if metodo == "DELETE"}
    sem_teste = registradas - set(ROTAS_DELETE)
    assert not sem_teste, (
        f"Rota DELETE sem teste: {sorted(sem_teste)}. Garanta que ela chama "
        "require_excluir(current_user) (ou é admin-only) e adicione-a em ROTAS_DELETE."
    )
    assert not set(ROTAS_DELETE) - registradas, "ROTAS_DELETE lista rota que não existe mais"


@pytest.fixture
def estagiario_tudo_liberado(db):
    """O admin marcou ver+editar em TODOS os módulos na tela de permissões."""
    tudo = {"modules": {m: {"view": True, "edit": True} for m in MODULOS}}
    u = criar_usuario(
        db, "Estagiário Tudo Liberado", "estag.total@teste.local", "estagiario",
        permissions=normalizar_permissoes(tudo, "estagiario"),
    )
    return headers_de(u)


@pytest.mark.parametrize("perfil", ["preset", "tudo_liberado"])
@pytest.mark.parametrize("rota", sorted(ROTAS_DELETE))
def test_estagiario_nao_exclui(client, db, cenario, estagiario_tudo_liberado, rota, perfil):
    headers = cenario.auth["estag"] if perfil == "preset" else estagiario_tudo_liberado
    url, modelo, alvo = _url_e_alvo(cenario, rota)

    resp = client.delete(url, headers=headers)

    assert resp.status_code == 403, f"{rota} ({perfil}): {resp.status_code} {resp.text[:200]}"
    assert _existe(db, modelo, alvo), f"{rota} ({perfil}) respondeu 403 mas apagou o registro"


def test_perfil_tudo_liberado_so_perde_o_financeiro(db, estagiario_tudo_liberado):
    # Garante que o segundo perfil é mesmo "tudo liberado": se o preset voltar
    # a ser aplicado por engano, o teste acima deixaria de provar o que promete.
    from app.scope import can_edit
    u = db.query(models.User).filter_by(email="estag.total@teste.local").one()
    for modulo in MODULOS:
        assert can_edit(u, modulo) == (modulo != "financeiro"), modulo


@pytest.mark.parametrize("rota", sorted(ROTAS_DELETE))
def test_controle_admin_exclui(client, db, cenario, rota):
    url, modelo, alvo = _url_e_alvo(cenario, rota)
    resp = client.delete(url, headers=cenario.auth["admin"])
    assert resp.status_code == 200, f"{rota}: {resp.status_code} {resp.text[:200]}"
    assert not _existe(db, modelo, alvo)
