// Shared API plumbing: errors, logging, security headers, rate limits,
// transactions and boundary validation. Patterns follow Parentalk's
// ParenTalkLibrary.js, trimmed to what this API needs.
import crypto from 'node:crypto'

// One error envelope, {error: {code, message}}, with stable codes the
// frontend can branch on. A database error never reaches the client.
export class APIError extends Error {
	constructor(status, code, message) {
		super(message)
		this.status = status
		this.code = code
	}
}

export const notFound = () => new APIError(404, 'not_found', 'Not found')
export const forbidden = () => new APIError(403, 'forbidden', 'You do not have permission to do that')
export const invalid = (message) => new APIError(400, 'invalid_request', message)

export const logLine = (fields) => {
	console.log(JSON.stringify({at: new Date().toISOString(), ...fields}))
}

export const accessLog = (request, response, next) => {
	const started = process.hrtime.bigint()
	request.id = crypto.randomBytes(4).toString('hex')
	response.setHeader('X-Request-Id', request.id)
	response.on('finish', () => {
		// The pathname only: a query string or body can carry an email address.
		logLine({event: 'request', id: request.id, method: request.method, path: request.path,
			status: response.statusCode, ms: Number((process.hrtime.bigint() - started) / 1_000_000n)})
	})
	next()
}

export const securityHeaders = (request, response, next) => {
	response.setHeader('X-Content-Type-Options', 'nosniff')
	response.setHeader('X-Frame-Options', 'DENY')
	response.setHeader('Referrer-Policy', 'no-referrer')
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
	if (request.secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
	next()
}

const PG_ERRORS = {
	'23505': [409, 'conflict', 'A record with these details already exists'],
	'23503': [409, 'conflict', 'A referenced record does not exist'],
	'23514': [400, 'invalid_request', 'A field has an invalid value'],
	'23502': [400, 'invalid_request', 'A required field is missing'],
	'22P02': [400, 'invalid_request', 'A field has an invalid value'],
	'22007': [400, 'invalid_request', 'A date is not valid'],
	'22008': [400, 'invalid_request', 'A date is not valid'],
	'40001': [409, 'retry', 'The request conflicted with a concurrent change; please retry'],
}

// The four-argument signature is how Express recognises error middleware.
export const errorHandler = (error, request, response, next) => {
	let [status, code, message] = [500, 'internal', 'An unexpected error occurred']
	if (error instanceof APIError) [status, code, message] = [error.status, error.code, error.message]
	else if (PG_ERRORS[error.code]) [status, code, message] = PG_ERRORS[error.code]
	else if (error.type == 'entity.too.large') [status, code, message] = [413, 'too_large', 'The request body is too large']
	else if (error.status && error.status < 500) [status, code, message] = [error.status, 'invalid_request', 'The request could not be read']
	// Which constraint and table, never the offending value (pg's `detail`).
	// A body-parser message quotes the request body (which can hold a key or
	// an address), so only its type is logged.
	const detail = error instanceof APIError ? {} : error.type ? {type: error.type}
		: {message: error.message, pg_code: error.code, constraint: error.constraint, table: error.table}
	logLine({event: 'error', id: request.id, path: request.path, status, code, ...detail})
	if (response.headersSent) return
	response.status(status).json({error: {code, message}})
}

// Fixed-window counter per key. State is per process; with more than one
// replica each holds its own allowance, which the architecture accepts for
// the small number of programme companies.
export const createRateLimiter = ({windowSeconds, max, now = Date.now}) => {
	const windows = new Map()
	return (key) => {
		const t = now()
		let w = windows.get(key)
		if (!w || t >= w.resetAt) {
			w = {count: 0, resetAt: t + windowSeconds * 1000}
			windows.set(key, w)
		}
		w.count += 1
		if (windows.size > 10000) for (const [k, v] of windows) if (t >= v.resetAt) windows.delete(k)
		return {allowed: w.count <= max, retryAfter: Math.ceil((w.resetAt - t) / 1000)}
	}
}

export const rateLimit = (limiter, keyOf = (request) => request.ip) => (request, response, next) => {
	const {allowed, retryAfter} = limiter(keyOf(request))
	if (allowed) return next()
	response.setHeader('Retry-After', String(retryAfter))
	next(new APIError(429, 'rate_limited', 'Too many requests; please try again later'))
}

// Runs fn inside one transaction on one pooled client, released in finally.
// A rollback failure is logged but the original error is the one thrown.
export const withTransaction = async (pool, fn) => {
	const client = await pool.connect()
	try {
		await client.query('BEGIN')
		const result = await fn(client)
		await client.query('COMMIT')
		return result
	} catch (error) {
		try {
			await client.query('ROLLBACK')
		} catch (rollbackError) {
			logLine({event: 'rollback_failed', message: rollbackError.message})
		}
		throw error
	} finally {
		client.release()
	}
}

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest()
export const randomToken = () => crypto.randomBytes(32).toString('base64url')

// Boundary validation. Each returns the cleaned value or throws a 400 naming
// the field, never echoing what was sent.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const uuidParam = (value) => {
	// A malformed id is indistinguishable from someone else's: both are 404.
	if (typeof value != 'string' || !UUID.test(value)) throw notFound()
	return value.toLowerCase()
}

export const text = (value, field, {min = 1, max = 200, optional = false} = {}) => {
	if (value == null && optional) return null
	if (typeof value != 'string') throw invalid(`${field} must be text`)
	const v = value.trim()
	if (v.length < min || v.length > max) throw invalid(`${field} must be between ${min} and ${max} characters`)
	return v
}

export const email = (value, field = 'email') => {
	const v = text(value, field, {min: 3, max: 320}).toLowerCase()
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw invalid(`${field} must be an email address`)
	return v
}

export const textList = (value, field, {maxItems = 50, maxLength = 100, allowed} = {}) => {
	if (value == null) return []
	if (!Array.isArray(value) || value.length > maxItems) throw invalid(`${field} must be a list of at most ${maxItems} items`)
	const items = value.map((item) => text(item, field, {max: maxLength}))
	if (allowed && items.some((item) => !allowed.includes(item))) throw invalid(`${field} may only contain ${allowed.join(', ')}`)
	return [...new Set(items)]
}

export const oneOf = (value, field, allowed) => {
	if (!allowed.includes(value)) throw invalid(`${field} must be one of ${allowed.join(', ')}`)
	return value
}

// Date.parse accepts 2026-02-30 (it rolls over to 2 March), so the date is
// round-tripped to check it is a real calendar day.
export const isCalendarDate = (value) => typeof value == 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
	&& !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) == value

export const isoDate = (value, field) => {
	if (!isCalendarDate(value)) throw invalid(`${field} must be a date (YYYY-MM-DD)`)
	return value
}

export const pageSize = (value, {fallback = 20, max = 100} = {}) => {
	if (value == null) return fallback
	const n = Number(value)
	if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`limit must be a whole number from 1 to ${max}`)
	return n
}

// The Monday (UK date) of the week a moment falls in, as YYYY-MM-DD. Weekly
// runs, reports and the cost card all count weeks from Monday in London.
export const weekStart = (at = new Date()) => {
	const london = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'}).format(at)
	const day = new Date(`${london}T00:00:00Z`)
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
	return day.toISOString().slice(0, 10)
}

export const audit = (client, {companyId = null, actorUserId = null, action, detail = {}}) =>
	client.query('INSERT INTO audit_event (company_id, actor_user_id, action, detail) VALUES ($1, $2, $3, $4)',
		[companyId, actorUserId, action, detail])
