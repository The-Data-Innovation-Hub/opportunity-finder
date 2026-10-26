# Requirements Dashboard

Status as of 23 Oct 2026. Nothing is deployed to Azure yet, so every Azure integration (Key Vault, Blob SAS, Communication Services email, Cost Management, Container Apps schedules) is verified only through its local stand-in. Those rows say so.

## Summary

| Status | Count |
|---|---:|
| Proposed | 1 |
| Approved | 0 |
| In progress | 3 |
| Blocked | 1 |
| Verified | 26 |
| Not applicable | 1 |

## Requirements

| ID | Requirement | Status | Implementation | Verification | Evidence/exceptions |
|---|---|---|---|---|---|
| BEH-001 | Each company has its own profile | Verified | `API/Companies.js` (profile routes), `company_profile` | `Tests/Db/api.test.js` "BEH-001 …new version each time"; browser save (v1→v2, details kept) | |
| BEH-002 | UK and Ireland funding and tenders; tenders only when the company can supply directly | Verified | `Worker/Sources/*`, `Worker/CompanyReport.js` | `Tests/Db/weekly.test.js` "BEH-002 tenders…left out"; trial run8 (28 of 36 reference rows) | Source coverage judged by trial runs, not a unit test |
| BEH-003 | Weekly run for every active company | In progress | `Worker/Weekly.js`, `Worker/Job.js`, `Infra/main.bicep` (jobs) | `weekly.test.js` "BEH-003 weekly run…", "…does not repeat or re-bill" | Job logic verified; deployed to Azure 24 Oct 2026 (`job-oppfinder-weekly`, `0 22 * * 0` UTC); manual run on Azure 26 Oct 2026 succeeded (1 company, 11 min, US$3.09 model on programme key, 27 Brave queries, 52 rows); first scheduled run not yet observed |
| BEH-004 | Report reproduces the sample layout | Verified | `Worker/Report/workbook.js` | `Tests/workbook.test.js` | |
| BEH-005 | "New this week" against the previous report | Verified | `Worker/CompanyReport.js`, `previousRowsFor` in `Weekly.js` | `weekly.test.js` "BEH-005 next week…not new" | |
| BEH-006 | Companies sign in to view and download their own reports | Verified | `API/Auth.js`, `API/Companies.js`, `src/pages/CompanyReport.tsx` | `api.test.js` SEC-001 download test; browser walkthrough (sign-in, report, filters) | Azure user-delegation SAS download verified on the live site 26 Oct 2026 (xlsx opened) |
| BEH-007 | Email when the week's report is ready | In progress | `sendWeeklyEmails` in `Weekly.js`, `Services/Mail.js` | `weekly.test.js` "BEH-007…once per member per report" | ACS sending verified on Azure 24 Oct 2026 (sign-in email from no-reply@thedatainnovationhub.com, domain Verified for Domain, SPF, DKIM, DKIM2); weekly report email sent on Azure 26 Oct 2026 (emails job, notification `sent`) |
| BEH-008 | Company chooses a region scope | Verified | `REGION_SCOPES` and `scopeRegions` in `Worker/Research/search.js`, `profileFromBody` in `API/Companies.js`, profile form | `Tests/Db/schema.test.js` "BEH-008…"; `api.test.js` "BEH-001…" rejects `FR`, `NI`, `UK`, `IE`+`UK`; `research.test.js` "DEC-013…" | |
| BEH-009 | Fit points and funding angles in the profile | Verified | `details` JSON, `toWorkerProfile`, profile form | `Tests/search-inputs.test.js` | |
| BEH-010 | Company chooses provider and model and adds its own key | Verified | `API/Companies.js` llm-credential, `src/pages/CompanySettings.tsx` | `api.test.js` "SEC-002…"; `weekly.test.js` "BEH-010 a rejected key…", "DEC-011 after the free period, companies are back on their own keys" | Anthropic only until DEC-009 |
| BEH-011 | Works the same with any supported provider | In progress | `Worker/Research/loop.js`, `tools.js`, `Providers/` | `Tests/research.test.js`, `Tests/anthropic.test.js` | OpenAI and Google adapters not built (need test keys) |
| BEH-012 | KPI card: weekly and total Brave and Azure cost | Verified | `GET /admin/service-cost`, `Worker/AzureCost.js`, `src/components/CostCard.tsx` | `api.test.js` "BEH-012 the cost card…"; `weekly.test.js` "BEH-012 Azure daily cost…"; browser check | Cost Management API call untested against Azure |
| BEH-013 | Admins can stop and cap search without a code change | Verified | `service_setting`, `PUT /admin/service-settings`, per-run search reservation in `runWeek`, shared allowance in `Research/tools.js` | `api.test.js` "BEH-013…audited"; `weekly.test.js` "BEH-013…no web_search tool", "…cannot together pass the monthly search cap", "…failed run still records the searches and model work it was billed for"; `research.test.js` "BEH-013 a shared allowance…" | Reservations are per job process; two weekly jobs started at once could each reserve the same remainder |
| BEH-014 | "Also checked" sheet | Verified | `workbook.js`, `report.also_checked`, report page | `workbook.test.js` BEH-014 | |
| SEC-001 | Strict tenant isolation | Verified | Membership check in every company query; composite tenant FKs | `api.test.js` two SEC-001 tests; `schema.test.js` SEC-001 | |
| SEC-002 | Keys are write-only, Key Vault only | Verified | `Services/SecretStore.js`, separate keys vault in `main.bicep` | `api.test.js` "SEC-002…never returned or logged" (checks responses, DB row and every log line) | Verified with the in-memory store; Key Vault untested |
| SEC-003 | Sign-in and sessions resist misuse | Verified | `API/Auth.js`, `requireSameOrigin` | `api.test.js` DEC-001 and SEC-003 tests (single use, expiry, no enumeration, revocation, origin) | Rate limits are per replica |
| DAT-001 | Every opportunity keeps its source URLs | Verified | `source_urls` required by the strict `SUBMIT_REPORT` schema; stored in `report_row.row_data` | `anthropic.test.js` (strict schema); run8 output | |
| DAT-002 | Report history stays downloadable | Verified | `report` per week, reports list and history panel | `api.test.js` report tests; `weekly.test.js` week 2 | Kept 13 weeks (DEC-005) |
| DAT-003 | Sources are data, not code | Verified | `Worker/Sources/catalogue.json` | earlier source tests in `Tests/` | |
| DAT-004 | Standing checklist of schemes | Verified | `Worker/Sources/schemes.json`, `missingDecisions` | `search-inputs.test.js`, `research.test.js` | |
| INF-001 | Programme admin adds, renames and invites companies | Verified | `POST /admin/companies`, `PATCH /admin/companies/:id`, `/invitations`; rename in `src/pages/Admin.tsx`; grant in `0005_CompanyRename.sql` | `api.test.js` setup test; "INF-001 a programme admin can rename a company…" | Rename is audited (`company.renamed`); duplicate names are 409 |
| INF-002 | Several users per company, admins and members | Verified | `company_membership`, members routes | `api.test.js` two INF-002 tests | |
| INF-003 | Programme admins see summaries only | Verified | `API/Admin.js` returns counts and costs only; no admin access to company routes | `api.test.js` "INF-003…" | |
| INF-004 | Closed rows kept four weeks | Verified | `Worker/Report/retention.js` | `Tests/retention.test.js` | |
| INF-005 | On-demand runs | Not applicable | — | — | Rejected (Sunday only) |
| INF-006 | Profiles hold no personal data | Proposed | — | — | Pending confirmation |
| DEC-005 | 13-week retention | Verified | `cleanup` in `Weekly.js` (daily job) | `weekly.test.js` "DEC-005…" | Run costs are kept for the cost card |
| DEC-011 | Free period on the programme's key, with a monthly AI cap and end-of-period notices | Verified | `0002_ProgrammeKey.sql`, `runClaimed`/`runWeek` in `Worker/Weekly.js`, `/admin/programme-key*` in `API/Admin.js`, `freePeriodFor` in `API/Companies.js`, `weeklyReportEmail`, `src/pages/Admin.tsx` (Free period), `Layout.tsx` banner, `CompanySettings.tsx` | `weekly.test.js` five DEC-011 tests (programme key for all, back to own keys, cap across parallel runs, rejected programme key, email notice); `api.test.js` two DEC-011 tests (key admin-only and never returned or logged; companies see only the end date, cost card counts the cost); browser check on dev data | Not run with a real programme key (none created yet). Second review fixed (below). The spend-limit error wording is unconfirmed; the Anthropic workspace limit stays the backstop |
| DEC-012 | Platform served at opportunities.thedatainnovationhub.com | Verified | `customDomain`, `addCustomDomain`, `bindCustomDomain` and the managed certificate in `Infra/main.bicep`; `ALLOWED_ORIGINS` set for both addresses | `az bicep build` (no warnings); live 26 Oct 2026: `/health` and `/ready` 200, SNI binding with managed certificate (valid to 25 Apr 2027), `APP_URL` set to the domain | |
| DEC-013 | Three region scopes, all including NI | Verified | as BEH-008; `src/pages/CompanySettings.tsx` radio choice | `research.test.js` "DEC-013…"; `api.test.js` "BEH-001…" | Database check `ck_company_profile_regions` allows only the three scopes (`0004_RegionScopes.sql`); `schema.test.js` "DEC-013…" tests both the check and the upgrade |
| DEC-009 | Approved models per provider | Blocked | `approved_model`, `Seeds/approvedModels.js` | `Tests/Db/seed.test.js` | Claude Sonnet 5.5 approved (28/36). OpenAI and Google wait for test keys |

Only use `Verified` when all named verification passes. Keep counts derived from this table.

## Test runs (26 Oct 2026)

| Suite | Result |
|---|---|
| `Backend: npm test` | 31 pass |
| `Backend: npm run test:db` (disposable databases, runtime roles) | 56 pass |
| `scraper: pytest` | 53 pass |
| `npm run typecheck`, `vite build` | pass |
| GitHub Actions `Tests` (`.github/workflows/tests.yml`: all of the above, database tests on Postgres 16) | pass at `2860be3` |
| `az bicep build Infra/main.bicep` | no warnings |
| Browser walkthrough on local dev data | sign-in, report, filters, settings save, admin card, phone width |

## Adversarial review (23 Oct 2026)

An independent reviewer read the schema, API, worker, infrastructure and frontend. It found 14 issues, each with evidence. Every fixed issue has a regression test.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | High | A programme admin could invite themselves into a company and read its data (breaks DEC-003) | Fixed: invitations to programme admins are refused and audited. Test: "INF-003 a programme admin cannot invite themselves" |
| 2 | High | A failure after the model work left a run at `running`, so no retry picked it up | Fixed: one try/catch ends every claimed run; runs left running more than 7 hours are reclaimed. Two `weekly.test.js` tests |
| 3 | High | A bad model value (30 Feb, unknown status, no name) failed the save after billing, and the cost went unrecorded | Fixed: rows are cleaned before saving; usage and cost are recorded before the save. Test: "rows…cleaned, not lost". Follow-up fixed: the finished research is kept (private blob `runs/<company>/<week>.json`) until the report is saved, and a retry reuses it instead of paying the model again. Test: "BEH-003 a failure after the model work…" (no provider call on the retry). If storage itself is down when the research finishes, the retry still pays again |
| 4 | High | A key removed and then re-added failed for 90 days (soft-deleted name) | Fixed: the soft-deleted secret is recovered, then overwritten. `Tests/secret-store.test.js`. Not yet tried against Azure |
| 5 | Medium | Re-inviting an admin demoted them, bypassing the last-admin rule | Fixed: an invitation never changes an existing role. Test in `api.test.js` |
| 6 | Medium | Sign-in response time revealed which addresses have accounts | Fixed: the email is sent after the response |
| 7 | Medium | The API identity could read every company's key | Fixed: custom "key writer" role (set, delete, recover only). Not yet tried against Azure |
| 8 | Medium | Invalid calendar dates caused a 500 | Fixed: dates are round-trip checked; 22007/22008 map to 400. Test in `api.test.js` |
| 9 | Medium | Phase 1 would fail by linking an unverified email domain | Fixed: `linkEmailDomain` flag, set after DNS verification |
| 10 | Low | Malformed JSON bodies were quoted in error logs | Fixed: parser errors log only their type. Test in `api.test.js` |
| 11 | Low | The run-failure log kept the provider's message | Fixed: logs the code and error name only |
| 12 | Low | The Monday email could be sent twice by overlapping jobs | Fixed: each email is claimed before sending. A crash between sending and recording can still resend once |
| 13 | Low | The monthly search cap can be exceeded by up to five runs in progress; failed runs did not record their searches | Fixed: each run reserves its searches against the cap before starting, the tool runner enforces the reservation across the company's regions, and failed runs record the searches and model work they were billed for. Tests: "BEH-013 runs in parallel cannot together pass the monthly search cap", "BEH-013 a failed run still records the searches it made", `research.test.js` shared allowance |
| 14 | Low | Database roles were wider than needed | Fixed: column-level UPDATE, no DELETE on users or companies; still passes every test as those roles |
| — | Low | The xlsx made any `website` value a hyperlink (file:, UNC) | Fixed: only http(s) values become links. Test in `workbook.test.js` |

## Adversarial review of the free period, DEC-011 (23 Oct 2026)

An independent reviewer read the free-period code, grants, migration and tests, and confirmed findings 1 and 2 with a probe test. Every fix has a regression test in `weekly.test.js` ("review finding n") unless stated.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | High | A retry overwrote the failed attempt's cost, so the cap and the cost card under-counted | Fixed: each attempt's searches, tokens and cost are added to the run |
| 2 | Medium | A key replaced mid-run could be marked rejected by the old key's failure, skipping every later run | Fixed: a key is marked only if it is still the one the run used (programme and company keys); otherwise the run fails and is retried |
| 3 | Medium | The cap could be passed by runs costing more than their estimate, or by two weekly jobs at once | Fixed: runs reserve twice the benchmark cost and are stopped before any request once they reach it (overshoot at most one request); a second weekly job does nothing while one holds the job lock; allowances are settled with actual spend |
| 4 | Low | A retry from saved research was re-checked against the current key and period, so it could be skipped or relabelled as company-paid | Fixed: the saved result carries who paid and which model; a retry needs no key |
| 5 | Low | Companies were shown "Covered" while their runs were being skipped | Fixed: `/me` says whether the programme key works and the settings page shows the company's own programme-side skip, with no amounts. Test in `api.test.js` |
| 6 | Low | Clearing "Free until" did not stop a job already running | Fixed: read for each company run; DEPLOYMENT.md wording corrected. No test (timing-dependent) |
| P1 | Plausible | A workspace spend limit may not read as out of credit | Matched "usage limits" too; the real wording is not confirmed (DEPLOYMENT.md step 8) |
| P2 | Plausible | A server-side fallback model was priced as the requested one | Fixed: cost is priced per response by the model that answered; an unpriced model is logged and priced as the default. `anthropic.test.js` |
| P3 | Plausible | A spend check could miss a run that finished at the same moment | Fixed by the in-memory allowances under the job lock |
| P4 | Plausible | Upgrades depended on re-running `database-roles.sql` | Fixed: `0003_ProgrammeKeyGrants.sql` grants the roles when they exist |
| — | Minor | Weekly charts left out AI cost; adapter header comment was stale | Fixed |

Remaining: a retry moves a run's `started_at`, so a run retried across a month boundary counts its cost in the later month.
