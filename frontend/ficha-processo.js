/* =========================================================
   ficha-processo.js — lista de Processos (renderProcesses, fase 2) e
   ficha do Processo (fichaProcessoAbrir, fase 3 — escrita DEPOIS do
   marcador "FICHA (fase 3)" no fim deste arquivo).

   Script clássico, mesmo escopo global do app.js e do ficha.js: todo nome
   de topo novo leva o prefixo fp* / FP_*, mais `renderProcesses` e
   `procFiltro` (SPEC §2.3). Para a lista e a ficha não colidirem dentro do
   MESMO prefixo, a lista usa só `fpLista*`/`FP_LISTA*` — a ficha (fase 3)
   não deve usar esse começo.
   Estado global novo? Registre o reset em FICHA_LIMPEZA.
   ========================================================= */

/* =========================================================
   1. LISTA DE PROCESSOS (#/processos) — SPEC §4.2
   =========================================================
   TODOS os filtros vão ao servidor — a mesma processes.py::query_processes
   que o export usa, então a planilha não tem como divergir da tela:
     q (número pelos dígitos, a partir de 4; assunto; classe; nome do
     cliente; nome das partes contrárias), tipo, sistema, status,
     responsavel (só admin) e vencido=1.
   As contagens das pílulas de status vêm de uma 2ª consulta, com os
   MESMOS filtros menos o status (com "Todos" ativo, uma consulta só serve
   para as duas coisas).
   A tela é redesenhada a cada `renderProcesses()` (navigate/roteador):
   voltar da ficha recarrega da API — o que a ficha salvou ou excluiu já
   aparece — e mantém os filtros, que moram em `procFiltro`. */

/** Filtros quando ninguém mexeu. Status padrão = "ativo" (a pílula
 *  "Ativos" vem primeiro): suspensos e encerrados ficam a um
 *  clique, com a contagem à vista. Todos os valores são TEXTO ("" = sem
 *  filtro; vencido = "1" | "") — o export lê estes campos e um booleano
 *  quebraria quem fizer `.trim()`. */
const FP_LISTA_PADRAO = Object.freeze({ busca: "", status: "ativo", tipo: "", sistema: "", responsavel: "", vencido: "" });

/** Filtros da lista. GLOBAIS de propósito: sobrevivem a abrir a ficha e
 *  voltar. O export lê exatamente estes nomes (app.js::exportFiltros):
 *  {busca, status, tipo, sistema, responsavel, vencido} — `busca` vira o `q`
 *  da API e já vem sem espaços nas pontas (o MESMO texto que a lista
 *  mandou). Zerado no logout (FICHA_LIMPEZA, abaixo). */
let procFiltro = Object.assign({}, FP_LISTA_PADRAO);

/** Pílulas de status, na ordem da tela ("" = Todos). */
const FP_LISTA_STATUS = [["ativo", "Ativos"], ["suspenso", "Suspensos"], ["encerrado", "Encerrados"], ["", "Todos"]];

/** Estado da TELA (não é filtro). `todos` = resultado SEM o status (fonte
 *  das contagens); `dados` = o que a tabela mostra; `chave` = filtros (sem
 *  status) que geraram `todos` — trocar só de pílula não reconsulta as
 *  contagens; `voltarPara` = linha que recebe o foco ao voltar da ficha. */
const FP_LISTA = { todos: null, dados: null, erro: null, chave: null, usuarios: null, listaUsuarios: [], voltarPara: null, filtrosAbertos: false };
const FP_LISTA_SEQ = fichaSeq();
const fpListaBuscaAdiada = fichaDebounce(() => fpListaCarregar(), 250);

FICHA_LIMPEZA.push(() => {
  procFiltro = Object.assign({}, FP_LISTA_PADRAO);
  fpListaBuscaAdiada.cancelar();
  FP_LISTA_SEQ.nova();               // resposta em voo do usuário anterior é descartada
  Object.assign(FP_LISTA, { todos: null, dados: null, erro: null, chave: null, usuarios: null, listaUsuarios: [], voltarPara: null, filtrosAbertos: false });
});

/** Entrada da tela (chamada pelo navigate/roteador). */
async function renderProcesses() {
  const c = document.getElementById("view-container");
  if (!c) return;
  if (typeof fcBgGarantir === "function") fcBgGarantir();
  const admin = permIsAdmin();
  // Filtro por responsável é do admin (o backend troca o id de outra pessoa
  // por "meus" para os demais): um valor herdado não pode ficar invisível.
  if (!admin) procFiltro.responsavel = "";
  if (!permCanView("deadlines")) procFiltro.vencido = "";
  // Nada da visita anterior é reaproveitado (nem as contagens): os nomes dos
  // responsáveis também são relidos a cada visita.
  Object.assign(FP_LISTA, { todos: null, dados: null, erro: null, chave: null, usuarios: null });
  FP_LISTA_SEQ.nova();               // resposta em voo da visita anterior é descartada
  const tk = fichaRotaToken();
  const usuarios = admin ? await fpListaUsuarios() : [];
  if (!fichaRotaValida(tk)) return;  // a pessoa já foi para outra tela
  const podeNovo = permCanEdit("processes");
  const verPrazos = permCanView("deadlines");
  const areas = typeof PROC_CATEGORIAS === "object" && PROC_CATEGORIAS
    ? Object.keys(PROC_CATEGORIAS).map((k) => [k, (PROC_CATEGORIAS[k] && PROC_CATEGORIAS[k].label) || k]) : [];
  const sistemas = Array.isArray(typeof PROC_SISTEMAS !== "undefined" ? PROC_SISTEMAS : null) ? PROC_SISTEMAS.map((s) => [s, s]) : [];
  const resp = [["meus", "Meus processos"]].concat(usuarios.map((u) => [String(u.id), u.name]));

  c.innerHTML = `
    <div class="lista-v2 lista-processos">
      <div class="lista-barra">
        <div class="lista-busca">
          <i class="bi bi-search" aria-hidden="true"></i>
          <input id="fp-lista-busca" type="search" class="form-control" autocomplete="off" spellcheck="false"
            placeholder="Número, cliente, parte contrária ou assunto"
            aria-label="Buscar processos por número, cliente, parte contrária ou assunto"
            value="${esc(procFiltro.busca)}" data-on-input="fpListaBuscaInput" data-on-keydown="fpListaBuscaTecla">
        </div>
        <div class="lista-acoes">
          ${admin && typeof auditarDuplicados === "function" ? `<button type="button" class="btn btn-outline-secondary" title="Procurar processos repetidos" data-on-click="auditarDuplicados" data-args="${escArgs("processes")}"><i class="bi bi-files" aria-hidden="true"></i> Duplicados</button>` : ""}
          ${typeof exportBtn === "function" ? exportBtn("processos") : ""}
          ${podeNovo ? `<a class="btn btn-primary" href="#/processos/novo" data-on-click="fichaIr" data-args="${escArgs("#/processos/novo")}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo processo</a>` : ""}
        </div>
      </div>
      <div class="lista-filtros">
        <div class="lista-pilulas" id="fp-lista-pilulas" role="group" aria-label="Filtrar por status">${fpListaPilulasHtml()}</div>
        <button type="button" class="btn btn-sm btn-ficha lista-filtros-btn" id="fp-lista-filtros-btn" aria-controls="fp-lista-selects"
          aria-expanded="${FP_LISTA.filtrosAbertos ? "true" : "false"}" data-on-click="fpListaFiltrosAlternar"><i class="bi bi-sliders" aria-hidden="true"></i> Filtros<span id="fp-lista-filtros-n"></span></button>
        <div class="lista-selects${FP_LISTA.filtrosAbertos ? "" : " is-recolhido"}" id="fp-lista-selects">
          ${fpListaSelectHtml("tipo", "Área", "Todas as áreas", areas)}
          ${fpListaSelectHtml("sistema", "Sistema", "Todos os sistemas", sistemas)}
          ${admin ? fpListaSelectHtml("responsavel", "Responsável", "Todos os responsáveis", resp) : ""}
          ${verPrazos ? `<div class="form-check form-switch lista-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="fp-lista-vencido" ${procFiltro.vencido ? "checked" : ""}
              data-on-change="fpListaCampo" data-args="${escArgs("vencido")}">
            <label class="form-check-label" for="fp-lista-vencido">Só com prazo vencido</label>
          </div>` : ""}
          <button type="button" class="btn btn-sm btn-link lista-limpar" id="fp-lista-limpar" data-on-click="fpListaLimpar" hidden><i class="bi bi-x-lg" aria-hidden="true"></i> Limpar filtros</button>
        </div>
        <span class="lista-total" id="fp-lista-total" aria-live="polite"></span>
      </div>
      <div id="fp-lista-resultado" class="lista-resultado" aria-busy="true">${uiCarregando("Carregando processos…")}</div>
    </div>`;
  fpListaAtualizarControles();
  await fpListaCarregar();
}

/** <select> de filtro. Valor gravado fora da lista (área antiga, usuário
 *  removido) vira opção "(atual)" — senão o select mostraria "Todas" com
 *  um filtro escondido valendo. */
function fpListaSelectHtml(campo, rotulo, vazio, opcoes) {
  const atual = String(procFiltro[campo] || "");
  let html = `<option value="">${esc(vazio)}</option>`;
  html += opcoes.map(([v, r]) => `<option value="${esc(v)}"${String(v) === atual ? " selected" : ""}>${esc(r)}</option>`).join("");
  if (atual && !opcoes.some(([v]) => String(v) === atual)) html += `<option value="${esc(atual)}" selected>${esc(atual)} (atual)</option>`;
  return `<select class="form-select form-select-sm lista-select" id="fp-lista-${esc(campo)}" aria-label="${esc(rotulo)}" title="${esc(rotulo)}"
    data-on-change="fpListaCampo" data-args="${escArgs(campo)}">${html}</select>`;
}

/** Usuários para o select e a coluna Responsável (só o admin lista
 *  usuários). [{id, name}] em ordem alfabética. */
function fpListaUsuarios() {
  if (!permIsAdmin()) return Promise.resolve([]);
  if (!FP_LISTA.usuarios) {
    FP_LISTA.usuarios = api("/api/auth/users")
      .then((us) => {
        const l = (Array.isArray(us) ? us : []).map((u) => ({ id: u.id, name: u.name || "" }))
          .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
        FP_LISTA.listaUsuarios = l;
        return l;
      })
      .catch(() => { FP_LISTA.usuarios = null; return []; });
  }
  return FP_LISTA.usuarios;
}

/** Query string dos filtros. comStatus=false → para as contagens. */
function fpListaQs(comStatus) {
  const f = procFiltro;
  const qs = new URLSearchParams();
  if (f.busca) qs.set("q", f.busca);
  if (f.tipo) qs.set("tipo", f.tipo);
  if (f.sistema) qs.set("sistema", f.sistema);
  if (f.responsavel && permIsAdmin()) qs.set("responsavel", f.responsavel);
  if (f.vencido) qs.set("vencido", "1");
  if (comStatus && f.status) qs.set("status", f.status);
  const s = qs.toString();
  return s ? "?" + s : "";
}

/** Consulta e redesenha. fichaSeq descarta resposta fora de ordem.
 *  opts.soStatus: só a pílula mudou — reaproveita as contagens já
 *  carregadas (mesmos filtros) e consulta, no máximo, a lista do status. */
async function fpListaCarregar(opts = {}) {
  const n = FP_LISTA_SEQ.nova();
  const chave = fpListaQs(false);
  const reaproveita = !!(opts.soStatus && FP_LISTA.todos && !FP_LISTA.erro && FP_LISTA.chave === chave);
  const res = document.getElementById("fp-lista-resultado");
  if (res) { res.classList.add("is-carregando"); res.setAttribute("aria-busy", "true"); }
  let todos = reaproveita ? FP_LISTA.todos : null;
  let dados = null;
  let erro = null;
  try {
    const [t, d] = await Promise.all([
      reaproveita ? Promise.resolve(todos) : api("/api/processes" + chave),
      procFiltro.status ? api("/api/processes" + fpListaQs(true)) : Promise.resolve(null),
      fpListaUsuarios(),
    ]);
    todos = Array.isArray(t) ? t : [];
    dados = procFiltro.status ? (Array.isArray(d) ? d : []) : todos;
  } catch (e) { erro = e; }
  if (!FP_LISTA_SEQ.atual(n)) return;
  FP_LISTA.erro = erro;
  FP_LISTA.todos = erro ? null : todos;
  FP_LISTA.dados = erro ? null : dados;
  FP_LISTA.chave = erro ? null : chave;
  fpListaDesenhar();
}

function fpListaDesenhar() {
  const res = document.getElementById("fp-lista-resultado");
  if (!res) return;                       // a pessoa já saiu da lista
  res.classList.remove("is-carregando"); res.removeAttribute("aria-busy");
  const total = document.getElementById("fp-lista-total");
  if (FP_LISTA.erro) {
    fpListaPilulasAtualizar(null);
    if (total) total.textContent = "";
    res.innerHTML = uiVazio({
      icone: "bi-exclamation-triangle",
      titulo: "Não foi possível carregar os processos",
      texto: (FP_LISTA.erro && FP_LISTA.erro.message) || "Tente novamente em instantes.",
      acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fpListaRecarregar"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Tentar novamente</button>`,
    });
    return;
  }
  const todos = FP_LISTA.todos || [];
  const lista = FP_LISTA.dados || [];
  const cont = { "": todos.length };
  todos.forEach((p) => { cont[p.status] = (cont[p.status] || 0) + 1; });
  fpListaPilulasAtualizar(cont);
  if (total) total.textContent = `${lista.length} ${lista.length === 1 ? "processo" : "processos"}`;
  res.innerHTML = lista.length ? fpListaTabelaHtml(lista) : fpListaVazioHtml(todos.length);
  fpListaFocarVolta();
}

function fpListaPilulasHtml() {
  return FP_LISTA_STATUS.map(([st, rotulo]) =>
    `<button type="button" class="lista-pilula" data-status="${esc(st)}" aria-pressed="${procFiltro.status === st ? "true" : "false"}" data-on-click="fpListaStatus" data-args="${escArgs(st)}">${esc(rotulo)}<span class="lista-pilula-cont" hidden></span></button>`).join("");
}

/** Atualiza as pílulas NO LUGAR (o foco do teclado fica no botão). */
function fpListaPilulasAtualizar(cont) {
  document.querySelectorAll("#fp-lista-pilulas .lista-pilula").forEach((b) => {
    const st = b.dataset.status || "";
    b.setAttribute("aria-pressed", st === procFiltro.status ? "true" : "false");
    const s = b.querySelector(".lista-pilula-cont");
    if (!s) return;
    const n = cont ? (cont[st] || 0) : null;
    s.hidden = n === null;
    s.textContent = n === null ? "" : String(n);
  });
}

/** Há filtro diferente do padrão? (mostra "Limpar filtros"). */
function fpListaTemFiltro() {
  return Object.keys(FP_LISTA_PADRAO).some((k) => String(procFiltro[k] || "") !== FP_LISTA_PADRAO[k]);
}

/** Pílulas, "Limpar filtros", o "Filtros (N)" do celular e o selo do
 *  Exportar, conforme procFiltro. */
function fpListaAtualizarControles() {
  fpListaPilulasAtualizar(null);
  const limpar = document.getElementById("fp-lista-limpar");
  if (limpar) limpar.hidden = !fpListaTemFiltro();
  const n = ["tipo", "sistema", "responsavel", "vencido"].filter((k) => String(procFiltro[k] || "") !== "").length;
  const cont = document.getElementById("fp-lista-filtros-n");
  if (cont) cont.textContent = n ? ` (${n})` : "";
  if (typeof exportAtualizarSelo === "function") exportAtualizarSelo("processos");
}

/** AÇÃO — celular: "Filtros (N)" mostra/recolhe os selects (no desktop eles
 *  ficam sempre à vista e o botão nem aparece — CSS). */
function fpListaFiltrosAlternar() {
  FP_LISTA.filtrosAbertos = !FP_LISTA.filtrosAbertos;
  const box = document.getElementById("fp-lista-selects");
  if (box) box.classList.toggle("is-recolhido", !FP_LISTA.filtrosAbertos);
  if (this instanceof Element) this.setAttribute("aria-expanded", FP_LISTA.filtrosAbertos ? "true" : "false");
}

function fpListaTabelaHtml(lista) {
  const ctx = {
    admin: permIsAdmin(),
    verCli: permCanView("clients"),
    verPrazos: permCanView("deadlines"),
    mapa: Object.fromEntries((FP_LISTA.listaUsuarios || []).map((u) => [u.id, u.name])),
  };
  return `<div class="lista-card"><div class="table-responsive">
    <table class="table table-hover lista-tabela ficha-tabela mb-0">
      <thead><tr>
        <th scope="col">Processo</th>
        <th scope="col">Partes</th>
        <th scope="col">Área · Tribunal/Vara</th>
        ${ctx.verPrazos ? '<th scope="col">Próximo prazo</th>' : ""}
        <th scope="col">Status</th>
        ${ctx.admin ? '<th scope="col">Responsável</th>' : ""}
      </tr></thead>
      <tbody>${lista.map((p) => fpListaLinhaHtml(p, ctx)).join("")}</tbody>
    </table></div></div>`;
}

/** Uma linha. A linha inteira abre a ficha do processo; tudo que é
 *  clicável DENTRO dela tem `data-on-click` próprio:
 *    - número: link para a ficha (Ctrl/meio-clique abre em outra aba),
 *      fora do Tab (tabindex=-1) porque a linha já é focável;
 *    - cliente: link para a FICHA DO CLIENTE (`fichaIr`), no Tab — é outro
 *      destino. Só vira link para quem tem o módulo Clientes. */
function fpListaLinhaHtml(p, ctx) {
  const id = Number(p.id);
  const hash = "#/processos/" + id;
  const num = p.case_number && String(p.case_number).trim() ? fmtCnj(p.case_number) : "";
  const titulo = `<a class="lista-nome${num ? " lista-mono" : " lista-sem-numero"}" href="${hash}" tabindex="-1" data-on-click="fpListaAbrir" data-args="${escArgs(id)}">${esc(num || "Processo sem número")}</a>`;
  const sub = [p.classe, p.assunto].filter((x) => x && String(x).trim()).join(" · ") || p.subcategoria || "";

  const cliHash = "#/clientes/" + Number(p.client_id);
  const cliente = p.client_name
    ? (ctx.verCli && p.client_id
      ? `<a class="lista-parte-cli" href="${cliHash}" data-on-click="fichaIr" data-args="${escArgs(cliHash)}">${esc(p.client_name)}</a>`
      : `<strong class="lista-parte-cli">${esc(p.client_name)}</strong>`)
    : '<span class="ficha-traco">—</span>';
  const contra = p.partes_contrarias ? `<div class="lista-sub lista-contra"><span aria-hidden="true">×</span><span class="visually-hidden">contra</span> ${esc(p.partes_contrarias)}</div>` : "";

  const area = p.type ? (typeof procAreaLabel === "function" ? procAreaLabel(p.type) : p.type) : "";
  const local = [p.tribunal, p.vara || p.orgao_julgador || p.foro].filter((x) => x && String(x).trim()).join(" · ");

  const prazo = p.proximo_prazo ? uiPrazoBadge(p.proximo_prazo) : '<span class="ficha-traco">—</span>';
  const resp = p.owner_id
    ? `<span class="lista-resp">${uiAvatar(ctx.mapa[p.owner_id] || "?")}<span>${esc(ctx.mapa[p.owner_id] || "Usuário #" + p.owner_id)}</span></span>`
    : '<span class="ficha-traco">Sem responsável</span>';

  return `<tr class="lista-linha" tabindex="0" data-id="${id}" data-on-click="fpListaAbrir" data-on-keydown="fpListaTecla" data-args="${escArgs(id)}">
    <td class="lista-td-titulo" data-rotulo="Processo"><div class="lista-cel-esq">${titulo}${sub ? `<div class="lista-sub">${esc(sub)}</div>` : ""}</div></td>
    <td data-rotulo="Partes"><div class="lista-cel">${cliente}${contra}</div></td>
    <td data-rotulo="Área"><div class="lista-cel">${area ? esc(area) : '<span class="ficha-traco">—</span>'}${local ? `<div class="lista-sub">${esc(local)}</div>` : ""}</div></td>
    ${ctx.verPrazos ? `<td data-rotulo="Próximo prazo"><div class="lista-cel">${prazo}</div></td>` : ""}
    <td data-rotulo="Status"><div class="lista-cel">${uiStatusProcesso(p.status)}${p.sistema_eletronico ? `<div class="lista-sub">${esc(p.sistema_eletronico)}</div>` : ""}</div></td>
    ${ctx.admin ? `<td data-rotulo="Responsável"><div class="lista-cel">${resp}</div></td>` : ""}
  </tr>`;
}

/** Vazio que orienta: nada cadastrado, filtros sem resultado, ou status
 *  sem nenhum (com N nos outros). */
function fpListaVazioHtml(totalSemStatus) {
  const podeNovo = permCanEdit("processes");
  const novo = podeNovo ? `<a class="btn btn-sm btn-primary" href="#/processos/novo" data-on-click="fichaIr" data-args="${escArgs("#/processos/novo")}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Novo processo</a>` : "";
  if (totalSemStatus > 0) {
    const rotulo = (FP_LISTA_STATUS.find(([s]) => s === procFiltro.status) || ["", "este status"])[1];
    return uiVazio({
      icone: "bi-funnel",
      titulo: `Nenhum processo em “${rotulo}”`,
      texto: `${totalSemStatus === 1 ? "Há 1 processo" : `Há ${totalSemStatus} processos`} em outros status com estes filtros.`,
      acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fpListaStatus" data-args="${escArgs("")}">Ver todos</button>`,
    });
  }
  const outros = Object.keys(FP_LISTA_PADRAO).some((k) => k !== "status" && String(procFiltro[k] || "") !== FP_LISTA_PADRAO[k]);
  if (outros) {
    return uiVazio({
      icone: "bi-search",
      titulo: "Nenhum processo encontrado com estes filtros",
      texto: procFiltro.busca
        ? `Nada corresponde a “${procFiltro.busca}”. Busque pelo número (com ou sem pontuação, ao menos 4 dígitos), nome do cliente, parte contrária ou assunto.`
        : "Afrouxe os filtros acima ou limpe todos para ver a lista inteira.",
      acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fpListaLimpar"><i class="bi bi-x-lg" aria-hidden="true"></i> Limpar filtros</button>${novo}`,
    });
  }
  return uiVazio({
    icone: "bi-folder2-open",
    titulo: "Nenhum processo cadastrado ainda",
    texto: podeNovo
      ? "Cadastre o primeiro processo. Ele fica ligado a um cliente e, na ficha, reúne partes, andamentos, prazos e documentos."
      : "Quando houver processos sob a sua responsabilidade, eles aparecem aqui.",
    acaoHtml: novo,
  });
}

/** Depois de voltar da ficha, a linha aberta recebe o foco (uma vez). */
function fpListaFocarVolta() {
  const id = FP_LISTA.voltarPara;
  FP_LISTA.voltarPara = null;
  if (!id) return;
  fpListaFocarLinha(document.querySelector(`#fp-lista-resultado tr[data-id="${Number(id)}"]`));
}
function fpListaFocarLinha(tr) {
  if (!tr) return;
  try { tr.focus({ preventScroll: true }); } catch (e) { tr.focus(); }
  const r = tr.getBoundingClientRect();
  if (r.top < 70 || r.bottom > window.innerHeight) tr.scrollIntoView({ block: "center" });
}

/* --- ações da lista (registradas no fim da seção) --- */

/** Digitação na busca: debounce de 250 ms; mesmo texto não reconsulta. */
function fpListaBuscaInput() {
  procFiltro.busca = String(this.value || "").trim();
  fpListaAtualizarControles();
  if (FP_LISTA.todos && !FP_LISTA.erro && FP_LISTA.chave === fpListaQs(false)) {
    // Voltou ao texto que já está na tela: nada a buscar — e a consulta de
    // um texto intermediário que ainda esteja em voo é descartada.
    fpListaBuscaAdiada.cancelar();
    FP_LISTA_SEQ.nova();
    fpListaDesenhar();
    return;
  }
  fpListaBuscaAdiada();
}

/** Enter busca na hora; Esc limpa; seta para baixo desce para a 1ª linha. */
function fpListaBuscaTecla() {
  const ev = eventoAtual();
  if (!ev) return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    fpListaBuscaAdiada.cancelar();
    procFiltro.busca = String(this.value || "").trim();
    fpListaAtualizarControles();
    fpListaCarregar();
  } else if (ev.key === "Escape" && this.value) {
    ev.preventDefault();
    this.value = "";
    fpListaBuscaInput.call(this);
  } else if (ev.key === "ArrowDown") {
    const tr = document.querySelector("#fp-lista-resultado tr.lista-linha");
    if (tr) { ev.preventDefault(); fpListaFocarLinha(tr); }
  }
}

/** Selects (área, sistema, responsável) e a chave "Só com prazo vencido". */
function fpListaCampo(campo) {
  if (!["tipo", "sistema", "responsavel", "vencido"].includes(campo)) return;
  procFiltro[campo] = campo === "vencido" ? (this.checked ? "1" : "") : String(this.value || "");
  fpListaAtualizarControles();
  fpListaCarregar();
}

function fpListaStatus(st) {
  procFiltro.status = FP_LISTA_STATUS.some(([s]) => s === st) ? st : "";
  fpListaAtualizarControles();
  fpListaCarregar({ soStatus: true });
}

function fpListaRecarregar() { fpListaCarregar(); }

/** Volta tudo ao padrão (inclusive a pílula "Ativos") e redesenha a tela. */
function fpListaLimpar() {
  fpListaBuscaAdiada.cancelar();
  procFiltro = Object.assign({}, FP_LISTA_PADRAO);
  renderProcesses();
}

function fpListaTemSelecao(el) {
  const s = window.getSelection ? window.getSelection() : null;
  return !!(s && !s.isCollapsed && s.anchorNode && el.contains(s.anchorNode));
}

/** Clique na linha (ou no número): abre a ficha. Ctrl/⌘/Shift abre em
 *  outra aba — no número o próprio navegador faz isso; na linha, window.open. */
function fpListaAbrir(id) {
  const ev = eventoAtual();
  const hash = "#/processos/" + Number(id);
  const link = this instanceof HTMLAnchorElement;
  if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
    if (!link) window.open(location.pathname + location.search + hash, "_blank", "noopener");
    return;
  }
  if (!link && fpListaTemSelecao(this)) return;
  if (ev && link) ev.preventDefault();
  FP_LISTA.voltarPara = Number(id);
  irPara(hash);
}

/** Teclado na linha: Enter abre SÓ com o foco na própria <tr> (Enter no
 *  link do cliente segue o link); setas andam entre as linhas. */
function fpListaTecla(id) {
  const ev = eventoAtual();
  if (!ev || ev.target !== this) return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    FP_LISTA.voltarPara = Number(id);
    irPara("#/processos/" + Number(id));
  } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const alvo = ev.key === "ArrowDown" ? this.nextElementSibling : this.previousElementSibling;
    if (alvo) fpListaFocarLinha(alvo);
    else if (ev.key === "ArrowUp") { const i = document.getElementById("fp-lista-busca"); if (i) i.focus(); }
  }
}

registrarAcoes({
  fpListaBuscaInput, fpListaBuscaTecla, fpListaCampo, fpListaStatus, fpListaRecarregar, fpListaLimpar,
  fpListaAbrir, fpListaTecla, fpListaFiltrosAlternar,
});

// ===== FICHA (fase 3) =====
// Daqui para baixo: ficha do Processo (fichaProcessoAbrir).
// A lista acima recarrega sozinha a cada renderProcesses() — depois de salvar
// ou excluir, basta voltar para "#/processos" (fichaVoltar/irPara); os filtros
// de procFiltro continuam valendo e a linha aberta recebe o foco.

/* =========================================================
   2. FICHA DO PROCESSO (#/processos/:id e #/processos/novo) — SPEC §4.4
   =========================================================
   Entrada: fichaProcessoAbrir(id|null, {aba, query}), chamada pelo roteador
   (ficha.js). Monta o `ctx` do contrato da fase 3 — o MESMO objeto em todas
   as abas, guardado em FICHA.ctx —, pré-carrega ctx.dados em paralelo
   (Promise.allSettled: fonte que responde 403 vira null e só some o que
   depende dela; a ficha abre do mesmo jeito) e desenha a casca (fichaRender).

   Abas próprias: Visão geral, Cadastro (formulário `fp-` do app.js — era
   "Dados"; o id da aba também virou "cadastro", e ?aba=dados antigo ainda
   abre o formulário) e Partes (formulário `fmp-`). As outras são módulos do ficha-modulos.js (fm*),
   chamados com `typeof`: se o módulo faltar, a aba mostra um aviso em vez de
   quebrar a ficha.

   Depois de QUALQUER gravação — aqui ou dentro de um módulo — roda
   ctx.aoMudar(motivo), que recalcula cabeçalho, alertas, KPIs, contadores e o
   "Complete a ficha" a partir de ctx.dados. Nunca recarrega a ficha inteira:
   isso apagaria uma edição ainda não salva no Cadastro.

   Prefixos de topo desta parte: fpFicha* / FP_FICHA* (a lista acima usa
   fpLista*). Datas puras (AAAA-MM-DD) nunca passam por new Date(str). */

/** Estado desta ficha que não cabe no ctx do contrato. Zerado a cada
 *  abertura e no logout (FICHA_LIMPEZA). */
const FP_FICHA = { usuarios: {}, parteEditando: null, parteRascunho: null, origemCliente: null, rascunho: null, salvando: false, alcancaCliente: false, nHon: null };
/** `parteRascunho` = o que está digitado no formulário de parte (fmp-) — a aba
 *  Partes é redesenhada quando fica desatualizada (o polo do cliente mudou no
 *  Cadastro, outra parte foi gravada) e o texto não pode sumir com ela, como
 *  o rascunho dos módulos. `nHon` = quantos honorários havia (o 1º pergunta
 *  "cliente ativo?"). */
function fpFichaEstadoZerar() {
  Object.assign(FP_FICHA, { usuarios: {}, parteEditando: null, parteRascunho: null, origemCliente: null, rascunho: null, salvando: false, alcancaCliente: false, nHon: null });
}
FICHA_LIMPEZA.push(fpFichaEstadoZerar);

/** Abas que mostram cada dado de ctx.dados. Quando o dado muda, as que NÃO
 *  estão na tela ficam marcadas para redesenhar na próxima visita (a que está
 *  na tela é redesenhada pelo próprio módulo que gravou). */
const FP_FICHA_DEPENDE = {
  prazos: ["agenda", "andamentos"],
  audiencias: ["agenda", "andamentos"],
  documentos: ["documentos", "andamentos"],
  atendimentos: ["andamentos"],
  honorarios: ["financeiro", "andamentos"],
  andamentos: ["andamentos"],
  publicacoes: ["andamentos"],
  partes: ["partes", "andamentos"],
  processo: ["partes", "andamentos"],      // Partes mostra o polo do cliente
};

/** Abas de módulo com contador, na ordem da barra. */
const FP_FICHA_CONTADORES = ["partes", "andamentos", "agenda", "documentos", "financeiro"];

function fpFichaTem(v) { return v !== null && v !== undefined && String(v).trim() !== ""; }

/** A aba existe para este usuário? (mesma régua dos módulos: Agenda aparece
 *  com Prazos OU Audiências; Documentos e Financeiro pelo próprio módulo). */
function fpFichaAbaVisivel(id) {
  if (id === "agenda") return permCanView("deadlines") || permCanView("appointments");
  if (id === "documentos") return permCanView("documents");
  if (id === "financeiro") return permCanView("financeiro");
  return true;
}

/** "Agora" no formato de fichaChaveData ("AAAA-MM-DDTHH:MM"), pela hora LOCAL. */
function fpFichaAgoraChave() {
  const d = new Date();
  return `${ymd(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fpFichaPlural(n, um, varios) { return `${n} ${n === 1 ? um : varios}`; }

/** Texto corrido de no máximo `n` caracteres (espaços colapsados). */
function fpFichaResumir(s, n) {
  const t = String(s === null || s === undefined ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/** `created_at` vem do servidor em UTC SEM fuso (datetime.utcnow): lido como
 *  local, um cadastro feito às 22h em Brasília apareceria no dia seguinte.
 *  É data-HORA (não data pura), então converter pelo Date com "Z" é correto. */
function fpFichaDataCadastro(s) {
  const t = String(s === null || s === undefined ? "" : s).trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return t ? fmtDate(fichaSoData(t) || "") : "";
  const dt = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : t + "Z");
  return isNaN(dt.getTime()) ? "" : fmtDate(ymd(dt));
}

/** Número CNJ formatado, ou "" quando o processo não tem número. */
function fpFichaNumero(p) {
  return p && fpFichaTem(p.case_number) ? fmtCnj(p.case_number) : "";
}

/** O cliente só vira link se estiver em CACHE.clients (= a pessoa abre a
 *  ficha dele). Processo próprio com cliente de outro responsável mostra só
 *  o nome — o link levaria a "sem acesso". */
function fpFichaClienteNoCache(id) {
  if (!id || !permCanView("clients") || !Array.isArray(CACHE.clients)) return false;
  return CACHE.clients.some((c) => Number(c.id) === Number(id));
}

function fpFichaClienteHtml(p, classe) {
  const nome = p.client_name || (p.client_id ? "Cliente #" + p.client_id : "");
  if (!nome) return '<span class="ficha-traco">—</span>';
  const cls = classe ? ` class="${classe}"` : "";
  if (!fpFichaClienteNoCache(p.client_id)) return `<span${cls}>${esc(nome)}</span>`;
  const h = "#/clientes/" + Number(p.client_id);
  return `<a${cls} href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}">${esc(nome)}</a>`;
}

/** Admin vê o nome; o dono vê "Você"; o estagiário (que vê tudo), "Atribuído". */
function fpFichaResponsavel(p) {
  if (!p || !p.owner_id) return "Sem responsável";
  if (CURRENT_USER && Number(p.owner_id) === Number(CURRENT_USER.id)) return "Você";
  if (permIsAdmin()) return FP_FICHA.usuarios[p.owner_id] || "Usuário #" + p.owner_id;
  return "Atribuído";
}

/* ---------------------------------------------------------
   2.1 Entrada e carregamento
   --------------------------------------------------------- */

/** Entrada da ficha (roteador). id null = cadastro (#/processos/novo). */
async function fichaProcessoAbrir(id, opts = {}) {
  const o = opts || {};
  const q = o.query || {};
  fpFichaEstadoZerar();
  if (id === null || id === undefined) return fpFichaAbrirNovo(q);
  // A aba "Dados" virou "Cadastro" (o mesmo nome da ficha do cliente): link
  // antigo com ?aba=dados continua abrindo o formulário.
  const aba = o.aba === "dados" ? "cadastro" : o.aba;
  const tk = fichaRotaToken();
  let processo;
  try {
    processo = await api("/api/processes/" + Number(id));
  } catch (e) {
    if (!fichaRotaValida(tk)) return;
    // 404/403: "não existe ou não é seu" — orientação + caminho de volta.
    if (e && (e.status === 404 || e.status === 403)) { fichaNaoEncontrada("#/processos", "Processos"); return; }
    throw e;
  }
  if (!fichaRotaValida(tk)) return;
  const ctx = fpFichaMontarCtx(processo);
  if (!(await fpFichaPreCarregar(ctx, tk))) return;
  const ok = await fichaRender(Object.assign(fpFichaTopo(ctx), {
    ctx,
    trilha: [{ rotulo: "Processos", hash: "#/processos" }],
    abas: fpFichaAbas(ctx),
    abaAtiva: aba || null,
  }));
  if (ok) fpFichaTopoExtras();
}

/** Complementos do cabeçalho que a casca não desenha (o menu "⋯" do
 *  celular, com o Excluir). Depois de CADA desenho do topo. */
function fpFichaTopoExtras() { fmTopoMenuMais(); }

/** Redesenha cabeçalho, alertas e KPIs a partir do ctx (e os complementos). */
function fpFichaAtualizarTopo(ctx) {
  fichaAtualizarCabecalho(fpFichaTopo(ctx));
  fpFichaTopoExtras();
}

function fpFichaMontarCtx(processo) {
  const ctx = {
    tipo: "processo", clientId: processo.client_id || null, processId: processo.id,
    cliente: null, processo, processos: [processo],
    dados: {},
    // Resposta atrasada de um módulo de OUTRA ficha (o usuário já saiu) não
    // pode redesenhar a ficha que está na tela.
    aoMudar: (motivo) => { if (FICHA.ctx === ctx) fpFichaAoMudar(motivo); },
  };
  return ctx;
}

/** URL de cada fonte de ctx.dados (pré-carga e recarga). */
function fpFichaFonteUrl(ctx, chave) {
  const pid = Number(ctx.processId);
  const urls = {
    prazos: `/api/deadlines?process_id=${pid}`,
    audiencias: `/api/appointments?process_id=${pid}`,
    documentos: `/api/documents?process_id=${pid}`,
    honorarios: `/api/honorarios?process_id=${pid}`,
    andamentos: `/api/processes/${pid}/andamentos`,
    publicacoes: `/api/publicacoes?process_id=${pid}`,
    partes: `/api/processes/${pid}/partes`,
    atendimentos: ctx.clientId ? `/api/clients/${Number(ctx.clientId)}/atendimentos?process_id=${pid}` : null,
  };
  return urls[chave] || null;
}

/** A fonte vale a consulta? (sem o módulo, nem pergunta: viria 403). */
function fpFichaFontePermitida(ctx, chave) {
  switch (chave) {
    case "prazos": return permCanView("deadlines");
    case "audiencias": return permCanView("appointments");
    case "documentos": return permCanView("documents");
    case "honorarios": return permCanView("financeiro");
    // Atendimento é do CLIENTE: sem alcançar o cliente, a rota daria 403.
    case "atendimentos": return permCanView("clients") && !!ctx.clientId && FP_FICHA.alcancaCliente;
    default: return true;
  }
}

/** A pessoa abre a ficha deste cliente? Admin e estagiário veem todos os
 *  clientes; o advogado, só os dele — é exatamente o que /api/clients lista
 *  (CACHE.clients). Saber ANTES evita pedir o cliente e os atendimentos só
 *  para colher um 403 (processo próprio com cliente de outro responsável). */
async function fpFichaAlcancaCliente(cid) {
  if (!cid || !permCanView("clients")) return false;
  if (permIsAdmin() || permIsEstagiario()) return true;
  await cacheGarantirCliente(null);
  if (fpFichaClienteNoCache(cid)) return true;
  // O cache pode ser de antes de o cliente existir: relê a lista uma vez.
  try { CACHE.clients = await api("/api/clients"); } catch (e) { return false; }
  return fpFichaClienteNoCache(cid);
}

/** Pré-carga em paralelo. Cada chave de ctx.dados fica com a lista ou null
 *  (sem acesso/erro). Nenhuma falha derruba a ficha.
 *  `tk` = token da rota de quem abriu: depois de CADA await, se a pessoa já
 *  foi para outra ficha, nada é gravado em FP_FICHA (que já é da ficha nova)
 *  e a função devolve false. */
async function fpFichaPreCarregar(ctx, tk) {
  const valido = () => tk === undefined || fichaRotaValida(tk);
  const chaves = ["prazos", "audiencias", "documentos", "atendimentos", "honorarios", "andamentos", "publicacoes", "partes"];
  const alcanca = await fpFichaAlcancaCliente(ctx.clientId);
  if (!valido()) return false;
  FP_FICHA.alcancaCliente = alcanca;
  const extras = [
    ["cliente", FP_FICHA.alcancaCliente ? api("/api/clients/" + Number(ctx.clientId)) : null],
    ["usuarios", permIsAdmin() ? api("/api/auth/users") : null],
  ];
  const fontes = extras.concat(chaves.map((k) => [k, fpFichaFontePermitida(ctx, k) ? api(fpFichaFonteUrl(ctx, k)) : null]));
  const rs = await Promise.allSettled(fontes.map(([, pr]) => pr || Promise.resolve(null)));
  if (!valido()) return false;
  const val = {};
  rs.forEach((r, i) => {
    const k = fontes[i][0];
    if (r.status === "fulfilled") { val[k] = r.value; return; }
    val[k] = null;
    // 403 é previsto (cliente de outro responsável, módulo sem permissão):
    // aviso no console, e o bloco que depende dele some.
    fichaLogErro(`ao carregar "${k}" do processo #${ctx.processId}`, r.reason);
  });
  ctx.cliente = val.cliente && typeof val.cliente === "object" && !Array.isArray(val.cliente) ? val.cliente : null;
  if (!ctx.cliente) FP_FICHA.alcancaCliente = false;
  FP_FICHA.usuarios = Object.fromEntries((Array.isArray(val.usuarios) ? val.usuarios : []).map((u) => [u.id, u.name]));
  const dados = {};
  chaves.forEach((k) => { dados[k] = Array.isArray(val[k]) ? val[k] : null; });
  ctx.dados = dados;
  FP_FICHA.nHon = Array.isArray(dados.honorarios) ? dados.honorarios.length : null;
  // Cliente cadastrado depois de o cache ser lido (outra aba, outro colega)
  // entra nele agora — é o cache que decide o link e o select do Cadastro.
  if (ctx.cliente) await cacheGarantirCliente(ctx.cliente);
  return valido();
}

/** Recarrega UMA fonte (usada quando a gravação foi feita por um modal do
 *  app.js, sem módulo que atualize ctx.dados sozinho). */
async function fpFichaRecarregarFonte(ctx, chave) {
  const url = fpFichaFonteUrl(ctx, chave);
  if (!url || !fpFichaFontePermitida(ctx, chave)) return;
  try {
    const l = await api(url);
    if (FICHA.ctx !== ctx) return;
    ctx.dados[chave] = Array.isArray(l) ? l : [];
  } catch (e) {
    if (FICHA.ctx === ctx) toast(e.message, true);
    return;
  }
  ctx.aoMudar(chave);
  // Sem módulo para redesenhar a aba da tela, a ficha redesenha.
  if ((FP_FICHA_DEPENDE[chave] || []).includes(FICHA.aba)) fichaAtualizarAba(FICHA.aba);
}

/* ---------------------------------------------------------
   2.2 Cabeçalho, alertas, KPIs e contadores (tudo a partir do ctx)
   --------------------------------------------------------- */

/** Campos do fichaRender que dependem dos dados — o mesmo objeto serve para
 *  o desenho inicial e para fichaAtualizarCabecalho. */
function fpFichaTopo(ctx) {
  const p = ctx.processo;
  const num = fpFichaNumero(p);
  const sub = [p.classe, p.assunto].filter(fpFichaTem).join(" · ") || (fpFichaTem(p.subcategoria) ? p.subcategoria : "");
  return {
    titulo: num || "Processo sem número",
    tituloDocumento: num ? "Processo " + num : "Processo sem número",
    tituloMono: !!num,
    copiar: num || "",
    subtitulo: sub,
    chips: fpFichaChips(p),
    meta: fpFichaMeta(ctx),
    menuNovo: fpFichaMenuNovo(ctx),
    acoes: [{ rotulo: "Excluir", icone: "bi-trash", acao: "fpFichaExcluir", tom: "perigo", oculto: !(permPodeExcluir() && permCanEdit("processes")) }],
    alertas: fpFichaAlertas(ctx),
    kpis: fpFichaKpis(ctx),
  };
}

function fpFichaChips(p) {
  const st = { ativo: ["success", "bi-play-circle"], suspenso: ["warning", "bi-pause-circle"], encerrado: ["neutral", "bi-stop-circle"] }[p.status] || ["neutral", ""];
  return [
    fpFichaTem(p.type) ? { tom: "accent", texto: procAreaLabel(p.type), icone: "bi-bookmark" } : null,
    { tom: st[0], texto: fichaRotulo("processoStatus", p.status) || "Sem status", icone: st[1], tracejado: p.status === "encerrado" },
    fpFichaTem(p.fase_processual) ? { tom: "neutral", texto: p.fase_processual, icone: "bi-signpost-split" } : null,
    fpFichaTem(p.instancia) ? { tom: "neutral", texto: fichaRotulo("instancia", p.instancia), icone: "bi-bank" } : null,
    fpFichaTem(p.sistema_eletronico) ? { tom: "neutral", texto: p.sistema_eletronico, icone: "bi-pc-display" } : null,
  ].filter(Boolean);
}

function fpFichaMeta(ctx) {
  const p = ctx.processo;
  const valor = p.valor_causa !== null && p.valor_causa !== undefined && p.valor_causa !== "";
  return [
    { rotulo: "Cliente", html: fpFichaClienteHtml(p) },
    fpFichaTem(p.polo_cliente) ? { rotulo: "Polo do cliente", html: esc(fichaRotulo("partePolo", p.polo_cliente)) } : null,
    { rotulo: "Responsável", html: esc(fpFichaResponsavel(p)) },
    fpFichaTem(p.data_distribuicao) ? { rotulo: "Distribuído em", html: `<span class="ficha-num">${esc(fmtDate(fichaSoData(p.data_distribuicao)))}</span>` } : null,
    valor ? { rotulo: "Valor da causa", html: `<span class="ficha-num">${esc(fmtMoeda(p.valor_causa))}</span>` } : null,
  ].filter(Boolean);
}

/** "Novo ▾" — cada item some sem a permissão de editar o módulo dele. */
function fpFichaMenuNovo(ctx) {
  const d = ctx.dados || {};
  return [
    { rotulo: "Prazo", icone: "bi-alarm", acao: "fpFichaNovoAgenda", args: ["prazo"], oculto: !(fpFichaAbaVisivel("agenda") && permCanEdit("deadlines")) },
    { rotulo: "Audiência", icone: "bi-calendar-event", acao: "fpFichaNovoAgenda", args: ["audiencia"], oculto: !(fpFichaAbaVisivel("agenda") && permCanEdit("appointments")) },
    { rotulo: "Andamento", icone: "bi-list-check", aba: "andamentos", oculto: !permCanEdit("processes") },
    { rotulo: "Documento", icone: "bi-file-earmark-arrow-up", aba: "documentos", oculto: !permCanEdit("documents") },
    // Atendimento é do CLIENTE: some se a pessoa não alcança o cliente deste
    // processo (o GET deu 403) ou se o formulário (módulos) não carregou.
    { rotulo: "Atendimento", icone: "bi-chat-dots", acao: "fpFichaNovoAtendimento",
      oculto: !(permCanEdit("clients") && Array.isArray(d.atendimentos) && typeof fmAtendimentoModal === "function") },
    { rotulo: "Honorário", icone: "bi-cash-coin", aba: "financeiro", oculto: !permCanEdit("financeiro") },
    { rotulo: "Parte", icone: "bi-person-plus", aba: "partes", oculto: !permCanEdit("processes") },
  ];
}

/** Link discreto dentro de um alerta, que abre uma aba. */
function fpFichaAlertaLink(aba, rotulo) {
  if (!fpFichaAbaVisivel(aba)) return "";
  return ` <button type="button" class="fp-ficha-alerta-link" data-on-click="fichaKpiClique" data-args="${escArgs(aba)}">${esc(rotulo)}</button>`;
}

function fpFichaAlertas(ctx) {
  const d = ctx.dados || {};
  const hoje = ymd(new Date());
  const out = [];
  if (Array.isArray(d.prazos)) {
    const abertos = d.prazos.filter((x) => !x.done && fichaSoData(x.date))
      .sort((a, b) => fichaSoData(a.date).localeCompare(fichaSoData(b.date)));
    const vencidos = abertos.filter((x) => fichaSoData(x.date) < hoje);
    const hojeL = abertos.filter((x) => fichaSoData(x.date) === hoje);
    if (vencidos.length) {
      const x = vencidos[0];
      const det = vencidos.length === 1
        ? `${esc(fpFichaResumir(x.description, 90))} — venceu em ${esc(fmtDate(fichaSoData(x.date)))}.`
        : `O mais antigo: ${esc(fpFichaResumir(x.description, 70))} (${esc(fmtDate(fichaSoData(x.date)))}).`;
      out.push({ tom: "danger", icone: "bi-exclamation-octagon", html: `<b>${esc(fpFichaPlural(vencidos.length, "prazo vencido", "prazos vencidos"))}</b> · ${det}${fpFichaAlertaLink("agenda", "Ver prazos")}` });
    }
    if (hojeL.length) {
      const det = hojeL.length === 1 ? esc(fpFichaResumir(hojeL[0].description, 90)) : esc(fpFichaPlural(hojeL.length, "prazo", "prazos"));
      out.push({ tom: "warning", icone: "bi-exclamation-triangle", html: `<b>Vence hoje:</b> ${det}${fpFichaAlertaLink("agenda", "Ver prazos")}` });
    }
  }
  if (Array.isArray(d.audiencias)) {
    const agora = fpFichaAgoraChave();
    const hojeA = d.audiencias.filter((a) => fichaSoData(a.date_time) === hoje && fichaChaveData(a.date_time) >= agora)
      .sort((a, b) => fichaChaveData(a.date_time).localeCompare(fichaChaveData(b.date_time)));
    if (hojeA.length) {
      const hora = fmtDataHora(hojeA[0].date_time).slice(11);
      out.push({ tom: "warning", icone: "bi-calendar-event", html: `<b>Audiência hoje${hora ? " às " + esc(hora) : ""}</b>${fpFichaTem(hojeA[0].location) ? " · " + esc(hojeA[0].location) : ""}.${fpFichaAlertaLink("agenda", "Ver agenda")}` });
    }
  }
  if (Array.isArray(d.publicacoes)) {
    const naoLidas = d.publicacoes.filter((x) => Number(x.lida) === 0 && Number(x.arquivada) === 0);
    if (naoLidas.length) {
      const txt = naoLidas.length === 1 ? "1 publicação do DJEN não lida" : `${naoLidas.length} publicações do DJEN não lidas`;
      out.push({ tom: "info", icone: "bi-megaphone", html: `<b>${esc(txt)}</b> neste processo.${fpFichaAlertaLink("andamentos", "Ler nos andamentos")}` });
    }
  }
  return out;
}

/** Último evento processual: andamento manual ou publicação do DJEN. */
function fpFichaUltimoAndamento(ctx) {
  const evs = fpFichaEventosProcessuais(ctx);
  return evs.length ? evs[0] : null;
}

/** KPIs (máximo 4). Os formatos — vazio = "—" + dica curta; data grande com o
 *  selo embaixo — são os MESMOS da ficha do cliente: vêm dos fmKpi* do
 *  ficha-modulos.js. Cada um some sem o módulo dele (fonte null por
 *  permissão nem entra); fonte que falhou mostra "Não foi possível carregar". */
function fpFichaKpis(ctx) {
  const d = ctx.dados || {};
  const ks = [];
  if (permCanView("deadlines")) ks.push(fmKpiPrazo(d.prazos, (x) => fpFichaResumir(x.description, 60)));
  if (permCanView("appointments")) ks.push(fmKpiAudiencia(d.audiencias, (a) => (fpFichaTem(a.location) ? fpFichaResumir(a.location, 60) : "Local não informado")));
  if (permCanView("financeiro")) ks.push(fmKpiReceber(d.honorarios));
  const u = fpFichaUltimoAndamento(ctx);
  const carregou = Array.isArray(d.andamentos) || Array.isArray(d.publicacoes);
  ks.push(fmKpiUltimo({ icone: "bi-list-check", rotulo: "Último andamento", aba: "andamentos" }, u, carregou,
    u ? `${fmtDate(fichaSoData(u.data))} · ${fpFichaResumir(u.titulo, 50)}` : ""));
  return ks;
}

/** Contadores das abas (mesma régua do contrato dos módulos). */
function fpFichaContagens(ctx) {
  const d = (ctx && ctx.dados) || {};
  const tam = (x) => (Array.isArray(x) ? x.length : null);
  let agenda = null;
  if (Array.isArray(d.prazos) || Array.isArray(d.audiencias)) {
    const agora = fpFichaAgoraChave();
    agenda = (Array.isArray(d.prazos) ? d.prazos.filter((x) => !x.done).length : 0) +
      (Array.isArray(d.audiencias) ? d.audiencias.filter((a) => fichaChaveData(a.date_time) >= agora).length : 0);
  }
  let andamentos = null;
  if (Array.isArray(d.andamentos) || Array.isArray(d.publicacoes)) andamentos = (tam(d.andamentos) || 0) + (tam(d.publicacoes) || 0);
  // Financeiro: a régua do próprio módulo (fmContarHonorarios).
  return { partes: tam(d.partes), andamentos, agenda, documentos: tam(d.documentos), financeiro: fmContarHonorarios(ctx) };
}

/** ctx.aoMudar: algum módulo (ou esta ficha) gravou. Recalcula tudo a partir
 *  de ctx.dados — sem ir à API e sem tocar na aba que está sendo editada. */
function fpFichaAoMudar(motivo) {
  const ctx = FICHA.ctx;
  if (!ctx || ctx.tipo !== "processo" || !ctx.processId) return;
  fpFichaAtualizarTopo(ctx);
  const n = fpFichaContagens(ctx);
  FP_FICHA_CONTADORES.forEach((a) => { if (fichaAbaCfg(a)) fmContador(a, n[a]); });
  (FP_FICHA_DEPENDE[motivo] || []).forEach((a) => { if (a !== FICHA.aba && fichaAbaCfg(a)) fichaAtualizarAba(a); });
  // Visão geral (KPIs, "Complete a ficha"): na tela, redesenha; fora, marca.
  // (A linha do tempo da aba Andamentos se atualiza sozinha — o módulo
  // redesenha os próprios blocos ao gravar, inclusive um atendimento do
  // "Novo ▾" com a aba aberta.)
  fichaAtualizarAba("geral");
  if (motivo === "honorarios") fpFichaHonorarioNovo(ctx);
}

/** Honorário NOVO (a lista cresceu) para um cliente Lead/Em negociação:
 *  pergunta se ele já é cliente ativo — mesma pergunta da ficha do cliente. */
async function fpFichaHonorarioNovo(ctx) {
  const hs = ctx.dados && ctx.dados.honorarios;
  if (!Array.isArray(hs)) return;
  const antes = FP_FICHA.nHon;
  FP_FICHA.nHon = hs.length;
  if (antes === null || hs.length <= antes) return;
  const salvo = await fmPerguntarClienteAtivo(ctx.cliente);
  if (salvo && FICHA.ctx === ctx && ctx.cliente) Object.assign(ctx.cliente, salvo);
}

/* ---------------------------------------------------------
   2.3 Abas
   --------------------------------------------------------- */

/** Aviso para aba de módulo enquanto o ficha-modulos.js não a entrega. */
function fpFichaModuloPendente(el) {
  el.innerHTML = uiVazio({
    icone: "bi-hourglass-split",
    titulo: "Módulo em preparação",
    texto: "Esta parte da ficha ainda não foi carregada nesta versão. Recarregue a página em instantes.",
  });
}

/** Abas SEM ícone e com "Cadastro" — o mesmo critério da ficha do cliente.
 *  Pílula só com número maior que zero. */
function fpFichaAbas(ctx) {
  const c = fpFichaContagens(ctx);
  const n = {};
  Object.keys(c).forEach((k) => { n[k] = c[k] > 0 ? c[k] : null; });
  return [
    { id: "geral", rotulo: "Visão geral", sempreAtualizar: true, render: fpFichaGeral },
    { id: "cadastro", rotulo: "Cadastro", render: fpFichaDados },
    { id: "partes", rotulo: "Partes", contador: n.partes, render: fpFichaPartes },
    {
      id: "andamentos", rotulo: "Andamentos", contador: n.andamentos, sempreAtualizar: true,
      render: (el, c) => (typeof fmLinhaDoTempo === "function"
        ? fmLinhaDoTempo(el, c, { abaId: "andamentos", filtroPadrao: "processuais", formAndamento: true })
        : fpFichaModuloPendente(el)),
    },
    {
      id: "agenda", rotulo: "Prazos e audiências", contador: n.agenda, oculto: !fpFichaAbaVisivel("agenda"),
      render: (el, c) => (typeof fmAgenda === "function" ? fmAgenda(el, c, { abaId: "agenda" }) : fpFichaModuloPendente(el)),
    },
    {
      id: "documentos", rotulo: "Documentos", contador: n.documentos, oculto: !fpFichaAbaVisivel("documentos"),
      render: (el, c) => (typeof fmDocumentos === "function" ? fmDocumentos(el, c, { abaId: "documentos" }) : fpFichaModuloPendente(el)),
    },
    {
      id: "financeiro", rotulo: "Financeiro", contador: n.financeiro, oculto: !fpFichaAbaVisivel("financeiro"),
      render: (el, c) => (typeof fmFinanceiro === "function" ? fmFinanceiro(el, c, { abaId: "financeiro" }) : fpFichaModuloPendente(el)),
    },
  ];
}

/* ---------------------------------------------------------
   2.4 Visão geral (só desenha a partir do ctx — nada de API)
   --------------------------------------------------------- */

function fpFichaGeral(el, ctx) {
  const itens = fpFichaPendencias(ctx);
  const pend = new Set(itens.filter((i) => !i.ok).map((i) => i.chave));
  const incompleta = pend.size > 0;
  // Completa: só o selo pequeno; incompleta: o guia — o MESMO componente da
  // ficha do cliente (fmCompletarHtml). Enquanto o guia está na tela, os
  // vazios dos cartões não repetem o botão da mesma pendência.
  el.innerHTML = `<div class="ficha-grade fp-ficha-geral${incompleta ? " is-incompleta" : ""}">
    <div class="ficha-coluna">
      ${fpFichaDadosCardHtml(ctx)}
      ${fpFichaUltimosHtml(ctx)}
    </div>
    <div class="ficha-coluna fp-ficha-lado">
      ${fmCompletarHtml(itens, "fpFichaCompletar")}
      ${fpFichaClienteCardHtml(ctx)}
      ${fpFichaPartesResumoHtml(ctx, pend)}
    </div>
  </div>`;
}

/** "Dados do processo" mostra só o que NÃO está no cabeçalho — número, área,
 *  status, fase, instância, sistema, cliente, polo, responsável, distribuição
 *  e valor já estão lá em cima (o cliente e o polo apareciam três vezes) — e
 *  esconde o que está vazio: processo recém-criado não vira fileira de "—". */
function fpFichaDadosResumo(ctx) {
  const p = ctx.processo;
  return [
    { rotulo: "Tribunal", valor: p.tribunal },
    { rotulo: "Órgão julgador", valor: p.orgao_julgador },
    { rotulo: "Foro / comarca", valor: p.foro },
    { rotulo: "Vara", valor: p.vara },
    { rotulo: "Classe processual", valor: p.classe },
    { rotulo: "Assunto", valor: p.assunto },
    { rotulo: "Subcategoria", valor: p.subcategoria },
    { rotulo: "Observações", valor: p.description, largo: true },
  ].filter((i) => fpFichaTem(i.valor));
}

function fpFichaDadosCardHtml(ctx) {
  const pode = permCanEdit("processes");
  const itens = fpFichaDadosResumo(ctx);
  const cad = fpFichaDataCadastro(ctx.processo.created_at);
  const corpo = (itens.length
    ? uiDl(itens)
    : uiVazio({
      icone: "bi-bank", compacto: true, titulo: "Juízo e detalhes ainda não informados",
      texto: "Tribunal, vara, classe, assunto e observações ficam no Cadastro do processo.",
    })) + (cad ? `<p class="fp-ficha-nota">Cadastrado em <span class="ficha-num">${esc(cad)}</span>.</p>` : "");
  return uiCard({
    titulo: "Dados do processo",
    acoesHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fichaKpiClique" data-args="${escArgs("cadastro")}"><i class="bi ${pode ? "bi-pencil-square" : "bi-card-list"}" aria-hidden="true"></i> ${pode ? "Editar cadastro" : "Ver cadastro"}</button>`,
    corpoHtml: corpo,
  });
}

/** Andamentos manuais + publicações do DJEN, do mais recente ao mais antigo
 *  (no mesmo dia, o andamento cadastrado por último vem primeiro). */
function fpFichaEventosProcessuais(ctx) {
  const d = ctx.dados || {};
  const evs = [];
  (Array.isArray(d.andamentos) ? d.andamentos : []).forEach((a) => {
    evs.push({
      tipo: "andamento", data: a.data, titulo: a.titulo || "Andamento",
      detalhe: fpFichaResumir(a.descricao, 220), autor: a.autor_nome || "",
      acao: "fichaKpiClique", args: ["andamentos"], _ord: Number(a.id) || 0,
    });
  });
  (Array.isArray(d.publicacoes) ? d.publicacoes : []).forEach((pb) => {
    const naoLida = Number(pb.lida) === 0 && Number(pb.arquivada) === 0;
    const titulo = [pb.tipo_comunicacao || "Publicação", pb.tribunal].filter(fpFichaTem).join(" · ");
    evs.push({
      tipo: "publicacao", data: pb.data_disponibilizacao, titulo,
      detalheHtml: (naoLida ? uiChip("info", "Não lida", "bi-envelope") + " " : "") + esc(fpFichaResumir(pb.texto, 220)),
      acao: "fichaKpiClique", args: ["andamentos"], _ord: 0,
    });
  });
  return evs.sort((a, b) => fichaChaveData(b.data).localeCompare(fichaChaveData(a.data)) || (b._ord - a._ord));
}

function fpFichaUltimosHtml(ctx) {
  const evs = fpFichaEventosProcessuais(ctx).slice(0, 3);
  const pode = permCanEdit("processes");
  const corpo = evs.length
    ? uiTimeline(evs, { ordenar: false })
    : uiVazio({
      icone: "bi-list-check", compacto: true,
      titulo: "Nenhum andamento registrado",
      texto: "Registre as movimentações do processo. As publicações do DJEN ligadas a ele aparecem aqui também.",
      acaoHtml: pode ? `<button type="button" class="btn btn-sm btn-primary" data-on-click="fichaIrAbaNovo" data-args="${escArgs("andamentos")}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Registrar andamento</button>` : "",
    });
  return uiCard({
    titulo: "Últimos andamentos",
    acoesHtml: evs.length ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fichaKpiClique" data-args="${escArgs("andamentos")}">Ver todos</button>` : "",
    corpoHtml: corpo,
  });
}

/** Itens do "Complete a ficha". Bloco sem acesso (sem o módulo) nem entra
 *  na conta — "4 de 6" não pode cobrar o que a pessoa não consegue fazer. */
function fpFichaPendencias(ctx) {
  const p = ctx.processo;
  const d = ctx.dados || {};
  const itens = [
    { chave: "numero", rotulo: "Número do processo", ok: fpFichaTem(p.case_number) },
    { chave: "juizo", rotulo: "Tribunal ou vara", ok: fpFichaTem(p.tribunal) || fpFichaTem(p.vara) || fpFichaTem(p.orgao_julgador) },
    { chave: "contraria", rotulo: "Parte contrária", ok: Array.isArray(d.partes) && d.partes.some((x) => x.tipo === "contraria") },
  ];
  if (Array.isArray(d.prazos) || Array.isArray(d.audiencias)) {
    itens.push({ chave: "agenda", rotulo: "Prazo ou audiência", ok: (d.prazos || []).length > 0 || (d.audiencias || []).length > 0 });
  }
  if (Array.isArray(d.documentos)) itens.push({ chave: "documento", rotulo: "Documento anexado", ok: d.documentos.length > 0 });
  if (Array.isArray(d.honorarios)) itens.push({ chave: "honorarios", rotulo: "Honorários", ok: d.honorarios.length > 0 });
  return itens;
}

function fpFichaClienteCardHtml(ctx) {
  const p = ctx.processo;
  const c = ctx.cliente;
  const nome = (c && c.name) || p.client_name || (p.client_id ? "Cliente #" + p.client_id : "Sem cliente");
  const link = fpFichaClienteNoCache(p.client_id);
  const h = "#/clientes/" + Number(p.client_id);
  const chips = [
    fpFichaTem(p.polo_cliente) ? uiChip("neutral", fichaRotulo("partePolo", p.polo_cliente), "bi-signpost") : "",
    c && fpFichaTem(c.tipo_pessoa) ? uiChip("neutral", fichaRotulo("tipoPessoaCurto", c.tipo_pessoa)) : "",
  ].join("");
  let corpo = `<div class="fp-ficha-cli">${uiAvatar(nome)}<div class="fp-ficha-cli-txt">${fpFichaClienteHtml(Object.assign({}, p, { client_name: nome }), "fp-ficha-cli-nome")}
    ${chips ? `<div class="ficha-chips">${chips}</div>` : ""}</div></div>`;
  if (c) {
    const tel = c.celular || c.whatsapp || c.phone;
    corpo += uiDl([
      { rotulo: c.tipo_pessoa === "PJ" ? "CNPJ" : (c.tipo_pessoa === "PF" ? "CPF" : "CPF/CNPJ"), html: fpFichaTem(c.cpf_cnpj) ? `<span class="ficha-num">${esc(fmtDoc(c.cpf_cnpj))}</span>` : "" },
      { rotulo: "Telefone", html: fpFichaTem(tel) ? `<span class="ficha-num">${esc(fmtTel(tel))}</span>` : "" },
      { rotulo: "E-mail", valor: c.email, largo: true },
    ]);
    const atalhos = uiContatoRapido({ whatsapp: c.whatsapp, celular: c.celular || c.phone, email: c.email });
    if (atalhos) corpo += `<div class="fp-ficha-cli-contato">${atalhos}</div>`;
  } else {
    corpo += `<p class="fp-ficha-nota">${permCanView("clients")
      ? "Cliente de outro responsável: aqui aparece só o nome."
      : "Você não tem acesso ao módulo Clientes."}</p>`;
  }
  return uiCard({
    titulo: "Cliente",
    acoesHtml: link ? `<a class="btn btn-sm btn-ficha" href="${h}" data-on-click="fichaIr" data-args="${escArgs(h)}">Abrir ficha</a>` : "",
    corpoHtml: corpo,
  });
}

function fpFichaPartesResumoHtml(ctx, pend) {
  const partes = (ctx.dados || {}).partes;
  if (!Array.isArray(partes)) return "";
  const contr = partes.filter((x) => x.tipo === "contraria");
  const outras = partes.length - contr.length;
  const pode = permCanEdit("processes");
  let corpo;
  if (contr.length) {
    corpo = `<ul class="fp-ficha-mini">${contr.map((x) => `<li>
        <span class="fp-ficha-mini-nome">${esc(x.nome)}</span>
        ${fpFichaTem(x.cpf_cnpj) || fpFichaTem(x.advogado) ? `<span class="fp-ficha-mini-sub">${[
          fpFichaTem(x.cpf_cnpj) ? `<span class="ficha-num">${esc(fmtDoc(x.cpf_cnpj))}</span>` : "",
          fpFichaTem(x.advogado) ? `Adv. ${esc(x.advogado)}` : "",
        ].filter(Boolean).join(" · ")}</span>` : ""}
      </li>`).join("")}</ul>${outras ? `<p class="fp-ficha-nota">+ ${esc(fpFichaPlural(outras, "outra parte", "outras partes"))} (litisconsorte, terceiro…)</p>` : ""}`;
  } else {
    corpo = uiVazio({
      icone: "bi-person-x", compacto: true,
      titulo: "Nenhuma parte contrária",
      texto: outras ? `${fpFichaPlural(outras, "parte cadastrada", "partes cadastradas")}, nenhuma como contrária.` : "",
      // O guia já tem "Parte contrária": o vazio não repete o botão.
      acaoHtml: pode && !(pend && pend.has("contraria")) ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fichaIrAbaNovo" data-args="${escArgs("partes")}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Incluir parte contrária</button>` : "",
    });
  }
  return uiCard({
    titulo: "Partes contrárias",
    acoesHtml: partes.length ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fichaKpiClique" data-args="${escArgs("partes")}">Ver partes</button>` : "",
    corpoHtml: corpo,
  });
}

/** AÇÃO — item pendente do "Complete a ficha": leva ao campo/formulário certo. */
async function fpFichaCompletar(item) {
  switch (item) {
    case "numero": return fpFichaFocarDado("fp-case");
    case "juizo": return fpFichaFocarDado("fp-tribunal");
    case "contraria": return fichaIrAba("partes", { novo: true, rolar: true });
    case "agenda": return fichaIrAba("agenda", { novo: true, rolar: true });
    case "documento": return fichaIrAba("documentos", { novo: true, rolar: true });
    case "honorarios": return fichaIrAba("financeiro", { novo: true, rolar: true });
    default: return undefined;
  }
}

async function fpFichaFocarDado(campo) {
  if (!(await fichaIrAba("cadastro"))) return;
  const el = document.getElementById(campo);
  if (!el || el.disabled) return;
  el.scrollIntoView({ block: "center" });
  try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
}

/* ---------------------------------------------------------
   2.5 Cadastro (formulário fp- do app.js) e modo novo
   ---------------------------------------------------------
   Só o formulário. Os botões são os da barra fixa do rodapé (a casca): no
   modo novo ela fica sempre à vista, com "Cancelar | Cadastrar processo";
   no processo existente, aparece com a primeira alteração ("Descartar |
   Salvar"). Um par de botões só, igual à ficha do cliente. */

async function fpFichaDados(el, ctx) {
  const novo = !ctx.processId;
  const p = novo ? (FP_FICHA.rascunho || {}) : ctx.processo;
  // O cadastro (#/processos/novo) já exige editar Processos no roteador.
  const pode = novo || permCanEdit("processes");
  const tk = fichaRotaToken();
  if (permCanView("clients")) await cacheGarantirCliente(null);
  const ownerField = pode ? await _ownerFieldHtml(p.owner_id, "col-md-6", "fp-") : "";
  if (!fichaRotaValida(tk) || !el.isConnected) return;     // a pessoa já saiu daqui
  const fv = _procFormValores(p);
  // Cliente fora de CACHE.clients (processo próprio, cliente de outro
  // responsável) vira a opção-âncora "Nome (atual)" — sem ela o select abriria
  // vazio e o Salvar desvincularia o cliente.
  const form = _processFormHtml(p, fv.areaKey, fv.sisSel, fv.sisOutro, ownerField, { pfx: "fp-", clientes: CACHE.clients });
  el.innerHTML = `
    ${novo ? `<div class="ficha-alerta ficha-alerta-accent"><i class="bi bi-lightbulb" aria-hidden="true"></i><div>Comece pelo cliente e pelo número do processo. Partes, andamentos, prazos, documentos e honorários você inclui na própria ficha, logo depois de cadastrar.</div></div>` : ""}
    ${pode ? "" : `<div class="ficha-alerta ficha-alerta-neutral"><i class="bi bi-lock" aria-hidden="true"></i><div>Você pode consultar o cadastro deste processo, mas não editá-lo.</div></div>`}
    <div id="fp-ficha-form" class="fp-ficha-form">${pode ? form : `<fieldset class="fp-ficha-leitura" disabled>${form}</fieldset>`}</div>`;
  if (!pode) return;
  fichaVigiarAlteracoes(document.getElementById("fp-ficha-form"), novo
    ? {
      aoSalvar: fpFichaSalvarDadosExec, aoDescartar: fpFichaCancelarNovo,
      sempreVisivel: true, rotuloSalvar: "Cadastrar processo", rotuloDescartar: "Cancelar",
    }
    : { aoSalvar: fpFichaSalvarDadosExec });
  if (novo) {
    const alvo = document.getElementById(p.client_id ? "fp-case" : "fp-client");
    if (alvo) { try { alvo.focus({ preventScroll: true }); } catch (e) { alvo.focus(); } }
  }
}

async function fpFichaSalvarDadosExec() {
  const ctx = FICHA.ctx;
  if (!ctx || FP_FICHA.salvando) return;
  const payload = _processFormPayload({ pfx: "fp-" });
  if (!payload) return;                 // o formulário já avisou o que falta
  FP_FICHA.salvando = true;
  try {
    if (!ctx.processId) await fpFichaCriar(payload);
    else await fpFichaAtualizar(ctx, payload);
  } finally { FP_FICHA.salvando = false; }
}

/** POST do cadastro. O token da rota é guardado ANTES: se a pessoa saiu da
 *  tela enquanto ele voava, o processo fica cadastrado (aviso) e ninguém é
 *  arrastado de volta para a ficha dele. */
async function fpFichaCriar(payload) {
  const tk = fichaRotaToken();
  const novo = await api("/api/processes", { method: "POST", body: JSON.stringify(payload) });
  await cacheGarantirProcesso(novo);
  if (!fichaRotaValida(tk)) { toast("Processo cadastrado. Ele já aparece na lista de Processos."); return; }
  fichaMarcarSujo(false);
  // replace: o Voltar não reabre o formulário de cadastro.
  await irPara("#/processos/" + Number(novo.id), { replace: true });
  toast("Processo cadastrado. Agora inclua partes, prazos e documentos.");
  // 1º processo de um cliente Lead/Em negociação: ele já é cliente ativo?
  const ctx = FICHA.ctx;
  if (ctx && Number(ctx.processId) === Number(novo.id) && ctx.cliente) {
    const salvo = await fmPerguntarClienteAtivo(ctx.cliente);
    if (salvo && FICHA.ctx === ctx) Object.assign(ctx.cliente, salvo);
  }
}

async function fpFichaAtualizar(ctx, payload) {
  const antes = ctx.processo;
  const salvo = await api("/api/processes/" + Number(ctx.processId), { method: "PUT", body: JSON.stringify(payload) });
  if (FICHA.ctx !== ctx) return;
  fichaMarcarSujo(false);
  await cacheGarantirProcesso(salvo);
  if (Number(salvo.client_id) !== Number(antes.client_id)) {
    // Outro cliente = outro contexto inteiro (atendimentos, contato, link,
    // documentos e publicações acompanham o cliente novo): relê a ficha.
    toast("Cadastro salvo. O processo passou para outro cliente — a ficha foi atualizada.");
    await fichaProcessoAbrir(ctx.processId, { aba: "cadastro" });
    return;
  }
  ctx.processo = Object.assign({}, antes, salvo);
  ctx.processos = [ctx.processo];
  // O select de responsável só manda owner_id quando muda em relação ao
  // data-orig: depois de salvar, o "original" passa a ser o gravado.
  const dono = document.getElementById("fp-owner");
  if (dono) dono.dataset.orig = salvo.owner_id === null || salvo.owner_id === undefined ? "" : String(salvo.owner_id);
  fpFichaAtualizarTopo(ctx);
  fichaAtualizarAba("geral");
  FP_FICHA_DEPENDE.processo.forEach((a) => { if (fichaAbaCfg(a)) fichaAtualizarAba(a); });
  toast("Cadastro salvo.");
}

/** #/processos/novo[?cliente=ID] — só a aba Cadastro, até o processo existir. */
async function fpFichaAbrirNovo(q) {
  const tk = fichaRotaToken();
  const cid = fichaIdValido(q.cliente) ? Number(q.cliente) : null;
  FP_FICHA.origemCliente = cid;
  if (permCanView("clients")) await cacheGarantirCliente(null);
  let cli = null;
  if (cid) {
    cli = CACHE.clients.find((c) => Number(c.id) === cid) || null;
    if (!cli) {
      try { cli = await api("/api/clients/" + cid); await cacheGarantirCliente(cli); }
      catch (e) { toast("Esse cliente não foi encontrado ou é de outro responsável. Escolha o cliente na lista.", true); }
    }
  }
  if (!fichaRotaValida(tk)) return;
  FP_FICHA.rascunho = {
    client_id: cli ? cli.id : "", client_name: cli ? cli.name : "",
    type: "civel", status: "ativo", owner_id: null, valor_causa: null,
  };
  const ctx = {
    tipo: "processo", clientId: cli ? cli.id : null, processId: null,
    cliente: cli, processo: null, processos: [], dados: {}, aoMudar: () => {},
  };
  // As outras abas ficam ESCONDIDAS até o primeiro salvamento (apagadas,
  // eram seis abas mortas chamando o clique) — igual à ficha do cliente.
  await fichaRender({
    tipo: "processo", id: null, ctx,
    trilha: [{ rotulo: "Processos", hash: "#/processos" }],
    titulo: "Novo processo",
    tituloDocumento: "Novo processo",
    subtitulo: cli ? `Cliente: ${cli.name}. Ao cadastrar, a ficha libera partes, andamentos, prazos, documentos e financeiro.` : "Cadastre o processo; depois inclua partes, andamentos, prazos e documentos na própria ficha.",
    abas: [{ id: "cadastro", rotulo: "Cadastro", render: fpFichaDados }],
    abaAtiva: "cadastro",
  });
}

/** AÇÃO — Cancelar do cadastro: volta à ficha do cliente de onde veio, ou à
 *  lista. A guarda pergunta antes se algo já foi digitado. */
function fpFichaCancelarNovo() {
  const cid = FP_FICHA.origemCliente;
  fichaVoltar(cid ? "#/clientes/" + Number(cid) : "#/processos");
}

/* ---------------------------------------------------------
   2.6 Partes (formulário fmp-; lista redesenhada sozinha)
   --------------------------------------------------------- */

/** Polo sugerido para a parte contrária: o oposto do polo do cliente. */
function fpFichaPoloOposto(ctx) {
  const polo = ctx && ctx.processo ? ctx.processo.polo_cliente : "";
  return polo === "ativo" ? "passivo" : (polo === "passivo" ? "ativo" : "");
}

function fpFichaPartes(el, ctx) {
  const pode = permCanEdit("processes");
  // Formulário mais largo (coluna própria de ~420px, e não o 1/3 da grade
  // padrão): em 1440px os rótulos cortavam.
  el.innerHTML = `<div class="fp-ficha-partes-grade">
    <div class="ficha-coluna">
      ${fpFichaPartesClienteHtml(ctx)}
      <div id="fp-ficha-partes-lista">${fpFichaPartesListaHtml(ctx)}</div>
    </div>
    <div class="ficha-coluna">
      ${pode ? fpFichaParteFormHtml(ctx) : uiCard({ titulo: "Incluir parte", corpoHtml: '<p class="fp-ficha-nota">Você pode consultar as partes, mas não incluir nem editar.</p>' })}
    </div>
  </div>`;
  FICHA.novo.partes = () => fpFichaParteNova({ focar: true });
  if (!pode) return;
  // O que estava digitado volta (a aba é redesenhada quando fica
  // desatualizada) — inclusive o modo "editando", se a parte ainda existe.
  const r = FP_FICHA.parteRascunho;
  const partes = Array.isArray(ctx.dados && ctx.dados.partes) ? ctx.dados.partes : [];
  const editada = r && r.editando ? partes.find((x) => Number(x.id) === Number(r.editando)) : null;
  FP_FICHA.parteEditando = editada ? editada.id : null;
  fpFichaParteFormPreencher(editada);
  if (r && r.valores) fpFichaParteRestaurar(r.valores);
  if (editada) fpFichaPartesRedesenhar();
  fpFichaParteLigar();
}

function fpFichaPartesClienteHtml(ctx) {
  const p = ctx.processo;
  const nome = (ctx.cliente && ctx.cliente.name) || p.client_name || "Cliente #" + p.client_id;
  const doc = ctx.cliente && fpFichaTem(ctx.cliente.cpf_cnpj) ? `<span class="ficha-num">${esc(fmtDoc(ctx.cliente.cpf_cnpj))}</span>` : "";
  const chips = [
    uiChip("success", "Cliente", "bi-person-check"),
    uiChip("neutral", fpFichaTem(p.polo_cliente) ? fichaRotulo("partePolo", p.polo_cliente) : "Polo não informado", "bi-signpost"),
  ].join("");
  return uiCard({
    titulo: "Cliente neste processo",
    acoesHtml: permCanEdit("processes") && !fpFichaTem(p.polo_cliente)
      ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fpFichaFocarPolo">Informar o polo</button>` : "",
    corpoHtml: `<div class="fp-ficha-cli">${uiAvatar(nome)}<div class="fp-ficha-cli-txt">
        ${fpFichaClienteHtml(Object.assign({}, p, { client_name: nome }), "fp-ficha-cli-nome")}
        ${doc ? `<div class="fp-ficha-cli-sub">${doc}</div>` : ""}
        <div class="ficha-chips">${chips}</div></div></div>`,
  });
}

/** AÇÃO — "Informar o polo": o polo do cliente mora no formulário Dados. */
function fpFichaFocarPolo() { return fpFichaFocarDado("fp-polo"); }

function fpFichaPartesListaHtml(ctx) {
  const partes = (ctx.dados || {}).partes;
  if (!Array.isArray(partes)) {
    return uiCard({
      titulo: "Partes do processo",
      corpoHtml: uiVazio({
        icone: "bi-exclamation-triangle", compacto: true,
        titulo: "Não foi possível carregar as partes", texto: "Tente novamente em instantes.",
        acaoHtml: `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fpFichaPartesRecarregar"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Tentar novamente</button>`,
      }),
    });
  }
  const pode = permCanEdit("processes");
  const exclui = pode && permPodeExcluir();
  if (!partes.length) {
    // Com o formulário de inclusão aberto ao lado, o vazio só orienta — um
    // botão aqui repetiria o "Incluir parte" que já está na tela.
    return uiCard({
      titulo: "Partes do processo",
      corpoHtml: uiVazio({
        icone: "bi-people",
        titulo: "Nenhuma parte cadastrada",
        texto: pode
          ? "Inclua a parte contrária no formulário “Incluir parte” e, se houver, litisconsortes e terceiros interessados."
          : "Quando a parte contrária for cadastrada, ela aparece aqui.",
      }),
    });
  }
  const itens = partes.map((x) => {
    const contraria = x.tipo === "contraria";
    const chips = [
      uiChip(contraria ? "danger" : "neutral", fichaRotulo("parteTipo", x.tipo) || "Parte", contraria ? "bi-person-x" : "bi-person"),
      fpFichaTem(x.polo) ? uiChip("neutral", fichaRotulo("partePolo", x.polo), "bi-signpost") : "",
    ].join("");
    const adv = [x.advogado, fpFichaTem(x.oab) ? "OAB " + x.oab : ""].filter(fpFichaTem).join(" · ");
    const meta = [
      fpFichaTem(x.cpf_cnpj) ? `<span class="ficha-num">${esc(fmtDoc(x.cpf_cnpj))}</span>` : "",
      adv ? `<span><i class="bi bi-briefcase" aria-hidden="true"></i> ${esc(adv)}</span>` : "",
    ].filter(Boolean).join('<span class="ficha-meta-sep" aria-hidden="true">·</span>');
    const botoes = [
      pode ? `<button type="button" class="btn btn-sm btn-ficha" data-on-click="fpFichaParteEditar" data-args="${escArgs(x.id)}" title="Editar parte" aria-label="Editar ${esc(x.nome)}"><i class="bi bi-pencil" aria-hidden="true"></i></button>` : "",
      exclui ? `<button type="button" class="btn btn-sm btn-ficha-perigo" data-on-click="fpFichaParteRemover" data-args="${escArgs(x.id)}" title="Remover parte" aria-label="Remover ${esc(x.nome)}"><i class="bi bi-trash" aria-hidden="true"></i></button>` : "",
    ].join("");
    return `<li class="fp-ficha-parte${FP_FICHA.parteEditando === x.id ? " is-editando" : ""}">
      <div class="fp-ficha-parte-cab">
        <div class="fp-ficha-parte-nome">${esc(x.nome)}</div>
        ${botoes ? `<div class="fp-ficha-parte-acoes">${botoes}</div>` : ""}
      </div>
      <div class="ficha-chips">${chips}</div>
      ${meta ? `<div class="fp-ficha-parte-meta">${meta}</div>` : ""}
      ${fpFichaTem(x.observacoes) ? `<div class="fp-ficha-parte-obs">${esc(x.observacoes)}</div>` : ""}
    </li>`;
  }).join("");
  const nContr = partes.filter((x) => x.tipo === "contraria").length;
  return uiCard({
    titulo: "Partes do processo",
    descricao: `${fpFichaPlural(partes.length, "parte", "partes")}${nContr ? " · " + fpFichaPlural(nContr, "contrária", "contrárias") : ""}`,
    corpoHtml: `<ul class="fp-ficha-partes">${itens}</ul>`,
  });
}

function fpFichaParteFormHtml(ctx) {
  return `<section class="ficha-card fp-ficha-parte-form" id="fmp-card">
    <header class="ficha-card-cab"><div class="ficha-card-cab-txt">
      <h2 class="ficha-card-titulo" id="fmp-titulo">Incluir parte</h2>
      <p class="ficha-card-desc">Parte contrária, litisconsorte ou terceiro interessado.</p>
    </div></header>
    <div class="ficha-card-corpo">
      <div class="row g-3">
        <div class="col-12"><label class="form-label" for="fmp-nome">Nome <span class="text-danger">*</span></label>
          <input id="fmp-nome" class="form-control" maxlength="150" autocomplete="off"></div>
        <div class="col-sm-6"><label class="form-label" for="fmp-tipo">Tipo</label>
          <select id="fmp-tipo" class="form-select">${fichaOpcoes("parteTipo", "contraria")}</select></div>
        <div class="col-sm-6"><label class="form-label" for="fmp-polo">Polo</label>
          <select id="fmp-polo" class="form-select">${fichaOpcoes("partePolo", fpFichaPoloOposto(ctx), { vazio: "— Não informado —" })}</select></div>
        <div class="col-12"><label class="form-label" for="fmp-doc">CPF/CNPJ</label>
          <input id="fmp-doc" class="form-control ficha-num" inputmode="numeric" autocomplete="off" maxlength="20" data-on-input="fichaMascaraDoc" placeholder="000.000.000-00"></div>
        <div class="col-sm-7"><label class="form-label" for="fmp-advogado">Advogado da parte</label>
          <input id="fmp-advogado" class="form-control" maxlength="150" autocomplete="off"></div>
        <div class="col-sm-5"><label class="form-label" for="fmp-oab">OAB</label>
          <input id="fmp-oab" class="form-control" maxlength="30" autocomplete="off" placeholder="ex.: 12345/AL"></div>
        <div class="col-12"><label class="form-label" for="fmp-obs">Observações</label>
          <textarea id="fmp-obs" class="form-control" rows="2"></textarea></div>
      </div>
      <div class="fp-ficha-form-acoes mt-3">
        <button type="button" class="btn btn-ficha" id="fmp-cancelar" data-on-click="fpFichaParteNovaAcao" hidden>Cancelar edição</button>
        <button type="button" class="btn btn-primary" id="fmp-salvar" data-on-click="fpFichaParteSalvar"><i class="bi bi-plus-lg" aria-hidden="true"></i> Incluir parte</button>
      </div>
    </div>
  </section>`;
}

/** Preenche o formulário de parte (inclusão: vazio com os padrões; edição:
 *  os valores da parte). Tudo por `.value` — nada de HTML vindo de dado. */
function fpFichaParteFormPreencher(x) {
  const ctx = FICHA.ctx;
  const editando = !!(x && x.id);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v === null || v === undefined ? "" : String(v); };
  set("fmp-nome", editando ? x.nome : "");
  const tipo = document.getElementById("fmp-tipo");
  if (tipo) {
    const t = editando ? x.tipo : "contraria";
    if (t && ![...tipo.options].some((o) => o.value === t)) tipo.insertAdjacentHTML("beforeend", `<option value="${esc(t)}">${esc(t)} (atual)</option>`);
    tipo.value = t || "contraria";
  }
  const polo = document.getElementById("fmp-polo");
  if (polo) {
    const v = editando ? (x.polo || "") : fpFichaPoloOposto(ctx);
    if (v && ![...polo.options].some((o) => o.value === v)) polo.insertAdjacentHTML("beforeend", `<option value="${esc(v)}">${esc(v)} (atual)</option>`);
    polo.value = v;
  }
  set("fmp-doc", editando ? x.cpf_cnpj : "");
  set("fmp-advogado", editando ? x.advogado : "");
  set("fmp-oab", editando ? x.oab : "");
  set("fmp-obs", editando ? x.observacoes : "");
  // Aviso do CPF/CNPJ: recalcula para o valor novo (ou some, se vazio).
  const doc = document.getElementById("fmp-doc");
  const aviso = document.getElementById("fmp-doc-aviso");
  if (doc) { delete doc.dataset.fichaDig; delete doc.dataset.fichaDocAnunciado; }
  if (aviso) { aviso.hidden = true; aviso.textContent = ""; }
  if (doc && doc.value) fichaMascarasIniciar(document.getElementById("fmp-card"));
  const titulo = document.getElementById("fmp-titulo");
  if (titulo) titulo.textContent = editando ? "Editar parte" : "Incluir parte";
  const cancelar = document.getElementById("fmp-cancelar");
  if (cancelar) cancelar.hidden = !editando;
  const salvar = document.getElementById("fmp-salvar");
  if (salvar && !salvar.disabled) {
    salvar.innerHTML = editando
      ? '<i class="bi bi-check-lg" aria-hidden="true"></i> Salvar parte'
      : '<i class="bi bi-plus-lg" aria-hidden="true"></i> Incluir parte';
  }
  const card = document.getElementById("fmp-card");
  if (card) card.classList.toggle("is-editando", editando);
}

/** Lê o formulário de parte (só os valores — é o rascunho). */
function fpFichaParteLer() {
  const v = {};
  ["fmp-nome", "fmp-tipo", "fmp-polo", "fmp-doc", "fmp-advogado", "fmp-oab", "fmp-obs"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) v[id] = el.value;
  });
  return v;
}

/** Devolve ao formulário o que estava digitado. Tudo por `.value`. */
function fpFichaParteRestaurar(v) {
  Object.keys(v || {}).forEach((id) => {
    const el = document.getElementById(id);
    if (!el || !/^fmp-/.test(id)) return;
    if (el.tagName === "SELECT" && v[id] && ![...el.options].some((o) => o.value === v[id])) return;
    el.value = v[id];
  });
}

/** Liga o formulário ao rascunho: cada tecla guarda o texto em
 *  FP_FICHA.parteRascunho e avisa a guarda de saída (fmMarcarRascunho).
 *  Listener comum: o CPF/CNPJ já tem a máscara no data-on-input dele. */
function fpFichaParteLigar() {
  const card = document.getElementById("fmp-card");
  if (!card || card.dataset.fpLigado) return;
  card.dataset.fpLigado = "1";
  const guardar = (ev) => {
    if (ev && ev.target instanceof Element) ev.target.classList.remove("is-invalid");
    const v = fpFichaParteLer();
    const temTexto = ["fmp-nome", "fmp-doc", "fmp-advogado", "fmp-oab", "fmp-obs"].some((id) => String(v[id] || "").trim());
    FP_FICHA.parteRascunho = { editando: FP_FICHA.parteEditando, valores: v };
    fmMarcarRascunho("parte", temTexto);
  };
  card.addEventListener("input", guardar);
  card.addEventListener("change", guardar);
}

/** Formulário vazio e sem rascunho (depois de incluir, cancelar ou remover). */
function fpFichaParteLimparRascunho() {
  FP_FICHA.parteRascunho = null;
  fmMarcarRascunho("parte", false);
}

function fpFichaParteFocar() {
  const card = document.getElementById("fmp-card");
  const nome = document.getElementById("fmp-nome");
  if (card) card.scrollIntoView({ block: "nearest" });
  if (nome) { try { nome.focus({ preventScroll: true }); } catch (e) { nome.focus(); } }
}

/** Formulário limpo para incluir (FICHA.novo.partes e "Cancelar edição").
 *  Se já está no modo "incluir" com texto, mantém o texto (o "Novo ▾ →
 *  Parte" não pode apagar o que a pessoa começou a digitar). */
function fpFichaParteNova(opts = {}) {
  const tinha = FP_FICHA.parteEditando;
  if (!tinha && FP_FICHA.parteRascunho) { if (opts.focar) fpFichaParteFocar(); return; }
  FP_FICHA.parteEditando = null;
  fpFichaParteFormPreencher(null);
  fpFichaParteLimparRascunho();
  if (tinha) fpFichaPartesRedesenhar();
  if (opts.focar) fpFichaParteFocar();
}
function fpFichaParteNovaAcao() { fpFichaParteNova({ focar: true }); }

/** AÇÃO — lápis da parte: carrega a parte no formulário ao lado. */
function fpFichaParteEditar(id) {
  const ctx = FICHA.ctx;
  const x = ctx && Array.isArray(ctx.dados.partes) ? ctx.dados.partes.find((p) => Number(p.id) === Number(id)) : null;
  if (!x) return;
  FP_FICHA.parteEditando = x.id;
  fpFichaParteFormPreencher(x);
  fpFichaParteLimparRascunho();
  fpFichaPartesRedesenhar();
  fpFichaParteFocar();
}

/** AÇÃO — Incluir/Salvar parte. Erro mantém o que foi digitado. */
async function fpFichaParteSalvar() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.processId) return;
  const btn = document.getElementById("fmp-salvar");
  if (btn && btn.disabled) return;
  const nome = valOpt("fmp-nome");
  if (!nome) {
    toast("Informe o nome da parte.", true);
    const el = document.getElementById("fmp-nome");
    if (el) { el.classList.add("is-invalid"); el.focus(); }
    return;
  }
  const payload = {
    nome,
    tipo: valOpt("fmp-tipo") || "contraria",
    polo: valOpt("fmp-polo") || null,
    cpf_cnpj: valOpt("fmp-doc") || null,
    advogado: valOpt("fmp-advogado") || null,
    oab: valOpt("fmp-oab") || null,
    observacoes: valOpt("fmp-obs") || null,
  };
  const editando = FP_FICHA.parteEditando;
  const rot = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Salvando…'; }
  try {
    const base = `/api/processes/${Number(ctx.processId)}/partes`;
    if (editando) await api(`${base}/${Number(editando)}`, { method: "PUT", body: JSON.stringify(payload) });
    else await api(base, { method: "POST", body: JSON.stringify(payload) });
  } catch (e) {
    toast(e.message, true);
    return;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = rot; }
  }
  if (FICHA.ctx !== ctx) return;
  toast(editando ? "Parte atualizada." : "Parte incluída.");
  FP_FICHA.parteEditando = null;
  fpFichaParteFormPreencher(null);
  fpFichaParteLimparRascunho();
  await fpFichaPartesRecarregar();
  // Pronto para a próxima: o foco volta ao Nome (incluir várias partes em
  // sequência sem caçar o campo).
  const n = document.getElementById("fmp-nome");
  if (n && FICHA.ctx === ctx) { try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); } }
}

/** AÇÃO — lixeira da parte. */
async function fpFichaParteRemover(id) {
  const ctx = FICHA.ctx;
  const x = ctx && Array.isArray(ctx.dados.partes) ? ctx.dados.partes.find((p) => Number(p.id) === Number(id)) : null;
  if (!x) return;
  const r = await confirmar({
    titulo: "Remover esta parte?",
    texto: `${x.nome} sai da lista de partes deste processo. Isso não pode ser desfeito.`,
    botao: "Remover", perigo: true,
  });
  if (r !== "ok" || FICHA.ctx !== ctx) return;
  try {
    await api(`/api/processes/${Number(ctx.processId)}/partes/${Number(x.id)}`, { method: "DELETE" });
  } catch (e) { toast(e.message, true); return; }
  if (Number(FP_FICHA.parteEditando) === Number(x.id)) {
    FP_FICHA.parteEditando = null;
    fpFichaParteFormPreencher(null);
    fpFichaParteLimparRascunho();
  }
  toast("Parte removida.");
  await fpFichaPartesRecarregar();
}

function fpFichaPartesRedesenhar() {
  const ctx = FICHA.ctx;
  const box = document.getElementById("fp-ficha-partes-lista");
  if (box && ctx) box.innerHTML = fpFichaPartesListaHtml(ctx);
}

/** Relê as partes, redesenha SÓ a lista (o formulário ao lado fica como
 *  está) e avisa a ficha (contador, "Complete a ficha", cabeçalho). */
async function fpFichaPartesRecarregar() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.processId) return;
  try {
    const l = await api(fpFichaFonteUrl(ctx, "partes"));
    if (FICHA.ctx !== ctx) return;
    ctx.dados.partes = Array.isArray(l) ? l : [];
  } catch (e) {
    if (FICHA.ctx === ctx) toast(e.message, true);
    return;
  }
  const contr = ctx.dados.partes.filter((x) => x.tipo === "contraria").map((x) => x.nome);
  ctx.processo.partes_contrarias = contr.length ? contr.join(", ") : null;
  fpFichaPartesRedesenhar();
  ctx.aoMudar("partes");
}

/* ---------------------------------------------------------
   2.7 Ações do cabeçalho
   --------------------------------------------------------- */

/** AÇÃO — "Novo ▾ → Prazo / Audiência": abre a aba e o formulário do módulo
 *  Agenda. Sem o módulo, cai no modal do app.js (mesmo contexto). */
async function fpFichaNovoAgenda(tipo) {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.processId) return;
  const t = tipo === "audiencia" ? "audiencia" : "prazo";
  if (fichaAbaCfg("agenda")) await fichaIrAba("agenda", { rolar: true });
  if (FICHA.ctx !== ctx) return;
  if (typeof fmAgendaNovo === "function") return fmAgendaNovo(t);
  const chave = t === "prazo" ? "prazos" : "audiencias";
  const opts = { processId: ctx.processId, processos: ctx.processos, onSaved: () => fpFichaRecarregarFonte(ctx, chave) };
  return t === "prazo" ? deadlineModal(null, opts) : appointmentModal(null, opts);
}

/** AÇÃO — "Novo ▾ → Atendimento": não há aba de atendimentos no processo;
 *  o formulário abre num modal (módulos) com o processo já fixado. */
function fpFichaNovoAtendimento() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.processId) return undefined;
  if (typeof fmAtendimentoModal !== "function") {
    toast("O registro de atendimento ainda não está disponível nesta versão.", true);
    return undefined;
  }
  return fmAtendimentoModal(ctx, { processId: ctx.processId });
}

/** Diálogo de "não pode excluir": a saída é encerrar o processo; "Ver
 *  honorários" leva direto ao que o prende. */
async function fpFichaBloqueio(ctx, texto, comHonorario) {
  const encerrado = ctx.processo && ctx.processo.status === "encerrado";
  const podeEncerrar = !encerrado && permCanEdit("processes");
  const ver = comHonorario && !!fichaAbaCfg("financeiro");
  const r = await confirmar({
    titulo: "Este processo não pode ser excluído",
    texto,
    botao: podeEncerrar ? "Encerrar o processo" : "Entendi",
    alternativa: ver ? "Ver honorários" : null,
    cancelar: "Fechar",
  });
  if (FICHA.ctx !== ctx) return;
  if (r === "ok" && podeEncerrar) await fpFichaEncerrar(ctx);
  else if (r === "alt" && ver) fichaIrAba("financeiro", { rolar: true });
}

/** Encerra o processo (a saída menos destrutiva que excluir). */
async function fpFichaEncerrar(ctx) {
  const salvo = await api("/api/processes/" + Number(ctx.processId), { method: "PUT", body: JSON.stringify({ status: "encerrado" }) });
  await cacheGarantirProcesso(salvo);
  if (FICHA.ctx !== ctx) return;
  ctx.processo = Object.assign({}, ctx.processo, salvo);
  ctx.processos = [ctx.processo];
  // O Cadastro (se aberto) acompanha, sem disparar "change" (não suja a ficha).
  const st = document.getElementById("fp-status");
  if (st) st.value = "encerrado";
  fpFichaAtualizarTopo(ctx);
  fichaAtualizarAba("geral");
  toast("Processo encerrado. Ele continua na lista, no filtro “Encerrados”.");
}

/** AÇÃO — Excluir. Com honorário à vista, abre DIRETO o "não pode excluir"
 *  (antes a pessoa confirmava a exclusão e só então via o bloqueio). Senão,
 *  o confirmar() diz o que vai junto; o 409 do backend (honorário que a
 *  pessoa não vê, prazo de outro responsável) continua tratado. */
async function fpFichaExcluir() {
  const ctx = FICHA.ctx;
  if (!ctx || !ctx.processId) return;
  const d = ctx.dados || {};
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  if (n(d.honorarios)) {
    await fpFichaBloqueio(ctx,
      `Há ${fpFichaPlural(n(d.honorarios), "honorário ligado", "honorários ligados")} a este processo. Honorário é dinheiro: não é apagado junto com o processo.\nExclua ou desvincule os honorários antes — ou encerre o processo, que continua na lista com o histórico.`,
      true);
    return;
  }
  const vai = [
    n(d.prazos) ? fpFichaPlural(n(d.prazos), "prazo", "prazos") : "",
    n(d.audiencias) ? fpFichaPlural(n(d.audiencias), "audiência", "audiências") : "",
    n(d.partes) ? fpFichaPlural(n(d.partes), "parte", "partes") : "",
    n(d.andamentos) ? fpFichaPlural(n(d.andamentos), "andamento", "andamentos") : "",
  ].filter(Boolean);
  const lista = vai.length > 1 ? vai.slice(0, -1).join(", ") + " e " + vai[vai.length - 1] : vai.join("");
  const nome = fpFichaNumero(ctx.processo) || "sem número";
  const r = await confirmar({
    titulo: "Excluir este processo?",
    texto: `Processo ${nome}.\n${lista ? "Vão junto: " + lista + ".\n" : ""}Documentos passam para a ficha do cliente; atendimentos e publicações continuam registrados, sem o vínculo com este processo.\nIsso não pode ser desfeito.`,
    botao: "Excluir processo", perigo: true,
  });
  if (r !== "ok" || FICHA.ctx !== ctx) return;
  try {
    await api("/api/processes/" + Number(ctx.processId), { method: "DELETE" });
  } catch (e) {
    if (e && e.status === 409) { await fpFichaBloqueio(ctx, e.message, true); return; }
    toast(e.message, true);
    return;
  }
  cacheRemoverProcesso(ctx.processId);
  fichaMarcarSujo(false);
  toast("Processo excluído.");
  irPara("#/processos", { replace: true });
}

registrarAcoes({
  fpFichaCompletar, fpFichaCancelarNovo, fpFichaFocarPolo,
  fpFichaParteNovaAcao, fpFichaParteEditar, fpFichaParteSalvar, fpFichaParteRemover, fpFichaPartesRecarregar,
  fpFichaNovoAgenda, fpFichaNovoAtendimento, fpFichaExcluir,
});
