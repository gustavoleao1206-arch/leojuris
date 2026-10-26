# Security policy

LeoJuris handles personal data of law-firm clients (names, CPF/CNPJ, addresses, phone
numbers, attorney fees). Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report it privately through GitHub: open the **Security** tab of this repository and click
**Report a vulnerability** (GitHub's *Private vulnerability reporting*). Only the maintainer
sees the report.

Please include:

- the affected file, route or screen;
- steps to reproduce, or a proof of concept against a **local** instance;
- the impact you expect (data exposure, privilege escalation, denial of service…).

You can expect an acknowledgement within a few days. Fixes are made in the main codebase
first and then reach this repository with the next public snapshot.

## Scope and rules

- Test only against your own local instance (`python seed.py` creates sample data).
  Never test against a deployment you don't own.
- Do not access, modify or keep data that isn't yours.
- In scope: anything in this repository — the FastAPI backend, the access-control layer
  (`backend/app/scope.py`), authentication and 2FA, the frontend and its Content Security
  Policy.
- Out of scope: third-party services the app integrates with (DataJud, DJEN, Clicksign,
  Google Gemini) and findings that require a compromised server or administrator account.

## Supported versions

Only the latest snapshot on the default branch is supported.
