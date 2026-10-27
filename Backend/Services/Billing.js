// Stripe billing (DEC-014). Card details stay with Stripe: the platform keeps
// only the customer and subscription ids and the subscription's state. The
// API takes this object as a dependency, so tests pass createFakeBilling and
// never call Stripe. Without STRIPE_SECRET_KEY billing is off (null): the
// billing card says checkout is unavailable.
import Stripe from 'stripe'
import {PLANS, INTERVALS} from './Plans.js'

const PRICE_ENV = {
	subscription: {month: 'STRIPE_PRICE_SUBSCRIPTION_MONTH', year: 'STRIPE_PRICE_SUBSCRIPTION_YEAR'},
	own_key: {month: 'STRIPE_PRICE_OWN_KEY_MONTH', year: 'STRIPE_PRICE_OWN_KEY_YEAR'},
}
export const BILLING_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', ...Object.values(PRICE_ENV).flatMap(Object.values)]

const isoFromSeconds = (s) => (s ? new Date(s * 1000).toISOString() : null)

// A Stripe subscription as the platform stores it. The plan comes from the
// price; a price that is not one of the four is reported as plan null.
export const toSubscription = (s, planOfPrice) => {
	const item = s.items?.data?.[0]
	const {plan = null, interval = null} = planOfPrice(item?.price?.id) ?? {}
	return {
		id: s.id,
		customerId: typeof s.customer == 'string' ? s.customer : s.customer?.id,
		status: s.status,
		plan,
		interval,
		// Since API version 2025-03-31 the period is on the item.
		currentPeriodEnd: isoFromSeconds(item?.current_period_end ?? s.current_period_end),
		cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
	}
}

// The subscription an event is about, or null for events that need no action.
export const subscriptionIdOf = (event) => {
	const o = event.data?.object ?? {}
	if (event.type == 'checkout.session.completed') return o.mode == 'subscription' ? idOf(o.subscription) : null
	if (event.type.startsWith('customer.subscription.')) return o.id
	if (event.type == 'invoice.paid' || event.type == 'invoice.payment_failed') {
		return idOf(o.parent?.subscription_details?.subscription ?? o.subscription)
	}
	return null
}
const idOf = (v) => (typeof v == 'string' ? v : v?.id ?? null)

const planLookup = (prices) => (priceId) => {
	for (const plan of PLANS) for (const interval of INTERVALS) if (prices[plan][interval] == priceId) return {plan, interval}
	return null
}

export const createBilling = (env = process.env) => {
	if (!env.STRIPE_SECRET_KEY) return null
	const missing = BILLING_ENV.filter((name) => !env[name])
	if (missing.length) throw new Error(`Billing configuration missing: ${missing.join(', ')}`)
	const stripe = new Stripe(env.STRIPE_SECRET_KEY, {maxNetworkRetries: 2, timeout: 20_000})
	const prices = Object.fromEntries(PLANS.map((plan) => [plan, Object.fromEntries(INTERVALS.map((i) => [i, env[PRICE_ENV[plan][i]]]))]))
	const planOfPrice = planLookup(prices)
	return {
		createCustomer: async ({companyId, name}) => (await stripe.customers.create({name, metadata: {company_id: companyId}})).id,
		// Prices exclude VAT; Stripe Tax adds UK VAT, and a business that gives
		// an EU VAT number is reverse-charged.
		checkoutUrl: async ({customerId, companyId, plan, interval, trialEnd, successUrl, cancelUrl}) => (await stripe.checkout.sessions.create({
			mode: 'subscription',
			customer: customerId,
			client_reference_id: companyId,
			line_items: [{price: prices[plan][interval], quantity: 1}],
			subscription_data: {metadata: {company_id: companyId}, ...(trialEnd ? {trial_end: Math.floor(trialEnd.getTime() / 1000)} : {})},
			automatic_tax: {enabled: true},
			tax_id_collection: {enabled: true},
			billing_address_collection: 'required',
			customer_update: {address: 'auto', name: 'auto'},
			success_url: successUrl,
			cancel_url: cancelUrl,
		})).url,
		portalUrl: async ({customerId, returnUrl}) => (await stripe.billingPortal.sessions.create({customer: customerId, return_url: returnUrl})).url,
		subscription: async (id) => toSubscription(await stripe.subscriptions.retrieve(id), planOfPrice),
		subscriptionsOf: async (customerId) => (await stripe.subscriptions.list({customer: customerId, status: 'all', limit: 10})).data
			.map((s) => toSubscription(s, planOfPrice)),
		// Throws unless the body is signed with the webhook secret, within
		// Stripe's default five-minute tolerance.
		event: (rawBody, signature) => stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET),
	}
}

// In-memory stand-in for tests and local development. Events are signed and
// checked with the real Stripe code, so the webhook route is tested as it runs.
export const createFakeBilling = ({webhookSecret = 'whsec_test_fake'} = {}) => {
	const stripe = new Stripe('sk_test_fake')
	const customers = new Map()
	const subscriptions = new Map()
	const calls = []
	let next = 1
	return {
		calls, customers, subscriptions, webhookSecret,
		createCustomer: async ({companyId, name}) => {
			const id = `cus_fake${next++}`
			customers.set(id, {companyId, name})
			calls.push({call: 'createCustomer', companyId})
			return id
		},
		checkoutUrl: async (args) => {
			calls.push({call: 'checkout', ...args})
			return `https://checkout.stripe.test/${args.customerId}/${args.plan}-${args.interval}`
		},
		portalUrl: async ({customerId, returnUrl}) => {
			calls.push({call: 'portal', customerId, returnUrl})
			return `https://billing.stripe.test/${customerId}`
		},
		subscription: async (id) => {
			const s = subscriptions.get(id)
			if (!s) throw Object.assign(new Error(`No such subscription: '${id}'`), {type: 'StripeInvalidRequestError'})
			return s
		},
		subscriptionsOf: async (customerId) => [...subscriptions.values()].filter((s) => s.customerId == customerId),
		// Test helpers: a subscription as Stripe would hold it, and a signed event.
		setSubscription: (s) => subscriptions.set(s.id, {plan: 'subscription', interval: 'month', status: 'active',
			currentPeriodEnd: '2027-03-01T00:00:00.000Z', cancelAtPeriodEnd: false, ...s}),
		signed: (event) => {
			const payload = JSON.stringify({object: 'event', created: Math.floor(Date.now() / 1000), ...event})
			return {payload, signature: stripe.webhooks.generateTestHeaderString({payload, secret: webhookSecret})}
		},
		event: (rawBody, signature) => stripe.webhooks.constructEvent(rawBody, signature, webhookSecret),
	}
}

