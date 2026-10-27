// Plans after the free period (DEC-014) against a real local database, with
// the in-memory Stripe stand-in. Its webhook events are signed and checked
// with Stripe's own code, so the signature check runs as in production.
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {seedApprovedModels} from '../../Database/Seeds/approvedModels.js'
import {createApp} from '../../API/App.js'
import {createOutboxMailer} from '../../Services/Mail.js'
import {createMemoryStore} from '../../Services/SecretStore.js'
import {createFakeBilling} from '../../Services/Billing.js'
import {londonMidnight} from '../../API/Billing.js'

const APP = 'http://app.test'
let db, servers = [], base, offBase, mailer, stripe, clock
const logs = []
const realLog = console.log

before(async () => {
	db = await createTestDatabase()
	await seedApprovedModels(db.pool)
	await db.pool.query("UPDATE service_setting SET free_period_until = '2027-01-31' WHERE id = 1")
	mailer = createOutboxMailer({environment: 'test'})
	stripe = createFakeBilling()
	clock = new Date('2026-12-01T10:00:00Z')
	const options = {pool: await db.rolePool('of_api'), mailer, secrets: createMemoryStore({environment: 'test'}), blobs: {kind: 'fake'},
		checkKey: async () => 'valid', appUrl: APP, secureCookies: false, rateLimits: {perIp: 1000, perEmail: 1000}, now: () => clock}
	console.log = (line) => logs.push(String(line))
	const listen = (app) => {
		const server = app.listen(0)
		servers.push(server)
		return `http://127.0.0.1:${server.address().port}/api`
	}
	base = listen(createApp({...options, billing: stripe}))
	offBase = listen(createApp(options))
})

after(async () => {
	console.log = realLog
	for (const server of servers) server.close()
	await db?.drop()
})

const call = async (method, path, {cookie, body, origin = APP, at = base} = {}) => {
	const response = await fetch(`${at}${path}`, {method, headers: {
		...(body ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {}), ...(origin ? {origin} : {})},
		body: body ? JSON.stringify(body) : undefined})
	return {status: response.status, json: await response.json()}
}
const webhook = async ({payload, signature}, at = base) => {
	const response = await fetch(`${at}/stripe/webhook`, {method: 'POST', headers: {'content-type': 'application/json', 'stripe-signature': signature}, body: payload})
	return {status: response.status, json: await response.json()}
}
let nextEvent = 1
const subscriptionEvent = (id, type = 'customer.subscription.updated', object = {}) =>
	stripe.signed({id: `evt_${nextEvent++}`, type, data: {object: {object: 'subscription', id, ...object}}})

const signIn = async (address) => {
	await call('POST', '/auth/request-link', {body: {email: address}})
	const token = mailer.outbox.at(-1).text.match(/#token=([\w-]+)/)[1]
	const response = await fetch(`${base}/auth/verify`, {method: 'POST', headers: {'content-type': 'application/json', origin: APP}, body: JSON.stringify({token})})
	return response.headers.get('set-cookie').split(';')[0]
}

let admin, alice, carol, bob, companyA, companyB, customerA

test('setup: two companies, an admin and a member in the first', async () => {
	const {rows: [ops]} = await db.pool.query("INSERT INTO app_user (email) VALUES ('ops@example.test') RETURNING id")
	await db.pool.query('INSERT INTO programme_admin (user_id) VALUES ($1)', [ops.id])
	admin = await signIn('ops@example.test')
	companyA = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Care Routing Ltd'}})).json.company.id
	companyB = (await call('POST', '/admin/companies', {cookie: admin, body: {name: 'Other Co'}})).json.company.id
	for (const [company, address, role] of [[companyA, 'alice@care.example', 'company_admin'], [companyA, 'carol@care.example', 'company_member'],
		[companyB, 'bob@other.example', 'company_admin']]) {
		assert.equal((await call('POST', `/admin/companies/${company}/invitations`, {cookie: admin, body: {email: address, role}})).status, 201)
	}
	alice = await signIn('alice@care.example')
	carol = await signIn('carol@care.example')
	bob = await signIn('bob@other.example')
})

test('BEH-016 the billing card shows the prices and when plans open and are needed', async () => {
	const r = await call('GET', `/companies/${companyA}/billing`, {cookie: carol})
	assert.equal(r.status, 200)
	assert.deepEqual(r.json, {billing: null, hasAccount: false, available: true,
		prices: {subscription: {month: 3000, year: 30000}, own_key: {month: 1000, year: 10000}},
		freePeriodUntil: '2027-01-31', checkoutOpensOn: '2027-01-03', plansRequiredFrom: '2027-02-01'})
})

test('BEH-016 checkout opens with the free-period notice, not before', async () => {
	const r = await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: alice, body: {plan: 'subscription', interval: 'month'}})
	assert.deepEqual([r.status, r.json.error.code], [409, 'checkout_not_open'])
	assert.equal(stripe.calls.length, 0)
})

test('BEH-016 only a company admin can buy, and only for its own company', async () => {
	clock = new Date('2027-01-10T10:00:00Z')
	const body = {plan: 'subscription', interval: 'year'}
	assert.equal((await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: carol, body})).status, 403)
	assert.equal((await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: bob, body})).status, 404)
	assert.equal((await call('GET', `/companies/${companyA}/billing`, {cookie: bob})).status, 404)
	assert.equal((await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: admin, body})).status, 404)
	assert.equal((await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: alice, body: {plan: 'gold', interval: 'year'}})).status, 400)
	assert.equal(stripe.calls.length, 0)
})

test('BEH-016 a checkout before the free period ends charges nothing until 1 Feb, and one customer is kept per company', async () => {
	const r = await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: alice, body: {plan: 'subscription', interval: 'year'}})
	assert.equal(r.status, 200)
	assert.match(r.json.url, /^https:\/\/checkout\.stripe\.test\//)
	const checkout = stripe.calls.find((c) => c.call == 'checkout')
	assert.equal(checkout.trialEnd.toISOString(), '2027-02-01T00:00:00.000Z')
	assert.deepEqual([checkout.plan, checkout.interval, checkout.companyId], ['subscription', 'year', companyA])
	assert.equal(checkout.successUrl, `${APP}/companies/${companyA}/settings?billing=done`)
	customerA = checkout.customerId
	// Abandoned and started again: the same customer.
	await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: alice, body: {plan: 'own_key', interval: 'month'}})
	assert.equal(stripe.calls.filter((c) => c.call == 'createCustomer').length, 1)
	assert.equal(stripe.calls.at(-1).customerId, customerA)
	assert.equal((await call('GET', `/companies/${companyA}/billing`, {cookie: alice})).json.hasAccount, true)
})

test('BEH-016 a trial is not set within 48 hours of the end (Stripe refuses it)', async () => {
	clock = new Date('2027-01-30T12:00:00Z')
	assert.equal((await call('POST', `/companies/${companyB}/billing/checkout`, {cookie: bob, body: {plan: 'own_key', interval: 'month'}})).status, 200)
	assert.equal(stripe.calls.at(-1).trialEnd, null)
	clock = new Date('2027-01-10T10:00:00Z')
	assert.equal(londonMidnight('2027-07-01').toISOString(), '2027-06-30T23:00:00.000Z')
})

test('SEC-004 a webhook without a valid Stripe signature is refused and changes nothing', async () => {
	stripe.setSubscription({id: 'sub_a1', customerId: customerA, status: 'trialing', interval: 'year'})
	const event = subscriptionEvent('sub_a1', 'customer.subscription.created')
	assert.equal((await webhook({payload: event.payload, signature: 't=1,v1=forged'})).status, 400)
	const tampered = {payload: event.payload.replace('sub_a1', 'sub_a2'), signature: event.signature}
	assert.equal((await webhook(tampered)).status, 400)
	assert.equal((await call('GET', `/companies/${companyA}/billing`, {cookie: alice})).json.billing, null)
	assert.ok(logs.some((l) => l.includes('stripe_webhook_rejected')))
})

test('SEC-004 a signed event stores the subscription as Stripe holds it, once however often it arrives', async () => {
	// The payload claims cancelled; Stripe holds trialing. Stripe wins.
	const event = subscriptionEvent('sub_a1', 'customer.subscription.created', {status: 'canceled'})
	assert.deepEqual(await webhook(event), {status: 200, json: {received: true}})
	assert.equal((await webhook(event)).status, 200)
	const {billing} = (await call('GET', `/companies/${companyA}/billing`, {cookie: carol})).json
	assert.deepEqual(billing, {plan: 'subscription', interval: 'year', status: 'trialing', live: true,
		currentPeriodEnd: '2027-03-01T00:00:00.000Z', cancelAtPeriodEnd: false})
	const {rows: [counts]} = await db.pool.query(`SELECT (SELECT count(*)::int FROM stripe_event) AS events,
		(SELECT count(*)::int FROM audit_event WHERE action = 'billing.updated' AND company_id = $1) AS audits`, [companyA])
	assert.deepEqual(counts, {events: 1, audits: 1})
})

test('SEC-004 invoice and checkout events are read through to their subscription', async () => {
	stripe.setSubscription({id: 'sub_a1', customerId: customerA, status: 'past_due', interval: 'year'})
	const invoice = stripe.signed({id: `evt_${nextEvent++}`, type: 'invoice.payment_failed',
		data: {object: {object: 'invoice', id: 'in_1', parent: {subscription_details: {subscription: 'sub_a1'}}}}})
	assert.equal((await webhook(invoice)).status, 200)
	assert.equal((await call('GET', `/companies/${companyA}/billing`, {cookie: alice})).json.billing.status, 'past_due')
	stripe.setSubscription({id: 'sub_a1', customerId: customerA, status: 'active', interval: 'year'})
	const done = stripe.signed({id: `evt_${nextEvent++}`, type: 'checkout.session.completed', data: {object: {object: 'checkout.session', mode: 'subscription', subscription: 'sub_a1'}}})
	assert.equal((await webhook(done)).status, 200)
	assert.equal((await call('GET', `/companies/${companyA}/billing`, {cookie: alice})).json.billing.status, 'active')
	// Events about nothing we hold are acknowledged and ignored.
	assert.equal((await webhook(stripe.signed({id: `evt_${nextEvent++}`, type: 'customer.created', data: {object: {object: 'customer', id: 'cus_x'}}}))).status, 200)
})

test('SEC-004 a bank debit that settles after checkout starts the plan on the async event', async () => {
	stripe.setSubscription({id: 'sub_a1', customerId: customerA, status: 'incomplete', interval: 'year'})
	const completed = stripe.signed({id: `evt_${nextEvent++}`, type: 'checkout.session.completed',
		data: {object: {object: 'checkout.session', mode: 'subscription', subscription: 'sub_a1', payment_status: 'unpaid'}}})
	assert.equal((await webhook(completed)).status, 200)
	assert.equal((await call('GET', `/companies/${companyA}/billing`, {cookie: alice})).json.billing.live, false)
	stripe.setSubscription({id: 'sub_a1', customerId: customerA, status: 'active', interval: 'year'})
	const settled = stripe.signed({id: `evt_${nextEvent++}`, type: 'checkout.session.async_payment_succeeded',
		data: {object: {object: 'checkout.session', mode: 'subscription', subscription: 'sub_a1', payment_status: 'paid'}}})
	assert.equal((await webhook(settled)).status, 200)
	assert.deepEqual((await call('GET', `/companies/${companyA}/billing`, {cookie: alice})).json.billing, {plan: 'subscription', interval: 'year',
		status: 'active', live: true, currentPeriodEnd: '2027-03-01T00:00:00.000Z', cancelAtPeriodEnd: false})
})

test('SEC-004 disputes, refunds and fraud warnings are recorded against the company, once, and disputes and warnings are logged for the alert', async () => {
	stripe.setCharge('ch_a1', customerA)
	const riskEvent = (type, object) => stripe.signed({id: `evt_${nextEvent++}`, type, data: {object}})
	const dispute = riskEvent('charge.dispute.created', {object: 'dispute', id: 'dp_1', charge: 'ch_a1', reason: 'fraudulent', amount: 3600})
	assert.equal((await webhook(dispute)).status, 200)
	assert.equal((await webhook(dispute)).status, 200)
	assert.equal((await webhook(riskEvent('radar.early_fraud_warning.created', {object: 'radar.early_fraud_warning', id: 'issfr_1', charge: 'ch_a1',
		fraud_type: 'unauthorized_use_of_card'}))).status, 200)
	// A refund carries its charge, and the charge its customer.
	assert.equal((await webhook(riskEvent('charge.refunded', {object: 'charge', id: 'ch_a2', customer: customerA, refunded: true, amount: 3600}))).status, 200)
	const {rows} = await db.pool.query(`SELECT action, detail FROM audit_event WHERE company_id = $1 AND action IN ('billing.dispute', 'billing.fraud_warning', 'billing.refund')
		ORDER BY action`, [companyA])
	assert.deepEqual(rows, [
		{action: 'billing.dispute', detail: {id: 'dp_1', charge: 'ch_a1', reason: 'fraudulent'}},
		{action: 'billing.fraud_warning', detail: {id: 'issfr_1', charge: 'ch_a1', reason: 'unauthorized_use_of_card'}},
		{action: 'billing.refund', detail: {id: 'ch_a2', charge: 'ch_a2', reason: 'full'}},
	])
	assert.ok(logs.some((l) => l.includes('billing_dispute') && l.includes(companyA)))
	assert.ok(logs.some((l) => l.includes('billing_fraud_warning') && l.includes(companyA)))
	// Amounts stay out of the logs, as for other billing changes.
	assert.ok(!logs.some((l) => l.includes('billing_') && l.includes('3600')))
	// The plan itself is left for a person to decide in Stripe.
	assert.equal((await call('GET', `/companies/${companyA}/billing`, {cookie: alice})).json.billing.status, 'active')
	// A charge for a customer that is not ours is logged, not recorded.
	stripe.setCharge('ch_stranger', 'cus_stranger')
	assert.equal((await webhook(riskEvent('charge.dispute.created', {object: 'dispute', id: 'dp_2', charge: 'ch_stranger', reason: 'general'}))).status, 200)
	assert.ok(logs.some((l) => l.includes('billing_unknown_customer') && l.includes('ch_stranger')))
})

test('SEC-004 an older subscription never replaces a live one; a second live one is logged for a refund', async () => {
	stripe.setSubscription({id: 'sub_old', customerId: customerA, status: 'canceled', interval: 'month'})
	assert.equal((await webhook(subscriptionEvent('sub_old', 'customer.subscription.deleted'))).status, 200)
	stripe.setSubscription({id: 'sub_dup', customerId: customerA, status: 'active', interval: 'month'})
	assert.equal((await webhook(subscriptionEvent('sub_dup'))).status, 200)
	const {rows: [row]} = await db.pool.query('SELECT stripe_subscription_id, status FROM company_billing WHERE company_id = $1', [companyA])
	assert.deepEqual(row, {stripe_subscription_id: 'sub_a1', status: 'active'})
	assert.ok(logs.some((l) => l.includes('billing_duplicate_subscription') && l.includes('sub_dup')))
	stripe.subscriptions.delete('sub_old')
	stripe.subscriptions.delete('sub_dup')
	// A subscription for a customer that is not ours is logged, not stored.
	stripe.setSubscription({id: 'sub_stranger', customerId: 'cus_stranger'})
	assert.equal((await webhook(subscriptionEvent('sub_stranger'))).status, 200)
	assert.ok(logs.some((l) => l.includes('billing_unknown_customer')))
})

test('BEH-016 a company with a live plan changes it in the portal, not a second checkout', async () => {
	const again = await call('POST', `/companies/${companyA}/billing/checkout`, {cookie: alice, body: {plan: 'own_key', interval: 'month'}})
	assert.deepEqual([again.status, again.json.error.code], [409, 'already_subscribed'])
	const portal = await call('POST', `/companies/${companyA}/billing/portal`, {cookie: alice})
	assert.deepEqual(portal, {status: 200, json: {url: `https://billing.stripe.test/${customerA}`}})
	assert.equal(stripe.calls.at(-1).returnUrl, `${APP}/companies/${companyA}/settings`)
	assert.equal((await call('POST', `/companies/${companyA}/billing/portal`, {cookie: carol})).status, 403)
})

test('BEH-016 back from Stripe, sync reads the subscription without waiting for the webhook', async () => {
	stripe.setSubscription({id: 'sub_a1', customerId: customerA, status: 'active', interval: 'year', cancelAtPeriodEnd: true})
	const r = await call('POST', `/companies/${companyA}/billing/sync`, {cookie: carol})
	assert.equal(r.status, 200)
	assert.equal(r.json.billing.cancelAtPeriodEnd, true)
})

test('BEH-016 programme admins see each company\'s plan and status, nothing more', async () => {
	const {companies} = (await call('GET', '/admin/companies', {cookie: admin})).json
	const a = companies.find((c) => c.id == companyA)
	const b = companies.find((c) => c.id == companyB)
	assert.deepEqual([a.billing_plan, a.billing_status, b.billing_plan, b.billing_status], ['subscription', 'active', null, null])
})

test('BEH-016 without Stripe settings, the card says plans are unavailable and checkout is refused', async () => {
	const card = await call('GET', `/companies/${companyB}/billing`, {cookie: bob, at: offBase})
	assert.equal(card.json.available, false)
	const r = await call('POST', `/companies/${companyB}/billing/checkout`, {cookie: bob, at: offBase, body: {plan: 'own_key', interval: 'month'}})
	assert.deepEqual([r.status, r.json.error.code], [503, 'billing_unavailable'])
	assert.equal((await webhook(subscriptionEvent('sub_a1'), offBase)).status, 404)
})
