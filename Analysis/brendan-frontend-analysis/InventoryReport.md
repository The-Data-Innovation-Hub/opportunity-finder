# Frontend Inventory Report

This report records the current state only. Commentary is in `ArchitectureAssessment.md` and issues are in `FindingsRegister.md`.

## Scope

- Application/project: Opportunity Finder web frontend
- Repository and commit: The-Data-Innovation-Hub/opportunity-finder at `36e593a`
- Package(s)/apps in scope (if a monorepo): the single root Vite app (`src/`). `Backend/` and `Scraper/` live in the same repository but are out of scope.
- Date of this inventory: 26 Oct 2026
- Analysis mode and authorised tooling actually run: Static-only. No tooling was run.
- Areas not accessible for review (and why):
  - Runtime behaviour was not observed (no dev server, no browser), by the skill's rule.
  - Dependency audit and typecheck were not run: no execution was authorised.
- Generated/vendor/sampled scope exclusions: `node_modules/` and `dist/` were excluded. Nothing was sampled; all 15 source files were read.

| File | Lines | Role |
|---|---:|---|
| src/main.tsx | 19 | QueryClient (staleTime 30 s; no retry on 4xx; max 2 retries) and the router provider |
| src/router.tsx | 19 | Code-based TanStack Router routes and the not-found route |
| src/api.ts | 109 | fetch wrapper, `ApiError`, hand-written response types, the formatters `formatDate`/`money`/`daysUntil`, and `safeHref` |
| src/useMe.ts | 3 | The `['me']` query hook |
| src/styles.css | — | Tailwind 4 `@theme` tokens and the `:focus-visible` outline |
| src/components/ui.tsx | 130 | Button, Card, Field, Input, Textarea, Select, MultiSelect, Badge, Spinner, Loading, ErrorBox, Notice, Empty and Stat |
| src/components/Layout.tsx | 57 | Shell, navigation, 401 redirect, sign-out, skip link and the free-period notice |
| src/components/CompanyTabs.tsx | 13 | Company sub-navigation |
| src/components/CostCard.tsx | 96 | Service cost tiles, SVG weekly bars and a table fallback |
| src/pages/Home.tsx | 23 | Redirect or company list |
| src/pages/SignIn.tsx | 67 | Magic-link request and fragment-token verification |
| src/pages/CompanyReport.tsx | 214 | Report, top five, filterable opportunities table and history |
| src/pages/CompanySettings.tsx | 266 | Profile form, AI key settings and members |
| src/pages/Admin.tsx | 277 | Programme admin: cost, free period, companies, runs and search settings |
| src/pages/NotFound.tsx | 7 | Not-found page |

Routes: `/sign-in`, `/`, `/companies/$companyId`, `/companies/$companyId/reports/$reportId`, `/companies/$companyId/settings` and `/admin`.

## Stack as found

- Framework and version: React 19.3 (`^19.3.1`)
- Build tool: Vite 8.3 with `@vitejs/plugin-react` 6 and `@tailwindcss/vite` 4.3. Source maps are off in the build.
- Package manager: npm; `package-lock.json` is committed.
- Routing approach: TanStack Router 1.170, code-based routes, no lazy routes
- State management approach: TanStack Query 5.104 for server state; local `useState` for forms and UI. There is no global client store.
- Styling approach: Tailwind 4 utilities with `@theme` tokens (`brand`, `ink`, `muted`, `line`, `surface`, `good`, `warn`, `bad`)
- API communication approach:
  - `fetch` to same-origin `/api` with `credentials: 'same-origin'`;
  - a JSON body;
  - an error envelope mapped to `ApiError`.
- Test tooling: none for the frontend

## Type-checking and linting configuration

- `tsconfig.json` strictness settings: `strict: true`, `noUnusedLocals: true`, `noEmit`, `skipLibCheck`. `noUncheckedIndexedAccess` is not set.
- Linter configuration and enforcement (local only / CI-enforced): none. There is no ESLint, Biome or Prettier config in `git ls-files`, and no lint script.

## API contract

- Shared/generated type source: No. The response types are hand-written in `src/api.ts` and are not generated from, or shared with, `Backend/API`.
- Runtime validation of API responses: No. `request` returns `json as T` (`src/api.ts:20`).

## Testing as found

- Test types present (unit / integration / end-to-end): none for the frontend. The backend has 31 unit and 56 DB tests, and the scraper has 53 pytest tests. Those are out of scope.
- Enforced in CI: Yes, but only typecheck and build. `.github/workflows/tests.yml` job `frontend` runs `npm ci` and then `npm run build`, which includes `tsc --noEmit`.
- Coverage figures (if runnable): Not applicable (no tests)
- CI platform enforcement verified directly: Partial. The workflow file was read and the green run was seen in this session. Branch protection or required checks were not inspected.

## Documentation vs. reality

- `README.md` describes the GitHub Actions jobs. This matches the workflow file.
- No frontend style guide or ADR exists to compare against.
- Code comments cite requirement IDs (DEC-003, DEC-011, DEC-013, BEH-010, BEH-012, INF-002). The behaviour they describe matches the code read.
