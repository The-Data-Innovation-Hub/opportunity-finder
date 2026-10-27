// EU calls from the EU Funding & Tenders Portal, read through its public
// search API (SEDIA; the "SEDIA" key is the portal's own public key). The
// open and forthcoming call topics are gathered once a week and shared, as
// the Innovate UK competitions are; shortlistEuCalls matches them to each
// company. The search results carry titles only, so each topic's page data
// (description, budget) is read too.
const SEARCH_URL = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=***'
const TOPIC_URL = (identifier) => `https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/${identifier.toLowerCase()}.json`
// type 1: call topics, 8: calls run by EU-funded projects for third parties
// (cascade funding, mostly aimed at SMEs). Status 31094501: forthcoming,
// 31094502: open.
const QUERY = {bool: {must: [{terms: {type: ['1', '8']}}, {terms: {status: ['31094501', '31094502']}}]}}
const FORTHCOMING = '31094501'
const PAGE_SIZE = 100
const MAX_PAGES = 30
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_DELAY_MS = 500
const TOPIC_DELAY_MS = 200
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Programmes worth offering to a company, by the prefix of the call
// identifier; development-aid and other calls are left out. UK (and so NI)
// organisations can apply to Horizon Europe and Euratom, to which the UK is
// associated; the others need an organisation established in an EU member
// state, such as Ireland.
export const PROGRAMMES = {
	HORIZON: {name: 'Horizon Europe', uk: true},
	EURATOM: {name: 'Euratom', uk: true},
	DIGITAL: {name: 'Digital Europe', uk: false},
	SMP: {name: 'Single Market Programme', uk: false},
	EU4H: {name: 'EU4Health', uk: false},
	LIFE: {name: 'LIFE', uk: false},
	CEF: {name: 'Connecting Europe Facility', uk: false},
	I3: {name: 'Interregional Innovation Investments', uk: false},
	CREA: {name: 'Creative Europe', uk: false},
	EDF: {name: 'European Defence Fund', uk: false},
}

const first = (value) => Array.isArray(value) ? value[0] : value
export const plainText = (html) => (html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
	.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, '\'').replace(/\s+/g, ' ').trim()

const postSearch = async (pageNumber) => {
	const form = new FormData()
	form.append('query', new Blob([JSON.stringify(QUERY)], {type: 'application/json'}))
	form.append('languages', new Blob([JSON.stringify(['en'])], {type: 'application/json'}))
	// Without a sort the portal's pages overlap and skip results.
	form.append('sort', new Blob([JSON.stringify({order: 'ASC', field: 'identifier'})], {type: 'application/json'}))
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(`${SEARCH_URL}&pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}`, {method: 'POST', body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
		if (response.ok) return response.json()
		if (attempt >= 4 || ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`EU portal search returned ${response.status}`)
		await sleep(5000 * attempt)
	}
}

// One search result as a call, or null when it is closed in all but name:
// the portal keeps some topics "open" or "forthcoming" long after their last
// deadline.
export const toCall = (result, today) => {
	const m = result.metadata ?? {}
	const identifier = first(m.identifier) ?? ''
	const programme = PROGRAMMES[identifier.split('-')[0]]
	if (!programme) return null
	const deadlines = (m.deadlineDate ?? []).map((d) => d.slice(0, 10)).sort()
	const forthcoming = first(m.status) == FORTHCOMING
	const closes = deadlines.find((d) => d >= today) ?? null
	if (!closes && !(forthcoming && deadlines.length == 0)) return null
	// A cascade call's own name is its callTitle; title is the EU topic that funds it.
	const cascade = first(m.type) == '8'
	const [title, call] = cascade ? [first(m.callTitle)?.trim() || first(m.title), first(m.title)] : [first(m.title), first(m.callTitle)]
	return {
		identifier, programme: programme.name, uk_eligible: programme.uk, cascade,
		title: title ?? identifier,
		call: call ?? null,
		status: forthcoming ? 'Opening soon' : 'Open',
		opens: first(m.startDate)?.slice(0, 10) ?? null,
		closes,
		deadline_model: first(m.deadlineModel) ?? null,
		action: first(m.typesOfAction) ?? null,
		url: result.url,
		summary: plainText(first(m.description)).slice(0, 1500),
		amount: null,
	}
}

// "EUR 2.5m to 3m per project" from the topic's budget table, when it has one.
const millions = (n) => `${Number((n / 1e6).toFixed(2))}m`
export const amountOf = (budgetJson, identifier) => {
	const actions = Object.values(budgetJson?.budgetTopicActionMap ?? {}).flat()
		.filter((a) => a.action?.toUpperCase().startsWith(identifier.toUpperCase()))
	// Some topics (the EIC Accelerator) fill the table with zeros.
	const given = (key) => actions.map((a) => a[key]).filter((n) => Number.isFinite(n) && n > 0)
	const min = Math.min(...given('minContribution'))
	const max = Math.max(...given('maxContribution'))
	if (!Number.isFinite(max)) return null
	return min == max || !Number.isFinite(min) ? `EUR ${millions(max)} per project` : `EUR ${millions(min)} to ${millions(max)} per project`
}

const readTopic = async (call) => {
	try {
		const response = await fetch(TOPIC_URL(call.identifier), {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: {accept: 'application/json'}})
		if (!response.ok) return call
		const topic = (await response.json()).TopicDetails ?? {}
		return {...call, summary: call.summary || plainText(topic.description).slice(0, 1500), amount: amountOf(topic.budgetOverviewJSONItem, call.identifier),
			sme: Boolean(topic.sme)}
	} catch {
		return call
	}
}

// A call topic's page on the portal needs a browser, so a web_fetch of it
// (or of its data file) is answered from the topic's data instead: the same
// page as text. Returns null for any other address.
const TOPIC_PAGE = /\/opportunities\/(?:portal\/screen\/opportunities\/topic-details\/|data\/topicDetails\/)([A-Za-z0-9._-]+?)(?:\.json)?(?:[?#].*)?$/
export const readEuTopic = async (url, {fetchJson = fetch} = {}) => {
	const identifier = typeof url == 'string' && url.startsWith('https://ec.europa.eu/') ? url.match(TOPIC_PAGE)?.[1] : null
	if (!identifier) return null
	try {
		const response = await fetchJson(TOPIC_URL(identifier), {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: {accept: 'application/json'}})
		if (!response.ok) return {url, status: 'Failed', error: `EU portal returned ${response.status}`}
		const topic = (await response.json()).TopicDetails ?? {}
		// Dates come as epoch milliseconds.
		const day = (v) => new Date(v).toISOString().slice(0, 10)
		const deadlines = (topic.actions ?? []).flatMap((a) => [a.plannedOpeningDate && `opens ${day(a.plannedOpeningDate)}`,
			...(a.deadlineDates ?? []).map((d) => `deadline ${day(d)}`)]).filter(Boolean)
		const content = [
			`${topic.identifier ?? identifier}: ${topic.title ?? ''}`,
			topic.callTitle ? `Call: ${topic.callTitle}` : null,
			deadlines.length ? `Dates: ${deadlines.join(', ')}` : null,
			amountOf(topic.budgetOverviewJSONItem, topic.identifier ?? identifier),
			plainText(topic.description),
			plainText(topic.conditions),
		].filter(Boolean).join('\n\n')
		return {url, status: 'Succeeded', title: topic.title ?? identifier, content, links: []}
	} catch (error) {
		return {url, status: 'Failed', error: error.message}
	}
}

// Every open or forthcoming call, one entry per call page.
export const fetchEuCalls = async ({today = new Date().toISOString().slice(0, 10), log = () => {}} = {}) => {
	const calls = new Map()
	let total = Infinity
	for (let page = 1; (page - 1) * PAGE_SIZE < total && page <= MAX_PAGES; page++) {
		const data = await postSearch(page)
		total = data.totalResults ?? 0
		for (const result of data.results ?? []) {
			const call = toCall(result, today)
			if (call && !calls.has(call.url)) calls.set(call.url, call)
		}
		await sleep(PAGE_DELAY_MS)
	}
	const read = []
	for (const call of calls.values()) {
		read.push(call.cascade ? call : await readTopic(call))
		if (!call.cascade) await sleep(TOPIC_DELAY_MS)
	}
	log(`EU: ${read.length} open or forthcoming calls on the Funding & Tenders Portal`)
	return read
}

const words = (text) => (text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
const ACCELERATOR = /^HORIZON-EIC-\d{4}-ACCELERATOR-\d+$/
// EU texts rarely use a company's own phrases, so single words from its
// keywords and sectors count too, less than a whole phrase.
const COMMON = new Set(['and', 'the', 'for', 'with', 'from', 'software', 'management', 'system', 'systems', 'services', 'tech', 'technology', 'based'])
// Horizon Europe health cluster topics suit any health company.
const THEMES = [{identifier: /-HLTH-|EU4H-/, sector: /health|medic|care|clinic|pharma/}]

// Keyword pre-filter, as for tenders and grants: Claude makes the final
// judgement. The open EIC Accelerator call suits any innovative company, so
// it is always offered. Calls a UK or NI organisation cannot lead are offered
// only when the company's scope includes Ireland.
export const shortlistEuCalls = (calls, profile, {regions, limit = 20}) => {
	const phrases = [...(profile.tender_keywords ?? []), ...(profile.sectors ?? [])].map((k) => k.toLowerCase())
	const single = [...new Set(phrases.flatMap(words))].filter((w) => w.length >= 4 && !COMMON.has(w))
	const sectors = (profile.sectors ?? []).join(' ').toLowerCase()
	const scored = []
	for (const call of calls) {
		if (!call.uk_eligible && !regions.includes('IE')) continue
		const title = new Set(words(`${call.title} ${call.call ?? ''}`))
		const all = words(`${call.title} ${call.call ?? ''} ${call.summary}`)
		const text = ` ${all.join(' ')} `
		const body = new Set(all)
		let score = ACCELERATOR.test(call.identifier) ? 100 : 0
		for (const phrase of phrases) if (text.includes(` ${phrase} `)) score += phrase.includes(' ') ? 3 : 2
		for (const word of single) score += title.has(word) ? 1 : body.has(word) ? 0.5 : 0
		if (THEMES.some((t) => t.identifier.test(call.identifier) && t.sector.test(sectors))) score += 1.5
		if (score > 0 && (call.cascade || call.sme)) score += 0.5
		if (score >= 3) scored.push({score, call})
	}
	scored.sort((a, b) => b.score - a.score || (a.call.closes ?? '9').localeCompare(b.call.closes ?? '9'))
	return scored.slice(0, limit).map((s) => s.call)
}
