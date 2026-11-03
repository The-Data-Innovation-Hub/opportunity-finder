// DEC-016: the shared scheme list, matching from it, and the trial's comparison.
import test from 'node:test'
import assert from 'node:assert/strict'
import {buildSharedCatalogue, checkRecords, missingFromCatalogue, catalogueRegionOf, CATALOGUE_REGIONS, SUBMIT_SCHEMES} from '../Worker/Research/catalogue.js'
import {matchRegion, schemesForRegion, STAGE3_LIMITS} from '../Worker/Research/match.js'
import {buildCompanyReport} from '../Worker/CompanyReport.js'
import {compareReports} from '../Worker/SharedTrial.js'
import {allSchemesFor} from '../Worker/Research/search.js'

const scheme = (name, extra = {}) => ({name, funder: 'Invest NI', source_group: 'Invest NI', type: 'grant', status: 'Open', opens: null,
	closing_date: '2026-12-01', amount: 'Up to £50k', match_funding: '50%', locations: 'NI-based SMEs', eligibility: 'SMEs.', sectors: ['any sector'],
	summary: 'R&D.', caveats: null, website: `https://www.investni.com/${name.replace(/\W+/g, '-').toLowerCase()}`, email: null, phone: null, source_urls: [], ...extra})

// A scripted conversation answering the final tool with answer(tools, sent),
// recording what each call was given.
const scripted = (answer) => {
	const calls = []
	return {calls, provider: {name: 'anthropic', model: 'm', estimateCost: () => 0.25,
		start: ({system, content, tools}) => {
			const call = {system, text: content.map((b) => b.text).join('\n'), tools: tools.map((t) => t.name), sends: 0}
			calls.push(call)
			return {usage: {input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0},
				send: async () => { call.sends++; return {stopReason: 'tool_use', calls: [{id: `x${call.sends}`, ...answer(call)}]} },
				addResults: () => {}, nudge: () => {}}
		}}}
}

test('DEC-016 records failing the code checks are dropped, bad dates become null', () => {
	const {kept, dropped} = checkRecords([
		scheme('Good', {closing_date: '2026-02-30x', opens: '2026-11-01', source_urls: ['https://www.investni.com/a', 'https://evil.example/b']}),
		scheme('Off domain', {website: 'https://evil.example/x'}),
		scheme('Plain http', {website: 'http://www.investni.com/x'}),
		scheme('', {}),
		scheme('Bad status', {status: 'Maybe'}),
	], 'NI')
	assert.deepEqual(kept.map((k) => k.name), ['Good'])
	assert.equal(kept[0].closing_date, null)
	assert.equal(kept[0].opens, '2026-11-01')
	assert.equal(kept[0].region, 'NI')
	assert.deepEqual(kept[0].source_urls, ['https://www.investni.com/a'])
	assert.deepEqual(dropped, ['Off domain', 'Plain http', '(unnamed)', 'Bad status'])
})

test('DEC-016 EU rows from a company\'s UK or Ireland pass belong to the EU list', () => {
	assert.equal(catalogueRegionOf({region: 'UK', source_group: 'EU'}), 'EU')
	assert.equal(catalogueRegionOf({region: 'IE', source_group: 'Ireland'}), 'IE')
})

test('DEC-016 every checklist scheme and last week\'s scheme needs a record or a reason', () => {
	const expected = [
		{name: 'Innovation Vouchers', kind: 'checklist scheme'},
		{name: 'Old Fund', website: 'https://www.investni.com/old-fund/', kind: 'scheme from last week'},
		{name: 'Gone Scheme', kind: 'scheme from last week'},
	]
	const result = {schemes: [scheme('Innovation Vouchers'), scheme('Renamed Fund', {website: 'https://investni.com/old-fund'})], not_included: []}
	assert.deepEqual(missingFromCatalogue(result, expected).map((m) => m.name), ['Gone Scheme'])
	assert.deepEqual(missingFromCatalogue({...result, not_included: [{name: 'Gone Scheme', reason: 'Closed for good'}]}, expected), [])
})

test('DEC-016 the shared list runs one pass per region on the programme provider, health-scoped, and re-checks last week\'s rows', async () => {
	const {calls, provider} = scripted((call) => {
		const region = {Northern: 'NI', Ireland: 'IE', United: 'UK', EU: 'EU'}[call.text.match(/Your region: (\w+)/)[1]]
		const names = allSchemesFor(region).map((s) => s.scheme)
		const all = call.text.includes('Last Year Fund') ? [...names, 'Last Year Fund'] : names
		return {name: SUBMIT_SCHEMES.name, input: {schemes: region == 'NI' ? [scheme('New Health Call')] : [], not_included: all.map((name) => ({name, reason: 'n/a'})), notes: ''}}
	})
	const catalogue = await buildSharedCatalogue({today: '2026-11-03', funderPages: {pages: []}, provider, searchEnabled: false,
		previousRows: [{name: 'Last Year Fund', region: 'NI', website: 'https://www.investni.com/lyf'}, {name: 'Last Year Fund', region: 'NI', website: 'https://www.investni.com/lyf'}]})
	assert.equal(calls.length, CATALOGUE_REGIONS.length)
	assert.ok(calls.every((c) => c.sends == 1), 'every pass was accepted first time')
	assert.ok(calls.every((c) => !c.tools.includes('web_search')), 'search was off')
	assert.match(calls[0].system, /agriculture, farming and agri-food, fisheries, manufacturing, financial services and fintech/)
	assert.equal(calls[0].text.match(/Last Year Fund/g).length, 1, 'last week\'s rows are de-duplicated')
	assert.deepEqual(catalogue.schemes.map((s) => [s.name, s.region]), [['New Health Call', 'NI']])
	assert.equal(catalogue.cost, 1)
})

test('DEC-016 the code filter keeps the region (and EU on the host pass) and drops long-closed schemes', () => {
	const schemes = [{name: 'a', region: 'NI', status: 'Open'}, {name: 'b', region: 'EU', status: 'Open'}, {name: 'c', region: 'UK', status: 'Open'},
		{name: 'd', region: 'NI', status: 'Closed', closing_date: '2026-09-01'}, {name: 'e', region: 'NI', status: 'Closed', closing_date: '2026-10-20'}]
	assert.deepEqual(schemesForRegion(schemes, {region: 'NI', today: '2026-11-03'}).map((s) => s.name), ['a', 'e'])
	assert.deepEqual(schemesForRegion(schemes, {region: 'UK', eu: true, today: '2026-11-03'}).map((s) => s.name), ['b', 'c'])
})

const row = (fund) => ({fund, funder: 'Invest NI', source_group: 'Invest NI', type: 'grant', amount: null, match_funding: 'Not stated', closing_date: null,
	status: 'Rolling', why_it_fits: 'Fits.', eligibility_notes: '', website: `https://www.investni.com/${fund}`, email: null, phone: null, next_step: 'Apply.', source_urls: []})
const gather = {ukNotices: [], ieNotices: [], grants: [], funderPages: {pages: [], competitions: [], euCalls: []}}
const profile = {company_name: 'Care Co', regions: ['NI', 'IE'], sectors: ['health'], product_description: 'Care software.', tender_keywords: ['care'], cpv_prefixes: []}
const answerReport = (call) => call.tools.includes('select_top_five')
	? {name: 'select_top_five', input: {top_five: []}}
	: {name: 'submit_report', input: {funding: [row(call.text.includes('Northern Ireland.') ? 'ni-grant' : 'ie-grant')], tenders: [], top_five: [],
		not_included: [...call.text.matchAll(/^- (.+?) \((?:[^()]|\([^()]*\))*\)$/gm)].map((m) => ({name: m[1], reason: 'n/a'})), notes: ''}}

test('DEC-016 matching: one call per region from the shared list with no web access, same report shape', async () => {
	const {calls, provider} = scripted(answerReport)
	const catalogue = {schemes: [{...scheme('Shared Scheme'), region: 'NI'}]}
	const result = await buildCompanyReport({profile, today: '2026-11-03', gather, provider, researchRegion: matchRegion({catalogue})})
	const matches = calls.filter((c) => c.tools.includes('submit_report'))
	assert.equal(matches.length, 2)
	assert.ok(matches.every((c) => c.tools.length == 1), 'no web tools without stage 3')
	assert.match(matches[0].text, /Shared Scheme/)
	assert.doesNotMatch(matches[1].text, /Shared Scheme/, 'the Ireland pass gets only Ireland\'s records')
	assert.deepEqual(result.funding.map((f) => [f.fund, f.region]), [['ni-grant', 'NI'], ['ie-grant', 'IE']])
	assert.deepEqual([result.searches, result.fetches], [0, 0])
})

test('DEC-016 stage 3: matching gets the small search and page-read allowance', async () => {
	const {calls, provider} = scripted(answerReport)
	await buildCompanyReport({profile, today: '2026-11-03', gather, provider, researchRegion: matchRegion({catalogue: {schemes: []}, stage3: true})})
	const match = calls.find((c) => c.tools.includes('submit_report'))
	assert.deepEqual(match.tools, ['web_search', 'web_fetch', 'submit_report'])
	assert.match(match.text, new RegExp(`Allowance: ${STAGE3_LIMITS.searches} searches and ${STAGE3_LIMITS.fetches} page reads`))
})

test('DEC-016 comparison: rows matched by page or name, figures compared, Top 5 overlap counted', () => {
	const current = {
		rows: [
			{kind: 'funding', name: 'Smart Grant', website: 'https://www.ukri.org/smart', row: {status: 'Open', closing_date: '2026-12-01', amount: 'Up to £500k'}},
			{kind: 'funding', name: 'Old Voucher', website: 'https://www.investni.com/v', row: {status: 'Rolling', closing_date: null, amount: '£5k'}},
			{kind: 'tender', name: 'Care app', website: 'https://ft.example/1', row: {status: 'Open', closing_date: '2026-11-20', value: '£1m'}},
		],
		topFive: [{name: 'Smart Grant (Innovate UK)'}, {name: 'Care app (HSC)'}],
	}
	const proposed = {
		funding: [{fund: 'Innovate UK Smart Grant', website: 'https://ukri.org/smart', status: 'Open', closing_date: '2026-12-08', amount: 'Up to £500k'},
			{fund: 'New Fund', website: 'https://www.investni.com/n', status: 'Open', closing_date: null, amount: null}],
		tenders: [{title: 'Care app', website: 'https://ft.example/1', status: 'Open', closing_date: '2026-11-20', value: '£1m'}],
		topFive: [{name: 'Smart Grant (Innovate UK)'}, {name: 'New Fund (Invest NI)'}],
	}
	const {rows, counts} = compareReports({current, proposed})
	assert.deepEqual(counts, {current: 3, proposed: 3, both: 2, only_current: 1, only_proposed: 1, figures_differ: 1, top_five_overlap: 1})
	assert.deepEqual(rows.find((r) => r.name == 'Smart Grant').differences, ['closing_date'])
})
