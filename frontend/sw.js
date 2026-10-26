/* Service Worker do LeoJuris (PWA)
   Estratégia: network-first para o app (sempre pega a versão nova quando online),
   com cache de fallback para funcionar offline. NUNCA cacheia /api (dados sempre frescos). */
// ⚠️ BUMPE ESTA VERSÃO sempre que o shell (index.html/app.js/ficha*.js/style.css) mudar.
// O `activate` apaga todo cache cujo nome não seja este — é o que garante que
// o usuário antigo não fique com a casca velha. Na Etapa 2 o index.html ganhou
// os atributos SRI, então o shell mudou.
//
// Nota de diagnóstico (ago/2026) — CORRIGIDA:
// esta nota antes dizia que o problema era "cache velho". Era diagnóstico
// errado. A causa real: o handler `fetch` interceptava TAMBÉM outra origem, e
// o navegador não valida `integrity` (SRI) em resposta vinda do service
// worker — então bloqueava o CSS do Bootstrap e a tela ficava desalinhada.
// Ver o comentário no próprio handler. O engano aconteceu porque, logo após
// desregistrar o SW, a página carrega bem (aquele load não é controlado) e só
// quebra na recarga seguinte.
const CACHE = "leojuris-v55";
const SHELL = [
  "/",
  "/static/style.css",
  "/static/app.js",
  // Ficha única de Cliente e Processo (out/2026). O `addAll` é atômico: se
  // UM destes faltar no servidor, nada entra no cache — por isso os quatro
  // existem desde a fase 1, mesmo vazios.
  "/static/ficha.js",
  "/static/ficha-modulos.js",
  "/static/ficha-cliente.js",
  "/static/ficha-processo.js",
  "/static/assets/VERTICAL%2001.png",
  // Bibliotecas e fontes, que ate' set/2026 vinham de CDN e por isso NUNCA
  // entravam no cache offline: sem rede, o CRM abria sem Bootstrap. Agora sao
  // da mesma origem e entram na casca.
  "/static/vendor/bootstrap/5.3.3/css/bootstrap.min.css",
  "/static/vendor/bootstrap/5.3.3/js/bootstrap.bundle.min.js",
  "/static/vendor/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css",
  "/static/vendor/bootstrap-icons/1.11.3/font/fonts/bootstrap-icons.woff2",
  "/static/vendor/Chart.js/4.4.1/chart.umd.min.js",
  "/static/vendor/qrcodejs/1.0.0/qrcode.min.js",
  "/static/assets/fontes/fontes.css",
  "/static/assets/fontes/xMQ9uFFYT72X5wkB_18qmnndmSdSnh2BAfO5mnuyOo1lfiQwV6-x.woff2",
  "/static/assets/fontes/xMQ9uFFYT72X5wkB_18qmnndmSdSnh2BAfO5mnuyOo1lfiQwWa-xsaQ.woff2",
  "/static/assets/fontes/xn7gYHE41ni1AdIRggOxSuXd.woff2",
  "/static/assets/fontes/xn7gYHE41ni1AdIRggSxSuXd.woff2",
  "/static/assets/fontes/xn7gYHE41ni1AdIRggexSg.woff2",
  "/static/assets/fontes/xn7gYHE41ni1AdIRggixSuXd.woff2",
  "/static/assets/fontes/xn7gYHE41ni1AdIRggmxSuXd.woff2",
  "/static/assets/fontes/xn7gYHE41ni1AdIRggqxSuXd.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // A API deve sempre ir pela rede (nunca servir dados cacheados)
  if (url.pathname.startsWith("/api/")) return;

  const isSameOrigin = url.origin === self.location.origin;

  // ⚠️ set/2026: as bibliotecas e fontes SAIRAM do CDN e viraram mesma origem
  // (/static/vendor, /static/assets/fontes) - entao este handler passou a
  // intercepta-las. As tags do index.html PERDERAM o `integrity` junto, por
  // duas razoes: (1) SRI em mesma origem nao protege de nada - quem consegue
  // trocar o arquivo no servidor troca o hash na mesma pagina; (2) ele
  // transformaria toda atualizacao de biblioteca numa edicao em DOIS lugares
  // que, esquecida, falha fechado (recurso bloqueado, tela sem estilo). O
  // incidente de ago/2026 descrito abaixo foi com SRI + SW em OUTRA origem;
  // o comportamento com mesma origem nao foi testado - nao dependa dele.
  //
  // ── Assets IMUTAVEIS: cache-first ─────────────────────────────────────────
  // O `no-store` logo abaixo existe para app.js/style.css, que trocam de
  // conteudo sob o mesmo caminho. As bibliotecas vendored NAO trocam: a versao
  // esta no caminho (bootstrap/5.3.3/...) e as woff2 do Google tem o hash do
  // conteudo no nome. Deixa-las no `no-store` refaria por carga ~800 KB que o
  // CDN cacheava por um ano - foi o achado da revisao de codigo desta
  // mudanca. Cache-first aqui e' seguro porque mudar de versao muda a URL.
  //
  // `ignoreSearch: true` por causa dos icones: o CSS pede a woff2 com
  // `?dd67...` e a casca a guarda sem query - sem isso o pre-cache nunca
  // casaria e o offline dependeria de uma sorte de runtime.
  //
  // ⚠️ fontes.css fica FORA (nao casa com o teste de extensao): o caminho dele
  // nao tem versao, entao cache-first o congelaria para sempre - uma edicao
  // futura nunca chegaria a quem ja o tivesse. Ele segue no `no-store`, e
  // custa ~1 KB.
  const imutavel =
    url.pathname.startsWith("/static/vendor/") ||
    (url.pathname.startsWith("/static/assets/fontes/") && url.pathname.endsWith(".woff2"));
  if (isSameOrigin && imutavel) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
      )
    );
    return;
  }

  // 🚨 NÃO INTERCEPTAR OUTRA ORIGEM (CDN, fontes).
  //
  // Isto quebrou o sistema em produção (ago/2026): as tags do cdnjs ganharam
  // `integrity` (SRI) e o navegador NÃO consegue validar integridade numa
  // resposta entregue pelo service worker — ele bloqueia o recurso. Resultado:
  // o CSS do Bootstrap não carregava e a tela aparecia toda desalinhada.
  //
  // O sintoma engana: logo após desregistrar o SW a página carrega bem (porque
  // aquele load não é controlado por ele) e só volta a quebrar na recarga
  // seguinte. Foi assim que o diagnóstico errou na primeira vez.
  //
  // Não há perda: o `put` no cache abaixo já era só para mesma origem, então
  // interceptar o CDN nunca serviu para nada aqui.
  if (!isSameOrigin) return;

  // Para os recursos da mesma origem (HTML/JS/CSS), busca SEMPRE a versão nova
  // ignorando o cache HTTP do navegador (no-store) — evita servir app.js antigo.
  const fetchReq = new Request(req.url, { cache: "no-store" });

  event.respondWith(
    fetch(fetchReq)
      .then((res) => {
        // Atualiza o cache de fallback com a versão nova (apenas mesma origem)
        if (res && res.ok && isSameOrigin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // Offline: serve do cache; navegação cai para a home
        caches.match(req).then((r) => r || caches.match("/"))
      )
  );
});
