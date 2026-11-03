import test from 'node:test'
import assert from 'node:assert/strict'
import {investorDirectoryRow, FUNDFINDER} from '../Worker/Sources/investors.js'

test('FundFinder row links to the lists for the company\'s stage and sectors, and copies no fund data', () => {
	const row = investorDirectoryRow({company: {stage: 'Early revenue'}, sectors: ['Medtech and medical devices', 'Data and AI', 'Fintech']}, 'UK')
	assert.equal(row.website, `${FUNDFINDER}/lists/seed/medtech`)
	assert.deepEqual(row.source_urls, [FUNDFINDER, `${FUNDFINDER}/lists/seed/medtech`, `${FUNDFINDER}/lists/seed/ai`])
	assert.deepEqual([row.status, row.closing_date, row.email, row.phone, row.region], ['Rolling', null, null, null, 'UK'])
})

test('FundFinder row without a stage or a mapped sector falls back to pre-seed and seed health lists', () => {
	const row = investorDirectoryRow({sectors: ['Public sector and govtech']}, 'NI')
	assert.deepEqual(row.source_urls.slice(1), [`${FUNDFINDER}/lists/pre-seed/healthcare-wellbeing`, `${FUNDFINDER}/lists/seed/healthcare-wellbeing`])
})
