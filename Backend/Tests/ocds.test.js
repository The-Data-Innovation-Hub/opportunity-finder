import test from 'node:test'
import assert from 'node:assert/strict'
import {shortlistTenders} from '../Worker/Sources/ocds.js'

const TODAY = '2026-11-02'
const profile = {tender_keywords: ['telehealth', 'remote monitoring'], cpv_prefixes: ['4800'], nuts_regions: []}
const notice = (overrides) => ({title: '', description: '', cpv: [], regions: [], status: 'active', closing_date: '2026-12-01', portal: 'Find a Tender', ...overrides})

test('eTenders (Ireland) title-only notices are shortlisted on a single keyword', () => {
	const ie = notice({title: 'Telehealth platform for HSE community services', portal: 'eTenders (Ireland)', regions: ['IE'], status: undefined})
	assert.deepEqual(shortlistTenders([ie], profile, {today: TODAY}), [ie])
})

test('a notice with a description or CPV still needs more than one single-word keyword', () => {
	const described = notice({title: 'Telehealth support', description: 'Facilities management for a clinic.'})
	const coded = notice({title: 'Telehealth support', cpv: ['45000000']})
	assert.deepEqual(shortlistTenders([described, coded], profile, {today: TODAY}), [])
	const strong = notice({title: 'Telehealth support', cpv: ['48000000']})
	assert.deepEqual(shortlistTenders([strong], profile, {today: TODAY}), [strong])
})

test('title-only notices with no keyword, or past their closing date, are left out', () => {
	const unrelated = notice({title: 'Road resurfacing works', portal: 'eTenders (Ireland)'})
	const closed = notice({title: 'Telehealth platform', portal: 'eTenders (Ireland)', closing_date: '2026-10-01'})
	assert.deepEqual(shortlistTenders([unrelated, closed], profile, {today: TODAY}), [])
})
