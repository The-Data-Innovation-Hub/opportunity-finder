// BEH-019: a company not on the platform asks for access from the landing
// page. Anyone may send a request, so it is rate-limited, always answered the
// same way, and only stored and passed to the programme admins: no account is
// created (INF-001). Admins read and close requests on the Admin page.
import express from 'express'
import {audit, createRateLimiter, email, invalid, logLine, notFound, oneOf, rateLimit, text, uuidParam} from './Library.js'
import {accessRequestEmail} from '../Services/Mail.js'
import {COHORTS} from '../Services/Plans.js'

export const REQUEST_COHORTS = [...COHORTS, 'not_sure']
// Requests hold a contact's name and email: the cleanup job deletes them
// after ACCESS_REQUEST_DAYS (Worker/Weekly.js).

// Mounted before the session check: the people sending these have no account.
export const accessRequestRoutes = ({pool, mailer, appUrl, limits = {}}) => {
	const router = express.Router()
	const perIp = createRateLimiter({windowSeconds: 3600, max: limits.accessRequestsPerIp ?? 5})

	router.post('/access-requests', rateLimit(perIp), async (request, response) => {
		const b = request.body ?? {}
		// A field people never see: anything in it was filled in by a bot.
		if (b.website) return response.status(202).json({received: true})
		const fields = {
			companyName: text(b.companyName, 'companyName', {max: 200}),
			contactName: text(b.contactName, 'contactName', {max: 200}),
			email: email(b.email),
			cohort: oneOf(b.cohort, 'cohort', REQUEST_COHORTS),
			message: b.message == null || b.message === '' ? null : text(b.message, 'message', {max: 2000}),
		}
		await pool.query('INSERT INTO access_request (company_name, contact_name, email, cohort, message) VALUES ($1, $2, $3, $4, $5)',
			[fields.companyName, fields.contactName, fields.email, fields.cohort, fields.message])
		response.status(202).json({received: true})
		// Sent after the response; a mail failure does not lose the request,
		// which is on the Admin page either way.
		const {rows: admins} = await pool.query(`SELECT u.email FROM programme_admin pa JOIN app_user u ON u.id = pa.user_id WHERE u.disabled_at IS NULL`)
		for (const admin of admins) {
			await mailer.send({to: admin.email, ...accessRequestEmail({...fields, adminLink: `${appUrl}/admin`})})
				.catch((error) => logLine({event: 'access_request_mail_failed', code: error.code}))
		}
	})

	return router
}

// Programme admin only (mounted inside the admin router).
export const accessRequestAdminRoutes = ({pool}) => {
	const router = express.Router()

	router.get('/admin/access-requests', async (request, response) => {
		const {rows} = await pool.query(`SELECT id, company_name, contact_name, email, cohort, message, created_at, handled_at
			FROM access_request ORDER BY handled_at IS NOT NULL, created_at DESC LIMIT 200`)
		response.json({requests: rows})
	})

	router.patch('/admin/access-requests/:id', async (request, response) => {
		const id = uuidParam(request.params.id)
		if (request.body?.handled !== true) throw invalid('Send handled: true')
		const {rows: [row]} = await pool.query(`UPDATE access_request SET handled_at = coalesce(handled_at, now()), handled_by = coalesce(handled_by, $2)
			WHERE id = $1 RETURNING id, handled_at`, [id, request.user.id])
		if (!row) throw notFound()
		await audit(pool, {actorUserId: request.user.id, action: 'access_request.handled', detail: {id}})
		response.json({request: row})
	})

	return router
}
