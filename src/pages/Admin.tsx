import {useEffect, useState} from 'react'
import {Navigate} from '@tanstack/react-router'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {api, daysUntil, formatDate, money, type AdminCompany, type AdminRuns, type Model, type ProgrammeKey, type Role, type ServiceCost, type ServiceSettings} from '../api'
import {useMe} from '../useMe'
import {Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Notice, Select} from '../components/ui'
import {CostCard} from '../components/CostCard'

// Programme admin (DEC-003): companies, run summaries and service cost. No
// company's profile or report content is shown here, because the API does
// not return it.
export const Admin = () => {
	const me = useMe()
	if (me.data && !me.data.isProgrammeAdmin) return <Navigate to="/" />
	return (
		<div className="space-y-6">
			<h1 className="text-xl font-semibold">Programme admin</h1>
			<Cost />
			<FreePeriod />
			<Companies />
			<Runs />
			<Settings />
		</div>
	)
}

const Cost = () => {
	const cost = useQuery({queryKey: ['admin', 'cost'], queryFn: () => api.get<ServiceCost>('/admin/service-cost')})
	if (cost.isPending) return <Card title="Service cost"><Loading /></Card>
	if (cost.error) return <Card title="Service cost"><ErrorBox error={cost.error} onRetry={() => cost.refetch()} /></Card>
	return <CostCard cost={cost.data} />
}

const runTone = (status: string | null) => status == 'succeeded' ? 'good' : status == 'failed' ? 'bad' : status == 'skipped' ? 'warn' : 'neutral'
const SKIP_REASONS: Record<string, string> = {no_key: 'no API key', invalid_key: 'key rejected', out_of_credit: 'out of credit', company_paused: 'paused', no_profile: 'no profile',
	programme_key_problem: 'programme key not working', programme_budget_reached: 'monthly AI cap reached'}

const Companies = () => {
	const queryClient = useQueryClient()
	const companies = useQuery({queryKey: ['admin', 'companies'], queryFn: () => api.get<{companies: AdminCompany[]}>('/admin/companies')})
	const [name, setName] = useState('')
	const [inviting, setInviting] = useState<AdminCompany | null>(null)
	const refresh = () => queryClient.invalidateQueries({queryKey: ['admin', 'companies']})
	const create = useMutation({mutationFn: () => api.post<{company: AdminCompany}>('/admin/companies', {name}), onSuccess: (d) => { setName(''); refresh(); setInviting(d.company) }})
	const setStatus = useMutation({mutationFn: ({id, status}: {id: string, status: string}) => api.patch(`/admin/companies/${id}`, {status}), onSuccess: refresh})
	const [renaming, setRenaming] = useState<{id: string, name: string} | null>(null)
	const rename = useMutation({mutationFn: ({id, name}: {id: string, name: string}) => api.patch(`/admin/companies/${id}`, {name}), onSuccess: () => { setRenaming(null); refresh() }})

	return (
		<Card title="Companies">
			{companies.isPending && <Loading />}
			{companies.error && <ErrorBox error={companies.error} />}
			{companies.data && companies.data.companies.length == 0 && <Empty title="No companies yet">Add the first one below.</Empty>}
			{companies.data && companies.data.companies.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="border-b border-line text-xs uppercase text-muted">
							<tr><th scope="col" className="py-2 pr-3">Company</th><th scope="col" className="pr-3">People</th><th scope="col" className="pr-3">Set-up</th><th scope="col" className="pr-3">Last run</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
						</thead>
						<tbody className="divide-y divide-line">
							{companies.data.companies.map((c) => (
								<tr key={c.id}>
									<td className="py-2 pr-3 font-medium">
										{renaming?.id == c.id ? (
											<form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate(renaming) }}>
												<Input aria-label={`New name for ${c.name}`} value={renaming.name} maxLength={200} autoFocus
													onChange={(e) => setRenaming({id: c.id, name: e.target.value})} onKeyDown={(e) => { if (e.key == 'Escape') setRenaming(null) }} />
												<Button type="submit" busy={rename.isPending} disabled={!renaming.name.trim() || renaming.name.trim() == c.name}>Save</Button>
												<button type="button" className="text-xs font-medium text-muted hover:underline" onClick={() => setRenaming(null)}>Cancel</button>
											</form>
										) : <>{c.name} {c.status == 'paused' && <Badge tone="warn">Paused</Badge>}</>}
									</td>
									<td className="pr-3">{c.members}</td>
									<td className="pr-3 space-x-1">
										<Badge tone={c.has_profile ? 'good' : 'warn'}>{c.has_profile ? 'Profile' : 'No profile'}</Badge>
										<Badge tone={c.key_status == 'valid' ? 'good' : 'warn'}>{c.key_status == 'valid' ? 'Key working' : c.key_status ? `Key ${c.key_status.replace('_', ' ')}` : 'No key'}</Badge>
									</td>
									<td className="pr-3">
										{c.last_run_status ? <><Badge tone={runTone(c.last_run_status)}>{c.last_run_status}{c.last_run_skip_reason ? `: ${SKIP_REASONS[c.last_run_skip_reason] ?? c.last_run_skip_reason}` : ''}</Badge> <span className="text-xs text-muted">{formatDate(c.last_run_week)}</span></> : <span className="text-muted">Not run yet</span>}
									</td>
									<td className="whitespace-nowrap text-right">
										<button className="mr-3 text-xs font-medium text-brand hover:underline" onClick={() => setInviting(c)}>Invite</button>
										<button className="mr-3 text-xs font-medium text-muted hover:underline" onClick={() => { rename.reset(); setRenaming({id: c.id, name: c.name}) }}>Rename</button>
										<button className="text-xs font-medium text-muted hover:underline" onClick={() => setStatus.mutate({id: c.id, status: c.status == 'active' ? 'paused' : 'active'})}>
											{c.status == 'active' ? 'Pause' : 'Resume'}
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{setStatus.error && <ErrorBox error={setStatus.error} />}
			{rename.error && <ErrorBox error={rename.error} />}
			<form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
				<div className="min-w-60 flex-1"><Field label="Add a company">{(id) => <Input id={id} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}</Field></div>
				<Button type="submit" busy={create.isPending} disabled={!name.trim()}>Add company</Button>
			</form>
			{create.error && <div className="mt-2"><ErrorBox error={create.error} /></div>}
			{inviting && <Invite company={inviting} onDone={() => { setInviting(null); refresh() }} />}
		</Card>
	)
}

const Invite = ({company, onDone}: {company: AdminCompany, onDone: () => void}) => {
	const [email, setEmail] = useState('')
	const [role, setRole] = useState<Role>('company_admin')
	const [sent, setSent] = useState<string | null>(null)
	const invite = useMutation({mutationFn: () => api.post(`/admin/companies/${company.id}/invitations`, {email, role}), onSuccess: () => { setSent(email); setEmail('') }})
	return (
		<div className="mt-4 rounded-md border border-line bg-surface p-4">
			<h3 className="text-sm font-semibold">Invite someone to {company.name}</h3>
			<form className="mt-2 grid gap-3 sm:grid-cols-[1fr_10rem_auto_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); setSent(null); invite.mutate() }}>
				<Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
				<Field label="Role">{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="company_admin">Admin</option><option value="company_member">Member</option></Select>}</Field>
				<Button type="submit" busy={invite.isPending} disabled={!email.includes('@')}>Send invitation</Button>
				<Button type="button" variant="secondary" onClick={onDone}>Close</Button>
			</form>
			{invite.error && <div className="mt-2"><ErrorBox error={invite.error} /></div>}
			{sent && <div className="mt-2"><Notice tone="good">Invitation sent to {sent}. The link works for 7 days.</Notice></div>}
		</div>
	)
}

const Runs = () => {
	const runs = useQuery({queryKey: ['admin', 'runs'], queryFn: () => api.get<AdminRuns>('/admin/runs')})
	if (runs.isPending) return <Card title="Latest weekly run"><Loading /></Card>
	if (runs.error) return <Card title="Latest weekly run"><ErrorBox error={runs.error} /></Card>
	const {gather, runs: rows} = runs.data
	if (!gather) return <Card title="Latest weekly run"><Empty title="No weekly run yet">The first run is on Sunday night.</Empty></Card>
	return (
		<Card title={`Weekly run for ${formatDate(gather.week_start)}`} action={<Badge tone={runTone(gather.status)}>Gather {gather.status}</Badge>}>
			<p className="mb-3 text-xs text-muted">{gather.tender_notices ?? 0} tender notices, {gather.funder_pages ?? 0} funder pages, {gather.competitions ?? 0} Innovate UK competitions gathered.</p>
			<div className="overflow-x-auto">
				<table className="w-full text-left text-sm tabular-nums">
					<thead className="border-b border-line text-xs uppercase text-muted">
						<tr><th scope="col" className="py-2 pr-3">Company</th><th scope="col" className="pr-3">Status</th><th scope="col" className="pr-3">Rows</th><th scope="col" className="pr-3">Searches</th><th scope="col" className="pr-3">Search cost</th><th scope="col">Model cost (paid by)</th></tr>
					</thead>
					<tbody className="divide-y divide-line">
						{rows.map((r) => (
							<tr key={r.company_id}>
								<td className="py-2 pr-3">{r.company}</td>
								<td className="pr-3"><Badge tone={runTone(r.status)}>{r.status}{r.skip_reason ? `: ${SKIP_REASONS[r.skip_reason] ?? r.skip_reason}` : ''}{r.error_code ? ` (${r.error_code})` : ''}</Badge></td>
								<td className="pr-3">{r.funding_rows != null ? `${r.funding_rows} + ${r.tender_rows} (${r.new_this_week} new)` : '—'}</td>
								<td className="pr-3">{r.search_queries}</td>
								<td className="pr-3">{money(Number(r.search_cost_usd))}</td>
								<td>{money(Number(r.model_cost_usd))} <span className="text-xs text-muted">{r.paid_by == 'programme' ? 'programme' : 'company'}</span></td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	)
}

const Settings = () => {
	const queryClient = useQueryClient()
	const settings = useQuery({queryKey: ['admin', 'settings'], queryFn: () => api.get<{settings: ServiceSettings}>('/admin/service-settings')})
	const [form, setForm] = useState<ServiceSettings | null>(null)
	const [saved, setSaved] = useState(false)
	useEffect(() => { if (settings.data) setForm(settings.data.settings) }, [settings.data])
	const save = useMutation({
		mutationFn: () => api.put<{settings: ServiceSettings}>('/admin/service-settings', {...form, reviewDate: form!.reviewDate.slice(0, 10)}),
		onSuccess: (d) => { queryClient.setQueryData(['admin', 'settings'], d); queryClient.invalidateQueries({queryKey: ['admin', 'cost']}); setSaved(true) },
	})
	// The error check comes first: after a failed first load form stays null.
	if (settings.error) return <Card title="Search service settings"><ErrorBox error={settings.error} onRetry={() => settings.refetch()} /></Card>
	if (settings.isPending || !form) return <Card title="Search service settings"><Loading /></Card>
	const update = (patch: Partial<ServiceSettings>) => { setSaved(false); setForm({...form, ...patch}) }
	return (
		<Card title="Search service settings">
			<form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
				<label className="flex items-center gap-2 text-sm font-medium">
					<input type="checkbox" checked={form.searchEnabled} onChange={(e) => update({searchEnabled: e.target.checked})} />
					Web search (Brave) is on
				</label>
				<p className="text-xs text-muted">Switched off, weekly runs still read the funder pages gathered on Sunday, but find fewer new schemes.</p>
				<div className="grid gap-4 sm:grid-cols-3">
					<Field label="Price per 1,000 queries (US$)">{(id) => <Input id={id} type="number" min={0} step="0.01" value={form.bravePricePer1000Usd} onChange={(e) => update({bravePricePer1000Usd: Number(e.target.value)})} />}</Field>
					<Field label="Monthly query cap" hint="Search stops for the rest of the month once reached.">{(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} step="1" value={form.monthlyQueryCap} onChange={(e) => update({monthlyQueryCap: Number(e.target.value)})} />}</Field>
					<Field label="Review date">{(id) => <Input id={id} type="date" value={form.reviewDate.slice(0, 10)} onChange={(e) => update({reviewDate: e.target.value})} />}</Field>
				</div>
				{save.error && <ErrorBox error={save.error} />}
				{saved && <Notice tone="good">Settings saved.</Notice>}
				<Button type="submit" busy={save.isPending}>Save settings</Button>
			</form>
		</Card>
	)
}

// --- Free period on the programme's key (DEC-011) --------------------------------------

const keyBadge = (p: ProgrammeKey) => !p.credential.configured ? <Badge tone="warn">No programme key</Badge>
	: p.credential.status == 'valid' ? <Badge tone="good">Key working</Badge>
	: p.credential.status == 'invalid' ? <Badge tone="bad">Key rejected: replace it</Badge>
	: <Badge tone="bad">Out of credit: top up the Anthropic account</Badge>

const FreePeriod = () => {
	const queryClient = useQueryClient()
	const programme = useQuery({queryKey: ['admin', 'programme-key'], queryFn: () => api.get<ProgrammeKey>('/admin/programme-key')})
	const models = useQuery({queryKey: ['models'], queryFn: () => api.get<{models: Model[]}>('/models')})
	const [form, setForm] = useState<{until: string, cap: number} | null>(null)
	const [saved, setSaved] = useState(false)
	const [choice, setChoice] = useState('')
	const [apiKey, setApiKey] = useState('')
	const [editing, setEditing] = useState(false)
	useEffect(() => { if (programme.data) setForm({until: programme.data.freePeriodUntil ?? '', cap: programme.data.monthlyCapUsd}) }, [programme.data])
	const refresh = (d: ProgrammeKey) => { queryClient.setQueryData(['admin', 'programme-key'], d); queryClient.invalidateQueries({queryKey: ['admin', 'cost']}) }
	const saveSettings = useMutation({
		mutationFn: () => api.put<ProgrammeKey>('/admin/programme-key/settings', {freePeriodUntil: form!.until || null, monthlyCapUsd: form!.cap}),
		onSuccess: (d) => { refresh(d); queryClient.invalidateQueries({queryKey: ['me']}); setSaved(true) },
	})
	const saveKey = useMutation({
		mutationFn: () => {
			const [provider, model] = (choice || `${models.data!.models[0].provider}/${models.data!.models[0].model}`).split('/')
			return api.put<ProgrammeKey>('/admin/programme-key/credential', {provider, model, apiKey})
		},
		onSuccess: (d) => { refresh(d); setApiKey(''); setEditing(false) },
		// Cleared on failure too, so the key does not linger in the page.
		onError: () => setApiKey(''),
	})
	const removeKey = useMutation({mutationFn: () => api.delete<ProgrammeKey>('/admin/programme-key/credential'), onSuccess: refresh})

	const title = 'Free period (programme pays the AI model)'
	if (programme.error || models.error) return <Card title={title}><ErrorBox error={programme.error ?? models.error} onRetry={() => { if (programme.error) programme.refetch(); if (models.error) models.refetch() }} /></Card>
	if (programme.isPending || models.isPending || !form) return <Card title={title}><Loading /></Card>
	const p = programme.data
	const c = p.credential
	const modelList = models.data.models
	const active = p.freePeriodUntil != null && daysUntil(p.freePeriodUntil) >= 0
	return (
		<Card title={title} action={<span className="flex flex-wrap gap-2">{keyBadge(p)}
			<Badge tone={active ? 'good' : 'neutral'}>{active ? `On until ${formatDate(p.freePeriodUntil)}` : 'Off'}</Badge></span>}>
			<p className="text-sm text-muted">
				Until the end date, every company's weekly search runs on the programme's Anthropic key, whether or not it has added its own; their keys are kept for afterwards.
				Companies are told from four weeks before the end, in the portal and the Monday email. Use a key made only for Opportunity Finder, ideally in its own Anthropic workspace with a spend limit.
			</p>
			{active && !(c.configured && c.status == 'valid') && <div className="mt-3"><Notice tone="warn">The free period is on but there is no working key, so this week's runs will be skipped.</Notice></div>}
			{c.configured && (
				<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
					<dt className="text-muted">Model</dt><dd>{modelList.find((m) => m.model == c.model)?.label ?? c.model}</dd>
					<dt className="text-muted">Key</dt><dd className="font-mono">••••{c.lastFour}</dd>
					<dt className="text-muted">Last checked</dt><dd>{formatDate(c.checkedAt)}</dd>
					{c.addedBy && <><dt className="text-muted">Added by</dt><dd>{c.addedBy}</dd></>}
				</dl>
			)}
			{!editing && (
				<div className="mt-4 flex gap-2">
					<Button onClick={() => setEditing(true)}>{c.configured ? 'Replace key' : 'Add key'}</Button>
					{c.configured && <Button variant="danger" busy={removeKey.isPending} onClick={() => { if (confirm('Remove the programme key? Runs in the free period are skipped until a new one is added.')) removeKey.mutate() }}>Remove key</Button>}
				</div>
			)}
			{editing && (
				<form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); saveKey.mutate() }}>
					<Field label="Model">
						{(id) => (
							<Select id={id} value={choice} onChange={(e) => setChoice(e.target.value)}>
								{modelList.map((m) => <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>{m.label}{m.typicalCostUsd != null ? ` (about US$${m.typicalCostUsd.toFixed(2)} per company a week)` : ''}</option>)}
							</Select>
						)}
					</Field>
					<Field label="API key" hint="Checked with the provider (a free call), then stored in the keys vault. It is never shown again.">
						{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
					</Field>
					{saveKey.error && <ErrorBox error={saveKey.error} />}
					<div className="flex gap-2">
						<Button type="submit" busy={saveKey.isPending} disabled={apiKey.trim().length < 20}>Check and save key</Button>
						<Button type="button" variant="secondary" onClick={() => { setEditing(false); setApiKey('') }}>Cancel</Button>
					</div>
				</form>
			)}
			{removeKey.error && <div className="mt-3"><ErrorBox error={removeKey.error} /></div>}
			<form className="mt-6 space-y-4 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); saveSettings.mutate() }}>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Free until" hint="Weeks starting on or before this date run on the programme key. Clear it to end the free period.">
						{(id, d) => <Input id={id} aria-describedby={d} type="date" value={form.until} onChange={(e) => { setSaved(false); setForm({...form, until: e.target.value}) }} />}
					</Field>
					<Field label="Monthly AI spend cap (US$)" hint="Once reached, the rest of the month's runs are skipped.">
						{(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} step="1" value={form.cap} onChange={(e) => { setSaved(false); setForm({...form, cap: Number(e.target.value)}) }} />}
					</Field>
				</div>
				{saveSettings.error && <ErrorBox error={saveSettings.error} />}
				{saved && <Notice tone="good">Free period saved.</Notice>}
				<Button type="submit" busy={saveSettings.isPending}>Save free period</Button>
			</form>
		</Card>
	)
}
