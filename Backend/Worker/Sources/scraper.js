// Client for the Opportunity Finder scraper service (Python, Scrapling):
// the Node backend never scrapes pages itself.
const SCRAPER_URL = process.env.SCRAPER_URL ?? 'http://localhost:8080'

export const scrapeListing = async (sourceKey, url, {since} = {}) => {
	const response = await fetch(`${SCRAPER_URL}/scrape`, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...(process.env.SCRAPER_SHARED_SECRET ? {'x-scraper-secret': process.env.SCRAPER_SHARED_SECRET} : {})},
		body: JSON.stringify({source_key: sourceKey, url, ...(since ? {since} : {})}),
		signal: AbortSignal.timeout(10 * 60_000),
	})
	if (!response.ok) throw new Error(`scraper returned ${response.status} for ${sourceKey}`)
	const document = await response.json()
	if (document.status != 'Succeeded') throw new Error(`scraper failed for ${sourceKey}: ${document.error}`)
	return document.notices ?? []
}

export const fetchEtendersIreland = async ({since}) => (await scrapeListing('etenders_ie_latest',
	'https://www.etenders.gov.ie/epps/quickSearchAction.do?searchType=cftFTS&latest=true', {since}))
	.map((n) => ({
		portal: 'eTenders (Ireland)', reference: n.reference, ocid: null, title: n.title, buyer: n.buyer,
		description: '', value: n.estimated_value_eur ? `EUR ${n.estimated_value_eur.toLocaleString('en-GB')}` : null,
		closing_date: n.closing_date, status: n.status, stage: 'tender', cpv: [], regions: ['IE'], url: n.url,
	}))

// Every Innovate UK competition on the Innovation Funding Service search.
export const fetchIfsCompetitions = () => scrapeListing('ifs_competitions', 'https://apply-for-innovation-funding.service.gov.uk/competition/search')

export const fetchFindAGrant = () => scrapeListing('find_a_grant', 'https://www.find-government-grants.service.gov.uk/grants')

// One funder page (listing or scheme). Failures come back as a page with
// ok: false rather than throwing, so one dead link does not stop the run.
export const scrapePage = async (url, attempt = 1) => {
	try {
		const response = await fetch(`${SCRAPER_URL}/scrape`, {
			method: 'POST',
			headers: {'content-type': 'application/json', ...(process.env.SCRAPER_SHARED_SECRET ? {'x-scraper-secret': process.env.SCRAPER_SHARED_SECRET} : {})},
			body: JSON.stringify({source_key: 'funder_page', url}),
			signal: AbortSignal.timeout(60_000),
		})
		if (!response.ok) return {url, status: 'Failed', error: `scraper returned ${response.status}`}
		return await response.json()
	} catch (error) {
		if (attempt < 2) {
			await new Promise((resolve) => setTimeout(resolve, 3000))
			return scrapePage(url, attempt + 1)
		}
		return {url, status: 'Failed', error: error.message}
	}
}
