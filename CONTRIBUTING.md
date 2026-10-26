# Contributing

Thanks for your interest in LeoJuris. Bug reports, questions and pull requests are welcome.
For security problems, use [SECURITY.md](SECURITY.md) instead of a public issue.

## Workflow

1. **Fork** the repository and clone your fork.
2. Create a **branch** from `main` with a descriptive name, e.g. `fix/deadline-carnival`.
3. Make your change, with tests when it touches the backend.
4. Run the checks below.
5. Open a **pull request** against `main` explaining what changed and why. CI runs the test
   suite on every pull request.

The code, comments, UI texts and commit messages of this project are in Brazilian Portuguese;
pull requests in English or Portuguese are both fine.

## Setting up

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python seed.py                     # sample data (local SQLite only)
uvicorn app.main:app --reload      # http://127.0.0.1:8000 — admin@escritorio.com / admin123
```

## Checks before opening a pull request

**Backend tests** — they run on a temporary SQLite database with network access blocked, so
they never touch `backend/crm.db` or an external API:

```bash
cd backend
pytest
```

**Frontend syntax** — `app.js` and the four `ficha*.js` files are classic scripts that share
one global scope. A `const`/`let` declared in two files is a `SyntaxError` that silently kills
the whole file, so they are checked together, and duplicate function names must not exist:

```bash
cd frontend
cat app.js ficha.js ficha-modulos.js ficha-cliente.js ficha-processo.js > /tmp/all.js
node --check /tmp/all.js
grep -ohE '^(async )?function [A-Za-z_$]+' *.js | sort | uniq -d   # must print nothing
```

## Rules the test suite and the security model rely on

- **Every new `DELETE` route** must call `require_excluir(current_user)` (or be admin-only)
  and get an entry in `ROTAS_DELETE` in `backend/tests/test_delete_estagiario.py`. The suite
  fails on purpose when a registered DELETE route is missing from that table.
- **Every route that reads `Precatorio` or `Acao`** needs the list filter
  (`filtrar_classificacao` / `filtrar_area`) and the per-record check
  (`ensure_classificacao` / `ensure_area`) from `backend/app/scope.py`, plus `_mascarar` on
  whatever it returns.
- **IDs coming in the request body** (`client_id`, `process_id`) need `ensure_owner` on the
  target record — module permission alone is not enough.
- **New personal-data fields** of queue leads go into `_SENSIVEIS` in both
  `routers/precatorios.py` and `routers/acoes.py`.
- **Closed value lists** are validated in the `Create`/`Update` schemas, never in the `Base`
  schema (output models inherit from it).
- **No inline event handlers** (`onclick=` and friends): the Content Security Policy blocks
  them. Use `data-on-click="actionName"` and register the action with `registrarAcoes`.
- **Escape on output**: `esc()` for HTML and `escJs()` for values placed inside a JavaScript
  context.
- **Frontend cache busting**: after editing a script or the stylesheet, bump its `?v=` in
  `frontend/index.html` (the five scripts share one value) and the `CACHE` name in
  `frontend/sw.js`; otherwise browsers and the service worker keep serving the old file.
- **Top-level names in the frontend** use the file's prefix (`ficha*`, `ui*`, `fmt*`,
  `cache*` in `ficha.js`; `fm*` in `ficha-modulos.js`; `fc*` in `ficha-cliente.js`; `fp*` in
  `ficha-processo.js`).

## Reporting bugs

Open an issue with the steps to reproduce, what you expected and what happened. Never paste
real client data — reproduce with the sample data from `seed.py`.
