import {test, before, after} from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './harness.js'
import {seedApprovedModels, APPROVED_MODELS} from '../../Database/Seeds/approvedModels.js'

let db
before(async () => { db = await createTestDatabase() })
after(async () => { await db?.drop() })

test('DEC-009 approved-model seed is idempotent', async () => {
	await seedApprovedModels(db.pool)
	await seedApprovedModels(db.pool)
	const {rows} = await db.pool.query('SELECT provider, model, benchmark_coverage FROM approved_model')
	assert.equal(rows.length, APPROVED_MODELS.length)
	assert.deepEqual(rows[0], {provider: 'anthropic', model: 'claude-sonnet-5-5', benchmark_coverage: 28})
})
