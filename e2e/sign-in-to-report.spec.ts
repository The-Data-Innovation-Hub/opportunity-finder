import {expect, test} from '@playwright/test'

// One real journey through the built app, the API and a fresh database:
// start at the landing page, sign in with an emailed link, read the week's report, open settings,
// sign out. Any console error (a CSP violation included) fails it.
test('a company admin signs in, reads the report, opens settings and signs out', async ({page, request}) => {
	const errors: string[] = []
	page.on('console', (message) => {
		// Signed out, /api/me answers 401 by design and the browser logs it.
		if (message.type() == 'error' && !/status of 401/.test(message.text())) errors.push(message.text())
	})
	page.on('pageerror', (error) => errors.push(error.message))

	// Signed out, the home page is the landing page (BEH-019).
	await page.goto('/')
	await expect(page.getByRole('heading', {level: 1, name: /Funding and tenders that fit your company/})).toBeVisible()
	await page.getByRole('navigation', {name: 'Main'}).getByRole('link', {name: 'Sign in'}).click()
	await expect(page).toHaveURL(/\/sign-in$/)
	await page.getByLabel('Email address').fill('founder@example.test')
	await page.getByRole('button', {name: 'Email me a sign-in link'}).click()
	await expect(page.getByText(/a sign-in link is on its way/)).toBeVisible()

	const {link} = await (await request.get('/__e2e/last-link')).json()
	expect(link).toMatch(/^http:\/\/localhost:4173\/sign-in#token=/)
	// Hold the verify call to see the address bar while the token is in use:
	// it must already be gone, so it never lands in history or a referrer.
	let addressDuringVerify = ''
	await page.route('**/api/auth/verify', async (route) => {
		addressDuringVerify = await page.evaluate(() => location.href)
		await route.continue()
	})
	await page.goto(link)

	// One company and not a programme admin: straight to its report.
	await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/)
	expect(addressDuringVerify).toBe('http://localhost:4173/sign-in')
	await expect(page.getByRole('heading', {level: 1, name: 'Care Routing Ltd'})).toBeVisible()
	await expect(page.getByRole('heading', {name: 'Top 5 this week'})).toBeVisible()
	await expect(page.getByText('Funds routing software at TRL 5-6.')).toBeVisible()

	const table = page.getByRole('table')
	await expect(table.getByRole('row', {name: /Smart Grant/})).toBeVisible()
	await expect(table.getByRole('row', {name: /Net Zero Fund/})).toBeVisible()
	await page.getByRole('button', {name: 'Tenders (1)'}).click()
	await expect(page.getByRole('button', {name: 'Tenders (1)'})).toHaveAttribute('aria-pressed', 'true')
	await expect(table.getByRole('row', {name: /Care Routing Tender/})).toBeVisible()
	await expect(table.getByRole('row', {name: /Smart Grant/})).toHaveCount(0)

	await page.getByRole('navigation', {name: 'Company'}).getByRole('link', {name: 'Settings'}).click()
	await expect(page.getByLabel('What does your product do, and for whom?')).toHaveValue('Routing software for home care providers.')
	await expect(page.getByRole('button', {name: 'Save profile'})).toBeEnabled()

	await page.getByRole('button', {name: 'Sign out'}).click()
	await expect(page).toHaveURL(/\/sign-in$/)
	await page.goto('/')
	await expect(page.getByRole('link', {name: 'Request access'}).first()).toBeVisible()
	await page.goto('/companies/00000000-0000-4000-8000-000000000000')
	await expect(page).toHaveURL(/\/sign-in$/)

	expect(errors).toEqual([])
})
