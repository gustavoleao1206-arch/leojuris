/* =========================================================
   ficha-modulos.js — módulos compartilhados das fichas de Cliente e de
   Processo (SPEC §5 + contrato da fase 3):

     fmAgenda(el, ctx, {abaId})                     prazos + audiências
     fmAgendaNovo(tipo)                             'prazo' | 'audiencia' (também é ação)
     fmDocumentos(el, ctx, {abaId, comContratos})   anexos (+ contratos do cliente)
     fmAtendimentos(el, ctx, {abaId})               formulário + histórico
     fmAtendimentoModal(ctx, {processId})           o mesmo formulário num modal
     fmFinanceiro(el, ctx, {abaId})                 honorários do cliente/processo
     fmLinhaDoTempo(el, ctx, {abaId, filtroPadrao, formAndamento})

   E as peças que as DUAS fichas desenham igual (seção 8): fmKpiPrazo,
   fmKpiAudiencia, fmKpiReceber, fmKpiUltimo, fmCompletarHtml, fmTopoMenuMais,
   fmPerguntarClienteAtivo, fmContador (pílula só > 0), fmMarcarRascunho
   (texto não salvo em formulário curto), e a regra do retorno de atendimento
   (fmRetornoSituacao / fmRetornosPendentes — seção 5).

   Script clássico, mesmo escopo global do app.js e do
   ficha.js: todo nome de topo leva o prefixo fm* / FM_* (SPEC §2.3) — um
   `const` repetido entre arquivos derruba o arquivo inteiro em silêncio.

   Regras que valem para os cinco módulos (contrato da fase 3):
   - Usam `ctx.dados.<chave>` quando a ficha já pré-carregou; senão buscam
     (Promise.allSettled). Fonte com 403 ESCONDE o bloco — não derruba a aba.
   - Depois de gravar/excluir: recarregam a fonte, atualizam ctx.dados,
     redesenham SÓ o próprio bloco (e os outros módulos que mostram o mesmo
     dado), acertam o contador da aba e chamam ctx.aoMudar(<chave>). Nunca a
     ficha inteira.
   - Handlers recebem só ids em data-args e leem FICHA.ctx (objeto com função
     dentro não cabe num atributo).
   - Nada de `on*=` no HTML (CSP sem 'unsafe-inline'): data-on-* + a função
     no registrarAcoes do FIM deste arquivo.
   - Todo dado em HTML passa por esc(); fallback de dicionário DENTRO do esc.
   - Data pura (AAAA-MM-DD) nunca passa por new Date(str) (vira o dia anterior
     em Brasília): fmtDate / fichaDiasAte / comparação de texto com ymd().
   ========================================================= */

/* =========================================================
   1. ESTADO E FONTES DE DADOS
   ========================================================= */

/** Estado de cada módulo desenhado, POR FICHA: WeakMap ctx → {abaId: estado}.
 *  A chave é o próprio ctx (um por ficha aberta): abrir outra ficha cria outro
 *  ctx e o estado antigo vai embora com ele — nada para zerar no logout, e o
 *  filtro escolhido na linha do tempo sobrevive à troca de aba. */
const FM_ESTADOS = new WeakMap();

/** ctx da ficha aberta (os handlers só recebem ids). */
function fmCtx() {
  return (typeof FICHA !== "undefined" && FICHA && FICHA.ctx) || null;
}
function fmEstados(ctx) {
  if (!ctx || typeof ctx !== "object") return {};
  let m = FM_ESTADOS.get(ctx);
  if (!m) { m = {}; FM_ESTADOS.set(ctx, m); }
  return m;
}
function fmEstado(ctx, abaId) { return fmEstados(ctx)[fichaIdSeguro(abaId)] || null; }

/** Começa um render. Devolve o estado com `rodada` nova: o render mais novo
 *  invalida o anterior, que ainda pode estar esperando a API (fmVivo). */
function fmIniciar(ctx, abaId, modulo, el, opts) {
  const m = fmEstados(ctx);
  const st = m[abaId] || (m[abaId] = { abaId, modulo, recolhe: {}, rascunho: {}, erros: {} });
  st.modulo = modulo; st.ctx = ctx; st.el = el; st.opts = opts || {};
  st.erros = {};
  st.rodada = (st.rodada || 0) + 1;
  ctx.dados = ctx.dados || {};
  fmVigiarRecolhidos(st);
  return st;
}

/** Lembra o aberto/fechado de cada <details data-fm-recolhe> ("Cumpridos",
 *  "Anteriores", inteiro teor) enquanto a pessoa abre e fecha — assim nem o
 *  redesenho do bloco nem o da aba inteira (sempreAtualizar) fecham o que ela
 *  abriu. `toggle` não borbulha: escuta na captura, uma vez por contêiner. */
const FM_VIGIADOS = new WeakSet();
function fmVigiarRecolhidos(st) {
  const el = st.el;
  if (!el || FM_VIGIADOS.has(el)) return;
  FM_VIGIADOS.add(el);
  el.addEventListener("toggle", (ev) => {
    const d = ev.target;
    if (d instanceof HTMLDetailsElement && d.dataset.fmRecolhe) {
      st.recolhe = st.recolhe || {};
      st.recolhe[d.dataset.fmRecolhe] = d.open;
    }
  }, true);
}
function fmVivo(st, rodada) { return !!(st && st.rodada === rodada && st.el && st.el.isConnected); }

/** Esta ficha ainda é a que está na tela? (modal salvo depois de trocar de ficha) */
function fmFichaAtual(ctx) { return !!ctx && fmCtx() === ctx; }

/** Registra o "Novo ▾" da ficha para esta aba (fichaIrAba(id, {novo:true})). */
function fmRegistrarNovo(ctx, abaId, fn) {
  if (fmFichaAtual(ctx) && FICHA.novo) FICHA.novo[abaId] = fn;
}

function fmEhProcesso(ctx) { return !!(ctx && ctx.tipo === "processo" && ctx.processId); }
function fmQs(ctx) {
  return fmEhProcesso(ctx)
    ? "process_id=" + encodeURIComponent(ctx.processId)
    : "client_id=" + encodeURIComponent(ctx.clientId);
}
const fmEnc = (v) => encodeURIComponent(String(v));

/** Fontes de dados — a chave é a mesma de ctx.dados e dos motivos de aoMudar.
 *  `perm`: módulo exigido para LER (sem ele a fonte nem é pedida). */
const FM_FONTES = {
  prazos:       { perm: "deadlines",    url: (c) => "/api/deadlines?" + fmQs(c) },
  audiencias:   { perm: "appointments", url: (c) => "/api/appointments?" + fmQs(c) },
  documentos:   { perm: "documents",    url: (c) => fmEhProcesso(c)
    ? "/api/documents?process_id=" + fmEnc(c.processId)
    : "/api/documents?client_id=" + fmEnc(c.clientId) + "&incluir_processos=1" },
  // Na ficha do processo: só os atendimentos ligados A ELE.
  atendimentos: { perm: "clients",      url: (c) => c.clientId
    ? "/api/clients/" + fmEnc(c.clientId) + "/atendimentos" + (fmEhProcesso(c) ? "?process_id=" + fmEnc(c.processId) : "")
    : null },
  honorarios:   { perm: "financeiro",   url: (c) => "/api/honorarios?" + fmQs(c) },
  andamentos:   { perm: "processes",    url: (c) => fmEhProcesso(c) ? "/api/processes/" + fmEnc(c.processId) + "/andamentos" : null },
  // Com process_id/client_id a listagem traz o `texto` e NÃO marca como lida.
  // (Nunca GET /api/publicacoes/{id}: aquela rota marca como lida para todos.)
  publicacoes:  { perm: null,           url: (c) => "/api/publicacoes?" + fmQs(c) },
};

/** Lista de uma fonte: a pré-carga da ficha (ctx.dados) ou a API.
 *  → array; null quando a pessoa não alcança a fonte (sem o módulo, 403/404):
 *  o bloco some e a aba continua. Outros erros sobem (o bloco mostra
 *  "Tentar novamente"). opts.forcar: ignora a pré-carga (depois de gravar). */
async function fmObter(ctx, chave, opts = {}) {
  const f = FM_FONTES[chave];
  if (!ctx || !f) return null;
  ctx.dados = ctx.dados || {};
  if (f.perm && !permCanView(f.perm)) return null;
  if (!opts.forcar && Array.isArray(ctx.dados[chave])) return ctx.dados[chave];
  const url = f.url(ctx);
  if (!url) return null;
  try {
    const r = await api(url);
    const lista = Array.isArray(r) ? r : [];
    ctx.dados[chave] = lista;
    return lista;
  } catch (e) {
    if (e && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

/** Depois de QUALQUER gravação/exclusão: recarrega a fonte, atualiza
 *  ctx.dados, redesenha os blocos que mostram esse dado, acerta o contador da
 *  aba e avisa a ficha (ctx.aoMudar) — que recalcula KPIs, alertas e "Complete
 *  a ficha". Não redesenha a ficha inteira. */
async function fmRecarregar(ctx, chave) {
  if (!ctx) return;
  try { await fmObter(ctx, chave, { forcar: true }); }
  catch (e) {
    console.warn("[ficha-modulos] não recarregou", chave, e);
    toast("Gravado, mas a lista não foi atualizada: " + (e && e.message ? e.message : "erro") + ". Recarregue a aba.", true);
  }
  fmRedesenharDependentes(ctx, chave);
  fmAtualizarContadores(ctx, chave);
  fmAvisar(ctx, chave);
}

/** Redesenha (a partir de ctx.dados) todo módulo desta ficha que mostra `chave`. */
function fmRedesenharDependentes(ctx, chave) {
  for (const st of Object.values(fmEstados(ctx))) {
    if (!st.el || !st.el.isConnected) continue;
    try {
      if (st.modulo === "agenda" && (chave === "prazos" || chave === "audiencias")) fmAgendaDesenhar(st);
      else if (st.modulo === "documentos" && chave === "documentos") fmDocDesenhar(st);
      else if (st.modulo === "atendimentos" && chave === "atendimentos") fmAtDesenharLista(st);
      else if (st.modulo === "financeiro" && chave === "honorarios") fmFinDesenhar(st);
      else if (st.modulo === "linha") fmLinhaAoMudar(st, chave);
    } catch (e) { console.error("[ficha-modulos] falha ao redesenhar", st.modulo, e); }
  }
}

/** Aba de um módulo: a que o desenhou nesta ficha, senão o id padrão do contrato. */
function fmAbaDe(ctx, modulo, padrao) {
  for (const st of Object.values(fmEstados(ctx))) {
    if (st.modulo === modulo && (modulo !== "linha" || st.comForm)) return st.abaId;
  }
  return padrao;
}

/* --- contadores (contrato: agenda = prazos não cumpridos + audiências futuras;
       documentos/atendimentos = total; andamentos = andamentos + publicações;
       financeiro = honorários em aberto, sem pílula quando zero) --- */
function fmContarAgenda(ctx) {
  const d = (ctx && ctx.dados) || {};
  const agora = fmAgoraLocal();
  const p = permCanView("deadlines") && Array.isArray(d.prazos) ? d.prazos.filter((x) => !x.done).length : 0;
  const a = permCanView("appointments") && Array.isArray(d.audiencias)
    ? d.audiencias.filter((x) => fichaChaveData(x.date_time) >= agora).length : 0;
  return p + a;
}
function fmContarAndamentos(ctx) {
  const d = (ctx && ctx.dados) || {};
  return (Array.isArray(d.andamentos) ? d.andamentos.length : 0) + (Array.isArray(d.publicacoes) ? d.publicacoes.length : 0);
}
function fmHonPendente(h) {
  const p = Number(h.pending_value);
  if (Number.isFinite(p)) return Math.max(0, p);
  return Math.max(0, (Number(h.total_value) || 0) - (Number(h.paid_value) || 0));
}
function fmContarHonorarios(ctx) {
  const l = ctx && ctx.dados && ctx.dados.honorarios;
  if (!Array.isArray(l)) return null;
  const n = l.filter((h) => fmHonPendente(h) > 0.004).length;
  return n || null;
}
/** Pílula da aba: SÓ aparece com número maior que zero, em todas as abas das
 *  duas fichas (zero e "não sei" escondem). As fichas também passam por aqui. */
function fmContador(abaId, n) {
  const v = Number(n);
  fichaContador(abaId, Number.isFinite(v) && v > 0 ? v : null);
}
function fmAtualizarContadores(ctx, chave) {
  if (!fmFichaAtual(ctx)) return;      // não mexer nas abas de OUTRA ficha
  const d = ctx.dados || {};
  if (chave === "prazos" || chave === "audiencias") fmContador(fmAbaDe(ctx, "agenda", "agenda"), fmContarAgenda(ctx));
  else if (chave === "documentos") fmContador(fmAbaDe(ctx, "documentos", "documentos"), Array.isArray(d.documentos) ? d.documentos.length : null);
  else if (chave === "atendimentos") fmContador(fmAbaDe(ctx, "atendimentos", "atendimentos"), Array.isArray(d.atendimentos) ? d.atendimentos.length : null);
  else if (chave === "honorarios") fmContador(fmAbaDe(ctx, "financeiro", "financeiro"), fmContarHonorarios(ctx));
  else if ((chave === "andamentos" || chave === "publicacoes") && fmEhProcesso(ctx)) fmContador(fmAbaDe(ctx, "linha", "andamentos"), fmContarAndamentos(ctx));
}
function fmAvisar(ctx, chave) {
  if (!fmFichaAtual(ctx) || typeof ctx.aoMudar !== "function") return;
  try {
    const r = ctx.aoMudar(chave);
    if (r && typeof r.catch === "function") r.catch((e) => console.warn("[ficha-modulos] aoMudar falhou", e));
  } catch (e) { console.warn("[ficha-modulos] aoMudar falhou", e); }
}

/* =========================================================
   2. UTILIDADES DE TELA
   ========================================================= */

/** Agora, na hora LOCAL, no formato do datetime-local ("AAAA-MM-DDTHH:MM"). */
function fmAgoraLocal() {
  const d = new Date();
  return `${ymd(d)}T${fichaDois(d.getHours())}:${fichaDois(d.getMinutes())}`;
}

/** Carimbo gravado pelo SERVIDOR (uploaded_at/created_at: UTC sem fuso) →
 *  "dd/mm/aaaa hh:mm" local. Lido como hora local, sairia 3h adiantado. */
function fmCarimbo(s, soData) {
  if (!s) return "";
  const t = String(s).trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return fmtDataHora(t);
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : t.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fmtDataHora(t);
  const data = `${fichaDois(d.getDate())}/${fichaDois(d.getMonth() + 1)}/${d.getFullYear()}`;
  return soData ? data : `${data} ${fichaDois(d.getHours())}:${fichaDois(d.getMinutes())}`;
}

/** dd/mm (mesmo ano) ou dd/mm/aaaa — para selos curtos. */
function fmDiaCurto(dataISO) {
  const d = fichaSoData(dataISO);
  if (!d) return "";
  return d.slice(0, 4) === ymd(new Date()).slice(0, 4) ? d.slice(8, 10) + "/" + d.slice(5, 7) : fmtDate(d);
}

/** Link interno (hash) que abre outra ficha/tela pelo roteador. */
function fmLink(hash, html, cls) {
  const h = fichaHashSeguro(hash);
  if (!h) return html;
  return `<a class="${cls || "fm-link"}" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}">${html}</a>`;
}

function fmProcs(ctx) { return ctx && Array.isArray(ctx.processos) ? ctx.processos : null; }
/** Ficha do cliente sem nenhum processo visível (prazo/audiência exigem um). */
function fmSemProcesso(ctx) {
  const l = fmProcs(ctx);
  return !fmEhProcesso(ctx) && Array.isArray(l) && l.length === 0;
}
/** Na ficha do processo a coluna "Processo" seria sempre o mesmo número. */
function fmMostraProcesso(ctx) { return !fmEhProcesso(ctx); }

function fmProcNumero(p) { return p ? (p.case_number ? fmtCnj(p.case_number) : "Processo #" + p.id) : ""; }
/** Número do processo para exibir: dos processos da ficha; senão o rótulo da
 *  API ("0801… — Cliente", sem o cliente, que na ficha dele é redundante). */
function fmRotuloProcesso(ctx, pid, rotuloApi) {
  if (!pid) return "";
  const p = (fmProcs(ctx) || []).find((x) => String(x.id) === String(pid))
    || (ctx && ctx.processo && String(ctx.processo.id) === String(pid) ? ctx.processo : null);
  if (p) return fmProcNumero(p);
  if (rotuloApi) return String(rotuloApi).split(" — ")[0];
  return "Processo #" + pid;
}
/** Processo como link para a ficha dele (texto puro sem o módulo Processos). */
function fmProcLinkHtml(ctx, pid, rotuloApi) {
  if (!pid) return "";
  const txt = `<i class="bi bi-folder2-open" aria-hidden="true"></i> <span class="ficha-num">${esc(fmRotuloProcesso(ctx, pid, rotuloApi))}</span>`;
  return permCanView("processes") ? fmLink("#/processos/" + Number(pid), txt) : `<span>${txt}</span>`;
}

/** Botão só com ícone (editar/excluir/baixar) — sempre com title e aria-label. */
function fmBtnIcone(icone, rotulo, acao, args, perigo) {
  return `<button type="button" class="fm-btn-icone${perigo ? " is-perigo" : ""}" title="${esc(rotulo)}" aria-label="${esc(rotulo)}" data-on-click="${acao}" data-args="${escArgs(...args)}"><i class="bi ${icone}" aria-hidden="true"></i></button>`;
}

function fmErroHtml(msg, abaId) {
  return uiVazio({
    icone: "bi-exclamation-triangle", compacto: true,
    titulo: "Não foi possível carregar",
    texto: msg || "Tente novamente em instantes.",
    acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fichaAtualizarAba" data-args="${escArgs(abaId)}"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Tentar novamente</button>`,
  });
}
function fmSemAcesso() {
  return uiVazio({ icone: "bi-lock", titulo: "Sem acesso a este módulo", texto: "Peça ao administrador para liberar o módulo no seu perfil." });
}
function fmMsg(e) { return e && e.message ? e.message : "Erro ao carregar."; }

/** Guarda o aberto/fechado dos <details> antes de redesenhar (senão "Concluídos"
 *  fechava sozinho a cada prazo marcado). */
function fmGuardarRecolhidos(st) {
  st.recolhe = st.recolhe || {};
  if (!st.el) return;
  st.el.querySelectorAll("details[data-fm-recolhe]").forEach((d) => { st.recolhe[d.dataset.fmRecolhe] = d.open; });
}
function fmAberto(st, chave) { return st.recolhe && st.recolhe[chave] ? " open" : ""; }
function fmRecolhivel(st, chave, rotulo, n, html) {
  return `<details class="fm-recolhe" data-fm-recolhe="${esc(chave)}"${fmAberto(st, chave)}><summary><i class="bi bi-chevron-right fm-recolhe-seta" aria-hidden="true"></i>${esc(rotulo)}<span class="fm-cont">${esc(n)}</span></summary>${html}</details>`;
}

/* --- rascunho dos formulários inline (atendimento, andamento) ---
   A aba Andamentos é "sempreAtualizar": volta a ser desenhada a cada
   ativação, e o que estava digitado sumiria. O rascunho fica no estado do
   módulo e volta para o formulário no próximo desenho. (A guarda global
   "Alterações não salvas" tem UM aoSalvar por ficha, que é do Cadastro/Dados:
   ligar estes formulários nela faria o Salvar da barra gravar o form errado.) */
function fmFormLer(form) {
  const r = {};
  form.querySelectorAll("input, textarea, select").forEach((c) => {
    if (!c.id && !c.name) return;
    if (c.type === "radio") { if (c.checked) r["radio:" + c.name] = c.value; return; }
    if (c.type === "submit" || c.type === "button") return;
    if (c.id) r[c.id] = c.value;
  });
  return r;
}
function fmFormRestaurar(form, r) {
  if (!form || !r) return;
  Object.entries(r).forEach(([k, v]) => {
    if (k.startsWith("radio:")) {
      const nome = k.slice(6);
      form.querySelectorAll('input[type="radio"]').forEach((x) => { if (x.name === nome) x.checked = x.value === v; });
      return;
    }
    const c = form.querySelector("#" + CSS.escape(k));
    if (c) c.value = v;
  });
}
/** AÇÃO (data-on-input/change no <form>): guarda o rascunho e avisa a guarda
 *  de saída se há TEXTO digitado (data e hora pré-preenchidas não contam). */
function fmRascunho(abaId) {
  const st = fmEstado(fmCtx(), abaId);
  if (!st || !(this instanceof HTMLFormElement)) return;
  st.rascunho = st.rascunho || {};
  st.rascunho[this.dataset.fmForm] = fmFormLer(this);
  fmMarcarRascunho(this.dataset.fmForm, fmFormTemTexto(this));
}

/** Há texto digitado num formulário curto? (só campos de texto livre) */
function fmFormTemTexto(form) {
  return !!form && [...form.querySelectorAll("textarea, input")].some((c) =>
    (c.tagName === "TEXTAREA" || ["text", "email", "tel", "search", ""].includes(c.type || "")) && String(c.value || "").trim() !== "");
}

/** Formulário curto com texto não salvo (contato, atendimento, parte,
 *  andamento): o núcleo (fichaMarcarRascunho) faz a guarda perguntar antes de
 *  sair da ficha. As duas fichas usam ESTA função, com os mesmos rótulos.
 *  Sem o núcleo novo carregado, não faz nada (a guarda antiga continua). */
const FM_RASCUNHO_ROTULOS = { contato: "Contatos", atendimento: "Atendimentos", parte: "Partes", andamento: "Andamentos" };
function fmMarcarRascunho(chave, sim) {
  if (typeof fichaMarcarRascunho !== "function" || !chave) return;
  try { fichaMarcarRascunho(chave, !!sim, FM_RASCUNHO_ROTULOS[chave] || chave); }
  catch (e) { console.warn("[ficha-modulos] fichaMarcarRascunho falhou", e); }
}

/** Desliga o botão de enviar durante a gravação (duplo clique gravaria 2x). */
function fmOcupado(form, sim) {
  const btn = form && form.querySelector('button[type="submit"]');
  if (!btn) return;
  if (sim) {
    form.dataset.fmGravando = "1";
    btn.dataset.fmRotulo = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Salvando…';
  } else {
    delete form.dataset.fmGravando;
    btn.disabled = false;
    if (btn.dataset.fmRotulo) btn.innerHTML = btn.dataset.fmRotulo;
  }
}

/** AÇÃO: foca o formulário inline da aba (o "Novo ▾" da ficha). */
function fmFocar(abaId, seletor) {
  const st = fmEstado(fmCtx(), abaId);
  const alvo = st && st.el ? st.el.querySelector(seletor) : null;
  if (!alvo) return;
  alvo.scrollIntoView({ block: "center", behavior: "smooth" });
  try { alvo.focus({ preventScroll: true }); } catch (e) { alvo.focus(); }
}

/* =========================================================
   3. AGENDA — prazos e audiências (SPEC §5.1)
   ========================================================= */
async function fmAgenda(el, ctx, opts = {}) {
  const abaId = fichaIdSeguro(opts.abaId || "agenda");
  const st = fmIniciar(ctx, abaId, "agenda", el, opts);
  const rodada = st.rodada;
  const edP = permCanEdit("deadlines"), edA = permCanEdit("appointments");
  if (edP || edA) fmRegistrarNovo(ctx, abaId, () => fmAgendaNovo(edP ? "prazo" : "audiencia", abaId));
  const verP = permCanView("deadlines"), verA = permCanView("appointments");
  if (!verP && !verA) { el.innerHTML = fmSemAcesso(); fmContador(abaId, null); return; }

  const [rp, ra] = await Promise.allSettled([
    verP ? fmObter(ctx, "prazos") : Promise.resolve(null),
    verA ? fmObter(ctx, "audiencias") : Promise.resolve(null),
  ]);
  if (!fmVivo(st, rodada)) return;
  st.erros = {
    prazos: rp.status === "rejected" ? fmMsg(rp.reason) : null,
    audiencias: ra.status === "rejected" ? fmMsg(ra.reason) : null,
  };
  st.oculto = {
    prazos: rp.status === "fulfilled" && rp.value === null,
    audiencias: ra.status === "fulfilled" && ra.value === null,
  };
  fmAgendaDesenhar(st);
  fmContador(abaId, fmContarAgenda(ctx));
}

function fmAgendaDesenhar(st) {
  const el = st.el, ctx = st.ctx;
  if (!el || !el.isConnected) return;
  fmGuardarRecolhidos(st);
  const d = ctx.dados || {};
  const verP = permCanView("deadlines") && !(st.oculto && st.oculto.prazos);
  const verA = permCanView("appointments") && !(st.oculto && st.oculto.audiencias);
  const prazos = verP && Array.isArray(d.prazos) ? d.prazos : null;
  const auds = verA && Array.isArray(d.audiencias) ? d.audiencias : null;
  const erros = st.erros || {};

  // Cliente sem processo e sem nada lançado: orienta a cadastrar o processo
  // (prazo e audiência sempre pertencem a um processo).
  if (fmSemProcesso(ctx) && !(prazos && prazos.length) && !(auds && auds.length) && !erros.prazos && !erros.audiencias) {
    el.innerHTML = `<div class="fm-modulo fm-agenda">${fmVazioSemProcesso(ctx)}</div>`;
    return;
  }
  const blocos = [];
  if (verP && (prazos || erros.prazos)) blocos.push(fmPrazosCard(st, prazos));
  if (verA && (auds || erros.audiencias)) blocos.push(fmAudCard(st, auds));
  el.innerHTML = `<div class="fm-modulo fm-agenda">${blocos.join("") || fmSemAcesso()}</div>`;
}

function fmVazioSemProcesso(ctx) {
  const h = "#/processos/novo?cliente=" + Number(ctx.clientId);
  const pode = permCanEdit("processes") && ctx.clientId;
  return uiVazio({
    icone: "bi-folder-plus",
    titulo: "Cadastre um processo primeiro",
    texto: "Prazos e audiências ficam ligados a um processo. Cadastre o primeiro processo deste cliente para lançá-los aqui.",
    acaoHtml: pode ? `<a class="btn btn-sm btn-primary" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo processo</a>` : "",
  });
}

function fmPrazosCard(st, prazos) {
  const aba = st.abaId;
  const acoes = permCanEdit("deadlines")
    ? `<button type="button" class="btn btn-sm btn-primary" data-on-click="fmAgendaNovo" data-args="${escArgs("prazo", aba)}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo prazo</button>` : "";
  if (st.erros.prazos) return uiCard({ titulo: "Prazos", acoesHtml: acoes, corpoHtml: fmErroHtml(st.erros.prazos, aba), classe: "fm-card" });
  const hoje = ymd(new Date());
  const data = (p) => String(p.date || "");
  // Em aberto: do mais antigo para o mais novo — os vencidos ficam no topo.
  const abertos = prazos.filter((p) => !p.done).sort((a, b) => data(a).localeCompare(data(b)) || a.id - b.id);
  const feitos = prazos.filter((p) => p.done).sort((a, b) => data(b).localeCompare(data(a)) || b.id - a.id);
  const vencidos = abertos.filter((p) => p.date && p.date < hoje).length;
  let corpo = abertos.length
    ? `<ul class="fm-lista">${abertos.map((p) => fmPrazoItem(st, p)).join("")}</ul>`
    : uiVazio({
      compacto: true, icone: prazos.length ? "bi-check2-all" : "bi-alarm",
      titulo: prazos.length ? "Nenhum prazo em aberto" : "Nenhum prazo lançado",
      texto: prazos.length ? "Todos os prazos foram cumpridos." : "Lance os prazos para receber os alertas de vencimento.",
    });
  if (feitos.length) corpo += fmRecolhivel(st, "prazos-feitos", "Cumpridos", feitos.length, `<ul class="fm-lista">${feitos.map((p) => fmPrazoItem(st, p)).join("")}</ul>`);
  const desc = abertos.length
    ? `${abertos.length} em aberto` + (vencidos ? ` · ${vencidos} vencido${vencidos > 1 ? "s" : ""}` : "")
    : "";
  return uiCard({ titulo: "Prazos", descricao: desc, acoesHtml: acoes, corpoHtml: corpo, classe: "fm-card" });
}

function fmPrazoItem(st, p) {
  const ctx = st.ctx, aba = st.abaId;
  const podeEd = permCanEdit("deadlines");
  const podeEx = podeEd && permPodeExcluir();
  const feito = !!p.done;
  const check = podeEd
    ? `<label class="fm-check" title="${feito ? "Reabrir o prazo" : "Marcar como cumprido"}"><input type="checkbox" class="form-check-input"${feito ? " checked" : ""} data-on-change="fmPrazoCumprido" data-args="${escArgs(aba, p.id, feito ? 0 : 1)}"><span class="visually-hidden">${feito ? "Cumprido (desmarque para reabrir)" : "Marcar como cumprido"}: ${esc(p.description)}</span></label>`
    : `<span class="fm-check-ro" aria-hidden="true"><i class="bi ${feito ? "bi-check-circle-fill" : "bi-circle"}"></i></span>`;
  const n = fichaDiasAte(p.date);
  const meta = [
    uiUrgencia(p.urgency_level),
    fmMostraProcesso(ctx) ? fmProcLinkHtml(ctx, p.process_id, p.process_label) : "",
    // A data por extenso só quando o selo é relativo ("Em 3 dias"); acima de
    // 7 dias o próprio selo já é a data.
    feito || (n !== null && n <= 7) ? `<span class="ficha-num">${esc(fmtDate(p.date))}</span>` : "",
  ].filter(Boolean).join("");
  const acoes = (podeEd ? fmBtnIcone("bi-pencil", "Editar prazo", "fmPrazoEditar", [aba, p.id]) : "") +
    (podeEx ? fmBtnIcone("bi-trash", "Excluir prazo", "fmExcluir", [aba, "prazo", p.id], true) : "");
  return `<li class="fm-item${feito ? " is-feito" : ""}">${check}<div class="fm-item-corpo"><div class="fm-item-titulo">${esc(p.description)}</div><div class="fm-item-meta">${meta}</div></div><div class="fm-item-lado">${uiPrazoBadge(p.date, feito)}</div>${acoes ? `<div class="fm-item-acoes">${acoes}</div>` : ""}</li>`;
}

function fmAudCard(st, auds) {
  const aba = st.abaId;
  const acoes = permCanEdit("appointments")
    ? `<button type="button" class="btn btn-sm btn-primary" data-on-click="fmAgendaNovo" data-args="${escArgs("audiencia", aba)}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Nova audiência</button>` : "";
  if (st.erros.audiencias) return uiCard({ titulo: "Audiências", acoesHtml: acoes, corpoHtml: fmErroHtml(st.erros.audiencias, aba), classe: "fm-card" });
  const agora = fmAgoraLocal();
  const chave = (a) => fichaChaveData(a.date_time);
  const futuras = auds.filter((a) => chave(a) >= agora).sort((a, b) => chave(a).localeCompare(chave(b)));
  const passadas = auds.filter((a) => chave(a) < agora).sort((a, b) => chave(b).localeCompare(chave(a)));
  let corpo = futuras.length
    ? `<ul class="fm-lista">${futuras.map((a) => fmAudItem(st, a, true)).join("")}</ul>`
    : uiVazio({ compacto: true, icone: "bi-calendar-event", titulo: "Nenhuma audiência marcada", texto: passadas.length ? "As anteriores estão logo abaixo." : "" });
  if (passadas.length) corpo += fmRecolhivel(st, "aud-passadas", "Anteriores", passadas.length, `<ul class="fm-lista">${passadas.map((a) => fmAudItem(st, a, false)).join("")}</ul>`);
  const desc = futuras.length ? `${futuras.length} marcada${futuras.length > 1 ? "s" : ""}` : "";
  return uiCard({ titulo: "Audiências", descricao: desc, acoesHtml: acoes, corpoHtml: corpo, classe: "fm-card" });
}

/** Selo relativo da audiência (não é "vence": é quando acontece). */
function fmAudSelo(dataHora) {
  const n = fichaDiasAte(dataHora);
  if (n === null) return "";
  if (n === 0) return uiChip("warning", "Hoje", "bi-exclamation-triangle");
  if (n === 1) return uiChip("info", "Amanhã", "bi-clock");
  if (n > 1 && n <= 7) return uiChip("info", `Em ${n} dias`, "bi-clock");
  return "";
}

function fmAudItem(st, a, futura) {
  const ctx = st.ctx, aba = st.abaId;
  const podeEd = permCanEdit("appointments");
  const podeEx = podeEd && permPodeExcluir();
  const meta = [
    a.location ? `<span><i class="bi bi-geo-alt" aria-hidden="true"></i> ${esc(a.location)}</span>` : "",
    fmMostraProcesso(ctx) ? fmProcLinkHtml(ctx, a.process_id, a.process_label) : "",
  ].filter(Boolean).join("");
  const acoes = (podeEd ? fmBtnIcone("bi-pencil", "Editar audiência", "fmAudEditar", [aba, a.id]) : "") +
    (podeEx ? fmBtnIcone("bi-trash", "Excluir audiência", "fmExcluir", [aba, "audiencia", a.id], true) : "");
  return `<li class="fm-item${futura ? "" : " is-passado"}"><span class="fm-check-ro" aria-hidden="true"><i class="bi bi-calendar-event"></i></span><div class="fm-item-corpo"><div class="fm-item-titulo ficha-num">${esc(fmtDataHora(a.date_time))}</div>${meta ? `<div class="fm-item-meta">${meta}</div>` : ""}${a.notes ? `<div class="fm-item-nota">${esc(a.notes)}</div>` : ""}</div>${futura ? `<div class="fm-item-lado">${fmAudSelo(a.date_time)}</div>` : ""}${acoes ? `<div class="fm-item-acoes">${acoes}</div>` : ""}</li>`;
}

/** "Novo prazo" / "Nova audiência". Exportada: a ficha pode chamá-la direto
 *  (e é AÇÃO registrada — o "Novo ▾" pode usar acao:'fmAgendaNovo', args:['audiencia']).
 *  Processo pré-selecionado na ficha do processo; na do cliente, a lista do
 *  modal fica restrita aos processos DELE. */
async function fmAgendaNovo(tipo, abaId) {
  const ctx = fmCtx();
  if (!ctx) return;
  const ehPrazo = tipo !== "audiencia";
  const mod = ehPrazo ? "deadlines" : "appointments";
  if (!permCanEdit(mod)) { toast(ehPrazo ? "Seu perfil não pode lançar prazos." : "Seu perfil não pode marcar audiências.", true); return; }
  if (fmSemProcesso(ctx)) {
    if (!permCanEdit("processes")) { toast("Este cliente ainda não tem processo. Prazos e audiências precisam de um processo cadastrado.", true); return; }
    const r = await confirmar({
      titulo: "Cadastre um processo primeiro",
      texto: "Prazos e audiências ficam ligados a um processo, e este cliente ainda não tem nenhum. Cadastrar o processo agora?",
      botao: "Cadastrar processo",
    });
    if (r === "ok") irPara("#/processos/novo?cliente=" + Number(ctx.clientId));
    return;
  }
  const chave = ehPrazo ? "prazos" : "audiencias";
  const o = {
    clientId: ctx.clientId || undefined,
    processId: fmEhProcesso(ctx) ? ctx.processId : undefined,
    processos: fmProcs(ctx) || undefined,
    onSaved: () => fmRecarregar(ctx, chave),
  };
  if (ehPrazo) await deadlineModal(null, o);
  else await appointmentModal(null, o);
}

/** AÇÃO da caixa "Cumprido" (data-on-change; `this` = a caixa). */
async function fmPrazoCumprido(abaId, id, done) {
  const ctx = fmCtx();
  if (!ctx) return;
  const cb = this instanceof HTMLInputElement ? this : null;
  if (cb) cb.disabled = true;
  const ok = await toggleDeadline(id, done, { onDone: () => fmRecarregar(ctx, "prazos") });
  // Falhou: a caixa volta ao que era (senão mostraria "cumprido" sem ter gravado).
  if (!ok && cb && cb.isConnected) { cb.checked = !cb.checked; cb.disabled = false; }
}
async function fmPrazoEditar(abaId, id) {
  const ctx = fmCtx();
  if (!ctx) return;
  await deadlineModal(id, { processos: fmProcs(ctx) || undefined, onSaved: () => fmRecarregar(ctx, "prazos") });
}
async function fmAudEditar(abaId, id) {
  const ctx = fmCtx();
  if (!ctx) return;
  await appointmentModal(id, { processos: fmProcs(ctx) || undefined, onSaved: () => fmRecarregar(ctx, "audiencias") });
}

/** AÇÃO única de exclusão dos módulos. tipo ∈ prazo, audiencia, documento,
 *  honorario, atendimento, andamento. As exclusões do app.js já confirmam
 *  (confirmar) e avisam; o `onDone` atualiza só o bloco. */
async function fmExcluir(abaId, tipo, id) {
  const ctx = fmCtx();
  if (!ctx) return;
  if (!permPodeExcluir()) { toast("Seu perfil não pode excluir registros.", true); return; }
  const depois = (chave) => ({ onDone: () => fmRecarregar(ctx, chave) });
  if (tipo === "prazo") return deleteDeadline(id, depois("prazos"));
  if (tipo === "audiencia") return deleteAppointment(id, depois("audiencias"));
  if (tipo === "documento") return deleteDocument(id, depois("documentos"));
  if (tipo === "honorario") return deleteHonorario(id, depois("honorarios"));
  if (tipo === "atendimento" || tipo === "andamento") {
    const at = tipo === "atendimento";
    const r = await confirmar({ titulo: at ? "Excluir este atendimento?" : "Excluir este andamento?", texto: "Isso não pode ser desfeito.", botao: "Excluir", perigo: true });
    if (r !== "ok") return;
    const url = at
      ? `/api/clients/${fmEnc(ctx.clientId)}/atendimentos/${fmEnc(id)}`
      : `/api/processes/${fmEnc(ctx.processId)}/andamentos/${fmEnc(id)}`;
    try { await api(url, { method: "DELETE" }); }
    catch (e) { toast(e.message, true); return; }
    toast(at ? "Atendimento excluído." : "Andamento excluído.");
    await fmRecarregar(ctx, at ? "atendimentos" : "andamentos");
  }
}

/* =========================================================
   4. DOCUMENTOS (SPEC §5.2) — anexos + contratos do cliente
   ========================================================= */
async function fmDocumentos(el, ctx, opts = {}) {
  const abaId = fichaIdSeguro(opts.abaId || "documentos");
  const st = fmIniciar(ctx, abaId, "documentos", el, opts);
  const rodada = st.rodada;
  if (permCanEdit("documents")) fmRegistrarNovo(ctx, abaId, () => fmDocNovo(abaId));
  const verDocs = permCanView("documents");
  st.comContratos = !!opts.comContratos && !fmEhProcesso(ctx) && !!ctx.clientId && permCanView("assinaturas");
  if (!verDocs && !st.comContratos) { el.innerHTML = fmSemAcesso(); fmContador(abaId, null); return; }

  const [rd, rc] = await Promise.allSettled([
    verDocs ? fmObter(ctx, "documentos") : Promise.resolve(null),
    st.comContratos ? fmObterContratos(ctx) : Promise.resolve(null),
  ]);
  if (!fmVivo(st, rodada)) return;
  st.erros = {
    documentos: rd.status === "rejected" ? fmMsg(rd.reason) : null,
    contratos: rc.status === "rejected" ? fmMsg(rc.reason) : null,
  };
  st.ocultoDocs = !verDocs || (rd.status === "fulfilled" && rd.value === null);
  st.contratos = rc.status === "fulfilled" ? rc.value : null;
  fmDocDesenhar(st);
  fmContador(abaId, !st.ocultoDocs && Array.isArray(ctx.dados.documentos) ? ctx.dados.documentos.length : null);
}

/** Contratos e procurações do cliente (módulo Assinaturas). 403 → null. */
async function fmObterContratos(ctx) {
  try {
    const r = await api("/api/assinaturas?client_id=" + fmEnc(ctx.clientId));
    return Array.isArray(r) ? r : [];
  } catch (e) {
    if (e && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

/** Ícone pelo tipo do arquivo — lista fechada (vira classe). */
function fmIconeArquivo(nome) {
  const ext = (String(nome || "").match(/\.([a-z0-9]+)$/i) || [])[1];
  const m = {
    pdf: "bi-file-earmark-pdf", doc: "bi-file-earmark-word", docx: "bi-file-earmark-word",
    xls: "bi-file-earmark-excel", xlsx: "bi-file-earmark-excel", csv: "bi-file-earmark-excel",
    jpg: "bi-file-earmark-image", jpeg: "bi-file-earmark-image", png: "bi-file-earmark-image",
    webp: "bi-file-earmark-image", gif: "bi-file-earmark-image",
  };
  return m[String(ext || "").toLowerCase()] || "bi-file-earmark-text";
}

function fmDocDesenhar(st) {
  const el = st.el, ctx = st.ctx;
  if (!el || !el.isConnected) return;
  const blocos = [];
  if (!st.ocultoDocs) blocos.push(fmDocCard(st));
  if (st.comContratos && (st.contratos || st.erros.contratos)) blocos.push(fmContratosCard(st));
  el.innerHTML = `<div class="fm-modulo fm-documentos">${blocos.join("") || fmSemAcesso()}</div>`;
}

function fmDocCard(st) {
  const ctx = st.ctx, aba = st.abaId;
  const docs = Array.isArray(ctx.dados.documentos) ? ctx.dados.documentos : [];
  const podeEnviar = permCanEdit("documents");
  const acoes = (ctx.clientId ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fmDocGerar" data-args="${escArgs(aba)}" title="Procuração, contrato e outros modelos em Word, com os dados preenchidos"><i class="bi bi-file-earmark-word" aria-hidden="true"></i> Gerar documento</button>` : "") +
    (podeEnviar ? `<button type="button" class="btn btn-sm btn-primary" data-on-click="fmDocNovo" data-args="${escArgs(aba)}"><i class="bi bi-upload" aria-hidden="true"></i> Enviar documento</button>` : "");
  if (st.erros.documentos) return uiCard({ titulo: "Documentos", acoesHtml: acoes, corpoHtml: fmErroHtml(st.erros.documentos, aba), classe: "fm-card" });
  const comVinculo = fmMostraProcesso(ctx);
  const linhas = docs.map((d) => {
    const nome = d.original_name || "documento";
    const podeEx = permPodeExcluir() && permCanEdit("documents");
    return `<tr>
      <td data-rotulo="Arquivo"><span class="fm-arquivo"><i class="bi ${fmIconeArquivo(nome)}" aria-hidden="true"></i><span>${esc(nome)}</span></span></td>
      <td data-rotulo="Categoria">${d.categoria ? uiChip("neutral", PREC_DOC_CAT[d.categoria] || d.categoria) : '<span class="ficha-traco">—</span>'}</td>
      ${comVinculo ? `<td data-rotulo="Vínculo">${fmDocVinculo(ctx, d)}</td>` : ""}
      <td data-rotulo="Enviado em" class="ficha-num">${esc(fmCarimbo(d.uploaded_at)) || '<span class="ficha-traco">—</span>'}</td>
      <td class="fm-acoes-td"><span class="fm-acoes">${fmBtnIcone("bi-download", "Baixar " + nome, "downloadDoc", [d.id, nome])}${podeEx ? fmBtnIcone("bi-trash", "Excluir " + nome, "fmExcluir", [aba, "documento", d.id], true) : ""}</span></td>
    </tr>`;
  }).join("");
  const corpo = docs.length
    ? `<div class="fm-tabela-wrap"><table class="table table-hover align-middle ficha-tabela fm-tabela">
        <thead><tr><th>Arquivo</th><th>Categoria</th>${comVinculo ? "<th>Vínculo</th>" : ""}<th>Enviado em</th><th class="text-end"><span class="visually-hidden">Ações</span></th></tr></thead>
        <tbody>${linhas}</tbody></table></div>
       <p class="fm-nota"><i class="bi bi-info-circle" aria-hidden="true"></i><span>Guarde sempre o arquivo original: anexos podem não continuar no servidor depois de atualizações do sistema.</span></p>`
    : uiVazio({
      icone: "bi-folder2-open", titulo: "Nenhum documento anexado",
      // (o botão "Enviar documento" já está no cabeçalho do cartão — não repete)
      texto: comVinculo ? "Envie procurações, contratos e documentos pessoais do cliente e dos processos dele." : "Envie as peças, decisões e comprovantes deste processo.",
    });
  const desc = docs.length ? `${docs.length} arquivo${docs.length > 1 ? "s" : ""}${comVinculo ? " do cliente e dos processos dele" : ""}` : "";
  return uiCard({ titulo: "Documentos", descricao: desc, acoesHtml: acoes, corpoHtml: corpo, classe: "fm-card" });
}

/** Na ficha do cliente: a que o documento está preso (processo, precatório, ação). */
function fmDocVinculo(ctx, d) {
  if (d.process_id) return fmProcLinkHtml(ctx, d.process_id);
  if (d.precatorio_id) {
    const t = `<i class="bi bi-bank" aria-hidden="true"></i> Precatório #${esc(d.precatorio_id)}`;
    return permCanView("precatorios") ? fmLink("#/precatorios/" + Number(d.precatorio_id), t) : t;
  }
  if (d.acao_id) {
    const t = `<i class="bi bi-briefcase" aria-hidden="true"></i> Ação #${esc(d.acao_id)}`;
    return permCanView("acoes") ? fmLink("#/acoes/" + Number(d.acao_id), t) : t;
  }
  return '<span class="fm-sub">Cliente</span>';
}

const FM_ASSIN_TOM = { assinado: "success", enviado: "info", visualizado: "info", recusado: "danger", expirado: "danger", rascunho: "neutral" };

function fmContratosCard(st) {
  const aba = st.abaId;
  const acoes = fmLink("#/assinaturas", '<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i> Abrir Assinaturas', "btn btn-sm btn-ficha");
  if (st.erros.contratos) return uiCard({ titulo: "Contratos e procurações", acoesHtml: acoes, corpoHtml: fmErroHtml(st.erros.contratos, aba), classe: "fm-card" });
  const lista = st.contratos || [];
  const corpo = lista.length
    ? `<div class="fm-tabela-wrap"><table class="table table-hover align-middle ficha-tabela fm-tabela">
        <thead><tr><th>Documento</th><th>Status</th><th>Criado em</th><th class="text-end"><span class="visually-hidden">Ações</span></th></tr></thead>
        <tbody>${lista.map((a) => `<tr>
          <td data-rotulo="Documento"><div class="fm-cel"><div class="fw-semibold fm-quebra">${esc(a.titulo || assinTipoLabel(a.tipo) || "Documento")}</div><div class="fm-sub">${esc(assinTipoLabel(a.tipo) || "")}</div></div></td>
          <td data-rotulo="Status">${uiChip(FM_ASSIN_TOM[a.status] || "neutral", ASSIN_STATUS[a.status] || a.status || "—")}</td>
          <td data-rotulo="Criado em" class="ficha-num">${esc(fmCarimbo(a.created_at, true)) || "—"}</td>
          <td class="fm-acoes-td"><span class="fm-acoes">${fmBtnIcone("bi-file-earmark-pdf", "Ver PDF", "downloadAssinatura", [a.id])}</span></td>
        </tr>`).join("")}</tbody></table></div>`
    : uiVazio({ compacto: true, icone: "bi-pen", titulo: "Nenhum contrato ou procuração", texto: "Gere e envie para assinatura pelo módulo Assinaturas." });
  return uiCard({ titulo: "Contratos e procurações", descricao: "Gerados no módulo Assinaturas", acoesHtml: acoes, corpoHtml: corpo, classe: "fm-card" });
}

/** "Enviar documento" com o vínculo da ficha: no processo vai SÓ o process_id
 *  (o backend deriva o cliente); no cliente, o cliente fica travado e o
 *  select de processo mostra só os dele. */
async function fmDocNovo(abaId) {
  const ctx = fmCtx();
  if (!ctx) return;
  if (!permCanEdit("documents")) { toast("Seu perfil não pode enviar documentos.", true); return; }
  const o = fmEhProcesso(ctx)
    ? { processId: ctx.processId }
    : { clientId: ctx.clientId, processos: fmProcs(ctx) || undefined };
  o.onSaved = () => fmRecarregar(ctx, "documentos");
  await documentModal(o);
}

/** Gerar .docx por modelo, já com o cliente (e o processo) da ficha. O arquivo
 *  é baixado — não é gravado no CRM. */
async function fmDocGerar(abaId) {
  const ctx = fmCtx();
  if (!ctx || !ctx.clientId) return;
  let modelos;
  try { modelos = await api("/api/documents/modelos"); }
  catch (e) { toast(e.message, true); return; }
  if (!Array.isArray(modelos) || !modelos.length) { toast("Nenhum modelo de documento disponível.", true); return; }
  const proc = fmEhProcesso(ctx);
  const procs = (fmProcs(ctx) || []).filter((p) => p && p.id);
  const campoProc = proc
    ? `<div class="mb-2"><span class="form-label d-block">Processo</span><div class="form-control-plaintext py-1 ficha-num">${esc(fmRotuloProcesso(ctx, ctx.processId))}</div></div>`
    : (procs.length ? `<div class="mb-2"><label class="form-label" for="fmd-proc">Processo (opcional)</label><select id="fmd-proc" class="form-select"><option value="">Nenhum</option>${procs.map((p) => `<option value="${esc(p.id)}">${esc(fmProcNumero(p))}${p.assunto ? " — " + esc(p.assunto) : ""}</option>`).join("")}</select></div>` : "");
  showModal("Gerar documento", `
    <div class="mb-2"><label class="form-label" for="fmd-modelo">Modelo*</label>
      <select id="fmd-modelo" class="form-select">${modelos.map((m) => `<option value="${esc(m.id)}">${esc(m.nome)}</option>`).join("")}</select></div>
    ${campoProc}
    <p class="small text-muted mb-0">Gera um arquivo Word (.docx) com os dados ${proc ? "do cliente e do processo" : "do cliente"}. O arquivo é baixado para você revisar — não fica salvo no CRM.</p>
  `, async () => {
    const modelo = valOpt("fmd-modelo");
    if (!modelo) return toast("Escolha o modelo.", true);
    const pid = proc ? ctx.processId : valOpt("fmd-proc");
    let url = `/api/documents/modelo?modelo=${fmEnc(modelo)}&client_id=${fmEnc(ctx.clientId)}`;
    if (pid) url += `&process_id=${fmEnc(pid)}`;
    await blobDownload(url, `${modelo}.docx`);
    closeModal();
    toast("Documento gerado e baixado.");
  }, { rotuloSalvar: "Gerar e baixar (.docx)", rotuloFechar: "Cancelar" });
}

/* =========================================================
   5. ATENDIMENTOS (SPEC §5.3)
   ========================================================= */
async function fmAtendimentos(el, ctx, opts = {}) {
  const abaId = fichaIdSeguro(opts.abaId || "atendimentos");
  const st = fmIniciar(ctx, abaId, "atendimentos", el, opts);
  const rodada = st.rodada;
  if (!permCanView("clients") || !ctx.clientId) { el.innerHTML = fmSemAcesso(); fmContador(abaId, null); return; }
  const podeEd = permCanEdit("clients");
  if (podeEd) fmRegistrarNovo(ctx, abaId, () => fmFocar(abaId, "#fma-descricao"));
  const pfx = "fma-";
  const form = podeEd ? uiCard({
    titulo: "Registrar atendimento",
    descricao: "Ligação, mensagem, reunião ou nota interna — fica no histórico do cliente.",
    corpoHtml: `<form class="fm-form" data-fm-form="atendimento" data-on-submit="fmAtendimentoSalvar" data-on-input="fmRascunho" data-on-change="fmRascunho" data-prevent="1" data-args="${escArgs(abaId)}" novalidate>${fmAtCamposHtml(ctx, pfx, { processoFixo: fmEhProcesso(ctx) ? ctx.processId : null })}<div class="fm-form-acoes"><button type="submit" class="btn btn-sm btn-primary"><i class="bi bi-check-lg" aria-hidden="true"></i> Registrar atendimento</button></div></form>`,
    classe: "fm-card",
  }) : "";
  el.innerHTML = `<div class="fm-modulo fm-atendimentos">${form}<div data-fm-bloco="lista">${uiCarregando()}</div></div>`;
  if (podeEd) fmFormRestaurar(el.querySelector('form[data-fm-form="atendimento"]'), st.rascunho && st.rascunho.atendimento);

  let r;
  try { r = await fmObter(ctx, "atendimentos"); }
  catch (e) { if (!fmVivo(st, rodada)) return; st.erros.atendimentos = fmMsg(e); }
  if (!fmVivo(st, rodada)) return;
  st.oculto = r === null && !st.erros.atendimentos;
  fmAtDesenharLista(st);
  fmContador(abaId, Array.isArray(ctx.dados.atendimentos) && !st.oculto ? ctx.dados.atendimentos.length : null);
}

/** Campos do formulário de atendimento (aba: pfx "fma-"; modal: "fma-m-",
 *  para os <label for> não apontarem para o campo errado se os dois existirem). */
function fmAtCamposHtml(ctx, pfx, o = {}) {
  const icones = (FICHA_ICONES && FICHA_ICONES.atendimentoTipo) || {};
  const pilulas = Object.entries(FICHA_ROTULOS.atendimentoTipo).map(([k, r]) => {
    const ic = fichaIconeSeguro(icones[k]) || "bi-dot";
    return `<input type="radio" class="btn-check" name="${pfx}tipo" id="${pfx}tipo-${esc(k)}" value="${esc(k)}" autocomplete="off"${k === "nota" ? " checked" : ""}><label class="btn btn-sm fm-pilula" for="${pfx}tipo-${esc(k)}"><i class="bi ${ic}" aria-hidden="true"></i> ${esc(r)}</label>`;
  }).join("");
  let proc = "";
  if (o.processoFixo) {
    proc = `<span class="form-label d-block">Processo</span><div class="form-control-plaintext py-1 ficha-num">${esc(fmRotuloProcesso(ctx, o.processoFixo))}</div>`;
  } else {
    const lista = (fmProcs(ctx) || []).filter((p) => p && p.id);
    if (lista.length && permCanView("processes")) {
      proc = `<label class="form-label" for="${pfx}proc">Processo <span class="fm-opcional">(opcional)</span></label><select id="${pfx}proc" class="form-select"><option value="">Nenhum</option>${lista.map((p) => `<option value="${esc(p.id)}">${esc(fmProcNumero(p))}${p.assunto ? " — " + esc(p.assunto) : ""}</option>`).join("")}</select>`;
    }
  }
  return `<div class="form-label" id="${pfx}tipo-rot">Tipo</div>
    <div class="fm-pilulas" role="radiogroup" aria-labelledby="${pfx}tipo-rot">${pilulas}</div>
    <div class="row g-2 mt-1">
      <div class="col-sm-6 col-lg-4"><label class="form-label" for="${pfx}data">Data e hora</label><input type="datetime-local" id="${pfx}data" class="form-control" value="${esc(fmAgoraLocal())}"></div>
      ${proc ? `<div class="col-sm-6 col-lg-4">${proc}</div>` : ""}
      <div class="col-sm-6 col-lg-4"><label class="form-label" for="${pfx}retorno">Agendar retorno <span class="fm-opcional">(opcional)</span></label><input type="date" id="${pfx}retorno" class="form-control"></div>
      <div class="col-12"><label class="form-label" for="${pfx}descricao">Descrição*</label><textarea id="${pfx}descricao" class="form-control" rows="3" placeholder="O que foi tratado, combinado ou pedido."></textarea></div>
    </div>`;
}

/** Lê e valida o formulário (escopo = `root`). → payload, ou null (já avisou e
 *  focou o campo — o que foi digitado FICA). */
function fmAtLer(root, pfx, processoFixo) {
  const q = (id) => root.querySelector("#" + pfx + id);
  const desc = q("descricao");
  const descricao = desc ? desc.value.trim() : "";
  if (!descricao) { toast("Descreva o atendimento.", true); if (desc) desc.focus(); return null; }
  const campoData = q("data");
  let data = campoData ? campoData.value.trim() : "";
  if (!data) data = fmAgoraLocal();                      // sempre manda a hora LOCAL
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(data.slice(0, 16))) {
    toast("Data e hora inválidas.", true); if (campoData) campoData.focus(); return null;
  }
  if (data.length === 16) data += ":00";                 // sem fuso: o backend lê como hora local
  const ret = q("retorno") ? q("retorno").value.trim() : "";
  const marcado = root.querySelector(`input[name="${pfx}tipo"]:checked`);
  let pid = processoFixo ? Number(processoFixo) : null;
  const sel = q("proc");
  if (!processoFixo && sel && sel.value) pid = Number(sel.value);
  return {
    tipo: marcado ? marcado.value : "nota", descricao, data,
    process_id: pid || null, proximo_retorno: ret || null,
  };
}
function fmAtLimpar(root, pfx) {
  const q = (id) => root.querySelector("#" + pfx + id);
  if (q("descricao")) q("descricao").value = "";
  if (q("retorno")) q("retorno").value = "";
  if (q("data")) q("data").value = fmAgoraLocal();
  if (q("proc")) q("proc").value = "";
  const nota = root.querySelector(`input[name="${pfx}tipo"][value="nota"]`);
  if (nota) nota.checked = true;
}
/** POST + atualização dos blocos. Erro sobe para quem chamou (o formulário
 *  fica como estava). */
async function fmAtGravar(ctx, payload) {
  await api(`/api/clients/${fmEnc(ctx.clientId)}/atendimentos`, { method: "POST", body: JSON.stringify(payload) });
  toast("Atendimento registrado.");
  await fmRecarregar(ctx, "atendimentos");
}

/** AÇÃO: envio do formulário da aba (data-on-submit; `this` = o <form>). */
async function fmAtendimentoSalvar(abaId) {
  const ctx = fmCtx();
  const st = fmEstado(ctx, abaId);
  const form = this instanceof HTMLFormElement ? this : (st && st.el ? st.el.querySelector('form[data-fm-form="atendimento"]') : null);
  if (!ctx || !form || form.dataset.fmGravando === "1") return;
  const payload = fmAtLer(form, "fma-", fmEhProcesso(ctx) ? ctx.processId : null);
  if (!payload) return;
  fmOcupado(form, true);
  try {
    await fmAtGravar(ctx, payload);
    fmAtLimpar(form, "fma-");                 // sucesso limpa…
    if (st && st.rascunho) st.rascunho.atendimento = null;
    fmMarcarRascunho("atendimento", false);
  } catch (e) {
    toast(e.message, true);                   // …erro mantém o que foi digitado
  } finally { fmOcupado(form, false); }
}

/** O mesmo formulário num modal — "Novo ▾ → Atendimento" da ficha do
 *  PROCESSO (que não tem aba Atendimentos). Aceita ser chamada como ação
 *  registrada: sem ctx (usa FICHA.ctx) e com o processo como 1º argumento. */
async function fmAtendimentoModal(ctxArg, opts) {
  const ehCtx = ctxArg && typeof ctxArg === "object" && !(ctxArg instanceof Event) && Object.prototype.hasOwnProperty.call(ctxArg, "clientId");
  const ctx = ehCtx ? ctxArg : fmCtx();
  let o = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  if (!ehCtx && /^\d{1,12}$/.test(String(ctxArg === undefined || ctxArg === null ? "" : ctxArg))) o = { processId: Number(ctxArg) };
  if (!ctx || !ctx.clientId) { toast("Abra a ficha do cliente ou do processo para registrar o atendimento.", true); return; }
  if (!permCanEdit("clients")) { toast("Seu perfil não pode registrar atendimentos.", true); return; }
  const processId = o.processId !== undefined && o.processId !== null ? o.processId : (fmEhProcesso(ctx) ? ctx.processId : null);
  const pfx = "fma-m-";
  showModal("Registrar atendimento", `<div class="fm-form" id="fma-m-form">${fmAtCamposHtml(ctx, pfx, { processoFixo: processId })}</div>`, async () => {
    const root = document.getElementById("fma-m-form");
    if (!root) return;
    const payload = fmAtLer(root, pfx, processId);
    if (!payload) return;                    // validação: o modal fica aberto com o texto
    await fmAtGravar(ctx, payload);          // erro: showModal mostra e mantém o modal
    closeModal();
  }, { rotuloSalvar: "Registrar atendimento", rotuloFechar: "Cancelar", tamanho: "modal-lg" });
}

function fmAtDesenharLista(st) {
  const el = st.el, ctx = st.ctx;
  const alvo = el && el.isConnected ? el.querySelector('[data-fm-bloco="lista"]') : null;
  if (!alvo) return;
  if (st.erros.atendimentos) { alvo.innerHTML = fmErroHtml(st.erros.atendimentos, st.abaId); return; }
  if (st.oculto) { alvo.innerHTML = ""; return; }
  const itens = (Array.isArray(ctx.dados.atendimentos) ? ctx.dados.atendimentos : []).slice()
    .sort((a, b) => fichaChaveData(b.data).localeCompare(fichaChaveData(a.data)) || b.id - a.id);
  const corpo = itens.length ? fmAtTimelineHtml(st, itens) : uiVazio({
    compacto: true, icone: "bi-chat-dots", titulo: "Nenhum atendimento registrado",
    texto: "Registre ligações, reuniões e mensagens: o histórico ajuda quem atender o cliente depois.",
  });
  alvo.innerHTML = uiCard({ titulo: "Histórico", descricao: itens.length ? `${itens.length} registro${itens.length > 1 ? "s" : ""}` : "", corpoHtml: corpo, classe: "fm-card" });
}

/* --- retorno de atendimento: a REGRA fica só aqui ---
   O atendimento não tem "feito": o retorno conta como feito quando há outro
   atendimento registrado DEPOIS dele, na data do retorno ou mais tarde — é
   exatamente o registro do retorno. Usada pelo cabeçalho da ficha do cliente
   (alertas) e pelo histórico da aba Atendimentos: os dois não podem divergir
   (antes, o histórico mostrava "vencido" para sempre um retorno já feito). */

/** 'feito' | 'pendente' (chegou o dia e ninguém registrou) | 'agendado'
 *  (futuro) | null (sem retorno). `ats` = todos os atendimentos do cliente. */
function fmRetornoSituacao(a, ats) {
  const r = fichaSoData(a && a.proximo_retorno);
  if (!r) return null;
  const ka = fichaChaveData(a.data);
  const outro = (b) => b && b !== a && (a.id === undefined || a.id === null || b.id !== a.id);
  if ((Array.isArray(ats) ? ats : []).some((b) => outro(b) && fichaChaveData(b.data) > ka && (fichaSoData(b.data) || "") >= r)) return "feito";
  return fichaDiasAte(r) > 0 ? "agendado" : "pendente";
}

/** Retornos que já deviam ter acontecido e não foram registrados, do mais
 *  antigo para o mais novo. */
function fmRetornosPendentes(ats) {
  if (!Array.isArray(ats)) return [];
  return ats.filter((a) => fmRetornoSituacao(a, ats) === "pendente")
    .sort((a, b) => fichaSoData(a.proximo_retorno).localeCompare(fichaSoData(b.proximo_retorno)));
}

/** Selo do retorno. Feito = cor neutra; só o pendente fica "vencido". */
function fmRetornoChip(a, ats) {
  const dataISO = a && a.proximo_retorno;
  const sit = fmRetornoSituacao(a, ats);
  if (!sit) return "";
  const titulo = "Retorno marcado para " + fmtDate(fichaSoData(dataISO));
  if (sit === "feito") return uiChip("neutral", `Retorno ${fmDiaCurto(dataISO)} · feito`, "bi-check2", { titulo: titulo + " — registrado em atendimento posterior" });
  const n = fichaDiasAte(dataISO);
  if (n < 0) return uiChip("danger", `Retorno ${fmDiaCurto(dataISO)} · vencido`, "bi-telephone-x", { titulo });
  if (n === 0) return uiChip("warning", "Retorno hoje", "bi-telephone-forward", { titulo });
  return uiChip("info", `Retorno ${fmDiaCurto(dataISO)}`, "bi-telephone-forward", { titulo });
}

/** AÇÃO "Registrar retorno" (atendimento com retorno pendente): o formulário
 *  da aba já vem com o tipo e o processo do original e um texto inicial. */
function fmAtRetorno(abaId, id) {
  const ctx = fmCtx();
  const st = fmEstado(ctx, abaId);
  const a = ctx && Array.isArray(ctx.dados && ctx.dados.atendimentos)
    ? ctx.dados.atendimentos.find((x) => String(x.id) === String(id)) : null;
  const form = st && st.el ? st.el.querySelector('form[data-fm-form="atendimento"]') : null;
  if (!a || !form) return;
  const tipo = form.querySelector(`input[name="fma-tipo"][value="${CSS.escape(String(a.tipo || ""))}"]`);
  if (tipo) tipo.checked = true;
  const sel = form.querySelector("#fma-proc");
  if (sel && a.process_id && [...sel.options].some((o) => o.value === String(a.process_id))) sel.value = String(a.process_id);
  const data = form.querySelector("#fma-data");
  if (data) data.value = fmAgoraLocal();
  const ret = form.querySelector("#fma-retorno");
  if (ret) ret.value = "";
  const desc = form.querySelector("#fma-descricao");
  if (desc) desc.value = `Retorno do atendimento de ${fmDiaCurto(a.data)}. `;
  fmRascunho.call(form, abaId);
  fmMarcarRascunho("atendimento", true);
  if (desc) {
    desc.scrollIntoView({ block: "center", behavior: "smooth" });
    try { desc.focus({ preventScroll: true }); } catch (e) { desc.focus(); }
    desc.setSelectionRange(desc.value.length, desc.value.length);
  }
}

function fmAtTimelineHtml(st, itens) {
  const ctx = st.ctx;
  const icones = (FICHA_ICONES && FICHA_ICONES.atendimentoTipo) || {};
  const podeEx = permPodeExcluir() && permCanEdit("clients");
  const podeEd = permCanEdit("clients");
  const todos = Array.isArray(ctx.dados.atendimentos) ? ctx.dados.atendimentos : itens;
  const partes = [];
  let mes = null;
  for (const a of itens) {
    const m = fichaMesAno(a.data);
    if (m !== mes) {
      if (mes !== null) partes.push("</ol>");
      partes.push(`<h3 class="ficha-tl-mes">${esc(m || "Sem data")}</h3><ol class="ficha-tl">`);
      mes = m;
    }
    const ic = fichaIconeSeguro(icones[a.tipo]) || "bi-chat-dots";
    const quando = fmtDataHora(a.data);
    const linha2 = [
      a.process_id && fmMostraProcesso(ctx) ? fmProcLinkHtml(ctx, a.process_id, a.process_number) : "",
      a.proximo_retorno ? fmRetornoChip(a, todos) : "",
    ].filter(Boolean).join("");
    const retornar = podeEd && fmRetornoSituacao(a, todos) === "pendente"
      ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fmAtRetorno" data-args="${escArgs(st.abaId, a.id)}"><i class="bi bi-telephone-forward" aria-hidden="true"></i> Registrar retorno</button>` : "";
    const excluir = podeEx ? `<button type="button" class="fm-btn-link" data-on-click="fmExcluir" data-args="${escArgs(st.abaId, "atendimento", a.id)}"><i class="bi bi-trash" aria-hidden="true"></i> Excluir</button>` : "";
    partes.push(`<li class="ficha-tl-item tl-tipo-atendimento"><span class="ficha-tl-ponto" aria-hidden="true"></span>
      <div class="ficha-tl-meta"><i class="bi ${ic}" aria-hidden="true"></i><span class="fm-tl-tipo">${esc(fichaRotulo("atendimentoTipo", a.tipo) || "Atendimento")}</span>${quando ? `<span aria-hidden="true">·</span><time datetime="${esc(a.data)}">${esc(quando)}</time>` : ""}${a.autor_nome ? `<span aria-hidden="true">·</span><span>${esc(a.autor_nome)}</span>` : ""}</div>
      ${linha2 ? `<div class="fm-at-linha">${linha2}</div>` : ""}
      <div class="ficha-tl-detalhe fm-at-texto">${esc(a.descricao)}</div>
      ${retornar || excluir ? `<div class="fm-tl-acoes">${retornar}${excluir}</div>` : ""}
    </li>`);
  }
  if (mes !== null) partes.push("</ol>");
  return `<div class="ficha-tl-wrap">${partes.join("")}</div>`;
}

/* =========================================================
   6. FINANCEIRO (SPEC §5.4)
   ========================================================= */
async function fmFinanceiro(el, ctx, opts = {}) {
  const abaId = fichaIdSeguro(opts.abaId || "financeiro");
  const st = fmIniciar(ctx, abaId, "financeiro", el, opts);
  const rodada = st.rodada;
  if (!permCanView("financeiro")) { el.innerHTML = fmSemAcesso(); fmContador(abaId, null); return; }
  if (permCanEdit("financeiro")) fmRegistrarNovo(ctx, abaId, () => fmHonNovo(abaId));
  let r;
  try { r = await fmObter(ctx, "honorarios"); }
  catch (e) { if (!fmVivo(st, rodada)) return; st.erros.honorarios = fmMsg(e); }
  if (!fmVivo(st, rodada)) return;
  st.oculto = r === null && !st.erros.honorarios;
  fmFinDesenhar(st);
  fmContador(abaId, st.oculto ? null : fmContarHonorarios(ctx));
}

function fmFinDesenhar(st) {
  const el = st.el, ctx = st.ctx, aba = st.abaId;
  if (!el || !el.isConnected) return;
  if (st.oculto) { el.innerHTML = `<div class="fm-modulo">${fmSemAcesso()}</div>`; return; }
  const podeEd = permCanEdit("financeiro");
  const novo = podeEd ? `<button type="button" class="btn btn-sm btn-primary" data-on-click="fmHonNovo" data-args="${escArgs(aba)}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo honorário</button>` : "";
  if (st.erros.honorarios) {
    el.innerHTML = `<div class="fm-modulo">${uiCard({ titulo: "Honorários", acoesHtml: novo, corpoHtml: fmErroHtml(st.erros.honorarios, aba), classe: "fm-card" })}</div>`;
    return;
  }
  const hons = Array.isArray(ctx.dados.honorarios) ? ctx.dados.honorarios : [];
  if (!hons.length) {
    // Dentro do cartão, como os outros módulos; o "Novo honorário" já está no
    // cabeçalho dele — o vazio não repete o botão.
    el.innerHTML = `<div class="fm-modulo fm-financeiro">${uiCard({
      titulo: "Honorários", acoesHtml: novo, classe: "fm-card",
      corpoHtml: uiVazio({
        icone: "bi-cash-coin", titulo: "Nenhum honorário lançado",
        texto: "Lance o contrato de honorários para acompanhar o que já foi recebido e o que falta receber.",
      }),
    })}</div>`;
    return;
  }
  const hoje = ymd(new Date());
  let contratado = 0, recebido = 0, aReceber = 0, vencido = 0, nVenc = 0;
  const vencidoDe = (h) => fmHonPendente(h) > 0.004 && h.due_date && String(h.due_date) < hoje;
  hons.forEach((h) => {
    contratado += Number(h.total_value) || 0;
    recebido += Number(h.paid_value) || 0;
    const pend = fmHonPendente(h);
    aReceber += pend;
    if (vencidoDe(h)) { vencido += pend; nVenc += 1; }
  });
  const kpis = `<div class="fm-kpis">${[
    uiKpi({ icone: "bi-file-earmark-text", rotulo: "Contratado", html: `<span class="ficha-num">${esc(fmtMoeda(contratado))}</span>` }),
    uiKpi({ icone: "bi-check2-circle", rotulo: "Recebido", html: `<span class="ficha-num">${esc(fmtMoeda(recebido))}</span>`, tom: "success" }),
    uiKpi({ icone: "bi-hourglass-split", rotulo: "A receber", html: `<span class="ficha-num">${esc(fmtMoeda(aReceber))}</span>`, tom: "info" }),
    uiKpi({ icone: "bi-exclamation-octagon", rotulo: "Vencido", html: `<span class="ficha-num${vencido > 0.004 ? " fm-valor-perigo" : ""}">${esc(fmtMoeda(vencido))}</span>`, tom: vencido > 0.004 ? "danger" : "neutral", dica: nVenc ? `${nVenc} parcela${nVenc > 1 ? "s" : ""} em atraso` : "" }),
  ].join("")}</div>`;
  const parceria = hons.some((h) => h.minha_parte)
    ? `<p class="fm-nota"><i class="bi bi-info-circle" aria-hidden="true"></i><span>Nos honorários de parceria, os valores mostram a sua parte.</span></p>` : "";
  const comProc = fmMostraProcesso(ctx);
  const podeEx = podeEd && permPodeExcluir();
  const linhas = hons.map((h) => {
    const venc = vencidoDe(h);
    const desc = h.notes || HON_TYPE[h.type] || "Honorário";
    const tom = h.status === "pago" ? "success" : (venc ? "danger" : (h.status === "parcial" ? "warning" : "neutral"));
    const status = uiChip(tom, venc ? "Vencido" : (HON_STATUS[h.status] || h.status || "—"));
    const sub = [esc(HON_TYPE[h.type] || h.type || ""), h.rateio ? uiChip("accent", "Rateio") : "", h.minha_parte ? uiChip("info", "Sua parte") : ""].filter(Boolean).join(" ");
    const clicavel = podeEd ? ` class="fm-linha-clicavel" tabindex="0" data-on-click="fmHonAbrir" data-on-keydown="fmHonTecla" data-args="${escArgs(aba, h.id)}" title="Abrir honorário"` : "";
    return `<tr${clicavel}>
      <td data-rotulo="Descrição"><div class="fm-cel"><div class="fw-semibold fm-quebra">${esc(desc)}</div>${sub ? `<div class="fm-sub">${sub}</div>` : ""}</div></td>
      ${comProc ? `<td data-rotulo="Processo">${h.process_id ? fmProcLinkHtml(ctx, h.process_id, h.process_label) : '<span class="ficha-traco">—</span>'}</td>` : ""}
      <td data-rotulo="Valor" class="text-md-end ficha-num">${esc(fmtMoeda(h.total_value))}</td>
      <td data-rotulo="Pago" class="text-md-end ficha-num">${esc(fmtMoeda(h.paid_value))}</td>
      <td data-rotulo="Vencimento" class="ficha-num">${h.due_date ? esc(fmtDate(fichaSoData(h.due_date) || "")) : '<span class="ficha-traco">—</span>'}</td>
      <td data-rotulo="Status">${status}</td>
      ${podeEx ? `<td class="fm-acoes-td"><span class="fm-acoes">${fmBtnIcone("bi-trash", "Excluir honorário", "fmExcluir", [aba, "honorario", h.id], true)}</span></td>` : ""}
    </tr>`;
  }).join("");
  const tabela = `<div class="fm-tabela-wrap"><table class="table table-hover align-middle ficha-tabela fm-tabela">
    <thead><tr><th>Descrição</th>${comProc ? "<th>Processo</th>" : ""}<th class="text-md-end">Valor</th><th class="text-md-end">Pago</th><th>Vencimento</th><th>Status</th>${podeEx ? '<th class="text-end"><span class="visually-hidden">Ações</span></th>' : ""}</tr></thead>
    <tbody>${linhas}</tbody></table></div>${parceria}`;
  el.innerHTML = `<div class="fm-modulo fm-financeiro">${kpis}${uiCard({ titulo: "Honorários", descricao: `${hons.length} lançamento${hons.length > 1 ? "s" : ""}`, acoesHtml: novo, corpoHtml: tabela, classe: "fm-card" })}</div>`;
}

async function fmHonNovo(abaId) {
  const ctx = fmCtx();
  if (!ctx) return;
  if (!permCanEdit("financeiro")) { toast("Seu perfil não pode lançar honorários.", true); return; }
  const o = fmEhProcesso(ctx)
    ? { processId: ctx.processId, clientId: ctx.clientId, processos: fmProcs(ctx) || undefined }
    : { clientId: ctx.clientId, processos: fmProcs(ctx) || undefined };
  o.onSaved = () => fmRecarregar(ctx, "honorarios");
  await honorarioModal(null, o);
}
async function fmHonAbrir(abaId, id) {
  const ctx = fmCtx();
  if (!ctx || !permCanEdit("financeiro")) return;
  await honorarioModal(id, { processos: fmProcs(ctx) || undefined, onSaved: () => fmRecarregar(ctx, "honorarios") });
}
/** Enter/Espaço na linha focada abre o honorário (só quando o foco é a <tr>). */
function fmHonTecla(abaId, id) {
  const ev = eventoAtual();
  if (!ev || ev.target !== this || (ev.key !== "Enter" && ev.key !== " ")) return;
  ev.preventDefault();
  return fmHonAbrir.call(this, abaId, id);
}

/* =========================================================
   7. LINHA DO TEMPO / ANDAMENTOS (SPEC §5.5 e §4.4 item 4)
   ========================================================= */

/** Pílulas de filtro. `tipos` = tipos de evento do backend (§3.5); null = tudo. */
const FM_TL_FILTROS_CLIENTE = [
  { id: "tudo", rotulo: "Tudo", tipos: null },
  { id: "processos", rotulo: "Processos", tipos: ["processo", "parte"] },
  { id: "prazos", rotulo: "Prazos", tipos: ["prazo"] },
  { id: "audiencias", rotulo: "Audiências", tipos: ["audiencia"] },
  { id: "andamentos", rotulo: "Andamentos", tipos: ["andamento"] },
  { id: "publicacoes", rotulo: "Publicações", tipos: ["publicacao"] },
  { id: "atendimentos", rotulo: "Atendimentos", tipos: ["atendimento"] },
  { id: "documentos", rotulo: "Documentos", tipos: ["documento", "assinatura"] },
  { id: "financeiro", rotulo: "Financeiro", tipos: ["honorario"] },
];
const FM_TL_FILTROS_PROCESSO = [
  { id: "processuais", rotulo: "Processuais", tipos: ["andamento", "publicacao"] },
  { id: "tudo", rotulo: "Tudo", tipos: null },
  { id: "prazos", rotulo: "Prazos", tipos: ["prazo"] },
  { id: "audiencias", rotulo: "Audiências", tipos: ["audiencia"] },
  { id: "documentos", rotulo: "Documentos", tipos: ["documento"] },
  { id: "atendimentos", rotulo: "Atendimentos", tipos: ["atendimento"] },
  { id: "financeiro", rotulo: "Financeiro", tipos: ["honorario"] },
];

async function fmLinhaDoTempo(el, ctx, opts = {}) {
  const abaId = fichaIdSeguro(opts.abaId || "linha");
  const st = fmIniciar(ctx, abaId, "linha", el, opts);
  const rodada = st.rodada;
  st.proc = fmEhProcesso(ctx);
  st.comForm = !!opts.formAndamento && st.proc;
  st.filtros = st.proc ? FM_TL_FILTROS_PROCESSO : FM_TL_FILTROS_CLIENTE;
  const valido = (f) => st.filtros.some((x) => x.id === f);
  st.filtroPadrao = valido(opts.filtroPadrao) ? opts.filtroPadrao : st.filtros[0].id;
  // O filtro escolhido sobrevive à troca de aba (a aba é "sempreAtualizar").
  if (!valido(st.filtro)) st.filtro = st.filtroPadrao;

  const verTl = st.proc ? permCanView("processes") : permCanView("clients");
  if (!verTl) { el.innerHTML = fmSemAcesso(); return; }
  const podeAndamento = st.comForm && permCanEdit("processes");
  if (podeAndamento) fmRegistrarNovo(ctx, abaId, () => fmFocar(abaId, "#fmn-titulo"));

  el.innerHTML = `<div class="fm-modulo fm-linha">${podeAndamento ? fmAndamentoFormHtml(st) : ""}<div data-fm-bloco="linha">${uiCarregando()}</div></div>`;
  if (podeAndamento) fmFormRestaurar(el.querySelector('form[data-fm-form="andamento"]'), st.rascunho && st.rascunho.andamento);

  const [rt, ra, rp] = await Promise.allSettled([
    fmBuscarTimeline(ctx),
    st.proc ? fmObter(ctx, "andamentos") : Promise.resolve(null),
    st.proc ? fmObter(ctx, "publicacoes") : Promise.resolve(null),
  ]);
  if (!fmVivo(st, rodada)) return;
  st.eventos = rt.status === "fulfilled" ? rt.value : null;
  st.erros = {
    timeline: rt.status === "rejected" ? fmMsg(rt.reason) : null,
    andamentos: ra.status === "rejected" ? fmMsg(ra.reason) : null,
    publicacoes: rp.status === "rejected" ? fmMsg(rp.reason) : null,
  };
  fmLinhaDesenhar(st);
  if (st.comForm) fmContador(abaId, fmContarAndamentos(ctx));
}

async function fmBuscarTimeline(ctx) {
  const url = fmEhProcesso(ctx)
    ? "/api/processes/" + fmEnc(ctx.processId) + "/timeline"
    : "/api/clients/" + fmEnc(ctx.clientId) + "/timeline";
  const r = await api(url);
  return r && Array.isArray(r.events) ? r.events : [];
}

/** Outro módulo gravou algo. Andamentos/publicações (já em ctx.dados):
 *  redesenha a lista. O resto vem da timeline do servidor: se esta aba está à
 *  vista, busca de novo SÓ a lista (o formulário fica intacto); se não está,
 *  marca a aba para redesenhar quando for aberta. */
function fmLinhaAoMudar(st, chave) {
  if (st.proc && (chave === "andamentos" || chave === "publicacoes")) { fmLinhaDesenhar(st); return; }
  const visivel = typeof FICHA !== "undefined" && FICHA.aba === st.abaId && FICHA.ctx === st.ctx;
  if (!visivel) { if (FICHA.ctx === st.ctx) fichaAtualizarAba(st.abaId); return; }
  const n = (st.rodadaLista = (st.rodadaLista || 0) + 1);
  fmBuscarTimeline(st.ctx).then((ev) => {
    if (st.rodadaLista !== n || !st.el || !st.el.isConnected) return;
    st.eventos = ev; st.erros.timeline = null;
    fmLinhaDesenhar(st);
  }).catch((e) => console.warn("[ficha-modulos] linha do tempo não atualizou", e));
}

function fmLinhaItens(st) {
  const ctx = st.ctx;
  let itens = (st.eventos || []).map((ev) => fmTlEvento(st, ev));
  if (st.proc) {
    // No processo, andamentos e publicações vêm das fontes próprias: com id
    // (excluir), teor e "lida". Os da timeline saem para não duplicar.
    const ands = ctx.dados && ctx.dados.andamentos;
    const pubs = ctx.dados && ctx.dados.publicacoes;
    if (Array.isArray(ands)) itens = itens.filter((i) => i.tipo !== "andamento").concat(ands.map((a) => fmTlAndamento(st, a)));
    if (Array.isArray(pubs)) itens = itens.filter((i) => i.tipo !== "publicacao").concat(pubs.map((p) => fmTlPublicacao(st, p)));
  }
  return itens;
}

function fmLinhaDesenhar(st) {
  const el = st.el;
  const alvo = el && el.isConnected ? el.querySelector('[data-fm-bloco="linha"]') : null;
  if (!alvo) return;
  fmGuardarRecolhidos(st);
  const itens = fmLinhaItens(st);
  const conta = {};
  st.filtros.forEach((f) => { conta[f.id] = f.tipos ? itens.filter((i) => f.tipos.includes(i.tipo)).length : itens.length; });
  const filtro = st.filtros.find((f) => f.id === st.filtro) || st.filtros[0];
  const lista = filtro.tipos ? itens.filter((i) => filtro.tipos.includes(i.tipo)) : itens;
  // Pílula sem nada some (enxuto) — menos "Tudo", a padrão e a escolhida.
  const pilulas = st.filtros
    .filter((f) => f.id === "tudo" || f.id === st.filtroPadrao || f.id === filtro.id || conta[f.id] > 0)
    .filter((f) => f.id !== "financeiro" || permCanView("financeiro"))
    .map((f) => {
      const on = f.id === filtro.id;
      return `<button type="button" class="fm-filtro${on ? " active" : ""}" aria-pressed="${on}" data-on-click="fmTlFiltro" data-args="${escArgs(st.abaId, f.id)}">${esc(f.rotulo)}<span class="fm-filtro-cont">${esc(conta[f.id])}</span></button>`;
    }).join("");
  const avisos = [st.erros.timeline, st.erros.andamentos, st.erros.publicacoes].filter(Boolean);
  const aviso = avisos.length ? `<div class="ficha-alerta ficha-alerta-warning fm-aviso"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i><div>Parte da linha do tempo não carregou (${esc(avisos[0])}). <button type="button" class="fm-btn-link fm-btn-link-forte" data-on-click="fichaAtualizarAba" data-args="${escArgs(st.abaId)}">Tentar novamente</button></div></div>` : "";
  const vazio = {
    processuais: ["Nenhum andamento ou publicação", st.comForm ? "Registre o primeiro andamento acima. As intimações do Diário vinculadas a este processo aparecem aqui." : "As intimações do Diário vinculadas a este processo aparecem aqui."],
    tudo: ["Nada registrado ainda", "Cadastros, prazos, documentos e atendimentos aparecem aqui, do mais recente para o mais antigo."],
  }[filtro.id] || ["Nada neste filtro", "Escolha outro filtro acima."];
  const corpo = `<div class="fm-filtros" role="group" aria-label="Filtrar a linha do tempo">${pilulas}</div>${aviso}` +
    uiTimeline(lista, { agruparPorMes: true, vazioTitulo: vazio[0], vazioTexto: vazio[1] });
  alvo.innerHTML = uiCard({ titulo: st.proc ? "Linha do tempo do processo" : "Linha do tempo", corpoHtml: corpo, classe: "fm-card" });
  // O teor das publicações que estava aberto continua aberto.
  alvo.querySelectorAll("details[data-fm-recolhe]").forEach((d) => { if (st.recolhe[d.dataset.fmRecolhe]) d.open = true; });
}

/** Evento do backend → item do uiTimeline (com destino quando houver). */
function fmTlEvento(st, ev) {
  const ctx = st.ctx;
  let detalhe = ev.detalhe || "";
  // Na ficha do cliente, de qual processo é o evento (o "processo" já traz o número).
  if (!st.proc && ev.processo_numero && !["processo", "cadastro"].includes(ev.tipo)) {
    detalhe = `Processo ${fmtCnj(ev.processo_numero)}` + (detalhe ? " · " + detalhe : "");
  }
  return Object.assign({ tipo: ev.tipo, data: ev.data, titulo: ev.titulo, detalhe, autor: ev.autor }, fmTlDestino(st, ev));
}

/** Para onde o item leva: outra ficha (hash) ou uma ação (modal/aba). */
function fmTlDestino(st, ev) {
  const ctx = st.ctx;
  const temAba = (id) => typeof fichaAbaCfg === "function" && !!fichaAbaCfg(id);
  const acao = () => ({ acao: "fmTlAbrir", args: [st.abaId, ev.tipo, ev.ref_id] });
  const pid = ev.processo_id;
  const fichaProc = (sufixo) => (pid && permCanView("processes") ? { hash: "#/processos/" + Number(pid) + (sufixo || "") } : {});
  switch (ev.tipo) {
    case "processo": return st.proc ? {} : fichaProc("");
    case "prazo": return ev.ref_id && (permCanEdit("deadlines") || temAba(fmAbaDe(ctx, "agenda", "agenda"))) ? acao() : {};
    case "audiencia": return ev.ref_id && (permCanEdit("appointments") || temAba(fmAbaDe(ctx, "agenda", "agenda"))) ? acao() : {};
    case "honorario": return ev.ref_id && (permCanEdit("financeiro") || temAba(fmAbaDe(ctx, "financeiro", "financeiro"))) ? acao() : {};
    case "documento": case "assinatura": return temAba(fmAbaDe(ctx, "documentos", "documentos")) ? acao() : {};
    case "atendimento": return temAba(fmAbaDe(ctx, "atendimentos", "atendimentos")) ? acao() : {};
    case "parte": return st.proc ? (temAba("partes") ? acao() : {}) : fichaProc("?aba=partes");
    case "andamento": case "publicacao": return st.proc ? {} : fichaProc("?aba=andamentos");
    default: return {};
  }
}

/** AÇÃO: clique num item da linha do tempo. */
async function fmTlAbrir(abaId, tipo, refId) {
  const ctx = fmCtx();
  if (!ctx) return;
  const ir = (id) => { if (typeof fichaAbaCfg === "function" && fichaAbaCfg(id)) fichaIrAba(id, { rolar: true }); };
  const procs = fmProcs(ctx) || undefined;
  if (tipo === "prazo") {
    if (permCanEdit("deadlines") && refId) return deadlineModal(refId, { processos: procs, onSaved: () => fmRecarregar(ctx, "prazos") });
    return ir(fmAbaDe(ctx, "agenda", "agenda"));
  }
  if (tipo === "audiencia") {
    if (permCanEdit("appointments") && refId) return appointmentModal(refId, { processos: procs, onSaved: () => fmRecarregar(ctx, "audiencias") });
    return ir(fmAbaDe(ctx, "agenda", "agenda"));
  }
  if (tipo === "honorario") {
    if (permCanEdit("financeiro") && refId) return honorarioModal(refId, { processos: procs, onSaved: () => fmRecarregar(ctx, "honorarios") });
    return ir(fmAbaDe(ctx, "financeiro", "financeiro"));
  }
  if (tipo === "documento" || tipo === "assinatura") return ir(fmAbaDe(ctx, "documentos", "documentos"));
  if (tipo === "atendimento") return ir(fmAbaDe(ctx, "atendimentos", "atendimentos"));
  if (tipo === "parte") return ir("partes");
}

/** AÇÃO: troca o filtro (redesenha só a lista; o formulário fica). */
function fmTlFiltro(abaId, filtro) {
  const st = fmEstado(fmCtx(), abaId);
  if (!st || !st.filtros || !st.filtros.some((f) => f.id === filtro)) return;
  st.filtro = filtro;
  fmLinhaDesenhar(st);
}

/* --- itens ricos do processo (detalheHtml vai dentro de .ficha-tl-detalhe,
       que é white-space:pre-wrap: o HTML abaixo não pode ter quebra de linha
       nem espaço entre as tags, senão vira linha em branco na tela) --- */
function fmTlAndamento(st, a) {
  const podeEx = permPodeExcluir() && permCanEdit("processes");
  const texto = a.descricao ? `<div class="fm-tl-texto">${esc(a.descricao)}</div>` : "";
  const acoes = podeEx ? `<div class="fm-tl-acoes"><button type="button" class="fm-btn-link" data-on-click="fmExcluir" data-args="${escArgs(st.abaId, "andamento", a.id)}"><i class="bi bi-trash" aria-hidden="true"></i> Excluir</button></div>` : "";
  return { tipo: "andamento", data: a.data, titulo: a.titulo, autor: a.autor_nome, detalheHtml: texto + acoes };
}

function fmTlPublicacao(st, p) {
  const naoLida = !p.lida;
  const chips = (naoLida ? uiChip("warning", "Não lida", "bi-envelope") : "") +
    (p.arquivada ? uiChip("neutral", "Arquivada", "bi-archive", { tracejado: true }) : "");
  const info = [p.orgao, p.classe].filter(Boolean).map((x) => esc(x)).join(" · ");
  const chave = "teor-" + fichaIdSeguro(p.id);
  const teor = p.texto
    ? `<details class="fm-teor" data-fm-recolhe="${chave}"><summary>Ver inteiro teor</summary><div class="fm-teor-texto">${esc(p.texto)}</div></details>`
    : "";
  const acoes = naoLida
    ? `<div class="fm-tl-acoes"><button type="button" class="btn btn-sm btn-ficha" data-on-click="fmPubLida" data-args="${escArgs(st.abaId, p.id)}"><i class="bi bi-check2" aria-hidden="true"></i> Marcar como lida</button></div>`
    : "";
  return {
    tipo: "publicacao", data: p.data_disponibilizacao || null,
    titulo: [p.tipo_comunicacao || "Publicação", p.tribunal].filter(Boolean).join(" · "),
    detalheHtml: (chips ? `<div class="fm-tl-chips">${chips}</div>` : "") + (info ? `<div class="fm-tl-info">${info}</div>` : "") + teor + acoes,
  };
}

/** AÇÃO: marca a publicação como lida (POST /lida — nunca o GET do detalhe). */
async function fmPubLida(abaId, id) {
  const ctx = fmCtx();
  if (!ctx) return;
  const btn = this instanceof HTMLButtonElement ? this : null;
  if (btn) btn.disabled = true;
  try { await api(`/api/publicacoes/${fmEnc(id)}/lida`, { method: "POST" }); }
  catch (e) { toast(e.message, true); if (btn && btn.isConnected) btn.disabled = false; return; }
  toast("Publicação marcada como lida.");
  await fmRecarregar(ctx, "publicacoes");
}

/* --- formulário "Registrar andamento" (fmn-) --- */
function fmAndamentoFormHtml(st) {
  return uiCard({
    titulo: "Registrar andamento",
    descricao: "Movimentações do processo que não chegam pelo Diário.",
    classe: "fm-card",
    corpoHtml: `<form class="fm-form" data-fm-form="andamento" data-on-submit="fmAndamentoSalvar" data-on-input="fmRascunho" data-on-change="fmRascunho" data-prevent="1" data-args="${escArgs(st.abaId)}" novalidate>
      <div class="row g-2">
        <div class="col-sm-4 col-lg-3"><label class="form-label" for="fmn-data">Data*</label><input type="date" id="fmn-data" class="form-control" value="${esc(ymd(new Date()))}"></div>
        <div class="col-sm-8 col-lg-9"><label class="form-label" for="fmn-titulo">Título*</label><input id="fmn-titulo" class="form-control" maxlength="200" placeholder="Ex.: Juntada de petição, sentença publicada" autocomplete="off"></div>
        <div class="col-12"><label class="form-label" for="fmn-descricao">Descrição <span class="fm-opcional">(opcional)</span></label><textarea id="fmn-descricao" class="form-control" rows="2"></textarea></div>
      </div>
      <div class="fm-form-acoes"><button type="submit" class="btn btn-sm btn-primary"><i class="bi bi-plus-lg" aria-hidden="true"></i> Registrar andamento</button></div>
    </form>`,
  });
}

/** AÇÃO: envio do "Registrar andamento" (data-on-submit; `this` = o <form>). */
async function fmAndamentoSalvar(abaId) {
  const ctx = fmCtx();
  const st = fmEstado(ctx, abaId);
  const form = this instanceof HTMLFormElement ? this : (st && st.el ? st.el.querySelector('form[data-fm-form="andamento"]') : null);
  if (!ctx || !form || !fmEhProcesso(ctx) || form.dataset.fmGravando === "1") return;
  const q = (id) => form.querySelector("#fmn-" + id);
  const data = q("data") ? q("data").value.trim() : "";
  const titulo = q("titulo") ? q("titulo").value.trim() : "";
  const descricao = q("descricao") ? q("descricao").value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { toast("Informe a data do andamento.", true); if (q("data")) q("data").focus(); return; }
  if (!titulo) { toast("Dê um título ao andamento.", true); if (q("titulo")) q("titulo").focus(); return; }
  fmOcupado(form, true);
  try {
    await api(`/api/processes/${fmEnc(ctx.processId)}/andamentos`, {
      method: "POST", body: JSON.stringify({ data, titulo, descricao: descricao || null }),
    });
    toast("Andamento registrado.");
    if (q("titulo")) q("titulo").value = "";
    if (q("descricao")) q("descricao").value = "";
    if (q("data")) q("data").value = ymd(new Date());
    fmMarcarRascunho("andamento", false);
    if (st) {
      if (st.rascunho) st.rascunho.andamento = null;
      // Garante que o andamento novo aparece (o filtro podia estar em "Prazos").
      if (st.filtro !== "tudo" && st.filtro !== "processuais") st.filtro = "processuais";
    }
    await fmRecarregar(ctx, "andamentos");
  } catch (e) {
    toast(e.message, true);                   // o que foi digitado fica
  } finally { fmOcupado(form, false); }
}

/* =========================================================
   8. PEÇAS COMUNS DAS DUAS FICHAS (cliente e processo)
   =========================================================
   O que as duas fichas mostram do MESMO jeito mora aqui, uma vez só: os
   KPIs, o "Complete a ficha", o menu "⋯" do celular e a pergunta "Marcar
   como cliente ativo?". Duas cópias divergem na primeira mudança — foi o que
   a revisão de uso real encontrou (mesmo dado, três formatos). */

/** Selo relativo de uma data. prazo=true: "Vence hoje"/"Vencido há 2 dias";
 *  audiência: "Hoje"/"Amanhã". Data pura ou data-hora, pelo dia LOCAL. */
function fmSeloRelativo(dataISO, prazo) {
  const n = fichaDiasAte(dataISO);
  if (n === null) return "";
  if (n < 0) return prazo ? uiChip("danger", n === -1 ? "Vencido há 1 dia" : `Vencido há ${-n} dias`, "bi-exclamation-octagon") : "";
  if (n === 0) return uiChip("warning", prazo ? "Vence hoje" : "Hoje", "bi-exclamation-triangle");
  if (n === 1) return uiChip(prazo ? "warning" : "info", prazo ? "Vence amanhã" : "Amanhã", "bi-clock");
  return uiChip(n <= 7 ? "info" : "neutral", `Em ${n} dias`, "bi-clock");
}

/** Valor grande com o selo pequeno embaixo (Próximo prazo e Próxima audiência). */
function fmKpiValorSelo(texto, selo) {
  return `<span class="fm-kpi-grande ficha-num">${esc(texto)}</span>${selo ? `<span class="fm-kpi-selo">${selo}</span>` : ""}`;
}

/** KPIs com a mesma régua nas duas fichas: vazio = "—" + dica curta; fonte que
 *  não carregou (null) = "—" + "Não foi possível carregar". `dicaDe(item)` é o
 *  texto de baixo, que cada ficha monta do seu jeito (descrição, processo…). */
const FM_KPI_FALHOU = "Não foi possível carregar";
function fmKpiPrazo(prazos, dicaDe) {
  const k = { icone: "bi-alarm", rotulo: "Próximo prazo", aba: "agenda", valor: "" };
  if (!Array.isArray(prazos)) return Object.assign(k, { dica: FM_KPI_FALHOU });
  const p = prazos.filter((x) => !x.done && fichaSoData(x.date))
    .sort((a, b) => fichaSoData(a.date).localeCompare(fichaSoData(b.date)) || (a.id - b.id))[0];
  if (!p) return Object.assign(k, { dica: "Sem prazo em aberto" });
  const n = fichaDiasAte(p.date);
  return Object.assign(k, {
    html: fmKpiValorSelo(fmtDate(fichaSoData(p.date)), fmSeloRelativo(p.date, true)),
    dica: dicaDe ? dicaDe(p) : "",
    tom: n < 0 ? "danger" : (n <= 1 ? "warning" : "info"),
  });
}
function fmKpiAudiencia(auds, dicaDe) {
  const k = { icone: "bi-calendar-event", rotulo: "Próxima audiência", aba: "agenda", valor: "" };
  if (!Array.isArray(auds)) return Object.assign(k, { dica: FM_KPI_FALHOU });
  const agora = fmAgoraLocal();
  const a = auds.filter((x) => fichaChaveData(x.date_time) >= agora)
    .sort((x, y) => fichaChaveData(x.date_time).localeCompare(fichaChaveData(y.date_time)))[0];
  if (!a) return Object.assign(k, { dica: "Nenhuma marcada" });
  return Object.assign(k, {
    html: fmKpiValorSelo(fmtDataHora(a.date_time), fmSeloRelativo(a.date_time, false)),
    dica: dicaDe ? dicaDe(a) : "", tom: "info",
  });
}
/** "A receber" pela régua do módulo Financeiro (pending_value, que já é a
 *  parte de quem vê; aberto = pendente > R$ 0,004). */
function fmKpiReceber(hons) {
  const k = { icone: "bi-cash-coin", rotulo: "A receber", aba: "financeiro", valor: "" };
  if (!Array.isArray(hons)) return Object.assign(k, { dica: FM_KPI_FALHOU });
  const hoje = ymd(new Date());
  let total = 0, venc = 0, n = 0;
  hons.forEach((h) => {
    const pend = fmHonPendente(h);
    if (pend <= 0.004) return;
    n += 1; total += pend;
    const d = fichaSoData(h.due_date);
    if (d && d < hoje) venc += pend;
  });
  if (!n) return Object.assign(k, { dica: "Nada a receber" });
  return Object.assign(k, {
    valor: fmtMoeda(total),
    dica: venc > 0.004 ? `${fmtMoeda(venc)} vencido` : (n === 1 ? "1 honorário em aberto" : `${n} honorários em aberto`),
    tom: venc > 0.004 ? "danger" : "success",
  });
}
/** "Último atendimento" / "Último andamento". `item` = {data} ou null;
 *  `carregou` = a fonte veio (senão "Não foi possível carregar"). */
function fmKpiUltimo(base, item, carregou, dica) {
  return Object.assign({ valor: item ? fmHaQuanto(item.data) : "" }, base, {
    dica: !carregou ? FM_KPI_FALHOU : (item ? dica || "" : "Nenhum ainda"),
  });
}

/** "Hoje" / "Ontem" / "Há 5 dias" (passado; depois de 90 dias, a data). */
function fmHaQuanto(dt) {
  const n = fichaDiasAte(dt);
  if (n === null) return "";
  if (n > 0) return fmtDate(fichaSoData(dt));
  if (n === 0) return "Hoje";
  if (n === -1) return "Ontem";
  return -n > 90 ? fmtDate(fichaSoData(dt)) : `Há ${-n} dias`;
}

/** "Complete a ficha" das duas fichas. itens: [{chave, rotulo, ok}];
 *  `acao`: AÇÃO registrada que recebe a chave do item pendente.
 *  Tudo feito → só um selo pequeno no lugar do cartão inteiro. */
function fmCompletarHtml(itens, acao) {
  const lista = (itens || []).filter(Boolean);
  const feitos = lista.filter((i) => i.ok).length;
  const total = lista.length;
  if (feitos === total) {
    return `<div class="fm-completa">${uiChip("success", "Ficha completa ✓", "", { titulo: "Todos os itens do guia de preenchimento estão feitos" })}</div>`;
  }
  const pct = Math.round((feitos * 100) / total);
  const lis = lista.map((i) => (i.ok
    ? `<li class="is-ok"><i class="bi bi-check-circle-fill" aria-hidden="true"></i><span>${esc(i.rotulo)}</span><span class="visually-hidden"> (feito)</span></li>`
    : `<li><button type="button" class="fm-completar-item" data-on-click="${esc(acao)}" data-args="${escArgs(i.chave)}"><i class="bi bi-circle" aria-hidden="true"></i><span>${esc(i.rotulo)}</span><i class="bi bi-chevron-right fm-completar-seta" aria-hidden="true"></i></button></li>`)).join("");
  return uiCard({
    titulo: "Complete a ficha",
    descricao: `${feitos} de ${total} · clique no que falta`,
    classe: "fm-completar",
    corpoHtml: `<div class="ficha-progresso" role="progressbar" aria-label="Ficha preenchida" aria-valuenow="${feitos}" aria-valuemin="0" aria-valuemax="${total}"><span style="width:${pct}%"></span></div>
      <ul class="fm-completar-lista">${lis}</ul>`,
  });
}

/** Celular: o "Excluir" (ações de perigo do cabeçalho) sai da fileira de
 *  botões e vai para um menu "⋯". A casca (ficha.js) só desenha botões; este
 *  complemento entra DEPOIS de cada desenho do topo — fichaRender e
 *  fichaAtualizarCabecalho; quem chama um dos dois chama isto também.
 *  No desktop o menu fica oculto e o botão continua onde estava (CSS). */
function fmTopoMenuMais() {
  const box = document.querySelector("#ficha-topo .ficha-cab-acoes");
  if (!box || box.querySelector(":scope > .fm-mais")) return;
  const perigos = [...box.querySelectorAll(":scope > .btn-ficha-perigo[data-on-click]")];
  if (!perigos.length) return;
  const dd = document.createElement("div");
  dd.className = "dropdown fm-mais";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-sm btn-ficha";
  btn.setAttribute("data-bs-toggle", "dropdown");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", "Mais ações");
  btn.title = "Mais ações";
  btn.innerHTML = '<i class="bi bi-three-dots" aria-hidden="true"></i>';
  const ul = document.createElement("ul");
  ul.className = "dropdown-menu dropdown-menu-end";
  perigos.forEach((b) => {
    b.classList.add("fm-so-largo");
    const li = document.createElement("li");
    const it = document.createElement("button");
    it.type = "button";
    it.className = "dropdown-item fm-mais-perigo";
    it.setAttribute("data-on-click", b.getAttribute("data-on-click"));
    if (b.hasAttribute("data-args")) it.setAttribute("data-args", b.getAttribute("data-args"));
    it.innerHTML = b.innerHTML;          // ícone + rótulo que a casca já escapou
    li.appendChild(it);
    ul.appendChild(li);
  });
  dd.append(btn, ul);
  box.appendChild(dd);
}

/** Cliente "Lead"/"Em negociação" que acabou de ganhar o 1º processo ou
 *  honorário: pergunta se já é cliente ativo e grava, se sim.
 *  → o cliente salvo, ou null (não perguntou, recusou ou falhou). */
async function fmPerguntarClienteAtivo(cliente) {
  if (!cliente || !cliente.id || !["lead", "negociacao"].includes(cliente.status) || !permCanEdit("clients")) return null;
  const r = await confirmar({
    titulo: `Marcar ${cliente.name || "este cliente"} como cliente ativo?`,
    texto: `Hoje o cadastro está como “${CLIENT_STATUS[cliente.status] || cliente.status}”. Com processo ou honorário lançado, normalmente ele já é cliente do escritório.`,
    botao: "Marcar como ativo", cancelar: "Agora não",
  });
  if (r !== "ok") return null;
  try {
    const salvo = await api(`/api/clients/${Number(cliente.id)}`, { method: "PUT", body: JSON.stringify({ status: "ativo" }) });
    await cacheGarantirCliente(salvo);
    toast(`${salvo.name || "Cliente"} agora é cliente ativo.`);
    return salvo;
  } catch (e) { toast(e.message, true); return null; }
}

/* =========================================================
   REGISTRO DE AÇÕES (allowlist do despachante — ver app.js)
   ========================================================= */
registrarAcoes({
  fmAgendaNovo, fmPrazoCumprido, fmPrazoEditar, fmAudEditar, fmExcluir,
  fmDocNovo, fmDocGerar,
  fmAtendimentoSalvar, fmAtendimentoModal, fmRascunho, fmAtRetorno,
  fmHonNovo, fmHonAbrir, fmHonTecla,
  fmTlFiltro, fmTlAbrir, fmPubLida, fmAndamentoSalvar,
});
