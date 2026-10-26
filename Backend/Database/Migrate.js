// Migration runner, adapted from Parentalk's (Backend/Database/Migrate.js).
//
// Applies every pending Migrations/<number>_<Name>.sql in numeric order, each
// in its own transaction, and records it in schema_migration with a hash of
// the file, so an edited migration is refused rather than silently diverging.
// Run as its own deployment step, never by the API on startup.
//
//   node --env-file=.env Database/Migrate.js            # apply all pending
//   node --env-file=.env Database/Migrate.js --status   # list applied and pending
import {createHash} from 'node:crypto'
import {readdirSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import {withExplicitSslMode} from './Connection.js'

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'Migrations')
const MIGRATION_FILE = /^(\d+)_.+\.sql$/
// Identity of the advisory lock that keeps two runners from racing; never change it.
const MIGRATION_LOCK_ID = 7340211958

export const contentHash = (sql) => createHash('sha256').update(sql).digest('hex')

export const discoverMigrations = (dir = MIGRATIONS_DIR) => {
	const migrations = readdirSync(dir)
		.filter((name) => MIGRATION_FILE.test(name))
		.sort((a, b) => a.localeCompare(b, 'en', {numeric: true}))
		.map((name) => ({id: String(Number(name.match(MIGRATION_FILE)[1])), name, path: join(dir, name)}))
	const seen = new Map()
	for (const m of migrations) seen.set(m.id, [...(seen.get(m.id) ?? []), m.name])
	const clashes = [...seen].filter(([, names]) => names.length > 1)
	if (clashes.length) throw new Error(`[migrate] duplicate migration number: ${clashes.map(([id, names]) => `${id} (${names.join(', ')})`).join('; ')}`)
	return migrations
}

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migration (
	migration_id TEXT NOT NULL,
	name TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_schema_migration PRIMARY KEY (migration_id)
)`

const applied = async (client) => new Map((await client.query('SELECT migration_id, name, content_hash FROM schema_migration')).rows
	.map((row) => [row.migration_id, row]))

export const runMigrations = async (client, dir = MIGRATIONS_DIR, log = console.log) => {
	const available = discoverMigrations(dir).map((m) => {
		const sql = readFileSync(m.path, 'utf8')
		return {...m, sql, hash: contentHash(sql)}
	})
	await client.query(BOOTSTRAP)
	await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
	try {
		const done = await applied(client)
		const edited = available.filter((m) => done.has(m.id) && done.get(m.id).content_hash != m.hash)
		if (edited.length) throw new Error(`[migrate] applied migrations have been edited: ${edited.map((m) => m.name).join(', ')}. Add a new migration instead.`)
		const pending = available.filter((m) => !done.has(m.id))
		for (const m of pending) {
			try {
				await client.query('BEGIN')
				await client.query(m.sql)
				await client.query('INSERT INTO schema_migration (migration_id, name, content_hash) VALUES ($1, $2, $3)', [m.id, m.name, m.hash])
				await client.query('COMMIT')
				log(`[migrate] applied ${m.name}`)
			} catch (error) {
				await client.query('ROLLBACK').catch(() => {})
				throw new Error(`[migrate] failed on ${m.name}: ${error.message}`)
			}
		}
		return pending
	} finally {
		await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
	}
}

const main = async () => {
	const url = process.env.OPPORTUNITY_FINDER_DATABASE_URL
	if (!url) throw new Error('[migrate] OPPORTUNITY_FINDER_DATABASE_URL is not set')
	const pool = new pg.Pool({connectionString: withExplicitSslMode(url), max: 1})
	const client = await pool.connect()
	try {
		if (process.argv.includes('--status')) {
			await client.query(BOOTSTRAP)
			const done = await applied(client)
			for (const m of discoverMigrations()) console.log(`${done.has(m.id) ? 'applied' : 'pending'}  ${m.name}`)
		} else {
			const ran = await runMigrations(client)
			console.log(ran.length ? `[migrate] ${ran.length} migration(s) applied` : '[migrate] already up to date')
		}
	} finally {
		client.release()
		await pool.end()
	}
}

if (process.argv[1] == fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message)
		process.exit(1)
	})
}
