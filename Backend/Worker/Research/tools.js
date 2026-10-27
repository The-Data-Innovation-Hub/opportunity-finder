// Worker-owned research tools, identical for every model provider (BEH-011).
// The model only decides what to call: searches go to Brave (programme key,
// DEC-008) and page reads go through the scraper's funder_page worker, both
// limited to the region's catalogue domains. Limits are counted here, not by
// the provider, so they hold the same way for everyone.
import {braveSearch, onDomains} from '../Sources/brave.js'
import {scrapePage} from '../Sources/scraper.js'
import {readEuTopic} from '../Sources/eu.js'

export const LIMITS = {searches: 20, fetches: 30}
// EU call pages need a browser; their text comes from the portal's data.
const readPage = async (url) => (await readEuTopic(url)) ?? scrapePage(url)
const MAX_PAGE_TEXT = 8000
const MAX_PAGE_LINKS = 40
const THIN_TEXT = 300

export const WEB_SEARCH = {
	name: 'web_search',
	description: 'Search the web through the programme\'s search service. Only results on this region\'s source domains are returned. Set site to one source domain to search within that funder\'s site (most useful), or null for an open search across all source domains.',
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['query', 'site'],
		properties: {
			query: {type: 'string', description: 'Search terms'},
			site: {type: ['string', 'null'], description: 'One source domain from the list in the message, e.g. "investni.com", or null'},
		},
	},
}

export const WEB_FETCH = {
	name: 'web_fetch',
	description: 'Read one web page on this region\'s source domains. Returns the page text and the links on it. Pages that need a browser to display return an error.',
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['url'],
		properties: {url: {type: 'string', description: 'Full https URL on a source domain'}},
	},
}

// budget: optional {limit, used}, shared by all of one company's regional
// passes: the searches the weekly job reserved for this run against the
// programme's monthly cap (BEH-013). Counted here, at the point of use.
export const createToolRunner = ({domains, searchEnabled = true, limits = LIMITS, budget, search = braveSearch, fetchPage = readPage}) => {
	const used = {searches: 0, fetches: 0}
	// Inputs are not schema-enforced (only the report tool is strict), so check them here.
	const webSearch = async ({query, site} = {}) => {
		if (typeof query != 'string' || !query.trim()) return {error: 'web_search needs a query.'}
		if (site != null && typeof site != 'string') return {error: 'site must be a domain or null.'}
		if (!searchEnabled) return {error: 'Web search is switched off this week. Use the supplied pages and web_fetch.'}
		const cleanSite = site ? site.replace(/^www\./, '').toLowerCase() : null
		if (cleanSite && !domains.includes(cleanSite)) return {error: `${site} is not one of this region's source domains.`}
		if (used.searches >= limits.searches) return {error: `Search limit reached (${limits.searches}). Use web_fetch, or submit the report.`}
		if (budget && budget.used >= budget.limit) return {error: 'This month\'s search allowance is used up. Use the supplied pages and web_fetch, or submit the report.'}
		used.searches++
		if (budget) budget.used++
		try {
			return await search({query, site: cleanSite, domains})
		} catch (error) {
			return {error: `Search failed: ${error.message}`}
		}
	}
	const webFetch = async ({url} = {}) => {
		if (typeof url != 'string') return {error: 'web_fetch needs a url.'}
		if (!onDomains(url, domains) || !url.startsWith('https://')) return {error: 'That page is not on this region\'s source domains.'}
		if (used.fetches >= limits.fetches) return {error: `Page read limit reached (${limits.fetches}). Submit the report with what you have.`}
		used.fetches++
		const page = await fetchPage(url)
		const text = page.content ?? ''
		if (page.status != 'Succeeded' || text.length < THIN_TEXT) {
			return {error: `Page not readable (${page.error ?? 'needs a browser to display'}). Use search results or other pages instead.`}
		}
		return {url, title: page.title ?? null, text: text.slice(0, MAX_PAGE_TEXT), links: (page.links ?? []).slice(0, MAX_PAGE_LINKS)}
	}
	const run = async ({name, input}) => {
		if (name == 'web_search') return webSearch(input)
		if (name == 'web_fetch') return webFetch(input)
		return {error: `Unknown tool ${name}`}
	}
	return {run, used}
}
