// One company's weekly report from the week's shared gather: one research
// pass per selected region (BEH-008), merge and de-duplicate, "New this
// week" against last week's rows, closed-row retention, the direct-supply
// tender filter, and the cross-region Top 5. Shared by the weekly job and
// the trial script; it reads and writes nothing itself.
import {readFileSync} from 'node:fs'
import {shortlistTenders, shortlistGrants} from './Sources/ocds.js'
import {applyClosedRetention} from './Report/retention.js'
import {shortlistEuCalls} from './Sources/eu.js'
import {runSearch, chooseTopFive, scopeRegions, euHost} from './Research/search.js'

const catalogue = JSON.parse(readFileSync(new URL('./Sources/catalogue.json', import.meta.url), 'utf8'))
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
export const regionOfUrl = (url) => catalogue.find((s) => { const h = hostOf(url); return h == s.domain || h.endsWith(`.${s.domain}`) })?.region

const isNI = (n) => n.regions.some((r) => r.startsWith('UKN'))
export const rowKey = (s) => (s ?? '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]+/g, ' ').trim()

const dedupe = (rows, nameOf) => {
	const seen = new Set()
	return rows.filter((r) => {
		const keys = [rowKey(r.website), rowKey(nameOf(r))].filter(Boolean)
		if (keys.some((k) => seen.has(k))) return false
		keys.forEach((k) => seen.add(k))
		return true
	})
}

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
const addUsage = (a, b = {}) => Object.fromEntries(TOKEN_KEYS.map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]))

// gather: {ukNotices, ieNotices, grants, funderPages}. previousRows: last
// week's rows as {name, status, closed_since, closing_date, website, region, ...}.
// searchBudget: optional {limit, used} shared across the regional passes.
export const buildCompanyReport = async ({profile, today, now = new Date(), gather, previousRows = [], provider, searchEnabled = true, searchBudget, log = () => {}}) => {
	if (searchBudget && searchBudget.limit <= 0) searchEnabled = false
	const regions = scopeRegions(profile.regions ?? [])
	const tendersFor = {
		NI: shortlistTenders(gather.ukNotices.filter(isNI), profile, {today}),
		UK: shortlistTenders(gather.ukNotices.filter((n) => !isNI(n)), profile, {today}),
		IE: shortlistTenders(gather.ieNotices, profile, {today}),
	}
	const grantsFor = {UK: shortlistGrants(gather.grants, profile, {today})}
	const eu = euHost(regions)
	const euCalls = shortlistEuCalls(gather.funderPages?.euCalls ?? [], profile, {regions})

	const results = []
	for (const region of regions) {
		const previous = previousRows.filter((r) => r.region == region || (region == eu && r.region == 'EU'))
		log(`${region}: ${tendersFor[region].length} tenders, ${(grantsFor[region] ?? []).length} grants, ${region == eu ? `${euCalls.length} EU calls, ` : ''}${previous.length} rows from last week`)
		results.push({region, ...(await runSearch({profile, today, region, tenders: tendersFor[region], grants: grantsFor[region], previous,
			funderPages: gather.funderPages, euCalls: region == eu ? euCalls : null, provider, searchEnabled, searchBudget, log}))})
	}

	const seenLastWeek = new Set(previousRows.flatMap((r) => [rowKey(r.website), rowKey(r.name)]).filter(Boolean))
	const isNew = (name, website) => !seenLastWeek.has(rowKey(website)) && !seenLastWeek.has(rowKey(name))
	const previousClosedSince = (name, website) => previousRows.find((p) => p.status == 'Closed'
		&& ((website && rowKey(p.website) == rowKey(website)) || rowKey(p.name) == rowKey(name)))?.closed_since ?? null
	const funding = applyClosedRetention(dedupe(results.flatMap((r) => r.report.funding.map((f) => ({...f, region: r.region}))), (f) => f.fund)
		.map((f) => ({...f, new_this_week: isNew(f.fund, f.website)})), {today, previousClosedSince: (f) => previousClosedSince(f.fund, f.website)})
	// Tenders only when the company could bid or supply directly.
	const tenders = applyClosedRetention(dedupe(results.flatMap((r) => r.report.tenders.filter((t) => t.company_can_supply_directly)
		.map((t) => ({...t, region: r.region}))), (t) => t.title)
		.map((t) => ({...t, new_this_week: isNew(t.title, t.website)})), {today, previousClosedSince: (t) => previousClosedSince(t.title, t.website)})

	const top = await chooseTopFive({profile, today, log, provider, candidates: results.flatMap((r) => r.report.top_five), rows: [
		...funding.map((f) => ({name: f.fund, kind: 'funding', region: f.region, status: f.status, closing_date: f.closing_date, amount: f.amount, why_it_fits: f.why_it_fits})),
		...tenders.map((t) => ({name: t.title, kind: 'tender', region: t.region, status: t.status, closing_date: t.closing_date, amount: t.value, why_it_fits: t.why_it_fits})),
	]})

	const notIncluded = results.flatMap((r) => (r.report.not_included ?? []).map((n) => ({...n, region: r.region})))
	const sources = [...new Set([...funding, ...tenders].flatMap((r) => [r.website, ...(r.source_urls ?? [])]).filter(Boolean))]
	const notes = results.map((r) => r.report.notes && `${r.region}: ${r.report.notes}`).filter(Boolean).join(' ')
	const preparedLabel = now.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London'})
	const note = `Prepared ${preparedLabel} for ${regions.join(', ')}. 'New this week' = not in last week's report. Amber rows close in ≤30 days. Amounts and dates as published on the source pages; check them there before applying. Blank email = none published. ${notes}`.trim()

	const usage = results.reduce((u, r) => addUsage(u, r.usage), addUsage({}, top.usage))
	return {
		regions, funding, tenders, topFive: top.topFive, notIncluded, sources, note,
		passes: results.map((r) => ({region: r.region, funding_rows: r.report.funding.length, tender_rows: r.report.tenders.length,
			tenders_left_out: r.report.tenders.filter((t) => !t.company_can_supply_directly).length,
			searches: r.searches, fetches: r.fetches, model_cost_usd: Number(r.cost.toFixed(2))})),
		usage,
		modelCost: results.reduce((sum, r) => sum + r.cost, 0) + top.cost,
		searches: results.reduce((sum, r) => sum + r.searches, 0),
		fetches: results.reduce((sum, r) => sum + r.fetches, 0),
	}
}

// Last week's trial JSON (the sample report layout) as previous rows.
const regionOfGroup = {'Invest NI': 'NI', 'InterTradeIreland': 'NI', 'NI Health': 'NI', 'Ireland': 'IE', 'UK': 'UK'}
export const previousRowsFromSample = (report) => [
	...report.funding.map((r) => ({name: r.fund, status: r.status, closed_since: r.closed_since, closing_date: r.closing_date, amount: r.amount, match_funding: r.match_funding, email: r.email, phone: r.phone, website: r.website, region: regionOfGroup[r.source_group] ?? r.region ?? regionOfUrl(r.website) ?? 'UK'})),
	...(report.tenders ?? []).map((r) => ({name: r.title, status: r.status, closed_since: r.closed_since, closing_date: r.closing_date, website: r.website, region: r.region ?? (r.portal == 'eTenders (Ireland)' ? 'IE' : 'UK')})),
]
