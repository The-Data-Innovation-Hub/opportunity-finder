// Mounts the real routes on a memory history, with `fetch` answered from a
// table of canned API replies, so a page test exercises what a user sees.
import {render} from '@testing-library/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {createMemoryHistory, createRouter, RouterProvider} from '@tanstack/react-router'
import {vi} from 'vitest'
import {routeTree} from '../router'
import type {Me, Role} from '../api'

type Reply = {status?: number, body?: unknown}
// Keyed by "METHOD /path", with or without the query string.
export type ApiRoutes = Record<string, Reply | ((body: unknown) => Reply)>
export type ApiCall = {method: string, path: string, body: unknown}

export const mockApi = (routes: ApiRoutes) => {
	const calls: ApiCall[] = []
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		const path = url.replace(/^\/api/, '')
		const body = typeof init?.body == 'string' ? JSON.parse(init.body) : undefined
		calls.push({method, path, body})
		const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`]
		const reply = typeof route == 'function' ? route(body) : route ?? {status: 404, body: {error: {code: 'not_found', message: `No mock for ${method} ${path}`}}}
		if (reply.status == 204) return new Response(null, {status: 204})
		return new Response(JSON.stringify(reply.body ?? {}), {status: reply.status ?? 200, headers: {'content-type': 'application/json'}})
	}))
	return calls
}

export const renderApp = (path: string) => {
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
	const router = createRouter({routeTree, history: createMemoryHistory({initialEntries: [path]})})
	return {router, ...render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)}
}

export const COMPANY_ID = 'c1'
export const meAs = (role: Role, {isProgrammeAdmin = false} = {}): Me => ({
	user: {id: 'u1', email: 'founder@example.test', displayName: null},
	isProgrammeAdmin,
	companies: [{id: COMPANY_ID, name: 'Care Routing Ltd', status: 'active', role, hasPlan: false}],
	freePeriod: null,
})
