// Schema invariants on a clean, freshly migrated local database.
import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {copyFileSync, mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runMigrations, MIGRATIONS_DIR} from '../../Database/Migrate.js'

let db
before(async () => { db = await createTestDatabase() })
after(async () => { await db?.drop() })

const q = (sql, params) => db.pool.query(sql, params)
const rejects = (promise, pattern) => assert.rejects(promise, (error) => pattern.test(error.constraint ?? error.message))

const company = async (name) => (await q('INSERT INTO company (name) VALUES ($1) RETURNING id', [name])).rows[0].id
const monday = '2026-10-26'
const gather = () => q("INSERT INTO weekly_gather (week_start, status) VALUES ($1, 'succeeded') ON CONFLICT DO NOTHING", [monday])
const profile = async (companyId, version = 1) => (await q(
	"INSERT INTO company_profile (company_id, version, product_description) VALUES ($1, $2, 'Software that plans domiciliary care visits.') RETURNING id",
	[companyId, version])).rows[0].id
const run = async (companyId, profileId) => (await q('INSERT INTO search_run (company_id, week_start, profile_id) VALUES ($1, $2, $3) RETURNING id',
	[companyId, monday, profileId])).rows[0].id

test('STR-001 migrations apply from clean and re-running applies nothing', async () => {
	const client = await db.pool.connect()
	try {
		assert.deepEqual(await runMigrations(client, undefined, () => {}), [])
	} finally {
		client.release()
	}
	assert.equal((await q("SELECT count(*)::int AS n FROM service_setting")).rows[0].n, 1)
})

test('SEC-001 a run cannot use another company\'s profile, nor a report another company\'s run', async () => {
	await gather()
	const a = await company('Tenant A'), b = await company('Tenant B')
	const profileA = await profile(a)
	await rejects(run(b, profileA), /fk_search_run_profile/)
	const runA = await run(a, profileA)
	await rejects(q(`INSERT INTO report (company_id, search_run_id, week_start, blob_name, funding_rows, tender_rows, new_this_week, top_five, also_checked, sources, note)
		VALUES ($1, $2, $3, 'x', 0, 0, 0, '[]', '[]', '[]', '')`, [b, runA, monday]), /fk_report_run/)
})

test('BEH-003 one run per company per week; week starts on a Monday', async () => {
	const c = await company('Tenant C')
	const p = await profile(c)
	await run(c, p)
	await rejects(run(c, p), /uq_search_run_week/)
	await rejects(q("INSERT INTO weekly_gather (week_start) VALUES ('2026-10-25')"), /ck_weekly_gather_monday/)
})

test('BEH-008 regions are NI, IE, UK only, default all three', async () => {
	const c = await company('Tenant D')
	const id = await profile(c)
	assert.deepEqual((await q('SELECT regions FROM company_profile WHERE id = $1', [id])).rows[0].regions, ['NI', 'IE', 'UK'])
	await rejects(q("INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, 2, 'Software that plans domiciliary care visits.', ARRAY['FR'])", [c]), /ck_company_profile_regions/)
	await rejects(q("INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, 3, 'Software that plans domiciliary care visits.', ARRAY[]::text[])", [c]), /ck_company_profile_regions/)
})

test('DEC-013 regions must be one of the three scopes, each including NI, in canonical order', async () => {
	const c = await company('Tenant D2')
	let version = 1
	const insert = (regions) => q('INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, $2, \'Software that plans domiciliary care visits.\', $3)', [c, version++, regions])
	for (const regions of [['NI', 'IE', 'UK'], ['NI', 'UK'], ['NI', 'IE']]) await insert(regions)
	for (const regions of [['NI'], ['IE'], ['UK'], ['IE', 'UK'], ['UK', 'NI'], ['NI', 'NI']]) await rejects(insert(regions), /ck_company_profile_regions/)
})

test('DEC-013 upgrading maps profiles saved earlier to the smallest scope that covers them', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'of-migrations-'))
	for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0004')) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file))
	const old = await createTestDatabase({migrationsDir: dir})
	try {
		const {rows: [{id: c}]} = await old.pool.query("INSERT INTO company (name) VALUES ('Upgrade Ltd') RETURNING id")
		const before = [['NI'], ['IE'], ['UK'], ['IE', 'UK'], ['UK', 'NI'], ['NI', 'IE', 'UK'], ['UK', 'IE', 'NI']]
		for (const [i, regions] of before.entries()) {
			await old.pool.query("INSERT INTO company_profile (company_id, version, product_description, regions) VALUES ($1, $2, 'Software that plans domiciliary care visits.', $3)", [c, i + 1, regions])
		}
		const client = await old.pool.connect()
		try { await runMigrations(client, MIGRATIONS_DIR, () => {}) } finally { client.release() }
		const {rows} = await old.pool.query('SELECT regions FROM company_profile WHERE company_id = $1 ORDER BY version', [c])
		assert.deepEqual(rows.map((r) => r.regions), [['NI', 'IE'], ['NI', 'IE'], ['NI', 'UK'], ['NI', 'IE', 'UK'], ['NI', 'UK'], ['NI', 'IE', 'UK'], ['NI', 'IE', 'UK']])
	} finally {
		await old.drop()
		rmSync(dir, {recursive: true})
	}
})

test('SEC-002 a key row needs an approved model and holds only the last four characters', async () => {
	const c = await company('Tenant E')
	await rejects(q("INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four) VALUES ($1, 'anthropic', 'unknown-model', 's', 'abcd')", [c]), /fk_company_llm_credential_model/)
	await q("INSERT INTO approved_model (provider, model, label) VALUES ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5')")
	await rejects(q("INSERT INTO company_llm_credential (company_id, provider, model, secret_name, last_four) VALUES ($1, 'anthropic', 'claude-sonnet-5-5', 's', 'sk-ant-full-key')", [c]), /ck_company_llm_credential_last_four/)
})

test('DAT-001 emails are stored lower-case and unique', async () => {
	await q("INSERT INTO app_user (email) VALUES ('founder@example.com')")
	await rejects(q("INSERT INTO app_user (email) VALUES ('Founder@Example.com')"), /ck_app_user_email/)
	await rejects(q("INSERT INTO app_user (email) VALUES ('founder@example.com')"), /uq_app_user_email/)
})
