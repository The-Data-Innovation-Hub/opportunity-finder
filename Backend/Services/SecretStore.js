// Company LLM keys (SEC-002). In Azure the key goes to Key Vault through the
// managed identity and nowhere else: the database keeps the secret's name and
// the last four characters. The memory store exists for local development and
// tests only and refuses to start in production.
import {DefaultAzureCredential} from '@azure/identity'
import {SecretClient} from '@azure/keyvault-secrets'

export const secretNameFor = (companyId) => `company-llm-${companyId}`

// The API's role on the keys vault can set, delete and recover secrets but
// not read them (Infra/grant-roles.sh), so nothing here waits on a poller
// that would need read access.
export const createKeyVaultStore = ({vaultUrl, credential = new DefaultAzureCredential(), client, retryDelayMs = 2000} = {}) => {
	const kv = client ?? new SecretClient(vaultUrl, credential)
	const set = async (name, value) => {
		for (let attempt = 1; ; attempt++) {
			try {
				await kv.setSecret(name, value, {contentType: 'llm-api-key'})
				return
			} catch (error) {
				// 409: the name was deleted (soft delete, purge protection), or is
				// still being deleted or recovered. Recover it once, then retry
				// the write, which replaces the recovered value.
				if (error.statusCode != 409 || attempt >= 10) throw error
				if (attempt == 1) await kv.beginRecoverDeletedSecret(name).catch((e) => { if (e.statusCode != 409) throw e })
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
			}
		}
	}
	return {
		kind: 'key-vault',
		set,
		get: async (name) => (await kv.getSecret(name)).value,
		// Soft delete keeps the secret recoverable for the vault's retention
		// period; nothing here purges it.
		remove: async (name) => {
			try {
				await kv.beginDeleteSecret(name)
			} catch (error) {
				if (error.statusCode != 404) throw error
			}
		},
	}
}

export const createMemoryStore = ({environment = process.env.NODE_ENV} = {}) => {
	if (environment == 'production') throw new Error('The in-memory secret store cannot be used in production')
	const secrets = new Map()
	return {
		kind: 'memory',
		set: async (name, value) => { secrets.set(name, value) },
		get: async (name) => {
			if (!secrets.has(name)) throw Object.assign(new Error('Secret not found'), {statusCode: 404})
			return secrets.get(name)
		},
		remove: async (name) => { secrets.delete(name) },
	}
}

export const createSecretStore = (env = process.env) =>
	env.KEY_VAULT_URL ? createKeyVaultStore({vaultUrl: env.KEY_VAULT_URL}) : createMemoryStore({environment: env.NODE_ENV})
