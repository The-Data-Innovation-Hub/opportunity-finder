// A fixed pointer to FundFinder (Concept Ventures), a free map of the venture
// funds backing UK and European startups, in every report. Link only: none
// of its data is copied, read or searched until Concept Ventures agree to
// that (asked 3 Nov 2026). Stage and sectors pick which of its public lists
// to link to. No AI and no cost.
export const FUNDFINDER = 'https://fundfinder.concept.vc'

// The company's stage (Settings) to FundFinder's round stages.
const STAGE_LISTS = {
	'Idea, pre-revenue': ['pre-seed'],
	'Prototype or pilot': ['pre-seed'],
	'Early revenue': ['seed'],
	'Growing': ['series-a'],
	'Established': ['series-a'],
}
// The company's sectors (Settings) to FundFinder's sector lists. Every
// company is in healthcare, so healthcare-wellbeing is the fallback.
const SECTOR_LISTS = {
	'Digital health and healthtech': 'healthcare-wellbeing',
	'Medtech and medical devices': 'medtech',
	'Life sciences': 'life-sciences',
	'Data and AI': 'ai',
	'Software and SaaS': 'saas',
}

export const investorDirectoryRow = (profile, region) => {
	const stages = STAGE_LISTS[profile.company?.stage] ?? ['pre-seed', 'seed']
	const sectors = [...new Set((profile.sectors ?? []).map((s) => SECTOR_LISTS[s]).filter(Boolean))]
	const lists = stages.flatMap((stage) => (sectors.length ? sectors : ['healthcare-wellbeing']).map((sector) => `${FUNDFINDER}/lists/${stage}/${sector}`))
	return {
		fund: 'FundFinder: map of UK and European early-stage investors',
		funder: 'Concept Ventures',
		source_group: 'Other',
		type: 'equity',
		amount: 'Cheque sizes vary by fund; each fund\'s profile gives its range',
		match_funding: 'Not applicable',
		closing_date: null,
		status: 'Rolling',
		why_it_fits: 'Lists the venture funds investing at your stage and in your sectors, with their cheque sizes and recent rounds.',
		eligibility_notes: 'Free, no sign-up. Covers funds backing UK and European startups from pre-seed to Series A. Built by Concept Ventures from public announcements and Harmonic data.',
		website: lists[0],
		email: null,
		phone: null,
		next_step: 'Use "Find your investors" and these lists to build a shortlist for your next round.',
		source_urls: [FUNDFINDER, ...lists],
		region,
	}
}
