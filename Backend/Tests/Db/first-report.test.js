// The first-report job (BEH-015) against a real local database, with a
// scripted provider (no model calls, no cost).
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createMemoryStore, secretNameFor} from '../../Services/SecretStore.js'
import {createOutboxMailer, weeklyReportEmail} from '../../Services/Mail.js'
import {keyStatusFromError} from '../../Worker/Providers/anthropic.js'
import {runFirstReports, WEEKLY_JOB_LOCK} from '../../Worker/Weekly.js'

delete process.env.BRAVE_SEARCH_API_KEY

let db, worker, secrets, blobs, providerCalls, gathers
const WEDNESDAY = new Date('2026-10-28T10:00:00Z')
const THURSDAY = new Date('2026-10-29T10:00:00Z')
const SUNDAY = new Date('2026-11-01T10:00:00Z')

const fundingRow = {fund: 'Smart Grant', funder: 'Innovate UK', source_group: 'UK', type: 'competition (grant)', amount: 'Up to £100k',
	match_funding: 'Not stated', closing_date: '2026-12-01', status: 'Open', why_it_fits: 'Fits.', eligibility_notes: 'UK SMEs.',
	website: 'https://www.ukri.org/smart-grant', email: null, phone: null, next_step: 'Apply.', source_urls: []}
const top = {rank: 1, name: 'Smart Grant', why_top_pick: 'Best.', amount: null, deadline: null, practical_steps: 'Apply.'}

const scriptedProvider = ({fail} = {}) => ({
	createProvider: ({apiKey, model}) => ({
		name: 'anthropic', model, estimateCost: () => 0.5,
		start: ({tools}) => {
			providerCalls.push(apiKey)
			const isTop = tools.some((t) => t.name == 'select_top_five')
			return {
				usage: {input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0},
				send: async () => {
					if (fail) throw fail
					return {stopReason: 'tool_use', calls: [isTop
						? {id: 't', name: 'select_top_five', input: {top_five: [top]}}
						: {id: 'r', name: 'submit_report', input: {funding: [fundingRow], tenders: [], top_five: [top], not_included: [], notes: ''}}]}
				},
				addResults: () => {},
				nudge: () => {},
			}
		},
	}),
	keyStatusFromError,
})

const fetchers = {
	tenders: async () => { gathers += 1; return [] }, ieTenders: async () => [], grants: async () => [],
	funderPages: async () => ({fetched_on: '2026-10-25', pages: [], competitions: [], euCalls: []}),
}

before(async () => {
	db = await createTestDatabase()
	await seedApprovedModels(db.pool)
	worker = await db.rolePool('of_worker')
	secrets = createMemoryStore({environment: 'test'})
	const store = new Map()
	blobs = {kind: 'memory', store, put: async (n, b) => { store.set(n, b) }, get: async (n) => store.get(n), getIfExists: async (n) => store.get(n) ?? null, remove: async (n) => { store.delete(n) }}
})
after(async () => { await db?.drop() })

const q = (sql, params) => db.pool.query(sql, params)
const addKey = async (id, name) => {
	await secrets.set(secretNameFor(id), `key-for-${name}`)
	await q(`INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four) VALUES ($1, 'anthropic', 'claude-sonnet-5-5', $2, 'abcd')`, [id, secretNameFor(id)])
}
const company = async (name, {key = true, profile = true, status = 'active'} = {}) => {
	const {rows: [c]} = await q('INSERT INTO company (name, status) VALUES ($1, $2) RETURNING id', [name, status])
	if (profile) await q(`INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, 1, 'Care visit planning.', ARRAY['NI', 'UK'])`, [c.id])
	if (key) await addKey(c.id, name)
	const {rows: [u]} = await q('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [`founder@${name.replace(/\W+/g, '').toLowerCase()}.example`])
	await q("INSERT INTO company_membership (company_id, user_id, role) VALUES ($1, $2, 'company_admin')", [c.id, u.id])
	return c.id
}
const run = (now, {mailer = createOutboxMailer({environment: 'test'}), provider = scriptedProvider()} = {}) =>
	runFirstReports({pool: worker, secrets, blobs, fetchers, mailer, appUrl: 'http://app.test', emailFor: weeklyReportEmail, now, providers: () => provider})
		.then((result) => ({...result, mailer}))
const reportsOf = async (id) => (await q('SELECT week_start::text AS week FROM report WHERE company_id = $1', [id])).rows.map((r) => r.week)

let fresh, waiting, paused, noProfile
test('BEH-015 a new company gets this week\'s report and its email without waiting for Sunday', async () => {
	fresh = await company('Fresh Ltd')
	waiting = await company('Waiting Ltd', {key: false})
	paused = await company('Paused Ltd', {status: 'paused'})
	noProfile = await company('No Profile Ltd', {profile: false})
	providerCalls = []
	gathers = 0
	const {week, outcomes, mailer} = await run(WEDNESDAY)
	assert.equal(week, '2026-10-26')
	assert.equal(outcomes[fresh].status, 'succeeded')
	assert.equal(outcomes[waiting].reason, 'no_key')
	assert.ok(!(paused in outcomes) && !(noProfile in outcomes))
	assert.deepEqual(await reportsOf(fresh), ['2026-10-26'])
	assert.equal(gathers, 1)
	assert.deepEqual(mailer.outbox.map((m) => m.to), ['founder@freshltd.example'])
})

test('BEH-015 a company already run is not run or emailed again; the week\'s gather is reused', async () => {
	providerCalls = []
	gathers = 0
	const {outcomes, mailer} = await run(THURSDAY)
	assert.deepEqual(Object.keys(outcomes), [waiting])
	assert.equal(outcomes[waiting].reason, 'no_key')
	assert.deepEqual([providerCalls.length, gathers, mailer.outbox.length], [0, 0, 0])
})

test('BEH-015 a company skipped for want of a key runs once the key is added, and only it is emailed', async () => {
	await addKey(waiting, 'Waiting Ltd')
	// Another company's report for the week, not yet emailed, is left to the Monday job.
	const other = await company('Other Ltd')
	const {rows: [otherRun]} = await q(`INSERT INTO search_run (company_id, week_start, status) VALUES ($1, '2026-10-26', 'succeeded') RETURNING id`, [other])
	await q(`INSERT INTO report (company_id, search_run_id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note)
		VALUES ($1, $2, '2026-10-26', 'reports/other.xlsx', 0, 0, 0, '[]', '[]', '[]', '')`, [other, otherRun.id])
	providerCalls = []
	const {outcomes, mailer} = await run(THURSDAY)
	assert.equal(outcomes[waiting].status, 'succeeded')
	assert.ok(providerCalls.every((k) => k == 'key-for-Waiting Ltd'))
	assert.deepEqual(mailer.outbox.map((m) => m.to), ['founder@waitingltd.example'])
})

test('BEH-015 a failed first run is left to Sunday, not retried every 15 minutes', async () => {
	const broken = await company('Broken Ltd')
	const first = await run(THURSDAY, {provider: scriptedProvider({fail: new Error('upstream exploded')})})
	assert.equal(first.outcomes[broken].status, 'failed')
	providerCalls = []
	const second = await run(THURSDAY)
	assert.ok(!(broken in second.outcomes))
	assert.equal(providerCalls.length, 0)
})

test('BEH-015 on a Sunday new companies wait for that night\'s run', async () => {
	const sundayCo = await company('Sunday Ltd')
	providerCalls = []
	const result = await run(SUNDAY)
	assert.equal(result.skipped, 'sunday')
	assert.equal(providerCalls.length, 0)
	assert.deepEqual(await reportsOf(sundayCo), [])
})

test('BEH-015 while the weekly job holds its lock, the first-report job does nothing', async () => {
	const later = await company('Later Ltd')
	const holder = await db.pool.connect()
	try {
		await holder.query('SELECT pg_advisory_lock($1)', [WEEKLY_JOB_LOCK])
		const result = await run(THURSDAY)
		assert.equal(result.skipped, 'another_weekly_job_running')
		assert.deepEqual(await reportsOf(later), [])
	} finally {
		await holder.query('SELECT pg_advisory_unlock($1)', [WEEKLY_JOB_LOCK])
		holder.release()
	}
	const {outcomes} = await run(THURSDAY)
	assert.equal(outcomes[later].status, 'succeeded')
})
