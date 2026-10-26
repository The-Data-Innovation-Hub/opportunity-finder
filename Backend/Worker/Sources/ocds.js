// Gathers open tender notices from the two UK portals that publish an OCDS
// API: Find a Tender (high-value, UK-wide incl. NI) and Contracts Finder
// (England, lower value). Notices are fetched once per run window and shared
// across companies; matching to a company happens in shortlistTenders.
const PORTALS = [
	{
		portal: 'Find a Tender',
		url: (from, to) => `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=100&updatedFrom=${from}&updatedTo=${to}`,
		noticeUrl: (release) => `https://www.find-tender.service.gov.uk/Notice/${release.id}`,
	},
	{
		portal: 'Contracts Finder',
		url: (from, to) => `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?limit=100&publishedFrom=${from}&publishedTo=${to}`,
		// The release id is the notice id plus a "-<version>" suffix; the
		// tenderNotice document carries the public link when present.
		noticeUrl: (release) => release.tender?.documents?.find((d) => d.documentType == 'tenderNotice')?.url
			?? `https://www.contractsfinder.service.gov.uk/Notice/${release.id.replace(/-\d+$/, '')}`,
	},
]

// ~5 pages a day on Find a Tender; a week fits well inside this cap.
const MAX_PAGES = 200
// The portals' own `stages` filter drops most tender notices, so every release
// is fetched and filtered here. Planning notices (market engagement, prior
// information) are kept: they become "Opening soon" rows.
const KEEP_TAGS = new Set(['tender', 'tenderUpdate', 'tenderAmendment', 'planning', 'planningUpdate'])
const REQUEST_TIMEOUT_MS = 30_000

// Both portals rate-limit; pause between pages and honour Retry-After.
const PAGE_DELAY_MS = 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fetchJson = async (url) => {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(url, {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: {accept: 'application/json'}})
		if (response.ok) return response.json()
		if (attempt >= 6 || ![429, 500, 502, 503, 504].includes(response.status)) {
			throw new Error(`${new URL(url).host} returned ${response.status}`)
		}
		const retryAfter = Number(response.headers.get('retry-after'))
		await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt)
	}
}

const normalise = (portal, release) => {
	const tender = release.tender ?? {}
	const cpvs = new Set()
	if (tender.classification?.scheme == 'CPV') cpvs.add(tender.classification.id)
	for (const item of tender.items ?? []) {
		if (item.classification?.scheme == 'CPV') cpvs.add(item.classification.id)
		for (const extra of item.additionalClassifications ?? []) if (extra.scheme == 'CPV') cpvs.add(extra.id)
	}
	const regions = new Set()
	for (const party of release.parties ?? []) if (party.address?.region) regions.add(party.address.region)
	for (const item of tender.items ?? []) for (const address of item.deliveryAddresses ?? []) if (address.region) regions.add(address.region)
	const buyerParty = (release.parties ?? []).find((p) => p.id == release.buyer?.id)
	return {
		portal: portal.portal,
		ocid: release.ocid,
		reference: release.id,
		title: tender.title ?? release.description ?? '(untitled notice)',
		buyer: release.buyer?.name ?? null,
		description: (tender.description ?? '').slice(0, 1500),
		value: tender.value?.amount ? `${tender.value.currency ?? 'GBP'} ${tender.value.amount.toLocaleString('en-GB')}` : null,
		closing_date: tender.tenderPeriod?.endDate?.slice(0, 10) ?? null,
		status: tender.status ?? null,
		cpv: [...cpvs],
		regions: [...regions],
		contact_email: buyerParty?.contactPoint?.email ?? null,
		url: portal.noticeUrl(release),
	}
}

// Returns every tender-stage notice published or updated in [from, to).
export const fetchTenderNotices = async ({from, to, log = () => {}}) => {
	const notices = new Map()
	for (const portal of PORTALS) {
		let url = portal.url(from, to)
		let pages = 0
		while (url && pages < MAX_PAGES) {
			const data = await fetchJson(url)
			for (const release of data.releases ?? []) {
				const tags = release.tag ?? []
				const key = release.ocid ?? release.id
				if (tags.some((t) => t == 'tenderCancellation' || t.startsWith('award') || t.startsWith('contract'))) {
					notices.delete(key)
					continue
				}
				if (!tags.some((t) => KEEP_TAGS.has(t))) continue
				const notice = normalise(portal, release)
				notice.stage = tags.some((t) => t.startsWith('tender')) ? 'tender' : 'planning'
				const existing = notices.get(key)
				if (!existing || (release.date ?? '') >= existing.date) notices.set(key, {...notice, date: release.date ?? ''})
			}
			pages++
			url = data.links?.next ?? null
			if (url) await sleep(PAGE_DELAY_MS)
		}
		log(`${portal.portal}: ${pages} page(s)${url ? ' (stopped at page limit)' : ''}`)
	}
	return [...notices.values()]
}

const words = (text) => (text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []

// Cheap, explainable pre-filter so Claude only reviews plausible notices:
// a CPV prefix match or keyword hits in the title/description, still open,
// and in a region the company covers. Claude makes the final fit judgement.
export const shortlistTenders = (notices, profile, {today, limit = 60}) => {
	const keywords = profile.tender_keywords.map((k) => k.toLowerCase())
	const cpvPrefixes = profile.cpv_prefixes ?? []
	const regionPrefixes = profile.nuts_regions ?? []
	const scored = []
	for (const notice of notices) {
		if (notice.closing_date && notice.closing_date < today) continue
		if (notice.status && notice.portal != 'eTenders (Ireland)' && !['active', 'planned', 'planning'].includes(notice.status)) continue
		if (regionPrefixes.length && notice.regions.length && !notice.regions.some((r) => regionPrefixes.some((p) => r.startsWith(p)))) continue
		const text = ` ${words(`${notice.title} ${notice.description}`).join(' ')} `
		let score = 0
		for (const keyword of keywords) if (text.includes(` ${keyword} `)) score += keyword.includes(' ') ? 3 : 2
		if (notice.cpv.some((c) => cpvPrefixes.some((p) => c.startsWith(p)))) score += 2
		if (score >= 3) scored.push({score, notice})
	}
	scored.sort((a, b) => b.score - a.score)
	return scored.slice(0, limit).map((s) => s.notice)
}

// Find a Grant listings: same keyword idea, plus a location check so an
// England-only grant is not offered to an NI company.
export const shortlistGrants = (grants, profile, {today, limit = 25}) => {
	const keywords = [...profile.tender_keywords, ...(profile.sectors ?? [])].map((k) => k.toLowerCase())
	const scored = []
	for (const grant of grants) {
		const location = (grant.location ?? '').toLowerCase()
		if (location && !/northern ireland|uk|united kingdom|national/.test(location)) continue
		const text = ` ${words(`${grant.title} ${grant.summary} ${grant.funder}`).join(' ')} `
		let score = 0
		for (const keyword of keywords) if (text.includes(` ${keyword} `)) score += keyword.includes(' ') ? 3 : 2
		if (score >= 2) scored.push({score, grant})
	}
	scored.sort((a, b) => b.score - a.score)
	return scored.slice(0, limit).map((s) => s.grant)
}
