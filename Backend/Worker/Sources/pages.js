// Funder pages, gathered once a week and shared by every company's search:
// each catalogue listing page, plus the official page of each named scheme
// on the standing checklist (schemes.json url). Claude reads the
// saved text instead of fetching the same pages for every company. Fetching
// goes through the scraper service (funder_page worker).
import fs from 'node:fs'
import {scrapePage, fetchIfsCompetitions} from './scraper.js'

const CATALOGUE = JSON.parse(fs.readFileSync(new URL('./catalogue.json', import.meta.url), 'utf8'))
const SCHEMES = JSON.parse(fs.readFileSync(new URL('./schemes.json', import.meta.url), 'utf8'))
const LISTING_ACCESS = new Set(['html', 'rss'])
// Listing pages carry many schemes, so they keep more text than a scheme page.
const MAX_TEXT = {listing: 20000, scheme: 8000}
const MAX_LINKS = 60
// Pages rendered by JavaScript come back almost empty from a plain fetch;
// Claude is told to read those itself.
const THIN_TEXT = 300
const PAGE_DELAY_MS = 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Shared pages: every core and sector listing (not low-tier), whatever the
// company's sector, so one copy serves every company in the region. Sources
// with a listing_worker are read as structured lists instead (competitions).
export const sharedListings = (region) => CATALOGUE.filter((s) => s.region == region && s.kind != 'tenders'
	&& LISTING_ACCESS.has(s.access) && s.listing_url && s.tier != 'low' && !s.listing_worker)

const toPage = (document, extra) => ({
	...extra, url: document.url, ok: document.status == 'Succeeded' && (document.content ?? '').length >= THIN_TEXT,
	error: document.error ?? (document.status == 'Succeeded' ? 'page text not readable without a browser' : null),
	title: document.title ?? null, text: (document.content ?? '').slice(0, MAX_TEXT[extra.kind]),
	links: (document.links ?? []).slice(0, MAX_LINKS),
})

export const gatherFunderPages = async ({regions, log = () => {}}) => {
	const pages = []
	for (const region of regions) {
		// more_pages: further pages of a paged listing (e.g. Innovate UK's competition search).
		for (const source of sharedListings(region)) {
			for (const url of [source.listing_url, ...(source.more_pages ?? [])]) {
				pages.push(toPage(await scrapePage(url), {region, kind: 'listing', organisation: source.organisation}))
				await sleep(PAGE_DELAY_MS)
			}
		}
		for (const scheme of SCHEMES.filter((s) => s.region == region && s.url)) {
			if (pages.some((p) => p.url == scheme.url)) continue
			pages.push(toPage(await scrapePage(scheme.url), {region, kind: 'scheme', organisation: scheme.funder, scheme: scheme.scheme}))
			await sleep(PAGE_DELAY_MS)
		}
		const mine = pages.filter((p) => p.region == region)
		log(`${region}: ${mine.length} funder pages (${mine.filter((p) => !p.ok).length} failed)`)
	}
	// Innovate UK competitions (UK pass): each one must be accepted or rejected.
	let competitions = []
	if (regions.includes('UK')) {
		try {
			competitions = await fetchIfsCompetitions()
		} catch (error) {
			log(`Innovate UK competitions not read: ${error.message}`)
		}
		log(`UK: ${competitions.length} Innovate UK competitions`)
	}
	return {fetched_on: new Date().toISOString().slice(0, 10), pages, competitions}
}
