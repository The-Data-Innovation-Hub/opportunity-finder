import {expect, test, vi} from 'vitest'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {COMPANY_ID, meAs, mockApi, renderApp} from '../test/app'

const card = async (title: string) => within((await screen.findByRole('heading', {name: title})).closest('section')!)

test('a failed first load of the search settings shows the error and a retry, not a spinner (STA-001)', async () => {
	const user = userEvent.setup()
	let failing = true
	mockApi({
		'GET /me': {body: {...meAs('company_admin', {isProgrammeAdmin: true}), companies: []}},
		'GET /admin/service-settings': () => failing
			? {status: 500, body: {error: {code: 'internal', message: 'The database is not answering.'}}}
			: {body: {settings: {searchEnabled: true, bravePricePer1000Usd: 5, monthlyQueryCap: 10000, reviewDate: '2027-01-25', updatedAt: '2026-10-26'}}},
	})
	renderApp('/admin')
	const settings = await card('Search service settings')
	expect(await settings.findByRole('alert')).toHaveTextContent('The database is not answering.')
	expect(settings.queryByRole('status')).toBeNull()

	failing = false
	await user.click(settings.getByRole('button', {name: 'Try again'}))
	expect(await settings.findByRole('checkbox', {name: 'Web search (Brave) is on'})).toBeChecked()
})

test('someone who is not a programme admin is sent away from /admin', async () => {
	mockApi({'GET /me': {body: meAs('company_admin')}})
	const {router} = renderApp('/admin')
	await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${COMPANY_ID}`))
})

test('BEH-016 the Free period card warns when the AI cap cannot cover the subscribers, and companies show their plan', async () => {
	mockApi({
		'GET /me': {body: {...meAs('company_admin', {isProgrammeAdmin: true}), companies: []}},
		'GET /models': {body: {models: [{provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', benchmarkCoverage: 30, benchmarkOutOf: 36, typicalCostUsd: 4}]}},
		'GET /admin/programme-key': {body: {credential: {configured: false}, freePeriodUntil: '2027-01-31', monthlyCapUsd: 100, subscribers: 4}},
		'GET /admin/companies': {body: {companies: [{id: COMPANY_ID, name: 'Care Routing Ltd', status: 'active', cohort: 'ai_in_healthcare', created_at: '2026-10-01', members: 1, has_profile: true,
			key_status: null, provider: null, model: null, last_run_week: null, last_run_status: null, last_run_skip_reason: null,
			billing_plan: 'subscription', billing_status: 'past_due'}]}},
	})
	renderApp('/admin')
	const free = await card('Free period for the AI in Healthcare programme (programme pays the AI model)')
	expect(await free.findByText(/4 companies subscribe\. .*raise it to at least US\$120/)).toBeInTheDocument()
	const companies = await card('Companies')
	expect(await companies.findByText('Subscription: past due')).toBeInTheDocument()
})

test('DEC-015 a programme admin adds a Connected Health Cluster company and can move a company between groups', async () => {
	const user = userEvent.setup()
	const calls = mockApi({
		'GET /me': {body: {...meAs('company_admin', {isProgrammeAdmin: true}), companies: []}},
		'GET /models': {body: {models: []}},
		'GET /admin/programme-key': {body: {credential: {configured: false}, freePeriodUntil: '2027-01-31', monthlyCapUsd: 100, subscribers: 0}},
		'GET /admin/companies': {body: {companies: [{id: COMPANY_ID, name: 'Care Routing Ltd', status: 'active', cohort: 'ai_in_healthcare', created_at: '2026-10-01', members: 1,
			has_profile: true, key_status: null, provider: null, model: null, last_run_week: null, last_run_status: null, last_run_skip_reason: null, billing_plan: null, billing_status: null}]}},
		'POST /admin/companies': {status: 201, body: {company: {id: 'c2', name: 'Cluster Co', status: 'active', cohort: 'connected_health_cluster', created_at: '2026-10-28'}}},
		[`PATCH /admin/companies/${COMPANY_ID}`]: {body: {company: {id: COMPANY_ID, name: 'Care Routing Ltd', status: 'active', cohort: 'connected_health_cluster'}}},
	})
	renderApp('/admin')
	const companies = await card('Companies')
	await user.type(companies.getByLabelText('Add a company'), 'Cluster Co')
	await user.selectOptions(companies.getByLabelText('Group'), 'connected_health_cluster')
	expect(companies.getByText('First report free, then a paid plan')).toBeInTheDocument()
	await user.click(companies.getByRole('button', {name: 'Add company'}))
	await waitFor(() => expect(calls.find((c) => c.method == 'POST')?.body).toEqual({name: 'Cluster Co', cohort: 'connected_health_cluster'}))

	vi.spyOn(window, 'confirm').mockReturnValue(true)
	await user.selectOptions(await companies.findByLabelText('Group for Care Routing Ltd'), 'connected_health_cluster')
	await waitFor(() => expect(calls.find((c) => c.method == 'PATCH')?.body).toEqual({cohort: 'connected_health_cluster'}))
})

test('BEH-019 a programme admin sees waiting access requests and marks one handled', async () => {
	const user = userEvent.setup()
	let handled: string | null = null
	const calls = mockApi({
		'GET /me': {body: {...meAs('company_admin', {isProgrammeAdmin: true}), companies: []}},
		'GET /admin/access-requests': () => ({body: {requests: [{id: 'r1', company_name: 'Ward Robotics Ltd', contact_name: 'Sam Rivera', email: 'sam@wardrobotics.example',
			cohort: 'connected_health_cluster', message: 'Discharge planning software.', created_at: '2026-10-29T10:00:00Z', handled_at: handled}]}}),
		'PATCH /admin/access-requests/r1': () => { handled = '2026-10-29T11:00:00Z'; return {body: {request: {id: 'r1', handled_at: handled}}} },
	})
	renderApp('/admin')
	const requests = await card('Access requests')
	expect(await requests.findByText('1 waiting')).toBeInTheDocument()
	expect(requests.getByText('Ward Robotics Ltd')).toBeInTheDocument()
	expect(requests.getByRole('link', {name: 'sam@wardrobotics.example'})).toHaveAttribute('href', 'mailto:sam@wardrobotics.example')
	await user.click(requests.getByRole('button', {name: 'Mark handled'}))
	expect(await requests.findByText(/No requests waiting/)).toBeInTheDocument()
	expect(requests.getByText('Handled (1)')).toBeInTheDocument()
	expect(calls.find((c) => c.method == 'PATCH')?.body).toEqual({handled: true})
})

test('INF-001 a programme admin views the people invited to a company and resends an expired invitation', async () => {
	const user = userEvent.setup()
	const calls = mockApi({
		'GET /me': {body: {...meAs('company_admin', {isProgrammeAdmin: true}), companies: []}},
		'GET /admin/companies': {body: {companies: [{id: COMPANY_ID, name: 'Care Routing Ltd', status: 'active', cohort: 'ai_in_healthcare', created_at: '2026-10-01', members: 2,
			has_profile: true, key_status: null, provider: null, model: null, last_run_week: null, last_run_status: null, last_run_skip_reason: null, billing_plan: null, billing_status: null}]}},
		[`GET /admin/companies/${COMPANY_ID}/members`]: {body: {members: [
			{id: 'u1', email: 'founder@care.example', display_name: 'Jo Founder', role: 'company_admin', status: 'active', invited_at: '2026-10-01T09:00:00Z', last_signed_in_at: '2026-10-28T09:00:00Z'},
			{id: 'u2', email: 'new@care.example', display_name: null, role: 'company_member', status: 'invitation_expired', invited_at: '2026-10-10T09:00:00Z', last_signed_in_at: null},
		]}},
		[`POST /admin/companies/${COMPANY_ID}/invitations`]: {status: 201, body: {invitation: {userId: 'u2', email: 'new@care.example', role: 'company_member'}}},
	})
	renderApp('/admin')
	const companies = await card('Companies')
	await user.click(await companies.findByRole('button', {name: 'View people at Care Routing Ltd (2)'}))
	const panel = within((await companies.findByRole('heading', {name: 'People at Care Routing Ltd'})).parentElement!.parentElement!)
	const founder = await panel.findByRole('row', {name: /Jo Founder/})
	expect(founder).toHaveTextContent('founder@care.example')
	expect(founder).toHaveTextContent('Admin')
	expect(founder).toHaveTextContent('Active')
	expect(within(founder).queryByRole('button', {name: 'Resend invitation'})).toBeNull()
	const invitee = panel.getByRole('row', {name: /new@care\.example/})
	expect(invitee).toHaveTextContent('Not given')
	expect(invitee).toHaveTextContent('Member')
	expect(invitee).toHaveTextContent('Invitation expired')
	await user.click(within(invitee).getByRole('button', {name: 'Resend invitation'}))
	expect(await panel.findByText(/Invitation sent again to new@care\.example/)).toBeInTheDocument()
	expect(calls.find((c) => c.method == 'POST')?.body).toEqual({email: 'new@care.example', role: 'company_member'})
})
