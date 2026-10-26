# Frontend Architecture Assessment

This describes the frontend as it exists. It is advisory only and is not a proposal to rebuild anything.

## Summary verdict

- Overall characterisation: a small, coherent React 19 app with one clear pattern throughout:
  - TanStack Query for server state;
  - local state for forms;
  - a dozen shared UI primitives;
  - same-origin cookie API calls.

  It fits its scale (1,412 lines). Its weaknesses are around verification, not design: there are no frontend tests, no linter, and no runtime check on API response shapes.
- Assurance grade and evidence modes: C. Static-only, plus dated CI and build records (EVD-004, EVD-016).

## Component structure

- Organisation convention (by feature / by type / mixed): by type at the top level (`pages/`, `components/`). Each page file holds its own sub-components, for example `Admin.tsx` holds Cost, Companies, Invite, Runs, Settings and FreePeriod.
- Notable oversized or multi-responsibility components:
  - `Admin.tsx` (277 lines) and `CompanySettings.tsx` (266) each hold several independent cards.
  - Each card is self-contained with its own query and mutation, so the size is the file, not a component.
  - The `FreePeriod` component manages two forms and three mutations, the largest single unit.
- Reuse vs. duplication observed:
  - `ui.tsx` primitives are used consistently.
  - The AI key form (model select, password field, check-and-save, clear on error) is implemented twice: `CompanySettings.tsx` KeySettings and `Admin.tsx` FreePeriod. They are near-identical.
  - `daysUntil` exists in two forms with different day boundaries (ARC-002).

## State management and data flow

- Dominant approach: TanStack Query. Query keys are scoped by company (`['report', companyId, reportId]`). Mutations either `setQueryData` from the response or invalidate the affected key.
- Consistency across features: high. Every page follows the same query, then pending, then error, then data sequence.
- Handling of loading/error/empty states:
  - Present on every query.
  - Two admin cards order their guards so that an initial load failure shows a spinner indefinitely instead of the error (STA-001).
- Side-effect cleanup discipline:
  - The MultiSelect outside-click and Escape listeners are removed on cleanup, and so is the SignIn `hashchange` listener.
  - The SignIn verification dedupes with a ref.
  - Form hydration effects depend on `query.data`, whose reference TanStack's structural sharing keeps stable across unchanged refetches.

## Type safety and API contract

- Type-checking strictness and enforcement: `strict` plus `noUnusedLocals`; enforced by `npm run build` in CI (EVD-002, EVD-004).
- API contract source (shared/generated vs. hand-typed): hand-typed in `src/api.ts`, with nothing linking it to `Backend/API` validators (TYP-001).
- Runtime validation of responses: none (`json as T`, EVD-001). One `useParams({strict: false}) as {...}` cast bypasses router typing (TYP-002).

## Technology fit

| Area | Consistent across the codebase? | Notes |
|---|---|---|
| State management | Yes | TanStack Query only; no redundant global store |
| Styling approach | Mostly | Tailwind tokens. Badge, Notice and the chart tooltip use raw palette classes (`slate-*`, `amber-50`, `bg-white`) (UIC-001) |
| API communication | Yes | Single `request` wrapper; one error type |
| Component API design | Yes | `Field` render-prop supplies `id` and `aria-describedby`; Button `busy`/`variant` |

## Deviations from best practice (advisory only)

| Area | Deviation observed | Reversal cost if changed | Related finding ID |
|---|---|---|---|
| Testing | No component or end-to-end tests | Medium: add Vitest + Testing Library for ui.tsx and the three forms, then one Playwright sign-in → report flow | TST-001 |
| Linting | No ESLint (e.g. `react-hooks` rules) | Low | ARC-001 |
| Contract | Hand-typed responses, no runtime check | Low to medium: a small schema per endpoint, or shared JSON Schema with the backend validators | TYP-001 |
| Loading guards | `!form` checked before `error` | Very low | STA-001 |
| Helpers | Two `daysUntil` semantics | Very low | ARC-002 |

## Unresolved questions

- How the app behaves at runtime in browsers and with assistive technology (not observed).
- Whether GitHub requires the `Tests` workflow before merge.
- Whether the deployed response headers match `Backend/API/App.js` (not observed).
