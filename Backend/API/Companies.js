// Company-scoped routes. Access comes from the caller's own membership row,
// looked up by the session's user id; the company id in the URL is only a
// selector. A company the caller does not belong to is 404, never 403, so
// one company cannot learn another exists (SEC-001). Programme admins have no
// access here (DEC-003: summaries only).
import express from 'express'
import {APIError, audit, email, forbidden, invalid, isoDate, logLine, notFound, oneOf, pageSize, text, textList, uuidParam, withTransaction} from './Library.js'
import {issueLinkToken, linkFor, INVITATION_DAYS} from './Auth.js'
import {invitationEmail} from '../Services/Mail.js'
import {secretNameFor} from '../Services/SecretStore.js'
import {PROVIDERS} from '../Worker/Providers/index.js'
import {REGIONS, REGION_SCOPES} from '../Worker/Research/search.js'

const ROLES = ['company_admin', 'company_member']

export const membershipOf = async (db, userId, companyId) => {
	const {rows} = await db.query(`SELECT m.role, c.name, c.status FROM company_membership m JOIN company c ON c.id = m.company_id
		WHERE m.user_id = $1 AND m.company_id = $2`, [userId, companyId])
	return rows[0] ?? null
}

export const requireMember = (pool) => async (request, response, next) => {
	const companyId = uuidParam(request.params.companyId)
	const membership = await membershipOf(pool, request.user.id, companyId)
	if (!membership) throw notFound()
	request.companyId = companyId
	request.membership = membership
	next()
}

export const requireCompanyAdmin = (request, response, next) => {
	if (request.membership.role != 'company_admin') throw forbidden()
	next()
}

const PROFILE_COLUMNS = 'id, version, product_description, regions, sectors, tender_keywords, cpv_prefixes, details, created_at'

const profileFromBody = (body = {}) => {
	const details = body.details ?? {}
	if (typeof details != 'object' || Array.isArray(details)) throw invalid('details must be an object')
	if (JSON.stringify(details).length > 20000) throw invalid('details is too large')
	const chosen = textList(body.regions ?? REGIONS, 'regions', {maxItems: 3, allowed: REGIONS})
	// DEC-013: only the three scopes, stored in their canonical order.
	const regions = Object.values(REGION_SCOPES).find((scope) => scope.length == chosen.length && scope.every((r) => chosen.includes(r)))
	if (!regions) throw invalid('regions must be UK and Ireland, UK only, or Ireland and Northern Ireland only')
	return {
		product_description: text(body.product_description, 'product_description', {min: 20, max: 5000}),
		regions,
		sectors: textList(body.sectors, 'sectors', {maxItems: 20, maxLength: 60}),
		tender_keywords: textList(body.tender_keywords, 'tender_keywords', {maxItems: 40, maxLength: 80}),
		cpv_prefixes: textList(body.cpv_prefixes, 'cpv_prefixes', {maxItems: 40, maxLength: 8}).map((p) => {
			if (!/^\d{2,8}$/.test(p)) throw invalid('cpv_prefixes must be 2 to 8 digit CPV codes')
			return p
		}),
		details,
	}
}

// Validates a key submitted for a company or for the programme and checks it
// with the provider's free call. The key is returned only to be written to
// the secret store; it is never logged or kept.
export const acceptKey = async ({pool, checkKey, body}) => {
	const provider = oneOf(body?.provider, 'provider', Object.keys(PROVIDERS))
	const model = text(body?.model, 'model', {max: 100})
	const apiKey = body?.apiKey
	if (typeof apiKey != 'string' || apiKey.trim().length < 20 || apiKey.length > 500 || /\s/.test(apiKey.trim())) throw invalid('apiKey does not look like an API key')
	const key = apiKey.trim()
	const {rows: approved} = await pool.query('SELECT 1 FROM approved_model WHERE provider = $1 AND model = $2 AND approved_at IS NOT NULL', [provider, model])
	if (!approved[0]) throw invalid('That model is not on the approved list')
	let status
	try {
		status = await checkKey(provider, key)
	} catch (error) {
		logLine({event: 'key_check_unavailable', provider})
		throw new APIError(502, 'provider_unavailable', 'Could not reach the provider to check the key. Please try again.')
	}
	if (status != 'valid') throw new APIError(400, 'key_rejected', 'The provider did not accept this key')
	return {provider, model, key}
}

// DEC-011: the free period as companies see it: the end date, and whether
// the programme's key works. What the programme spends is not a company's
// business.
export const freePeriodFor = async (pool, today = new Date()) => {
	const {rows: [s]} = await pool.query(`SELECT s.free_period_until, coalesce(p.status = 'valid', false) AS key_working
		FROM service_setting s LEFT JOIN programme_llm_credential p ON p.id = 1 WHERE s.id = 1`)
	return s?.free_period_until && today.toISOString().slice(0, 10) <= s.free_period_until ? {until: s.free_period_until, keyWorking: s.key_working} : null
}

// A free-period run skipped for the programme's reasons, so the company's
// page can say why its report is missing (no amounts).
const PROGRAMME_SKIPS = ['programme_key_problem', 'programme_budget_reached']

const credentialView = (row, role) => {
	if (!row) return {configured: false}
	const view = {configured: true, provider: row.provider, model: row.model, status: row.status}
	// SEC-002: members see whether runs will work; only admins see which key.
	if (role == 'company_admin') Object.assign(view, {lastFour: row.last_four, checkedAt: row.checked_at, addedAt: row.added_at, addedBy: row.added_by_email})
	return view
}

export const companyRoutes = ({pool, secrets, blobs, mailer, appUrl, checkKey}) => {
	const router = express.Router()
	const member = requireMember(pool)

	router.get('/me', async (request, response) => {
		const {rows} = await pool.query(`SELECT c.id, c.name, c.status, m.role FROM company_membership m JOIN company c ON c.id = m.company_id
			WHERE m.user_id = $1 ORDER BY c.name`, [request.user.id])
		response.json({
			user: {id: request.user.id, email: request.user.email, displayName: request.user.display_name},
			isProgrammeAdmin: request.user.is_programme_admin,
			companies: rows.map((r) => ({id: r.id, name: r.name, status: r.status, role: r.role})),
			freePeriod: await freePeriodFor(pool),
		})
	})

	router.get('/models', async (request, response) => {
		const {rows} = await pool.query(`SELECT provider, model, label, benchmark_coverage, benchmark_cost_usd FROM approved_model
			WHERE approved_at IS NOT NULL ORDER BY provider, label`)
		response.json({models: rows.filter((r) => PROVIDERS[r.provider]).map((r) => ({provider: r.provider, model: r.model, label: r.label,
			benchmarkCoverage: r.benchmark_coverage, benchmarkOutOf: 36, typicalCostUsd: r.benchmark_cost_usd == null ? null : Number(r.benchmark_cost_usd)}))})
	})

	// Profile (BEH-001, BEH-008) ------------------------------------------------

	router.get('/companies/:companyId/profile', member, async (request, response) => {
		const {rows} = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM company_profile WHERE company_id = $1 ORDER BY version DESC LIMIT 1`, [request.companyId])
		response.json({profile: rows[0] ?? null})
	})

	// Each save is a new version, so every run records the profile it used.
	router.put('/companies/:companyId/profile', member, requireCompanyAdmin, async (request, response) => {
		const p = profileFromBody(request.body)
		const profile = await withTransaction(pool, async (client) => {
			// Serialises concurrent saves for one company so versions never clash.
			await client.query('SELECT id FROM company WHERE id = $1 FOR UPDATE', [request.companyId])
			const {rows} = await client.query(`INSERT INTO company_profile (company_id, version, product_description, regions, sectors, tender_keywords, cpv_prefixes, details, created_by)
				SELECT $1, coalesce(max(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8 FROM company_profile WHERE company_id = $1
				RETURNING ${PROFILE_COLUMNS}`,
				[request.companyId, p.product_description, p.regions, p.sectors, p.tender_keywords, p.cpv_prefixes, p.details, request.user.id])
			await audit(client, {companyId: request.companyId, actorUserId: request.user.id, action: 'profile.updated', detail: {version: rows[0].version}})
			return rows[0]
		})
		response.json({profile})
	})

	// Reports (BEH-004) -----------------------------------------------------------

	router.get('/companies/:companyId/reports', member, async (request, response) => {
		const limit = pageSize(request.query.limit)
		const before = request.query.before == null ? null : isoDate(request.query.before, 'before')
		const {rows} = await pool.query(`SELECT id, week_start, funding_rows, tender_rows, new_this_week, created_at FROM report
			WHERE company_id = $1 AND ($2::date IS NULL OR week_start < $2) ORDER BY week_start DESC LIMIT $3`,
			[request.companyId, before, limit + 1])
		response.json({reports: rows.slice(0, limit), nextBefore: rows.length > limit ? rows[limit - 1].week_start : null})
	})

	const reportFor = async (companyId, reportId) => {
		const {rows} = await pool.query(`SELECT id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note, created_at
			FROM report WHERE company_id = $1 AND id = $2`, [companyId, uuidParam(reportId)])
		if (!rows[0]) throw notFound()
		return rows[0]
	}

	router.get('/companies/:companyId/reports/:reportId', member, async (request, response) => {
		const {blob_name, ...report} = await reportFor(request.companyId, request.params.reportId)
		response.json({report})
	})

	router.get('/companies/:companyId/reports/:reportId/download', member, async (request, response) => {
		const report = await reportFor(request.companyId, request.params.reportId)
		const safeName = request.membership.name.replace(/[^\w]+/g, '_').slice(0, 60)
		const link = await blobs.downloadUrl(report.blob_name, `${safeName}_Funding_and_Tenders_${String(report.week_start).slice(0, 10)}.xlsx`)
		response.json(link)
	})

	router.get('/companies/:companyId/opportunities', member, async (request, response) => {
		const week = request.query.week == null ? null : isoDate(request.query.week, 'week')
		const kind = request.query.kind == null ? null : oneOf(request.query.kind, 'kind', ['funding', 'tender'])
		const status = request.query.status == null ? null : oneOf(request.query.status, 'status', ['Open', 'Rolling', 'Opening soon', 'Closed'])
		const {rows: reports} = await pool.query(`SELECT id, week_start FROM report WHERE company_id = $1 AND ($2::date IS NULL OR week_start = $2)
			ORDER BY week_start DESC LIMIT 1`, [request.companyId, week])
		if (!reports[0]) return response.json({weekStart: week, rows: []})
		const {rows} = await pool.query(`SELECT id, kind, region, name, website, status, closing_date, closed_since, new_this_week, row_data
			FROM report_row WHERE company_id = $1 AND report_id = $2 AND ($3::text IS NULL OR kind = $3) AND ($4::text IS NULL OR status = $4)
			ORDER BY kind, region, name`, [request.companyId, reports[0].id, kind, status])
		response.json({weekStart: reports[0].week_start, reportId: reports[0].id, rows})
	})

	// Model provider key (BEH-010, SEC-002) --------------------------------------

	const credentialRow = async (companyId) => (await pool.query(`SELECT c.provider, c.model, c.secret_name, c.last_four, c.status, c.checked_at, c.added_at, u.email AS added_by_email
		FROM company_llm_credential c LEFT JOIN app_user u ON u.id = c.added_by WHERE c.company_id = $1`, [companyId])).rows[0]

	router.get('/companies/:companyId/llm-credential', member, async (request, response) => {
		const {rows: [last]} = await pool.query(`SELECT week_start, skip_reason FROM search_run WHERE company_id = $1 ORDER BY week_start DESC LIMIT 1`, [request.companyId])
		response.json({credential: credentialView(await credentialRow(request.companyId), request.membership.role),
			programmeSkip: PROGRAMME_SKIPS.includes(last?.skip_reason) ? {week: last.week_start, reason: last.skip_reason} : null})
	})

	// The key is checked with the provider's free call, written to the secret
	// store, and then forgotten: it is never logged, stored in the database or
	// returned. Only its last four characters are kept, for the settings page.
	router.put('/companies/:companyId/llm-credential', member, requireCompanyAdmin, async (request, response) => {
		const {provider, model, key} = await acceptKey({pool, checkKey, body: request.body})
		const secretName = secretNameFor(request.companyId)
		await secrets.set(secretName, key)
		await withTransaction(pool, async (client) => {
			await client.query(`INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four, status, checked_at, added_by, added_at)
				VALUES ($1, $2, $3, $4, $5, 'valid', now(), $6, now())
				ON CONFLICT (company_id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model, secret_name = EXCLUDED.secret_name,
					last_four = EXCLUDED.last_four, status = 'valid', checked_at = now(), added_by = EXCLUDED.added_by, added_at = now()`,
				[request.companyId, provider, model, secretName, key.slice(-4), request.user.id])
			await audit(client, {companyId: request.companyId, actorUserId: request.user.id, action: 'llm_key.saved', detail: {provider, model}})
		})
		response.json({credential: credentialView(await credentialRow(request.companyId), 'company_admin')})
	})

	router.delete('/companies/:companyId/llm-credential', member, requireCompanyAdmin, async (request, response) => {
		const row = await credentialRow(request.companyId)
		if (row) {
			await secrets.remove(row.secret_name)
			await withTransaction(pool, async (client) => {
				await client.query('DELETE FROM company_llm_credential WHERE company_id = $1', [request.companyId])
				await audit(client, {companyId: request.companyId, actorUserId: request.user.id, action: 'llm_key.removed'})
			})
		}
		response.json({credential: {configured: false}})
	})

	// Colleagues (INF-002) ----------------------------------------------------------

	router.get('/companies/:companyId/members', member, async (request, response) => {
		const {rows} = await pool.query(`SELECT u.id, u.email, u.display_name, m.role, m.created_at,
				EXISTS (SELECT 1 FROM user_session s WHERE s.user_id = u.id) AS has_signed_in
			FROM company_membership m JOIN app_user u ON u.id = m.user_id WHERE m.company_id = $1 ORDER BY u.email`, [request.companyId])
		response.json({members: rows})
	})

	router.post('/companies/:companyId/members', member, requireCompanyAdmin, async (request, response) => {
		const address = email(request.body?.email)
		const role = oneOf(request.body?.role ?? 'company_member', 'role', ROLES)
		const result = await inviteToCompany({pool, companyId: request.companyId, companyName: request.membership.name, address, role, invitedBy: request.user.id})
		await sendInvitation({mailer, appUrl, address, companyName: request.membership.name, token: result.token})
		response.status(201).json({member: {id: result.userId, email: address, role: result.role}})
	})

	router.delete('/companies/:companyId/members/:userId', member, requireCompanyAdmin, async (request, response) => {
		const userId = uuidParam(request.params.userId)
		await withTransaction(pool, async (client) => {
			const {rows: admins} = await client.query(`SELECT user_id FROM company_membership WHERE company_id = $1 AND role = 'company_admin' FOR UPDATE`, [request.companyId])
			if (admins.length == 1 && admins[0].user_id == userId) throw new APIError(409, 'last_admin', 'A company needs at least one admin')
			const {rowCount} = await client.query('DELETE FROM company_membership WHERE company_id = $1 AND user_id = $2', [request.companyId, userId])
			if (!rowCount) throw notFound()
			await audit(client, {companyId: request.companyId, actorUserId: request.user.id, action: 'member.removed', detail: {userId}})
		})
		response.status(204).end()
	})

	return router
}

// Shared by company admins and programme admins. Creates the account if
// needed, adds (or updates) the membership, and issues an invitation link.
// An invitation never changes an existing member's role (re-sending to an
// admin must not demote them, and the last-admin rule lives in one place),
// and never goes to a programme admin: DEC-003 keeps them out of company data.
export const inviteToCompany = ({pool, companyId, address, role, invitedBy}) => withTransaction(pool, async (client) => {
	const {rows: users} = await client.query(`INSERT INTO app_user (email) VALUES ($1)
		ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, disabled_at,
			EXISTS (SELECT 1 FROM programme_admin pa WHERE pa.user_id = app_user.id) AS is_programme_admin`, [address])
	if (users[0].disabled_at) throw new APIError(409, 'user_disabled', 'That account is disabled')
	if (users[0].is_programme_admin) {
		await audit(client, {companyId, actorUserId: invitedBy, action: 'member.invite_refused', detail: {reason: 'programme_admin'}})
		throw new APIError(409, 'programme_admin', 'Programme admins cannot be members of a company')
	}
	const userId = users[0].id
	const {rows: [membership]} = await client.query(`INSERT INTO company_membership (company_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
		ON CONFLICT (company_id, user_id) DO UPDATE SET company_id = EXCLUDED.company_id RETURNING role, (xmax = 0) AS created`,
		[companyId, userId, role, invitedBy])
	const token = await issueLinkToken(client, userId, 'invitation')
	await audit(client, {companyId, actorUserId: invitedBy, action: membership.created ? 'member.invited' : 'member.invitation_resent', detail: {userId, role: membership.role}})
	return {userId, token, role: membership.role}
})

export const sendInvitation = async ({mailer, appUrl, address, companyName, token}) => {
	try {
		await mailer.send({to: address, ...invitationEmail({link: linkFor(appUrl, token), companyName, days: INVITATION_DAYS})})
	} catch (error) {
		// The membership stands; the admin can resend. The failure is logged by
		// code only, never by address.
		logLine({event: 'invitation_mail_failed', code: error.code})
		throw new APIError(502, 'mail_failed', 'The invitation was saved but the email could not be sent. Try resending it.')
	}
}
