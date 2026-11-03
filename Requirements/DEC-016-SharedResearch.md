# DEC-016: shared weekly research (proposed, 3 Nov 2026)

Status: **proposed, for Brendan's decision.** Nothing here is built yet.

Each company's weekly report is researched from scratch today: the AI browses funders' sites for every company separately, so the cost grows in step with the number of companies. This proposal does that browsing once a week for everyone. It builds a shared list of open schemes, then matches each company against the list in one short AI step.

The aim is to cut the AI cost per company by about 85–90% while keeping the report's format, coverage rules and accuracy rules. With the cut, charging the roughly 130 companies across the two groups becomes affordable, and the programme's free-period AI cap (DEC-011) holds.

## How a report is made today

Every Sunday the weekly job:

1. **Gathers once, for everyone** (`gatherWeek` in `Worker/Weekly.js`). It reads 95 funder pages, the UK and NI tender feeds, eTenders (Ireland), Find a Grant, the Innovate UK competitions and the EU Funding & Tenders Portal. All of it is saved to `gathers/<week>.json`. This step uses no AI and costs almost nothing.
2. **Researches each company separately** (`buildCompanyReport` → `runSearch`). There is one AI pass per region the company covers (NI, Ireland, UK; one of them also covers the EU). Each pass:
   - starts from the gathered pages for its region;
   - runs a loop of 10–14 turns, using up to 20 web searches and 30 page reads (40 for NI), to re-check last week's rows, read scheme pages and search for more;
   - submits its rows through `submit_report`.
3. **Picks the Top 5** across regions in one more AI call (`chooseTopFive`). It then works out "New this week", keeps closed rows for a while, and writes the spreadsheet and email.

**Where the money goes:** every turn of step 2 re-sends the whole conversation so far, including every page read, to the AI. With about 36 turns across three regions, one company costs **US$3.58–3.78 a week** (measured on the 2 Nov run, 3 companies, US$11.09 in total) and about 36 Brave searches. Most of those page reads are the same pages for every company: Invest NI's schemes, Innovate UK, Enterprise Ireland and so on. They are read again for each company.

## Proposal

### Why it suits this platform: every company is in healthcare

Every member company, about 100 in the Connected Health Cluster and about 30 in the AI in Healthcare programme, works in the healthcare market: health tech, medtech, digital health, diagnostics, care and wellbeing. That means their reports draw on largely the same funders, so most of today's per-company browsing reads the same pages again and again. One shared pass can therefore cover nearly everything they need.

- **The shared list has a clear scope:** health and life-sciences funding plus the general innovation and business schemes any company can use. Examples of general schemes are Invest NI innovation vouchers and R&D grants, InterTradeIreland, Innovate UK Smart and KTPs, R&D tax relief, British Business Bank and Enterprise Ireland. Schemes for other sectors are left out, which keeps the list short: agriculture, farming and agri-food, fisheries, manufacturing, financial services and fintech, arts, tourism and heritage (Brendan, 3 Nov 2026). Loans and equity open to any company, such as British Business Bank or Invest NI's funds, are not a sector and stay in. A medtech scheme that funds device production also stays in, because it is health funding. Only schemes aimed at the manufacturing sector in general are excluded.
- **The shared pass can go deeper on health funders** than any single company's pass does today: NIHR (including i4i), SBRI Healthcare, the Biomedical Catalyst, HSC R&D and HSC innovation calls, Health Innovation Research Alliance NI, HRB and Enterprise Ireland health tech in Ireland, and IHI, the EIC and Horizon Europe health calls.
- **Tender shortlisting can share health search terms and codes:** medical equipment (CPV 33), health and social services (CPV 85) and health software (CPV 48), alongside each company's own keywords.
- **Stage 3 matters less.** With one market, the shared list catches most niche funders; a per-company search mainly adds sub-sector bodies, for example a diabetes or dementia charity's research fund. The trial shows whether it is needed.
- **Costs are likely at the low end of the ranges below.** A health-focused list is smaller, so each company's matching call reads less, and nearly identical lists get the most from the prompt cache.

### Stage 1: one shared scheme list a week (new)

After the gather, the job runs **one AI pass per region (NI, Ireland, UK, EU), not per company**. Each pass reads the gathered pages, every scheme on the standing checklist, the Innovate UK competitions and the EU calls. It is given a larger allowance (about 60 page reads and 30 searches). It also re-checks every scheme that appeared in **any** company's report last week, so the "re-check last week's rows" rule still holds.

It writes a structured **scheme list** with one record per scheme or call:

- name, funder, region, official URL and source URLs;
- status (Open, Rolling, Opening soon, Closed), opening and closing dates;
- amount and intervention or match-funding rate, exactly as published or "Not stated";
- eligibility: locations, entity types, size, stage, any ROI or EU-establishment requirement;
- sectors and themes, in plain words that matching can use;
- published contact email and phone, or null;
- a one-line summary and any caveats.

It is saved as `catalogues/<week>.json`, next to the gather. The list holds **no company data**. The same accuracy rules as today apply: only what was read on a page this week, figures copied as published, and page text treated as data, not instructions.

### Stage 2: match each company (replaces today's browsing loop)

For each company:

1. **Code filter, no AI.** Keep schemes in the company's regions whose location rules it meets, that are not long closed, and whose sectors or themes overlap its profile. Last week's rows and checklist schemes are always kept. Tender and grant shortlists stay as they are (`shortlistTenders`, `shortlistGrants`, `shortlistEuCalls`).
2. **One AI call, no browsing.** The call gets:
   - the company profile;
   - the filtered schemes, typically 40–80 records;
   - its shortlisted tenders and EU calls;
   - last week's rows.

   It returns the **same `submit_report` rows as today**: why it fits (against the profile's fit points), eligibility notes for this company, next step, tenders it could supply directly, top candidates and `not_included` reasons. The existing code checks that every checklist scheme and competition gets a decision.
3. **Unchanged:** Top 5, "New this week", closed-row retention, the spreadsheet, the email and the portal.

The scheme list is the same for every company in a week. It goes first in the message so the AI provider's prompt cache serves it to each company at a fraction of the price.

### Stage 3 (optional): a small search for each company

Stage 2 alone finds only what the shared list holds. To catch funders specific to one company (an unusual niche or a sector body), each company can get a **small budget: about 5 searches and 5 page reads** on its own funding angles. This is less than a fifth of today's allowance. The trial (below) shows whether it adds rows worth the cost.

## What it costs

Measured costs scaled up, not list prices, at **$1 = £0.75** as in DEC-014. The estimates are ±30% until the trial measures them.

| Per month | Today | Proposed (stages 1+2) | Proposed with stage 3 |
|---|---|---|---|
| Shared scheme list | none | US$22–35 | US$22–35 |
| AI per company | US$15.60–16.40 | US$1.30–2.20 | US$2.40–3.90 |
| Brave per company | US$0.80 | none (about US$2 shared) | about US$0.10 |

| Companies with profiles | Today | Proposed (1+2) | Proposed (1+2+3) |
|---|---|---|---|
| 8 (today) | about US$180 (£135) | about US$80–100 (£60–75) | about US$90–115 (£70–85) |
| 30 (AI in Healthcare) | about US$550 (£410) | about US$110–150 (£80–110) | about US$140–200 (£105–150) |
| 130 (both groups) | about US$2,230 (£1,670) | about US$270–400 (£200–300) | about US$410–600 (£310–450) |

All three columns include the platform's fixed **£33 (US$44) a month** (DEC-014). At 130 companies the proposed cost works out at about **£1.50–2.30 per company per month** (stages 1+2), against about **£13** today.

**Free-period cap (DEC-011, US$100 a month):** today it covers about 6 companies a month. Under the proposal it covers about 30 (stages 1+2).

## What changes in the reports

**The same:** the columns, the regions, Top 5, "New this week", closed rows, the tenders and EU sections, the coverage check, published contacts only, and figures as published.

**Better:**
- Every company sees the same, consistently checked facts for a scheme in a given week.
- A scheme re-checked for one company is re-checked for all.
- Runs finish in minutes, not about 20.

**Risks:**

| Risk | Mitigation |
|---|---|
| A scheme found today only by one company's own searches is missed | The shared pass searches by sector across all companies' sectors; stage 3 adds a small per-company search; the trial measures what is lost |
| Generic "why it fits" text | Stage 2 still writes against the company's own fit points; the trial compares wording |
| A bad shared list affects every company that week | The list is checked by code (required fields, valid URLs on source domains, dates) before use; if the shared pass fails, the job falls back to today's per-company research for that week |
| Eligibility depends on the company (ROI entity, size) | Records carry the eligibility facts; the per-company step applies them, as today's notes do |

## Trial before switching

1. Build stages 1–3 alongside today's code, off by default, behind a setting.
2. Run both on the same week's gather for the companies with profiles. The new path writes to a separate place, so companies still get today's report.
3. Compare, company by company:
   - the rows found by each, and rows only one found, with whether they mattered;
   - Top 5 overlap;
   - figures that differ;
   - cost and run time.
4. Brendan reviews the comparison and decides to switch, keep stage 3 or not, or stay as we are.

The comparison week costs about one extra week of today's AI (about US$30 for 8 companies) and needs Brendan's approval first.

## Work involved

| Part | Files | Effort |
|---|---|---|
| Shared pass and scheme record schema | `Worker/Research/catalogue.js` (new), `Worker/Weekly.js` | 2 days |
| Code filter and matching call | `Worker/CompanyReport.js`, `Worker/Research/search.js` | 2 days |
| Optional per-company search budget | `Worker/Research/tools.js` limits | half a day |
| Side-by-side trial, comparison sheet, fallback, tests | `Worker/trial.js`, Tests | 1–2 days |

About **a week** in all. There is no database change, except an optional setting for which path is on. The portal, email and billing are unchanged.

## Decisions needed from Brendan

1. Go ahead with building it for a side-by-side trial? *(Recommended: yes.)*
2. Include stage 3, the small per-company search, in the trial? *(Recommended: yes, so the trial shows whether it earns its cost.)*
3. Approve about US$30 of AI for the comparison week.
4. After the trial, revisit pricing (DEC-014) with the measured cost. At about £2 per company a month, a £5 a month or £50 a year price, or an annual donation, covers costs with room for non-payers and upkeep.
