// Container Apps job entry point. One command per scheduled job:
//
//   node Worker/Job.js weekly       Sunday 22:00 UK: gather, then every company's run
//   node Worker/Job.js emails       Monday 07:00 UK: the weekly report email
//   node Worker/Job.js first-reports every 15 min: a new company's first report, then its email
//   node Worker/Job.js cleanup      daily: 13-week retention, expired tokens and sessions
//   node Worker/Job.js azure-cost   daily: hosting cost for the admin card
//
// Exit code is non-zero on failure so the job's run shows as failed.
import {createPool} from '../Database/Connection.js'
import {createBlobStore} from '../Services/BlobStore.js'
import {createSecretStore} from '../Services/SecretStore.js'
import {createMailer, weeklyReportEmail} from '../Services/Mail.js'
import {fetchTenderNotices} from './Sources/ocds.js'
import {fetchEtendersIreland, fetchFindAGrant} from './Sources/scraper.js'
import {gatherFunderPages} from './Sources/pages.js'
import {REGIONS} from './Research/search.js'
import {runWeek, runFirstReports, sendWeeklyEmails, cleanup, targetWeek} from './Weekly.js'
import {collectAzureCost, fetchDailyCost} from './AzureCost.js'
import {logLine} from '../API/Library.js'

const command = process.argv[2]
const commands = ['weekly', 'first-reports', 'emails', 'cleanup', 'azure-cost']
if (!commands.includes(command)) {
	console.error(`[job] usage: node Worker/Job.js ${commands.join('|')}`)
	process.exit(2)
}

const log = (message) => logLine({event: 'job', command, message})
const pool = createPool({connectionString: process.env.OPPORTUNITY_FINDER_WORKER_DATABASE_URL ?? process.env.OPPORTUNITY_FINDER_DATABASE_URL, max: 8, statementTimeout: 120000})

try {
	const fetchers = {
		tenders: fetchTenderNotices,
		ieTenders: fetchEtendersIreland,
		grants: fetchFindAGrant,
		funderPages: ({log}) => gatherFunderPages({regions: REGIONS, log}),
	}
	if (command == 'weekly') {
		const {week, outcomes} = await runWeek({pool, secrets: createSecretStore(), blobs: createBlobStore(), fetchers, log})
		const counts = Object.values(outcomes).reduce((c, o) => ({...c, [o.status]: (c[o.status] ?? 0) + 1}), {})
		log(`week ${week}: ${JSON.stringify(counts)}`)
		if (counts.failed) process.exitCode = 1
	} else if (command == 'first-reports') {
		const {outcomes} = await runFirstReports({pool, secrets: createSecretStore(), blobs: createBlobStore(), fetchers,
			mailer: createMailer(), appUrl: process.env.APP_URL, emailFor: weeklyReportEmail, log})
		if (Object.values(outcomes).some((o) => o.status == 'failed')) process.exitCode = 1
	} else if (command == 'emails') {
		// The Monday job sends the week that started today.
		const week = targetWeek(new Date(Date.now() - 864e5))
		await sendWeeklyEmails({pool, mailer: createMailer(), appUrl: process.env.APP_URL, week, emailFor: weeklyReportEmail, log})
	} else if (command == 'cleanup') {
		await cleanup({pool, blobs: createBlobStore(), log})
	} else if (command == 'azure-cost') {
		if (!process.env.AZURE_COST_SCOPE) throw new Error('AZURE_COST_SCOPE is not set')
		await collectAzureCost({pool, fetchCost: () => fetchDailyCost({scope: process.env.AZURE_COST_SCOPE}), log})
	}
} catch (error) {
	logLine({event: 'job_failed', command, message: error.message?.slice(0, 300)})
	process.exitCode = 1
} finally {
	await pool.end()
}
