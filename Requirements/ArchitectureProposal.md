# Backend Architecture Proposal

## Executive decision

- Recommended approach: a new repository on the same stack as Brendan's other platforms (Vite + React + TypeScript frontend, Node.js ES-module Express API, PostgreSQL with `pg`, Azure hosting). A separate weekly worker gathers candidate opportunities, asks Claude to judge fit for each company and fill the report fields as structured JSON, stores them in PostgreSQL, and renders the Excel report with the sample's exact layout.
- Why: matches the conventions already used in HeartPath Ireland and Parentalk, so the same deployment, test and review habits apply. Storing opportunities as rows, rather than only as spreadsheets, is what makes "New this week", report history and tenant isolation reliable.
- Approval status: Architecture approved by Brendan for the platform build, 23 Oct 2026, after the trials (cold start covers 28 of the sample's 36 rows with rows plus Also checked). Decided: DEC-001…008, DEC-010; INF-001, INF-002 confirmed; INF-005 rejected (no on-demand runs). Pending: DEC-009 (approved models per provider).

## Current state

- Frontend: none yet
- Backend: none yet
- Database: none yet
- Identity: to decide (DEC-001)
- Deployment: Azure, following the HeartPath Ireland / Parentalk pattern (App Service or Container Apps, Azure Database for PostgreSQL Flexible Server, Key Vault, Azure Communication Services email)
- Tests: none yet; the requirement-ID-tagged suite convention from HeartPath Ireland will be reused

## How the weekly run works

1. **Gather (no AI, cheap and repeatable).** For each active company, query the structured tender sources directly: Find a Tender and Contracts Finder via their public OCDS APIs, filtered by the company's CPV codes, keywords and regions. Raw notices are cached once per week and shared across companies, so the same notice is fetched once.
2. **Search (Claude with web search).** One Claude request per company, using the server-side `web_search` and `web_fetch` tools restricted to an allow-list of funding and procurement domains (Invest NI, nibusinessinfo, InterTradeIreland, Innovate UK / IFS / UKRI, NHS and HSC innovation sites, eTendersNI, etenders.gov.ie, PCS Scotland, Sell2Wales…). The request carries the company profile, last week's opportunity list (so Claude can confirm status changes rather than rediscover everything) and the gathered tender notices.
3. **Judge and fill.** Claude returns a structured-output JSON object: funding rows, tender rows, the top 5 with practical steps, and the source URLs, exactly the fields in the sample. The schema is enforced by structured outputs; the worker validates again before storing.
4. **Store.** Opportunities are upserted into a shared `opportunity` table keyed by normalised URL and title. Each company's match is a `company_opportunity` row (its own "why it fits", "next step", status), so "New this week" is a database fact: first seen this week for this company.
5. **Render.** The worker builds the `.xlsx` with ExcelJS: the same sheets, columns, widths, header style, `dd mmm yyyy` dates, live Days-left formula, frozen header, autofilter and conditional formatting as the sample, plus a Tenders sheet. The file is stored in private Azure Blob Storage.
6. **Notify.** Each opted-in user of the company gets one email ("Your report for week of 19 Oct is ready") with a portal link. No attachment and no opportunity details in the email.

Runs are idempotent per (company, ISO week): a retried or re-run job replaces that week's draft, never duplicates it, and emails only once.

## Scraping (decided 22 Oct 2026)

Portals with no usable API (eTendersNI, etenders.gov.ie, and any others the trial shows Claude's `web_fetch` cannot read) are scraped by a **separate deployment of the Screen Clinical guidance-scraper code** (`screen-clinical-main/guidance-scraper`: FastAPI, `scrapling[fetchers]==0.4.14`, Python 3.12-slim, non-root container).

- **Same code, own deployment.** The service is copied into this repository as `scraper/`, with its origin and commit recorded, and deployed as its own Container App (for example `of-dev-scraper`) on internal ingress, with its own `SCRAPER_SHARED_SECRET`. Opportunity Finder never calls `sc-dev-scraper`, so the two products don't share rate limits, failures or release cycles.
- **Same division of responsibility.** The Node backend never scrapes pages itself; it calls `POST /scrape` with a `source_key` and URL. Scrape permission is policy on the Node side: a `tender_source` table records each portal's ingestion method (`api`, `scrapling` or `claude_fetch`) and `allowed_to_scrape`, which is set only after the portal's terms of use have been checked (RSK-003). The scraper is only the mechanism.
- **New workers** are added for the portals that need them (for example `etendersni_search`, `etenders_ie_search`), following the existing per-source worker pattern; unregistered keys fall back to the generic worker.
- **Flow.** On Sunday night, scraped notices join the Find a Tender and Contracts Finder notices in the shared weekly notice cache, go through the same per-company shortlist, and reach Claude as supplied notices, so Claude judges fit rather than re-reading those portals.
- **Open check.** The existing workers use Scrapling's plain HTTP fetcher with no browser. If eTendersNI or etenders.gov.ie need JavaScript rendering or a login to list notices, that needs a decision (a browser fetcher in the image, or an official notification feed) before building those workers.

## Source catalogue and regions (22 Oct 2026)

`Backend/Worker/Sources/catalogue.json` lists 92 official sources from three research passes: Northern Ireland 34, Ireland 25, UK 33. Each records region, kind (funding, tenders, support), sectors, access method, and whether an NI company can apply. Companies pick one of three scopes, each including Northern Ireland: UK and Ireland (default), UK only, or Ireland and Northern Ireland only (BEH-008, DEC-013).

- **One search pass per selected region.** Claude's web tools accept at most 64 allowed domains, and NI + UK together already come to 66. Each region runs as its own Claude pass (NI 33, IE 24, UK 33 domains) and the results are merged and de-duplicated by URL before the Top 5 is chosen. Smaller passes also cut the cost of Claude re-reading its own research.
- **Structured feeds first.** Tender APIs: Find a Tender, Contracts Finder, Public Contracts Scotland, Sell2Wales, TED (Irish above-threshold). RSS: nibusinessinfo, DfE, DAERA, SEUPB, UKRI. These are fetched by the worker, not Claude.
- **Scraper (Scrapling).** etenders.gov.ie (public HTML table) and Find a Grant (query-string HTML) suit the plain fetcher. eTendersNI is JavaScript-driven, and four NI sites return 403 to scripts: DEC-006.
- **Ireland and NI eligibility.** Most ROI schemes need an ROI-registered entity. Rows carry that in Eligibility notes so an NI-only company is not misled.

## Shared funder pages and report trimming (23 Oct 2026)

The cold-start trial with the named-scheme checklist found 31 of the sample's 36 rows but cost US$6.04, mostly Claude fetching the same funder pages itself. Three changes followed:

- **Funder pages gathered once a week.** On Sunday, before the company runs, the scraper's `funder_page` worker fetches every core and sector listing page in the catalogue and each checklist scheme's official page (`Sources/schemes.json`), about 90 pages in a few minutes. Only catalogue domains are fetched (`scraper/workers/funder_domains.json`, generated from the catalogue), over HTTPS with certificates verified against certifi's bundle. Each region's pages go to Claude as the first, prompt-cached block of the message, identical for every company, so after the first company they are cache reads. Pages the plain fetcher cannot read (JavaScript sites such as Techstart, SBRI Healthcare and HSC Innovations, or 403s) are listed for Claude to fetch itself. Claude's limits drop to 20 searches and 30 fetches per region, spent on the company's funding angles and discovery.
- **Closed rows kept four weeks** after the closing date (or after the first week reported Closed, when undated), then dropped (`Report/retention.js`, INF-004).
- **Every named scheme and competition gets a decision (BEH-014).** Innovate UK competitions are read as a structured list (scraper `ifs_competitions` worker), not page text. The report schema has a `not_included` list, and the worker checks that every checklist scheme and supplied competition has either a row or a `not_included` reason, sending the report back up to twice if not. The reasons appear in the report's "Also checked" sheet.
- **Tenders only when the company can supply directly.** Tender rows carry `company_can_supply_directly`; rows where it is false (for example contracts to deliver home-care services) are left off the sheet and counted in the run summary.

## Domain and data model

| Entity | Purpose | Tenant scope |
|---|---|---|
| `company` | A programme company (name, status active/paused) | Is the tenant |
| `company_profile` | Product description, sectors, CPV codes, keywords, regions (NI/GB/ROI), company size, stage, exclusions; versioned so each report records the profile it used | Company |
| `app_user` | A person who signs in (email, name, identity-provider subject) | Global identity |
| `company_membership` | Links a user to a company with role `company_admin` or `company_member` | Company |
| `programme_admin` | Data Innovation Hub staff | Global |
| `search_run` | One weekly run for one company: week, status, provider and model, token usage and model cost estimate (the company's own bill), Brave queries and their cost (the programme's bill), error | Company |
| `opportunity` | A funding call or tender, shared across companies: kind (funding/tender), title, funder/buyer, type, amount, rate, closing date, status, website, email, phone, source URLs | Shared (public information) |
| `company_opportunity` | The match: why it fits, eligibility notes, next step, rank, first-seen run | Company |
| `report` | The generated xlsx for a run: blob path, generated at, row counts | Company |
| `notification` | One row per email sent, for idempotency and audit | Company |
| `company_llm_credential` | Provider (anthropic/openai/google), model (from the approved list), Key Vault secret name, last four characters, status (unchecked/valid/invalid/out of credit), checked at, added by, added at. Never the key itself (SEC-002) | Company |
| `service_cost_daily` | One row per day and source (azure, brave): amount, currency, complete-to date | Global |
| `service_setting` | Search service on or off, price per 1,000 queries, monthly query cap, review date; audit-logged changes | Global |
| `approved_model` | Provider, model id, benchmark recall and cost, approved at; only these can be chosen (DEC-009) | Global |
| `audit_event` | Who added, replaced or removed a key, and when | Company |

Key invariants: every `company_opportunity`, `search_run` and `report` row carries `company_id`, enforced with composite foreign keys so a report can only point at a run of the same company; one report per (company, ISO week); one notification per (report, user).

## Company API keys and providers (BEH-010, BEH-011, SEC-002; 23 Oct 2026)

Each company pays for its own model usage. It picks a provider and model on the company settings page and adds its own API key. The first release supports Anthropic, OpenAI and Google Gemini (DEC-007).

### Model-neutral search

The trial used Claude's built-in web search and fetch. Those tools, their domain controls and their structured-output rules differ between providers, so one built-in set can't serve every company the same way. Instead, the worker owns the tools and the model only decides which to call:

- **`web_search(query)`:** the worker queries the Brave Search API (DEC-008), restricted to the region's catalogue domains, and returns titles, URLs and snippets. The worker caps searches per region (20), as `max_uses` did before. The Brave key is the programme's, held in Key Vault like the company keys.
- **`web_fetch(url)`:** the worker fetches the page through the scraper's `funder_page` worker, which already refuses any host outside the catalogue (HTTPS, certificates verified), and returns the page text, capped per region (30).
- **`submit_report(...)`:** the same strict report schema as now.
- **Same everywhere.** The prompt, shared funder pages, standing checklist, tender shortlist, limits and allow-list are identical for every provider. A provider adapter only translates the tool loop into that provider's API and back.

| Provider | API | Tool calls | Report schema | Free key check |
|---|---|---|---|---|
| Anthropic | Messages API | Client tools | Strict tool (`strict: true`) | List models |
| OpenAI | Responses API | Function tools | Strict function schema | List models |
| Google Gemini | Gemini API | Function declarations | Function schema (converted to Gemini's supported JSON Schema subset) | List models |

- **Prompt caching.** The shared funder-page block comes first in every request. Anthropic needs explicit cache breakpoints. OpenAI and Gemini cache repeated prefixes automatically, within the company's own account.
- **Approved models.** A model is offered only after a benchmark run of the trial profile on it finds at least 28 of the sample's 36 rows. The result and cost per run are recorded (DEC-009). Companies on a weaker model would otherwise get thinner reports without knowing it.
- **Re-measure Claude.** Moving Claude from its built-in tools to ours changes what it sees: search snippets and page text come from our services rather than Anthropic's. The 31-of-36 result must be re-checked with the worker's own tools.

### Keys

- **Saving a key.** A company admin chooses the provider and model and pastes the key. The API checks it with that provider's free list-models call before saving, so a mistyped or revoked key is rejected at once. The key is written to Azure Key Vault as `company-<companyId>-llm`. The database keeps only the provider, model, secret name, last four characters and check status. The request body is never logged, and no API ever returns the key.
- **Who can see what.**
  - Company admins can add, replace or remove the key and change the model, and see the last four characters, status and who added it.
  - Company members see only the provider and model, and whether a key is set.
  - Programme admins see only whether each company has a valid key, in the run summary (DEC-003).
- **Using the key.** Only the worker's managed identity can read the secrets; the API can only set and delete them. On Sunday night the worker reads the company's key, builds that provider's client for the run and drops it afterwards. Keys never appear in logs, run summaries, errors or emails.
- **When the key fails.** An authentication error marks the key invalid. A billing or quota error marks it out of credit. A rate limit retries with backoff. In each case the run is recorded as skipped with the reason, and the company admins get one email asking them to fix it. Other companies' runs go ahead.
- **Cost guidance.** The settings page shows each company its recent run costs, using each provider's list prices, and advises a dedicated project or workspace with a monthly spend limit in the provider's console.
- **What the programme still pays for.** Azure hosting, the database, the scraper, the Sunday gather of tenders and funder pages, and Brave search.

### Service cost and review (DEC-008, BEH-012, BEH-013)

- **Metering.** Every Brave query a run makes is counted on its `search_run` row (`search_queries`, `search_cost_usd` = queries × the configured price per 1,000). Nothing about the company's profile goes into this count.
- **Azure hosting cost.** All Opportunity Finder resources live in their own resource groups (one per environment) and are tagged `app=opportunity-finder`. Once a day the worker calls the Azure Cost Management Query API for those groups, using its managed identity with the Cost Management Reader role on them, and stores one row per day and service in `service_cost_daily` (date, source `azure` or `brave`, amount, currency). Azure cost data arrives 8–24 hours late, so the card shows the date the figures are complete to.
- **KPI card.** The programme admin dashboard shows a "Service cost" card with:
  - this week's and total-to-date cost for Brave search and for Azure hosting, each shown separately and added together;
  - Brave queries this week and the average cost per company per week;
  - the review date (25 Jan 2027).

  It is served by `GET /admin/service-cost`. The Brave figures are labelled as estimates and checked against Brave's invoice each month. Azure figures are what Cost Management reports, in the subscription's billing currency.
- **Controls.** A `service_setting` row holds: on or off, price per 1,000 queries, monthly query cap, and review date. Admins change these on the admin settings page; each change is audit-logged.
  - **Off:** the `web_search` tool is left out of the request. Runs then use the shared funder pages, page reads and supplied notices, and each report notes that search was off.
  - **Cap reached:** searches stop for the rest of the month, and run summaries say so.
- **Review.** On 25 Jan 2027 (in Brendan's Outlook calendar) the programme reviews the three months of Brave and Azure cost against the reports' value. Options are to keep it, lower the cap or per-region search limit, move search to each company's own provider search, or stop it.


## Identity and authorization

- Identity provider/session model: per DEC-001. The recommendation is **email magic link** for the first release: programme companies are invited, they sign in with a one-time link, and we store no passwords. Moving to Entra External ID later is possible because accounts are keyed by an identity-provider subject.
- Roles: `programme_admin` (manage companies, invite users, see run status and cost; report access per DEC-003), `company_admin` (edit profile, invite colleagues, view and download), `company_member` (view and download).
- Tenant isolation: every company-scoped query includes `company_id` from the caller's membership in the `WHERE` clause; IDs in URLs are never trusted on their own. A row outside the caller's company returns 404, not 403. Downloads go through the API (membership check, then a short-lived SAS URL), never a public blob link.
- The worker runs with its own database role. It can write runs, opportunities and reports, but has no access to sessions or sign-in tokens.

## API contract (summary)

| Method and path | Who | Purpose |
|---|---|---|
| `POST /auth/request-link`, `POST /auth/verify` | Public, rate-limited | Magic-link sign-in (DEC-001) |
| `GET /me` | Signed in | Current user, memberships |
| `GET/PUT /companies/:companyId/profile` | Company admin (PUT), members (GET) | Read or edit the profile; PUT creates a new profile version |
| `GET /companies/:companyId/reports` | Members | Report history, paginated, newest first |
| `GET /companies/:companyId/reports/:reportId` | Members | Report summary: counts, top 5, new this week |
| `GET /companies/:companyId/reports/:reportId/download` | Members | Short-lived link to the xlsx |
| `GET /companies/:companyId/opportunities?week=&kind=&status=` | Members | The rows behind a report, for on-screen viewing and filtering |
| `GET /companies/:companyId/llm-credential` | Members (status only); company admin (also last four, added by, checked at) | Whether a key is set and working; never the key |
| `GET /admin/service-cost` | Programme admin | KPI card: this week's and total cost for Brave and Azure, separately and combined; Brave queries and average per company; review date |
| `GET/PUT /admin/service-settings` | Programme admin | Turn search on or off, set the price and monthly cap |
| `GET /models` | Signed in | Approved providers and models, with benchmark recall and typical cost per run |
| `PUT /companies/:companyId/llm-credential` | Company admin | Choose provider and model, check the key with that provider's free call, then save it to Key Vault; replaces any existing key |
| `DELETE /companies/:companyId/llm-credential` | Company admin | Remove the key; weekly runs stop until a new one is added |
| `POST /admin/companies`, `POST /admin/companies/:id/invitations` | Programme admin | Onboard companies and users |
| `GET /admin/runs` | Programme admin | Run status, failures, token and search usage, cost |

Errors use one envelope, `{error: {code, message}}`, with stable codes. Database errors are never passed to the client.

## Proposed structure

```
opportunity-finder/
  src/                    React + TypeScript frontend (Vite), served by the API in Azure
  Dockerfile              one image: API + built frontend + jobs
  Backend/
    API/                  Express routes (Auth, Companies, Admin), middleware, validation
    Database/             Migrations/, Migrate.js (`npm run migrate`), Seeds/
    Services/             Key Vault, Blob Storage, email (ACS), each with a local stand-in
    Worker/               Job.js (weekly, emails, cleanup, azure-cost), Weekly.js, CompanyReport.js
      Sources/            tender APIs, scraper client, Brave, funder pages, catalogue and checklist data
      Research/           prompt, report schema, provider-neutral loop and tools
      Providers/          one adapter per model provider (Anthropic first)
      Report/             ExcelJS workbook builder (sample layout), retention
    Tests/                unit tests; Db/ integration tests on disposable databases
  scraper/                copy of the guidance-scraper service (Python, Scrapling), own Container App
  Infra/                  main.bicep, grant-roles.sh, database-roles.sql, DEPLOYMENT.md
  Requirements/
```

## Alternatives and trade-offs

| Decision | Recommended | Alternatives | Consequences |
|---|---|---|---|
| Finding opportunities | Structured APIs for Find a Tender and Contracts Finder, plus Claude web search over an allow-list for everything else | Claude web search only | Web search only is simpler, but tender coverage is less complete and less repeatable, and every company pays to rediscover the same notices |
| Claude surface | One Messages API request per company with server-side `web_search` / `web_fetch` and structured output | Managed Agents scheduled deployment; Message Batches | Plain requests are the least code, are easy to retry per company and keep the schedule in Azure alongside everything else. Batches would halve token cost; whether they support web search needs checking before relying on it |
| Model | Company's choice from approved models per provider (DEC-007, DEC-009); `claude-sonnet-5-5` is the reference model | Single programme-chosen model | Companies pay, so they choose; the benchmark keeps quality comparable |
| Web tools | Worker-owned `web_search` (search service) and `web_fetch` (scraper), same for every provider | Each provider's built-in search | Identical allow-list, limits and behaviour for every company; one place to enforce domain rules |
| Report storage | Opportunities as rows, xlsx rendered from rows and stored in Blob | Store only the xlsx | Rows make "New this week", on-screen filtering, history and tenant isolation testable |
| Excel library | ExcelJS | SheetJS community edition | ExcelJS writes conditional formatting, formulas, number formats and frozen panes, which the sample uses |
| Scraping | Separate deployment of the guidance-scraper code (Scrapling) for portals without an API | Claude `web_fetch` only; reuse `sc-dev-scraper` | Decided by Brendan 22 Oct 2026: same code, deployed separately |
| Scheduling | Container Apps scheduled job (cron, Sunday 22:00 UK), running companies five at a time; Monday 07:00 email job | Azure Functions timer | A company run takes about 15 minutes, beyond a Functions timer's time limit; 50 companies five at a time finish in about 2.5 hours |
| Sign-in | Magic link | Entra External ID; email + password | See DEC-001 |

## Risks and unresolved decisions

| ID | Risk/decision | Impact | Required action |
|---|---|---|---|
| RSK-001 | Claude may report a wrong closing date, amount or eligibility detail | A company misses a deadline or applies for something it can't get | Every row keeps its source URL; the report says figures must be checked at source; dates taken from structured tender APIs override model-supplied dates |
| RSK-002 | Each company's Claude cost grows with searches and pages read | Companies' own bills; companies may remove their key | Per-run token and search caps (`max_uses`); usage and estimated cost recorded per run and shown to the company; companies advised to set an Anthropic workspace spend limit |
| RSK-005 | A company's key leaks from our system | The company is billed for someone else's usage | Key Vault only, write-only API, worker-only read via managed identity, no logging of request bodies, audit log, last-four display; the company can revoke the key in the Anthropic Console at any time |
| RSK-003 | Portal terms of use for automated access (eTendersNI, etenders.gov.ie) | Access could be blocked, or breach terms | Use official APIs or notification feeds where they exist; check terms before automating |
| RSK-004 | Prompt injection from a fetched web page | Wrong rows or misleading text in a report | Web tools restricted to the allow-list; output schema-constrained; text fields length-limited and rendered as plain text, never HTML |
| DEC-009 | Approved models per provider | Which models companies can choose | Benchmark each provider's models on the trial profile when test keys are available |

## Implementation and verification plan

1. **Gate 1 (now):** approve this architecture and answer DEC-001…005.
2. **Proof of value, before the platform:** one standalone script that takes the sample company's profile, runs gather → Claude → xlsx, and produces a report for comparison with `Care_Software_Funding_2026-10-21.xlsx`. It measures real cost per run (ASM-002). Brendan reviews the output quality before the multi-tenant build starts.
3. **Stage 2:** schema, migrations and API contract (MigrationPlan.md); clean-install migration test.
4. **Stage 3:** API with tenant scoping, worker, report builder, email, frontend (profile editor, report list, report view, download, admin pages).
5. **Stage 4:** adversarial review: cross-tenant access, retries, partial run failure, prompt injection, cost runaway.
6. **Stage 5:** requirement-tagged tests (tenant isolation, report-format conformance against the sample, New-this-week logic, idempotent re-runs, email-once) and the Requirements Dashboard.
7. **Deploy to an Azure test environment**, with Brendan's approval at each remote step.
