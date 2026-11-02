// BEH-019: access requests from the public landing page, against a real,
// freshly migrated local database. The app runs as the API's runtime role and
// the cleanup as the worker's, so the grants are tested as well.
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as wait} from 'node:timers/promises'
import {createTestDatabase} from './harness.js'
import {createApp} from '../../API/App.js'
import {createOutboxMailer} from '../../Services/Mail.js'
import {createMemoryStore} from '../../Services/SecretStore.js'
import {ACCESS_REQUEST_DAYS, cleanup} from '../../Worker/Weekly.js'

const APP = 'http://app.test'
let db, server, base, mailer, admin, member

before(async () => {
	db = await createTestDatabase()
	mailer = createOutboxMailer({environment: 'test'})
	const app = createApp({pool: await db.rolePool('of_api'), mailer, secrets: createMemoryStore({environment: 'test'}), blobs: {kind: 'fake'},
		checkKey: async () => 'valid', appUrl: APP, secureCookies: false, rateLimits: {perIp: 1000, perEmail: 1000, accessRequestsPerIp: 7}})
	server = app.listen(0)
	base = `http://127.0.0.1:${server.address().port}/api`
})

after(async () => {
	server?.close()
	await db?.drop()
})

const call = async (method, path, {cookie, body, origin = APP} = {}) => {
	const response = await fetch(`${base}${path}`, {method, headers: {
		...(body ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {}), ...(origin ? {origin} : {})},
		body: body ? JSON.stringify(body) : undefined})
	return {status: response.status, json: response.status == 204 ? null : await response.json(), headers: response.headers}
}

const signIn = async (address) => {
	await call('POST', '/auth/request-link', {body: {email: address}})
	const token = mailer.outbox.at(-1).text.match(/#token=([\w-]+)/)[1]
	const r = await call('POST', '/auth/verify', {body: {token}})
	return r.headers.get('set-cookie').split(';')[0]
}

const request = {companyName: 'Ward Robotics Ltd', contactName: 'Sam Rivera', email: 'sam@wardrobotics.example',
	cohort: 'connected_health_cluster', message: 'We make discharge planning software.'}

test('setup: two programme admins (one disabled) and a company member', async () => {
	const {rows: users} = await db.pool.query(`INSERT INTO app_user (email, disabled_at) VALUES
		('ops@thedatainnovationhub.com', NULL), ('old@thedatainnovationhub.com', now()), ('alice@care.example', NULL) RETURNING id`)
	await db.pool.query('INSERT INTO programme_admin (user_id) VALUES ($1), ($2)', [users[0].id, users[1].id])
	admin = await signIn('ops@thedatainnovationhub.com')
	const {rows: [c]} = await db.pool.query("INSERT INTO company (name) VALUES ('Care Routing Ltd') RETURNING id")
	await db.pool.query("INSERT INTO company_membership (company_id, user_id, role) VALUES ($1, $2, 'company_admin')", [c.id, users[2].id])
	member = await signIn('alice@care.example')
})

test('BEH-019 anyone can ask for access without signing in; each active programme admin is emailed', async () => {
	const before = mailer.outbox.length
	const r = await call('POST', '/access-requests', {body: request})
	assert.deepEqual([r.status, r.json], [202, {received: true}])
	for (let i = 0; i < 50 && mailer.outbox.length == before; i++) await wait(10)
	const sent = mailer.outbox.slice(before)
	assert.deepEqual(sent.map((m) => m.to), ['ops@thedatainnovationhub.com'])
	assert.match(sent[0].subject, /Ward Robotics Ltd/)
	assert.match(sent[0].text, /Connected Health Cluster/)
	assert.match(sent[0].text, /http:\/\/app\.test\/admin/)
	const {rows} = await db.pool.query('SELECT company_name, email, cohort, message, handled_at FROM access_request')
	assert.deepEqual(rows, [{company_name: 'Ward Robotics Ltd', email: 'sam@wardrobotics.example', cohort: 'connected_health_cluster',
		message: 'We make discharge planning software.', handled_at: null}])
})

test('BEH-019 the email escapes what the requester typed', async () => {
	const before = mailer.outbox.length
	await call('POST', '/access-requests', {body: {...request, companyName: '<b>Bold</b> & Co', message: '', cohort: 'not_sure'}})
	for (let i = 0; i < 50 && mailer.outbox.length == before; i++) await wait(10)
	const mail = mailer.outbox.at(-1)
	assert.match(mail.html, /&lt;b&gt;Bold&lt;\/b&gt; &amp; Co/)
	assert.doesNotMatch(mail.html, /<b>Bold/)
	assert.match(mail.text, /Group: Not sure/)
})

test('BEH-019 a request is validated; a filled-in hidden field is accepted but not stored', async () => {
	for (const body of [{...request, email: 'not-an-email'}, {...request, cohort: 'everyone'}, {...request, companyName: ''},
		{...request, message: 'x'.repeat(2001)}]) {
		assert.equal((await call('POST', '/access-requests', {body})).status, 400)
	}
	const bot = await call('POST', '/access-requests', {body: {...request, companyName: 'Spam Ltd', website: 'http://spam.example'}})
	assert.equal(bot.status, 202)
	const {rows} = await db.pool.query("SELECT count(*)::int AS n FROM access_request WHERE company_name = 'Spam Ltd'")
	assert.equal(rows[0].n, 0)
})

test('BEH-019 requests from one address are rate-limited', async () => {
	const r = await call('POST', '/access-requests', {body: request})
	assert.equal(r.status, 429)
})

test('BEH-019 programme admins list requests and mark them handled; company users cannot', async () => {
	assert.equal((await call('GET', '/admin/access-requests', {cookie: member})).status, 403)
	assert.equal((await call('GET', '/admin/access-requests')).status, 401)
	const list = await call('GET', '/admin/access-requests', {cookie: admin})
	assert.equal(list.status, 200)
	assert.equal(list.json.requests.length, 2)
	const id = list.json.requests.find((r) => r.company_name == 'Ward Robotics Ltd').id
	assert.equal((await call('PATCH', `/admin/access-requests/${id}`, {cookie: member, body: {handled: true}})).status, 403)
	assert.equal((await call('PATCH', `/admin/access-requests/${id}`, {cookie: admin, body: {handled: 'yes'}})).status, 400)
	const done = await call('PATCH', `/admin/access-requests/${id}`, {cookie: admin, body: {handled: true}})
	assert.equal(done.status, 200)
	assert.ok(done.json.request.handled_at)
	const again = await call('PATCH', `/admin/access-requests/${id}`, {cookie: admin, body: {handled: true}})
	assert.equal(again.json.request.handled_at, done.json.request.handled_at)
	assert.equal((await call('PATCH', '/admin/access-requests/00000000-0000-4000-8000-000000000000', {cookie: admin, body: {handled: true}})).status, 404)
	const after = await call('GET', '/admin/access-requests', {cookie: admin})
	assert.equal(after.json.requests.at(-1).id, id, 'handled requests are listed last')
	const {rows} = await db.pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action = 'access_request.handled'")
	assert.equal(rows[0].n, 2)
})

test(`BEH-019 requests are deleted ${ACCESS_REQUEST_DAYS} days after they were made`, async () => {
	await db.pool.query("UPDATE access_request SET created_at = '2026-01-01' WHERE company_name = 'Ward Robotics Ltd'")
	const result = await cleanup({pool: await db.rolePool('of_worker'), blobs: {remove: async () => {}}, now: new Date('2026-11-01T12:00:00Z')})
	assert.equal(result.accessRequestsRemoved, 1)
	const {rows} = await db.pool.query('SELECT company_name FROM access_request')
	assert.deepEqual(rows.map((r) => r.company_name), ['<b>Bold</b> & Co'])
})

const newRequest = async (fields) => {
	const {rows: [r]} = await db.pool.query(`INSERT INTO access_request (company_name, contact_name, email, cohort) VALUES ($1, $2, $3, $4) RETURNING id`,
		[fields.company, fields.contact, fields.email, fields.cohort])
	return r.id
}

test('BEH-019 accepting a request adds the company in its group, invites the contact as company admin and closes the request', async () => {
	const id = await newRequest({company: 'Cameron Labs', contact: 'Cameron Black', email: 'cameron@labs.example', cohort: 'connected_health_cluster'})
	assert.equal((await call('POST', `/admin/access-requests/${id}/accept`, {cookie: member, body: {}})).status, 403)
	const before = mailer.outbox.length
	const r = await call('POST', `/admin/access-requests/${id}/accept`, {cookie: admin, body: {companyName: 'Cameron Labs Ltd'}})
	assert.equal(r.status, 201)
	assert.deepEqual([r.json.company.name, r.json.company.cohort, r.json.invitation.email, r.json.invitation.role],
		['Cameron Labs Ltd', 'connected_health_cluster', 'cameron@labs.example', 'company_admin'])
	assert.equal(mailer.outbox.length, before + 1)
	assert.equal(mailer.outbox.at(-1).to, 'cameron@labs.example')
	assert.match(mailer.outbox.at(-1).subject, /Cameron Labs Ltd/)

	const people = await call('GET', `/admin/companies/${r.json.company.id}/members`, {cookie: admin})
	assert.deepEqual(people.json.members.map((m) => [m.display_name, m.email, m.role, m.status]), [['Cameron Black', 'cameron@labs.example', 'company_admin', 'invited']])
	const list = await call('GET', '/admin/access-requests', {cookie: admin})
	const accepted = list.json.requests.find((x) => x.id == id)
	assert.ok(accepted.handled_at)
	assert.deepEqual([accepted.company_id, accepted.accepted_company], [r.json.company.id, 'Cameron Labs Ltd'])
	const {rows} = await db.pool.query("SELECT action FROM audit_event WHERE detail->>'id' = $1 OR detail->>'accessRequestId' = $1 ORDER BY created_at", [id])
	assert.deepEqual(rows.map((e) => e.action), ['company.created', 'access_request.accepted'])

	// The invitation link signs the contact in to their new company.
	const token = mailer.outbox.at(-1).text.match(/#token=([\w-]+)/)[1]
	assert.equal((await call('POST', '/auth/verify', {body: {token}})).status, 200)

	const again = await call('POST', `/admin/access-requests/${id}/accept`, {cookie: admin, body: {}})
	assert.deepEqual([again.status, again.json.error.code], [409, 'already_handled'])
})

test('BEH-019 a "not sure" request needs a group; a clash with an existing company changes nothing', async () => {
	const unsure = await newRequest({company: 'Unsure Health', contact: 'Ali Unsure', email: 'ali@unsure.example', cohort: 'not_sure'})
	assert.equal((await call('POST', `/admin/access-requests/${unsure}/accept`, {cookie: admin, body: {}})).status, 400)
	assert.equal((await call('POST', `/admin/access-requests/${unsure}/accept`, {cookie: admin, body: {cohort: 'not_sure'}})).status, 400)
	const ok = await call('POST', `/admin/access-requests/${unsure}/accept`, {cookie: admin, body: {cohort: 'ai_in_healthcare'}})
	assert.deepEqual([ok.status, ok.json.company.cohort], [201, 'ai_in_healthcare'])

	const clash = await newRequest({company: 'Care Routing Ltd', contact: 'Dup Person', email: 'dup@care.example', cohort: 'ai_in_healthcare'})
	const r = await call('POST', `/admin/access-requests/${clash}/accept`, {cookie: admin, body: {}})
	assert.equal(r.status, 409)
	const {rows: [req]} = await db.pool.query('SELECT handled_at, company_id FROM access_request WHERE id = $1', [clash])
	assert.deepEqual(req, {handled_at: null, company_id: null})
	const {rows: users} = await db.pool.query("SELECT 1 FROM app_user WHERE email = 'dup@care.example'")
	assert.equal(users.length, 0, 'the rolled-back invitation left no account behind')
	assert.equal((await call('POST', '/admin/access-requests/00000000-0000-4000-8000-000000000000/accept', {cookie: admin, body: {}})).status, 404)
})

test('BEH-019 a request from a company already on the platform is accepted into it, without adding another', async () => {
	const {rows: [existing]} = await db.pool.query("SELECT id FROM company WHERE name = 'Care Routing Ltd'")
	const id = await newRequest({company: 'Care Routing', contact: 'Sam Second', email: 'sam@care.example', cohort: 'not_sure'})
	const {rows: [{n: before}]} = await db.pool.query('SELECT count(*)::int AS n FROM company')
	const r = await call('POST', `/admin/access-requests/${id}/accept`, {cookie: admin, body: {companyId: existing.id, role: 'company_member'}})
	assert.equal(r.status, 201)
	assert.deepEqual([r.json.company.id, r.json.invitation.role], [existing.id, 'company_member'])
	const {rows: [{n: after}]} = await db.pool.query('SELECT count(*)::int AS n FROM company')
	assert.equal(after, before)
	const {rows: [req]} = await db.pool.query('SELECT company_id FROM access_request WHERE id = $1', [id])
	assert.equal(req.company_id, existing.id)
	const bad = await newRequest({company: 'Ghost', contact: 'G', email: 'g@ghost.example', cohort: 'ai_in_healthcare'})
	assert.equal((await call('POST', `/admin/access-requests/${bad}/accept`, {cookie: admin, body: {companyId: '00000000-0000-4000-8000-000000000000'}})).status, 400)
})

test('INF-001 a programme admin deletes a company added by mistake, but never one with a profile, run or plan', async () => {
	const dup = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Duplicate Ltd'}})).json.company.id
	assert.equal((await call('POST', `/admin/companies/${dup}/invitations`, {cookie: admin, body: {email: 'dup@dup.example'}})).status, 201)
	const {rows: [busy]} = await db.pool.query("SELECT id FROM company WHERE name = 'Care Routing Ltd'")
	await db.pool.query("INSERT INTO company_profile (company_id, version, product_description) VALUES ($1, 1, 'Routing software for home care providers across Northern Ireland.')", [busy.id])

	// The weekly run skips a company with no profile; that leaves a row with no data or cost.
	await db.pool.query("INSERT INTO weekly_gather (week_start, status) VALUES ('2026-11-02', 'succeeded') ON CONFLICT DO NOTHING")
	await db.pool.query("INSERT INTO search_run (company_id, week_start, status, skip_reason) VALUES ($1, '2026-11-02', 'skipped', 'no_profile')", [dup])
	const listed = (await call('GET', '/admin/companies', {cookie: admin})).json.companies
	assert.deepEqual([listed.find((c) => c.id == dup).deletable, listed.find((c) => c.id == busy.id).deletable], [true, false])

	assert.equal((await call('DELETE', `/admin/companies/${dup}`, {cookie: member})).status, 403)
	assert.equal((await call('DELETE', `/admin/companies/${dup}`, {cookie: admin})).status, 204)
	const {rows: runs} = await db.pool.query('SELECT 1 FROM search_run WHERE company_id = $1', [dup])
	assert.equal(runs.length, 0, 'the skipped run went with it')
	const {rows: gone} = await db.pool.query('SELECT 1 FROM company WHERE id = $1', [dup])
	assert.equal(gone.length, 0)
	const {rows: members} = await db.pool.query('SELECT 1 FROM company_membership WHERE company_id = $1', [dup])
	assert.equal(members.length, 0)
	const {rows: [user]} = await db.pool.query("SELECT 1 AS kept FROM app_user WHERE email = 'dup@dup.example'")
	assert.equal(user.kept, 1, 'the person\'s account stays')
	const {rows: [event]} = await db.pool.query("SELECT detail FROM audit_event WHERE action = 'company.deleted'")
	assert.deepEqual(event.detail, {companyId: dup, name: 'Duplicate Ltd'})
	assert.equal((await call('DELETE', `/admin/companies/${dup}`, {cookie: admin})).status, 404)

	const r = await call('DELETE', `/admin/companies/${busy.id}`, {cookie: admin})
	assert.deepEqual([r.status, r.json.error.code], [409, 'company_in_use'])
	const {rows: still} = await db.pool.query('SELECT 1 FROM company WHERE id = $1', [busy.id])
	assert.equal(still.length, 1)
})

test('INF-001 a company whose run did anything or cost anything cannot be deleted', async () => {
	const ran = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Ran Once Ltd'}})).json.company.id
	await db.pool.query("INSERT INTO search_run (company_id, week_start, status, skip_reason, model_cost_usd) VALUES ($1, '2026-11-02', 'skipped', 'no_key', 0.12)", [ran])
	assert.equal((await call('DELETE', `/admin/companies/${ran}`, {cookie: admin})).status, 409)
	const failed = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Failed Once Ltd'}})).json.company.id
	await db.pool.query("INSERT INTO search_run (company_id, week_start, status, error_code) VALUES ($1, '2026-11-02', 'failed', 'provider_error')", [failed])
	assert.equal((await call('DELETE', `/admin/companies/${failed}`, {cookie: admin})).status, 409)
})

test('INF-001 a company in use can be archived and restored; it keeps its records', async () => {
	const {rows: [busy]} = await db.pool.query("SELECT id FROM company WHERE name = 'Care Routing Ltd'")
	assert.equal((await call('PATCH', `/admin/companies/${busy.id}`, {cookie: member, body: {status: 'archived'}})).status, 403)
	const r = await call('PATCH', `/admin/companies/${busy.id}`, {cookie: admin, body: {status: 'archived'}})
	assert.deepEqual([r.status, r.json.company.status], [200, 'archived'])
	const listed = (await call('GET', '/admin/companies', {cookie: admin})).json.companies.find((c) => c.id == busy.id)
	assert.equal(listed.status, 'archived')
	const {rows: profiles} = await db.pool.query('SELECT 1 FROM company_profile WHERE company_id = $1', [busy.id])
	assert.equal(profiles.length, 1, 'nothing of the company\'s is removed')
	const {rows: [event]} = await db.pool.query("SELECT detail FROM audit_event WHERE action = 'company.status_changed' AND company_id = $1 ORDER BY created_at DESC LIMIT 1", [busy.id])
	assert.deepEqual(event.detail, {status: 'archived'})
	assert.equal((await call('PATCH', `/admin/companies/${busy.id}`, {cookie: admin, body: {status: 'gone'}})).status, 400)
	assert.equal((await call('PATCH', `/admin/companies/${busy.id}`, {cookie: admin, body: {status: 'paused'}})).json.company.status, 'paused')
})
