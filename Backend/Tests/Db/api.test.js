// API behaviour against a real, freshly migrated local database, with fakes
// for mail, the secret store, blobs and the provider key check.
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createApp} from '../../API/App.js'
import {createOutboxMailer} from '../../Services/Mail.js'
import {createMemoryStore, secretNameFor} from '../../Services/SecretStore.js'

const APP = 'http://app.test'
const GOOD_KEY = 'sk-ant-test-key-0000000000000000wxyz'
let db, server, base, mailer, secrets, keyChecks

const logs = []
const realLog = console.log

before(async () => {
	db = await createTestDatabase()
	await seedApprovedModels(db.pool)
	mailer = createOutboxMailer({environment: 'test'})
	secrets = createMemoryStore({environment: 'test'})
	keyChecks = []
	const blobs = {kind: 'fake', downloadUrl: async (name, fileName) => ({url: `https://blob.test/${name}?sas=1`, fileName, expiresAt: 'soon'})}
	const checkKey = async (provider, key) => { keyChecks.push(provider); return key == GOOD_KEY ? 'valid' : 'invalid' }
	// The app runs as the API's runtime role; setup uses the owner pool.
	const app = createApp({pool: await db.rolePool('of_api'), mailer, secrets, blobs, checkKey, appUrl: APP, secureCookies: false, rateLimits: {perIp: 1000, perEmail: 1000}})
	console.log = (line) => logs.push(String(line))
	server = app.listen(0)
	base = `http://127.0.0.1:${server.address().port}/api`
})

after(async () => {
	console.log = realLog
	server?.close()
	await db?.drop()
})

const call = async (method, path, {cookie, body, origin = APP} = {}) => {
	const response = await fetch(`${base}${path}`, {method, headers: {
		...(body ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {}), ...(origin ? {origin} : {})},
		body: body ? JSON.stringify(body) : undefined})
	const json = response.status == 204 ? null : await response.json()
	return {status: response.status, json, headers: response.headers}
}

const tokenFromLastMail = () => mailer.outbox.at(-1).text.match(/#token=([\w-]+)/)[1]

const signIn = async (address) => {
	const before = mailer.outbox.length
	await call('POST', '/auth/request-link', {body: {email: address}})
	assert.equal(mailer.outbox.length, before + 1, `no sign-in mail for ${address}`)
	const r = await call('POST', '/auth/verify', {body: {token: tokenFromLastMail()}})
	assert.equal(r.status, 200)
	return r.headers.get('set-cookie').split(';')[0]
}

let admin, alice, bob, member, companyA, companyB

test('setup: programme admin creates two companies and invites their admins (INF-001)', async () => {
	const {rows} = await db.pool.query("INSERT INTO app_user (email) VALUES ('ops@thedatainnovationhub.com') RETURNING id")
	await db.pool.query('INSERT INTO programme_admin (user_id) VALUES ($1)', [rows[0].id])
	admin = await signIn('ops@thedatainnovationhub.com')
	companyA = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Care Routing Ltd'}})).json.company.id
	companyB = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Other Co'}})).json.company.id
	for (const [company, address] of [[companyA, 'alice@care.example'], [companyB, 'bob@other.example']]) {
		const r = await call('POST', `/admin/companies/${company}/invitations`, {cookie: admin, body: {email: address}})
		assert.equal(r.status, 201)
	}
	const invite = mailer.outbox.at(-1)
	assert.match(invite.subject, /Other Co/)
	const r = await call('POST', '/auth/verify', {body: {token: tokenFromLastMail()}})
	assert.equal(r.status, 200)
	bob = r.headers.get('set-cookie').split(';')[0]
	alice = await signIn('alice@care.example')
})

test('DEC-001 a sign-in link works once', async () => {
	await call('POST', '/auth/request-link', {body: {email: 'alice@care.example'}})
	const token = tokenFromLastMail()
	assert.equal((await call('POST', '/auth/verify', {body: {token}})).status, 200)
	const again = await call('POST', '/auth/verify', {body: {token}})
	assert.equal(again.status, 400)
	assert.equal(again.json.error.code, 'link_invalid')
})

test('DEC-001 an expired link is refused', async () => {
	await call('POST', '/auth/request-link', {body: {email: 'alice@care.example'}})
	const token = tokenFromLastMail()
	await db.pool.query("UPDATE sign_in_token SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute' WHERE used_at IS NULL")
	assert.equal((await call('POST', '/auth/verify', {body: {token}})).status, 400)
})

test('SEC-003 request-link does not reveal whether an address has an account', async () => {
	const before = mailer.outbox.length
	const unknown = await call('POST', '/auth/request-link', {body: {email: 'stranger@example.com'}})
	const known = await call('POST', '/auth/request-link', {body: {email: 'Alice@Care.example'}})
	assert.deepEqual([unknown.status, unknown.json], [known.status, known.json])
	assert.equal(mailer.outbox.length, before + 1)
})

test('SEC-003 sessions: no cookie is 401; sign-out revokes the session', async () => {
	assert.equal((await call('GET', '/me')).status, 401)
	const temp = await signIn('alice@care.example')
	assert.equal((await call('GET', '/me', {cookie: temp})).status, 200)
	await call('POST', '/auth/sign-out', {cookie: temp})
	assert.equal((await call('GET', '/me', {cookie: temp})).status, 401)
})

test('SEC-003 state-changing requests from another origin are refused', async () => {
	const r = await call('PUT', `/companies/${companyA}/profile`, {cookie: alice, origin: 'https://evil.example', body: {product_description: 'x'.repeat(30)}})
	assert.equal(r.status, 403)
	assert.equal(r.json.error.code, 'bad_origin')
	assert.equal((await call('POST', '/auth/sign-out', {cookie: alice, origin: null})).status, 403)
})

test('BEH-001 company admin saves the profile as a new version each time', async () => {
	const body = {product_description: 'Software that plans and routes domiciliary care visits.', regions: ['NI', 'UK'], sectors: ['health', 'digital'], cpv_prefixes: ['48']}
	const first = await call('PUT', `/companies/${companyA}/profile`, {cookie: alice, body})
	assert.equal(first.status, 200)
	assert.equal(first.json.profile.version, 1)
	const second = await call('PUT', `/companies/${companyA}/profile`, {cookie: alice, body: {...body, regions: ['IE', 'NI']}})
	assert.equal(second.json.profile.version, 2)
	const got = await call('GET', `/companies/${companyA}/profile`, {cookie: alice})
	assert.deepEqual(got.json.profile.regions, ['NI', 'IE'])
	for (const regions of [['FR'], ['NI'], ['UK'], ['IE', 'UK'], []]) {
		const bad = await call('PUT', `/companies/${companyA}/profile`, {cookie: alice, body: {...body, regions}})
		assert.equal(bad.status, 400, JSON.stringify(regions))
		assert.equal(bad.json.error.code, 'invalid_request')
	}
})

test('SEC-001 another company\'s data is 404, whatever the route', async () => {
	for (const path of [`/companies/${companyA}/profile`, `/companies/${companyA}/reports`, `/companies/${companyA}/llm-credential`,
		`/companies/${companyA}/members`, `/companies/${companyA}/opportunities`, '/companies/not-a-uuid/profile']) {
		const r = await call('GET', path, {cookie: bob})
		assert.equal(r.status, 404, path)
	}
	const write = await call('PUT', `/companies/${companyA}/profile`, {cookie: bob, body: {product_description: 'Overwriting someone else.'.padEnd(40, '.')}})
	assert.equal(write.status, 404)
})

test('SEC-001 a report id from another company is 404 even with a valid membership', async () => {
	const runId = await seedReport(companyB)
	const {rows} = await db.pool.query('SELECT id FROM report WHERE search_run_id = $1', [runId])
	assert.equal((await call('GET', `/companies/${companyA}/reports/${rows[0].id}`, {cookie: alice})).status, 404)
	assert.equal((await call('GET', `/companies/${companyA}/reports/${rows[0].id}/download`, {cookie: alice})).status, 404)
	const own = await call('GET', `/companies/${companyB}/reports/${rows[0].id}/download`, {cookie: bob})
	assert.equal(own.status, 200)
	assert.match(own.json.url, /^https:\/\/blob\.test\//)
	const list = await call('GET', `/companies/${companyB}/opportunities?kind=funding`, {cookie: bob})
	assert.equal(list.json.rows.length, 1)
	assert.equal(list.json.rows[0].name, 'Smart Grant')
})

test('INF-002 company admin invites a member; members can read but not edit', async () => {
	const r = await call('POST', `/companies/${companyA}/members`, {cookie: alice, body: {email: 'carol@care.example', role: 'company_member'}})
	assert.equal(r.status, 201)
	member = (await call('POST', '/auth/verify', {body: {token: tokenFromLastMail()}})).headers.get('set-cookie').split(';')[0]
	assert.equal((await call('GET', `/companies/${companyA}/profile`, {cookie: member})).status, 200)
	assert.equal((await call('PUT', `/companies/${companyA}/profile`, {cookie: member, body: {product_description: 'x'.repeat(30)}})).status, 403)
	assert.equal((await call('POST', `/companies/${companyA}/members`, {cookie: member, body: {email: 'dave@care.example'}})).status, 403)
	const me = await call('GET', '/me', {cookie: member})
	assert.deepEqual(me.json.companies.map((c) => c.role), ['company_member'])
})

test('INF-002 the last company admin cannot be removed', async () => {
	const {rows} = await db.pool.query("SELECT id FROM app_user WHERE email = 'alice@care.example'")
	const r = await call('DELETE', `/companies/${companyA}/members/${rows[0].id}`, {cookie: alice})
	assert.equal(r.status, 409)
	assert.equal(r.json.error.code, 'last_admin')
})

test('SEC-002 a key is checked, stored only in the secret store, and never returned or logged', async () => {
	const rejected = await call('PUT', `/companies/${companyA}/llm-credential`, {cookie: alice, body: {provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-wrong-key-000000000000000000'}})
	assert.equal(rejected.status, 400)
	assert.equal(rejected.json.error.code, 'key_rejected')
	const notApproved = await call('PUT', `/companies/${companyA}/llm-credential`, {cookie: alice, body: {provider: 'anthropic', model: 'claude-old', apiKey: GOOD_KEY}})
	assert.equal(notApproved.status, 400)
	const saved = await call('PUT', `/companies/${companyA}/llm-credential`, {cookie: alice, body: {provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: GOOD_KEY}})
	assert.equal(saved.status, 200)
	assert.equal(saved.json.credential.lastFour, 'wxyz')
	assert.equal(await secrets.get(secretNameFor(companyA)), GOOD_KEY)
	const {rows} = await db.pool.query('SELECT row_to_json(c)::text AS row FROM company_llm_credential c')
	assert.ok(!rows[0].row.includes(GOOD_KEY))
	assert.ok(!JSON.stringify(saved.json).includes(GOOD_KEY))
	assert.ok(!logs.some((line) => line.includes(GOOD_KEY)), 'key appeared in a log line')
	// Members see status only, not which key.
	const asMember = await call('GET', `/companies/${companyA}/llm-credential`, {cookie: member})
	assert.deepEqual(Object.keys(asMember.json.credential).sort(), ['configured', 'model', 'provider', 'status'])
	assert.equal((await call('PUT', `/companies/${companyA}/llm-credential`, {cookie: member, body: {provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: GOOD_KEY}})).status, 403)
	const removed = await call('DELETE', `/companies/${companyA}/llm-credential`, {cookie: alice})
	assert.equal(removed.json.credential.configured, false)
	await assert.rejects(secrets.get(secretNameFor(companyA)))
})

test('INF-003 programme admins see summaries, never a company\'s profile or report', async () => {
	assert.equal((await call('GET', `/companies/${companyA}/profile`, {cookie: admin})).status, 404)
	const runs = await call('GET', '/admin/runs', {cookie: admin})
	assert.equal(runs.status, 200)
	const text = JSON.stringify(runs.json)
	assert.ok(!text.includes('Smart Grant'), 'report content leaked into the admin summary')
	assert.equal(runs.json.runs[0].funding_rows, 1)
	const companies = await call('GET', '/admin/companies', {cookie: admin})
	assert.ok(!JSON.stringify(companies.json).includes('domiciliary'))
	assert.equal((await call('GET', '/admin/companies', {cookie: alice})).status, 403)
})

test('BEH-012 the cost card shows Brave and Azure, this week and in total', async () => {
	await db.pool.query("INSERT INTO azure_cost_daily (day, amount, currency) VALUES (current_date - 1, 3.50, 'USD'), (current_date - 30, 10, 'USD')")
	const r = await call('GET', '/admin/service-cost', {cookie: admin})
	assert.equal(r.status, 200)
	assert.equal(r.json.brave.week, 0.18)
	assert.equal(r.json.brave.weekQueries, 35)
	assert.equal(r.json.azure.lastSevenDays, 3.5)
	assert.equal(r.json.azure.total, 13.5)
	assert.equal(r.json.combined.total, 13.68)
	assert.equal(r.json.reviewDate.slice(0, 10), '2027-01-25')
	assert.equal(r.json.weekly.length, 13)
	assert.equal((await call('GET', '/admin/service-cost', {cookie: alice})).status, 403)
})

test('BEH-013 an admin can switch search off; the change is audited', async () => {
	const r = await call('PUT', '/admin/service-settings', {cookie: admin, body: {searchEnabled: false, bravePricePer1000Usd: 5, monthlyQueryCap: 5000, reviewDate: '2027-01-25'}})
	assert.equal(r.status, 200)
	assert.equal(r.json.settings.searchEnabled, false)
	const {rows} = await db.pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action = 'service_settings.updated'")
	assert.equal(rows[0].n, 1)
	assert.equal((await call('PUT', '/admin/service-settings', {cookie: admin, body: {searchEnabled: 'no'}})).status, 400)
})

test('INF-001 a programme admin can rename a company; the rename is audited', async () => {
	const r = await call('PATCH', `/admin/companies/${companyB}`, {cookie: admin, body: {name: 'Other Co Ltd'}})
	assert.equal(r.status, 200)
	assert.deepEqual([r.json.company.name, r.json.company.status], ['Other Co Ltd', 'active'])
	const {rows} = await db.pool.query("SELECT detail FROM audit_event WHERE action = 'company.renamed' AND company_id = $1", [companyB])
	assert.deepEqual(rows.map((e) => e.detail), [{from: 'Other Co', to: 'Other Co Ltd'}])
	assert.equal((await call('PATCH', `/admin/companies/${companyB}`, {cookie: admin, body: {name: 'Care Routing Ltd'}})).status, 409)
	assert.equal((await call('PATCH', `/admin/companies/${companyB}`, {cookie: admin, body: {name: '  '}})).status, 400)
	assert.equal((await call('PATCH', `/admin/companies/${companyB}`, {cookie: admin, body: {}})).status, 400)
	assert.equal((await call('PATCH', `/admin/companies/${companyB}`, {cookie: bob, body: {name: 'Mine now'}})).status, 403)
	assert.equal((await call('PATCH', `/admin/companies/${companyB}`, {cookie: admin, body: {name: 'Other Co'}})).status, 200)
})

test('INF-003 a programme admin cannot invite themselves into a company (review finding 1)', async () => {
	const r = await call('POST', `/admin/companies/${companyA}/invitations`, {cookie: admin, body: {email: 'ops@thedatainnovationhub.com'}})
	assert.equal(r.status, 409)
	assert.equal(r.json.error.code, 'programme_admin')
	assert.equal((await call('GET', `/companies/${companyA}/profile`, {cookie: admin})).status, 404)
})

test('INF-002 re-sending an invitation never changes an existing member\'s role (review finding 5)', async () => {
	const r = await call('POST', `/companies/${companyA}/members`, {cookie: alice, body: {email: 'alice@care.example', role: 'company_member'}})
	assert.equal(r.status, 201)
	assert.equal(r.json.member.role, 'company_admin')
	const {rows} = await db.pool.query("SELECT m.role FROM company_membership m JOIN app_user u ON u.id = m.user_id WHERE u.email = 'alice@care.example'")
	assert.equal(rows[0].role, 'company_admin')
})

test('invalid calendar dates are a 400, not a 500 (review finding 8)', async () => {
	const r = await call('GET', `/companies/${companyA}/reports?before=2026-02-30`, {cookie: alice})
	assert.equal(r.status, 400)
	const s = await call('PUT', '/admin/service-settings', {cookie: admin, body: {searchEnabled: true, bravePricePer1000Usd: 5, monthlyQueryCap: 10, reviewDate: '2027-02-30'}})
	assert.equal(s.status, 400)
})

test('a malformed body is not quoted in the logs (review finding 10)', async () => {
	const response = await fetch(`${base}/companies/${companyA}/llm-credential`, {method: 'PUT',
		headers: {'content-type': 'application/json', cookie: alice, origin: APP}, body: '{"apiKey":sk-ant-secretish'})
	assert.equal(response.status, 400)
	assert.ok(!logs.some((line) => line.includes('secretish')), 'request body text reached the log')
})

test('errors use one envelope and never include database detail', async () => {
	const dup = await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Care Routing Ltd'}})
	assert.equal(dup.status, 409)
	assert.deepEqual(Object.keys(dup.json.error), ['code', 'message'])
	assert.ok(!/uq_company_name|duplicate key/.test(dup.json.error.message))
	const unknown = await call('GET', '/nope', {cookie: alice})
	assert.equal(unknown.status, 404)
	assert.equal(unknown.json.error.code, 'not_found')
})

// A succeeded run with one funding row and its report, as the worker writes them.
async function seedReport(companyId) {
	const week = '2026-10-26'
	await db.pool.query("INSERT INTO weekly_gather (week_start, status) VALUES ($1, 'succeeded') ON CONFLICT DO NOTHING", [week])
	const {rows: [p]} = await db.pool.query(`INSERT INTO company_profile (company_id, version, product_description) VALUES ($1, 1, 'Seeded profile for a report test.') RETURNING id`, [companyId])
	const {rows: [run]} = await db.pool.query(`INSERT INTO search_run (company_id, week_start, profile_id, status, provider, model, search_queries, search_cost_usd, model_cost_usd)
		VALUES ($1, $2, $3, 'succeeded', 'anthropic', 'claude-sonnet-5-5', 35, 0.175, 3.97) RETURNING id`, [companyId, week, p.id])
	const {rows: [report]} = await db.pool.query(`INSERT INTO report (company_id, search_run_id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note)
		VALUES ($1, $2, $3, 'reports/x.xlsx', 1, 0, 1, '[]', '[]', '[]', '') RETURNING id`, [companyId, run.id, week])
	await db.pool.query(`INSERT INTO report_row (company_id, report_id, kind, region, name, status, new_this_week, row_data)
		VALUES ($1, $2, 'funding', 'UK', 'Smart Grant', 'Open', true, '{}')`, [companyId, report.id])
	return run.id
}

test('DEC-011 the programme key is admin-only, checked, kept only in the secret store, and never returned or logged', async () => {
	const body = (apiKey) => ({provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey})
	assert.equal((await call('GET', '/admin/programme-key', {cookie: alice})).status, 403)
	assert.equal((await call('PUT', '/admin/programme-key/credential', {cookie: alice, body: body(GOOD_KEY)})).status, 403)
	const rejected = await call('PUT', '/admin/programme-key/credential', {cookie: admin, body: body('sk-ant-wrong-key-000000000000000000')})
	assert.equal(rejected.json.error.code, 'key_rejected')
	const saved = await call('PUT', '/admin/programme-key/credential', {cookie: admin, body: body(GOOD_KEY)})
	assert.equal(saved.status, 200)
	assert.deepEqual([saved.json.credential.lastFour, saved.json.credential.status], ['wxyz', 'valid'])
	assert.equal(await secrets.get('programme-llm-anthropic'), GOOD_KEY)
	const {rows} = await db.pool.query('SELECT row_to_json(p)::text AS row FROM programme_llm_credential p')
	assert.ok(!rows[0].row.includes(GOOD_KEY))
	assert.ok(!JSON.stringify(saved.json).includes(GOOD_KEY))
	assert.ok(!logs.some((line) => line.includes(GOOD_KEY)), 'key appeared in a log line')
	const {rows: audited} = await db.pool.query("SELECT detail::text FROM audit_event WHERE action = 'programme_key.saved'")
	assert.equal(audited.length, 1)
	assert.ok(!audited[0].detail.includes(GOOD_KEY))
	const removed = await call('DELETE', '/admin/programme-key/credential', {cookie: admin})
	assert.equal(removed.json.credential.configured, false)
	await assert.rejects(secrets.get('programme-llm-anthropic'))
})

test('DEC-011 companies see only the free period end date; the cost card counts the programme model cost', async () => {
	assert.equal((await call('PUT', '/admin/programme-key/settings', {cookie: admin, body: {freePeriodUntil: '2027-02-30', monthlyCapUsd: 100}})).status, 400)
	assert.equal((await call('PUT', '/admin/programme-key/settings', {cookie: admin, body: {freePeriodUntil: '2027-01-31', monthlyCapUsd: -1}})).status, 400)
	assert.equal((await call('PUT', '/admin/programme-key/settings', {cookie: alice, body: {freePeriodUntil: '2027-01-31', monthlyCapUsd: 100}})).status, 403)
	const set = await call('PUT', '/admin/programme-key/settings', {cookie: admin, body: {freePeriodUntil: '2027-01-31', monthlyCapUsd: 150}})
	assert.deepEqual([set.json.freePeriodUntil, set.json.monthlyCapUsd], ['2027-01-31', 150])
	const me = await call('GET', '/me', {cookie: alice})
	// The end date and whether the programme key works; never an amount.
	assert.deepEqual(me.json.freePeriod, {until: '2027-01-31', keyWorking: false})
	// DEC-014: whether each company has a plan for after it, for the notice.
	assert.deepEqual(me.json.companies.map((c) => c.hasPlan), me.json.companies.map(() => false))
	await db.pool.query(`INSERT INTO company_billing (company_id, stripe_customer_id, stripe_subscription_id, plan, billing_interval, status)
		VALUES ($1, 'cus_me', 'sub_me', 'own_key', 'month', 'active')`, [companyA])
	assert.equal((await call('GET', '/me', {cookie: alice})).json.companies.find((c) => c.id == companyA).hasPlan, true)
	await db.pool.query("UPDATE company_billing SET status = 'canceled' WHERE company_id = $1", [companyA])
	assert.equal((await call('GET', '/me', {cookie: alice})).json.companies.find((c) => c.id == companyA).hasPlan, false)
	await db.pool.query('DELETE FROM company_billing WHERE company_id = $1', [companyA])
	const cred = await call('GET', `/companies/${companyA}/llm-credential`, {cookie: alice})
	assert.equal(cred.json.programmeSkip, null)
	await db.pool.query("INSERT INTO weekly_gather (week_start) VALUES ('2027-01-04') ON CONFLICT DO NOTHING")
	const {rows: [run]} = await db.pool.query("INSERT INTO search_run (company_id, week_start, status, skip_reason, finished_at) VALUES ($1, '2027-01-04', 'skipped', 'programme_budget_reached', now()) RETURNING id", [companyA])
	const skipped = await call('GET', `/companies/${companyA}/llm-credential`, {cookie: member})
	assert.deepEqual(skipped.json.programmeSkip, {week: '2027-01-04', reason: 'programme_budget_reached'})
	assert.ok(!JSON.stringify(skipped.json).match(/usd|cost|cap/i), 'spend leaked to a company')
	await db.pool.query('DELETE FROM search_run WHERE id = $1', [run.id])

	const before = (await call('GET', '/admin/service-cost', {cookie: admin})).json
	const {rows: [c]} = await db.pool.query("INSERT INTO company (name) VALUES ('Free Co') RETURNING id")
	await db.pool.query(`INSERT INTO search_run (company_id, week_start, status, started_at, finished_at, paid_by, model_cost_usd)
		VALUES ($1, $2, 'succeeded', now(), now(), 'programme', 2.25)`, [c.id, before.latestWeek])
	const after = (await call('GET', '/admin/service-cost', {cookie: admin})).json
	assert.deepEqual([after.programmeModel.week, after.programmeModel.month, after.programmeModel.monthlyCapUsd, after.programmeModel.freePeriodUntil], [2.25, 2.25, 150, '2027-01-31'])
	assert.equal(after.combined.total, Math.round((before.combined.total + 2.25) * 100) / 100)

	await call('PUT', '/admin/programme-key/settings', {cookie: admin, body: {freePeriodUntil: null, monthlyCapUsd: 150}})
	assert.equal((await call('GET', '/me', {cookie: alice})).json.freePeriod, null)
	const {rows: audited} = await db.pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action = 'free_period.updated'")
	assert.equal(audited[0].n, 2)
})
