// Mapping Stripe's objects to the platform's (DEC-014), without Stripe.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {subscriptionIdOf, toSubscription} from '../Services/Billing.js'
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

test('DEC-014 events lead to their subscription; others to nothing', () => {
	const of = (type, object) => subscriptionIdOf({type, data: {object}})
	assert.equal(of('checkout.session.completed', {mode: 'subscription', subscription: 'sub_1'}), 'sub_1')
	assert.equal(of('checkout.session.completed', {mode: 'payment', subscription: null}), null)
	assert.equal(of('customer.subscription.deleted', {id: 'sub_2'}), 'sub_2')
	assert.equal(of('invoice.paid', {parent: {subscription_details: {subscription: 'sub_3'}}}), 'sub_3')
	assert.equal(of('invoice.payment_failed', {subscription: {id: 'sub_4'}}), 'sub_4')
	assert.equal(of('customer.created', {id: 'cus_1'}), null)
})

test('DEC-014 a trial ends at midnight UK time, in winter and in summer', () => {
	assert.equal(londonMidnight('2027-02-01').toISOString(), '2027-02-01T00:00:00.000Z')
	assert.equal(londonMidnight('2027-07-01').toISOString(), '2027-06-30T23:00:00.000Z')
})
