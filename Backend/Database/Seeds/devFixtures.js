// Synthetic data for local development only: a programme admin, a trial
// company with last trial run's report (run8), and a second company still
// being set up. Refuses anything but a local database whose name ends in
// _dev, and refuses production. Re-running replaces the fixtures.
//
//   OPPORTUNITY_FINDER_DATABASE_URL=postgresql:///opportunity_finder_dev node Database/Seeds/devFixtures.js
import {copyFileSync, mkdirSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {createPool} from '../Connection.js'
import {seedApprovedModels} from './approvedModels.js'
import {decodeUnicodeEscapes} from '../../Worker/Research/loop.js'
import {scopeRegions} from '../../Worker/Research/search.js'

const url = process.env.OPPORTUNITY_FINDER_DATABASE_URL ?? ''
const parsed = new URL(url.replace(/^postgresql:\/\/\//, 'postgresql://localhost/'))
if (process.env.NODE_ENV == 'production' || !['localhost', '127.0.0.1', ''].includes(parsed.hostname) || !parsed.pathname.endsWith('_dev')) {
	console.error('[dev-fixtures] refusing: only a local database named *_dev')
	process.exit(1)
}

const root = new URL('../../', import.meta.url).pathname
const RUN = join(root, 'Output/run8/Care_routing_trial_company_2026-10-23')
const report = decodeUnicodeEscapes(JSON.parse(readFileSync(`${RUN}.json`, 'utf8')))
const summary = JSON.parse(readFileSync(`${RUN}.summary.json`, 'utf8'))
const profile = JSON.parse(readFileSync(join(root, 'Worker/Profiles/trial-care-routing.json'), 'utf8'))
const WEEK = '2026-10-26'

const pool = createPool()
const q = (sql, params) => pool.query(sql, params)
try {
	await seedApprovedModels(pool)
	await q("DELETE FROM company WHERE name IN ('Care Routing Trial Ltd', 'Second Trial Co')")
	await q("DELETE FROM search_run WHERE week_start = $1", [WEEK])
	await q("DELETE FROM weekly_gather WHERE week_start = $1", [WEEK])
	await q("DELETE FROM app_user WHERE email LIKE '%@example.test'")
	await q('DELETE FROM azure_cost_daily')

	const user = async (email) => (await q('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [email])).rows[0].id
	const admin = await user('admin@example.test')
	await q('INSERT INTO programme_admin (user_id) VALUES ($1)', [admin])
	const founder = await user('founder@example.test')
	const colleague = await user('colleague@example.test')

	const {rows: [a]} = await q("INSERT INTO company (name, created_by) VALUES ('Care Routing Trial Ltd', $1) RETURNING id", [admin])
	const {rows: [b]} = await q("INSERT INTO company (name, created_by) VALUES ('Second Trial Co', $1) RETURNING id", [admin])
	await q("INSERT INTO company_membership (company_id, user_id, role) VALUES ($1, $2, 'company_admin'), ($1, $3, 'company_member'), ($4, $2, 'company_member')", [a.id, founder, colleague, b.id])

	const {product_description, regions, sectors, tender_keywords, cpv_prefixes, company_name, _note, ...details} = profile
	const {rows: [p]} = await q(`INSERT INTO company_profile (company_id, version, product_description, regions, sectors, tender_keywords, cpv_prefixes, details, created_by)
		VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [a.id, product_description, scopeRegions(regions ?? []), sectors ?? [], tender_keywords ?? [], (cpv_prefixes ?? []).map(String), details, founder])
	// Display only: the dev API's in-memory secret store holds no key, so a
	// real weekly run would need a key added through the settings page.
	await q(`INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four, added_by) VALUES ($1, 'anthropic', 'claude-sonnet-5-5', $2, 'TEST', $3)`, [a.id, `company-llm-${a.id}`, founder])

	await q("INSERT INTO weekly_gather (week_start, status, finished_at, tender_notices, funder_pages, competitions) VALUES ($1, 'succeeded', now(), 1840, 92, 29)", [WEEK])
	const {rows: [run]} = await q(`INSERT INTO search_run (company_id, week_start, profile_id, status, provider, model, started_at, finished_at, input_tokens, output_tokens, model_cost_usd, search_queries, search_cost_usd, page_reads)
		VALUES ($1, $2, $3, 'succeeded', 'anthropic', 'claude-sonnet-5-5', now() - interval '15 minutes', now(), 900000, 60000, $4, $5, $6, 70) RETURNING id`,
		[a.id, WEEK, p.id, summary.model_cost_usd, summary.search_queries, summary.search_cost_usd])
	await q("INSERT INTO search_run (company_id, week_start, status, skip_reason, finished_at) VALUES ($1, $2, 'skipped', 'no_key', now())", [b.id, WEEK])

	const blobName = `reports/${a.id}/${WEEK}.xlsx`
	const blobPath = join(root, 'Output/dev-blobs', blobName)
	mkdirSync(dirname(blobPath), {recursive: true})
	copyFileSync(`${RUN}.xlsx`, blobPath)
	const rows = [...report.funding.map((f) => ({kind: 'funding', name: f.fund, row: f})), ...report.tenders.map((t) => ({kind: 'tender', name: t.title, row: t}))]
	const {rows: [r]} = await q(`INSERT INTO report (company_id, search_run_id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
		[a.id, run.id, WEEK, blobName, report.funding.length, report.tenders.length, rows.filter((x) => x.row.new_this_week).length,
			JSON.stringify(report.topFive), JSON.stringify(report.notIncluded ?? []), JSON.stringify(report.sources), report.note])
	const date = (v) => typeof v == 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
	for (const {kind, name, row} of rows) {
		await q(`INSERT INTO report_row (company_id, report_id, kind, region, name, website, status, closing_date, closed_since, new_this_week, row_data)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[a.id, r.id, kind, row.region, name, row.website, row.status, date(row.closing_date), row.status == 'Closed' ? (row.closed_since ?? '2026-10-23') : null, Boolean(row.new_this_week), row])
	}
	// Synthetic hosting cost so the admin card has something to draw.
	await q(`INSERT INTO azure_cost_daily (day, amount, currency) SELECT d::date, 1.2 + (extract(dow FROM d) / 10), 'USD'
		FROM generate_series(current_date - 40, current_date - 1, interval '1 day') d`)
	console.log(`[dev-fixtures] done: ${rows.length} report rows; sign in as admin@example.test or founder@example.test`)
} finally {
	await pool.end()
}
