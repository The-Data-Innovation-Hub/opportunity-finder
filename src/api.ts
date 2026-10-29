// Typed client for the Opportunity Finder API. Same origin, cookie session:
// no token is ever held in script-readable storage.

export class ApiError extends Error {
	constructor(public status: number, public code: string, message: string) {
		super(message)
	}
}

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
	const response = await fetch(`/api${path}`, {
		method,
		credentials: 'same-origin',
		headers: body === undefined ? {} : {'content-type': 'application/json'},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	if (response.status == 204) return undefined as T
	const json = await response.json().catch(() => null)
	if (!response.ok) throw new ApiError(response.status, json?.error?.code ?? 'internal', json?.error?.message ?? 'Something went wrong. Please try again.')
	return json as T
}

export const api = {
	get: <T>(path: string) => request<T>('GET', path),
	post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
	put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
	patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
	delete: <T>(path: string) => request<T>('DELETE', path),
}

export type Role = 'company_admin' | 'company_member'
// DEC-015: AI in Healthcare programme members have the free period; Connected
// Health Cluster members get their first report free, then need a plan.
export type Cohort = 'ai_in_healthcare' | 'connected_health_cluster'
export const COHORT_LABELS: Record<Cohort, string> = {ai_in_healthcare: 'AI in Healthcare programme', connected_health_cluster: 'Connected Health Cluster'}
export type Me = {
	user: {id: string, email: string, displayName: string | null}
	isProgrammeAdmin: boolean
	// hasPlan: a live plan not set to end, so it carries on after the free period (DEC-014).
	companies: {id: string, name: string, status: string, role: Role, cohort: Cohort, hasPlan: boolean}[]
	// DEC-011: set while the programme covers AI in Healthcare companies' AI cost.
	freePeriod: {until: string, keyWorking: boolean} | null
}

export type Region = 'NI' | 'IE' | 'UK'
export type Profile = {
	id: string
	version: number
	product_description: string
	regions: Region[]
	sectors: string[]
	tender_keywords: string[]
	cpv_prefixes: string[]
	details: Record<string, unknown>
	created_at: string
}

export type ReportSummary = {id: string, week_start: string, funding_rows: number, tender_rows: number, new_this_week: number, created_at: string}
export type TopPick = {rank: number, name: string, why_top_pick: string, amount: string | null, deadline: string | null, practical_steps: string}
export type Report = ReportSummary & {top_five: TopPick[], also_checked: {name: string, reason: string, region: Region}[], sources: string[], note: string}

export type OpportunityRow = {
	id: string
	kind: 'funding' | 'tender'
	region: Region
	name: string
	website: string | null
	status: 'Open' | 'Rolling' | 'Opening soon' | 'Closed'
	closing_date: string | null
	closed_since: string | null
	new_this_week: boolean
	row_data: Record<string, unknown> & {amount?: string | null, value?: string | null, funder?: string, buyer?: string, why_it_fits?: string, next_step?: string}
}

export type Credential =
	| {configured: false}
	| {configured: true, provider: string, model: string, status: 'valid' | 'invalid' | 'out_of_credit', lastFour?: string, checkedAt?: string, addedAt?: string, addedBy?: string}

export type Model = {provider: string, model: string, label: string, benchmarkCoverage: number | null, benchmarkOutOf: number, typicalCostUsd: number | null}
export type Member = {id: string, email: string, display_name: string | null, role: Role, created_at: string, has_signed_in: boolean}

export type ServiceCost = {
	latestWeek: string | null
	brave: {currency: 'USD', week: number, total: number, weekQueries: number, totalQueries: number, averagePerCompany: number,
		averageQueriesPerCompany: number, weekCompanies: number, monthQueries: number, monthlyQueryCap: number}
	azure: null | {error: string} | {currency: string, lastSevenDays: number, total: number, collectedTo: string}
	programmeModel: {currency: 'USD', week: number, month: number, total: number, monthlyCapUsd: number, freePeriodUntil: string | null}
	combined: null | {currency: 'USD', week: number, total: number}
	weekly: {weekStart: string, braveUsd: number, programmeModelUsd: number, azure: number}[]
	searchEnabled: boolean
	reviewDate: string
}
export type ProgrammeKey = {
	credential: {configured: false} | {configured: true, provider: string, model: string, lastFour: string, status: 'valid' | 'invalid' | 'out_of_credit',
		checkedAt: string, addedAt: string, addedBy: string | null}
	freePeriodUntil: string | null
	monthlyCapUsd: number
	// DEC-014: companies on a live subscription, who run on this key.
	subscribers: number
}
export type ServiceSettings = {searchEnabled: boolean, bravePricePer1000Usd: number, monthlyQueryCap: number, reviewDate: string, updatedAt: string}
export type AdminCompany = {id: string, name: string, status: 'active' | 'paused', cohort: Cohort, created_at: string, members: number, has_profile: boolean,
	key_status: string | null, provider: string | null, model: string | null, last_run_week: string | null, last_run_status: string | null, last_run_skip_reason: string | null,
	billing_plan: Plan | null, billing_status: string | null}
// A company as just created, before it has members or runs.
export type NewCompany = Pick<AdminCompany, 'id' | 'name' | 'status' | 'cohort' | 'created_at'>
export type AdminRun = {company_id: string, company: string, status: string, skip_reason: string | null, error_code: string | null, provider: string | null,
	model: string | null, started_at: string | null, finished_at: string | null, input_tokens: string, output_tokens: string, cache_read_tokens: string, cache_write_tokens: string,
	model_cost_usd: string, paid_by: 'company' | 'programme', search_queries: number, search_cost_usd: string, page_reads: number,
	funding_rows: number | null, tender_rows: number | null, new_this_week: number | null}
export type AdminRuns = {gather: null | {week_start: string, status: string, started_at: string | null, finished_at: string | null, tender_notices: number | null, funder_pages: number | null, competitions: number | null}, runs: AdminRun[]}

// DEC-014: the plans a company chooses from when the free period ends.
export type Plan = 'subscription' | 'own_key'
export type BillingInterval = 'month' | 'year'
export type Billing = {
	billing: null | {plan: Plan, interval: BillingInterval, live: boolean, currentPeriodEnd: string | null, cancelAtPeriodEnd: boolean,
		status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'paused'}
	// A Stripe customer exists, so the portal can open.
	hasAccount: boolean
	// Stripe is set up on the server.
	available: boolean
	// Pence, excluding VAT.
	prices: Record<Plan, Record<BillingInterval, number>>
	cohort: Cohort
	freePeriodUntil: string | null
	checkoutOpensOn: string | null
	// Null when no free period is set: every company uses its own key.
	plansRequiredFrom: string | null
	// DEC-015: a Connected Health Cluster company that has not had its free first report yet.
	firstReportFree: boolean
}

// BEH-019: a company asking for access from the landing page.
export type RequestCohort = Cohort | 'not_sure'
export const REQUEST_COHORT_LABELS: Record<RequestCohort, string> = {...COHORT_LABELS, not_sure: 'Not sure'}
export type AccessRequest = {id: string, company_name: string, contact_name: string, email: string, cohort: RequestCohort, message: string | null,
	created_at: string, handled_at: string | null}

export type ProgrammeSkip = {week: string, reason: 'programme_key_problem' | 'programme_budget_reached'} | null

// TYP-001: every response the pages read, by route. Pages type their calls
// from this map, and CI checks real backend responses against it
// (Backend/Tests/Contract/capture.js, then `npm run test:contract`).
export type Responses = {
	'GET /me': Me
	'GET /models': {models: Model[]}
	'GET /companies/:companyId/profile': {profile: Profile | null}
	'PUT /companies/:companyId/profile': {profile: Profile}
	'GET /companies/:companyId/reports': {reports: ReportSummary[], nextBefore: string | null}
	'GET /companies/:companyId/reports/:reportId': {report: Report}
	'GET /companies/:companyId/reports/:reportId/download': {url: string, fileName: string, expiresAt: string}
	'GET /companies/:companyId/opportunities': {weekStart: string | null, reportId?: string, rows: OpportunityRow[]}
	'GET /companies/:companyId/llm-credential': {credential: Credential, programmeSkip: ProgrammeSkip}
	'PUT /companies/:companyId/llm-credential': {credential: Credential}
	'DELETE /companies/:companyId/llm-credential': {credential: Credential}
	'GET /companies/:companyId/members': {members: Member[]}
	'GET /companies/:companyId/billing': Billing
	'POST /companies/:companyId/billing/checkout': {url: string}
	'POST /companies/:companyId/billing/portal': {url: string}
	'POST /companies/:companyId/billing/sync': Billing
	'GET /admin/companies': {companies: AdminCompany[]}
	'POST /admin/companies': {company: NewCompany}
	'GET /admin/runs': AdminRuns
	'GET /admin/service-cost': ServiceCost
	'GET /admin/service-settings': {settings: ServiceSettings}
	'PUT /admin/service-settings': {settings: ServiceSettings}
	'GET /admin/programme-key': ProgrammeKey
	'PUT /admin/programme-key/settings': ProgrammeKey
	'PUT /admin/programme-key/credential': ProgrammeKey
	'DELETE /admin/programme-key/credential': ProgrammeKey
	'POST /access-requests': {received: true}
	'GET /admin/access-requests': {requests: AccessRequest[]}
	'PATCH /admin/access-requests/:id': {request: Pick<AccessRequest, 'id' | 'handled_at'>}
}

export const formatDate = (value: string | null | undefined) =>
	value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'}) : '—'
// From four weeks before it ends, the free period is announced (DEC-011).
export const FREE_PERIOD_NOTICE_DAYS = 28
export const daysUntil = (date: string) => Math.ceil((Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - Date.now()) / 864e5)
export const money = (value: number, currency = 'USD') =>
	new Intl.NumberFormat('en-GB', {style: 'currency', currency, minimumFractionDigits: 2}).format(value)

// Row links come from model output: only http(s) URLs become links, so a
// `javascript:` or `data:` value can never run in the page.
export const safeHref = (url: string | null | undefined) => {
	if (!url) return null
	try {
		const parsed = new URL(url)
		return parsed.protocol == 'https:' || parsed.protocol == 'http:' ? parsed.href : null
	} catch {
		return null
	}
}
