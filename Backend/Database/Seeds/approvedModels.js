// Baseline reference data: the models a company may choose. Idempotent, so
// it is safe to run after every deploy. Coverage is the number of Anthony's
// 36 reference rows the model found in the benchmark run (DEC-009); cost is
// the US$ model cost of that run for one company.
import {createPool} from '../Connection.js'

export const APPROVED_MODELS = [
	{provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', benchmark_coverage: 28, benchmark_cost_usd: 3.97, approved_at: '2026-10-23'},
]

export const seedApprovedModels = async (client, models = APPROVED_MODELS) => {
	for (const m of models) {
		await client.query(`INSERT INTO approved_model (provider, model, label, benchmark_coverage, benchmark_cost_usd, approved_at)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (provider, model) DO UPDATE SET label = EXCLUDED.label,
				benchmark_coverage = EXCLUDED.benchmark_coverage, benchmark_cost_usd = EXCLUDED.benchmark_cost_usd,
				approved_at = EXCLUDED.approved_at`,
			[m.provider, m.model, m.label, m.benchmark_coverage, m.benchmark_cost_usd, m.approved_at])
	}
	return models.length
}

if (import.meta.url == `file://${process.argv[1]}`) {
	const pool = createPool()
	try {
		const n = await seedApprovedModels(pool)
		console.log(`Approved models seeded: ${n}`)
	} finally {
		await pool.end()
	}
}
