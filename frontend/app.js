/* =========================================================
   CRM Jurídico — Frontend (vanilla JS + Bootstrap)
   Comunica-se com a API FastAPI usando token JWT.
   ========================================================= */

const API = ""; // mesma origem do backend
let TOKEN = null;
let CURRENT_USER = null;
let CACHE = { clients: [], processes: [] }; // usado em selects de formulários

/* =========================================================
   Permissões granulares (espelham o backend em scope.py)
   - CURRENT_USER.permissions == null  -> acesso total
   - admin                             -> acesso total, sempre
   Estas funções servem APENAS para esconder o que o usuário não pode usar.
   O bloqueio de verdade é feito no backend; aqui é só experiência de uso.
   ========================================================= */
const PERM_MODULES = [
  "clients", "processes", "deadlines", "appointments", "documents",
  "financeiro", "precatorios", "funilprec", "acoes", "assinaturas",
];

function _perms() {
  return (CURRENT_USER && CURRENT_USER.permissions) || null;
}
function permIsAdmin() {
  return !!(CURRENT_USER && CURRENT_USER.role === "admin");
}
function permIsEstagiario() {
  return !!(CURRENT_USER && CURRENT_USER.role === "estagiario");
}
/** Módulos que o estagiário nunca acessa (espelha ESTAGIARIO_BLOQUEADOS do scope.py). */
const ESTAGIARIO_BLOQUEADOS = ["financeiro"];
/** O estagiário nunca exclui nada (espelha require_excluir do scope.py). */
function permPodeExcluir() {
  return !permIsEstagiario();
}
function permCanView(mod) {
  // Bloqueio fixo do perfil vem antes de tudo, inclusive do "acesso total".
  if (permIsEstagiario() && ESTAGIARIO_BLOQUEADOS.includes(mod)) return false;
  if (permIsAdmin()) return true;
  const p = _perms();
  if (!p || !p.modules) return true;           // nada configurado = tudo liberado
  const m = p.modules[mod];
  return !!(m && m.view);
}
function permCanEdit(mod) {
  if (permIsEstagiario() && ESTAGIARIO_BLOQUEADOS.includes(mod)) return false;
  if (permIsAdmin()) return true;
  const p = _perms();
  if (!p || !p.modules) return true;
  const m = p.modules[mod];
  return !!(m && m.view && m.edit);
}
/** Classificações de precatório permitidas, ou null quando são todas. */
function permClassificacoes() {
  if (permIsAdmin()) return null;
  const p = _perms();
  const lista = p && p.precatorios_classificacoes;
  return lista && lista.length ? lista : null;
}
/** Áreas de ação permitidas, ou null quando são todas. */
function permAreas() {
  if (permIsAdmin()) return null;
  const p = _perms();
  const lista = p && p.acoes_areas;
  return lista && lista.length ? lista : null;
}

/* ---------------- Helpers de API ---------------- */
async function api(path, options = {}) {
  const headers = options.headers || {};
  const sessao = TOKEN;
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(API + path, { ...options, headers });
  // A sessão mudou enquanto a resposta viajava (Sair, ou Sair + login de
  // outra pessoa): a resposta é da sessão ANTERIOR e não pode ser usada —
  // ela encheria o CACHE dos selects ou uma tela do próximo usuário com os
  // dados do anterior, e um 401 atrasado derrubaria a sessão nova.
  if (TOKEN !== sessao) {
    const err = new Error("Sessão encerrada");
    err.status = 0;
    err.sessaoTrocada = true;
    throw err;
  }
  if (res.status === 401) {
    // Sessão caiu: sai SEM a pergunta de "Descartar alterações?" da ficha.
    // Não há o que salvar — o token já não vale, qualquer gravação daria 401
    // de novo — e a pergunta só travaria a pessoa numa tela morta.
    if (typeof fichaMarcarSujo === "function") fichaMarcarSujo(false);
    logout();
    throw new Error("Sessão expirada");
  }
  if (!res.ok) {
    let msg = "Erro na requisição";
    let detail = null;
    try { detail = (await res.json()).detail; } catch (e) {}
    // 400/403/404/409 trazem `detail` em texto pronto para mostrar. O 422 de
    // validação do Pydantic traz uma LISTA de objetos — usada direto, virava
    // "[object Object]" no toast. Junta as mensagens, sem o "Value error, "
    // que o Pydantic põe na frente das validações nossas (listas fechadas).
    if (typeof detail === "string" && detail.trim()) msg = detail;
    else if (Array.isArray(detail)) {
      const partes = detail
        .map((d) => {
          if (!d || typeof d !== "object") return d;
          const campo = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : "";
          const rotulo = _apiRotuloCampo(campo);
          // O "Field required" nativo do Pydantic vem em inglês e sem dizer
          // qual campo: vira "Campo obrigatório: <campo>".
          if (d.type === "missing") return "Campo obrigatório" + (rotulo ? ": " + rotulo : "");
          if (d.msg === null || d.msg === undefined || !String(d.msg).trim()) return null;
          // "Use no máximo 80 caracteres." não diz QUAL campo — o nome vem no
          // `loc`: vira "Complemento: use no máximo 80 caracteres."
          const msg = String(d.msg).replace(/^Value error,\s*/i, "");
          if (!rotulo || msg.toLowerCase().startsWith(rotulo.toLowerCase())) return msg;
          return rotulo + ": " + msg.charAt(0).toLowerCase() + msg.slice(1);
        })
        .filter((m) => m !== null && m !== undefined && String(m).trim())
        .map((m) => String(m).replace(/^Value error,\s*/i, ""));
      // "Bairro: use no máximo 80 caracteres; Complemento: use no máximo 80 caracteres."
      if (partes.length) msg = [...new Set(partes.map((m) => m.replace(/\.\s*$/, "")))].join("; ") + ".";
    } else if (detail && typeof detail === "object" && detail.msg) msg = String(detail.msg);
    // `status` deixa a ficha distinguir 404/403 ("registro não encontrado ou
    // sem acesso", com caminho de volta) de falha de servidor; `detail` cru
    // fica para quem precisar do campo (`loc`) do 422.
    const err = new Error(msg);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}

/** Nome de campo da API (último item do `loc` do 422) → rótulo da tela.
 *  Campo fora do mapa: o próprio nome, com espaço no lugar do "_". */
const API_ROTULOS_CAMPO = {
  name: "Nome", nome: "Nome", nome_fantasia: "Nome fantasia", cpf_cnpj: "CPF/CNPJ", cpf: "CPF",
  email: "E-mail", notes: "Observações", observacoes: "Observações", description: "Descrição",
  descricao: "Descrição", rg: "RG", orgao_expedidor: "Órgão expedidor", nacionalidade: "Nacionalidade",
  profissao: "Profissão", pis_pasep: "PIS/PASEP", ctps: "CTPS", celular: "Celular", phone: "Telefone",
  telefone: "Telefone", telefone_secundario: "Telefone secundário", whatsapp: "WhatsApp", cep: "CEP",
  estado: "UF", cidade: "Cidade", bairro: "Bairro", rua: "Rua", numero: "Número",
  complemento: "Complemento", indicado_por: "Indicado por", case_number: "Número do processo",
  subcategoria: "Subcategoria", classe: "Classe", assunto: "Assunto", foro: "Foro/comarca", vara: "Vara",
  tribunal: "Tribunal", orgao_julgador: "Órgão julgador", fase_processual: "Fase processual",
  sistema_eletronico: "Sistema processual", location: "Local", titulo: "Título", advogado: "Advogado",
  oab: "OAB", papel: "Papel", resumo: "Resumo", detalhe: "Detalhe", parte_nome: "Nome da parte",
  requerente_nome: "Nome do requerente", numero_processo: "Número do processo", anotacoes: "Anotações",
  client_id: "Cliente", process_id: "Processo", date: "Data", date_time: "Data e hora",
  urgency_level: "Urgência", total_value: "Valor total", paid_value: "Valor pago", due_date: "Vencimento",
  valor_causa: "Valor da causa", data: "Data", tipo: "Tipo", status: "Status",
};
function _apiRotuloCampo(campo) {
  if (typeof campo !== "string" || !campo || campo === "body") return "";
  if (Object.prototype.hasOwnProperty.call(API_ROTULOS_CAMPO, campo)) return API_ROTULOS_CAMPO[campo];
  const t = campo.replace(/_/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

function toast(message, isError = false) {
  const el = document.getElementById("toast");
  document.getElementById("toast-body").textContent = message;
  el.className = "toast align-items-center text-white border-0 " +
    (isError ? "bg-danger" : "bg-success");
  new bootstrap.Toast(el, { delay: 3000 }).show();
}

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * Valor de usuário que vai para DENTRO de uma string JavaScript.
 *
 * ⚠️ HISTÓRICO — a lição vale mesmo com o código atual não dependendo mais
 * disto. Havia um XSS armazenado real quando o valor ia para dentro de um
 * `onclick=`: esc() transforma `'` em `&#39;`, mas o navegador
 * HTML-decodifica o atributo ANTES de entregar ao interpretador JS, o `'`
 * volta e fecha a string. Um documento chamado  x');alert(1);//  executava na
 * sessão de quem abrisse o registro.
 *
 * A ordem correta é a inversa da intuição:
 *   1. JSON.stringify() monta um literal JS já escapado (com as aspas).
 *   2. esc() protege esse literal na viagem pelo atributo HTML.
 * O retorno JÁ INCLUI as aspas — use SEM envolver em aspas.
 *
 * 🔸 Hoje os handlers usam delegação (data-on-* + escArgs), então NÃO há mais
 * código JS dentro de atributo e esta função ficou sem chamadas. Mantida
 * porque continua sendo a primitiva correta caso algum dia um valor precise
 * ir para um contexto JS-em-atributo — e porque o raciocínio acima é fácil de
 * errar de novo.
 */
function escJs(v) {
  return esc(JSON.stringify(v === null || v === undefined ? "" : String(v)));
}

/**
 * Argumentos de uma ação, prontos para o atributo data-args.
 *
 * Serializa a lista inteira em JSON e escapa de uma vez. Duas vantagens sobre
 * montar o JSON à mão no template:
 *   - preserva o TIPO (número continua número, null continua null);
 *   - impossível uma aspa do dado quebrar o atributo — é o mesmo raciocínio
 *     do escJs, aplicado à lista.
 *
 *   <button data-on-click="downloadDoc" data-args="${escArgs(d.id, d.nome)}">
 */
function escArgs(...args) {
  return esc(JSON.stringify(args));
}

/* =========================================================
   DELEGAÇÃO DE EVENTOS — substitui os handlers inline (onclick=...)
   =========================================================

   POR QUE ISTO EXISTE
   Enquanto houvesse `onclick=` no HTML, a CSP precisava de
   `script-src 'unsafe-inline'` — e com essa diretiva a CSP NÃO impede um
   <script> injetado de rodar. Ou seja: ela continha um XSS (bloqueando a
   exfiltração via connect-src) mas não o prevenia. Tirar os handlers inline
   é o que permite remover o 'unsafe-inline' e fechar a porta de vez.

   COMO USAR
     <button data-on-click="salvarCliente" data-args="[12]">
     <input  data-on-change="filtrarLista">
   O elemento declara a AÇÃO pelo nome e os ARGUMENTOS em JSON. A função é
   chamada com `this` = o elemento e os argumentos desempacotados:
       fn.apply(elemento, argumentos)
   Assim as funções existentes mantiveram a assinatura — nada de `fn(ev, ...)`.

   Atributos auxiliares (evitam código solto no HTML):
     data-stop="1"     -> event.stopPropagation() antes de chamar
     data-prevent="1"  -> event.preventDefault() antes de chamar

   ⚠️ SÓ FUNÇÃO REGISTRADA EM `ACOES` PODE SER CHAMADA.
   A alternativa óbvia — procurar em `window[nome]` — seria um buraco de
   segurança: bastaria injetar <button data-on-click="eval" data-args='["..."]'>
   para executar qualquer coisa com um clique. O registro é uma allowlist.

   ⚠️ AÇÃO NOVA PRECISA SER REGISTRADA (ver registrarAcoes no fim do arquivo).
   Se não estiver, o clique não faz nada e o console avisa.
   ========================================================= */
const ACOES = Object.create(null);

function registrarAcoes(mapa) {
  for (const [nome, fn] of Object.entries(mapa)) {
    if (typeof fn === "function") ACOES[nome] = fn;
  }
}

function _executarAcao(ev, el, nome) {
  const fn = ACOES[nome];
  if (!fn) {
    console.warn("[acoes] ação não registrada:", nome, el);
    return;
  }
  if (el.dataset.stop === "1") ev.stopPropagation();
  if (el.dataset.prevent === "1") ev.preventDefault();
  let args = [];
  const bruto = el.getAttribute("data-args");
  if (bruto) {
    try { args = JSON.parse(bruto); } catch (e) {
      console.warn("[acoes] data-args inválido em", nome, bruto);
      return;
    }
    if (!Array.isArray(args)) args = [args];
  }
  // Alguns handlers precisam do evento (ex.: saber se a tecla foi Enter).
  // Expor por variável de módulo em vez de mudar a assinatura de todas as
  // funções. É seguro porque JS é single-thread e a chamada é síncrona: o
  // valor só existe durante o despacho.
  // Erro de API (Error com a mensagem do backend) vai como está para o toast.
  // Defeito de programação (TypeError…) não mostra a mensagem técnica — e vai
  // para o console como ERRO, para não passar despercebido; o de API, como
  // aviso (é situação prevista e já está na tela).
  const falhou = (e) => {
    const defeito = e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError;
    (defeito ? console.error : console.warn)("[acoes] erro em", nome, e);
    let msg = e && e.message ? e.message : "Não foi possível concluir a ação.";
    if (e instanceof TypeError && /fetch/i.test(msg)) msg = "Sem conexão com o servidor. Verifique a internet e tente de novo.";
    else if (defeito) msg = "Algo deu errado nesta ação. Tente de novo; se repetir, avise o suporte.";
    try { toast(msg, true); } catch (_) { /* toast indisponível */ }
  };
  _EVENTO_ATUAL = ev;
  try {
    const r = fn.apply(el, args);
    // Ação async que falha devolve uma promessa REJEITADA — o try/catch não a
    // vê (só cobre a parte síncrona). Sem isto, um 403/409 numa gravação
    // virava "Uncaught (in promise)" no console e NADA na tela: a pessoa
    // clicava e achava que tinha dado certo.
    if (r && typeof r.then === "function") r.catch(falhou);
  }
  catch (e) { falhou(e); }
  finally { _EVENTO_ATUAL = null; }
}

let _EVENTO_ATUAL = null;
/** Evento em despacho — válido apenas DENTRO de uma ação registrada. */
function eventoAtual() { return _EVENTO_ATUAL; }


/* ---------------------------------------------------------------------
   Ações nomeadas — o que antes era código solto dentro do atributo.
   Cada uma recebe `this` = o elemento que disparou o evento.
   --------------------------------------------------------------------- */

// Enter no campo de CEP dispara a busca. O prefixo do formulário sai do id do
// próprio campo (f-cep → "f-", cf-cep → "cf-"): sem isso a busca lia sempre
// `f-cep` e, nos formulários com outro prefixo, falhava calada.
function acCepEnter() {
  const ev = eventoAtual();
  if (ev && ev.key === "Enter") { ev.preventDefault(); _buscarCep(_pfxDoCampo(this, "cep")); }
}
// Enter no campo de busca da auditoria aplica o filtro
function acAuditEnter() {
  const ev = eventoAtual();
  if (ev && ev.key === "Enter") auditAplicar();
}
// Link interno do dashboard (o `return false` virou data-prevent="1")
function acNavegar(destino) { navigate(destino); }
// Honorário novo já vinculado à ação, recarregando a tela ao salvar.
// Era o único handler com função inline (`onSaved:()=>...`) — impossível
// de serializar num atributo, por isso virou função de verdade.
function acNovoHonorarioAcao(id) {
  honorarioModal(null, { acaoId: id, onSaved: () => _casoReabrir("acoes", id) });
}
// Botão que aciona o <input type=file> escondido da importação
function acAbrirSeletorXlsx() { document.getElementById("prec-xlsx").click(); }

// --- alternâncias de formulário (mostrar/esconder blocos) ---
function acToggleRateio() {
  document.getElementById("f-rateio-box").style.display = this.checked ? "block" : "none";
  document.getElementById("f-origem-wrap").style.display = this.checked ? "none" : "block";
  distAtualizarPreview();
}
function acToggleParceria() {
  document.getElementById("f-parceria").style.display = this.value === "parceria" ? "flex" : "none";
}
function acToggleOrigemAssinatura() {
  document.getElementById("as-sec-modelo").style.display = this.value === "modelo" ? "block" : "none";
  document.getElementById("as-sec-anexo").style.display = this.value === "anexo" ? "block" : "none";
}
function acToggleVinculoAssinatura() {
  document.getElementById("as-prec-wrap").style.display = this.value === "precatorio" ? "block" : "none";
  document.getElementById("as-cli-wrap").style.display = this.value === "cliente" ? "block" : "none";
}
function acEmailDestinatario() {
  const o = this.options[this.selectedIndex];
  document.getElementById("as-up-email").textContent = o && o.dataset.email
    ? "Assinatura irá para: " + o.dataset.email
    : "Este cliente não tem e-mail cadastrado.";
}
function acPreencherNomeCliente() {
  if (this.value) document.getElementById("f-name").value = this.value;
}
function acUsarSugestaoIA() {
  document.getElementById("ia-pergunta").value = this.textContent;
}

// --- casos parados / monitoramento ---
function acParadosVer() { auditarParados(document.getElementById("par-dias").value); }
function acParadosMarcarTodos() {
  const marcar = this.checked;
  document.querySelectorAll(".par-chk").forEach((c) => { c.checked = marcar; });
}
function acMonitAba(view) { monitView = view; renderMonitoramento(); }
function acDjenToggleNovas() { djenFilterNovas = !djenFilterNovas; renderMonitDjen(); }
function acDjenToggleAll() { djenToggleAll(this); }
function acDjenToggleArquivadas() { djenVerArquivadas = !djenVerArquivadas; renderMonitDjen(); }

// --- imagens que somem quando o arquivo não existe ---
function acImgOcultar() { this.style.display = "none"; }
function acImgMarcaFallback() {
  this.style.display = "none";
  const f = document.getElementById("brand-fallback");
  if (f) f.style.display = "block";
}

// Seleciona todo o texto do campo (usado no segredo do 2FA, para copiar fácil)
function acSelecionarTudo() { this.select(); }
// Cabeçalho "selecionar todos" da lista de precatórios
function acPrecToggleAll() { precToggleAll(this); }
// Só impede o clique de subir para a linha (que abriria o caso). Existe porque
// `data-stop="1"` sozinho precisa de uma ação para o despachante entrar.
function acNada() {}

// --- adaptadores que precisam receber o próprio elemento ---
function acImportarXlsx() { importarPrecatoriosExcel(this); }
function acMaskMoeda() { _maskMoeda(this); }
// Valor pago do honorário: máscara + prévia do rateio (um elemento só tem um data-on-input).
function acMaskMoedaRateio() { _maskMoeda(this); distAtualizarPreview(); }
// Valor simulado da distribuição (Financeiro → Distribuição).
function acDcSimMoeda() { _maskMoeda(this); if (typeof window._dcRecalc === "function") window._dcRecalc(); }
// Caso do honorário trocou: o rateio de precatório só faz sentido com caso
// PRECATÓRIO. Fica visível se já estiver ligado — sumir com ele ligado
// esconderia uma divisão que vai ser gravada.
function acHonCasoMudou() {
  const w = document.getElementById("f-rateio-wrap");
  const chk = document.getElementById("f-rateio");
  if (w) w.style.display = String(this.value || "").startsWith("prec:") || (chk && chk.checked) ? "block" : "none";
}
function acStatusAssinatura(id) { setAssinaturaStatus(id, this.value); }
function acDjenToggleAuto() { djenToggleAuto(this.checked); }

// Um listener por tipo de evento, no document — não importa quantos elementos
// a tela redesenhe, a delegação continua valendo (era outra vantagem: antes,
// cada innerHTML recriava 100+ handlers).
["click", "change", "input", "keydown", "submit"].forEach((tipo) => {
  document.addEventListener(tipo, (ev) => {
    const alvo = ev.target instanceof Element ? ev.target : null;
    if (!alvo) return;
    const el = alvo.closest(`[data-on-${tipo}]`);
    if (el) _executarAcao(ev, el, el.getAttribute(`data-on-${tipo}`));
  });
});

// `error` de <img> NÃO borbulha — só é capturável na fase de captura.
document.addEventListener("error", (ev) => {
  const el = ev.target instanceof Element ? ev.target : null;
  if (el && el.hasAttribute("data-on-error")) {
    _executarAcao(ev, el, el.getAttribute("data-on-error"));
  }
}, true);

/* ---------------- Autenticação ---------------- */
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const otpField = document.getElementById("login-otp");
  const otp = otpField ? otpField.value.trim() : "";
  const errBox = document.getElementById("login-error");
  errBox.classList.add("d-none");
  try {
    // O endpoint /api/auth/login espera form-data OAuth2 (username/password e otp)
    const form = new URLSearchParams();
    form.append("username", email);
    form.append("password", password);
    if (otp) form.append("otp", otp);
    const res = await fetch(API + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      let detail = "Usuário ou senha inválidos";
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      if (detail === "2FA_REQUIRED") {
        document.getElementById("otp-wrap").classList.remove("d-none");
        if (otpField) otpField.focus();
        errBox.className = "alert alert-info py-2";
        errBox.textContent = "Digite o código do seu app autenticador.";
        errBox.classList.remove("d-none");
        return;
      }
      throw new Error(detail);
    }
    const data = await res.json();
    TOKEN = data.access_token;
    CURRENT_USER = data.user;
    try { localStorage.setItem("crm_token", TOKEN); } catch (e) {}
    startApp();
  } catch (err) {
    errBox.className = "alert alert-danger py-2";
    errBox.textContent = err.message;
    errBox.classList.remove("d-none");
  }
});

function logout() {
  // Sair ignora a guarda de "alteração não salva" de propósito: o botão Sair,
  // o 401 e a inatividade têm de funcionar sempre — uma pergunta aqui
  // deixaria a sessão aberta numa máquina compartilhada.
  if (typeof fichaMarcarSujo === "function") fichaMarcarSujo(false);
  TOKEN = null;
  CURRENT_USER = null;
  limparEstadoDeTela();
  try { localStorage.removeItem("crm_token"); localStorage.removeItem("crm_last_activity"); } catch (e) {}
  removerMarcaDagua();
  if (window._wmTimer) clearInterval(window._wmTimer);
  if (window._bellTimer) clearInterval(window._bellTimer);
  // A tela do usuário anterior (ficha com CPF, telefone...) não fica no DOM
  // escondida atrás do login: some junto com a sessão.
  // E o contêiner é TROCADO por um clone vazio, não só esvaziado: uma tela
  // que ainda esperava a API (Documentos aberta um segundo antes do Sair)
  // escrevia no MESMO nó depois que o próximo usuário entrava — a tela da
  // sessão anterior aparecia por cima do dashboard dele.
  try { closeModal(); } catch (e) {}
  const vc = document.getElementById("view-container");
  if (vc) vc.replaceWith(vc.cloneNode(false));
  document.getElementById("app").classList.add("d-none");
  document.getElementById("login-screen").classList.remove("d-none");
}

/** Zera os filtros das telas ao trocar de usuário.
 *
 * O logout NÃO recarrega a página, então estes objetos globais sobreviveriam à
 * troca de sessão: o próximo usuário abriria as listas já filtradas pelo que o
 * anterior escolheu — sem nenhuma pista na tela do porquê. No filtro de
 * responsável isso era pior ainda: um ID herdado devolvia lista vazia. */
function limparEstadoDeTela() {
  precFilter = { tribunal: "", classificacao: "", status_lead: "", responsavel: "", search: "" };
  finFilter = { type: "", status: "" };
  acaoFilter = { area: "", status_lead: "", search: "" };
  _colegasCache = null;
  CACHE = { clients: [], processes: [] };
  // O hash também é estado de tela: sem limpá-lo, o próximo a logar nesta
  // aba abriria a ficha que o anterior estava vendo (o backend negaria, mas a
  // tela quebraria). replaceState: limpar não deve virar entrada no histórico.
  if (location.hash) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }
  // Estado da ficha (FICHA) + o reset que cada arquivo da ficha registrou
  // em FICHA_LIMPEZA (filtros das listas novas etc.).
  if (typeof fichaLimparEstado === "function") fichaLimparEstado();
}

/* =========================================================
   Foto de perfil do usuário
   ========================================================= */
function renderAvatar() {
  const av = document.getElementById("user-avatar");
  if (!av) return;
  if (CURRENT_USER && CURRENT_USER.avatar) {
    av.innerHTML = `<img src="${esc(CURRENT_USER.avatar)}" alt="perfil">`;
  } else {
    av.textContent = ((CURRENT_USER && CURRENT_USER.name) || "?").trim().charAt(0).toUpperCase();
  }
  av.style.cursor = "pointer";
  av.title = "Alterar foto de perfil";
  av.onclick = perfilModal;
}

function _resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function perfilModal() {
  const letra = ((CURRENT_USER.name || "?").trim().charAt(0).toUpperCase());
  const atual = CURRENT_USER.avatar
    ? `<img src="${esc(CURRENT_USER.avatar)}" style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid var(--line)">`
    : `<div style="width:96px;height:96px;border-radius:50%;display:grid;place-items:center;margin:0 auto;font-size:2.2rem;font-weight:700;color:#fff;background:linear-gradient(135deg,var(--navy-300),var(--navy))">${letra}</div>`;
  showModal("Foto de perfil", `
    <div class="text-center mb-3">${atual}</div>
    <div class="mb-2"><label class="form-label">Escolha uma imagem</label>
      <input type="file" id="perfil-file" class="form-control" accept="image/*"></div>
    ${CURRENT_USER.avatar ? `<button type="button" class="btn btn-sm btn-outline-danger" data-on-click="removerAvatar"><i class="bi bi-trash"></i> Remover foto atual</button>` : ""}
    <p class="text-muted small mt-2">A imagem é redimensionada automaticamente. Tamanho máximo ~2MB.</p>
  `, async () => {
    const fi = document.getElementById("perfil-file");
    if (!fi || !fi.files.length) { closeModal(); return; }
    try {
      const dataUrl = await _resizeImage(fi.files[0], 256);
      const u = await api("/api/auth/me/avatar", { method: "PUT", body: JSON.stringify({ avatar: dataUrl }) });
      CURRENT_USER.avatar = u.avatar; renderAvatar();
      closeModal(); toast("Foto de perfil atualizada!");
    } catch (e) { toast(e.message || "Erro ao enviar a imagem", true); }
  });
}

async function removerAvatar() {
  try {
    const u = await api("/api/auth/me/avatar", { method: "PUT", body: JSON.stringify({ avatar: null }) });
    CURRENT_USER.avatar = u.avatar; renderAvatar();
    closeModal(); toast("Foto removida");
  } catch (e) { toast(e.message, true); }
}

/* =========================================================
   Logout automático por inatividade (1 hora sem interação)
   ========================================================= */
const INACTIVITY_LIMIT_MS = 60 * 60 * 1000; // 1 hora
let _lastActivityWrite = 0;

function markActivity() {
  // Registra a última atividade (compartilhado entre abas via localStorage)
  const now = Date.now();
  if (now - _lastActivityWrite < 10000) return; // grava no máx. a cada 10s
  _lastActivityWrite = now;
  try { localStorage.setItem("crm_last_activity", String(now)); } catch (e) {}
}

function _lastActivityTs() {
  try { return parseInt(localStorage.getItem("crm_last_activity") || "0") || 0; } catch (e) { return 0; }
}

function sessaoInativaExpirada() {
  const last = _lastActivityTs();
  return last > 0 && (Date.now() - last > INACTIVITY_LIMIT_MS);
}

function logoutInatividade() {
  logout();
  try { toast("Sessão encerrada por inatividade. Faça login novamente.", true); } catch (e) {}
}

// Eventos que contam como atividade do usuário
["mousedown", "keydown", "scroll", "touchstart", "click", "mousemove"].forEach(ev =>
  document.addEventListener(ev, () => { if (TOKEN) markActivity(); }, { passive: true }));

// Verifica a inatividade periodicamente (robusto mesmo com a aba em segundo plano)
setInterval(() => {
  if (TOKEN && sessaoInativaExpirada()) logoutInatividade();
}, 30000);

function alterarSenhaModal() {
  showModal("Alterar minha senha", `
    <div class="mb-2"><label class="form-label">Senha atual</label><input type="password" id="sn-atual" class="form-control" autocomplete="current-password"></div>
    <div class="mb-2"><label class="form-label">Nova senha</label><input type="password" id="sn-nova" class="form-control" placeholder="mínimo 6 caracteres" autocomplete="new-password"></div>
    <div class="mb-2"><label class="form-label">Confirmar nova senha</label><input type="password" id="sn-conf" class="form-control" autocomplete="new-password"></div>
  `, async () => {
    const atual = val("sn-atual"), nova = val("sn-nova"), conf = val("sn-conf");
    if (!atual || !nova) return toast("Preencha todos os campos", true);
    if (nova.length < 6) return toast("A nova senha deve ter ao menos 6 caracteres", true);
    if (nova !== conf) return toast("A confirmação não confere com a nova senha", true);
    await api("/api/auth/me/password", { method: "POST", body: JSON.stringify({ senha_atual: atual, nova_senha: nova }) });
    closeModal(); toast("Senha alterada com sucesso!");
  });
}

async function segurancaModal() {
  if (CURRENT_USER && CURRENT_USER.totp_enabled) {
    showModal("Segurança — Verificação em 2 fatores", `
      <p><span class="badge bg-success">2FA ativado</span></p>
      <p class="small text-muted">Sua conta pede um código do app autenticador ao entrar. Para desativar, informe um código atual:</p>
      <div class="mb-1"><input id="tf-code" class="form-control" inputmode="numeric" placeholder="000000"></div>
      <hr>
      <div id="tf-troca">
        <p class="small mb-2"><strong>Trocou de celular?</strong> Gere uma chave nova sem desligar o 2FA. A chave atual continua valendo até você confirmar a nova.</p>
        <div class="mb-2"><input type="password" id="tf-senha" class="form-control form-control-sm" placeholder="Senha atual" autocomplete="current-password"></div>
        <div class="mb-2"><input id="tf-code-atual" class="form-control form-control-sm" inputmode="numeric" placeholder="Código do app atual" autocomplete="one-time-code"></div>
        <button type="button" class="btn btn-sm btn-outline-primary" data-on-click="tfTrocarAparelho">Gerar chave nova</button>
      </div>
    `, async () => {
      if (!val("tf-code")) return toast("Informe um código do app para desativar", true);
      await api("/api/auth/2fa/disable", { method: "POST", body: JSON.stringify({ code: val("tf-code") }) });
      CURRENT_USER.totp_enabled = 0;
      closeModal(); toast("2FA desativado.");
    }, { rotuloSalvar: "Desativar 2FA" });
    return;
  }
  let s;
  try {
    s = await api("/api/auth/2fa/setup", { method: "POST" });
  } catch (e) {
    // 409: o 2FA foi ligado em outra aba/aparelho e esta sessão não sabia.
    // Desde out/2026 o setup não troca mais o segredo de quem já tem 2FA sem
    // senha + código — então mostra a tela de quem já tem 2FA.
    if (e.status === 409 && CURRENT_USER) { CURRENT_USER.totp_enabled = 1; return segurancaModal(); }
    throw e;
  }
  showModal("Ativar verificação em 2 fatores (2FA)", `
    <p class="small text-muted">1) Instale um app autenticador (Google Authenticator, Authy, etc.). 2) Escaneie o QR abaixo (ou digite a chave). 3) Informe o código gerado e a sua senha para ativar.</p>
    <div class="text-center mb-3"><div id="tf-qr" style="display:inline-block"></div></div>
    <div class="mb-2"><label class="form-label">Chave (caso prefira digitar)</label><input class="form-control" readonly value="${esc(s.secret)}" data-on-click="acSelecionarTudo"></div>
    <div class="mb-2"><label class="form-label">Código do app*</label><input id="tf-code" class="form-control" inputmode="numeric" placeholder="000000" autocomplete="one-time-code"></div>
    <div class="mb-1"><label class="form-label">Sua senha atual*</label><input type="password" id="tf-senha-ativ" class="form-control" autocomplete="current-password"></div>
  `, async () => {
    // Desde out/2026 o backend exige a senha para LIGAR o 2FA: sem ela, uma
    // sessão roubada ativava o 2FA com a chave do atacante. Vai CRUA, sem o
    // trim do val(), como no login.
    const senha = document.getElementById("tf-senha-ativ").value;
    if (!val("tf-code") || !senha) return toast("Informe o código do app e a sua senha atual", true);
    await api("/api/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code: val("tf-code"), senha_atual: senha }) });
    CURRENT_USER.totp_enabled = 1;
    closeModal(); toast("2FA ativado com sucesso!");
  });
  setTimeout(() => _tfDesenharQr(s.otpauth_uri), 250);
}

function _tfDesenharQr(uri) {
  const el = document.getElementById("tf-qr");
  if (el && typeof QRCode !== "undefined") {
    try { new QRCode(el, { text: uri, width: 170, height: 170 }); } catch (e) {}
  }
}

// Troca de aparelho com o 2FA LIGADO (out/2026). O backend exige a senha e um
// código do app ATUAL e guarda a chave nova como PENDENTE: a antiga continua
// valendo até o código da nova ser confirmado em tfConfirmarTroca. Tudo dentro
// do mesmo modal (o bloco #tf-troca é redesenhado), sem abrir outro por cima.
async function tfTrocarAparelho() {
  // A senha vai CRUA, sem o trim do val(): o login também não apara, e uma
  // senha com espaço na ponta entraria no login e falharia aqui.
  const senha = document.getElementById("tf-senha").value, codigo = val("tf-code-atual");
  if (!senha || !codigo) return toast("Informe a senha atual e um código do app atual", true);
  // Dois cliques gerariam duas chaves, e a primeira mostrada já não valeria.
  this.disabled = true;
  let s;
  try {
    s = await api("/api/auth/2fa/setup", {
      method: "POST", body: JSON.stringify({ senha_atual: senha, code: codigo }),
    });
  } finally { this.disabled = false; }
  const box = document.getElementById("tf-troca");
  if (!box) return;
  box.innerHTML = `
    <p class="small mb-2"><strong>Novo aparelho:</strong> escaneie o QR no app do celular novo (ou digite a chave) e informe o código que ele mostrar. Até confirmar, a chave antiga continua valendo.</p>
    <div class="text-center mb-3"><div id="tf-qr" style="display:inline-block"></div></div>
    <div class="mb-2"><label class="form-label">Chave (caso prefira digitar)</label><input class="form-control" readonly value="${esc(s.secret)}" data-on-click="acSelecionarTudo"></div>
    <div class="mb-2"><label class="form-label">Código do app NOVO*</label><input id="tf-code-novo" class="form-control" inputmode="numeric" placeholder="000000" autocomplete="one-time-code"></div>
    <button type="button" class="btn btn-sm btn-primary" data-on-click="tfConfirmarTroca">Confirmar novo aparelho</button>`;
  _tfDesenharQr(s.otpauth_uri);
}

async function tfConfirmarTroca() {
  const codigo = val("tf-code-novo");
  if (!codigo) return toast("Informe o código do app novo", true);
  this.disabled = true;
  try {
    await api("/api/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code: codigo }) });
  } finally { this.disabled = false; }
  closeModal(); toast("Aparelho trocado. A chave antiga deixou de valer.");
}

function startApp() {
  // Reinicia o relógio de inatividade no início da sessão
  _lastActivityWrite = 0; markActivity();
  document.getElementById("login-screen").classList.add("d-none");
  document.getElementById("app").classList.remove("d-none");
  document.getElementById("user-name").textContent =
    CURRENT_USER.name + " (" + (ROLE_LABEL[CURRENT_USER.role] || CURRENT_USER.role) + ")";
  renderAvatar();
  // Menu de Usuários só aparece para administradores
  const isAdmin = CURRENT_USER.role === "admin";
  const navUsers = document.getElementById("nav-usuarios");
  if (navUsers) navUsers.style.display = isAdmin ? "block" : "none";
  const navAudit = document.getElementById("nav-auditoria");
  if (navAudit) navAudit.style.display = isAdmin ? "block" : "none";
  const navIa = document.getElementById("nav-ia");
  if (navIa) navIa.style.display = isAdmin ? "block" : "none";
  // Funil é exclusivo do administrador; Monitoramento vale para admin e
  // estagiário (que só enxerga a aba Publicações — ver renderMonitoramento)
  const navFunil = document.getElementById("nav-funil");
  if (navFunil) navFunil.style.display = isAdmin ? "block" : "none";
  const navMonit = document.getElementById("nav-monitoramento");
  if (navMonit) navMonit.style.display = podeVerMonitoramento() ? "block" : "none";
  // Esconde da barra lateral os módulos que este usuário não pode ver
  document.querySelectorAll(".sidebar .nav-link[data-view]").forEach(link => {
    const v = link.dataset.view;
    if (!PERM_MODULES.includes(v)) return;      // dashboard e views de admin: já tratados
    const li = link.closest("li");
    if (li) li.style.display = permCanView(v) ? "" : "none";
  });
  // Marca d'água de segurança removida a pedido do usuário
  removerMarcaDagua();
  if (window._wmTimer) clearInterval(window._wmTimer);
  // Sino de novidades + alertas de segurança (somente admin)
  if (isAdmin) {
    atualizarSinoMonitor();
    atualizarAlertasSeguranca();
    if (window._bellTimer) clearInterval(window._bellTimer);
    window._bellTimer = setInterval(() => { atualizarSinoMonitor(); atualizarAlertasSeguranca(); }, 5 * 60 * 1000);
    // Auto-sincroniza o DJEN em segundo plano (após o app estabilizar)
    setTimeout(() => { try { djenAutoSync(); } catch (e) {} }, 4000);
  }
  // Abre a tela do hash (F5 numa ficha reabre a mesma ficha e aba; link
  // compartilhado abre direto depois do login). 'replace': a entrada atual
  // do histórico só ganha o carimbo do app, não vira uma entrada nova.
  // Sem hash ou rota inválida, o roteador cai no dashboard.
  if (typeof fichaRotear === "function") {
    fichaRotear(location.hash || "#/dashboard", { historico: "replace", guarda: false, inicio: true });
  } else {
    navigate("dashboard");   // ficha.js não carregou: o CRM continua de pé
  }
}

/* ---------------- Navegação ---------------- */
const VIEW_TITLES = {
  dashboard: "Dashboard", clients: "Clientes", processes: "Processos",
  deadlines: "Prazos", appointments: "Agenda", documents: "Documentos",
  pipeline: "Funil de Clientes", financeiro: "Financeiro",
  precatorios: "Precatórios Federais", funilprec: "Funil de Clientes — Precatórios", acoes: "Ações Judiciais Gerais", assinaturas: "Assinaturas", usuarios: "Usuários",
  monitoramento: "Monitoramento de Processos", auditoria: "Trilha de Auditoria",
  ia: "Inteligência Artificial",
};

document.querySelectorAll(".sidebar .nav-link").forEach(link => {
  link.addEventListener("click", () => navigate(link.dataset.view));
});

// Views exclusivas do administrador (advogado é redirecionado ao dashboard)
const ADMIN_ONLY_VIEWS = ["pipeline", "usuarios", "auditoria", "ia"];

/** Monitoramento: o admin usa por completo; o estagiário alcança APENAS a aba
    Publicações (DJEN), sem a configuração (OABs, sincronização, diagnóstico).
    O advogado segue sem acesso. */
function podeVerMonitoramento() { return permIsAdmin() || permIsEstagiario(); }

/**
 * Abre uma tela de lista/módulo e grava `#/<slug>` na URL.
 *   navigate(view, { historico: "push" | "replace" | "nenhum" })
 *     push    (padrão) empilha — mas só se o hash for outro: clicar em
 *             "Clientes" estando em Clientes não cria entrada repetida;
 *     replace troca a entrada atual (startApp, rota negada);
 *     nenhum  não toca no histórico — é o Voltar/Avançar do navegador,
 *             em que a URL já mudou (gravar aqui empilharia e mataria o
 *             Avançar).
 * Virou async por causa da guarda de alteração não salva (ficha.js): com a
 * ficha suja, pergunta antes de sair. Quem chama NÃO precisa de await.
 * `semGuarda` é para quem já perguntou (o roteador da ficha).
 */
async function navigate(view, opts) {
  const o = opts || {};
  let historico = o.historico || "push";
  if (!CURRENT_USER) return false;
  if (!o.semGuarda && typeof fichaPodeSair === "function" && !(await fichaPodeSair())) return false;
  let negado = false;
  if (ADMIN_ONLY_VIEWS.includes(view) && CURRENT_USER.role !== "admin") {
    view = "dashboard"; negado = true;
  }
  if (view === "monitoramento" && !podeVerMonitoramento()) {
    view = "dashboard"; negado = true;
  }
  // Módulo sem permissão: volta para o dashboard e avisa
  if (PERM_MODULES.includes(view) && !permCanView(view)) {
    toast("Você não tem permissão para acessar este módulo.", true);
    view = "dashboard"; negado = true;
  }
  if (!Object.prototype.hasOwnProperty.call(VIEW_TITLES, view)) { view = "dashboard"; negado = true; }
  // A URL aponta para a tela negada (veio do Voltar ou de um link): troca a
  // entrada em vez de deixá-la lá — senão o F5 tentaria abri-la de novo.
  if (negado && historico === "nenhum") historico = "replace";
  if (typeof fichaPrepararTela === "function") {
    // sidebar, título, spinner, modal esquecido, rolar ao topo, zerar ficha
    fichaPrepararTela(view);
    fichaGravarHash(fichaHashDaView(view), historico);
  } else {
    // ficha.js não carregou: mantém o comportamento de antes (sem URL)
    document.querySelectorAll(".sidebar .nav-link").forEach(l =>
      l.classList.toggle("active", l.dataset.view === view));
    document.getElementById("view-title").textContent = VIEW_TITLES[view];
    const c = document.getElementById("view-container");
    c.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>';
    c.classList.remove("view-fade"); void c.offsetWidth; c.classList.add("view-fade");
  }
  const render = _telasApp()[view];
  if (typeof render === "function") render();
  else if (typeof fichaEmConstrucao === "function") fichaEmConstrucao(VIEW_TITLES[view], "#/dashboard", "Dashboard");
  return true;
}

/** view → função que desenha a tela. Usada pelo navigate e pelo _depoisDe
 *  (redesenhar a tela em que a pessoa ESTÁ depois de salvar num modal).
 *  renderClients/renderProcesses moram em ficha-cliente.js e
 *  ficha-processo.js (SPEC §2.3). Citá-las direto num objeto literal daria
 *  ReferenceError em TODA navegação no intervalo em que a versão antiga já
 *  saiu do app.js e a nova ainda não chegou — o CRM inteiro parava de trocar
 *  de tela. Com o `typeof`, a tela que falta vira "Em construção". */
function _telasApp() {
  return {
    dashboard: renderDashboard,
    clients: typeof renderClients === "function" ? renderClients : null,
    processes: typeof renderProcesses === "function" ? renderProcesses : null,
    deadlines: renderDeadlines, appointments: renderAppointments,
    documents: renderDocuments, pipeline: renderPipeline,
    financeiro: renderFinanceiro, precatorios: renderPrecatorios,
    funilprec: renderFunilPrec,
    acoes: renderAcoes, assinaturas: renderAssinaturas,
    usuarios: renderUsuarios, monitoramento: renderMonitoramento,
    auditoria: renderAuditoria, ia: renderIA,
  };
}

/* ---------------- Dashboard ----------------
   A tela é o DASHBOARD EXECUTIVO (renderDashboard, mais abaixo). A versão
   antiga (cards + gráfico de demandas) ficava aqui, sobrescrita em silêncio
   pela de baixo por hoisting — foi apagada junto com loadDashChart/dashChart,
   que só ela usava. */
function statCard(bg, icon, value, label) {
  return `<div class="col-md-3 col-sm-6">
    <div class="card stat-card ${bg}"><div class="card-body">
      <i class="bi ${icon} stat-ic"></i>
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
    </div></div></div>`;
}

/* ---------------- Clientes ---------------- */
const CLIENT_STATUS = { lead: "Lead", negociacao: "Em negociação", ativo: "Cliente ativo", arquivado: "Arquivado" };
const CLIENT_STATUS_COLOR = { lead: "info", negociacao: "warning text-dark", ativo: "success", arquivado: "secondary" };
const CLIENT_STATUS_ICON = { lead: "bi-person-plus", negociacao: "bi-chat-dots", ativo: "bi-check-circle-fill", arquivado: "bi-archive" };
function clientStatusBadge(s) {
  // ⚠️ `esc()` no fallback NÃO é decoração: `CLIENT_STATUS[s] || s` devolve o
  // valor CRU do banco quando o status não está no dicionário — era XSS
  // armazenado. Os outros dois `||` desta linha caem em string literal
  // ('secondary'/'bi-dot'), então não precisam.
  return `<span class="badge bg-${CLIENT_STATUS_COLOR[s] || 'secondary'}"><i class="bi ${CLIENT_STATUS_ICON[s] || 'bi-dot'} me-1"></i>${esc(CLIENT_STATUS[s] || s)}</span>`;
}

/* A lista de Clientes (renderClients) e a ficha do cliente moram em
   ficha-cliente.js (SPEC §2.3). Daqui saíram renderClients, clientRows e o
   modal "Visão 360°" (clientDetail), que a ficha substitui. */

const SEXO_OPC = ["", "Masculino", "Feminino", "Outro"];
const ESTADO_CIVIL_OPC = ["", "Solteiro(a)", "Casado(a)", "Divorciado(a)", "Viúvo(a)", "União estável"];
const UF_OPC = ["", "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

/* =====================================================================
   FORMULÁRIOS COMPARTILHADOS — cliente e processo
   =====================================================================
   UM formulário por entidade, usado em todo lugar: modais antigos e painel
   do DJEN (prefixo `f-`), aba Cadastro da ficha do cliente (`cf-`) e aba
   Dados da ficha do processo (`fp-`). Campo novo entra AQUI e aparece nos
   três lugares ("não duplicar!").

   O PREFIXO vale para TUDO o que o formulário gera e lê — ids dos campos,
   `${pfx}owner`, `${pfx}sub-wrap`, `${pfx}sis-outro-wrap`, `${pfx}btn-cep`.
   Motivo: `getElementById` devolve o PRIMEIRO id do documento, e o
   `#view-container` vem antes do `#modal-container`. Com a ficha e um modal
   usando o mesmo id, o modal gravaria o que está digitado na ficha.
   Prefixos reservados: modais `f-` · Cadastro do cliente `cf-` · Dados do
   processo `fp-` (`pf-` era da lista antiga) · módulos `fma-` `fmd-` `fmc-`
   `fmp-` `fmn-`. Código novo NÃO usa `f-`.

   Uso (a casca devolve HTML; o formulário se inicializa sozinho logo depois
   de entrar no DOM — máscaras e avisos dos valores gravados):
     const dono = await _ownerFieldHtml(c.owner_id, "col-md-6", "cf-");
     el.innerHTML = _clientFormHtml(c, dono, { pfx: "cf-", aoMudarDocumento: (dig) => ... });
     ...
     const payload = _clientFormPayload({ pfx: "cf-" });   // null = já avisou o erro
   ===================================================================== */

/** Prefixo válido de formulário ("cf-", "fp-"…); qualquer outra coisa → "f-". */
function _pfxForm(pfx) {
  return typeof pfx === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(pfx) ? pfx : "f-";
}

/** Prefixo a partir do id do próprio campo: `cf-cep` + "cep" → "cf-".
 *  Sem elemento (chamada direta, sem `this`) → "f-", o prefixo dos modais. */
function _pfxDoCampo(el, sufixo) {
  if (el && el.dataset && el.dataset.pfx !== undefined) return _pfxForm(el.dataset.pfx);
  const id = el && el.id ? String(el.id) : "";
  return id && id.endsWith(sufixo) ? _pfxForm(id.slice(0, id.length - sufixo.length)) : "f-";
}

/** <option>s de uma lista de TEXTO (sexo, estado civil, UF, fase, subcategoria).
 *  Valor gravado que saiu da lista vira "(atual)": sem isso o select abriria
 *  na 1ª opção e o próximo Salvar trocaria o dado em silêncio. */
function _opcoesTexto(lista, atual, vazio) {
  const cur = atual === null || atual === undefined ? "" : String(atual);
  let html = vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : "";
  html += lista.map((o) => `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(o || "—")}</option>`).join("");
  if (cur && !lista.includes(cur)) html += `<option value="${esc(cur)}" selected>${esc(cur)} (atual)</option>`;
  return html;
}

/** Seção do formulário (uiSecao do ficha.js; fieldset simples se ele faltar). */
function _formSecao(titulo, html, opts) {
  if (typeof uiSecao === "function") return uiSecao(titulo, html, opts);
  return `<fieldset class="ficha-secao"><legend>${esc(titulo)}</legend>${html}</fieldset>`;
}

/** Máscaras e avisos dos valores JÁ gravados (CPF válido, CNJ decodificado…).
 *  Os formulários chamam sozinhos logo depois de entrar no DOM; chame de novo
 *  se inserir o HTML mais tarde (é idempotente e não marca a ficha como suja). */
function _formIniciar(raiz) {
  if (raiz && typeof fichaMascarasIniciar === "function") fichaMascarasIniciar(raiz);
}
function _formAgendarInicio(seletor) {
  setTimeout(() => { _formIniciar(document.querySelector(seletor)); }, 0);
}

/* Select "Advogado responsável" — só o admin lista usuários; para os demais
   devolve "" (o backend define o dono). Usado pelos formulários de cliente e
   de processo e pelo painel do DJEN.
   🚨 Até out/2026 não tinha opção vazia: num cadastro novo (owner_id nulo)
   nenhuma opção ficava `selected`, o navegador mostrava a PRIMEIRA (o 1º
   usuário em ordem alfabética) e o salvar gravava essa pessoa como dona —
   atribuição silenciosa. Agora: vazio = "eu mesmo", e o payload só manda
   `owner_id` quando o admin MUDOU o campo (data-orig). */
async function _ownerFieldHtml(selectedId, wrapper, pfx) {
  if (!permIsAdmin()) return "";
  const p = _pfxForm(pfx);
  let users;
  try { users = await api("/api/auth/users"); } catch (e) { return ""; }   // sem permissão: ignora
  const atual = selectedId === null || selectedId === undefined || selectedId === "" ? "" : String(selectedId);
  const conhecido = users.some((u) => String(u.id) === atual);
  const opcoes =
    (atual ? "" : `<option value="" selected>— Eu mesmo (quem cadastra) —</option>`) +
    (atual && !conhecido ? `<option value="${esc(atual)}" selected>Responsável atual (#${esc(atual)})</option>` : "") +
    users.map((u) => `<option value="${esc(u.id)}"${String(u.id) === atual ? " selected" : ""}>${esc(u.name)} (${esc(ROLE_LABEL[u.role] || u.role)})</option>`).join("");
  return `
    <div class="${esc(wrapper || "")}"><label class="form-label" for="${p}owner">Advogado responsável</label>
      <select id="${p}owner" class="form-select" data-orig="${esc(atual)}">${opcoes}</select></div>`;
}

/** Valor do select de responsável para o payload: `undefined` = não mandar a
 *  chave (campo não existe, não mudou, ou ficou em "Eu mesmo"). */
function _ownerFieldValor(pfx) {
  const el = document.getElementById(_pfxForm(pfx) + "owner");
  if (!el) return undefined;
  if (el.value === (el.dataset.orig || "")) return undefined;
  return el.value ? parseInt(el.value, 10) : undefined;
}

// Consulta de CEP (ViaCEP). NÃO DESTRUTIVA: só preenche campo VAZIO — antes
// sobrescrevia rua/bairro que a pessoa já tinha digitado (e lia `f-cep` fixo,
// falhando calada nos formulários com outro prefixo). O que vem de fora entra
// só por `.value`/textContent, nunca como HTML.
//   _buscarCep("cf-")  — pelo botão (data-args), pela máscara (8 dígitos) ou Enter.
window._buscarCep = async function (pfx) {
  const p = typeof pfx === "string" ? _pfxForm(pfx) : _pfxDoCampo(this instanceof Element ? this : null, "btn-cep");
  const cepEl = document.getElementById(p + "cep");
  const cep = String(cepEl ? cepEl.value : "").replace(/\D/g, "");
  if (cep.length !== 8) { toast("Digite um CEP com 8 dígitos", true); return; }
  const btn = document.getElementById(p + "btn-cep");
  const rotulo = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>'; }
  const dica = document.getElementById(p + "cep-dica");
  try {
    let d;
    try {
      const r = await fetch("https://viacep.com.br/ws/" + cep + "/json/", { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!r.ok) throw new Error("http " + r.status);
      d = await r.json();
    } catch (e) {
      toast("Não foi possível consultar o CEP agora. Preencha o endereço à mão.", true);
      return;
    }
    if (!d || d.erro) {
      _cepDica(dica, "alerta", "CEP não encontrado — confira os números.");
      toast("CEP não encontrado", true);
      return;
    }
    const campos = [["estado", d.uf, "UF"], ["cidade", d.localidade, "cidade"], ["bairro", d.bairro, "bairro"], ["rua", d.logradouro, "rua"]];
    const preenchidos = [];
    for (const [suf, valor, rot] of campos) {
      const el = document.getElementById(p + suf);
      const v = String(valor || "").trim();
      if (!el || !v || String(el.value || "").trim()) continue;
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === v)) continue;
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));   // a ficha marca "alterações não salvas"
      preenchidos.push(rot);
    }
    if (preenchidos.length) {
      _cepDica(dica, "ok", `Preenchido pelo CEP · editável (${preenchidos.join(", ")})`);
      toast("Endereço preenchido pelo CEP");
    } else {
      const lugar = [d.localidade, d.uf].filter(Boolean).join("/");
      _cepDica(dica, "info", `CEP de ${lugar || "endereço encontrado"} — os campos já preenchidos foram mantidos.`);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = rotulo || '<i class="bi bi-search"></i>'; }
  }
};
function _cepDica(el, tom, texto) {
  if (!el) return;
  el.className = "form-text ficha-aviso ficha-aviso-" + (tom === "ok" || tom === "alerta" ? tom : "info");
  el.innerHTML = '<i class="bi bi-geo-alt" aria-hidden="true"></i><span></span>';
  el.querySelector("span").textContent = texto;
  el.hidden = false;
}

/* ---------- Gancho de duplicidade (CPF/CNPJ) ----------
   A máscara do documento (ficha.js) dispara o evento DOM `ficha-documento`
   ({digitos, tipo, valido}) quando o campo completa 11/14 dígitos. Cada
   formulário de cliente registra aqui o seu gancho, pelo prefixo; sem gancho
   próprio vale o padrão `_clienteDuplicidade` (procura outro cliente com os
   mesmos dígitos e avisa embaixo do campo). `aoMudarDocumento: null` desliga. */
const _FORM_GANCHO_DOC = Object.create(null);
document.addEventListener("ficha-documento", (ev) => {
  const el = ev.target instanceof Element ? ev.target : null;
  if (!el || !el.id || !el.id.endsWith("doc")) return;
  const fn = _FORM_GANCHO_DOC[el.id.slice(0, -3)];
  if (typeof fn !== "function") return;
  const det = ev.detail || {};
  try {
    const r = fn(det.digitos, det);
    if (r && typeof r.catch === "function") r.catch((e) => console.warn("[form] gancho de documento falhou", e));
  } catch (e) { console.warn("[form] gancho de documento falhou", e); }
});
// O aviso de duplicidade some assim que o número digitado deixa de ser aquele.
document.addEventListener("input", (ev) => {
  const el = ev.target instanceof Element ? ev.target : null;
  if (!el || !el.id || !el.id.endsWith("doc")) return;
  const box = document.getElementById(el.id + "-dup");
  if (box && !box.hidden && box.dataset.dig !== String(el.value || "").replace(/\D/g, "")) box.hidden = true;
});

/** Gancho padrão: outro cliente com o mesmo CPF/CNPJ → aviso com link para a
 *  ficha dele. Só enxerga o que a busca do usuário enxerga (escopo do backend). */
async function _clienteDuplicidade(pfx, digitos, idAtual) {
  const p = _pfxForm(pfx);
  const box = document.getElementById(p + "doc-dup");
  if (!box) return;
  box.hidden = true;
  const dig = String(digitos || "");
  if (dig.length !== 11 && dig.length !== 14) return;
  let lista;
  try { lista = await api("/api/clients?search=" + encodeURIComponent(dig)); } catch (e) { return; }
  const el = document.getElementById(p + "doc");
  if (!el || String(el.value || "").replace(/\D/g, "") !== dig) return;   // mudou durante a busca
  const outro = (Array.isArray(lista) ? lista : []).find((c) =>
    String(c.cpf_cnpj || "").replace(/\D/g, "") === dig && String(c.id) !== String(idAtual === undefined || idAtual === null ? "" : idAtual));
  if (!outro) return;
  const h = "#/clientes/" + Number(outro.id);
  box.className = "form-text ficha-aviso ficha-aviso-alerta";
  box.dataset.dig = dig;
  box.innerHTML = `<i class="bi bi-people" aria-hidden="true"></i><span>Já existe um cliente com este documento: <b>${esc(outro.name)}</b> · <a href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}">abrir ficha</a></span>`;
  box.hidden = false;
}

/* ---------- Formulário de CLIENTE ----------
   _clientFormHtml(cliente, ownerField, { pfx = "f-", aoMudarDocumento })
   - PF/PJ em `${pfx}tipo_pessoa`: "Dados pessoais" e o rótulo "CPF" só para PF;
     nome fantasia e "Buscar na Receita" só para PJ. O campo escondido CONTINUA
     no DOM (d-none) e vai no payload como está — trocar PF↔PJ não apaga nada.
   - Máscaras: documento (marca PJ sozinho com 14 dígitos), telefones, CEP
     (8 dígitos → busca o endereço, só nos campos vazios).
   - Origem (`FICHA_ROTULOS.origem`) + "Indicado por" quando origem = indicação. */
function _clientFormHtml(client, ownerField, opts) {
  const o = opts || {};
  const p = _pfxForm(o.pfx);
  const c = client || {};
  const v = (x) => esc(x === null || x === undefined ? "" : x);
  const doc = fichaDigitos(c.cpf_cnpj);
  const tipo = c.tipo_pessoa === "PJ" || c.tipo_pessoa === "PF" ? c.tipo_pessoa : (doc.length === 14 ? "PJ" : "PF");
  const pj = tipo === "PJ";
  const so = (t) => ((t === "PJ") === pj ? "" : " d-none");
  const indicacao = c.origem === "indicacao";
  const cep = fichaDigitos(c.cep).length === 8 ? fichaPadrao(fichaDigitos(c.cep), "#####-###") : (c.cep || "");
  const statusOpts = Object.entries(CLIENT_STATUS).map(([k, r]) =>
    `<option value="${k}"${(c.status || "lead") === k ? " selected" : ""}>${esc(r)}</option>`).join("") +
    (c.status && !CLIENT_STATUS[c.status] ? `<option value="${v(c.status)}" selected>${v(c.status)} (atual)</option>` : "");
  const tel = (id, rotulo, valor, col) => `
    <div class="${col}"><label class="form-label" for="${p}${id}">${rotulo}</label>
      <input id="${p}${id}" class="form-control ficha-num" inputmode="tel" autocomplete="off" data-on-input="fichaMascaraTel" placeholder="(00) 00000-0000" value="${v(fmtTel(valor))}"></div>`;
  const txt = (id, rotulo, valor, col, extra) => `
    <div class="${col}"><label class="form-label" for="${p}${id}">${rotulo}</label>
      <input id="${p}${id}" class="form-control" value="${v(valor)}"${extra || ""}></div>`;

  // Gancho de duplicidade deste formulário (ver _FORM_GANCHO_DOC).
  _FORM_GANCHO_DOC[p] = o.aoMudarDocumento === undefined
    ? (dig) => _clienteDuplicidade(p, dig, c.id)
    : (typeof o.aoMudarDocumento === "function" ? o.aoMudarDocumento : null);
  _formAgendarInicio(`[data-form-cliente="${p}"]`);

  const identificacao = `
    <div class="row g-3">
      <div class="col-md-4"><label class="form-label" for="${p}tipo_pessoa">Tipo de pessoa</label>
        <select id="${p}tipo_pessoa" class="form-select" data-on-change="_cliTipoPessoaSync">${fichaOpcoes("tipoPessoa", tipo)}</select></div>
      <div class="col-md-8"><label class="form-label" for="${p}doc" id="${p}lbl-doc">${pj ? "CNPJ" : "CPF"}</label>
        <input id="${p}doc" class="form-control ficha-num" inputmode="numeric" autocomplete="off" data-on-input="fichaMascaraDoc"
          placeholder="${pj ? "00.000.000/0000-00" : "000.000.000-00"}" value="${v(fmtDoc(c.cpf_cnpj))}">
        <div id="${p}doc-aviso" class="form-text ficha-aviso ficha-aviso-fixo" aria-live="polite"></div>
        <div class="mt-1${so("PJ")}" data-so="PJ"><div class="d-flex flex-wrap align-items-center gap-2">
          <button type="button" class="btn btn-sm btn-ficha" id="${p}btn-cnpj" data-on-click="fichaBuscarCnpj" data-args="${escArgs(p)}"><i class="bi bi-search" aria-hidden="true"></i> Buscar na Receita</button>
          <span class="small text-muted">Preenche só os campos vazios.</span>
        </div>
        <div id="${p}cnpj-info" hidden></div></div>
        <div id="${p}doc-dup" class="form-text ficha-aviso" hidden></div></div>
      <div class="col-md-8"><label class="form-label" for="${p}name"><span id="${p}lbl-name">${pj ? "Razão social" : "Nome completo"}</span> <span class="text-danger">*</span></label>
        <input id="${p}name" class="form-control" autocomplete="off" value="${v(c.name)}"></div>
      <div class="col-md-4${so("PJ")}" data-so="PJ"><label class="form-label" for="${p}fantasia">Nome fantasia</label>
        <input id="${p}fantasia" class="form-control" maxlength="150" value="${v(c.nome_fantasia)}"></div>
      <div class="col-md-4"><label class="form-label" for="${p}nasc" id="${p}lbl-nasc">${pj ? "Data de abertura" : "Data de nascimento"}</label>
        <input type="date" id="${p}nasc" class="form-control" value="${v(String(c.data_nascimento || "").slice(0, 10))}"></div>
      <div class="col-md-4"><label class="form-label" for="${p}status">Status (funil)</label>
        <select id="${p}status" class="form-select">${statusOpts}</select></div>
      <div class="col-md-4"><label class="form-label" for="${p}origem">Como chegou ao escritório</label>
        <select id="${p}origem" class="form-select" data-on-change="_cliOrigemSync">${fichaOpcoes("origem", c.origem, { vazio: "— Não informado —" })}</select></div>
      <div class="col-md-4${indicacao ? "" : " d-none"}" id="${p}wrap-indicado"><label class="form-label" for="${p}indicado">Indicado por</label>
        <input id="${p}indicado" class="form-control" maxlength="150" placeholder="Quem indicou" value="${v(c.indicado_por)}"></div>
    </div>`;

  const pessoais = `
    <div class="row g-3">
      ${txt("rg", "RG", c.rg, "col-md-4")}
      ${txt("orgexp", "Órgão expedidor", c.orgao_expedidor, "col-md-4", ' placeholder="ex.: SSP/AL"')}
      <div class="col-md-4"><label class="form-label" for="${p}sexo">Sexo</label><select id="${p}sexo" class="form-select">${_opcoesTexto(SEXO_OPC, c.sexo)}</select></div>
      <div class="col-md-4"><label class="form-label" for="${p}ecivil">Estado civil</label><select id="${p}ecivil" class="form-select">${_opcoesTexto(ESTADO_CIVIL_OPC, c.estado_civil)}</select></div>
      ${txt("nac", "Nacionalidade", c.nacionalidade, "col-md-4", ' placeholder="ex.: brasileira"')}
      ${txt("prof", "Profissão", c.profissao, "col-md-4")}
      ${txt("pis", "PIS / PASEP", c.pis_pasep, "col-md-6")}
      ${txt("ctps", "CTPS", c.ctps, "col-md-6", ' placeholder="Número / série"')}
    </div>`;

  const contato = `
    <div class="row g-3">
      ${tel("celular", "Celular principal", c.celular || c.phone, "col-md-4")}
      ${tel("wpp", "WhatsApp", c.whatsapp, "col-md-4")}
      ${tel("tel2", "Telefone secundário", c.telefone_secundario, "col-md-4")}
      <div class="col-md-8"><label class="form-label" for="${p}email">E-mail</label>
        <input id="${p}email" type="email" class="form-control" autocomplete="off" value="${v(c.email)}"></div>
    </div>`;

  const endereco = `
    <div class="row g-3">
      <div class="col-md-4"><label class="form-label" for="${p}cep">CEP</label>
        <div class="input-group">
          <input id="${p}cep" class="form-control ficha-num" inputmode="numeric" autocomplete="off" placeholder="00000-000" value="${v(cep)}" data-on-input="fichaMascaraCep" data-on-keydown="acCepEnter">
          <button type="button" id="${p}btn-cep" class="btn btn-outline-secondary" data-on-click="_buscarCep" data-args="${escArgs(p)}" title="Buscar endereço pelo CEP" aria-label="Buscar endereço pelo CEP"><i class="bi bi-search"></i></button>
        </div>
        <div id="${p}cep-dica" class="form-text ficha-aviso" hidden></div></div>
      ${txt("rua", "Rua / logradouro", c.rua, "col-md-8")}
      ${txt("num", "Número", c.numero, "col-md-3")}
      ${txt("compl", "Complemento", c.complemento, "col-md-4")}
      ${txt("bairro", "Bairro", c.bairro, "col-md-5")}
      ${txt("cidade", "Cidade", c.cidade, "col-md-8")}
      <div class="col-md-4"><label class="form-label" for="${p}estado">UF</label><select id="${p}estado" class="form-select">${_opcoesTexto(UF_OPC, c.estado)}</select></div>
    </div>`;

  const outros = `
    <div class="row g-3">
      ${ownerField || ""}
      <div class="col-12"><label class="form-label" for="${p}notes">Observações</label>
        <textarea id="${p}notes" class="form-control" rows="3">${v(c.notes)}</textarea></div>
    </div>`;

  return `<div class="form-compartilhado" data-form-cliente="${p}">
    ${_formSecao("Identificação", identificacao)}
    <div class="${so("PF").trim()}" data-so="PF">${_formSecao("Dados pessoais", pessoais)}</div>
    ${_formSecao("Contato", contato)}
    ${_formSecao("Endereço", endereco)}
    ${_formSecao(ownerField ? "Responsável e observações" : "Observações", outros)}
  </div>`;
}

/** Validação que falhou: toast + campo em vermelho (is-invalid) + foco. O
 *  vermelho sai sozinho quando a pessoa mexe no campo. Devolve null — use
 *  `return _campoInvalido(id, "mensagem")` dentro de quem devolve payload. */
function _campoInvalido(id, msg) {
  toast(msg, true);
  const el = typeof id === "string" ? document.getElementById(id) : id;
  if (el) {
    el.classList.add("is-invalid");
    el.setAttribute("aria-invalid", "true");
    const limpar = () => { el.classList.remove("is-invalid"); el.removeAttribute("aria-invalid"); };
    el.addEventListener("input", limpar, { once: true });
    el.addEventListener("change", limpar, { once: true });
    try { el.focus(); } catch (e) { /* campo escondido */ }
  }
  return null;
}

/** Lê o formulário de cliente → payload (ou null, já avisando o erro).
 *  Campo condicional escondido (PF/PJ) vai como está: escondê-lo não apaga. */
function _clientFormPayload(opts) {
  const p = _pfxForm((opts || {}).pfx);
  const g = (s) => valOpt(p + s);
  const nome = g("name");
  if (!nome) return _campoInvalido(p + "name", g("tipo_pessoa") === "PJ" ? "Informe a razão social" : "Informe o nome do cliente");
  const celular = g("celular");
  const payload = {
    name: nome, tipo_pessoa: g("tipo_pessoa") || null, cpf_cnpj: g("doc"),
    nome_fantasia: g("fantasia"), status: g("status"),
    origem: g("origem") || null, indicado_por: g("indicado"),
    email: g("email"), notes: g("notes"),
    rg: g("rg"), orgao_expedidor: g("orgexp"), data_nascimento: g("nasc") || null,
    sexo: g("sexo"), estado_civil: g("ecivil"), nacionalidade: g("nac"), profissao: g("prof"),
    pis_pasep: g("pis"), ctps: g("ctps"),
    celular, telefone_secundario: g("tel2"), whatsapp: g("wpp"),
    phone: celular,  // mantém compatibilidade com listagens/exportações antigas
    cep: g("cep"), estado: g("estado"), cidade: g("cidade"),
    bairro: g("bairro"), rua: g("rua"), numero: g("num"), complemento: g("compl"),
  };
  if (!payload.status) delete payload.status;   // `status: ""` daria 422 no PUT
  const dono = _ownerFieldValor(p);
  if (dono !== undefined) payload.owner_id = dono;
  return payload;
}

/** AÇÃO: PF ↔ PJ. Também roda quando a máscara do documento marca PJ sozinha. */
function _cliTipoPessoaSync() {
  const el = this instanceof Element ? this : null;
  if (!el) return;
  const p = _pfxDoCampo(el, "tipo_pessoa");
  const pj = el.value === "PJ";
  const raiz = el.closest("[data-form-cliente]") || document;
  raiz.querySelectorAll("[data-so]").forEach((e) => e.classList.toggle("d-none", e.dataset.so !== (pj ? "PJ" : "PF")));
  const txt = (suf, t) => { const e = document.getElementById(p + suf); if (e) e.textContent = t; };
  txt("lbl-doc", pj ? "CNPJ" : "CPF");
  txt("lbl-name", pj ? "Razão social" : "Nome completo");
  txt("lbl-nasc", pj ? "Data de abertura" : "Data de nascimento");
  const doc = document.getElementById(p + "doc");
  if (doc) doc.placeholder = pj ? "00.000.000/0000-00" : "000.000.000-00";
}

/** AÇÃO: "Indicado por" aparece só quando a origem é indicação. */
function _cliOrigemSync() {
  const el = this instanceof Element ? this : null;
  if (!el) return;
  const w = document.getElementById(_pfxDoCampo(el, "origem") + "wrap-indicado");
  if (w) w.classList.toggle("d-none", el.value !== "indicacao");
}

/** Recarrega a lista do módulo SE é ela que está na tela (o modal pode ter
 *  sido aberto de outro lugar; redesenhar a lista ali trocaria a tela). */
function _recarregarListaSeAberta(slug, render) {
  const r = typeof fichaRotaAtual === "function" ? fichaRotaAtual() : null;
  if (r && r.padrao === slug && typeof render === "function") render();
}

/** Modal antigo de cliente (`f-`). A tela nova é a ficha (#/clientes/novo);
 *  este continua funcionando para quem ainda o chama. */
async function clientModal(id) {
  let client = { name: "", status: "lead", owner_id: null };
  if (id) {
    try { client = await api("/api/clients/" + id); }
    catch (e) { toast(e.message, true); return; }
  }
  const ownerField = await _ownerFieldHtml(client.owner_id, "col-md-6", "f-");
  showModal(id ? "Editar cliente" : "Novo cliente", _clientFormHtml(client, ownerField, { pfx: "f-" }), async () => {
    const payload = _clientFormPayload({ pfx: "f-" });
    if (!payload) return;
    const salvo = id
      ? await api("/api/clients/" + id, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/clients", { method: "POST", body: JSON.stringify(payload) });
    if (typeof cacheGarantirCliente === "function") await cacheGarantirCliente(salvo);
    closeModal(); toast("Cliente salvo!");
    _recarregarListaSeAberta("clientes", typeof renderClients === "function" ? renderClients : null);
  }, "Cancelar", "modal-lg");
}

async function deleteClient(id) {
  if (!(await _confirmarExclusao("Excluir este cliente?", "Os processos dele (com prazos e audiências) vão junto. Isso não pode ser desfeito."))) return false;
  try { await api("/api/clients/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return false; }
  if (typeof cacheRemoverCliente === "function") cacheRemoverCliente(id);
  toast("Cliente excluído!");
  _recarregarListaSeAberta("clientes", typeof renderClients === "function" ? renderClients : null);
  return true;
}

/** Confirmação de exclusão: o confirmar() próprio da ficha (não derruba o
 *  modal aberto e não trava a aba como o confirm() nativo); o nativo só se o
 *  ficha.js não carregou. → true quando a pessoa confirmou. */
async function _confirmarExclusao(titulo, texto) {
  if (typeof confirmar === "function") {
    return (await confirmar({ titulo, texto: texto || "Isso não pode ser desfeito.", botao: "Excluir", perigo: true })) === "ok";
  }
  return window.confirm(titulo + (texto ? "\n" + texto : ""));
}

/* ---------------- Processos ---------------- */
// Classes processuais pré-cadastradas (área → subcategorias)
const PROC_CATEGORIAS = {
  civel: { label: "Cível", subs: [
    "Responsabilidade Civil", "Indenização por Danos Morais", "Indenização por Danos Materiais",
    "Indenização por Danos Estéticos", "Cobrança", "Monitória", "Execução de Título Extrajudicial",
    "Execução de Título Judicial", "Cumprimento de Sentença", "Embargos à Execução", "Embargos de Terceiro",
    "Contratos", "Rescisão Contratual", "Revisão Contratual", "Anulação de Contrato", "Obrigação de Fazer",
    "Obrigação de Não Fazer", "Obrigação de Dar", "Consignação em Pagamento", "Prestação de Contas",
    "Despejo", "Ação de Despejo por Falta de Pagamento", "Locação", "Cobrança de Aluguéis",
    "Revisional de Aluguel", "Renovatória de Locação", "Usucapião", "Reintegração de Posse",
    "Manutenção de Posse", "Interdito Proibitório", "Imissão na Posse", "Reivindicatória",
    "Adjudicação Compulsória", "Nunciação de Obra Nova", "Direito de Vizinhança", "Condomínio",
    "Cobrança de Cotas Condominiais", "Acidente de Trânsito", "Responsabilidade Médica",
    "Busca e Apreensão", "Ação Declaratória", "Ação Cautelar", "Despejo Comercial",
  ] },
  trabalhista: { label: "Trabalhista", subs: [
    "Verbas Rescisórias", "Reconhecimento de Vínculo Empregatício", "Horas Extras", "Adicional de Horas Extras",
    "Adicional de Insalubridade", "Adicional de Periculosidade", "Adicional Noturno", "Adicional de Transferência",
    "Equiparação Salarial", "Desvio de Função", "Acúmulo de Função", "Diferenças Salariais",
    "Acidente de Trabalho", "Doença Ocupacional", "Dano Moral Trabalhista", "Assédio Moral",
    "Assédio Sexual", "Rescisão Indireta", "Reversão de Justa Causa", "Estabilidade Gestante",
    "Estabilidade Acidentária", "Estabilidade CIPA", "Reintegração", "FGTS e Multa de 40%",
    "Multa do Art. 477", "Multa do Art. 467", "Intervalo Intrajornada", "Intervalo Interjornada",
    "Salário por Fora", "Comissões", "Gorjetas", "PLR", "Vale-Transporte", "Vale-Refeição/Alimentação",
    "Terceirização", "Grupo Econômico", "Sucessão Trabalhista", "Trabalho Doméstico", "Trabalho Rural",
    "Indenização por Estabilidade", "Pensão Mensal Vitalícia",
  ] },
  previdenciario: { label: "Previdenciário", subs: [
    "Aposentadoria por Idade", "Aposentadoria por Tempo de Contribuição", "Aposentadoria Especial",
    "Aposentadoria por Incapacidade Permanente (Invalidez)", "Aposentadoria Rural", "Aposentadoria Híbrida",
    "Aposentadoria da Pessoa com Deficiência", "Auxílio por Incapacidade Temporária (Auxílio-Doença)",
    "Auxílio-Acidente", "Auxílio-Reclusão", "Pensão por Morte", "Salário-Maternidade",
    "BPC/LOAS - Idoso", "BPC/LOAS - Deficiente", "Benefício Assistencial", "Revisão de Benefício",
    "Revisão da Vida Toda", "Revisão do Teto", "Restabelecimento de Benefício", "Concessão de Benefício",
    "Averbação de Tempo de Contribuição", "Reconhecimento de Atividade Especial", "Reconhecimento de Tempo Rural",
    "Conversão de Tempo Especial em Comum", "Desaposentação", "Renúncia de Aposentadoria",
  ] },
  familia: { label: "Família e Sucessões", subs: [
    "Divórcio Consensual", "Divórcio Litigioso", "Separação", "Reconhecimento de União Estável",
    "Dissolução de União Estável", "Partilha de Bens", "Sobrepartilha", "Guarda", "Guarda Compartilhada",
    "Guarda Unilateral", "Regulamentação de Visitas", "Alienação Parental", "Alimentos",
    "Revisão de Alimentos", "Exoneração de Alimentos", "Execução de Alimentos", "Oferta de Alimentos",
    "Alimentos Gravídicos", "Investigação de Paternidade", "Reconhecimento de Paternidade",
    "Negatória de Paternidade", "Reconhecimento Socioafetivo", "Adoção", "Tutela", "Curatela",
    "Interdição", "Tomada de Decisão Apoiada", "Suprimento de Consentimento", "Inventário",
    "Inventário Extrajudicial", "Arrolamento de Bens", "Testamento", "Petição de Herança",
    "Medida Protetiva (Lei Maria da Penha)", "Mudança de Nome/Retificação de Registro",
  ] },
  consumidor: { label: "Consumidor", subs: [
    "Negativação Indevida", "Inscrição Indevida em Cadastro de Inadimplentes", "Cobrança Indevida",
    "Repetição de Indébito", "Falha na Prestação de Serviço", "Vício do Produto", "Vício do Serviço",
    "Fato do Produto", "Recall", "Garantia Legal/Contratual", "Revisão Contratual",
    "Práticas Abusivas", "Publicidade Enganosa", "Publicidade Abusiva", "Venda Casada",
    "Plano de Saúde - Negativa de Cobertura", "Plano de Saúde - Reajuste Abusivo",
    "Cancelamento de Voo", "Atraso de Voo", "Extravio de Bagagem", "Overbooking",
    "Telefonia/Internet", "Energia Elétrica", "Saneamento/Água", "Tarifas Bancárias",
    "Empréstimo Consignado", "Fraude Bancária", "Golpe do PIX", "Superendividamento",
    "Inadimplemento Contratual", "Rescisão de Contrato de Consumo",
  ] },
  bancario: { label: "Bancário", subs: [
    "Revisão de Contrato Bancário", "Juros Abusivos", "Capitalização de Juros (Anatocismo)",
    "Tarifas Bancárias", "Empréstimo Consignado", "Cartão de Crédito", "Financiamento de Veículo",
    "Busca e Apreensão (Alienação Fiduciária)", "Cédula de Crédito Bancário", "Renegociação de Dívida",
    "Fraude Bancária", "Golpe/Estelionato Bancário", "Descontos Indevidos em Conta",
    "Superendividamento", "Expurgos Inflacionários (Poupança)",
  ] },
  imobiliario: { label: "Imobiliário", subs: [
    "Compra e Venda de Imóvel", "Rescisão de Compromisso de Compra e Venda", "Distrato Imobiliário",
    "Atraso na Entrega de Imóvel", "Adjudicação Compulsória", "Usucapião", "Regularização de Imóvel",
    "Vícios de Construção", "Condomínio", "Cobrança de Cotas Condominiais", "Locação",
    "Despejo", "Renovatória", "Direito de Preferência", "Incorporação Imobiliária",
    "Financiamento Imobiliário (SFH)", "Reintegração de Posse",
  ] },
  tributario: { label: "Tributário", subs: [
    "Execução Fiscal", "Embargos à Execução Fiscal", "Exceção de Pré-Executividade",
    "Anulatória de Débito Fiscal", "Declaratória de Inexistência de Relação Tributária",
    "Repetição de Indébito Tributário", "Compensação Tributária", "Mandado de Segurança",
    "ICMS", "ISS", "IPTU", "IPVA", "ITBI", "ITCMD", "Imposto de Renda", "PIS/COFINS",
    "Contribuição Previdenciária", "Parcelamento Tributário", "Certidão Negativa de Débitos",
    "Exclusão de ICMS da base do PIS/COFINS",
  ] },
  empresarial: { label: "Empresarial", subs: [
    "Recuperação Judicial", "Recuperação Extrajudicial", "Falência", "Cobrança Empresarial",
    "Execução de Título Empresarial", "Duplicata", "Cheque", "Nota Promissória",
    "Dissolução de Sociedade", "Apuração de Haveres", "Conflito entre Sócios",
    "Contratos Empresariais", "Propriedade Industrial/Marcas e Patentes", "Concorrência Desleal",
    "Responsabilidade de Administradores", "Dívidas Empresariais", "Protesto de Título",
  ] },
  administrativo: { label: "Administrativo", subs: [
    "Mandado de Segurança", "Ação contra Ato Administrativo", "Servidor Público", "Concurso Público",
    "Licitações e Contratos", "Improbidade Administrativa", "Responsabilidade Civil do Estado",
    "Desapropriação", "Multa de Trânsito", "CNH (suspensão/cassação)", "Benefício Estatutário",
    "Reintegração de Servidor", "Anulação de Penalidade Administrativa", "Regularização Funcional",
  ] },
  penal: { label: "Penal", subs: [
    "Inquérito Policial", "Ação Penal Pública", "Ação Penal Privada", "Queixa-Crime",
    "Habeas Corpus", "Relaxamento de Prisão", "Liberdade Provisória", "Revogação de Prisão Preventiva",
    "Crimes contra o Patrimônio", "Crimes contra a Pessoa", "Crimes contra a Honra",
    "Crimes de Trânsito", "Lei Maria da Penha", "Tráfico de Drogas", "Crimes Tributários",
    "Estelionato", "Execução Penal", "Progressão de Regime", "Revisão Criminal", "Júri",
  ] },
  outros: { label: "Outros", subs: [] },
};
// Mapa de áreas legadas → nova chave (compatibilidade com dados antigos)
const PROC_AREA_LEGADO = { civil: "civel" };
const PROC_STATUS = ["ativo", "suspenso", "encerrado"];
const PROC_FASES = ["Conhecimento", "Instrução", "Sentença", "Recursal", "Execução", "Cumprimento de Sentença", "Arquivado"];
const PROC_SISTEMAS = ["PJe", "e-Proc", "Projudi", "e-SAJ", "CRETA", "Apolo", "Tucujuris", "Outros"];

function procAreaKey(t) { return PROC_CATEGORIAS[t] ? t : (PROC_AREA_LEGADO[t] || (t ? "outros" : "")); }
function procAreaLabel(t) { const k = procAreaKey(t); return (PROC_CATEGORIAS[k] && PROC_CATEGORIAS[k].label) || (t || "—"); }
function fmtCausa(v) { return (v || v === 0) ? Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—"; }

// ---- Máscara de moeda para campos de valor (exibe 10.000,00) ----
function _fmtMoedaInit(v) {
  return (v == null || v === "") ? "" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
window._maskMoeda = function (el) {
  let d = (el.value || "").replace(/\D/g, "");
  if (!d) { el.value = ""; return; }
  d = String(parseInt(d, 10));
  while (d.length < 3) d = "0" + d;
  const cents = d.slice(-2);
  const ip = d.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  el.value = ip + "," + cents;
};
function _parseMoeda(s) {
  s = (s || "").replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, "");
  return s ? parseFloat(s) : null;
}

/* A lista de Processos (renderProcesses) e a ficha do processo moram em
   ficha-processo.js (SPEC §2.3). Daqui saíram renderProcesses, procRows,
   _procAplicarFiltro e o modal de linha do tempo (processTimeline). */

// Monta o campo de subcategoria conforme a área (select com as subcategorias
// da área, ou texto livre quando a área não tem lista). `pfx` = prefixo do
// formulário — o campo é `${pfx}sub`.
function procSubInner(area, current, pfx) {
  const x = _pfxForm(pfx);
  const cat = PROC_CATEGORIAS[procAreaKey(area)];
  const cur = current === null || current === undefined ? "" : String(current);
  if (!cat || !cat.subs.length) {
    return `<input id="${x}sub" class="form-control" placeholder="Descreva a subcategoria (livre)" value="${esc(cur)}">`;
  }
  return `<select id="${x}sub" class="form-select">${_opcoesTexto(cat.subs, cur, "Selecione…")}</select>`;
}
// Trocou a área → refaz a subcategoria. O prefixo sai do id do próprio select
// (`fp-type` → "fp-"): antes lia `f-type`/`sub-wrap` fixos.
window._procSyncSub = function () {
  const x = _pfxDoCampo(this instanceof Element ? this : null, "type");
  const wrap = document.getElementById(x + "sub-wrap");
  const tipo = document.getElementById(x + "type");
  if (wrap) wrap.innerHTML = procSubInner(tipo ? tipo.value : "", "", x);
};

// Mostra/oculta o campo livre quando o sistema eletrônico é "Outros".
window._procSyncSistema = function () {
  const x = _pfxDoCampo(this instanceof Element ? this : null, "sistema");
  const wrap = document.getElementById(x + "sis-outro-wrap");
  const sel = document.getElementById(x + "sistema");
  if (wrap) wrap.style.display = sel && sel.value === "Outros" ? "block" : "none";
};

/** Argumentos derivados do processo para _processFormHtml:
 *  `{ areaKey, sisSel, sisOutro }` — sistema fora da lista vira "Outros" + texto. */
function _procFormValores(p) {
  const proc = p || {};
  const sis = proc.sistema_eletronico || "";
  const conhecido = PROC_SISTEMAS.includes(sis);
  return {
    areaKey: procAreaKey(proc.type) || "civel",
    sisSel: conhecido ? sis : (sis ? "Outros" : ""),
    sisOutro: conhecido ? "" : sis,
  };
}

/* ---------- Formulário de PROCESSO ----------
   _processFormHtml(p, areaKey, sisSel, sisOutro, ownerField,
                    { pfx = "f-", sistemaObrigatorio = true, clientes })
   - Cliente: `opts.clientes` (padrão CACHE.clients — quem chama garante que
     está carregado). Cliente gravado que NÃO está na lista (processo de um
     cliente de outro responsável) vira opção "(atual)": sem ela o select
     abria em "Selecione…" e o Salvar recusava — o dono do processo não
     conseguia editar o próprio processo.
   - Número CNJ com máscara, dígito verificador e decodificação (preenche o
     tribunal se estiver vazio). Polo do cliente e instância (FICHA_ROTULOS).
   - Valor da causa com máscara de moeda (texto "10.000,00" → 10000).
     🚨 Era `type=number` + parseFloat: com a máscara, "10.000,00" viraria 10. */
function _processFormHtml(p, areaKey, sisSel, sisOutro, ownerField, opts) {
  const o = opts || {};
  const x = _pfxForm(o.pfx);
  const proc = p || {};
  const v = (z) => esc(z === null || z === undefined ? "" : z);
  const sisObrig = o.sistemaObrigatorio !== false;
  const clientes = Array.isArray(o.clientes) ? o.clientes : CACHE.clients;
  const cid = proc.client_id === null || proc.client_id === undefined || proc.client_id === "" ? "" : String(proc.client_id);
  const temCli = clientes.some((c) => String(c.id) === cid);
  // "+ Cadastrar novo cliente…" é AÇÃO, não valor: leva para #/clientes/novo
  // (com a guarda de alteração não salva). Fora do painel do DJEN, que tem o
  // próprio "+" e não pode trocar de tela com a publicação aberta.
  const comNovo = o.novoCliente !== false && typeof irPara === "function" && permCanEdit("clients");
  const cliOpts = `<option value="">Selecione…</option>` +
    (cid && !temCli ? `<option value="${v(cid)}" selected>${v(proc.client_name || "Cliente #" + cid)} (atual)</option>` : "") +
    clientes.map((c) => `<option value="${v(c.id)}"${String(c.id) === cid ? " selected" : ""}>${v(c.name)}</option>`).join("") +
    (comNovo ? `<option value="__novo__" data-ficha-ignorar>+ Cadastrar novo cliente…</option>` : "");
  const area = areaKey || "civel";
  const txt = (id, rotulo, valor, col, extra) => `
    <div class="${col}"><label class="form-label" for="${x}${id}">${rotulo}</label>
      <input id="${x}${id}" class="form-control" value="${v(valor)}"${extra || ""}></div>`;
  _formAgendarInicio(`[data-form-processo="${x}"]`);

  const vinculo = `
    <div class="row g-3">
      <div class="col-md-8"><label class="form-label" for="${x}client">Cliente <span class="text-danger">*</span></label>
        <select id="${x}client" class="form-select" data-on-change="_procClienteNovo" data-prev="${v(cid)}">${cliOpts}</select></div>
      <div class="col-md-4"><label class="form-label" for="${x}polo">Polo do cliente</label>
        <select id="${x}polo" class="form-select">${fichaOpcoes("partePolo", proc.polo_cliente, { vazio: "— Não informado —" })}</select></div>
    </div>`;

  const identificacao = `
    <div class="row g-3">
      <div class="col-md-6"><label class="form-label" for="${x}case">Número do processo (CNJ)</label>
        <input id="${x}case" class="form-control ficha-num" inputmode="numeric" autocomplete="off" data-on-input="fichaMascaraCnj"
          placeholder="0000000-00.0000.0.00.0000" value="${v(fmtCnj(proc.case_number))}"></div>
      <div class="col-md-3"><label class="form-label" for="${x}datadist">Distribuído em</label>
        <input type="date" id="${x}datadist" class="form-control" value="${v(String(proc.data_distribuicao || "").slice(0, 10))}"></div>
      <div class="col-md-3"><label class="form-label" for="${x}status">Status</label>
        <select id="${x}status" class="form-select">${fichaOpcoes("processoStatus", proc.status || "ativo")}</select></div>
      <div class="col-md-6"><label class="form-label" for="${x}type">Área jurídica</label>
        <select id="${x}type" class="form-select" data-on-change="_procSyncSub">${
          Object.keys(PROC_CATEGORIAS).map((k) => `<option value="${k}"${area === k ? " selected" : ""}>${esc(PROC_CATEGORIAS[k].label)}</option>`).join("")}</select></div>
      <div class="col-md-6"><label class="form-label" for="${x}sub">Subcategoria</label>
        <div id="${x}sub-wrap">${procSubInner(area, proc.subcategoria, x)}</div></div>
      ${txt("classe", "Classe processual", proc.classe, "col-md-6")}
      ${txt("assunto", "Assunto", proc.assunto, "col-md-6")}
    </div>`;

  const juizo = `
    <div class="row g-3">
      ${txt("tribunal", "Tribunal", proc.tribunal, "col-md-4", ' placeholder="ex.: TJAL, TRF5, TRT19"')}
      <div class="col-md-4"><label class="form-label" for="${x}instancia">Instância</label>
        <select id="${x}instancia" class="form-select">${fichaOpcoes("instancia", proc.instancia, { vazio: "— Não informada —" })}</select></div>
      ${txt("orgao", "Órgão julgador", proc.orgao_julgador, "col-md-4")}
      ${txt("foro", "Foro / comarca", proc.foro, "col-md-6")}
      ${txt("vara", "Vara", proc.vara, "col-md-6")}
    </div>`;

  const andamento = `
    <div class="row g-3">
      <div class="col-md-4"><label class="form-label" for="${x}fase">Fase processual</label>
        <select id="${x}fase" class="form-select">${_opcoesTexto(PROC_FASES, proc.fase_processual, "—")}</select></div>
      <div class="col-md-4"><label class="form-label" for="${x}valor">Valor da causa</label>
        <div class="input-group"><span class="input-group-text">R$</span>
          <input type="text" inputmode="numeric" id="${x}valor" class="form-control ficha-num" placeholder="0,00" value="${v(_fmtMoedaInit(proc.valor_causa))}" data-on-input="acMaskMoeda"></div></div>
      <div class="col-md-4"><label class="form-label" for="${x}sistema">Sistema processual eletrônico${sisObrig ? ' <span class="text-danger">*</span>' : ' <span class="text-muted fw-normal">(opcional)</span>'}</label>
        <select id="${x}sistema" class="form-select" data-on-change="_procSyncSistema">${_opcoesTexto(PROC_SISTEMAS, sisSel, "Selecione…")}</select>
        <div id="${x}sis-outro-wrap" class="mt-1" style="display:${sisSel === "Outros" ? "block" : "none"}">
          <input id="${x}sistema-outro" class="form-control" placeholder="Informe o sistema utilizado" value="${v(sisOutro)}">
        </div></div>
    </div>`;

  const outros = `
    <div class="row g-3">
      ${ownerField || ""}
      <div class="col-12"><label class="form-label" for="${x}desc">Observações</label>
        <textarea id="${x}desc" class="form-control" rows="3">${v(proc.description)}</textarea></div>
    </div>`;

  return `<div class="form-compartilhado" data-form-processo="${x}">
    ${_formSecao("Cliente", vinculo)}
    ${_formSecao("Identificação", identificacao)}
    ${_formSecao("Juízo", juizo)}
    ${_formSecao("Andamento e valores", andamento)}
    ${_formSecao(ownerField ? "Responsável e observações" : "Observações", outros)}
  </div>`;
}

/** AÇÃO do select de cliente do processo: guarda o último valor escolhido e,
 *  na opção "+ Cadastrar novo cliente…", devolve o select a ele e abre o
 *  cadastro de cliente pelo roteador (irPara pergunta antes se houver
 *  alteração não salva; se a pessoa ficar, nada mudou no formulário). */
function _procClienteNovo() {
  const sel = this instanceof Element ? this : null;
  if (!sel) return;
  if (sel.value !== "__novo__") { sel.dataset.prev = sel.value; return; }
  sel.value = sel.dataset.prev || "";
  irPara("#/clientes/novo");
}

/** Lê o formulário de processo → payload (ou null, já avisando o erro).
 *  opts: { pfx = "f-", sistemaObrigatorio = true } */
function _processFormPayload(opts) {
  const o = opts || {};
  const x = _pfxForm(o.pfx);
  const g = (s) => valOpt(x + s);
  const sisObrig = o.sistemaObrigatorio !== false;
  const clientId = g("client") === "__novo__" ? "" : g("client");
  if (!clientId) return _campoInvalido(x + "client", "Selecione o cliente do processo");
  let sistema = g("sistema");
  if (!sistema && sisObrig) return _campoInvalido(x + "sistema", "Selecione o sistema processual eletrônico");
  if (sistema === "Outros") {
    sistema = g("sistema-outro");
    if (!sistema && sisObrig) return _campoInvalido(x + "sistema-outro", "Informe o nome do sistema (Outros)");
  }
  const payload = {
    client_id: parseInt(clientId, 10), case_number: g("case"),
    type: g("type"), subcategoria: g("sub"), classe: g("classe"),
    assunto: g("assunto"), foro: g("foro"), vara: g("vara"),
    tribunal: g("tribunal"), orgao_julgador: g("orgao"),
    instancia: g("instancia") || null, polo_cliente: g("polo") || null,
    data_distribuicao: g("datadist") || null,
    fase_processual: g("fase"), sistema_eletronico: sistema || null,
    valor_causa: _parseMoeda(g("valor")),
    status: g("status"), description: g("desc"),
  };
  if (!payload.status) delete payload.status;   // `status: ""` daria 422 no PUT
  const dono = _ownerFieldValor(x);
  if (dono !== undefined) payload.owner_id = dono;
  return payload;
}

/** Modal antigo de processo (`f-`). A tela nova é a ficha (#/processos/novo);
 *  este continua funcionando para quem ainda o chama. */
async function processModal(id) {
  let p = { client_id: "", type: "civel", status: "ativo", valor_causa: null, owner_id: null };
  try {
    if (!CACHE.clients.length) CACHE.clients = await api("/api/clients");
    if (id) p = await api("/api/processes/" + id);
  } catch (e) { toast(e.message, true); return; }
  const fv = _procFormValores(p);
  const ownerField = await _ownerFieldHtml(p.owner_id, "col-md-6", "f-");
  showModal(id ? "Editar processo" : "Novo processo",
    _processFormHtml(p, fv.areaKey, fv.sisSel, fv.sisOutro, ownerField, { pfx: "f-" }), async () => {
    const payload = _processFormPayload({ pfx: "f-" });
    if (!payload) return;
    const salvo = id
      ? await api("/api/processes/" + id, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/processes", { method: "POST", body: JSON.stringify(payload) });
    if (typeof cacheGarantirProcesso === "function") await cacheGarantirProcesso(salvo);
    closeModal(); toast("Processo salvo!");
    _recarregarListaSeAberta("processos", typeof renderProcesses === "function" ? renderProcesses : null);
  }, "Cancelar", "modal-lg");
}

async function deleteProcess(id) {
  if (!(await _confirmarExclusao("Excluir este processo?", "Os prazos e as audiências dele vão junto. Isso não pode ser desfeito."))) return false;
  try { await api("/api/processes/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return false; }
  if (typeof cacheRemoverProcesso === "function") cacheRemoverProcesso(id);
  toast("Processo excluído!");
  _recarregarListaSeAberta("processos", typeof renderProcesses === "function" ? renderProcesses : null);
  return true;
}

/* ---------------- Prazos ---------------- */
const URGENCY = { alta: "Alta", media: "Média", baixa: "Baixa" };

/* ---------------------------------------------------------------------
   MODAIS COM CONTEXTO (prazo, audiência, documento, honorário)
   ---------------------------------------------------------------------
   As fichas abrem os mesmos modais das telas de módulo, mas com contexto:
     deadlineModal(id, { clientId, processId, processos, onSaved })
   - processos: lista de ProcessOut que o select pode oferecer (a ficha do
     cliente passa só os processos DELE); sem ela, todos os do usuário;
   - processId / clientId: pré-seleção (registro novo);
   - onSaved(registroSalvo): chamado NO LUGAR do render da tela do módulo —
     sem ele, salvar dentro da ficha trocava a ficha pela tela de Prazos e
     descartava a edição não salva.
   Excluir/cumprir aceitam `opts.onDone()` pelo mesmo motivo. Chamadas antigas
   (sem opts) continuam como eram.
   --------------------------------------------------------------------- */
function _modalOpts(opts) {
  return opts && typeof opts === "object" && !(opts instanceof Event) && !(opts instanceof Element) ? opts : {};
}
/** Processos que o select do modal oferece (ver acima). */
async function _modalProcessos(o) {
  if (Array.isArray(o.processos)) return o.processos;
  if (!CACHE.processes.length) CACHE.processes = await api("/api/processes");
  if (o.clientId) return CACHE.processes.filter((p) => String(p.client_id) === String(o.clientId));
  return CACHE.processes;
}
/** <option>s de processo. O vínculo gravado que não está na lista vira
 *  "(atual)": sem isso o select abria em "Selecione…" e o Salvar recusava
 *  (ou trocava) o processo do registro. */
function _procOpcoes(lista, selecionado, rotuloAtual, vazio) {
  const cur = selecionado === null || selecionado === undefined || selecionado === "" ? "" : String(selecionado);
  const rot = (p) => (p.case_number || "Proc #" + p.id) + (p.client_name ? " — " + p.client_name : "");
  const tem = lista.some((p) => String(p.id) === cur);
  return `<option value="">${esc(vazio || "Selecione…")}</option>` +
    (cur && !tem ? `<option value="${esc(cur)}" selected>${esc(rotuloAtual || "Processo #" + cur)} (atual)</option>` : "") +
    lista.map((p) => `<option value="${esc(p.id)}"${String(p.id) === cur ? " selected" : ""}>${esc(rot(p))}</option>`).join("");
}
/** Depois de gravar: o callback da ficha ou, sem ele, redesenha a tela em
 *  que a pessoa ESTÁ (a da rota atual). Antes o padrão era fixo pelo modal —
 *  um prazo salvo a partir do calendário da Agenda trocava a Agenda pela tela
 *  de Prazos. Ficha/caso aberto sem callback não é trocado por uma lista.
 *  `padrao` só vale se o roteador (ficha.js) não carregou. Um callback que
 *  falha não vira "erro ao salvar" (a gravação deu certo). */
function _depoisDe(fn, padrao, ...args) {
  if (typeof fn === "function") {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === "function") r.catch((e) => console.warn("[modal] callback falhou", e));
    } catch (e) { console.warn("[modal] callback falhou", e); }
    return;
  }
  const rota = typeof fichaRotaAtual === "function" ? fichaRotaAtual() : null;
  if (rota && rota.rota) {
    if (rota.rota.abrir) return;
    const tela = _telasApp()[rota.rota.view];
    if (typeof tela === "function") tela();
    return;
  }
  if (typeof padrao === "function") padrao();
}
/** Classe de urgência só de LISTA FECHADA (o valor vem do banco e vira classe). */
function _urgClasse(u) {
  return Object.prototype.hasOwnProperty.call(URGENCY, u) ? "badge-urgency-" + u : "bg-secondary";
}

async function renderDeadlines() {
  const c = document.getElementById("view-container");
  try {
    const deadlines = await api("/api/deadlines");
    CACHE.processes = await api("/api/processes");
    c.innerHTML = `
      <div class="d-flex justify-content-end mb-3">
        <button class="btn btn-primary" data-on-click="deadlineModal"><i class="bi bi-plus-lg"></i> Novo prazo</button>
      </div>
      <div class="card shadow-sm"><div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead><tr><th>Descrição</th><th>Processo</th><th>Data</th><th>Restam</th><th>Urgência</th><th>Status</th><th></th></tr></thead>
          <tbody>${deadlines.length?deadlines.map(d=>`
            <tr class="${d.done?'table-light text-muted':''}">
              <td>${esc(d.description)}</td>
              <td><small>${esc(d.process_label||"")}</small></td>
              <td>${fmtDate(d.date)}</td>
              <td class="${d.days_left<0?'deadline-overdue':d.days_left<=7?'deadline-soon':''}">${d.done?'—':d.days_left<0?'Vencido':d.days_left+' dias'}</td>
              <td><span class="badge ${_urgClasse(d.urgency_level)}">${esc(URGENCY[d.urgency_level]||d.urgency_level)}</span></td>
              <td>${d.done?'<span class="badge bg-success">Cumprido</span>':'<span class="badge bg-warning text-dark">Pendente</span>'}</td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-success" title="Marcar cumprido" data-on-click="toggleDeadline" data-args="${escArgs(d.id, d.done?0:1)}"><i class="bi bi-check2"></i></button>
                <button class="btn btn-sm btn-outline-primary" data-on-click="deadlineModal" data-args="${escArgs(d.id)}"><i class="bi bi-pencil"></i></button>
                ${permPodeExcluir() ? `<button class="btn btn-sm btn-outline-danger" data-on-click="deleteDeadline" data-args="${escArgs(d.id)}"><i class="bi bi-trash"></i></button>` : ""}
              </td>
            </tr>`).join(""):'<tr><td colspan="7" class="text-center text-muted py-3">Nenhum prazo.</td></tr>'}
          </tbody>
        </table>
      </div></div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function deadlineModal(id, opts) {
  const o = _modalOpts(opts);
  let d = { process_id: o.processId || "", date: "", description: "", urgency_level: "media" };
  let lista;
  try {
    lista = await _modalProcessos(o);
    if (id) d = await api("/api/deadlines/" + id);
  } catch (e) { toast(e.message, true); return; }
  if (!id && !d.process_id && lista.length === 1) d.process_id = lista[0].id;
  const semProcesso = !lista.length && !d.process_id;
  showModal(id ? "Editar prazo" : "Novo prazo", `
    <div class="mb-2"><label class="form-label" for="f-proc">Processo*</label>
      <select id="f-proc" class="form-select">${_procOpcoes(lista, d.process_id, d.process_label)}</select>
      ${semProcesso ? '<div class="form-text">Ainda não há processo para lançar o prazo — cadastre o processo primeiro.</div>' : ""}</div>
    <div class="mb-2"><label class="form-label" for="f-desc">Descrição*</label><input id="f-desc" class="form-control" value="${esc(d.description)}"></div>
    <div class="row">
      <div class="col"><label class="form-label" for="f-date">Data*</label><input type="date" id="f-date" class="form-control" value="${esc(d.date || "")}"></div>
      <div class="col"><label class="form-label" for="f-urg">Urgência</label>
        <select id="f-urg" class="form-select">${Object.entries(URGENCY).map(([k,v])=>`<option value="${k}" ${d.urgency_level===k?'selected':''}>${v}</option>`).join("")}</select></div>
    </div>
    <div class="border rounded p-2 mt-2" style="background:var(--surface-2)">
      <div class="small fw-semibold text-primary mb-1"><i class="bi bi-calculator"></i> Calcular prazo a partir de uma data</div>
      <div class="row g-2 align-items-end">
        <div class="col"><label class="form-label small mb-0" for="f-calc-base">Data base</label><input type="date" id="f-calc-base" class="form-control form-control-sm"></div>
        <div class="col-3"><label class="form-label small mb-0" for="f-calc-dias">Dias</label><input type="number" min="1" id="f-calc-dias" class="form-control form-control-sm"></div>
        <div class="col"><label class="form-label small mb-0" for="f-calc-tipo">Tipo</label>
          <select id="f-calc-tipo" class="form-select form-select-sm"><option value="uteis">Úteis</option><option value="corridos">Corridos</option></select></div>
        <div class="col-auto"><button type="button" class="btn btn-sm btn-outline-primary" data-on-click="calcularPrazo">Calcular</button></div>
      </div>
      <div class="small text-muted mt-1">Considera fins de semana, feriados nacionais e suspensão do CPC (20/12–20/01). Confira sempre o prazo final.</div>
    </div>
  `, async () => {
    const procId = val("f-proc");
    if (!procId || !val("f-desc") || !val("f-date")) return toast("Preencha os campos obrigatórios: processo, descrição e data.", true);
    const payload = { process_id: parseInt(procId, 10), description: val("f-desc"), date: val("f-date"), urgency_level: val("f-urg") };
    const salvo = id
      ? await api("/api/deadlines/" + id, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/deadlines", { method: "POST", body: JSON.stringify(payload) });
    closeModal(); toast("Prazo salvo!");
    _depoisDe(o.onSaved, renderDeadlines, salvo);
  });
}

async function calcularPrazo() {
  const base = val("f-calc-base"), dias = val("f-calc-dias"), tipo = val("f-calc-tipo");
  if (!base || !dias) return toast("Informe a data base e o número de dias", true);
  try {
    const r = await api(`/api/deadlines/calcular?base=${base}&dias=${parseInt(dias)}&tipo=${tipo}`);
    document.getElementById("f-date").value = r.data;
    toast("Prazo calculado para " + fmtDate(r.data));
  } catch (e) { toast(e.message, true); }
}

/** Marca/desmarca "cumprido". → true quando gravou. opts.onDone no lugar do
 *  render da tela de Prazos (ver "MODAIS COM CONTEXTO"). */
async function toggleDeadline(id, done, opts) {
  const o = _modalOpts(opts);
  const feito = done ? 1 : 0;
  try { await api("/api/deadlines/" + id, { method: "PUT", body: JSON.stringify({ done: feito }) }); }
  catch (e) { toast(e.message, true); return false; }
  toast(feito ? "Prazo marcado como cumprido." : "Prazo reaberto.");
  _depoisDe(o.onDone, renderDeadlines);
  return true;
}
async function deleteDeadline(id, opts) {
  const o = _modalOpts(opts);
  if (!(await _confirmarExclusao("Excluir este prazo?"))) return false;
  try { await api("/api/deadlines/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return false; }
  toast("Prazo excluído!");
  _depoisDe(o.onDone, renderDeadlines);
  return true;
}

/* ---------------- Agenda / Audiências ---------------- */
let agendaView = "calendario";
let agendaRef = new Date();

async function renderAppointments() {
  const c = document.getElementById("view-container");
  try {
    const appts = await api("/api/appointments");
    const deadlines = await api("/api/deadlines");
    CACHE.processes = await api("/api/processes");
    c.innerHTML = `
      <div class="section-toolbar">
        <div class="seg" id="agenda-seg">
          <button data-v="calendario">Calendário</button>
          <button data-v="lista">Lista</button>
        </div>
        <button class="btn btn-primary ms-auto" data-on-click="appointmentModal"><i class="bi bi-plus-lg"></i> Nova audiência</button>
      </div>
      <div id="agenda-body"></div>`;
    document.querySelectorAll("#agenda-seg button").forEach(b => {
      b.classList.toggle("active", b.dataset.v === agendaView);
      b.addEventListener("click", () => { agendaView = b.dataset.v; renderAppointments(); });
    });
    document.getElementById("agenda-body").innerHTML =
      agendaView === "lista" ? agendaListaHTML(appts) : agendaCalendarHTML(appts, deadlines);
  } catch (e) { c.innerHTML = errorBox(e); }
}

function agendaListaHTML(appts) {
  return `<div class="card"><div class="table-responsive">
    <table class="table table-hover mb-0">
      <thead><tr><th>Data e hora</th><th>Processo</th><th>Local</th><th>Observações</th><th></th></tr></thead>
      <tbody>${appts.length ? appts.map(a => `
        <tr>
          <td class="text-nowrap"><strong>${fmtDateTime(a.date_time)}</strong></td>
          <td><small>${esc(a.process_label || "")}</small></td>
          <td>${esc(a.location)}</td>
          <td><small>${esc(a.notes || "")}</small></td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-primary" data-on-click="appointmentModal" data-args="${escArgs(a.id)}"><i class="bi bi-pencil"></i></button>
            ${permPodeExcluir() ? `<button class="btn btn-sm btn-outline-danger" data-on-click="deleteAppointment" data-args="${escArgs(a.id)}"><i class="bi bi-trash"></i></button>` : ""}
          </td>
        </tr>`).join("") : '<tr><td colspan="5" class="text-center text-muted py-3">Nenhuma audiência.</td></tr>'}
      </tbody>
    </table>
  </div></div>`;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function agendaMonthShift(delta) {
  agendaRef = new Date(agendaRef.getFullYear(), agendaRef.getMonth() + delta, 1);
  renderAppointments();
}

function agendaCalendarHTML(appts, deadlines) {
  const y = agendaRef.getFullYear(), m = agendaRef.getMonth();
  const monthName = new Date(y, m, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const byDay = {};
  const addEv = (key, html) => { (byDay[key] = byDay[key] || []).push(html); };
  appts.forEach(a => {
    if (!a.date_time) return;
    const d = new Date(a.date_time);
    const hh = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    addEv(ymd(d), `<span class="cal-ev aud" title="${esc(a.location || "Audiência")}" data-on-click="appointmentModal" data-args="${escArgs(a.id)}">${hh} ${esc(a.location || "Audiência")}</span>`);
  });
  deadlines.forEach(d => {
    if (!d.date || d.done) return;
    addEv(d.date, `<span class="cal-ev prz" title="${esc(d.description)}" data-on-click="deadlineModal" data-args="${escArgs(d.id)}">${esc(d.description)}</span>`);
  });
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayKey = ymd(new Date());
  const dows = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell muted"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = ymd(new Date(y, m, day));
    const evs = byDay[key] || [];
    const shown = evs.slice(0, 3).join("");
    const more = evs.length > 3 ? `<span class="small text-muted">+${evs.length - 3}</span>` : "";
    cells += `<div class="cal-cell ${key === todayKey ? "today" : ""}"><div class="cal-daynum">${day}</div>${shown}${more}</div>`;
  }
  return `
    <div class="card lift"><div class="card-body">
      <div class="cal-header">
        <button class="btn btn-sm btn-outline-secondary" data-on-click="agendaMonthShift" data-args="${escArgs(-1)}"><i class="bi bi-chevron-left"></i></button>
        <strong class="text-capitalize">${monthName}</strong>
        <button class="btn btn-sm btn-outline-secondary" data-on-click="agendaMonthShift" data-args="${escArgs(1)}"><i class="bi bi-chevron-right"></i></button>
      </div>
      <div class="cal-grid">${dows.map(d => `<div class="cal-dow">${d}</div>`).join("")}${cells}</div>
      <div class="small text-muted mt-2"><span class="badge" style="background:#2c5282">Audiências</span> <span class="badge ms-1" style="background:#c05621">Prazos</span></div>
    </div></div>`;
}

async function appointmentModal(id, opts) {
  const o = _modalOpts(opts);
  let a = { process_id: o.processId || "", date_time: "", location: "", notes: "" };
  let lista;
  try {
    lista = await _modalProcessos(o);
    if (id) a = await api("/api/appointments/" + id);
  } catch (e) { toast(e.message, true); return; }
  if (!id && !a.process_id && lista.length === 1) a.process_id = lista[0].id;
  const semProcesso = !lista.length && !a.process_id;
  const dtValue = a.date_time ? String(a.date_time).slice(0, 16) : "";
  showModal(id ? "Editar audiência" : "Nova audiência", `
    <div class="mb-2"><label class="form-label" for="f-proc">Processo*</label>
      <select id="f-proc" class="form-select">${_procOpcoes(lista, a.process_id, a.process_label)}</select>
      ${semProcesso ? '<div class="form-text">Ainda não há processo para marcar a audiência — cadastre o processo primeiro.</div>' : ""}</div>
    <div class="mb-2"><label class="form-label" for="f-dt">Data e hora*</label><input type="datetime-local" id="f-dt" class="form-control" value="${esc(dtValue)}"></div>
    <div class="mb-2"><label class="form-label" for="f-loc">Local</label><input id="f-loc" class="form-control" value="${esc(a.location)}"></div>
    <div class="mb-2"><label class="form-label" for="f-notes">Observações</label><textarea id="f-notes" class="form-control">${esc(a.notes)}</textarea></div>
  `, async () => {
    const procId = val("f-proc");
    if (!procId || !val("f-dt")) return toast("Selecione o processo e a data/hora", true);
    const payload = { process_id: parseInt(procId, 10), date_time: val("f-dt"), location: val("f-loc"), notes: val("f-notes") };
    const salvo = id
      ? await api("/api/appointments/" + id, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/appointments", { method: "POST", body: JSON.stringify(payload) });
    closeModal(); toast("Audiência salva!");
    _depoisDe(o.onSaved, renderAppointments, salvo);
  });
}

async function deleteAppointment(id, opts) {
  const o = _modalOpts(opts);
  if (!(await _confirmarExclusao("Excluir esta audiência?"))) return false;
  try { await api("/api/appointments/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return false; }
  toast("Audiência excluída!");
  _depoisDe(o.onDone, renderAppointments);
  return true;
}

/* ---------------- Documentos ---------------- */
async function renderDocuments() {
  const c = document.getElementById("view-container");
  try {
    const docs = await api("/api/documents");
    CACHE.clients = await api("/api/clients");
    CACHE.processes = await api("/api/processes");
    const clientName = (cid) => { const x = CACHE.clients.find(c=>c.id===cid); return x?x.name:""; };
    const procLabel = (pid) => { const x = CACHE.processes.find(p=>p.id===pid); return x?(x.case_number||'Proc #'+x.id):""; };
    c.innerHTML = `
      <div class="d-flex justify-content-end gap-2 mb-3">
        <button class="btn btn-outline-primary" data-on-click="modeloModal"><i class="bi bi-file-earmark-word"></i> Gerar documento</button>
        <button class="btn btn-primary" data-on-click="documentModal"><i class="bi bi-upload"></i> Enviar documento</button>
      </div>
      <div class="card shadow-sm"><div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead><tr><th>Arquivo</th><th>Cliente</th><th>Processo</th><th>Enviado em</th><th></th></tr></thead>
          <tbody>${docs.length?docs.map(d=>`
            <tr>
              <td><i class="bi bi-file-earmark-text"></i> ${esc(d.original_name)}</td>
              <td>${esc(clientName(d.client_id))||"—"}</td>
              <td>${esc(procLabel(d.process_id))||"—"}</td>
              <td>${_fmtCarimbo(d.uploaded_at)}</td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-primary" data-on-click="downloadDoc" data-args="${escArgs(d.id, d.original_name)}"><i class="bi bi-download"></i></button>
                ${permPodeExcluir() ? `<button class="btn btn-sm btn-outline-danger" data-on-click="deleteDocument" data-args="${escArgs(d.id)}"><i class="bi bi-trash"></i></button>` : ""}
              </td>
            </tr>`).join(""):'<tr><td colspan="5" class="text-center text-muted py-3">Nenhum documento.</td></tr>'}
          </tbody>
        </table>
      </div></div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

/** Enviar documento. opts: { clientId, processId, processos, onSaved }.
 *  Com `processId` o documento vai SÓ com process_id — o backend deriva o
 *  cliente do processo (mandar outro client_id dá 400, e o dono do processo
 *  pode não ser o dono do cliente). Com `clientId` o cliente fica fixo e o
 *  select de processo mostra só os processos dele. */
async function documentModal(opts) {
  const o = _modalOpts(opts);
  let lista;
  try {
    if (!o.processId && !CACHE.clients.length) CACHE.clients = await api("/api/clients");
    lista = await _modalProcessos(o);
  } catch (e) { toast(e.message, true); return; }
  const procFixo = o.processId ? (lista.find((p) => String(p.id) === String(o.processId)) || { id: o.processId }) : null;
  const cliFixo = !procFixo && o.clientId ? String(o.clientId) : "";
  const cliAtual = cliFixo ? CACHE.clients.find((c) => String(c.id) === cliFixo) : null;
  const categorias = `<option value="">— Sem categoria —</option>` +
    Object.entries(PREC_DOC_CAT).map(([k, r]) => `<option value="${k}">${esc(r)}</option>`).join("");
  const vinculo = procFixo
    ? `<div class="mb-2"><span class="form-label d-block">Processo</span>
         <div class="form-control-plaintext py-1"><i class="bi bi-folder2-open" aria-hidden="true"></i> ${esc(procFixo.case_number || "Processo #" + procFixo.id)}${procFixo.client_name ? ` <span class="text-muted">— ${esc(procFixo.client_name)}</span>` : ""}</div>
         <div class="form-text">O documento fica no processo e aparece também na ficha do cliente.</div></div>`
    : `<div class="mb-2"><label class="form-label" for="f-client">Cliente</label>
         <select id="f-client" class="form-select"${cliFixo ? " disabled" : ""}><option value="">Nenhum</option>
           ${cliFixo && !cliAtual ? `<option value="${esc(cliFixo)}" selected>Cliente #${esc(cliFixo)}</option>` : ""}
           ${CACHE.clients.map((c) => `<option value="${esc(c.id)}"${String(c.id) === cliFixo ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
       <div class="mb-2"><label class="form-label" for="f-proc">Processo</label>
         <select id="f-proc" class="form-select">${_procOpcoes(lista, "", "", cliFixo ? "Nenhum (só o cliente)" : "Nenhum")}</select></div>`;
  showModal("Enviar documento", `
    ${procFixo ? "" : '<p class="text-muted small">Vincule o documento a um cliente e/ou processo.</p>'}
    <div class="mb-2"><label class="form-label" for="f-file">Arquivo*</label><input type="file" id="f-file" class="form-control"></div>
    <div class="mb-2"><label class="form-label" for="f-cat">Categoria</label><select id="f-cat" class="form-select">${categorias}</select></div>
    ${vinculo}
  `, async () => {
    const fileInput = document.getElementById("f-file");
    if (!fileInput.files.length) return toast("Selecione um arquivo", true);
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    const cat = val("f-cat");
    if (cat) fd.append("categoria", cat);
    if (procFixo) {
      fd.append("process_id", String(procFixo.id));
    } else {
      const clientId = cliFixo || valOpt("f-client");
      const procId = valOpt("f-proc");
      if (!clientId && !procId) return toast("Vincule a um cliente ou processo", true);
      if (procId) fd.append("process_id", procId);
      // Com processo escolhido, o cliente vem DO processo. Na ficha do cliente
      // (cliente fixo) só o processo vai; na tela de Documentos o cliente vai
      // junto para o backend recusar a combinação errada (400) em vez de gravar
      // o documento na ficha de outro cliente.
      if (clientId && (!procId || !cliFixo)) fd.append("client_id", clientId);
    }
    const salvo = await api("/api/documents", { method: "POST", body: fd });
    closeModal(); toast("Documento enviado!");
    _depoisDe(o.onSaved, renderDocuments, salvo);
  });
}

/** Baixa o anexo. O disco do Render é EFÊMERO: o registro
 *  pode sobreviver ao arquivo. Antes, o JSON do erro era baixado como se
 *  fosse o "contrato.pdf"; agora a resposta é conferida. */
async function downloadDoc(id, name) {
  let res;
  try { res = await fetch(API + "/api/documents/" + id + "/download", { headers: { Authorization: "Bearer " + TOKEN } }); }
  catch (e) { toast("Não foi possível baixar o arquivo.", true); return false; }
  if (!res.ok) {
    toast(res.status === 404 ? "O arquivo não está mais no servidor — anexos não são permanentes." : "Não foi possível baixar o arquivo.", true);
    return false;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name || "documento"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
async function deleteDocument(id, opts) {
  const o = _modalOpts(opts);
  if (!(await _confirmarExclusao("Excluir este documento?"))) return false;
  try { await api("/api/documents/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return false; }
  toast("Documento excluído!");
  _depoisDe(o.onDone, renderDocuments);
  return true;
}

/* ---------------- Funil (Pipeline) ---------------- */
const PIPELINE_ORDER = ["lead", "negociacao", "ativo", "arquivado"];

async function renderPipeline() {
  const c = document.getElementById("view-container");
  try {
    const board = await api("/api/pipeline");
    c.innerHTML = `<div class="pipeline-board">${board.map((col, idx)=>`
      <div class="pipeline-column">
        <h6>${esc(col.label)} <span class="badge bg-primary">${col.count}</span></h6>
        ${col.clients.map(cl=>`
          <div class="pipeline-card">
            <strong>${esc(cl.name)}</strong>
            <div class="small text-muted">${esc(cl.phone||"")}</div>
            <div class="move-btns mt-1">
              ${idx>0?`<button class="btn btn-outline-secondary" title="Voltar" data-on-click="movePipeline" data-args="${escArgs(cl.id, PIPELINE_ORDER[idx-1])}"><i class="bi bi-arrow-left"></i></button>`:''}
              ${idx<PIPELINE_ORDER.length-1?`<button class="btn btn-outline-primary" title="Avançar" data-on-click="movePipeline" data-args="${escArgs(cl.id, PIPELINE_ORDER[idx+1])}"><i class="bi bi-arrow-right"></i></button>`:''}
            </div>
          </div>`).join("") || '<p class="text-muted small">Vazio</p>'}
      </div>`).join("")}</div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function movePipeline(clientId, stage) {
  try { await api(`/api/pipeline/${encodeURIComponent(clientId)}?stage=${encodeURIComponent(stage)}`, { method: "PUT" }); }
  catch (e) { toast(e.message, true); return; }
  renderPipeline();
}

/* ---------------- Utilitários de UI ---------------- */
function val(id) { return document.getElementById(id).value.trim(); }

/** Modal único do app (#modal-container).
 *    showModal(titulo, corpoHtml, onSave, closeLabel = "Cancelar", size = "")
 *    showModal(titulo, corpoHtml, onSave, { rotuloSalvar, rotuloFechar, tamanho, focar })
 *  - size/tamanho: "" | "modal-lg" | "modal-xl";
 *  - rotuloSalvar: texto do botão de salvar (padrão "Salvar") — ex.:
 *    "Gerar e baixar (.docx)"; rotuloFechar: o do botão de fechar
 *    (padrão "Cancelar"). Os dois são TEXTO (escapados aqui);
 *  - focar:false desliga o foco automático. Por padrão, ao abrir, o foco vai
 *    para o primeiro campo editável do corpo (antes ficava no modal inteiro e
 *    a pessoa precisava clicar no campo para começar a digitar).
 *  A forma antiga (4º e 5º parâmetros em texto) continua valendo. */
function showModal(title, bodyHtml, onSave, closeLabel = "Cancelar", size = "") {
  const op = closeLabel && typeof closeLabel === "object" ? closeLabel : { rotuloFechar: closeLabel, tamanho: size };
  const fechar = op.rotuloFechar === undefined || op.rotuloFechar === null ? "Cancelar" : String(op.rotuloFechar);
  const tam = ["modal-lg", "modal-xl", "modal-sm"].includes(op.tamanho || op.size) ? (op.tamanho || op.size) : "";
  const saveBtn = onSave ? `<button type="button" class="btn btn-primary" id="modal-save">${esc(op.rotuloSalvar || "Salvar")}</button>` : "";
  document.getElementById("modal-container").innerHTML = `
    <div class="modal fade" id="app-modal" tabindex="-1">
      <div class="modal-dialog ${tam} modal-dialog-centered modal-dialog-scrollable"><div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button></div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${esc(fechar)}</button>${saveBtn}
        </div>
      </div></div>
    </div>`;
  const modalEl = document.getElementById("app-modal");
  const modal = new bootstrap.Modal(modalEl);
  modalEl._instance = modal;
  if (op.focar !== false) {
    modalEl.addEventListener("shown.bs.modal", () => {
      // Só se o foco ainda está no próprio modal (quem abriu pode ter focado algo).
      if (document.activeElement && document.activeElement !== modalEl && modalEl.contains(document.activeElement)) return;
      const campo = [...modalEl.querySelectorAll(".modal-body input, .modal-body select, .modal-body textarea")]
        .find((el) => el.type !== "hidden" && !el.disabled && !el.readOnly && el.getClientRects().length);
      if (campo) { try { campo.focus({ preventScroll: false }); } catch (e) { /* campo sumiu */ } }
    }, { once: true });
  }
  if (onSave) {
    const btn = document.getElementById("modal-save");
    btn.addEventListener("click", async () => {
      // Duplo clique criava o registro duas vezes (o POST demora e o botão
      // continuava ativo). Desabilita enquanto grava e reabilita SEMPRE no
      // finally: várias validações saem com `return toast(...)`, que não
      // lança — se só reabilitasse no erro, o Salvar ficaria travado em
      // "Salvando…" depois do primeiro campo esquecido.
      if (btn.disabled) return;
      const rotulo = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Salvando…';
      try { await onSave(); } catch (e) { toast(e.message, true); }
      finally { btn.disabled = false; btn.innerHTML = rotulo; }
    });
  }
  modal.show();
}
function closeModal() {
  const el = document.getElementById("app-modal");
  if (el && el._instance) el._instance.hide();
}
function errorBox(e) { return `<div class="alert alert-danger">Erro: ${esc(e.message)}</div>`; }

/* ============================================================
   DASHBOARD EXECUTIVO (Fase 2) — é o ÚNICO renderDashboard() desde
   out/2026 (a versão antiga, que esta sobrescrevia por hoisting, foi apagada).
   ============================================================ */
window._exCharts = window._exCharts || [];
var exPeriod = "mes";
var exAdv = "";
function _exDestroy(){ (window._exCharts||[]).forEach(c=>{ try{ c.destroy(); }catch(_){}}); window._exCharts = []; }
function _exChart(id, cfg){ const el = document.getElementById(id); if(!el || typeof Chart==="undefined") return; try{ const ch = new Chart(el, cfg); window._exCharts.push(ch); return ch; }catch(_){} }
function _exBaseOpts(extra){ return Object.assign({ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true, ticks:{ precision:0 }, grid:{ color:"rgba(130,150,180,.15)" } }, x:{ grid:{ display:false } } } }, extra||{}); }
function _exKpi(icon,value,label,color){ return `<div class="col-6 col-lg-3"><div class="card stat-card lift h-100" style="border-top:3px solid ${color}"><div class="card-body py-3"><div class="d-flex align-items-center gap-2"><i class="bi ${icon}" style="font-size:1.35rem;color:${color}"></i><div><div style="font-size:1.4rem;font-weight:700;line-height:1;font-family:Sora,system-ui,sans-serif">${value}</div><div class="text-muted" style="font-size:.76rem">${label}</div></div></div></div></div></div>`; }
function _exH(title,icon){ return `<h6 class="mt-4 mb-2" style="font-family:Sora,system-ui,sans-serif"><i class="bi ${icon} me-1" style="color:var(--gold)"></i> ${title}</h6>`; }
function _exCanvas(id,h){ return `<div class="card lift chart-card"><div style="height:${h||220}px"><canvas id="${id}"></canvas></div></div>`; }

const EX_COL = { navy:"#2f6699", navyD:"#163a5f", gold:"#c9a14a", ok:"#3fca8b", warn:"#e8b84b", bad:"#e5695f", blue:"#4f9bd8", violet:"#8b5cff" };
const EX_SEV = { bad:"danger", warn:"warning", info:"primary", ok:"success" };

async function renderDashboard(){
  const c = document.getElementById("view-container");
  const admin = CURRENT_USER.role === "admin";
  try {
    let advOpts = "";
    if (admin) {
      try {
        // `colegas` devolve só id/nome/papel — que é tudo que o select usa.
        // A rota /api/auth/users existe, mas mandaria e-mail, permissões e
        // avatar de cada usuário só para preencher um dropdown.
        const users = await api("/api/auth/colegas");
        advOpts = `<option value="">Todos os advogados</option>` +
          (users||[]).map(u=>`<option value="${u.id}" ${String(u.id)===String(exAdv)?"selected":""}>${esc(u.name)}</option>`).join("");
      } catch(e){
        // Sem o filtro o painel ainda serve, então a falha não derruba a tela —
        // mas ela DEIXA RASTRO. Um catch mudo aqui escondeu por meses o select
        // vazio de um /api/users que nunca existiu (a rota é /api/auth/*).
        console.warn("Dashboard: não foi possível carregar a lista de advogados.", e);
        advOpts = "";
      }
    }
    const d = await api("/api/dashboard/executive?period="+exPeriod+(admin&&exAdv?("&advogado_id="+exAdv):""));
    const cd = d.cards||{}, co = d.comercial||{}, ju = d.juridica||{}, fi = d.financeiro||{}, ag = d.agenda||{};
    // Estagiário (e quem perdeu o módulo) não vê nada de dinheiro no painel.
    const verFin = permCanView("financeiro");
    co.funil = co.funil||[]; co.serie = co.serie||{labels:[],novos:[],convertidos:[]}; co.leads_por_area = co.leads_por_area||[];
    ju.processos_por_area = ju.processos_por_area||[]; ju.precatorios_por_classificacao = ju.precatorios_por_classificacao||[]; ju.processos_por_tribunal = ju.processos_por_tribunal||[];
    fi.serie = fi.serie||{labels:[],contratado:[],recebido:[]}; fi.receita_por_area = fi.receita_por_area||[];

    // -------- Barra de filtros --------
    let html = `
      <div class="card lift mb-3"><div class="card-body py-2 d-flex flex-wrap gap-2 align-items-center justify-content-between">
        <div class="seg" id="ex-seg">
          <button data-p="hoje">Hoje</button><button data-p="7d">7 dias</button>
          <button data-p="mes">Mês</button><button data-p="ano">Ano</button>
        </div>
        <div class="d-flex gap-2 align-items-center">
          ${admin && advOpts ? `<select id="ex-adv" class="form-select form-select-sm" style="min-width:190px">${advOpts}</select>` : ""}
          <span class="badge ${admin?'bg-warning text-dark':'bg-primary'}">${admin?'Administrador':'Meu painel'}</span>
        </div>
      </div></div>`;

    // -------- Bloco 1 · Cards --------
    html += `<div class="row g-3">
      ${_exKpi("bi-people", cd.clientes_ativos, "Clientes ativos", EX_COL.navy)}
      ${_exKpi("bi-folder2-open", cd.processos_ativos, "Processos ativos", EX_COL.blue)}
      ${_exKpi("bi-cash-coin", cd.precatorios_ativos, "Precatórios ativos", EX_COL.gold)}
      ${verFin ? _exKpi("bi-graph-up-arrow", fmtMoney(cd.receita_periodo), "Receita do período", EX_COL.ok) : ""}
      ${_exKpi("bi-alarm", cd.prazos_criticos_72h, "Prazos críticos (72h)", cd.prazos_criticos_72h?EX_COL.bad:EX_COL.navy)}
      ${verFin ? _exKpi("bi-hourglass-split", fmtMoney(cd.honorarios_pendentes), "Honorários pendentes", EX_COL.warn) : ""}
      ${_exKpi("bi-person-plus", cd.novos_clientes, "Novos clientes (período)", EX_COL.violet)}
      ${_exKpi("bi-people-fill", co.taxa_conversao+"%", "Taxa de conversão", EX_COL.navy)}
    </div>`;

    // -------- Bloco 7 · Insights (topo, alta prioridade) --------
    if ((d.insights||[]).length){
      html += _exH("Insights", "bi-robot") + `<div class="row g-2">` +
        d.insights.map(i=>`<div class="col-md-6 col-lg-4"><div class="card lift h-100" style="border-left:3px solid var(--bs-${EX_SEV[i.sev]||'primary'})"><div class="card-body py-2 d-flex gap-2 align-items-start">
          <i class="bi bi-lightbulb text-${EX_SEV[i.sev]||'primary'}"></i>
          <div><div style="font-size:.86rem">${esc(i.texto)}</div>${i.link?`<a class="small" href="#" data-on-click="acNavegar" data-args="${escArgs(i.link.replace('/',''))}" data-prevent="1">Ver detalhes →</a>`:""}</div>
        </div></div></div>`).join("") + `</div>`;
    }

    // -------- Bloco 2 · Comercial --------
    html += _exH("Gestão Comercial", "bi-funnel");
    html += `<div class="row g-3">
      <div class="col-lg-7">${_exCanvas("exFunil",250)}</div>
      <div class="col-lg-5">${_exCanvas("exSerie",250)}</div>
    </div>
    <div class="row g-3 mt-0">
      <div class="col-lg-6">${_exCanvas("exLeadArea",210)}</div>
      <div class="col-lg-6"><div class="card lift"><div class="card-body">
        <h6 class="text-warning mb-2"><i class="bi bi-fire"></i> Leads quentes</h6>
        ${(co.leads_quentes||[]).length ? co.leads_quentes.map(l=>`<div class="d-flex justify-content-between border-bottom py-1"><span>${esc(l.nome)}<br><small class="text-muted">${l.tipo}</small></span><span class="text-nowrap">${l.proximo_contato?fmtDate(l.proximo_contato):"—"}</span></div>`).join("") : '<p class="text-muted mb-0">Nenhum lead quente no momento.</p>'}
      </div></div></div>
    </div>`;

    // -------- Bloco 3 · Jurídica --------
    html += _exH("Gestão Jurídica", "bi-bank");
    html += `<div class="row g-3">
      <div class="col-lg-6">${_exCanvas("exArea",210)}</div>
      <div class="col-lg-6">${_exCanvas("exClassif",210)}</div>
    </div>
    <div class="row g-3 mt-0">
      <div class="col-12">${_exCanvas("exTrib",220)}</div>
    </div>
    ${admin && ju.datajud_total ? `<div class="small text-muted mt-2"><i class="bi bi-broadcast text-danger"></i> DataJud: <b>${ju.datajud_novidades||0}</b> com novidade de ${ju.datajud_total} monitorados.</div>` : ""}`;
    // O card "Processos ativos sem próximo passo" foi removido a pedido do dono;
    // só o aviso do DataJud foi preservado aqui.

    // -------- Bloco 4 · Financeiro (oculto para quem não vê o módulo) --------
    if (verFin) {
      html += _exH("Financeiro", "bi-cash-stack");
      html += `<div class="row g-3">
        ${_exKpi("bi-file-earmark-text", fmtMoney(fi.contratado), "Contratado", EX_COL.navy)}
        ${_exKpi("bi-check-circle", fmtMoney(fi.recebido), "Recebido", EX_COL.ok)}
        ${_exKpi("bi-hourglass-split", fmtMoney(fi.pendente), "A receber", EX_COL.warn)}
        ${_exKpi("bi-exclamation-octagon", fmtMoney(fi.inadimplencia), "Inadimplência", EX_COL.bad)}
      </div>
      <div class="row g-3 mt-0">
        <div class="col-lg-7">${_exCanvas("exFin",240)}</div>
        <div class="col-lg-5">${_exCanvas("exReceitaArea",240)}</div>
      </div>
      ${fi.parcerias && fi.parcerias.qtd ? `<div class="card lift mt-3"><div class="card-body py-2 small">
        <i class="bi bi-people text-primary"></i> <b>Parcerias:</b> ${fi.parcerias.qtd} contrato(s) · total ${fmtMoney(fi.parcerias.total)} · escritório ${fmtMoney(fi.parcerias.escritorio)} · parceiro ${fmtMoney(fi.parcerias.parceiro)}
      </div></div>` : ""}`;
    }

    // -------- Bloco 4b · Distribuição (rateio de precatórios) — admin --------
    const dist = fi.distribuicao;
    if (admin && dist && dist.total > 0) {
      html += _exH("Distribuição de honorários (precatórios)", "bi-diagram-3");
      html += `<div class="small text-muted mb-2" style="margin-top:-4px"><i class="bi bi-info-circle"></i> Repartição do valor <b>recebido</b> em ${dist.qtd_honorarios} honorário(s), na cascata reserva → parceiro → fundo + sócios.</div>`;
      // Card robusto: min-width:0 + nowrap + ellipsis garantem que o valor não corta.
      const card = (icon, label, valor, cor) => `<div class="col-6 col-lg-3">
        <div class="card lift h-100" style="border-top:3px solid ${cor}"><div class="card-body py-3">
          <div class="d-flex align-items-center gap-2" style="min-width:0">
            <i class="bi ${icon}" style="font-size:1.2rem;color:${cor};flex:0 0 auto"></i>
            <div style="min-width:0;flex:1 1 auto">
              <div title="${fmtMoney(valor)}" style="font-size:1.05rem;font-weight:700;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:Sora,system-ui,sans-serif">${fmtMoney(valor)}</div>
              <div class="text-muted" style="font-size:.72rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
            </div>
          </div>
        </div></div></div>`;
      const fundoTotal = (dist.fundos || []).reduce((a, f) => a + f.valor, 0);
      const sociosTotal = (dist.socios || []).reduce((a, s) => a + s.valor, 0);
      const parcTotal = (dist.parceiros || []).reduce((a, p) => a + p.valor, 0);
      html += `<div class="row g-3">
        ${card("bi-piggy-bank", "Caixa Reserva", dist.reserva, EX_COL.navy)}
        ${card("bi-bank", "Fundo", fundoTotal, EX_COL.warn)}
        ${card("bi-people", "Sócios", sociosTotal, EX_COL.ok)}
        ${card("bi-person-badge", "Parceiros", parcTotal, EX_COL.blue)}
      </div>`;
      const linhas = []
        .concat((dist.socios || []).map(s => ({ nome: s.nome, tag: "Sócio", cor: "success", valor: s.valor })))
        .concat((dist.parceiros || []).map(p => ({ nome: p.nome, tag: "Parceiro", cor: "info text-dark", valor: p.valor })))
        .concat((dist.fundos || []).map(f => ({ nome: f.nome, tag: "Fundo", cor: "warning text-dark", valor: f.valor })))
        .concat(dist.reserva > 0 ? [{ nome: "Caixa Reserva", tag: "Reserva", cor: "secondary", valor: dist.reserva }] : []);
      html += `<div class="card lift mt-3"><div class="card-body p-0"><div class="table-responsive"><table class="table table-sm mb-0 align-middle">
        <thead><tr><th>Destino</th><th></th><th class="text-end">Valor recebido</th></tr></thead>
        <tbody>${linhas.map(l => `<tr><td>${esc(l.nome)}</td><td><span class="badge bg-${l.cor}">${l.tag}</span></td><td class="text-end"><b>${fmtMoney(l.valor)}</b></td></tr>`).join("")}
        <tr class="border-top"><td class="text-muted" colspan="2">Total distribuído</td><td class="text-end text-muted">${fmtMoney(dist.total)}</td></tr></tbody>
      </table></div></div></div>`;
    }

    // -------- Bloco 5 · Equipe (admin) --------
    if (admin && (d.equipe||[]).length){
      html += _exH("Equipe — produtividade", "bi-trophy");
      // A tabela por advogado foi removida a pedido do dono — fica só o gráfico
      // do índice, agora em largura cheia. (O texto não cita mais a coluna
      // "Honor.", que deixou de existir.)
      html += `<div class="small text-muted mb-2" style="margin-top:-4px"><i class="bi bi-info-circle"></i> <b>Índice</b> = casos (processos + precatórios + ações) ×2 · conversões ×5 · prazos cumpridos ×1 · honorários (R$ 10 mil = 1 ponto), considerando a <b>parte real</b> recebida por cada um.</div>`;
      html += `<div class="row g-3">
        <div class="col-12">${_exCanvas("exEquipe",260)}</div>
      </div>`;
    }

    // -------- Bloco 6 · Agenda --------
    html += _exH("Agenda", "bi-calendar-week");
    html += `<div class="row g-3">
      <div class="col-lg-6"><div class="card lift"><div class="card-body">
        <h6 class="text-danger mb-2"><i class="bi bi-exclamation-triangle"></i> Prazos críticos (72h)</h6>
        ${(ag.prazos_criticos||[]).length ? ag.prazos_criticos.map(p=>`<div class="d-flex justify-content-between border-bottom py-1"><span>${esc(p.descricao||"")}<br><small class="text-muted">${esc(p.processo||"")}</small></span><span class="badge bg-${p.urgencia==='alta'?'danger':p.urgencia==='media'?'warning text-dark':'secondary'}">${fmtDate(p.date)}</span></div>`).join("") : '<p class="text-muted mb-0">Nenhum prazo crítico. ✅</p>'}
      </div></div></div>
      <div class="col-lg-6"><div class="card lift"><div class="card-body">
        <h6 class="text-primary mb-2"><i class="bi bi-calendar-event"></i> Próximas audiências</h6>
        ${(ag.proximas_audiencias||[]).length ? ag.proximas_audiencias.map(a=>`<div class="d-flex justify-content-between border-bottom py-1"><span>${esc(a.local||"—")}<br><small class="text-muted">${esc(a.processo||"")}</small></span><span class="text-nowrap small">${fmtDateTime(a.date_time)}</span></div>`).join("") : '<p class="text-muted mb-0">Nenhuma audiência agendada.</p>'}
        <div class="mt-2 small text-muted"><i class="bi bi-check2-square"></i> ${ag.tarefas_pendentes||0} tarefa(s)/prazo(s) pendentes.</div>
      </div></div></div>
    </div>`;

    c.innerHTML = html;

    // -------- Listeners de filtro --------
    document.querySelectorAll("#ex-seg button").forEach(b=>{
      b.classList.toggle("active", b.dataset.p===exPeriod);
      b.addEventListener("click", ()=>{ exPeriod = b.dataset.p; renderDashboard(); });
    });
    const advSel = document.getElementById("ex-adv");
    if (advSel) advSel.addEventListener("change", ()=>{ exAdv = advSel.value; renderDashboard(); });

    // -------- Gráficos --------
    _exDestroy();
    const gridC = "rgba(130,150,180,.15)";
    // Funil (barras horizontais)
    _exChart("exFunil", { type:"bar", data:{ labels:co.funil.map(f=>f.label), datasets:[{ data:co.funil.map(f=>f.count), backgroundColor:EX_COL.navy, borderRadius:5 }] },
      options:_exBaseOpts({ indexAxis:"y", plugins:{ legend:{display:false}, title:{ display:true, text:"Funil de captação" } }, scales:{ x:{ beginAtZero:true, ticks:{precision:0}, grid:{color:gridC} }, y:{ grid:{display:false} } } }) });
    // Série novos x convertidos
    _exChart("exSerie", { type:"line", data:{ labels:co.serie.labels, datasets:[
      { label:"Novos", data:co.serie.novos, borderColor:EX_COL.blue, backgroundColor:"rgba(79,155,216,.15)", fill:true, tension:.35, pointRadius:2 },
      { label:"Convertidos", data:co.serie.convertidos, borderColor:EX_COL.ok, backgroundColor:"rgba(63,202,139,.12)", fill:true, tension:.35, pointRadius:2 } ] },
      options:_exBaseOpts({ plugins:{ legend:{display:true, position:"bottom"}, title:{display:true, text:"Novos × convertidos"} } }) });
    // Leads por área
    _exChart("exLeadArea", { type:"bar", data:{ labels:co.leads_por_area.map(a=>a.label), datasets:[{ data:co.leads_por_area.map(a=>a.count), backgroundColor:EX_COL.gold, borderRadius:5 }] },
      options:_exBaseOpts({ plugins:{ legend:{display:false}, title:{display:true, text:"Leads por área"} } }) });
    // Processos por área
    _exChart("exArea", { type:"bar", data:{ labels:ju.processos_por_area.map(a=>a.label), datasets:[{ data:ju.processos_por_area.map(a=>a.count), backgroundColor:EX_COL.blue, borderRadius:5 }] },
      options:_exBaseOpts({ indexAxis:"y", plugins:{ legend:{display:false}, title:{display:true, text:"Processos por área"} }, scales:{ x:{beginAtZero:true,ticks:{precision:0},grid:{color:gridC}}, y:{grid:{display:false}} } }) });
    // Precatórios por classificação
    _exChart("exClassif", { type:"bar", data:{ labels:ju.precatorios_por_classificacao.map(x=>x.label), datasets:[{ data:ju.precatorios_por_classificacao.map(x=>x.count), backgroundColor:EX_COL.gold, borderRadius:5 }] },
      options:_exBaseOpts({ plugins:{ legend:{display:false}, title:{display:true, text:"Precatórios por classificação"} } }) });
    // Processos por tribunal
    _exChart("exTrib", { type:"bar", data:{ labels:ju.processos_por_tribunal.map(x=>x.tribunal), datasets:[{ data:ju.processos_por_tribunal.map(x=>x.count), backgroundColor:EX_COL.navy, borderRadius:5 }] },
      options:_exBaseOpts({ plugins:{ legend:{display:false}, title:{display:true, text:"Processos por tribunal"} } }) });
    // Financeiro: contratado (barra) + recebido (linha)
    _exChart("exFin", { data:{ labels:fi.serie.labels, datasets:[
      { type:"bar", label:"Contratado", data:fi.serie.contratado, backgroundColor:"rgba(47,102,153,.55)", borderRadius:5 },
      { type:"line", label:"Recebido", data:fi.serie.recebido, borderColor:EX_COL.ok, backgroundColor:"rgba(63,202,139,.12)", fill:true, tension:.35, pointRadius:2 } ] },
      options:_exBaseOpts({ plugins:{ legend:{display:true, position:"bottom"}, title:{display:true, text:"Contratado × Recebido (por mês)"} } }) });
    // Receita por área
    _exChart("exReceitaArea", { type:"bar", data:{ labels:fi.receita_por_area.map(a=>a.label), datasets:[{ data:fi.receita_por_area.map(a=>a.valor), backgroundColor:EX_COL.gold, borderRadius:5 }] },
      options:_exBaseOpts({ indexAxis:"y", plugins:{ legend:{display:false}, title:{display:true, text:"Receita por área (contratado)"} }, scales:{ x:{beginAtZero:true,grid:{color:gridC}}, y:{grid:{display:false}} } }) });
    // Equipe ranking
    if (admin && (d.equipe||[]).length){
      _exChart("exEquipe", { type:"bar", data:{ labels:d.equipe.map(u=>u.nome), datasets:[{ data:d.equipe.map(u=>u.indice), backgroundColor:EX_COL.navy, borderRadius:5 }] },
        options:_exBaseOpts({ indexAxis:"y", plugins:{ legend:{display:false}, title:{display:true, text:"Índice de produtividade"} }, scales:{ x:{beginAtZero:true,grid:{color:gridC}}, y:{grid:{display:false}} } }) });
    }
  } catch(e){ c.innerHTML = errorBox(e); }
}

/* ---------------- Formatação de datas ---------------- */
function fmtDate(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
function fmtDateTime(dt) {
  if (!dt) return "—";
  const date = new Date(dt);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
/** Carimbo de gravação (uploaded_at/created_at, UTC sem fuso) na hora local —
 *  ver fmtCarimboUtc no ficha.js. Fallback para o formato antigo se o
 *  ficha.js não carregou. */
function _fmtCarimbo(s) {
  return typeof fmtCarimboUtc === "function" ? fmtCarimboUtc(s) : fmtDateTime(s);
}
function fmtMoney(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/* =========================================================
   MÓDULO FINANCEIRO (honorários)
   ========================================================= */
const HON_TYPE = { contratual: "Contratual", extrajudicial: "Extrajudicial" };
const HON_STATUS = { pago: "Pago", parcial: "Parcial", pendente: "Pendente" };
let finFilter = { type: "", status: "" };
let finView = "lancamentos";
let finChart = null;

async function renderFinanceiro() {
  const c = document.getElementById("view-container");
  try {
    const summary = await api("/api/honorarios/summary");
    if (!CACHE.clients.length) CACHE.clients = await api("/api/clients");
    if (!CACHE.processes.length) CACHE.processes = await api("/api/processes");
    c.innerHTML = `
      <div class="row g-3 mb-3">
        ${statCard("bg-finance", "bi-cash-stack", fmtMoney(summary.total), "Total contratado")}
        ${statCard("bg-processes", "bi-check2-circle", fmtMoney(summary.recebido), "Recebido")}
        ${statCard("bg-deadlines", "bi-hourglass-split", fmtMoney(summary.pendente), "Pendente")}
      </div>
      <div class="section-toolbar">
        <div class="seg" id="fin-seg">
          <button data-v="lancamentos">Lançamentos</button>
          <button data-v="relatorios">Relatórios</button>
        </div>
        ${CURRENT_USER.role === "admin" ? `<button class="btn btn-outline-secondary btn-sm ms-auto" data-on-click="distConfigModal" title="Regra de distribuição de honorários (precatórios)"><i class="bi bi-sliders"></i> Distribuição</button>` : ""}
      </div>
      <div id="fin-body"></div>`;
    document.querySelectorAll("#fin-seg button").forEach(b => {
      b.classList.toggle("active", b.dataset.v === finView);
      b.addEventListener("click", () => { finView = b.dataset.v; renderFinanceiro(); });
    });
    if (finView === "relatorios") await renderFinReport();
    else await renderFinLancamentos();
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function renderFinLancamentos() {
  const qs = new URLSearchParams();
  if (finFilter.type) qs.append("type", finFilter.type);
  if (finFilter.status) qs.append("status", finFilter.status);
  const items = await api("/api/honorarios" + (qs.toString() ? "?" + qs : ""));
  document.getElementById("fin-body").innerHTML = `
    <div class="section-toolbar">
      <select id="fin-type" class="form-select input-clean w-auto">
        <option value="">Todos os tipos</option>
        <option value="contratual">Contratual</option>
        <option value="extrajudicial">Extrajudicial</option>
      </select>
      <select id="fin-status" class="form-select input-clean w-auto">
        <option value="">Todos os status</option>
        <option value="pago">Pago</option>
        <option value="parcial">Parcial</option>
        <option value="pendente">Pendente</option>
      </select>
      <button class="btn btn-outline-primary ms-auto" data-on-click="parcelarModal"><i class="bi bi-layers"></i> Parcelar</button>
      <button class="btn btn-primary" data-on-click="honorarioModal"><i class="bi bi-plus-lg"></i> Novo honorário</button>
    </div>
    <div class="card"><div class="table-responsive">
      <table class="table table-hover mb-0">
        <thead><tr><th>Cliente</th><th>Processo</th><th>Tipo</th><th>Responsável</th><th>Total</th><th>Pago</th><th>Pendente</th><th>Status</th><th>Vencimento</th><th></th></tr></thead>
        <tbody>${finRows(items)}</tbody>
      </table>
    </div></div>`;
  document.getElementById("fin-type").value = finFilter.type;
  document.getElementById("fin-status").value = finFilter.status;
  document.getElementById("fin-type").addEventListener("change", e => { finFilter.type = e.target.value; renderFinanceiro(); });
  document.getElementById("fin-status").addEventListener("change", e => { finFilter.status = e.target.value; renderFinanceiro(); });
}

async function renderFinReport() {
  const r = await api("/api/honorarios/relatorio?meses=6");
  document.getElementById("fin-body").innerHTML = `
    <div class="row g-3 mb-3">
      ${statCard("bg-deadlines", "bi-hourglass-split", fmtMoney(r.a_receber), "A receber")}
      ${statCard("bg-clients", "bi-exclamation-octagon", fmtMoney(r.inadimplencia), "Inadimplência (vencido)")}
    </div>
    <div class="card lift chart-card">
      <h6 class="mb-3"><i class="bi bi-bar-chart-line text-primary"></i> Contratado x Recebido por mês (vencimento)</h6>
      <div style="height:280px"><canvas id="finChartCanvas"></canvas></div>
    </div>`;
  const ctx = document.getElementById("finChartCanvas");
  if (!ctx || typeof Chart === "undefined") return;
  if (finChart) finChart.destroy();
  finChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: r.labels,
      datasets: [
        { label: "Contratado", data: r.contratado, backgroundColor: "rgba(26,58,92,.75)", borderRadius: 5 },
        { label: "Recebido", data: r.recebido, backgroundColor: "rgba(201,161,74,.9)", borderRadius: 5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (x) => x.dataset.label + ": " + fmtMoney(x.parsed.y) } } },
      scales: { y: { beginAtZero: true, grid: { color: "#eef1f6" } }, x: { grid: { display: false } } },
    },
  });
}

async function parcelarModal() {
  if (!CACHE.clients.length) CACHE.clients = await api("/api/clients");
  // Mesmo seletor de três tipos do honorário avulso: parcelar honorário de
  // PRECATÓRIO é o caso mais comum daqui, e este modal ficava só com processos.
  let casosIniciais = { processos: [], precatorios: [], acoes: [] };
  try { casosIniciais = await api("/api/honorarios/casos"); } catch (e) {}
  showModal("Parcelar honorário", `
    <div class="mb-2"><label class="form-label">Cliente</label>
      <select id="pc-client" class="form-select" data-on-change="casoTrocouClientePc"><option value="">Nenhum</option>
        ${CACHE.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
    <div class="mb-2"><label class="form-label">Caso vinculado</label>
      <div class="d-flex gap-2">
        <select id="pc-caso" class="form-select">${_casoOptions(casosIniciais, "")}</select>
        <input id="pc-caso-busca" class="form-control" style="max-width:220px"
               placeholder="buscar por nº ou nome" data-on-input="casoBuscarPc">
      </div>
      <div class="form-text" id="pc-caso-dica">Processos, precatórios e ações.</div></div>
    <div class="row">
      <div class="col"><label class="form-label">Tipo</label>
        <select id="pc-type" class="form-select"><option value="contratual">Contratual</option><option value="extrajudicial">Extrajudicial</option></select></div>
      <div class="col"><label class="form-label" for="pc-total">Valor total</label>
        <div class="input-group"><span class="input-group-text">R$</span>
          <input type="text" inputmode="numeric" autocomplete="off" id="pc-total" class="form-control ficha-num" placeholder="0,00" data-on-input="acMaskMoeda"></div></div>
    </div>
    <div class="row mt-1">
      <div class="col"><label class="form-label">Nº de parcelas</label><input type="number" min="2" id="pc-parcelas" class="form-control" value="2"></div>
      <div class="col"><label class="form-label">1º vencimento</label><input type="date" id="pc-venc" class="form-control"></div>
      <div class="col"><label class="form-label">Intervalo (dias)</label><input type="number" min="1" id="pc-int" class="form-control" value="30"></div>
    </div>
    <div class="mb-1 mt-1"><label class="form-label">Observações</label><input id="pc-notes" class="form-control" placeholder="ex.: Contrato de honorários"></div>
  `, async () => {
    const total = _parseMoeda(val("pc-total")), parcelas = parseInt(val("pc-parcelas")), venc = val("pc-venc");
    if (!total || !parcelas || !venc) return toast("Informe valor, nº de parcelas e 1º vencimento", true);
    const casoPc = val("pc-caso") || "";
    const [tipoCaso, idCaso] = casoPc.includes(":") ? casoPc.split(":") : ["", ""];
    const payload = {
      client_id: val("pc-client") ? parseInt(val("pc-client")) : null,
      process_id: tipoCaso === "proc" ? parseInt(idCaso) : null,
      precatorio_id: tipoCaso === "prec" ? parseInt(idCaso) : null,
      acao_id: tipoCaso === "acao" ? parseInt(idCaso) : null,
      type: val("pc-type"), total_value: total, parcelas: parcelas,
      primeiro_vencimento: venc, intervalo_dias: parseInt(val("pc-int")) || 30, notes: val("pc-notes"),
    };
    await api("/api/honorarios/parcelar", { method: "POST", body: JSON.stringify(payload) });
    closeModal(); toast(parcelas + " parcelas geradas!"); renderFinanceiro();
  });
}

async function downloadRecibo(id) {
  try {
    const res = await fetch("/api/honorarios/" + id + "/recibo", { headers: { Authorization: "Bearer " + TOKEN } });
    if (!res.ok) throw new Error("Erro ao gerar recibo");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "recibo-" + id + ".pdf"; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, true); }
}

/* =========================================================
   EXPORTAÇÕES (Excel/PDF) e MODELOS DE DOCUMENTO (.docx)
   ========================================================= */
async function blobDownload(url, filename) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN } });
  if (!res.ok) {
    let msg = "Erro ao gerar arquivo";
    try { msg = (await res.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u; a.download = filename; a.click();
  URL.revokeObjectURL(u);
}

/** Filtros ATIVOS na tela de cada entidade — o export leva os mesmos, para o
 *  arquivo bater com o que o usuário está vendo.
 *  O estado de cada lista mora num objeto global: `precFilter` (app.js),
 *  `cliFiltro` (ficha-cliente.js) e `procFiltro` (ficha-processo.js). Os dois
 *  últimos são de outros arquivos — o `typeof` deixa o export funcionar (sem
 *  filtro) enquanto a lista nova não existir.
 *  ⚠️ Os nomes das chaves são os parâmetros da API (/api/export/<entidade>):
 *  busca de clientes = `search`; busca de processos = `q`. */
function exportFiltros(entidade) {
  const f = {};
  const por = (pares) => pares.forEach(([k, v]) => {
    const t = v === null || v === undefined ? "" : String(v).trim();
    if (t) f[k] = t;
  });
  if (entidade === "precatorios") por(Object.entries(precFilter));
  else if (entidade === "clientes") {
    const cf = typeof cliFiltro !== "undefined" && cliFiltro ? cliFiltro : {};
    por([["search", cf.busca], ["status", cf.status]]);
  } else if (entidade === "processos") {
    const pf = typeof procFiltro !== "undefined" && procFiltro ? procFiltro : {};
    por([["q", pf.busca], ["status", pf.status], ["tipo", pf.tipo], ["sistema", pf.sistema],
         ["responsavel", pf.responsavel], ["vencido", [true, 1, "1", "true"].includes(pf.vencido) ? "1" : ""]]);
  }
  return f;
}

/** Liga/desliga o selo "filtrado" sem re-renderizar a tela.
 *  Em Clientes e Processos só o corpo da tabela é trocado quando o filtro muda,
 *  então o botão precisa ser avisado — senão o selo nunca apareceria. */
function exportAtualizarSelo(entidade) {
  const s = document.getElementById("export-selo");
  if (!s) return;
  s.className = Object.keys(exportFiltros(entidade)).length ? "badge bg-warning text-dark" : "d-none";
}

async function exportLista(entidade, formato) {
  try {
    const qs = new URLSearchParams({ formato });
    Object.entries(exportFiltros(entidade)).forEach(([k, v]) => qs.append(k, v));
    await blobDownload(`/api/export/${entidade}?${qs}`, `${entidade}.${formato === "pdf" ? "pdf" : "xlsx"}`);
  } catch (e) { toast(e.message, true); }
}

function exportBtn(entidade) {
  // Exportação de listas é restrita ao administrador (segurança anti-extração)
  if (!CURRENT_USER || CURRENT_USER.role !== "admin") return "";
  // O selo nasce OCULTO e quem o acende é `exportAtualizarSelo`, chamado depois
  // que o HTML novo já está no DOM. Calcular aqui leria o DOM ANTIGO (esta
  // função roda durante a montagem do template) e o selo mentiria: ao voltar
  // para a tela depois de salvar, ele acenderia "filtrado" sobre uma lista sem
  // filtro nenhum — e o export levaria a base inteira.
  return `<div class="dropdown d-inline-block">
    <button class="btn btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown" title="Exporta o que está na tela — com os filtros aplicados"><i class="bi bi-download"></i> Exportar <span id="export-selo" class="d-none">filtrado</span></button>
    <ul class="dropdown-menu dropdown-menu-end">
      <li><h6 class="dropdown-header">Segue os filtros da tela</h6></li>
      <li><a class="dropdown-item cursor-pointer" data-on-click="exportLista" data-args="${escArgs(entidade, 'xlsx')}"><i class="bi bi-file-earmark-excel text-success"></i> Excel</a></li>
      <li><a class="dropdown-item cursor-pointer" data-on-click="exportLista" data-args="${escArgs(entidade, 'pdf')}"><i class="bi bi-file-earmark-pdf text-danger"></i> PDF</a></li>
    </ul>
  </div>`;
}

async function modeloModal() {
  if (!CACHE.clients.length) CACHE.clients = await api("/api/clients");
  if (!CACHE.processes.length) CACHE.processes = await api("/api/processes");
  const modelos = await api("/api/documents/modelos");
  showModal("Gerar documento", `
    <div class="mb-2"><label class="form-label">Modelo*</label>
      <select id="md-modelo" class="form-select">${modelos.map(m => `<option value="${m.id}">${esc(m.nome)}</option>`).join("")}</select></div>
    <div class="mb-2"><label class="form-label">Cliente*</label>
      <select id="md-client" class="form-select"><option value="">Selecione...</option>
        ${CACHE.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
    <div class="mb-2"><label class="form-label">Processo (opcional)</label>
      <select id="md-proc" class="form-select"><option value="">Nenhum</option>
        ${CACHE.processes.map(p => `<option value="${p.id}">${esc(p.case_number || 'Proc #' + p.id)} — ${esc(p.client_name || '')}</option>`).join("")}</select></div>
    <small class="text-muted">Gera um arquivo Word (.docx) com os dados mesclados. Você pode editá-lo livremente depois.</small>
  `, async () => {
    const modelo = val("md-modelo"), clientId = val("md-client");
    if (!clientId) return toast("Selecione o cliente", true);
    let url = `/api/documents/modelo?modelo=${modelo}&client_id=${clientId}`;
    if (val("md-proc")) url += `&process_id=${val("md-proc")}`;
    try {
      await blobDownload(url, `${modelo}.docx`);
      closeModal(); toast("Documento gerado!");
    } catch (e) { toast(e.message, true); }
  }, "Fechar");
}

function finStatusBadge(s) {
  const map = { pago: "bg-success", parcial: "bg-warning text-dark", pendente: "bg-secondary" };
  // O status do honorário é DERIVADO no servidor (`_compute_status`), então
  // este não é alcançável hoje. Escapa mesmo assim: foi a análise caso-a-caso
  // de "esse aqui não dá" que deixou 3 pontos passarem na auditoria anterior.
  return `<span class="badge ${map[s] || 'bg-secondary'}">${esc(HON_STATUS[s] || s)}</span>`;
}
function finRows(items) {
  if (!items.length) return '<tr><td colspan="10" class="empty-state">Nenhum honorário cadastrado.</td></tr>';
  return items.map(h => `
    <tr>
      <td>${esc(h.client_name || "—")}</td>
      <td><small>${esc(h.process_label || "—")}</small></td>
      <td>${esc(HON_TYPE[h.type] || h.type)}</td>
      <td><small>${esc(h.owner_name || "—")}</small>${h.created_by_name && h.created_by_name !== h.owner_name ? `<br><small class="text-muted">criado: ${esc(h.created_by_name)}</small>` : ""}${h.minha_parte ? `<br><span class="badge bg-success" title="Sua participação na parceria">Minha parte (${h.pct_parceiro || 0}%)</span>` : (h.origem === "parceria" ? `<br><span class="badge bg-info text-dark" title="Escritório ${h.pct_escritorio || 0}% • ${esc(h.parceiro_name || "parceiro")} ${h.pct_parceiro || 0}%">Parceria ${h.pct_escritorio || 0}/${h.pct_parceiro || 0}</span>` : "")}</td>
      <td>${fmtMoney(h.total_value)}</td>
      <td>${fmtMoney(h.paid_value)}${(!h.minha_parte && h.origem === "parceria" && h.valor_parceiro != null) ? `<br><small class="text-muted">parc: ${fmtMoney(h.valor_parceiro)}</small>` : ""}</td>
      <td>${fmtMoney(h.pending_value)}</td>
      <td>${finStatusBadge(h.status)}</td>
      <td>${fmtDate(h.due_date)}</td>
      <td class="text-end text-nowrap">${h.minha_parte ? '<span class="badge bg-light text-dark border">Somente leitura</span>' : `
        <button class="btn btn-sm btn-outline-secondary" title="Recibo (PDF)" data-on-click="downloadRecibo" data-args="${escArgs(h.id)}"><i class="bi bi-receipt"></i></button>
        <button class="btn btn-sm btn-outline-primary" data-on-click="honorarioModal" data-args="${escArgs(h.id)}"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-danger" data-on-click="deleteHonorario" data-args="${escArgs(h.id)}"><i class="bi bi-trash"></i></button>`}
      </td>
    </tr>`).join("");
}

/* ===== Rateio: distribuição de honorários de precatório (espelha o backend) ===== */
let DIST_CFG = null;
async function distConfig(force) {
  if (DIST_CFG && !force) return DIST_CFG;
  try { DIST_CFG = await api("/api/config/distribuicao"); }
  catch (e) { DIST_CFG = { config: null, usuarios: [], _semAcesso: true }; }
  return DIST_CFG;
}
function _d2(x) { return Math.round(((parseFloat(x) || 0) + Number.EPSILON) * 100) / 100; }
// Cascata idêntica a backend/app/distribuicao.py::calcular_rateio
function distCalc(total, cfg, comParceiro, parceiroNome, pctParc, pctReservaOverride) {
  cfg = cfg || {};
  total = parseFloat(total) || 0;
  if (total <= 0) return [];
  const clamp = p => Math.min(100, Math.max(0, parseFloat(p) || 0));
  const fatias = [];
  const pctReserva = clamp((pctReservaOverride != null && pctReservaOverride !== "")
    ? pctReservaOverride : cfg.pct_reserva);
  const reserva = _d2(total * pctReserva / 100);
  if (reserva > 0) fatias.push({ tipo: "reserva", nome: cfg.reserva_nome || "Caixa Reserva", pct: pctReserva, valor: reserva });
  const posR = _d2(Math.max(total - reserva, 0));
  let parc = 0;
  if (comParceiro) {
    const pp = clamp((pctParc != null && pctParc !== "") ? pctParc : cfg.pct_parceiro_padrao);
    parc = _d2(posR * pp / 100);
    fatias.push({ tipo: "parceiro", nome: parceiroNome || "Parceiro", pct: pp, valor: parc });
  }
  const dist = _d2(Math.max(posR - parc, 0));
  const internos = [{ tipo: "fundo", nome: cfg.fundo_nome || "Fundo", pct: parseFloat(cfg.pct_fundo) || 0 }]
    .concat((cfg.socios || []).map(s => ({ tipo: "socio", nome: s.nome, pct: parseFloat(s.pct) || 0 })));
  internos.forEach(it => fatias.push({ tipo: it.tipo, nome: it.nome, pct: it.pct, valor: _d2(dist * it.pct / 100) }));
  const soma = _d2(fatias.reduce((a, f) => a + f.valor, 0));
  const resto = _d2(total - soma);
  if (fatias.length && Math.abs(resto) >= 0.01) fatias[fatias.length - 1].valor = _d2(fatias[fatias.length - 1].valor + resto);
  return fatias;
}
const DIST_COR = { reserva: "secondary", parceiro: "info", fundo: "warning text-dark", socio: "success" };
function distPreviewHtml(fatias) {
  if (!fatias.length) return '<div class="text-muted small py-1">Informe o valor pago para ver a divisão.</div>';
  return `<table class="table table-sm mb-0 align-middle"><tbody>${fatias.map(f =>
    `<tr><td><span class="badge bg-${DIST_COR[f.tipo] || 'light text-dark'}">${esc(f.nome)}</span> <small class="text-muted">${f.pct}%</small></td><td class="text-end"><b>${fmtMoney(f.valor)}</b></td></tr>`
  ).join("")}<tr class="border-top"><td class="text-muted">Total</td><td class="text-end text-muted">${fmtMoney(fatias.reduce((a, f) => a + f.valor, 0))}</td></tr></tbody></table>`;
}
// Recalcula e injeta a prévia no modal de honorário
function distAtualizarPreview() {
  const box = document.getElementById("f-rpreview");
  if (!box) return;
  const cfg = (DIST_CFG && DIST_CFG.config) || null;
  if (!cfg) { box.innerHTML = '<div class="text-muted small">A distribuição entre os sócios será aplicada automaticamente ao salvar.</div>'; return; }
  const pago = _parseMoeda(val("f-paid")) || 0;
  const parcSel = val("f-rparceiro");
  const parcNome = parcSel ? (document.querySelector(`#f-rparceiro option[value="${parcSel}"]`)?.textContent || "Parceiro") : null;
  const fatias = distCalc(pago, cfg, !!parcSel, parcNome, val("f-rpctparc"), val("f-rreserva"));
  box.innerHTML = distPreviewHtml(fatias);
}

/* Seletor de CASO VINCULADO (processo | precatório | ação).
 *
 * 🚨 Até set/2026 este campo se chamava "Processo vinculado" e era montado só
 * com `/api/processes`. Como a carteira daqui é majoritariamente de
 * precatórios, ele parecia estar escondendo registros — na verdade nunca
 * conheceu as outras duas tabelas de caso. O valor do <option> carrega o TIPO
 * junto (`prec:486`), porque o id sozinho é ambíguo entre as três tabelas.
 */
function _casoValor(h) {
  if (h.precatorio_id) return "prec:" + h.precatorio_id;
  if (h.acao_id) return "acao:" + h.acao_id;
  if (h.process_id) return "proc:" + h.process_id;
  return "";
}

function _casoOptions(casos, selecionado, rotuloAtual) {
  let achou = false;
  const grupo = (titulo, itens, prefixo) => {
    if (!itens || !itens.length) return "";
    return `<optgroup label="${titulo}">` + itens.map(c => {
      const v = prefixo + ":" + c.id;
      if (v === selecionado) achou = true;
      const rot = c.sub ? `${c.label} — ${c.sub}` : c.label;
      return `<option value="${v}" ${v === selecionado ? "selected" : ""}>${esc(rot)}</option>`;
    }).join("") + `</optgroup>`;
  };
  const html = grupo("Processos", casos.processos, "proc")
    + grupo("Precatórios", casos.precatorios, "prec")
    + grupo("Ações", casos.acoes, "acao");
  // 🚨 O caso JÁ GRAVADO precisa sobreviver mesmo fora do recorte atual (troca
  // de cliente, busca, precatório sem vínculo formal). Sem esta opção-âncora o
  // select abriria em "Nenhum" e um Salvar distraído apagaria o vínculo sem
  // ninguém pedir — perda silenciosa, o pior tipo num módulo de dinheiro.
  const ancora = (selecionado && !achou)
    ? `<option value="${esc(selecionado)}" selected>${esc(rotuloAtual || "Caso vinculado atual")} (atual)</option>`
    : "";
  return `<option value="">Nenhum</option>` + ancora + html;
}

/* Recarrega o select conforme o cliente escolhido (ou a busca digitada).
 * Preserva a seleção atual quando ela continua na lista — trocar o cliente sem
 * querer não pode apagar em silêncio o vínculo de um honorário que já existe. */
async function _casoRecarregar(clientId, termo, pre) {
  pre = pre || "f";                      // "f" = honorário avulso · "pc" = parcelar
  const sel = document.getElementById(pre + "-caso");
  if (!sel) return;
  // Campo travado pelo contexto (honorário aberto de dentro de uma ação): não
  // recarrega. Sem isto, trocar o cliente dispararia o change e substituiria a
  // opção travada pela lista inteira — a trava duraria até o primeiro clique.
  if (sel.dataset.travado === "1") return;
  const atual = sel.value;
  const rotuloAtual = atual
    ? (sel.querySelector(`option[value="${atual}"]`)?.textContent || "").replace(/ \(atual\)$/, "")
    : "";
  const qs = [];
  if (termo) qs.push("q=" + encodeURIComponent(termo));
  else if (clientId) qs.push("client_id=" + clientId);
  sel.disabled = true;
  try {
    const casos = await api("/api/honorarios/casos" + (qs.length ? "?" + qs.join("&") : ""));
    sel.innerHTML = _casoOptions(casos, atual, rotuloAtual);
    const total = (casos.processos.length + casos.precatorios.length + casos.acoes.length);
    const dica = document.getElementById(pre + "-caso-dica");
    if (dica) {
      dica.textContent = total
        ? `${total} caso(s) — processos, precatórios e ações`
        : (termo ? "Nada encontrado para essa busca."
                 : "Nenhum caso vinculado a este cliente. Use a busca ao lado.");
    }
  } catch (e) {
    toast("Não foi possível carregar os casos", true);
  } finally {
    sel.disabled = false;
  }
}

/* Trocou o cliente → recarrega os casos daquele cliente (e limpa a busca). */
function _casoTrocouCliente(pre) {
  const busca = document.getElementById(pre + "-caso-busca");
  if (busca) busca.value = "";
  _casoRecarregar(val(pre + "-client"), "", pre);
}
function casoTrocouCliente() { _casoTrocouCliente("f"); }
function casoTrocouClientePc() { _casoTrocouCliente("pc"); }

/* Busca livre: alcança qualquer caso, inclusive fora do cliente selecionado —
 * é a saída para o precatório que não tem vínculo formal com o cadastro. */
let _casoBuscaTimer = null;
function _casoBuscar(pre) {
  clearTimeout(_casoBuscaTimer);
  _casoBuscaTimer = setTimeout(() => {
    const termo = (val(pre + "-caso-busca") || "").trim();
    if (termo && termo.length < 3) return;   // evita varrer a base a cada tecla
    _casoRecarregar(val(pre + "-client"), termo, pre);
  }, 350);
}
function casoBuscar() { _casoBuscar("f"); }
function casoBuscarPc() { _casoBuscar("pc"); }

/** Honorário. opts (todos opcionais):
 *   acaoId    — aberto de dentro de uma ação: o caso fica TRAVADO nela;
 *   processId — aberto de dentro da ficha do processo (registro novo): o caso
 *               fica TRAVADO no processo e o cliente no cliente dele;
 *   clientId  — pré-seleciona o cliente (registro novo);
 *   processos — restringe os processos oferecidos no "Caso vinculado";
 *   onSaved(h)— chamado no lugar de renderFinanceiro(). */
async function honorarioModal(id, opts) {
  opts = _modalOpts(opts);
  try {
    if (!CACHE.clients.length) CACHE.clients = await api("/api/clients");
  } catch (e) { CACHE.clients = []; }   // sem o módulo Clientes: segue sem a lista
  let h = { client_id: "", process_id: "", acao_id: null, precatorio_id: null, type: "contratual", total_value: "", paid_value: "", due_date: "", notes: "", origem: "proprio", parceiro_id: null, pct_escritorio: 70, pct_parceiro: 30, rateio: 0, pct_reserva: null };
  if (id) {
    try { h = await api("/api/honorarios/" + id); }
    catch (e) { toast(e.message, true); return; }
  }
  // Registro novo aberto de dentro de uma ficha: vínculo já decidido pelo contexto.
  const procFixo = !id && !opts.acaoId && opts.processId ? Number(opts.processId) : null;
  // Cliente do processo só vai no payload se o usuário o alcança (o dono do
  // processo pode não ser o dono do cliente — mandar daria 403). Sem ele o
  // honorário fica só no processo, e a ficha do cliente o acha pelo processo.
  const cliFixo = procFixo && opts.clientId && CACHE.clients.some((c) => String(c.id) === String(opts.clientId))
    ? Number(opts.clientId) : null;
  if (!id && procFixo) { h.process_id = procFixo; h.client_id = cliFixo || ""; }
  else if (!id && opts.clientId) h.client_id = Number(opts.clientId);
  let travaProc = null;
  if (procFixo) {
    const lp = (Array.isArray(opts.processos) ? opts.processos : CACHE.processes).find((p) => String(p.id) === String(procFixo));
    travaProc = lp ? (lp.case_number || "Processo #" + procFixo) + (lp.client_name ? " — " + lp.client_name : "") : "Processo #" + procFixo;
  }
  // Aberto de DENTRO de uma ação: o caso já está decidido pelo contexto. O
  // campo mostra a ação e fica TRAVADO — antes ele abria em "Nenhum",
  // habilitado e cheio de opções, e o que a pessoa escolhesse era descartado
  // no salvamento pelo override abaixo. Campo editável cuja escolha é jogada
  // fora é pior que campo bloqueado: só se descobre depois, na listagem.
  let travaAcao = null;
  if (opts.acaoId) {
    h.acao_id = opts.acaoId;
    try {
      const a = await api("/api/acoes/" + opts.acaoId);
      travaAcao = (a.numero_processo || "Ação #" + opts.acaoId)
        + (a.parte_nome ? " — " + a.parte_nome : "");
    } catch (e) { travaAcao = "Ação #" + opts.acaoId; }
  }
  let colegas = [];
  try { colegas = await api("/api/auth/colegas"); } catch (e) {}
  await distConfig();
  const distCfg = (DIST_CFG && DIST_CFG.config) || null;
  const ehParceria = h.origem === "parceria";
  const ehRateio = !!h.rateio;
  const reservaDefault = distCfg ? distCfg.pct_reserva : 5;
  const parceiroDefault = distCfg ? distCfg.pct_parceiro_padrao : 20;
  // Casos do cliente já vinculado (ao editar) ou de todos (ao criar sem cliente).
  // Ao EDITAR, pede pelo cliente do honorário para o caso atual vir na lista —
  // senão o <select> abriria sem a opção que está gravada e um "Salvar" sem
  // querer apagaria o vínculo.
  let casosIniciais = { processos: [], precatorios: [], acoes: [] };
  if (!travaAcao && !travaProc) {         // travado: a lista não é usada
    try {
      casosIniciais = await api("/api/honorarios/casos"
        + (h.client_id ? "?client_id=" + h.client_id : ""));
    } catch (e) {}
    // Ficha do cliente: os processos oferecidos são os que ela passou.
    if (Array.isArray(opts.processos)) {
      casosIniciais.processos = opts.processos.map((p) => ({ id: p.id, label: p.case_number || "Processo #" + p.id, sub: p.client_name || null }));
    }
  }
  showModal(id ? "Editar honorário" : "Novo honorário", `
    <div class="mb-2"><label class="form-label">Cliente</label>
      <select id="f-client" class="form-select" ${travaProc ? 'disabled data-travado="1"' : 'data-on-change="casoTrocouCliente"'}><option value="">Nenhum</option>
        ${CACHE.clients.map(c => `<option value="${c.id}" ${String(h.client_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join("")}</select>
      ${travaProc && !cliFixo ? '<div class="form-text">Cliente de outro responsável — o honorário fica ligado só ao processo.</div>' : ""}</div>
    <div class="mb-2"><label class="form-label">Caso vinculado</label>
      ${travaProc ? `
        <select id="f-caso" class="form-select" data-travado="1" disabled>
          <option value="proc:${procFixo}" selected>${esc(travaProc)}</option></select>
        <div class="form-text" id="f-caso-dica">Este honorário é do processo aberto. Para vincular a outro caso, lance pelo Financeiro.</div>
      ` : travaAcao ? `
        <select id="f-caso" class="form-select" data-travado="1" disabled>
          <option value="acao:${opts.acaoId}" selected>${esc(travaAcao)}</option></select>
        <div class="form-text" id="f-caso-dica">Este honorário é da ação aberta. Para vincular a outro caso, lance pelo Financeiro.</div>
      ` : `
        <div class="d-flex gap-2">
          <select id="f-caso" class="form-select" data-on-change="acHonCasoMudou">${_casoOptions(casosIniciais, _casoValor(h), h.process_label)}</select>
          <input id="f-caso-busca" class="form-control" style="max-width:220px"
                 placeholder="buscar por nº ou nome" data-on-input="casoBuscar">
        </div>
        <div class="form-text" id="f-caso-dica">Processos, precatórios e ações.</div>
      `}</div>
    <div class="row">
      <div class="col"><label class="form-label">Tipo</label>
        <select id="f-type" class="form-select">
          <option value="contratual" ${h.type === 'contratual' ? 'selected' : ''}>Contratual</option>
          <option value="extrajudicial" ${h.type === 'extrajudicial' ? 'selected' : ''}>Extrajudicial</option>
        </select></div>
      <div class="col"><label class="form-label">Vencimento</label><input type="date" id="f-due" class="form-control" value="${h.due_date || ''}"></div>
    </div>
    <div class="row mt-1">
      <div class="col"><label class="form-label" for="f-total">Valor total</label>
        <div class="input-group"><span class="input-group-text">R$</span>
          <input type="text" inputmode="numeric" autocomplete="off" id="f-total" class="form-control ficha-num" placeholder="0,00" value="${esc(_fmtMoedaInit(h.total_value))}" data-on-input="acMaskMoeda"></div></div>
      <div class="col"><label class="form-label" for="f-paid">Valor pago</label>
        <div class="input-group"><span class="input-group-text">R$</span>
          <input type="text" inputmode="numeric" autocomplete="off" id="f-paid" class="form-control ficha-num" placeholder="0,00" value="${esc(_fmtMoedaInit(h.paid_value))}" data-on-input="acMaskMoedaRateio"></div></div>
    </div>

    <div id="f-rateio-wrap" style="display:${ehRateio || _casoValor(h).startsWith("prec:") ? 'block' : 'none'}">
    <div class="form-check form-switch mt-3">
      <input class="form-check-input" type="checkbox" id="f-rateio" ${ehRateio ? 'checked' : ''}
        data-on-change="acToggleRateio">
      <label class="form-check-label" for="f-rateio"><b>Honorário de Precatório</b> — distribuir entre os sócios (rateio)</label>
    </div>

    <!-- Rateio de precatório (cascata: reserva → parceiro → fundo + sócios) -->
    <div id="f-rateio-box" class="p-2 mt-2" style="display:${ehRateio ? 'block' : 'none'};background:var(--surface-2);border-radius:10px">
      <div class="row g-2">
        <div class="col-md-6"><label class="form-label">Advogado parceiro (opcional)</label>
          <select id="f-rparceiro" class="form-select" data-on-change="distAtualizarPreview"><option value="">Sem parceiro</option>${colegas.map(u => `<option value="${u.id}" ${h.parceiro_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join("")}</select></div>
        <div class="col-md-3"><label class="form-label">% Parceiro</label><input type="number" min="0" max="100" step="0.01" id="f-rpctparc" class="form-control" value="${ehRateio && h.pct_parceiro != null ? h.pct_parceiro : parceiroDefault}" data-on-input="distAtualizarPreview"></div>
        <div class="col-md-3"><label class="form-label">% Reserva</label><input type="number" min="0" max="100" step="0.01" id="f-rreserva" class="form-control" value="${h.pct_reserva != null ? h.pct_reserva : reservaDefault}" data-on-input="distAtualizarPreview"></div>
      </div>
      <div class="mt-2"><div class="small text-muted mb-1"><i class="bi bi-diagram-3"></i> Divisão sobre o <b>valor pago</b> (reserva sai primeiro, depois o parceiro, depois fundo + sócios):</div>
        <div id="f-rpreview" class="p-2" style="background:var(--surface);border-radius:8px"></div></div>
      ${distCfg ? '' : '<div class="small text-warning mt-1">Regra de distribuição ainda não configurada por um administrador — os valores padrão serão usados.</div>'}
    </div>
    </div>

    <div id="f-origem-wrap" style="display:${ehRateio ? 'none' : 'block'}">
      <div class="mt-2"><label class="form-label">Origem do honorário</label>
        <select id="f-origem" class="form-select" data-on-change="acToggleParceria">
          <option value="proprio" ${!ehParceria ? 'selected' : ''}>Honorário próprio</option>
          <option value="parceria" ${ehParceria ? 'selected' : ''}>Honorário de parceria</option>
        </select></div>
      <div id="f-parceria" class="row g-2 mt-1 p-2" style="display:${ehParceria ? 'flex' : 'none'};background:var(--surface-2);border-radius:10px">
        <div class="col-md-6"><label class="form-label">Advogado parceiro</label>
          <select id="f-parceiro" class="form-select"><option value="">Selecione...</option>${colegas.map(u => `<option value="${u.id}" ${h.parceiro_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join("")}</select></div>
        <div class="col-md-3"><label class="form-label">% Escritório</label><input type="number" min="0" max="100" id="f-pctesc" class="form-control" value="${h.pct_escritorio ?? 70}"></div>
        <div class="col-md-3"><label class="form-label">% Parceiro</label><input type="number" min="0" max="100" id="f-pctparc" class="form-control" value="${h.pct_parceiro ?? 30}"></div>
        <div class="col-12"><small class="text-muted">Os percentuais incidem sobre o valor recebido (pago).</small></div>
      </div>
    </div>

    <div class="mb-1 mt-2"><label class="form-label">Observações</label><textarea id="f-notes" class="form-control">${esc(h.notes)}</textarea></div>
  `, async () => {
    const rateioOn = document.getElementById("f-rateio").checked;
    // O caso vem como "tipo:id" — os três FKs são enviados SEMPRE (o não
    // escolhido vai null), senão editar um honorário trocando de precatório
    // para processo deixaria o vínculo antigo pendurado no banco.
    const caso = val("f-caso") || "";
    const [tipoCaso, idCaso] = caso.includes(":") ? caso.split(":") : ["", ""];
    const payload = {
      client_id: val("f-client") ? parseInt(val("f-client")) : null,
      process_id: tipoCaso === "proc" ? parseInt(idCaso) : null,
      precatorio_id: tipoCaso === "prec" ? parseInt(idCaso) : null,
      acao_id: tipoCaso === "acao" ? parseInt(idCaso) : null,
      type: val("f-type"),
      total_value: _parseMoeda(val("f-total")) || 0,
      paid_value: _parseMoeda(val("f-paid")) || 0,
      due_date: val("f-due") || null,
      notes: val("f-notes"),
    };
    // Pago maior que o total virava honorário "pago" com saldo negativo.
    if (payload.paid_value > payload.total_value + 0.004) {
      return _campoInvalido("f-paid", "O valor pago não pode ser maior que o total.");
    }
    if (rateioOn) {
      const parc = val("f-rparceiro");
      payload.rateio = 1;
      payload.origem = parc ? "parceria" : "proprio";
      payload.parceiro_id = parc ? parseInt(parc) : null;
      payload.pct_parceiro = parc ? (parseFloat(val("f-rpctparc")) || 0) : null;
      payload.pct_escritorio = null;
      // Só envia a reserva como override se o usuário mudou do padrão global.
      const rres = val("f-rreserva");
      const padrao = (DIST_CFG && DIST_CFG.config) ? DIST_CFG.config.pct_reserva : reservaDefault;
      payload.pct_reserva = (rres !== "" && parseFloat(rres) !== parseFloat(padrao)) ? parseFloat(rres) : null;
    } else {
      const origem = val("f-origem");
      payload.rateio = 0;
      payload.pct_reserva = null;
      payload.origem = origem;
      payload.parceiro_id = origem === "parceria" && val("f-parceiro") ? parseInt(val("f-parceiro")) : null;
      payload.pct_escritorio = origem === "parceria" ? (parseFloat(val("f-pctesc")) || 0) : null;
      payload.pct_parceiro = origem === "parceria" ? (parseFloat(val("f-pctparc")) || 0) : null;
      if (origem === "parceria" && !payload.parceiro_id) return toast("Selecione o advogado parceiro", true);
    }
    // Cinto e suspensório: o select travado já entrega "acao:<id>", então isto
    // é redundante hoje — fica porque garante o vínculo mesmo que alguém mexa
    // no DOM, e porque zera os outros dois (o backend recusa dois casos).
    if (opts.acaoId) {
      payload.acao_id = opts.acaoId;
      payload.process_id = null;
      payload.precatorio_id = null;
    }
    if (procFixo) {
      payload.process_id = procFixo;
      payload.precatorio_id = null;
      payload.acao_id = null;
      payload.client_id = cliFixo;
    }
    const salvo = id
      ? await api("/api/honorarios/" + id, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/honorarios", { method: "POST", body: JSON.stringify(payload) });
    closeModal(); toast("Honorário salvo!");
    _depoisDe(opts.onSaved, renderFinanceiro, salvo);
  }, "Cancelar", "modal-lg");
  distAtualizarPreview();
}
async function deleteHonorario(id, opts) {
  const o = _modalOpts(opts);
  if (!(await _confirmarExclusao("Excluir este honorário?"))) return false;
  try { await api("/api/honorarios/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return false; }
  toast("Honorário excluído!");
  _depoisDe(o.onDone, renderFinanceiro);
  return true;
}

/* ===== Configuração da distribuição de honorários (somente admin) ===== */
async function distConfigModal() {
  let data;
  try { data = await api("/api/config/distribuicao"); }
  catch (e) { return toast(e.message || "Sem acesso à configuração", true); }
  const cfg = data.config || {};
  const usuarios = data.usuarios || [];
  // Estado editável dos sócios
  let SC = (cfg.socios || []).map(s => ({ user_id: s.user_id || "", pct: s.pct != null ? s.pct : 0 }));
  if (!SC.length) SC = [{ user_id: "", pct: 32.5 }, { user_id: "", pct: 32.5 }];

  const optsUsers = (sel) => `<option value="">Selecione o sócio...</option>` +
    usuarios.map(u => `<option value="${u.id}" ${String(sel) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join("");

  showModal("Distribuição de honorários (precatórios)", `
    <div class="alert alert-info py-2 small mb-3"><i class="bi bi-info-circle"></i>
      Regra em <b>cascata</b> sobre o valor <b>recebido</b>: 1) sai a <b>Reserva</b> do total;
      2) o <b>parceiro</b> recebe seu % do que sobrou; 3) o restante do escritório é dividido entre <b>Fundo</b> e <b>sócios</b>.
      Fundo + sócios devem somar <b>100%</b>.
    </div>
    <div class="row g-2">
      <div class="col-md-8"><label class="form-label">Nome da reserva</label><input id="dc-reserva-nome" class="form-control" value="${esc(cfg.reserva_nome || 'Caixa Reserva')}"></div>
      <div class="col-md-4"><label class="form-label">% Reserva (do total)</label><input id="dc-reserva" type="number" min="0" max="100" step="0.01" class="form-control" value="${cfg.pct_reserva ?? 5}" data-on-input="_dcRecalc"></div>
      <div class="col-md-8"><label class="form-label">% padrão do parceiro</label><input id="dc-parc" type="number" min="0" max="100" step="0.01" class="form-control" value="${cfg.pct_parceiro_padrao ?? 20}" data-on-input="_dcRecalc"></div>
      <div class="col-12"><hr class="my-1"></div>
      <div class="col-md-8"><label class="form-label">Nome do fundo</label><input id="dc-fundo-nome" class="form-control" value="${esc(cfg.fundo_nome || 'Fundo')}"></div>
      <div class="col-md-4"><label class="form-label">% Fundo</label><input id="dc-fundo" type="number" min="0" max="100" step="0.01" class="form-control" value="${cfg.pct_fundo ?? 35}" data-on-input="_dcRecalc"></div>
    </div>
    <div class="d-flex align-items-center mt-3 mb-1">
      <label class="form-label mb-0">Sócios</label>
      <button type="button" class="btn btn-sm btn-outline-primary ms-auto" id="dc-add"><i class="bi bi-plus-lg"></i> Adicionar sócio</button>
    </div>
    <div id="dc-socios"></div>
    <div id="dc-soma" class="small mt-1"></div>
    <hr>
    <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
      <span class="small text-muted"><i class="bi bi-diagram-3"></i> Simular a divisão sobre o valor recebido de</span>
      <div class="input-group input-group-sm" style="max-width:200px">
        <span class="input-group-text">R$</span>
        <input id="dc-sim" type="text" inputmode="numeric" autocomplete="off" class="form-control ficha-num" value="100.000,00" data-on-input="acDcSimMoeda">
      </div>
      <span class="small text-muted">com parceiro no % padrão:</span>
    </div>
    <div class="small text-muted mb-2" style="margin-top:-4px"><i class="bi bi-info-circle"></i> Este valor é só uma simulação. Na prática, a divisão sempre incide sobre o <b>valor pago</b> de cada honorário.</div>
    <div id="dc-preview" class="p-2" style="background:var(--surface-2);border-radius:8px"></div>
    <div class="mt-2"><button type="button" class="btn btn-sm btn-outline-secondary" id="dc-recalc"><i class="bi bi-arrow-repeat"></i> Recalcular rateios já lançados</button>
      <span class="small text-muted ms-1">reaplica a regra atual aos honorários de precatório existentes</span></div>
  `, async () => {
    const cfgOut = _dcLer();
    const soma = (parseFloat(cfgOut.pct_fundo) || 0) + cfgOut.socios.reduce((a, s) => a + (parseFloat(s.pct) || 0), 0);
    if (Math.abs(soma - 100) > 0.01) return toast(`Fundo + sócios devem somar 100% (atual: ${soma.toFixed(2)}%)`, true);
    if (cfgOut.socios.some(s => !s.user_id)) return toast("Escolha o usuário de cada sócio", true);
    const r = await api("/api/config/distribuicao", { method: "PUT", body: JSON.stringify(cfgOut) });
    DIST_CFG = null; // invalida o cache
    closeModal();
    toast(`Regra salva!${r.recalculados ? ` ${r.recalculados} honorário(s) recalculado(s).` : ""}`);
  }, "Cancelar", "modal-lg");

  // ---- helpers do modal (expostos no window para os handlers inline) ----
  window._dcLer = () => ({
    pct_reserva: parseFloat(val("dc-reserva")) || 0,
    reserva_nome: val("dc-reserva-nome") || "Caixa Reserva",
    pct_parceiro_padrao: parseFloat(val("dc-parc")) || 0,
    fundo_nome: val("dc-fundo-nome") || "Fundo",
    pct_fundo: parseFloat(val("dc-fundo")) || 0,
    socios: SC.map(s => ({
      user_id: s.user_id ? parseInt(s.user_id) : null,
      nome: (usuarios.find(u => String(u.id) === String(s.user_id)) || {}).name || "Sócio",
      pct: parseFloat(s.pct) || 0,
    })),
  });
  const renderSocios = () => {
    document.getElementById("dc-socios").innerHTML = SC.map((s, i) => `
      <div class="row g-2 mb-1 align-items-center">
        <div class="col"><select class="form-select" data-i="${i}" data-k="user_id">${optsUsers(s.user_id)}</select></div>
        <div class="col-4"><div class="input-group"><input type="number" min="0" max="100" step="0.01" class="form-control" data-i="${i}" data-k="pct" value="${s.pct}"><span class="input-group-text">%</span></div></div>
        <div class="col-auto"><button type="button" class="btn btn-outline-danger btn-sm" data-del="${i}"><i class="bi bi-trash"></i></button></div>
      </div>`).join("");
    document.querySelectorAll("#dc-socios [data-k]").forEach(el => el.addEventListener("input", e => {
      SC[+e.target.dataset.i][e.target.dataset.k] = e.target.value; _dcRecalc();
    }));
    document.querySelectorAll("#dc-socios [data-del]").forEach(el => el.addEventListener("click", e => {
      SC.splice(+e.target.closest("[data-del]").dataset.del, 1); renderSocios(); _dcRecalc();
    }));
  };
  window._dcRecalc = () => {
    const cfgNow = _dcLer();
    const soma = (parseFloat(cfgNow.pct_fundo) || 0) + cfgNow.socios.reduce((a, s) => a + (parseFloat(s.pct) || 0), 0);
    const ok = Math.abs(soma - 100) <= 0.01;
    const el = document.getElementById("dc-soma");
    if (el) el.innerHTML = `Fundo + sócios = <b class="text-${ok ? 'success' : 'danger'}">${soma.toFixed(2)}%</b> ${ok ? '<i class="bi bi-check-circle text-success"></i>' : '— precisa fechar em 100%'}`;
    const box = document.getElementById("dc-preview");
    const simBase = _parseMoeda(val("dc-sim")) || 0;
    if (box) box.innerHTML = distPreviewHtml(distCalc(simBase, cfgNow, true, "Parceiro", cfgNow.pct_parceiro_padrao, cfgNow.pct_reserva));
  };
  document.getElementById("dc-add").addEventListener("click", () => { SC.push({ user_id: "", pct: 0 }); renderSocios(); _dcRecalc(); });
  document.getElementById("dc-recalc").addEventListener("click", async (e) => {
    const btn = e.target.closest("#dc-recalc");
    btn.disabled = true;
    try {
      const r = await api("/api/config/distribuicao/recalcular", { method: "POST" });
      toast(`${r.recalculados} honorário(s) recalculado(s) com a regra atual.`);
    } catch (err) { toast(err.message || "Erro ao recalcular", true); }
    btn.disabled = false;
  });
  renderSocios();
  _dcRecalc();
}

/* =========================================================
   MÓDULO PRECATÓRIOS FEDERAIS (grid editável)
   ========================================================= */
const TRIBUNAIS = ["TRF1", "TRF2", "TRF3", "TRF4", "TRF5"];
const PREC_BANCO = { caixa: "Caixa Econômica Federal", bb: "Banco do Brasil" };
const PREC_CLASSIF = { habilitacao_herdeiros: "Habilitação de herdeiros", cancelado: "Cancelado", reexpedicao: "Reexpedição", com_alvara: "Com alvará", sem_alvara: "Compra de crédito" };
const PREC_CLASSIF_ADMIN = []; // todas as classificações ficam acessíveis aos advogados
// Etapas do funil (Kanban) — na ordem em que aparecem no quadro
const PREC_LEAD = {
  novos_leads: "Novos Leads",
  primeiro_contato: "Primeiro Contato",
  interesse: "Interesse Confirmado",
  analise_doc: "Análise Documental",
  proposta: "Proposta Comercial",
  contrato_enviado: "Contrato Enviado",
  contrato_assinado: "Contrato Assinado",
  processo_andamento: "Processo em Andamento",
  concluido: "Concluído",
  perdido: "Perdido / Não Interessado",
};
const PREC_LEAD_ORDER = Object.keys(PREC_LEAD);
const PREC_LEAD_COLOR = {
  novos_leads: "secondary", primeiro_contato: "info", interesse: "primary",
  analise_doc: "warning text-dark", proposta: "primary", contrato_enviado: "info",
  contrato_assinado: "success", processo_andamento: "success", concluido: "dark",
  perdido: "danger",
};
// Etapas consideradas "convertidas" (cliente fechado) para as métricas
const PREC_LEAD_FECHADAS = ["contrato_assinado", "processo_andamento", "concluido"];
const PREC_PROB = { pouco_provavel: "Pouco provável", possivel: "Possível", muito_provavel: "Muito provável" };
const PREC_PROB_COLOR = { pouco_provavel: "secondary", possivel: "warning text-dark", muito_provavel: "success" };
function brl(v) { return v == null || v === "" ? "—" : "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const PREC_CONTATO = { ligacao: "Ligação", whatsapp: "WhatsApp", email: "E-mail", reuniao: "Reunião", outro: "Outro" };
// Espelha schemas.DOC_CATEGORIAS do backend (lista fechada): chave nova lá = rótulo novo aqui.
const PREC_DOC_CAT = {
  procuracao: "Procuração", contrato: "Contrato", documento_pessoal: "Documento pessoal", comprovante: "Comprovante",
  peticao: "Petição", decisao: "Decisão/Sentença", laudo: "Laudo", outro: "Outro",
};
let precFilter = { tribunal: "", classificacao: "", status_lead: "", responsavel: "", search: "" };
function precClassifOptions() {
  const isAdmin = CURRENT_USER.role === "admin";
  const permitidas = permClassificacoes(); // null = todas
  return Object.entries(PREC_CLASSIF).filter(([k]) => {
    if (!isAdmin && PREC_CLASSIF_ADMIN.includes(k)) return false;
    return !permitidas || permitidas.includes(k);
  });
}

/* =========================================================
   AUDITORIA DE DUPLICADOS (admin) — Precatórios e Processos
   Só LISTA; a exclusão é sempre uma escolha do admin, registro a registro.
   ========================================================= */
async function auditarDuplicados(entidade) {
  // `entidade` é o caminho REAL da API ("precatorios" | "processes") — ela vira
  // URL aqui e na exclusão. Cuidado: o módulo se chama "Processos" na tela, mas
  // a rota é /api/processes (inglês); usar o rótulo aqui dá 404.
  const ehPrec = entidade === "precatorios";
  const titulo = ehPrec ? "Precatórios duplicados" : "Processos duplicados";
  showModal(titulo, `<div class="text-center py-4"><div class="spinner-border text-primary"></div>
    <div class="mt-2 text-muted">Procurando repetições...</div></div>`, null, "Fechar", "modal-lg");
  const body = () => document.querySelector("#app-modal .modal-body");
  try {
    const d = await api(`/api/${entidade}/duplicados`);
    const total = ehPrec ? d.total_precatorios : d.total_processos;
    const grupos = d.por_numero || [];
    const nomes = ehPrec ? (d.por_nome || []) : [];

    const linha = (r) => ehPrec
      ? `<tr><td><input type="checkbox" class="dup-chk" value="${r.id}"></td>
           <td>#${r.id}<br><small class="text-muted">${r.criado_em ? fmtDate(r.criado_em.slice(0,10)) : "—"}</small></td>
           <td>${esc(r.requerente) || "<span class='text-muted'>sem nome</span>"}<br><small class="text-muted">${esc(r.cpf) || ""}</small></td>
           <td><small>${esc(r.numero_precatorio || r.processo_id || r.numero_originario) || "—"}</small></td>
           <td><small>${esc(PREC_CLASSIF[r.classificacao] || "—")}<br>${esc(PREC_LEAD[r.status_lead] || "")}</small></td>
           <td><small>${r.owner_id ? "atribuído" : "<span class='text-warning'>fila</span>"}</small></td></tr>`
      : `<tr><td><input type="checkbox" class="dup-chk" value="${r.id}"></td>
           <td>#${r.id}<br><small class="text-muted">${r.criado_em ? fmtDate(r.criado_em.slice(0,10)) : "—"}</small></td>
           <td>${esc(r.cliente) || "<span class='text-muted'>—</span>"}</td>
           <td><small>${esc(r.case_number) || "—"}</small></td>
           <td><small>${esc(r.type || "")}<br>${esc(r.status || "")}</small></td>
           <td><small>${esc(r.tribunal || "—")}</small></td></tr>`;

    const bloco = (g, i) => `
      <div class="card mb-2"><div class="card-body py-2">
        <div class="small text-muted mb-1"><b>Grupo ${i + 1}</b> — ${g.registros.length} registros
          <span class="badge bg-light text-dark border ms-1">${esc(g.chave)}</span></div>
        <div class="table-responsive"><table class="table table-sm align-middle mb-0">
          <thead><tr><th style="width:34px"></th><th>ID</th><th>${ehPrec ? "Requerente" : "Cliente"}</th><th>Número</th><th>${ehPrec ? "Situação" : "Área / status"}</th><th>${ehPrec ? "Dono" : "Tribunal"}</th></tr></thead>
          <tbody>${g.registros.map(linha).join("")}</tbody></table></div>
      </div></div>`;

    if (!grupos.length && !nomes.length) {
      body().innerHTML = `<div class="alert alert-success mb-0"><i class="bi bi-check-circle"></i>
        Nenhuma duplicidade encontrada entre os <b>${total}</b> registros.</div>`;
      return;
    }
    body().innerHTML = `
      <div class="small text-muted mb-2">Analisados <b>${total}</b> registros. A comparação usa só os
        <b>dígitos</b> do número, então "0801234-56.2026…" e "080123456…" batem.
        O <b>processo originário/de execução não conta</b>: numa ação coletiva vários autores
        dividem o mesmo, e isso geraria falso duplicado.</div>
      ${grupos.length ? `
        <div class="alert alert-danger py-2"><b>${grupos.length}</b> grupo(s) com o mesmo <b>nº de requisitório/processo TRF</b> —
          sobram <b>${d.excedentes_por_numero}</b> registro(s) para apagar.</div>
        ${grupos.map(bloco).join("")}
        <div class="d-flex align-items-center gap-2 mt-2">
          <button class="btn btn-danger btn-sm" data-on-click="excluirDuplicadosSelecionados" data-args="${escArgs(entidade)}">
            <i class="bi bi-trash"></i> Excluir selecionados</button>
          <small class="text-muted">Marque os que quer remover — deixe 1 de cada grupo.</small>
        </div>` : ""}
      ${nomes.length ? `
        <hr><div class="alert alert-warning py-2"><b>${nomes.length}</b> grupo(s) com o mesmo
          <b>NOME</b> de requerente (números diferentes) — sobram <b>${d.excedentes_por_nome}</b>.
          Confira: pode ser homônimo ou a mesma pessoa em dois precatórios.</div>
        ${nomes.map(bloco).join("")}
        <div class="d-flex align-items-center gap-2 mt-2">
          <button class="btn btn-danger btn-sm" data-on-click="excluirDuplicadosSelecionados" data-args="${escArgs(entidade)}">
            <i class="bi bi-trash"></i> Excluir selecionados</button>
          <small class="text-muted">Marque os que quer remover — deixe 1 de cada grupo.</small>
        </div>` : ""}`;
  } catch (e) {
    body().innerHTML = `<div class="alert alert-danger mb-0">${esc(e.message)}</div>`;
  }
}

async function excluirDuplicadosSelecionados(entidade) {
  if (entidade !== "precatorios" && entidade !== "processes") return;   // vira URL de DELETE
  const ids = [...document.querySelectorAll(".dup-chk:checked")].map(c => parseInt(c.value));
  if (!ids.length) return toast("Marque ao menos um registro.", true);
  if (!(await _confirmarExclusao(`Excluir ${ids.length} registro(s)?`, "Esta ação não pode ser desfeita."))) return;
  let ok = 0, falhas = [];
  for (const id of ids) {
    try { await api(`/api/${entidade}/${id}`, { method: "DELETE" }); ok++; }
    catch (e) { falhas.push(`#${id}: ${e.message}`); }
  }
  toast(`${ok} excluído(s).${falhas.length ? " " + falhas.length + " falhou(ram)." : ""}`, !!falhas.length);
  if (entidade === "precatorios") renderPrecatorios();
  else _recarregarListaSeAberta("processos", typeof renderProcesses === "function" ? renderProcesses : null);
  auditarDuplicados(entidade);   // reabre já atualizado
}

/** Quem enxerga os casos do escritório inteiro (espelha `ve_tudo()` do backend). */
function precPodeVerTodos() { return permIsAdmin() || permIsEstagiario(); }

/** Quem filtra por um advogado ESPECÍFICO — só o admin.
 *  O estagiário opera todos os casos, mas não recebe o mapa de qual advogado
 *  atende qual cliente: para ele o caso de outra pessoa é só "Atribuído". */
function precPodeFiltrarPorAdvogado() { return permIsAdmin(); }

/* Lista de colegas (id/nome/papel) — não muda durante a sessão, então busca uma
   vez só. Sem isso, cada tecla digitada na busca custava uma requisição a mais. */
let _colegasCache = null;
async function precColegas() {
  if (_colegasCache) return _colegasCache;
  try { _colegasCache = await api("/api/auth/colegas"); }
  catch (e) { return []; }   // sem os nomes a tela continua funcionando
  return _colegasCache;
}

/** Descarta um filtro de responsável que não vale para o usuário atual.
 *
 * `precFilter` é global e o logout não recarrega a página: sem esta trava, um ID
 * herdado da sessão anterior seguiria na consulta. Para o advogado o backend
 * responderia com lista VAZIA (some até o que é dele), enquanto o select exibiria
 * "Todos" — filtro invisível e impossível de limpar pela tela. */
function precSanitizeResp() {
  const v = precFilter.responsavel;
  if (!v || v === "meus" || v === "fila") return;
  if (v === "atribuidos") {
    // Só faz sentido para quem enxerga casos de outras pessoas.
    if (!precPodeVerTodos()) precFilter.responsavel = "";
    return;
  }
  // Daqui para baixo é um ID de advogado: exclusivo do admin.
  if (!precPodeFiltrarPorAdvogado()) { precFilter.responsavel = ""; return; }
  // Filtrar por si mesmo é o próprio "Meus casos" — normaliza para a opção certa.
  if (CURRENT_USER && String(CURRENT_USER.id) === String(v)) precFilter.responsavel = "meus";
}

/* Opções do filtro por responsável, conforme o perfil:
   - Advogado ....: Todos (meus + fila) · Meus casos · Fila
   - Estagiário ..: Todos · Atribuídos · Meus casos · Disponíveis  (sem nomes)
   - Admin .......: as categorias + a lista de advogados
   O backend aplica exatamente a mesma regra — a tela só esconde. */
function precRespOptions(colegas) {
  const sel = precFilter.responsavel || "";
  const opt = (v, label) => `<option value="${v}" ${sel === String(v) ? "selected" : ""}>${label}</option>`;
  const veTudo = precPodeVerTodos();
  let html = opt("", veTudo ? "Todos os responsáveis" : "Todos (meus + fila)");
  if (veTudo) html += opt("atribuidos", "Atribuídos");
  html += opt("meus", "Meus casos")
        + opt("fila", veTudo ? "Disponíveis (fila)" : "Fila (sem responsável)");
  if (precPodeFiltrarPorAdvogado()) {
    const lista = colegas || [];
    const outros = lista.filter(u => u.id !== CURRENT_USER.id);
    if (outros.length) {
      html += `<optgroup label="Por advogado">`
            + outros.map(u => opt(u.id, esc(u.name))).join("")
            + `</optgroup>`;
    }
    // O responsável filtrado sumiu da lista (usuário excluído, ou /colegas fora
    // do ar): mostra a opção assim mesmo. Senão o select exibiria "Todos"
    // enquanto a consulta continua filtrada — e não daria para limpar o filtro.
    if (sel && !["meus", "fila", "atribuidos"].includes(sel) && !lista.some(u => String(u.id) === sel)) {
      html += opt(sel, "Responsável nº " + esc(sel) + " (fora da lista)");
    }
  }
  return html;
}

/** Algum filtro da tela de precatórios está ativo? (usado no estado vazio) */
function precTemFiltro() {
  return !!(precFilter.tribunal || precFilter.classificacao || precFilter.status_lead
            || precFilter.responsavel || precFilter.search);
}

function precBadge(k, map, colors) {
  if (!k) return '<span class="text-muted">—</span>';
  // ⚠️ Este helper é o sink de MAIOR alcance do arquivo: recebe classificacao,
  // status_lead e probabilidade_nivel, e desenha em 5 telas. `map[k] || k`
  // devolvia o valor cru do banco — XSS armazenado até ago/2026.
  return `<span class="badge bg-${(colors && colors[k]) || 'light text-dark border'}">${esc(map[k] || k)}</span>`;
}

async function importarPrecatoriosExcel(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = "";  // permite reenviar o mesmo arquivo depois
  showModal("Importando planilha", `
    <div class="text-center py-3">
      <div class="spinner-border text-success mb-3"></div>
      <div>Lendo <strong>${esc(file.name)}</strong> e criando os precatórios...</div>
      <div class="small text-muted mt-1">A IA do CRM vai analisar a importação em seguida.</div>
    </div>`, null, "Fechar");
  const setTitle = (t) => { const h = document.querySelector("#app-modal .modal-title"); if (h) h.textContent = t; };
  const setBody = (html) => { const b = document.querySelector("#app-modal .modal-body"); if (b) b.innerHTML = html; };
  try {
    const fd = new FormData(); fd.append("file", file);
    const r = await api("/api/precatorios/importar", { method: "POST", body: fd });
    renderPrecatorios();  // atualiza a lista por trás do modal
    const analiseHtml = r.analise
      ? `<hr><div class="small text-muted mb-1"><i class="bi bi-robot"></i> Análise da IA do CRM</div>
         <div class="alert alert-light border" style="white-space:pre-wrap">${esc(r.analise)}</div>`
      : `<div class="small text-muted mt-2"><i class="bi bi-info-circle"></i> IA não configurada — importação feita sem análise automática (defina a GEMINI_API_KEY para ativar).</div>`;
    // Duplicados barrados na entrada: mostra QUEM ficou de fora e por quê,
    // senão o admin acha que a planilha veio incompleta.
    const ign = r.detalhe_ignorados || [];
    const ignHtml = r.ignorados ? `
      <div class="alert alert-warning">
        <div><i class="bi bi-shield-check"></i> <strong>${r.ignorados}</strong> linha(s) <b>não</b> foram importadas por já existirem no CRM.</div>
        <div class="table-responsive mt-2" style="max-height:230px;overflow:auto">
          <table class="table table-sm mb-0"><thead><tr><th>Requerente</th><th>Número</th><th>Motivo</th></tr></thead>
          <tbody>${ign.map(i => `<tr><td>${esc(i.requerente)}</td><td><small>${esc(i.numero) || "—"}</small></td><td><small>${esc(i.motivo)}</small></td></tr>`).join("")}</tbody></table>
        </div>
        ${r.ignorados > ign.length ? `<div class="small mt-1">…e mais ${r.ignorados - ign.length}.</div>` : ""}
      </div>` : "";
    setTitle("Importação concluída");
    setBody(`
      <div class="alert ${r.criados ? "alert-success" : "alert-secondary"}"><i class="bi bi-check-circle"></i>
        <strong>${r.criados}</strong> precatório(s) importado(s) para a <strong>fila de triagem</strong>,
        sem classificação. Você define a categoria de cada um quando quiser.</div>
      ${ignHtml}${analiseHtml}`);
  } catch (e) {
    setTitle("Falha na importação");
    setBody(`<div class="alert alert-danger">${esc(e.message || "Erro ao importar")}</div>`);
  }
}

async function renderPrecatorios() {
  const c = document.getElementById("view-container");
  const isAdminPrec = CURRENT_USER.role === "admin";
  try {
    precSanitizeResp();   // nunca consultar com um filtro que não vale para este papel
    const qs = new URLSearchParams();
    Object.entries(precFilter).forEach(([k, v]) => { if (v) qs.append(k, v); });
    // Só o admin recebe os nomes: para o estagiário o caso de outra pessoa é
    // "Atribuído", e para o advogado a coluna só diz "Você"/"Disponível".
    // As duas chamadas vão em paralelo para não somar latência.
    const [items, colegas] = await Promise.all([
      api("/api/precatorios" + (qs.toString() ? "?" + qs : "")),
      precPodeFiltrarPorAdvogado() ? precColegas() : Promise.resolve([]),
    ]);
    const usersMap = {};
    colegas.forEach(u => usersMap[u.id] = u.name);
    const respCell = (p) => {
      if (!p.owner_id) return '<span class="badge bg-warning text-dark"><i class="bi bi-inbox me-1"></i>Disponível</span>';
      if (p.owner_id === CURRENT_USER.id) return '<span class="badge bg-success"><i class="bi bi-person-check me-1"></i>Você</span>';
      return `<span class="badge bg-secondary">${esc(usersMap[p.owner_id] || "Atribuído")}</span>`;
    };
    c.innerHTML = `
      <div class="section-toolbar">
        <input id="prec-search" class="form-control input-clean w-auto" placeholder="Buscar por nome ou CPF..." value="${esc(precFilter.search)}" style="min-width:230px">
        <select id="prec-trib" class="form-select input-clean w-auto"><option value="">Todos tribunais</option>${TRIBUNAIS.map(t => `<option ${precFilter.tribunal === t ? 'selected' : ''}>${t}</option>`).join("")}</select>
        <select id="prec-classif" class="form-select input-clean w-auto"><option value="">Toda classificação</option>${precClassifOptions().map(([k, v]) => `<option value="${k}" ${precFilter.classificacao === k ? 'selected' : ''}>${v}</option>`).join("")}</select>
        <select id="prec-lead" class="form-select input-clean w-auto"><option value="">Todo status comercial</option>${Object.entries(PREC_LEAD).map(([k, v]) => `<option value="${k}" ${precFilter.status_lead === k ? 'selected' : ''}>${v}</option>`).join("")}</select>
        <select id="prec-resp" class="form-select input-clean w-auto" title="Filtrar por responsável">${precRespOptions(colegas)}</select>
        <div class="ms-auto d-flex gap-2">
          ${CURRENT_USER.role === "admin" ? `<button class="btn btn-outline-danger" id="prec-del-sel" data-on-click="excluirPrecatoriosSelecionados" disabled><i class="bi bi-trash"></i> Excluir selecionados</button>` : ""}
          ${CURRENT_USER.role === "admin" ? `<input type="file" id="prec-xlsx" accept=".xlsx,.xlsm" style="display:none" data-on-change="acImportarXlsx"><button class="btn btn-outline-success" data-on-click="acAbrirSeletorXlsx"><i class="bi bi-file-earmark-excel"></i> Importar Excel</button><button class="btn btn-outline-warning" title="Procurar precatórios repetidos" data-on-click="auditarDuplicados" data-args="${escArgs('precatorios')}"><i class="bi bi-files"></i> Duplicados</button>` : ""}
          ${exportBtn("precatorios")}${permCanEdit("precatorios") ? `<button class="btn btn-primary" data-on-click="novoPrecatorio"><i class="bi bi-plus-lg"></i> Novo precatório</button>` : ""}
        </div>
      </div>
      <div class="card shadow-sm"><div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr>${isAdminPrec ? '<th style="width:34px"><input type="checkbox" id="prec-all" title="Selecionar todos" data-on-click="acPrecToggleAll"></th>' : ""}<th>Requerente</th><th>CPF</th><th>Tribunal</th><th>Classificação</th><th>Status comercial</th><th>Prob.</th><th>Responsável</th><th>Próx. contato</th><th></th></tr></thead>
          <tbody>${items.length ? items.map(p => `
            <tr style="cursor:pointer" data-on-click="abrirPrecatorio" data-args="${escArgs(p.id)}">
              ${isAdminPrec ? `<td data-on-click="acNada" data-stop="1"><input type="checkbox" class="prec-chk" value="${p.id}" data-on-click="precUpdateSel"></td>` : ""}
              <td><strong>${esc(p.requerente_nome) || "<span class='text-muted'>Sem nome</span>"}</strong></td>
              <td>${esc(p.requerente_cpf) || "—"}</td>
              <td>${esc(p.tribunal) || "—"}</td>
              <td>${precBadge(p.classificacao, PREC_CLASSIF)}</td>
              <td>${precBadge(p.status_lead, PREC_LEAD, PREC_LEAD_COLOR)}</td>
              <td>${precBadge(p.probabilidade_nivel, PREC_PROB, PREC_PROB_COLOR)}</td>
              <td>${respCell(p)}</td>
              <td>${p.data_proximo_contato ? fmtDate(p.data_proximo_contato) : "—"}</td>
              <td class="text-end text-nowrap">
                ${!p.owner_id ? `<button class="btn btn-sm btn-success" data-on-click="assumirPrecatorio" data-args="${escArgs(p.id)}" data-stop="1"><i class="bi bi-hand-index"></i> Assumir</button> ` : ""}
                ${p.owner_id && (CURRENT_USER.role === "admin" || p.owner_id === CURRENT_USER.id) ? `<button class="btn btn-sm btn-outline-warning" title="Devolver para a fila" data-on-click="liberarPrecatorio" data-args="${escArgs(p.id)}" data-stop="1"><i class="bi bi-arrow-counterclockwise"></i> Liberar</button> ` : ""}
                <button class="btn btn-sm btn-outline-primary" data-on-click="abrirPrecatorio" data-args="${escArgs(p.id)}" data-stop="1">Abrir <i class="bi bi-arrow-right"></i></button>
              </td>
            </tr>`).join("") : `<tr><td colspan="${isAdminPrec ? 10 : 9}" class="text-center text-muted py-3">${precTemFiltro() ? "Nenhum precatório para os filtros escolhidos." : 'Nenhum precatório. Clique em "Novo precatório".'}</td></tr>`}
          </tbody>
        </table>
      </div></div>`;
    let to;
    document.getElementById("prec-search").addEventListener("input", e => { precFilter.search = e.target.value; clearTimeout(to); to = setTimeout(renderPrecatorios, 450); });
    document.getElementById("prec-trib").addEventListener("change", e => { precFilter.tribunal = e.target.value; renderPrecatorios(); });
    document.getElementById("prec-classif").addEventListener("change", e => { precFilter.classificacao = e.target.value; renderPrecatorios(); });
    document.getElementById("prec-lead").addEventListener("change", e => { precFilter.status_lead = e.target.value; renderPrecatorios(); });
    document.getElementById("prec-resp").addEventListener("change", e => { precFilter.responsavel = e.target.value; renderPrecatorios(); });
  } catch (e) { c.innerHTML = errorBox(e); }
}

/* =========================================================
   FUNIL DE CLIENTES — PRECATÓRIOS (Kanban com drag-and-drop)
   Reaproveita os dados do módulo de Precatórios (status_lead = etapa).
   ========================================================= */
let funilCache = [];      // últimos precatórios carregados
let funilBusca = "";      // termo de pesquisa

function _funilCard(p, idx, total) {
  // prioridade: vermelho se próximo contato vencido; amarelo se sem próximo contato definido
  let prio = "", prioTit = "";
  const hoje = new Date().toISOString().slice(0, 10);
  if (p.data_proximo_contato && p.data_proximo_contato <= hoje && !PREC_LEAD_FECHADAS.includes(p.status_lead) && p.status_lead !== "perdido") {
    prio = "#e53e3e"; prioTit = "Contato em atraso";
  } else if (!p.data_proximo_contato && !PREC_LEAD_FECHADAS.includes(p.status_lead) && p.status_lead !== "perdido") {
    prio = "#d69e2e"; prioTit = "Sem próximo contato definido";
  }
  const resp = !p.owner_id ? '<span class="badge bg-warning text-dark">Fila</span>'
    : (p.owner_id === CURRENT_USER.id ? '<span class="badge bg-success">Você</span>'
      : `<span class="badge bg-secondary">${esc(funilUsers[p.owner_id] || "Atribuído")}</span>`);
  return `
    <div class="pipeline-card funil-card" draggable="true"
         ondragstart="_funilDrag(event, ${p.id})"
         data-on-click="abrirPrecatorio" data-args="${escArgs(p.id)}" style="cursor:pointer;${prio ? `border-left:4px solid ${prio};` : ""}">
      <div class="d-flex justify-content-between align-items-start">
        <strong>${esc(p.requerente_nome) || "<span class='text-muted'>Sem nome</span>"}</strong>
        ${prio ? `<span title="${prioTit}" style="color:${prio};font-size:.8rem">●</span>` : ""}
      </div>
      ${p.valor_caso ? `<div class="funil-valor">${fmtCausa(p.valor_caso)}</div>` : ""}
      <div class="small text-muted">${esc(p.tribunal || "")}${p.numero_precatorio ? " • " + esc(p.numero_precatorio) : ""}</div>
      <div class="d-flex justify-content-between align-items-center mt-1">
        ${resp}
        ${precBadge(p.probabilidade_nivel, PREC_PROB, PREC_PROB_COLOR)}
      </div>
      ${p.data_proximo_contato ? `<div class="small mt-1"><i class="bi bi-calendar-event"></i> ${fmtDate(p.data_proximo_contato)}</div>` : ""}
    </div>`;
}

let funilUsers = {};

function _funilFiltrar(lista) {
  const q = funilBusca.trim().toLowerCase();
  if (!q) return lista;
  return lista.filter(p =>
    (p.requerente_nome || "").toLowerCase().includes(q) ||
    (p.requerente_cpf || "").toLowerCase().includes(q) ||
    (p.processo_id || "").toLowerCase().includes(q) ||
    (p.numero_precatorio || "").toLowerCase().includes(q) ||
    (p.numero_originario || "").toLowerCase().includes(q));
}

function _funilDashboard(lista) {
  const total = lista.length;
  const fechados = lista.filter(p => PREC_LEAD_FECHADAS.includes(p.status_lead)).length;
  const perdidos = lista.filter(p => p.status_lead === "perdido").length;
  const emNeg = lista.filter(p => !PREC_LEAD_FECHADAS.includes(p.status_lead) && p.status_lead !== "perdido");
  const valorNeg = emNeg.reduce((s, p) => s + (p.valor_caso || 0), 0);
  const valorConv = lista.filter(p => PREC_LEAD_FECHADAS.includes(p.status_lead)).reduce((s, p) => s + (p.valor_caso || 0), 0);
  const taxa = total ? Math.round((fechados / total) * 100) : 0;
  const card = (cor, ico, val, lbl) => `${statCard(cor, ico, val, lbl)}`;
  return `
    <div class="row g-2 mb-3">
      ${card("bg-clients", "bi-people", total, "Clientes no funil")}
      ${card("bg-processes", "bi-graph-up-arrow", taxa + "%", "Taxa de conversão")}
      ${card("bg-finance", "bi-cash-coin", fmtCausa(valorNeg), "Em negociação")}
      ${card("bg-deadlines", "bi-trophy", fmtCausa(valorConv), "Valor convertido")}
    </div>`;
}

async function renderFunilPrec() {
  const c = document.getElementById("view-container");
  try {
    funilCache = await api("/api/precatorios");
    funilUsers = {};
    if (CURRENT_USER.role === "admin") { try { (await api("/api/auth/users")).forEach(u => funilUsers[u.id] = u.name); } catch (e) {} }
    // _funilDesenhar busca o #view-container DE NOVO: se a pessoa já trocou
    // de tela, desenharia o funil por cima da tela nova.
    if (!c.isConnected) return;
    _funilDesenhar();
  } catch (e) { c.innerHTML = errorBox(e); }
}

function _funilDesenhar() {
  const c = document.getElementById("view-container");
  const lista = _funilFiltrar(funilCache);
  const porEtapa = {};
  PREC_LEAD_ORDER.forEach(k => porEtapa[k] = []);
  lista.forEach(p => { (porEtapa[p.status_lead] || (porEtapa[p.status_lead] = [])).push(p); });

  const colunas = PREC_LEAD_ORDER.map(k => {
    const itens = porEtapa[k] || [];
    const soma = itens.reduce((s, p) => s + (p.valor_caso || 0), 0);
    return `
      <div class="pipeline-column funil-col" ondragover="_funilOver(event)" ondrop="_funilDrop(event,'${k}')">
        <h6 class="funil-col-head">
          <span><span class="dot bg-${(PREC_LEAD_COLOR[k] || 'secondary').split(' ')[0]}"></span> ${esc(PREC_LEAD[k])}</span>
          <span class="badge bg-light text-dark border">${itens.length}</span>
        </h6>
        ${soma ? `<div class="funil-col-sum">${fmtCausa(soma)}</div>` : ""}
        <div class="funil-col-body">
          ${itens.map((p, i) => _funilCard(p, i, itens.length)).join("") || '<div class="funil-empty">—</div>'}
        </div>
      </div>`;
  }).join("");

  c.innerHTML = `
    <div class="section-toolbar mb-2">
      <input id="funil-busca" class="form-control input-clean w-auto" placeholder="Buscar por nome, CPF ou processo..." value="${esc(funilBusca)}" style="min-width:260px">
      <div class="ms-auto d-flex gap-2">
        <button class="btn btn-outline-secondary" data-on-click="renderFunilPrec"><i class="bi bi-arrow-clockwise"></i> Atualizar</button>
        <button class="btn btn-primary" data-on-click="novoPrecatorio"><i class="bi bi-plus-lg"></i> Novo cliente</button>
      </div>
    </div>
    ${_funilDashboard(lista)}
    <div class="alert alert-secondary py-2 small mb-2"><i class="bi bi-hand-index"></i> Arraste os cartões entre as colunas para mudar a etapa. Clique no cartão para abrir o cadastro completo.</div>
    <div class="pipeline-board funil-board">${colunas}</div>`;
  const b = document.getElementById("funil-busca");
  let to; b.addEventListener("input", e => { funilBusca = e.target.value; clearTimeout(to); to = setTimeout(_funilDesenhar, 250); });
}

// ---- Drag and drop ----
let _funilDragId = null;
function _funilDrag(ev, id) { _funilDragId = id; ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", id); }
function _funilOver(ev) { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; }
async function _funilDrop(ev, etapa) {
  ev.preventDefault();
  const id = _funilDragId || parseInt(ev.dataTransfer.getData("text/plain"));
  _funilDragId = null;
  if (!id) return;
  const p = funilCache.find(x => x.id === id);
  if (!p || p.status_lead === etapa) return;
  const anterior = p.status_lead;
  p.status_lead = etapa;     // atualização otimista
  _funilDesenhar();
  try {
    await api(`/api/precatorios/${id}/mover`, { method: "POST", body: JSON.stringify({ status_lead: etapa }) });
    toast("Etapa atualizada!");
  } catch (e) {
    p.status_lead = anterior; _funilDesenhar();
    toast(e.message || "Falha ao mover", true);
  }
}

async function novoPrecatorio() {
  // O token é guardado ANTES do POST: se a pessoa sair da lista enquanto o
  // caso é criado, ele é criado (e avisado), mas a tela não a puxa de volta.
  const tk = typeof fichaRotaToken === "function" ? fichaRotaToken() : null;
  const p = await api("/api/precatorios", { method: "POST", body: JSON.stringify({}) });
  // Quem cadastra manualmente já assume o caso; admin deixa na fila para distribuir.
  if (CURRENT_USER.role !== "admin") {
    try { await api("/api/precatorios/" + p.id + "/assumir", { method: "POST" }); } catch (e) {}
  }
  if (!_casoAindaNaTela(tk)) { toast("Precatório #" + p.id + " criado — está na lista de Precatórios."); return; }
  abrirPrecatorio(p.id);
}

async function assumirPrecatorio(id) {
  try {
    await api("/api/precatorios/" + id + "/assumir", { method: "POST" });
    toast("Caso assumido! Você agora é o responsável.");
    renderPrecatorios();
  } catch (e) { toast(e.message, true); }
}

async function assumirNoCaso(id) {
  try {
    await api("/api/precatorios/" + id + "/assumir", { method: "POST" });
    toast("Caso assumido! Você agora é o responsável.");
    _casoReabrir("precatorios", id);
  } catch (e) { toast(e.message, true); }
}
async function liberarPrecatorio(id) {
  if (!confirm("Devolver este caso para a fila? Ele ficará disponível para outro advogado assumir.")) return;
  try { await api("/api/precatorios/" + id + "/liberar", { method: "POST" }); toast("Caso devolvido à fila."); renderPrecatorios(); }
  catch (e) { toast(e.message, true); }
}
async function liberarNoCaso(id) {
  if (!confirm("Devolver este caso para a fila? Ele ficará disponível para outro advogado assumir.")) return;
  try { await api("/api/precatorios/" + id + "/liberar", { method: "POST" }); toast("Caso devolvido à fila."); _casoReabrir("precatorios", id); }
  catch (e) { toast(e.message, true); }
}

/* ---------- Página de gestão de caso do precatório ---------- */
function _pf(id, label, value, type = "text", col = "col-md-6") {
  return `<div class="${col} mb-2"><label class="form-label small text-muted mb-1">${label}</label><input id="${id}" type="${type}" class="form-control" value="${value == null ? '' : esc(value)}"></div>`;
}
function _pa(id, label, value, col = "col-12", rows = 3) {
  return `<div class="${col} mb-2"><label class="form-label small text-muted mb-1">${label}</label><textarea id="${id}" class="form-control" rows="${rows}">${value == null ? '' : esc(value)}</textarea></div>`;
}
// Select de "Responsável" dos casos (precatório/ação).
// `data-orig` guarda o dono ATUAL: no salvar só mandamos `owner_id` se o admin
// tiver REALMENTE mexido aqui. Abrir um caso para consultar e salvar qualquer
// outro campo não pode reatribuir o dono.
// A opção em branco é obrigatória: caso da FILA tem owner_id nulo e, sem ela,
// o select mostrava a primeira pessoa da lista como se fosse a responsável.
function _ownerSelectHtml(id, ownerId, owners) {
  const orig = ownerId === null || ownerId === undefined ? "" : String(ownerId);
  return _ps(id, "Responsável", orig,
    owners.map(u => [String(u.id), u.name + " (" + u.role + ")"]),
    "col-md-6", "— Sem responsável (fila) —", `data-orig="${orig}"`);
}

// Lê o select de responsável para o payload, preservando o dono quando o admin
// não encostou no campo (devolve `undefined` = não manda a chave).
function _ownerSelectValor(id) {
  const el = document.getElementById(id);
  if (!el) return undefined;
  if (el.value === (el.dataset.orig || "")) return undefined;   // não mudou
  return el.value ? parseInt(el.value) : null;
}

function _ps(id, label, value, entries, col = "col-md-6", blank = "", attrs = "") {
  // Compara como TEXTO: o valor costuma vir do banco como número (ex.: owner_id)
  // e as chaves das opções são string. Com `===` nenhuma opção casava, o select
  // exibia a PRIMEIRA da lista e o save gravava essa — foi assim que todo caso
  // aberto pelo admin acabava atribuído a ele (a lista vem ordenada por nome).
  const sel = value === null || value === undefined ? "" : String(value);
  const opts = (blank ? `<option value="" ${sel === "" ? 'selected' : ''}>${blank}</option>` : "") +
    entries.map(([k, v]) => `<option value="${k}" ${sel === String(k) ? 'selected' : ''}>${esc(v)}</option>`).join("");
  return `<div class="${col} mb-2"><label class="form-label small text-muted mb-1">${label}</label><select id="${id}" class="form-select" ${attrs}>${opts}</select></div>`;
}

/* ---------- Páginas de caso (precatório e ação): URL, carga e vínculo ----------
   - URL própria (#/precatorios/<id>, #/acoes/<id>): F5 e link reabrem o mesmo
     caso. Já estando num caso do módulo (recarga depois de salvar, ou o
     roteador abrindo pelo hash) a entrada é TROCADA; vindo da lista, do funil
     ou de uma ficha, é EMPILHADA — e o Voltar do navegador volta para lá.
     Sempre por fichaSincronizarHash (pushState cru desalinharia o histórico
     do app e a guarda de alteração não salva).
   - Carga em PARALELO e tolerante: antes eram 6–7 chamadas em série e
     QUALQUER 403 derrubava a página — o estagiário (Financeiro bloqueado) não
     abria NENHUMA ação, porque a página pedia os honorários. Agora só o
     registro principal é obrigatório; o resto que falhar some da tela.
   - 404/403 do registro → "Registro não encontrado ou sem acesso" com o
     caminho de volta, e não a caixa vermelha de erro. */
function _casoSincronizarUrl(modulo, id) {
  if (typeof fichaSincronizarHash !== "function") return null;
  const jaNoCaso = new RegExp("^#/" + modulo + "/\\d+").test(location.hash);
  fichaSincronizarHash("#/" + modulo + "/" + id, { replace: jaNoCaso });
  return typeof fichaRotaToken === "function" ? fichaRotaToken() : null;
}
function _casoAindaNaTela(tk) {
  return tk === null || typeof fichaRotaValida !== "function" || fichaRotaValida(tk);
}
/** Recarrega o caso DEPOIS de gravar (salvar, contato, documento, assumir…),
 *  mas SÓ se a pessoa ainda está nele. Antes era `abrirPrecatorio(id)` direto:
 *  quem clicava em Salvar e logo em seguida ia para o Dashboard era puxado de
 *  volta para o caso quando o PUT terminava. modulo: "precatorios" | "acoes".
 *  (O nome _casoRecarregar já é do seletor de casos do honorário.) */
function _casoReabrir(modulo, id) {
  const r = typeof fichaRotaAtual === "function" ? fichaRotaAtual() : null;
  if (r && (r.padrao !== modulo + "/:id" || String(r.params.id) !== String(id))) return false;
  if (modulo === "acoes") abrirAcao(id); else abrirPrecatorio(id);
  return true;
}
/** Registro principal falhou: 404/403 orienta; o resto é erro de verdade. */
function _casoFalhou(c, e, hashLista, rotuloLista) {
  if (e && (e.status === 404 || e.status === 403) && typeof fichaNaoEncontrada === "function") {
    fichaNaoEncontrada(hashLista, rotuloLista);
    return;
  }
  c.innerHTML = errorBox(e || new Error("Não foi possível abrir o caso."));
}
function _casoResultado(r, padrao) { return r && r.status === "fulfilled" ? r.value : padrao; }
/** Select "Cliente cadastrado (vincular)": o cliente já vinculado que NÃO está
 *  na lista (é de outro responsável) vira a opção "Cliente de outro
 *  responsável" — sem ela o select abria em "Não vinculado" e qualquer Salvar
 *  DESVINCULAVA o caso em silêncio. */
function _casoClienteEntradas(clientes, clientId) {
  const entradas = (clientes || []).map(cl => [String(cl.id), cl.name + (cl.cpf_cnpj ? " — " + cl.cpf_cnpj : "")]);
  if (clientId && !entradas.some(([k]) => k === String(clientId))) entradas.unshift([String(clientId), "Cliente de outro responsável"]);
  return entradas;
}
function _semPermissao() { const e = new Error("Sem permissão"); e.status = 403; return Promise.reject(e); }

/** Contêiner para a página de caso. Aberta pela LISTA (fora do roteador),
 *  troca o nó como o roteador faz: um render da lista ainda pendente escreve
 *  no nó velho em vez de cobrir o caso (ver fichaTrocarContainer). */
function _casoContainer() {
  return typeof fichaTrocarContainer === "function" ? fichaTrocarContainer() : document.getElementById("view-container");
}

async function abrirPrecatorio(id) {
  const c = _casoContainer();
  const tk = _casoSincronizarUrl("precatorios", id);
  c.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>';
  const [rp, rct, rdoc, rtl, rcli, rown] = await Promise.allSettled([
    api("/api/precatorios/" + id),
    api("/api/precatorios/" + id + "/contatos"),
    permCanView("documents") ? api("/api/documents?precatorio_id=" + id) : _semPermissao(),
    api("/api/precatorios/" + id + "/timeline"),
    permCanView("clients") ? api("/api/clients") : _semPermissao(),
    CURRENT_USER.role === "admin" ? api("/api/auth/users") : Promise.resolve([]),
  ]);
  if (!_casoAindaNaTela(tk)) return;          // a pessoa já foi para outra tela
  if (rp.status === "rejected") return _casoFalhou(c, rp.reason, "#/precatorios", "Precatórios");
  try {
    const p = rp.value;
    const contatos = _casoResultado(rct, []);
    const docs = rdoc.status === "fulfilled" ? rdoc.value : null;   // null = sem acesso: a aba some
    const tl = _casoResultado(rtl, { events: [] });
    const semClientes = rcli.status === "rejected";
    const cliEntries = _casoClienteEntradas(_casoResultado(rcli, []), p.client_id);
    const owners = _casoResultado(rown, []);

    const tribEntries = TRIBUNAIS.map(t => [t, t]);
    const tlIcon = { precatorio: "bi-flag", contato: "bi-telephone", documento: "bi-file-earmark" };

    document.getElementById("view-title").textContent = p.requerente_nome || "Precatório";
    c.innerHTML = `
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <button class="btn btn-outline-secondary btn-sm" data-on-click="fichaVoltar" data-args="${escArgs("#/precatorios")}"><i class="bi bi-arrow-left"></i> Voltar</button>
        <h4 class="mb-0 me-2">${esc(p.requerente_nome) || "Novo precatório"}</h4>
        ${precBadge(p.classificacao, PREC_CLASSIF)}
        ${precBadge(p.status_lead, PREC_LEAD, PREC_LEAD_COLOR)}
        ${!p.owner_id ? '<span class="badge bg-warning text-dark"><i class="bi bi-inbox me-1"></i>Disponível na fila</span>' : ""}
        <div class="ms-auto d-flex gap-2">
          ${!p.owner_id ? `<button class="btn btn-success" data-on-click="assumirNoCaso" data-args="${escArgs(id)}"><i class="bi bi-hand-index"></i> Assumir</button>` : ""}
          ${p.owner_id && (CURRENT_USER.role === "admin" || p.owner_id === CURRENT_USER.id) ? `<button class="btn btn-outline-warning" data-on-click="liberarNoCaso" data-args="${escArgs(id)}" title="Devolver para a fila"><i class="bi bi-arrow-counterclockwise"></i> Liberar</button>` : ""}
          <button class="btn btn-success" data-on-click="salvarPrecatorio" data-args="${escArgs(id)}"><i class="bi bi-check-lg"></i> Salvar</button>
          ${CURRENT_USER.role === "admin" ? `<button class="btn btn-outline-danger" data-on-click="deletePrecatorio" data-args="${escArgs(id)}"><i class="bi bi-trash"></i></button>` : ""}
        </div>
      </div>

      <ul class="nav nav-tabs mb-3" role="tablist">
        <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#pc-tab-req" type="button">Requerente</button></li>
        <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#pc-tab-proc" type="button">Processual</button></li>
        <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#pc-tab-com" type="button">Comercial</button></li>
        ${docs ? `<li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#pc-tab-doc" type="button">Documentos <span class="badge bg-secondary">${docs.length}</span></button></li>` : ""}
        <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#pc-tab-tl" type="button">Timeline</button></li>
      </ul>

      <div class="tab-content">
        <!-- Requerente -->
        <div class="tab-pane fade show active" id="pc-tab-req">
          <div class="card shadow-sm"><div class="card-body"><div class="row g-2">
            ${_ps("pc-client", "Cliente cadastrado (vincular)", p.client_id ? String(p.client_id) : "", cliEntries, "col-12", "— Não vinculado —", semClientes ? 'disabled title="Sem acesso ao módulo Clientes"' : "")}
            ${_pf("pc-nome", "Nome completo", p.requerente_nome, "text", "col-md-8")}
            ${_pf("pc-cpf", "CPF", p.requerente_cpf, "text", "col-md-4")}
            ${_pf("pc-rg", "RG", p.requerente_rg, "text", "col-md-4")}
            ${_pf("pc-nasc", "Data de nascimento", p.requerente_nascimento, "date", "col-md-4")}
            ${_pf("pc-tel", "Telefone", p.requerente_telefone, "text", "col-md-4")}
            ${_pf("pc-email", "E-mail", p.requerente_email, "email", "col-md-6")}
            ${_pa("pc-end", "Endereço", p.requerente_endereco, "col-12", 2)}
          </div></div></div>
        </div>

        <!-- Processual -->
        <div class="tab-pane fade" id="pc-tab-proc">
          <div class="card shadow-sm"><div class="card-body"><div class="row g-2">
            ${_pf("pc-pid", "Nº do Processo TRF", p.processo_id, "text", "col-md-4")}
            ${_pf("pc-orig", "Nº originário", p.numero_originario, "text", "col-md-4")}
            ${_pf("pc-numprec", "Nº do precatório", p.numero_precatorio, "text", "col-md-4")}
            ${_ps("pc-trib", "Tribunal", p.tribunal || "", tribEntries, "col-md-4", "—")}
            ${_pf("pc-vara", "Vara", p.vara, "text", "col-md-4")}
            ${_pf("pc-classe", "Classe", p.classe, "text", "col-md-4")}
            ${_pf("pc-assunto", "Assunto do Caso", p.assunto || p.tema, "text", "col-md-8")}
            ${_ps("pc-banco", "Banco de pagamento", p.banco || "", Object.entries(PREC_BANCO), "col-md-4", "—")}
            ${_pa("pc-obs", "Observações processuais", p.observacoes, "col-12", 3)}
          </div></div></div>
        </div>

        <!-- Comercial -->
        <div class="tab-pane fade" id="pc-tab-com">
          <div class="card shadow-sm mb-3"><div class="card-body"><div class="row g-2">
            ${_ps("pc-classif", "Classificação", p.classificacao || "", precClassifOptions(), "col-md-4", "—")}
            ${_ps("pc-lead", "Status comercial", p.status_lead || "novos_leads", Object.entries(PREC_LEAD), "col-md-4")}
            ${_ps("pc-probnivel", "Probabilidade", p.probabilidade_nivel || "", Object.entries(PREC_PROB), "col-md-4", "—")}
            <div class="col-md-4 mb-2"><label class="form-label small text-muted mb-1">Valor do caso (R$)</label>
              <input id="pc-valor" class="form-control" inputmode="numeric" placeholder="0,00" value="${_fmtMoedaInit(p.valor_caso)}" data-on-input="acMaskMoeda"></div>
            ${_pf("pc-pct", "Honorários contratados (%)", p.percentual_honorarios, "number", "col-md-4")}
            ${_pf("pc-adv", "Advogado (texto livre)", p.advogado, "text", "col-md-4")}
            ${_pf("pc-ult", "Último contato", p.data_ultimo_contato, "date", "col-md-3")}
            ${_pf("pc-prox", "Próximo contato", p.data_proximo_contato, "date", "col-md-3")}
            ${owners.length ? _ownerSelectHtml("pc-owner", p.owner_id, owners) : ""}
            ${_pa("pc-anot", "Anotações comerciais", p.anotacoes, "col-12", 3)}
          </div></div></div>

          <div class="card shadow-sm"><div class="card-body">
            <div class="d-flex align-items-center mb-2">
              <h6 class="mb-0">Histórico de contatos</h6>
              <button class="btn btn-sm btn-primary ms-auto" data-on-click="precAddContato" data-args="${escArgs(id)}"><i class="bi bi-plus-lg"></i> Registrar contato</button>
            </div>
            <ul class="list-group list-group-flush">${contatos.length ? contatos.map(ct => `
              <li class="list-group-item d-flex justify-content-between align-items-start px-0">
                <div><span class="badge bg-light text-dark border me-2">${esc(PREC_CONTATO[ct.tipo] || ct.tipo)}</span>${esc(ct.descricao) || "<span class='text-muted'>sem descrição</span>"}<br><small class="text-muted">${_fmtCarimbo(ct.data)}</small></div>
                <button class="btn btn-sm btn-link text-danger" data-on-click="precDelContato" data-args="${escArgs(id, ct.id)}"><i class="bi bi-trash"></i></button>
              </li>`).join("") : '<li class="list-group-item text-muted px-0">Nenhum contato registrado.</li>'}</ul>
          </div></div>
        </div>

        <!-- Documentos -->
        ${docs ? `<div class="tab-pane fade" id="pc-tab-doc">
          <div class="card shadow-sm"><div class="card-body">
            <div class="d-flex align-items-center mb-2">
              <h6 class="mb-0">Documentos do caso</h6>
              <button class="btn btn-sm btn-primary ms-auto" data-on-click="precUploadDoc" data-args="${escArgs(id)}"><i class="bi bi-upload"></i> Enviar documento</button>
            </div>
            <ul class="list-group list-group-flush">${docs.length ? docs.map(d => `
              <li class="list-group-item d-flex justify-content-between align-items-center px-0">
                <div><i class="bi bi-file-earmark-text"></i> ${esc(d.original_name)} ${d.categoria ? `<span class="badge bg-light text-dark border ms-1">${esc(PREC_DOC_CAT[d.categoria] || d.categoria)}</span>` : ""}<br><small class="text-muted">${_fmtCarimbo(d.uploaded_at)}</small></div>
                <div class="text-nowrap">
                  <button class="btn btn-sm btn-outline-primary" data-on-click="downloadDoc" data-args="${escArgs(d.id, d.original_name)}"><i class="bi bi-download"></i></button>
                  <button class="btn btn-sm btn-outline-danger" data-on-click="precDelDoc" data-args="${escArgs(id, d.id)}"><i class="bi bi-trash"></i></button>
                </div>
              </li>`).join("") : '<li class="list-group-item text-muted px-0">Nenhum documento.</li>'}</ul>
          </div></div>
        </div>` : ""}

        <!-- Timeline -->
        <div class="tab-pane fade" id="pc-tab-tl">
          <div class="card shadow-sm"><div class="card-body">
            <ul class="timeline-list list-unstyled mb-0">${tl.events.length ? tl.events.map(ev => `
              <li class="d-flex gap-2 mb-3">
                <i class="bi ${tlIcon[ev.tipo] || 'bi-dot'} fs-5 text-primary"></i>
                <div><strong>${esc(ev.titulo)}</strong> <small class="text-muted">• ${fmtDateTime(ev.data)}</small><br><span class="text-muted">${esc(ev.detalhe)}</span></div>
              </li>`).join("") : '<li class="text-muted">Sem eventos ainda.</li>'}</ul>
          </div></div>
        </div>
      </div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function salvarPrecatorio(id) {
  const g = (x) => { const e = document.getElementById(x); return e ? e.value.trim() : ""; };
  const payload = {
    client_id: g("pc-client") ? parseInt(g("pc-client")) : null,
    requerente_nome: g("pc-nome") || null, requerente_cpf: g("pc-cpf") || null, requerente_rg: g("pc-rg") || null,
    requerente_nascimento: g("pc-nasc") || null, requerente_telefone: g("pc-tel") || null,
    requerente_email: g("pc-email") || null, requerente_endereco: g("pc-end") || null,
    processo_id: g("pc-pid") || null, numero_originario: g("pc-orig") || null, numero_precatorio: g("pc-numprec") || null,
    tribunal: g("pc-trib") || null, vara: g("pc-vara") || null, classe: g("pc-classe") || null,
    assunto: g("pc-assunto") || null, banco: g("pc-banco") || null,
    observacoes: g("pc-obs") || null,
    classificacao: g("pc-classif") || null, status_lead: g("pc-lead") || null,
    probabilidade_nivel: g("pc-probnivel") || null,
    valor_caso: _parseMoeda(g("pc-valor")),
    percentual_honorarios: g("pc-pct") !== "" ? parseFloat(g("pc-pct")) : null,
    data_ultimo_contato: g("pc-ult") || null, data_proximo_contato: g("pc-prox") || null,
    advogado: g("pc-adv") || null, anotacoes: g("pc-anot") || null,
  };
  const novoOwner = _ownerSelectValor("pc-owner");
  if (novoOwner !== undefined) payload.owner_id = novoOwner;
  try {
    await api("/api/precatorios/" + id, { method: "PUT", body: JSON.stringify(payload) });
    // Escolher "— Sem responsável (fila) —" devolve o caso para a fila. O PUT
    // não serve: lá `owner_id` nulo significa "não mexer no dono".
    if (novoOwner === null) await api("/api/precatorios/" + id + "/liberar", { method: "POST" });
    toast("Precatório salvo!");
    _casoReabrir("precatorios", id);
  } catch (e) { toast("Erro ao salvar: " + e.message, true); }
}

async function precAddContato(id) {
  showModal("Registrar contato", `
    <div class="mb-2"><label class="form-label">Tipo</label><select id="ct-tipo" class="form-select">${Object.entries(PREC_CONTATO).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="mb-2"><label class="form-label">Descrição</label><textarea id="ct-desc" class="form-control" rows="3"></textarea></div>
  `, async () => {
    await api("/api/precatorios/" + id + "/contatos", { method: "POST", body: JSON.stringify({ tipo: val("ct-tipo"), descricao: val("ct-desc") }) });
    closeModal(); toast("Contato registrado!"); _casoReabrir("precatorios", id);
  });
}
async function precDelContato(pid, cid) {
  if (!confirm("Excluir este contato?")) return;
  await api("/api/precatorios/" + pid + "/contatos/" + cid, { method: "DELETE" });
  toast("Contato excluído"); _casoReabrir("precatorios", pid);
}

async function precUploadDoc(id) {
  showModal("Enviar documento", `
    <div class="mb-2"><label class="form-label">Arquivo*</label><input type="file" id="pd-file" class="form-control"></div>
    <div class="mb-2"><label class="form-label">Categoria</label><select id="pd-cat" class="form-select">${Object.entries(PREC_DOC_CAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
  `, async () => {
    const fi = document.getElementById("pd-file");
    if (!fi.files.length) return toast("Selecione um arquivo", true);
    const fd = new FormData();
    fd.append("file", fi.files[0]);
    fd.append("precatorio_id", id);
    fd.append("categoria", val("pd-cat"));
    await api("/api/documents", { method: "POST", body: fd });
    closeModal(); toast("Documento enviado!"); _casoReabrir("precatorios", id);
  });
}
async function precDelDoc(pid, did) {
  if (!confirm("Excluir este documento?")) return;
  await api("/api/documents/" + did, { method: "DELETE" });
  toast("Documento excluído"); _casoReabrir("precatorios", pid);
}

async function deletePrecatorio(id) {
  if (!(await _confirmarExclusao("Excluir este precatório?"))) return;
  try { await api("/api/precatorios/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return; }
  toast("Precatório excluído!");
  // O caso some: a URL não pode continuar apontando para ele (F5 = 404).
  if (typeof irPara === "function") irPara("#/precatorios", { replace: true }); else renderPrecatorios();
}

// ---- Seleção múltipla + exclusão em lote (Precatórios) ----
function precSelecionados() {
  return Array.from(document.querySelectorAll(".prec-chk:checked")).map(c => parseInt(c.value));
}
function precUpdateSel() {
  const n = precSelecionados().length;
  const btn = document.getElementById("prec-del-sel");
  if (btn) { btn.disabled = n === 0; btn.innerHTML = `<i class="bi bi-trash"></i> Excluir selecionados${n ? ` (${n})` : ""}`; }
  const all = document.getElementById("prec-all");
  const total = document.querySelectorAll(".prec-chk").length;
  if (all) all.checked = total > 0 && n === total;
}
function precToggleAll(cb) {
  document.querySelectorAll(".prec-chk").forEach(c => { c.checked = cb.checked; });
  precUpdateSel();
}
async function excluirPrecatoriosSelecionados() {
  const ids = precSelecionados();
  if (!ids.length) return;
  if (!confirm(`Excluir ${ids.length} caso(s) selecionado(s)? Esta ação não pode ser desfeita.`)) return;
  try {
    const r = await api("/api/precatorios/excluir-lote", { method: "POST", body: JSON.stringify({ ids }) });
    toast(`${r.apagados} caso(s) excluído(s)!`);
    renderPrecatorios();
  } catch (e) { toast(e.message || "Falha ao excluir", true); }
}

/* =========================================================
   AÇÕES JUDICIAIS GERAIS (espelha Precatórios)
   ========================================================= */
const ACAO_AREA = { civel: "Cível", trabalhista: "Trabalhista", previdenciario: "Previdenciário", consumidor: "Consumidor", bancario: "Bancário", tributario: "Tributário", familia: "Família", sucessoes: "Sucessões", outras: "Outras" };
let acaoFilter = { area: "", status_lead: "", search: "" };

async function renderAcoes() {
  const c = document.getElementById("view-container");
  try {
    const qs = new URLSearchParams();
    Object.entries(acaoFilter).forEach(([k, v]) => { if (v) qs.append(k, v); });
    const items = await api("/api/acoes" + (qs.toString() ? "?" + qs : ""));
    let usersMap = {};
    if (CURRENT_USER.role === "admin") { try { (await api("/api/auth/users")).forEach(u => usersMap[u.id] = u.name); } catch (e) {} }
    const respCell = (a) => {
      if (!a.owner_id) return '<span class="badge bg-warning text-dark"><i class="bi bi-inbox me-1"></i>Disponível</span>';
      if (a.owner_id === CURRENT_USER.id) return '<span class="badge bg-success"><i class="bi bi-person-check me-1"></i>Você</span>';
      return `<span class="badge bg-secondary">${esc(usersMap[a.owner_id] || "Atribuído")}</span>`;
    };
    c.innerHTML = `
      <div class="section-toolbar">
        <input id="acao-search" class="form-control input-clean w-auto" placeholder="Buscar parte, CPF ou nº do processo..." value="${esc(acaoFilter.search)}" style="min-width:240px">
        <select id="acao-area" class="form-select input-clean w-auto"><option value="">Todas as áreas</option>${Object.entries(ACAO_AREA).map(([k, v]) => `<option value="${k}" ${acaoFilter.area === k ? 'selected' : ''}>${v}</option>`).join("")}</select>
        <select id="acao-lead" class="form-select input-clean w-auto"><option value="">Todo status comercial</option>${Object.entries(PREC_LEAD).map(([k, v]) => `<option value="${k}" ${acaoFilter.status_lead === k ? 'selected' : ''}>${v}</option>`).join("")}</select>
        <div class="ms-auto">${permCanEdit("acoes") ? `<button class="btn btn-primary" data-on-click="novaAcao"><i class="bi bi-plus-lg"></i> Nova ação</button>` : ""}</div>
      </div>
      <div class="card shadow-sm"><div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>Parte</th><th>Área</th><th>Nº do processo</th><th>Status comercial</th><th>Prob.</th><th>Valor da causa</th><th>Responsável</th><th></th></tr></thead>
          <tbody>${items.length ? items.map(a => `
            <tr style="cursor:pointer" data-on-click="abrirAcao" data-args="${escArgs(a.id)}">
              <td><strong>${esc(a.parte_nome) || "<span class='text-muted'>Sem nome</span>"}</strong></td>
              <td>${ACAO_AREA[a.area] || "—"}</td>
              <td>${esc(a.numero_processo) || "—"}</td>
              <td>${precBadge(a.status_lead, PREC_LEAD, PREC_LEAD_COLOR)}</td>
              <td>${precBadge(a.probabilidade_nivel, PREC_PROB, PREC_PROB_COLOR)}</td>
              <td>${a.valor_causa != null ? brl(a.valor_causa) : "—"}</td>
              <td>${respCell(a)}</td>
              <td class="text-end text-nowrap">
                ${!a.owner_id ? `<button class="btn btn-sm btn-success" data-on-click="assumirAcao" data-args="${escArgs(a.id)}" data-stop="1"><i class="bi bi-hand-index"></i> Assumir</button> ` : ""}
                ${a.owner_id && (CURRENT_USER.role === "admin" || a.owner_id === CURRENT_USER.id) ? `<button class="btn btn-sm btn-outline-warning" title="Devolver para a fila" data-on-click="liberarAcao" data-args="${escArgs(a.id)}" data-stop="1"><i class="bi bi-arrow-counterclockwise"></i> Liberar</button> ` : ""}
                <button class="btn btn-sm btn-outline-primary" data-on-click="abrirAcao" data-args="${escArgs(a.id)}" data-stop="1">Abrir <i class="bi bi-arrow-right"></i></button>
              </td>
            </tr>`).join("") : '<tr><td colspan="8" class="text-center text-muted py-3">Nenhuma ação. Clique em "Nova ação".</td></tr>'}
          </tbody>
        </table>
      </div></div>`;
    let to;
    document.getElementById("acao-search").addEventListener("input", e => { acaoFilter.search = e.target.value; clearTimeout(to); to = setTimeout(renderAcoes, 450); });
    document.getElementById("acao-area").addEventListener("change", e => { acaoFilter.area = e.target.value; renderAcoes(); });
    document.getElementById("acao-lead").addEventListener("change", e => { acaoFilter.status_lead = e.target.value; renderAcoes(); });
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function novaAcao() {
  const tk = typeof fichaRotaToken === "function" ? fichaRotaToken() : null;   // ver novoPrecatorio
  const a = await api("/api/acoes", { method: "POST", body: JSON.stringify({}) });
  if (CURRENT_USER.role !== "admin") { try { await api("/api/acoes/" + a.id + "/assumir", { method: "POST" }); } catch (e) {} }
  if (!_casoAindaNaTela(tk)) { toast("Ação #" + a.id + " criada — está na lista de Ações Gerais."); return; }
  abrirAcao(a.id);
}
async function assumirAcao(id) {
  try { await api("/api/acoes/" + id + "/assumir", { method: "POST" }); toast("Caso assumido! Você é o responsável."); renderAcoes(); } catch (e) { toast(e.message, true); }
}
async function assumirNoCasoAcao(id) {
  try { await api("/api/acoes/" + id + "/assumir", { method: "POST" }); toast("Caso assumido!"); _casoReabrir("acoes", id); } catch (e) { toast(e.message, true); }
}
async function liberarAcao(id) {
  if (!confirm("Devolver este caso para a fila? Ele ficará disponível para outro advogado assumir.")) return;
  try { await api("/api/acoes/" + id + "/liberar", { method: "POST" }); toast("Caso devolvido à fila."); renderAcoes(); } catch (e) { toast(e.message, true); }
}
async function liberarNoCasoAcao(id) {
  if (!confirm("Devolver este caso para a fila? Ele ficará disponível para outro advogado assumir.")) return;
  try { await api("/api/acoes/" + id + "/liberar", { method: "POST" }); toast("Caso devolvido à fila."); _casoReabrir("acoes", id); } catch (e) { toast(e.message, true); }
}

async function abrirAcao(id) {
  const c = _casoContainer();
  const tk = _casoSincronizarUrl("acoes", id);
  c.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>';
  const [ra, rct, rdoc, rtl, rhon, rcli, rown] = await Promise.allSettled([
    api("/api/acoes/" + id),
    api("/api/acoes/" + id + "/contatos"),
    permCanView("documents") ? api("/api/documents?acao_id=" + id) : _semPermissao(),
    api("/api/acoes/" + id + "/timeline"),
    permCanView("financeiro") ? api("/api/honorarios?acao_id=" + id) : _semPermissao(),
    permCanView("clients") ? api("/api/clients") : _semPermissao(),
    CURRENT_USER.role === "admin" ? api("/api/auth/users") : Promise.resolve([]),
  ]);
  if (!_casoAindaNaTela(tk)) return;          // a pessoa já foi para outra tela
  if (ra.status === "rejected") return _casoFalhou(c, ra.reason, "#/acoes", "Ações Gerais");
  try {
    const a = ra.value;
    const contatos = _casoResultado(rct, []);
    const docs = rdoc.status === "fulfilled" ? rdoc.value : null;   // null = sem acesso: a aba some
    const tl = _casoResultado(rtl, { events: [] });
    const hons = rhon.status === "fulfilled" ? rhon.value : null;   // estagiário: Financeiro bloqueado
    const semClientes = rcli.status === "rejected";
    const cliEntriesA = _casoClienteEntradas(_casoResultado(rcli, []), a.client_id);
    const owners = _casoResultado(rown, []);
    const tlIcon = { acao: "bi-flag", contato: "bi-telephone", documento: "bi-file-earmark" };
    document.getElementById("view-title").textContent = a.parte_nome || "Ação";
    c.innerHTML = `
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <button class="btn btn-outline-secondary btn-sm" data-on-click="fichaVoltar" data-args="${escArgs("#/acoes")}"><i class="bi bi-arrow-left"></i> Voltar</button>
        <h4 class="mb-0 me-2">${esc(a.parte_nome) || "Nova ação"}</h4>
        ${a.area ? `<span class="badge bg-primary">${esc(ACAO_AREA[a.area] || a.area)}</span>` : ""}
        ${precBadge(a.status_lead, PREC_LEAD, PREC_LEAD_COLOR)}
        ${!a.owner_id ? '<span class="badge bg-warning text-dark"><i class="bi bi-inbox me-1"></i>Disponível na fila</span>' : ""}
        <div class="ms-auto d-flex gap-2">
          ${!a.owner_id ? `<button class="btn btn-success" data-on-click="assumirNoCasoAcao" data-args="${escArgs(id)}"><i class="bi bi-hand-index"></i> Assumir</button>` : ""}
          ${a.owner_id && (CURRENT_USER.role === "admin" || a.owner_id === CURRENT_USER.id) ? `<button class="btn btn-outline-warning" data-on-click="liberarNoCasoAcao" data-args="${escArgs(id)}" title="Devolver para a fila"><i class="bi bi-arrow-counterclockwise"></i> Liberar</button>` : ""}
          <button class="btn btn-success" data-on-click="salvarAcao" data-args="${escArgs(id)}"><i class="bi bi-check-lg"></i> Salvar</button>
          ${CURRENT_USER.role === "admin" ? `<button class="btn btn-outline-danger" data-on-click="deleteAcao" data-args="${escArgs(id)}"><i class="bi bi-trash"></i></button>` : ""}
        </div>
      </div>
      <ul class="nav nav-tabs mb-3" role="tablist">
        <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#ac-tab-parte" type="button">Parte</button></li>
        <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#ac-tab-proc" type="button">Processual</button></li>
        <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#ac-tab-com" type="button">Comercial</button></li>
        ${docs ? `<li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#ac-tab-doc" type="button">Documentos <span class="badge bg-secondary">${docs.length}</span></button></li>` : ""}
        ${hons ? `<li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#ac-tab-hon" type="button">Honorários <span class="badge bg-secondary">${hons.length}</span></button></li>` : ""}
        <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#ac-tab-tl" type="button">Timeline</button></li>
      </ul>
      <div class="tab-content">
        <div class="tab-pane fade show active" id="ac-tab-parte"><div class="card shadow-sm"><div class="card-body"><div class="row g-2">
          ${_ps("ac-client", "Cliente cadastrado (vincular)", a.client_id ? String(a.client_id) : "", cliEntriesA, "col-12", "— Não vinculado —", semClientes ? 'disabled title="Sem acesso ao módulo Clientes"' : "")}
          ${_pf("ac-nome", "Nome completo", a.parte_nome, "text", "col-md-8")}
          ${_pf("ac-cpf", "CPF/CNPJ", a.parte_cpf, "text", "col-md-4")}
          ${_pf("ac-rg", "RG", a.parte_rg, "text", "col-md-4")}
          ${_pf("ac-nasc", "Data de nascimento", a.parte_nascimento, "date", "col-md-4")}
          ${_pf("ac-tel", "Telefone", a.parte_telefone, "text", "col-md-4")}
          ${_pf("ac-email", "E-mail", a.parte_email, "email", "col-md-6")}
          ${_pa("ac-end", "Endereço", a.parte_endereco, "col-12", 2)}
        </div></div></div></div>
        <div class="tab-pane fade" id="ac-tab-proc"><div class="card shadow-sm"><div class="card-body"><div class="row g-2">
          ${_ps("ac-area", "Área", a.area || "", Object.entries(ACAO_AREA), "col-md-4", "—")}
          ${_pf("ac-numproc", "Nº do processo", a.numero_processo, "text", "col-md-4")}
          ${_pf("ac-comarca", "Comarca", a.comarca, "text", "col-md-4")}
          ${_pf("ac-vara", "Vara", a.vara, "text", "col-md-4")}
          ${_pf("ac-classe", "Classe", a.classe, "text", "col-md-4")}
          ${_pf("ac-assunto", "Assunto do Caso", a.assunto, "text", "col-md-4")}
          ${_pa("ac-obs", "Observações processuais", a.observacoes, "col-12", 3)}
        </div></div></div></div>
        <div class="tab-pane fade" id="ac-tab-com">
          <div class="card shadow-sm mb-3"><div class="card-body"><div class="row g-2">
            ${_ps("ac-lead", "Status comercial", a.status_lead || "novos_leads", Object.entries(PREC_LEAD), "col-md-4")}
            ${_ps("ac-probnivel", "Probabilidade", a.probabilidade_nivel || "", Object.entries(PREC_PROB), "col-md-4", "—")}
            <div class="col-md-4 mb-2"><label class="form-label small text-muted mb-1" for="ac-valor">Valor da causa (R$)</label>
              <input id="ac-valor" class="form-control" inputmode="numeric" autocomplete="off" placeholder="0,00" value="${esc(_fmtMoedaInit(a.valor_causa))}" data-on-input="acMaskMoeda"></div>
            ${_pf("ac-pct", "Honorários contratados (%)", a.percentual_honorarios, "number", "col-md-4")}
            ${_pf("ac-ult", "Último contato", a.data_ultimo_contato, "date", "col-md-4")}
            ${_pf("ac-prox", "Próximo contato", a.data_proximo_contato, "date", "col-md-4")}
            ${owners.length ? _ownerSelectHtml("ac-owner", a.owner_id, owners) : ""}
            ${_pa("ac-anot", "Anotações comerciais", a.anotacoes, "col-12", 3)}
          </div></div></div>
          <div class="card shadow-sm"><div class="card-body">
            <div class="d-flex align-items-center mb-2"><h6 class="mb-0">Histórico de contatos</h6><button class="btn btn-sm btn-primary ms-auto" data-on-click="acaoAddContato" data-args="${escArgs(id)}"><i class="bi bi-plus-lg"></i> Registrar contato</button></div>
            <ul class="list-group list-group-flush">${contatos.length ? contatos.map(ct => `
              <li class="list-group-item d-flex justify-content-between align-items-start px-0">
                <div><span class="badge bg-light text-dark border me-2">${esc(PREC_CONTATO[ct.tipo] || ct.tipo)}</span>${esc(ct.descricao) || "<span class='text-muted'>sem descrição</span>"}<br><small class="text-muted">${_fmtCarimbo(ct.data)}</small></div>
                <button class="btn btn-sm btn-link text-danger" data-on-click="acaoDelContato" data-args="${escArgs(id, ct.id)}"><i class="bi bi-trash"></i></button>
              </li>`).join("") : '<li class="list-group-item text-muted px-0">Nenhum contato registrado.</li>'}</ul>
          </div></div>
        </div>
        ${docs ? `<div class="tab-pane fade" id="ac-tab-doc"><div class="card shadow-sm"><div class="card-body">
          <div class="d-flex align-items-center mb-2"><h6 class="mb-0">Documentos do caso</h6><button class="btn btn-sm btn-primary ms-auto" data-on-click="acaoUploadDoc" data-args="${escArgs(id)}"><i class="bi bi-upload"></i> Enviar documento</button></div>
          <ul class="list-group list-group-flush">${docs.length ? docs.map(d => `
            <li class="list-group-item d-flex justify-content-between align-items-center px-0">
              <div><i class="bi bi-file-earmark-text"></i> ${esc(d.original_name)} ${d.categoria ? `<span class="badge bg-light text-dark border ms-1">${esc(PREC_DOC_CAT[d.categoria] || d.categoria)}</span>` : ""}<br><small class="text-muted">${_fmtCarimbo(d.uploaded_at)}</small></div>
              <div class="text-nowrap"><button class="btn btn-sm btn-outline-primary" data-on-click="downloadDoc" data-args="${escArgs(d.id, d.original_name)}"><i class="bi bi-download"></i></button> <button class="btn btn-sm btn-outline-danger" data-on-click="acaoDelDoc" data-args="${escArgs(id, d.id)}"><i class="bi bi-trash"></i></button></div>
            </li>`).join("") : '<li class="list-group-item text-muted px-0">Nenhum documento.</li>'}</ul>
        </div></div></div>` : ""}
        ${hons ? `<div class="tab-pane fade" id="ac-tab-hon"><div class="card shadow-sm"><div class="card-body">
          <div class="d-flex align-items-center mb-2"><h6 class="mb-0">Honorários do caso</h6><button class="btn btn-sm btn-primary ms-auto" data-on-click="acNovoHonorarioAcao" data-args="${escArgs(id)}"><i class="bi bi-plus-lg"></i> Novo honorário</button></div>
          <ul class="list-group list-group-flush">${hons.length ? hons.map(hh => `
            <li class="list-group-item d-flex justify-content-between align-items-center px-0">
              <div>${esc(HON_TYPE[hh.type] || hh.type)} — <strong>${fmtMoney(hh.total_value)}</strong> <small class="text-muted">(pago ${fmtMoney(hh.paid_value)})</small>${hh.origem === 'parceria' ? ` <span class="badge bg-info text-dark">Parceria ${hh.pct_escritorio || 0}/${hh.pct_parceiro || 0}</span>` : ""}<br>${finStatusBadge(hh.status)} <small class="text-muted">venc. ${fmtDate(hh.due_date)}</small></div>
            </li>`).join("") : '<li class="list-group-item text-muted px-0">Nenhum honorário. O que você lançar aqui também aparece no módulo Financeiro.</li>'}</ul>
        </div></div></div>` : ""}
        <div class="tab-pane fade" id="ac-tab-tl"><div class="card shadow-sm"><div class="card-body">
          <ul class="timeline-list list-unstyled mb-0">${tl.events.length ? tl.events.map(ev => `
            <li class="d-flex gap-2 mb-3"><i class="bi ${tlIcon[ev.tipo] || 'bi-dot'} fs-5 text-primary"></i><div><strong>${esc(ev.titulo)}</strong> <small class="text-muted">• ${fmtDateTime(ev.data)}</small><br><span class="text-muted">${esc(ev.detalhe)}</span></div></li>`).join("") : '<li class="text-muted">Sem eventos ainda.</li>'}</ul>
        </div></div></div>
      </div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function salvarAcao(id) {
  const g = (x) => { const e = document.getElementById(x); return e ? e.value.trim() : ""; };
  const payload = {
    client_id: g("ac-client") ? parseInt(g("ac-client")) : null,
    area: g("ac-area") || null,
    parte_nome: g("ac-nome") || null, parte_cpf: g("ac-cpf") || null, parte_rg: g("ac-rg") || null,
    parte_nascimento: g("ac-nasc") || null, parte_telefone: g("ac-tel") || null, parte_email: g("ac-email") || null, parte_endereco: g("ac-end") || null,
    numero_processo: g("ac-numproc") || null, comarca: g("ac-comarca") || null, vara: g("ac-vara") || null, classe: g("ac-classe") || null, assunto: g("ac-assunto") || null,
    observacoes: g("ac-obs") || null,
    status_lead: g("ac-lead") || null, probabilidade_nivel: g("ac-probnivel") || null,
    valor_causa: _parseMoeda(g("ac-valor")),
    percentual_honorarios: g("ac-pct") !== "" ? parseFloat(g("ac-pct")) : null,
    data_ultimo_contato: g("ac-ult") || null, data_proximo_contato: g("ac-prox") || null,
    anotacoes: g("ac-anot") || null,
  };
  const novoOwnerA = _ownerSelectValor("ac-owner");
  if (novoOwnerA !== undefined) payload.owner_id = novoOwnerA;
  try {
    await api("/api/acoes/" + id, { method: "PUT", body: JSON.stringify(payload) });
    if (novoOwnerA === null) await api("/api/acoes/" + id + "/liberar", { method: "POST" });
    toast("Ação salva!"); _casoReabrir("acoes", id);
  }
  catch (e) { toast("Erro ao salvar: " + e.message, true); }
}

async function deleteAcao(id) {
  if (!(await _confirmarExclusao("Excluir esta ação?"))) return;
  try { await api("/api/acoes/" + id, { method: "DELETE" }); }
  catch (e) { toast(e.message, true); return; }
  toast("Ação excluída!");
  if (typeof irPara === "function") irPara("#/acoes", { replace: true }); else renderAcoes();
}
async function acaoAddContato(id) {
  showModal("Registrar contato", `
    <div class="mb-2"><label class="form-label">Tipo</label><select id="act-tipo" class="form-select">${Object.entries(PREC_CONTATO).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="mb-2"><label class="form-label">Descrição</label><textarea id="act-desc" class="form-control" rows="3"></textarea></div>
  `, async () => { await api("/api/acoes/" + id + "/contatos", { method: "POST", body: JSON.stringify({ tipo: val("act-tipo"), descricao: val("act-desc") }) }); closeModal(); toast("Contato registrado!"); _casoReabrir("acoes", id); });
}
async function acaoDelContato(aid, cid) {
  if (!confirm("Excluir este contato?")) return;
  await api("/api/acoes/" + aid + "/contatos/" + cid, { method: "DELETE" }); toast("Contato excluído"); _casoReabrir("acoes", aid);
}
async function acaoUploadDoc(id) {
  showModal("Enviar documento", `
    <div class="mb-2"><label class="form-label">Arquivo*</label><input type="file" id="acd-file" class="form-control"></div>
    <div class="mb-2"><label class="form-label">Categoria</label><select id="acd-cat" class="form-select">${Object.entries(PREC_DOC_CAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
  `, async () => {
    const fi = document.getElementById("acd-file"); if (!fi.files.length) return toast("Selecione um arquivo", true);
    const fd = new FormData(); fd.append("file", fi.files[0]); fd.append("acao_id", id); fd.append("categoria", val("acd-cat"));
    await api("/api/documents", { method: "POST", body: fd }); closeModal(); toast("Documento enviado!"); _casoReabrir("acoes", id);
  });
}
async function acaoDelDoc(aid, did) {
  if (!confirm("Excluir este documento?")) return;
  await api("/api/documents/" + did, { method: "DELETE" }); toast("Documento excluído"); _casoReabrir("acoes", aid);
}

/* =========================================================
   ASSINATURAS (modelos por área + PDF + status; Clicksign em breve)
   ========================================================= */
const ASSIN_TIPO = { procuracao: "Procuração", contrato: "Contrato de Honorários" };
const ASSIN_CAT = { procuracao: "Procuração", contrato: "Contrato", declaracao: "Declaração", peticao: "Petição", termo: "Termo", outro: "Documento" };
const ASSIN_AREA = { precatorios: "Precatórios", civel: "Cível", trabalhista: "Trabalhista" };
const ASSIN_STATUS = { rascunho: "Rascunho", enviado: "Enviado", visualizado: "Visualizado", assinado: "Assinado", recusado: "Recusado", expirado: "Expirado" };
/** Devolve TEXTO (não escapado): o fallback é a chave crua do banco — e o
 *  upload grava a `categoria` sem lista fechada. Sempre dentro de esc(). */
function assinTipoLabel(t) { return ASSIN_TIPO[t] || ASSIN_CAT[t] || t; }

async function renderAssinaturas() {
  const c = document.getElementById("view-container");
  try {
    const items = await api("/api/assinaturas");
    c.innerHTML = `
      <div class="d-flex justify-content-end mb-3">
        <button class="btn btn-primary" data-on-click="assinaturaModal"><i class="bi bi-plus-lg"></i> Novo documento</button>
      </div>
      <div class="card shadow-sm"><div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>Documento</th><th>Tipo</th><th>Área</th><th>Vínculo</th><th>Status</th><th>Criado</th><th></th></tr></thead>
          <tbody>${items.length ? items.map(a => `
            <tr>
              <td><strong>${esc(a.titulo) || "—"}</strong></td>
              <td>${esc(assinTipoLabel(a.tipo))}</td>
              <td>${a.area === 'anexo' ? '<span class="badge bg-light text-dark border">Anexo</span>' : esc(ASSIN_AREA[a.area] || a.area)}</td>
              <td>${esc(a.precatorio_label || a.client_name || "—")}</td>
              <td><select class="form-select form-select-sm w-auto" data-on-change="acStatusAssinatura" data-args="${escArgs(a.id)}">
                ${Object.entries(ASSIN_STATUS).map(([k, v]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${v}</option>`).join("")}
              </select></td>
              <td><small>${_fmtCarimbo(a.created_at)}</small></td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-primary" title="Ver PDF" data-on-click="downloadAssinatura" data-args="${escArgs(a.id)}"><i class="bi bi-file-earmark-pdf"></i></button>
                ${a.clicksign_key
                  ? `<button class="btn btn-sm btn-outline-secondary" title="Reenviar e-mail ao signatário" data-on-click="renotificarAssinatura" data-args="${escArgs(a.id)}"><i class="bi bi-envelope"></i></button>
                     <button class="btn btn-sm btn-outline-info" title="Sincronizar status (Clicksign)" data-on-click="sincronizarAssinatura" data-args="${escArgs(a.id)}"><i class="bi bi-arrow-repeat"></i></button>`
                  : `<button class="btn btn-sm btn-outline-success" title="Enviar para assinatura (Clicksign)" data-on-click="enviarClicksign" data-args="${escArgs(a.id)}"><i class="bi bi-send"></i></button>`}
                ${permPodeExcluir() ? `<button class="btn btn-sm btn-outline-danger" title="Excluir" data-on-click="deleteAssinatura" data-args="${escArgs(a.id)}"><i class="bi bi-trash"></i></button>` : ""}
              </td>
            </tr>`).join("") : '<tr><td colspan="7" class="text-center text-muted py-3">Nenhum documento gerado ainda.</td></tr>'}
          </tbody>
        </table>
      </div></div>
      <p class="text-muted small mt-2"><i class="bi bi-info-circle"></i> Gere procurações e contratos com os dados preenchidos automaticamente. A assinatura digital (Clicksign) será habilitada em breve.</p>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function assinaturaModal() {
  const precs = await api("/api/precatorios");
  const clients = await api("/api/clients");
  const cliOpts = (idAttr) => clients.map(c => `<option value="${c.id}" data-email="${esc(c.email || '')}">${esc(c.name)}${c.email ? '' : ' (sem e-mail)'}</option>`).join("");
  showModal("Novo documento para assinatura", `
    <div class="mb-3"><label class="form-label">Como criar o documento</label>
      <select id="as-modo" class="form-select" data-on-change="acToggleOrigemAssinatura">
        <option value="modelo">Gerar a partir de um modelo do sistema</option>
        <option value="anexo">Anexar documento próprio (PDF)</option>
      </select></div>

    <!-- MODO MODELO -->
    <div id="as-sec-modelo">
      <div class="row g-2">
        <div class="col-md-6"><label class="form-label">Tipo de documento</label>
          <select id="as-tipo" class="form-select">${Object.entries(ASSIN_TIPO).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div class="col-md-6"><label class="form-label">Área</label>
          <select id="as-area" class="form-select">${Object.entries(ASSIN_AREA).map(([k, v]) => `<option value="${k}" ${k === 'precatorios' ? 'selected' : ''}>${v}</option>`).join("")}</select></div>
        <div class="col-12"><label class="form-label">Vincular a</label>
          <select id="as-fonte" class="form-select" data-on-change="acToggleVinculoAssinatura">
            <option value="precatorio">Precatório</option>
            <option value="cliente">Cliente</option>
          </select></div>
        <div class="col-12" id="as-prec-wrap"><label class="form-label">Precatório</label>
          <select id="as-prec" class="form-select"><option value="">Selecione...</option>${precs.map(p => `<option value="${p.id}">${esc(p.requerente_nome || ('Precatório #' + p.id))}${p.requerente_cpf ? ' — ' + esc(p.requerente_cpf) : ''}</option>`).join("")}</select></div>
        <div class="col-12" id="as-cli-wrap" style="display:none"><label class="form-label">Cliente</label>
          <select id="as-cli" class="form-select"><option value="">Selecione...</option>${cliOpts()}</select></div>
      </div>
      <p class="text-muted small mt-2">Os dados do signatário são preenchidos automaticamente a partir do vínculo escolhido.</p>
    </div>

    <!-- MODO ANEXO -->
    <div id="as-sec-anexo" style="display:none">
      <div class="row g-2">
        <div class="col-12"><label class="form-label">Arquivo (PDF)*</label>
          <input type="file" id="as-file" class="form-control" accept="application/pdf,.pdf"></div>
        <div class="col-md-6"><label class="form-label">Categoria</label>
          <select id="as-cat" class="form-select">${Object.entries(ASSIN_CAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div class="col-md-6"><label class="form-label">Cliente (signatário)</label>
          <select id="as-upcli" class="form-select" data-on-change="acEmailDestinatario">
            <option value="">Selecione...</option>${cliOpts()}</select></div>
        <div class="col-12"><small id="as-up-email" class="text-muted"></small></div>
      </div>
      <p class="text-muted small mt-2">O documento é anexado e a solicitação de assinatura vai para o e-mail cadastrado do cliente.</p>
    </div>
  `, async () => {
    const modo = val("as-modo");
    if (modo === "anexo") {
      const fi = document.getElementById("as-file");
      if (!fi.files.length) return toast("Anexe um arquivo PDF", true);
      const cid = val("as-upcli"); if (!cid) return toast("Selecione o cliente", true);
      const fd = new FormData();
      fd.append("file", fi.files[0]);
      fd.append("categoria", val("as-cat"));
      fd.append("client_id", cid);
      await api("/api/assinaturas/upload", { method: "POST", body: fd });
      closeModal(); toast("Documento anexado!"); renderAssinaturas();
      return;
    }
    const payload = { tipo: val("as-tipo"), area: val("as-area") };
    if (val("as-fonte") === "precatorio") {
      const id = val("as-prec"); if (!id) return toast("Selecione um precatório", true);
      payload.precatorio_id = parseInt(id);
    } else {
      const id = val("as-cli"); if (!id) return toast("Selecione um cliente", true);
      payload.client_id = parseInt(id);
    }
    await api("/api/assinaturas", { method: "POST", body: JSON.stringify(payload) });
    closeModal(); toast("Documento gerado!"); renderAssinaturas();
  });
}

async function setAssinaturaStatus(id, status) {
  try { await api("/api/assinaturas/" + id, { method: "PUT", body: JSON.stringify({ status }) }); toast("Status atualizado"); }
  catch (e) { toast("Erro: " + e.message, true); }
}
async function downloadAssinatura(id) {
  const res = await fetch(API + "/api/assinaturas/" + id + "/pdf", { headers: { Authorization: "Bearer " + TOKEN } });
  if (!res.ok) { toast("Erro ao abrir o PDF", true); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
async function enviarClicksign(id) {
  if (!confirm("Enviar este documento para assinatura digital via Clicksign?")) return;
  try { await api("/api/assinaturas/" + id + "/enviar", { method: "POST" }); toast("Enviado ao Clicksign!"); renderAssinaturas(); }
  catch (e) { toast(e.message, true); }
}
async function sincronizarAssinatura(id) {
  try { await api("/api/assinaturas/" + id + "/sincronizar", { method: "POST" }); toast("Status sincronizado"); renderAssinaturas(); }
  catch (e) { toast(e.message, true); }
}
async function renotificarAssinatura(id) {
  try { await api("/api/assinaturas/" + id + "/notificar", { method: "POST" }); toast("E-mail reenviado ao signatário!"); }
  catch (e) { toast(e.message, true); }
}
async function deleteAssinatura(id) {
  if (!confirm("Excluir este documento?")) return;
  await api("/api/assinaturas/" + id, { method: "DELETE" });
  toast("Documento excluído"); renderAssinaturas();
}

/* =========================================================
   GESTÃO DE USUÁRIOS (somente admin)
   ========================================================= */
const ROLE_LABEL = { admin: "Administrador", advogado: "Advogado", estagiario: "Estagiário" };
const ROLE_BADGE = { admin: "bg-dark", estagiario: "bg-info text-dark", advogado: "bg-secondary" };

async function renderUsuarios() {
  const c = document.getElementById("view-container");
  try {
    const users = await api("/api/auth/users");
    c.innerHTML = `
      <div class="section-toolbar">
        <span class="text-muted small"><i class="bi bi-info-circle"></i> Crie um acesso para cada advogado. A senha definida aqui é entregue a ele para o primeiro login.</span>
        <button class="btn btn-primary ms-auto" data-on-click="usuarioModal"><i class="bi bi-plus-lg"></i> Novo usuário</button>
      </div>
      <div class="card"><div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead><tr><th>Nome</th><th>Usuário</th><th>Papel</th><th>Acesso</th><th>Criado em</th><th></th></tr></thead>
          <tbody>${users.map(u => `
            <tr>
              <td><strong>${esc(u.name)}</strong></td>
              <td>${esc(u.email)}</td>
              <td><span class="badge ${ROLE_BADGE[u.role] || 'bg-secondary'}">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
              <td>${acessoBadge(u)}</td>
              <td>${fmtDateTime(u.created_at)}</td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-secondary" title="Permissões de acesso" data-on-click="permissoesModal" data-args="${escArgs(u.id)}"><i class="bi bi-shield-lock"></i></button>
                <button class="btn btn-sm btn-outline-primary" title="Editar / redefinir senha" data-on-click="usuarioModal" data-args="${escArgs(u.id)}"><i class="bi bi-pencil"></i></button>
                ${u.id === CURRENT_USER.id ? '' : `<button class="btn btn-sm btn-outline-danger" data-on-click="deleteUsuario" data-args="${escArgs(u.id)}"><i class="bi bi-trash"></i></button>`}
              </td>
            </tr>`).join("")}</tbody>
        </table>
      </div></div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

async function usuarioModal(id) {
  let u = { name: "", email: "", role: "advogado" };
  let editing = false;
  if (id) { u = (await api("/api/auth/users")).find(x => x.id === id) || u; editing = true; }
  showModal(editing ? "Editar usuário" : "Novo usuário", `
    <div class="mb-2"><label class="form-label">Nome*</label><input id="u-name" class="form-control" value="${esc(u.name)}"></div>
    <div class="mb-2"><label class="form-label">Usuário*</label>
      <input id="u-email" type="text" class="form-control" value="${esc(u.email)}" ${editing ? 'disabled' : ''}>
      ${editing ? '<small class="text-muted">O usuário não pode ser alterado.</small>' : '<small class="text-muted">Pode ser um nome de usuário ou e-mail (sem espaços).</small>'}</div>
    <div class="mb-2"><label class="form-label">Senha${editing ? ' (deixe em branco para manter)' : '*'}</label>
      <input id="u-pass" type="text" class="form-control" placeholder="${editing ? 'manter senha atual' : 'senha de acesso'}"></div>
    <div class="mb-2"><label class="form-label">Papel</label>
      <select id="u-role" class="form-select">
        <option value="advogado" ${u.role === 'advogado' ? 'selected' : ''}>Advogado</option>
        <option value="estagiario" ${u.role === 'estagiario' ? 'selected' : ''}>Estagiário</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option>
      </select>
      <small class="text-muted">
        <b>Advogado:</b> vê apenas os próprios casos.
        <b>Estagiário:</b> vê os casos de todo o escritório, opera o dia a dia,
        mas nunca acessa o Financeiro nem exclui registros.
        <b>Administrador:</b> acesso total.
      </small></div>
  `, async () => {
    const name = val("u-name");
    if (!name) return toast("Nome é obrigatório", true);
    if (editing) {
      const payload = { name, role: val("u-role") };
      const pass = val("u-pass");
      if (pass) payload.password = pass;
      await api("/api/auth/users/" + id, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      const email = val("u-email"), pass = val("u-pass");
      if (!email || !pass) return toast("Usuário e senha são obrigatórios", true);
      const role = val("u-role");
      const novo = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name, email, password: pass, role }) });
      closeModal(); renderUsuarios();
      // Advogado recém-criado nasce com acesso total: já abrimos a tela de
      // permissões para o admin restringir o que quiser.
      if (novo && novo.id && role !== "admin") {
        toast("Usuário criado! Agora defina as permissões de acesso.");
        setTimeout(() => permissoesModal(novo.id), 450);
      } else {
        toast("Usuário salvo!");
      }
      return;
    }
    closeModal(); toast("Usuário salvo!"); renderUsuarios();
  });
}

async function deleteUsuario(id) {
  if (!confirm("Excluir este usuário? Ele perderá o acesso ao sistema.")) return;
  try {
    await api("/api/auth/users/" + id, { method: "DELETE" });
    toast("Usuário excluído!"); renderUsuarios();
  } catch (e) {
    // Sem este catch a exceção subia e MORRIA aqui: o toast de sucesso não
    // rodava, nenhum erro aparecia, e para o admin a exclusão simplesmente
    // "não acontecia". O 409 do backend explica o que está travando — de
    // nada adianta ele existir se a tela não mostra.
    alert(e.message || "Não foi possível excluir o usuário.");
  }
}

/* ---------------- Permissões de acesso (somente admin) ---------------- */
function acessoBadge(u) {
  if (u.role === "admin") return '<span class="badge bg-dark">Total (admin)</span>';
  if (!u.permissions) return '<span class="badge bg-success">Total</span>';
  const m = u.permissions.modules || {};
  const vis = Object.keys(m).filter(k => m[k] && m[k].view).length;
  const total = Object.keys(m).length || 0;
  const extras = [];
  if ((u.permissions.precatorios_classificacoes || []).length) extras.push("classificações");
  if ((u.permissions.acoes_areas || []).length) extras.push("áreas");
  const detalhe = total ? `${vis}/${total} módulos` : "restrito";
  const sufixo = extras.length ? ` + ${extras.join(" e ")}` : "";
  return `<span class="badge bg-warning text-dark" title="Restrições aplicadas">Restrito — ${detalhe}${sufixo}</span>`;
}

async function permissoesModal(id) {
  let cat, alvo;
  try {
    const [catalogo, users] = await Promise.all([
      api("/api/auth/permissoes/catalogo"),
      api("/api/auth/users"),
    ]);
    cat = catalogo;
    alvo = users.find(x => x.id === id);
  } catch (e) { return toast(e.message || "Erro ao carregar as permissões", true); }
  if (!alvo) return toast("Usuário não encontrado", true);

  // Administrador nunca é restringido
  if (alvo.role === "admin") {
    return showModal("Permissões — " + alvo.name, `
      <div class="alert alert-secondary mb-0">
        <i class="bi bi-shield-lock"></i> <strong>${esc(alvo.name)}</strong> é
        <strong>administrador</strong> e sempre tem acesso total a todos os módulos.
        Para poder restringir o acesso, altere o papel dele para <em>Advogado</em>.
      </div>`, null, "Fechar");
  }

  const p = alvo.permissions || null;
  const mods = (p && p.modules) || null;           // null = nada configurado = tudo liberado
  const classifSel = (p && p.precatorios_classificacoes) || [];
  const areasSel = (p && p.acoes_areas) || [];
  const podeVer = k => !mods || !!(mods[k] && mods[k].view);
  const podeEditar = k => !mods || !!(mods[k] && mods[k].edit);
  // Quando não há restrição salva, todas as caixas de classificação/área vêm marcadas
  const classifMarcadas = classifSel.length ? classifSel : cat.precatorios_classificacoes.map(x => x.key);
  const areasMarcadas = areasSel.length ? areasSel : cat.acoes_areas.map(x => x.key);

  const linhas = cat.modules.map(m => `
    <tr>
      <td>${esc(m.label)}</td>
      <td class="text-center"><input type="checkbox" class="form-check-input perm-view" data-k="${m.key}" ${podeVer(m.key) ? "checked" : ""}></td>
      <td class="text-center"><input type="checkbox" class="form-check-input perm-edit" data-k="${m.key}" ${podeEditar(m.key) ? "checked" : ""}></td>
    </tr>`).join("");

  const caixas = (itens, marcados, cls) => itens.map(x => `
    <div class="col-md-6">
      <div class="form-check">
        <input class="form-check-input ${cls}" type="checkbox" id="${cls}-${x.key}" data-k="${x.key}" ${marcados.includes(x.key) ? "checked" : ""}>
        <label class="form-check-label" for="${cls}-${x.key}">${esc(x.label)}</label>
      </div>
    </div>`).join("");

  showModal("Permissões — " + alvo.name, `
    <div class="alert alert-info py-2 small mb-3">
      <i class="bi bi-info-circle"></i>
      <strong>Editar</strong> exige <strong>Ver</strong>. Se tudo ficar marcado e nenhuma restrição de
      classificação/área for aplicada, o usuário volta a ter <strong>acesso total</strong>.
      Precatórios <em>sem classificação definida</em> só aparecem para o administrador.
      A segregação por responsável continua valendo: o advogado segue vendo apenas os próprios casos e a fila.
    </div>
    <div class="d-flex gap-2 mb-2">
      <button type="button" class="btn btn-sm btn-outline-secondary" id="perm-all">Marcar tudo</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" id="perm-none">Limpar módulos</button>
    </div>
    <table class="table table-sm align-middle">
      <thead><tr>
        <th>Módulo</th>
        <th class="text-center" style="width:90px">Ver</th>
        <th class="text-center" style="width:90px">Editar</th>
      </tr></thead>
      <tbody>${linhas}</tbody>
    </table>
    <hr>
    <h6 class="mb-1">Precatórios — classificações liberadas</h6>
    <p class="text-muted small mb-2">Marque só o que este usuário pode alcançar. Ex.: apenas <em>Com alvará</em>.</p>
    <div class="row g-1 mb-3">${caixas(cat.precatorios_classificacoes, classifMarcadas, "perm-classif")}</div>
    <h6 class="mb-1">Ações Gerais — áreas liberadas</h6>
    <div class="row g-1">${caixas(cat.acoes_areas, areasMarcadas, "perm-area")}</div>
  `, async () => {
    const modules = {};
    document.querySelectorAll("#app-modal .perm-view").forEach(cb => {
      modules[cb.dataset.k] = { view: cb.checked, edit: false };
    });
    document.querySelectorAll("#app-modal .perm-edit").forEach(cb => {
      const k = cb.dataset.k;
      if (modules[k]) modules[k].edit = cb.checked && modules[k].view;
    });
    const marcados = cls => Array.from(document.querySelectorAll("#app-modal ." + cls))
      .filter(c => c.checked).map(c => c.dataset.k);
    const classif = marcados("perm-classif");
    const areas = marcados("perm-area");

    // Zero classificações com o módulo visível é ambíguo — exige decisão explícita.
    if (modules.precatorios && modules.precatorios.view && classif.length === 0)
      return toast("Marque ao menos uma classificação de precatório, ou desmarque o módulo Precatórios.", true);
    if (modules.acoes && modules.acoes.view && areas.length === 0)
      return toast("Marque ao menos uma área de ação, ou desmarque o módulo Ações Gerais.", true);

    const permissions = { modules, precatorios_classificacoes: classif, acoes_areas: areas };
    await api("/api/auth/users/" + id, { method: "PUT", body: JSON.stringify({ permissions }) });
    closeModal(); toast("Permissões atualizadas!"); renderUsuarios();
  }, "Cancelar", "modal-lg");

  // Atalhos e coerência das caixas
  document.getElementById("perm-all").onclick = () =>
    document.querySelectorAll("#app-modal .form-check-input").forEach(cb => { cb.checked = true; });
  document.getElementById("perm-none").onclick = () =>
    document.querySelectorAll("#app-modal .perm-view, #app-modal .perm-edit").forEach(cb => { cb.checked = false; });

  document.querySelectorAll("#app-modal .perm-edit").forEach(cb => {
    cb.addEventListener("change", () => {          // marcar Editar liga o Ver
      if (!cb.checked) return;
      const v = document.querySelector(`#app-modal .perm-view[data-k="${cb.dataset.k}"]`);
      if (v) v.checked = true;
    });
  });
  document.querySelectorAll("#app-modal .perm-view").forEach(cb => {
    cb.addEventListener("change", () => {          // desmarcar Ver desliga o Editar
      if (cb.checked) return;
      const e = document.querySelector(`#app-modal .perm-edit[data-k="${cb.dataset.k}"]`);
      if (e) e.checked = false;
    });
  });
}

/* =========================================================
   TRILHA DE AUDITORIA (somente admin)
   ========================================================= */
const AUDIT_MODULO = {
  clients: "Clientes", processes: "Processos", deadlines: "Prazos", appointments: "Agenda",
  documents: "Documentos", pipeline: "Funil", honorarios: "Financeiro", precatorios: "Precatórios",
  acoes: "Ações", assinaturas: "Assinaturas", monitor: "Monitoramento", auth: "Usuários",
};
const AUDIT_ACAO = { POST: "Criou", PUT: "Editou", DELETE: "Excluiu", VIEW: "Visualizou", DOWNLOAD: "Baixou", EXPORT: "Exportou", ARQUIVAR: "Arquivou", RETENCAO: "Retenção", ALERTA: "ALERTA" };
// Singular, para a referência do alvo ("Precatório #486") — o AUDIT_MODULO é plural.
const AUDIT_ALVO_TIPO = { precatorios: "Precatório", acoes: "Ação", clients: "Cliente", processes: "Processo" };

// Célula "Alvo": mostra o NOME do caso, não só o número.
// "quem olhou o precatório #486" não responde nada a quem está auditando —
// ninguém decora ID. O backend resolve o nome pelo ID (inclusive nos registros
// antigos, que foram gravados só com o número).
function auditAlvoHtml(l, d) {
  if (d.alerta) return `<small class="text-danger fw-semibold">${esc(d.alvo)}</small>`;
  if (l.alvo_nome) {
    const ref = l.alvo_tipo
      ? `${esc(AUDIT_ALVO_TIPO[l.alvo_tipo] || l.alvo_tipo)} #${l.alvo_id}`
      : "#" + l.alvo_id;
    return `<div class="small fw-semibold">${esc(l.alvo_nome)}</div>
            <small class="text-muted">${esc(ref)}</small>`;
  }
  // Sem nome: ou o registro foi excluído depois do acesso, ou é um alvo que
  // não tem nome (config, login). O rótulo cru é o que sobrou.
  return `<small class="text-muted">${esc(d.alvo)}</small>`;
}

function auditDescricao(method, path) {
  // Eventos de segurança / acesso usam o path como texto livre
  if (method === "ALERTA") return { acao: "ALERTA DE SEGURANÇA", modulo: "Segurança", alvo: path || "", alerta: true };
  if (method === "VIEW" || method === "DOWNLOAD" || method === "EXPORT" || method === "ARQUIVAR") {
    return { acao: AUDIT_ACAO[method], modulo: "Acesso", alvo: path || "" };
  }
  // RETENCAO: o expurgo automático (retencao.py). O path é a descrição inteira
  // ("expurgo automático: N linha(s)...") — sem este ramo ele caía no parser de
  // caminho REST e a contagem sumia da tela. ARQUIVAR acima tinha o MESMO
  // defeito desde a feature do DJEN; consertados juntos.
  if (method === "RETENCAO") {
    return { acao: AUDIT_ACAO[method], modulo: "Sistema", alvo: path || "" };
  }
  // A partir daqui é caminho REST (/api/precatorios/463)
  const parts = (path || "").split("/").filter(Boolean); // ["api","clients","5"]
  const ent = parts[1] || "";
  let modulo = AUDIT_MODULO[ent] || ent;
  let acao = AUDIT_ACAO[method] || method;
  if (path.includes("/parcelar")) acao = "Parcelou";
  if (path.includes("/consultar")) acao = "Consultou (DataJud)";
  if (path.includes("/assumir")) acao = "Assumiu";
  if (path.includes("/liberar")) acao = "Liberou p/ fila";
  if (path.includes("/pipeline/")) { acao = "Moveu no funil"; modulo = "Funil"; }
  const idPart = parts.find((p, i) => i >= 2 && /^\d+$/.test(p));
  return { acao, modulo, alvo: idPart ? "#" + idPart : "" };
}

/* ---------------- Inteligência Artificial (Gemini) ---------------- */
async function renderIA() {
  const c = document.getElementById("view-container");
  let cfg = { configurada: false, modelo: "" };
  try { cfg = await api("/api/ia/status"); } catch (e) {}
  const aviso = cfg.configurada ? "" : `
    <div class="alert alert-warning"><i class="bi bi-exclamation-triangle"></i>
      A IA ainda <strong>não está configurada</strong>. Crie uma chave gratuita em
      <a href="https://aistudio.google.com" target="_blank" rel="noopener">aistudio.google.com</a>,
      defina a variável de ambiente <code>GEMINI_API_KEY</code> no Render e faça o deploy.</div>`;
  c.innerHTML = `
    ${aviso}
    <ul class="nav nav-pills mb-3" role="tablist">
      <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#ia-imp" type="button"><i class="bi bi-file-earmark-arrow-up"></i> Importação inteligente</button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#ia-ass" type="button"><i class="bi bi-chat-dots"></i> Assistente jurídico</button></li>
    </ul>
    <div class="tab-content">
      <!-- Importação -->
      <div class="tab-pane fade show active" id="ia-imp">
        <div class="card shadow-sm mb-3"><div class="card-body">
          <h6 class="card-title"><i class="bi bi-magic"></i> Enviar documento para a IA analisar</h6>
          <p class="text-muted small mb-2">Aceita PDF, JPG ou PNG (petições, contratos, procurações, documentos pessoais, precatórios). A IA lê o conteúdo — inclusive documentos escaneados — e sugere o preenchimento. Nada é criado sem a sua aprovação.</p>
          <div class="input-group">
            <input type="file" id="ia-file" class="form-control" accept=".pdf,.jpg,.jpeg,.png">
            <button class="btn btn-primary" id="ia-analisar" data-on-click="iaAnalisar" ${cfg.configurada?"":"disabled"}><i class="bi bi-robot"></i> Analisar com IA</button>
          </div>
        </div></div>
        <div id="ia-preview"></div>
      </div>
      <!-- Assistente -->
      <div class="tab-pane fade" id="ia-ass">
        <div class="card shadow-sm"><div class="card-body">
          <h6 class="card-title"><i class="bi bi-chat-dots"></i> Pergunte sobre o seu CRM</h6>
          <div class="d-flex flex-wrap gap-1 mb-2">
            ${["Quantos processos trabalhistas temos?","Quais precatórios aguardando documentação?","Qual advogado tem mais leads ativos?","Resumo dos honorários a receber"].map(q=>`<button class="btn btn-sm btn-outline-secondary" data-on-click="acUsarSugestaoIA">${q}</button>`).join("")}
          </div>
          <div class="input-group">
            <textarea id="ia-pergunta" class="form-control" rows="2" placeholder="Digite sua pergunta em linguagem natural..."></textarea>
            <button class="btn btn-primary" id="ia-perguntar" data-on-click="iaPerguntar" ${cfg.configurada?"":"disabled"}><i class="bi bi-send"></i></button>
          </div>
          <div id="ia-resposta" class="mt-3"></div>
        </div></div>
      </div>
    </div>`;
}

async function iaAnalisar() {
  const fi = document.getElementById("ia-file");
  if (!fi.files || !fi.files[0]) return toast("Selecione um arquivo", true);
  const btn = document.getElementById("ia-analisar");
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Analisando...';
  try {
    const fd = new FormData(); fd.append("file", fi.files[0]);
    const r = await api("/api/ia/importar", { method: "POST", body: fd });
    iaRenderPreview(r.dados || {});
  } catch (e) {
    toast(e.message || "Falha ao analisar", true);
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-robot"></i> Analisar com IA';
  }
}

function _iaField(id, label, v) {
  return `<div class="col-md-4 mb-2"><label class="form-label small text-muted mb-0">${label}</label>
    <input id="${id}" class="form-control form-control-sm" value="${esc(v||"")}"></div>`;
}

async function iaRenderPreview(d) {
  const cli = d.cliente || {}, proc = d.processo || {}, ac = d.acao || {}, prec = d.precatorio || {};
  const clientes = await api("/api/clients");
  const temCli = Object.values(cli).some(v => v);
  const temProc = Object.values(proc).some(v => v);
  const temAc = Object.values(ac).some(v => v);
  const temPrec = Object.values(prec).some(v => v);
  document.getElementById("ia-preview").innerHTML = `
    <div class="card shadow-sm border-primary">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="mb-0"><i class="bi bi-clipboard-check"></i> Prévia extraída pela IA</h6>
          ${d.tipo_documento?`<span class="badge bg-info">${esc(d.tipo_documento)}</span>`:""}
        </div>
        ${d.resumo?`<p class="text-muted small">${esc(d.resumo)}</p>`:""}
        <p class="small text-danger"><i class="bi bi-info-circle"></i> Revise e edite os campos abaixo. Marque o que deseja criar e confirme.</p>

        <div class="mb-2"><label class="form-label small">Vincular a um cliente já cadastrado (opcional)</label>
          <select id="ia-clientsel" class="form-select form-select-sm">
            <option value="">— criar/usar conforme abaixo —</option>
            ${clientes.map(c=>`<option value="${c.id}">${esc(c.name)}${c.cpf_cnpj?` — ${esc(c.cpf_cnpj)}`:""}</option>`).join("")}
          </select></div>

        <div class="form-check mt-3"><input class="form-check-input" type="checkbox" id="ia-mk-cli" ${temCli?"checked":""}>
          <label class="form-check-label fw-bold" for="ia-mk-cli">Criar Cliente</label></div>
        <div class="row">${_iaField("ia-cli-name","Nome",cli.name)}${_iaField("ia-cli-cpf","CPF/CNPJ",cli.cpf_cnpj)}${_iaField("ia-cli-rg","RG",cli.rg)}
          ${_iaField("ia-cli-nasc","Nascimento (AAAA-MM-DD)",cli.data_nascimento)}${_iaField("ia-cli-prof","Profissão",cli.profissao)}${_iaField("ia-cli-ecivil","Estado civil",cli.estado_civil)}
          ${_iaField("ia-cli-email","E-mail",cli.email)}${_iaField("ia-cli-cel","Celular",cli.celular)}${_iaField("ia-cli-cep","CEP",cli.cep)}
          ${_iaField("ia-cli-cidade","Cidade",cli.cidade)}${_iaField("ia-cli-estado","Estado",cli.estado)}${_iaField("ia-cli-rua","Rua",cli.rua)}</div>

        <div class="form-check mt-3"><input class="form-check-input" type="checkbox" id="ia-mk-proc" ${temProc?"checked":""}>
          <label class="form-check-label fw-bold" for="ia-mk-proc">Criar Processo</label></div>
        <div class="row">${_iaField("ia-proc-num","Nº do processo",proc.case_number)}${_iaField("ia-proc-type","Área",proc.type)}${_iaField("ia-proc-assunto","Assunto",proc.assunto)}
          ${_iaField("ia-proc-vara","Vara",proc.vara)}${_iaField("ia-proc-trib","Tribunal",proc.tribunal)}${_iaField("ia-proc-valor","Valor da causa",proc.valor_causa)}</div>

        <div class="form-check mt-3"><input class="form-check-input" type="checkbox" id="ia-mk-ac" ${temAc?"checked":""}>
          <label class="form-check-label fw-bold" for="ia-mk-ac">Criar Ação geral</label></div>
        <div class="row">${_iaField("ia-ac-area","Área",ac.area)}${_iaField("ia-ac-num","Nº do processo",ac.numero_processo)}${_iaField("ia-ac-assunto","Assunto",ac.assunto)}
          ${_iaField("ia-ac-comarca","Comarca",ac.comarca)}${_iaField("ia-ac-valor","Valor da causa",ac.valor_causa)}</div>

        <div class="form-check mt-3"><input class="form-check-input" type="checkbox" id="ia-mk-prec" ${temPrec?"checked":""}>
          <label class="form-check-label fw-bold" for="ia-mk-prec">Criar Precatório</label></div>
        <div class="row">${_iaField("ia-prec-num","Nº do precatório",prec.numero_precatorio)}${_iaField("ia-prec-trib","Tribunal",prec.tribunal)}${_iaField("ia-prec-assunto","Assunto",prec.assunto)}
          ${_iaField("ia-prec-valor","Valor",prec.valor_caso)}</div>

        <button class="btn btn-success mt-3" data-on-click="iaCriar"><i class="bi bi-check2-circle"></i> Criar registros selecionados</button>
      </div>
    </div>`;
}

async function iaCriar() {
  const g = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ""; };
  const ck = (id) => { const e = document.getElementById(id); return e ? e.checked : false; };
  const numOrNull = (v) => v !== "" ? parseFloat(v) : null;
  const payload = {
    client_id: g("ia-clientsel") ? parseInt(g("ia-clientsel")) : null,
    criar_cliente: ck("ia-mk-cli"), criar_processo: ck("ia-mk-proc"),
    criar_acao: ck("ia-mk-ac"), criar_precatorio: ck("ia-mk-prec"),
    cliente: { name: g("ia-cli-name"), cpf_cnpj: g("ia-cli-cpf"), rg: g("ia-cli-rg"),
      data_nascimento: g("ia-cli-nasc") || null, profissao: g("ia-cli-prof"), estado_civil: g("ia-cli-ecivil"),
      email: g("ia-cli-email"), celular: g("ia-cli-cel"), cep: g("ia-cli-cep"),
      cidade: g("ia-cli-cidade"), estado: g("ia-cli-estado"), rua: g("ia-cli-rua") },
    processo: { case_number: g("ia-proc-num"), type: g("ia-proc-type"), assunto: g("ia-proc-assunto"),
      vara: g("ia-proc-vara"), tribunal: g("ia-proc-trib"), valor_causa: numOrNull(g("ia-proc-valor")) },
    acao: { area: g("ia-ac-area"), numero_processo: g("ia-ac-num"), assunto: g("ia-ac-assunto"),
      comarca: g("ia-ac-comarca"), valor_causa: numOrNull(g("ia-ac-valor")) },
    precatorio: { numero_precatorio: g("ia-prec-num"), tribunal: g("ia-prec-trib"),
      assunto: g("ia-prec-assunto"), valor_caso: numOrNull(g("ia-prec-valor")) },
  };
  if (!payload.criar_cliente && !payload.criar_processo && !payload.criar_acao && !payload.criar_precatorio) {
    return toast("Marque ao menos um registro para criar", true);
  }
  try {
    const r = await api("/api/ia/criar", { method: "POST", body: JSON.stringify(payload) });
    toast("Registros criados com sucesso!");
    document.getElementById("ia-preview").innerHTML = `<div class="alert alert-success"><i class="bi bi-check-circle"></i> Criado com sucesso. Confira nas abas de Clientes, Processos, Ações e Precatórios.</div>`;
  } catch (e) {
    toast(e.message || "Falha ao criar", true);
  }
}

async function iaPerguntar() {
  const pergunta = (document.getElementById("ia-pergunta").value || "").trim();
  if (!pergunta) return toast("Digite uma pergunta", true);
  const btn = document.getElementById("ia-perguntar");
  const box = document.getElementById("ia-resposta");
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
  box.innerHTML = '<div class="text-muted small"><span class="spinner-border spinner-border-sm"></span> Consultando a IA...</div>';
  try {
    const r = await api("/api/ia/assistente", { method: "POST", body: JSON.stringify({ pergunta }) });
    box.innerHTML = `<div class="card border-primary"><div class="card-body">
      <div class="small text-muted mb-1"><i class="bi bi-robot"></i> Assistente jurídico</div>
      <div style="white-space:pre-wrap">${esc(r.resposta||"")}</div></div></div>`;
  } catch (e) {
    box.innerHTML = `<div class="alert alert-danger">${esc(e.message || "Falha na consulta")}</div>`;
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-send"></i>';
  }
}

// Filtros da auditoria. Sem eles a tela só mostrava os últimos 300 registros,
// e uma pergunta como "algum estagiário apagou um processo?" não tinha resposta:
// a exclusão podia estar 500 linhas atrás.
let auditFilter = { method: "", search: "", role: "", limit: 300 };

function auditAplicar() {
  auditFilter = {
    method: document.getElementById("aud-method").value,
    search: document.getElementById("aud-search").value.trim(),
    role: document.getElementById("aud-role").value,
    limit: parseInt(document.getElementById("aud-limit").value) || 300,
  };
  renderAuditoria();
}
function auditLimpar() {
  auditFilter = { method: "", search: "", role: "", limit: 300 };
  renderAuditoria();
}
// Atalho para a pergunta que motivou os filtros.
function auditExclusoesEstagiario() {
  auditFilter = { method: "DELETE", search: "", role: "estagiario", limit: 1000 };
  renderAuditoria();
}

/* =========================================================
   AUDITORIA DE CASOS PARADOS (admin)
   Lista casos COM responsável sem movimentação há N dias e deixa o admin
   devolvê-los à fila. Nunca devolve sozinho: o advogado pode estar negociando
   fora do sistema, e tirar o caso dele automaticamente seria pior do que o
   problema que isso resolve.
   ========================================================= */
async function auditarParados(dias) {
  const d = Math.max(1, parseInt(dias || 20, 10) || 20);
  showModal("Casos parados", `<div class="text-center py-4"><div class="spinner-border text-primary"></div>
    <div class="mt-2 text-muted">Reconstruindo a última movimentação de cada caso...</div></div>`,
    null, "Fechar", "modal-xl");
  const body = () => document.querySelector("#app-modal .modal-body");
  try {
    const r = await api("/api/precatorios/parados?dias=" + d);
    const filtro = `
      <div class="d-flex align-items-end gap-2 mb-3">
        <div><label class="form-label small text-muted mb-1">Sem movimentação há</label>
          <div class="input-group input-group-sm" style="width:190px">
            <input type="number" id="par-dias" class="form-control" min="1" max="365" value="${r.dias}">
            <span class="input-group-text">dias</span>
            <button class="btn btn-outline-primary" data-on-click="acParadosVer">Ver</button>
          </div></div>
      </div>`;

    if (!r.casos.length) {
      body().innerHTML = filtro + `<div class="alert alert-success mb-0"><i class="bi bi-check-circle"></i>
        Nenhum caso com responsável está parado há mais de <b>${r.dias}</b> dias.</div>`;
      return;
    }

    const linha = (c) => `
      <tr>
        <td><input type="checkbox" class="par-chk" value="${c.id}"></td>
        <td><div class="fw-semibold small">${esc(c.nome)}</div>
            <small class="text-muted">#${c.id}${c.numero_precatorio ? " · " + esc(c.numero_precatorio) : ""}</small></td>
        <td><small>${esc(c.responsavel)}</small></td>
        <td><span class="badge ${c.dias_parado >= r.dias * 3 ? 'bg-danger' : 'bg-warning text-dark'}">${c.dias_parado} dias</span>
            ${c.nunca_editado ? '<br><small class="text-danger">nunca editado</small>' : ''}</td>
        <td><small class="text-muted">${c.ultima_movimentacao ? fmtDate(c.ultima_movimentacao.slice(0, 10)) : "—"}</small></td>
        <td><small class="text-muted">${c.ultima_visualizacao
              ? fmtDate(c.ultima_visualizacao.slice(0, 10)) + ` <span class="text-body-secondary">(${c.dias_sem_ver}d)</span>`
              : "nunca abriu"}</small></td>
        <td><small>${esc(c.status_label)}<br><span class="text-muted">${esc(c.classificacao_label)}</span></small></td>
      </tr>`;

    body().innerHTML = filtro + `
      <div class="small text-muted mb-2">
        <b>${r.total}</b> caso(s) com responsável sem nenhuma edição há mais de <b>${r.dias}</b> dias.
        Conta como movimentação <b>editar, mover no funil, assumir ou registrar contato</b> —
        <b>abrir o caso não conta</b>, porque só olhar não é trabalhar nele. A coluna
        "Última vez aberto" está aí justamente para você distinguir um caso esquecido
        de um que o advogado acompanha sem registrar nada.
      </div>
      <div class="table-responsive" style="max-height:52vh">
        <table class="table table-sm table-hover align-middle">
          <thead class="sticky-top bg-body"><tr>
            <th style="width:34px"><input type="checkbox" data-on-change="acParadosMarcarTodos"></th>
            <th>Caso</th><th>Responsável</th><th>Parado há</th><th>Última movimentação</th>
            <th>Última vez aberto</th><th>Etapa / tipo</th>
          </tr></thead>
          <tbody>${r.casos.map(linha).join("")}</tbody>
        </table>
      </div>
      <div class="d-flex align-items-center gap-2 mt-2">
        <button class="btn btn-warning btn-sm" data-on-click="liberarParadosSelecionados">
          <i class="bi bi-arrow-counterclockwise"></i> Devolver selecionados à fila</button>
        <small class="text-muted">Remove o responsável e o caso volta a ficar disponível para outro advogado assumir.</small>
      </div>`;
  } catch (e) { body().innerHTML = errorBox(e); }
}

async function liberarParadosSelecionados() {
  const ids = Array.from(document.querySelectorAll(".par-chk:checked")).map(c => parseInt(c.value));
  if (!ids.length) return toast("Selecione ao menos um caso.");
  if (!confirm(`Devolver ${ids.length} caso(s) à fila?\n\nO responsável atual perde o caso e qualquer advogado poderá assumir.`)) return;
  try {
    const r = await api("/api/precatorios/liberar-lote", { method: "POST", body: JSON.stringify({ ids }) });
    toast(`${r.liberados} caso(s) devolvido(s) à fila.`);
    // Recarrega a própria lista: quem foi liberado sai daqui na hora, então dá
    // para ver o que sobrou sem fechar o modal.
    auditarParados(document.getElementById("par-dias")?.value || 20);
  } catch (e) { toast("Erro ao liberar: " + e.message); }
}

async function renderAuditoria() {
  const c = document.getElementById("view-container");
  try {
    const qs = new URLSearchParams({ limit: auditFilter.limit });
    if (auditFilter.method) qs.set("method", auditFilter.method);
    if (auditFilter.search) qs.set("search", auditFilter.search);
    if (auditFilter.role) qs.set("role", auditFilter.role);
    const logs = await api("/api/auditoria?" + qs.toString());
    const alertas = logs.filter(l => l.method === "ALERTA").length;
    const filtrando = auditFilter.method || auditFilter.search || auditFilter.role;
    const _s = (v, atual) => v === atual ? "selected" : "";
    c.innerHTML = `
      <p class="text-muted small"><i class="bi bi-info-circle"></i> Registro de ações, acessos, downloads e exportações (mais recentes primeiro). Acesso restrito a administradores.</p>
      <div class="card mb-3"><div class="card-body py-2">
        <div class="row g-2 align-items-end">
          <div class="col-md-2"><label class="form-label small text-muted mb-1">Ação</label>
            <select id="aud-method" class="form-select form-select-sm">
              <option value="">Todas</option>
              <option value="DELETE" ${_s("DELETE", auditFilter.method)}>Exclusão (DELETE)</option>
              <option value="POST" ${_s("POST", auditFilter.method)}>Criação (POST)</option>
              <option value="PUT" ${_s("PUT", auditFilter.method)}>Edição (PUT)</option>
              <option value="VIEW" ${_s("VIEW", auditFilter.method)}>Consulta</option>
              <option value="DOWNLOAD" ${_s("DOWNLOAD", auditFilter.method)}>Download</option>
              <option value="EXPORT" ${_s("EXPORT", auditFilter.method)}>Exportação</option>
              <option value="ALERTA" ${_s("ALERTA", auditFilter.method)}>Alerta</option>
            </select></div>
          <div class="col-md-2"><label class="form-label small text-muted mb-1">Perfil</label>
            <select id="aud-role" class="form-select form-select-sm">
              <option value="">Todos</option>
              <option value="admin" ${_s("admin", auditFilter.role)}>Administrador</option>
              <option value="advogado" ${_s("advogado", auditFilter.role)}>Advogado</option>
              <option value="estagiario" ${_s("estagiario", auditFilter.role)}>Estagiário</option>
            </select></div>
          <div class="col-md-4"><label class="form-label small text-muted mb-1">Módulo / caminho</label>
            <input id="aud-search" class="form-control form-control-sm" placeholder="ex.: processes, precatorios, clients"
                   value="${esc(auditFilter.search)}" data-on-keydown="acAuditEnter"></div>
          <div class="col-md-2"><label class="form-label small text-muted mb-1">Registros</label>
            <select id="aud-limit" class="form-select form-select-sm">
              <option value="300" ${_s(300, auditFilter.limit)}>300</option>
              <option value="1000" ${_s(1000, auditFilter.limit)}>1000</option>
            </select></div>
          <div class="col-md-2 d-flex gap-1">
            <button class="btn btn-sm btn-primary flex-fill" data-on-click="auditAplicar"><i class="bi bi-funnel"></i> Filtrar</button>
            ${filtrando ? '<button class="btn btn-sm btn-outline-secondary" data-on-click="auditLimpar" title="Limpar filtros"><i class="bi bi-x-lg"></i></button>' : ""}
          </div>
        </div>
        <div class="mt-2">
          <button class="btn btn-sm btn-outline-danger" data-on-click="auditExclusoesEstagiario">
            <i class="bi bi-shield-exclamation"></i> Ver exclusões feitas por estagiário
          </button>
          <button class="btn btn-sm btn-outline-warning ms-1" data-on-click="auditarParados" data-args="${escArgs(20)}">
            <i class="bi bi-hourglass-bottom"></i> Casos parados (20+ dias)
          </button>
          <span class="small text-muted ms-2">${logs.length} registro(s)${filtrando ? " com o filtro atual" : ""}</span>
        </div>
      </div></div>
      ${alertas ? `<div class="alert alert-danger py-2"><i class="bi bi-shield-exclamation"></i> <strong>${alertas} alerta(s) de comportamento suspeito</strong> nas últimas 24h — destacados em vermelho abaixo.</div>` : ""}
      <div class="card"><div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Módulo</th><th>Alvo</th><th>Status</th></tr></thead>
          <tbody>${logs.length ? logs.map(l => {
            const d = auditDescricao(l.method, l.path);
            const ok = l.status < 400;
            return `<tr class="${d.alerta ? 'table-danger' : ''}">
              <td class="text-nowrap"><small>${fmtDateTime(l.created_at)}</small></td>
              <td>${esc(l.user)}${l.role ? ` <span class="badge bg-secondary-subtle text-secondary-emphasis">${esc(ROLE_LABEL[l.role] || l.role)}</span>` : ""}</td>
              <td>${d.alerta ? '<span class="badge bg-danger"><i class="bi bi-shield-exclamation"></i> ALERTA</span>' : esc(d.acao)}</td>
              <td>${esc(d.modulo)}</td>
              <td>${auditAlvoHtml(l, d)}</td>
              <td>${d.alerta ? "" : `<span class="badge ${ok ? 'bg-success' : 'bg-danger'}">${l.status}</span>`}</td>
            </tr>`;
          }).join("") : '<tr><td colspan="6" class="empty-state">Nenhum registro ainda.</td></tr>'}</tbody>
        </table>
      </div></div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

/* =========================================================
   MONITORAMENTO DE PROCESSOS (DataJud / CNJ)
   ========================================================= */
const TRIBUNAIS_DATAJUD = {
  "Tribunais Superiores": { stj: "STJ", tst: "TST", tse: "TSE", stm: "STM" },
  "Justiça Federal": { trf1: "TRF1", trf2: "TRF2", trf3: "TRF3", trf4: "TRF4", trf5: "TRF5", trf6: "TRF6" },
  "Justiça Estadual": {
    tjac: "TJAC", tjal: "TJAL", tjam: "TJAM", tjap: "TJAP", tjba: "TJBA", tjce: "TJCE",
    tjdft: "TJDFT", tjes: "TJES", tjgo: "TJGO", tjma: "TJMA", tjmg: "TJMG", tjms: "TJMS",
    tjmt: "TJMT", tjpa: "TJPA", tjpb: "TJPB", tjpe: "TJPE", tjpi: "TJPI", tjpr: "TJPR",
    tjrj: "TJRJ", tjrn: "TJRN", tjro: "TJRO", tjrr: "TJRR", tjrs: "TJRS", tjsc: "TJSC",
    tjse: "TJSE", tjsp: "TJSP", tjto: "TJTO",
  },
  "Justiça do Trabalho": Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => ["trt" + (i + 1), "TRT" + (i + 1)])
  ),
};

function tribunalLabel(alias) {
  for (const grp of Object.values(TRIBUNAIS_DATAJUD)) if (grp[alias]) return grp[alias];
  return (alias || "").toUpperCase();
}
function tribunalOptions(selected) {
  return Object.entries(TRIBUNAIS_DATAJUD).map(([grupo, opts]) =>
    `<optgroup label="${grupo}">${Object.entries(opts).map(([k, v]) =>
      `<option value="${k}" ${selected === k ? 'selected' : ''}>${v}</option>`).join("")}</optgroup>`).join("");
}

let monitView = "datajud";
function _monitTabs(active) {
  // O estagiário só alcança Publicações (DJEN) — sem abas, para não sugerir
  // um DataJud que ele não pode abrir.
  if (!permIsAdmin()) return "";
  return `<div class="seg mb-2" id="monit-seg">
    <button class="${active === 'datajud' ? 'active' : ''}" data-on-click="acMonitAba" data-args="${escArgs('datajud')}">Andamentos (DataJud)</button>
    <button class="${active === 'djen' ? 'active' : ''}" data-on-click="acMonitAba" data-args="${escArgs('djen')}">Publicações (DJEN)</button>
  </div>`;
}
async function renderMonitoramento() {
  const c = document.getElementById("view-container");
  if (!permIsAdmin()) monitView = "djen";        // estagiário: só Publicações
  if (monitView === "djen") return renderMonitDjen();
  try {
    const items = await api("/api/monitor");
    c.innerHTML = `
      ${_monitTabs("datajud")}
      <div class="section-toolbar">
        <span class="text-muted small"><i class="bi bi-info-circle"></i> Dados da API pública do CNJ (DataJud). Verificação automática + manual; avisamos quando houver movimentação nova.</span>
        <div class="ms-auto d-flex gap-2">
          <button class="btn btn-outline-secondary" data-on-click="testarEmailMonitor" title="Enviar um e-mail de teste"><i class="bi bi-envelope-check"></i> Testar e-mail</button>
          <button class="btn btn-outline-primary" data-on-click="verificarTodosMonitores"><i class="bi bi-arrow-repeat"></i> Verificar todos agora</button>
          <button class="btn btn-primary" data-on-click="monitorModal"><i class="bi bi-plus-lg"></i> Monitorar processo</button>
        </div>
      </div>
      <div class="card"><div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead><tr><th>Descrição</th><th>Número</th><th>Tribunal</th><th>Última movimentação</th><th>Atualizado em</th><th></th></tr></thead>
          <tbody>${items.length ? items.map(m => `
            <tr class="${m.has_news ? 'table-warning' : ''}">
              <td><strong>${esc(m.descricao || "—")}</strong>${m.has_news ? ' <span class="badge bg-danger"><i class="bi bi-bell-fill"></i> Nova movimentação</span>' : ""}</td>
              <td><small>${esc(m.numero)}</small></td>
              <td><span class="badge bg-secondary">${tribunalLabel(m.tribunal)}</span></td>
              <td>${m.last_movement ? `${esc(m.last_movement)}<br><small class="text-muted">${fmtDateTime(m.last_movement_date)}</small>` : '<small class="text-muted">— consulte —</small>'}</td>
              <td><small>${m.last_checked ? fmtDateTime(m.last_checked) : "—"}</small></td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-primary" title="Atualizar no DataJud" data-on-click="consultarMonitor" data-args="${escArgs(m.id)}"><i class="bi bi-arrow-repeat"></i></button>
                <button class="btn btn-sm btn-outline-secondary" title="Ver movimentações" data-on-click="verMovimentos" data-args="${escArgs(m.id)}"><i class="bi bi-list-ul"></i></button>
                <button class="btn btn-sm btn-outline-danger" data-on-click="deleteMonitor" data-args="${escArgs(m.id)}"><i class="bi bi-trash"></i></button>
              </td>
            </tr>`).join("") : '<tr><td colspan="6" class="empty-state">Nenhum processo monitorado. Clique em "Monitorar processo".</td></tr>'}
          </tbody>
        </table>
      </div></div>`;
  } catch (e) { c.innerHTML = errorBox(e); }
}

/* ===== Publicações (DJEN) — aba dentro do Monitoramento ===== */
let djenFilterNovas = false;
// Arquivadas moram numa VISÃO separada, não misturadas na caixa: misturar
// devolveria a poluição que o arquivamento existe para resolver.
let djenVerArquivadas = false;
async function renderMonitDjen() {
  const c = document.getElementById("view-container");
  try {
    const qs = djenVerArquivadas ? "?arquivadas=1" : (djenFilterNovas ? "?lida=0" : "");
    const podeArquivar = permPodeExcluir();
    const [pubs, oabs] = await Promise.all([
      api("/api/publicacoes" + qs),
      api("/api/publicacoes/oabs").catch(() => []),
    ]);
    const ativas = oabs.filter(o => o.ativo);
    let lastSync = 0; try { lastSync = parseInt(localStorage.getItem("djen_last_sync")) || 0; } catch (e) {}
    const syncTxt = lastSync ? `Última sincronização: ${fmtDateTime(new Date(lastSync).toISOString())}` : "Ainda não sincronizado.";
    const autoOn = djenAutoLigado();
    c.innerHTML = `
      ${_monitTabs("djen")}
      <div class="section-toolbar">
        <span class="text-muted small"><i class="bi bi-info-circle"></i> Publicações do DJEN. ${
          !permIsAdmin() ? "Abra uma publicação para vincular ao CRM e gerar o prazo."
          : (ativas.length ? `Monitorando ${ativas.length} OAB(s). · ${syncTxt}` : '<b class="text-warning">Cadastre uma OAB para começar.</b>')}</span>
        <div class="ms-auto d-flex gap-2 align-items-center">
          ${permIsAdmin() ? `<div class="form-check form-switch mb-0" title="Sincroniza sozinho ao abrir o CRM (a cada ~6h)">
            <input class="form-check-input" type="checkbox" id="djen-auto" ${autoOn ? 'checked' : ''} data-on-change="acDjenToggleAuto">
            <label class="form-check-label small" for="djen-auto">Auto</label>
          </div>` : ""}
          ${djenVerArquivadas ? "" : `<button class="btn btn-outline-secondary ${djenFilterNovas ? 'active' : ''}" data-on-click="acDjenToggleNovas"><i class="bi bi-funnel"></i> ${djenFilterNovas ? 'Só novas' : 'Todas'}</button>`}
          ${podeArquivar ? `<button class="btn btn-outline-secondary ${djenVerArquivadas ? 'active' : ''}" data-on-click="acDjenToggleArquivadas" title="${djenVerArquivadas ? 'Voltar para a caixa' : 'Ver o que foi arquivado'}"><i class="bi bi-archive"></i> ${djenVerArquivadas ? 'Voltar à caixa' : 'Arquivadas'}</button>` : ""}
          ${permIsAdmin() ? `<button class="btn btn-outline-secondary" data-on-click="oabsModal"><i class="bi bi-person-vcard"></i> OABs</button>
          <button class="btn btn-outline-secondary" data-on-click="diagnosticoDjen" title="Ver o que o servidor recebe da API"><i class="bi bi-activity"></i></button>
          <button class="btn btn-primary" data-on-click="sincronizarDjen"><i class="bi bi-cloud-download"></i> Sincronizar</button>` : ""}
        </div>
      </div>
      ${podeArquivar ? `<div class="d-flex flex-wrap align-items-center gap-2 mb-2">
        <button id="djen-arq-sel" class="btn btn-sm btn-outline-danger" disabled data-on-click="${djenVerArquivadas ? 'desarquivarDjenSelecionadas' : 'arquivarDjenSelecionadas'}">
          <i class="bi bi-${djenVerArquivadas ? 'arrow-counterclockwise' : 'archive'}"></i> ${djenVerArquivadas ? 'Devolver à caixa' : 'Arquivar selecionadas'}</button>
        ${djenVerArquivadas && permIsAdmin() ? `<button id="djen-excl-sel" class="btn btn-sm btn-danger" disabled data-on-click="excluirDjenSelecionadas" title="Apaga a intimação para sempre — não pode ser desfeito"><i class="bi bi-trash3"></i> Excluir definitivamente</button>` : ""}
        ${djenVerArquivadas ? "" : `<button class="btn btn-sm btn-outline-secondary" data-on-click="arquivarDjenTodasLidas" title="Arquiva de uma vez tudo que você já leu"><i class="bi bi-check2-all"></i> Arquivar todas as lidas</button>`}
        <span class="small text-muted ms-auto">${djenVerArquivadas
          ? 'Arquivadas não voltam na sincronização e podem ser devolvidas à caixa.' + (permIsAdmin() ? ' Excluir em definitivo apaga a intimação para sempre.' : '')
          : 'Arquivar tira da lista sem apagar a intimação — e não volta na próxima sincronização.'}</span>
      </div>` : ""}
      <div class="card"><div class="table-responsive">
        <table class="table table-hover mb-0 align-middle">
          <thead><tr>${podeArquivar ? '<th style="width:34px"><input type="checkbox" id="djen-all" title="Selecionar todas" data-on-click="acDjenToggleAll"></th>' : ""}<th>Disponibilização</th><th>Tribunal</th><th>Tipo</th><th>Processo</th><th>Órgão</th><th>Captura</th><th></th></tr></thead>
          <tbody>${pubs.length ? pubs.map(p => `
            <tr class="${p.lida ? '' : 'table-warning'}" style="cursor:pointer" data-on-click="verPublicacao" data-args="${escArgs(p.id)}">
              ${podeArquivar ? `<td data-on-click="acNada" data-stop="1"><input type="checkbox" class="djen-chk" value="${p.id}" data-on-click="djenUpdateSel"></td>` : ""}
              <td><small>${fmtDate(p.data_disponibilizacao)}</small>${p.lida ? '' : ' <span class="badge bg-danger">nova</span>'}${p.deadline_id ? ' <span class="badge bg-info text-dark" title="Esta publicação gerou um prazo na agenda">prazo</span>' : ''}</td>
              <td><span class="badge bg-secondary">${esc(p.tribunal || '—')}</span></td>
              <td>${esc(p.tipo_comunicacao || '—')}</td>
              <td><small>${esc(p.numero_processo || '—')}</small></td>
              <td><small>${esc((p.orgao || '—').slice(0, 60))}</small></td>
              <td><small class="text-muted">${esc(p.oab_captura || 'processo')}</small></td>
              <td class="text-end"><i class="bi bi-chevron-right text-muted"></i></td>
            </tr>`).join("") : `<tr><td colspan="${podeArquivar ? 8 : 7}" class="empty-state">${
              djenVerArquivadas ? 'Nada arquivado ainda.'
              : `Nenhuma publicação. ${!permIsAdmin() ? 'O administrador é quem sincroniza as publicações do DJEN.'
              : (ativas.length ? 'Clique em "Sincronizar".' : 'Cadastre uma OAB e sincronize.')}`}</td></tr>`}
          </tbody>
        </table>
      </div></div>`;
  } catch (e) { c.innerHTML = _monitTabs("djen") + errorBox(e); }
}

// ---- Seleção múltipla + arquivamento (Publicações do DJEN) ----
function djenSelecionados() {
  return Array.from(document.querySelectorAll(".djen-chk:checked")).map(c => parseInt(c.value));
}
function djenUpdateSel() {
  const n = djenSelecionados().length;
  const btn = document.getElementById("djen-arq-sel");
  if (btn) {
    btn.disabled = n === 0;
    const rot = djenVerArquivadas ? "Devolver à caixa" : "Arquivar selecionadas";
    const ico = djenVerArquivadas ? "arrow-counterclockwise" : "archive";
    btn.innerHTML = `<i class="bi bi-${ico}"></i> ${rot}${n ? ` (${n})` : ""}`;
  }
  const bex = document.getElementById("djen-excl-sel");   // só aparece p/ admin na visão de arquivadas
  if (bex) {
    bex.disabled = n === 0;
    bex.innerHTML = `<i class="bi bi-trash3"></i> Excluir definitivamente${n ? ` (${n})` : ""}`;
  }
  const all = document.getElementById("djen-all");
  const total = document.querySelectorAll(".djen-chk").length;
  if (all) all.checked = total > 0 && n === total;
}
function djenToggleAll(cb) {
  document.querySelectorAll(".djen-chk").forEach(c => { c.checked = cb.checked; });
  djenUpdateSel();
}

/** Manda o lote e explica o que o servidor recusou por ter prazo vinculado. */
async function _djenArquivar(corpo) {
  const r = await api("/api/publicacoes/arquivar-lote", { method: "POST", body: JSON.stringify(corpo) });
  if (r.ignoradas_com_prazo) {
    // Publicação que gerou prazo é a prova de quando ele começou a correr.
    // Nunca some num "arquivar tudo" — só com um sim explícito.
    const ok = confirm(
      `${r.arquivadas} arquivada(s).\n\n` +
      `${r.ignoradas_com_prazo} não foram arquivadas porque geraram prazo na agenda — ` +
      `elas são a prova de quando o prazo começou a correr.\n\nArquivar essas também?`
    );
    if (ok) {
      const r2 = await api("/api/publicacoes/arquivar-lote", {
        method: "POST", body: JSON.stringify({ ...corpo, incluir_com_prazo: true }),
      });
      toast(`${r.arquivadas + r2.arquivadas} publicação(ões) arquivada(s).`);
    } else {
      toast(`${r.arquivadas} arquivada(s). ${r.ignoradas_com_prazo} mantida(s) por terem prazo.`);
    }
  } else {
    toast(`${r.arquivadas} publicação(ões) arquivada(s).`);
  }
  atualizarSinoMonitor();
  renderMonitDjen();
}

async function arquivarDjenSelecionadas() {
  const ids = djenSelecionados();
  if (!ids.length) return;
  try { await _djenArquivar({ ids }); }
  catch (e) { toast(e.message || "Falha ao arquivar", true); }
}

async function arquivarDjenTodasLidas() {
  if (!confirm("Arquivar todas as publicações que você já leu?\n\nElas saem da lista mas não são apagadas — dá para devolver à caixa depois, em 'Arquivadas'.")) return;
  try { await _djenArquivar({ todas_lidas: true }); }
  catch (e) { toast(e.message || "Falha ao arquivar", true); }
}

async function desarquivarDjenSelecionadas() {
  const ids = djenSelecionados();
  if (!ids.length) return;
  try {
    const r = await api("/api/publicacoes/desarquivar-lote", { method: "POST", body: JSON.stringify({ ids }) });
    toast(`${r.desarquivadas} devolvida(s) à caixa.`);
    atualizarSinoMonitor();
    renderMonitDjen();
  } catch (e) { toast(e.message || "Falha ao desarquivar", true); }
}

// Exclusão DEFINITIVA das arquivadas (admin-only na tela; backend confirma).
// Irreversível: apaga a intimação. A publicação com prazo vinculado só sai com
// um segundo "sim" explícito — ela é a prova de quando o prazo começou.
async function excluirDjenSelecionadas() {
  const ids = djenSelecionados();
  if (!ids.length) return;
  if (!confirm(
    `Excluir DEFINITIVAMENTE ${ids.length} publicação(ões) arquivada(s)?\n\n` +
    `Isto apaga a intimação para sempre e NÃO pode ser desfeito. As publicações ` +
    `não voltarão na próxima sincronização do DJEN.`
  )) return;
  try {
    const r = await api("/api/publicacoes/excluir-lote", { method: "POST", body: JSON.stringify({ ids }) });
    if (r.ignoradas_com_prazo) {
      const ok = confirm(
        `${r.excluidas} excluída(s).\n\n` +
        `${r.ignoradas_com_prazo} não foram excluídas porque geraram prazo na agenda — ` +
        `elas são a prova de quando o prazo começou a correr.\n\nExcluir essas também, em definitivo?`
      );
      if (ok) {
        const r2 = await api("/api/publicacoes/excluir-lote", {
          method: "POST", body: JSON.stringify({ ids, incluir_com_prazo: true }),
        });
        toast(`${r.excluidas + r2.excluidas} publicação(ões) excluída(s) em definitivo.`);
      } else {
        toast(`${r.excluidas} excluída(s). ${r.ignoradas_com_prazo} mantida(s) por terem prazo.`);
      }
    } else {
      toast(`${r.excluidas} publicação(ões) excluída(s) em definitivo.`);
    }
    atualizarSinoMonitor();
    renderMonitDjen();
  } catch (e) { toast(e.message || "Falha ao excluir", true); }
}

function djenToggleAuto(on) {
  try { localStorage.setItem("djen_auto", on ? "1" : "0"); } catch (e) {}
  toast(on ? "Auto-sincronização ligada (ao abrir o CRM)." : "Auto-sincronização desligada.");
}

async function diagnosticoDjen() {
  toast("Rodando diagnóstico...");
  try {
    const r = await api("/api/publicacoes/diagnostico");
    showModal("Diagnóstico DJEN", `
      <p class="small text-muted">Isto mostra exatamente o que o <b>servidor</b> recebe da API do CNJ. Copie e envie para análise.</p>
      <textarea class="form-control" rows="14" style="font-family:monospace;font-size:.8rem" readonly>${esc(JSON.stringify(r, null, 2))}</textarea>
    `, null, "Fechar", "modal-lg");
  } catch (e) { toast(e.message || "Falha no diagnóstico", true); }
}

// A API do CNJ geo-bloqueia o servidor (403), mas libera o navegador (Brasil) + CORS.
// Por isso o NAVEGADOR busca as publicações e envia ao CRM para gravar.
const DJEN_API = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";
async function djenBuscarTudo(baseParams, ini, fim) {
  let pagina = 1, all = [];
  const MAX = 20, ITENS = 100;
  while (pagina <= MAX) {
    const qs = new URLSearchParams({ ...baseParams, dataDisponibilizacaoInicio: ini, dataDisponibilizacaoFim: fim, pagina, itensPorPagina: ITENS });
    const r = await fetch(DJEN_API + "?" + qs.toString());
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const lote = j.items || [];
    all = all.concat(lote);
    if (lote.length < ITENS) break;
    pagina++;
  }
  return all;
}
function _ymd(d) { return d.toISOString().slice(0, 10); }

// Núcleo do sync (o navegador busca no DJEN e o backend grava). silent=true = automático.
async function djenSync(silent) {
  let oabs, monitores = [];
  try {
    oabs = (await api("/api/publicacoes/oabs")).filter(o => o.ativo);
    monitores = await api("/api/monitor").catch(() => []);
  } catch (e) { if (!silent) toast(e.message, true); return { novas: 0, erro: true }; }
  if (!oabs.length && !monitores.length) {
    if (!silent) toast("Cadastre uma OAB ativa primeiro.", true);
    return { novas: 0, semFonte: true };
  }
  const fim = new Date(), ini = new Date(Date.now() - 30 * 86400000);
  const iniS = _ymd(ini), fimS = _ymd(fim);
  if (!silent) toast("Buscando publicações no DJEN (via seu navegador)...");
  let novas = 0, recebidas = 0;
  const erros = [];
  for (const o of oabs) {
    try {
      const items = await djenBuscarTudo({ numeroOab: o.numero, ufOab: o.uf }, iniS, fimS);
      const r = await api("/api/publicacoes/importar", { method: "POST", body: JSON.stringify({ oab: `${o.numero}/${o.uf}`, items }) });
      novas += r.novas; recebidas += r.recebidas;
    } catch (e) { erros.push(`OAB ${o.numero}/${o.uf}: ${e.message}`); }
  }
  for (const m of monitores) {
    if (!m.numero) continue;
    try {
      const items = await djenBuscarTudo({ numeroProcesso: m.numero }, iniS, fimS);
      if (items.length) {
        const r = await api("/api/publicacoes/importar", { method: "POST", body: JSON.stringify({ oab: null, items }) });
        novas += r.novas; recebidas += r.recebidas;
      }
    } catch (e) { /* processo sem publicação: ignora */ }
  }
  try { localStorage.setItem("djen_last_sync", String(Date.now())); } catch (e) {}
  if (!silent && erros.length) alert("Alguns itens falharam:\n\n" + erros.join("\n"));
  return { novas, recebidas, erros };
}

async function sincronizarDjen() {
  const r = await djenSync(false);
  if (r && (r.erro || r.semFonte)) return;
  toast(`${r.novas} nova(s) publicação(ões) — ${r.recebidas} recebida(s) do DJEN.`);
  renderMonitDjen();
}

// Auto-sincronização: roda em segundo plano ao abrir o CRM, no máx. 1x a cada 6h.
const DJEN_AUTO_HORAS = 6;
function djenAutoLigado() {
  try { return localStorage.getItem("djen_auto") !== "0"; } catch (e) { return true; }
}
async function djenAutoSync() {
  if (!CURRENT_USER || CURRENT_USER.role !== "admin" || !djenAutoLigado()) return;
  let last = 0;
  try { last = parseInt(localStorage.getItem("djen_last_sync")) || 0; } catch (e) {}
  if (Date.now() - last < DJEN_AUTO_HORAS * 3600 * 1000) return;   // ainda dentro da janela
  try {
    const r = await djenSync(true);
    if (r && r.novas > 0) {
      toast(`${r.novas} nova(s) publicação(ões) do DJEN.`);
      atualizarSinoMonitor();
      if (monitView === "djen") renderMonitDjen();
    }
  } catch (e) { /* silencioso */ }
}

/* Publicação aberta no modal — os cadastros rápidos do painel lateral leem
   daqui para pré-preencher (número do processo, tribunal, órgão, partes). */
let _pubAtual = null;

async function verPublicacao(id) {
  let p;
  try { p = await api("/api/publicacoes/" + id); }
  catch (e) { return toast(e.message, true); }
  if (!CACHE.clients.length) { try { CACHE.clients = await api("/api/clients"); } catch (e) {} }
  if (!CACHE.processes.length) { try { CACHE.processes = await api("/api/processes"); } catch (e) {} }
  _pubAtual = p;   // guarda a publicação aberta para os cadastros rápidos do painel lateral
  const adv = ((p.destinatarios || {}).advogados || []).map(a => `${esc(a.nome || '')}${a.oab ? ` (OAB ${esc(a.oab)}${a.uf ? '/' + esc(a.uf) : ''})` : ''}`).join(", ");
  showModal(`${esc(p.tipo_comunicacao || 'Publicação')} — ${esc(p.tribunal || '')}`, `
    <div class="d-flex flex-wrap gap-3 align-items-start">
    <div style="flex:1 1 0;min-width:320px">
    <div class="small text-muted mb-2">
      <div><b>Processo:</b> ${esc(p.numero_processo || '—')}</div>
      <div><b>Órgão:</b> ${esc(p.orgao || '—')}</div>
      <div><b>Classe:</b> ${esc(p.classe || '—')} · <b>Disponibilização:</b> ${fmtDate(p.data_disponibilizacao)} · <b>Meio:</b> ${esc(p.meio || '—')}</div>
      ${adv ? `<div><b>Advogado(s):</b> ${adv}</div>` : ''}
    </div>
    <div style="max-height:38vh;overflow:auto;white-space:pre-wrap;background:var(--surface-2);border-radius:8px;padding:12px;font-size:.92rem;line-height:1.5">${esc(p.texto || 'Sem inteiro teor.')}</div>
    <div class="row g-2 mt-2 p-2" style="background:var(--surface-2);border-radius:8px">
      <div class="col-12"><b class="small"><i class="bi bi-link-45deg"></i> Vincular ao CRM</b></div>
      <div class="col-md-6"><label class="form-label small">Cliente</label>
        <div class="d-flex gap-1">
          <select id="pub-client" class="form-select form-select-sm"><option value="">Nenhum</option>${CACHE.clients.map(c => `<option value="${c.id}" ${p.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join("")}</select>
          ${permCanEdit("clients") ? `<button type="button" class="btn btn-sm btn-outline-primary" style="flex:none" title="Cadastrar cliente sem sair daqui" data-on-click="pubNovoCliente"><i class="bi bi-plus-lg"></i></button>` : ""}
        </div></div>
      <div class="col-md-6"><label class="form-label small">Processo</label>
        <div class="d-flex gap-1">
          <select id="pub-proc" class="form-select form-select-sm"><option value="">Nenhum</option>${CACHE.processes.map(pr => `<option value="${pr.id}" ${p.process_id === pr.id ? 'selected' : ''}>${esc(pr.case_number || 'Proc #' + pr.id)} — ${esc(pr.client_name || '')}</option>`).join("")}</select>
          ${permCanEdit("processes") ? `<button type="button" class="btn btn-sm btn-outline-primary" style="flex:none" title="Cadastrar processo sem sair daqui" data-on-click="pubNovoProcesso"><i class="bi bi-plus-lg"></i></button>` : ""}
        </div></div>
      <div class="col-12"><small class="text-muted">Ao vincular, a publicação passa a aparecer na ficha do cliente e do processo e herda o responsável do processo. Use o <b>+</b> para cadastrar o que ainda não existe, sem sair desta tela.</small></div>
    </div>
    <div class="row g-2 mt-2 p-2" style="background:var(--surface-2);border-radius:8px">
      <div class="col-12"><b class="small"><i class="bi bi-alarm"></i> Prazo sugerido (dias úteis)</b></div>
      <div class="col-md-3"><label class="form-label small">Dias úteis</label><input id="pub-dias" type="number" min="1" max="365" class="form-control form-control-sm" value="15" data-on-input="_pubPrazoPreview" data-args="${escArgs(id)}"></div>
      <div class="col-md-3"><label class="form-label small">Urgência</label><select id="pub-urg" class="form-select form-select-sm"><option value="baixa">Baixa</option><option value="media" selected>Média</option><option value="alta">Alta</option></select></div>
      <div class="col-md-6"><label class="form-label small">Descrição (opcional)</label><input id="pub-prazo-desc" class="form-control form-control-sm" placeholder="Ex.: Contestação, Recurso..."></div>
      <div class="col-12"><div id="pub-prazo-preview" class="small text-muted py-1">Calculando...</div></div>
      <div class="col-12 d-flex align-items-center gap-2">
        <button type="button" class="btn btn-sm btn-primary" data-on-click="gerarPrazoPub" data-args="${escArgs(id)}"><i class="bi bi-calendar-plus"></i> Gerar prazo na agenda</button>
        <small class="text-warning"><i class="bi bi-exclamation-triangle"></i> Sugestão automática — feriados locais/forenses variam. Confirme sempre.</small>
      </div>
    </div>
    </div>
    <div id="pub-side" class="d-none" style="width:520px;flex:none;position:sticky;top:0;align-self:flex-start;max-height:74vh;overflow:auto;background:var(--surface-2);border:1px solid var(--bs-border-color);border-radius:8px;padding:12px"></div>
    </div>
  `, async () => {
    await api("/api/publicacoes/" + id + "/vincular", { method: "POST", body: JSON.stringify({
      client_id: val("pub-client") ? parseInt(val("pub-client")) : null,
      process_id: val("pub-proc") ? parseInt(val("pub-proc")) : null,
    }) });
    closeModal(); toast("Publicação vinculada!"); renderMonitDjen();
  }, "Fechar", "modal-xl");
  // Pelo id: o 1º `.btn-primary` do modal é o "Gerar prazo na agenda" (vem
  // antes do rodapé) — era ele que ganhava o rótulo "Salvar vínculo".
  const salvarVinculo = document.getElementById("modal-save");
  if (salvarVinculo) salvarVinculo.textContent = "Salvar vínculo";
  _pubPrazoPreview(id);
  renderMonitDjen();  // atualiza o "nova" -> lida
}

/* ---- Cadastro rápido no painel lateral do modal da publicação ----
   Corta o vai-e-vem "sair do monitoramento → cadastrar cliente → cadastrar
   processo → voltar para vincular". Os campos já nascem preenchidos com os
   dados da própria publicação e o registro criado é selecionado no vínculo. */
function pubSideFechar() {
  const s = document.getElementById("pub-side");
  if (s) { s.classList.add("d-none"); s.innerHTML = ""; }
}

function _pubSideAbrir(titulo, icone, corpo) {
  const s = document.getElementById("pub-side");
  if (!s) return;
  s.classList.remove("d-none");
  s.innerHTML = `
    <div class="d-flex align-items-center mb-2">
      <b class="small"><i class="bi ${icone}"></i> ${titulo}</b>
      <button type="button" class="btn-close ms-auto" style="font-size:.65rem" title="Fechar" data-on-click="pubSideFechar"></button>
    </div>${corpo}`;
}

/* Redesenha os selects do vínculo já com o registro recém-criado selecionado. */
function _pubRefreshSelects(clientId, procId) {
  const cs = document.getElementById("pub-client");
  if (cs) {
    const atual = clientId || cs.value;
    cs.innerHTML = `<option value="">Nenhum</option>` +
      CACHE.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    if (atual) cs.value = String(atual);
  }
  const ps = document.getElementById("pub-proc");
  if (ps) {
    const atual = procId || ps.value;
    ps.innerHTML = `<option value="">Nenhum</option>` +
      CACHE.processes.map(pr => `<option value="${pr.id}">${esc(pr.case_number || "Proc #" + pr.id)} — ${esc(pr.client_name || "")}</option>`).join("");
    if (atual) ps.value = String(atual);
  }
}

async function pubNovoCliente() {
  const partes = (((_pubAtual || {}).destinatarios || {}).partes || []).filter(Boolean);
  // Cliente em branco (mesmos campos da aba Clientes), com o nome já vindo da
  // parte da publicação.
  const client = { name: partes[0] || "", status: "lead", owner_id: null };
  const ownerField = await _ownerFieldHtml(null, "col-md-6", "f-");
  _pubSideAbrir("Novo cliente", "bi-person-plus", `
    ${partes.length > 1 ? `<div class="mb-2"><label class="form-label small">Partes desta publicação</label>
      <select class="form-select form-select-sm" data-on-change="acPreencherNomeCliente">
        <option value="">— usar uma delas —</option>
        ${partes.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}
      </select></div>` : ""}
    ${_clientFormHtml(client, ownerField, { pfx: "f-" })}
    <button type="button" class="btn btn-primary w-100 mt-2" data-on-click="pubSalvarCliente"><i class="bi bi-check-lg"></i> Salvar e selecionar</button>`);
}

async function pubSalvarCliente() {
  const payload = _clientFormPayload({ pfx: "f-" });
  if (!payload) return;
  try {
    const novo = await api("/api/clients", { method: "POST", body: JSON.stringify(payload) });
    // Nunca `CACHE.clients.push` direto: com o cache ainda vazio ele virava
    // [o novo] e todo select de cliente mostrava UM cliente até o logout.
    await cacheGarantirCliente(novo);
    CACHE.clients.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    _pubRefreshSelects(novo.id, null);
    pubSideFechar();
    toast(`Cliente "${novo.name}" cadastrado e selecionado.`);
  } catch (e) { toast(e.message, true); }
}

async function pubNovoProcesso() {
  const pub = _pubAtual || {};
  const cliSel = document.getElementById("pub-client");
  // Processo em branco (mesmos campos da aba Processos), pré-preenchido com o
  // que a publicação já informa e com o cliente do vínculo.
  const p = {
    client_id: cliSel && cliSel.value ? parseInt(cliSel.value) : null,
    case_number: pub.numero_processo || "", type: "", subcategoria: "",
    classe: pub.classe || "", assunto: "", foro: "", vara: "",
    tribunal: pub.tribunal || "", orgao_julgador: pub.orgao || "",
    data_distribuicao: "", fase_processual: "", sistema_eletronico: "",
    valor_causa: null, status: "ativo", description: "",
  };
  const ownerField = await _ownerFieldHtml(null, "col-md-6", "f-");
  _pubSideAbrir("Novo processo", "bi-folder-plus",
    _processFormHtml(p, procAreaKey(p.type) || "civel", "", "", ownerField,
                     { pfx: "f-", sistemaObrigatorio: false, novoCliente: false }) +
    `<button type="button" class="btn btn-primary w-100 mt-2" data-on-click="pubSalvarProcesso"><i class="bi bi-check-lg"></i> Salvar e selecionar</button>`);
}

async function pubSalvarProcesso() {
  const payload = _processFormPayload({ pfx: "f-", sistemaObrigatorio: false });
  if (!payload) return;
  try {
    const novo = await api("/api/processes", { method: "POST", body: JSON.stringify(payload) });
    await cacheGarantirProcesso(novo);
    _pubRefreshSelects(payload.client_id, novo.id);
    pubSideFechar();
    toast("Processo cadastrado e selecionado.");
  } catch (e) { toast(e.message, true); }
}

async function _pubPrazoPreview(id) {
  const box = document.getElementById("pub-prazo-preview");
  if (!box) return;
  const dias = parseInt(val("pub-dias")) || 15;
  try {
    const r = await api(`/api/publicacoes/${id}/prazo-preview?dias=${dias}`);
    box.innerHTML = `Disponibilização <b>${fmtDate(r.disponibilizacao)}</b> → publicação <b>${fmtDate(r.publicacao)}</b> → início da contagem <b>${fmtDate(r.inicio_contagem)}</b> → <b class="text-danger">vencimento ${fmtDate(r.vencimento)}</b>`;
  } catch (e) { box.textContent = e.message || "Não foi possível calcular."; }
}

async function gerarPrazoPub(id) {
  const proc = val("pub-proc");
  if (!proc) return toast("Selecione um processo (em Vincular ao CRM) para gerar o prazo.", true);
  try {
    // Garante o vínculo com o processo escolhido antes de gerar
    await api(`/api/publicacoes/${id}/vincular`, { method: "POST", body: JSON.stringify({
      client_id: val("pub-client") ? parseInt(val("pub-client")) : null,
      process_id: parseInt(proc),
    }) });
    const r = await api(`/api/publicacoes/${id}/gerar-prazo`, { method: "POST", body: JSON.stringify({
      dias: parseInt(val("pub-dias")) || 15,
      urgency_level: val("pub-urg"),
      descricao: val("pub-prazo-desc"),
    }) });
    closeModal();
    toast(`Prazo criado — vencimento ${fmtDate(r.vencimento)}. Confira na aba Prazos.`);
    renderMonitDjen();
  } catch (e) { toast(e.message, true); }
}

async function oabsModal() {
  let oabs = [];
  try { oabs = await api("/api/publicacoes/oabs"); } catch (e) { return toast(e.message, true); }
  const linhas = oabs.map(o => `
    <tr>
      <td><b>${esc(o.numero)}/${esc(o.uf)}</b></td>
      <td>${esc(o.nome || '—')}</td>
      <td>${o.ativo ? '<span class="badge bg-success">ativa</span>' : '<span class="badge bg-secondary">pausada</span>'}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-secondary" data-on-click="toggleOab" data-args="${escArgs(o.id, o.ativo ? 0 : 1)}">${o.ativo ? 'Pausar' : 'Ativar'}</button>
        <button class="btn btn-sm btn-outline-danger" data-on-click="deleteOab" data-args="${escArgs(o.id)}"><i class="bi bi-trash"></i></button>
      </td>
    </tr>`).join("");
  showModal("OABs monitoradas", `
    <div class="row g-2 align-items-end mb-3">
      <div class="col-4"><label class="form-label">Número da OAB*</label><input id="oab-num" class="form-control" placeholder="ex.: 12345"></div>
      <div class="col-3"><label class="form-label">UF*</label><input id="oab-uf" class="form-control" placeholder="ex.: AL" maxlength="2"></div>
      <div class="col-5"><label class="form-label">Nome (opcional)</label><input id="oab-nome" class="form-control" placeholder="ex.: Dra. Fulana de Tal"></div>
    </div>
    <button type="button" class="btn btn-primary btn-sm mb-3" id="oab-add"><i class="bi bi-plus-lg"></i> Adicionar OAB</button>
    <table class="table table-sm align-middle"><thead><tr><th>OAB</th><th>Nome</th><th>Status</th><th></th></tr></thead>
      <tbody>${linhas || '<tr><td colspan="4" class="text-muted">Nenhuma OAB cadastrada.</td></tr>'}</tbody></table>
  `, null, "Fechar", "modal-lg");
  document.getElementById("oab-add").addEventListener("click", async () => {
    const numero = val("oab-num"), uf = val("oab-uf"), nome = val("oab-nome");
    if (!numero || !uf) return toast("Informe número e UF da OAB", true);
    try {
      await api("/api/publicacoes/oabs", { method: "POST", body: JSON.stringify({ numero, uf, nome }) });
      toast("OAB adicionada!"); oabsModal();
    } catch (e) { toast(e.message, true); }
  });
}
async function toggleOab(id, ativo) {
  try { await api("/api/publicacoes/oabs/" + id, { method: "PUT", body: JSON.stringify({ numero: "", uf: "", ativo }) }); oabsModal(); }
  catch (e) { toast(e.message, true); }
}
async function deleteOab(id) {
  if (!confirm("Remover esta OAB do monitoramento?")) return;
  try { await api("/api/publicacoes/oabs/" + id, { method: "DELETE" }); toast("OAB removida"); oabsModal(); }
  catch (e) { toast(e.message, true); }
}

async function monitorModal() {
  showModal("Monitorar processo", `
    <div class="mb-2"><label class="form-label">Descrição</label><input id="m-desc" class="form-control" placeholder="Ex.: João da Silva — ação trabalhista"></div>
    <div class="mb-2"><label class="form-label">Número do processo (CNJ)*</label><input id="m-num" class="form-control" placeholder="0000000-00.0000.0.00.0000"></div>
    <div class="mb-2"><label class="form-label">Tribunal*</label>
      <select id="m-trib" class="form-select"><option value="">Selecione...</option>${tribunalOptions("")}</select></div>
    <small class="text-muted">A consulta usa o número e o tribunal escolhido. Se não encontrar, confira ambos.</small>
  `, async () => {
    const numero = val("m-num"), tribunal = val("m-trib");
    if (!numero || !tribunal) return toast("Informe número e tribunal", true);
    await api("/api/monitor", { method: "POST", body: JSON.stringify({ numero, tribunal, descricao: val("m-desc") }) });
    closeModal(); toast("Processo adicionado!"); renderMonitoramento();
  });
}

async function consultarMonitor(id) {
  toast("Consultando DataJud...");
  try {
    const r = await api("/api/monitor/" + id + "/consultar", { method: "POST" });
    showMovimentosModal(r.capa, r.movimentos, r.found);
    renderMonitoramento();
  } catch (e) { toast(e.message, true); }
}

async function verMovimentos(id) {
  const r = await api("/api/monitor/" + id + "/movimentos");
  showMovimentosModal(null, r.movimentos || [], (r.movimentos || []).length > 0);
}

function showMovimentosModal(capa, movs, found) {
  const capaHtml = capa ? `<div class="mb-3 small text-muted">
      <span class="me-3"><strong>Classe:</strong> ${esc(capa.classe || "—")}</span>
      <span class="me-3"><strong>Órgão:</strong> ${esc(capa.orgao || "—")}</span>
      <span><strong>Ajuizamento:</strong> ${fmtDateTime(capa.ajuizamento)}</span>
    </div>` : "";
  const body = !found
    ? '<div class="alert alert-warning mb-0">Nenhuma movimentação pública encontrada. Verifique o número e o tribunal — a base do DataJud não é em tempo real e exclui processos sigilosos.</div>'
    : capaHtml + `<ul class="list-group">${movs.map(m => `
        <li class="list-group-item d-flex justify-content-between align-items-start">
          <span>${esc(m.nome)}</span>
          <small class="text-muted text-nowrap ms-3">${fmtDateTime(m.data)}</small>
        </li>`).join("")}</ul>`;
  showModal("Movimentações do processo", body, null, "Fechar");
}

async function deleteMonitor(id) {
  if (!confirm("Remover este processo do monitoramento?")) return;
  await api("/api/monitor/" + id, { method: "DELETE" });
  toast("Removido!"); renderMonitoramento();
}

async function testarEmailMonitor() {
  toast("Enviando e-mail de teste...");
  try {
    const r = await api("/api/monitor/testar-email", { method: "POST" });
    toast("E-mail de teste enviado para " + (r.destinatario || "—"));
  } catch (e) { toast(e.message, true); }
}

async function verificarTodosMonitores() {
  toast("Verificando todos os processos no DataJud...");
  try {
    const r = await api("/api/monitor/verificar-todos", { method: "POST" });
    toast(`Verificados: ${r.checados} • Com novidade: ${r.novidades}`);
    renderMonitoramento();
    atualizarSinoMonitor();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- Segurança: marca d'água + alertas ---------------- */
function aplicarMarcaDagua() {
  if (!CURRENT_USER) return;
  let el = document.getElementById("security-watermark");
  if (!el) {
    el = document.createElement("div");
    el.id = "security-watermark";
    el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9998;";
    document.body.appendChild(el);
  }
  const txt = ((CURRENT_USER.name || "") + "  •  " + new Date().toLocaleString("pt-BR")).replace(/[<>&"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="370" height="210"><text x="18" y="120" fill="#7a7a7a" font-family="sans-serif" font-size="14" transform="rotate(-24 185 105)">${txt}</text></svg>`;
  el.style.backgroundImage = "url('data:image/svg+xml;utf8," + encodeURIComponent(svg) + "')";
  el.style.opacity = document.documentElement.getAttribute("data-bs-theme") === "dark" ? "0.12" : "0.07";
}
function removerMarcaDagua() {
  const el = document.getElementById("security-watermark");
  if (el) el.remove();
}

async function atualizarAlertasSeguranca() {
  if (!CURRENT_USER || CURRENT_USER.role !== "admin") return;
  try {
    const r = await api("/api/auditoria/alertas");
    const link = document.querySelector('#nav-auditoria .nav-link');
    if (!link) return;
    let b = document.getElementById("audit-alert-badge");
    if (r.count > 0) {
      if (!b) { b = document.createElement("span"); b.id = "audit-alert-badge"; b.className = "badge bg-danger ms-auto"; link.appendChild(b); }
      b.textContent = r.count;
    } else if (b) { b.remove(); }
  } catch (e) {}
}

/* ---------------- Sino de novidades (Monitoramento) ---------------- */
async function atualizarSinoMonitor() {
  if (!CURRENT_USER || CURRENT_USER.role !== "admin") return;
  const bell = document.getElementById("nav-bell");
  const badge = document.getElementById("bell-count");
  if (!bell) return;
  bell.style.display = "inline-flex";
  try {
    // Soma novidades do DataJud + publicações do DJEN ainda não lidas
    const [mon, pub] = await Promise.all([
      api("/api/monitor/novidades").catch(() => ({ count: 0 })),
      api("/api/publicacoes/novidades").catch(() => ({ count: 0 })),
    ]);
    window._djenNovas = pub.count || 0;   // usado para abrir a aba certa ao clicar
    const total = (mon.count || 0) + (pub.count || 0);
    if (total > 0) { badge.textContent = total > 99 ? "99+" : total; badge.style.display = "inline-block"; bell.classList.add("text-danger"); }
    else { badge.style.display = "none"; bell.classList.remove("text-danger"); }
  } catch (e) {}
}
// Ao clicar no sino: se houver publicações novas, abre direto a aba Publicações
function abrirSino() {
  if (window._djenNovas > 0) monitView = "djen";
  navigate("monitoramento");
}

/* =========================================================
   Restauração de sessão (mantém login ao apertar F5)
   ========================================================= */
async function restoreSession() {
  let saved = null;
  try { saved = localStorage.getItem("crm_token"); } catch (e) {}
  if (!saved) return;                 // sem token salvo -> mostra login
  // Se ficou mais de 1h sem atividade, expira a sessão ao reabrir
  if (sessaoInativaExpirada()) {
    try { localStorage.removeItem("crm_token"); localStorage.removeItem("crm_last_activity"); } catch (_) {}
    return;
  }
  TOKEN = saved;
  try {
    CURRENT_USER = await api("/api/auth/me");  // valida o token
    startApp();
  } catch (e) {
    // token expirado/inválido -> limpa e permanece na tela de login
    TOKEN = null;
    try { localStorage.removeItem("crm_token"); } catch (_) {}
  }
}
// Só depois de TODOS os scripts rodarem: a sessão restaurada já abre a rota
// do hash (F5 numa ficha), e quem desenha a ficha mora no ficha*.js, que o
// index.html carrega DEPOIS deste arquivo. Chamado aqui direto, o F5 numa
// ficha cairia em "função não existe".
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restoreSession);
else restoreSession();


/* =========================================================
   REGISTRO DE AÇÕES — a allowlist do despachante
   =========================================================
   Fica no FIM do arquivo, depois de tudo declarado.

   ⚠️ AÇÃO NOVA PRECISA ENTRAR AQUI. Se não entrar, o clique não faz nada e o
   console avisa ("[acoes] ação não registrada"). É de propósito: a
   alternativa — procurar a função em `window[nome]` — deixaria qualquer HTML
   injetado chamar `eval` com um clique. A allowlist é o que torna a delegação
   mais segura que o `onclick=` que ela substituiu, e não apenas diferente.
   ========================================================= */
registrarAcoes({
  _pubPrazoPreview, abrirAcao, abrirPrecatorio, _cliTipoPessoaSync, _cliOrigemSync, _procClienteNovo,
  abrirSino, acAbrirSeletorXlsx, acAuditEnter, acCepEnter,
  acDjenToggleAuto, acDjenToggleNovas, acDjenToggleAll, acDjenToggleArquivadas,
  djenUpdateSel, arquivarDjenSelecionadas, arquivarDjenTodasLidas, desarquivarDjenSelecionadas,
  excluirDjenSelecionadas,
  acEmailDestinatario,
  acImgMarcaFallback, acImgOcultar, acImportarXlsx, acMaskMoeda, acMaskMoedaRateio, acDcSimMoeda, acHonCasoMudou,
  acMonitAba, acNada, acNavegar, acNovoHonorarioAcao,
  acParadosMarcarTodos, acParadosVer, acPrecToggleAll, acPreencherNomeCliente,
  acSelecionarTudo, acStatusAssinatura, acToggleOrigemAssinatura, acToggleParceria,
  acToggleRateio, acToggleVinculoAssinatura, acUsarSugestaoIA, acaoAddContato,
  acaoDelContato, acaoDelDoc, acaoUploadDoc, agendaMonthShift,
  alterarSenhaModal, appointmentModal, assinaturaModal, assumirAcao,
  assumirNoCaso, assumirNoCasoAcao, assumirPrecatorio, auditAplicar,
  auditExclusoesEstagiario, auditLimpar, auditarDuplicados, auditarParados,
  calcularPrazo, clientModal, consultarMonitor,
  deadlineModal, deleteAcao, deleteAppointment, deleteAssinatura,
  deleteClient, deleteDeadline, deleteDocument, deleteHonorario,
  deleteMonitor, deleteOab, deletePrecatorio, deleteProcess,
  deleteUsuario, diagnosticoDjen, distAtualizarPreview, distConfigModal,
  documentModal, downloadAssinatura, downloadDoc, downloadRecibo,
  enviarClicksign, excluirDuplicadosSelecionados, excluirPrecatoriosSelecionados, exportLista,
  gerarPrazoPub, honorarioModal, casoTrocouCliente, casoBuscar,
  casoTrocouClientePc, casoBuscarPc, iaAnalisar, iaCriar,
  iaPerguntar, liberarAcao, liberarNoCaso, liberarNoCasoAcao,
  liberarParadosSelecionados, liberarPrecatorio, logout, modeloModal,
  monitorModal, movePipeline, novaAcao, novoPrecatorio,
  oabsModal, parcelarModal, permissoesModal, precAddContato,
  precDelContato, precDelDoc, precUpdateSel, precUploadDoc,
  processModal, pubNovoCliente, pubNovoProcesso,
  pubSalvarCliente, pubSalvarProcesso, pubSideFechar, removerAvatar,
  renderAcoes, renderFunilPrec, renderPrecatorios, renotificarAssinatura,
  salvarAcao, salvarPrecatorio, segurancaModal, sincronizarAssinatura,
  sincronizarDjen, testarEmailMonitor, tfConfirmarTroca, tfTrocarAparelho,
  toggleDeadline, toggleOab,
  usuarioModal, verMovimentos, verPublicacao, verificarTodosMonitores,
});

// Estas NÃO são declarações de função: ou são atribuídas a `window` dentro de
// outra função (só passam a existir depois que a tela é montada), ou vivem no
// <script> do index.html, que roda DEPOIS do app.js. Referenciá-las direto
// aqui daria `undefined`. O wrapper resolve no momento do clique — continua
// sendo allowlist, porque só estes nomes entram.
["_buscarCep", "_dcRecalc", "_procSyncSistema", "_procSyncSub", "toggleTheme"].forEach(function (nome) {
  ACOES[nome] = function (...args) {
    const fn = window[nome];
    if (typeof fn !== "function") {
      console.warn("[acoes] ação tardia ainda indefinida:", nome);
      return;
    }
    return fn.apply(this, args);
  };
});
