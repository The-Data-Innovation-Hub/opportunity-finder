// Disposable test database: created fresh for one test file, migrated from
// clean, and dropped afterwards. Refuses anything but a local server, so a
// test run can never touch a shared, staging or production database.
import crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import pg from 'pg'
import {runMigrations} from '../../Database/Migrate.js'

const ADMIN_URL = process.env.OPPORTUNITY_FINDER_TEST_ADMIN_URL ?? 'postgresql:///postgres'

const assertLocal = (url) => {
	const host = new URL(url.replace(/^postgresql:\/\/\//, 'postgresql://localhost/')).hostname
	if (!['localhost', '127.0.0.1', '::1', ''].includes(host)) throw new Error(`Test databases must be local; refusing ${host}`)
}

// migrationsDir lets an upgrade test start from an earlier schema.
export const createTestDatabase = async ({migrationsDir} = {}) => {
	assertLocal(ADMIN_URL)
	const name = `of_test_${crypto.randomBytes(6).toString('hex')}`
	const admin = new pg.Client({connectionString: ADMIN_URL})
	await admin.connect()
	await admin.query(`CREATE DATABASE ${name}`)
	await admin.end()
	const url = new URL(ADMIN_URL.replace(/^postgresql:\/\/\//, 'postgresql://localhost/'))
	url.pathname = `/${name}`
	const pool = new pg.Pool({connectionString: url.toString(), max: 5})
	const client = await pool.connect()
	try {
		await runMigrations(client, migrationsDir, () => {})
	} finally {
		client.release()
	}
	// Pools that log in as the production runtime roles (Infra/database-roles.sql),
	// so the suites prove the code works within its grants. Role names carry
	// the database's suffix because roles are cluster-wide.
	const roles = []
	const rolePool = async (role) => {
		if (!roles.length) {
			const tag = name.slice('of_test_'.length)
			const password = crypto.randomBytes(12).toString('hex')
			const sql = readFileSync(new URL('../../../Infra/database-roles.sql', import.meta.url), 'utf8')
				.split('\n').filter((line) => !line.startsWith('SELECT format') && !line.startsWith('--')).join('\n')
				.replaceAll('of_api', `of_api_${tag}`).replaceAll('of_worker', `of_worker_${tag}`).replace('DATABASE opportunity_finder', `DATABASE ${name}`)
			for (const r of ['of_api', 'of_worker']) {
				await pool.query(`CREATE ROLE ${r}_${tag} LOGIN PASSWORD '${password}'`)
				roles.push(`${r}_${tag}`)
			}
			await pool.query(sql)
			roles.password = password
		}
		const roleUrl = new URL(url.toString())
		roleUrl.username = `${role}_${name.slice('of_test_'.length)}`
		roleUrl.password = roles.password
		roleUrl.hostname = 'localhost'
		const p = new pg.Pool({connectionString: roleUrl.toString(), max: 5})
		roles.pools = [...(roles.pools ?? []), p]
		return p
	}
	const drop = async () => {
		for (const p of roles.pools ?? []) await p.end()
		await pool.end()
		const again = new pg.Client({connectionString: ADMIN_URL})
		await again.connect()
		await again.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
		for (const r of roles) await again.query(`DROP ROLE IF EXISTS ${r}`)
		await again.end()
	}
	return {pool, name, url: url.toString(), drop, rolePool}
}
