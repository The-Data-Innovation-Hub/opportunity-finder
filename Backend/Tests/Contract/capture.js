// API contract capture (TYP-001). Seeds a disposable local database, calls
// every route the frontend reads, and writes the real responses as a
// TypeScript file that must satisfy the frontend's `Responses` map in
// src/api.ts. `npm run test:contract` at the repo root runs this, then type
// checks the result: a field the backend renames, drops or retypes fails the
// check. Each route is called in the states the pages handle (no key and a
// key, no free period and one).
import {writeFile, mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createTestDatabase} from '../Db/harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createApp} from '../../API/App.js'
import {createOutboxMailer} from '../../Services/Mail.js'
import {createMemoryStore} from '../../Services/SecretStore.js'
import {createFakeBilling} from '../../Services/Billing.js'

const OUT = fileURLToPath(new URL('../../../contract/responses.generated.ts', import.meta.url))
const APP = 'http://localhost:4174'
const WEEK = '2026-10-26'

// The API logs every request; only this script's own summary is wanted.
const print = console.log
console.log = () => {}
const db = await createTestDatabase()
const samples = {}
try {
	await seedApprovedModels(db.pool)
	const mailer = createOutboxMailer({environment: 'test'})
	const billing = createFakeBilling()
	const app = createApp({
		pool: await db.rolePool('of_api'),
		mailer,
		secrets: createMemoryStore({environment: 'test'}),
		blobs: {kind: 'fake', downloadUrl: async (name, fileName) => ({url: `${APP}/blobs/${name}`, fileName, expiresAt: 'soon'})},
		checkKey: async () => 'valid',
		billing,
		appUrl: APP,
		secureCookies: false,
		rateLimits: {perIp: 1000, perEmail: 1000},
	})
	const server = app.listen(0)
	await new Promise((resolve) => server.once('listening', resolve))
	const base = `http://127.0.0.1:${server.address().port}/api`
	try {
		const send = async (method, path, {cookie, body} = {}) => {
			const response = await fetch(`${base}${path}`, {method, headers: {origin: APP, ...(body ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {})},
				body: body ? JSON.stringify(body) : undefined})
			const json = response.status == 204 ? null : await response.json()
			if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(json)}`)
			return {json, cookie: response.headers.get('set-cookie')?.split(';')[0]}
		}
		// Calls a route and keeps its response under the route's name.
		const capture = async (route, path, options) => {
			const {json} = await send(route.split(' ')[0], path, options)
			;(samples[route] ??= []).push(json)
			return json
		}
		const signIn = async (address) => {
			await send('POST', '/auth/request-link', {body: {email: address}})
			const token = mailer.outbox.at(-1).text.match(/#token=([\w-]+)/)[1]
			return (await send('POST', '/auth/verify', {body: {token}})).cookie
		}
		const key = {provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-contract-test-0000'}

		const {rows: [ops]} = await db.pool.query("INSERT INTO app_user (email) VALUES ('ops@example.test') RETURNING id")
		await db.pool.query('INSERT INTO programme_admin (user_id) VALUES ($1)', [ops.id])
		const admin = await signIn('ops@example.test')
		const company = (await capture('POST /admin/companies', '/admin/companies', {cookie: admin, body: {name: 'Care Routing Ltd'}})).company.id
		await send('POST', `/admin/companies/${company}/invitations`, {cookie: admin, body: {email: 'founder@example.test', role: 'company_admin'}})
		const founder = await signIn('founder@example.test')
		const c = `/companies/${company}`

		// Before anything is set up.
		await capture('GET /me', '/me', {cookie: founder})
		await capture('GET /companies/:companyId/profile', `${c}/profile`, {cookie: founder})
		await capture('GET /companies/:companyId/reports', `${c}/reports`, {cookie: founder})
		await capture('GET /companies/:companyId/llm-credential', `${c}/llm-credential`, {cookie: founder})
		await capture('GET /companies/:companyId/billing', `${c}/billing`, {cookie: founder})
		await capture('GET /companies/:companyId/opportunities', `${c}/opportunities`, {cookie: founder})
		await capture('GET /admin/programme-key', '/admin/programme-key', {cookie: admin})
		await capture('GET /admin/service-cost', '/admin/service-cost', {cookie: admin})
		await capture('GET /admin/runs', '/admin/runs', {cookie: admin})

		await capture('GET /models', '/models', {cookie: founder})
		await capture('PUT /companies/:companyId/profile', `${c}/profile`, {cookie: founder, body: {product_description: 'Routing software for home care providers.',
			regions: ['NI', 'IE', 'UK'], sectors: ['Health'], tender_keywords: ['care routing'], cpv_prefixes: ['48'], details: {trl: '6'}}})
		await capture('PUT /companies/:companyId/llm-credential', `${c}/llm-credential`, {cookie: founder, body: key})
		await send('POST', `${c}/members`, {cookie: founder, body: {email: 'member@example.test', role: 'company_member'}})
		// DEC-014: a plan bought (checkout is open while no free period is set), as Stripe would report it.
		await capture('POST /companies/:companyId/billing/checkout', `${c}/billing/checkout`, {cookie: founder, body: {plan: 'subscription', interval: 'year'}})
		billing.setSubscription({id: 'sub_contract', customerId: [...billing.customers.keys()][0], interval: 'year', status: 'trialing'})
		await capture('POST /companies/:companyId/billing/sync', `${c}/billing/sync`, {cookie: founder})
		await capture('POST /companies/:companyId/billing/portal', `${c}/billing/portal`, {cookie: founder})
		await capture('PUT /admin/programme-key/credential', '/admin/programme-key/credential', {cookie: admin, body: key})
		await capture('PUT /admin/programme-key/settings', '/admin/programme-key/settings', {cookie: admin, body: {freePeriodUntil: '2099-01-03', monthlyCapUsd: 50}})
		await capture('GET /admin/service-settings', '/admin/service-settings', {cookie: admin})
		const {settings} = await capture('PUT /admin/service-settings', '/admin/service-settings', {cookie: admin, body: {searchEnabled: true,
			bravePricePer1000Usd: 5, monthlyQueryCap: 2000, reviewDate: '2027-01-03'}})

		// A finished weekly run, written as the worker would.
		const {rows: [profile]} = await db.pool.query('SELECT id FROM company_profile WHERE company_id = $1', [company])
		await db.pool.query("INSERT INTO weekly_gather (week_start, status, tender_notices, funder_pages, competitions) VALUES ($1, 'succeeded', 40, 12, 9)", [WEEK])
		const {rows: [run]} = await db.pool.query(`INSERT INTO search_run (company_id, week_start, profile_id, status, provider, model, started_at, finished_at,
			input_tokens, output_tokens, search_queries, search_cost_usd, model_cost_usd)
			VALUES ($1, $2, $3, 'succeeded', 'anthropic', 'claude-sonnet-5-5', now(), now(), 120000, 9000, 35, 0.175, 3.97) RETURNING id`, [company, WEEK, profile.id])
		const {rows: [report]} = await db.pool.query(`INSERT INTO report (company_id, search_run_id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note)
			VALUES ($1, $2, $3, 'reports/contract.xlsx', 2, 1, 1, $4, $5, $6, 'Synthetic contract data.') RETURNING id`,
			[company, run.id, WEEK, JSON.stringify([{rank: 1, name: 'Smart Grant', why_top_pick: 'Funds routing software at TRL 5-6.', amount: '£100,000', deadline: '2026-12-01', practical_steps: 'Apply online.'}]),
				JSON.stringify([{name: 'EIC Accelerator', reason: 'Not a fit this week.', region: 'UK'}]), JSON.stringify(['https://www.ukri.org/'])])
		await db.pool.query(`INSERT INTO report_row (company_id, report_id, kind, region, name, status, new_this_week, row_data) VALUES
			($1, $2, 'funding', 'UK', 'Smart Grant', 'Open', true, '{"funder": "Innovate UK"}'),
			($1, $2, 'tender', 'UK', 'Care Routing Tender', 'Open', false, '{"buyer": "Health Trust"}')`, [company, report.id])

		// After set-up.
		await capture('GET /me', '/me', {cookie: founder})
		await capture('GET /me', '/me', {cookie: admin})
		await capture('GET /companies/:companyId/profile', `${c}/profile`, {cookie: founder})
		await capture('GET /companies/:companyId/reports', `${c}/reports`, {cookie: founder})
		await capture('GET /companies/:companyId/reports/:reportId', `${c}/reports/${report.id}`, {cookie: founder})
		await capture('GET /companies/:companyId/reports/:reportId/download', `${c}/reports/${report.id}/download`, {cookie: founder})
		await capture('GET /companies/:companyId/opportunities', `${c}/opportunities?week=${WEEK}`, {cookie: founder})
		await capture('GET /companies/:companyId/llm-credential', `${c}/llm-credential`, {cookie: founder})
		await capture('GET /companies/:companyId/members', `${c}/members`, {cookie: founder})
		await capture('GET /companies/:companyId/billing', `${c}/billing`, {cookie: founder})
		await capture('GET /admin/companies', '/admin/companies', {cookie: admin})
		await capture('GET /admin/runs', `/admin/runs?week=${WEEK}`, {cookie: admin})
		await capture('GET /admin/service-cost', '/admin/service-cost', {cookie: admin})
		await capture('GET /admin/programme-key', '/admin/programme-key', {cookie: admin})
		await capture('DELETE /companies/:companyId/llm-credential', `${c}/llm-credential`, {cookie: founder})
		await capture('DELETE /admin/programme-key/credential', '/admin/programme-key/credential', {cookie: admin})
		// BEH-019: a request from the landing page, listed and closed by an admin.
		await capture('POST /access-requests', '/access-requests', {body: {companyName: 'Ward Robotics Ltd', contactName: 'Sam Rivera',
			email: 'sam@example.test', cohort: 'not_sure', message: 'Discharge planning software.'}})
		const {requests} = await capture('GET /admin/access-requests', '/admin/access-requests', {cookie: admin})
		await capture('PATCH /admin/access-requests/:id', `/admin/access-requests/${requests[0].id}`, {cookie: admin, body: {handled: true}})
		await capture('GET /admin/access-requests', '/admin/access-requests', {cookie: admin})
		if (!settings.updatedAt) throw new Error('service settings were not saved')
	} finally {
		server.close()
	}
} finally {
	await db.drop()
}

await mkdir(dirname(OUT), {recursive: true})
await writeFile(OUT, `// Generated by Backend/Tests/Contract/capture.js from real API responses. Do not edit.
// Fresh object literals, so a missing, extra or wrongly typed field fails the type check.
import type {Responses} from '../src/api'

export const samples = ${JSON.stringify(samples, null, '\t')} satisfies {[K in keyof Responses]: Responses[K][]}
`)
print(`[contract] ${Object.values(samples).flat().length} responses from ${Object.keys(samples).length} routes written to contract/responses.generated.ts`)
