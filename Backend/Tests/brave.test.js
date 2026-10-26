import test from 'node:test'
import assert from 'node:assert/strict'
import {braveSearch} from '../Worker/Sources/brave.js'

const domains = ['investni.com', 'intertradeireland.com']
const reply = (results) => async (url, options) => ({ok: true, status: 200, url, options, json: async () => ({web: {results}})})

test('BEH-011 Brave results are limited to the region\'s catalogue domains', async () => {
	const {results} = await braveSearch({query: 'innovation vouchers', domains, apiKey: 'test', fetchImpl: reply([
		{title: 'Vouchers', url: 'https://www.investni.com/vouchers', description: '<strong>Up to</strong> £5k'},
		{title: 'Blog', url: 'https://example.com/invest-ni-vouchers', description: 'x'},
	])})
	assert.deepEqual(results, [{title: 'Vouchers', url: 'https://www.investni.com/vouchers', snippet: 'Up to £5k', age: null}])
})

test('BEH-011 a site outside the list is refused without a query', async () => {
	let called = false
	const result = await braveSearch({query: 'grants', site: 'example.com', domains, apiKey: 'test', fetchImpl: async () => { called = true }})
	assert.equal(called, false)
	assert.match(result.error, /not on this region/)
})

test('BEH-011 site restriction and key header are sent', async () => {
	let seen
	await braveSearch({query: 'acumen', site: 'intertradeireland.com', domains, apiKey: 'k', fetchImpl: async (url, options) => { seen = {url, options}; return {ok: true, json: async () => ({})} }})
	assert.equal(new URL(seen.url).searchParams.get('q'), 'acumen site:intertradeireland.com')
	assert.equal(seen.options.headers['x-subscription-token'], 'k')
})
