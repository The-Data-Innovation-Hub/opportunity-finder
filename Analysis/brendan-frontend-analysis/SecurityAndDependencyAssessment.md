# Security and Dependency Assessment

This is a retrospective review. Nothing was changed, and no secret value is recorded.

## Secrets and exposure

- Hardcoded secrets/credentials found: No. A grep of `src/` for keys, tokens and `import.meta.env` found no env reads and no credentials.
- Confidentiality/usability and impact confirmed: Not applicable
- Build-time environment variables bundled into the client that shouldn't be public: No. `import.meta.env` is not used anywhere, and `vite.config.ts` defines no `define` or `envPrefix`.
- Public-but-restricted keys (maps, analytics) and their provider-level restriction status, as far as determinable: none present. There is no analytics or third-party script.
- LLM API key entry (`CompanySettings.tsx:218-219`, `Admin.tsx` FreePeriod):
  - `type="password"`, `autoComplete="off"`, `spellCheck={false}`;
  - state is cleared on success and on error;
  - the key is sent only to the same-origin API and never displayed (only `lastFour`).

  See EVD-020.

## Injection and XSS

- `dangerouslySetInnerHTML`/`innerHTML` usage found: No. All rendering goes through React text interpolation, including the LLM-generated `why_top_pick`, `practical_steps` and `why_it_fits` fields (EVD-008).
- Unvalidated redirect/URL construction from user input found: No.
  - Opportunity links go through `safeHref`, which allows only `http:`/`https:`, with `rel="noopener noreferrer"` (EVD-008).
  - The report download navigates to a server-returned URL with `window.location.assign` without `safeHref`. This is acceptable because it is server-controlled, but it is a defence-in-depth gap (SEC-001).
  - The magic-link token is read from the URL fragment, never sent as a query string, and removed with `history.replaceState` (EVD-009).
- CSP on the served SPA (EVD-006):
  - `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`
  - `nosniff`; `Referrer-Policy: no-referrer`; HSTS when served over TLS.
  - The CSP blocks inline and `javascript:` script execution, which compensates for SEC-001.

## Authorisation boundary

- Frontend visibility/permission checks found: Yes.
  - `/admin` redirects when `!isProgrammeAdmin`.
  - Settings forms are disabled and buttons hidden for `company_member`.
  - Company pages show "not found" if the company is not in `/me`.
- Corresponding server-side enforcement inspected: Yes, cross-referenced only. `Backend/Tests/Db/api.test.js` has:
  - the backend's cross-company isolation tests (its own requirement ID, not this register's SEC-001): another company's data is 404 on every route;
  - INF-003 cases: programme admins get summaries only and cannot self-invite.

  These passed in CI at `36e593a` (EVD-018). The backend review owns this control.
- Sensitive routes reachable directly by URL with only UI hidden: No confirmed case.
  - The `/admin` card queries fire while `/me` is still loading (EVD-022). A non-admin briefly triggers admin GETs that the API rejects. There is no data exposure if the backend tests hold.
- Session: `httpOnly`, `secure` (in production), `sameSite: 'lax'` cookie. There is no token in `localStorage` or `sessionStorage` (EVD-007).

## Dependency security

- Dependency audit safely authorised and run: No. The only evidence is the ACR build log of 26 Oct 2026, where root `npm ci` reported "found 0 vulnerabilities" (EVD-016). That is npm's install-time audit summary, not a separate `npm audit` run.

| Severity | Count | Notable packages |
|---|---:|---|
| Critical | 0 (install-time summary) | — |
| High | 0 (install-time summary) | — |
| Medium | 0 (install-time summary) | — |
| Low | 0 (install-time summary) | — |

- Lockfile committed and in sync: committed, yes. In sync: the CI `npm ci` succeeds, and `npm ci` fails on a mismatch.
- Deprecated/unmaintained security-relevant packages found: No. There are 4 runtime dependencies (React, React DOM, TanStack Query and Router), all current majors.
- Applicability/reachability and compensating controls assessed: not applicable; no advisories were reported.

## Overall security risk verdict

- Highest individual risk found: SEC-001 (Informational). The download URL is not scheme-checked client-side, and the CSP compensates.
- Whether this feeds a Critical finding in the findings register: No.
