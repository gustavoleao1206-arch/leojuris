/* =========================================================
   ficha-cliente.js — lista de Clientes (renderClients, fase 2), busca
   rápida global da topbar (também da fase 2) e ficha do Cliente
   (fichaClienteAbrir, fase 3 — escrita DEPOIS do marcador "FICHA (fase 3)"
   no fim deste arquivo).

   Script clássico, mesmo escopo global do app.js e do ficha.js: todo nome
   de topo novo leva o prefixo fc* / FC_*, mais `renderClients` e `cliFiltro`
   (SPEC §2.3). Para a lista e a ficha não colidirem dentro do MESMO prefixo,
   a lista usa só `fcLista*`/`FC_LISTA*` e a busca global só `fcBg*`/`FC_BG*`
   — a ficha (fase 3) não deve usar esses dois começos.
   Estado global novo? Registre o reset em FICHA_LIMPEZA.
   ========================================================= */

/* =========================================================
   1. LISTA DE CLIENTES (#/clientes) — SPEC §4.1
   =========================================================
   Uma busca vai ao servidor (nome, e-mail e — com 3 dígitos ou mais — os
   DÍGITOS de CPF/CNPJ e telefones; ver clients.py::query_clients). O status
   é filtrado NO NAVEGADOR sobre o resultado da busca: assim as pílulas mostram
   a contagem de cada status sem uma consulta por pílula.
   A tela é redesenhada a cada `renderClients()` (navigate/roteador): voltar
   da ficha recarrega da API — o que a ficha salvou ou excluiu já aparece — e
   mantém os filtros, que moram em `cliFiltro`. */

/** Filtros da lista. GLOBAIS de propósito: sobrevivem a abrir a ficha e
 *  voltar. O export lê exatamente estes nomes (app.js::exportFiltros →
 *  {search: cliFiltro.busca, status: cliFiltro.status}). `busca` já vem sem
 *  espaços nas pontas — é o MESMO texto que a lista mandou à API, senão a
 *  planilha traria linhas que a tela não mostrou. Zerado no logout
 *  (FICHA_LIMPEZA, abaixo). */
let cliFiltro = { busca: "", status: "" };

/** Pílulas de status, na ordem da tela ("" = Todos). */
const FC_LISTA_STATUS = [
  ["", "Todos"], ["lead", "Leads"], ["negociacao", "Em negociação"], ["ativo", "Ativos"], ["arquivado", "Arquivados"],
];

/** Estado da TELA (não é filtro): o que veio da API e o que desenhar.
 *  `termo` = busca que gerou `dados` (evita reconsultar o mesmo texto);
 *  `voltarPara` = id da linha aberta, que recebe o foco quando a lista volta;
 *  `usuarios` = Promise<{id: nome}> da coluna Responsável (só admin). */
const FC_LISTA = { dados: null, erro: null, termo: null, usuarios: null, mapaUsuarios: {}, voltarPara: null };
const FC_LISTA_SEQ = fichaSeq();
const fcListaBuscaAdiada = fichaDebounce(() => fcListaCarregar(), 250);

FICHA_LIMPEZA.push(() => {
  cliFiltro = { busca: "", status: "" };
  fcListaBuscaAdiada.cancelar();
  FC_LISTA_SEQ.nova();               // resposta em voo do usuário anterior é descartada
  Object.assign(FC_LISTA, { dados: null, erro: null, termo: null, usuarios: null, mapaUsuarios: {}, voltarPara: null });
});

/** Entrada da tela (chamada pelo navigate/roteador). */
async function renderClients() {
  const c = document.getElementById("view-container");
  if (!c) return;
  fcBgGarantir();
  // Nada da visita anterior é reaproveitado: trocar de pílula durante o
  // carregamento mostraria o resultado de outra busca. Os nomes dos
  // responsáveis também são relidos a cada visita (não a cada tecla).
  Object.assign(FC_LISTA, { dados: null, erro: null, termo: null, usuarios: null });
  FC_LISTA_SEQ.nova();          // resposta em voo da visita anterior é descartada
  const podeNovo = permCanEdit("clients");
  c.innerHTML = `
    <div class="lista-v2 lista-clientes">
      <div class="lista-barra">
        <div class="lista-busca">
          <i class="bi bi-search" aria-hidden="true"></i>
          <input id="fc-lista-busca" type="search" class="form-control" autocomplete="off" spellcheck="false"
            placeholder="Buscar por nome, CPF/CNPJ, telefone ou e-mail"
            aria-label="Buscar clientes por nome, CPF/CNPJ, telefone ou e-mail"
            value="${esc(cliFiltro.busca)}" data-on-input="fcListaBuscaInput" data-on-keydown="fcListaBuscaTecla">
        </div>
        <div class="lista-acoes">
          ${typeof exportBtn === "function" ? exportBtn("clientes") : ""}
          ${podeNovo ? `<a class="btn btn-primary" href="#/clientes/novo" data-on-click="fichaIr" data-args="${escArgs("#/clientes/novo")}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo cliente</a>` : ""}
        </div>
      </div>
      <div class="lista-filtros">
        <div class="lista-pilulas" id="fc-lista-pilulas" role="group" aria-label="Filtrar por status">${fcListaPilulasHtml()}</div>
        <span class="lista-total" id="fc-lista-total" aria-live="polite"></span>
      </div>
      <div id="fc-lista-resultado" class="lista-resultado" aria-busy="true">${uiCarregando("Carregando clientes…")}</div>
    </div>`;
  fcListaAtualizarSelo();     // sobre o DOM novo (o selo do exportBtn nasce oculto)
  await fcListaCarregar();
}

/** Busca no servidor (com o texto de `cliFiltro.busca`) e redesenha.
 *  fichaSeq: a resposta de "ana" chegando depois da de "anaclara" é jogada
 *  fora — senão a tabela mostraria o resultado velho para o texto novo. */
async function fcListaCarregar() {
  const n = FC_LISTA_SEQ.nova();
  const termo = cliFiltro.busca;
  const res = document.getElementById("fc-lista-resultado");
  if (res) { res.classList.add("is-carregando"); res.setAttribute("aria-busy", "true"); }
  let dados = null;
  let mapa = {};
  let erro = null;
  try {
    [dados, mapa] = await Promise.all([
      api("/api/clients" + (termo ? "?search=" + encodeURIComponent(termo) : "")),
      fcListaUsuarios(),
    ]);
  } catch (e) { erro = e; }
  if (!FC_LISTA_SEQ.atual(n)) return;
  FC_LISTA.erro = erro;
  FC_LISTA.dados = erro ? null : (Array.isArray(dados) ? dados : []);
  FC_LISTA.termo = erro ? null : termo;
  FC_LISTA.mapaUsuarios = mapa || {};
  fcListaDesenhar();
}

/** id → nome de quem é responsável (coluna só do admin; só ele lista
 *  usuários). Uma consulta por visita à lista (renderClients zera o cache). */
function fcListaUsuarios() {
  if (!permIsAdmin()) return Promise.resolve({});
  if (!FC_LISTA.usuarios) {
    FC_LISTA.usuarios = api("/api/auth/users")
      .then((us) => {
        const m = {};
        (Array.isArray(us) ? us : []).forEach((u) => { m[u.id] = u.name; });
        return m;
      })
      .catch(() => { FC_LISTA.usuarios = null; return {}; });   // tenta de novo na próxima
  }
  return FC_LISTA.usuarios;
}

/** Desenha pílulas, total e tabela a partir de FC_LISTA + cliFiltro.status
 *  (o status não vai ao servidor: trocar de pílula não consulta a API). */
function fcListaDesenhar() {
  const res = document.getElementById("fc-lista-resultado");
  if (!res) return;                       // a pessoa já saiu da lista
  const total = document.getElementById("fc-lista-total");
  if (FC_LISTA.erro) {
    res.classList.remove("is-carregando"); res.removeAttribute("aria-busy");
    fcListaPilulasAtualizar(null);
    if (total) total.textContent = "";
    res.innerHTML = uiVazio({
      icone: "bi-exclamation-triangle",
      titulo: "Não foi possível carregar os clientes",
      texto: (FC_LISTA.erro && FC_LISTA.erro.message) || "Tente novamente em instantes.",
      acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fcListaRecarregar"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Tentar novamente</button>`,
    });
    return;
  }
  if (!FC_LISTA.dados) { fcListaPilulasAtualizar(null); return; }   // ainda carregando
  res.classList.remove("is-carregando"); res.removeAttribute("aria-busy");
  const todos = FC_LISTA.dados;
  const cont = { "": todos.length };
  todos.forEach((c) => { cont[c.status] = (cont[c.status] || 0) + 1; });
  fcListaPilulasAtualizar(cont);
  const lista = cliFiltro.status ? todos.filter((c) => c.status === cliFiltro.status) : todos;
  if (total) {
    total.textContent = cliFiltro.status
      ? `${lista.length} de ${fcListaPlural(todos.length, "cliente", "clientes")}`
      : fcListaPlural(todos.length, "cliente", "clientes");
  }
  res.innerHTML = lista.length ? fcListaTabelaHtml(lista) : fcListaVazioHtml(todos.length);
  fcListaFocarVolta();
}

function fcListaPlural(n, um, varios) { return `${n} ${n === 1 ? um : varios}`; }

function fcListaPilulasHtml() {
  return FC_LISTA_STATUS.map(([st, rotulo]) =>
    `<button type="button" class="lista-pilula" data-status="${esc(st)}" aria-pressed="${cliFiltro.status === st ? "true" : "false"}" data-on-click="fcListaStatus" data-args="${escArgs(st)}">${esc(rotulo)}<span class="lista-pilula-cont" hidden></span></button>`).join("");
}

/** Atualiza as pílulas NO LUGAR (sem innerHTML): quem trocou de status pelo
 *  teclado continua com o foco no botão. cont = {status: n, "": total} | null. */
function fcListaPilulasAtualizar(cont) {
  document.querySelectorAll("#fc-lista-pilulas .lista-pilula").forEach((b) => {
    const st = b.dataset.status || "";
    b.setAttribute("aria-pressed", st === cliFiltro.status ? "true" : "false");
    const s = b.querySelector(".lista-pilula-cont");
    if (!s) return;
    const n = cont ? (cont[st] || 0) : null;
    s.hidden = n === null;
    s.textContent = n === null ? "" : String(n);
  });
}

function fcListaTabelaHtml(lista) {
  const ctx = { admin: permIsAdmin(), verProc: permCanView("processes"), mapa: FC_LISTA.mapaUsuarios || {} };
  return `<div class="lista-card"><div class="table-responsive">
    <table class="table table-hover lista-tabela ficha-tabela mb-0">
      <thead><tr>
        <th scope="col">Cliente</th>
        <th scope="col">Contato</th>
        ${ctx.verProc ? '<th scope="col" class="text-center">Processos</th>' : ""}
        <th scope="col">Status</th>
        ${ctx.admin ? '<th scope="col">Responsável</th>' : ""}
        <th scope="col" class="lista-col-desde">Desde</th>
      </tr></thead>
      <tbody>${lista.map((c) => fcListaLinhaHtml(c, ctx)).join("")}</tbody>
    </table></div></div>`;
}

/** Uma linha. A linha inteira abre a ficha; tudo que é clicável DENTRO dela
 *  tem `data-on-click` próprio (a delegação do app.js pega o elemento mais
 *  próximo, então o clique no WhatsApp não chega à linha):
 *    - nome: link para a ficha (Ctrl/meio-clique abre em outra aba), fora da
 *      ordem do Tab (tabindex=-1) porque a linha já é focável;
 *    - WhatsApp / e-mail: `acNada`, SEM data-prevent — o link abre normal. */
function fcListaLinhaHtml(c, ctx) {
  const id = Number(c.id);
  const hash = "#/clientes/" + id;
  const dig = fichaDigitos(c.cpf_cnpj);
  const tipo = c.tipo_pessoa === "PF" || c.tipo_pessoa === "PJ" ? c.tipo_pessoa
    : (dig.length === 14 ? "PJ" : (dig.length === 11 ? "PF" : ""));
  const temDoc = c.cpf_cnpj !== null && c.cpf_cnpj !== undefined && String(c.cpf_cnpj).trim() !== "";
  const semDoc = tipo === "PJ" ? "Sem CNPJ" : (tipo === "PF" ? "Sem CPF" : "Sem CPF/CNPJ");
  const doc = temDoc
    ? `${tipo ? esc(tipo) + " · " : ""}<span class="ficha-num">${esc(fmtDoc(c.cpf_cnpj))}</span>`
    : `<span class="lista-sem-doc">${tipo ? esc(tipo) + " · " : ""}${semDoc}</span>`;
  const fantasia = tipo === "PJ" && c.nome_fantasia ? `<span class="lista-fantasia">${esc(c.nome_fantasia)}</span>` : "";

  const tel = [c.celular, c.phone, c.whatsapp, c.telefone_secundario].find((t) => t && String(t).trim()) || "";
  const w = fmtWhats(c.whatsapp) || fmtWhats(c.celular) || fmtWhats(c.phone);
  const email = fcListaEmail(c.email);
  const atalhos = (w ? `<a class="lista-atalho is-whats" href="https://wa.me/${w}" target="_blank" rel="noopener noreferrer" data-on-click="acNada" title="Abrir conversa no WhatsApp" aria-label="WhatsApp de ${esc(c.name)}"><i class="bi bi-whatsapp" aria-hidden="true"></i></a>` : "") +
    (email ? `<a class="lista-atalho" href="mailto:${esc(email)}" data-on-click="acNada" title="Escrever para ${esc(email)}" aria-label="E-mail para ${esc(c.name)}"><i class="bi bi-envelope" aria-hidden="true"></i></a>` : "");
  const contato = tel ? `<span class="ficha-num text-nowrap">${esc(fmtTel(tel))}</span>`
    : (email ? `<span class="lista-email">${esc(email)}</span>` : '<span class="ficha-traco">—</span>');

  const procs = c.processos_count === null || c.processos_count === undefined
    ? '<span class="ficha-traco">—</span>' : `<span class="ficha-num">${esc(c.processos_count)}</span>`;
  const resp = c.owner_id
    ? `<span class="lista-resp">${uiAvatar(ctx.mapa[c.owner_id] || "?")}<span>${esc(ctx.mapa[c.owner_id] || "Usuário #" + c.owner_id)}</span></span>`
    : '<span class="ficha-traco">Sem responsável</span>';

  return `<tr class="lista-linha" tabindex="0" data-id="${id}" data-on-click="fcListaAbrir" data-on-keydown="fcListaTecla" data-args="${escArgs(id)}">
    <td class="lista-td-titulo" data-rotulo="Cliente"><div class="lista-ident">${uiAvatar(c.name)}<div class="lista-ident-txt">
      <a class="lista-nome" href="${hash}" tabindex="-1" data-on-click="fcListaAbrir" data-args="${escArgs(id)}">${esc(c.name)}</a>${fantasia}
      <div class="lista-sub">${doc}</div></div></div></td>
    <td data-rotulo="Contato"><div class="lista-cel lista-contato">${contato}${atalhos ? `<span class="lista-atalhos">${atalhos}</span>` : ""}</div></td>
    ${ctx.verProc ? `<td data-rotulo="Processos" class="text-center"><div class="lista-cel">${procs}</div></td>` : ""}
    <td data-rotulo="Status"><div class="lista-cel">${uiStatusCliente(c.status)}</div></td>
    ${ctx.admin ? `<td data-rotulo="Responsável"><div class="lista-cel">${resp}</div></td>` : ""}
    <td data-rotulo="Desde" class="lista-col-desde"><div class="lista-cel ficha-num text-nowrap">${esc(fcListaDesde(c.created_at)) || '<span class="ficha-traco">—</span>'}</div></td>
  </tr>`;
}

/** E-mail que dá para usar em mailto: — a régua é a do núcleo
 *  (fichaEmailValido, a mesma do uiContatoRapido): a regex frouxa de antes
 *  deixava passar "x@y.z?bcc=…", que vira destinatário escondido no mailto. */
function fcListaEmail(e) {
  const s = typeof e === "string" ? e.trim() : "";
  if (typeof fichaEmailValido === "function") return fichaEmailValido(s) ? s : "";
  return /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s) ? s : "";
}

/** "Cliente desde": created_at é gravado em UTC SEM fuso (datetime.utcnow).
 *  Lido como UTC e mostrado na data LOCAL — senão quem cadastrou às 22h de
 *  Brasília apareceria como cliente desde "amanhã". */
function fcListaDesde(iso) {
  if (!iso) return "";
  const s = String(iso).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
  const comFuso = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(comFuso);
  if (isNaN(d.getTime())) return fmtDataHora(s).slice(0, 10);
  return fmtDate(ymd(d));
}

/** Vazio que orienta: sem cadastro nenhum, busca sem resultado, ou status
 *  sem ninguém (com N em outros status). */
function fcListaVazioHtml(totalBusca) {
  const podeNovo = permCanEdit("clients");
  const novo = podeNovo ? `<a class="btn btn-sm btn-primary" href="#/clientes/novo" data-on-click="fichaIr" data-args="${escArgs("#/clientes/novo")}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo cliente</a>` : "";
  if (totalBusca > 0) {
    const rotulo = (FC_LISTA_STATUS.find(([s]) => s === cliFiltro.status) || ["", "este status"])[1];
    return uiVazio({
      icone: "bi-funnel",
      titulo: `Nenhum cliente em “${rotulo}”`,
      texto: `${totalBusca === 1 ? "Há 1 cliente" : `Há ${totalBusca} clientes`} em outros status${cliFiltro.busca ? " para esta busca" : ""}.`,
      acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fcListaStatus" data-args="${escArgs("")}">Ver todos</button>`,
    });
  }
  if (cliFiltro.busca) {
    return uiVazio({
      icone: "bi-search",
      titulo: "Nenhum cliente encontrado",
      texto: `Nada corresponde a “${cliFiltro.busca}”. Confira a grafia, ou busque pelo CPF/CNPJ, telefone ou e-mail (para números, digite ao menos 3 dígitos).`,
      acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fcListaLimparBusca"><i class="bi bi-x-lg" aria-hidden="true"></i> Limpar busca</button>${novo}`,
    });
  }
  return uiVazio({
    icone: "bi-people",
    titulo: "Nenhum cliente cadastrado ainda",
    texto: podeNovo
      ? "Cadastre o primeiro cliente. Depois de salvar, a ficha dele guia o preenchimento de processos, prazos, atendimentos e documentos."
      : "Quando houver clientes sob a sua responsabilidade, eles aparecem aqui.",
    acaoHtml: novo,
  });
}

/** Depois de voltar da ficha: a linha que foi aberta recebe o foco (e entra
 *  na tela, se estiver fora). Uma vez só — a próxima busca não rouba o foco. */
function fcListaFocarVolta() {
  const id = FC_LISTA.voltarPara;
  FC_LISTA.voltarPara = null;
  if (!id) return;
  const tr = document.querySelector(`#fc-lista-resultado tr[data-id="${Number(id)}"]`);
  fcListaFocarLinha(tr);
}
function fcListaFocarLinha(tr) {
  if (!tr) return;
  try { tr.focus({ preventScroll: true }); } catch (e) { tr.focus(); }
  const r = tr.getBoundingClientRect();
  if (r.top < 70 || r.bottom > window.innerHeight) tr.scrollIntoView({ block: "center" });
}

function fcListaAtualizarSelo() {
  if (typeof exportAtualizarSelo === "function") exportAtualizarSelo("clientes");
}

/* --- ações da lista (registradas no fim da seção) --- */

/** Digitação na busca: debounce de 250 ms; mesmo texto não reconsulta. */
function fcListaBuscaInput() {
  cliFiltro.busca = String(this.value || "").trim();
  fcListaAtualizarSelo();
  if (cliFiltro.busca === FC_LISTA.termo && FC_LISTA.dados) {
    // Voltou ao texto que já está na tela: nada a buscar — e a consulta de
    // um texto intermediário que ainda esteja em voo é descartada.
    fcListaBuscaAdiada.cancelar();
    FC_LISTA_SEQ.nova();
    fcListaDesenhar();
    return;
  }
  fcListaBuscaAdiada();
}

/** Enter busca na hora; Esc limpa; seta para baixo desce para a 1ª linha. */
function fcListaBuscaTecla() {
  const ev = eventoAtual();
  if (!ev) return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    fcListaBuscaAdiada.cancelar();
    cliFiltro.busca = String(this.value || "").trim();
    fcListaCarregar();
  } else if (ev.key === "Escape" && this.value) {
    ev.preventDefault();
    this.value = "";
    fcListaBuscaInput.call(this);
  } else if (ev.key === "ArrowDown") {
    const tr = document.querySelector("#fc-lista-resultado tr.lista-linha");
    if (tr) { ev.preventDefault(); fcListaFocarLinha(tr); }
  }
}

function fcListaStatus(st) {
  cliFiltro.status = FC_LISTA_STATUS.some(([s]) => s === st) ? st : "";
  fcListaDesenhar();
  fcListaAtualizarSelo();
}

function fcListaRecarregar() { fcListaCarregar(); }

function fcListaLimparBusca() {
  cliFiltro.busca = "";
  const i = document.getElementById("fc-lista-busca");
  if (i) { i.value = ""; i.focus(); }
  fcListaBuscaAdiada.cancelar();
  fcListaAtualizarSelo();
  fcListaCarregar();
}

/** Seleção de texto dentro da linha? (arrastar para copiar um telefone não
 *  pode abrir a ficha no soltar do mouse). */
function fcListaTemSelecao(el) {
  const s = window.getSelection ? window.getSelection() : null;
  return !!(s && !s.isCollapsed && s.anchorNode && el.contains(s.anchorNode));
}

/** Clique na linha (ou no nome): abre a ficha. Ctrl/⌘/Shift abre em outra
 *  aba — no nome o próprio navegador faz isso (o link tem href); na linha,
 *  window.open. */
function fcListaAbrir(id) {
  const ev = eventoAtual();
  const hash = "#/clientes/" + Number(id);
  const link = this instanceof HTMLAnchorElement;
  if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
    if (!link) window.open(location.pathname + location.search + hash, "_blank", "noopener");
    return;
  }
  if (!link && fcListaTemSelecao(this)) return;
  if (ev && link) ev.preventDefault();
  FC_LISTA.voltarPara = Number(id);
  irPara(hash);
}

/** Teclado na linha: Enter abre — SÓ quando o foco está na própria <tr>
 *  (Enter no link do WhatsApp segue o link, não abre a ficha). Setas
 *  andam entre as linhas; seta para cima na 1ª volta para a busca. */
function fcListaTecla(id) {
  const ev = eventoAtual();
  if (!ev || ev.target !== this) return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    FC_LISTA.voltarPara = Number(id);
    irPara("#/clientes/" + Number(id));
  } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const alvo = ev.key === "ArrowDown" ? this.nextElementSibling : this.previousElementSibling;
    if (alvo) fcListaFocarLinha(alvo);
    else if (ev.key === "ArrowUp") { const i = document.getElementById("fc-lista-busca"); if (i) i.focus(); }
  }
}

registrarAcoes({
  fcListaBuscaInput, fcListaBuscaTecla, fcListaStatus, fcListaRecarregar, fcListaLimparBusca,
  fcListaAbrir, fcListaTecla,
});

/* =========================================================
   2. BUSCA RÁPIDA GLOBAL (topbar, desktop) — SPEC §4.1
   =========================================================
   Campo "Buscar cliente ou processo" injetado na .topbar por JS (o
   index.html tem scripts com hash na CSP e não é editado por este arquivo).

   Como entra na tela (a forma mais robusta das três possíveis):
     - é criado UMA vez, no DOMContentLoaded — a .topbar é HTML estático e
       já existe; o #app só fica visível depois do login, então o campo nunca
       aparece na tela de login;
     - um MutationObserver no `class` do #app acompanha login/logout
       (startApp tira o d-none; logout põe): mostra o campo conforme a
       permissão do NOVO usuário e, ao sair, apaga texto e resultados — a
       busca de quem saiu não fica na tela de quem entra;
     - renderClients/renderProcesses chamam fcBgGarantir() como rede de
       proteção (idempotente).
   Pendurar no startApp exigiria editar o app.js (de outro dono), e injetar
   só na 1ª lista deixaria o campo sumido para quem entra pelo dashboard.

   Consulta as MESMAS rotas das listas (/api/clients?search= e
   /api/processes?q=), cada uma só se o usuário tem o módulo; até 5 de cada.
   Teclado: Ctrl+K (⌘K) foca; ↑/↓ escolhem; Enter abre; Esc fecha/limpa.
   Abaixo de 992px o campo some (CSS) e o Ctrl+K volta a ser do navegador. */

const FC_BG_MAX = 5;
const FC_BG = { termo: "", buscado: null, emVoo: null, itens: [], ativo: -1, carregando: false, abrirPrimeiro: false };
const FC_BG_SEQ = fichaSeq();
const fcBgAdiada = fichaDebounce(() => fcBgBuscar(), 250);

FICHA_LIMPEZA.push(() => fcBgLimpar());

/** Cria o campo na topbar (uma vez) e acerta a visibilidade. */
function fcBgGarantir() {
  let box = document.getElementById("fc-bg");
  if (!box) {
    const topbar = document.querySelector(".main-content > .topbar") || document.querySelector(".topbar");
    if (!topbar) return;
    const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
    box = document.createElement("div");
    box.id = "fc-bg";
    box.className = "fc-bg";
    box.setAttribute("role", "search");
    box.hidden = true;
    box.innerHTML = `
      <i class="bi bi-search fc-bg-lupa" aria-hidden="true"></i>
      <input id="fc-bg-input" class="form-control fc-bg-input" type="search" autocomplete="off" spellcheck="false"
        placeholder="Buscar cliente ou processo" aria-label="Busca rápida de clientes e processos (atalho ${mac ? "⌘K" : "Ctrl+K"})"
        role="combobox" aria-expanded="false" aria-controls="fc-bg-painel" aria-autocomplete="list"
        data-on-input="fcBgInput" data-on-keydown="fcBgTecla">
      <kbd class="fc-bg-kbd" aria-hidden="true">${mac ? "⌘ K" : "Ctrl K"}</kbd>
      <div id="fc-bg-painel" class="fc-bg-painel" role="listbox" aria-label="Resultados da busca rápida" hidden></div>`;
    const chip = topbar.querySelector(".user-chip");
    topbar.insertBefore(box, chip || null);
    const painel = box.querySelector("#fc-bg-painel");
    const input = box.querySelector("#fc-bg-input");
    // Clicar num resultado não pode tirar o foco do campo antes do click
    // chegar (o focusout fecharia o painel e o clique cairia no vazio).
    painel.addEventListener("mousedown", (e) => e.preventDefault());
    input.addEventListener("focus", () => {
      if (FC_BG.itens.length && FC_BG.buscado === FC_BG.termo && FC_BG.termo.length >= 2) fcBgAbrirPainel();
    });
    box.addEventListener("focusout", (e) => {
      if (!box.contains(e.relatedTarget)) fcBgFechar();
    });
  }
  fcBgSincronizar();
}

/** Mostra o campo só para quem está logado e tem Clientes ou Processos. */
function fcBgSincronizar() {
  const box = document.getElementById("fc-bg");
  if (!box) return;
  const app = document.getElementById("app");
  const logado = !!(TOKEN && CURRENT_USER) && !(app && app.classList.contains("d-none"));
  const cli = logado && permCanView("clients");
  const proc = logado && permCanView("processes");
  box.hidden = !(cli || proc);
  const input = document.getElementById("fc-bg-input");
  if (input && (cli || proc)) {
    input.placeholder = "Buscar " + (cli && proc ? "cliente ou processo" : (cli ? "cliente" : "processo"));
  }
  if (!logado) fcBgLimpar();
}

/** Zera texto, resultados e consultas em voo (logout e depois de abrir). */
function fcBgLimpar() {
  fcBgAdiada.cancelar();
  FC_BG_SEQ.nova();
  Object.assign(FC_BG, { termo: "", buscado: null, emVoo: null, itens: [], ativo: -1, carregando: false, abrirPrimeiro: false });
  const input = document.getElementById("fc-bg-input");
  if (input) input.value = "";
  const painel = document.getElementById("fc-bg-painel");
  if (painel) painel.innerHTML = "";
  fcBgFechar();
}

function fcBgAberto() {
  const p = document.getElementById("fc-bg-painel");
  return !!(p && !p.hidden);
}
function fcBgAbrirPainel() {
  const p = document.getElementById("fc-bg-painel");
  const i = document.getElementById("fc-bg-input");
  if (p) p.hidden = false;
  if (i) i.setAttribute("aria-expanded", "true");
}
function fcBgFechar() {
  const p = document.getElementById("fc-bg-painel");
  const i = document.getElementById("fc-bg-input");
  if (p) p.hidden = true;
  if (i) { i.setAttribute("aria-expanded", "false"); i.removeAttribute("aria-activedescendant"); }
  FC_BG.ativo = -1;
  if (p) p.querySelectorAll(".fc-bg-item.is-ativo").forEach((e) => { e.classList.remove("is-ativo"); e.setAttribute("aria-selected", "false"); });
}
/** Troca o conteúdo do painel. Só ABRE se o campo ainda tem o foco: a
 *  resposta que chega depois de a pessoa sair do campo não pula na tela. */
function fcBgPainelHtml(html) {
  const p = document.getElementById("fc-bg-painel");
  if (!p) return;
  p.innerHTML = html;
  if (document.activeElement === document.getElementById("fc-bg-input")) fcBgAbrirPainel();
}

/** AÇÃO: digitação no campo global. Menos de 2 caracteres não busca. */
function fcBgInput() {
  FC_BG.termo = String(this.value || "").trim();
  FC_BG.ativo = -1;
  FC_BG.abrirPrimeiro = false;
  if (FC_BG.termo.length < 2) {
    fcBgAdiada.cancelar();
    FC_BG_SEQ.nova();
    FC_BG.itens = []; FC_BG.buscado = null; FC_BG.carregando = false;
    fcBgFechar();
    return;
  }
  if (FC_BG.termo === FC_BG.buscado && !FC_BG.carregando) { fcBgAdiada.cancelar(); fcBgAbrirPainel(); return; }
  fcBgAdiada();
}

async function fcBgBuscar() {
  const termo = FC_BG.termo;
  if (termo.length < 2 || !CURRENT_USER) return;
  const cli = permCanView("clients");
  const proc = permCanView("processes");
  if (!cli && !proc) return;
  const n = FC_BG_SEQ.nova();
  FC_BG.carregando = true;
  FC_BG.emVoo = termo;
  if (!FC_BG.itens.length || FC_BG.buscado === null) {
    fcBgPainelHtml(`<div class="fc-bg-msg">${uiCarregando("Buscando…")}</div>`);
  }
  const q = encodeURIComponent(termo);
  const [rc, rp] = await Promise.allSettled([
    cli ? api("/api/clients?search=" + q) : Promise.resolve(null),
    proc ? api("/api/processes?q=" + q) : Promise.resolve(null),
  ]);
  if (!FC_BG_SEQ.atual(n)) return;       // chegou digitação nova depois desta
  FC_BG.carregando = false;
  FC_BG.buscado = termo;
  FC_BG.ativo = -1;
  const itens = [];
  const grupos = [];
  const montar = (entidade, titulo, r, itemHtml, hashDe) => {
    if (r.status !== "fulfilled") {
      grupos.push(`<div class="fc-bg-grupo">${esc(titulo)}</div><div class="fc-bg-msg is-erro">Não foi possível buscar ${entidade === "clientes" ? "clientes" : "processos"} agora.</div>`);
      return;
    }
    const lista = Array.isArray(r.value) ? r.value : [];
    if (!lista.length) return;
    let html = `<div class="fc-bg-grupo" role="presentation">${esc(titulo)}<span class="fc-bg-grupo-n">${lista.length}</span></div>`;
    lista.slice(0, FC_BG_MAX).forEach((x) => {
      const i = itens.length;
      const hash = hashDe(x);
      itens.push({ hash });
      html += `<a class="fc-bg-item" id="fc-bg-op-${i}" role="option" aria-selected="false" tabindex="-1" href="${hash}" data-on-click="fcBgAbrir" data-args="${escArgs(i)}">${itemHtml(x)}</a>`;
    });
    if (lista.length > FC_BG_MAX) {
      const i = itens.length;
      itens.push({ verTodos: entidade });
      html += `<button type="button" class="fc-bg-item fc-bg-todos" id="fc-bg-op-${i}" role="option" aria-selected="false" tabindex="-1" data-on-click="fcBgAbrir" data-args="${escArgs(i)}"><i class="bi bi-arrow-right" aria-hidden="true"></i> Ver todos os ${lista.length} ${entidade === "clientes" ? "clientes" : "processos"}</button>`;
    }
    grupos.push(html);
  };
  if (cli) montar("clientes", "Clientes", rc, fcBgItemCliente, (c) => "#/clientes/" + Number(c.id));
  if (proc) montar("processos", "Processos", rp, (p) => fcBgItemProcesso(p, termo), (p) => "#/processos/" + Number(p.id));
  FC_BG.itens = itens;
  fcBgPainelHtml(grupos.length ? grupos.join("")
    : `<div class="fc-bg-msg">Nada encontrado para “${esc(termo)}”.</div>`);
  if (FC_BG.abrirPrimeiro) {
    FC_BG.abrirPrimeiro = false;
    if (itens.length) fcBgExecutar(0);
  }
}

function fcBgItemCliente(c) {
  const dig = fichaDigitos(c.cpf_cnpj);
  const tel = [c.celular, c.phone, c.whatsapp].find((t) => t && String(t).trim()) || "";
  const sub = [dig ? fmtDoc(c.cpf_cnpj) : "", tel ? fmtTel(tel) : "", CLIENT_STATUS[c.status] || ""].filter(Boolean).join(" · ");
  return `${uiAvatar(c.name)}<span class="fc-bg-txt"><span class="fc-bg-titulo">${esc(c.name)}</span>${sub ? `<span class="fc-bg-sub ficha-num">${esc(sub)}</span>` : ""}</span>`;
}

/** Texto para comparar busca: sem acento e sem caixa. */
function fcBgNormal(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

/** Processo achado pela PARTE CONTRÁRIA (o termo não está no número nem no
 *  cliente): o resultado mostra a parte — "Maria × INSS" — senão a pessoa
 *  não entende por que aquele processo apareceu. */
function fcBgItemProcesso(p, termo) {
  const num = p.case_number && String(p.case_number).trim() ? fmtCnj(p.case_number) : "";
  const area = typeof procAreaLabel === "function" && p.type ? procAreaLabel(p.type) : "";
  const t = fcBgNormal(termo).trim();
  let contra = "";
  if (t && p.partes_contrarias && !fcBgNormal(p.client_name).includes(t)) {
    contra = String(p.partes_contrarias).split(/\s*,\s*/).find((n) => fcBgNormal(n).includes(t)) || "";
  }
  const partes = [p.client_name, contra ? "× " + contra : ""].filter(Boolean).join(" ");
  const sub = [partes, area, fichaRotulo("processoStatus", p.status)].filter(Boolean).join(" · ");
  return `<span class="fc-bg-ic" aria-hidden="true"><i class="bi bi-folder2-open"></i></span><span class="fc-bg-txt"><span class="fc-bg-titulo${num ? " ficha-num" : " fc-bg-sem-num"}">${esc(num || "Processo sem número")}</span>${sub ? `<span class="fc-bg-sub">${esc(sub)}</span>` : ""}</span>`;
}

/** Abre o item i: ficha (hash) ou "ver todos" (lista já filtrada pela busca).
 *  "Ver todos" troca o filtro GLOBAL da lista: a guarda de alteração não
 *  salva roda ANTES — quem escolhe "Continuar editando" fica onde estava e a
 *  lista não muda de filtro pelas costas dele. */
async function fcBgExecutar(i) {
  const it = FC_BG.itens[i];
  if (!it) return;
  const termo = FC_BG.termo;
  const input = document.getElementById("fc-bg-input");
  fcBgLimpar();
  if (input) input.blur();
  if (it.verTodos && !(await fichaPodeSair())) return;
  if (it.verTodos === "clientes") {
    cliFiltro = { busca: termo, status: "" };
    irPara("#/clientes");
  } else if (it.verTodos === "processos") {
    // A busca global não aplica status nem os outros filtros: a lista abre
    // igual, para os números baterem com o que a busca mostrou.
    if (typeof procFiltro !== "undefined") {
      procFiltro = Object.assign({}, typeof FP_LISTA_PADRAO !== "undefined" ? FP_LISTA_PADRAO : {}, { busca: termo, status: "" });
    }
    irPara("#/processos");
  } else if (fichaHashSeguro(it.hash)) {
    irPara(it.hash);
  }
}

/** AÇÃO: clique num resultado. Ctrl/⌘/Shift no link segue o padrão do
 *  navegador (abre em outra aba). */
function fcBgAbrir(i) {
  const ev = eventoAtual();
  const it = FC_BG.itens[Number(i)];
  if (!it) return;
  if (it.hash && ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) return;
  if (ev) ev.preventDefault();
  fcBgExecutar(Number(i));
}

function fcBgMarcarAtivo() {
  const input = document.getElementById("fc-bg-input");
  document.querySelectorAll("#fc-bg-painel .fc-bg-item").forEach((el) => {
    const on = el.id === "fc-bg-op-" + FC_BG.ativo;
    el.classList.toggle("is-ativo", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
    if (on) {
      el.scrollIntoView({ block: "nearest" });
      if (input) input.setAttribute("aria-activedescendant", el.id);
    }
  });
}

/** AÇÃO: teclado no campo global. */
function fcBgTecla() {
  const ev = eventoAtual();
  if (!ev) return;
  const k = ev.key;
  if (k === "ArrowDown" || k === "ArrowUp") {
    const n = FC_BG.itens.length;
    if (!n || FC_BG.buscado !== FC_BG.termo) return;
    ev.preventDefault();
    if (!fcBgAberto()) fcBgAbrirPainel();
    const d = k === "ArrowDown" ? 1 : -1;
    FC_BG.ativo = FC_BG.ativo < 0 ? (d > 0 ? 0 : n - 1) : (FC_BG.ativo + d + n) % n;
    fcBgMarcarAtivo();
  } else if (k === "Enter") {
    ev.preventDefault();
    if (FC_BG.termo.length < 2) return;
    // Enter antes de a busca chegar: busca já e abre o 1º resultado.
    if (FC_BG.buscado !== FC_BG.termo || FC_BG.carregando) {
      FC_BG.abrirPrimeiro = true;
      fcBgAdiada.cancelar();
      if (!(FC_BG.carregando && FC_BG.emVoo === FC_BG.termo)) fcBgBuscar();   // a mesma já está em voo: só espera
      return;
    }
    if (FC_BG.itens.length) fcBgExecutar(FC_BG.ativo >= 0 ? FC_BG.ativo : 0);
  } else if (k === "Escape") {
    ev.preventDefault();
    if (fcBgAberto()) fcBgFechar();
    else if (this.value) { this.value = ""; fcBgInput.call(this); }
    else this.blur();
  }
}

/** Ctrl+K / ⌘K: foca a busca global — só quando ela está na tela (desktop,
 *  logado, com permissão) e não há janela modal aberta por cima. */
document.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
  if (String(ev.key || "").toLowerCase() !== "k") return;
  const box = document.getElementById("fc-bg");
  const input = document.getElementById("fc-bg-input");
  if (!box || box.hidden || !input || input.offsetParent === null) return;
  if (document.querySelector(".modal.show, dialog[open]")) return;
  ev.preventDefault();
  input.focus();
  input.select();
});

/** Clique fora fecha o painel. */
document.addEventListener("pointerdown", (ev) => {
  if (!fcBgAberto()) return;
  const box = document.getElementById("fc-bg");
  if (box && ev.target instanceof Node && !box.contains(ev.target)) fcBgFechar();
});

function fcBgIniciar() {
  fcBgGarantir();
  const app = document.getElementById("app");
  if (app && typeof MutationObserver === "function") {
    new MutationObserver(() => fcBgSincronizar()).observe(app, { attributes: true, attributeFilter: ["class"] });
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fcBgIniciar);
else fcBgIniciar();

registrarAcoes({ fcBgInput, fcBgTecla, fcBgAbrir });

// ===== FICHA (fase 3) =====
// Daqui para baixo: ficha do Cliente (fichaClienteAbrir).
// A lista acima recarrega sozinha a cada renderClients() — depois de salvar
// ou excluir, basta voltar para "#/clientes" (fichaVoltar/irPara); os filtros
// de cliFiltro continuam valendo e a linha aberta recebe o foco.

/* =========================================================
   3. FICHA DO CLIENTE (#/clientes/:id e #/clientes/novo) — SPEC §4.3
   =========================================================
   Pedido do dono: "cadastro o cliente e automaticamente na aba daquele
   cliente vêm vários módulos de preenchimento". Por isso a ficha tem duas
   caras:
     - MODO NOVO (#/clientes/novo): só a aba Cadastro. Salvar grava, troca a
       URL para #/clientes/<id> (replace — o Voltar não reabre o formulário)
       e abre a Visão geral com o cartão "Complete a ficha";
     - FICHA (#/clientes/<id>): cabeçalho + KPIs + 8 abas. As abas de módulo
       (Agenda, Atendimentos, Documentos, Financeiro, Linha do tempo) vêm do
       ficha-modulos.js (fm*), sempre chamadas por `typeof` — enquanto o módulo
       não existir, um aviso ocupa o lugar e o resto da ficha funciona.

   Três regras que vieram do caso de Precatório e
   não podem ser desfeitas por descuido:
     1. Carga TOLERANTE: o cliente primeiro; o resto em paralelo
        (Promise.allSettled). Fonte que deu
        403/erro vira `null` em ctx.dados e só o bloco dela some — o caso de
        Ação inteiro caía para o estagiário por causa de UM 403 de honorários.
     2. Nunca recarregar a ficha inteira depois de gravar: quem grava redesenha
        o próprio bloco e chama ctx.aoMudar(motivo); aqui só se recalcula
        cabeçalho, alertas, KPIs, contadores e "Complete a ficha" a partir de
        ctx.dados (fcFichaAoMudar). Recarregar tudo apagava edição não salva.
     3. Formulário curto com gravação própria (Contatos, na Visão geral) não
        entra na barra "Alterações não salvas": o texto dele mora no estado
        (FC_FICHA.contato) e avisa a guarda por fmMarcarRascunho.

   O que as duas fichas mostram igual (KPIs, "Complete a ficha", menu "⋯" do
   celular, "Marcar como cliente ativo?") vem do ficha-modulos.js, seção 8.

   Datas: data pura (YYYY-MM-DD — prazo, retorno, nascimento) nunca passa por
   new Date(str); compara-se com fichaDiasAte/ymd (dia LOCAL). Data-hora sem
   fuso (audiência, atendimento) é lida como veio (fichaParseData). */

/** Estado próprio da ficha do cliente — além do FICHA da casca, que é zerado
 *  a cada fichaRender. `usuarios` = {id: nome} (só o admin lista usuários);
 *  `overview` = resposta do /overview (bloco "Outros casos");
 *  `contato` = formulário fmc- do cartão "Contatos e representantes" da Visão
 *  geral: {aberto, editando (id | null = novo), valores (o que foi digitado)}
 *  — mora AQUI, e não no DOM, porque a Visão geral é redesenhada a cada
 *  visita e a cada ctx.aoMudar, e o texto digitado não pode sumir;
 *  `nHon` = quantos honorários havia (o 1º honorário pergunta "cliente ativo?");
 *  `salvando` = trava de duplo clique no Salvar do cadastro. */
const FC_FICHA = { clientId: null, usuarios: {}, overview: null, contato: null, nHon: null, salvando: false };
FICHA_LIMPEZA.push(() => { fcFichaZerar(null); FC_FICHA_QSA.cnpj = ""; FC_FICHA_QSA.qsa = null; });

function fcFichaZerar(clientId) {
  Object.assign(FC_FICHA, { clientId, usuarios: {}, overview: null, contato: { aberto: false, editando: null, valores: null }, nHon: null, salvando: false });
}

/** Quadro de sócios (qsa) da última consulta à Receita: {cnpj (dígitos), qsa
 *  (lista | null = não consultado)}. Sobrevive à troca #/clientes/novo →
 *  #/clientes/<id> (é o que permite oferecer "Importar sócios" logo depois de
 *  cadastrar a PJ). Só dados públicos da empresa; zerado no logout. */
const FC_FICHA_QSA = { cnpj: "", qsa: null };

/* ---------------------------------------------------------
   3.1 Entrada (chamada pelo roteador do ficha.js)
   --------------------------------------------------------- */

/** #/clientes/novo (id null) ou #/clientes/<id>. opts = {aba, query}. */
async function fichaClienteAbrir(id, opts = {}) {
  const o = opts || {};
  if (id === null || id === undefined) return fcFichaAbrirNovo(o);
  const cid = Number(id);
  const tk = fichaRotaToken();
  fcFichaZerar(cid);
  const pv = (m) => permCanView(m);
  // 1º o cliente, sozinho: se ele não existe ou é de outro responsável, a
  // ficha para aqui — sem disparar as outras nove consultas só para levar
  // nove 403 (barulho no console e na trilha, e trabalho à toa).
  let cliente;
  try {
    cliente = await api(`/api/clients/${cid}`);
  } catch (e) {
    if (!fichaRotaValida(tk)) return;
    if (e && (e.status === 404 || e.status === 403)) { fichaNaoEncontrada("#/clientes", "Clientes"); return; }
    throw e;                                       // o roteador mostra o erro
  }
  if (!fichaRotaValida(tk)) return;
  // Depois, tudo em paralelo. Cada fonte só é pedida se o usuário tem o
  // módulo: sem ele, o backend daria 403 de qualquer jeito, e a chave fica
  // `null` ("não sei") em vez de lista vazia ("não tem").
  const fontes = {
    processos: pv("processes") ? api(`/api/processes?client_id=${cid}`) : null,
    prazos: pv("deadlines") ? api(`/api/deadlines?client_id=${cid}`) : null,
    audiencias: pv("appointments") ? api(`/api/appointments?client_id=${cid}`) : null,
    documentos: pv("documents") ? api(`/api/documents?client_id=${cid}&incluir_processos=1`) : null,
    atendimentos: api(`/api/clients/${cid}/atendimentos`),
    honorarios: pv("financeiro") ? api(`/api/honorarios?client_id=${cid}`) : null,
    contatos: api(`/api/clients/${cid}/contatos`),
    // Só para "Outros casos" (precatórios/ações ligados ao cliente).
    overview: pv("precatorios") || pv("acoes") ? api(`/api/clients/${cid}/overview`) : null,
    usuarios: permIsAdmin() ? api("/api/auth/users") : null,
  };
  const chaves = Object.keys(fontes);
  const res = await Promise.allSettled(chaves.map((k) => fontes[k] || Promise.resolve(null)));
  if (!fichaRotaValida(tk)) return;                 // a pessoa já foi para outra tela
  const r = { cliente };
  chaves.forEach((k, i) => {
    if (res[i].status === "fulfilled") r[k] = res[i].value;
    else {
      r[k] = null;
      console.warn(`[ficha-cliente] fonte "${k}" não carregou:`, res[i].reason && res[i].reason.message);
    }
  });
  const lista = (x) => (Array.isArray(x) ? x : null);
  FC_FICHA.overview = r.overview && typeof r.overview === "object" ? r.overview : null;
  FC_FICHA.nHon = lista(r.honorarios) ? r.honorarios.length : null;
  (lista(r.usuarios) || []).forEach((u) => { FC_FICHA.usuarios[u.id] = u.name; });

  const ctx = {
    tipo: "cliente", clientId: cid, processId: null,
    cliente: r.cliente, processo: null,
    processos: lista(r.processos) || [],
    // Contrato da fase 3: chave ausente/null = o módulo carrega sozinho.
    dados: {
      prazos: lista(r.prazos), audiencias: lista(r.audiencias), documentos: lista(r.documentos),
      atendimentos: lista(r.atendimentos), honorarios: lista(r.honorarios),
      contatos: lista(r.contatos),     // só desta ficha (Cadastro + Visão geral)
    },
    aoMudar: null,
  };
  ctx.aoMudar = (motivo) => fcFichaAoMudar(ctx, motivo);

  const ok = await fichaRender(Object.assign(fcFichaCabecalho(ctx), {
    tipo: "cliente", id: cid, ctx,
    trilha: [{ rotulo: "Clientes", hash: "#/clientes" }],
    abas: fcFichaAbas(ctx, false),
    abaAtiva: o.aba || null,
  }));
  if (ok) fcFichaTopoExtras(ctx);
}

/** Modo novo: só o Cadastro. As outras abas ficam ESCONDIDAS até o primeiro
 *  salvamento (apagadas, eram oito abas mortas que chamavam o clique); o
 *  subtítulo diz o que aparece depois de salvar. */
async function fcFichaAbrirNovo() {
  fcFichaZerar(null);
  const ctx = {
    tipo: "cliente", clientId: null, processId: null,
    cliente: null, processo: null, processos: [], dados: {},
    aoMudar: () => {},
  };
  await fichaRender({
    tipo: "cliente", id: null, ctx,
    trilha: [{ rotulo: "Clientes", hash: "#/clientes" }],
    titulo: "Novo cliente",
    tituloDocumento: "Novo cliente",
    subtitulo: "Preencha o cadastro. Ao salvar, a ficha libera processos, prazos, atendimentos, documentos e financeiro — e mostra o que falta completar.",
    abas: fcFichaAbas(ctx, true),
    abaAtiva: "cadastro",
  });
}

/* ---------------------------------------------------------
   3.2 Abas
   --------------------------------------------------------- */

/** Abas SEM ícone — o mesmo critério da ficha do processo (o rótulo basta e
 *  as oito cabem em 1440px sem rolar). No modo novo, só o Cadastro aparece. */
function fcFichaAbas(ctx, novo) {
  const pv = (m) => permCanView(m);
  const cont = novo ? {} : fcFichaContadores(ctx);
  const n = (x) => (x > 0 ? x : null);                 // pílula só com número > 0
  const bloq = (extra) => Object.assign({}, extra, novo ? { oculto: true } : {});
  return [
    bloq({ id: "geral", rotulo: "Visão geral", sempreAtualizar: true, render: fcFichaGeral }),
    { id: "cadastro", rotulo: "Cadastro", render: fcFichaCadastro },
    bloq({
      id: "processos", rotulo: "Processos", contador: n(cont.processos),
      oculto: !(pv("processes") || pv("precatorios") || pv("acoes")), render: fcFichaProcessos,
    }),
    bloq({
      id: "agenda", rotulo: "Prazos e audiências", contador: n(cont.agenda),
      oculto: !(pv("deadlines") || pv("appointments")),
      render: (el, c) => (typeof fmAgenda === "function" ? fmAgenda(el, c, { abaId: "agenda" }) : fcFichaModuloPendente(el)),
    }),
    bloq({
      id: "atendimentos", rotulo: "Atendimentos", contador: n(cont.atendimentos),
      render: (el, c) => (typeof fmAtendimentos === "function" ? fmAtendimentos(el, c, { abaId: "atendimentos" }) : fcFichaModuloPendente(el)),
    }),
    bloq({
      id: "documentos", rotulo: "Documentos", contador: n(cont.documentos),
      oculto: !(pv("documents") || pv("assinaturas")),
      render: (el, c) => (typeof fmDocumentos === "function" ? fmDocumentos(el, c, { abaId: "documentos", comContratos: true }) : fcFichaModuloPendente(el)),
    }),
    bloq({
      id: "financeiro", rotulo: "Financeiro", contador: n(cont.financeiro),
      oculto: !pv("financeiro"),
      render: (el, c) => (typeof fmFinanceiro === "function" ? fmFinanceiro(el, c, { abaId: "financeiro" }) : fcFichaModuloPendente(el)),
    }),
    bloq({
      id: "linha", rotulo: "Linha do tempo", sempreAtualizar: true,
      render: (el, c) => (typeof fmLinhaDoTempo === "function" ? fmLinhaDoTempo(el, c, { abaId: "linha", filtroPadrao: "tudo" }) : fcFichaModuloPendente(el)),
    }),
  ];
}

/** Lugar do módulo enquanto o ficha-modulos.js não o publica. Inofensivo
 *  depois: só aparece se a função fm* não existir. */
function fcFichaModuloPendente(el) {
  el.innerHTML = uiVazio({
    icone: "bi-hourglass-split",
    titulo: "Módulo em preparação",
    texto: "Esta parte da ficha ainda não foi publicada nesta versão. Os dados continuam nas telas do menu lateral.",
  });
}

/** Números das pílulas, a partir de ctx.dados (null = não sei → sem pílula).
 *  Mesma regra dos módulos (contrato da fase 3): agenda = prazos não
 *  cumpridos + audiências futuras; documentos e atendimentos = total;
 *  financeiro = honorários em aberto pela régua do módulo (fmContarHonorarios:
 *  pending_value > 0,004 — o `status` sozinho contava honorário quitado por
 *  arredondamento e divergia da pílula que o próprio módulo põe). */
function fcFichaContadores(ctx) {
  const d = ctx.dados || {};
  const arr = (x) => (Array.isArray(x) ? x : null);
  const prazos = arr(d.prazos), auds = arr(d.audiencias);
  const agora = fcFichaAgoraChave();
  const prazosAbertos = prazos ? prazos.filter((p) => !p.done).length : null;
  const audFuturas = auds ? auds.filter((a) => fichaChaveData(a.date_time) >= agora).length : null;
  return {
    processos: permCanView("processes") ? ctx.processos.length : (fcFichaOutrosCasos().length || null),
    agenda: prazosAbertos === null && audFuturas === null ? null : (prazosAbertos || 0) + (audFuturas || 0),
    atendimentos: arr(d.atendimentos) ? d.atendimentos.length : null,
    documentos: arr(d.documentos) ? d.documentos.length : null,
    financeiro: fmContarHonorarios(ctx),
  };
}

/** "YYYY-MM-DDTHH:MM" de agora, no relógio LOCAL (mesmo formato de fichaChaveData). */
function fcFichaAgoraChave() {
  const n = new Date();
  return `${ymd(n)}T${fichaDois(n.getHours())}:${fichaDois(n.getMinutes())}`;
}

/* ---------------------------------------------------------
   3.3 Cabeçalho, alertas e KPIs (recalculados a cada ctx.aoMudar)
   --------------------------------------------------------- */

/** PF/PJ do cadastro; sem tipo gravado, deduz pelo documento; "" = não sei. */
function fcFichaTipo(c) {
  if (c && (c.tipo_pessoa === "PF" || c.tipo_pessoa === "PJ")) return c.tipo_pessoa;
  const d = fichaDigitos(c && c.cpf_cnpj);
  return d.length === 14 ? "PJ" : (d.length === 11 ? "PF" : "");
}
function fcFichaRotuloDoc(c) {
  const d = fichaDigitos(c && c.cpf_cnpj);
  if (d.length === 14) return "CNPJ";
  if (d.length === 11) return "CPF";
  const t = fcFichaTipo(c);
  return t === "PJ" ? "CNPJ" : (t === "PF" ? "CPF" : "CPF/CNPJ");
}

/** Status do cliente → selo (cores da SPEC §4.3). */
const FC_FICHA_STATUS = {
  lead: ["info", "bi-person-plus"], negociacao: ["warning", "bi-chat-dots"],
  ativo: ["success", "bi-check-circle"], arquivado: ["neutral", "bi-archive"],
};

/** Responsável: o admin vê o nome; quem é o dono vê "Você"; o estagiário vê
 *  "Atribuído" (conveniência de tela, como em Precatórios). */
function fcFichaResponsavel(c) {
  if (!c || !c.owner_id) return "Sem responsável";
  if (CURRENT_USER && c.owner_id === CURRENT_USER.id) return "Você";
  if (permIsAdmin()) return FC_FICHA.usuarios[c.owner_id] || `Usuário #${c.owner_id}`;
  return "Atribuído";
}

function fcFichaCabecalho(ctx) {
  const c = ctx.cliente || {};
  const tipo = fcFichaTipo(c);
  const dig = fichaDigitos(c.cpf_cnpj);
  const chips = [];
  if (tipo) chips.push({ tom: "neutral", texto: fichaRotulo("tipoPessoa", tipo), icone: tipo === "PJ" ? "bi-building" : "bi-person" });
  if (dig) {
    // O botão de copiar entra ao lado deste selo (fcFichaTopoExtras): o
    // `title` é o que o localiza.
    chips.push({ tom: "neutral", texto: `${fcFichaRotuloDoc(c)} ${fmtDoc(c.cpf_cnpj)}`, icone: "bi-person-vcard", titulo: `${fcFichaRotuloDoc(c)} do cliente` });
  } else {
    chips.push({ tom: "warning", texto: `Sem ${fcFichaRotuloDoc(c)}`, icone: "bi-exclamation-triangle", titulo: "Cadastro incompleto: falta o documento" });
  }
  const st = FC_FICHA_STATUS[c.status] || ["neutral", "bi-dot"];
  chips.push({ tom: st[0], texto: CLIENT_STATUS[c.status] || c.status || "Sem status", icone: st[1], tracejado: c.status === "arquivado" });
  if (c.origem) {
    const ind = c.origem === "indicacao" && c.indicado_por ? ` · ${c.indicado_por}` : "";
    chips.push({ tom: "accent", texto: fichaRotulo("origem", c.origem) + ind, icone: "bi-signpost-split", titulo: "Como chegou ao escritório" });
  }
  const desde = fcListaDesde(c.created_at);
  return {
    titulo: c.name || "Cliente",
    tituloDocumento: c.name || "Cliente",
    subtitulo: tipo === "PJ" && c.nome_fantasia ? c.nome_fantasia : "",
    chips,
    meta: [
      { rotulo: "Responsável", html: esc(fcFichaResponsavel(c)) },
      desde ? { html: `Cliente desde <span class="ficha-num">${esc(desde)}</span>` } : null,
    ].filter(Boolean),
    // Só celular/principal: o secundário costuma ser o FIXO (a Receita grava o
    // telefone da empresa ali) e o uiContatoRapido faz WhatsApp do `celular`.
    contato: { whatsapp: c.whatsapp, celular: c.celular || c.phone, email: c.email },
    menuNovo: fcFichaMenuNovo(ctx),
    acoes: [
      { rotulo: "Excluir", icone: "bi-trash", acao: "fcFichaExcluir", tom: "perigo", oculto: !(permPodeExcluir() && permCanEdit("clients")) },
    ],
    alertas: fcFichaAlertas(ctx),
    kpis: fcFichaKpis(ctx),
  };
}

/** "Novo ▾": cada item some sem a permissão de EDITAR o módulo (e o item de
 *  aba some sozinho quando a aba está oculta — regra da casca). */
function fcFichaMenuNovo(ctx) {
  const pe = (m) => permCanEdit(m);
  const agendaVisivel = permCanView("deadlines") || permCanView("appointments");
  return [
    { rotulo: "Processo", icone: "bi-folder-plus", hash: `#/processos/novo?cliente=${Number(ctx.clientId)}`, oculto: !pe("processes") },
    { rotulo: "Prazo", icone: "bi-alarm", aba: "agenda", oculto: !pe("deadlines") },
    { rotulo: "Audiência", icone: "bi-calendar-event", acao: "fcFichaNovoAudiencia", oculto: !pe("appointments") || !agendaVisivel },
    { rotulo: "Atendimento", icone: "bi-chat-dots", aba: "atendimentos", oculto: !pe("clients") },
    { rotulo: "Documento", icone: "bi-file-earmark-arrow-up", aba: "documentos", oculto: !pe("documents") },
    { rotulo: "Honorário", icone: "bi-cash-coin", aba: "financeiro", oculto: !pe("financeiro") },
    { rotulo: "Contato ou representante", icone: "bi-person-plus", acao: "fcFichaNovoContato", oculto: !pe("clients") },
  ];
}

/** Complementos do cabeçalho que a casca não desenha: o menu "⋯" do celular
 *  (com o Excluir) e o botão de copiar ao lado do selo do documento (a casca
 *  só aceita texto nos selos). Entra depois de cada desenho do cabeçalho
 *  (fichaRender e fcFichaAtualizarTopo — os dois únicos caminhos que
 *  redesenham o topo). */
function fcFichaTopoExtras(ctx) {
  fmTopoMenuMais();
  const c = ctx && ctx.cliente;
  if (!c || !fichaDigitos(c.cpf_cnpj)) return;
  const rot = fcFichaRotuloDoc(c);
  const chip = [...document.querySelectorAll("#ficha-topo .ficha-chips .chip")].find((e) => e.getAttribute("title") === `${rot} do cliente`);
  if (!chip || (chip.nextElementSibling && chip.nextElementSibling.classList.contains("ui-copiar"))) return;
  chip.insertAdjacentHTML("afterend", uiCopiar(fmtDoc(c.cpf_cnpj), { rotulo: rot }));
}

/** Link dentro de alerta/cartão que abre uma aba desta ficha. */
function fcFichaLinkAba(aba, texto) {
  return `<a href="#/clientes/${Number(FC_FICHA.clientId)}?aba=${esc(aba)}" data-on-click="fcFichaAbaLink" data-args="${escArgs(aba)}">${esc(texto)}</a>`;
}

/** Prazos não cumpridos, do mais antigo para o mais novo (null = sem a fonte). */
function fcFichaPrazosAbertos(ctx) {
  const ps = ctx.dados && ctx.dados.prazos;
  if (!Array.isArray(ps)) return null;
  return ps.filter((p) => !p.done && fichaSoData(p.date))
    .sort((a, b) => fichaSoData(a.date).localeCompare(fichaSoData(b.date)));
}

function fcFichaAlertas(ctx) {
  const al = [];
  const abertos = fcFichaPrazosAbertos(ctx);
  if (abertos) {
    const venc = abertos.filter((p) => fichaDiasAte(p.date) < 0);
    const hoje = abertos.filter((p) => fichaDiasAte(p.date) === 0);
    if (venc.length) {
      const p = venc[0];
      al.push({
        tom: "danger", icone: "bi-exclamation-octagon",
        html: `<b>${venc.length === 1 ? "1 prazo vencido" : `${venc.length} prazos vencidos`}</b> nos processos deste cliente — ${venc.length === 1 ? "venceu" : "o mais antigo venceu"} em ${esc(fmtDate(fichaSoData(p.date)))}${p.description ? ` (${esc(p.description)})` : ""}. ${fcFichaLinkAba("agenda", "Ver prazos")}`,
      });
    }
    if (hoje.length) {
      al.push({
        tom: "warning", icone: "bi-exclamation-triangle",
        html: `<b>${hoje.length === 1 ? "1 prazo vence hoje" : `${hoje.length} prazos vencem hoje`}</b>${hoje.length === 1 && hoje[0].description ? `: ${esc(hoje[0].description)}` : ""}. ${fcFichaLinkAba("agenda", "Ver prazos")}`,
      });
    }
  }
  // A regra do retorno (feito × pendente) é a do módulo Atendimentos — a
  // mesma que pinta o selo no histórico da aba.
  const ret = fmRetornosPendentes(ctx.dados && ctx.dados.atendimentos);
  if (ret.length) {
    const atrasados = ret.filter((a) => fichaDiasAte(a.proximo_retorno) < 0);
    if (atrasados.length) {
      al.push({
        tom: "danger", icone: "bi-telephone-x",
        html: `<b>Retorno de atendimento atrasado</b> — estava marcado para ${esc(fmtDate(fichaSoData(atrasados[0].proximo_retorno)))}${atrasados.length > 1 ? ` (e mais ${atrasados.length - 1})` : ""}. ${fcFichaLinkAba("atendimentos", "Ver atendimentos")}`,
      });
    }
    if (ret.length > atrasados.length) {
      al.push({
        tom: "warning", icone: "bi-telephone",
        html: `<b>Retorno de atendimento marcado para hoje.</b> ${fcFichaLinkAba("atendimentos", "Ver atendimentos")}`,
      });
    }
  }
  return al;
}

/** Atendimentos do mais recente para o mais antigo (sem confiar na ordem da API). */
function fcFichaAtendimentosOrdenados(ctx) {
  const ats = ctx.dados && ctx.dados.atendimentos;
  if (!Array.isArray(ats)) return null;
  return ats.slice().sort((a, b) => fichaChaveData(b.data).localeCompare(fichaChaveData(a.data)));
}

/** Número do processo para as dicas. O `process_label` da API vem como
 *  "número — nome do cliente"; dentro da ficha do cliente o nome sobra. */
function fcFichaRotuloProcesso(ctx, processId, label) {
  const p = ctx.processos.find((x) => x.id === processId);
  if (p) return fcFichaNumProcesso(p) || "Processo sem número";
  return label ? String(label).split(" — ")[0] : "";
}

/** KPIs (máximo 4): Próximo prazo · Próxima audiência · A receber · Último
 *  atendimento. Cada um some sem a permissão do módulo dele. Os formatos
 *  (vazio = "—" + dica; data grande + selo embaixo) são os MESMOS da ficha
 *  do processo — vêm dos fmKpi* do ficha-modulos.js. */
function fcFichaKpis(ctx) {
  const d = ctx.dados || {};
  const k = [];
  const doProcesso = (x) => fcFichaRotuloProcesso(ctx, x.process_id, x.process_label);
  if (permCanView("deadlines")) {
    k.push(fmKpiPrazo(d.prazos, (p) => [p.description, doProcesso(p)].filter(Boolean).join(" · ")));
  }
  if (permCanView("appointments")) {
    k.push(fmKpiAudiencia(d.audiencias, (a) => [a.location, doProcesso(a)].filter(Boolean).join(" · ")));
  }
  if (permCanView("financeiro")) k.push(fmKpiReceber(d.honorarios));
  const ats = fcFichaAtendimentosOrdenados(ctx);
  const at = ats && ats[0];
  k.push(fmKpiUltimo({ icone: "bi-chat-dots", rotulo: "Último atendimento", aba: "atendimentos" }, at, !!ats,
    at ? [fichaRotulo("atendimentoTipo", at.tipo), at.autor_nome].filter(Boolean).join(" · ") : ""));
  return k;
}

/** Recalcula TUDO o que depende de ctx.dados, sem recarregar nada da API. */
function fcFichaAtualizarTopo(ctx) {
  if (!FICHA.ctx || FICHA.ctx !== ctx) return;
  fichaAtualizarCabecalho(fcFichaCabecalho(ctx));
  fcFichaTopoExtras(ctx);
}

/** ctx.aoMudar(motivo) — chamado pelos módulos depois de gravar/excluir (eles
 *  já atualizaram ctx.dados.<motivo> e o próprio contador). Aqui: cabeçalho,
 *  alertas, KPIs, os demais contadores e "Complete a ficha". */
function fcFichaAoMudar(ctx, motivo) {
  if (!FICHA.ctx || FICHA.ctx !== ctx) return;      // a ficha já é outra
  fcFichaAtualizarTopo(ctx);
  // A pílula da aba de quem gravou é do próprio módulo (ele acabou de pô-la).
  const dono = { prazos: "agenda", audiencias: "agenda", documentos: "documentos", atendimentos: "atendimentos", honorarios: "financeiro" }[motivo];
  const cont = fcFichaContadores(ctx);
  Object.keys(cont).forEach((aba) => { if (aba !== dono && fichaAbaCfg(aba)) fmContador(aba, cont[aba]); });
  fichaAtualizarAba("geral");                       // ativa: redesenha; senão, na próxima visita
  if (motivo === "prazos") fichaAtualizarAba("processos");   // coluna "Próximo prazo"
  if (motivo === "honorarios") fcFichaHonorarioNovo(ctx);
}

/** Honorário NOVO (a lista cresceu) num cliente Lead/Em negociação: pergunta
 *  se ele já é cliente ativo. Exclusão e edição não perguntam. */
async function fcFichaHonorarioNovo(ctx) {
  const hs = ctx.dados && ctx.dados.honorarios;
  if (!Array.isArray(hs)) return;
  const antes = FC_FICHA.nHon;
  FC_FICHA.nHon = hs.length;
  if (antes === null || hs.length <= antes) return;
  const salvo = await fmPerguntarClienteAtivo(ctx.cliente);
  if (salvo && FICHA.ctx === ctx) fcFichaClienteGravado(ctx, salvo);
}

/** O cadastro mudou fora do formulário (arquivar, "cliente ativo"): a ficha
 *  acompanha — cabeçalho, Visão geral e o select de status do Cadastro, se
 *  aberto (sem disparar "change", para não marcar a ficha como alterada). */
function fcFichaClienteGravado(ctx, salvo) {
  Object.assign(ctx.cliente, salvo);
  const st = document.getElementById("cf-status");
  if (st && salvo.status) st.value = salvo.status;
  fcFichaAtualizarTopo(ctx);
  fichaAtualizarAba("geral");
}

/* ---------------------------------------------------------
   3.4 Visão geral
   --------------------------------------------------------- */

function fcFichaGeral(el, ctx) {
  const itens = fcFichaPendencias(ctx);
  const pend = new Set(itens.filter((i) => !i.ok).map((i) => i.chave));
  const incompleto = pend.size > 0;
  // Completa: só o selo pequeno; incompleta: o guia. Enquanto o guia está na
  // tela, os vazios dos cartões não repetem o botão da MESMA pendência — o
  // guia já é o caminho (eram dois "Novo processo" para a mesma coisa).
  const completar = fmCompletarHtml(itens, "fcFichaPendencia");
  // No celular a grade empilha: o guia iria para depois de "Dados principais"
  // e "Processos". Enquanto houver pendência, ele aparece no TOPO (só no
  // celular) — é a peça que conduz o preenchimento.
  el.innerHTML = `
    ${incompleto ? `<div class="d-md-none">${completar}</div>` : ""}
    <div class="ficha-grade">
      <div class="ficha-coluna">${fcFichaCardDados(ctx)}${fcFichaCardProcessos(ctx, pend)}</div>
      <div class="ficha-coluna">
        <div class="${incompleto ? "d-none d-md-block" : ""}">${completar}</div>
        ${fcFichaCardAtendimento(ctx, pend)}
        <div id="fc-ficha-contatos">${fcFichaCardContatos(ctx)}</div>
      </div>
    </div>`;
  fcFichaContatoLigar(el);
}

function fcFichaBtnAba(aba, texto, icone, novo) {
  const ic = icone ? `<i class="bi ${icone}" aria-hidden="true"></i> ` : "";
  return `<button type="button" class="btn btn-sm btn-ficha" data-on-click="${novo ? "fcFichaIrNovo" : "fcFichaAbaLink"}" data-args="${escArgs(aba)}">${ic}${esc(texto)}</button>`;
}

function fcFichaIdade(dataISO) {
  const d = fichaSoData(dataISO);
  if (!d) return null;
  const [y, m, dd] = d.split("-").map(Number);
  const [hy, hm, hd] = ymd(new Date()).split("-").map(Number);
  let idade = hy - y;
  if (hm < m || (hm === m && hd < dd)) idade -= 1;
  return idade >= 0 && idade < 130 ? idade : null;
}

function fcFichaEndereco(c) {
  const linha1 = [c.rua, c.numero].filter((x) => x && String(x).trim()).join(", ");
  const l1 = [linha1, c.complemento].filter((x) => x && String(x).trim()).join(" — ");
  const cidade = [c.cidade, c.estado].filter((x) => x && String(x).trim()).join("/");
  const cep = fichaDigitos(c.cep).length === 8 ? "CEP " + fichaPadrao(fichaDigitos(c.cep), "#####-###") : "";
  return [l1, c.bairro, cidade, cep].filter((x) => x && String(x).trim()).join(" · ");
}

function fcFichaCardDados(ctx) {
  const c = ctx.cliente || {};
  const pj = fcFichaTipo(c) === "PJ";
  const rotDoc = fcFichaRotuloDoc(c);
  const doc = fichaDigitos(c.cpf_cnpj) ? fmtDoc(c.cpf_cnpj) : "";
  const nasc = fichaSoData(c.data_nascimento);
  const idade = !pj && nasc ? fcFichaIdade(nasc) : null;
  const tel = c.celular || c.phone || "";
  const tels = [];
  if (tel) tels.push(`<span class="ficha-num">${esc(fmtTel(tel))}</span>`);
  if (c.whatsapp && fichaDigitos(c.whatsapp) !== fichaDigitos(tel)) tels.push(`<span class="ficha-num">${esc(fmtTel(c.whatsapp))}</span> <span class="fc-ficha-mudo">(WhatsApp)</span>`);
  else if (c.whatsapp && tel) tels[0] += ' <span class="fc-ficha-mudo">(também WhatsApp)</span>';
  if (c.telefone_secundario) tels.push(`<span class="ficha-num">${esc(fmtTel(c.telefone_secundario))}</span>`);
  const itens = [
    { rotulo: rotDoc, html: doc ? `<span class="ficha-num">${esc(doc)}</span> ${uiCopiar(doc, { rotulo: rotDoc })}` : "" },
    { rotulo: pj ? "Abertura" : "Nascimento", valor: nasc ? fmtDate(nasc) + (idade !== null ? ` · ${idade} anos` : "") : "" },
    { rotulo: "Telefone / WhatsApp", html: tels.join("<br>") },
    { rotulo: "E-mail", valor: c.email },
    pj ? { rotulo: "Nome fantasia", valor: c.nome_fantasia } : { rotulo: "Profissão", valor: c.profissao },
    { rotulo: "Endereço", valor: fcFichaEndereco(c), largo: true },
    c.notes && String(c.notes).trim() ? { rotulo: "Observações", html: `<span class="fc-ficha-pre">${esc(c.notes)}</span>`, largo: true } : null,
  ];
  return uiCard({
    titulo: "Dados principais",
    // Mesmo botão do cartão "Dados do processo" na ficha do processo.
    acoesHtml: permCanEdit("clients")
      ? fcFichaBtnAba("cadastro", "Editar cadastro", "bi-pencil-square")
      : fcFichaBtnAba("cadastro", "Ver cadastro", "bi-card-list"),
    corpoHtml: uiDl(itens),
  });
}

/** Próximo prazo de um processo: dos prazos já carregados (atualiza na hora
 *  quando um prazo é cumprido na Agenda); sem eles, o que a lista trouxe. */
function fcFichaProximoPrazo(ctx, p) {
  const ps = ctx.dados && ctx.dados.prazos;
  if (Array.isArray(ps)) {
    const ab = ps.filter((x) => x.process_id === p.id && !x.done && fichaSoData(x.date)).map((x) => fichaSoData(x.date)).sort();
    return ab[0] || null;
  }
  return fichaSoData(p.proximo_prazo);
}

/** Processos em ordem útil: ativos primeiro, depois quem vence antes. */
function fcFichaProcessosOrdenados(ctx) {
  const peso = { ativo: 0, suspenso: 1, encerrado: 2 };
  return ctx.processos.slice().sort((a, b) => {
    const pa = peso[a.status] === undefined ? 1 : peso[a.status];
    const pb = peso[b.status] === undefined ? 1 : peso[b.status];
    if (pa !== pb) return pa - pb;
    const xa = fcFichaProximoPrazo(ctx, a) || "9999", xb = fcFichaProximoPrazo(ctx, b) || "9999";
    if (xa !== xb) return xa.localeCompare(xb);
    return b.id - a.id;
  });
}

function fcFichaNumProcesso(p) {
  return p.case_number && String(p.case_number).trim() ? fmtCnj(p.case_number) : "";
}

function fcFichaBtnNovoProcesso(ctx, classe) {
  if (!permCanEdit("processes")) return "";
  const h = `#/processos/novo?cliente=${Number(ctx.clientId)}`;
  return `<a class="btn btn-sm ${classe || "btn-primary"}" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo processo</a>`;
}

function fcFichaCardProcessos(ctx, pend) {
  if (!permCanView("processes")) return "";
  const lista = fcFichaProcessosOrdenados(ctx);
  const n = lista.length;
  if (!n) {
    const peloGuia = pend && pend.has("processo");
    return uiCard({
      titulo: "Processos",
      corpoHtml: uiVazio({
        icone: "bi-folder2-open", compacto: true, titulo: "Nenhum processo ainda",
        texto: peloGuia
          ? "Cadastre o primeiro processo pelo guia “Complete a ficha” — depois ele aparece aqui, com prazos e audiências."
          : "Cadastre o primeiro processo deste cliente para acompanhar prazos, audiências e documentos.",
        acaoHtml: peloGuia ? "" : fcFichaBtnNovoProcesso(ctx),
      }),
    });
  }
  const itens = lista.slice(0, 5).map((p) => {
    const num = fcFichaNumProcesso(p);
    const h = `#/processos/${Number(p.id)}`;
    const prox = fcFichaProximoPrazo(ctx, p);
    const sub = [typeof procAreaLabel === "function" && p.type ? procAreaLabel(p.type) : p.type, p.assunto || p.classe].filter(Boolean).join(" · ");
    return `<li class="fc-ficha-proc">
      <div class="fc-ficha-proc-txt">
        <a class="fc-ficha-proc-num${num ? " fc-ficha-mono" : " fc-ficha-sem-num"}" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}">${esc(num || "Processo sem número")}</a>
        ${sub ? `<div class="fc-ficha-sub">${esc(sub)}</div>` : ""}
      </div>
      <div class="fc-ficha-proc-chips">${uiStatusProcesso(p.status)}${prox && p.status !== "encerrado" ? uiPrazoBadge(prox, false) : ""}</div>
    </li>`;
  }).join("");
  return uiCard({
    titulo: "Processos",
    descricao: n > 5 ? `Os 5 mais urgentes de ${n}.` : "",
    acoesHtml: `${fcFichaBtnAba("processos", n > 5 ? `Ver todos (${n})` : "Ver todos", "")}${fcFichaBtnNovoProcesso(ctx, "btn-ficha")}`,
    corpoHtml: `<ul class="fc-ficha-procs">${itens}</ul>`,
  });
}

/* --- "Complete a ficha": o guia que materializa o pedido do dono --- */

/** Papéis que contam como "Representante legal" de uma PJ. */
const FC_FICHA_PAPEIS_REPRESENTANTE = ["representante_legal", "socio"];
function fcFichaTemRepresentante(cs) {
  return Array.isArray(cs) && cs.some((x) => FC_FICHA_PAPEIS_REPRESENTANTE.includes(x.papel));
}

/** Itens do guia. Cada um só entra se a pessoa enxerga o módulo E a fonte
 *  carregou (sem a fonte não dá para saber se está feito). PJ ganha
 *  "Representante legal" (contato com papel representante legal ou sócio). */
function fcFichaPendencias(ctx) {
  const c = ctx.cliente || {};
  const d = ctx.dados || {};
  const dig = fichaDigitos(c.cpf_cnpj);
  const tem = (x) => !!(x && String(x).trim());
  const itens = [
    { chave: "doc", rotulo: fcFichaRotuloDoc(c), ok: dig.length === 11 || dig.length === 14 },
    { chave: "tel", rotulo: "Telefone ou WhatsApp", ok: [c.celular, c.phone, c.whatsapp, c.telefone_secundario].some((t) => fichaDigitos(t).length >= 8) },
    { chave: "end", rotulo: "Endereço", ok: tem(c.cidade) && (tem(c.rua) || fichaDigitos(c.cep).length === 8) },
  ];
  if (fcFichaTipo(c) === "PJ" && Array.isArray(d.contatos)) {
    itens.push({ chave: "representante", rotulo: "Representante legal", ok: fcFichaTemRepresentante(d.contatos) });
  }
  if (permCanView("processes") || permCanView("precatorios") || permCanView("acoes")) {
    const casos = fcFichaOutrosCasos().filter((x) => x.vinculo === "cadastro").length;
    itens.push({ chave: "processo", rotulo: "1º processo (ou precatório/ação)", ok: ctx.processos.length > 0 || casos > 0 });
  }
  if (permCanView("documents") && Array.isArray(d.documentos)) itens.push({ chave: "documento", rotulo: "Documento anexado", ok: d.documentos.length > 0 });
  if (permCanView("financeiro") && Array.isArray(d.honorarios)) itens.push({ chave: "honorario", rotulo: "Honorários", ok: d.honorarios.length > 0 });
  if (Array.isArray(d.atendimentos)) itens.push({ chave: "atendimento", rotulo: "1º atendimento", ok: d.atendimentos.length > 0 });
  return itens;
}

function fcFichaCardAtendimento(ctx, pend) {
  const ats = fcFichaAtendimentosOrdenados(ctx);
  if (!ats) return "";
  const pode = permCanEdit("clients");
  const at = ats[0];
  const btn = pode ? fcFichaBtnAba("atendimentos", "Registrar", "bi-plus-lg", true) : "";
  if (!at) {
    const peloGuia = pend && pend.has("atendimento");
    return uiCard({
      titulo: "Último atendimento",
      corpoHtml: uiVazio({
        icone: "bi-chat-dots", compacto: true, titulo: "Nenhum atendimento registrado",
        texto: "Registre ligações, reuniões e mensagens — vira o histórico do cliente.",
        acaoHtml: pode && !peloGuia ? `<button type="button" class="btn btn-sm btn-primary" data-on-click="fcFichaIrNovo" data-args="${escArgs("atendimentos")}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Registrar atendimento</button>` : "",
      }),
    });
  }
  const ic = (FICHA_ICONES.atendimentoTipo || {})[at.tipo] || "bi-chat-dots";
  const meta = [fichaRotulo("atendimentoTipo", at.tipo), fmtDataHora(at.data), at.autor_nome].filter(Boolean).join(" · ");
  const desc = String(at.descricao || "");
  // O selo do retorno é o MESMO do histórico da aba (regra do módulo).
  const retorno = at.proximo_retorno ? fmRetornoChip(at, ctx.dados.atendimentos) : "";
  const proc = at.process_id ? `<a class="fc-ficha-mono" href="#/processos/${Number(at.process_id)}" data-on-click="fichaIr" data-args="${escArgs(`#/processos/${Number(at.process_id)}`)}">${esc(at.process_number ? fmtCnj(at.process_number) : "Processo #" + at.process_id)}</a>` : "";
  return uiCard({
    titulo: "Último atendimento",
    acoesHtml: btn,
    corpoHtml: `<div class="fc-ficha-at">
        <div class="fc-ficha-at-meta"><i class="bi ${fichaIconeSeguro(ic) || "bi-chat-dots"}" aria-hidden="true"></i><span>${esc(meta)}</span></div>
        <div class="fc-ficha-at-desc">${esc(desc.length > 320 ? desc.slice(0, 317) + "…" : desc)}</div>
        ${retorno || proc ? `<div class="fc-ficha-at-rodape">${retorno}${proc}</div>` : ""}
      </div>
      ${ats.length > 1 ? `<div class="fc-ficha-mais">${fcFichaLinkAba("atendimentos", `Ver todos os ${ats.length} atendimentos`)}</div>` : ""}`,
  });
}

/* ---------------------------------------------------------
   3.5 Contatos e representantes (cartão da Visão geral, ids fmc-)
   ---------------------------------------------------------
   Lista + incluir/editar/remover NO cartão da Visão geral (antes ficava no
   fim do Cadastro, longe de quem procura "com quem falo"). O formulário fica
   fechado até a pessoa pedir; o que foi digitado mora em FC_FICHA.contato
   e volta a cada redesenho da Visão geral (ela é sempreAtualizar e é
   redesenhada a cada ctx.aoMudar). Texto não salvo avisa a guarda de saída
   (fmMarcarRascunho → fichaMarcarRascunho do núcleo). */

/** Quantos contatos o cartão mostra antes do "Mostrar todos". */
const FC_FICHA_CONTATOS_VISIVEIS = 4;

function fcFichaContatoInfoHtml(ct) {
  const nome = ct.nome && String(ct.nome).trim() ? ct.nome : "Contato sem nome";
  const sub = [ct.telefone ? fmtTel(ct.telefone) : "", ct.email || "", ct.cpf ? "CPF " + fmtDoc(ct.cpf) : ""].filter(Boolean);
  return `<div class="fc-ficha-ct-info">
    <div class="fc-ficha-ct-nome"><span>${esc(nome)}</span>${ct.papel ? uiChip("neutral", fichaRotulo("contatoPapel", ct.papel)) : ""}${ct.principal ? uiChip("accent", "Principal", "bi-star-fill") : ""}</div>
    ${sub.length ? `<div class="fc-ficha-ct-sub ficha-num">${sub.map(esc).join(" · ")}</div>` : ""}
    ${ct.observacao ? `<div class="fc-ficha-ct-obs">${esc(ct.observacao)}</div>` : ""}
  </div>`;
}

/** WhatsApp/ligar/e-mail do contato — só ícones (cabem na linha). */
function fcFichaContatoAtalhos(ct) {
  const w = fmtWhats(ct.telefone);
  const em = fcListaEmail(ct.email);
  const b = [];
  if (w) {
    b.push(`<a class="fc-ficha-icone is-whats" href="https://wa.me/${w}" target="_blank" rel="noopener noreferrer" data-on-click="acNada" title="WhatsApp" aria-label="WhatsApp de ${esc(ct.nome || "contato")}"><i class="bi bi-whatsapp" aria-hidden="true"></i></a>`);
    b.push(`<a class="fc-ficha-icone" href="tel:+${w}" data-on-click="acNada" title="Ligar" aria-label="Ligar para ${esc(ct.nome || "contato")}"><i class="bi bi-telephone" aria-hidden="true"></i></a>`);
  }
  if (em) b.push(`<a class="fc-ficha-icone" href="mailto:${esc(em)}" data-on-click="acNada" title="${esc(em)}" aria-label="E-mail para ${esc(ct.nome || "contato")}"><i class="bi bi-envelope" aria-hidden="true"></i></a>`);
  return b.length ? `<div class="fc-ficha-ct-atalhos">${b.join("")}</div>` : "";
}

/** Principal primeiro, depois o representante legal (quem fala pela PJ),
 *  depois a ordem de cadastro — com 40 sócios importados da Receita, o
 *  representante não pode ficar escondido no fim da lista. */
function fcFichaContatosOrdenados(cs) {
  const rep = (x) => (x.papel === "representante_legal" ? 0 : 1);
  return cs.slice().sort((a, b) => (b.principal ? 1 : 0) - (a.principal ? 1 : 0) || rep(a) - rep(b) || (a.id - b.id));
}

function fcFichaCardContatos(ctx) {
  const cs = ctx.dados && ctx.dados.contatos;
  const pe = permCanEdit("clients");
  const f = FC_FICHA.contato || {};
  const incluir = pe && Array.isArray(cs) && !(f.aberto && f.editando === null)
    ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fcFichaNovoContato"><i class="bi bi-person-plus" aria-hidden="true"></i> Incluir</button>` : "";
  let corpo;
  if (!Array.isArray(cs)) {
    corpo = uiVazio({
      icone: "bi-exclamation-triangle", compacto: true, titulo: "Não foi possível carregar os contatos",
      texto: "Tente novamente em instantes.",
      acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fcFichaContatosTentar"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Tentar novamente</button>`,
    });
  } else {
    const px = pe && permPodeExcluir();
    const ord = fcFichaContatosOrdenados(cs);
    const visiveis = f.todos ? ord : ord.slice(0, FC_FICHA_CONTATOS_VISIVEIS);
    const lista = ord.length ? `<ul class="fc-ficha-ct-lista">${visiveis.map((ct) => `
      <li class="fc-ficha-ct-item${f.aberto && f.editando === ct.id ? " is-editando" : ""}">
        ${fcFichaContatoInfoHtml(ct)}
        <div class="fc-ficha-ct-acoes">
          ${fcFichaContatoAtalhos(ct)}
          ${pe ? `<button type="button" class="fc-ficha-icone" data-on-click="fcFichaContatoEditar" data-args="${escArgs(ct.id)}" title="Editar" aria-label="Editar ${esc(ct.nome || "contato")}"><i class="bi bi-pencil" aria-hidden="true"></i></button>` : ""}
          ${px ? `<button type="button" class="fc-ficha-icone is-perigo" data-on-click="fcFichaContatoExcluir" data-args="${escArgs(ct.id)}" title="Remover" aria-label="Remover ${esc(ct.nome || "contato")}"><i class="bi bi-trash" aria-hidden="true"></i></button>` : ""}
        </div>
      </li>`).join("")}</ul>
      ${ord.length > visiveis.length ? `<button type="button" class="fm-btn-link fc-ficha-ct-todos" data-on-click="fcFichaContatosTodos">Mostrar todos os ${ord.length} contatos</button>` : ""}`
      : (f.aberto ? "" : uiVazio({
        icone: "bi-person-lines-fill", compacto: true, titulo: "Nenhum contato ou representante",
        texto: "Quem fala pelo cliente: representante legal, sócio, procurador, familiar, financeiro.",
      }));
    corpo = lista + fcFichaOfertaSocios(ctx) + (pe && f.aberto ? fcFichaContatoFormHtml() : "");
  }
  return uiCard({
    titulo: "Contatos e representantes",
    descricao: Array.isArray(cs) && cs.length ? fcListaPlural(cs.length, "contato", "contatos") : "",
    acoesHtml: incluir,
    corpoHtml: corpo,
    classe: "fc-ficha-ct-card",
  });
}

/** Formulário de contato, desenhado a partir de FC_FICHA.contato (o que foi
 *  digitado volta a cada redesenho). Campos empilhados: o cartão mora na
 *  coluna estreita da Visão geral. */
function fcFichaContatoFormHtml() {
  const f = FC_FICHA.contato || {};
  const v = f.valores || {};
  const editando = f.editando !== null && f.editando !== undefined;
  const val = (k) => esc(v[k] === undefined || v[k] === null ? "" : v[k]);
  return `<form id="fmc-form" class="fc-ficha-ct-form" novalidate data-on-submit="fcFichaContatoSalvar" data-prevent="1">
    <div class="fc-ficha-ct-form-tit" id="fmc-titulo">${editando ? `Editar contato: ${esc(v.nomeOriginal || v.nome || "sem nome")}` : "Incluir contato ou representante"}</div>
    <div class="row g-2">
      <div class="col-12"><label class="form-label" for="fmc-nome">Nome</label>
        <input id="fmc-nome" class="form-control" maxlength="150" autocomplete="off" value="${val("nome")}"></div>
      <div class="col-12"><label class="form-label" for="fmc-papel">Papel</label>
        <select id="fmc-papel" class="form-select">${fichaOpcoes("contatoPapel", v.papel || "", { vazio: "— Selecione —" })}</select></div>
      <div class="col-6"><label class="form-label" for="fmc-telefone">Telefone</label>
        <input id="fmc-telefone" class="form-control ficha-num" inputmode="tel" maxlength="40" autocomplete="off" data-on-input="fichaMascaraTel" placeholder="(00) 00000-0000" value="${val("telefone")}"></div>
      <div class="col-6"><label class="form-label" for="fmc-cpf">CPF</label>
        <input id="fmc-cpf" class="form-control ficha-num" inputmode="numeric" maxlength="20" autocomplete="off" data-on-input="fichaMascaraDoc" placeholder="000.000.000-00" value="${val("cpf")}"></div>
      <div class="col-12"><label class="form-label" for="fmc-email">E-mail</label>
        <input id="fmc-email" type="email" class="form-control" maxlength="120" autocomplete="off" value="${val("email")}"></div>
      <div class="col-12"><label class="form-label" for="fmc-obs">Observação</label>
        <input id="fmc-obs" class="form-control" autocomplete="off" placeholder="ex.: falar só à tarde; cuida dos pagamentos" value="${val("obs")}"></div>
      <div class="col-12 fc-ficha-ct-form-rodape">
        <div class="form-check mb-0"><input class="form-check-input" type="checkbox" id="fmc-principal"${v.principal ? " checked" : ""}><label class="form-check-label" for="fmc-principal">Contato principal</label></div>
        <div class="d-flex flex-wrap gap-2">
          <button type="button" class="btn btn-sm btn-ficha" data-on-click="fcFichaContatoCancelar">Cancelar</button>
          <button type="submit" class="btn btn-sm btn-primary" id="fmc-salvar">${editando ? '<i class="bi bi-check-lg" aria-hidden="true"></i> Salvar contato' : '<i class="bi bi-plus-lg" aria-hidden="true"></i> Incluir contato'}</button>
        </div>
      </div>
    </div>
  </form>`;
}

/** O que está digitado no formulário fmc- agora. */
function fcFichaContatoLer() {
  const g = (s) => { const el = document.getElementById("fmc-" + s); return el ? String(el.value || "") : ""; };
  const pr = document.getElementById("fmc-principal");
  const antes = (FC_FICHA.contato && FC_FICHA.contato.valores) || {};
  return {
    nome: g("nome"), papel: g("papel"), telefone: g("telefone"), email: g("email"), cpf: g("cpf"), obs: g("obs"),
    principal: !!(pr && pr.checked), nomeOriginal: antes.nomeOriginal || "",
  };
}

/** Liga o formulário (se estiver na tela) ao rascunho: cada tecla guarda o
 *  texto em FC_FICHA.contato e avisa a guarda de saída. Listener comum (não
 *  data-on-input): Telefone e CPF já têm a máscara no data-on-input deles, e
 *  o despachante só chama o elemento mais próximo. */
function fcFichaContatoLigar(raiz) {
  const form = raiz && raiz.querySelector ? raiz.querySelector("#fmc-form") : null;
  if (!form || form.dataset.fcLigado) return;
  form.dataset.fcLigado = "1";
  const guardar = () => {
    if (!FC_FICHA.contato || !FC_FICHA.contato.aberto) return;
    FC_FICHA.contato.valores = fcFichaContatoLer();
    fmMarcarRascunho("contato", fmFormTemTexto(form));
  };
  form.addEventListener("input", (ev) => {
    if (ev.target instanceof Element) ev.target.classList.remove("is-invalid");
    guardar();
  });
  form.addEventListener("change", guardar);
}

/** Redesenha só o cartão (o resto da Visão geral fica como está). */
function fcFichaContatosRedesenhar(ctx) {
  const box = document.getElementById("fc-ficha-contatos");
  if (!box || !ctx) return;
  box.innerHTML = fcFichaCardContatos(ctx);
  fcFichaContatoLigar(box);
}

function fcFichaContatoFocar() {
  setTimeout(() => {
    const el = document.getElementById("fmc-nome");
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }, 40);
}

/** Abre o formulário (novo ou edição) na Visão geral. `valores` pré-preenche. */
async function fcFichaContatoAbrir(editando, valores) {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId || !permCanEdit("clients")) return;
  FC_FICHA.contato = { aberto: true, editando, valores: valores || null, todos: FC_FICHA.contato && FC_FICHA.contato.todos };
  if (FICHA.aba !== "geral") { if (!(await fichaIrAba("geral"))) return; }
  else fcFichaContatosRedesenhar(ctx);
  fcFichaContatoFocar();
}

async function fcFichaContatosRecarregar(ctx) {
  let lista = null;
  try { lista = await api(`/api/clients/${ctx.clientId}/contatos`); }
  catch (e) { toast(e.message, true); }
  if (FICHA.ctx !== ctx) return;
  if (Array.isArray(lista)) ctx.dados.contatos = lista;
  fichaAtualizarAba("geral");          // cartão + "Complete a ficha" (representante legal)
}

/** AÇÃO: "Tentar novamente" quando os contatos não carregaram. */
async function fcFichaContatosTentar() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId) return;
  ctx.dados.contatos = await api(`/api/clients/${ctx.clientId}/contatos`);
  if (FICHA.ctx !== ctx) return;
  fichaAtualizarAba("geral");
}

/** AÇÃO: "Mostrar todos os N contatos". */
function fcFichaContatosTodos() {
  FC_FICHA.contato = Object.assign({}, FC_FICHA.contato, { todos: true });
  fcFichaContatosRedesenhar(FICHA.ctx);
}

/** AÇÃO: fecha o formulário e descarta o que foi digitado. */
function fcFichaContatoCancelar() {
  FC_FICHA.contato = { aberto: false, editando: null, valores: null, todos: FC_FICHA.contato && FC_FICHA.contato.todos };
  fmMarcarRascunho("contato", false);
  fcFichaContatosRedesenhar(FICHA.ctx);
}

/** AÇÃO: carrega o contato no formulário (o mesmo formulário edita). */
function fcFichaContatoEditar(id) {
  const ctx = FICHA.ctx;
  const ct = ctx && Array.isArray(ctx.dados.contatos) ? ctx.dados.contatos.find((x) => x.id === Number(id)) : null;
  if (!ct) return;
  fmMarcarRascunho("contato", false);
  fcFichaContatoAbrir(ct.id, {
    nome: ct.nome || "", papel: ct.papel || "", telefone: ct.telefone ? fmtTel(ct.telefone) : "",
    email: ct.email || "", cpf: ct.cpf ? fmtDoc(ct.cpf) : "", obs: ct.observacao || "",
    principal: !!ct.principal, nomeOriginal: ct.nome || "",
  });
}

/** AÇÃO (submit do formulário fmc-): cria ou atualiza. */
async function fcFichaContatoSalvar() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId) return;
  const v = fcFichaContatoLer();
  const corpo = {
    nome: v.nome.trim(), papel: v.papel || null, telefone: v.telefone.trim(), email: v.email.trim(),
    cpf: v.cpf.trim(), observacao: v.obs.trim(), principal: v.principal,
  };
  if (!corpo.nome && !corpo.telefone && !corpo.email) {
    toast("Informe ao menos o nome, o telefone ou o e-mail do contato.", true);
    const el = document.getElementById("fmc-nome");
    if (el) { el.classList.add("is-invalid"); el.focus(); }
    return;
  }
  ["nome", "telefone", "email", "cpf", "observacao"].forEach((k) => { if (!corpo[k]) corpo[k] = null; });
  const id = FC_FICHA.contato && FC_FICHA.contato.editando;
  const btn = document.getElementById("fmc-salvar");
  if (btn && btn.disabled) return;
  const rotulo = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Salvando…'; }
  try {
    await api(id ? `/api/clients/${ctx.clientId}/contatos/${id}` : `/api/clients/${ctx.clientId}/contatos`, {
      method: id ? "PUT" : "POST", body: JSON.stringify(corpo),
    });
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = rotulo; }
  }
  if (FICHA.ctx !== ctx) return;
  FC_FICHA.contato = { aberto: false, editando: null, valores: null, todos: FC_FICHA.contato && FC_FICHA.contato.todos };
  fmMarcarRascunho("contato", false);
  await fcFichaContatosRecarregar(ctx);
  toast(id ? "Contato atualizado." : "Contato incluído.");
}

/** AÇÃO: remover contato (com confirmação). */
async function fcFichaContatoExcluir(id) {
  const ctx = FICHA.ctx;
  const ct = ctx && Array.isArray(ctx.dados.contatos) ? ctx.dados.contatos.find((x) => x.id === Number(id)) : null;
  if (!ct) return;
  const r = await confirmar({
    titulo: "Remover este contato?",
    texto: `${ct.nome || "O contato"} sai da lista de contatos e representantes deste cliente. O cadastro do cliente não muda.`,
    botao: "Remover", perigo: true,
  });
  if (r !== "ok") return;
  await api(`/api/clients/${ctx.clientId}/contatos/${ct.id}`, { method: "DELETE" });
  if (FICHA.ctx !== ctx) return;
  if (FC_FICHA.contato && FC_FICHA.contato.editando === ct.id) {
    FC_FICHA.contato = { aberto: false, editando: null, valores: null, todos: FC_FICHA.contato.todos };
    fmMarcarRascunho("contato", false);
  }
  await fcFichaContatosRecarregar(ctx);
  toast("Contato removido.");
}

/** AÇÃO ("Novo ▾ → Contato ou representante", "Incluir" do cartão). Se o
 *  formulário de inclusão já está aberto, só o traz de volta (com o texto). */
function fcFichaNovoContato(papel) {
  const f = FC_FICHA.contato || {};
  if (f.aberto && (f.editando === null || f.editando === undefined)) {
    if (papel && f.valores && !f.valores.papel) f.valores.papel = papel;
    return fcFichaContatoAbrir(null, f.valores);
  }
  fmMarcarRascunho("contato", false);
  return fcFichaContatoAbrir(null, papel ? { papel } : null);
}

/* --- PJ: importar o quadro de sócios da Receita (BrasilAPI) --- */

/** Oferta dentro do cartão: PJ com CNPJ válido, sem representante legal nem
 *  sócio nos contatos, e a Receita lista sócios (ou ainda não foi consultada
 *  nesta sessão — aí o botão consulta). Some quando já não serve. */
function fcFichaOfertaSocios(ctx) {
  const c = ctx.cliente || {};
  if (fcFichaTipo(c) !== "PJ" || !permCanEdit("clients")) return "";
  const dig = fichaDigitos(c.cpf_cnpj);
  if (dig.length !== 14 || !fichaCnpjValido(dig)) return "";
  if (fcFichaTemRepresentante(ctx.dados && ctx.dados.contatos)) return "";
  const qsa = FC_FICHA_QSA.cnpj === dig ? FC_FICHA_QSA.qsa : null;
  if (Array.isArray(qsa) && !qsa.length) return "";            // a Receita não lista sócios
  const n = Array.isArray(qsa) ? qsa.length : 0;
  return `<div class="fc-ficha-socios">
    <i class="bi bi-building-check" aria-hidden="true"></i>
    <div class="fc-ficha-socios-txt">
      <div class="fc-ficha-socios-tit">${n ? `A Receita lista ${n === 1 ? "1 sócio" : `${n} sócios`} desta empresa` : "Quadro de sócios na Receita"}</div>
      <div>${n ? "Importe como contatos: o sócio-administrador entra como representante legal." : "Busque os sócios desta empresa na Receita e importe como contatos."}</div>
    </div>
    <button type="button" class="btn btn-sm btn-ficha" data-on-click="fcFichaImportarSocios"><i class="bi bi-people" aria-hidden="true"></i> ${n ? "Importar sócios como contatos" : "Importar sócios da Receita"}</button>
  </div>`;
}

/** Quadro de sócios (qsa) na BrasilAPI — a MESMA rota da busca do cadastro
 *  (a CSP só libera esse caminho). Leva só o CNPJ, dado público da empresa. */
async function fcFichaBuscarQsa(dig) {
  let r;
  try {
    r = await fetch("https://brasilapi.com.br/api/cnpj/v1/" + dig, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    throw new Error("Não foi possível falar com a Receita agora (sem conexão ou bloqueado). Tente de novo em instantes.");
  }
  if (r.status === 404) throw new Error("CNPJ não encontrado na Receita.");
  if (!r.ok) throw new Error("A consulta à Receita não respondeu agora. Tente de novo em instantes.");
  const j = await r.json();
  return Array.isArray(j && j.qsa) ? j.qsa.filter((s) => s && String(s.nome_socio || "").trim()) : [];
}

/** Sócio-administrador (e presidente/administrador de S.A.) fala pela empresa. */
function fcFichaPapelDoSocio(qualificacao) {
  return /administrador|presidente/i.test(String(qualificacao || "")) ? "representante_legal" : "socio";
}

/** AÇÃO: importa os sócios como contatos (um clique quando a consulta do
 *  cadastro já trouxe o quadro; senão consulta, mostra quantos e confirma).
 *  Quem já está nos contatos (mesmo nome) não é duplicado. */
async function fcFichaImportarSocios() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId || !permCanEdit("clients")) return;
  const btn = this instanceof HTMLButtonElement ? this : null;
  const dig = fichaDigitos(ctx.cliente && ctx.cliente.cpf_cnpj);
  const rotulo = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Importando…'; }
  try {
    let qsa = FC_FICHA_QSA.cnpj === dig ? FC_FICHA_QSA.qsa : null;
    const jaConhecido = Array.isArray(qsa);
    if (!jaConhecido) {
      qsa = await fcFichaBuscarQsa(dig);
      FC_FICHA_QSA.cnpj = dig;
      FC_FICHA_QSA.qsa = qsa;
    }
    if (FICHA.ctx !== ctx) return;
    if (!qsa.length) { toast("A Receita não lista sócios para este CNPJ."); fcFichaContatosRedesenhar(ctx); return; }
    if (!jaConhecido) {
      const nomes = qsa.slice(0, 6).map((s) => String(s.nome_socio).trim()).join(", ") + (qsa.length > 6 ? ` e mais ${qsa.length - 6}` : "");
      const r = await confirmar({
        titulo: `Importar ${qsa.length === 1 ? "1 sócio" : `${qsa.length} sócios`} como contatos?`,
        texto: `${nomes}.\nO sócio-administrador entra como representante legal; os demais, como sócios. Telefone e e-mail você completa depois.`,
        botao: "Importar",
      });
      if (r !== "ok" || FICHA.ctx !== ctx) return;
    }
    const chave = (s) => String(s || "").trim().toLowerCase();
    const ja = new Set((Array.isArray(ctx.dados.contatos) ? ctx.dados.contatos : []).map((x) => chave(x.nome)));
    let n = 0, falhas = 0;
    for (const s of qsa) {
      const nome = String(s.nome_socio || "").trim().slice(0, 150);
      if (!nome || ja.has(chave(nome))) continue;
      const qual = String(s.qualificacao_socio || "").trim();
      try {
        await api(`/api/clients/${ctx.clientId}/contatos`, {
          method: "POST",
          body: JSON.stringify({ nome, papel: fcFichaPapelDoSocio(qual), observacao: qual ? `Quadro de sócios da Receita: ${qual}` : null, principal: false }),
        });
        n += 1;
        ja.add(chave(nome));
      } catch (e) { falhas += 1; }
    }
    if (FICHA.ctx !== ctx) return;
    await fcFichaContatosRecarregar(ctx);
    if (falhas) toast(`${n} sócio(s) importado(s); ${falhas} não puderam ser gravados.`, true);
    else toast(n ? `${n === 1 ? "1 sócio importado" : `${n} sócios importados`} como contato.` : "Todos os sócios já estavam nos contatos.");
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = rotulo; }
  }
}

/* ---------------------------------------------------------
   3.6 Cadastro (formulário cf-)
   ---------------------------------------------------------
   Só o formulário. Os botões são os da barra fixa do rodapé (a casca): no
   modo novo ela fica sempre à vista, com "Cancelar | Cadastrar cliente"; na
   ficha, aparece com a primeira alteração ("Descartar | Salvar"). Um par de
   botões só — antes eram dois "Salvar" na mesma tela. */

function fcFichaFormHtml(c, dono, podeEditar) {
  const form = _clientFormHtml(c, dono, { pfx: "cf-" });
  // Quem só VÊ o módulo Clientes enxerga o cadastro, mas não edita: o
  // fieldset desabilitado trava todos os campos de uma vez.
  return podeEditar ? form : `<fieldset disabled class="fc-ficha-so-leitura">${form}</fieldset>`;
}

async function fcFichaCadastro(el, ctx) {
  const novo = !ctx.clientId;
  const podeEditar = permCanEdit("clients");
  const c = ctx.cliente || { name: "", status: "lead", owner_id: null };
  const dono = podeEditar ? await _ownerFieldHtml(novo ? null : c.owner_id, "col-md-6", "cf-") : "";
  if (!el.isConnected) return;
  el.innerHTML = `
    ${podeEditar ? "" : `<div class="ficha-alerta ficha-alerta-neutral"><i class="bi bi-lock" aria-hidden="true"></i><div>Você pode consultar este cadastro, mas não editá-lo.</div></div>`}
    <div id="fc-ficha-form" class="fc-ficha-form">${fcFichaFormHtml(c, dono, podeEditar)}</div>`;
  const form = el.querySelector("#fc-ficha-form");
  if (podeEditar) {
    fichaVigiarAlteracoes(form, novo
      ? {
        aoSalvar: () => fcFichaSalvarNovo(), aoDescartar: () => fcFichaCancelarNovo(),
        sempreVisivel: true, rotuloSalvar: "Cadastrar cliente", rotuloDescartar: "Cancelar",
      }
      : { aoSalvar: () => fcFichaSalvarCadastro(), aoDescartar: () => fcFichaDescartarCadastro() });
    fcFichaCnpjVigiar(form);
  }
  FICHA.novo.cadastro = () => fcFichaFocar("cf-name");
  if (novo) fcFichaFocar("cf-name", { semRolar: true });
}

/** A consulta da Receita do cadastro (ficha.js) pode publicar o JSON no
 *  evento `ficha-cnpj` (detalhe = resposta da BrasilAPI). Se publicar, o
 *  quadro de sócios fica guardado para a oferta "Importar sócios" da Visão
 *  geral, sem consultar de novo. Sem o evento, a oferta consulta no clique. */
function fcFichaCnpjVigiar(form) {
  if (!form || form.dataset.fcCnpj) return;
  form.dataset.fcCnpj = "1";
  form.addEventListener("ficha-cnpj", (ev) => {
    const j = ev && ev.detail;
    const dig = fichaDigitos(j && j.cnpj);
    if (dig.length !== 14) return;
    FC_FICHA_QSA.cnpj = dig;
    FC_FICHA_QSA.qsa = Array.isArray(j.qsa) ? j.qsa.filter((s) => s && String(s.nome_socio || "").trim()) : [];
  });
}

/** Foca um campo depois que o formulário terminar de se iniciar (máscaras e
 *  valores entram num setTimeout(0) — ver _formAgendarInicio no app.js). */
function fcFichaFocar(id, opts = {}) {
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    if (!opts.semRolar) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 40);
}

/** Descartar: redesenha SÓ o formulário. */
async function fcFichaDescartarCadastro() {
  const ctx = FICHA.ctx;
  const box = document.getElementById("fc-ficha-form");
  if (!ctx || !box) return;
  const podeEditar = permCanEdit("clients");
  const c = ctx.cliente || { name: "", status: "lead", owner_id: null };
  const dono = podeEditar ? await _ownerFieldHtml(ctx.clientId ? c.owner_id : null, "col-md-6", "cf-") : "";
  if (!box.isConnected) return;
  box.innerHTML = fcFichaFormHtml(c, dono, podeEditar);
}

/** Modo novo: POST → cache → #/clientes/<id> (replace) → Visão geral + aviso.
 *  O token da rota é guardado ANTES do POST: se a pessoa saiu da tela enquanto
 *  ele voava, o cadastro fica feito (aviso) e ninguém é arrastado de volta. */
async function fcFichaSalvarNovo() {
  if (FC_FICHA.salvando) return;
  const payload = _clientFormPayload({ pfx: "cf-" });
  if (!payload) return;                          // o próprio payload já avisou e focou
  const tk = fichaRotaToken();
  FC_FICHA.salvando = true;
  let novo;
  try {
    novo = await api("/api/clients", { method: "POST", body: JSON.stringify(payload) });
  } finally { FC_FICHA.salvando = false; }
  await cacheGarantirCliente(novo);
  if (!fichaRotaValida(tk)) {
    toast("Cliente cadastrado. Abra a ficha pela lista de Clientes para completá-la.");
    return;
  }
  fichaMarcarSujo(false);                         // senão a guarda perguntaria "Descartar?"
  await irPara("#/clientes/" + Number(novo.id), { replace: true });
  toast("Cliente cadastrado. Agora complete a ficha.");
}

/** Ficha existente: PUT, e o resto da tela acompanha sem recarregar. */
async function fcFichaSalvarCadastro() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId || FC_FICHA.salvando) return;
  const payload = _clientFormPayload({ pfx: "cf-" });
  if (!payload) return;
  FC_FICHA.salvando = true;
  let salvo;
  try {
    salvo = await api(`/api/clients/${ctx.clientId}`, { method: "PUT", body: JSON.stringify(payload) });
  } finally { FC_FICHA.salvando = false; }
  if (FICHA.ctx !== ctx) return;
  Object.assign(ctx.cliente, salvo);
  await cacheGarantirCliente(salvo);
  // O select de responsável só manda owner_id quando muda (data-orig): o
  // valor salvo vira a nova referência, senão o próximo Salvar o reenviaria.
  const dono = document.getElementById("cf-owner");
  if (dono) dono.dataset.orig = salvo.owner_id === null || salvo.owner_id === undefined ? "" : String(salvo.owner_id);
  fichaMarcarSujo(false);
  fcFichaAtualizarTopo(ctx);
  fichaAtualizarAba("geral");
  toast("Cadastro salvo.");
}

/** Cancelar do modo novo: volta à lista (a guarda pergunta se algo foi digitado). */
function fcFichaCancelarNovo() { irPara("#/clientes", { replace: true }); }

/* ---------------------------------------------------------
   3.7 Processos (+ "Outros casos": precatórios e ações)
   --------------------------------------------------------- */

/** Precatórios e ações do /overview, num formato só. `vinculo` = "cadastro"
 *  (client_id) ou "nome" (mesmo nome — não é prova de que é a mesma pessoa). */
function fcFichaOutrosCasos() {
  const ov = FC_FICHA.overview;
  if (!ov) return [];
  const casos = [];
  if (permCanView("precatorios")) {
    (Array.isArray(ov.precatorios) ? ov.precatorios : []).forEach((p) => casos.push({
      tipo: "precatorio", id: p.id, hash: `#/precatorios/${Number(p.id)}`, icone: "bi-bank",
      titulo: p.numero_precatorio ? `Precatório ${p.numero_precatorio}` : `Precatório #${p.id}`,
      sub: [p.tribunal, p.assunto].filter(Boolean).join(" · "),
      etapa: p.status_lead, valor: p.valor_caso, vinculo: p.vinculo,
    }));
  }
  if (permCanView("acoes")) {
    (Array.isArray(ov.acoes) ? ov.acoes : []).forEach((a) => casos.push({
      tipo: "acao", id: a.id, hash: `#/acoes/${Number(a.id)}`, icone: "bi-briefcase",
      titulo: `Ação · ${typeof ACAO_AREA !== "undefined" && ACAO_AREA[a.area] ? ACAO_AREA[a.area] : (a.area || "sem área")}`,
      sub: [a.numero_processo ? fmtCnj(a.numero_processo) : "", a.assunto].filter(Boolean).join(" · "),
      etapa: a.status_lead, valor: a.valor_causa, vinculo: a.vinculo,
    }));
  }
  return casos;
}

function fcFichaProcessos(el, ctx) {
  const partes = [];
  if (permCanView("processes")) {
    const lista = fcFichaProcessosOrdenados(ctx);
    const tabela = lista.length ? `<div class="table-responsive"><table class="table table-hover ficha-tabela fc-ficha-tabela mb-0">
        <thead><tr><th scope="col">Processo</th><th scope="col">Área · Tribunal</th><th scope="col">Próximo prazo</th><th scope="col">Status</th></tr></thead>
        <tbody>${lista.map((p) => fcFichaLinhaProcesso(ctx, p)).join("")}</tbody></table></div>`
      : uiVazio({
        icone: "bi-folder2-open", titulo: "Nenhum processo ainda",
        texto: "Cadastre o primeiro processo deste cliente. Na ficha do processo você inclui partes, prazos, andamentos e documentos.",
        acaoHtml: fcFichaBtnNovoProcesso(ctx),
      });
    partes.push(uiCard({
      titulo: "Processos",
      descricao: lista.length ? fcListaPlural(lista.length, "processo deste cliente", "processos deste cliente") : "",
      acoesHtml: lista.length ? fcFichaBtnNovoProcesso(ctx) : "",
      corpoHtml: tabela,
      classe: "fc-ficha-card-tabela",
    }));
  }
  const outros = fcFichaOutrosCasos();
  if (outros.length) {
    partes.push(uiCard({
      titulo: "Outros casos",
      descricao: "Precatórios e ações ligados a este cliente — pelo cadastro ou pelo mesmo nome.",
      corpoHtml: `<ul class="fc-ficha-casos">${outros.map(fcFichaCasoHtml).join("")}</ul>`,
    }));
  } else if (!permCanView("processes")) {
    partes.push(uiVazio({ icone: "bi-folder2-open", titulo: "Nenhum caso ligado a este cliente", texto: "Precatórios e ações com o cadastro ou o nome deste cliente aparecem aqui." }));
  }
  el.innerHTML = partes.join("");
}

function fcFichaLinhaProcesso(ctx, p) {
  const id = Number(p.id);
  const h = `#/processos/${id}`;
  const num = fcFichaNumProcesso(p);
  const sub = [p.classe, p.assunto].filter((x) => x && String(x).trim()).join(" · ");
  const area = typeof procAreaLabel === "function" && p.type ? procAreaLabel(p.type) : (p.type || "");
  const local = [p.tribunal, p.vara || p.orgao_julgador].filter((x) => x && String(x).trim()).join(" · ");
  const prox = p.status === "encerrado" ? null : fcFichaProximoPrazo(ctx, p);
  return `<tr class="fc-ficha-linha" tabindex="0" data-on-click="fcFichaAbrirProcesso" data-on-keydown="fcFichaLinhaTecla" data-args="${escArgs(id)}">
    <td class="fc-ficha-td-titulo" data-rotulo="Processo">
      <a class="fc-ficha-proc-num${num ? " fc-ficha-mono" : " fc-ficha-sem-num"}" href="${h}" tabindex="-1" data-on-click="fcFichaAbrirProcesso" data-args="${escArgs(id)}">${esc(num || "Processo sem número")}</a>
      ${sub ? `<div class="fc-ficha-sub">${esc(sub)}</div>` : ""}
    </td>
    <td data-rotulo="Área · Tribunal"><div class="fc-ficha-cel">${esc(area) || '<span class="ficha-traco">—</span>'}${local ? `<div class="fc-ficha-sub">${esc(local)}</div>` : ""}</div></td>
    <td data-rotulo="Próximo prazo"><div class="fc-ficha-cel">${prox ? uiPrazoBadge(prox, false) : '<span class="ficha-traco">—</span>'}</div></td>
    <td data-rotulo="Status"><div class="fc-ficha-cel">${uiStatusProcesso(p.status)}</div></td>
  </tr>`;
}

function fcFichaCasoHtml(k) {
  const etapa = k.etapa ? uiChip("neutral", (typeof PREC_LEAD !== "undefined" && PREC_LEAD[k.etapa]) || k.etapa, "bi-funnel") : "";
  const valor = k.valor !== null && k.valor !== undefined && k.valor !== "" && Number(k.valor) ? `<span class="fc-ficha-caso-valor ficha-num">${esc(fmtMoeda(k.valor))}</span>` : "";
  const nome = k.vinculo === "nome" ? uiChip("warning", "mesmo nome", "bi-person-exclamation", { titulo: "Ligado pelo nome, não pelo cadastro — confira se é a mesma pessoa" }) : "";
  return `<li><a class="fc-ficha-caso" href="${k.hash}" data-on-click="fichaIr" data-args="${escArgs(k.hash)}">
    <span class="fc-ficha-caso-ic" aria-hidden="true"><i class="bi ${k.icone}"></i></span>
    <span class="fc-ficha-caso-txt"><span class="fc-ficha-caso-tit">${esc(k.titulo)}</span>${k.sub ? `<span class="fc-ficha-sub">${esc(k.sub)}</span>` : ""}</span>
    <span class="fc-ficha-caso-chips">${nome}${etapa}${valor}</span>
  </a></li>`;
}

/** AÇÃO: linha (ou número) da tabela abre a ficha do processo. Ctrl/⌘/Shift
 *  abre em outra aba (no link, o próprio navegador faz isso). */
function fcFichaAbrirProcesso(id) {
  const ev = eventoAtual();
  const hash = "#/processos/" + Number(id);
  const link = this instanceof HTMLAnchorElement;
  if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
    if (!link) window.open(location.pathname + location.search + hash, "_blank", "noopener");
    return;
  }
  if (!link) {
    const s = window.getSelection ? window.getSelection() : null;
    if (s && !s.isCollapsed && s.anchorNode && this.contains(s.anchorNode)) return;   // estava selecionando texto
  }
  if (ev && link) ev.preventDefault();
  irPara(hash);
}

/** AÇÃO: Enter na linha (só quando o foco é a própria <tr>); setas andam. */
function fcFichaLinhaTecla(id) {
  const ev = eventoAtual();
  if (!ev || ev.target !== this) return;
  if (ev.key === "Enter") { ev.preventDefault(); irPara("#/processos/" + Number(id)); }
  else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const alvo = ev.key === "ArrowDown" ? this.nextElementSibling : this.previousElementSibling;
    if (alvo) alvo.focus();
  }
}

/* ---------------------------------------------------------
   3.8 Ações do cabeçalho e atalhos
   --------------------------------------------------------- */

/** AÇÃO: link/botão que abre uma aba desta ficha. */
function fcFichaAbaLink(aba) {
  const ev = eventoAtual();
  if (ev && this instanceof HTMLAnchorElement) {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;     // outra aba do navegador
    ev.preventDefault();
  }
  fichaIrAba(aba, { rolar: true });
}

/** AÇÃO: abre a aba já com o formulário de inclusão (FICHA.novo[aba]). */
function fcFichaIrNovo(aba) { fichaIrAba(aba, { novo: true, rolar: true }); }

/** AÇÃO: item pendente do "Complete a ficha" → o lugar exato do preenchimento. */
async function fcFichaPendencia(chave) {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId) return;
  const campos = { doc: "cf-doc", tel: "cf-celular", end: "cf-cep" };
  if (campos[chave]) {
    if (await fichaIrAba("cadastro")) fcFichaFocar(campos[chave]);
    return;
  }
  if (chave === "processo") {
    if (permCanEdit("processes")) irPara(`#/processos/novo?cliente=${Number(ctx.clientId)}`);
    else fichaIrAba("processos", { rolar: true });
    return;
  }
  if (chave === "representante") {
    if (permCanEdit("clients")) fcFichaNovoContato("representante_legal");
    return;
  }
  const destino = { documento: ["documentos", "documents"], honorario: ["financeiro", "financeiro"], atendimento: ["atendimentos", "clients"] }[chave];
  if (destino) fichaIrAba(destino[0], { novo: permCanEdit(destino[1]), rolar: true });
}

/** AÇÃO ("Novo ▾ → Audiência"): a aba Agenda abre por padrão em "Novo prazo";
 *  a audiência usa a função exportada pelo módulo. Sem o módulo, o modal
 *  antigo (com o cliente e os processos dele) faz o serviço. */
async function fcFichaNovoAudiencia() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId) return;
  if (!(await fichaIrAba("agenda", { rolar: true }))) return;
  if (typeof fmAgendaNovo === "function") { await fmAgendaNovo("audiencia"); return; }
  await appointmentModal(null, {
    clientId: ctx.clientId, processos: ctx.processos,
    onSaved: async () => {
      try { ctx.dados.audiencias = await api(`/api/appointments?client_id=${ctx.clientId}`); } catch (e) { /* fica o que havia */ }
      if (FICHA.ctx !== ctx) return;
      fichaAtualizarAba("agenda");
      ctx.aoMudar("audiencias");
    },
  });
}

/** Texto do "o que vai junto" na exclusão — só o que a pessoa enxerga. */
function fcFichaTextoExclusao(ctx) {
  const d = ctx.dados || {};
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  const partes = [];
  if (ctx.processos.length) partes.push(fcListaPlural(ctx.processos.length, "processo (com prazos, audiências, partes e andamentos)", "processos (com prazos, audiências, partes e andamentos)"));
  if (n(d.atendimentos)) partes.push(fcListaPlural(n(d.atendimentos), "atendimento", "atendimentos"));
  if (n(d.contatos)) partes.push(fcListaPlural(n(d.contatos), "contato", "contatos"));
  if (n(d.documentos)) partes.push(fcListaPlural(n(d.documentos), "documento", "documentos"));
  const junta = partes.length > 1 ? partes.slice(0, -1).join(", ") + " e " + partes[partes.length - 1] : (partes[0] || "");
  const arquivado = ctx.cliente && ctx.cliente.status === "arquivado";
  return (junta ? `Vão junto: ${junta}.` : "Não há processos, atendimentos, contatos nem documentos ligados a ele.") +
    "\nIsso não pode ser desfeito." + (arquivado ? "" : " Se a ideia é só tirá-lo da lista, arquive.");
}

/** Honorários e contratos que a PESSOA vê e que impedem a exclusão (o
 *  backend bloqueia os dois — honorário é dinheiro, contrato é documento
 *  assinado). Contratos não estão em ctx.dados: são lidos na hora (só com o
 *  módulo Assinaturas). Falhou a leitura? Conta zero — o 409 do backend
 *  continua sendo a rede de proteção. */
async function fcFichaVinculos(ctx) {
  const hs = ctx.dados && ctx.dados.honorarios;
  const honorarios = Array.isArray(hs) ? hs.length : 0;
  let contratos = 0;
  if (permCanView("assinaturas")) {
    try {
      const l = await api(`/api/assinaturas?client_id=${Number(ctx.clientId)}`);
      contratos = Array.isArray(l) ? l.length : 0;
    } catch (e) { contratos = 0; }
  }
  return { honorarios, contratos };
}

/** Diálogo de "não pode excluir": a saída é arquivar; "Ver honorários" (ou
 *  "Ver contratos") leva direto ao que prende o cliente. */
async function fcFichaBloqueio(ctx, texto, vinc) {
  const arquivado = ctx.cliente && ctx.cliente.status === "arquivado";
  const podeArquivar = !arquivado && permCanEdit("clients");
  const v = vinc || {};
  let ver = null;
  if (v.honorarios && fichaAbaCfg("financeiro")) ver = { rotulo: "Ver honorários", aba: "financeiro" };
  else if (v.contratos && fichaAbaCfg("documentos")) ver = { rotulo: "Ver contratos", aba: "documentos" };
  const r = await confirmar({
    titulo: "Este cliente não pode ser excluído",
    texto,
    botao: podeArquivar ? "Arquivar o cliente" : "Entendi",
    alternativa: ver ? ver.rotulo : null,
    cancelar: "Fechar",
  });
  if (FICHA.ctx !== ctx) return;
  if (r === "ok" && podeArquivar) await fcFichaArquivar(ctx);
  else if (r === "alt" && ver) fichaIrAba(ver.aba, { rolar: true });
}

/** AÇÃO: Excluir (com Arquivar como saída menos destrutiva). Com honorário ou
 *  contrato à vista, abre DIRETO o "não pode excluir" — antes a pessoa
 *  confirmava a exclusão e só então descobria o bloqueio. O 409 do backend
 *  (honorário que a pessoa não vê, processo de outro responsável) continua
 *  tratado, com o texto pronto que ele devolve. */
async function fcFichaExcluir() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.clientId) return;
  const arquivado = ctx.cliente && ctx.cliente.status === "arquivado";
  const vinc = await fcFichaVinculos(ctx);
  if (FICHA.ctx !== ctx) return;
  if (vinc.honorarios || vinc.contratos) {
    const partes = [
      vinc.honorarios ? fcListaPlural(vinc.honorarios, "honorário", "honorários") : "",
      vinc.contratos ? fcListaPlural(vinc.contratos, "contrato ou procuração", "contratos ou procurações") : "",
    ].filter(Boolean).join(" e ");
    await fcFichaBloqueio(ctx,
      `Há ${partes} ${vinc.honorarios + vinc.contratos > 1 ? "ligados" : "ligado"} a este cliente. Honorário é dinheiro e contrato é documento assinado: eles não são apagados junto com o cliente.` +
      (arquivado ? "\nExclua ou desvincule esses registros antes." : "\nPara tirá-lo da lista, arquive — o histórico continua guardado."),
      vinc);
    return;
  }
  const r = await confirmar({
    titulo: "Excluir este cliente?",
    texto: fcFichaTextoExclusao(ctx),
    botao: "Excluir", perigo: true,
    alternativa: arquivado || !permCanEdit("clients") ? null : "Arquivar",
  });
  if (r === "alt") { await fcFichaArquivar(ctx); return; }
  if (r !== "ok") return;
  try {
    await api(`/api/clients/${ctx.clientId}`, { method: "DELETE" });
  } catch (e) {
    if (e && e.status === 409) {
      if (arquivado) { toast(e.message, true); return; }
      await fcFichaBloqueio(ctx, e.message, null);
      return;
    }
    throw e;
  }
  cacheRemoverCliente(ctx.clientId);
  fichaMarcarSujo(false);
  toast("Cliente excluído.");
  irPara("#/clientes", { replace: true });
}

async function fcFichaArquivar(ctx) {
  const salvo = await api(`/api/clients/${ctx.clientId}`, { method: "PUT", body: JSON.stringify({ status: "arquivado" }) });
  await cacheGarantirCliente(salvo);
  if (FICHA.ctx !== ctx) return;
  fcFichaClienteGravado(ctx, salvo);
  toast("Cliente arquivado. Ele continua na lista, no filtro “Arquivados”.");
}

registrarAcoes({
  fcFichaAbaLink, fcFichaIrNovo, fcFichaPendencia, fcFichaCancelarNovo,
  fcFichaContatoSalvar, fcFichaContatoEditar, fcFichaContatoExcluir, fcFichaContatoCancelar,
  fcFichaContatosTentar, fcFichaContatosTodos, fcFichaNovoContato, fcFichaImportarSocios, fcFichaNovoAudiencia,
  fcFichaExcluir, fcFichaAbrirProcesso, fcFichaLinhaTecla,
});
