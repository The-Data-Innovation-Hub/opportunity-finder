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
	return {status: response.status, json: await response.json(), headers: response.headers}
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
