// Trial run for one company: gather tenders and grants, run one Claude pass
// per selected region (BEH-008), choose the Top 5 across regions, mark "New
// this week" against last week's report, write the xlsx and a run summary.
//
//   node Worker/trial.js --profile Worker/Profiles/trial-care-routing.json \
//     [--previous Tests/fixtures/sample-report.json] [--tenders-cache Output/tenders.json] \
//     [--pages-cache Output/funder-pages.json]
//
// Needs the scraper service on SCRAPER_URL (default http://localhost:8080) for
// Ireland and UK grants. Calls the Claude API, which costs money: run only when approved.
import fs from 'node:fs'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {fetchTenderNotices} from './Sources/ocds.js'
import {fetchEtendersIreland, fetchFindAGrant} from './Sources/scraper.js'
import {gatherFunderPages} from './Sources/pages.js'
import {scopeRegions} from './Research/search.js'
import {buildCompanyReport, previousRowsFromSample} from './CompanyReport.js'
import {buildWorkbook} from './Report/workbook.js'
import {createProvider} from './Providers/anthropic.js'
import {PRICE_PER_QUERY} from './Sources/brave.js'

const {values: args} = parseArgs({options: {
	profile: {type: 'string'},
	previous: {type: 'string'},
	'tenders-cache': {type: 'string'},
	'pages-cache': {type: 'string'},
	out: {type: 'string', default: 'Output'},
}})
if (!args.profile) throw new Error('--profile is required')

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)
const profile = JSON.parse(fs.readFileSync(args.profile, 'utf8'))
const regions = scopeRegions(profile.regions ?? [])
const now = new Date()
const today = now.toISOString().slice(0, 10)
const weekAgo = new Date(now.getTime() - 7 * 864e5)
fs.mkdirSync(args.out, {recursive: true})

// --- Gather (no Claude)
let ukNotices = []
if (regions.includes('NI') || regions.includes('UK')) {
	if (args['tenders-cache'] && fs.existsSync(args['tenders-cache'])) {
		ukNotices = JSON.parse(fs.readFileSync(args['tenders-cache'], 'utf8'))
		log(`${ukNotices.length} Find a Tender / Contracts Finder notices from cache`)
	} else {
		ukNotices = await fetchTenderNotices({from: weekAgo.toISOString().slice(0, 19), to: now.toISOString().slice(0, 19), log})
		if (args['tenders-cache']) fs.writeFileSync(args['tenders-cache'], JSON.stringify(ukNotices))
	}
}
const isNI = (n) => n.regions.some((r) => r.startsWith('UKN'))
const ieNotices = regions.includes('IE') ? await fetchEtendersIreland({since: weekAgo.toISOString().slice(0, 10)}) : []
const grants = regions.includes('UK') ? await fetchFindAGrant() : []
log(`${ieNotices.length} eTenders (Ireland) notices, ${grants.length} Find a Grant listings`)

// Funder pages are shared by every company; in production they are gathered
// once on Sunday before the company runs start.
let funderPages
if (args['pages-cache'] && fs.existsSync(args['pages-cache'])) {
	funderPages = JSON.parse(fs.readFileSync(args['pages-cache'], 'utf8'))
	log(`${funderPages.pages.length} funder pages from cache (${funderPages.fetched_on})`)
} else {
	funderPages = await gatherFunderPages({regions, log})
	if (args['pages-cache']) fs.writeFileSync(args['pages-cache'], JSON.stringify(funderPages))
}

// --- Last week's rows, then one research pass per region. In production the
// provider, model and key are the company's own, the key read from Key Vault
// (BEH-010); the trial uses Claude with the key from the environment.
const previousRows = args.previous ? previousRowsFromSample(JSON.parse(fs.readFileSync(args.previous, 'utf8'))) : []
const provider = createProvider({apiKey: process.env.ANTHROPIC_API_KEY})
const started = Date.now()
const result = await buildCompanyReport({profile, today, now, gather: {ukNotices, ieNotices, grants, funderPages}, previousRows, provider, log})
const {funding, tenders, topFive, notIncluded, sources, note} = result
const workbook = buildWorkbook({preparedOn: today, funding, tenders, topFive, sources, note, notIncluded})

const base = path.join(args.out, `${profile.company_name.replace(/[^A-Za-z0-9]+/g, '_')}_${today}`)
await workbook.xlsx.writeFile(`${base}.xlsx`)
fs.writeFileSync(`${base}.json`, JSON.stringify({preparedOn: today, funding, tenders, topFive, sources, note, notIncluded}, null, 1))

// The run summary is all programme admins see (DEC-003). Model cost is the
// company's own bill; search cost is the programme's (BEH-012).
const {passes, modelCost, searches} = result
const summary = {
	company: profile.company_name, week_of: today, regions, status: 'succeeded', provider: provider.name, model: provider.model,
	funding_rows: funding.length, tender_rows: tenders.length,
	new_this_week: [...funding, ...tenders].filter((r) => r.new_this_week).length,
	passes, model_cost_usd: Number(modelCost.toFixed(2)),
	search_queries: searches, search_cost_usd: Number((searches * PRICE_PER_QUERY).toFixed(3)),
	duration_seconds: Math.round((Date.now() - started) / 1000),
}
fs.writeFileSync(`${base}.summary.json`, JSON.stringify(summary, null, 1))
log(`wrote ${base}.xlsx`)
console.log(JSON.stringify(summary, null, 1))
