// The model providers a company can choose (DEC-007). OpenAI and Google join
// once their adapters pass the DEC-009 benchmark; until then only approved
// models from implemented providers can be saved.
import * as anthropic from './anthropic.js'

export const PROVIDERS = {anthropic}

export const providerFor = (name) => {
	const p = PROVIDERS[name]
	if (!p) throw Object.assign(new Error(`Provider ${name} is not available yet`), {code: 'provider_unavailable'})
	return p
}
