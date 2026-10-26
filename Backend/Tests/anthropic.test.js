import test from 'node:test'
import assert from 'node:assert/strict'
import {clientForKey, keyStatusFromError} from '../Worker/Providers/anthropic.js'
import {runSearch} from '../Worker/Research/search.js'

test('BEH-010 there is no fallback key: a company without one cannot run', async () => {
	assert.throws(() => clientForKey(undefined), /No API key/)
	await assert.rejects(runSearch({profile: {}, today: '2026-10-23', region: 'NI', tenders: [], previous: []}), /own provider/)
})

test('BEH-010 auth and billing failures map to a credential status', () => {
	assert.equal(keyStatusFromError({status: 401}), 'invalid')
	assert.equal(keyStatusFromError({status: 400, message: 'Your credit balance is too low'}), 'out_of_credit')
	assert.equal(keyStatusFromError({status: 529}), null)
})

import {createProvider} from '../Worker/Providers/anthropic.js'

const fakeClient = (responses) => {
	const requests = []
	return {requests, beta: {messages: {stream: (request) => {
		requests.push(structuredClone(request))
		return {finalMessage: async () => responses.shift()}
	}}}}
}

test('BEH-011 Claude adapter sends worker tools as strict client tools and returns tool results', async () => {
	const client = fakeClient([
		{stop_reason: 'tool_use', usage: {input_tokens: 10, output_tokens: 5}, content: [{type: 'tool_use', id: 't1', name: 'web_search', input: {query: 'q', site: null}}]},
		{stop_reason: 'tool_use', usage: {input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100}, content: [{type: 'tool_use', id: 't2', name: 'submit_report', input: {ok: true}}]},
	])
	const provider = createProvider({client})
	const conversation = provider.start({system: 'sys', content: [{type: 'text', text: 'shared', cache_control: {type: 'ephemeral'}}, {type: 'text', text: 'company'}],
		tools: [{name: 'web_search', description: 'd', schema: {type: 'object'}}, {name: 'submit_report', description: 'r', schema: {type: 'object'}, strict: true}]})
	const first = await conversation.send()
	assert.deepEqual(first.calls, [{id: 't1', name: 'web_search', input: {query: 'q', site: null}}])
	assert.deepEqual(client.requests[0].tools, [{name: 'web_search', description: 'd', input_schema: {type: 'object'}},
		{name: 'submit_report', description: 'r', input_schema: {type: 'object'}, strict: true}])
	conversation.addResults([{id: 't1', output: {error: 'Search limit reached'}}])
	await conversation.send()
	const last = client.requests[1].messages.at(-1)
	assert.equal(last.content[0].tool_use_id, 't1')
	assert.equal(last.content[0].is_error, true)
	assert.deepEqual(last.content[0].cache_control, {type: 'ephemeral'})
	assert.equal(conversation.usage.cache_read_input_tokens, 100)
	assert.ok(provider.estimateCost(conversation.usage) > 0)
})

test('DEC-011 cost is priced by the model that answered, and a workspace spend limit reads as out of credit', async () => {
	const usage = {input_tokens: 1_000_000, output_tokens: 0}
	const client = fakeClient([
		{content: [], stop_reason: 'end_turn', usage, model: 'claude-sonnet-5-5-20260601'},
		{content: [], stop_reason: 'end_turn', usage, model: 'some-fallback-model'},
	])
	const conversation = createProvider({client}).start({system: 's', content: [{type: 'text', text: 'x'}], tools: []})
	await conversation.send()
	assert.equal(conversation.costUsd, 2, 'a dated model id was not matched to its price')
	const logged = []
	const realLog = console.log
	console.log = (line) => logged.push(String(line))
	try { await conversation.send() } finally { console.log = realLog }
	assert.ok(logged.some((l) => l.includes('model_unpriced') && l.includes('some-fallback-model')), 'an unpriced fallback was not flagged')
	assert.equal(keyStatusFromError({status: 400, message: 'You have reached your specified workspace API usage limits.'}), 'out_of_credit')
})
