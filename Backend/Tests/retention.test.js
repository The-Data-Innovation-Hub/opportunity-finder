import test from 'node:test'
import assert from 'node:assert/strict'
import {applyClosedRetention} from '../Worker/Report/retention.js'

const today = '2026-10-23'

test('INF-004 closed rows drop four weeks after their closing date', () => {
	const rows = applyClosedRetention([
		{name: 'recent', status: 'Closed', closing_date: '2026-10-01'},
		{name: 'old', status: 'Closed', closing_date: '2026-09-20'},
		{name: 'open', status: 'Open', closing_date: '2026-11-30'},
	], {today})
	assert.deepEqual(rows.map((r) => r.name), ['recent', 'open'])
	assert.equal(rows[0].closed_since, '2026-10-01')
	assert.equal(rows[1].closed_since, null)
})

test('INF-004 undated closed rows count from the first week they were reported closed', () => {
	const previous = {carried: '2026-10-09', expired: '2026-09-18'}
	const rows = applyClosedRetention([
		{name: 'new', status: 'Closed', closing_date: null},
		{name: 'carried', status: 'Closed', closing_date: null},
		{name: 'expired', status: 'Closed', closing_date: null},
	], {today, previousClosedSince: (r) => previous[r.name]})
	assert.deepEqual(rows.map((r) => [r.name, r.closed_since]), [['new', today], ['carried', '2026-10-09']])
})
