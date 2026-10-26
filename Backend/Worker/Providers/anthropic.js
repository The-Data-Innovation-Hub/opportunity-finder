// Anthropic (Claude) provider adapter. A run uses exactly the key it is
// given: the company's own (BEH-010) or, in the free period, the programme's
// (DEC-011). There is deliberately no default client, so a run without a key
// fails rather than falling back to another. Keys are never logged.
import Anthropic from '@anthropic-ai/sdk'
import {logLine} from '../../API/Library.js'

export const PROVIDER = 'anthropic'
export const DEFAULT_MODEL = 'claude-sonnet-5-5'

// List prices per token, for the company's cost estimate (its own bill).
const PRICES = {
	'claude-sonnet-5-5': {input: 2 / 1e6, output: 10 / 1e6, cacheWrite: 2.5 / 1e6, cacheRead: 0.2 / 1e6},
}

export const clientForKey = (apiKey) => {
	if (!apiKey) throw new Error('No API key for this company')
	return new Anthropic({apiKey, maxRetries: 3})
}

// Free check used when a company saves a key: listing models costs nothing.
export const checkApiKey = async (apiKey) => {
	try {
		await clientForKey(apiKey).models.list({limit: 1})
		return 'valid'
	} catch (error) {
		if (error?.status == 401 || error?.status == 403) return 'invalid'
		throw new Error(`Key check failed (${error?.status ?? 'network'})`)
	}
}

// Maps an API failure during a run to the credential status that skips the
// company's run and asks its admins to fix the key.
export const keyStatusFromError = (error) => {
	if (error?.status == 401 || error?.status == 403) return 'invalid'
	// Out of prepaid credit, or a workspace spend limit reached. The second
	// wording is not yet confirmed against a real limit (DEPLOYMENT.md step 8).
	if (error?.status == 400 && /credit balance|usage limits?/i.test(error?.message ?? '')) return 'out_of_credit'
	return null
}

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']

// A response may name a dated version of the model (e.g. "<model>-20260101").
const priceKey = (model) => Object.keys(PRICES).find((k) => model == k || model?.startsWith(`${k}-`))

export const estimateCost = (model, usage) => {
	const price = PRICES[priceKey(model)] ?? PRICES[DEFAULT_MODEL]
	return (usage.input_tokens ?? 0) * price.input + (usage.output_tokens ?? 0) * price.output
		+ (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite + (usage.cache_read_input_tokens ?? 0) * price.cacheRead
}

// Breakpoints: the system prompt and the shared funder-page block are cached
// by the caller; this keeps one more on the newest user turn so each request
// reads the conversation so far from cache (at most 4 are allowed).
const moveRollingBreakpoint = (messages) => {
	for (const [index, message] of messages.entries()) {
		if (index == 0 || !Array.isArray(message.content)) continue
		for (const block of message.content) delete block.cache_control
	}
	const last = messages.at(-1)
	if (messages.length > 1 && last.role == 'user' && Array.isArray(last.content)) last.content.at(-1).cache_control = {type: 'ephemeral'}
}

export const createProvider = ({apiKey, model = DEFAULT_MODEL, client = clientForKey(apiKey)}) => ({
	name: PROVIDER,
	model,
	estimateCost: (usage) => estimateCost(model, usage),
	// content: the first user message as text blocks; the caller marks the
	// shared block for caching.
	start: ({system, content, tools, effort = 'high', maxTokens = 64000}) => {
		const messages = [{role: 'user', content}]
		const usage = Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]))
		// Strict decoding only where a tool asks for it (the report): the API
		// limits the combined size of strict schemas.
		const toolDefs = tools.map((t) => ({name: t.name, description: t.description, input_schema: t.schema, ...(t.strict ? {strict: true} : {})}))
		const conversation = {
			usage,
			// Priced per response by the model that answered: a server-side
			// fallback may serve a different one from the model requested.
			costUsd: 0,
			send: async () => {
				moveRollingBreakpoint(messages)
				const response = await client.beta.messages.stream({
					model,
					max_tokens: maxTokens,
					betas: ['server-side-fallback-2026-07-01'],
					fallbacks: 'default',
					output_config: {effort},
					system: [{type: 'text', text: system, cache_control: {type: 'ephemeral'}}],
					tools: toolDefs,
					// Forced tool_choice is refused on this model; the loop nudges instead.
					tool_choice: {type: 'auto'},
					messages,
				}).finalMessage()
				for (const key of TOKEN_KEYS) usage[key] += response.usage?.[key] ?? 0
				const served = response.model ?? model
				if (!priceKey(served)) logLine({event: 'model_unpriced', model: served})
				conversation.costUsd += estimateCost(served, response.usage ?? {})
				if (response.stop_reason == 'refusal') throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'no category'})`)
				messages.push({role: 'assistant', content: response.content})
				return {
					calls: response.content.filter((b) => b.type == 'tool_use').map((b) => ({id: b.id, name: b.name, input: b.input})),
					stopReason: response.stop_reason,
				}
			},
			addResults: (results) => messages.push({role: 'user', content: results.map((r) => ({
				type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.output), ...(r.output?.error ? {is_error: true} : {}),
			}))}),
			nudge: (text) => messages.push({role: 'user', content: [{type: 'text', text}]}),
		}
		return conversation
	},
})
