// The weekly job against a real local database, with a scripted provider
// (no model calls, no cost), an in-memory secret store and blob store.
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createMemoryStore, secretNameFor} from '../../Services/SecretStore.js'
import {createOutboxMailer, weeklyReportEmail} from '../../Services/Mail.js'
import {keyStatusFromError} from '../../Worker/Providers/anthropic.js'
import {runWeek, sendWeeklyEmails, cleanup} from '../../Worker/Weekly.js'
import {collectAzureCost} from '../../Worker/AzureCost.js'

// Searches made by the scripted model fail fast and offline, but still count.
delete process.env.BRAVE_SEARCH_API_KEY

let db, worker, secrets, blobs, providerCalls
const WEEK1 = new Date('2026-10-25T21:00:00Z')
const WEEK2 = new Date('2026-11-01T22:00:00Z')

const fundingRow = (fund, status = 'Open') => ({fund, funder: 'Innovate UK', source_group: 'UK', type: 'competition (grant)', amount: 'Up to £100k',
	match_funding: 'Not stated', closing_date: '2026-12-01', status, why_it_fits: 'Fits.', eligibility_notes: 'UK SMEs.',
	website: `https://www.ukri.org/${fund.replace(/\W+/g, '-').toLowerCase()}`, email: null, phone: null, next_step: 'Apply.', source_urls: []})
const tenderRow = (title, direct) => ({title, buyer: 'HSC', portal: 'Find a Tender', notice_type: 'Tender', value: null, location: null,
	closing_date: '2026-11-20', status: 'Open', why_it_fits: 'Fits.', requirements: '', website: `https://find-tender.example/${title.length}`,
	contact_email: null, reference: null, next_step: 'Bid.', source_urls: [], company_can_supply_directly: direct})
const top = (name) => ({rank: 1, name, why_top_pick: 'Best.', amount: null, deadline: null, practical_steps: 'Apply.'})

// A scripted conversation: optionally searches, then answers the final tool.
// fail throws instead of answering (only for the key failFor, if given).
// costPerSend sets a provider-reported cost per request (as the Anthropic
// adapter does); onSend runs before each request.
const scriptedProvider = ({fail, failFor, searches = 0, costPerSend, onSend, funding = [fundingRow('Smart Grant')]} = {}) => ({
	createProvider: ({apiKey, model}) => ({
		name: 'anthropic', model, estimateCost: () => 0.5,
		start: ({tools}) => {
			providerCalls.push({apiKey, tools: tools.map((t) => t.name)})
			const usage = {input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}
			const isTop = tools.some((t) => t.name == 'select_top_five')
			let searchesLeft = tools.some((t) => t.name == 'web_search') ? searches : 0
			const conversation = {
				usage,
				...(costPerSend != null ? {costUsd: 0} : {}),
				send: async () => {
					if (costPerSend != null) conversation.costUsd += costPerSend
					await onSend?.({apiKey})
					if (searchesLeft > 0) return {stopReason: 'tool_use', calls: [{id: `s${searchesLeft--}`, name: 'web_search', input: {query: 'care grants', site: null}}]}
					if (fail && (!failFor || failFor == apiKey)) throw fail
					return {stopReason: 'tool_use', calls: [isTop
						? {id: 't', name: 'select_top_five', input: {top_five: [top('Smart Grant')]}}
						: {id: 'r', name: 'submit_report', input: {funding, tenders: [tenderRow('Care software', true), tenderRow('Care visits', false)],
							top_five: [top('Smart Grant')], not_included: [], notes: ''}}]}
				},
				addResults: () => {},
				nudge: () => {},
			}
			return conversation
		},
	}),
	keyStatusFromError,
})

const fetchers = {
	tenders: async () => [], ieTenders: async () => [], grants: async () => [],
	funderPages: async () => ({fetched_on: '2026-10-25', pages: [], competitions: []}),
}

before(async () => {
	db = await createTestDatabase()
	await seedApprovedModels(db.pool)
	// Jobs run as the worker's runtime role; setup uses the owner pool.
	worker = await db.rolePool('of_worker')
	secrets = createMemoryStore({environment: 'test'})
	const store = new Map()
	blobs = {kind: 'memory', store, put: async (n, b) => { store.set(n, b) }, get: async (n) => store.get(n), getIfExists: async (n) => store.get(n) ?? null, remove: async (n) => { store.delete(n) }}
})
after(async () => { await db?.drop() })

const q = (sql, params) => db.pool.query(sql, params)
const company = async (name, {key = true, profile = true} = {}) => {
	const {rows: [c]} = await q('INSERT INTO company (name) VALUES ($1) RETURNING id', [name])
	if (profile) await q(`INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, 1, 'Software that plans domiciliary care visits.', ARRAY['NI', 'UK'])`, [c.id])
	if (key) {
		await secrets.set(secretNameFor(c.id), `key-for-${name}`)
		await q(`INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four) VALUES ($1, 'anthropic', 'claude-sonnet-5-5', $2, 'abcd')`, [c.id, secretNameFor(c.id)])
	}
	return c.id
}

let a, noKey, noProfile, badKey
const silent = {log: () => {}}

test('BEH-003 weekly run: stores the report, skips companies that cannot run', async () => {
	a = await company('A Ltd')
	noKey = await company('B Ltd', {key: false})
	noProfile = await company('C Ltd', {profile: false})
	providerCalls = []
	const {week, outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: WEEK1, providers: () => scriptedProvider(), ...silent})
	assert.equal(week, '2026-10-26')
	assert.equal(outcomes[a].status, 'succeeded')
	assert.deepEqual([outcomes[noKey].reason, outcomes[noProfile].reason], ['no_key', 'no_profile'])
	// The company's own key, read from the secret store, is what the provider got.
	assert.ok(providerCalls.every((c) => c.apiKey == 'key-for-A Ltd'))
	const {rows: [run]} = await q('SELECT status, search_queries, model_cost_usd, input_tokens FROM search_run WHERE company_id = $1', [a])
	assert.equal(run.status, 'succeeded')
	// Two region passes and the Top 5, 0.50 each.
	assert.equal(Number(run.model_cost_usd), 1.5)
	assert.equal(Number(run.input_tokens), 3000)
	const {rows: [report]} = await q('SELECT blob_name, funding_rows, tender_rows, new_this_week FROM report WHERE company_id = $1', [a])
	assert.deepEqual([report.funding_rows, report.tender_rows, report.new_this_week], [1, 1, 2])
	assert.ok(blobs.store.get(report.blob_name).length > 1000, 'xlsx was not written')
})

test('BEH-002 tenders the company cannot supply directly are left out', async () => {
	const {rows} = await q("SELECT name FROM report_row WHERE company_id = $1 AND kind = 'tender'", [a])
	assert.deepEqual(rows.map((r) => r.name), ['Care software'])
})

test('BEH-003 a re-run of the same week does not repeat or re-bill a succeeded run', async () => {
	providerCalls = []
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: WEEK1, providers: () => scriptedProvider(), ...silent})
	assert.equal(outcomes[a].status, 'already_done')
	assert.equal(providerCalls.length, 0)
	const {rows} = await q('SELECT count(*)::int AS n FROM search_run WHERE company_id = $1', [a])
	assert.equal(rows[0].n, 1)
})

test('BEH-010 a rejected key marks the key invalid and skips, without failing the week', async () => {
	badKey = await company('D Ltd')
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: WEEK2,
		providers: () => scriptedProvider({fail: Object.assign(new Error('auth'), {status: 401})}), ...silent})
	assert.equal(outcomes[badKey].reason, 'invalid')
	const {rows: [k]} = await q('SELECT status FROM company_llm_credential WHERE company_id = $1', [badKey])
	assert.equal(k.status, 'invalid')
	const {rows: [r]} = await q("SELECT status, skip_reason FROM search_run WHERE company_id = $1", [badKey])
	assert.deepEqual([r.status, r.skip_reason], ['skipped', 'invalid_key'])
	// A was also refused this week by the failing provider and is retried later.
	assert.equal(outcomes[a].reason, 'invalid')
	await q("UPDATE company_llm_credential SET status = 'valid'")
})

test('BEH-005 next week, last week\'s rows are not "new"', async () => {
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: WEEK2, providers: () => scriptedProvider(), ...silent})
	assert.equal(outcomes[a].status, 'succeeded')
	const {rows: [report]} = await q("SELECT new_this_week FROM report WHERE company_id = $1 AND week_start = '2026-11-02'", [a])
	assert.equal(report.new_this_week, 0)
})

test('BEH-013 with search switched off, the model gets no web_search tool', async () => {
	await q('UPDATE service_setting SET search_enabled = false')
	const fresh = await company('E Ltd')
	providerCalls = []
	await runWeek({pool: worker, secrets, blobs, fetchers, now: WEEK2, providers: () => scriptedProvider(), ...silent})
	assert.ok(providerCalls.length > 0)
	assert.ok(providerCalls.every((c) => !c.tools.includes('web_search')))
	const {rows: [r]} = await q("SELECT status FROM search_run WHERE company_id = $1", [fresh])
	assert.equal(r.status, 'succeeded')
	await q('UPDATE service_setting SET search_enabled = true')
})

test('BEH-007 the Monday email goes once per member per report', async () => {
	const {rows: [u]} = await q("INSERT INTO app_user (email) VALUES ('founder@a.example') RETURNING id")
	await q("INSERT INTO company_membership (company_id, user_id, role) VALUES ($1, $2, 'company_admin')", [a, u.id])
	const mailer = createOutboxMailer({environment: 'test'})
	const first = await sendWeeklyEmails({pool: worker, mailer, appUrl: 'http://app.test', week: '2026-11-02', emailFor: weeklyReportEmail})
	const second = await sendWeeklyEmails({pool: worker, mailer, appUrl: 'http://app.test', week: '2026-11-02', emailFor: weeklyReportEmail})
	assert.deepEqual([first.sent, second.sent, mailer.outbox.length], [1, 0, 1])
	assert.match(mailer.outbox[0].subject, /A Ltd/)
	assert.match(mailer.outbox[0].text, /Smart Grant/)
})

test('DEC-005 reports older than 13 weeks are removed with their files; run costs are kept', async () => {
	const {rows: [old]} = await q("SELECT blob_name FROM report WHERE company_id = $1 AND week_start = '2026-10-26'", [a])
	const result = await cleanup({pool: worker, blobs, now: new Date('2027-02-01T12:00:00Z')})
	assert.ok(result.reportsRemoved >= 1)
	assert.equal(blobs.store.has(old.blob_name), false)
	const {rows} = await q("SELECT count(*)::int AS n FROM search_run WHERE week_start = '2026-10-26' AND status = 'succeeded'")
	assert.equal(rows[0].n, 1)
})

test('BEH-012 Azure daily cost is upserted, so a revised day replaces the old figure', async () => {
	await collectAzureCost({pool: worker, fetchCost: async () => [{day: '2026-10-20', amount: 1.2, currency: 'USD'}]})
	await collectAzureCost({pool: worker, fetchCost: async () => [{day: '2026-10-20', amount: 1.5, currency: 'USD'}]})
	const {rows} = await q('SELECT amount FROM azure_cost_daily')
	assert.deepEqual(rows.map((r) => Number(r.amount)), [1.5])
})

test('BEH-003 a failure after the model work marks the run failed, records its cost, and the next attempt retries it (review findings 2, 3)', async () => {
	const c = await company('F Ltd')
	// Reports fail to upload; the shared gather still saves.
	const failingBlobs = {...blobs, put: async (name, body) => {
		if (name.startsWith('reports/')) throw Object.assign(new Error('blob down'), {code: 'BLOB_DOWN'})
		return blobs.put(name, body)
	}}
	const week = new Date('2026-11-08T22:00:00Z')
	const first = await runWeek({pool: worker, secrets, blobs: failingBlobs, fetchers, now: week, providers: () => scriptedProvider(), ...silent})
	assert.equal(first.outcomes[c].status, 'failed')
	const {rows: [run]} = await q('SELECT status, error_code, model_cost_usd FROM search_run WHERE company_id = $1', [c])
	assert.deepEqual([run.status, run.error_code], ['failed', 'BLOB_DOWN'])
	assert.equal(Number(run.model_cost_usd), 1.5, 'model cost of the failed run was not recorded')
	assert.ok(blobs.store.has(`runs/${c}/2026-11-09.json`), 'the finished research was not kept')
	providerCalls = []
	const second = await runWeek({pool: worker, secrets, blobs, fetchers, now: week, providers: () => scriptedProvider(), ...silent})
	assert.equal(second.outcomes[c].status, 'succeeded')
	assert.equal(second.outcomes[c].reusedResearch, true)
	assert.equal(providerCalls.filter((p) => p.apiKey == 'key-for-F Ltd').length, 0, 'the retry paid for the research again')
	assert.equal(blobs.store.has(`runs/${c}/2026-11-09.json`), false, 'the kept research outlived the saved report')
	const {rows: [after]} = await q('SELECT model_cost_usd FROM search_run WHERE company_id = $1', [c])
	assert.equal(Number(after.model_cost_usd), 1.5, 'the reused run was not costed once')
})

test('BEH-003 a run left running by a dead replica is claimed again after the timeout', async () => {
	const c = await company('G Ltd')
	await q("INSERT INTO search_run (company_id, week_start, status, started_at) VALUES ($1, '2026-11-09', 'running', now() - interval '8 hours')", [c])
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-11-08T22:00:00Z'), providers: () => scriptedProvider(), ...silent})
	assert.equal(outcomes[c].status, 'succeeded')
})

test('BEH-004 rows with values the database would reject are cleaned, not lost (review finding 3)', async () => {
	const c = await company('H Ltd')
	const odd = {...fundingRow('Odd'), closing_date: '2026-02-30', status: 'Maybe'}
	const unnamed = {...fundingRow('x'), fund: null, status: 'Closed', closed_since: 'soon'}
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-11-15T22:00:00Z'),
		providers: () => scriptedProvider({funding: [odd, unnamed]}), ...silent})
	assert.equal(outcomes[c].status, 'succeeded')
	const {rows} = await q(`SELECT rr.name, rr.status, rr.closing_date, rr.closed_since FROM report_row rr JOIN report r ON r.id = rr.report_id
		WHERE r.company_id = $1 AND rr.kind = 'funding' ORDER BY rr.name COLLATE "C"`, [c])
	assert.deepEqual(rows.map((r) => [r.name, r.status, r.closing_date]), [['(untitled)', 'Closed', '2026-12-01'], ['Odd', 'Open', null]])
	assert.equal(rows[0].closed_since, '2026-11-15')
})

const monthUsed = async () => (await q("SELECT coalesce(sum(search_queries), 0)::int AS n FROM search_run WHERE started_at >= date_trunc('month', now())")).rows[0].n

test('BEH-013 runs in parallel cannot together pass the monthly search cap (review finding 13)', async () => {
	for (const n of ['K1 Ltd', 'K2 Ltd', 'K3 Ltd', 'K4 Ltd']) await company(n)
	const before = await monthUsed()
	// 30 searches left this month; every company would make 20.
	await q('UPDATE service_setting SET monthly_query_cap = $1', [before + 30])
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-11-22T22:00:00Z'),
		providers: () => scriptedProvider({searches: 20}), ...silent})
	assert.ok(Object.values(outcomes).filter((o) => o.status == 'succeeded').length >= 4)
	assert.equal(await monthUsed(), before + 30)
	await q('UPDATE service_setting SET monthly_query_cap = 10000')
})

test('BEH-013 a failed run still records the searches and model work it was billed for (review finding 13)', async () => {
	const c = await company('J Ltd')
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-11-29T22:00:00Z'),
		providers: () => scriptedProvider({searches: 3, failFor: 'key-for-J Ltd', fail: Object.assign(new Error('model down'), {code: 'MODEL_DOWN'})}), ...silent})
	assert.equal(outcomes[c].status, 'failed')
	const {rows: [run]} = await q('SELECT status, error_code, search_queries, search_cost_usd, input_tokens, output_tokens, model_cost_usd FROM search_run WHERE company_id = $1', [c])
	assert.deepEqual([run.status, run.error_code, run.search_queries], ['failed', 'MODEL_DOWN', 3])
	assert.ok(Number(run.search_cost_usd) > 0)
	// The model work before the failure was billed, so it is recorded too.
	assert.deepEqual([Number(run.input_tokens), Number(run.output_tokens), Number(run.model_cost_usd)], [1000, 100, 0.5])
})

// --- DEC-011: free period on the programme's key ------------------------------------

const PROGRAMME_KEY = 'programme-key-for-tests'
const freePeriod = async ({until = '2027-12-31', capUsd = 1000, key = true} = {}) => {
	await q('UPDATE service_setting SET free_period_until = $1, programme_model_monthly_cap_usd = $2', [until, capUsd])
	await q('DELETE FROM programme_llm_credential')
	if (key) {
		await secrets.set('programme-llm-anthropic', PROGRAMME_KEY)
		await q(`INSERT INTO programme_llm_credential (provider, model, secret_name, last_four) VALUES ('anthropic', 'claude-sonnet-5-5', 'programme-llm-anthropic', 'ests')`)
	}
}
const endFreePeriod = () => q('UPDATE service_setting SET free_period_until = NULL, programme_model_monthly_cap_usd = 100')
const runOf = async (companyId, week) => (await q('SELECT status, skip_reason, paid_by, model_cost_usd FROM search_run WHERE company_id = $1 AND week_start = $2', [companyId, week])).rows[0]

test('DEC-011 in the free period every company runs on the programme key, with or without its own', async () => {
	const own = await company('L Ltd')
	const none = await company('M Ltd', {key: false})
	await freePeriod()
	providerCalls = []
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-12-06T22:00:00Z'), providers: () => scriptedProvider(), ...silent})
	assert.deepEqual([outcomes[own].status, outcomes[none].status], ['succeeded', 'succeeded'])
	assert.ok(providerCalls.length > 0 && providerCalls.every((c) => c.apiKey == PROGRAMME_KEY), 'a company key was used in the free period')
	for (const c of [own, none]) {
		const run = await runOf(c, '2026-12-07')
		assert.equal(run.paid_by, 'programme')
		assert.equal(Number(run.model_cost_usd), 1.5)
	}
	const {rows: [kept]} = await q('SELECT status FROM company_llm_credential WHERE company_id = $1', [own])
	assert.equal(kept.status, 'valid', 'the company key was not kept for afterwards')
	await endFreePeriod()
})

test('DEC-011 and DEC-014 after the free period, an own-key plan runs on the company\'s own key; no plan, no run', async () => {
	const own = await company('N Ltd')
	const none = await company('O Ltd', {key: false})
	const unplanned = await company('O2 Ltd')
	for (const id of [own, none]) await q(`INSERT INTO company_billing (company_id, stripe_customer_id, stripe_subscription_id, plan, billing_interval, status)
		VALUES ($1, $2, $3, 'own_key', 'month', 'active')`, [id, `cus_${id}`, `sub_${id}`])
	await freePeriod({until: '2026-12-13'})
	providerCalls = []
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-12-13T22:00:00Z'), providers: () => scriptedProvider(), ...silent})
	assert.equal(outcomes[own].status, 'succeeded')
	assert.equal(outcomes[none].reason, 'no_key')
	assert.equal(outcomes[unplanned].reason, 'no_plan')
	assert.equal((await runOf(own, '2026-12-14')).paid_by, 'company')
	assert.ok(providerCalls.every((c) => c.apiKey != PROGRAMME_KEY))
	await endFreePeriod()
})

test('DEC-011 the monthly AI cap holds across runs in parallel', async () => {
	for (const n of ['P1 Ltd', 'P2 Ltd', 'P3 Ltd']) await company(n)
	const {rows: [spent]} = await q("SELECT coalesce(sum(model_cost_usd), 0) AS usd FROM search_run WHERE paid_by = 'programme' AND started_at >= date_trunc('month', now())")
	// Room for one run at the model's benchmark cost (US$3.97), not two.
	await freePeriod({capUsd: Number(spent.usd) + 4.5})
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-12-20T22:00:00Z'), providers: () => scriptedProvider(), ...silent})
	const statuses = Object.values(outcomes)
	assert.equal(statuses.filter((o) => o.status == 'succeeded').length, 1)
	assert.ok(statuses.filter((o) => o.reason == 'programme_budget_reached').length >= 3)
	await endFreePeriod()
})

test('DEC-011 a rejected programme key is marked on the programme, not the company', async () => {
	const c = await company('Q Ltd')
	await freePeriod()
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2026-12-27T22:00:00Z'),
		providers: () => scriptedProvider({fail: Object.assign(new Error('auth'), {status: 401})}), ...silent})
	assert.equal(outcomes[c].reason, 'programme_key_problem')
	assert.equal((await q('SELECT status FROM programme_llm_credential')).rows[0].status, 'invalid')
	assert.equal((await q('SELECT status FROM company_llm_credential WHERE company_id = $1', [c])).rows[0].status, 'valid')
	await freePeriod({key: false})
	const {outcomes: next} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2027-01-03T22:00:00Z'), providers: () => scriptedProvider(), ...silent})
	assert.equal(next[c].reason, 'programme_key_problem')
	await endFreePeriod()
})

test('DEC-011 the Monday email announces the end of the free period from four weeks before', async () => {
	const {rows: [u]} = await q("INSERT INTO app_user (email) VALUES ('founder@l.example') RETURNING id")
	const {rows: [l]} = await q("SELECT id FROM company WHERE name = 'L Ltd'")
	await q("INSERT INTO company_membership (company_id, user_id, role) VALUES ($1, $2, 'company_admin')", [l.id, u.id])
	const mailer = createOutboxMailer({environment: 'test'})
	await q("UPDATE service_setting SET free_period_until = '2027-01-31'")
	await sendWeeklyEmails({pool: worker, mailer, appUrl: 'http://app.test', week: '2026-12-07', emailFor: weeklyReportEmail})
	const sent = mailer.outbox.find((m) => m.to == 'founder@l.example')
	assert.ok(sent, 'no email was sent')
	assert.doesNotMatch(sent.text, /covering the AI cost/, 'announced more than four weeks early')
	await q("UPDATE service_setting SET free_period_until = '2026-12-31'")
	await q("DELETE FROM notification WHERE user_id = $1", [u.id])
	await sendWeeklyEmails({pool: worker, mailer, appUrl: 'http://app.test', week: '2026-12-07', emailFor: weeklyReportEmail})
	const notice = mailer.outbox.filter((m) => m.to == 'founder@l.example').at(-1)
	assert.match(notice.text, /covering the AI cost of these reports until 31 December 2026/)
	assert.match(notice.text, /http:\/\/app\.test\/companies\/.+\/settings/)
	await endFreePeriod()
})

// --- Review of DEC-011 (second adversarial review) ----------------------------------

// Every company in this file's database runs each week; these tests need
// theirs to be the only one, so the others are paused.
const onlyActive = (...ids) => q("UPDATE company SET status = CASE WHEN id = ANY($1::uuid[]) THEN 'active' ELSE 'paused' END", [ids])

test('DEC-011 a failed attempt and its retry are both counted (review finding 1)', async () => {
	const c = await company('R Ltd')
	await freePeriod()
	const week = new Date('2027-01-10T22:00:00Z')
	const first = await runWeek({pool: worker, secrets, blobs, fetchers, now: week,
		providers: () => scriptedProvider({searches: 2, failFor: PROGRAMME_KEY, fail: Object.assign(new Error('model down'), {code: 'MODEL_DOWN'})}), ...silent})
	assert.equal(first.outcomes[c].status, 'failed')
	const second = await runWeek({pool: worker, secrets, blobs, fetchers, now: week, providers: () => scriptedProvider(), ...silent})
	assert.equal(second.outcomes[c].status, 'succeeded')
	const {rows: [run]} = await q("SELECT model_cost_usd, search_queries, input_tokens, paid_by FROM search_run WHERE company_id = $1 AND week_start = '2027-01-11'", [c])
	// 0.50 for the failed attempt's first conversation, 1.50 for the retry.
	assert.deepEqual([Number(run.model_cost_usd), run.search_queries, Number(run.input_tokens), run.paid_by], [2, 2, 4000, 'programme'])
	await endFreePeriod()
})

test('DEC-011 a key replaced mid-run is not marked rejected by the old key\'s failure (review finding 2)', async () => {
	const c = await company('S Ltd')
	await onlyActive(c)
	await freePeriod()
	const replace = async () => {
		await secrets.set('programme-llm-anthropic', 'replacement-programme-key')
		await q("UPDATE programme_llm_credential SET last_four = 'cccc', added_at = now() + interval '1 second', status = 'valid'")
	}
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2027-01-17T22:00:00Z'),
		providers: () => scriptedProvider({onSend: async ({apiKey}) => { if (apiKey == PROGRAMME_KEY) { await replace(); throw Object.assign(new Error('revoked'), {status: 401}) } }}), ...silent})
	assert.equal(outcomes[c].status, 'failed', 'the run should be retried with the new key, not skipped')
	assert.deepEqual((await q('SELECT last_four, status FROM programme_llm_credential')).rows[0], {last_four: 'cccc', status: 'valid'})
	// The same guard protects a company's own key.
	await endFreePeriod()
	const own = await company('S2 Ltd')
	await onlyActive(own)
	const {outcomes: next} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2027-01-24T22:00:00Z'),
		providers: () => scriptedProvider({onSend: async ({apiKey}) => {
			if (apiKey != 'key-for-S2 Ltd') return
			await q("UPDATE company_llm_credential SET last_four = 'dddd', added_at = now() + interval '1 second' WHERE company_id = $1", [own])
			throw Object.assign(new Error('revoked'), {status: 401})
		}}), ...silent})
	assert.equal(next[own].status, 'failed')
	assert.equal((await q('SELECT status FROM company_llm_credential WHERE company_id = $1', [own])).rows[0].status, 'valid')
})

test('DEC-011 a run is stopped once it reaches its AI allowance (review finding 3)', async () => {
	const c = await company('T Ltd')
	await onlyActive(c)
	const {rows: [spent]} = await q("SELECT coalesce(sum(model_cost_usd), 0) AS usd FROM search_run WHERE paid_by = 'programme' AND started_at >= date_trunc('month', now())")
	// US$5 left; every request costs US$3, so the third request is refused.
	await freePeriod({capUsd: Number(spent.usd) + 5})
	const {outcomes} = await runWeek({pool: worker, secrets, blobs, fetchers, now: new Date('2027-01-31T22:00:00Z'),
		providers: () => scriptedProvider({searches: 5, costPerSend: 3}), ...silent})
	assert.equal(outcomes[c].status, 'failed')
	const {rows: [run]} = await q("SELECT error_code, model_cost_usd FROM search_run WHERE company_id = $1 AND week_start = '2027-02-01'", [c])
	assert.deepEqual([run.error_code, Number(run.model_cost_usd)], ['programme_budget_reached', 6])
	const {rows: [total]} = await q("SELECT coalesce(sum(model_cost_usd), 0) AS usd FROM search_run WHERE paid_by = 'programme' AND started_at >= date_trunc('month', now())")
	assert.ok(Number(total.usd) <= Number(spent.usd) + 5 + 3, 'the cap was passed by more than one request')
	await endFreePeriod()
})

test('DEC-011 a second weekly job started while one is running does nothing (review finding 3)', async () => {
	let release
	const gate = new Promise((resolve) => { release = resolve })
	const slowFetchers = {...fetchers, tenders: async () => { await gate; return [] }}
	const week = new Date('2027-02-07T22:00:00Z')
	const first = runWeek({pool: worker, secrets, blobs, fetchers: slowFetchers, now: week, providers: () => scriptedProvider(), ...silent})
	await new Promise((resolve) => setTimeout(resolve, 200))
	const second = await runWeek({pool: worker, secrets, blobs, fetchers, now: week, providers: () => scriptedProvider(), ...silent})
	release()
	assert.equal(second.skipped, 'another_weekly_job_running')
	assert.ok(Object.keys((await first).outcomes).length > 0)
})

test('DEC-011 a retry reuses research the programme paid for, even after the free period ends (review finding 4)', async () => {
	const c = await company('U Ltd', {key: false})
	await onlyActive(c)
	await freePeriod()
	const failingBlobs = {...blobs, put: async (name, body) => {
		if (name.startsWith('reports/')) throw Object.assign(new Error('blob down'), {code: 'BLOB_DOWN'})
		return blobs.put(name, body)
	}}
	const week = new Date('2027-02-14T22:00:00Z')
	assert.equal((await runWeek({pool: worker, secrets, blobs: failingBlobs, fetchers, now: week, providers: () => scriptedProvider(), ...silent})).outcomes[c].status, 'failed')
	await endFreePeriod()
	await q('UPDATE programme_llm_credential SET status = $1', ['invalid'])
	providerCalls = []
	const retry = await runWeek({pool: worker, secrets, blobs, fetchers, now: week, providers: () => scriptedProvider(), ...silent})
	assert.equal(retry.outcomes[c].status, 'succeeded', 'a company with no key lost research the programme paid for')
	assert.equal(retry.outcomes[c].reusedResearch, true)
	assert.equal(providerCalls.filter((p) => p.apiKey == PROGRAMME_KEY).length, 0)
	const run = await runOf(c, '2027-02-15')
	assert.deepEqual([run.paid_by, Number(run.model_cost_usd)], ['programme', 1.5])
})
