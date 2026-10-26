"""Cliente da API v3 (Envelope) do Clicksign — envio de documentos para
assinatura digital. Usa apenas a biblioteca padrão (urllib), sem dependências.

O token é lido da variável de ambiente CLICKSIGN_ACCESS_TOKEN (nunca fica no
código). O host padrão é o de produção; defina CLICKSIGN_API_URL para usar o
sandbox (https://sandbox.clicksign.com).
"""
import base64
import json
import os
import re
import urllib.error
import urllib.request

# Mapeia o status do envelope no Clicksign para o status interno da Assinatura
STATUS_MAP = {
    "running": "enviado",
    "finished": "assinado",
    "closed": "assinado",
    "canceled": "recusado",
    "cancelled": "recusado",
    "expired": "expirado",
}


class ClicksignError(Exception):
    pass


def configurado() -> bool:
    return bool(os.environ.get("CLICKSIGN_ACCESS_TOKEN"))


def _base() -> str:
    return os.environ.get("CLICKSIGN_API_URL", "https://app.clicksign.com").rstrip("/")


def _req(method: str, path: str, body=None, label: str = "", timeout: int = 90):
    token = os.environ.get("CLICKSIGN_ACCESS_TOKEN")
    if not token:
        raise ClicksignError(
            "Integração Clicksign não configurada. Defina CLICKSIGN_ACCESS_TOKEN."
        )
    url = _base() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", token)
    req.add_header("Content-Type", "application/vnd.api+json")
    req.add_header("Accept", "application/vnd.api+json")
    pref = f"[{label}] " if label else ""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detalhe = None
        try:
            err = json.loads(e.read().decode("utf-8"))
            primeiro = (err.get("errors") or [{}])[0]
            detalhe = primeiro.get("detail") or primeiro.get("title")
        except Exception:
            detalhe = None
        raise ClicksignError(pref + (detalhe or f"Erro na API do Clicksign (HTTP {e.code})."))
    except Exception as e:
        raise ClicksignError(pref + f"Falha de conexão com o Clicksign: {e}")


def _fmt_cpf(cpf):
    if not cpf:
        return None
    nums = re.sub(r"\D", "", str(cpf))
    if len(nums) != 11:
        return None
    return f"{nums[0:3]}.{nums[3:6]}.{nums[6:9]}-{nums[9:11]}"


def enviar_para_assinatura(nome, email, cpf, pdf_bytes, filename, titulo) -> str:
    """Executa o fluxo completo da API v3 e retorna o ID do envelope (ativado)."""
    if not nome or len(str(nome).split()) < 2:
        raise ClicksignError("O signatário precisa ter nome completo (nome e sobrenome).")
    if not email:
        raise ClicksignError("Informe um e-mail para o signatário receber o documento.")

    # 1) Cria o envelope (rascunho)
    env = _req("POST", "/api/v3/envelopes", {
        "data": {"type": "envelopes", "attributes": {
            "name": titulo, "locale": "pt-BR", "auto_close": True,
        }},
    }, label="envelope")
    env_id = env["data"]["id"]

    # 2) Adiciona o documento (PDF em base64, formato data URI)
    content = "data:application/pdf;base64," + base64.b64encode(pdf_bytes).decode("ascii")
    doc = _req("POST", f"/api/v3/envelopes/{env_id}/documents", {
        "data": {"type": "documents", "attributes": {
            "filename": filename, "content_base64": content,
        }},
    }, label="documento")
    doc_id = doc["data"]["id"]

    # 3) Cadastra o signatário
    attrs = {
        "name": nome, "email": email,
        "communicate_events": {
            "signature_request": "email", "signature_reminder": "email",
            "document_signed": "email",
        },
    }
    cpf_fmt = _fmt_cpf(cpf)
    if cpf_fmt:
        attrs["has_documentation"] = True
        attrs["documentation"] = cpf_fmt
    else:
        attrs["has_documentation"] = False
    signer = _req("POST", f"/api/v3/envelopes/{env_id}/signers",
                  {"data": {"type": "signers", "attributes": attrs}}, label="signatario")
    signer_id = signer["data"]["id"]

    rel = {
        "document": {"data": {"type": "documents", "id": doc_id}},
        "signer": {"data": {"type": "signers", "id": signer_id}},
    }
    # 4) Requisito de autenticação (token por e-mail)
    _req("POST", f"/api/v3/envelopes/{env_id}/requirements", {
        "data": {"type": "requirements",
                 "attributes": {"action": "provide_evidence", "auth": "email"},
                 "relationships": rel},
    }, label="req-auth")
    # 5) Requisito de qualificação (assinar)
    _req("POST", f"/api/v3/envelopes/{env_id}/requirements", {
        "data": {"type": "requirements",
                 "attributes": {"action": "agree", "role": "sign"},
                 "relationships": rel},
    }, label="req-qualificacao")
    # 6) Ativa o envelope
    _req("PATCH", f"/api/v3/envelopes/{env_id}", {
        "data": {"id": env_id, "type": "envelopes", "attributes": {"status": "running"}},
    }, label="ativacao", timeout=120)

    # 7) Notifica os signatários (garante o envio do e-mail de solicitação)
    try:
        notificar(env_id)
    except ClicksignError:
        # Envelope já está ativo; a notificação pode ser reenviada manualmente depois.
        pass
    return env_id


MENSAGEM_PADRAO = (
    "Você recebeu um documento para assinatura digital do escritório "
    "LeoJuris. Clique no botão para assinar."
)


def notificar(env_id: str, mensagem: str = None):
    """Dispara (ou reenvia) o e-mail de solicitação de assinatura aos signatários."""
    return _req("POST", f"/api/v3/envelopes/{env_id}/notifications", {
        "data": {"type": "notifications",
                 "attributes": {"message": mensagem or MENSAGEM_PADRAO}},
    }, label="notificacao", timeout=60)


def status_interno(env_id: str):
    """Consulta o envelope e devolve o status interno correspondente (ou None)."""
    data = _req("GET", f"/api/v3/envelopes/{env_id}")
    ck = (data.get("data") or {}).get("attributes", {}).get("status")
    return STATUS_MAP.get(ck)
