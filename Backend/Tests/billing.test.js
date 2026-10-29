// Mapping Stripe's objects to the platform's (DEC-014), without Stripe.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {BILLING_ENV, STRIPE_API_VERSION, createBilling, createFakeBilling, riskOf, subscriptionIdOf, toSubscription} from '../Services/Billing.js'
import {londonMidnight} from '../API/Billing.js'

const planOfPrice = (id) => ({price_sub_year: {plan: 'subscription', interval: 'year'}})[id] ?? null

test('DEC-014 a subscription is stored by its price, with the period from the item (API 2025-03-31 on) or the subscription', () => {
	const s = {id: 'sub_1', customer: 'cus_1', status: 'trialing', cancel_at_period_end: false,
		items: {data: [{price: {id: 'price_sub_year'}, current_period_end: 1801440000}]}}
	assert.deepEqual(toSubscription(s, planOfPrice), {id: 'sub_1', customerId: 'cus_1', status: 'trialing', plan: 'subscription', interval: 'year',
		currentPeriodEnd: '2027-02-01T00:00:00.000Z', cancelAtPeriodEnd: false})
	const older = {...s, customer: {id: 'cus_1'}, current_period_end: 1801440000, items: {data: [{price: {id: 'price_other'}}]}}
	assert.deepEqual([toSubscription(older, planOfPrice).customerId, toSubscription(older, planOfPrice).plan, toSubscription(older, planOfPrice).currentPeriodEnd],
		['cus_1', null, '2027-02-01T00:00:00.000Z'])
})

test('DEC-014 a plan cancelled in the portal (cancel_at, API 2025-03-31 on) or by the older flag is ending, at the earlier date', () => {
	const s = {id: 'sub_1', customer: 'cus_1', status: 'trialing', cancel_at_period_end: false, cancel_at: 1795132800,
		items: {data: [{price: {id: 'price_sub_year'}, current_period_end: 1795132800}]}}
	assert.deepEqual([toSubscription(s, planOfPrice).cancelAtPeriodEnd, toSubscription(s, planOfPrice).currentPeriodEnd], [true, '2026-11-20T00:00:00.000Z'])
	const sooner = {...s, cancel_at: 1794528000}
	assert.equal(toSubscription(sooner, planOfPrice).currentPeriodEnd, '2026-11-13T00:00:00.000Z')
	const older = {...s, cancel_at: null, cancel_at_period_end: true}
	assert.deepEqual([toSubscription(older, planOfPrice).cancelAtPeriodEnd, toSubscription(older, planOfPrice).currentPeriodEnd], [true, '2026-11-20T00:00:00.000Z'])
	assert.equal(toSubscription({...s, cancel_at: null}, planOfPrice).cancelAtPeriodEnd, false)
})

test('DEC-014 events lead to their subscription; others to nothing', () => {
	const of = (type, object) => subscriptionIdOf({type, data: {object}})
	assert.equal(of('checkout.session.completed', {mode: 'subscription', subscription: 'sub_1'}), 'sub_1')
	assert.equal(of('checkout.session.completed', {mode: 'payment', subscription: null}), null)
	assert.equal(of('customer.subscription.deleted', {id: 'sub_2'}), 'sub_2')
	assert.equal(of('invoice.paid', {parent: {subscription_details: {subscription: 'sub_3'}}}), 'sub_3')
	assert.equal(of('invoice.payment_failed', {subscription: {id: 'sub_4'}}), 'sub_4')
	assert.equal(of('checkout.session.async_payment_succeeded', {mode: 'subscription', subscription: 'sub_5'}), 'sub_5')
	assert.equal(of('checkout.session.async_payment_failed', {mode: 'subscription', subscription: {id: 'sub_6'}}), 'sub_6')
	assert.equal(of('checkout.session.expired', {mode: 'subscription', subscription: null}), null)
	assert.equal(of('customer.created', {id: 'cus_1'}), null)
})

test('DEC-014 disputes, fraud warnings and refunds lead to their charge; others to nothing', () => {
	const of = (type, object) => riskOf({type, data: {object}})
	assert.deepEqual(of('charge.dispute.created', {id: 'dp_1', charge: 'ch_1', reason: 'fraudulent'}),
		{kind: 'dispute', id: 'dp_1', chargeId: 'ch_1', reason: 'fraudulent'})
	assert.deepEqual(of('radar.early_fraud_warning.created', {id: 'issfr_1', charge: {id: 'ch_2'}, fraud_type: 'misc'}),
		{kind: 'fraud_warning', id: 'issfr_1', chargeId: 'ch_2', reason: 'misc'})
	assert.deepEqual(of('charge.refunded', {id: 'ch_3', customer: {id: 'cus_1'}, refunded: false}),
		{kind: 'refund', id: 'ch_3', chargeId: 'ch_3', customerId: 'cus_1', reason: 'partial'})
	assert.equal(of('charge.succeeded', {id: 'ch_4'}), null)
	assert.equal(of('invoice.paid', {id: 'in_1'}), null)
})

test('DEC-014 a trial ends at midnight UK time, in winter and in summer', () => {
	assert.equal(londonMidnight('2027-02-01').toISOString(), '2027-02-01T00:00:00.000Z')
	assert.equal(londonMidnight('2027-07-01').toISOString(), '2027-06-30T23:00:00.000Z')
})

test('DEC-014 the real client pins the API version, tags checkout sessions, keeps Managed Payments off and offers every call the stand-in does', async () => {
	const requests = []
	const server = createServer((request, response) => {
		let body = ''
		request.on('data', (chunk) => { body += chunk })
		request.on('end', () => {
			requests.push({path: request.url, version: request.headers['stripe-version'], body: new URLSearchParams(body)})
			response.setHeader('content-type', 'application/json')
			response.end(JSON.stringify(request.url.startsWith('/v1/charges/') ? {id: 'ch_1', object: 'charge', customer: 'cus_1'} : {id: 'cs_1', url: 'https://checkout.stripe.test/cs_1'}))
		})
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	try {
		const env = Object.fromEntries(BILLING_ENV.map((name) => [name, `${name.toLowerCase()}_test`]))
		const billing = createBilling(env, {host: '127.0.0.1', port: server.address().port, protocol: 'http', maxNetworkRetries: 0})
		const helpers = ['calls', 'customers', 'subscriptions', 'charges', 'webhookSecret', 'setSubscription', 'setCharge', 'signed']
		assert.deepEqual(Object.keys(billing).toSorted(), Object.keys(createFakeBilling()).filter((k) => !helpers.includes(k)).toSorted())
		assert.equal(await billing.checkoutUrl({customerId: 'cus_1', companyId: 'co_1', plan: 'subscription', interval: 'year', trialEnd: null,
			successUrl: 'https://app.test/done', cancelUrl: 'https://app.test/cancel'}), 'https://checkout.stripe.test/cs_1')
		assert.equal(await billing.customerOfCharge('ch_1'), 'cus_1')
		const [checkout, charge] = requests
		assert.deepEqual([checkout.path, checkout.version, charge.path, charge.version],
			['/v1/checkout/sessions', STRIPE_API_VERSION, '/v1/charges/ch_1', STRIPE_API_VERSION])
		assert.match(checkout.body.get('integration_identifier'), /^opportunity_finder_plans_[a-z]{8}$/)
		assert.equal(checkout.body.get('line_items[0][price]'), 'stripe_price_subscription_year_test')
		assert.equal(checkout.body.has('payment_method_types[0]'), false)
		// The Data Innovation Hub is the seller of record, never Stripe.
		assert.equal(checkout.body.get('managed_payments[enabled]'), 'false')
		assert.equal(checkout.body.get('automatic_tax[enabled]'), 'true')
	} finally {
		server.close()
	}
})
