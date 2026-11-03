// DEC-016 side-by-side trial against a real local database, as the worker's
// runtime role, with a scripted provider (no model calls, no cost).
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createMemoryStore, secretNameFor} from '../../Services/SecretStore.js'
import {keyStatusFromError} from '../../Worker/Providers/anthropic.js'
import {runWeek} from '../../Worker/Weekly.js'
import {runSharedTrial} from '../../Worker/SharedTrial.js'
import {allSchemesFor} from '../../Worker/Research/search.js'

delete process.env.BRAVE_SEARCH_API_KEY

const PROGRAMME_KEY = 'programme-key-for-trial'
let db, worker, secrets, blobs, calls

const fundingRow = (fund) => ({fund, funder: 'Invest NI', source_group: 'Invest NI', type: 'grant', amount: 'Up to £50k', match_funding: '50%',
	closing_date: '2026-12-01', status: 'Open', why_it_fits: 'Fits.', eligibility_notes: '', website: `https://www.investni.com/${fund.replace(/\W+/g, '-').toLowerCase()}`,
	email: null, phone: null, next_step: 'Apply.', source_urls: []})
const record = (name) => ({name, funder: 'Invest NI', source_group: 'Invest NI', type: 'grant', status: 'Open', opens: null, closing_date: '2026-12-01',
	amount: 'Up to £50k', match_funding: '50%', locations: 'NI', eligibility: 'SMEs.', sectors: ['any sector'], summary: 'R&D.', caveats: null,
	website: `https://www.investni.com/${name.replace(/\W+/g, '-').toLowerCase()}`, email: null, phone: null, source_urls: []})
const REGION = {Northern: 'NI', Ireland: 'IE', United: 'UK', EU: 'EU'}
// Every checklist name in a message, as "- Name (Funder...)" lines.
const checklist = (text) => [...text.matchAll(/^- (.+?) \((?:[^()]|\([^()]*\))*\)$/gm)].map((m) => ({name: m[1], reason: 'n/a'}))

// Answers whichever final tool the conversation offers. The weekly run
// finds "Grant A"; the shared path finds "Grant A" and "Grant B".
const scriptedProvider = ({costPerSend = 0.5} = {}) => ({
	createProvider: ({apiKey, model}) => ({
		name: 'anthropic', model, estimateCost: () => costPerSend,
		start: ({system, content, tools}) => {
			const names = tools.map((t) => t.name)
			const text = content.map((b) => b.text).join('\n')
			calls.push({apiKey, tools: names, shared: system.includes('shared by about 130 companies')})
			const usage = {input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}
			const conversation = {usage, costUsd: 0,
				send: async () => {
					conversation.costUsd += costPerSend
					if (names.includes('submit_schemes')) {
						const region = REGION[text.match(/Your region: (\w+)/)[1]]
						const notIncluded = [...allSchemesFor(region).map((s) => ({name: s.scheme, reason: 'n/a'})), ...(text.includes('Grant A') ? [{name: 'Grant A', reason: 'n/a'}] : [])]
						return {stopReason: 'tool_use', calls: [{id: 'c', name: 'submit_schemes', input: {schemes: region == 'NI' ? [record('Grant B')] : [], not_included: notIncluded, notes: ''}}]}
					}
					if (names.includes('select_top_five')) return {stopReason: 'tool_use', calls: [{id: 't', name: 'select_top_five', input: {top_five: []}}]}
					const fromList = text.includes('checked schemes for Northern Ireland')
					const funding = text.includes('Your region for this pass: Northern Ireland') ? [fundingRow('Grant A'), ...(fromList ? [fundingRow('Grant B')] : [])] : []
					return {stopReason: 'tool_use', calls: [{id: 'r', name: 'submit_report', input: {funding, tenders: [], top_five: [], not_included: checklist(text), notes: ''}}]}
				},
				addResults: () => {}, nudge: () => {}}
			return conversation
		},
	}),
	keyStatusFromError,
})

const fetchers = {tenders: async () => [], ieTenders: async () => [], grants: async () => [],
	funderPages: async () => ({fetched_on: '2026-11-01', pages: [], competitions: [], euCalls: []})}

let companyId
before(async () => {
	db = await createTestDatabase()
	await seedApprovedModels(db.pool)
	worker = await db.rolePool('of_worker')
	secrets = createMemoryStore({environment: 'test'})
	const store = new Map()
	blobs = {kind: 'memory', store, put: async (n, b) => { store.set(n, b) }, get: async (n) => store.get(n), getIfExists: async (n) => store.get(n) ?? null, remove: async (n) => { store.delete(n) }}
	const {rows: [c]} = await db.pool.query(`INSERT INTO company (name) VALUES ('Trial Co') RETURNING id`)
	companyId = c.id
	await db.pool.query(`INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, 1, 'Software that plans domiciliary care visits.', ARRAY['NI', 'UK'])`, [c.id])
	await secrets.set(secretNameFor(c.id), 'company-key')
	await db.pool.query(`INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four) VALUES ($1, 'anthropic', 'claude-sonnet-5-5', $2, 'abcd')`, [c.id, secretNameFor(c.id)])
	await secrets.set('programme-llm-anthropic', PROGRAMME_KEY)
	await db.pool.query(`INSERT INTO programme_llm_credential (provider, model, secret_name, last_four) VALUES ('anthropic', 'claude-sonnet-5-5', 'programme-llm-anthropic', 'rial')`)
	calls = []
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-11-01T22:00:00Z'), providers: () => scriptedProvider(), log: () => {}})
	assert.equal(outcomes[c.id].status, 'succeeded')
})
after(async () => { await db?.drop() })

const counts = async () => (await db.pool.query(`SELECT (SELECT count(*) FROM report)::int AS reports, (SELECT count(*) FROM report_row)::int AS rows,
	(SELECT count(*) FROM search_run)::int AS runs, (SELECT coalesce(sum(model_cost_usd), 0)::text FROM search_run) AS cost`)).rows[0]

test('DEC-016 trial: shared list then matching on the programme key, compared with the week\'s report, nothing else touched', async () => {
	const start = await counts()
	calls = []
	const summary = await runSharedTrial({pool: worker, secrets, blobs, week: '2026-11-02', now: new Date('2026-11-03T10:00:00Z'), providers: () => scriptedProvider(), log: () => {}})
	assert.ok(calls.length > 0 && calls.every((c) => c.apiKey == PROGRAMME_KEY), 'only the programme key is used')
	assert.equal(calls.filter((c) => c.shared).length, 4, 'one shared pass per region')
	assert.ok(calls.filter((c) => c.tools.includes('submit_report')).every((c) => c.tools.includes('web_search')), 'stage 3 is on by default')
	assert.deepEqual(await counts(), start, 'reports, rows and runs are unchanged')

	const [c] = summary.companies
	assert.equal(c.outcome, 'succeeded')
	assert.deepEqual([c.counts.both, c.counts.only_current, c.counts.only_proposed], [1, 0, 1])
	assert.ok(blobs.store.get('trials/2026-11-02/comparison.xlsx').length > 1000)
	const comparison = JSON.parse(String(blobs.store.get('trials/2026-11-02/comparison.json')))
	assert.deepEqual(comparison.companies[0].rows.map((r) => [r.name, r.in_current, r.in_proposed]), [['Grant A', true, true], ['Grant B', false, true]])
	assert.ok(blobs.store.has('trials/2026-11-02/catalogue.json') && blobs.store.has(`trials/2026-11-02/companies/${companyId}.json`))
})

test('DEC-016 trial: a retry reuses the list and finished companies, paying nothing again', async () => {
	calls = []
	const summary = await runSharedTrial({pool: worker, secrets, blobs, week: '2026-11-02', providers: () => scriptedProvider(), log: () => {}})
	assert.equal(calls.length, 0)
	assert.equal(summary.spent_usd, 0)
	assert.equal(summary.companies[0].outcome, 'succeeded')
})

test('DEC-016 trial: the spend limit stops it before the next request', async () => {
	for (const name of [...blobs.store.keys()].filter((n) => n.startsWith('trials/'))) blobs.store.delete(name)
	calls = []
	await assert.rejects(runSharedTrial({pool: worker, secrets, blobs, week: '2026-11-02', spendLimitUsd: 1, providers: () => scriptedProvider(), log: () => {}}),
		{code: 'programme_budget_reached'})
	// Two passes at US$0.50 each reach the limit; the third is stopped before its first request.
	assert.equal(calls.length, 3)
})

test('DEC-016 trial: refuses a week without a finished gather or reports', async () => {
	await assert.rejects(runSharedTrial({pool: worker, secrets, blobs, week: '2026-10-26', providers: () => scriptedProvider()}), /No finished gather/)
})
