"""Rotas de autenticação: registro, login (JWT), 2FA e gestão de usuários."""
from typing import List, Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from ..ratelimit import limitar
from .. import marca, models, schemas
from ..auth import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_user,
)
from ..database import get_db
from ..scope import (
    ACAO_AREAS,
    MODULOS,
    PREC_CLASSIFICACOES,
    ROLES,
    get_perms,
    normalizar_permissoes,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _claims(user: models.User) -> dict:
    """Conteúdo do JWT. `tv` é a versão da conta — ver auth.py::get_current_user."""
    return {"sub": str(user.id), "tv": int(getattr(user, "token_version", 0) or 0)}


def _revogar_sessoes(user: models.User):
    """Invalida TODOS os tokens já emitidos para este usuário.

    Chamado quando a confiança na sessão muda: troca de senha, alteração de
    papel/permissões pelo admin. Antes disso, um token continuava válido por
    até 8h depois de a pessoa ser demitida ou rebaixada.
    """
    user.token_version = int(getattr(user, "token_version", 0) or 0) + 1


@router.post("/register", response_model=schemas.UserOut)
def register(
    payload: schemas.UserCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Cria um novo usuário do sistema.

    Protegido: apenas um usuário autenticado com papel 'admin' pode criar
    novas contas (evita registro público aberto em produção).
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Apenas administradores podem cadastrar novos usuários",
        )

    existing = db.query(models.User).filter(models.User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="E-mail já cadastrado")

    user = models.User(
        name=payload.name,
        email=payload.email,
        password_hash=hash_password(payload.password),
        role=payload.role,
        # Permissões opcionais já na criação (None = acesso total).
        # Estagiário sem permissões explícitas nasce com o preset do perfil.
        permissions=normalizar_permissoes(payload.permissions, payload.role),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=schemas.Token)
def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    otp: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Login via OAuth2 (username = usuário/e-mail). Retorna o token JWT.

    Se o usuário tiver 2FA ativado, exige também o código `otp` (do app
    autenticador). Usuários sem 2FA logam normalmente (comportamento inalterado).
    """
    # Rate limiting em DUAS dimensões, de propósito:
    #  - por IP: barra quem varre senhas de um lugar só;
    #  - por CONTA: barra quem distribui as tentativas por vários IPs contra o
    #    mesmo usuário.
    # Sem isso não havia limite nenhum — dava para testar senhas na velocidade
    # da rede (achado da auditoria de ago/2026).
    alvo = (form_data.username or "").strip().lower()[:120]
    limitar(request, "login-ip", limite=20, janela_seg=300)
    limitar(request, "login-conta", limite=8, janela_seg=300, extra=alvo)

    user = db.query(models.User).filter(models.User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="E-mail ou senha inválidos",
        )

    if getattr(user, "totp_enabled", 0) and user.totp_secret:
        import pyotp
        if not otp:
            # Sinaliza ao frontend que falta o código 2FA
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="2FA_REQUIRED")
        # O 2FA é o último obstáculo de quem já tem a senha certa: 6 dígitos
        # sem limite são forçáveis. Limite curto e por conta.
        limitar(request, "2fa", limite=6, janela_seg=300, extra=str(user.id))
        if not pyotp.TOTP(user.totp_secret).verify(str(otp).strip(), valid_window=1):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Código 2FA inválido")

    token = create_access_token(_claims(user))
    return {"access_token": token, "token_type": "bearer", "user": user}


@router.get("/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(get_current_user)):
    """Retorna os dados do usuário autenticado."""
    return current_user


@router.put("/me/avatar", response_model=schemas.UserOut)
def update_avatar(
    payload: schemas.AvatarUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Define ou remove a foto de perfil do próprio usuário (imagem base64)."""
    av = payload.avatar
    if av:
        if not av.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="Formato de imagem inválido")
        if len(av) > 3_000_000:  # ~2MB de imagem em base64
            raise HTTPException(status_code=400, detail="Imagem muito grande (máx. ~2MB)")
    current_user.avatar = av or None
    db.commit()
    db.refresh(current_user)
    return current_user


from pydantic import BaseModel


class TrocaSenha(BaseModel):
    senha_atual: str
    nova_senha: str


def _limitar_senha(request: Request, user: models.User):
    """Conferência da senha ATUAL com a sessão já aberta (out/2026).

    Usa o MESMO balde por conta do login (`login-conta`, chave = e-mail): quem
    tem só o token de uma sessão não ganha um canal paralelo para testar
    senhas. Até out/2026 o /me/password conferia a senha sem limite nenhum —
    com uma sessão roubada dava para chutar a senha na velocidade da rede e,
    acertando, levá-la para fora (ela vale em outros lugares, a sessão não).
    """
    limitar(request, "login-conta", limite=8, janela_seg=300,
            extra=(user.email or "").strip().lower()[:120])


@router.post("/me/password")
def alterar_propria_senha(
    request: Request,
    payload: TrocaSenha,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Permite que o próprio usuário (admin ou advogado) altere a sua senha."""
    _limitar_senha(request, current_user)
    if not verify_password(payload.senha_atual, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Senha atual incorreta.")
    if len(payload.nova_senha or "") < 6:
        raise HTTPException(status_code=400, detail="A nova senha deve ter ao menos 6 caracteres.")
    current_user.password_hash = hash_password(payload.nova_senha)
    # Trocar a senha DEVE derrubar as outras sessões — é o motivo mais comum
    # de troca ("acho que alguém pegou meu acesso"). Sem isto, quem estava
    # dentro continuava dentro.
    _revogar_sessoes(current_user)
    db.commit()
    # Quem trocou a senha continua trabalhando: devolvemos um token novo já na
    # versão nova, para a própria aba não cair.
    return {"ok": True, "access_token": create_access_token(_claims(current_user)), "token_type": "bearer"}


@router.get("/colegas")
def colegas(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lista simples (id, nome, papel) de usuários — para escolher responsável/parceiro."""
    return [
        {"id": u.id, "name": u.name, "role": u.role}
        for u in db.query(models.User).order_by(models.User.name).all()
    ]


# ------------------- 2FA (app autenticador / TOTP, opcional) -------------------
#
# 🚨 Até out/2026 o /2fa/setup gravava um segredo novo DIRETO em `totp_secret`,
# sem pedir nada, mesmo com o 2FA ligado. Quem obtivesse só o token de uma
# sessão (ele fica no localStorage) trocava o segundo fator da vítima: o app
# autenticador dela parava de funcionar e o atacante passava a ter o segredo —
# e o /2fa/disable passava a aceitar o código DELE.
#
# Regras de agora, e por quê:
#   1. 2FA ligado → trocar de aparelho exige a SENHA ATUAL e um código do app
#      ATUAL. É o par que o próprio login exige; a sessão sozinha não basta.
#   2. O segredo novo nasce PENDENTE (`totp_pending_secret`). Só o /2fa/enable,
#      com um código da chave nova, o promove. Até lá login e disable seguem
#      conferindo o segredo antigo: desistir no meio da troca (ou escanear o QR
#      errado) não tranca ninguém para fora.
#   3. Toda conferência de código com o 2FA ligado — login, troca e
#      desativação — gasta o MESMO balde do limitador ("2fa", por conta). Sem
#      isso o /2fa/disable era chute ilimitado de 6 dígitos com uma sessão
#      roubada: desligava o 2FA e caía na primeira ativação.
#   4. Erro aqui é 400/409, nunca 401: o `api()` do frontend trata 401 como
#      sessão expirada e desloga — errar a senha na troca derrubaria a pessoa.
#   5. A PRIMEIRA ativação também exige a senha atual, no /2fa/enable (que é
#      quem liga o 2FA). Até out/2026 bastava a sessão: quem roubasse o token
#      de alguém SEM 2FA ligava o 2FA com a chave DELE e trancava o dono fora
#      da conta. O setup segue sem pedir nada nesse caso — gerar um segredo
#      pendente não liga nada.


def _2fa_ativo(user: models.User) -> bool:
    """Mesma régua do login: só conta como ligado com segredo gravado."""
    return bool(getattr(user, "totp_enabled", 0) and user.totp_secret)


def _codigo_confere(segredo: Optional[str], codigo: Optional[str]) -> bool:
    import pyotp
    if not segredo or not codigo:
        return False
    return pyotp.TOTP(segredo).verify(str(codigo).strip(), valid_window=1)


def _limitar_2fa(request: Request, user: models.User):
    """O mesmo balde do login (ver `login`): 6 conferências por conta em 5 min."""
    limitar(request, "2fa", limite=6, janela_seg=300, extra=str(user.id))


@router.post("/2fa/setup")
def twofa_setup(
    request: Request,
    payload: Optional[schemas.TwoFASetup] = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Gera um segredo NOVO, guarda como pendente e devolve o otpauth URI.

    Primeira ativação: não pede nada aqui — o segredo nasce pendente e não liga
    nada; a senha é exigida no /2fa/enable. Com o 2FA ligado: exige
    `senha_atual` + `code` do app atual — ver o bloco acima. O segredo em uso
    NÃO é tocado aqui.
    """
    import pyotp
    if _2fa_ativo(current_user):
        senha = (payload.senha_atual if payload else None) or ""
        codigo = (payload.code if payload else None) or ""
        if not senha or not codigo:
            raise HTTPException(
                status_code=409,
                detail=(
                    "O 2FA já está ativo. Para trocar de aparelho, informe a senha "
                    "atual e um código do app autenticador atual."
                ),
            )
        _limitar_2fa(request, current_user)
        # As duas conferências SEMPRE rodam e a resposta é uma só: dizer qual
        # das duas errou deixaria testar a senha separada do código.
        senha_ok = verify_password(senha, current_user.password_hash)
        codigo_ok = _codigo_confere(current_user.totp_secret, codigo)
        if not (senha_ok and codigo_ok):
            raise HTTPException(status_code=400, detail="Senha atual ou código do app inválidos.")

    secret = pyotp.random_base32()
    current_user.totp_pending_secret = secret
    db.commit()
    uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=current_user.email, issuer_name=marca.obter().emissor_2fa
    )
    return {"secret": secret, "otpauth_uri": uri}


@router.post("/2fa/enable")
def twofa_enable(
    request: Request,
    payload: schemas.TwoFAEnable,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Confirma o segredo PENDENTE com um código dele e o torna o segredo do 2FA.

    Vale para a primeira ativação e para a troca de aparelho. É só aqui que o
    segredo antigo deixa de valer.

    Primeira ativação: exige também `senha_atual` (regra 5 do bloco acima). Na
    troca de aparelho, não: com o 2FA ligado o pendente só nasce depois de o
    /2fa/setup conferir senha + código atual.
    """
    pendente = current_user.totp_pending_secret
    if not pendente:
        raise HTTPException(status_code=400, detail="Inicie a configuração do 2FA primeiro")
    if not _2fa_ativo(current_user):
        if not payload.senha_atual:
            raise HTTPException(status_code=400, detail="Para ativar o 2FA, informe a sua senha atual.")
        _limitar_senha(request, current_user)
        if not verify_password(payload.senha_atual, current_user.password_hash):
            raise HTTPException(status_code=400, detail="Senha atual incorreta.")
    # Balde próprio, separado do "2fa" do login: um pendente abandonado (troca
    # iniciada e não concluída) não pode virar chute ilimitado de 6 dígitos —
    # promovê-lo às cegas trancaria o dono fora.
    limitar(request, "2fa-confirmar", limite=10, janela_seg=300, extra=str(current_user.id))
    if not _codigo_confere(pendente, payload.code):
        raise HTTPException(status_code=400, detail="Código inválido")
    current_user.totp_secret = pendente
    current_user.totp_pending_secret = None
    current_user.totp_enabled = 1
    db.commit()
    return {"ok": True, "enabled": True}


@router.post("/2fa/disable")
def twofa_disable(
    request: Request,
    payload: schemas.TwoFACode,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Desativa o 2FA (exige um código válido se estiver ativo)."""
    if _2fa_ativo(current_user):
        _limitar_2fa(request, current_user)
        if not _codigo_confere(current_user.totp_secret, payload.code):
            raise HTTPException(status_code=400, detail="Código inválido")
    current_user.totp_enabled = 0
    current_user.totp_secret = None
    current_user.totp_pending_secret = None
    db.commit()
    return {"ok": True, "enabled": False}


# ------------------- Gestão de usuários (somente admin) -------------------
def _require_admin(current_user: models.User):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Apenas administradores")


@router.get("/users", response_model=List[schemas.UserOut])
def list_users(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lista todos os usuários (apenas admin)."""
    _require_admin(current_user)
    return db.query(models.User).order_by(models.User.name).all()


@router.put("/users/{user_id}", response_model=schemas.UserOut)
def update_user(
    user_id: int,
    payload: schemas.UserAdminUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Atualiza nome/papel e, opcionalmente, redefine a senha (apenas admin)."""
    _require_admin(current_user)
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")
    if payload.name is not None:
        user.name = payload.name
    # Mudança de papel, senha ou permissões altera o que a sessão pode fazer:
    # os tokens antigos precisam morrer, senão o rebaixamento (ou a demissão)
    # só vale daqui a 8 horas.
    if payload.role is not None and payload.role != user.role:
        user.role = payload.role
        _revogar_sessoes(user)
    if payload.password:
        user.password_hash = hash_password(payload.password)
        _revogar_sessoes(user)
    if payload.permissions is not None:
        _revogar_sessoes(user)
    if payload.permissions is not None:
        # normalizar_permissoes devolve None quando equivale a acesso total.
        user.permissions = normalizar_permissoes(payload.permissions, user.role)
    elif payload.role is not None:
        # Trocou o papel sem mandar permissões: reaplica as regras do novo
        # perfil (preset do estagiário / remoção dos módulos bloqueados).
        user.permissions = normalizar_permissoes(get_perms(user) or None, user.role)
    db.commit()
    db.refresh(user)
    return user


@router.get("/permissoes/catalogo")
def catalogo_permissoes(current_user: models.User = Depends(get_current_user)):
    """Catálogo de módulos e sub-recursos para montar a tela de permissões."""
    _require_admin(current_user)
    return {
        "roles": [{"key": k, "label": v} for k, v in ROLES.items()],
        "modules": [{"key": k, "label": v} for k, v in MODULOS.items()],
        "precatorios_classificacoes": [
            {"key": k, "label": v} for k, v in PREC_CLASSIFICACOES.items()
        ],
        "acoes_areas": [{"key": k, "label": v} for k, v in ACAO_AREAS.items()],
    }


# Colunas que são SÓ autoria — "quem registrou", não "de quem é". Não travam a
# exclusão do usuário: o registro fica (é histórico do cliente/processo) e
# perde apenas o nome do autor. Sem isto, a estagiária que registrou um único
# atendimento nunca mais podia ser excluída (409), e não há tela para
# "transferir autoria". `owner_id`, `created_by`, `parceiro_id` etc. continuam
# travando: ali o usuário é dono/parte de dinheiro, e isso pede decisão.
_SO_AUTORIA = (
    (models.Atendimento, "autor_id"),
    (models.ProcessoAndamento, "autor_id"),
)


def _vinculos_do_usuario(db: Session, user_id: int) -> dict:
    """Conta, por tabela, os registros que apontam para este usuário.

    Varre os modelos por INTROSPECÇÃO, não por lista fixa. Lista escrita à mão
    envelhece: bastaria um modelo novo com `owner_id` para ele ficar de fora e
    a exclusão voltar a estourar 500 sem explicação — que é exatamente o bug
    que esta função existe para acabar. Aqui, modelo novo entra sozinho.
    As colunas de `_SO_AUTORIA` ficam de fora (são anuladas na exclusão).
    """
    ignorar = {(cls.__tablename__, coluna) for cls, coluna in _SO_AUTORIA}
    achados: dict = {}
    for mapper in models.Base.registry.mappers:
        cls = mapper.class_
        if cls is models.User:
            continue
        for col in mapper.columns:
            aponta = any(fk.column.table.name == "users" for fk in col.foreign_keys)
            if not aponta or (col.table.name, col.name) in ignorar:
                continue
            try:
                n = db.query(cls).filter(col == user_id).count()
            except Exception:
                continue          # tabela ainda não migrada: não trava a rota
            if n:
                nome = getattr(cls, "__tablename__", cls.__name__)
                achados[nome] = achados.get(nome, 0) + n
    return achados


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Remove um usuário (apenas admin). Não permite excluir a si mesmo.

    🚨 15 colunas apontam para users.id e NENHUMA tem cascata. Antes, excluir
    quem já foi dono de qualquer registro estourava ForeignKeyViolation no
    commit, virava 500, e o frontend engolia sem mensagem: para o admin a
    exclusão simplesmente "não acontecia", sem explicação. O conserto não é
    apagar em cascata — os registros são de CLIENTES, não do funcionário, e
    sumir com eles seria muito pior. É dizer o que está travando.
    """
    _require_admin(current_user)
    if current_user.id == user_id:
        raise HTTPException(status_code=400, detail="Você não pode excluir o próprio usuário")
    user = db.query(models.User).get(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    vinculos = _vinculos_do_usuario(db, user_id)
    if vinculos:
        resumo = ", ".join(f"{n} em {t}" for t, n in sorted(vinculos.items()))
        raise HTTPException(
            status_code=409,
            detail=(
                f"Não dá para excluir {user.name}: há registros vinculados a "
                f"esta pessoa ({resumo}). Transfira ou libere esses registros "
                f"antes — em Precatórios e Ações dá para devolver à fila pela "
                f"própria tela. Se a intenção é só tirar o acesso, mude o "
                f"papel/permissões em vez de excluir: assim o histórico "
                f"continua atribuído a quem de fato trabalhou nele."
            ),
        )

    # Só depois de passar pela trava acima, e no mesmo commit do DELETE: se
    # algo bloquear, nenhuma autoria é perdida à toa.
    for cls, coluna in _SO_AUTORIA:
        db.query(cls).filter(getattr(cls, coluna) == user_id).update(
            {getattr(cls, coluna): None}, synchronize_session=False)
    db.delete(user)
    db.commit()
    return {"ok": True}
