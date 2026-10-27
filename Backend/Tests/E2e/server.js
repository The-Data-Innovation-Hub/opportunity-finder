// Server for the browser end-to-end test (`npm run test:e2e` at the repo
// root). It creates a disposable local database, seeds it through the API
// as a programme admin would, and serves the built frontend from the same
// origin as the API, as Azure does. Mail goes to an outbox the test reads
// through /__e2e/last-link; that route exists only in this file.
import express from 'express'
import {fileURLToPath} from 'node:url'
import {createTestDatabase} from '../Db/harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createApp} from '../../API/App.js'
import {createOutboxMailer} from '../../Services/Mail.js'
import {createMemoryStore} from '../../Services/SecretStore.js'

const PORT = Number(process.env.E2E_PORT ?? 4173)
const APP = `http://localhost:${PORT}`
const WEEK = '2026-10-26'

const db = await createTestDatabase()
await seedApprovedModels(db.pool)
const mailer = createOutboxMailer({environment: 'test'})
const app = createApp({
	pool: await db.rolePool('of_api'),
	mailer,
	secrets: createMemoryStore({environment: 'test'}),
	blobs: {kind: 'fake', downloadUrl: async (name, fileName) => ({url: `${APP}/__e2e/blob/${name}`, fileName, expiresAt: 'soon'})},
	checkKey: async () => 'valid',
	appUrl: APP,
	secureCookies: false,
	frontendDir: fileURLToPath(new URL('../../../dist', import.meta.url)),
	rateLimits: {perIp: 1000, perEmail: 1000},
})

const outer = express()
outer.get('/__e2e/last-link', (request, response) => {
	const text = mailer.outbox.at(-1)?.text ?? ''
	response.json({link: text.match(/https?:\/\/\S+#token=[\w-]+/)?.[0] ?? null})
})
outer.use(app)

// Seed on a private port first, so the test's port only opens once the
// data is in place.
const seeding = outer.listen(0)
await new Promise((resolve) => seeding.once('listening', resolve))
const seedUrl = `http://127.0.0.1:${seeding.address().port}`

// Seed through the API: a programme admin creates the company and invites
// its founder, then a finished weekly run is written as the worker would.
const call = async (method, path, {cookie, body} = {}) => {
	const response = await fetch(`${seedUrl}/api${path}`, {method, headers: {origin: APP, ...(body ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {})},
		body: body ? JSON.stringify(body) : undefined})
	return {json: response.status == 204 ? null : await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0]}
}
const token = () => mailer.outbox.at(-1).text.match(/#token=([\w-]+)/)[1]
const {rows: [ops]} = await db.pool.query("INSERT INTO app_user (email) VALUES ('ops@example.test') RETURNING id")
await db.pool.query('INSERT INTO programme_admin (user_id) VALUES ($1)', [ops.id])
await call('POST', '/auth/request-link', {body: {email: 'ops@example.test'}})
const admin = (await call('POST', '/auth/verify', {body: {token: token()}})).cookie
const company = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Care Routing Ltd'}})).json.company.id
await call('POST', `/admin/companies/${company}/invitations`, {cookie: admin, body: {email: 'founder@example.test', role: 'company_admin'}})

await db.pool.query("INSERT INTO weekly_gather (week_start, status) VALUES ($1, 'succeeded')", [WEEK])
const {rows: [profile]} = await db.pool.query("INSERT INTO company_profile (company_id, version, product_description) VALUES ($1, 1, 'Routing software for home care providers.') RETURNING id", [company])
const {rows: [run]} = await db.pool.query(`INSERT INTO search_run (company_id, week_start, profile_id, status, provider, model, search_queries, search_cost_usd, model_cost_usd)
	VALUES ($1, $2, $3, 'succeeded', 'anthropic', 'claude-sonnet-5-5', 35, 0.175, 3.97) RETURNING id`, [company, WEEK, profile.id])
const {rows: [report]} = await db.pool.query(`INSERT INTO report (company_id, search_run_id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note)
	VALUES ($1, $2, $3, 'reports/e2e.xlsx', 2, 1, 1, $4, '[]', '[]', 'Synthetic end-to-end data.') RETURNING id`,
	[company, run.id, WEEK, JSON.stringify([{rank: 1, name: 'Smart Grant', why_top_pick: 'Funds routing software at TRL 5-6.', amount: '£100,000', deadline: null, practical_steps: 'Apply online.'}])])
await db.pool.query(`INSERT INTO report_row (company_id, report_id, kind, region, name, status, new_this_week, row_data) VALUES
	($1, $2, 'funding', 'UK', 'Smart Grant', 'Open', true, '{"funder": "Innovate UK"}'),
	($1, $2, 'funding', 'IE', 'Net Zero Fund', 'Rolling', false, '{"funder": "Enterprise Ireland"}'),
	($1, $2, 'tender', 'UK', 'Care Routing Tender', 'Open', false, '{"buyer": "Health Trust"}')`, [company, report.id])
seeding.close()
const server = outer.listen(PORT, () => console.log(`[e2e] ready on ${APP}`))

const stop = () => server.close(async () => {
	await db.drop()
	process.exit(0)
})
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
