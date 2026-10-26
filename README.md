# Opportunity Finder

Weekly funding and tender reports for the companies on The Data Innovation Hub's programme. Every Sunday night, for each company, a model on the company's own AI provider account searches Northern Ireland, Ireland and UK funders and tender portals against that company's profile. On Monday morning the company gets an email and can view and download the report (the same layout as the sample spreadsheet). Programme admins manage companies and see run summaries and the service's running cost, never report content.

Requirements: `Requirements/Requirements.md`. Design: `Requirements/ArchitectureProposal.md`. Deployment: `Infra/DEPLOYMENT.md`.

## Layout

| Path | What |
|---|---|
| `src/` | React + TypeScript frontend (Vite, TanStack Router and Query, Tailwind) |
| `Backend/API/` | Express 5 API: magic-link sign-in, company and admin routes |
| `Backend/Database/` | Migrations, runner, seeds |
| `Backend/Services/` | Key Vault, Blob Storage and email adapters, each with a local stand-in |
| `Backend/Worker/` | Weekly job: gather, per-company research, workbook, email, retention, Azure cost |
| `scraper/` | Python scraper service (funder pages, Innovate UK competitions, eTenders) |
| `Infra/` | Bicep, role grants, database roles |

## Local development

Needs Node 24+ and a local PostgreSQL.

```bash
npm install && (cd Backend && npm install)
```

```bash
createdb opportunity_finder_dev
```

```bash
cd Backend && cp .env.example .env && npm run migrate && node --env-file=.env Database/Seeds/devFixtures.js
```

The fixtures are synthetic: a programme admin (`admin@example.test`), a trial company with the last trial run's report, and a second company still being set up. Start the API and the frontend in two terminals:

```bash
cd Backend && node --env-file=.env API/Server.js
```

```bash
npm run dev
```

Open http://localhost:5173 and ask for a sign-in link for `founder@example.test` or `admin@example.test`. With `DEV_PRINT_MAIL=1` the link is printed in the API's terminal; no mail is sent locally.

To see the free period (DEC-011) as companies and admins do, switch the dev database between its states with `cd Backend && npm run dev:free-period -- <covered|no-key|budget|off>`, then reload the app.

The weekly job needs the scraper (`cd scraper && .venv/bin/uvicorn main:app --port 8080`), a Brave key, and a company with a real provider key, and it costs money, so it is not part of local start-up. Trial runs use `Backend/Worker/trial.js`.

## Tests

```bash
cd Backend && npm test
```

```bash
cd Backend && npm run test:db
```

`test:db` creates a uniquely named database on the local server for each test file and drops it afterwards. The API and job tests run as the production runtime roles from `Infra/database-roles.sql`, so a missing grant fails a test. It refuses any server that is not local.

```bash
cd scraper && .venv/bin/python -m pytest
```

```bash
npm run lint && npm run typecheck && npm run build
```

`npm run lint` is Oxlint (`.oxlintrc.json`) with the React hooks and jsx-a11y rules. It is used instead of ESLint because typescript-eslint does not support TypeScript 7 yet. A rule is turned off in a line comment only with the reason next to it.

GitHub Actions runs all of these on every push to `main` and every pull request (`.github/workflows/tests.yml`), with the database tests on a throwaway Postgres 16. Check the run passed before building an image (`Infra/DEPLOYMENT.md`, "Each release"). That Postgres sorts text by `en_US` rules, as Azure does, so a test that compares rows sorted by text should sort with `COLLATE "C"`.

## Security notes

- Sign-in links are single-use, expire after 15 minutes (invitations 7 days), and are stored only as SHA-256 hashes. The token travels in the URL fragment, so it never reaches a server log.
- Sessions are HttpOnly, SameSite=Lax cookies, revocable server-side; state-changing requests must come from the app's own origin.
- Company API keys go to their own Key Vault and nowhere else. The database keeps the last four characters; nothing returns or logs the key.
- Every company route checks the caller's membership in the query; another company's data is 404.
- Programme admins get counts and costs only (DEC-003).
