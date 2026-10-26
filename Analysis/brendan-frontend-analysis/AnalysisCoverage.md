# Frontend Analysis Coverage

## Scope counts

| Category | Population identified | Reviewed | Sampled only | Blocked/unavailable | Excluded |
|---|---:|---:|---:|---:|---:|
| Applications/packages | 1 | 1 | 0 | 0 | 0 |
| Routes/features | 6 | 6 | 0 | 0 | 0 |
| Shared components/services | 7 | 7 | 0 | 0 | 0 |
| Critical journeys | 6 | 6 (static) | 0 | 6 (runtime) | 0 |
| Test/CI units | 1 | 1 | 0 | 0 | 0 |

The critical journeys are:

1. Sign-in
2. Report view and download
3. Profile edit
4. AI key entry
5. Invitations
6. Programme admin

## Control coverage

| Control ID | Dimension | Scope/unit | Evidence status | Evidence ID(s) | Limitation/exclusion rationale |
|---|---|---|---|---|---|
| C-SEC-01 | Security | Session handling (no token in web storage) | Static verified | EVD-007, EVD-009 | Cookie flags read from the backend source and cross-referenced only |
| C-SEC-02 | Security | XSS sinks (`dangerouslySetInnerHTML`, `innerHTML`, `eval`) | Static verified | EVD-008 | Grep over all of `src/` found none |
| C-SEC-03 | Security | Untrusted URLs in links | Static verified | EVD-008 | — |
| C-SEC-04 | Security | CSP and security headers on the served build | Static verified | EVD-006 | Header values were not observed at runtime |
| C-SEC-05 | Security | Secret entry (API key fields) | Static verified | EVD-020 | — |
| C-SEC-06 | Security | Server-side authorisation behind UI gating | Corroborating documentation | EVD-018, EVD-022 | Backend tests were cross-referenced and not re-run by this review |
| C-SEC-07 | Security | Dependency vulnerabilities | Corroborating documentation | EVD-016 | `npm audit` was not run; the ACR `npm ci` summary only |
| C-ARC-01 | Architecture | Component decomposition and reuse | Static verified | EVD-011 | — |
| C-ARC-02 | Architecture | Lint enforcement | Static verified | EVD-003 | Absence was confirmed via `git ls-files` |
| C-STA-01 | State | Loading, error and empty states | Static verified | EVD-010 | — |
| C-STA-02 | State | Effect cleanup and cache invalidation | Static verified | EVD-009 | — |
| C-TYP-01 | Type safety | Compiler strictness | Static verified | EVD-002, EVD-004 | Typecheck not re-run; CI green at `36e593a` |
| C-TYP-02 | Type safety | API response contract | Static verified | EVD-001 | — |
| C-TST-01 | Testing | Frontend test presence and CI gating | Static verified | EVD-004, EVD-005 | — |
| C-A11Y-01 | Accessibility | Labels, landmarks, skip link, focus style, live regions | Static verified | EVD-019 | No runtime screen-reader or axe pass |
| C-A11Y-02 | Accessibility | Colour contrast | Not assessed | EVD-015 | Needs a rendered page |
| C-A11Y-03 | Accessibility | Custom widgets (tabs, chart) | Static verified | EVD-013, EVD-014 | — |
| C-PRF-01 | Performance | Bundle size and splitting | Corroborating documentation | EVD-016, EVD-017 | Size taken from the ACR build log; no Lighthouse run |
| C-PRF-02 | Performance | Rendering hot paths | Static verified | EVD-011 | — |
| C-UIC-01 | UI consistency | Token use and shared primitives | Static verified | EVD-015 | — |

## Sampling

- Population and selection method: the whole population; all 15 files were read in full.
- High-risk items deliberately selected: not applicable (exhaustive)
- Unsampled remainder: none
- Representativeness limitations: none for source. Runtime behaviour, contrast and real browsers are not represented.
- Effect on assurance: Static-only, so assurance is capped at C.

## Outstanding evidence

| Priority | Evidence needed | Control/dimension affected | Effect if unavailable |
|---|---|---|---|
| 1 | `npm audit --omit=dev` on the root package | C-SEC-07 | The dependency score rests on the ACR `npm ci` summary |
| 2 | axe or Lighthouse pass and a keyboard/screen-reader walkthrough of the six journeys | C-A11Y-01..03 | The accessibility score stays provisional |
| 3 | Response headers observed on the deployed app | C-SEC-04 | The CSP is known from source only |
| 4 | Branch protection or required-check settings on GitHub | C-TST-01 | CI gating may be advisory |
