// BEH-019: a company not on the platform asks for access from the landing
// page. Anyone may send a request, so it is rate-limited, always answered the
// same way, and only stored and passed to the programme admins: no account is
// created (INF-001). Admins read and close requests on the Admin page.
import express from 'express'
import {APIError, audit, createRateLimiter, email, invalid, logLine, notFound, oneOf, rateLimit, text, uuidParam, withTransaction} from './Library.js'
import {inviteToCompany, sendInvitation} from './Companies.js'
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
export const accessRequestAdminRoutes = ({pool, mailer, appUrl}) => {
	const router = express.Router()

	router.get('/admin/access-requests', async (request, response) => {
		const {rows} = await pool.query(`SELECT r.id, r.company_name, r.contact_name, r.email, r.cohort, r.message, r.created_at, r.handled_at,
				r.company_id, c.name AS accepted_company
			FROM access_request r LEFT JOIN company c ON c.id = r.company_id ORDER BY r.handled_at IS NOT NULL, r.created_at DESC LIMIT 200`)
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

	// Accept in one step: add the company in the group asked for, invite the
	// contact as its company admin and close the request. The admin may correct
	// the company name and must pick a group when the requester was not sure.
	// With companyId the contact joins that existing company instead (the
	// company was already on the platform), and nothing new is added.
	router.post('/admin/access-requests/:id/accept', async (request, response) => {
		const id = uuidParam(request.params.id)
		const b = request.body ?? {}
		const {company, invitation, address} = await withTransaction(pool, async (client) => {
			const {rows: [r]} = await client.query('SELECT company_name, contact_name, email, cohort, handled_at FROM access_request WHERE id = $1 FOR UPDATE', [id])
			if (!r) throw notFound()
			if (r.handled_at) throw new APIError(409, 'already_handled', 'This request has already been handled')
			let c
			if (b.companyId != null) {
				;({rows: [c]} = await client.query('SELECT id, name, status, cohort, created_at FROM company WHERE id = $1', [uuidParam(b.companyId)]))
				if (!c) throw invalid('That company no longer exists')
			} else {
				const name = text(b.companyName ?? r.company_name, 'companyName', {max: 200})
				const cohort = b.cohort == null && r.cohort != 'not_sure' ? r.cohort : oneOf(b.cohort, 'cohort', COHORTS)
				;({rows: [c]} = await client.query('INSERT INTO company (name, cohort, created_by) VALUES ($1, $2, $3) RETURNING id, name, status, cohort, created_at',
					[name, cohort, request.user.id]))
				await audit(client, {companyId: c.id, actorUserId: request.user.id, action: 'company.created', detail: {cohort, accessRequestId: id}})
			}
			// Company admin by default; joining an existing company, the admin may make them a member.
			const role = b.role == null ? 'company_admin' : oneOf(b.role, 'role', ['company_admin', 'company_member'])
			const result = await inviteToCompany({client, companyId: c.id, address: r.email, role, invitedBy: request.user.id})
			await client.query('UPDATE app_user SET display_name = $2 WHERE id = $1 AND display_name IS NULL', [result.userId, r.contact_name])
			await client.query('UPDATE access_request SET handled_at = now(), handled_by = $2, company_id = $3 WHERE id = $1', [id, request.user.id, c.id])
			await audit(client, {companyId: c.id, actorUserId: request.user.id, action: 'access_request.accepted', detail: {id, existingCompany: b.companyId != null}})
			return {company: c, invitation: result, address: r.email}
		})
		// After the commit, as for any invitation: a failed email leaves the
		// company and membership in place, and the admin resends from People.
		await sendInvitation({mailer, appUrl, address, companyName: company.name, token: invitation.token})
		response.status(201).json({company, invitation: {userId: invitation.userId, email: address, role: invitation.role}})
	})

	return router
}
