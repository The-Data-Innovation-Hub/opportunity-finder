import test from 'node:test'
import assert from 'node:assert/strict'
import {toCall, amountOf, plainText, shortlistEuCalls, readEuTopic} from '../Worker/Sources/eu.js'
import {buildUserMessage, missingDecisions, schemesFor, euHost} from '../Worker/Research/search.js'
import {gatherFunderPages} from '../Worker/Sources/pages.js'

const TODAY = '2026-10-27'
const result = (metadata, url = `https://ec.europa.eu/topic-details/${metadata.identifier}`) => ({url,
	metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]))})

const call = (overrides) => ({identifier: 'HORIZON-HLTH-2027-01-CARE-01', programme: 'Horizon Europe', uk_eligible: true, cascade: false,
	title: 'Digital tools for integrated home care', call: 'Health', status: 'Open', opens: '2026-09-01', closes: '2027-02-17',
	deadline_model: 'single-stage', action: 'HORIZON Innovation Actions', url: 'https://ec.europa.eu/topic-details/HORIZON-HLTH-2027-01-CARE-01',
	summary: 'Scheduling and route planning for community care.', amount: 'EUR 3m to 5m per project', ...overrides})

test('DAT-005 portal results become calls; topics past their last deadline and unknown programmes are left out', () => {
	const open = toCall(result({identifier: 'HORIZON-CL4-2027-04-DATA-09', type: '1', status: '31094502', title: 'AI in data centres', callTitle: 'Digital',
		deadlineDate: ['2026-03-01T17:00:00.000+0000', '2027-03-18T17:00:00.000+0000'], startDate: '2026-09-01T00:00:00.000+0000', description: '<p>Energy &amp; AI</p>'}), TODAY)
	assert.equal(open.closes, '2027-03-18')
	assert.equal(open.status, 'Open')
	assert.equal(open.programme, 'Horizon Europe')
	assert.equal(open.uk_eligible, true)
	assert.equal(open.summary, 'Energy & AI')
	assert.equal(toCall(result({identifier: 'HORIZON-EIC-2023-PATHFINDERCHALLENGES-01-01', type: '1', status: '31094501', title: 'Old', deadlineDate: '2023-10-18T17:00:00.000+0000'}), TODAY), null)
	assert.equal(toCall(result({identifier: 'EuropeAid/187686/ID/ACT/MK', type: '1', status: '31094502', title: 'Aid', deadlineDate: '2027-01-01T00:00:00.000+0000'}), TODAY), null)
	assert.equal(toCall(result({identifier: 'DIGITAL-2026-AI-01', type: '1', status: '31094501', title: 'Forthcoming'}), TODAY).status, 'Opening soon')
	assert.equal(toCall(result({identifier: 'DIGITAL-2026-AI-01', type: '1', status: '31094501', title: 'x'}), TODAY).uk_eligible, false)
})

test('DAT-005 a cascade call is named by its own call title, not the EU topic that funds it', () => {
	const cascade = toCall(result({identifier: 'HORIZON-EIC-2025-WOMENTECH', type: '8', status: '31094502', title: 'Women Tech.EU initiative', callTitle: 'Women TechEU Open Call ',
		deadlineDate: '2027-01-14T17:00:00.000+0000'}, 'https://ec.europa.eu/competitive-calls-cs/48106227'), TODAY)
	assert.equal(cascade.title, 'Women TechEU Open Call')
	assert.equal(cascade.call, 'Women Tech.EU initiative')
	assert.equal(cascade.cascade, true)
})

test('DAT-005 the per-project amount comes from the topic budget table', () => {
	const budget = {budgetTopicActionMap: {1: [
		{action: 'HORIZON-CL5-2027-07-D3-32 - HORIZON-IA HORIZON Innovation Actions', minContribution: 8500000, maxContribution: 10000000},
		{action: 'HORIZON-CL5-2027-07-D3-11 - HORIZON-IA', minContribution: 1, maxContribution: 2},
	]}}
	assert.equal(amountOf(budget, 'HORIZON-CL5-2027-07-D3-32'), 'EUR 8.5m to 10m per project')
	assert.equal(amountOf({budgetTopicActionMap: {1: [{action: 'X-1 - grant', minContribution: 2e6, maxContribution: 2e6}]}}, 'X-1'), 'EUR 2m per project')
	assert.equal(amountOf(undefined, 'X-1'), null)
	assert.equal(amountOf({budgetTopicActionMap: {1: [{action: 'X-1 - grant', minContribution: 0, maxContribution: 0}]}}, 'X-1'), null)
	assert.equal(plainText('<p>A&nbsp;&lt;b&gt;</p>'), 'A <b>')
})

test('DAT-005 the shortlist matches the profile, always offers the EIC Accelerator, and drops EU-only calls without Ireland in scope', () => {
	const profile = {sectors: ['health and social care'], tender_keywords: ['home care', 'scheduling']}
	const calls = [
		call(),
		call({identifier: 'HORIZON-EIC-2026-ACCELERATOR-01', title: 'EIC Accelerator 2026 - Short proposal', summary: 'Any field.'}),
		call({identifier: 'HORIZON-CL6-2027-01-SOIL-01', title: 'Soil carbon', summary: 'Farming.'}),
		call({identifier: 'DIGITAL-2026-CARE-01', programme: 'Digital Europe', uk_eligible: false, title: 'Home care scheduling platforms'}),
	]
	assert.deepEqual(shortlistEuCalls(calls, profile, {regions: ['NI', 'IE', 'UK']}).map((c) => c.identifier),
		['HORIZON-EIC-2026-ACCELERATOR-01', 'HORIZON-HLTH-2027-01-CARE-01', 'DIGITAL-2026-CARE-01'])
	assert.deepEqual(shortlistEuCalls(calls, profile, {regions: ['NI', 'UK']}).map((c) => c.identifier),
		['HORIZON-EIC-2026-ACCELERATOR-01', 'HORIZON-HLTH-2027-01-CARE-01'])
})

test('DAT-005 the EU programmes ride on the UK pass, or Ireland\'s for the all-island scope', () => {
	assert.equal(euHost(['NI', 'IE', 'UK']), 'UK')
	assert.equal(euHost(['NI', 'UK']), 'UK')
	assert.equal(euHost(['NI', 'IE']), 'IE')
	assert.ok(schemesFor('UK', {}, {eu: true}).some((s) => s.scheme == 'EIC Accelerator'))
	assert.ok(!schemesFor('UK', {}).some((s) => s.region == 'EU'))
})

test('DAT-005 the carrying pass gets the EU pages, domains, full call list and shortlist; other passes get none of it', () => {
	const funderPages = {fetched_on: TODAY, competitions: [], euCalls: [call(), call({identifier: 'HORIZON-CL6-2027-01-SOIL-01', title: 'Soil carbon'})], pages: [
		{region: 'EU', kind: 'listing', organisation: 'EIC', url: 'https://eic.ec.europa.eu/eic-funding-opportunities_en', ok: true, text: 'EIC listing text', links: []},
		{region: 'IE', kind: 'listing', organisation: 'Enterprise Ireland', url: 'https://www.enterprise-ireland.com/a', ok: true, text: 'EI text', links: []},
	]}
	const args = {profile: {company_name: 'x'}, today: TODAY, region: 'IE', tenders: [], previous: [], funderPages}
	const [shared, company] = buildUserMessage({...args, euCalls: [call()]})
	assert.ok(shared.text.includes('EIC listing text') && shared.text.includes('EI text'))
	assert.ok(shared.text.includes('ec.europa.eu') && shared.text.includes('eic.ec.europa.eu'))
	assert.ok(shared.text.includes('HORIZON-CL6-2027-01-SOIL-01 | Soil carbon | closes 2027-02-17'))
	assert.ok(company.text.includes('EU calls shortlisted for this company (1)') && company.text.includes('EUR 3m to 5m per project'))
	assert.ok(company.text.includes('EIC Accelerator (European Innovation Council'))
	const [otherShared, otherCompany] = buildUserMessage(args)
	assert.ok(!otherShared.text.includes('EIC listing text') && !otherShared.text.includes('Soil carbon') && !otherShared.text.includes('eic.ec.europa.eu'))
	assert.ok(!otherCompany.text.includes('EU calls shortlisted') && !otherCompany.text.includes('EIC Accelerator'))
})

test('DAT-005 every shortlisted EU call needs a row or a not_included reason, matched on its identifier', () => {
	const expected = [
		{name: 'Digital tools for integrated home care', id: 'HORIZON-HLTH-2027-01-CARE-01', kind: 'EU call'},
		{name: 'Virtual Human Twins for clinical decision support', id: 'HORIZON-HLTH-2027-03-TOOL-04', kind: 'EU call'},
		{name: 'Soil carbon', id: 'HORIZON-CL6-2027-01-SOIL-01', kind: 'EU call'},
	]
	const report = {
		funding: [{fund: 'Horizon Europe: integrated care tools', funder: 'European Commission', website: 'https://ec.europa.eu/topic-details/horizon-hlth-2027-01-care-01', source_urls: []}],
		not_included: [{name: 'HORIZON-CL6-2027-01-SOIL-01', reason: 'Farming only'}],
	}
	assert.deepEqual(missingDecisions(report, expected).map((m) => m.id), ['HORIZON-HLTH-2027-03-TOOL-04'])
})

test('DAT-005 the weekly gather adds the EU calls, and a portal failure leaves the rest of the gather intact', async () => {
	const scrape = async (url) => ({url, status: 'Succeeded', content: 'x'.repeat(400)})
	const ok = await gatherFunderPages({regions: [], scrape, delayMs: 0, euCalls: async () => [call()]})
	assert.equal(ok.euCalls.length, 1)
	assert.ok(ok.pages.some((p) => p.region == 'EU' && p.organisation == 'EIC' && p.kind == 'listing'))
	assert.ok(ok.pages.some((p) => p.region == 'EU' && p.scheme == 'EIC Accelerator'))
	const lines = []
	const failed = await gatherFunderPages({regions: [], scrape, delayMs: 0, euCalls: async () => { throw new Error('EU portal search returned 503') }, log: (l) => lines.push(l)})
	assert.deepEqual(failed.euCalls, [])
	assert.ok(lines.includes('EU calls not read: EU portal search returned 503'))
})

test('DAT-005 a web_fetch of an EU call page is answered from the topic\'s data, which needs no browser', async () => {
	const asked = []
	const fetchJson = async (url) => {
		asked.push(url)
		return {ok: true, json: async () => ({TopicDetails: {identifier: 'HORIZON-HLTH-2027-01-STAYHLTH-01', title: 'Independent living', callTitle: 'Cluster 1 - Health',
			actions: [{plannedOpeningDate: Date.UTC(2026, 9, 29), deadlineDates: [Date.UTC(2027, 1, 17)]}],
			budgetOverviewJSONItem: {budgetTopicActionMap: {1: [{action: 'HORIZON-HLTH-2027-01-STAYHLTH-01 - RIA', minContribution: 6e6, maxContribution: 8e6}]}},
			description: '<p>Expected Outcome: care at home</p>', conditions: '<h4>Eligible countries</h4>'}})}
	}
	const page = await readEuTopic('https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-HLTH-2027-01-STAYHLTH-01', {fetchJson})
	assert.equal(asked[0], 'https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/horizon-hlth-2027-01-stayhlth-01.json')
	assert.equal(page.status, 'Succeeded')
	assert.ok(page.content.includes('Dates: opens 2026-10-29, deadline 2027-02-17'))
	assert.ok(page.content.includes('EUR 6m to 8m per project') && page.content.includes('Expected Outcome: care at home') && page.content.includes('Eligible countries'))
	assert.equal(await readEuTopic('https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/competitive-calls-cs/48106227', {fetchJson}), null)
	assert.equal(await readEuTopic('https://example.com/opportunities/data/topicDetails/x.json', {fetchJson}), null)
	assert.equal(asked.length, 1)
	const failed = await readEuTopic('https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/x-1.json', {fetchJson: async () => ({ok: false, status: 404})})
	assert.equal(failed.status, 'Failed')
})
