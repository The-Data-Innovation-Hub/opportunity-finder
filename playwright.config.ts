import {defineConfig, devices} from '@playwright/test'

// Runs against the built frontend (`npm run build` first), served with a
// fresh synthetic database by Backend/Tests/E2e/server.js.
export default defineConfig({
	testDir: 'e2e',
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: {baseURL: 'http://localhost:4173', trace: 'retain-on-failure'},
	projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
	webServer: {
		command: 'node Backend/Tests/E2e/server.js',
		// The port opens only after the database is seeded.
		url: 'http://localhost:4173/health',
		stdout: process.env.CI ? 'pipe' : 'ignore',
		reuseExistingServer: false,
		// SIGTERM lets the server drop its database and roles.
		gracefulShutdown: {signal: 'SIGTERM', timeout: 10_000},
		timeout: 60_000,
	},
})
