// Brave Search API: the worker-owned web_search tool, the same for every
// model provider (BEH-011, DEC-008). Results are kept only when they are on
// the region's catalogue domains, and every query is counted for the run's
// cost record and the programme's Service cost card (BEH-012).
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const RESULTS = 20
// Programme cost per query for the Service cost card (BEH-012); the admin
// setting replaces this default in production.
export const PRICE_PER_QUERY = Number(process.env.BRAVE_PRICE_PER_1000 ?? 5) / 1000
const REQUEST_TIMEOUT_MS = 15_000

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
export const onDomains = (url, domains) => {
	const host = hostOf(url)
	return domains.some((d) => host == d || host.endsWith(`.${d}`))
}

// query: the model's search terms. site: optional catalogue domain to search
// within; anything not on the list is refused rather than searched.
export const braveSearch = async ({query, site, domains, apiKey = process.env.BRAVE_SEARCH_API_KEY, fetchImpl = fetch}) => {
	if (!apiKey) throw new Error('Brave search is not configured')
	if (site && !domains.includes(site.replace(/^www\./, ''))) return {results: [], error: `${site} is not on this region's source list`}
	const q = site ? `${query} site:${site}` : query
	const url = `${ENDPOINT}?${new URLSearchParams({q: q.slice(0, 400), count: String(RESULTS), country: 'GB', search_lang: 'en', safesearch: 'strict'})}`
	for (let attempt = 1; ; attempt++) {
		const response = await fetchImpl(url, {
			headers: {accept: 'application/json', 'x-subscription-token': apiKey},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		if (response.ok) {
			const data = await response.json()
			const results = (data.web?.results ?? [])
				.filter((r) => onDomains(r.url, domains))
				.map((r) => ({title: r.title, url: r.url, snippet: (r.description ?? '').replace(/<[^>]+>/g, ''), age: r.age ?? null}))
			return {results}
		}
		if (response.status == 429 && attempt < 3) {
			await new Promise((resolve) => setTimeout(resolve, 1100 * attempt))
			continue
		}
		// Never echo the response body: it can include account details.
		throw new Error(`Brave search returned ${response.status}`)
	}
}
