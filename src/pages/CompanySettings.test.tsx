import {expect, test} from 'vitest'
import {screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {COMPANY_ID, meAs, mockApi, renderApp, type ApiRoutes} from '../test/app'
import type {Role} from '../api'

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
	...extra,
})

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
