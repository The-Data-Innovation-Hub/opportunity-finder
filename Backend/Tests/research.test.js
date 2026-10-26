import test from 'node:test'
import assert from 'node:assert/strict'
import {createToolRunner} from '../Worker/Research/tools.js'
import {research} from '../Worker/Research/loop.js'

const domains = ['investni.com']
const page = (content) => async (url) => ({status: 'Succeeded', url, title: 'T', content, links: []})

test('BEH-011 tools stay on catalogue domains and stop at the limits', async () => {
	const searches = []
	const runner = createToolRunner({domains, limits: {searches: 1, fetches: 1},
		search: async (args) => { searches.push(args); return {results: []} }, fetchPage: page('x'.repeat(500))})
	assert.match((await runner.run({name: 'web_search', input: {query: 'a', site: 'example.com'}})).error, /not one of/)
	assert.deepEqual(await runner.run({name: 'web_search', input: {query: 'a', site: 'www.investni.com'}}), {results: []})
	assert.equal(searches[0].site, 'investni.com')
	assert.match((await runner.run({name: 'web_search', input: {query: 'b', site: null}})).error, /limit reached/)
	assert.match((await runner.run({name: 'web_fetch', input: {url: 'https://example.com/'}})).error, /not on this region/)
	assert.equal((await runner.run({name: 'web_fetch', input: {url: 'https://www.investni.com/a'}})).text.length, 500)
	assert.match((await runner.run({name: 'web_fetch', input: {url: 'https://www.investni.com/b'}})).error, /limit reached/)
	assert.deepEqual(runner.used, {searches: 1, fetches: 1})
})

test('BEH-013 with search switched off, searches are refused and not counted', async () => {
	const runner = createToolRunner({domains, searchEnabled: false, search: async () => assert.fail('searched')})
	assert.match((await runner.run({name: 'web_search', input: {query: 'a', site: null}})).error, /switched off/)
	assert.equal(runner.used.searches, 0)
})

test('BEH-013 a shared allowance is counted across a company\'s regional passes and then refuses (review finding 13)', async () => {
	const budget = {limit: 3, used: 0}
	const make = () => createToolRunner({domains, budget, limits: {searches: 2, fetches: 1}, search: async () => ({results: []})})
	const [ni, uk] = [make(), make()]
	const search = (runner) => runner.run({name: 'web_search', input: {query: 'a', site: null}})
	assert.deepEqual([await search(ni), await search(ni)], [{results: []}, {results: []}])
	assert.deepEqual(await search(uk), {results: []})
	assert.match((await search(uk)).error, /allowance is used up/)
	assert.deepEqual([budget.used, uk.used.searches], [3, 1])
})

test('BEH-011 unreadable pages return an error instead of empty text', async () => {
	const runner = createToolRunner({domains, fetchPage: page('short')})
	assert.match((await runner.run({name: 'web_fetch', input: {url: 'https://investni.com/x'}})).error, /not readable/)
})

test('BEH-011 the loop runs tools, nudges once, and returns the final tool input', async () => {
	const turns = [
		{calls: [{id: '1', name: 'web_fetch', input: {url: 'u'}}]},
		{calls: [], stopReason: 'end_turn'},
		{calls: [{id: '2', name: 'submit_report', input: {done: true}}]},
	]
	const log = {results: [], nudges: []}
	const conversation = {send: async () => turns.shift(), addResults: (r) => log.results.push(r), nudge: (t) => log.nudges.push(t)}
	const result = await research({conversation, runTool: async () => ({ok: 1}), finalTool: 'submit_report'})
	assert.deepEqual(result, {done: true})
	assert.deepEqual(log.results, [[{id: '1', output: {ok: 1}}]])
	assert.equal(log.nudges.length, 1)
})

import {missingDecisions, limitsFor, scopeRegions, REGION_SCOPES} from '../Worker/Research/search.js'

test('DAT-004 every checklist scheme and competition needs a row or a not_included reason', () => {
	const report = {
		funding: [
			{fund: 'Technical Development Incentive', funder: 'Invest NI', website: 'https://www.investni.com/tdi', source_urls: []},
			{fund: 'BridgeAI: Decision Critical', funder: 'Innovate UK', website: 'https://apply-for-innovation-funding.service.gov.uk/competition/2598/overview/x', source_urls: []},
		],
		not_included: [{name: 'Battery Innovation: Feasibility Studies Rd 3', reason: 'Battery only'}],
	}
	const expected = [
		{name: 'Technical Development Incentive (TDI)', kind: 'checklist scheme'},
		{name: 'Seedcorn Investor Readiness Competition', kind: 'checklist scheme'},
		{name: 'BridgeAI Deployment Catalyst: AI for Decision Critical Systems', url: 'https://apply-for-innovation-funding.service.gov.uk/competition/2598/overview/y', kind: 'Innovate UK competition'},
		{name: 'Battery Innovation: Feasibility Studies Rd 3', url: 'https://apply-for-innovation-funding.service.gov.uk/competition/2700/overview/z', kind: 'Innovate UK competition'},
		{name: 'Efficient, Structured and Controllable AI Systems', url: 'https://apply-for-innovation-funding.service.gov.uk/competition/2582/overview/w', kind: 'Innovate UK competition'},
	]
	assert.deepEqual(missingDecisions(report, expected).map((m) => m.name), ['Seedcorn Investor Readiness Competition', 'Efficient, Structured and Controllable AI Systems'])
})

test('DAT-004 an incomplete report goes back once with the missing items, then is accepted', async () => {
	const turns = [
		{calls: [{id: 'a', name: 'submit_report', input: {n: 1}}]},
		{calls: [{id: 'b', name: 'submit_report', input: {n: 2}}]},
	]
	const sent = []
	const conversation = {send: async () => turns.shift(), addResults: (r) => sent.push(r), nudge: () => {}}
	const result = await research({conversation, runTool: async () => ({}), finalTool: 'submit_report', validate: (r) => r.n == 1 ? 'missing Seedcorn' : null})
	assert.deepEqual(result, {n: 2})
	assert.deepEqual(sent, [[{id: 'a', output: {error: 'missing Seedcorn'}}]])
})

test('NI gets 40 page reads, other regions 30', () => {
	assert.equal(limitsFor('NI').fetches, 40)
	assert.equal(limitsFor('UK').fetches, 30)
})

test('BEH-011 malformed search and fetch inputs are refused, not counted', async () => {
	const runner = createToolRunner({domains, search: async () => assert.fail('searched'), fetchPage: async () => assert.fail('fetched')})
	assert.match((await runner.run({name: 'web_search', input: {}})).error, /needs a query/)
	assert.match((await runner.run({name: 'web_fetch', input: {url: 5}})).error, /needs a url/)
	assert.deepEqual(runner.used, {searches: 0, fetches: 0})
})

test('report strings: literal \\u escapes written by the model are decoded', async () => {
	const {decodeUnicodeEscapes} = await import('../Worker/Research/loop.js')
	assert.deepEqual(decodeUnicodeEscapes({amount: 'Up to \\u20ac130,000', months: ['1\\u201312'], n: 3, none: null}),
		{amount: 'Up to €130,000', months: ['1–12'], n: 3, none: null})
})

test('DEC-013 every region scope includes Northern Ireland, and older profiles map to the smallest scope covering them', () => {
	assert.deepEqual(scopeRegions(['NI', 'IE', 'UK']), ['NI', 'IE', 'UK'])
	assert.deepEqual(scopeRegions(['UK']), ['NI', 'UK'])
	assert.deepEqual(scopeRegions(['IE']), ['NI', 'IE'])
	assert.deepEqual(scopeRegions(['NI']), ['NI', 'IE'])
	assert.deepEqual(scopeRegions(['IE', 'UK']), ['NI', 'IE', 'UK'])
	assert.deepEqual(scopeRegions([]), ['NI', 'IE', 'UK'])
	for (const scope of Object.values(REGION_SCOPES)) assert.ok(scope.includes('NI'))
})
