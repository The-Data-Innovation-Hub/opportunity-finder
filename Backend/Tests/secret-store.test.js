import test from 'node:test'
import assert from 'node:assert/strict'
import {createKeyVaultStore} from '../Services/SecretStore.js'

test('SEC-002 a key removed earlier can be saved again (soft-deleted name is recovered)', async () => {
	const calls = []
	let deleted = true
	const client = {
		setSecret: async (name, value) => {
			calls.push(`set:${value}`)
			if (deleted) throw Object.assign(new Error('Conflict'), {statusCode: 409})
		},
		beginRecoverDeletedSecret: async (name) => { calls.push('recover'); deleted = false },
	}
	const store = createKeyVaultStore({client, retryDelayMs: 1})
	await store.set('company-llm-x', 'new-key')
	assert.deepEqual(calls, ['set:new-key', 'recover', 'set:new-key'])
})

test('SEC-002 other Key Vault errors are not retried', async () => {
	const client = {setSecret: async () => { throw Object.assign(new Error('Forbidden'), {statusCode: 403}) }}
	await assert.rejects(createKeyVaultStore({client, retryDelayMs: 1}).set('n', 'v'), /Forbidden/)
})
