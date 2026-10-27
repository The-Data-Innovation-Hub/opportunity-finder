import {expect, test} from 'vitest'
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
