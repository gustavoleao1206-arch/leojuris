"""Módulo de Inteligência Artificial (Google Gemini).

Usa apenas a biblioteca padrão (urllib) — sem dependências extras. A chave de
API NUNCA fica no código: é lida de GEMINI_API_KEY (variável de ambiente do
Render). A chave do Gemini é gratuita (aistudio.google.com, sem cartão).
O modelo é configurável por GEMINI_MODEL.

Recursos:
- extrair_documento(): lê um PDF/imagem (inclusive escaneado) e devolve os dados
  estruturados (cliente, processo, ação, precatório) sugeridos pela IA.
- assistente(): responde perguntas em linguagem natural sobre o CRM, recebendo
  um "retrato" (snapshot) dos dados como contexto.
"""
import json
import re
import urllib.error
import urllib.request

from . import config


class IAError(Exception):
    pass


# 🚨 LGPD — chaves que NÃO podem sair do escritório para a IA (Google, EUA).
# O resumo de importação de precatórios (routers/precatorios.py) manda só
# AGREGADOS — contagens e somas, nunca o registro da pessoa. `conferir_sem_pii`
# é a TRAVA que impede uma edição futura de reabrir aquela porta: antes, o laço
# despejava nome completo e CPF de até 200 titulares no contexto enviado ao
# Gemini a cada importação (achado crítico da auditoria de ago/2026).
_CHAVES_PESSOAIS = {
    "nome", "name", "cpf", "cpf_cnpj", "rg", "email", "telefone", "phone",
    "celular", "endereco", "endereço", "nome_mae", "nascimento",
    "requerente_nome", "requerente_cpf", "requerente_rg", "requerente_telefone",
    "requerente_email", "requerente_endereco", "parte_nome", "parte_cpf",
    "registros",  # a antiga lista de registros por pessoa
}


def conferir_sem_pii(dados) -> None:
    """Levanta IAError se `dados` contiver, em qualquer nível, chave de dado
    pessoal. Usada pelos caminhos que DEVEM enviar apenas agregado à IA."""
    pilha = [dados]
    while pilha:
        atual = pilha.pop()
        if isinstance(atual, dict):
            for k, v in atual.items():
                if isinstance(k, str) and k.strip().lower() in _CHAVES_PESSOAIS:
                    raise IAError(
                        f"Bloqueado por LGPD: '{k}' é dado pessoal e não pode ir para a IA."
                    )
                pilha.append(v)
        elif isinstance(atual, (list, tuple)):
            pilha.extend(atual)


def ia_configurada() -> bool:
    return bool(config.GEMINI_API_KEY)


def _gerar(parts: list, system: str = "", json_mode: bool = False,
           max_tokens: int = 2000, timeout: int = 120) -> str:
    """Chama o endpoint generateContent do Gemini e devolve o texto da resposta."""
    if not config.GEMINI_API_KEY:
        raise IAError(
            "IA não configurada. Defina GEMINI_API_KEY nas variáveis de ambiente."
        )
    url = (config.GEMINI_BASE.rstrip("/") +
           f"/v1beta/models/{config.GEMINI_MODEL}:generateContent")
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
    }
    if system:
        body["system_instruction"] = {"parts": [{"text": system}]}
    if json_mode:
        body["generationConfig"]["response_mime_type"] = "application/json"

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-goog-api-key", config.GEMINI_API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detalhe = None
        try:
            err = json.loads(e.read().decode("utf-8"))
            detalhe = (err.get("error") or {}).get("message")
        except Exception:
            detalhe = None
        raise IAError(detalhe or f"Erro HTTP {e.code} ao chamar a IA.")
    except urllib.error.URLError as e:
        raise IAError(f"Falha de conexão com a IA: {e.reason}")

    try:
        parsed = json.loads(raw) if raw else {}
        cands = parsed.get("candidates") or []
        if not cands:
            # Pode ter sido bloqueado por filtros de segurança
            fb = parsed.get("promptFeedback") or {}
            if fb.get("blockReason"):
                raise IAError(f"A IA bloqueou o conteúdo ({fb['blockReason']}).")
            return ""
        partes = (cands[0].get("content") or {}).get("parts") or []
        return "".join(p.get("text", "") for p in partes).strip()
    except IAError:
        raise
    except Exception:
        raise IAError("Resposta inesperada da IA.")


def _extrair_json(texto: str) -> dict:
    """Extrai o primeiro objeto JSON de um texto (caso venha com comentários)."""
    if not texto:
        return {}
    try:
        return json.loads(texto)
    except Exception:
        pass
    m = re.search(r"\{.*\}", texto, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return {}


# ----------------------- Importação inteligente -----------------------
_PROMPT_EXTRACAO = """Você é um assistente jurídico de um escritório de advocacia brasileiro.
Analise o documento anexado (petição, contrato, procuração, documento pessoal,
precatório, planilha ou similar) e EXTRAIA os dados que conseguir identificar.

Responda APENAS com um objeto JSON válido (sem texto antes ou depois), no formato:
{
  "tipo_documento": "peticao | contrato | procuracao | documento_pessoal | precatorio | outro",
  "resumo": "uma frase curta descrevendo o documento",
  "cliente": {
    "name": "", "cpf_cnpj": "", "rg": "", "orgao_expedidor": "",
    "data_nascimento": "AAAA-MM-DD", "sexo": "", "estado_civil": "",
    "nacionalidade": "", "profissao": "", "email": "", "celular": "",
    "cep": "", "estado": "", "cidade": "", "bairro": "", "rua": "",
    "numero": "", "complemento": ""
  },
  "processo": {
    "case_number": "", "type": "civel|trabalhista|previdenciario|familia|consumidor|outros",
    "subcategoria": "", "classe": "", "assunto": "", "foro": "", "vara": "",
    "tribunal": "", "orgao_julgador": "", "data_distribuicao": "AAAA-MM-DD",
    "fase_processual": "", "valor_causa": 0
  },
  "precatorio": {
    "numero_precatorio": "", "numero_originario": "", "tribunal": "",
    "vara": "", "classe": "", "assunto": "", "valor_caso": 0
  },
  "acao": {
    "area": "", "numero_processo": "", "comarca": "", "vara": "",
    "classe": "", "assunto": "", "valor_causa": 0
  }
}

Regras importantes:
- Use string vazia "" quando não encontrar o dado. NÃO invente informações.
- Preencha apenas as seções pertinentes ao tipo do documento (pode deixar as outras com campos vazios).
- Datas sempre no formato AAAA-MM-DD. Valores monetários como número (ex.: 15000.50).
- O CPF/CNPJ deve manter apenas o formato encontrado no documento.
"""


def extrair_documento(file_bytes: bytes, media_type: str, filename: str = "") -> dict:
    """Envia o arquivo (PDF ou imagem) para o Gemini e devolve o JSON extraído."""
    import base64 as _b64
    b64 = _b64.b64encode(file_bytes).decode("ascii")

    if media_type not in ("application/pdf", "image/jpeg", "image/png",
                          "image/gif", "image/webp"):
        raise IAError("Formato não suportado. Envie PDF, JPG ou PNG.")

    parts = [
        {"inline_data": {"mime_type": media_type, "data": b64}},
        {"text": _PROMPT_EXTRACAO},
    ]
    texto = _gerar(parts, json_mode=True, max_tokens=2000)
    dados = _extrair_json(texto)
    if not dados:
        raise IAError("A IA não conseguiu extrair dados estruturados do documento.")
    return dados


# ----------------------- Assistente jurídico -----------------------
_SYSTEM_ASSISTENTE = (
    "Você é o assistente jurídico interno de um escritório de advocacia. "
    "Responda em português do Brasil, de forma objetiva, usando SOMENTE os dados "
    "do CRM fornecidos. Se a informação não estiver nos dados, diga claramente "
    "que ela não está disponível no sistema."
)


def assistente(pergunta: str, contexto: dict) -> str:
    """Responde uma pergunta em linguagem natural usando o snapshot do CRM."""
    texto = (
        "DADOS DO CRM (contexto em JSON):\n"
        + json.dumps(contexto, ensure_ascii=False, default=str)
        + "\n\nPERGUNTA DO USUÁRIO:\n" + pergunta
    )
    parts = [{"text": texto}]
    out = _gerar(parts, system=_SYSTEM_ASSISTENTE, max_tokens=1500)
    return out or "Não consegui gerar uma resposta."
