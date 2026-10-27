import {beforeEach, expect, test, vi} from 'vitest'
import {screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {COMPANY_ID, meAs, mockApi, renderApp} from '../test/app'
import type {OpportunityRow, Report} from '../api'

const WEEK = '2026-10-26'
const summary = {id: 'r1', week_start: WEEK, funding_rows: 3, tender_rows: 1, new_this_week: 1, created_at: '2026-10-26T06:00:00Z'}
const report: Report = {...summary, top_five: [], also_checked: [], sources: [], note: 'Checked against 214 sources.'}
const row = (r: Partial<OpportunityRow> & Pick<OpportunityRow, 'id' | 'name'>): OpportunityRow => ({
	kind: 'funding', region: 'UK', website: null, status: 'Open', closing_date: null, closed_since: null, new_this_week: false, row_data: {}, ...r,
})
const rows = [
	row({id: '1', name: 'Smart Grant', website: 'https://example.org/smart', closing_date: '2026-10-26', new_this_week: true, row_data: {funder: 'Innovate UK'}}),
	row({id: '2', name: 'Net Zero Fund', region: 'IE', website: 'javascript:alert(1)', closing_date: '2026-10-27', row_data: {funder: 'Enterprise Ireland'}}),
	row({id: '3', name: 'Old Scheme', region: 'NI', status: 'Closed', closing_date: '2026-11-10', row_data: {funder: 'Invest NI'}}),
	row({id: '4', name: 'Care Routing Tender', kind: 'tender', row_data: {buyer: 'Health Trust'}}),
]

beforeEach(() => {
	vi.useFakeTimers({toFake: ['Date']})
	vi.setSystemTime(new Date('2026-10-26T10:00:00Z'))
	mockApi({
		'GET /me': {body: meAs('company_admin')},
		[`GET /companies/${COMPANY_ID}/reports`]: {body: {reports: [summary]}},
		[`GET /companies/${COMPANY_ID}/reports/r1`]: {body: {report}},
		[`GET /companies/${COMPANY_ID}/opportunities`]: {body: {rows}},
	})
})

const table = async () => within(await screen.findByRole('table'))
const names = async () => (await table()).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)

test('closing dates count down to "Closes today"; closed rows get no countdown', async () => {
	renderApp(`/companies/${COMPANY_ID}`)
	const t = await table()
	expect(t.getByText('Closes today')).toBeInTheDocument()
	expect(t.getByText('1 day left')).toBeInTheDocument()
	// Old Scheme is closed, so only the two open rows count down.
	expect(t.getAllByText(/^(Closes today|\d+ days? left)$/)).toHaveLength(2)
})

test('only http(s) websites become links', async () => {
	renderApp(`/companies/${COMPANY_ID}`)
	const t = await table()
	expect(t.getByRole('link', {name: 'Smart Grant'})).toHaveAttribute('href', 'https://example.org/smart')
	expect(t.queryByRole('link', {name: 'Net Zero Fund'})).toBeNull()
	expect(t.getByText('Net Zero Fund')).toBeInTheDocument()
})

test('the Funding/Tenders switch is a pair of pressed buttons', async () => {
	const user = userEvent.setup()
	renderApp(`/companies/${COMPANY_ID}`)
	await table()
	const tenders = screen.getByRole('button', {name: 'Tenders (1)'})
	expect(screen.getByRole('button', {name: 'Funding (3)'})).toHaveAttribute('aria-pressed', 'true')
	await user.click(tenders)
	expect(tenders).toHaveAttribute('aria-pressed', 'true')
	expect(await names()).toEqual([expect.stringContaining('Care Routing Tender')])
})

test('search, status and "new this week" filter the funding rows', async () => {
	const user = userEvent.setup()
	renderApp(`/companies/${COMPANY_ID}`)
	await table()
	// Search matches the funder as well as the name.
	await user.type(screen.getByRole('textbox', {name: 'Search by name or funder'}), 'enterprise')
	expect(await names()).toEqual([expect.stringContaining('Net Zero Fund')])
	await user.clear(screen.getByRole('textbox', {name: 'Search by name or funder'}))

	await user.selectOptions(screen.getByRole('combobox', {name: 'Status'}), 'Closed')
	expect(await names()).toEqual([expect.stringContaining('Old Scheme')])
	await user.selectOptions(screen.getByRole('combobox', {name: 'Status'}), '')

	await user.click(screen.getByRole('checkbox', {name: 'New this week only'}))
	expect(await names()).toEqual([expect.stringContaining('Smart Grant')])
})
