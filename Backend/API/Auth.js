// Magic-link sign-in (DEC-001) and sessions. No passwords are stored. A link
// is a random token, stored only as a SHA-256 hash, that works once; signing
// in swaps it for a session token in an HttpOnly cookie, also stored hashed.
import express from 'express'
import {APIError, audit, createRateLimiter, email, rateLimit, randomToken, sha256, text, withTransaction, logLine} from './Library.js'
import {signInEmail} from '../Services/Mail.js'

export const SESSION_COOKIE = 'of_session'
export const SIGN_IN_MINUTES = 15
export const INVITATION_DAYS = 7
export const SESSION_DAYS = 14

const cookieOf = (request) => {
	const header = request.headers.cookie ?? ''
	for (const part of header.split(';')) {
		const [name, ...rest] = part.trim().split('=')
		if (name == SESSION_COOKIE) return rest.join('=')
	}
	return null
}

const setSessionCookie = (response, token, {secure}) => {
	response.cookie(SESSION_COOKIE, token, {httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400_000})
}

// Loads the caller from the session cookie. Every route after this sees
// request.user or nothing; nothing trusts an id sent by the client.
export const loadSession = (pool) => async (request, response, next) => {
	const token = cookieOf(request)
	if (!token) return next()
	const {rows} = await pool.query(`SELECT s.id AS session_id, u.id, u.email, u.display_name,
			EXISTS (SELECT 1 FROM programme_admin pa WHERE pa.user_id = u.id) AS is_programme_admin
		FROM user_session s JOIN app_user u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`, [sha256(token)])
	if (rows[0]) request.user = rows[0]
	next()
}

export const requireUser = (request, response, next) => {
	if (!request.user) return next(new APIError(401, 'unauthenticated', 'Please sign in'))
	next()
}

// Cookie sessions need a CSRF control: a state-changing request must come
// from the app's own origin. SameSite=Lax covers most of it; this covers the
// rest (older browsers, same-site subdomains).
export const requireSameOrigin = (allowedOrigins) => (request, response, next) => {
	if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
	const origin = request.headers.origin
	if (!origin || !allowedOrigins.includes(origin)) return next(new APIError(403, 'bad_origin', 'Request origin not allowed'))
	next()
}

export const issueLinkToken = async (client, userId, purpose) => {
	const token = randomToken()
	const interval = purpose == 'invitation' ? `${INVITATION_DAYS} days` : `${SIGN_IN_MINUTES} minutes`
	await client.query(`INSERT INTO sign_in_token (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`,
		[userId, sha256(token), purpose, interval])
	return token
}

// The token goes in the URL fragment, which browsers never send to a server,
// so it cannot reach access logs or a Referer header.
export const linkFor = (appUrl, token) => `${appUrl}/sign-in#token=${token}`

export const authRoutes = ({pool, mailer, appUrl, secureCookies, limits = {}}) => {
	const router = express.Router()
	const perIp = createRateLimiter({windowSeconds: 900, max: limits.perIp ?? 20})
	const perEmail = createRateLimiter({windowSeconds: 3600, max: limits.perEmail ?? 5})

	// Always 202 with the same body, whether or not the address has an
	// account, so the endpoint cannot be used to find out who is a customer.
	router.post('/auth/request-link', rateLimit(perIp), async (request, response) => {
		const address = email(request.body?.email)
		if (!perEmail(address).allowed) return response.status(202).json({sent: true})
		const {rows} = await pool.query(`SELECT u.id FROM app_user u WHERE u.email = $1 AND u.disabled_at IS NULL
			AND (EXISTS (SELECT 1 FROM programme_admin WHERE user_id = u.id) OR EXISTS (SELECT 1 FROM company_membership WHERE user_id = u.id))`, [address])
		const token = rows[0] ? await issueLinkToken(pool, rows[0].id, 'sign_in') : null
		response.status(202).json({sent: true})
		// Sent after the response: waiting on the mail service only for real
		// accounts would let response time reveal who has one.
		if (token) mailer.send({to: address, ...signInEmail({link: linkFor(appUrl, token), minutes: SIGN_IN_MINUTES})})
			.catch((error) => logLine({event: 'sign_in_mail_failed', code: error.code}))
	})

	router.post('/auth/verify', rateLimit(perIp), async (request, response) => {
		const token = text(request.body?.token, 'token', {min: 20, max: 100})
		const session = randomToken()
		const user = await withTransaction(pool, async (client) => {
			// Marked used in the same statement that reads it, so two requests
			// racing with the same link cannot both sign in.
			const {rows} = await client.query(`UPDATE sign_in_token SET used_at = now()
				WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
					AND user_id IN (SELECT id FROM app_user WHERE disabled_at IS NULL)
				RETURNING user_id, purpose`, [sha256(token)])
			if (!rows[0]) return null
			await client.query(`INSERT INTO user_session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + $3::interval)`,
				[rows[0].user_id, sha256(session), `${SESSION_DAYS} days`])
			await audit(client, {actorUserId: rows[0].user_id, action: rows[0].purpose == 'invitation' ? 'auth.invitation_accepted' : 'auth.signed_in'})
			return rows[0]
		})
		if (!user) throw new APIError(400, 'link_invalid', 'This sign-in link has expired or has already been used. Ask for a new one.')
		setSessionCookie(response, session, {secure: secureCookies})
		response.json({signedIn: true})
	})

	router.post('/auth/sign-out', async (request, response) => {
		if (request.user) await pool.query('UPDATE user_session SET revoked_at = now() WHERE id = $1', [request.user.session_id])
		response.clearCookie(SESSION_COOKIE, {path: '/'})
		response.json({signedOut: true})
	})

	return router
}
