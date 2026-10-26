import {useMemo, useState} from 'react'
import {Link} from '@tanstack/react-router'
import {useQuery} from '@tanstack/react-query'
import {api, daysUntil, formatDate, safeHref, type Credential, type OpportunityRow, type Profile, type Region, type Report, type ReportSummary} from '../api'
import {useMe} from '../useMe'
import {Badge, Button, Card, Empty, ErrorBox, Input, Loading, Notice, Select, Stat} from '../components/ui'
import {CompanyTabs} from '../components/CompanyTabs'

const REGION_NAMES: Record<Region, string> = {NI: 'Northern Ireland', IE: 'Ireland', UK: 'Great Britain and UK-wide'}

// Serves both /companies/$companyId and .../reports/$reportId; the router passes the params.
export const CompanyReport = ({companyId, reportId}: {companyId: string, reportId?: string}) => {
	const me = useMe()
	const company = me.data?.companies.find((c) => c.id == companyId)
	const reports = useQuery({queryKey: ['reports', companyId], queryFn: () => api.get<{reports: ReportSummary[]}>(`/companies/${companyId}/reports?limit=13`)})
	const selectedId = reportId ?? reports.data?.reports[0]?.id

	if (!company) return <Empty title="Company not found">You may not have access to it. <Link to="/" className="text-brand underline">Go back</Link></Empty>

	return (
		<div className="space-y-6">
			<CompanyTabs company={company} />
			{reports.isPending && <Loading label="Loading reports" />}
			{reports.error && <ErrorBox error={reports.error} onRetry={() => reports.refetch()} />}
			{reports.data && !selectedId && <NoReportYet companyId={companyId} isAdmin={company.role == 'company_admin'} />}
			{selectedId && (
				<div className="grid gap-6 lg:grid-cols-[1fr_14rem]">
					<ReportView companyId={companyId} reportId={selectedId} companyName={company.name} />
					<History companyId={companyId} reports={reports.data?.reports ?? []} selectedId={selectedId} />
				</div>
			)}
		</div>
	)
}

const NoReportYet = ({companyId, isAdmin}: {companyId: string, isAdmin: boolean}) => {
	const profile = useQuery({queryKey: ['profile', companyId], queryFn: () => api.get<{profile: Profile | null}>(`/companies/${companyId}/profile`)})
	const credential = useQuery({queryKey: ['credential', companyId], queryFn: () => api.get<{credential: Credential}>(`/companies/${companyId}/llm-credential`)})
	if (profile.isPending || credential.isPending) return <Loading />
	const steps = [
		{done: Boolean(profile.data?.profile), label: 'Describe your product and choose regions'},
		{done: credential.data?.credential.configured && credential.data.credential.status == 'valid', label: 'Add your AI provider API key (runs are billed to your own account)'},
	]
	return (
		<Card title="Your first report">
			<p className="text-sm text-muted">Reports are prepared every Sunday night and emailed on Monday morning.</p>
			<ol className="mt-4 space-y-2">
				{steps.map((s) => (
					<li key={s.label} className="flex items-center gap-2 text-sm">
						<span aria-hidden="true">{s.done ? '✅' : '⬜'}</span>
						<span className={s.done ? 'text-muted line-through' : ''}>{s.label}</span>
						<span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
					</li>
				))}
			</ol>
			{steps.some((s) => !s.done) && (isAdmin
				? <Link to="/companies/$companyId/settings" params={{companyId}} className="mt-4 inline-block font-medium text-brand underline">Go to settings</Link>
				: <p className="mt-4 text-sm text-muted">Your company admin can finish these in Settings.</p>)}
			{steps.every((s) => s.done) && <Notice tone="good">All set. Your first report will arrive after the next Sunday run.</Notice>}
		</Card>
	)
}

const History = ({companyId, reports, selectedId}: {companyId: string, reports: ReportSummary[], selectedId: string}) => (
	<Card title="Previous weeks" className="self-start">
		<ul className="space-y-1 text-sm">
			{reports.map((r) => (
				<li key={r.id}>
					<Link to="/companies/$companyId/reports/$reportId" params={{companyId, reportId: r.id}}
						aria-current={r.id == selectedId ? 'page' : undefined}
						className={r.id == selectedId ? 'font-semibold' : 'text-brand hover:underline'}>
						Week of {formatDate(r.week_start)}
					</Link>
					<span className="ml-1 text-xs text-muted">{r.new_this_week} new</span>
				</li>
			))}
		</ul>
		<p className="mt-3 text-xs text-muted">Reports are kept for 13 weeks.</p>
	</Card>
)

const ReportView = ({companyId, reportId, companyName}: {companyId: string, reportId: string, companyName: string}) => {
	const report = useQuery({queryKey: ['report', companyId, reportId], queryFn: () => api.get<{report: Report}>(`/companies/${companyId}/reports/${reportId}`)})
	const week = report.data?.report.week_start.slice(0, 10)
	const rows = useQuery({
		queryKey: ['opportunities', companyId, week],
		queryFn: () => api.get<{rows: OpportunityRow[]}>(`/companies/${companyId}/opportunities?week=${week}`),
		enabled: Boolean(week),
	})
	const [downloading, setDownloading] = useState(false)
	const [downloadError, setDownloadError] = useState<unknown>(null)

	if (report.isPending) return <Loading label="Loading report" />
	if (report.error) return <ErrorBox error={report.error} onRetry={() => report.refetch()} />
	const r = report.data.report

	const download = async () => {
		setDownloading(true)
		setDownloadError(null)
		try {
			const {url} = await api.get<{url: string}>(`/companies/${companyId}/reports/${reportId}/download`)
			window.location.assign(url)
		} catch (e) {
			setDownloadError(e)
		} finally {
			setDownloading(false)
		}
	}

	// min-w-0: a grid item otherwise grows to the table's width on a phone.
	return (
		<div className="min-w-0 space-y-6">
			<Card
				title={`${companyName}: week of ${formatDate(r.week_start)}`}
				action={<Button onClick={download} busy={downloading}>Download spreadsheet (.xlsx)</Button>}
			>
				{downloadError != null && <div className="mb-3"><ErrorBox error={downloadError} /></div>}
				<div className="grid grid-cols-3 gap-3">
					<Stat label="Funding" value={r.funding_rows} />
					<Stat label="Tenders" value={r.tender_rows} />
					<Stat label="New this week" value={r.new_this_week} />
				</div>
			</Card>

			<Card title="Top 5 this week">
				{r.top_five.length == 0 ? <p className="text-sm text-muted">No top picks this week.</p> : (
					<ol className="space-y-4">
						{r.top_five.map((t) => (
							<li key={t.rank} className="flex gap-3">
								<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">{t.rank}</span>
								<div className="text-sm">
									<p className="font-semibold">{t.name}</p>
									<p className="text-muted">{[t.amount, t.deadline && `Deadline ${t.deadline}`].filter(Boolean).join(' · ')}</p>
									<p className="mt-1">{t.why_top_pick}</p>
									<p className="mt-1"><span className="font-medium">Next steps: </span>{t.practical_steps}</p>
								</div>
							</li>
						))}
					</ol>
				)}
			</Card>

			{rows.isPending && <Loading label="Loading opportunities" />}
			{rows.error && <ErrorBox error={rows.error} onRetry={() => rows.refetch()} />}
			{rows.data && <Opportunities rows={rows.data.rows} />}

			{r.also_checked.length > 0 && (
				<Card title={`Also checked (${r.also_checked.length})`}>
					<details>
						<summary className="cursor-pointer text-sm text-brand">Schemes and competitions we looked at and left out, with the reason</summary>
						<ul className="mt-3 space-y-2 text-sm">
							{r.also_checked.map((a, i) => <li key={i}><span className="font-medium">{a.name}</span> <Badge>{a.region}</Badge><p className="text-muted">{a.reason}</p></li>)}
						</ul>
					</details>
				</Card>
			)}
			<p className="text-xs text-muted">{r.note}</p>
		</div>
	)
}

const Opportunities = ({rows}: {rows: OpportunityRow[]}) => {
	const [kind, setKind] = useState<'funding' | 'tender'>('funding')
	const [region, setRegion] = useState('')
	const [status, setStatus] = useState('')
	const [newOnly, setNewOnly] = useState(false)
	const [search, setSearch] = useState('')
	const shown = useMemo(() => rows.filter((r) => r.kind == kind && (!region || r.region == region) && (!status || r.status == status)
		&& (!newOnly || r.new_this_week) && (!search || `${r.name} ${r.row_data.funder ?? r.row_data.buyer ?? ''}`.toLowerCase().includes(search.toLowerCase()))), [rows, kind, region, status, newOnly, search])
	const counts = {funding: rows.filter((r) => r.kind == 'funding').length, tender: rows.filter((r) => r.kind == 'tender').length}

	return (
		<Card title="All opportunities">
			<div role="group" aria-label="Kind" className="mb-4 flex gap-2">
				{(['funding', 'tender'] as const).map((k) => (
					<button key={k} type="button" aria-pressed={kind == k} onClick={() => setKind(k)}
						className={`rounded-md px-3 py-1.5 text-sm font-medium ${kind == k ? 'bg-brand text-white' : 'bg-surface text-ink hover:bg-line'}`}>
						{k == 'funding' ? 'Funding' : 'Tenders'} ({counts[k]})
					</button>
				))}
			</div>
			<div className="mb-4 grid gap-2 sm:grid-cols-4">
				<Input aria-label="Search by name or funder" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
				<Select aria-label="Region" value={region} onChange={(e) => setRegion(e.target.value)}>
					<option value="">All regions</option>
					{(Object.keys(REGION_NAMES) as Region[]).map((r) => <option key={r} value={r}>{REGION_NAMES[r]}</option>)}
				</Select>
				<Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
					<option value="">Any status</option>
					{['Open', 'Rolling', 'Opening soon', 'Closed'].map((s) => <option key={s}>{s}</option>)}
				</Select>
				<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} /> New this week only</label>
			</div>
			{shown.length == 0 ? <Empty title="Nothing matches these filters" /> : (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<caption className="sr-only">{kind == 'funding' ? 'Funding opportunities' : 'Tenders'}</caption>
						<thead className="border-b border-line text-xs uppercase text-muted">
							<tr><th scope="col" className="py-2 pr-3">Name</th><th scope="col" className="py-2 pr-3">Region</th><th scope="col" className="py-2 pr-3">{kind == 'funding' ? 'Amount' : 'Value'}</th><th scope="col" className="py-2 pr-3">Closes</th><th scope="col" className="py-2">Status</th></tr>
						</thead>
						<tbody className="divide-y divide-line">
							{shown.map((r) => {
								const days = r.closing_date ? daysUntil(r.closing_date) : null
								return (
									<tr key={r.id} className="align-top">
										<td className="py-2 pr-3">
											{safeHref(r.website) ? <a href={safeHref(r.website)!} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">{r.name}</a> : <span className="font-medium">{r.name}</span>}
											{r.new_this_week && <span className="ml-2"><Badge tone="brand">New</Badge></span>}
											<p className="text-xs text-muted">{r.row_data.funder ?? r.row_data.buyer}</p>
											{r.row_data.why_it_fits && <p className="mt-1 text-xs">{r.row_data.why_it_fits}</p>}
										</td>
										<td className="py-2 pr-3">{r.region}</td>
										<td className="py-2 pr-3">{r.row_data.amount ?? r.row_data.value ?? '—'}</td>
										<td className="py-2 pr-3 whitespace-nowrap">
											{r.closing_date ? formatDate(r.closing_date) : '—'}
											{days != null && days >= 0 && days <= 30 && r.status != 'Closed' && <p><Badge tone="warn">{days == 0 ? 'Closes today' : days == 1 ? '1 day left' : `${days} days left`}</Badge></p>}
										</td>
										<td className="py-2"><Badge tone={r.status == 'Closed' ? 'bad' : r.status == 'Opening soon' ? 'neutral' : 'good'}>{r.status}</Badge></td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	)
}
