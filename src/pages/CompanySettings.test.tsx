import {afterEach, expect, test, vi} from 'vitest'
import {screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {COMPANY_ID, meAs, mockApi, renderApp, type ApiRoutes} from '../test/app'
import type {Billing, Role} from '../api'

const base = `/companies/${COMPANY_ID}`
const routes = (role: Role, extra: ApiRoutes = {}): ApiRoutes => ({
	'GET /me': {body: meAs(role)},
	[`GET ${base}/profile`]: {body: {profile: null}},
	[`GET ${base}/llm-credential`]: {body: {credential: {configured: false}, programmeSkip: null}},
	'GET /models': {body: {models: [{provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', benchmarkCoverage: 30, benchmarkOutOf: 36, typicalCostUsd: 4}]}},
	[`GET ${base}/members`]: {body: {members: [
		{id: 'u1', email: 'founder@example.test', display_name: null, role, created_at: '2026-10-01', has_signed_in: true},
		{id: 'u2', email: 'colleague@example.test', display_name: null, role: 'company_member', created_at: '2026-10-02', has_signed_in: false},
	]}},
	[`GET ${base}/billing`]: {body: billing()},
	...extra,
})
// DEC-014: no free period set, so no plan is needed and the card is hidden.
const billing = (over: Partial<Billing> = {}): Billing => ({billing: null, hasAccount: false, available: true,
	prices: {subscription: {month: 3000, year: 30000}, own_key: {month: 1000, year: 10000}},
	freePeriodUntil: null, checkoutOpensOn: null, plansRequiredFrom: null, ...over})
const ending = {freePeriodUntil: '2027-01-31', checkoutOpensOn: '2027-01-03', plansRequiredFrom: '2027-02-01'}
const on = (day: string) => vi.useFakeTimers({toFake: ['Date'], now: new Date(`${day}T10:00:00Z`)})
afterEach(() => { vi.useRealTimers() })

test('a member sees the settings read-only, with no way to change them', async () => {
	mockApi(routes('company_member'))
	renderApp(`${base}/settings`)
	expect(await screen.findByText('You can view these settings. Only your company admins can change them.')).toBeInTheDocument()
	expect(await screen.findByLabelText('What does your product do, and for whom?')).toBeDisabled()
	expect(screen.getByLabelText('Tender keywords')).toBeDisabled()
	expect(screen.queryByRole('button', {name: 'Save profile'})).toBeNull()
	expect(screen.queryByRole('button', {name: 'Add key'})).toBeNull()
	expect(screen.queryByLabelText('Invite a colleague')).toBeNull()
	expect(screen.queryByRole('button', {name: 'Remove'})).toBeNull()
})

test('a rejected API key is cleared from the page and the error is shown', async () => {
	const user = userEvent.setup()
	const calls = mockApi(routes('company_admin', {
		[`PUT ${base}/llm-credential`]: {status: 400, body: {error: {code: 'key_rejected', message: 'The provider rejected that key.'}}},
	}))
	renderApp(`${base}/settings`)
	await user.click(await screen.findByRole('button', {name: 'Add key'}))
	const key = screen.getByLabelText('API key')
	expect(key).toHaveAttribute('type', 'password')
	await user.type(key, 'sk-ant-not-a-real-key-000000')
	await user.click(screen.getByRole('button', {name: 'Check and save key'}))

	expect(await screen.findByText('The provider rejected that key.')).toBeInTheDocument()
	expect(screen.getByLabelText('API key')).toHaveValue('')
	expect(calls.find((c) => c.method == 'PUT')?.body).toEqual({provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-not-a-real-key-000000'})
})

test('saving the profile sends lists split by line and by comma', async () => {
	const user = userEvent.setup()
	const calls = mockApi(routes('company_admin', {
		[`PUT ${base}/profile`]: (body) => ({body: {profile: {id: 'p1', version: 1, created_at: '2026-10-27', details: {}, ...(body as object)}}}),
	}))
	renderApp(`${base}/settings`)
	await user.type(await screen.findByLabelText('What does your product do, and for whom?'), 'Routing software for home care providers.')
	await user.click(screen.getByRole('radio', {name: /^UK only/}))
	await user.type(screen.getByLabelText('Tender keywords'), 'care routing, scheduling ,')
	await user.type(screen.getByLabelText('Customers'), 'Health trusts{Enter}{Enter}Care agencies')
	await user.click(screen.getByRole('button', {name: 'Save profile'}))

	expect(await screen.findByText('Profile saved.')).toBeInTheDocument()
	expect(calls.find((c) => c.method == 'PUT')?.body).toMatchObject({
		product_description: 'Routing software for home care providers.',
		regions: ['NI', 'UK'],
		tender_keywords: ['care routing', 'scheduling'],
		cpv_prefixes: [],
		details: {customers: ['Health trusts', 'Care agencies']},
	})
})

test('BEH-016 before checkout opens the plans and prices show, but cannot be bought yet', async () => {
	on('2026-12-01')
	mockApi(routes('company_admin', {[`GET ${base}/billing`]: {body: billing(ending)}}))
	renderApp(`${base}/settings`)
	expect(await screen.findByText('Plans can be chosen from 3 Jan 2027.')).toBeInTheDocument()
	expect(screen.getByText('£30 a month')).toBeInTheDocument()
	expect(screen.getByText('£10 a month')).toBeInTheDocument()
	expect(screen.getByRole('button', {name: 'Choose subscription'})).toBeDisabled()
})

test('BEH-016 an admin chooses the yearly own-key plan and is sent to Stripe Checkout', async () => {
	on('2027-01-10')
	const user = userEvent.setup()
	const calls = mockApi(routes('company_admin', {[`GET ${base}/billing`]: {body: billing(ending)},
		[`POST ${base}/billing/checkout`]: {body: {url: 'https://checkout.stripe.test/session'}}}))
	renderApp(`${base}/settings`)
	await user.click(await screen.findByRole('button', {name: 'Yearly (two months free)'}))
	expect(screen.getByText('£300 a year')).toBeInTheDocument()
	await user.click(screen.getByRole('button', {name: 'Choose own AI key'}))
	await vi.waitFor(() => expect(calls.find((c) => c.method == 'POST')?.body).toEqual({plan: 'own_key', interval: 'year'}))
})

test('BEH-016 a member sees the plans but only admins can choose one', async () => {
	on('2027-01-10')
	mockApi(routes('company_member', {[`GET ${base}/billing`]: {body: billing(ending)}}))
	renderApp(`${base}/settings`)
	expect(await screen.findByText('Only your company admins can choose a plan.')).toBeInTheDocument()
	expect(screen.queryByRole('button', {name: 'Choose subscription'})).toBeNull()
})

test('BEH-016 a subscriber in its trial sees when the first payment is, can manage billing, and needs no key', async () => {
	on('2027-01-10')
	mockApi(routes('company_admin', {[`GET ${base}/billing`]: {body: billing({...ending, hasAccount: true,
		billing: {plan: 'subscription', interval: 'month', status: 'trialing', live: true, currentPeriodEnd: '2027-02-01T00:00:00Z', cancelAtPeriodEnd: false}})}}))
	renderApp(`${base}/settings`)
	expect(await screen.findByText('Subscription, £30 a month')).toBeInTheDocument()
	expect(screen.getByText('1 Feb 2027')).toBeInTheDocument()
	expect(screen.getByRole('button', {name: 'Manage billing'})).toBeInTheDocument()
	expect(await screen.findByText('Not needed: your subscription covers the AI')).toBeInTheDocument()
})

test('BEH-017 after the free period a company without a plan is told its runs are paused', async () => {
	on('2027-02-03')
	mockApi(routes('company_admin', {[`GET ${base}/billing`]: {body: billing(ending)}}))
	renderApp(`${base}/settings`)
	expect(await screen.findByText('No plan: weekly runs are paused')).toBeInTheDocument()
	expect(screen.getByText(/Your weekly reports are paused until a company admin chooses a plan/)).toBeInTheDocument()
})
