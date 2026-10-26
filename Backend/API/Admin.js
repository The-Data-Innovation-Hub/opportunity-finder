// Programme admin routes: onboard companies and users, see run status and
// what the service costs. DEC-003: summaries only. Nothing here returns a
// profile, a report's rows, top five or a key; counts and costs only.
import express from 'express'
import {audit, email, forbidden, invalid, isoDate, notFound, oneOf, text, uuidParam, weekStart, withTransaction} from './Library.js'
import {acceptKey, inviteToCompany, sendInvitation} from './Companies.js'

const requireProgrammeAdmin = (request, response, next) => {
	if (!request.user.is_programme_admin) throw forbidden()
	next()
}

const money = (v) => v == null ? 0 : Math.round(Number(v) * 100) / 100

const settingsView = (s) => ({searchEnabled: s.search_enabled, bravePricePer1000Usd: Number(s.brave_price_per_1000_usd),
	monthlyQueryCap: s.monthly_query_cap, reviewDate: s.review_date, updatedAt: s.updated_at})

// DEC-011: the programme's own key, used for every company in the free period.
export const PROGRAMME_SECRET_PREFIX = 'programme-llm-'

export const adminRoutes = ({pool, secrets, mailer, appUrl, checkKey, now = () => new Date()}) => {
	const router = express.Router()
	router.use('/admin', requireProgrammeAdmin)

	router.get('/admin/companies', async (request, response) => {
		const {rows} = await pool.query(`SELECT c.id, c.name, c.status, c.created_at,
				(SELECT count(*)::int FROM company_membership m WHERE m.company_id = c.id) AS members,
				EXISTS (SELECT 1 FROM company_profile p WHERE p.company_id = c.id) AS has_profile,
				k.status AS key_status, k.provider, k.model,
				r.week_start AS last_run_week, r.status AS last_run_status, r.skip_reason AS last_run_skip_reason
			FROM company c
			LEFT JOIN company_llm_credential k ON k.company_id = c.id
			LEFT JOIN LATERAL (SELECT week_start, status, skip_reason FROM search_run WHERE company_id = c.id ORDER BY week_start DESC LIMIT 1) r ON true
			ORDER BY c.name`)
		response.json({companies: rows})
	})

	router.post('/admin/companies', async (request, response) => {
		const name = text(request.body?.name, 'name', {max: 200})
		const company = await withTransaction(pool, async (client) => {
			const {rows} = await client.query('INSERT INTO company (name, created_by) VALUES ($1, $2) RETURNING id, name, status, created_at', [name, request.user.id])
			await audit(client, {companyId: rows[0].id, actorUserId: request.user.id, action: 'company.created'})
			return rows[0]
		})
		response.status(201).json({company})
	})

	router.patch('/admin/companies/:id', async (request, response) => {
		const id = uuidParam(request.params.id)
		const status = request.body?.status == null ? null : oneOf(request.body.status, 'status', ['active', 'paused'])
		const name = request.body?.name == null ? null : text(request.body.name, 'name', {max: 200})
		if (status == null && name == null) throw invalid('Send a status or a name')
		const company = await withTransaction(pool, async (client) => {
			const {rows: [before]} = await client.query('SELECT name, status FROM company WHERE id = $1 FOR UPDATE', [id])
			if (!before) throw notFound()
			const {rows} = await client.query('UPDATE company SET status = coalesce($2, status), name = coalesce($3, name) WHERE id = $1 RETURNING id, name, status',
				[id, status, name])
			if (status != null && status != before.status) await audit(client, {companyId: id, actorUserId: request.user.id, action: 'company.status_changed', detail: {status}})
			if (name != null && name != before.name) await audit(client, {companyId: id, actorUserId: request.user.id, action: 'company.renamed', detail: {from: before.name, to: name}})
			return rows[0]
		})
		response.json({company})
	})

	router.post('/admin/companies/:id/invitations', async (request, response) => {
		const companyId = uuidParam(request.params.id)
		const address = email(request.body?.email)
		const role = oneOf(request.body?.role ?? 'company_admin', 'role', ['company_admin', 'company_member'])
		const {rows} = await pool.query('SELECT name FROM company WHERE id = $1', [companyId])
		if (!rows[0]) throw notFound()
		const result = await inviteToCompany({pool, companyId, address, role, invitedBy: request.user.id})
		await sendInvitation({mailer, appUrl, address, companyName: rows[0].name, token: result.token})
		response.status(201).json({invitation: {userId: result.userId, email: address, role: result.role}})
	})

	router.get('/admin/runs', async (request, response) => {
		const week = request.query.week == null ? null : isoDate(request.query.week, 'week')
		const {rows: weeks} = await pool.query(`SELECT week_start, status, started_at, finished_at, tender_notices, funder_pages, competitions
			FROM weekly_gather WHERE ($1::date IS NULL OR week_start = $1) ORDER BY week_start DESC LIMIT 1`, [week])
		if (!weeks[0]) return response.json({gather: null, runs: []})
		const {rows} = await pool.query(`SELECT c.id AS company_id, c.name AS company, r.status, r.skip_reason, r.error_code, r.provider, r.model,
				r.started_at, r.finished_at, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
				r.model_cost_usd, r.paid_by, r.search_queries, r.search_cost_usd, r.page_reads,
				rp.funding_rows, rp.tender_rows, rp.new_this_week
			FROM search_run r JOIN company c ON c.id = r.company_id LEFT JOIN report rp ON rp.search_run_id = r.id
			WHERE r.week_start = $1 ORDER BY c.name`, [weeks[0].week_start])
		response.json({gather: weeks[0], runs: rows})
	})

	// The KPI card (BEH-012): what the programme pays, separately and in total.
	// Brave is the latest weekly run's queries; Azure is the last seven days of
	// billed hosting. Model cost counts only runs on the programme's key
	// (DEC-011); a company's own key is its own bill.
	router.get('/admin/service-cost', async (request, response) => {
		const today = now()
		const {rows: [settings]} = await pool.query('SELECT * FROM service_setting WHERE id = 1')
		const {rows: [latest]} = await pool.query('SELECT max(week_start) AS week_start FROM search_run')
		const {rows: [programme]} = await pool.query(`SELECT
				coalesce(sum(model_cost_usd) FILTER (WHERE week_start = $1), 0) AS week_usd,
				coalesce(sum(model_cost_usd) FILTER (WHERE started_at >= date_trunc('month', $2::timestamptz)), 0) AS month_usd,
				coalesce(sum(model_cost_usd), 0) AS total_usd
			FROM search_run WHERE paid_by = 'programme'`, [latest.week_start, today])
		const {rows: [brave]} = await pool.query(`SELECT
				coalesce(sum(search_cost_usd) FILTER (WHERE week_start = $1), 0) AS week_usd,
				coalesce(sum(search_queries) FILTER (WHERE week_start = $1), 0)::int AS week_queries,
				count(*) FILTER (WHERE week_start = $1 AND status = 'succeeded')::int AS week_companies,
				coalesce(sum(search_cost_usd), 0) AS total_usd,
				coalesce(sum(search_queries), 0)::int AS total_queries,
				coalesce(sum(search_queries) FILTER (WHERE started_at >= date_trunc('month', $2::timestamptz)), 0)::int AS month_queries
			FROM search_run`, [latest.week_start, today])
		const {rows: azure} = await pool.query(`SELECT currency,
				coalesce(sum(amount) FILTER (WHERE day > ($1::date - 7)), 0) AS week_amount,
				coalesce(sum(amount), 0) AS total_amount, max(day) AS last_day
			FROM azure_cost_daily GROUP BY currency`, [today.toISOString().slice(0, 10)])
		const {rows: weekly} = await pool.query(`SELECT w.week_start::date AS week_start,
				coalesce((SELECT sum(search_cost_usd) FROM search_run r WHERE r.week_start = w.week_start), 0) AS brave_usd,
				coalesce((SELECT sum(model_cost_usd) FROM search_run r WHERE r.week_start = w.week_start AND r.paid_by = 'programme'), 0) AS programme_model_usd,
				coalesce((SELECT sum(amount) FROM azure_cost_daily a WHERE a.day >= w.week_start AND a.day < w.week_start + 7), 0) AS azure_amount
			FROM (SELECT d::date AS week_start FROM generate_series($1::date - 84, $1::date, interval '7 days') AS d) w ORDER BY w.week_start`,
			// Up to the latest run's week: the Sunday run is for the Monday after.
			[[weekStart(today), latest.week_start].filter(Boolean).sort().at(-1)])
		// Two currencies are only added together when they are the same one;
		// a converted figure would hide an exchange-rate assumption.
		const az = azure.length == 1 ? azure[0] : null
		const sameCurrency = az?.currency == 'USD'
		response.json({
			latestWeek: latest.week_start,
			brave: {currency: 'USD', week: money(brave.week_usd), total: money(brave.total_usd), weekQueries: brave.week_queries,
				totalQueries: brave.total_queries, averagePerCompany: brave.week_companies ? money(brave.week_usd / brave.week_companies) : 0,
				averageQueriesPerCompany: brave.week_companies ? Math.round(brave.week_queries / brave.week_companies) : 0, weekCompanies: brave.week_companies,
				monthQueries: brave.month_queries, monthlyQueryCap: settings.monthly_query_cap},
			azure: az ? {currency: az.currency, lastSevenDays: money(az.week_amount), total: money(az.total_amount), collectedTo: az.last_day}
				: (azure.length ? {error: 'more_than_one_currency'} : null),
			// The model cost of runs on the programme's key (DEC-011), latest week.
			programmeModel: {currency: 'USD', week: money(programme.week_usd), month: money(programme.month_usd), total: money(programme.total_usd),
				monthlyCapUsd: Number(settings.programme_model_monthly_cap_usd), freePeriodUntil: settings.free_period_until},
			combined: sameCurrency ? {currency: 'USD', week: money(Number(brave.week_usd) + Number(programme.week_usd) + Number(az.week_amount)),
				total: money(Number(brave.total_usd) + Number(programme.total_usd) + Number(az.total_amount))} : null,
			weekly: weekly.map((w) => ({weekStart: w.week_start, braveUsd: money(w.brave_usd), programmeModelUsd: money(w.programme_model_usd), azure: money(w.azure_amount)})),
			searchEnabled: settings.search_enabled,
			reviewDate: settings.review_date,
		})
	})

	router.get('/admin/service-settings', async (request, response) => {
		const {rows} = await pool.query('SELECT * FROM service_setting WHERE id = 1')
		response.json({settings: settingsView(rows[0])})
	})

	router.put('/admin/service-settings', async (request, response) => {
		const b = request.body ?? {}
		if (typeof b.searchEnabled != 'boolean') throw invalid('searchEnabled must be true or false')
		const price = Number(b.bravePricePer1000Usd)
		if (!Number.isFinite(price) || price < 0 || price > 1000) throw invalid('bravePricePer1000Usd must be a number from 0 to 1000')
		const cap = Number(b.monthlyQueryCap)
		if (!Number.isInteger(cap) || cap < 0 || cap > 10_000_000) throw invalid('monthlyQueryCap must be a whole number')
		const reviewDate = isoDate(b.reviewDate, 'reviewDate')
		const settings = await withTransaction(pool, async (client) => {
			const {rows} = await client.query(`UPDATE service_setting SET search_enabled = $1, brave_price_per_1000_usd = $2, monthly_query_cap = $3,
				review_date = $4, updated_by = $5, updated_at = now() WHERE id = 1 RETURNING *`, [b.searchEnabled, price, cap, reviewDate, request.user.id])
			await audit(client, {actorUserId: request.user.id, action: 'service_settings.updated',
				detail: {searchEnabled: b.searchEnabled, bravePricePer1000Usd: price, monthlyQueryCap: cap, reviewDate}})
			return rows[0]
		})
		response.json({settings: settingsView(settings)})
	})

	// Programme key and free period (DEC-011) -------------------------------------

	const programmeView = async () => {
		const {rows: [c]} = await pool.query(`SELECT p.provider, p.model, p.last_four, p.status, p.checked_at, p.added_at, u.email AS added_by
			FROM programme_llm_credential p LEFT JOIN app_user u ON u.id = p.added_by WHERE p.id = 1`)
		const {rows: [s]} = await pool.query('SELECT free_period_until, programme_model_monthly_cap_usd FROM service_setting WHERE id = 1')
		return {
			credential: c ? {configured: true, provider: c.provider, model: c.model, lastFour: c.last_four, status: c.status,
				checkedAt: c.checked_at, addedAt: c.added_at, addedBy: c.added_by} : {configured: false},
			freePeriodUntil: s.free_period_until,
			monthlyCapUsd: Number(s.programme_model_monthly_cap_usd),
		}
	}

	router.get('/admin/programme-key', async (request, response) => {
		response.json(await programmeView())
	})

	// Same path as a company's key (SEC-002): checked, written to the keys
	// vault, forgotten. Only the last four characters are kept.
	router.put('/admin/programme-key/credential', async (request, response) => {
		const {provider, model, key} = await acceptKey({pool, checkKey, body: request.body})
		const secretName = `${PROGRAMME_SECRET_PREFIX}${provider}`
		await secrets.set(secretName, key)
		const {rows: [old]} = await pool.query('SELECT secret_name FROM programme_llm_credential WHERE id = 1')
		await withTransaction(pool, async (client) => {
			await client.query(`INSERT INTO programme_llm_credential (id, provider, model, secret_name, last_four, status, checked_at, added_by, added_at)
				VALUES (1, $1, $2, $3, $4, 'valid', now(), $5, now())
				ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model, secret_name = EXCLUDED.secret_name,
					last_four = EXCLUDED.last_four, status = 'valid', checked_at = now(), added_by = EXCLUDED.added_by, added_at = now()`,
				[provider, model, secretName, key.slice(-4), request.user.id])
			await audit(client, {actorUserId: request.user.id, action: 'programme_key.saved', detail: {provider, model}})
		})
		// Another provider's earlier key is removed only once the new one is saved.
		if (old && old.secret_name != secretName) await secrets.remove(old.secret_name)
		response.json(await programmeView())
	})

	router.delete('/admin/programme-key/credential', async (request, response) => {
		const {rows: [old]} = await pool.query('SELECT secret_name FROM programme_llm_credential WHERE id = 1')
		if (old) {
			await secrets.remove(old.secret_name)
			await withTransaction(pool, async (client) => {
				await client.query('DELETE FROM programme_llm_credential WHERE id = 1')
				await audit(client, {actorUserId: request.user.id, action: 'programme_key.removed'})
			})
		}
		response.json(await programmeView())
	})

	router.put('/admin/programme-key/settings', async (request, response) => {
		const b = request.body ?? {}
		const until = b.freePeriodUntil == null || b.freePeriodUntil === '' ? null : isoDate(b.freePeriodUntil, 'freePeriodUntil')
		const cap = Number(b.monthlyCapUsd)
		if (!Number.isFinite(cap) || cap < 0 || cap > 100_000) throw invalid('monthlyCapUsd must be a number from 0 to 100000')
		await withTransaction(pool, async (client) => {
			await client.query(`UPDATE service_setting SET free_period_until = $1, programme_model_monthly_cap_usd = $2, updated_by = $3, updated_at = now() WHERE id = 1`,
				[until, cap, request.user.id])
			await audit(client, {actorUserId: request.user.id, action: 'free_period.updated', detail: {freePeriodUntil: until, monthlyCapUsd: cap}})
		})
		response.json(await programmeView())
	})

	return router
}
