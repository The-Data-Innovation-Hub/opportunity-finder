// DEC-016 side-by-side trial. For a week whose reports are already done, it
// builds the shared scheme list from that week's gather, then rebuilds each
// company's report from the list (stages 2 and 3), and compares the two
// company by company. It runs on the programme's key and writes only to
// trials/<week>/ in blob storage: companies' reports, runs, costs and emails
// are untouched, and nothing is saved to the database.
//
// Each step is kept as it finishes, so a retried trial reuses the list and
// the companies already done instead of paying for them again. The whole
// trial stops once its spend reaches spendLimitUsd (Brendan approved about
// US$30, 3 Nov 2026).
import ExcelJS from 'exceljs'
import {buildCompanyReport, rowKey} from './CompanyReport.js'
import {buildSharedCatalogue} from './Research/catalogue.js'
import {matchRegion} from './Research/match.js'
import {providerFor} from './Providers/index.js'
import {trackUsage, toWorkerProfile, previousRowsFor} from './Weekly.js'

export const TRIAL_SPEND_LIMIT_USD = 40
const iso = (d) => d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))

// Every company's funding rows from its latest report before the week: the
// schemes the shared list must re-check.
export const previousRowsForAll = async (pool, week) => {
	const {rows} = await pool.query(`SELECT rr.name, rr.status, rr.closing_date, rr.website, rr.region, rr.row_data
		FROM report_row rr JOIN report r ON r.id = rr.report_id AND r.company_id = rr.company_id
		WHERE rr.kind = 'funding' AND r.week_start = (SELECT max(week_start) FROM report p WHERE p.company_id = r.company_id AND p.week_start < $1)`, [week])
	return rows.map((r) => ({name: r.name, status: r.status, closing_date: iso(r.closing_date), website: r.website, region: r.region,
		amount: r.row_data?.amount ?? null, match_funding: r.row_data?.match_funding ?? null, source_group: r.row_data?.source_group ?? null}))
}

// --- Comparison -------------------------------------------------------------------

const topKey = (name) => rowKey(String(name ?? '').replace(/\(.*?\)/g, ' '))
const FIELDS = {funding: ['status', 'closing_date', 'amount'], tender: ['status', 'closing_date', 'value']}

// current: {rows: [{kind, name, website, status, closing_date, row}], topFive};
// proposed: {funding, tenders, topFive}, as buildCompanyReport returns them.
export const compareReports = ({current, proposed}) => {
	const proposedRows = [
		...proposed.funding.map((f) => ({kind: 'funding', name: f.fund, website: f.website, row: f})),
		...proposed.tenders.map((t) => ({kind: 'tender', name: t.title, website: t.website, row: t})),
	]
	const same = (a, b) => a.kind == b.kind && ((a.website && rowKey(a.website) == rowKey(b.website)) || rowKey(a.name) == rowKey(b.name))
	const used = new Set()
	const rows = current.rows.map((c) => {
		const match = proposedRows.find((p) => !used.has(p) && same(c, p))
		if (match) used.add(match)
		const differences = match ? FIELDS[c.kind].filter((f) => String(c.row?.[f] ?? '') != String(match.row[f] ?? '')) : []
		return {kind: c.kind, name: c.name, in_current: true, in_proposed: Boolean(match), current: c.row, proposed: match?.row ?? null, differences}
	})
	for (const extra of proposedRows.filter((p) => !used.has(p))) rows.push({kind: extra.kind, name: extra.name, in_current: false, in_proposed: true, current: null, proposed: extra.row, differences: []})
	const currentTop = new Set((current.topFive ?? []).map((t) => topKey(t.name)))
	return {
		rows,
		counts: {
			current: current.rows.length, proposed: proposedRows.length,
			both: rows.filter((r) => r.in_current && r.in_proposed).length,
			only_current: rows.filter((r) => !r.in_proposed).length,
			only_proposed: rows.filter((r) => !r.in_current).length,
			figures_differ: rows.filter((r) => r.differences.length).length,
			top_five_overlap: (proposed.topFive ?? []).filter((t) => currentTop.has(topKey(t.name))).length,
		},
	}
}

const FIELD_LABEL = {status: 'Status', closing_date: 'Closes', amount: 'Amount', value: 'Value'}
export const comparisonWorkbook = ({week, catalogue, companies}) => {
	const book = new ExcelJS.Workbook()
	const summary = book.addWorksheet('Summary')
	summary.columns = [
		{header: 'Company', key: 'company', width: 30}, {header: 'Outcome', key: 'outcome', width: 12},
		{header: 'Rows today', key: 'current', width: 11}, {header: 'Rows shared', key: 'proposed', width: 12},
		{header: 'In both', key: 'both', width: 9}, {header: 'Only today', key: 'only_current', width: 11}, {header: 'Only shared', key: 'only_proposed', width: 12},
		{header: 'Figures differ', key: 'figures_differ', width: 13}, {header: 'Top 5 overlap', key: 'top_five_overlap', width: 13},
		{header: 'AI cost today (US$)', key: 'current_cost', width: 18}, {header: 'AI cost shared (US$)', key: 'proposed_cost', width: 19},
		{header: 'Minutes today', key: 'current_minutes', width: 14}, {header: 'Minutes shared', key: 'proposed_minutes', width: 15},
	]
	for (const c of companies) summary.addRow({company: c.company, outcome: c.outcome, ...c.counts,
		current_cost: c.current_cost_usd, proposed_cost: c.proposed_cost_usd, current_minutes: c.current_minutes, proposed_minutes: c.proposed_minutes})
	summary.addRow({})
	summary.addRow({company: `Shared list for week ${week}: ${catalogue.schemes.length} schemes, US$${catalogue.cost.toFixed(2)}, ${catalogue.searches} searches, ${catalogue.fetches} page reads. "AI cost shared" includes an equal share of it.`})
	summary.getRow(1).font = {bold: true}

	const detail = book.addWorksheet('Rows')
	detail.columns = [
		{header: 'Company', key: 'company', width: 26}, {header: 'Kind', key: 'kind', width: 9}, {header: 'Name', key: 'name', width: 50},
		{header: 'Today', key: 'in_current', width: 7}, {header: 'Shared', key: 'in_proposed', width: 8}, {header: 'Differs', key: 'differs', width: 22},
		{header: 'Today: status / closes / amount', key: 'current', width: 40}, {header: 'Shared: status / closes / amount', key: 'proposed', width: 40},
	]
	const figures = (kind, row) => row ? FIELDS[kind].map((f) => row[f] ?? '–').join(' / ') : ''
	for (const c of companies) for (const r of c.rows ?? []) detail.addRow({company: c.company, kind: r.kind, name: r.name,
		in_current: r.in_current ? 'yes' : '', in_proposed: r.in_proposed ? 'yes' : '', differs: r.differences.map((f) => FIELD_LABEL[f]).join(', '),
		current: figures(r.kind, r.current), proposed: figures(r.kind, r.proposed)})
	detail.getRow(1).font = {bold: true}

	const list = book.addWorksheet('Shared list')
	list.columns = [{header: 'Region', key: 'region', width: 8}, {header: 'Schemes', key: 'schemes', width: 9}, {header: 'Dropped by checks', key: 'dropped', width: 17},
		{header: 'Not included', key: 'not_included', width: 13}, {header: 'Searches', key: 'searches', width: 9}, {header: 'Page reads', key: 'fetches', width: 11},
		{header: 'AI cost (US$)', key: 'model_cost_usd', width: 13}, {header: 'Notes', key: 'notes', width: 80}]
	for (const p of catalogue.passes) list.addRow({...p, dropped: p.dropped.length})
	list.getRow(1).font = {bold: true}
	return book
}

// --- The trial --------------------------------------------------------------------

const blobJson = async (blobs, name) => {
	const found = await blobs.getIfExists(name)
	return found ? JSON.parse(String(found)) : null
}
const putJson = (blobs, name, value) => blobs.put(name, Buffer.from(JSON.stringify(value)), 'application/json')

export const runSharedTrial = async ({pool, secrets, blobs, week, stage3 = true, spendLimitUsd = TRIAL_SPEND_LIMIT_USD, now = new Date(), providers = providerFor, log = () => {}}) => {
	const {rows: [gatherRow]} = await pool.query(`SELECT blob_name FROM weekly_gather WHERE week_start = $1 AND status = 'succeeded'`, [week])
	if (!gatherRow?.blob_name) throw new Error(`No finished gather for week ${week}`)
	const gather = JSON.parse(String(await blobs.get(gatherRow.blob_name)))

	const {rows: companies} = await pool.query(`SELECT c.id, c.name, r.id AS report_id, r.top_five, s.profile_id, s.model_cost_usd,
			extract(epoch FROM s.finished_at - s.started_at) AS seconds
		FROM report r JOIN search_run s ON s.id = r.search_run_id JOIN company c ON c.id = r.company_id
		WHERE r.week_start = $1 AND c.status <> 'archived' ORDER BY c.name`, [week])
	if (!companies.length) throw new Error(`No reports for week ${week} to compare with`)

	const {rows: [credential]} = await pool.query('SELECT provider, model, secret_name, status FROM programme_llm_credential WHERE id = 1')
	if (credential?.status != 'valid') throw new Error('The programme key is missing or not valid')
	const {rows: [settings]} = await pool.query('SELECT search_enabled, monthly_query_cap FROM service_setting WHERE id = 1')
	const {rows: [month]} = await pool.query(`SELECT coalesce(sum(search_queries), 0)::int AS queries FROM search_run WHERE started_at >= date_trunc('month', now())`)
	const budget = {limit: Math.max(0, settings.monthly_query_cap - month.queries), used: 0}

	const adapter = providers(credential.provider)
	const tracked = trackUsage(adapter.createProvider({apiKey: await secrets.get(credential.secret_name), model: credential.model}), {limitUsd: spendLimitUsd})
	const today = now.toISOString().slice(0, 10)
	const prefix = `trials/${week}`

	let catalogue = await blobJson(blobs, `${prefix}/catalogue.json`)
	if (catalogue) log(`shared list for ${week} reused (${catalogue.schemes.length} schemes)`)
	else {
		catalogue = await buildSharedCatalogue({today, funderPages: gather.funderPages, previousRows: await previousRowsForAll(pool, week),
			provider: tracked.provider, searchEnabled: settings.search_enabled, budget, log})
		await putJson(blobs, `${prefix}/catalogue.json`, catalogue)
		log(`shared list: ${catalogue.schemes.length} schemes, US$${catalogue.cost.toFixed(2)}`)
	}
	const catalogueShare = catalogue.cost / companies.length

	const results = []
	for (const company of companies) {
		const name = `${prefix}/companies/${company.id}.json`
		let kept = await blobJson(blobs, name)
		if (!kept) {
			const started = Date.now()
			try {
				const {rows: [profileRow]} = await pool.query(`SELECT product_description, regions, sectors, tender_keywords, cpv_prefixes, details
					FROM company_profile WHERE id = $1`, [company.profile_id])
				const result = await buildCompanyReport({profile: toWorkerProfile(company, profileRow), today, now, gather,
					previousRows: await previousRowsFor(pool, company.id, week), provider: tracked.provider, searchEnabled: settings.search_enabled,
					searchBudget: budget, researchRegion: matchRegion({catalogue, stage3}), log: (m) => log(`${company.name}: ${m}`)})
				kept = {outcome: 'succeeded', seconds: Math.round((Date.now() - started) / 1000), result}
				await putJson(blobs, name, kept)
			} catch (error) {
				log(`${company.name}: failed (${error.code ?? error.name})`)
				results.push({company: company.name, outcome: 'failed', error: error.code ?? error.name})
				if (error.code == 'programme_budget_reached') break
				continue
			}
		}
		const {rows: currentRows} = await pool.query(`SELECT kind, name, website, status, closing_date, row_data FROM report_row WHERE company_id = $1 AND report_id = $2`,
			[company.id, company.report_id])
		const {rows, counts} = compareReports({
			current: {rows: currentRows.map((r) => ({kind: r.kind, name: r.name, website: r.website, row: {...r.row_data, status: r.status, closing_date: iso(r.closing_date)}})), topFive: company.top_five},
			proposed: kept.result,
		})
		results.push({company: company.name, outcome: kept.outcome, counts, rows,
			current_cost_usd: Number(Number(company.model_cost_usd).toFixed(2)), proposed_cost_usd: Number((kept.result.modelCost + catalogueShare).toFixed(2)),
			current_minutes: Math.round(Number(company.seconds ?? 0) / 6) / 10, proposed_minutes: Math.round(kept.seconds / 6) / 10,
			searches: kept.result.searches, fetches: kept.result.fetches})
	}

	const book = comparisonWorkbook({week, catalogue, companies: results})
	await blobs.put(`${prefix}/comparison.xlsx`, Buffer.from(await book.xlsx.writeBuffer()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
	await putJson(blobs, `${prefix}/comparison.json`, {week, stage3, catalogue: {schemes: catalogue.schemes.length, passes: catalogue.passes, cost_usd: catalogue.cost}, companies: results})
	// Counts and costs only: the rows themselves stay in the blobs.
	return {week, spent_usd: Number(tracked.spent().cost.toFixed(2)), searches: budget.used,
		companies: results.map(({rows, ...r}) => r)}
}
