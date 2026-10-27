// Who pays for a run once the free period has ended (DEC-014), through the
// first-report job, against a real local database with a scripted provider
// (no model calls, no cost).
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createMemoryStore, secretNameFor} from '../../Services/SecretStore.js'
import {createOutboxMailer, weeklyReportEmail} from '../../Services/Mail.js'
import {keyStatusFromError} from '../../Worker/Providers/anthropic.js'
import {runFirstReports} from '../../Worker/Weekly.js'

delete process.env.BRAVE_SEARCH_API_KEY

let db, worker, secrets, blobs, keysUsed
const fundingRow = {fund: 'Smart Grant', funder: 'Innovate UK', source_group: 'UK', type: 'competition (grant)', amount: 'Up to £100k',
	match_funding: 'Not stated', closing_date: '2027-03-01', status: 'Open', why_it_fits: 'Fits.', eligibility_notes: 'UK SMEs.',
	website: 'https://www.ukri.org/smart-grant', email: null, phone: null, next_step: 'Apply.', source_urls: []}
const top = {rank: 1, name: 'Smart Grant', why_top_pick: 'Best.', amount: null, deadline: null, practical_steps: 'Apply.'}
const provider = {
	createProvider: ({apiKey, model}) => ({
		name: 'anthropic', model, estimateCost: () => 0.5,
		start: ({tools}) => {
			keysUsed.add(apiKey)
			const isTop = tools.some((t) => t.name == 'select_top_five')
			return {
				usage: {input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0},
				send: async () => ({stopReason: 'tool_use', calls: [isTop
					? {id: 't', name: 'select_top_five', input: {top_five: [top]}}
					: {id: 'r', name: 'submit_report', input: {funding: [fundingRow], tenders: [], top_five: [top], not_included: [], notes: ''}}]}),
				addResults: () => {},
				nudge: () => {},
			}
		},
	}),
	keyStatusFromError,
}
const fetchers = {
	tenders: async () => [], ieTenders: async () => [], grants: async () => [],
	funderPages: async () => ({fetched_on: '2027-02-01', pages: [], competitions: [], euCalls: []}),
}

before(async () => {
	db = await createTestDatabase()
	await seedApprovedModels(db.pool)
	worker = await db.rolePool('of_worker')
	secrets = createMemoryStore({environment: 'test'})
	const store = new Map()
	blobs = {kind: 'memory', store, put: async (n, b) => { store.set(n, b) }, get: async (n) => store.get(n), getIfExists: async (n) => store.get(n) ?? null, remove: async (n) => { store.delete(n) }}
	await db.pool.query("UPDATE service_setting SET free_period_until = '2027-01-31' WHERE id = 1")
	await secrets.set('programme-llm-anthropic', 'programme-key')
	await db.pool.query(`INSERT INTO programme_llm_credential (provider, model, secret_name, last_four) VALUES ('anthropic', 'claude-sonnet-5-5', 'programme-llm-anthropic', 'abcd')`)
})
after(async () => { await db?.drop() })

const q = (sql, params) => db.pool.query(sql, params)
// A company with a profile and its own key, and optionally a plan.
const company = async (name, plan = null, status = 'active') => {
	const {rows: [c]} = await q('INSERT INTO company (name) VALUES ($1) RETURNING id', [name])
	await q(`INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, 1, 'Care visit planning.', ARRAY['NI', 'UK'])`, [c.id])
	await secrets.set(secretNameFor(c.id), `key-for-${name}`)
	await q(`INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four) VALUES ($1, 'anthropic', 'claude-sonnet-5-5', $2, 'abcd')`, [c.id, secretNameFor(c.id)])
	if (plan) await q(`INSERT INTO company_billing (company_id, stripe_customer_id, stripe_subscription_id, plan, billing_interval, status)
		VALUES ($1, $2, $3, $4, 'month', $5)`, [c.id, `cus_${name}`, `sub_${name}`, plan, status])
	return c.id
}
const run = async (id, now) => {
	keysUsed = new Set()
	const {outcomes} = await runFirstReports({pool: worker, secrets, blobs, fetchers, mailer: createOutboxMailer({environment: 'test'}), appUrl: 'http://app.test',
		emailFor: weeklyReportEmail, now, providers: () => provider})
	const {rows: [r]} = await q('SELECT status, skip_reason, paid_by FROM search_run WHERE company_id = $1 ORDER BY started_at DESC NULLS LAST LIMIT 1', [id])
	return {outcome: outcomes[id], run: r, keys: [...keysUsed]}
}
// Wednesday 3 Feb 2027: the week of 1 Feb, the first after the free period.
const AFTER = new Date('2027-02-03T10:00:00Z')

test('BEH-017 after the free period, a subscriber runs on the programme key', async () => {
	const id = await company('Subscriber', 'subscription')
	const {outcome, run: r, keys} = await run(id, AFTER)
	assert.equal(outcome.status, 'succeeded')
	assert.equal(r.paid_by, 'programme')
	assert.deepEqual(keys, ['programme-key'])
})

test('BEH-017 after the free period, an own-key company runs on its own key', async () => {
	const id = await company('OwnKey', 'own_key')
	const {outcome, run: r, keys} = await run(id, AFTER)
	assert.equal(outcome.status, 'succeeded')
	assert.equal(r.paid_by, 'company')
	assert.deepEqual(keys, ['key-for-OwnKey'])
})

test('BEH-017 a card payment being retried keeps the runs going', async () => {
	const id = await company('Retrying', 'subscription', 'past_due')
	assert.equal((await run(id, AFTER)).outcome.status, 'succeeded')
})

test('BEH-017 without a live plan the run is skipped, even with a working key, and tried again once a plan starts', async () => {
	const none = await company('NoPlan')
	const cancelled = await company('Cancelled', 'own_key', 'canceled')
	const unpaid = await company('Unpaid', 'subscription', 'unpaid')
	for (const id of [none, cancelled, unpaid]) {
		const {outcome, run: r, keys} = await run(id, AFTER)
		assert.deepEqual([outcome.status, outcome.reason, r.skip_reason], ['skipped', 'no_plan', 'no_plan'])
		assert.deepEqual(keys, [])
	}
	await q("UPDATE company_billing SET status = 'active' WHERE company_id = $1", [cancelled])
	assert.equal((await run(cancelled, AFTER)).outcome.status, 'succeeded')
})

test('BEH-017 in the free period a company runs on the programme key whatever its plan', async () => {
	const id = await company('EarlyBird', 'own_key', 'trialing')
	const {outcome, run: r} = await run(id, new Date('2027-01-27T10:00:00Z'))
	assert.equal(outcome.status, 'succeeded')
	assert.equal(r.paid_by, 'programme')
})
