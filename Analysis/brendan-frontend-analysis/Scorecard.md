# Brendan Frontend Analysis Scorecard

- Application/project: Opportunity Finder web frontend (`src/`)
- Date of review: 26 Oct 2026
- Analysis mode: Static-only, with dated corroborating CI and build records
- Scope summary: one Vite + React 19 app, 15 files, 1,412 lines, 6 routes, all read in full at `36e593a`
- Assurance grade: C
- Previous comparable scorecard, if any: none

## Per-dimension scores

| Dimension | Weight | Score (0-5, N/A, or Unscored) | Evidence status summary | Rationale | Evidence ID(s) |
|---|---:|---|---|---|---|
| Security | 20% | 4 | Static verified; dependency and authorisation evidence is corroborating | Cookie session, fragment token scrubbed, no HTML sinks, `safeHref`, strict CSP, key fields cleared. Only an Informational gap; no audit run. | EVD-006, EVD-007, EVD-008, EVD-009, EVD-016, EVD-018, EVD-020 |
| Component architecture and code quality | 15% | 4 | Static verified | Clear, consistent structure with shared primitives. Low gaps: no linter, duplicated helper and key form. | EVD-003, EVD-011 |
| State management and data flow | 15% | 4 | Static verified | TanStack Query used uniformly with scoped keys, invalidation, and effect cleanup. One Low guard-order defect. | EVD-009, EVD-010 |
| Type safety and API contract adherence | 15% | 3 | Static verified; typecheck corroborated by CI | Strict TS in CI, but hand-written, unchecked response types (Medium) and one params cast | EVD-001, EVD-002, EVD-004 |
| Testing coverage and quality | 10% | 1 | Static verified | No frontend tests of any kind; only typecheck and build gate CI | EVD-004, EVD-005 |
| Accessibility | 10% | 4 | Static verified; contrast not assessed; no runtime AT pass | Labels, describedby, skip link, focus-visible, live regions, captions and a chart table fallback. Low ARIA misuses. | EVD-012, EVD-013, EVD-014, EVD-019 |
| Performance and rendering efficiency | 10% | 4 | Corroborating build log plus static | 119 kB gzip bundle, memoised filtering, 30 s staleTime, no 4xx retries. No splitting (Informational). | EVD-016, EVD-017 |
| UI and design-system consistency | 5% | 4 | Static verified | `@theme` tokens and shared primitives throughout; some raw palette classes | EVD-015 |

- Genuinely inapplicable dimensions and rationale: none
- Weights renormalised for N/A dimensions: No
- Any Unscored dimension preventing a definitive total: No

## Coverage

- Controls — static / tool / runtime verified / blocked / not assessed / insufficient: 16 / 0 / 0 / 0 / 1 / 0, plus 3 corroborating documentation (20 controls)
- Packages/routes/features — identified / reviewed / sampled / excluded: 1 package and 6 routes identified; all reviewed in full; none sampled; `Backend/` and `Scraper/` excluded as separate review areas
- Critical journeys — identified / reviewed / unverified: 6 / 6 statically / 6 at runtime
- Material limitations:
  - No runtime, browser or assistive-technology observation.
  - No `npm audit` or typecheck run by this review.
  - Backend authorisation known from its own tests only.

## Result and gates

- Raw weighted maturity score: 3.55/5
- Raw maturity band: Production-ready with minor gaps (3.5–4.49)
- Critical gate: Not applied. No Critical findings.
- High-finding gate: Not applied. No High findings.
- Assurance cap: Applied. Grade C, because the review is static-only and runtime, accessibility and dependency-audit evidence is unverified.
- **Effective verdict:** Provisional / needs targeted verification before production. The raw band is "production-ready with minor gaps", but frontend tests are absent and runtime evidence is not verified.
- Delta from comparable prior review: Not comparable. This is the first review.

## Top priorities

1. TST-001: add a minimal frontend test suite and an end-to-end sign-in → report flow to CI.
2. TYP-001: add contract checks between the backend responses and `src/api.ts` types.
3. STA-001, then ARC-001: fix the admin guard order, and add ESLint (`react-hooks`, `jsx-a11y`) to the CI `frontend` job.

## Outstanding evidence requests

1. Authorise `npm audit --omit=dev` and `npm run typecheck` (no installs) to move to "Static plus authorised tooling".
2. A runtime accessibility pass (axe, keyboard and a screen reader, colour contrast) over the six journeys, for example through `brendan-qa-analysis`.
3. GitHub branch protection status for the `Tests` workflow on `main`.

## Assurance statement

- **What static inspection established:** every frontend source file at `36e593a` was read, together with the build config, `tsconfig.json`, `package.json` and the CI workflow.
- **What was cross-referenced, not re-run:** the backend's served CSP, cookie flags and authorisation tests, for trust-boundary facts only.
- **Tools run by this review:** none.
  - The GitHub Actions `frontend` job (typecheck + build) and the ACR build log (install-time audit summary, bundle size) are dated corroborating records from the same day.
- **Not observed:** runtime behaviour, rendered contrast and assistive-technology behaviour.

The code shows sound security and state patterns, with no Critical or High findings. The absence of frontend tests and of runtime evidence keeps assurance at C. That is why the effective verdict is provisional, not a production-readiness claim.

## Post-review changes

These were fixed after this review, at `36e593a`. The scores, findings and verdict above describe that commit and have not been re-assessed. The findings register keeps every finding Open by design.

| Finding | Fixed in | Change |
|---|---|---|
| STA-001 | `e926477` | Admin Settings and Free period cards check the query error before the form guard, and offer Try again |
| ARC-002 | `5839110` | One `daysUntil` helper; the report table says "Closes today" or "1 day left" |
| TYP-002 | `5839110` | `CompanyReport` takes its params as props from the typed routes |
| A11Y-001 | `5839110` | The Funding/Tenders switch is `aria-pressed` buttons in a group |
| A11Y-002 | `5839110` | "Signed in as" is visually hidden text |
| UIC-001 | `5839110` | Tints come from `@theme` tokens; Tailwind scans `src` only |

Still open: TST-001, TYP-001 and ARC-001. A re-run of this analysis would re-score the frontend.
