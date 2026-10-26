// The provider-neutral research loop (BEH-011). A provider conversation
// (Providers/*.js) sends the request and reports the tool calls; this loop
// runs them with the worker's own tools and stops when the model calls the
// final tool (submit_report or select_top_five). validate(input) may return
// a message to send the result back for completion, up to MAX_RETURNS times.
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

export const research = async ({conversation, runTool, finalTool, validate = () => null, label = '', log = () => {}, maxTurns = MAX_TURNS}) => {
	let nudged = false
	let returns = 0
	for (let turn = 1; turn <= maxTurns; turn++) {
		const {calls, stopReason} = await conversation.send()
		const final = calls.find((c) => c.name == finalTool)
		if (final) {
			const input = decodeUnicodeEscapes(final.input)
			const problem = returns < MAX_RETURNS ? validate(input) : null
			if (!problem) return input
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
