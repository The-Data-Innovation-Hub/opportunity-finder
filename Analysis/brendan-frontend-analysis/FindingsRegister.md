# Findings Register

No secret values or personal data appear here. Every confirmed finding cites stable evidence, and inference is listed under Probable risks.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 6 |
| Informational | 3 |

## Evidence index

| Evidence ID | Mode | Commit/tool/runtime context | Minimal evidence or source | Limitations |
|---|---|---|---|---|
| EVD-001 | Static | `36e593a` | `src/api.ts:10-20`: `request` parses JSON and returns `json as T` | — |
| EVD-002 | Static | `36e593a` | `tsconfig.json`: `strict: true`, `noUnusedLocals: true` | `noUncheckedIndexedAccess` not set |
| EVD-003 | Static | `36e593a` | `git ls-files` lists no eslint, biome or prettier config; `package.json` has no lint script | — |
| EVD-004 | Static + corroborating CI | `36e593a`; GitHub Actions `Tests` run | `.github/workflows/tests.yml:20-29`: the `frontend` job runs `npm ci` and `npm run build` (tsc + vite); the run was green | Required-check setting not inspected |
| EVD-005 | Static | `36e593a` | `git ls-files` lists no `*.test.*`/`*.spec.*` under `src/`, and no vitest/playwright config or dependency | — |
| EVD-006 | Static (backend, cross-reference) | `36e593a` | `Backend/API/App.js:50-58`: CSP, nosniff, no-referrer and HSTS on the served SPA | Not observed at runtime |
| EVD-007 | Static (backend, cross-reference) | `36e593a` | `Backend/API/Auth.js:23`: session cookie `httpOnly`, `secure`, `sameSite: 'lax'`; no web-storage use in `src/` | — |
| EVD-008 | Static | `36e593a` | Grep finds no `dangerouslySetInnerHTML`, `innerHTML` or `eval`; `src/api.ts:113` `safeHref` (http/https only) is used at `CompanyReport.tsx:208` | — |
| EVD-009 | Static | `36e593a` | `src/pages/SignIn.tsx:14-24`: the token is read from `location.hash` and removed with `history.replaceState`; the hashchange listener is cleaned up | — |
| EVD-010 | Static | `36e593a` | `src/pages/Admin.tsx:168-169` and `:226-227`: the `!form` guard precedes the `error` guard | — |
| EVD-011 | Static | `36e593a` | `src/api.ts:107` `daysUntil` (00:00Z, non-null); `CompanyReport.tsx:10` local `daysUntil` (23:59:59Z, nullable); `CostCard.tsx:13` inline third copy | — |
| EVD-012 | Static | `36e593a` | `src/components/Layout.tsx:35`: `aria-label="Signed in as"` on a plain `<span>` | AT behaviour not observed |
| EVD-013 | Static | `36e593a` | `src/pages/CompanyReport.tsx:175-181`: `role="tablist"`/`role="tab"` buttons, no arrow-key handling, `aria-controls` or `tabpanel` | — |
| EVD-014 | Static | `36e593a` | `src/components/CostCard.tsx:61-97`: bar tooltip on `onMouseEnter` only; "Show as a table" fallback at `:46-54`; SVG `role="img"` with an aria-label | — |
| EVD-015 | Static | `36e593a` | `src/components/ui.tsx:95-103`: Badge tones use `bg-slate-100 text-slate-700` and `bg-amber-50`; Notice at `:125` uses `bg-green-50`/`bg-blue-50`; `CostCard.tsx:89` uses `bg-white` | Contrast not measured |
| EVD-016 | Corroborating build log | ACR build of `opportunity-finder:202610261554`, 26 Oct 2026 | Root `npm ci` printed "found 0 vulnerabilities"; Vite printed `index-*.js` 386.66 kB / 119.16 kB gzip | Not an `npm audit` run by this review |
| EVD-017 | Static | `36e593a` | `src/router.tsx`: all routes import components eagerly; no `lazy` or `lazyRouteComponent` | — |
| EVD-018 | Corroborating CI (backend) | `36e593a`; `Backend/Tests/Db/api.test.js:133,143,197,245` | Backend requirement tests for cross-company isolation and INF-003 programme-admin limits passed in the GitHub Actions backend job | Owned by the backend review; not re-run |
| EVD-019 | Static | `36e593a` | `ui.tsx` `Field` (useId, `aria-describedby`); `Loading` `role="status"`; `ErrorBox` `role="alert"`; `Layout.tsx:52` skip link; `styles.css:20` `:focus-visible`; table captions and `scope="col"` | No runtime AT pass |
| EVD-020 | Static | `36e593a` | `CompanySettings.tsx:152-164,218-219` and `Admin.tsx` FreePeriod: password field, `autoComplete="off"`, key state cleared on success and error | — |
| EVD-021 | Static | `36e593a` | `CompanyReport.tsx:102-103`: `window.location.assign(url)` with the server-returned download URL; no scheme check | — |
| EVD-022 | Static | `36e593a` | `Admin.tsx:12-24`: `Navigate` only once `me.data` resolves; the card queries mount while `me` is pending | — |

## Confirmed findings

| ID | Dimension | Scope | Severity | Confidence | Condition and consequence | Evidence ID(s) | Severity rationale | Recommended outcome | Owner category | Disposition |
|---|---|---|---|---|---|---|---|---|---|---|
| TST-001 | Testing coverage and quality | Whole frontend | Medium | Confirmed | There are no unit, component or end-to-end tests for the frontend. CI gates only typecheck and build. Regressions in sign-in, report filters, key entry or role-based disabling would ship unnoticed. | EVD-004, EVD-005 | Meaningful defect likelihood on the six critical journeys. Mitigated by the strict TS, a small codebase and a thorough backend API test suite. | Add a minimal suite: ui primitives, the Opportunities filter, the KeySettings clear-on-error, member-vs-admin disabling, and one end-to-end sign-in → report flow against the dev API | Frontend engineering | Open |
| TYP-001 | Type safety and API contract adherence | `src/api.ts` and every `api.get<T>` call | Medium | Confirmed | Response types are hand-written and cast unchecked (`json as T`). Nothing ties them to the backend's validators or responses. A backend shape change would compile and fail at runtime, for example as blank cells or a `.toFixed` on undefined. | EVD-001 | Medium: same repository and a small team lower the likelihood, but CI cannot detect drift | Add contract checks (a shared schema, or a light runtime parse for the key endpoints `/me`, report and opportunities), or a backend test that asserts response shapes against the frontend types | Frontend + backend engineering | Open |
| STA-001 | State management and data flow | `Admin.tsx` Settings and FreePeriod cards | Low | Confirmed | `if (query.isPending \|\| !form)` runs before `if (query.error)`. When the first load fails, `form` stays null, so the card shows a spinner indefinitely instead of the error and retry. The FreePeriod card is affected when the programme-key query fails. | EVD-010 | Admin-only, no data effect. It hides failures on the cost-control screens. | Check `error` before the `!form` guard and add `onRetry` | Frontend engineering | Open |
| ARC-001 | Component architecture and code quality | Repository | Low | Confirmed | No linter is configured or run, so hook-dependency mistakes, unused effects and accessibility lint (jsx-a11y) are not caught automatically. | EVD-003 | Strict TS covers much of this ground | Add ESLint with `react-hooks` and `jsx-a11y` and run it in the CI `frontend` job | Frontend engineering | Open |
| ARC-002 | Component architecture and code quality | `api.ts`, `CompanyReport.tsx`, `CostCard.tsx` | Low | Confirmed | `daysUntil` is implemented three times. Two copies count to 00:00Z and the report-table copy counts to 23:59:59Z. A date can show different day counts on different screens. | EVD-011 | Cosmetic off-by-one risk; maintainability | Keep one helper with an explicit inclusive/exclusive option | Frontend engineering | Open |
| TYP-002 | Type safety and API contract adherence | `CompanyReport.tsx:13` | Low | Confirmed | `useParams({strict: false}) as {companyId: string, reportId?: string}` discards the router's typing because the component serves two routes. | EVD-011 | Local; the route definitions guarantee `companyId` today | Use `useParams({from: ...})` per route, or pass the params as props from two thin route components | Frontend engineering | Open |
| A11Y-001 | Accessibility | `CompanyReport.tsx` Opportunities kind switcher | Low | Confirmed | The buttons carry `role="tab"` without the tab pattern: no arrow keys, no `aria-controls`, no `tabpanel`. Screen readers announce tabs that do not behave as tabs. | EVD-013 | Operable by Tab and Enter; a mismatched announcement only | Either implement the tabs pattern or drop the roles and use `aria-pressed` toggle buttons | Frontend engineering | Open |
| A11Y-002 | Accessibility | `Layout.tsx:35` | Low | Confirmed | `aria-label` on a generic `<span>` is prohibited in ARIA 1.2 and is ignored or overrides the text inconsistently, so the email may not be announced. | EVD-012 | Header label only | Use visually hidden text ("Signed in as") before the email | Frontend engineering | Open |
| UIC-001 | UI and design-system consistency | `ui.tsx` Badge and Notice; `CostCard.tsx` tooltip | Low | Confirmed | Status colours mix `@theme` tokens (`text-warn`, `text-good`) with raw palette classes (`slate-*`, `amber-50`, `green-50`, `blue-50`, `bg-white`), so the tokens are not the single source of colour. | EVD-015 | Consistency only; contrast was not measured | Add surface tokens for each tone and use them | Frontend engineering | Open |
| SEC-001 | Security | `CompanyReport.tsx:102-103` | Informational | Confirmed | The download navigates to a server-returned URL without the `safeHref` scheme check. | EVD-021, EVD-006 | Server-controlled value; the CSP `script-src 'self'` blocks `javascript:` execution | Optionally pass the URL through `safeHref` | Frontend engineering | Open |
| PRF-001 | Performance and rendering efficiency | Build output | Informational | Confirmed | A single eagerly loaded bundle of 386.66 kB (119.16 kB gzip). The admin and settings code ships to every user. | EVD-016, EVD-017 | Acceptable for this audience and size; no observed slowness | No action needed; revisit if the bundle grows past about 250 kB gzip | Frontend engineering | Open |
| A11Y-003 | Accessibility | `CostCard.tsx` WeeklyBars | Informational | Confirmed | Bar values appear on mouse hover only, with no keyboard or touch equivalent. A "Show as a table" fallback and the SVG label cover the data. | EVD-014 | Fully compensated by the table | None required | Frontend engineering | Open |

## Probable risks

| ID | Dimension | Scope | Basis | What would confirm it | Potential severity | Confidence |
|---|---|---|---|---|---|---|
| PR-1 | Accessibility | Badge and `text-muted` text | Light tinted backgrounds (`amber-50`, `slate-100`) with small (`text-xs`) coloured text | A contrast measurement on the rendered tokens | Low | Low |
| PR-2 | Security | `/admin` for non-admins | Admin queries fire before the `/me` check resolves (EVD-022) | Backend 403s are already covered by the INF-003 tests. Confirm that no admin data renders between the response and the redirect. | Low | Low |
| PR-3 | Accessibility | Indeterminate loading spinners | `Loading` uses `role="status"`, but a long `busy` state on a Button is not announced | A screen-reader pass of the key save flow | Low | Low |

## Unverified assumptions

| ID | Assumption | Why unverified | Impact if wrong | Required evidence |
|---|---|---|---|---|
| UA-1 | The deployed app sends the CSP in `App.js` | Runtime headers not observed The CSP compensation for the download-URL finding is weaker | `curl -I` on the live URL (user-run) |
| UA-2 | The `Tests` workflow is a required check on `main` | GitHub branch protection not inspected | Typecheck gating may be advisory | Repository settings |
| UA-3 | Dependencies have no known advisories | Only the install-time `npm ci` summary was seen | Dependency risk unknown | `npm audit --omit=dev` |
