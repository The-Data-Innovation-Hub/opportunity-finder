// Private report and gather storage. Downloads are short-lived, read-only
// user-delegation SAS links for one blob, issued only after the API has
// checked membership (SEC-001); the container is never public.
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, normalize} from 'node:path'
import {DefaultAzureCredential} from '@azure/identity'
import {BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters} from '@azure/storage-blob'

export const DOWNLOAD_LINK_MINUTES = 5

export const createAzureBlobStore = ({accountUrl, container, credential = new DefaultAzureCredential()}) => {
	const service = new BlobServiceClient(accountUrl, credential)
	const containerClient = service.getContainerClient(container)
	return {
		kind: 'azure-blob',
		put: async (name, body, contentType) => {
			await containerClient.getBlockBlobClient(name).uploadData(body, {blobHTTPHeaders: {blobContentType: contentType}})
		},
		get: async (name) => containerClient.getBlobClient(name).downloadToBuffer(),
		getIfExists: async (name) => {
			try { return await containerClient.getBlobClient(name).downloadToBuffer() } catch (error) { if (error.statusCode == 404) return null; throw error }
		},
		remove: async (name) => { await containerClient.getBlobClient(name).deleteIfExists() },
		downloadUrl: async (name, fileName, minutes = DOWNLOAD_LINK_MINUTES) => {
			const startsOn = new Date(Date.now() - 60_000)
			const expiresOn = new Date(Date.now() + minutes * 60_000)
			const key = await service.getUserDelegationKey(startsOn, expiresOn)
			const sas = generateBlobSASQueryParameters({
				containerName: container, blobName: name, permissions: BlobSASPermissions.parse('r'),
				startsOn, expiresOn, protocol: 'https',
				contentDisposition: `attachment; filename="${fileName.replace(/[^\w.\- ]/g, '_')}"`,
			}, key, service.accountName).toString()
			return {url: `${containerClient.getBlobClient(name).url}?${sas}`, expiresAt: expiresOn.toISOString()}
		},
	}
}

// Local development: files under a directory, links that only the dev server
// serves. Refuses production.
export const createLocalBlobStore = ({root, baseUrl = 'http://localhost:3001/dev-blobs', environment = process.env.NODE_ENV}) => {
	if (environment == 'production') throw new Error('The local blob store cannot be used in production')
	const pathOf = (name) => {
		const p = normalize(join(root, name))
		if (!p.startsWith(normalize(root))) throw new Error('Blob name escapes the store')
		return p
	}
	return {
		kind: 'local',
		put: async (name, body) => { await mkdir(dirname(pathOf(name)), {recursive: true}); await writeFile(pathOf(name), body) },
		get: async (name) => readFile(pathOf(name)),
		getIfExists: async (name) => {
			try { return await readFile(pathOf(name)) } catch (error) { if (error.code == 'ENOENT') return null; throw error }
		},
		remove: async () => {},
		downloadUrl: async (name, fileName, minutes = DOWNLOAD_LINK_MINUTES) =>
			({url: `${baseUrl}/${encodeURIComponent(name)}`, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString()}),
	}
}

export const createBlobStore = (env = process.env) => env.BLOB_ACCOUNT_URL
	? createAzureBlobStore({accountUrl: env.BLOB_ACCOUNT_URL, container: env.BLOB_CONTAINER ?? 'reports'})
	: createLocalBlobStore({root: env.LOCAL_BLOB_DIR ?? 'Output/dev-blobs', environment: env.NODE_ENV})
