// The weekly job (BEH-003): gather once, then each active company's run, five
// at a time. Every step is idempotent on (company, week), so a retried job
// picks up only what has not succeeded: a succeeded run is never repeated and
// never billed twice.
//
// Which week: the Sunday-night run builds the report for the Monday that
// follows, so the target week is the Monday on or after tomorrow's UK date.
import {weekStart, logLine, isCalendarDate} from '../API/Library.js'
import {buildCompanyReport} from './CompanyReport.js'
import {LIMITS} from './Research/tools.js'
import {scopeRegions} from './Research/search.js'
import {buildWorkbook} from './Report/workbook.js'
import {providerFor} from './Providers/index.js'
import {CLUSTER, FREE_PERIOD_NOTICE_DAYS, LIVE_PLAN_STATUSES, hasPlanSql} from '../Services/Plans.js'

export const COMPANY_CONCURRENCY = 5
export const targetWeek = (now = new Date()) => weekStart(new Date(now.getTime() + 864e5))

// A run left 'running' longer than the weekly job's timeout belongs to a
// replica that died; it may be claimed again.
export const STALE_RUN_HOURS = 7

const STATUSES = ['Open', 'Rolling', 'Opening soon', 'Closed']
const dateOrNull = (v) => isCalendarDate(v) ? v : null

// Model output is untrusted: each row is cleaned so that saving it cannot
// fail on a value the database would reject (a 30 February, an unknown
// status, a missing name), which would otherwise fail the run after the
// company's model had already been billed.
export const cleanRow = (kind, row, today) => {
	const name = String((kind == 'funding' ? row.fund : row.title) ?? '').trim().slice(0, 500) || '(untitled)'
	const status = STATUSES.includes(row.status) ? row.status : 'Open'
	return {
		kind, name, status,
		region: ['NI', 'IE', 'UK'].includes(row.region) ? row.region : 'UK',
		website: typeof row.website == 'string' && row.website ? row.website.slice(0, 2000) : null,
		closing_date: dateOrNull(row.closing_date),
		closed_since: status == 'Closed' ? (dateOrNull(row.closed_since) ?? today) : null,
		new_this_week: Boolean(row.new_this_week),
		row: {...row, status},
	}
}

// Runs fn over items with at most `limit` in flight.
export const eachLimited = async (items, limit, fn) => {
	const queue = [...items]
	const workers = Array.from({length: Math.min(limit, queue.length)}, async () => {
		while (queue.length) await fn(queue.shift())
	})
	await Promise.all(workers)
}

// --- Gather ---------------------------------------------------------------------

// fetchers: {tenders({from, to}), ieTenders({since}), grants(), funderPages()}
export const gatherWeek = async ({pool, blobs, week, fetchers, now = new Date(), log = () => {}}) => {
	const {rows: [existing]} = await pool.query('SELECT status, blob_name FROM weekly_gather WHERE week_start = $1', [week])
	if (existing?.status == 'succeeded') {
		log(`gather for ${week} already done`)
		return JSON.parse(String(await blobs.get(existing.blob_name)))
	}
	await pool.query(`INSERT INTO weekly_gather (week_start, status) VALUES ($1, 'running')
		ON CONFLICT (week_start) DO UPDATE SET status = 'running', started_at = now(), finished_at = NULL, error_message = NULL`, [week])
	try {
		const from = new Date(now.getTime() - 7 * 864e5)
		const gather = {
			ukNotices: await fetchers.tenders({from: from.toISOString().slice(0, 19), to: now.toISOString().slice(0, 19), log}),
			ieNotices: await fetchers.ieTenders({since: from.toISOString().slice(0, 10)}),
			grants: await fetchers.grants(),
			funderPages: await fetchers.funderPages({log}),
		}
		const blobName = `gathers/${week}.json`
		await blobs.put(blobName, Buffer.from(JSON.stringify(gather)), 'application/json')
		await pool.query(`UPDATE weekly_gather SET status = 'succeeded', finished_at = now(), blob_name = $2,
			tender_notices = $3, funder_pages = $4, competitions = $5 WHERE week_start = $1`,
			[week, blobName, gather.ukNotices.length + gather.ieNotices.length, gather.funderPages.pages.length, gather.funderPages.competitions?.length ?? 0])
		return gather
	} catch (error) {
		await pool.query(`UPDATE weekly_gather SET status = 'failed', finished_at = now(), error_message = $2 WHERE week_start = $1`,
			[week, String(error.message).slice(0, 500)])
		throw error
	}
}

// --- One company ------------------------------------------------------------------

const toWorkerProfile = (company, p) => ({
	...p.details, company_name: company.name, product_description: p.product_description, regions: scopeRegions(p.regions),
	sectors: p.sectors, tender_keywords: p.tender_keywords, cpv_prefixes: p.cpv_prefixes,
})

const previousRowsFor = async (pool, companyId, week) => {
	const {rows} = await pool.query(`SELECT rr.name, rr.status, rr.closed_since, rr.closing_date, rr.website, rr.region, rr.row_data
		FROM report_row rr JOIN report r ON r.id = rr.report_id AND r.company_id = rr.company_id
		WHERE r.company_id = $1 AND r.week_start = (SELECT max(week_start) FROM report WHERE company_id = $1 AND week_start < $2)`, [companyId, week])
	const iso = (d) => d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))
	return rows.map((r) => ({...r.row_data, name: r.name, status: r.status, closed_since: iso(r.closed_since), closing_date: iso(r.closing_date), website: r.website, region: r.region}))
}

const skip = (pool, runId, reason) => pool.query(`UPDATE search_run SET status = 'skipped', skip_reason = $2, finished_at = now() WHERE id = $1`, [runId, reason])

// Claims the company's run for the week. A run that succeeded, or is running
// in another worker, is left alone; a failed or skipped one is tried again.
const claimRun = async (pool, companyId, week) => {
	await pool.query(`INSERT INTO search_run (company_id, week_start) VALUES ($1, $2) ON CONFLICT (company_id, week_start) DO NOTHING`, [companyId, week])
	const {rows} = await pool.query(`UPDATE search_run SET status = 'running', skip_reason = NULL, error_code = NULL, started_at = now(), finished_at = NULL
		WHERE company_id = $1 AND week_start = $2
			AND (status IN ('queued', 'failed', 'skipped') OR (status = 'running' AND started_at < now() - make_interval(hours => $3)))
		RETURNING id`, [companyId, week, STALE_RUN_HOURS])
	return rows[0]?.id ?? null
}

// Whatever happens after the claim, the run ends succeeded, skipped or
// failed: never stuck at 'running', which no later attempt would pick up.
export const runCompany = async (args) => {
	const runId = await claimRun(args.pool, args.company.id, args.week)
	if (!runId) return {status: 'already_done'}
	try {
		return await runClaimed({...args, runId})
	} catch (error) {
		await args.pool.query(`UPDATE search_run SET status = 'failed', finished_at = now(), error_code = $2 WHERE id = $1 AND status = 'running'`,
			[runId, String(error.code ?? 'run_failed').slice(0, 60)])
		throw error
	}
}

// The finished research, kept until the report is saved. A retry after a
// failed save reuses it instead of paying for the model work again. It
// carries who paid and with which model, so a retry needs no key at all.
const resultBlobName = (companyId, week) => `runs/${companyId}/${week}.json`

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']

// Keeps every conversation a run starts. Each one counts its tokens and cost
// as the provider bills them, so a run that fails part-way can still record
// the model work done before the failure. With a limit, a conversation is
// stopped before any request once the run's spend has reached it, so a run
// can pass its allowance by one request at most.
const trackUsage = (provider, {limitUsd = Infinity} = {}) => {
	const started = []
	const spent = () => {
		const usage = Object.fromEntries(TOKEN_KEYS.map((k) => [k, started.reduce((n, c) => n + (c.usage?.[k] ?? 0), 0)]))
		return {usage, cost: started.reduce((n, c) => n + (c.costUsd ?? provider.estimateCost(c.usage ?? {})), 0)}
	}
	return {
		spent,
		provider: {...provider, start: (args) => {
			const conversation = provider.start(args)
			started.push(conversation)
			// Reads go through to the conversation, so its usage stays live.
			const limited = Object.create(conversation)
			limited.send = async () => {
				if (spent().cost >= limitUsd) throw Object.assign(new Error('The run used up its AI spend allowance'), {code: 'programme_budget_reached'})
				return conversation.send()
			}
			return limited
		}},
	}
}

// Each attempt's spend is added to the run, so a failed attempt and its
// retry are both counted (review of DEC-011, finding 1).
const addAttemptCost = (pool, runId, {searches, fetches = 0, bravePricePer1000, usage, cost}) =>
	pool.query(`UPDATE search_run SET search_queries = search_queries + $2, search_cost_usd = search_cost_usd + $3,
			input_tokens = input_tokens + $4, output_tokens = output_tokens + $5, cache_write_tokens = cache_write_tokens + $6,
			cache_read_tokens = cache_read_tokens + $7, model_cost_usd = model_cost_usd + $8, page_reads = page_reads + $9 WHERE id = $1`,
		[runId, searches, (searches * bravePricePer1000 / 1000).toFixed(4), usage.input_tokens, usage.output_tokens,
			usage.cache_creation_input_tokens, usage.cache_read_input_tokens, cost.toFixed(4), fetches])

// A key is marked rejected only if it is still the key this run used: an
// admin may have replaced it while the run was going.
const markKey = async (pool, credential, keyStatus) => {
	const {rowCount} = credential.paidBy == 'programme'
		? await pool.query('UPDATE programme_llm_credential SET status = $1, checked_at = now() WHERE id = 1 AND added_at::text = $2', [keyStatus, credential.addedAt])
		: await pool.query('UPDATE company_llm_credential SET status = $1, checked_at = now() WHERE company_id = $2 AND added_at::text = $3', [keyStatus, credential.companyId, credential.addedAt])
	return rowCount > 0
}

const loadCredential = async (pool, companyId, programmePays) => {
	if (programmePays) {
		const {rows: [c]} = await pool.query('SELECT provider, model, secret_name, status, added_at::text AS added_at FROM programme_llm_credential WHERE id = 1')
		return c && {...c, addedAt: c.added_at, paidBy: 'programme'}
	}
	const {rows: [c]} = await pool.query('SELECT provider, model, secret_name, status, added_at::text AS added_at FROM company_llm_credential WHERE company_id = $1', [companyId])
	return c && {...c, addedAt: c.added_at, paidBy: 'company', companyId}
}

// attempt: filled with this attempt's searches and programme-paid model
// spend, so runWeek can settle the run's reservations.
const runClaimed = async ({pool, secrets, blobs, week, company, gather, searchEnabled, reserveSearches = async () => Infinity,
	payerFor = async () => 'company', reserveModelCost = async () => Infinity, attempt = {}, bravePricePer1000, runId,
	now = new Date(), providers = providerFor, log = () => {}}) => {
	if (company.status != 'active') return skip(pool, runId, 'company_paused').then(() => ({status: 'skipped', reason: 'company_paused'}))

	const {rows: [profileRow]} = await pool.query(`SELECT id, product_description, regions, sectors, tender_keywords, cpv_prefixes, details
		FROM company_profile WHERE company_id = $1 ORDER BY version DESC LIMIT 1`, [company.id])
	if (!profileRow) return skip(pool, runId, 'no_profile').then(() => ({status: 'skipped', reason: 'no_profile'}))
	const setRun = (provider, model, paidBy) => pool.query('UPDATE search_run SET profile_id = $2, provider = $3, model = $4, paid_by = $5 WHERE id = $1',
		[runId, profileRow.id, provider, model, paidBy])

	// A failed save left the finished research behind: reuse it, so nobody
	// pays twice for the same week. Its cost was recorded when it finished.
	const cached = await blobs.getIfExists(resultBlobName(company.id, week))
	let result
	if (cached) {
		const kept = JSON.parse(String(cached))
		;({result} = kept)
		await setRun(kept.provider, kept.model, kept.paidBy)
	} else {
		// DEC-011 and DEC-014: the programme's key in the free period and for a
		// subscriber, the company's own key otherwise. Read for each run, so
		// ending the period or a plan takes effect from the next run.
		const payer = await payerFor(company.id)
		if (payer == 'none') return skip(pool, runId, 'no_plan').then(() => ({status: 'skipped', reason: 'no_plan'}))
		const free = payer == 'programme'
		const credential = await loadCredential(pool, company.id, free)
		if (free && credential?.status != 'valid') return skip(pool, runId, 'programme_key_problem').then(() => ({status: 'skipped', reason: 'programme_key_problem'}))
		if (!credential) return skip(pool, runId, 'no_key').then(() => ({status: 'skipped', reason: 'no_key'}))
		if (credential.status != 'valid') return skip(pool, runId, credential.status == 'invalid' ? 'invalid_key' : 'out_of_credit').then(() => ({status: 'skipped', reason: credential.status}))
		await setRun(credential.provider, credential.model, credential.paidBy)

		let limitUsd = Infinity
		if (credential.paidBy == 'programme') {
			// Reserved against the monthly cap before the research starts; the run
			// is stopped if it reaches what it was granted.
			const {rows: [m]} = await pool.query('SELECT benchmark_cost_usd FROM approved_model WHERE provider = $1 AND model = $2', [credential.provider, credential.model])
			limitUsd = await reserveModelCost(Number(m?.benchmark_cost_usd ?? 5))
			if (!(limitUsd > 0)) {
				await skip(pool, runId, 'programme_budget_reached')
				return {status: 'skipped', reason: 'programme_budget_reached'}
			}
		}
		const adapter = providers(credential.provider)
		const profile = toWorkerProfile(company, profileRow)
		// BEH-013: searches are reserved against the monthly cap before the
		// research starts, and counted as they happen across its regions.
		const searchBudget = {limit: searchEnabled ? await reserveSearches(profile.regions.length * LIMITS.searches) : 0, used: 0}
		let tracked = null
		const record = async ({fetches = 0} = {}) => {
			const spent = tracked?.spent() ?? {usage: Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0])), cost: 0}
			attempt.searches = searchBudget.used
			attempt.programmeUsd = credential.paidBy == 'programme' ? spent.cost : 0
			await addAttemptCost(pool, runId, {searches: searchBudget.used, fetches, bravePricePer1000, ...spent})
		}
		try {
			const apiKey = await secrets.get(credential.secret_name)
			tracked = trackUsage(adapter.createProvider({apiKey, model: credential.model}), {limitUsd})
			const today = now.toISOString().slice(0, 10)
			result = await buildCompanyReport({profile, today, now, gather, previousRows: await previousRowsFor(pool, company.id, week),
				provider: tracked.provider, searchEnabled, searchBudget, log: (m) => log(`${company.name}: ${m}`)})
		} catch (error) {
			// Searches and model work done before the failure were still billed:
			// to the programme, and to whoever's key the run used.
			await record()
			// A rejected or empty key stops runs on that key until it is fixed;
			// anything else, or a key replaced meanwhile, is a failed run that the
			// next attempt retries. Only a code is kept: a provider's message can
			// quote the request.
			const keyStatus = adapter.keyStatusFromError?.(error)
			if (keyStatus && await markKey(pool, credential, keyStatus)) {
				if (credential.paidBy == 'programme') {
					await skip(pool, runId, 'programme_key_problem')
					logLine({event: 'programme_key_rejected', status: keyStatus})
					return {status: 'skipped', reason: 'programme_key_problem'}
				}
				await skip(pool, runId, keyStatus == 'invalid' ? 'invalid_key' : 'out_of_credit')
				return {status: 'skipped', reason: keyStatus}
			}
			await pool.query(`UPDATE search_run SET status = 'failed', finished_at = now(), error_code = $2 WHERE id = $1`,
				[runId, String(error.code ?? error.status ?? 'research_failed').slice(0, 60)])
			logLine({event: 'run_failed', company_id: company.id, week, code: error.code ?? error.status, name: error.name})
			return {status: 'failed'}
		}
		// Recorded before anything else can fail, so the model cost and the
		// programme's search cost are counted even if the save does not finish.
		await record({fetches: result.fetches})
		// Kept best-effort: if storage is down the save below fails too, and the
		// retry pays again, but a working save never depends on this copy.
		await blobs.put(resultBlobName(company.id, week), Buffer.from(JSON.stringify({paidBy: credential.paidBy, provider: credential.provider, model: credential.model, result})), 'application/json')
			.catch((error) => logLine({event: 'run_result_not_kept', company_id: company.id, week, code: error.code, name: error.name}))
	}

	const today = now.toISOString().slice(0, 10)
	const rows = [...result.funding.map((f) => cleanRow('funding', f, today)), ...result.tenders.map((t) => cleanRow('tender', t, today))]
	const funding = rows.filter((r) => r.kind == 'funding').map((r) => r.row)
	const tenders = rows.filter((r) => r.kind == 'tender').map((r) => r.row)
	const {topFive, notIncluded, sources, note} = result
	const workbook = buildWorkbook({preparedOn: now.toISOString().slice(0, 10), funding, tenders, topFive, sources, note, notIncluded})
	const blobName = `reports/${company.id}/${week}.xlsx`
	await blobs.put(blobName, Buffer.from(await workbook.xlsx.writeBuffer()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

	const client = await pool.connect()
	try {
		await client.query('BEGIN')
		const {rows: [report]} = await client.query(`INSERT INTO report (company_id, search_run_id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			ON CONFLICT (company_id, week_start) DO UPDATE SET search_run_id = EXCLUDED.search_run_id, blob_name = EXCLUDED.blob_name,
				funding_rows = EXCLUDED.funding_rows, tender_rows = EXCLUDED.tender_rows, new_this_week = EXCLUDED.new_this_week,
				top_five = EXCLUDED.top_five, also_checked = EXCLUDED.also_checked, sources = EXCLUDED.sources, note = EXCLUDED.note, created_at = now()
			RETURNING id`,
			[company.id, runId, week, blobName, funding.length, tenders.length, rows.filter((r) => r.new_this_week).length,
				JSON.stringify(topFive), JSON.stringify(notIncluded), JSON.stringify(sources), note])
		await client.query('DELETE FROM report_row WHERE company_id = $1 AND report_id = $2', [company.id, report.id])
		for (const r of rows) {
			await client.query(`INSERT INTO report_row (company_id, report_id, kind, region, name, website, status, closing_date, closed_since, new_this_week, row_data)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
				[company.id, report.id, r.kind, r.region, r.name, r.website, r.status, r.closing_date, r.closed_since, r.new_this_week, r.row])
		}
		await client.query(`UPDATE search_run SET status = 'succeeded', finished_at = now() WHERE id = $1`, [runId])
		await client.query('COMMIT')
		await blobs.remove(resultBlobName(company.id, week)).catch(() => {})
		return {status: 'succeeded', reportId: report.id, rows: rows.length, reusedResearch: Boolean(cached)}
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {})
		throw Object.assign(error, {code: error.code ?? 'store_failed'})
	} finally {
		client.release()
	}
}

// --- The whole week -----------------------------------------------------------------

// Two weekly jobs never run at once (a manual start while the scheduled one
// is still going): the caps below are only exact if one job spends at a time.
export const WEEKLY_JOB_LOCK = 7_010_403

// An allowance taken from before each run and settled with what the run
// actually used once it ends. Kept in memory: the job lock means no one else
// spends against the same cap meanwhile.
const allowance = (left) => ({
	take: (wanted, {atLeast = 0} = {}) => {
		if (left < atLeast) return 0
		const granted = Math.max(0, Math.min(wanted, left))
		left -= granted
		return granted
	},
	settle: (granted, used) => { left += granted - used },
})

export const runWeek = async ({pool, secrets, blobs, fetchers, now = new Date(), week = targetWeek(now), providers, log = () => {}}) => {
	const lock = await pool.connect()
	try {
		const {rows: [held]} = await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [WEEKLY_JOB_LOCK])
		if (!held.ok) {
			logLine({event: 'weekly_job_already_running', week})
			return {week, outcomes: {}, skipped: 'another_weekly_job_running'}
		}
		try {
			return await runWeekLocked({pool, secrets, blobs, fetchers, now, week, providers, log})
		} finally {
			await lock.query('SELECT pg_advisory_unlock($1)', [WEEKLY_JOB_LOCK])
		}
	} finally {
		lock.release()
	}
}

const runWeekLocked = async ({pool, secrets, blobs, fetchers, now, week, providers, log}) => {
	const gather = await gatherWeek({pool, blobs, week, fetchers, now, log})
	const {rows: companies} = await pool.query('SELECT id, name, status FROM company ORDER BY name')
	return {week, outcomes: await runCompanies({pool, secrets, blobs, week, gather, companies, now, providers, log})}
}

// Runs the given companies for the week within this month's search and AI caps.
const runCompanies = async ({pool, secrets, blobs, week, gather, companies, now, providers, log}) => {
	const {rows: [settings]} = await pool.query(`SELECT search_enabled, brave_price_per_1000_usd, monthly_query_cap, programme_model_monthly_cap_usd
		FROM service_setting WHERE id = 1`)
	const {rows: [month]} = await pool.query(`SELECT coalesce(sum(search_queries), 0)::int AS queries,
			coalesce(sum(model_cost_usd) FILTER (WHERE paid_by = 'programme'), 0) AS programme_usd
		FROM search_run WHERE started_at >= date_trunc('month', now())`)
	// BEH-013 and DEC-011: what is left of this month's search and AI caps.
	const searches = allowance(settings.monthly_query_cap - month.queries)
	const programmeUsd = allowance(Number(settings.programme_model_monthly_cap_usd) - Number(month.programme_usd))
	// Who pays for a company's run this week: 'programme', 'company' or 'none'.
	// In the free period, the programme (DEC-011). After it, the company's plan
	// (DEC-014): a subscription runs on the programme's key, the own-key plan
	// on the company's, and without a live plan there is no run. Where no free
	// period was ever set, every company uses its own key, as before DEC-011.
	// DEC-015: a Connected Health Cluster company has no free period: the
	// programme pays for its first report only, then its plan decides.
	const payerFor = async (companyId) => {
		const {rows: [s]} = await pool.query(`SELECT s.free_period_until, c.cohort, b.plan, b.status,
				EXISTS (SELECT 1 FROM report r WHERE r.company_id = c.id) AS has_report
			FROM service_setting s JOIN company c ON c.id = $1
			LEFT JOIN company_billing b ON b.company_id = c.id WHERE s.id = 1`, [companyId])
		if (s.cohort == CLUSTER) {
			if (!s.has_report) return 'programme'
		} else {
			if (s.free_period_until == null) return 'company'
			if (week <= s.free_period_until) return 'programme'
		}
		if (!LIVE_PLAN_STATUSES.includes(s.status)) return 'none'
		return s.plan == 'subscription' ? 'programme' : 'company'
	}
	const outcomes = {}
	await eachLimited(companies, COMPANY_CONCURRENCY, async (company) => {
		const attempt = {searches: 0, programmeUsd: 0}
		let grantedSearches = 0
		let grantedUsd = 0
		const reserveSearches = async (wanted) => (grantedSearches = searches.take(wanted))
		// Twice the model's benchmark cost, so a typical run is never stopped
		// part-way; a run starts only if at least the benchmark cost is left.
		const reserveModelCost = async (estimateUsd) => (grantedUsd = programmeUsd.take(2 * estimateUsd, {atLeast: estimateUsd}))
		try {
			outcomes[company.id] = await runCompany({pool, secrets, blobs, week, company, gather, searchEnabled: settings.search_enabled,
				reserveSearches, payerFor, reserveModelCost, attempt, bravePricePer1000: Number(settings.brave_price_per_1000_usd), now, providers, log})
		} catch (error) {
			outcomes[company.id] = {status: 'failed'}
			logLine({event: 'company_run_error', company_id: company.id, message: error.message?.slice(0, 200)})
		} finally {
			searches.settle(grantedSearches, attempt.searches)
			programmeUsd.settle(grantedUsd, attempt.programmeUsd)
		}
	})
	return outcomes
}

// --- First report ---------------------------------------------------------------

// A gather made before the EU calls were gathered (DAT-005) has none; read
// them now and save them into the week's gather, so later first reports that
// week reuse them. If the portal cannot be read, the run goes ahead without.
const withEuCalls = async ({pool, blobs, week, gather, fetchers, log}) => {
	if (!gather.funderPages || 'euCalls' in gather.funderPages || !fetchers.euCalls) return gather
	try {
		const euCalls = await fetchers.euCalls({log})
		const updated = {...gather, funderPages: {...gather.funderPages, euCalls}}
		const {rows: [row]} = await pool.query('SELECT blob_name FROM weekly_gather WHERE week_start = $1', [week])
		await blobs.put(row.blob_name, Buffer.from(JSON.stringify(updated)), 'application/json')
		return updated
	} catch (error) {
		log(`EU calls not read: ${error.message}`)
		return gather
	}
}

// A company that has just saved its first profile should not wait for
// Sunday (BEH-015). A job every 15 minutes runs, for this week, each active
// company with a profile that has no report and no run that got under way
// (a skipped run, e.g. no key yet, is tried again), then emails it. It uses
// the week's shared gather, so normally only the company's own run costs
// anything. On Sundays it leaves new companies to that night's run, and it
// shares the weekly job's lock, so the two never run at once.
export const runFirstReports = async ({pool, secrets, blobs, fetchers, mailer, appUrl, emailFor, now = new Date(), providers, log = () => {}}) => {
	const week = weekStart(now)
	if (targetWeek(now) != week) return {week, outcomes: {}, skipped: 'sunday'}
	const lock = await pool.connect()
	try {
		const {rows: [held]} = await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [WEEKLY_JOB_LOCK])
		if (!held.ok) return {week, outcomes: {}, skipped: 'another_weekly_job_running'}
		try {
			const {rows: companies} = await pool.query(`SELECT c.id, c.name, c.status FROM company c
				WHERE c.status = 'active'
					AND EXISTS (SELECT 1 FROM company_profile p WHERE p.company_id = c.id)
					AND NOT EXISTS (SELECT 1 FROM report r WHERE r.company_id = c.id)
					AND NOT EXISTS (SELECT 1 FROM search_run s WHERE s.company_id = c.id AND s.status IN ('running', 'succeeded', 'failed'))
				ORDER BY c.created_at`)
			if (!companies.length) return {week, outcomes: {}}
			log(`first reports for ${companies.length} companies, week ${week}`)
			const gather = await withEuCalls({pool, blobs, week, gather: await gatherWeek({pool, blobs, week, fetchers, now, log}), fetchers, log})
			const outcomes = await runCompanies({pool, secrets, blobs, week, gather, companies, now, providers, log})
			const done = Object.keys(outcomes).filter((id) => outcomes[id].status == 'succeeded')
			if (done.length) await sendWeeklyEmails({pool, mailer, appUrl, week, emailFor, companyIds: done, log})
			return {week, outcomes}
		} finally {
			await lock.query('SELECT pg_advisory_unlock($1)', [WEEKLY_JOB_LOCK])
		}
	} finally {
		lock.release()
	}
}

// --- Monday email (BEH-007) ----------------------------------------------------------

// One notification per report per member, inserted first so a retried job
// never emails anyone twice; then every pending one is sent.
// DEC-011: from four weeks before the free period ends, the email says so,
// unless the company already has a plan for after it (DEC-014). DEC-015: a
// Connected Health Cluster company without a plan is told its report was
// free and a plan keeps them coming.
export {FREE_PERIOD_NOTICE_DAYS}

// companyIds: only these companies' reports (a first report); otherwise all.
export const sendWeeklyEmails = async ({pool, mailer, appUrl, week, emailFor, companyIds = null, log = () => {}}) => {
	const {rows: [settings]} = await pool.query('SELECT free_period_until FROM service_setting WHERE id = 1')
	const until = settings.free_period_until
	const freePeriodEnds = until && week <= until && Date.parse(until) - Date.parse(week) <= FREE_PERIOD_NOTICE_DAYS * 864e5 ? until : null
	await pool.query(`INSERT INTO notification (company_id, report_id, user_id)
		SELECT r.company_id, r.id, m.user_id FROM report r JOIN company_membership m ON m.company_id = r.company_id
		JOIN app_user u ON u.id = m.user_id AND u.disabled_at IS NULL
		WHERE r.week_start = $1 AND ($2::uuid[] IS NULL OR r.company_id = ANY($2)) ON CONFLICT (report_id, user_id) DO NOTHING`, [week, companyIds])
	const {rows} = await pool.query(`SELECT n.id, n.attempts, u.email, c.name AS company_name, c.id AS company_id, r.id AS report_id,
			r.funding_rows, r.tender_rows, r.new_this_week, r.top_five, c.cohort, ${hasPlanSql('b')} AS has_plan
		FROM notification n JOIN report r ON r.id = n.report_id JOIN company c ON c.id = n.company_id JOIN app_user u ON u.id = n.user_id
		LEFT JOIN company_billing b ON b.company_id = c.id
		WHERE r.week_start = $1 AND ($2::uuid[] IS NULL OR r.company_id = ANY($2)) AND n.status IN ('pending', 'failed') AND n.attempts < 3`, [week, companyIds])
	let sent = 0
	for (const n of rows) {
		// Claimed by bumping attempts from the value just read, so two
		// overlapping jobs cannot both send the same email.
		const {rowCount} = await pool.query(`UPDATE notification SET attempts = attempts + 1
			WHERE id = $1 AND attempts = $2 AND status <> 'sent'`, [n.id, n.attempts])
		if (!rowCount) continue
		try {
			await mailer.send({to: n.email, ...emailFor({companyName: n.company_name, link: `${appUrl}/companies/${n.company_id}/reports/${n.report_id}`,
				fundingRows: n.funding_rows, tenderRows: n.tender_rows, newThisWeek: n.new_this_week, topFive: n.top_five,
				freePeriodEnds: n.has_plan || n.cohort == CLUSTER ? null : freePeriodEnds, planNeeded: !n.has_plan && n.cohort == CLUSTER, settingsLink: `${appUrl}/companies/${n.company_id}/settings`})})
			await pool.query(`UPDATE notification SET status = 'sent', sent_at = now() WHERE id = $1`, [n.id])
			sent += 1
		} catch (error) {
			await pool.query(`UPDATE notification SET status = 'failed' WHERE id = $1`, [n.id])
			logLine({event: 'weekly_mail_failed', code: error.code})
		}
	}
	log(`weekly emails sent: ${sent} of ${rows.length}`)
	return {sent, attempted: rows.length}
}

// --- Retention (DAT-002: 13 weeks) ---------------------------------------------------

export const RETENTION_WEEKS = 13

export const cleanup = async ({pool, blobs, now = new Date(), weeks = RETENTION_WEEKS, log = () => {}}) => {
	const cutoff = weekStart(new Date(now.getTime() - weeks * 7 * 864e5))
	const {rows: reports} = await pool.query('SELECT id, blob_name FROM report WHERE week_start < $1', [cutoff])
	for (const r of reports) await blobs.remove(r.blob_name)
	const {rows: gathers} = await pool.query('SELECT blob_name FROM weekly_gather WHERE week_start < $1 AND blob_name IS NOT NULL', [cutoff])
	for (const g of gathers) await blobs.remove(g.blob_name)
	// Kept research results whose save never succeeded.
	const {rows: unsaved} = await pool.query("SELECT company_id, week_start FROM search_run WHERE week_start < $1 AND status <> 'succeeded'", [cutoff])
	for (const u of unsaved) await blobs.remove(resultBlobName(u.company_id, u.week_start))
	// Runs and their costs are kept: they are the programme's cost history.
	await pool.query('DELETE FROM report WHERE week_start < $1', [cutoff])
	await pool.query("UPDATE weekly_gather SET blob_name = NULL WHERE week_start < $1", [cutoff])
	await pool.query("DELETE FROM sign_in_token WHERE expires_at < now() - interval '1 day'")
	await pool.query("DELETE FROM user_session WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'")
	log(`cleanup: ${reports.length} reports before ${cutoff} removed`)
	return {reportsRemoved: reports.length, cutoff}
}

