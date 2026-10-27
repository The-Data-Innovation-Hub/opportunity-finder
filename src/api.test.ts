import {expect, test, vi} from 'vitest'
import {api, ApiError, daysUntil, safeHref} from './api'

const replyWith = (response: Response) => {
	const fetch = vi.fn(async () => response)
	vi.stubGlobal('fetch', fetch)
	return fetch
}

test('only http and https URLs become links', () => {
	expect(safeHref('https://example.org/fund')).toBe('https://example.org/fund')
	expect(safeHref('http://example.org')).toBe('http://example.org/')
	for (const value of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.org', 'not a url', '', null, undefined]) {
		expect(safeHref(value)).toBeNull()
	}
})

test('daysUntil counts calendar days: 0 on the day itself, 1 the day before', () => {
	vi.useFakeTimers({toFake: ['Date']})
	vi.setSystemTime(new Date('2026-10-26T15:00:00Z'))
	// Math.ceil gives -0 on the day; -0 === 0, which is how the pages compare it.
	expect(daysUntil('2026-10-26') === 0).toBe(true)
	expect(daysUntil('2026-10-27')).toBe(1)
	expect(daysUntil('2026-11-04T00:00:00Z')).toBe(9)
	expect(daysUntil('2026-10-25')).toBe(-1)
})

test('requests go to /api with the session cookie and a JSON body', async () => {
	const fetch = replyWith(new Response(JSON.stringify({ok: true}), {status: 200}))
	await expect(api.put('/companies/c1/profile', {a: 1})).resolves.toEqual({ok: true})
	expect(fetch).toHaveBeenCalledWith('/api/companies/c1/profile', {
		method: 'PUT', credentials: 'same-origin', headers: {'content-type': 'application/json'}, body: '{"a":1}',
	})
})

test('an error envelope becomes an ApiError with its status, code and message', async () => {
	replyWith(new Response(JSON.stringify({error: {code: 'forbidden', message: 'Only company admins can do that.'}}), {status: 403}))
	const error = await api.get('/companies/c1/members').catch((e) => e)
	expect(error).toBeInstanceOf(ApiError)
	expect(error).toMatchObject({status: 403, code: 'forbidden', message: 'Only company admins can do that.'})
})

test('an error without a JSON body gets a generic message', async () => {
	replyWith(new Response('<html>Bad gateway</html>', {status: 502}))
	await expect(api.get('/me')).rejects.toMatchObject({status: 502, code: 'internal', message: 'Something went wrong. Please try again.'})
})

test('204 No Content resolves to undefined', async () => {
	replyWith(new Response(null, {status: 204}))
	await expect(api.delete('/companies/c1/llm-credential')).resolves.toBeUndefined()
})
