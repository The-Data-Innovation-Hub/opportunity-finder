import {expect, test} from 'vitest'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {COMPANY_ID, meAs, mockApi, renderApp} from '../test/app'

const signedOut = {status: 401, body: {error: {code: 'unauthenticated', message: 'Sign in to continue.'}}}

test('BEH-019 a signed-out visitor at / sees the landing page, with sign in and request access', async () => {
	mockApi({'GET /me': signedOut})
	const {router} = renderApp('/')
	expect(await screen.findByRole('heading', {level: 1, name: /Funding and tenders that fit your company/})).toBeInTheDocument()
	expect(router.state.location.pathname).toBe('/')
	const nav = screen.getByRole('navigation', {name: 'Main'})
	expect(within(nav).getByRole('link', {name: 'Sign in'})).toHaveAttribute('href', '/sign-in')
	expect(within(nav).getByRole('link', {name: 'Request access'})).toHaveAttribute('href', '/request-access')
	expect(screen.getByText(/Your first report is free/)).toBeInTheDocument()
})

test('BEH-019 a signed-in user at / still goes straight to their company', async () => {
	mockApi({'GET /me': {body: meAs('company_admin')}})
	const {router} = renderApp('/')
	await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${COMPANY_ID}`))
	expect(screen.queryByRole('link', {name: 'Request access'})).toBeNull()
})

test('BEH-019 signed out anywhere else still goes to sign in, which links to request access', async () => {
	mockApi({'GET /me': signedOut})
	const {router} = renderApp(`/companies/${COMPANY_ID}`)
	await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'))
	expect(await screen.findByText(/New here\?/)).toBeInTheDocument()
	expect(screen.getAllByRole('link', {name: 'Request access'}).length).toBeGreaterThan(0)
})

test('BEH-019 a new company sends an access request without signing in', async () => {
	const user = userEvent.setup()
	const calls = mockApi({'POST /access-requests': {status: 202, body: {received: true}}})
	renderApp('/request-access')
	const send = await screen.findByRole('button', {name: 'Send request'})
	expect(send).toBeDisabled()
	await user.type(screen.getByLabelText('Company name'), 'Ward Robotics Ltd')
	await user.type(screen.getByLabelText('Your name'), 'Sam Rivera')
	await user.type(screen.getByLabelText('Work email'), 'sam@wardrobotics.example')
	expect(send).toBeDisabled()
	await user.click(screen.getByRole('radio', {name: 'Connected Health Cluster'}))
	await user.type(screen.getByLabelText('Anything we should know? (optional)'), 'Discharge planning software.')
	await user.click(send)
	expect(await screen.findByText(/The programme team has your request/)).toHaveTextContent('sam@wardrobotics.example')
	expect(calls.some((c) => c.path == '/me')).toBe(false)
	expect(calls.find((c) => c.method == 'POST')?.body).toEqual({companyName: 'Ward Robotics Ltd', contactName: 'Sam Rivera', email: 'sam@wardrobotics.example',
		cohort: 'connected_health_cluster', message: 'Discharge planning software.', website: ''})
})

test('BEH-019 a refused request shows the reason and keeps what was typed', async () => {
	const user = userEvent.setup()
	mockApi({'POST /access-requests': {status: 429, body: {error: {code: 'rate_limited', message: 'Too many requests. Try again later.'}}}})
	renderApp('/request-access')
	await user.type(await screen.findByLabelText('Company name'), 'Ward Robotics Ltd')
	await user.type(screen.getByLabelText('Your name'), 'Sam Rivera')
	await user.type(screen.getByLabelText('Work email'), 'sam@wardrobotics.example')
	await user.click(screen.getByRole('radio', {name: 'Not sure'}))
	await user.click(screen.getByRole('button', {name: 'Send request'}))
	expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests')
	expect(screen.getByLabelText('Company name')).toHaveValue('Ward Robotics Ltd')
})
