// Builds the Express app from its dependencies, so tests can pass fakes for
// mail, secrets, blobs and the provider key check.
import {existsSync} from 'node:fs'
import {join, resolve} from 'node:path'
import express from 'express'
import {accessLog, errorHandler, notFound, securityHeaders} from './Library.js'
import {authRoutes, loadSession, requireSameOrigin, requireUser} from './Auth.js'
import {companyRoutes} from './Companies.js'
import {adminRoutes} from './Admin.js'
import {billingRoutes, stripeWebhook} from './Billing.js'
import {accessRequestRoutes} from './AccessRequests.js'

export const JSON_BODY_LIMIT = '64kb'

export const createApp = ({pool, mailer, secrets, blobs, checkKey, billing = null, appUrl, allowedOrigins = [appUrl], secureCookies = true, trustProxy = false, frontendDir, rateLimits, now}) => {
	const app = express()
	app.disable('x-powered-by')
	app.set('trust proxy', trustProxy)
	app.use(accessLog)

	app.get('/health', (request, response) => response.json({ok: true}))
	app.get('/ready', async (request, response) => {
		try {
			await pool.query('SELECT 1')
			response.json({ok: true})
		} catch {
			response.status(503).json({ok: false})
		}
	})

	const api = express.Router()
	api.use(securityHeaders)
	api.use(stripeWebhook({pool, billing}))
	api.use(express.json({limit: JSON_BODY_LIMIT}))
	api.use(requireSameOrigin(allowedOrigins))
	api.use(loadSession(pool))
	api.use(authRoutes({pool, mailer, appUrl, secureCookies, limits: rateLimits}))
	api.use(accessRequestRoutes({pool, mailer, appUrl, limits: rateLimits}))
	api.use(requireUser)
	api.use(companyRoutes({pool, secrets, blobs, mailer, appUrl, checkKey}))
	api.use(billingRoutes({pool, billing, appUrl, now}))
	api.use(adminRoutes({pool, secrets, mailer, appUrl, checkKey, now}))
	api.use(() => { throw notFound() })
	app.use('/api', api)

	if (blobs.kind == 'local') app.get('/dev-blobs/:name', async (request, response) => response.send(await blobs.get(request.params.name)))

	// In Azure the API serves the built frontend from the same origin, so the
	// session cookie never crosses sites.
	if (frontendDir && existsSync(frontendDir)) {
		const dir = resolve(frontendDir)
		// The page's own policy: scripts, styles and API calls from this origin
		// only, so injected markup cannot load or send anything elsewhere.
		app.use((request, response, next) => {
			response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
			response.setHeader('X-Content-Type-Options', 'nosniff')
			response.setHeader('Referrer-Policy', 'no-referrer')
			if (request.secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
			next()
		})
		app.use('/assets', express.static(join(dir, 'assets'), {immutable: true, maxAge: '1y', fallthrough: false}))
		app.use(express.static(dir, {index: false, maxAge: 0}))
		app.get('/{*path}', (request, response) => response.sendFile(join(dir, 'index.html'), {headers: {'Cache-Control': 'no-cache'}}))
	}

	app.use(errorHandler)
	return app
}
