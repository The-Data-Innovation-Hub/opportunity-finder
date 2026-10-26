import test from 'node:test'
import assert from 'node:assert/strict'
import {schemesFor, buildUserMessage} from '../Worker/Research/search.js'
import {sharedListings} from '../Worker/Sources/pages.js'

const health = {sectors: ['health and social care', 'AI software']}
const agri = {sectors: ['agri-food']}

test('DAT-004 sector-tagged schemes go only to companies in that sector', () => {
	assert.ok(schemesFor('NI', health).some((s) => s.scheme.startsWith('HSC Innovations')))
	assert.ok(!schemesFor('NI', agri).some((s) => s.scheme.startsWith('HSC Innovations')))
	assert.ok(schemesFor('NI', agri).some((s) => s.scheme == 'Innovation Vouchers'))
})

test('DAT-004 listing pages skip blocked, login and tender sites', () => {
	const pages = sharedListings('NI')
	assert.ok(pages.some((s) => s.domain == 'investni.com'))
	assert.ok(!pages.some((s) => ['research.hscni.net', 'etendersni.gov.uk', 'cofundni.com'].includes(s.domain)))
})

test('DAT-004 funder pages form a cached first block; unreadable pages are listed for Claude to fetch', () => {
	const funderPages = {fetched_on: '2026-10-23', pages: [
		{region: 'NI', kind: 'listing', organisation: 'Invest NI', url: 'https://www.investni.com/a', ok: true, title: 'Funding', text: 'Grant text', links: []},
		{region: 'NI', kind: 'listing', organisation: 'Techstart Ventures', url: 'https://techstart.vc', ok: false, text: '', links: []},
		{region: 'UK', kind: 'listing', organisation: 'UKRI', url: 'https://www.ukri.org/opportunity/', ok: true, text: 'UK text', links: []},
	]}
	const [shared, company] = buildUserMessage({profile: {...health, company_name: 'x'}, today: '2026-10-23', region: 'NI', tenders: [], previous: [], funderPages})
	assert.deepEqual(shared.cache_control, {type: 'ephemeral'})
	assert.ok(shared.text.includes('Grant text') && !shared.text.includes('UK text') && !shared.text.includes('=== Techstart') && shared.text.includes('investni.com, '))
	assert.ok(company.text.includes('Techstart Ventures: https://techstart.vc'))
	assert.ok(!shared.text.includes('Company profile'))
})
