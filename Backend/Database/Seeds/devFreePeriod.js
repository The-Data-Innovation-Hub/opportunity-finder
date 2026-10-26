// Puts the local dev database into one of the free period states (DEC-011),
// to see what companies and admins are shown. Local *_dev databases only.
//
//   node --env-file=.env.example Database/Seeds/devFreePeriod.js <state>
//
//   covered   free period on, programme key working
//   no-key    free period on, no programme key: runs paused
//   budget    key working, but the trial company's latest run was skipped
//             because the monthly AI cap was reached
//   off       no free period (the fixtures' normal state)
//
// The programme key row is a stand-in: there is no real key behind it, so
// do not run the weekly job while it is set. The free period ends 23 days
// from today, inside the four-week notice, so the portal banner shows too.
import {createPool} from '../Connection.js'
import {weekStart} from '../../API/Library.js'

const url = process.env.OPPORTUNITY_FINDER_DATABASE_URL ?? ''
const parsed = new URL(url.replace(/^postgresql:\/\/\//, 'postgresql://localhost/'))
if (process.env.NODE_ENV == 'production' || !['localhost', '127.0.0.1', ''].includes(parsed.hostname) || !parsed.pathname.endsWith('_dev')) {
	console.error('[dev-free-period] refusing: only a local database named *_dev')
	process.exit(1)
}
const STATES = ['covered', 'no-key', 'budget', 'off']
const state = process.argv[2]
if (!STATES.includes(state)) {
	console.error(`[dev-free-period] choose one of: ${STATES.join(', ')}`)
	process.exit(1)
}

const pool = createPool()
const iso = (d) => d.toISOString().slice(0, 10)
const until = iso(new Date(Date.now() + 23 * 864e5))
try {
	const {rows: [trial]} = await pool.query("SELECT id FROM company WHERE name = 'Care Routing Trial Ltd'")
	if (!trial) throw new Error('No trial company: run Database/Seeds/devFixtures.js first')

	// Back to the fixtures' state, then apply the one asked for.
	await pool.query("DELETE FROM search_run WHERE skip_reason IN ('programme_key_problem', 'programme_budget_reached')")
	await pool.query('DELETE FROM weekly_gather g WHERE blob_name IS NULL AND NOT EXISTS (SELECT 1 FROM search_run r WHERE r.week_start = g.week_start)')
	await pool.query('DELETE FROM programme_llm_credential')
	await pool.query('UPDATE service_setting SET free_period_until = NULL')

	if (state != 'off') await pool.query('UPDATE service_setting SET free_period_until = $1', [until])
	if (state == 'covered' || state == 'budget') {
		await pool.query(`INSERT INTO programme_llm_credential (provider, model, secret_name, last_four)
			VALUES ('anthropic', 'claude-sonnet-5-5', 'programme-llm-anthropic', 'demo')`)
	}
	if (state == 'budget') {
		// The week after the fixtures' latest run.
		const {rows: [latest]} = await pool.query('SELECT max(week_start) AS week FROM search_run WHERE company_id = $1', [trial.id])
		const week = weekStart(new Date(Date.parse(`${latest.week}T12:00:00Z`) + 7 * 864e5))
		await pool.query("INSERT INTO weekly_gather (week_start, status, finished_at) VALUES ($1, 'succeeded', now()) ON CONFLICT DO NOTHING", [week])
		await pool.query(`INSERT INTO search_run (company_id, week_start, status, skip_reason, started_at, finished_at, paid_by)
			VALUES ($1, $2, 'skipped', 'programme_budget_reached', now(), now(), 'programme')`, [trial.id, week])
	}
	console.log(`[dev-free-period] ${state}${state == 'off' ? '' : `: free until ${until}`}. Reload the app to see it.`)
} finally {
	await pool.end()
}
