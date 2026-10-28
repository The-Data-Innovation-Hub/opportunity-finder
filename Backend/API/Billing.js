// Company plans after the free period (DEC-014). A company admin chooses a
// plan on Stripe Checkout and manages it in Stripe's customer portal; Stripe
// tells us about every change through the webhook, and the subscription's
// state is always read back from Stripe rather than taken from the event.
// Card details never reach this server.
import express from 'express'
import {APIError, audit, logLine, notFound, oneOf, withTransaction} from './Library.js'
import {requireCompanyAdmin, requireMember} from './Companies.js'
import {riskOf, subscriptionIdOf} from '../Services/Billing.js'
import {CLUSTER, FREE_PERIOD_NOTICE_DAYS, INTERVALS, LIVE_PLAN_STATUSES, PLAN_PRICES, PLANS} from '../Services/Plans.js'

const DAY_MS = 864e5
// Stripe refuses a trial that ends less than 48 hours ahead.
const MIN_TRIAL_MS = 49 * 3600e3
const addDays = (day, n) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10)
const isLive = (status) => LIVE_PLAN_STATUSES.includes(status)

// 00:00 in the UK on the given day (UTC or UTC+1).
export const londonMidnight = (day) => {
	const utc = new Date(`${day}T00:00:00Z`)
	const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23'}).format(utc))
	return new Date(utc.getTime() - hour * 3600e3)
}

const unavailable = () => new APIError(503, 'billing_unavailable', 'Plans cannot be bought yet. Please try again later.')

// When plans are needed: from the day after the free period. With no free
// period set, every company runs on its own key and no plan is needed.
// DEC-015: a Connected Health Cluster company has no free period. Its first
// report is free; plans are needed from the day it was added, and checkout
// is open at once and charges straight away.
const termsOf = async (pool, companyId) => {
	const {rows: [s]} = await pool.query(`SELECT s.free_period_until, c.cohort, c.created_at::date::text AS added_on,
			EXISTS (SELECT 1 FROM report r WHERE r.company_id = c.id) AS has_report
		FROM service_setting s JOIN company c ON c.id = $1 WHERE s.id = 1`, [companyId])
	if (s.cohort == CLUSTER) {
		return {cohort: s.cohort, freePeriodUntil: null, checkoutOpensOn: null, plansRequiredFrom: s.added_on, firstReportFree: !s.has_report}
	}
	const until = s.free_period_until
	return {
		cohort: s.cohort,
		freePeriodUntil: until,
		checkoutOpensOn: until ? addDays(until, -FREE_PERIOD_NOTICE_DAYS) : null,
		plansRequiredFrom: until ? addDays(until, 1) : null,
		firstReportFree: false,
	}
}

const billingRow = async (db, companyId) => (await db.query(`SELECT stripe_customer_id, stripe_subscription_id, plan, billing_interval, status,
	current_period_end, cancel_at_period_end FROM company_billing WHERE company_id = $1`, [companyId])).rows[0]

const planView = (row) => row?.stripe_subscription_id ? {plan: row.plan, interval: row.billing_interval, status: row.status, live: isLive(row.status),
	currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end} : null

// Copies a subscription's state from Stripe to its company's row. An event
// about an older subscription never replaces a live one; a second live
// subscription for one company is logged for a refund (RSK-007).
export const storeSubscription = async (client, sub) => {
	const {rows: [row]} = await client.query(`SELECT company_id, stripe_subscription_id, plan, billing_interval, status FROM company_billing
		WHERE stripe_customer_id = $1 FOR UPDATE`, [sub.customerId])
	if (!row) return logLine({event: 'billing_unknown_customer', subscription: sub.id})
	if (!sub.plan) return logLine({event: 'billing_unknown_price', company_id: row.company_id, subscription: sub.id})
	if (row.stripe_subscription_id && row.stripe_subscription_id != sub.id && isLive(row.status)) {
		if (isLive(sub.status)) logLine({event: 'billing_duplicate_subscription', company_id: row.company_id, kept: row.stripe_subscription_id, duplicate: sub.id})
		return
	}
	await client.query(`UPDATE company_billing SET stripe_subscription_id = $2, plan = $3, billing_interval = $4, status = $5, current_period_end = $6,
		cancel_at_period_end = $7, updated_at = now() WHERE company_id = $1`,
		[row.company_id, sub.id, sub.plan, sub.interval, sub.status, sub.currentPeriodEnd, sub.cancelAtPeriodEnd])
	if (row.plan != sub.plan || row.billing_interval != sub.interval || row.status != sub.status) {
		await audit(client, {companyId: row.company_id, action: 'billing.updated', detail: {plan: sub.plan, interval: sub.interval, status: sub.status}})
	}
}

// Records a dispute, refund or early fraud warning against its company. A
// dispute or fraud warning raises the failures alert: someone decides in
// Stripe whether to refund or cancel, and any cancellation comes back
// through the webhook. Logged without amounts, as other billing changes.
export const storeRisk = async (client, risk, customerId) => {
	const {rows: [row]} = await client.query('SELECT company_id FROM company_billing WHERE stripe_customer_id = $1', [customerId])
	if (!row) return logLine({event: 'billing_unknown_customer', charge: risk.chargeId})
	logLine({event: `billing_${risk.kind}`, company_id: row.company_id, id: risk.id, charge: risk.chargeId, reason: risk.reason})
	await audit(client, {companyId: row.company_id, action: `billing.${risk.kind}`, detail: {id: risk.id, charge: risk.chargeId, reason: risk.reason}})
}

// Mounted before the JSON parser and the same-origin and session checks:
// Stripe signs the raw body, and its signature is the only credential.
export const stripeWebhook = ({pool, billing}) => {
	const router = express.Router()
	router.post('/stripe/webhook', express.raw({type: () => true, limit: '256kb'}), async (request, response) => {
		if (!billing) throw notFound()
		let event
		try {
			event = billing.event(request.body, request.get('stripe-signature') ?? '')
		} catch {
			logLine({event: 'stripe_webhook_rejected'})
			throw new APIError(400, 'invalid_signature', 'Invalid signature')
		}
		const subscriptionId = subscriptionIdOf(event)
		// Read before the transaction, so no connection waits on Stripe. A
		// failure here returns 500 and Stripe sends the event again.
		const sub = subscriptionId ? await billing.subscription(subscriptionId) : null
		const risk = riskOf(event)
		const riskCustomer = risk ? risk.customerId ?? (risk.chargeId ? await billing.customerOfCharge(risk.chargeId) : null) : null
		await withTransaction(pool, async (client) => {
			const {rowCount} = await client.query('INSERT INTO stripe_event (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [event.id, event.type])
			if (rowCount && sub) await storeSubscription(client, sub)
			if (rowCount && risk) await storeRisk(client, risk, riskCustomer)
		})
		response.json({received: true})
	})
	return router
}

export const billingRoutes = ({pool, billing, appUrl, now = () => new Date()}) => {
	const router = express.Router()
	const member = requireMember(pool)
	const view = async (companyId) => {
		const row = await billingRow(pool, companyId)
		return {billing: planView(row), hasAccount: Boolean(row), available: Boolean(billing), prices: PLAN_PRICES, ...(await termsOf(pool, companyId))}
	}

	router.get('/companies/:companyId/billing', member, async (request, response) => {
		response.json(await view(request.companyId))
	})

	router.post('/companies/:companyId/billing/checkout', member, requireCompanyAdmin, async (request, response) => {
		if (!billing) throw unavailable()
		const plan = oneOf(request.body?.plan, 'plan', PLANS)
		const interval = oneOf(request.body?.interval, 'interval', INTERVALS)
		const terms = await termsOf(pool, request.companyId)
		const at = now()
		if (terms.checkoutOpensOn && at.toISOString().slice(0, 10) < terms.checkoutOpensOn) {
			throw new APIError(409, 'checkout_not_open', `Plans can be chosen from ${terms.checkoutOpensOn}`)
		}
		const {companyId} = request
		// One Stripe customer per company, created under a lock on the company.
		const customerId = await withTransaction(pool, async (client) => {
			await client.query('SELECT id FROM company WHERE id = $1 FOR UPDATE', [companyId])
			const row = await billingRow(client, companyId)
			if (isLive(row?.status)) throw new APIError(409, 'already_subscribed', 'This company already has a plan: use Manage billing to change it')
			if (row) return row.stripe_customer_id
			const id = await billing.createCustomer({companyId, name: request.membership.name})
			await client.query('INSERT INTO company_billing (company_id, stripe_customer_id) VALUES ($1, $2)', [companyId, id])
			return id
		})
		// Bought before the free period ends: nothing is charged until it does.
		// A Connected Health Cluster plan is charged at once (no trial).
		const trialEnd = terms.plansRequiredFrom ? londonMidnight(terms.plansRequiredFrom) : null
		const settings = `${appUrl}/companies/${companyId}/settings`
		const url = await billing.checkoutUrl({customerId, companyId, plan, interval,
			trialEnd: trialEnd && trialEnd - at >= MIN_TRIAL_MS ? trialEnd : null,
			successUrl: `${settings}?billing=done`, cancelUrl: `${settings}?billing=cancelled`})
		await audit(pool, {companyId, actorUserId: request.user.id, action: 'billing.checkout_started', detail: {plan, interval}})
		response.json({url})
	})

	router.post('/companies/:companyId/billing/portal', member, requireCompanyAdmin, async (request, response) => {
		if (!billing) throw unavailable()
		const row = await billingRow(pool, request.companyId)
		if (!row) throw new APIError(409, 'no_billing_account', 'Choose a plan first')
		response.json({url: await billing.portalUrl({customerId: row.stripe_customer_id, returnUrl: `${appUrl}/companies/${request.companyId}/settings`})})
	})

	// Back from Checkout or the portal: read the company's subscriptions from
	// Stripe now rather than wait for the webhook (RSK-009).
	router.post('/companies/:companyId/billing/sync', member, async (request, response) => {
		const row = await billingRow(pool, request.companyId)
		if (billing && row) {
			const subs = await billing.subscriptionsOf(row.stripe_customer_id)
			// The live one with the latest period end, else the latest.
			const latest = (list) => list.toSorted((a, b) => (b.currentPeriodEnd ?? '').localeCompare(a.currentPeriodEnd ?? ''))[0]
			const sub = latest(subs.filter((s) => isLive(s.status))) ?? latest(subs)
			if (sub) await withTransaction(pool, (client) => storeSubscription(client, sub))
		}
		response.json(await view(request.companyId))
	})

	return router
}
