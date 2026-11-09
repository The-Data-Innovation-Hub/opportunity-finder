// The provider-neutral research loop (BEH-011). A provider conversation
// (Providers/*.js) sends the request and reports the tool calls; this loop
// runs them with the worker's own tools and stops when the model calls the
// final tool (submit_report or select_top_five). validate(input) may return
// a message to send the result back for completion, up to MAX_RETURNS times.
// The model then submits only the additions, which are merged onto the
// result already held: resending a complete report wrote every row again
// and doubled or tripled a pass's output cost (DEC-016 trial, 9 Nov 2026).
const MAX_TURNS = 60
const MAX_RETURNS = 2

// Under strict output the model sometimes writes a character as the literal
// text "\\u20ac" rather than "€" (seen in trial runs 7 and 8). Decoded in
// every string of the final result, so reports and workbooks show the
// character. Surrogate pairs come out right because the pair is decoded
// into two UTF-16 units that join up.
export const decodeUnicodeEscapes = (value) => {
	if (typeof value == 'string') return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
	if (Array.isArray(value)) return value.map(decodeUnicodeEscapes)
	if (value && typeof value == 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeUnicodeEscapes(v)]))
	return value
}

// An item's identity for merging: its name and page together, since two
// schemes can share one funder page.
const itemKey = (item) => {
	const name = item?.fund ?? item?.title ?? item?.name
	return name == null ? JSON.stringify(item) : `${name}|${item.website ?? ''}`.toLowerCase().trim()
}

// Joins a returned result's additions onto the result already held. Lists are
// joined, an addition replacing a held item with the same key, so a model that
// resends the complete result still leaves no duplicates. Text is joined;
// any other value is taken from the additions.
export const mergeAdditions = (held, additions) => Object.fromEntries([...new Set([...Object.keys(held), ...Object.keys(additions)])].map((key) => {
	const before = held[key]
	const after = additions[key]
	if (Array.isArray(before) && Array.isArray(after)) {
		const merged = new Map(before.map((item) => [itemKey(item), item]))
		for (const item of after) merged.set(itemKey(item), item)
		return [key, [...merged.values()]]
	}
	if (typeof before == 'string' && typeof after == 'string') return [key, before && after && before != after ? `${before} ${after}` : before || after]
	return [key, after === undefined ? before : after]
}))

export const research = async ({conversation, runTool, finalTool, validate = () => null, label = '', log = () => {}, maxTurns = MAX_TURNS}) => {
	let nudged = false
	let returns = 0
	let held = null
	for (let turn = 1; turn <= maxTurns; turn++) {
		const {calls, stopReason} = await conversation.send()
		const final = calls.find((c) => c.name == finalTool)
		if (final) {
			const submitted = decodeUnicodeEscapes(final.input)
			const input = held ? mergeAdditions(held, submitted) : submitted
			const problem = returns < MAX_RETURNS ? validate(input) : null
			if (!problem) return input
			held = input
			returns++
			// Every tool call in the turn needs a result before the model can continue.
			conversation.addResults(calls.map((c) => ({id: c.id, output: c == final ? {error: problem} : {error: 'Not run: the report was returned for completion.'}})))
			continue
		}
		if (calls.length) {
			const results = []
			for (const call of calls) results.push({id: call.id, output: await runTool(call)})
			conversation.addResults(results)
			log(`${label} turn ${turn}: ${calls.map((c) => c.name).join(', ')}`)
			continue
		}
		if (stopReason == 'max_tokens') throw new Error('Response exceeded the output limit')
		if (nudged) throw new Error(`Model finished without calling ${finalTool}`)
		nudged = true
		conversation.nudge(`Please call ${finalTool} now with everything you have verified.`)
	}
	throw new Error(`No ${finalTool} call after ${maxTurns} turns`)
}
