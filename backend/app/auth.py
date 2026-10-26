"""Autenticação e segurança: hashing de senhas e tokens JWT."""
from datetime import datetime, timedelta
from typing import Optional

import jwt                     # PyJWT
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from passlib.context import CryptContext
from sqlalchemy.orm import Session

# ⚠️ Trocamos python-jose por PyJWT (ago/2026).
# python-jose 3.3.0 carrega CVE-2024-33663 (confusão de algoritmo) e
# CVE-2024-33664 (DoS por JWE comprimido), e está praticamente sem manutenção.
# Como esta é a biblioteca que assina e valida TODO login do sistema, manter
# uma dependência abandonada aqui é risco desnecessário. A API é equivalente;
# a exceção base passou de JWTError para jwt.PyJWTError.

from .config import SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES
from .database import get_db
from . import models

# Contexto de hashing de senhas (bcrypt)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Esquema OAuth2: o token é enviado no header Authorization: Bearer <token>
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Gera um JWT assinado com o subject (id do usuário)."""
    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    """Dependência que valida o JWT e retorna o usuário autenticado."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Não foi possível validar as credenciais",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        # Um token antigo (ou adulterado) pode trazer no "sub" algo que não é o
        # ID numérico. Isso é credencial inválida (401) e não erro do servidor:
        # sem esta conversão dentro do try, o int() estourava ValueError -> 500,
        # e o frontend, que só desloga no 401, deixava o usuário travado.
        user_id = int(user_id)
    # RecursionError: o PyJWT até a 2.13.0 estourava com cabeçalho de token em
    # JSON aninhado fundo demais, e qualquer anônimo arrancava um 500 de qualquer
    # rota protegida. A lib já foi atualizada; isto fica como segunda camada.
    except (jwt.PyJWTError, ValueError, TypeError, RecursionError):
        raise credentials_exception

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise credentials_exception

    # Revogação de sessão.
    #
    # Antes, o token só era checado por assinatura e validade: trocar a senha,
    # rebaixar o papel ou demitir alguém deixava o token dele funcionando por
    # até 8 horas. Agora o token carrega a "versão" da conta e qualquer
    # incremento (troca de senha, mudança de papel, revogação manual) derruba
    # todas as sessões existentes daquele usuário.
    #
    # Token antigo, emitido antes desta mudança, não tem o campo `tv`: tratamos
    # a ausência como 0, que é o valor inicial da coluna. Assim ninguém é
    # deslogado pelo deploy — a trava passa a valer da próxima emissão em
    # diante, sem transtorno para quem está trabalhando.
    if int(payload.get("tv", 0) or 0) != int(getattr(user, "token_version", 0) or 0):
        raise credentials_exception
    return user
