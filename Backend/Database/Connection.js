import pg from 'pg'
// Copied from Parentalk Backend/Database/Connection.js (23 Oct 2026).
//
// FIND-027 (brendan-qa-analysis, raised 2026-09-10): how this deployment
// verifies the database's TLS certificate was decided by a library default
// rather than by anything in this repo, and that default is being inverted.
//
// Production's connection string carries `sslmode=require`. Under `pg` 8,
// `pg-connection-string` treats `require` (and `prefer`, and `verify-ca`) as
// an alias for `verify-full`: it yields `ssl: {}`, which Node's TLS layer
// receives with `rejectUnauthorized` defaulting to true, so the certificate
// chain and the hostname are both checked. Measured against production: an
// explicitly-supplied wrong CA is rejected with SELF_SIGNED_CERT_IN_CHAIN,
// and the same connection succeeds once verification is waived - so the
// verification is real, not nominal.
//
// From `pg` 9 / `pg-connection-string` 3, those three modes adopt libpq
// semantics: encrypt, but do not verify the certificate or the hostname. The
// same unchanged connection string then accepts any certificate an
// interceptor presents. No code change, no connection-string change, no
// failing test - and `pg_stat_ssl.ssl` stays `true`, so even a manual "is it
// encrypted?" check would still pass while verification had silently stopped.
//
// The obvious fix does not work, and this is worth recording because it looks
// like it should. Passing `ssl: {rejectUnauthorized: true}` in the Pool
// options is **discarded** whenever the connection string carries an
// `sslmode`: `new Client({connectionString: '...?sslmode=require', ssl: {...}})`
// computes `connectionParameters.ssl = {}` either way. The string wins. So the
// only lever that actually moves is the `sslmode` value itself, which is why
// this normalises the string rather than setting an option beside it.
//
// Doing it here, in code, rather than by editing the two App Service settings
// means the guarantee travels with the repo and holds in every environment,
// including ones nobody remembers to update.

// The modes `pg` currently aliases to `verify-full` and will stop aliasing.
// Rewriting each to the mode it means *today* preserves current behaviour
// exactly while making it independent of the library's version.
export const ALIASED_SSL_MODES = ['prefer', 'require', 'verify-ca']

/**
 * The connection string with an aliased `sslmode` rewritten to `verify-full`.
 *
 * Deliberately unchanged:
 * - a string with **no** `sslmode` at all - local development and CI both
 *   connect to a plaintext Postgres over loopback, and forcing TLS there
 *   would break every suite for no security gain.
 * - `disable`, `allow`, `no-verify` and an already-explicit `verify-full` -
 *   each is a deliberate choice by whoever wrote the string, and `no-verify`
 *   in particular is an explicit opt-out that this must not silently reverse.
 * - anything carrying `uselibpqcompat=true`, which is how an operator asks
 *   for libpq semantics on purpose.
 */
export const withExplicitSslMode = (connectionString) => {
	if (!connectionString) return connectionString
	// Operate only on the query portion, and find it after the credentials, so
	// a password containing '?' cannot be mistaken for the start of the query.
	let credentialsEnd = connectionString.lastIndexOf('@')
	let queryStart = connectionString.indexOf('?', credentialsEnd + 1)
	if (queryStart === -1) return connectionString

	let head = connectionString.slice(0, queryStart)
	let query = connectionString.slice(queryStart + 1)
	if (/(^|&)uselibpqcompat=true(&|$)/.test(query)) return connectionString

	let rewritten = query.replace(/(^|&)sslmode=([^&]*)/, (whole, separator, mode) =>
		ALIASED_SSL_MODES.includes(mode) ? `${separator}sslmode=verify-full` : whole,
	)
	return rewritten === query ? connectionString : `${head}?${rewritten}`
}

// DATE columns stay 'YYYY-MM-DD' strings. pg's default turns them into a
// JavaScript Date at local midnight, which in British Summer Time serialises
// as 23:00 the day before, so every week and deadline showed a day early.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value)

// One pool per process. The URL comes from configuration only and is never
// logged; an unset URL fails here rather than falling back to a default.
// statement_timeout bounds a runaway query; the worker passes a longer one.
export const createPool = ({connectionString = process.env.OPPORTUNITY_FINDER_DATABASE_URL, max = 10, statementTimeout = 30000} = {}) => {
	if (!connectionString) throw new Error('OPPORTUNITY_FINDER_DATABASE_URL is not set')
	return new pg.Pool({connectionString: withExplicitSslMode(connectionString), max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: statementTimeout})
}
