"""Controle de acesso do CRM.

São DUAS camadas independentes, que se somam (o acesso só é liberado se as
duas permitirem):

1. Segregação por dono (já existia): admin enxerga tudo; advogado enxerga
   apenas registros cujo owner_id é o seu (e, em Precatórios/Ações, também a
   fila de casos sem dono).

2. Permissões granulares por usuário (novo): o admin escolhe, para cada
   usuário, quais MÓDULOS ele vê e se pode editar, e ainda quais
   CLASSIFICAÇÕES de precatório e quais ÁREAS de ação ele alcança.

Regras importantes:
  - O admin ignora a camada 2: sempre vê e edita tudo.
  - Usuário SEM permissões configuradas (NULL/vazio) tem acesso total. Isso
    mantém os usuários antigos funcionando exatamente como antes.
  - Uma lista de classificações/áreas VAZIA significa "todas".
  - Precatório sem classificação definida (NULL) NÃO aparece para quem tem
    restrição de classificação — só o admin o enxerga até ser classificado.

Centralizar tudo aqui reduz a chance de esquecer o filtro em alguma rota.
"""
import json
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import and_, false, func, or_


# --------------------------------------------------------------------------
# Catálogo de módulos e sub-recursos (usado também pela tela de permissões)
# --------------------------------------------------------------------------
MODULOS = {
    "clients": "Clientes",
    "processes": "Processos",
    "deadlines": "Prazos",
    "appointments": "Agenda",
    "documents": "Documentos",
    "financeiro": "Financeiro",
    "precatorios": "Precatórios",
    "funilprec": "Funil de Precatórios",
    "acoes": "Ações Gerais",
    "assinaturas": "Assinaturas",
}

PREC_CLASSIFICACOES = {
    "com_alvara": "Com alvará",
    "sem_alvara": "Compra de crédito",
    "habilitacao_herdeiros": "Habilitação de herdeiros",
    "reexpedicao": "Reexpedição",
    "cancelado": "Cancelado",
}

ACAO_AREAS = {
    "civel": "Cível",
    "trabalhista": "Trabalhista",
    "previdenciario": "Previdenciário",
    "familia": "Família",
    "consumidor": "Consumidor",
    "tributario": "Tributário",
    "bancario": "Bancário",
    "sucessoes": "Sucessões",
    # ⚠️ "outras", no feminino — combina com "Área". O backend usava "outros" e o
    # frontend "outras", e a divergência impedia fechar esta lista: validar a
    # entrada contra `outros` recusaria o cadastro que a tela manda como
    # `outras`. Decisão do dono (ago/2026): vale **"outras"**.
    #
    # 🚨 NÃO confunda com a lista de PROCESSOS (`PROC_CATEGORIAS` no app.js e
    # `AREA_LABELS` no pipeline.py), que usa "outros" no masculino e está
    # correta. São listas diferentes: processo tem área própria, ação tem a sua.
    "outras": "Outras",
}

# --------------------------------------------------------------------------
# Listas fechadas dos campos que a TELA renderiza como rótulo
# --------------------------------------------------------------------------
# Estes ficam aqui, e não em cada router, porque o `schemas.py` precisa deles
# para barrar valor inventado na ENTRADA — e `scope.py` é o único módulo que
# não importa mais nada do projeto, então dá para importar de qualquer lugar
# sem criar ciclo.
#
# 🚨 POR QUE EXISTEM: todo campo abaixo é interpolado no HTML com o padrão
# `DICT[x] || x`, ou seja, o valor CRU aparece na tela quando não está no
# dicionário. Enquanto eles eram `str` livre, um funcionário gravava
# `<img src=x onerror=...>` no status de um cliente e o código rodava na
# sessão de quem abrisse a tela. O escape no `app.js` é a segunda linha de
# defesa; a lista fechada é a primeira.
#
# ⚠️ Rótulo novo entra AQUI, não numa cópia local — e precisa entrar junto no
# dicionário equivalente do `frontend/app.js`, senão a tela mostra a chave crua.

CLIENT_STATUS = {
    "lead": "Lead",
    "negociacao": "Em negociação",
    "ativo": "Cliente ativo",
    "arquivado": "Arquivado",
}

# Etapas do funil (Kanban), na ordem em que aparecem no quadro.
# Espelho de PREC_LEAD no frontend. Vale para Precatórios E Ações.
FUNIL_LABELS = {
    "novos_leads": "Novos Leads",
    "primeiro_contato": "Primeiro Contato",
    "interesse": "Interesse Confirmado",
    "analise_doc": "Análise Documental",
    "proposta": "Proposta Comercial",
    "contrato_enviado": "Contrato Enviado",
    "contrato_assinado": "Contrato Assinado",
    "processo_andamento": "Processo em Andamento",
    "concluido": "Concluído",
    "perdido": "Perdido / Não Interessado",
}

PREC_PROBABILIDADES = {
    "pouco_provavel": "Pouco provável",
    "possivel": "Possível",
    "muito_provavel": "Muito provável",
}

# Assinatura gerada pela tela. ⚠️ NÃO inclui "anexo": esse valor é escrito
# pelo servidor em `assinaturas.py::upload`, junto de um `tipo` que vem das
# categorias de documento. Por isso a trava mora no `AssinaturaCreate`, e não
# na Base — na Base ela rodaria também na SAÍDA e quebraria a leitura de todo
# anexo já existente.
ASSIN_TIPOS = {"procuracao": "Procuração", "contrato": "Contrato"}
ASSIN_AREAS = {"precatorios": "Precatórios", "civel": "Cível", "trabalhista": "Trabalhista"}

# --- Ficha única de Cliente e Processo (out/2026) ---------------------------
# Mesma regra das listas acima: entram no `Create`/`Update` dos schemas, NUNCA
# na Base (valor fora da lista já gravado não pode quebrar a leitura). O espelho
# dos rótulos no frontend é `FICHA_ROTULOS` (ficha.js) — rótulo novo entra nos
# dois lugares. Os rótulos daqui também montam os títulos da linha do tempo,
# que nunca podem mostrar a chave crua.
ATENDIMENTO_TIPOS = {
    "nota": "Nota",
    "ligacao": "Ligação",
    "whatsapp": "WhatsApp",
    "email": "E-mail",
    "reuniao": "Reunião",
    "presencial": "Presencial",
    "outro": "Outro",
}

CONTATO_PAPEIS = {
    "representante_legal": "Representante legal",
    "socio": "Sócio",
    "procurador": "Procurador",
    "conjuge": "Cônjuge",
    "familiar": "Familiar",
    "financeiro": "Financeiro",
    "contato": "Contato",
    "outro": "Outro",
}

PARTE_TIPOS = {
    "contraria": "Parte contrária",
    "litisconsorte": "Litisconsorte",
    "terceiro": "Terceiro interessado",
    "outro": "Outro",
}

PARTE_POLOS = {
    "ativo": "Polo ativo",
    "passivo": "Polo passivo",
    "terceiro": "Terceiro",
    "outro": "Outro",
}

CLIENTE_ORIGENS = {
    "indicacao": "Indicação",
    "site": "Site",
    "instagram": "Instagram",
    "google": "Google",
    "whatsapp": "WhatsApp",
    "cliente_antigo": "Cliente antigo",
    "parceiro": "Parceiro",
    "outro": "Outro",
}

TIPOS_PESSOA = {"PF": "Pessoa física", "PJ": "Pessoa jurídica"}

INSTANCIAS = {
    "primeiro_grau": "1º grau",
    "segundo_grau": "2º grau",
    "superior": "Tribunal superior",
}

# 🚨 `urgency_level` caía SEM escape num atributo `class` do app.js
# (`badge-urgency-${d.urgency_level}`) e era texto livre na API e no
# gerar-prazo do DJEN — injeção de marcação. Lista fechada na entrada.
URGENCIAS = {"baixa": "Baixa", "media": "Média", "alta": "Alta"}


# --------------------------------------------------------------------------
# Perfis (papéis) do sistema
# --------------------------------------------------------------------------
ROLES = {
    "admin": "Administrador",
    "advogado": "Advogado",
    "estagiario": "Estagiário",
}

# Módulos que o ESTAGIÁRIO nunca acessa. É regra FIXA do perfil: o admin não
# consegue liberar pela tela de permissões nem por payload manipulado.
ESTAGIARIO_BLOQUEADOS = {"financeiro"}

# Preset aplicado ao criar um estagiário sem permissões explícitas: opera o
# dia a dia do escritório e apenas CONSULTA o comercial.
PRESET_ESTAGIARIO = {
    "modules": {
        "clients":      {"view": True,  "edit": True},
        "processes":    {"view": True,  "edit": True},
        "deadlines":    {"view": True,  "edit": True},
        "appointments": {"view": True,  "edit": True},
        "documents":    {"view": True,  "edit": True},
        # Precatórios é EDITÁVEL: alimentar os leads (CPF, telefone, contatos,
        # etapa do funil) é justamente o trabalho do estagiário. Ele continua
        # sem excluir nada (require_excluir) e sem o Financeiro.
        "precatorios":  {"view": True,  "edit": True},
        "funilprec":    {"view": True,  "edit": True},
        "acoes":        {"view": True,  "edit": False},
        "assinaturas":  {"view": True,  "edit": False},
        "financeiro":   {"view": False, "edit": False},
    }
}


# --------------------------------------------------------------------------
# Camada 1 — segregação por dono (comportamento original, preservado)
# --------------------------------------------------------------------------
def is_admin(user) -> bool:
    return getattr(user, "role", None) == "admin"


def is_estagiario(user) -> bool:
    return getattr(user, "role", None) == "estagiario"


def ve_tudo(user) -> bool:
    """Quem ignora a segregação por dono (camada 1).

    O estagiário assiste o escritório inteiro, então enxerga os registros de
    todos os advogados. Ele continua preso à camada 2 (módulos, classificações
    e áreas) e NUNCA herda poder de admin — para isso existe is_admin().
    """
    return is_admin(user) or is_estagiario(user)


def scope(query, model, user):
    """Restringe a consulta ao dono, exceto para quem vê tudo."""
    if ve_tudo(user):
        return query
    return query.filter(model.owner_id == user.id)


def ensure_owner(obj, user, label="registro"):
    """Levanta 403 se o usuário não puder alcançar registro de outro dono."""
    if obj is None:
        return
    if not ve_tudo(user) and getattr(obj, "owner_id", None) != user.id:
        raise HTTPException(status_code=403, detail=f"Sem acesso a este {label}")


def validar_cliente_do_corpo(db, novo_client_id, atual_client_id, user):
    """`client_id` vindo do CORPO de um precatório/ação: existe e é alcançável.

    🚨 Só confere quando o campo VEIO, não é nulo E muda o vínculo atual. A
    tela de Precatórios/Ações manda `client_id` em TODO salvamento; checar
    sempre faria o advogado que edita um lead da fila — já ligado pelo admin a
    um cliente de outro advogado — levar 403 até para salvar uma anotação.
    Trocar PARA o cliente de um colega é que não pode: o caso apareceria no
    painel 360 dele (poluição) e o vínculo revelaria o cliente.

    `db` vem de quem chama; o modelo é importado aqui para o scope.py
    continuar sem importar nada do projeto no topo (é o que evita ciclo).
    """
    if novo_client_id is None or novo_client_id == atual_client_id:
        return
    from . import models
    alvo = db.query(models.Client).get(novo_client_id)
    if not alvo:
        raise HTTPException(status_code=400, detail="Cliente vinculado não existe")
    ensure_owner(alvo, user, "cliente")


def validar_responsavel(db, owner_id):
    """O responsável que o admin escolheu existe? Senão 400, não 500 de FK."""
    from . import models
    if owner_id is None:
        return
    if not db.query(models.User).get(owner_id):
        raise HTTPException(status_code=400, detail="Responsável escolhido não existe")


def alcanca(obj, user) -> bool:
    """A mesma regra do `ensure_owner`, só que respondendo sim/não.

    Para quem precisa OMITIR um bloco em vez de recusar a requisição inteira
    (linha do tempo, vínculo de processo no atendimento). ⚠️ `None` responde
    False — ao contrário do `ensure_owner(None)`, que passa calado.
    """
    if obj is None:
        return False
    return ve_tudo(user) or getattr(obj, "owner_id", None) == user.id


# --------------------------------------------------------------------------
# Busca por CPF/CNPJ que respeita a máscara da FILA
# --------------------------------------------------------------------------
# Formatação ignorada na comparação por igualdade. O espaço não separável
# (U+00A0) entra porque planilha colada do Excel costuma trazê-lo.
_FORMATACAO_DOC = (".", "-", "/", " ", " ")


def _doc_do_termo(termo) -> Optional[str]:
    """O número buscado, só dígitos e sem zeros à esquerda — ou None.

    None quando o termo não é um CPF (11 dígitos) ou CNPJ (14) COMPLETO: aí
    não há comparação por documento nenhuma. Só dígitos ASCII — `isdigit()`
    aceitaria "１" (dígito largo), que o banco não normaliza igual. Os zeros à
    esquerda saem dos DOIS lados porque a importação de Excel grava CPF
    numérico sem o zero (012.345.678-90 vira "1234567890"); continua sendo
    igualdade do número, não casamento parcial.
    """
    digitos = "".join(c for c in str(termo or "") if c in "0123456789")
    if len(digitos) not in (11, 14):
        return None
    return digitos.lstrip("0") or None


def _doc_da_coluna(coluna):
    expr = coluna
    for ch in _FORMATACAO_DOC:
        expr = func.replace(expr, ch, "")
    return func.ltrim(expr, "0")


def condicao_busca_documento(coluna_doc, coluna_owner, termo: str, user):
    """Condição de busca pelo CPF/CNPJ da parte que não vira oráculo da máscara.

    🚨 ERA UM ORÁCULO (set/2026). A busca da lista fazia `cpf ILIKE '%termo%'`
    em todo registro visível — inclusive nos leads da FILA, cujo CPF o advogado
    não vê (`_mascara_ativa`). Com curinga (`1__.___.___-__`) ou substring
    crescente, ele reconstruía o CPF posição a posição: o GET devolvia None e a
    lista entregava o número em algumas dezenas de consultas.

    Regra (decisão do dono): no lead da fila o advogado encontra por CPF só com
    o número COMPLETO — igualdade exata confirma um documento que ele já tem,
    não extrai um que não tem. Nos casos dele, e para quem é ve_tudo (admin e
    estagiário), a busca parcial segue como sempre.

    ⚠️ Espelha o `_mascara_ativa` dos routers (máscara = não ve_tudo E sem
    dono). Campo sensível novo que entre numa busca passa por aqui.
    """
    parcial = coluna_doc.ilike(f"%{termo}%")
    if ve_tudo(user):
        return parcial
    alvo = _doc_do_termo(termo)
    exato = (_doc_da_coluna(coluna_doc) == alvo) if alvo else false()
    return or_(
        and_(coluna_owner == user.id, parcial),
        and_(coluna_owner.is_(None), exato),
    )


# --------------------------------------------------------------------------
# Camada 2 — permissões granulares
# --------------------------------------------------------------------------
def get_perms(user) -> dict:
    """Lê o JSON de permissões do usuário. Retorna {} se não houver nada."""
    raw = getattr(user, "permissions", None)
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _modules(user) -> dict:
    return get_perms(user).get("modules") or {}


def can_view(user, modulo: str) -> bool:
    """O usuário pode ABRIR/LISTAR este módulo?"""
    # Bloqueio fixo do perfil vem ANTES de tudo (inclusive do "acesso total").
    if is_estagiario(user) and modulo in ESTAGIARIO_BLOQUEADOS:
        return False
    if is_admin(user):
        return True
    mods = _modules(user)
    if not mods:  # nada configurado = acesso total (compatibilidade)
        return True
    return bool((mods.get(modulo) or {}).get("view"))


def can_edit(user, modulo: str) -> bool:
    """O usuário pode CRIAR/ALTERAR neste módulo?"""
    if is_estagiario(user) and modulo in ESTAGIARIO_BLOQUEADOS:
        return False
    if is_admin(user):
        return True
    mods = _modules(user)
    if not mods:
        return True
    m = mods.get(modulo) or {}
    return bool(m.get("view")) and bool(m.get("edit"))


def require_view(user, modulo: str):
    if not can_view(user, modulo):
        nome = MODULOS.get(modulo, modulo)
        raise HTTPException(status_code=403, detail=f"Sem permissão para acessar {nome}")


def require_edit(user, modulo: str):
    if not can_edit(user, modulo):
        nome = MODULOS.get(modulo, modulo)
        raise HTTPException(
            status_code=403, detail=f"Sem permissão para alterar registros em {nome}"
        )


def can_excluir(user) -> bool:
    """Pode EXCLUIR registros? O estagiário nunca pode, em módulo nenhum.

    Para admin e advogado nada muda: a exclusão continua governada por
    can_edit() e pela segregação por dono dentro de cada rota.
    """
    return not is_estagiario(user)


def require_excluir(user):
    """Trava de exclusão do perfil estagiário (usar em toda rota DELETE)."""
    if not can_excluir(user):
        raise HTTPException(
            status_code=403,
            detail="Perfil estagiário não pode excluir registros",
        )


def prec_classificacoes(user):
    """Classificações permitidas, ou None quando TODAS são permitidas."""
    if is_admin(user):
        return None
    lista = get_perms(user).get("precatorios_classificacoes")
    if not lista:
        return None
    return [str(x) for x in lista]


def classificacao_permitida(user, classificacao) -> bool:
    permitidas = prec_classificacoes(user)
    if permitidas is None:
        return True
    # Sem classificação definida => visível apenas para o admin.
    return bool(classificacao) and classificacao in permitidas


def filtrar_classificacao(query, model, user):
    """Aplica o filtro de classificação de precatório à consulta."""
    permitidas = prec_classificacoes(user)
    if permitidas is None:
        return query
    return query.filter(model.classificacao.in_(permitidas))


def ensure_classificacao(obj, user, label="precatório"):
    """403 se o usuário não tiver permissão para a classificação do registro."""
    if obj is None:
        return
    if not classificacao_permitida(user, getattr(obj, "classificacao", None)):
        raise HTTPException(
            status_code=403, detail=f"Sem permissão para esta classificação de {label}"
        )


# -------------------------- Sub-recursos: ações ---------------------------
def acao_areas(user):
    """Áreas de ação permitidas, ou None quando TODAS são permitidas."""
    if is_admin(user):
        return None
    lista = get_perms(user).get("acoes_areas")
    if not lista:
        return None
    return [str(x) for x in lista]


def area_permitida(user, area) -> bool:
    permitidas = acao_areas(user)
    if permitidas is None:
        return True
    return bool(area) and area in permitidas


def filtrar_area(query, model, user):
    """Aplica o filtro de área de ação à consulta."""
    permitidas = acao_areas(user)
    if permitidas is None:
        return query
    return query.filter(model.area.in_(permitidas))


def ensure_area(obj, user, label="ação"):
    if obj is None:
        return
    if not area_permitida(user, getattr(obj, "area", None)):
        raise HTTPException(
            status_code=403, detail=f"Sem permissão para esta área de {label}"
        )


# --------------------------------------------------------------------------
# Normalização do JSON vindo da tela de permissões (admin)
# --------------------------------------------------------------------------
def normalizar_permissoes(dados, role: Optional[str] = None) -> Optional[str]:
    """Valida e serializa o dicionário de permissões vindo da tela do admin.

    Cuidado importante: quando o admin salva o formulário, gravamos TODOS os
    módulos de forma explícita (inclusive os desmarcados, como view=false).
    Assim, "desmarcar tudo" significa mesmo "nenhum acesso" — e não é
    confundido com "usuário nunca configurado" (que é NULL = acesso total).

    Retorna None apenas quando o resultado equivale a acesso irrestrito, para
    o banco guardar NULL e o usuário seguir como antes.

    Para o papel 'estagiario': sem permissões explícitas aplica-se o
    PRESET_ESTAGIARIO, e os módulos bloqueados do perfil são sempre gravados
    como negados. O bloqueio de verdade está em can_view/can_edit — aqui é
    para a tela de permissões refletir a realidade.
    """
    if not isinstance(dados, dict) or not dados:
        if role != "estagiario":
            return None
        dados = PRESET_ESTAGIARIO

    entrada = dados.get("modules") or {}
    modules = {}
    for chave in MODULOS:
        valor = entrada.get(chave) or {}
        ver = bool(valor.get("view"))
        editar = bool(valor.get("edit")) and ver  # não faz sentido editar sem ver
        if role == "estagiario" and chave in ESTAGIARIO_BLOQUEADOS:
            ver = editar = False
        modules[chave] = {"view": ver, "edit": editar}

    classif = [c for c in (dados.get("precatorios_classificacoes") or [])
               if c in PREC_CLASSIFICACOES]
    areas = [a for a in (dados.get("acoes_areas") or []) if a in ACAO_AREAS]

    # Marcar todas equivale a "todas" (lista vazia mantém o JSON enxuto).
    if len(classif) == len(PREC_CLASSIFICACOES):
        classif = []
    if len(areas) == len(ACAO_AREAS):
        areas = []

    acesso_total = (
        all(m["view"] and m["edit"] for m in modules.values())
        and not classif
        and not areas
    )
    if acesso_total:
        return None

    saida = {"modules": modules}
    if classif:
        saida["precatorios_classificacoes"] = classif
    if areas:
        saida["acoes_areas"] = areas
    return json.dumps(saida, ensure_ascii=False)
