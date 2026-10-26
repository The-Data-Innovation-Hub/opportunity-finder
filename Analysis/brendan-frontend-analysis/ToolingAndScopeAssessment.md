# Tooling and Scope Assessment

Completed before any repository command would have run. None did.

## Scope

- Application/project: Opportunity Finder, the company portal and programme admin web frontend
- Repository and commit: github.com/The-Data-Innovation-Hub/opportunity-finder, `main` at `36e593a`, working tree clean
- Packages/apps included: the root Vite app, `src/`: 15 files, 1,412 lines, all reviewed in full
- Generated/vendor directories excluded: `node_modules/`, `dist/`, `Backend/` (a separate review area, cross-referenced only for trust-boundary facts), `Scraper/` (Python)
- Critical journeys/data types:
  - Magic-link sign-in (session cookie)
  - Company report view and spreadsheet download
  - Company profile editing (commercial data; INF-006 confirms no personal data)
  - LLM API key entry (secret, write-only)
  - Colleague invitations (email addresses)
  - Programme admin: companies, cost, free period, programme key
- Environments represented by the code: local dev (the Vite proxy to :3001) and Azure Container Apps (the API serves the built `dist/`)
- Review date: 26 Oct 2026

## Execution decision

- Analysis mode: Static-only, with dated corroborating CI and build records
- User authorised repository code execution: No (the skill was invoked without arguments, and execution wasn't requested)
- Existing dependencies sufficient without installation: Unknown (not checked; no command run)
- Production/external credentials unavailable to commands: Not applicable (no commands run)
- Scripts/lifecycle hooks inspected:
  - `package.json` scripts were read: `dev`, `build` (`tsc --noEmit && vite build`), `typecheck`, `preview`.
  - No `postinstall` or `prepare` hook was found.
- Network, service, port, write, generation, or snapshot risks:
  - `dev` and `preview` start servers.
  - `build` writes `dist/`.
  - Both were withheld.
- Commands approved under the execution policy: none
- Commands withheld and reason: `npm run typecheck`, `npm run build`, `npm audit` and lint were not run. Repository execution wasn't authorised, and there is no lint config to run.
- Pre-execution repository status recorded: Yes. `git status --short` was empty at `36e593a`.
- Post-execution repository status unchanged: Not applicable. The only writes are the reports in this directory.

Corroborating records, not run by this review:

- **GitHub Actions run of `Tests`:** the `frontend` job (`npm ci`, `npm run build`) passed at `36e593a`.
- **Azure Container Registry build log of 26 Oct 2026:**
  - root `npm ci` reported "found 0 vulnerabilities";
  - the Vite output reported `index-*.js` at 386.66 kB (119.16 kB gzip).

Both were produced earlier in this working session.

## Decision

- Tool execution permitted: No
- Remaining safeguards or evidence requests:
  - Authorise `npm run typecheck`, `npm audit --omit=dev` and a lint pass, if one is added, so this can be upgraded to "Static plus authorised tooling".
  - Runtime accessibility evidence (axe or a screen-reader pass, contrast checks) would come from a separate QA review.
