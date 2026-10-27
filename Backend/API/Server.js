// API entry point. Configuration is checked before anything listens; no
// value is printed. Migrations are not run here (`npm run migrate`).
import {createPool} from '../Database/Connection.js'
import {createMailer} from '../Services/Mail.js'
import {createSecretStore} from '../Services/SecretStore.js'
import {createBlobStore} from '../Services/BlobStore.js'
import {createBilling} from '../Services/Billing.js'
import {providerFor} from '../Worker/Providers/index.js'
import {createApp} from './App.js'
import {logLine} from './Library.js'

const required = ['OPPORTUNITY_FINDER_DATABASE_URL', 'APP_URL']
const production = process.env.NODE_ENV == 'production'
if (production) required.push('KEY_VAULT_URL', 'BLOB_ACCOUNT_URL', 'ACS_EMAIL_ENDPOINT')
const missing = required.filter((name) => !process.env[name])
if (missing.length) {
	console.error(`[api] missing configuration: ${missing.join(', ')}`)
	process.exit(1)
}

const pool = createPool({connectionString: process.env.OPPORTUNITY_FINDER_RUNTIME_DATABASE_URL ?? process.env.OPPORTUNITY_FINDER_DATABASE_URL})
pool.on('error', (error) => logLine({event: 'pool_error', message: error.message}))

const app = createApp({
	pool,
	mailer: createMailer(),
	secrets: createSecretStore(),
	blobs: createBlobStore(),
	checkKey: (provider, key) => providerFor(provider).checkApiKey(key),
	// DEC-014: off until the Stripe settings are present (all or none).
	billing: createBilling(),
	appUrl: process.env.APP_URL,
	allowedOrigins: (process.env.ALLOWED_ORIGINS ?? process.env.APP_URL).split(',').map((o) => o.trim()),
	secureCookies: production,
	trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
	frontendDir: process.env.FRONTEND_DIR,
})

const port = Number(process.env.PORT ?? 3001)
const server = app.listen(port, () => logLine({event: 'listening', port}))
server.requestTimeout = 30_000

const shutdown = (signal) => {
	logLine({event: 'shutdown', signal})
	server.close(async () => {
		await pool.end()
		process.exit(0)
	})
	setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
