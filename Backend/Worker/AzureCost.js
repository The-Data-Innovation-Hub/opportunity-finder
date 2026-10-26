// Daily Azure hosting cost for the admin KPI card (BEH-012), from the Cost
// Management query API for the service's resource group, read with the
// worker's managed identity (Cost Management Reader on that group). The
// last 35 days are re-read each time because Azure revises recent days.
import {DefaultAzureCredential} from '@azure/identity'

const API_VERSION = '2023-11-01'

export const fetchDailyCost = async ({scope, days = 35, now = new Date(), credential = new DefaultAzureCredential(), fetchImpl = fetch}) => {
	const {token} = await credential.getToken('https://management.azure.com/.default')
	const to = now.toISOString().slice(0, 10)
	const from = new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10)
	const response = await fetchImpl(`https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`, {
		method: 'POST',
		headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
		body: JSON.stringify({type: 'ActualCost', timeframe: 'Custom', timePeriod: {from, to},
			dataset: {granularity: 'Daily', aggregation: {totalCost: {name: 'Cost', function: 'Sum'}}}}),
	})
	if (!response.ok) throw Object.assign(new Error(`Cost Management query failed (${response.status})`), {code: `COST_${response.status}`})
	const body = await response.json()
	const columns = body.properties.columns.map((c) => c.name)
	const [cost, date, currency] = ['Cost', 'UsageDate', 'Currency'].map((n) => columns.indexOf(n))
	// UsageDate comes back as a number, e.g. 20261023.
	return body.properties.rows.map((r) => ({day: String(r[date]).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), amount: Number(r[cost]), currency: r[currency]}))
}

export const collectAzureCost = async ({pool, fetchCost, log = () => {}}) => {
	const days = await fetchCost()
	for (const d of days) {
		await pool.query(`INSERT INTO azure_cost_daily (day, amount, currency) VALUES ($1, $2, $3)
			ON CONFLICT (day) DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, collected_at = now()`, [d.day, d.amount, d.currency])
	}
	log(`Azure cost: ${days.length} days stored`)
	return days.length
}
