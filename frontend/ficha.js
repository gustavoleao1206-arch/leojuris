/* =========================================================
   ficha.js — núcleo da FICHA ÚNICA de Cliente e de Processo
   (roteador por hash, guarda de alteração não salva, casca da ficha,
   componentes de tela, máscaras, formatação e cache).

   Carregado DEPOIS do app.js (index.html), como
   script clássico: tudo aqui é global e convive no MESMO escopo do app.js e
   dos outros três arquivos da ficha. Duas consequências que já derrubaram
   código em silêncio e por isso viraram regra (SPEC §2.3):
     - `const`/`let` repetido entre arquivos é SyntaxError do arquivo INTEIRO:
       nenhuma linha dele roda e nenhuma ação é registrada;
     - `function` repetida sobrescreve sem erro, mas o ACOES continua
       apontando para a versão antiga.
   Por isso todo nome de topo daqui leva prefixo: ficha*, ui*, fmt*, FICHA_*,
   cache* — com as exceções que a própria SPEC nomeia (irPara, confirmar,
   valOpt).

   Nada de `on*=` no HTML (a CSP não tem 'unsafe-inline' em script): eventos
   por `data-on-click="nome"` + `data-args="${escArgs(...)}"`, e a função
   registrada no `registrarAcoes` do FIM deste arquivo.
   ========================================================= */

/* =========================================================
   1. ESTADO
   ========================================================= */

/** Estado da ficha aberta — UM objeto só, lido pelos módulos e handlers.
 *  Handlers recebem apenas ids em `data-args` e leem o resto daqui (objeto
 *  com função dentro não cabe num atributo). Campos internos (cfg, abas,
 *  abasEstado, aoSalvar, aoDescartar, sujoAba) são da casca: não mexa. */
function fichaEstadoVazio() {
  return {
    tipo: null, id: null, aba: null, ctx: null, novo: {},
    cfg: null, abas: [], abasEstado: {},
    aoSalvar: null, aoDescartar: null, sujoAba: null,
    // Barra do rodapé (fichaVigiarAlteracoes): rótulos próprios e o modo
    // "sempre visível" (cadastro NOVO), preso à aba que o pediu.
    rotuloSalvar: null, rotuloDescartar: null, barraSempreAba: null,
    // Formulários curtos com texto não salvo (fichaMarcarRascunho):
    // chave → rótulo. Mora aqui para zerar junto com a ficha (troca de
    // ficha, troca de tela e logout).
    rascunhos: new Map(),
  };
}
let FICHA = fichaEstadoVazio();

/** Há edição não salva na tela? Lido pela guarda (fichaPodeSair) e pelo
 *  beforeunload. Só mude por fichaMarcarSujo(), que também mostra a barra. */
let fichaSujo = false;

/** Hash da tela que está desenhada AGORA. Não é o mesmo que location.hash:
 *  no popstate a URL já mudou antes de decidirmos se a troca é permitida, e
 *  é este valor que usamos para desfazer a troca. */
let fichaHashTela = "";
/** Rota desenhada agora ({padrao, rota, params, query, caminho}) ou null. */
let fichaRota = null;
/** Muda a cada troca de rota — permite a quem carrega dados descartar uma
 *  resposta que chegou depois de o usuário já ter ido para outra tela. */
let fichaRotaN = 0;
/** Posição desta entrada no histórico DO APP (0 = primeira tela da sessão).
 *  Serve ao fichaVoltar: só faz `history.back()` se a entrada anterior é
 *  nossa; senão o "Voltar" levaria a pessoa para fora do CRM. */
let fichaIdx = 0;
/** Já existe uma confirmação de "Descartar alterações?" aberta por um
 *  popstate. Sem isto, apertar Voltar duas vezes abria duas perguntas. */
let fichaPerguntando = false;

/** Cada arquivo registra aqui o reset do PRÓPRIO estado global (filtros etc.).
 *  Roda no logout — que não recarrega a página, então filtro esquecido aqui
 *  sobrevive e vaza para o próximo usuário (já aconteceu).
 *     FICHA_LIMPEZA.push(() => { cliFiltro = { busca: "", status: "" }; });  */
const FICHA_LIMPEZA = [];

/* =========================================================
   2. RÓTULOS E LISTAS FECHADAS
   =========================================================
   Os rótulos das listas NOVAS ficam SÓ aqui (SPEC §2.3) — a mesma lista
   escrita em dois arquivos diverge na primeira mudança. As chaves espelham as
   listas canônicas do backend (scope.py): chave nova lá = chave nova aqui.
   Para exibir: `esc(fichaRotulo("origem", c.origem))` — o fallback devolve a
   chave crua quando ela não está no dicionário, então SEMPRE dentro de esc(). */
const FICHA_ROTULOS = {
  atendimentoTipo: {
    nota: "Nota", ligacao: "Ligação", whatsapp: "WhatsApp", email: "E-mail",
    reuniao: "Reunião", presencial: "Presencial", outro: "Outro",
  },
  contatoPapel: {
    representante_legal: "Representante legal", socio: "Sócio(a)", procurador: "Procurador(a)",
    conjuge: "Cônjuge", familiar: "Familiar", financeiro: "Financeiro", contato: "Contato", outro: "Outro",
  },
  parteTipo: { contraria: "Parte contrária", litisconsorte: "Litisconsorte", terceiro: "Terceiro interessado", outro: "Outro" },
  partePolo: { ativo: "Polo ativo", passivo: "Polo passivo", terceiro: "Terceiro", outro: "Outro" },
  origem: {
    indicacao: "Indicação", site: "Site", instagram: "Instagram", google: "Google",
    whatsapp: "WhatsApp", cliente_antigo: "Cliente antigo", parceiro: "Parceiro", outro: "Outro",
  },
  tipoPessoa: { PF: "Pessoa física", PJ: "Pessoa jurídica" },
  tipoPessoaCurto: { PF: "PF", PJ: "PJ" },
  instancia: { primeiro_grau: "1º grau", segundo_grau: "2º grau", superior: "Tribunal superior" },
  processoStatus: { ativo: "Ativo", suspenso: "Suspenso", encerrado: "Encerrado" },
  /** Tipos de evento da linha do tempo (backend §3.5). */
  evento: {
    cadastro: "Cadastro", processo: "Processo", prazo: "Prazo", audiencia: "Audiência",
    documento: "Documento", andamento: "Andamento", publicacao: "Publicação",
    atendimento: "Atendimento", honorario: "Honorário", parte: "Parte", assinatura: "Assinatura",
  },
};

/** Ícones das listas acima (Bootstrap Icons). Mesma regra: só aqui. */
const FICHA_ICONES = {
  atendimentoTipo: {
    nota: "bi-journal-text", ligacao: "bi-telephone", whatsapp: "bi-whatsapp", email: "bi-envelope",
    reuniao: "bi-people", presencial: "bi-person-walking", outro: "bi-three-dots",
  },
  evento: {
    cadastro: "bi-flag", processo: "bi-folder2-open", prazo: "bi-alarm", audiencia: "bi-calendar-event",
    documento: "bi-file-earmark-text", andamento: "bi-arrow-right-circle", publicacao: "bi-megaphone",
    atendimento: "bi-chat-dots", honorario: "bi-cash-coin", parte: "bi-people", assinatura: "bi-pen",
  },
};

/** Tons de selo/alerta. Lista FECHADA: o tom vira classe CSS, e classe vinda
 *  de dado só pode sair de lista fechada (SPEC §1). */
const FICHA_TONS = ["success", "warning", "danger", "info", "neutral", "accent"];

const FICHA_MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
  "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Rótulo de uma lista de FICHA_ROTULOS. Devolve TEXTO (não escapado). */
function fichaRotulo(lista, chave) {
  if (chave === null || chave === undefined || chave === "") return "";
  const m = FICHA_ROTULOS[lista];
  return (m && Object.prototype.hasOwnProperty.call(m, chave)) ? m[chave] : String(chave);
}

/** `<option>`s de uma lista de FICHA_ROTULOS, já escapadas.
 *  Valor gravado que saiu da lista (dado antigo) vira uma opção "(atual)" —
 *  sem isso o select mostraria a 1ª opção e o salvar trocaria o dado calado. */
function fichaOpcoes(lista, atual, opts = {}) {
  const m = FICHA_ROTULOS[lista] || {};
  const cur = atual === null || atual === undefined ? "" : String(atual);
  let html = opts.vazio !== undefined ? `<option value="">${esc(opts.vazio)}</option>` : "";
  html += Object.entries(m).map(([k, r]) =>
    `<option value="${esc(k)}"${k === cur ? " selected" : ""}>${esc(r)}</option>`).join("");
  if (cur && !Object.prototype.hasOwnProperty.call(m, cur)) {
    html += `<option value="${esc(cur)}" selected>${esc(cur)} (atual)</option>`;
  }
  return html;
}

/* --- higienização de valores que viram atributo/classe --- */
function fichaIconeSeguro(ic) { return typeof ic === "string" && /^bi-[a-z0-9-]+$/.test(ic) ? ic : ""; }
function fichaTomSeguro(t) { return FICHA_TONS.includes(t) ? t : "neutral"; }
function fichaIdSeguro(id) { return String(id === null || id === undefined ? "" : id).replace(/[^A-Za-z0-9_-]/g, ""); }
function fichaAcaoSegura(nome) { return typeof nome === "string" && /^[A-Za-z_$][\w$]*$/.test(nome) ? nome : ""; }
/** Só hash interno (`#/...`) vira href — nada de `javascript:` vindo de dado. */
function fichaHashSeguro(h) {
  return typeof h === "string" && /^#\/[\w\-\/?=&%.:,+]*$/.test(h) ? h : "";
}
function fichaArgs(a) { return Array.isArray(a) ? a : (a === undefined ? [] : [a]); }

/* =========================================================
   3. ROTEADOR (hash)
   =========================================================
   Por que HASH e não caminho: o backend só serve "/" (main.py) — um F5 em
   /clientes/12 daria 404. Com `#/clientes/12` a URL é compartilhável, o F5
   reabre a mesma ficha e o Voltar do navegador funciona.

   Regras (SPEC §2.4):
     - navigate(view, {historico}) grava `#/<slug>` só se o hash for outro
       (clicar em "Clientes" estando em Clientes não empilha);
     - popstate renderiza com historico:'nenhum' — NUNCA grava (se gravasse, o
       Voltar empilharia e o Avançar morreria);
     - startApp abre a rota do hash com 'replace'; sem hash/rota inválida →
       dashboard;
     - rota de detalhe passa pelas MESMAS travas de navigate (pela `perm`);
       sem permissão → toast + replace para #/dashboard.

   Tabela: padrão → { view, perm, abrir?, admin?, titulo?, lista?, rotuloLista?, edita? }.
   `view` é a chave do app.js (sidebar e VIEW_TITLES). ORDEM IMPORTA:
   "clientes/novo" antes de "clientes/:id".
   `lista`/`rotuloLista`: para onde o "Registro não encontrado ou sem acesso"
   leva quando a ficha responde 404/403. `edita`: rota de CADASTRO — além de
   ver o módulo, exige poder editá-lo (senão o formulário abriria e o Salvar
   daria 403 só no fim). */
const FICHA_ROTAS = {
  "dashboard":     { view: "dashboard",     perm: null },
  "clientes":      { view: "clients",       perm: "clients" },
  "processos":     { view: "processes",     perm: "processes" },
  "deadlines":     { view: "deadlines",     perm: "deadlines" },
  "appointments":  { view: "appointments",  perm: "appointments" },
  "documents":     { view: "documents",     perm: "documents" },
  "pipeline":      { view: "pipeline",      perm: null },
  "financeiro":    { view: "financeiro",    perm: "financeiro" },
  "precatorios":   { view: "precatorios",   perm: "precatorios" },
  "funilprec":     { view: "funilprec",     perm: "funilprec" },
  "acoes":         { view: "acoes",         perm: "acoes" },
  "assinaturas":   { view: "assinaturas",   perm: "assinaturas" },
  "monitoramento": { view: "monitoramento", perm: null },
  "usuarios":      { view: "usuarios",      perm: null },
  "auditoria":     { view: "auditoria",     perm: null },
  "ia":            { view: "ia",            perm: null },

  "clientes/novo": {
    view: "clients", perm: "clients", edita: true, lista: "#/clientes", rotuloLista: "Clientes",
    abrir: (p, q) => fichaChamarEntrada("fichaClienteAbrir", null, q, "Ficha do cliente", "#/clientes", "Clientes"),
  },
  "clientes/:id": {
    view: "clients", perm: "clients", lista: "#/clientes", rotuloLista: "Clientes",
    abrir: (p, q) => fichaChamarEntrada("fichaClienteAbrir", p.id, q, "Ficha do cliente", "#/clientes", "Clientes"),
  },
  "processos/novo": {
    view: "processes", perm: "processes", edita: true, lista: "#/processos", rotuloLista: "Processos",
    abrir: (p, q) => fichaChamarEntrada("fichaProcessoAbrir", null, q, "Ficha do processo", "#/processos", "Processos"),
  },
  "processos/:id": {
    view: "processes", perm: "processes", lista: "#/processos", rotuloLista: "Processos",
    abrir: (p, q) => fichaChamarEntrada("fichaProcessoAbrir", p.id, q, "Ficha do processo", "#/processos", "Processos"),
  },
  "precatorios/:id": {
    view: "precatorios", perm: "precatorios", lista: "#/precatorios", rotuloLista: "Precatórios",
    abrir: (p) => fichaIdValido(p.id) ? abrirPrecatorio(Number(p.id)) : fichaNaoEncontrada("#/precatorios", "Precatórios"),
  },
  "acoes/:id": {
    view: "acoes", perm: "acoes", lista: "#/acoes", rotuloLista: "Ações Gerais",
    abrir: (p) => fichaIdValido(p.id) ? abrirAcao(Number(p.id)) : fichaNaoEncontrada("#/acoes", "Ações Gerais"),
  },
};

/** Erro de API (403, 409, "não encontrado") é situação prevista, já mostrada
 *  na tela: vai para o console como aviso. Erro de PROGRAMAÇÃO (TypeError,
 *  ReferenceError…) é defeito: vai como erro, para ninguém deixar passar. */
function fichaLogErro(onde, e) {
  const defeito = e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError;
  (defeito ? console.error : console.warn)("[ficha] erro " + onde + ":", e);
}

function fichaIdValido(id) { return /^\d{1,12}$/.test(String(id || "")); }

/** Chama a função de entrada de uma ficha (fase 3). Enquanto ela não existir,
 *  mostra "Em construção" em vez de quebrar (o roteador é da fase 1). */
function fichaChamarEntrada(nomeFn, id, q, titulo, hashLista, rotuloLista) {
  if (id !== null && !fichaIdValido(id)) return fichaNaoEncontrada(hashLista, rotuloLista);
  const entradas = {
    fichaClienteAbrir: typeof fichaClienteAbrir === "function" ? fichaClienteAbrir : null,
    fichaProcessoAbrir: typeof fichaProcessoAbrir === "function" ? fichaProcessoAbrir : null,
  };
  const fn = entradas[nomeFn];
  if (!fn) return fichaEmConstrucao(titulo, hashLista, rotuloLista);
  return fn(id === null ? null : Number(id), { aba: q.aba || null, query: q });
}

/** view do app.js → slug do hash ("clients" → "clientes"). */
function fichaSlugDaView(view) {
  for (const [padrao, r] of Object.entries(FICHA_ROTAS)) {
    if (!r.abrir && r.view === view) return padrao;
  }
  return "dashboard";
}
function fichaHashDaView(view) { return "#/" + fichaSlugDaView(view); }

/** "#/clientes/12?aba=processos" → { padrao, rota, params, query, caminho, hash } ou null. */
function fichaParseHash(hash) {
  let h = String(hash || "").replace(/^#/, "");
  if (h.startsWith("/")) h = h.slice(1);
  const i = h.indexOf("?");
  const caminho = (i < 0 ? h : h.slice(0, i)).split("/").filter(Boolean);
  const qs = i < 0 ? "" : h.slice(i + 1);
  if (!caminho.length) return null;
  const query = {};
  try { new URLSearchParams(qs).forEach((v, k) => { query[k] = v; }); } catch (e) { /* query ilegível: ignora */ }
  for (const [padrao, rota] of Object.entries(FICHA_ROTAS)) {
    const pp = padrao.split("/");
    if (pp.length !== caminho.length) continue;
    const params = {};
    let ok = true;
    for (let k = 0; k < pp.length && ok; k++) {
      if (pp[k].startsWith(":")) {
        try { params[pp[k].slice(1)] = decodeURIComponent(caminho[k]); } catch (e) { ok = false; }
      } else if (pp[k] !== caminho[k]) ok = false;
    }
    if (!ok) continue;
    const q = new URLSearchParams(query).toString();
    const cam = caminho.join("/");
    return { padrao, rota, params, query, caminho: cam, hash: "#/" + cam + (q ? "?" + q : "") };
  }
  return null;
}

/** As MESMAS travas de navigate (app.js), aplicadas a qualquer rota. */
function fichaRotaPermitida(rota) {
  if (!CURRENT_USER) return false;
  if (rota.admin && !permIsAdmin()) return false;
  if (ADMIN_ONLY_VIEWS.includes(rota.view) && !permIsAdmin()) return false;
  if (rota.view === "monitoramento" && !podeVerMonitoramento()) return false;
  if (rota.perm && PERM_MODULES.includes(rota.perm) && !permCanView(rota.perm)) return false;
  return true;
}

/** Tudo o que TODA troca de tela faz antes de desenhar (navigate e rotas de
 *  detalhe): fecha modal e backdrop esquecidos, zera a ficha, marca a sidebar,
 *  título, spinner e rola ao topo. Quem chega aqui JÁ passou pela guarda. */
function fichaPrepararTela(view, titulo) {
  fichaLimparModais();
  // Uma confirmação aberta ("Excluir este prazo?") pertence à tela que está
  // saindo: respondida depois, agiria sobre a tela nova.
  if (fichaConfirmarAtual) fichaConfirmarAtual.fechar(false);
  fichaMarcarSujo(false);
  FICHA = fichaEstadoVazio();
  fichaTituloDocumento(null);
  document.querySelectorAll(".sidebar .nav-link").forEach((l) =>
    l.classList.toggle("active", l.dataset.view === view));
  const t = document.getElementById("view-title");
  if (t) t.textContent = titulo || VIEW_TITLES[view] || "";
  const c = fichaTrocarContainer();
  if (c) {
    c.innerHTML = uiCarregando();
    // re-dispara a animação de transição entre páginas
    c.classList.remove("view-fade"); void c.offsetWidth; c.classList.add("view-fade");
  }
  fichaBarraAtualizar();
  fichaRolarAoTopo();
}

/** Troca o #view-container por um CLONE VAZIO (mesmo id e classes) e devolve
 *  o novo. É o que fecha a corrida de render: as telas do app.js fazem
 *    const c = document.getElementById("view-container"); await api(...); c.innerHTML = ...
 *  — uma resposta que chega DEPOIS de a pessoa ir para outra tela escrevia
 *  por cima da tela nova (a lista de Prazos aparecia no lugar da ficha que
 *  ela tinha acabado de abrir). Com o nó trocado, o render atrasado escreve
 *  num elemento que já saiu do documento e ninguém vê. Vale também no logout
 *  (app.js): a tela do usuário anterior não pode aparecer para o próximo. */
function fichaTrocarContainer() {
  const velho = document.getElementById("view-container");
  if (!velho) return null;
  const novo = velho.cloneNode(false);
  velho.replaceWith(novo);
  return novo;
}

/** Modal aberto + troca de rota (Voltar do navegador com um modal na frente)
 *  deixava modal e backdrop por cima da tela nova. O hide() do Bootstrap é
 *  animado; o backdrop "órfão" (modal-container reescrito com o modal aberto)
 *  nunca sai sozinho — por isso a varredura depois da animação. */
function fichaLimparModais() {
  try { closeModal(); } catch (e) { /* sem modal */ }
  setTimeout(() => {
    if (document.querySelector(".modal.show")) return;   // abriu outro nesse meio tempo
    document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove());
    document.body.classList.remove("modal-open");
    document.body.style.removeProperty("overflow");
    document.body.style.removeProperty("padding-right");
  }, 400);
}

/** No celular (<992px) a sidebar fica EM CIMA do conteúdo: rolar para o
 *  topo da página mostraria o menu, não a tela nova. */
function fichaRolarAoTopo() {
  const c = document.getElementById("view-container");
  if (window.innerWidth < 992 && c) c.scrollIntoView({ block: "start", behavior: "instant" });
  else window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

/** Grava o hash conforme o modo de histórico e registra a rota desenhada.
 *  'push' não empilha se o hash já é o mesmo; 'nenhum' não toca no histórico
 *  (é o popstate: a URL já está certa). */
function fichaGravarHash(hash, historico) {
  fichaHashTela = hash;
  fichaRota = fichaParseHash(hash);
  fichaRotaN += 1;
  if (historico === "nenhum") return;
  if (historico === "replace") { history.replaceState({ fichaIdx }, "", hash); return; }
  if (location.hash === hash) return;
  fichaIdx += 1;
  history.pushState({ fichaIdx }, "", hash);
}

/** Para tela aberta FORA do roteador (abrirPrecatorio/abrirAcao chamados pela
 *  lista) acertar a URL e a sidebar sem redesenhar nada. Use isto, e NUNCA
 *  history.pushState direto: o pushState cru deixa o fichaIdx e o
 *  fichaHashTela para trás, e o Voltar/guarda passam a errar de entrada. */
function fichaSincronizarHash(hash, opts = {}) {
  const r = fichaParseHash(hash);
  if (!r) return;
  fichaGravarHash(r.hash, opts.replace ? "replace" : "push");
  document.querySelectorAll(".sidebar .nav-link").forEach((l) =>
    l.classList.toggle("active", l.dataset.view === r.rota.view));
}

/** Abre uma rota pelo hash. É o coração do roteador: startApp, popstate,
 *  irPara e os links internos passam por aqui.
 *  opts.historico: 'push' | 'replace' | 'nenhum'; opts.guarda:false pula a
 *  pergunta de alteração não salva (quem chama já perguntou). */
async function fichaRotear(hash, opts = {}) {
  const historico = opts.historico || "push";
  if (!CURRENT_USER) return false;
  // Início de sessão (startApp): retoma a posição gravada nesta entrada do
  // histórico — depois de um F5 o "Voltar" da ficha continua sabendo se há
  // tela do app antes desta.
  if (opts.inicio) fichaIdx = history.state && typeof history.state.fichaIdx === "number" ? history.state.fichaIdx : 0;
  const alvo = fichaParseHash(hash);
  if (!alvo) {
    return fichaRotear("#/dashboard", { historico: historico === "push" ? "push" : "replace", guarda: opts.guarda, inicio: false });
  }
  if (opts.guarda !== false && !(await fichaPodeSair())) return false;
  if (!fichaRotaPermitida(alvo.rota)) {
    toast("Você não tem permissão para acessar esta tela.", true);
    return fichaRotear("#/dashboard", { historico: "replace", guarda: false });
  }
  // Cadastro (#/clientes/novo) sem permissão de EDITAR o módulo: quem só lê
  // vai para a lista, onde está o que ele pode fazer.
  if (alvo.rota.edita && alvo.rota.perm && !permCanEdit(alvo.rota.perm)) {
    toast("Você não tem permissão para cadastrar neste módulo.", true);
    return fichaRotear(alvo.rota.lista || "#/dashboard", { historico: "replace", guarda: false });
  }
  // Tela de lista: o navigate do app.js faz o resto (inclusive gravar o hash).
  if (!alvo.rota.abrir) return navigate(alvo.rota.view, { historico, semGuarda: true });
  fichaPrepararTela(alvo.rota.view, alvo.rota.titulo);
  fichaGravarHash(alvo.hash, historico);
  const tk = fichaRotaToken();
  try {
    await alvo.rota.abrir(alvo.params, alvo.query);
  } catch (e) {
    fichaLogErro("ao abrir " + alvo.hash, e);
    const c = document.getElementById("view-container");
    if (!c || !fichaRotaValida(tk)) return true;     // a pessoa já foi para outra tela
    // 404/403 é "não existe ou não é seu": orientação + caminho de volta, não
    // a caixa vermelha de erro (que não diz o que fazer). A ficha que trata o
    // próprio 404 não chega aqui; esta é a rede de proteção.
    if (e && (e.status === 404 || e.status === 403)) fichaNaoEncontrada(alvo.rota.lista, alvo.rota.rotuloLista);
    else c.innerHTML = errorBox(e);
  }
  return true;
}

/** Abre uma ficha/tela pelo hash (com a guarda). `{replace:true}` troca a
 *  entrada atual em vez de empilhar — use depois de criar um registro
 *  (`#/clientes/novo` → `#/clientes/9`), senão o Voltar reabre o formulário. */
function irPara(hash, opts = {}) {
  return fichaRotear(hash, { historico: opts.replace ? "replace" : "push" });
}

/** AÇÃO para links internos dentro de linha clicável:
 *    <a href="#/clientes/3" data-on-click="fichaIr" data-args="${escArgs('#/clientes/3')}">
 *  Ctrl/⌘/Shift+clique segue o padrão do navegador (abre em outra aba). */
function fichaIr(hash) {
  const ev = eventoAtual();
  if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey)) return;
  if (ev) ev.preventDefault();
  const h = fichaHashSeguro(hash);
  if (h) irPara(h);
}

/** "Voltar" de dentro de uma ficha. Se a entrada anterior do histórico é do
 *  app, é o Voltar do navegador (volta para onde a pessoa estava: lista,
 *  outra ficha...). Se não (link aberto direto, F5 na primeira tela), vai
 *  para a lista SEM empilhar — senão o Voltar seguinte voltaria à ficha. */
function fichaVoltar(hashLista) {
  if (fichaIdx > 0) { history.back(); return; }
  irPara(fichaHashSeguro(hashLista) || "#/dashboard", { replace: true });
}

/** Token da rota atual. Quem carrega dados com await faz:
 *    const tk = fichaRotaToken(); const x = await api(...);
 *    if (!fichaRotaValida(tk)) return;   // o usuário já saiu desta tela */
function fichaRotaToken() { return fichaRotaN; }
function fichaRotaValida(tk) { return tk === fichaRotaN; }
function fichaRotaAtual() { return fichaRota; }

/** Ficha com id inválido, 404 ou 403: orientação + caminho de volta, em vez
 *  da caixa vermelha de erro (que não diz o que fazer). */
function fichaNaoEncontrada(hashLista, rotuloLista) {
  const c = document.getElementById("view-container");
  if (!c) return;
  const h = fichaHashSeguro(hashLista) || "#/dashboard";
  c.innerHTML = `<div class="ficha"><div class="ficha-sozinha">${uiVazio({
    icone: "bi-search",
    titulo: "Registro não encontrado ou sem acesso",
    texto: "Ele pode ter sido excluído ou pertencer a outro responsável. Se precisar dele, fale com o administrador.",
    acaoHtml: `<a class="btn btn-sm btn-primary" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}"><i class="bi bi-arrow-left"></i> Voltar para ${esc(rotuloLista || "a lista")}</a>`,
  })}</div></div>`;
}

function fichaEmConstrucao(titulo, hashLista, rotuloLista) {
  const c = document.getElementById("view-container");
  if (!c) return;
  const h = fichaHashSeguro(hashLista) || "#/dashboard";
  c.innerHTML = `<div class="ficha"><div class="ficha-sozinha">${uiVazio({
    icone: "bi-cone-striped",
    titulo: `${titulo} — em construção`,
    texto: "Esta tela ainda não foi publicada nesta versão.",
    acaoHtml: `<a class="btn btn-sm btn-ficha" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}"><i class="bi bi-arrow-left"></i> ${esc(rotuloLista || "Voltar")}</a>`,
  })}</div></div>`;
}

/** Zera o estado da ficha (logout). O hash é limpo pelo próprio
 *  limparEstadoDeTela (app.js), para funcionar mesmo sem este arquivo. */
function fichaLimparEstado() {
  fichaMarcarSujo(false);
  FICHA = fichaEstadoVazio();
  fichaRota = null; fichaHashTela = ""; fichaIdx = 0; fichaRotaN += 1;
  if (fichaConfirmarAtual) fichaConfirmarAtual.fechar(false);
  fichaTituloDocumento(null);
  document.body.classList.remove("ficha-com-barra");
  FICHA_LIMPEZA.forEach((f) => {
    try { f(); } catch (e) { console.error("[ficha] limpeza falhou", e); }
  });
}

/* Voltar/Avançar do navegador (e hash digitado na barra).
   O popstate NÃO é cancelável: quando ele chega, a URL já mudou. Com a ficha
   suja, a saída é empilhar de volta a URL da ficha NA HORA (para F5 e link
   continuarem apontando para o que está na tela) e só sair se a pessoa
   confirmar — aí o history.back() gera um popstate novo, já sem sujeira. */
window.addEventListener("popstate", async (ev) => {
  if (!TOKEN || !CURRENT_USER) return;          // tela de login: nada a rotear
  const destino = location.hash || "#/dashboard";
  const idxEstado = ev.state && typeof ev.state.fichaIdx === "number" ? ev.state.fichaIdx : null;
  if (fichaPerguntando || fichaHaPendencia()) {
    fichaIdx = (idxEstado === null ? fichaIdx : idxEstado) + 1;
    history.pushState({ fichaIdx }, "", fichaHashTela || "#/dashboard");
    if (fichaPerguntando) return;               // já há uma pergunta aberta
    fichaPerguntando = true;
    let sair = false;
    try { sair = await fichaPodeSair(); } finally { fichaPerguntando = false; }
    if (sair) history.back();
    return;
  }
  if (idxEstado === null) {                     // hash digitado: entrada nova, sem carimbo
    fichaIdx += 1;
    history.replaceState({ fichaIdx }, "", destino);
  } else {
    fichaIdx = idxEstado;
  }
  fichaRotear(destino, { historico: "nenhum", guarda: false });
});

/* F5 / fechar a aba com edição não salva. O texto da janela é do navegador
   (não dá para personalizar); o preventDefault + returnValue é o que a faz
   aparecer nos três motores. */
window.addEventListener("beforeunload", (e) => {
  if (!fichaHaPendencia()) return;
  e.preventDefault();
  e.returnValue = "";
});

/* =========================================================
   4. GUARDA DE ALTERAÇÃO NÃO SALVA
   ========================================================= */

/** Liga/desliga o estado "sujo" e a barra "Alterações não salvas".
 *  `aba` (opcional): qual aba tem a edição — essa aba NÃO é redesenhada ao
 *  ser reativada (sempreAtualizar apagaria o que foi digitado). */
function fichaMarcarSujo(sujo, aba) {
  fichaSujo = !!sujo;
  FICHA.sujoAba = fichaSujo ? (aba || FICHA.sujoAba || FICHA.aba) : null;
  const raiz = document.querySelector(".ficha");
  if (raiz) raiz.classList.toggle("ficha-com-sujo", fichaSujo);
  fichaBarraAtualizar();
}

/** Desenha a barra do rodapé a partir do estado: aparece com a ficha suja ou,
 *  no cadastro NOVO (`sempreVisivel`), na aba que a pediu — limpa, só com os
 *  botões. Também marca o <body> com `ficha-com-barra` e mede a altura da
 *  barra em `--ficha-barra-h`: o toast sobe acima dela (antes cobria o
 *  "Salvar" justamente quando a pessoa ia clicar). */
function fichaBarraAtualizar() {
  const barra = document.getElementById("ficha-sujo");
  let visivel = false;
  if (barra) {
    const sempre = !!FICHA.barraSempreAba && FICHA.barraSempreAba === FICHA.aba;
    visivel = fichaSujo || sempre;
    barra.hidden = !visivel;
    barra.classList.toggle("is-limpa", !fichaSujo);
    const txt = barra.querySelector(".ficha-sujo-texto");
    if (txt) txt.hidden = !fichaSujo;
    const salvar = document.getElementById("ficha-sujo-salvar");
    // Botão em gravação ("Salvando…"): o finally do fichaSujoSalvar devolve o rótulo.
    if (salvar) {
      salvar.hidden = typeof FICHA.aoSalvar !== "function";
      if (!salvar.disabled) salvar.innerHTML = `<i class="bi bi-check-lg" aria-hidden="true"></i> ${esc(FICHA.rotuloSalvar || "Salvar")}`;
    }
    const desc = document.getElementById("ficha-sujo-descartar");
    if (desc) desc.textContent = FICHA.rotuloDescartar || "Descartar";
  }
  document.body.classList.toggle("ficha-com-barra", visivel);
  if (visivel) document.documentElement.style.setProperty("--ficha-barra-h", Math.max(48, barra.offsetHeight) + "px");
}

/** Formulário CURTO com texto digitado e ainda não gravado (contato,
 *  atendimento, parte, andamento). Não é "sujeira" da ficha: não mostra a
 *  barra do rodapé nem oferece Salvar — só faz a guarda perguntar antes de
 *  sair ("Há texto não salvo em <rótulo>. Sair mesmo assim?").
 *    fichaMarcarRascunho('contato', true, 'Contatos')   // ao digitar
 *    fichaMarcarRascunho('contato', false)              // salvou ou limpou
 *  `chave` é livre (uma por formulário); sem rótulo, a própria chave. Zera
 *  sozinho na troca de ficha/tela e no logout (mora em FICHA). */
function fichaMarcarRascunho(chave, ativo, rotulo) {
  const k = chave === null || chave === undefined ? "" : String(chave);
  if (!k) return;
  if (ativo) FICHA.rascunhos.set(k, String(rotulo || FICHA.rascunhos.get(k) || k));
  else FICHA.rascunhos.delete(k);
}
function fichaRascunhosRotulos() { return [...new Set(FICHA.rascunhos.values())]; }
/** Há algo que a troca de tela perderia? (ficha suja OU rascunho curto) */
function fichaHaPendencia() { return fichaSujo || FICHA.rascunhos.size > 0; }
/** ["A","B","C"] → "A, B e C". */
function fichaListaHumana(lista) {
  const l = (lista || []).filter(Boolean);
  return l.length <= 1 ? (l[0] || "") : l.slice(0, -1).join(", ") + " e " + l[l.length - 1];
}

/** Pode trocar de tela? Pergunta só se houver edição não salva — no
 *  formulário da ficha (barra do rodapé) ou num formulário curto
 *  (fichaMarcarRascunho). Promise<boolean> — navigate()/irPara()/popstate
 *  esperam por ela. */
async function fichaPodeSair() {
  const rasc = fichaRascunhosRotulos();
  if (!fichaSujo && !rasc.length) return true;
  const onde = fichaListaHumana(rasc);
  const r = await confirmar(fichaSujo ? {
    titulo: "Descartar alterações?",
    texto: "Há alterações nesta ficha que ainda não foram salvas. Se sair agora, elas serão perdidas." +
      (rasc.length ? ` Também há texto não salvo em ${onde}.` : ""),
    botao: "Descartar e sair",
    cancelar: "Continuar editando",
    perigo: true,
  } : {
    titulo: "Descartar o texto digitado?",
    texto: `Há texto não salvo em ${onde}. Sair mesmo assim?`,
    botao: "Descartar",
    cancelar: "Continuar editando",
    perigo: true,
  });
  if (r === "ok") { fichaMarcarSujo(false); FICHA.rascunhos.clear(); return true; }
  return false;
}

/** Vigia um formulário: qualquer input/change dentro de `raiz` marca a ficha
 *  como suja. Passe SÓ o contêiner do formulário — sub-bloco com gravação
 *  própria (Contatos dentro do Cadastro) fica fora dele, ou marque esse
 *  sub-bloco com `data-ficha-ignorar`.
 *    fichaVigiarAlteracoes(form, { aoSalvar: async () => {...; fichaMarcarSujo(false)},
 *                                  aoDescartar: () => fichaAtualizarAba("cadastro") })
 *  aoSalvar deve chamar fichaMarcarSujo(false) quando der certo (validação que
 *  falha não pode limpar a sujeira). Sem aoDescartar, Descartar redesenha a aba.
 *
 *  Opções da barra (valem até a próxima chamada):
 *    sempreVisivel: true  → a barra aparece mesmo LIMPA (cadastro NOVO: é o
 *                           único par de botões da tela), só nesta aba e sem
 *                           ativar a guarda enquanto nada foi digitado;
 *    rotuloSalvar         → ex.: "Cadastrar cliente" (padrão "Salvar");
 *    rotuloDescartar      → ex.: "Cancelar" (padrão "Descartar"). Com a
 *                           barra limpa, o Descartar chama aoDescartar direto
 *                           (não há o que perder, então não pergunta). */
function fichaVigiarAlteracoes(raiz, opts = {}) {
  if (!raiz) return;
  FICHA.aoSalvar = typeof opts.aoSalvar === "function" ? opts.aoSalvar : null;
  FICHA.aoDescartar = typeof opts.aoDescartar === "function" ? opts.aoDescartar : null;
  const painel = raiz.closest(".ficha-painel");
  const aba = painel ? painel.dataset.aba : FICHA.aba;
  FICHA.rotuloSalvar = opts.rotuloSalvar ? String(opts.rotuloSalvar) : null;
  FICHA.rotuloDescartar = opts.rotuloDescartar ? String(opts.rotuloDescartar) : null;
  FICHA.barraSempreAba = opts.sempreVisivel ? (aba || FICHA.aba || null) : null;
  const marcar = (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (t && t.closest("[data-ficha-ignorar]")) return;
    // Opção que é AÇÃO, não valor ("+ Cadastrar novo cliente…"): o handler
    // dela devolve o select ao valor anterior — não há o que salvar.
    if (t && t.tagName === "SELECT" && t.selectedOptions[0] && t.selectedOptions[0].hasAttribute("data-ficha-ignorar")) return;
    if (!fichaSujo) fichaMarcarSujo(true, aba);
  };
  raiz.addEventListener("input", marcar);
  raiz.addEventListener("change", marcar);
  fichaBarraAtualizar();
}

/** Botão "Salvar" da barra de alterações. Desabilita durante a gravação e
 *  SEMPRE reabilita no finally (validação que sai com `return toast(...)` não
 *  lança — se só reabilitasse no erro, o botão travaria para sempre). */
async function fichaSujoSalvar() {
  if (typeof FICHA.aoSalvar !== "function") return;
  const btn = document.getElementById("ficha-sujo-salvar");
  if (btn && btn.disabled) return;
  const rotulo = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Salvando…'; }
  try { await FICHA.aoSalvar(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = rotulo; } }
}

async function fichaSujoDescartar() {
  const estavaSujo = fichaSujo;
  // Barra LIMPA (cadastro novo, nada digitado): não há o que perder — o
  // "Cancelar" age direto, sem pergunta.
  if (estavaSujo) {
    const r = await confirmar({
      titulo: "Descartar alterações?",
      texto: "O que foi digitado e ainda não foi salvo será perdido.",
      botao: "Descartar", cancelar: "Continuar editando", perigo: true,
    });
    if (r !== "ok") return;
  }
  const fn = FICHA.aoDescartar;
  const aba = FICHA.sujoAba || FICHA.aba;
  fichaMarcarSujo(false);
  if (typeof fn === "function") { await fn(); return; }
  if (estavaSujo && aba) await fichaAtualizarAba(aba);
}

/* =========================================================
   5. CASCA DA FICHA
   =========================================================
   fichaRender({
     trilha: [{rotulo, hash}], titulo, tituloMono, copiar, subtitulo,
     chips: [{tom, texto, icone, tracejado}],
     meta: [{rotulo, html}],                 // html JÁ escapado por quem chama
     contato: {whatsapp, celular, email},
     menuNovo: [{rotulo, icone, aba | hash | acao+args, oculto}],
     acoes: [{rotulo, icone, acao, args, tom:'perigo'|'secundario', oculto}],
     alertas: [{tom, icone, html}],          // html JÁ escapado
     kpis: [{icone, rotulo, valor | html, dica, aba, tom, oculto}],   // máx. 4
     abas: [{id, rotulo, icone, contador, oculto, desabilitado, dica,
             sempreAtualizar, render: async (el, ctx) => {...}}],
     abaAtiva, ctx,
     tipo?, id?   // opcionais: por padrão saem de ctx.tipo e ctx.clientId/processId
   })
   Devolve Promise<boolean>: false quando a rota já mudou (resposta atrasada
   de uma ficha que o usuário abandonou) — nesse caso nada é desenhado. */
async function fichaRender(cfg) {
  const c = document.getElementById("view-container");
  if (!c || !cfg) return false;
  const ctx = cfg.ctx || null;
  const tipo = cfg.tipo || (ctx && ctx.tipo) || null;
  let id = cfg.id;
  if (id === undefined) id = ctx ? (tipo === "processo" ? ctx.processId : ctx.clientId) : null;
  if (id === undefined) id = null;
  if (!fichaRotaConfere(tipo, id)) {
    console.warn("[ficha] desenho ignorado: a rota mudou enquanto a ficha carregava", tipo, id);
    return false;
  }
  fichaMarcarSujo(false);
  FICHA = fichaEstadoVazio();
  FICHA.tipo = tipo; FICHA.id = id; FICHA.ctx = ctx; FICHA.cfg = cfg;
  FICHA.abas = (cfg.abas || []).filter((a) => a && !a.oculto && fichaIdSeguro(a.id))
    .map((a) => Object.assign({}, a, { id: fichaIdSeguro(a.id) }));
  FICHA.abas.forEach((a) => { FICHA.abasEstado[a.id] = { renderizada: false, desatualizada: false }; });

  const abasHtml = FICHA.abas.map((a) => {
    const cont = a.contador === null || a.contador === undefined || a.contador === "";
    return `<button type="button" role="tab" class="ficha-aba${a.desabilitado ? " is-desabilitada" : ""}"
        id="ficha-aba-${a.id}" data-aba="${a.id}" aria-controls="ficha-painel-${a.id}" aria-selected="false" tabindex="-1"
        ${a.desabilitado ? 'aria-disabled="true"' : ""} ${a.dica ? `title="${esc(a.dica)}"` : ""}
        data-on-click="fichaAbaClique" data-on-keydown="fichaAbaTecla" data-args="${escArgs(a.id)}">
        ${fichaIconeSeguro(a.icone) ? `<i class="bi ${fichaIconeSeguro(a.icone)}" aria-hidden="true"></i>` : ""}<span>${esc(a.rotulo)}</span><span class="ficha-aba-cont"${cont ? " hidden" : ""}>${cont ? "" : esc(a.contador)}</span>
      </button>`;
  }).join("");
  const paineis = FICHA.abas.map((a) =>
    `<section class="ficha-painel" id="ficha-painel-${a.id}" data-aba="${a.id}" role="tabpanel" aria-labelledby="ficha-aba-${a.id}" tabindex="0" hidden></section>`).join("");

  c.innerHTML = `
    <div class="ficha" data-tipo="${esc(tipo || "")}">
      <div id="ficha-topo" class="ficha-topo">${fichaTopoHtml(cfg)}</div>
      ${FICHA.abas.length ? `<div class="ficha-abas" id="ficha-abas" role="tablist" aria-label="Módulos da ficha">${abasHtml}</div>` : ""}
      <div class="ficha-paineis">${paineis}</div>
      <div class="ficha-sujo" id="ficha-sujo" role="status" hidden>
        <span class="ficha-sujo-texto"><i class="bi bi-exclamation-circle" aria-hidden="true"></i> Alterações não salvas</span>
        <span class="ficha-sujo-acoes">
          <button type="button" class="btn btn-sm btn-ficha" id="ficha-sujo-descartar" data-on-click="fichaSujoDescartar">Descartar</button>
          <button type="button" class="btn btn-sm btn-primary" id="ficha-sujo-salvar" data-on-click="fichaSujoSalvar" hidden><i class="bi bi-check-lg"></i> Salvar</button>
        </span>
      </div>
    </div>`;
  fichaTituloDocumento(cfg.tituloDocumento || cfg.titulo);
  fichaBarraAtualizar();     // barra nova (escondida): o <body> deixa de reservar espaço para a velha
  fichaFadesIniciar();

  const q = (fichaRota && fichaRota.query) || {};
  const pode = (x) => FICHA.abas.find((a) => a.id === x && !a.desabilitado);
  // abaAtiva da ficha > ?aba= da URL (F5 reabre na mesma aba mesmo que a
  // ficha esqueça de repassar o opts.aba) > primeira aba habilitada.
  const inicial = pode(cfg.abaAtiva) || pode(q.aba) || FICHA.abas.find((a) => !a.desabilitado);
  if (!inicial) return true;
  await fichaIrAba(inicial.id, { hash: false, novo: q.novo === "1" });
  // Limpa da URL o que não vale mais: `novo=1` é de uso único (senão o F5
  // reabriria o formulário) e `aba` inválida/oculta não deve sobreviver.
  if (q.novo || (q.aba && q.aba !== inicial.id)) fichaHashAba(inicial.id);
  return true;
}

/** A ficha que terminou de carregar ainda é a da URL? (o usuário pode ter
 *  clicado em outra coisa durante o await — desenhar agora sobrescreveria a
 *  tela nova com a ficha velha). */
function fichaRotaConfere(tipo, id) {
  if (!fichaRota) return true;
  const p = fichaRota.padrao;
  const mesmoId = (pad) => p === pad && String(fichaRota.params.id) === String(id);
  if (tipo === "cliente") return id === null ? p === "clientes/novo" : mesmoId("clientes/:id");
  if (tipo === "processo") return id === null ? p === "processos/novo" : mesmoId("processos/:id");
  return true;
}

function fichaAbaCfg(id) { return FICHA.abas.find((a) => a.id === id) || null; }

/** Cabeçalho + alertas + KPIs (tudo o que fichaAtualizarCabecalho redesenha). */
function fichaTopoHtml(cfg) {
  const trilha = (cfg.trilha || []).map((t) => {
    const h = fichaHashSeguro(t.hash);
    return (h ? `<a href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}">${esc(t.rotulo)}</a>` : `<span>${esc(t.rotulo)}</span>`) +
      '<i class="bi bi-chevron-right" aria-hidden="true"></i>';
  }).join("");

  const chips = (cfg.chips || []).filter(Boolean)
    .map((ch) => uiChip(ch.tom, ch.texto, ch.icone, { tracejado: ch.tracejado, titulo: ch.titulo })).join("");

  const meta = (cfg.meta || []).filter((m) => m && m.html !== undefined && m.html !== null && m.html !== "")
    .map((m) => `<span class="ficha-meta-item">${m.rotulo ? `<span class="ficha-meta-rotulo">${esc(m.rotulo)}:</span> ` : ""}${m.html}</span>`)
    .join('<span class="ficha-meta-sep" aria-hidden="true">·</span>');

  const contato = cfg.contato ? uiContatoRapido(cfg.contato) : "";

  // Item de "Novo" que aponta para aba oculta/desabilitada some junto: a aba
  // já está escondida pela permissão do módulo, o atalho não pode furar isso.
  const itensNovo = (cfg.menuNovo || []).filter((it) => {
    if (!it || it.oculto) return false;
    if (it.aba) { const a = fichaAbaCfg(fichaIdSeguro(it.aba)); return !!(a && !a.desabilitado); }
    return !!(fichaHashSeguro(it.hash) || fichaAcaoSegura(it.acao));
  }).map((it) => {
    const ic = fichaIconeSeguro(it.icone);
    const icone = ic ? `<i class="bi ${ic}" aria-hidden="true"></i>` : "";
    if (it.aba) return `<li><button type="button" class="dropdown-item" data-on-click="fichaIrAbaNovo" data-args="${escArgs(fichaIdSeguro(it.aba))}">${icone}${esc(it.rotulo)}</button></li>`;
    if (fichaHashSeguro(it.hash)) return `<li><a class="dropdown-item" href="${fichaHashSeguro(it.hash)}" data-on-click="fichaIr" data-args="${escArgs(fichaHashSeguro(it.hash))}">${icone}${esc(it.rotulo)}</a></li>`;
    return `<li><button type="button" class="dropdown-item" data-on-click="${fichaAcaoSegura(it.acao)}" data-args="${escArgs(...fichaArgs(it.args))}">${icone}${esc(it.rotulo)}</button></li>`;
  }).join("");
  const novo = itensNovo ? `
    <div class="dropdown">
      <button type="button" class="btn btn-sm btn-primary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-plus-lg"></i> Novo</button>
      <ul class="dropdown-menu dropdown-menu-end ficha-menu-novo">${itensNovo}</ul>
    </div>` : "";

  const acoes = (cfg.acoes || []).filter((a) => a && !a.oculto && fichaAcaoSegura(a.acao)).map((a) => {
    const ic = fichaIconeSeguro(a.icone);
    return `<button type="button" class="btn btn-sm ${a.tom === "perigo" ? "btn-ficha-perigo" : "btn-ficha"}" data-on-click="${fichaAcaoSegura(a.acao)}" data-args="${escArgs(...fichaArgs(a.args))}">${ic ? `<i class="bi ${ic}" aria-hidden="true"></i> ` : ""}${esc(a.rotulo)}</button>`;
  }).join("");

  const alertas = (cfg.alertas || []).filter(Boolean).map((al) => {
    const tom = fichaTomSeguro(al.tom);
    const ic = fichaIconeSeguro(al.icone) || "bi-info-circle";
    return `<div class="ficha-alerta ficha-alerta-${tom}" role="${tom === "danger" ? "alert" : "status"}"><i class="bi ${ic}" aria-hidden="true"></i><div>${al.html || ""}</div></div>`;
  }).join("");

  let ks = (cfg.kpis || []).filter((k) => k && !k.oculto);
  if (ks.length > 4) { console.warn("[ficha] mais de 4 KPIs — só os 4 primeiros aparecem"); ks = ks.slice(0, 4); }

  return `
    <nav class="ficha-trilha" aria-label="Você está em">${trilha}<span class="ficha-trilha-atual" aria-current="page">${esc(cfg.titulo || "")}</span></nav>
    <header class="ficha-cab">
      <div class="ficha-cab-info">
        <div class="ficha-titulo-linha">
          <h1 class="ficha-titulo${cfg.tituloMono ? " ficha-mono" : ""}">${esc(cfg.titulo || "")}</h1>
          ${cfg.copiar ? uiCopiar(cfg.copiar, { rotulo: cfg.titulo }) : ""}
        </div>
        ${cfg.subtitulo ? `<div class="ficha-subtitulo">${esc(cfg.subtitulo)}</div>` : ""}
        ${chips ? `<div class="ficha-chips">${chips}</div>` : ""}
        ${meta ? `<div class="ficha-meta">${meta}</div>` : ""}
      </div>
      ${contato || novo || acoes ? `<div class="ficha-cab-acoes">${contato}${novo}${acoes}</div>` : ""}
    </header>
    ${alertas ? `<div class="ficha-alertas">${alertas}</div>` : ""}
    ${ks.length ? `<div class="ficha-kpis">${ks.map(uiKpi).join("")}</div>` : ""}`;
}

/** Redesenha o cabeçalho, alertas e KPIs com os campos de `parcial`
 *  (ex.: depois que um módulo gravou e chamou ctx.aoMudar). Não toca nas
 *  abas — a edição em andamento nelas fica intacta. */
function fichaAtualizarCabecalho(parcial) {
  if (!FICHA.cfg) return;
  Object.assign(FICHA.cfg, parcial || {});
  const topo = document.getElementById("ficha-topo");
  if (topo) topo.innerHTML = fichaTopoHtml(FICHA.cfg);
  fichaFadesIniciar();
  if (parcial && ("tituloDocumento" in parcial || "titulo" in parcial)) {
    fichaTituloDocumento(FICHA.cfg.tituloDocumento || FICHA.cfg.titulo);
  }
}

/** Título da ABA do navegador: "<texto> · <marca>" na ficha (o histórico e
 *  a lista de abas passam a dizer QUAL ficha é); sem texto, volta ao padrão
 *  do index.html. Toda troca de tela (fichaPrepararTela) e o logout voltam
 *  ao padrão — o nome de um cliente não pode ficar na aba depois de sair. */
const FICHA_TITULO_PADRAO = document.title;
// Nome curto da marca, que o backend grava no <meta name="application-name">.
const FICHA_MARCA_CURTA =
  (document.querySelector('meta[name="application-name"]') || {}).content || FICHA_TITULO_PADRAO;
function fichaTituloDocumento(texto) {
  const t = texto === null || texto === undefined ? "" : String(texto).trim();
  document.title = t ? `${t} · ${FICHA_MARCA_CURTA}` : FICHA_TITULO_PADRAO;
}

/** Troca de aba. Renderiza na 1ª vez; `sempreAtualizar` (e aba marcada como
 *  desatualizada) re-renderiza a cada ativação — EXCETO a aba com edição não
 *  salva, que seria apagada. opts: {novo:true} chama FICHA.novo[id]() depois
 *  de desenhar (abre e foca o formulário); {hash:false} não mexe na URL;
 *  {rolar:true} traz a barra de abas para a tela. */
async function fichaIrAba(id, opts = {}) {
  const aid = fichaIdSeguro(id);
  const aba = fichaAbaCfg(aid);
  if (!aba) return false;
  if (aba.desabilitado) { toast(aba.dica || "Este módulo ainda não está disponível.", true); return false; }
  FICHA.aba = aid;
  document.querySelectorAll(".ficha-aba").forEach((b) => {
    const on = b.dataset.aba === aid;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
    if (on) fichaMostrarAbaNaBarra(b);
  });
  document.querySelectorAll(".ficha-painel").forEach((p) => { p.hidden = p.dataset.aba !== aid; });
  fichaBarraAtualizar();      // barra "sempre visível" é da aba que a pediu
  if (opts.hash !== false) fichaHashAba(aid);
  if (opts.rolar) {
    const barra = document.getElementById("ficha-abas");
    if (barra) barra.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const est = FICHA.abasEstado[aid];
  const protegida = fichaSujo && FICHA.sujoAba === aid;
  if (!est.renderizada || ((aba.sempreAtualizar || est.desatualizada) && !protegida)) {
    await fichaRenderAba(aid);
  }
  if (opts.novo) {
    const fn = FICHA.novo[aid];
    if (typeof fn === "function") {
      try { await fn(); } catch (e) { toast(e.message, true); }
    }
  }
  return true;
}

/** Faixas com rolagem horizontal (abas; KPIs no celular) escondem a barra de
 *  rolagem — então um esmaecimento na borda avisa que há mais para o lado.
 *  Classes `ficha-rola-esq`/`ficha-rola-dir` conforme a posição. */
function fichaFadeRolagem(el) {
  if (!el) return;
  if (!el.dataset.fichaFade) {
    el.dataset.fichaFade = "1";
    el.addEventListener("scroll", () => fichaFadeAtualizar(el), { passive: true });
  }
  fichaFadeAtualizar(el);
}
function fichaFadeAtualizar(el) {
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle("ficha-rola-esq", max > 2 && el.scrollLeft > 2);
  el.classList.toggle("ficha-rola-dir", max > 2 && el.scrollLeft < max - 2);
}
function fichaFadesIniciar() {
  document.querySelectorAll("#view-container .ficha-abas, #view-container .ficha-kpis").forEach(fichaFadeRolagem);
}
window.addEventListener("resize", fichaDebounce(() => {
  document.querySelectorAll("[data-ficha-fade]").forEach(fichaFadeAtualizar);
}, 150));

/** Rola SÓ a barra de abas (na horizontal) para a aba ativa aparecer.
 *  scrollIntoView aqui rolaria a página inteira na vertical. */
function fichaMostrarAbaNaBarra(btn) {
  const barra = btn.parentElement;
  if (!barra || barra.scrollWidth <= barra.clientWidth) return;
  const esq = btn.offsetLeft - barra.offsetLeft;
  if (esq < barra.scrollLeft || esq + btn.offsetWidth > barra.scrollLeft + barra.clientWidth) {
    barra.scrollLeft = Math.max(0, esq - 24);
  }
}

/** Desenha a aba num contêiner NOVO a cada vez: se um render antigo ainda
 *  estiver esperando a API e terminar depois, ele escreve num nó que já
 *  saiu da tela — em vez de sobrescrever o render mais novo. */
async function fichaRenderAba(id) {
  const aba = fichaAbaCfg(id);
  const painel = document.getElementById("ficha-painel-" + id);
  if (!aba || !painel) return;
  const est = FICHA.abasEstado[id];
  est.renderizada = true; est.desatualizada = false;
  const alvo = document.createElement("div");
  alvo.className = "ficha-painel-corpo";
  alvo.innerHTML = uiCarregando();
  painel.replaceChildren(alvo);
  if (typeof aba.render !== "function") { alvo.innerHTML = ""; return; }
  try {
    await aba.render(alvo, FICHA.ctx);
  } catch (e) {
    fichaLogErro("na aba " + id, e);
    if (alvo.isConnected) {
      alvo.innerHTML = uiVazio({
        icone: "bi-exclamation-triangle",
        titulo: "Não foi possível carregar este módulo",
        texto: e && e.message ? e.message : "Tente novamente em instantes.",
        acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fichaAtualizarAba" data-args="${escArgs(id)}"><i class="bi bi-arrow-clockwise"></i> Tentar novamente</button>`,
      });
    }
  }
  const sp = alvo.querySelector(":scope > .ficha-carregando");
  if (sp) sp.remove();
}

/** Redesenha uma aba sob demanda. Se ela não é a ativa, só marca como
 *  desatualizada: redesenha quando a pessoa voltar a ela (sem trabalho à toa). */
function fichaAtualizarAba(id) {
  const aid = fichaIdSeguro(id);
  const est = FICHA.abasEstado[aid];
  if (!est) return Promise.resolve();
  if (FICHA.aba === aid) return fichaRenderAba(aid);
  est.desatualizada = true;
  return Promise.resolve();
}

/** Número na pílula da aba. null/undefined/'' esconde a pílula. */
function fichaContador(id, n) {
  const aid = fichaIdSeguro(id);
  const a = fichaAbaCfg(aid);
  if (a) a.contador = n;
  const el = document.querySelector(`#ficha-aba-${aid} .ficha-aba-cont`);
  if (!el) return;
  const vazio = n === null || n === undefined || n === "";
  el.hidden = vazio;
  el.textContent = vazio ? "" : String(n);
}

/** Troca só o `?aba=` da URL (replaceState: trocar de aba não empilha). */
function fichaHashAba(id) {
  const r = fichaParseHash(fichaHashTela || location.hash);
  if (!r || !r.rota.abrir) return;
  const q = new URLSearchParams(r.query);
  q.set("aba", id);
  q.delete("novo");
  const novo = "#/" + r.caminho + "?" + q.toString();
  fichaHashTela = novo;
  fichaRota = fichaParseHash(novo);
  if (location.hash !== novo) history.replaceState(history.state, "", novo);
}

/* --- ações da casca --- */
function fichaAbaClique(id) { fichaIrAba(id); }
function fichaIrAbaNovo(id) { fichaIrAba(id, { novo: true, rolar: true }); }
function fichaKpiClique(id) { fichaIrAba(id, { rolar: true }); }

/** Setas ←/→, Home e End percorrem as abas (padrão ARIA de tablist). */
function fichaAbaTecla(id) {
  const ev = eventoAtual();
  if (!ev) return;
  const teclas = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!teclas.includes(ev.key)) return;
  ev.preventDefault();
  const lista = FICHA.abas.filter((a) => !a.desabilitado);
  if (!lista.length) return;
  let i = lista.findIndex((a) => a.id === fichaIdSeguro(id));
  if (ev.key === "ArrowRight") i = (i + 1) % lista.length;
  else if (ev.key === "ArrowLeft") i = (i - 1 + lista.length) % lista.length;
  else if (ev.key === "Home") i = 0;
  else i = lista.length - 1;
  const alvo = lista[i];
  const btn = document.getElementById("ficha-aba-" + alvo.id);
  if (btn) btn.focus();
  fichaIrAba(alvo.id);
}

/* =========================================================
   6. COMPONENTES (devolvem HTML; todo dado passa por esc())
   ========================================================= */

/** Selo em pílula. tom ∈ FICHA_TONS; `tracejado` para estado encerrado. */
function uiChip(tom, texto, icone, opts = {}) {
  const t = fichaTomSeguro(tom);
  const ic = fichaIconeSeguro(icone);
  return `<span class="chip chip-${t}${opts.tracejado ? " chip-tracejado" : ""}"${opts.titulo ? ` title="${esc(opts.titulo)}"` : ""}>` +
    `${ic ? `<i class="bi ${ic}" aria-hidden="true"></i>` : ""}${esc(texto)}</span>`;
}

/** Selos de status prontos (as cores são as da SPEC §4.3/§4.4). */
function uiStatusCliente(s) {
  const m = {
    lead: ["info", "bi-person-plus"], negociacao: ["warning", "bi-chat-dots"],
    ativo: ["success", "bi-check-circle"], arquivado: ["neutral", "bi-archive"],
  }[s] || ["neutral", ""];
  return uiChip(m[0], CLIENT_STATUS[s] || s || "—", m[1], { tracejado: s === "arquivado" });
}
function uiStatusProcesso(s) {
  const m = {
    ativo: ["success", "bi-play-circle"], suspenso: ["warning", "bi-pause-circle"],
    encerrado: ["neutral", "bi-stop-circle"],
  }[s] || ["neutral", ""];
  return uiChip(m[0], fichaRotulo("processoStatus", s) || "—", m[1], { tracejado: s === "encerrado" });
}
function uiUrgencia(u) {
  const tom = { alta: "danger", media: "warning", baixa: "neutral" }[u] || "neutral";
  return uiChip(tom, URGENCY[u] || u || "—", "bi-flag");
}

/** Lista rótulo/valor. items: [{rotulo, valor | html, largo}] — valor é texto
 *  (escapado aqui); html é HTML JÁ escapado. Vazio vira "—". */
function uiDl(items) {
  const linhas = (items || []).filter(Boolean).map((it) => {
    let v;
    if (it.html !== undefined && it.html !== null && it.html !== "") v = it.html;
    else if (it.valor !== undefined && it.valor !== null && String(it.valor).trim() !== "") v = esc(it.valor);
    else v = '<span class="ficha-traco">—</span>';
    return `<div class="ficha-dl-item${it.largo ? " ficha-dl-largo" : ""}"><dt>${esc(it.rotulo)}</dt><dd>${v}</dd></div>`;
  });
  return `<dl class="ficha-dl">${linhas.join("")}</dl>`;
}

/** Cartão com borda (sem sombra). titulo/descricao são texto; acoesHtml e
 *  corpoHtml são HTML já escapado. */
function uiCard({ titulo, descricao, acoesHtml, corpoHtml, id, classe } = {}) {
  const sid = fichaIdSeguro(id);
  const cab = titulo || descricao || acoesHtml;
  return `<section class="ficha-card${classe ? " " + fichaIdSeguro(classe) : ""}"${sid ? ` id="${sid}"` : ""}>` +
    (cab ? `<header class="ficha-card-cab"><div class="ficha-card-cab-txt">${titulo ? `<h2 class="ficha-card-titulo">${esc(titulo)}</h2>` : ""}${descricao ? `<p class="ficha-card-desc">${esc(descricao)}</p>` : ""}</div>${acoesHtml ? `<div class="ficha-card-acoes">${acoesHtml}</div>` : ""}</header>` : "") +
    `<div class="ficha-card-corpo">${corpoHtml || ""}</div></section>`;
}

/** Estado vazio que ORIENTA (diz o que fazer e oferece a ação). */
function uiVazio({ icone, titulo, texto, acaoHtml, compacto } = {}) {
  const ic = fichaIconeSeguro(icone) || "bi-inbox";
  return `<div class="ficha-vazio${compacto ? " ficha-vazio-compacto" : ""}">
    <i class="bi ${ic}" aria-hidden="true"></i>
    ${titulo ? `<div class="ficha-vazio-titulo">${esc(titulo)}</div>` : ""}
    ${texto ? `<p class="ficha-vazio-texto">${esc(texto)}</p>` : ""}
    ${acaoHtml ? `<div class="ficha-vazio-acao">${acaoHtml}</div>` : ""}
  </div>`;
}

/** Indicador. valor = texto; html = HTML já escapado (ex.: uiPrazoBadge).
 *  Com `aba`, vira botão que abre essa aba. */
function uiKpi(k) {
  if (!k || k.oculto) return "";
  const ic = fichaIconeSeguro(k.icone);
  const tom = k.tom ? fichaTomSeguro(k.tom) : "";
  let valor;
  if (k.html !== undefined && k.html !== null && k.html !== "") valor = k.html;
  else if (k.valor !== undefined && k.valor !== null && k.valor !== "") valor = esc(k.valor);
  else valor = '<span class="ficha-traco">—</span>';
  const aba = fichaIdSeguro(k.aba);
  const corpo = `<span class="ficha-kpi-rotulo">${ic ? `<i class="bi ${ic}${tom ? " ficha-tom-" + tom : ""}" aria-hidden="true"></i>` : ""}${esc(k.rotulo)}</span>
    <span class="ficha-kpi-valor">${valor}</span>
    ${k.dica ? `<span class="ficha-kpi-dica">${esc(k.dica)}</span>` : ""}`;
  return aba
    ? `<button type="button" class="ficha-kpi ficha-kpi-link" data-on-click="fichaKpiClique" data-args="${escArgs(aba)}">${corpo}</button>`
    : `<div class="ficha-kpi">${corpo}</div>`;
}

/** Linha do tempo. eventos: [{tipo, data, titulo, detalhe | detalheHtml,
 *  autor, hash | acao+args}] — tipo ∈ FICHA_ROTULOS.evento (outro = neutro).
 *  Ordena do mais recente para o mais antigo (opts.ordenar:false desliga).
 *  opts: {agruparPorMes, vazioTitulo, vazioTexto}. */
function uiTimeline(eventos, opts = {}) {
  let lista = (eventos || []).filter(Boolean);
  if (opts.ordenar !== false) {
    lista = lista.slice().sort((a, b) => fichaChaveData(b.data).localeCompare(fichaChaveData(a.data)));
  }
  if (!lista.length) {
    return uiVazio({ icone: "bi-clock-history", titulo: opts.vazioTitulo || "Nada registrado ainda", texto: opts.vazioTexto || "", compacto: true });
  }
  const partes = [];
  let mes = null;
  let aberto = false;
  for (const ev of lista) {
    if (opts.agruparPorMes) {
      const m = fichaMesAno(ev.data);
      if (m !== mes) {
        if (aberto) partes.push("</ol>");
        partes.push(`<h3 class="ficha-tl-mes">${esc(m || "Sem data")}</h3><ol class="ficha-tl">`);
        mes = m; aberto = true;
      }
    } else if (!aberto) { partes.push('<ol class="ficha-tl">'); aberto = true; }
    partes.push(uiTimelineItem(ev));
  }
  if (aberto) partes.push("</ol>");
  return `<div class="ficha-tl-wrap">${partes.join("")}</div>`;
}

function uiTimelineItem(ev) {
  const tipo = Object.prototype.hasOwnProperty.call(FICHA_ROTULOS.evento, ev.tipo) ? ev.tipo : "outro";
  const ic = FICHA_ICONES.evento[tipo] || "bi-dot";
  const rotuloTipo = tipo === "outro" ? (ev.tipo ? String(ev.tipo) : "Registro") : FICHA_ROTULOS.evento[tipo];
  const quando = ev.data ? fmtDataHora(ev.data) : "";
  const h = fichaHashSeguro(ev.hash);
  const acao = fichaAcaoSegura(ev.acao);
  let titulo = esc(ev.titulo || rotuloTipo);
  if (h) titulo = `<a class="ficha-tl-link" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}">${titulo}</a>`;
  else if (acao) titulo = `<button type="button" class="ficha-tl-link" data-on-click="${acao}" data-args="${escArgs(...fichaArgs(ev.args))}">${titulo}</button>`;
  const detalhe = ev.detalheHtml ? `<div class="ficha-tl-detalhe">${ev.detalheHtml}</div>`
    : (ev.detalhe ? `<div class="ficha-tl-detalhe">${esc(ev.detalhe)}</div>` : "");
  return `<li class="ficha-tl-item tl-tipo-${tipo}">
    <span class="ficha-tl-ponto" aria-hidden="true"></span>
    <div class="ficha-tl-meta"><i class="bi ${ic}" aria-hidden="true"></i><span>${esc(rotuloTipo)}</span>${quando ? `<span aria-hidden="true">·</span><time${ev.data ? ` datetime="${esc(ev.data)}"` : ""}>${esc(quando)}</time>` : ""}${ev.autor ? `<span aria-hidden="true">·</span><span>${esc(ev.autor)}</span>` : ""}</div>
    <div class="ficha-tl-titulo">${titulo}</div>
    ${detalhe}
  </li>`;
}

/** Selo de prazo pela data LOCAL (nunca pelo days_left do servidor, que é
 *  calculado no relógio UTC e erra o dia entre 21h e meia-noite). */
function uiPrazoBadge(dataISO, cumprido) {
  if (cumprido) return uiChip("success", "Cumprido", "bi-check2-circle");
  const d = fichaSoData(dataISO);
  if (!d) return uiChip("neutral", "Sem data", "bi-calendar3");
  const n = fichaDiasAte(d);
  const completo = fmtDate(d);
  const ddmm = d.slice(8, 10) + "/" + d.slice(5, 7);
  if (n < 0) return uiChip("danger", n === -1 ? "Vencido há 1 dia" : `Vencido há ${-n} dias`, "bi-exclamation-octagon", { titulo: "Venceu em " + completo });
  if (n === 0) return uiChip("warning", "Vence hoje", "bi-exclamation-triangle", { titulo: completo });
  if (n === 1) return uiChip("warning", "Vence amanhã", "bi-clock", { titulo: completo });
  if (n <= 7) return uiChip("info", `Em ${n} dias · ${ddmm}`, "bi-clock", { titulo: completo });
  return uiChip("neutral", completo, "bi-calendar3");
}

/** Atalhos de contato. WhatsApp: whatsapp, senão celular. Ligar: celular,
 *  senão whatsapp. Número que não forma telefone válido não vira botão
 *  (link quebrado é pior que nenhum). `data-on-click="acNada"` impede que o
 *  toque suba para uma linha clicável — sem data-prevent, o link abre. */
function uiContatoRapido({ whatsapp, celular, email } = {}) {
  const w = fmtWhats(whatsapp) || fmtWhats(celular);
  const t = fmtWhats(celular) || fmtWhats(whatsapp);
  const em = fichaEmailValido(email) ? String(email).trim() : "";
  const b = [];
  if (w) b.push(`<a class="btn btn-sm btn-ficha" href="https://wa.me/${w}" target="_blank" rel="noopener noreferrer" data-on-click="acNada" title="Abrir conversa no WhatsApp" aria-label="WhatsApp"><i class="bi bi-whatsapp" aria-hidden="true"></i><span class="ui-contato-txt"> WhatsApp</span></a>`);
  if (t) b.push(`<a class="btn btn-sm btn-ficha" href="tel:+${t}" data-on-click="acNada" title="Ligar para ${esc(fmtTel(t))}" aria-label="Ligar"><i class="bi bi-telephone" aria-hidden="true"></i><span class="ui-contato-txt"> Ligar</span></a>`);
  if (em) b.push(`<a class="btn btn-sm btn-ficha" href="mailto:${esc(em)}" data-on-click="acNada" title="Escrever para ${esc(em)}" aria-label="E-mail"><i class="bi bi-envelope" aria-hidden="true"></i><span class="ui-contato-txt"> E-mail</span></a>`);
  return b.length ? `<span class="ui-contato">${b.join("")}</span>` : "";
}

/** E-mail que pode virar `mailto:`. Lista FECHADA de caracteres: a regex
 *  anterior aceitava `?` e `&`, e um e-mail gravado como
 *  "a@b.com?bcc=outro@x.com" abria o programa de e-mail com uma cópia oculta
 *  para terceiros. Fora deste formato, o botão de e-mail simplesmente não
 *  aparece. Use também nas listas (um lugar só para a regra). */
function fichaEmailValido(s) {
  if (typeof s !== "string") return false;
  return /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s.trim());
}

/** Iniciais num círculo; a cor sai do nome (sempre a mesma para a mesma pessoa). */
function uiAvatar(nome, opts = {}) {
  const n = String(nome || "").trim();
  // Iniciais só de letras/dígitos: "[ESPÓLIO] Ana" vira "EA", e não "[A".
  const pal = n.split(/\s+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((p) => p && !/^(d[aeo]s?|e)$/i.test(p));
  const ini = ((pal[0] || "?").charAt(0) + (pal.length > 1 ? pal[pal.length - 1].charAt(0) : "")).toUpperCase();
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const cor = (h % 6) + 1;
  return `<span class="ui-avatar ui-avatar-${cor}${opts.grande ? " ui-avatar-g" : ""}" title="${esc(n)}" aria-hidden="true">${esc(ini)}</span>`;
}

/** Seção de formulário (fieldset em cartão + legenda). */
function uiSecao(titulo, html, opts = {}) {
  const sid = fichaIdSeguro(opts.id);
  return `<fieldset class="ficha-secao${opts.classe ? " " + fichaIdSeguro(opts.classe) : ""}"${sid ? ` id="${sid}"` : ""}>` +
    `<legend>${esc(titulo)}</legend>${opts.descricao ? `<p class="ficha-secao-desc">${esc(opts.descricao)}</p>` : ""}${html || ""}</fieldset>`;
}

/** Botão "copiar" (ícone). O texto vai no data-args e é copiado ao clicar. */
function uiCopiar(texto, opts = {}) {
  return `<button type="button" class="ui-copiar" data-on-click="fichaCopiarAcao" data-args="${escArgs(String(texto === null || texto === undefined ? "" : texto))}" title="Copiar" aria-label="Copiar ${esc(opts.rotulo || "")}"><i class="bi bi-copy" aria-hidden="true"></i></button>`;
}

function uiCarregando(texto) {
  return `<div class="ficha-carregando" role="status"><div class="spinner-border spinner-border-sm text-primary" aria-hidden="true"></div><span>${esc(texto || "Carregando…")}</span></div>`;
}

/** AÇÃO do uiCopiar. */
async function fichaCopiarAcao(texto) {
  const btn = this instanceof Element ? this : null;
  const t = String(texto === null || texto === undefined ? "" : texto);
  let ok = false;
  try { await navigator.clipboard.writeText(t); ok = true; }
  catch (e) {
    // Fallback para contexto sem a API de área de transferência.
    const ta = document.createElement("textarea");
    ta.value = t; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove();
  }
  if (!ok) { toast("Não foi possível copiar. Selecione o texto e use Ctrl+C.", true); return; }
  toast("Copiado.");
  const i = btn && btn.querySelector("i");
  if (i) {
    btn.classList.add("copiado"); i.className = "bi bi-check2";
    setTimeout(() => { btn.classList.remove("copiado"); i.className = "bi bi-copy"; }, 1500);
  }
}

/** Confirmação própria — Promise<'ok' | 'alt' | false>.
 *  confirmar({titulo, texto, botao, perigo, alternativa, cancelar, html})
 *  `alternativa`: rótulo (ou {rotulo}) de um 3º botão, que resolve 'alt' —
 *  ex.: Excluir cliente, com "Arquivar" como saída menos destrutiva.
 *
 *  É um <dialog> NATIVO fora do #modal-container, e não um modal Bootstrap:
 *  (1) não derruba o modal que já estiver aberto (o #modal-container só tem
 *  um); (2) dois modais Bootstrap empilhados brigam pelo foco (cada focus
 *  trap devolve o foco para o seu, em laço); o <dialog> fica na camada do
 *  topo e torna o resto inerte, então a briga não acontece. */
let fichaConfirmarAtual = null;
function confirmar(opts = {}) {
  const o = typeof opts === "string" ? { texto: opts } : (opts || {});
  if (fichaConfirmarAtual) fichaConfirmarAtual.fechar(false);
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "ficha-confirmar";
    dlg.setAttribute("aria-labelledby", "ficha-confirmar-titulo");
    const alt = o.alternativa ? (typeof o.alternativa === "string" ? { rotulo: o.alternativa } : o.alternativa) : null;
    dlg.innerHTML = `
      <div class="ficha-confirmar-corpo">
        <div class="ficha-confirmar-icone${o.perigo ? " is-perigo" : ""}" aria-hidden="true"><i class="bi ${o.perigo ? "bi-exclamation-triangle" : "bi-question-circle"}"></i></div>
        <div class="ficha-confirmar-txt">
          <h2 id="ficha-confirmar-titulo">${esc(o.titulo || "Confirmar?")}</h2>
          ${o.texto ? `<p>${esc(o.texto)}</p>` : ""}${o.html || ""}
        </div>
      </div>
      <div class="ficha-confirmar-acoes">
        <button type="button" class="btn btn-ficha" data-r="nao">${esc(o.cancelar || "Cancelar")}</button>
        ${alt ? `<button type="button" class="btn btn-ficha" data-r="alt">${esc(alt.rotulo || "Alternativa")}</button>` : ""}
        <button type="button" class="btn ${o.perigo ? "btn-danger" : "btn-primary"}" data-r="ok">${esc(o.botao || "Confirmar")}</button>
      </div>`;
    let feito = false;
    const fechar = (r) => {
      if (feito) return;
      feito = true;
      if (fichaConfirmarAtual && fichaConfirmarAtual.dlg === dlg) fichaConfirmarAtual = null;
      try { dlg.close(); } catch (e) { /* já fechado */ }
      dlg.remove();
      resolve(r);
    };
    dlg.addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-r]") : null;
      if (b) { fechar(b.dataset.r === "ok" ? "ok" : (b.dataset.r === "alt" ? "alt" : false)); return; }
      if (ev.target === dlg) fechar(false);          // clique no fundo escurecido
    });
    dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); fechar(false); });   // Esc
    document.body.appendChild(dlg);
    fichaConfirmarAtual = { dlg, fechar };
    dlg.showModal();
    // Em ação perigosa o foco começa no "Cancelar": Enter por reflexo não apaga nada.
    const foco = dlg.querySelector(o.perigo ? '[data-r="nao"]' : '[data-r="ok"]');
    if (foco) foco.focus();
  });
}

/** Espera `ms` sem novas chamadas antes de executar (busca ao digitar). */
function fichaDebounce(fn, ms = 250) {
  let t = null;
  const d = function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
  d.cancelar = () => clearTimeout(t);
  return d;
}

/** Descarta resposta fora de ordem (a busca de "ana" chegando depois da de
 *  "anaclara" mostraria o resultado velho):
 *    const seq = fichaSeq();
 *    const n = seq.nova(); const r = await api(...); if (!seq.atual(n)) return; */
function fichaSeq() {
  let ultimo = 0;
  return { nova() { ultimo += 1; return ultimo; }, atual(n) { return n === ultimo; } };
}

/** Como val() do app.js, mas devolve '' quando o campo não existe — para
 *  campo condicional (só PF / só PJ) que pode não estar no DOM. */
function valOpt(id) {
  const el = document.getElementById(id);
  return el && el.value !== undefined && el.value !== null ? String(el.value).trim() : "";
}

/* =========================================================
   7. FORMATAÇÃO E DATAS
   =========================================================
   Data pura (YYYY-MM-DD) NUNCA passa por new Date(str): o JS a lê como meia-
   noite UTC, que em Brasília é 21h do dia ANTERIOR. Datas são comparadas por
   texto/Date.UTC com o "hoje" de ymd(new Date()) (app.js), que é local. */
function fichaDigitos(v) { return String(v === null || v === undefined ? "" : v).replace(/\D/g, ""); }

/** CPF/CNPJ formatado; o que não tem 11/14 dígitos volta como veio. */
function fmtDoc(v) {
  const d = fichaDigitos(v);
  if (d.length === 11) return fichaPadrao(d, "###.###.###-##");
  if (d.length === 14) return fichaPadrao(d, "##.###.###/####-##");
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Telefone formatado; aceita +55 na frente. Fora do padrão: volta como veio. */
function fmtTel(v) {
  let d = fichaDigitos(v);
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) return fichaPadrao(d, "(##) #####-####");
  if (d.length === 10) return fichaPadrao(d, "(##) ####-####");
  if (d.length === 9) return fichaPadrao(d, "#####-####");
  if (d.length === 8) return fichaPadrao(d, "####-####");
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Número CNJ (20 dígitos) → NNNNNNN-DD.AAAA.J.TR.OOOO. */
function fmtCnj(v) {
  const d = fichaDigitos(v);
  if (d.length === 20) return fichaPadrao(d, "#######-##.####.#.##.####");
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Dígitos para wa.me/tel:. 12–13 dígitos começando por 55 → como está;
 *  10–11 → prefixa 55; qualquer outro → null (e o botão não aparece).
 *  Ordem importa: "55 99999-0000" (DDD 55, RS) tem 11 dígitos e ganha o 55. */
function fmtWhats(tel) {
  const d = fichaDigitos(tel);
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return d;
  if (d.length === 10 || d.length === 11) return "55" + d;
  return null;
}

/** R$ 1.234,56 — nulo/vazio vira "—" (zero continua R$ 0,00). */
function fmtMoeda(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "2026-10-03" → {y,m,d,h:null}; "2026-10-03T14:05:00" → com hora.
 *  Data-hora SEM fuso é exibida como veio (é assim que o resto do CRM a lê);
 *  com fuso (Z/±hh:mm) é convertida para a hora local. */
function fichaParseData(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(s).trim());
  if (!m) return null;
  if (m[7] && m[4] !== undefined) {
    const dt = new Date(String(s).trim());
    if (isNaN(dt.getTime())) return null;
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes() };
  }
  return { y: +m[1], m: +m[2], d: +m[3], h: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null };
}
const fichaDois = (n) => String(n).padStart(2, "0");
/** "YYYY-MM-DD" (só a data) de uma data ou data-hora. */
function fichaSoData(s) {
  const p = fichaParseData(s);
  return p ? `${p.y}-${fichaDois(p.m)}-${fichaDois(p.d)}` : null;
}
/** dd/mm/aaaa ou dd/mm/aaaa hh:mm. */
function fmtDataHora(s) {
  const p = fichaParseData(s);
  if (!p) return s ? String(s) : "";
  const data = `${fichaDois(p.d)}/${fichaDois(p.m)}/${p.y}`;
  return p.h === null ? data : `${data} ${fichaDois(p.h)}:${fichaDois(p.mi)}`;
}
/** Carimbo de gravação do servidor (`uploaded_at`, `created_at`, data do
 *  contato) → "dd/mm/aaaa hh:mm" na hora LOCAL. O backend grava esses campos
 *  com datetime.utcnow() e devolve SEM fuso ("2026-10-04T13:05:00"); o
 *  new Date() do JS lê isso como hora local, e um documento enviado às 10h
 *  aparecia como 13h. Aqui, carimbo sem fuso é UTC. NÃO use em data de
 *  negócio (prazo, audiência, atendimento), que já vem na hora certa.
 *  `soData:true` → só "dd/mm/aaaa". Vazio → "—". */
function fmtCarimboUtc(s, soData) {
  if (!s) return "—";
  const t = String(s).trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return fmtDataHora(t) || "—";
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : t.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fmtDataHora(t) || "—";
  const data = `${fichaDois(d.getDate())}/${fichaDois(d.getMonth() + 1)}/${d.getFullYear()}`;
  return soData ? data : `${data} ${fichaDois(d.getHours())}:${fichaDois(d.getMinutes())}`;
}

/** Dias de HOJE (local) até a data (negativo = já passou). */
function fichaDiasAte(dataISO) {
  const d = fichaSoData(dataISO);
  if (!d) return null;
  const [y, m, dd] = d.split("-").map(Number);
  const [hy, hm, hd] = ymd(new Date()).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(hy, hm - 1, hd)) / 86400000);
}
function fichaChaveData(s) {
  const p = fichaParseData(s);
  if (!p) return "";
  return `${p.y}-${fichaDois(p.m)}-${fichaDois(p.d)}T${fichaDois(p.h === null ? 0 : p.h)}:${fichaDois(p.mi === null ? 0 : p.mi)}`;
}
function fichaMesAno(s) {
  const p = fichaParseData(s);
  if (!p) return "";
  const nome = FICHA_MESES[p.m - 1] || "";
  return nome.charAt(0).toUpperCase() + nome.slice(1) + " de " + p.y;
}

/* =========================================================
   8. VALIDAÇÃO (aviso, NUNCA bloqueio — SPEC §2.6)
   ========================================================= */
function fichaCpfValido(v) {
  const d = fichaDigitos(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

function fichaCnpjValido(v) {
  const d = fichaDigitos(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (n) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * pesos[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

/* Tabela do CNJ (Res. 65/2008): códigos de UF usados por TJ, TRE e TJM. */
const FICHA_CNJ_UF = {
  "01": "AC", "02": "AL", "03": "AP", "04": "AM", "05": "BA", "06": "CE", "07": "DF", "08": "ES", "09": "GO",
  "10": "MA", "11": "MT", "12": "MS", "13": "MG", "14": "PA", "15": "PB", "16": "PR", "17": "PE", "18": "PI",
  "19": "RJ", "20": "RN", "21": "RS", "22": "RO", "23": "RR", "24": "SC", "25": "SE", "26": "SP", "27": "TO",
};
const FICHA_CNJ_SEGMENTO = {
  1: "Supremo Tribunal Federal", 2: "Conselho Nacional de Justiça", 3: "Superior Tribunal de Justiça",
  4: "Justiça Federal", 5: "Justiça do Trabalho", 6: "Justiça Eleitoral", 7: "Justiça Militar da União",
  8: "Justiça Estadual", 9: "Justiça Militar Estadual",
};

/** Resto da divisão de um número decimal ENORME por 97, dígito a dígito
 *  (20 dígitos não cabem em Number sem perder precisão). */
function fichaMod97(s) {
  let r = 0;
  for (const c of s) r = (r * 10 + Number(c)) % 97;
  return r;
}

/** Decodifica e valida um número CNJ.
 *  → {digitos, completo, valido, segmento, tribunal} — tribunal é a sigla
 *  (TRF5, TJAL, TRT19…) ou "" quando o código não está na tabela. */
function fichaCnjInfo(v) {
  const d = fichaDigitos(v);
  const info = { digitos: d, completo: d.length === 20, valido: false, segmento: "", tribunal: "" };
  if (!info.completo) return info;
  const n = d.slice(0, 7), dv = d.slice(7, 9), a = d.slice(9, 13), j = d.slice(13, 14), tr = d.slice(14, 16), o = d.slice(16, 20);
  info.valido = fichaMod97(n + a + j + tr + o + dv) === 1;   // ISO 7064 MOD 97-10
  info.segmento = FICHA_CNJ_SEGMENTO[Number(j)] || "";
  const uf = FICHA_CNJ_UF[tr];
  const num = Number(tr);
  switch (Number(j)) {
    case 1: info.tribunal = "STF"; break;
    case 2: info.tribunal = "CNJ"; break;
    case 3: info.tribunal = "STJ"; break;
    case 4: info.tribunal = tr === "90" ? "CJF" : (num >= 1 && num <= 6 ? "TRF" + num : ""); break;
    case 5: info.tribunal = tr === "00" ? "TST" : (tr === "90" ? "CSJT" : (num >= 1 && num <= 24 ? "TRT" + num : "")); break;
    case 6: info.tribunal = tr === "00" ? "TSE" : (uf ? "TRE-" + uf : ""); break;
    case 7: info.tribunal = tr === "00" ? "STM" : (num >= 1 && num <= 12 ? num + "ª CJM" : ""); break;
    case 8: info.tribunal = tr === "07" ? "TJDFT" : (uf ? "TJ" + uf : ""); break;
    case 9: info.tribunal = { "13": "TJMMG", "21": "TJMRS", "26": "TJMSP" }[tr] || ""; break;
    default: break;
  }
  return info;
}

/* =========================================================
   9. MÁSCARAS (data-on-input) E CONSULTA DE CNPJ
   =========================================================
   Uso no formulário:
     <input id="${pfx}doc"  data-on-input="fichaMascaraDoc" inputmode="numeric">
     <input id="${pfx}celular" data-on-input="fichaMascaraTel" inputmode="tel">
     <input id="${pfx}cep"  data-on-input="fichaMascaraCep" inputmode="numeric">
     <input id="${pfx}case" data-on-input="fichaMascaraCnj" inputmode="numeric">
   O prefixo do formulário sai do próprio id (tudo antes de doc|cep|case) ou
   de `data-pfx`. O aviso aparece num elemento `#<id do campo>-aviso` (criado
   logo abaixo do campo se não existir). Valores já gravados: chame
   fichaMascarasIniciar(raiz) depois de desenhar o formulário. */

/** Preenche um padrão com dígitos ("#" = dígito) parando no último dígito —
 *  sem pontuação pendurada no fim (senão o Backspace "não apaga"). */
function fichaPadrao(d, padrao) {
  let out = "";
  let i = 0;
  for (const ch of padrao) {
    if (i >= d.length) break;
    if (ch === "#") out += d[i++]; else out += ch;
  }
  return out;
}

/** Núcleo comum das máscaras: aplica `formatar(digitos)`, mantém o cursor
 *  depois do mesmo número de dígitos e trata o Backspace sobre pontuação
 *  (apagar o "-" apagaria nada; aqui apaga o dígito anterior). Devolve os
 *  dígitos finais. */
function fichaMascaraProcessar(el, formatar, maxDig, normalizar) {
  const ev = eventoAtual();
  const valor = el.value || "";
  const pos = el.selectionStart === null || el.selectionStart === undefined ? valor.length : el.selectionStart;
  let digAntes = valor.slice(0, pos).replace(/\D/g, "").length;
  let d = valor.replace(/\D/g, "");
  const anterior = el.dataset.fichaDig;
  if (ev && ev.inputType === "deleteContentBackward" && anterior !== undefined && anterior === d && digAntes > 0) {
    d = d.slice(0, digAntes - 1) + d.slice(digAntes);
    digAntes -= 1;
  }
  if (typeof normalizar === "function") {
    const n = normalizar(d);
    digAntes = Math.max(0, Math.min(digAntes - (d.length - n.length), n.length));
    d = n;
  }
  d = d.slice(0, maxDig);
  digAntes = Math.min(digAntes, d.length);
  const novo = formatar(d);
  el.dataset.fichaDig = d;
  if (novo !== valor) {
    el.value = novo;
    if (document.activeElement === el) {
      let p = 0;
      let cont = 0;
      while (p < novo.length && cont < digAntes) { if (/\d/.test(novo[p])) cont++; p++; }
      try { el.setSelectionRange(p, p); } catch (e) { /* campo sem seleção */ }
    }
  }
  return d;
}

/** Prefixo do formulário a partir do id do campo (cf-doc → "cf-"). */
function fichaPrefixo(el, sufixos) {
  if (el.dataset.pfx !== undefined) return el.dataset.pfx;
  return (el.id || "").replace(new RegExp("(" + sufixos + ")$"), "");
}

/** Mostra/limpa o aviso de um campo. aviso = {tom:'ok'|'alerta'|'info', texto} | null. */
const fichaAvisosSemId = new WeakMap();
/*  Aviso com a classe `ficha-aviso-fixo` (já no HTML do formulário) nunca
    some: fica vazio, com a altura reservada — o "CNPJ válido" aparecendo
    empurrava o botão "Buscar na Receita" para baixo no meio do clique. */
function fichaMascaraAviso(el, aviso) {
  let alvo = el.id ? document.getElementById(el.id + "-aviso") : fichaAvisosSemId.get(el);
  const fixo = !!(alvo && alvo.classList.contains("ficha-aviso-fixo"));
  if (!aviso) {
    if (alvo) { alvo.textContent = ""; if (fixo) alvo.className = "form-text ficha-aviso ficha-aviso-fixo"; else alvo.hidden = true; }
    return;
  }
  if (!alvo) {
    alvo = document.createElement("div");
    if (el.id) alvo.id = el.id + "-aviso"; else fichaAvisosSemId.set(el, alvo);
    alvo.setAttribute("aria-live", "polite");
    (el.closest(".input-group") || el).insertAdjacentElement("afterend", alvo);
  }
  const ic = { ok: "bi-check-circle", alerta: "bi-exclamation-triangle", info: "bi-info-circle" }[aviso.tom] || "bi-info-circle";
  alvo.className = "form-text ficha-aviso ficha-aviso-" + ({ ok: "ok", alerta: "alerta" }[aviso.tom] || "info") + (fixo ? " ficha-aviso-fixo" : "");
  alvo.hidden = false;
  alvo.innerHTML = `<i class="bi ${ic}" aria-hidden="true"></i><span>${esc(aviso.texto)}</span>`;
}

function fichaMascaraDoc() { fichaMascaraDocExec(this, false); }
/** CPF/CNPJ. Com 14 dígitos marca Pessoa jurídica (colar um CNPJ com a
 *  ficha em PF troca sozinho). Ao completar 11/14 dígitos dispara o evento
 *  `ficha-documento` (bubbles) com detail {digitos, tipo:'PF'|'PJ', valido} —
 *  é o gancho da checagem de duplicidade (aoMudarDocumento). */
function fichaMascaraDocExec(el, inicial) {
  const d = fichaMascaraProcessar(el, (x) => (x.length > 11 ? fichaPadrao(x, "##.###.###/####-##") : fichaPadrao(x, "###.###.###-##")), 14);
  let aviso = null;
  if (d.length === 11) aviso = fichaCpfValido(d) ? { tom: "ok", texto: "CPF válido" } : { tom: "alerta", texto: "CPF inválido — confira os números" };
  else if (d.length === 14) aviso = fichaCnpjValido(d) ? { tom: "ok", texto: "CNPJ válido" } : { tom: "alerta", texto: "CNPJ inválido — confira os números" };
  else if (d.length && inicial) aviso = { tom: "alerta", texto: "CPF tem 11 dígitos e CNPJ tem 14" };
  fichaMascaraAviso(el, aviso);
  if (inicial) { el.dataset.fichaDocAnunciado = d; return; }
  if (d.length === 14) fichaMarcarPJ(el);
  if ((d.length === 11 || d.length === 14) && el.dataset.fichaDocAnunciado !== d) {
    el.dataset.fichaDocAnunciado = d;
    el.dispatchEvent(new CustomEvent("ficha-documento", {
      bubbles: true,
      detail: { digitos: d, tipo: d.length === 14 ? "PJ" : "PF", valido: d.length === 14 ? fichaCnpjValido(d) : fichaCpfValido(d) },
    }));
  }
}

/** Marca PJ no seletor de tipo de pessoa do mesmo formulário: um <select
 *  id="${pfx}tipo_pessoa"> ou rádios name="${pfx}tipo_pessoa" (ou o id/name
 *  em data-tipo-pessoa). Dispara `change`, que é o que mostra/esconde as
 *  seções PF/PJ do formulário. Nunca volta de PJ para PF sozinho. */
function fichaMarcarPJ(el) {
  const alvo = el.dataset.tipoPessoa || (fichaPrefixo(el, "doc") + "tipo_pessoa");
  const sel = document.getElementById(alvo);
  if (sel && sel.tagName === "SELECT") {
    if (sel.value !== "PJ" && [...sel.options].some((o) => o.value === "PJ")) {
      sel.value = "PJ";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  const radio = [...document.querySelectorAll('input[type="radio"]')].find((r) => r.name === alvo && r.value === "PJ");
  if (radio && !radio.checked) {
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

/** Telefone. Enquanto digita, formata como (DD) …; ao sair do campo
 *  (change), número SEM DDD (8–9 dígitos) volta ao formato local
 *  ("99999-0000", e não "(99) 9990-000") e ganha o aviso — sem DDD o
 *  WhatsApp e o Ligar não aparecem (fmtWhats). Aviso, nunca bloqueio. */
function fichaMascaraTel() {
  const el = this;
  fichaMascaraProcessar(el, fichaFormatarTel, 11, fichaTirar55);
  if (!el.dataset.fichaTelConf) {
    el.dataset.fichaTelConf = "1";
    el.addEventListener("change", () => fichaTelConferir(el));
  }
  // Voltou a ter DDD: o aviso antigo sai na hora, sem esperar o blur.
  if (fichaDigitos(el.value).length >= 10) fichaMascaraAviso(el, null);
}
function fichaTirar55(d) { return d.length > 11 && d.startsWith("55") ? d.slice(2) : d; }
function fichaFormatarTel(d) { return d.length > 10 ? fichaPadrao(d, "(##) #####-####") : fichaPadrao(d, "(##) ####-####"); }
function fichaTelConferir(el) {
  const d = fichaDigitos(el.value);
  if (d.length === 8 || d.length === 9) {
    el.value = fmtTel(d);
    el.dataset.fichaDig = d;
    fichaMascaraAviso(el, { tom: "alerta", texto: "Sem DDD — inclua o DDD para os atalhos de WhatsApp e ligação funcionarem" });
  } else if (d.length && d.length < 10) {
    fichaMascaraAviso(el, { tom: "alerta", texto: "Telefone incompleto — com DDD são 10 ou 11 dígitos" });
  } else {
    fichaMascaraAviso(el, null);
  }
}

function fichaMascaraCep() { fichaMascaraCepExec(this, false); }
/** CEP. Com 8 dígitos chama _buscarCep(pfx) (app.js), que preenche o
 *  endereço sem apagar o que já foi digitado. Uma busca por CEP distinto. */
function fichaMascaraCepExec(el, inicial) {
  const d = fichaMascaraProcessar(el, (x) => fichaPadrao(x, "#####-###"), 8);
  if (inicial || d.length !== 8) { if (inicial) el.dataset.fichaCepBuscado = d; return; }
  if (el.dataset.fichaCepBuscado === d) return;
  el.dataset.fichaCepBuscado = d;
  const pfx = fichaPrefixo(el, "cep");
  if (typeof window._buscarCep === "function") {
    Promise.resolve().then(() => window._buscarCep(pfx)).catch((e) => console.warn("[ficha] busca de CEP falhou", e));
  }
}

function fichaMascaraCnj() { fichaMascaraCnjExec(this, false); }
/** Número CNJ. Completo: valida o dígito (mod 97) e decodifica
 *  ("Número válido · Justiça Federal · TRF5"); preenche o tribunal se o
 *  campo estiver vazio (id em data-tribunal, ou "${pfx}tribunal"). */
function fichaMascaraCnjExec(el, inicial) {
  const d = fichaMascaraProcessar(el, (x) => fichaPadrao(x, "#######-##.####.#.##.####"), 20);
  if (d.length !== 20) {
    fichaMascaraAviso(el, d.length && inicial ? { tom: "alerta", texto: "O número CNJ tem 20 dígitos" } : null);
    return;
  }
  const info = fichaCnjInfo(d);
  if (!info.valido) {
    fichaMascaraAviso(el, { tom: "alerta", texto: "Dígito verificador não confere — confira o número" });
    return;
  }
  fichaMascaraAviso(el, { tom: "ok", texto: ["Número válido", info.segmento, info.tribunal].filter(Boolean).join(" · ") });
  if (inicial || !info.tribunal) return;
  const pfx = fichaPrefixo(el, "case|cnj|numero");
  const trib = document.getElementById(el.dataset.tribunal || (pfx + "tribunal"));
  if (trib && !String(trib.value || "").trim()) {
    trib.value = info.tribunal;
    trib.dispatchEvent(new Event("change", { bubbles: true }));
  }
  fichaSugerirSistema(document.getElementById(pfx + "sistema"), info.tribunal);
}

/** Sistema processual de cada tribunal — SÓ os casos seguros (o resto varia
 *  por comarca/ano e uma sugestão errada é pior que nenhuma). */
function fichaSistemaDoTribunal(trib) {
  const t = String(trib || "");
  if (/^TRT\d+$/.test(t) || ["TRF1", "TRF3", "TRF5"].includes(t)) return "PJe";
  if (["TRF2", "TRF4"].includes(t)) return "e-Proc";
  if (["TJSP", "TJAL"].includes(t)) return "e-SAJ";
  return "";
}
/** Preenche o select de sistema pelo tribunal do CNJ — só se ele estiver
 *  VAZIO e a opção existir na lista (PROC_SISTEMAS). Marca "Sugerido pelo
 *  número · editável"; a marca some quando a pessoa troca o valor. */
function fichaSugerirSistema(sel, trib) {
  if (!sel || sel.tagName !== "SELECT" || String(sel.value || "").trim()) return;
  const sug = fichaSistemaDoTribunal(trib);
  const lista = typeof PROC_SISTEMAS !== "undefined" && Array.isArray(PROC_SISTEMAS) ? PROC_SISTEMAS : [];
  if (!sug || !lista.includes(sug) || ![...sel.options].some((o) => o.value === sug)) return;
  sel.value = sug;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  fichaMascaraAviso(sel, { tom: "info", texto: "Sugerido pelo número · editável" });
  sel.addEventListener("change", () => fichaMascaraAviso(sel, null), { once: true });
}

/** Aplica as máscaras aos valores JÁ gravados de um formulário recém-
 *  desenhado (formata e mostra o aviso), sem efeitos colaterais: não busca
 *  CEP, não preenche tribunal, não dispara `ficha-documento`. */
function fichaMascarasIniciar(raiz) {
  const r = raiz || document;
  r.querySelectorAll('[data-on-input^="fichaMascara"]').forEach((el) => {
    if (!el.value) return;
    const m = el.getAttribute("data-on-input");
    if (m === "fichaMascaraDoc") fichaMascaraDocExec(el, true);
    else if (m === "fichaMascaraCep") fichaMascaraCepExec(el, true);
    else if (m === "fichaMascaraCnj") fichaMascaraCnjExec(el, true);
    else if (m === "fichaMascaraTel") {
      // Valor gravado sem DDD fica no formato local, com o aviso.
      if (fichaDigitos(el.value).length >= 10) fichaMascaraProcessar(el, fichaFormatarTel, 11, fichaTirar55);
      else fichaTelConferir(el);
    }
  });
}

/** Campos que fichaBuscarCnpj preenche: sufixo do id → campo da BrasilAPI.
 *  Só preenche campo que EXISTE e está VAZIO (nunca sobrescreve o digitado).
 *  `nasc` recebe a data de abertura (o cliente PJ usa data_nascimento como
 *  "abertura" — SPEC §4.3 "nascimento ou abertura"). */
/*  O 3º item é o TAMANHO DA COLUNA no banco: a Receita devolve complemento e
    logradouro maiores que a coluna, e o Salvar recusava a ficha inteira
    (422) por um campo que a pessoa nem digitou. Corta antes de preencher.
    Telefone: celular (11 dígitos) vai para "Celular", fixo (10) para
    "Telefone secundário" — fixo no Celular fazia o botão de WhatsApp
    aparecer para um número que não tem WhatsApp. */
function fichaCnpjTelefone(j, celular) {
  const nums = [j.ddd_telefone_1, j.ddd_telefone_2].map(fichaDigitos);
  const d = nums.find((x) => x.length === (celular ? 11 : 10));
  return d ? fmtTel(d) : "";
}
const FICHA_CNPJ_CAMPOS = [
  ["name", (j) => j.razao_social, 150],
  ["fantasia", (j) => j.nome_fantasia, 150],
  ["email", (j) => (j.email || "").toLowerCase(), 120],
  ["celular", (j) => fichaCnpjTelefone(j, true), 40],
  ["tel2", (j) => fichaCnpjTelefone(j, false), 40],
  ["cep", (j) => fichaPadrao(fichaDigitos(j.cep), "#####-###"), 12],
  ["rua", (j) => [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(" "), 160],
  ["num", (j) => j.numero, 20],
  ["compl", (j) => j.complemento, 80],
  ["bairro", (j) => j.bairro, 80],
  ["cidade", (j) => j.municipio, 80],
  ["estado", (j) => j.uf, 40],
  ["nasc", (j) => /^\d{4}-\d{2}-\d{2}$/.test(j.data_inicio_atividade || "") ? j.data_inicio_atividade : "", 10],
];

/** "Buscar na Receita" (PJ): BrasilAPI, só para CNPJ — CPF NUNCA sai do
 *  navegador. Preenche apenas campos vazios e mostra razão social,
 *  situação e atividade em `#${pfx}cnpj-info`. Tudo que vem de fora entra
 *  por `.value`/esc(), nunca como HTML.
 *  Uso: <button id="${pfx}btn-cnpj" data-on-click="fichaBuscarCnpj" data-args="${escArgs(pfx)}"> */
async function fichaBuscarCnpj(pfx) {
  const p = typeof pfx === "string" ? pfx : "f-";
  const docEl = document.getElementById(p + "doc");
  const d = fichaDigitos(docEl && docEl.value);
  if (d.length !== 14) { toast("Digite um CNPJ com 14 dígitos para buscar na Receita.", true); return; }
  if (!fichaCnpjValido(d)) { toast("Este CNPJ não é válido — confira os números antes de buscar.", true); return; }
  const btn = document.getElementById(p + "btn-cnpj") || (this instanceof HTMLButtonElement ? this : null);
  const rotulo = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Buscando…'; }
  try {
    let r;
    try {
      r = await fetch("https://brasilapi.com.br/api/cnpj/v1/" + d, { credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (e) {
      throw new Error("Não foi possível falar com a Receita agora (sem conexão ou bloqueado). Tente de novo em instantes.");
    }
    if (r.status === 404) { toast("CNPJ não encontrado na Receita.", true); return; }
    if (!r.ok) throw new Error("A consulta à Receita não respondeu agora. Tente de novo em instantes.");
    const j = await r.json();
    const preenchidos = [];
    for (const [suf, pega, max] of FICHA_CNPJ_CAMPOS) {
      const el = document.getElementById(p + suf);
      if (!el || String(el.value || "").trim()) continue;
      const v = String(pega(j) || "").trim().slice(0, max || undefined).trim();
      if (!v) continue;
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === v || o.text === v)) continue;
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      preenchidos.push(suf);
    }
    const sit = String(j.descricao_situacao_cadastral || "").trim();
    // O cartão vai ABAIXO do botão (o formulário já traz `${pfx}cnpj-info`
    // ali): acima dele, o botão pulava ~150px para baixo no clique.
    let info = document.getElementById(p + "cnpj-info");
    if (!info && docEl) {
      info = document.createElement("div");
      info.id = p + "cnpj-info";
      const linhaBtn = btn && btn.parentElement;
      const ancora = linhaBtn || document.getElementById(docEl.id + "-aviso") || docEl.closest(".input-group") || docEl;
      ancora.insertAdjacentElement("afterend", info);
    }
    if (info) {
      const ativa = sit.toUpperCase() === "ATIVA";
      info.hidden = false;
      info.className = "ficha-cnpj-info" + (ativa ? "" : " is-alerta");
      info.innerHTML = uiDl([
        { rotulo: "Razão social", valor: j.razao_social, largo: true },
        { rotulo: "Situação na Receita", html: sit ? uiChip(ativa ? "success" : "warning", sit, ativa ? "bi-check-circle" : "bi-exclamation-triangle") : "" },
        { rotulo: "Abertura", valor: j.data_inicio_atividade ? fmtDate(j.data_inicio_atividade) : "" },
        { rotulo: "Atividade principal", valor: j.cnae_fiscal_descricao, largo: true },
      ]) + `<div class="ficha-cnpj-nota">${preenchidos.length ? "Campos vazios preenchidos pela Receita — tudo continua editável." : "Nenhum campo vazio para preencher: os dados atuais foram mantidos."}</div>`;
    }
    toast(preenchidos.length ? `Dados da Receita preenchidos em ${preenchidos.length} campo(s).` : "Consulta feita — nenhum campo vazio para preencher.");
    // Avisa quem estiver ouvindo (a ficha do cliente guarda o quadro de sócios
    // para oferecer "Importar sócios" sem consultar a Receita de novo).
    if (docEl) docEl.dispatchEvent(new CustomEvent("ficha-cnpj", { bubbles: true, detail: j }));
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = rotulo; }
  }
}

/* =========================================================
   10. CACHE (CACHE.clients / CACHE.processes do app.js)
   =========================================================
   Os modais só recarregam a lista quando ela está VAZIA. Um `push` direto
   num cache vazio deixava CACHE.clients = [o novo] e, até o próximo logout,
   todo select de cliente mostrava UM cliente só. Por isso: carrega primeiro,
   depois insere/atualiza. Ninguém faz CACHE.x.push direto. */
async function cacheGarantirCliente(c) {
  if (!CACHE.clients.length) {
    try { CACHE.clients = await api("/api/clients"); }
    catch (e) { return; }   // sem a lista, não insere: senão o cache vira [c] e ninguém recarrega
  }
  if (!c || c.id === undefined || c.id === null) return;
  const i = CACHE.clients.findIndex((x) => x.id === c.id);
  if (i < 0) CACHE.clients.push(c); else CACHE.clients[i] = Object.assign({}, CACHE.clients[i], c);
}
async function cacheGarantirProcesso(p) {
  if (!CACHE.processes.length) {
    try { CACHE.processes = await api("/api/processes"); }
    catch (e) { return; }
  }
  if (!p || p.id === undefined || p.id === null) return;
  const i = CACHE.processes.findIndex((x) => x.id === p.id);
  if (i < 0) CACHE.processes.push(p); else CACHE.processes[i] = Object.assign({}, CACHE.processes[i], p);
}
function cacheRemoverCliente(id) { CACHE.clients = CACHE.clients.filter((x) => x.id !== id); }
function cacheRemoverProcesso(id) { CACHE.processes = CACHE.processes.filter((x) => x.id !== id); }

/* =========================================================
   REGISTRO DE AÇÕES (allowlist do despachante — ver app.js)
   ========================================================= */
registrarAcoes({
  fichaIr, fichaVoltar, fichaAbaClique, fichaAbaTecla, fichaKpiClique, fichaIrAbaNovo,
  fichaAtualizarAba, fichaCopiarAcao, fichaSujoSalvar, fichaSujoDescartar,
  fichaMascaraDoc, fichaMascaraTel, fichaMascaraCep, fichaMascaraCnj, fichaBuscarCnpj,
});
