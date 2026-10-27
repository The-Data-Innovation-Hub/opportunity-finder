import {useEffect, useState} from 'react'
import {Link, useParams} from '@tanstack/react-router'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {api, formatDate, type Credential, type Me, type Region, type Role, type Responses, type ProgrammeSkip} from '../api'
import {useMe} from '../useMe'
import {Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, MultiSelect, Notice, Select, Textarea} from '../components/ui'
import {CompanyTabs} from '../components/CompanyTabs'

// DEC-013: three scopes, each with Northern Ireland in it.
const SCOPES: {regions: Region[], label: string, hint: string}[] = [
	{regions: ['NI', 'IE', 'UK'], label: 'UK and Ireland', hint: 'All of the UK, including Northern Ireland, and the Republic of Ireland'},
	{regions: ['NI', 'UK'], label: 'UK only', hint: 'All of the UK, including Northern Ireland'},
	{regions: ['NI', 'IE'], label: 'Ireland and Northern Ireland only', hint: 'The island of Ireland: no Great Britain or UK-wide schemes'},
]
// Profiles saved before DEC-013 may hold any combination: show the smallest scope that covers it.
const scopeOf = (regions: Region[]) => regions.includes('UK') ? (regions.includes('IE') ? SCOPES[0] : SCOPES[1]) : regions.length ? SCOPES[2] : SCOPES[0]
const STAGES = ['Idea, pre-revenue', 'Prototype or pilot', 'Early revenue', 'Growing', 'Established']
const SIZES = ['Micro (under 10 staff)', 'Small (10 to 49 staff)', 'Medium (50 to 249 staff)', 'Large (250+ staff)']
const SECTORS = ['Digital health and healthtech', 'Medtech and medical devices', 'Life sciences', 'Data and AI', 'Software and SaaS', 'Cybersecurity',
	'Fintech', 'Agritech and food', 'Clean tech and net zero', 'Advanced manufacturing and engineering', 'Construction and built environment',
	'Transport and logistics', 'Creative industries and media', 'Education and edtech', 'Public sector and govtech', 'Social enterprise and charity',
	'Tourism and hospitality', 'Retail and consumer']
// Keeps a value saved before these lists existed selectable.
const withSaved = (options: string[], saved: string) => saved && !options.includes(saved) ? [saved, ...options] : options
const lines = (value: string) => value.split('\n').map((s) => s.trim()).filter(Boolean)
const commas = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean)
const asList = (v: unknown) => Array.isArray(v) ? v.map(String) : []

export const CompanySettings = () => {
	const {companyId} = useParams({from: '/companies/$companyId/settings'})
	const me = useMe()
	const company = me.data?.companies.find((c) => c.id == companyId)
	if (!company) return <Empty title="Company not found"><Link to="/" className="text-brand underline">Go back</Link></Empty>
	const isAdmin = company.role == 'company_admin'
	return (
		<div className="space-y-6">
			<CompanyTabs company={company} />
			{!isAdmin && <Notice>You can view these settings. Only your company admins can change them.</Notice>}
			<ProfileForm companyId={companyId} isAdmin={isAdmin} />
			<KeySettings companyId={companyId} isAdmin={isAdmin} freePeriod={me.data!.freePeriod} />
			<Members companyId={companyId} isAdmin={isAdmin} myId={me.data!.user.id} />
		</div>
	)
}

// --- Profile ------------------------------------------------------------------------

const ProfileForm = ({companyId, isAdmin}: {companyId: string, isAdmin: boolean}) => {
	const queryClient = useQueryClient()
	const profile = useQuery({queryKey: ['profile', companyId], queryFn: () => api.get<Responses['GET /companies/:companyId/profile']>(`/companies/${companyId}/profile`)})
	const [form, setForm] = useState({description: '', regions: ['NI', 'IE', 'UK'] as Region[], sectors: [] as string[], keywords: '', cpv: '', customers: '', fitPoints: '', angles: '', exclusions: '', basedIn: '', stage: '', size: ''})
	const [saved, setSaved] = useState(false)

	useEffect(() => {
		const p = profile.data?.profile
		if (!p) return
		const company = (p.details.company ?? {}) as Record<string, string>
		// oxlint-disable-next-line react/set-state-in-effect -- seeds the editable form once the query loads
		setForm({description: p.product_description, regions: scopeOf(p.regions).regions, sectors: p.sectors, keywords: p.tender_keywords.join(', '), cpv: p.cpv_prefixes.join(', '),
			customers: asList(p.details.customers).join('\n'), fitPoints: asList(p.details.fit_points).join('\n'), angles: asList(p.details.funding_angles).join('\n'),
			exclusions: asList(p.details.exclusions).join('\n'), basedIn: company.based_in ?? '', stage: company.stage ?? '', size: company.size ?? ''})
	}, [profile.data])

	const save = useMutation({
		mutationFn: () => api.put<Responses['PUT /companies/:companyId/profile']>(`/companies/${companyId}/profile`, {
			product_description: form.description, regions: form.regions, sectors: form.sectors, tender_keywords: commas(form.keywords), cpv_prefixes: commas(form.cpv),
			details: {...profile.data?.profile?.details, customers: lines(form.customers), fit_points: lines(form.fitPoints), funding_angles: lines(form.angles),
				exclusions: lines(form.exclusions), company: {based_in: form.basedIn, stage: form.stage, size: form.size}},
		}),
		onSuccess: (data) => {
			queryClient.setQueryData(['profile', companyId], data)
			setSaved(true)
		},
	})

	if (profile.isPending) return <Card title="Company profile"><Loading /></Card>
	if (profile.error) return <Card title="Company profile"><ErrorBox error={profile.error} onRetry={() => profile.refetch()} /></Card>
	const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setSaved(false); setForm({...form, [key]: e.target.value}) }
	const chooseScope = (regions: Region[]) => { setSaved(false); setForm({...form, regions}) }
	const p = profile.data.profile

	return (
		<Card title="Company profile" action={p && <span className="text-xs text-muted">Version {p.version}, saved {formatDate(p.created_at)}</span>}>
			<form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
				<p className="text-sm text-muted">The weekly search reads this to judge what fits. Changes apply from the next Sunday run.</p>
				<Field label="What does your product do, and for whom?" hint="20 to 5,000 characters. Include the problem it solves, who buys it and how far along it is. Describe the product, not people: no names, contact details or health information.">
					{(id, d) => <Textarea id={id} aria-describedby={d} rows={5} required minLength={20} maxLength={5000} disabled={!isAdmin} value={form.description} onChange={set('description')} />}
				</Field>
				<fieldset>
					<legend className="text-sm font-medium">Regions to search</legend>
					<div className="mt-1 space-y-2">
						{SCOPES.map((scope) => (
							<label key={scope.label} className="flex items-start gap-2 text-sm">
								<input type="radio" name="region-scope" className="mt-1" disabled={!isAdmin} checked={scopeOf(form.regions) == scope} onChange={() => chooseScope(scope.regions)} />
								<span>{scope.label}<span className="block text-xs text-muted">{scope.hint}</span></span>
							</label>
						))}
					</div>
				</fieldset>
				<div className="grid gap-4 sm:grid-cols-3">
					<Field label="Based in">{(id) => <Input id={id} disabled={!isAdmin} value={form.basedIn} onChange={set('basedIn')} placeholder="e.g. Northern Ireland" />}</Field>
					<Field label="Stage">{(id) => (
						<Select id={id} disabled={!isAdmin} value={form.stage} onChange={set('stage')}>
							<option value="">Choose…</option>
							{withSaved(STAGES, form.stage).map((o) => <option key={o}>{o}</option>)}
						</Select>
					)}</Field>
					<Field label="Size">{(id) => (
						<Select id={id} disabled={!isAdmin} value={form.size} onChange={set('size')}>
							<option value="">Choose…</option>
							{withSaved(SIZES, form.size).map((o) => <option key={o}>{o}</option>)}
						</Select>
					)}</Field>
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Sectors" hint="Choose all that apply, up to 20.">{(id, d) => <MultiSelect id={id} describedBy={d} label="Sectors" options={SECTORS} max={20} disabled={!isAdmin} value={form.sectors} onChange={(sectors) => { setSaved(false); setForm({...form, sectors}) }} />}</Field>
					<Field label="Tender keywords" hint="Words a matching tender would use, separated by commas.">{(id, d) => <Input id={id} aria-describedby={d} disabled={!isAdmin} value={form.keywords} onChange={set('keywords')} />}</Field>
					<Field label="Customers" hint="Organisations, not people. One per line.">{(id, d) => <Textarea id={id} aria-describedby={d} rows={3} disabled={!isAdmin} value={form.customers} onChange={set('customers')} />}</Field>
					<Field label="Strongest fit points" hint="One per line.">{(id, d) => <Textarea id={id} aria-describedby={d} rows={3} disabled={!isAdmin} value={form.fitPoints} onChange={set('fitPoints')} />}</Field>
					<Field label="Funding angles to look for" hint="One per line, e.g. net zero fleet funds.">{(id, d) => <Textarea id={id} aria-describedby={d} rows={3} disabled={!isAdmin} value={form.angles} onChange={set('angles')} />}</Field>
					<Field label="Leave out" hint="One per line.">{(id, d) => <Textarea id={id} aria-describedby={d} rows={3} disabled={!isAdmin} value={form.exclusions} onChange={set('exclusions')} />}</Field>
				</div>
				<Field label="CPV codes (optional)" hint="2 to 8 digit codes, separated by commas, e.g. 48, 72.">{(id, d) => <Input id={id} aria-describedby={d} disabled={!isAdmin} value={form.cpv} onChange={set('cpv')} />}</Field>
				{save.error && <ErrorBox error={save.error} />}
				{saved && <Notice tone="good">Profile saved.</Notice>}
				{isAdmin && <Button type="submit" busy={save.isPending} disabled={form.description.trim().length < 20}>Save profile</Button>}
			</form>
		</Card>
	)
}

// --- AI provider key (BEH-010) -----------------------------------------------------------

// DEC-011: "covered" only while the programme's runs are actually working.
const freeBlocked = (free: Me['freePeriod'], skip: ProgrammeSkip) => free != null && (!free.keyWorking || skip != null)
const statusBadge = (c: Credential, free: Me['freePeriod'], skip: ProgrammeSkip) => free
	? (freeBlocked(free, skip) ? <Badge tone="warn">Free period: runs paused</Badge> : <Badge tone="good">Covered by the programme until {formatDate(free.until)}</Badge>)
	: !c.configured ? <Badge tone="warn">No key: weekly runs are paused</Badge>
	: c.status == 'valid' ? <Badge tone="good">Working</Badge>
	: c.status == 'invalid' ? <Badge tone="bad">Key rejected: please replace it</Badge>
	: <Badge tone="bad">Out of credit: top up your provider account</Badge>

const KeySettings = ({companyId, isAdmin, freePeriod}: {companyId: string, isAdmin: boolean, freePeriod: Me['freePeriod']}) => {
	const queryClient = useQueryClient()
	const freeUntil = freePeriod?.until ?? null
	const credential = useQuery({queryKey: ['credential', companyId], queryFn: () => api.get<Responses['GET /companies/:companyId/llm-credential']>(`/companies/${companyId}/llm-credential`)})
	const models = useQuery({queryKey: ['models'], queryFn: () => api.get<Responses['GET /models']>('/models')})
	const [choice, setChoice] = useState('')
	const [apiKey, setApiKey] = useState('')
	const [editing, setEditing] = useState(false)

	const save = useMutation({
		mutationFn: () => {
			const [provider, model] = (choice || `${models.data!.models[0].provider}/${models.data!.models[0].model}`).split('/')
			return api.put<Responses['PUT /companies/:companyId/llm-credential']>(`/companies/${companyId}/llm-credential`, {provider, model, apiKey})
		},
		onSuccess: (data) => {
			queryClient.setQueryData(['credential', companyId], data)
			setApiKey('')
			setEditing(false)
		},
		// The key is cleared on failure too, so it does not linger in the page.
		onError: () => setApiKey(''),
	})
	const remove = useMutation({
		mutationFn: () => api.delete<Responses['DELETE /companies/:companyId/llm-credential']>(`/companies/${companyId}/llm-credential`),
		onSuccess: (data) => queryClient.setQueryData(['credential', companyId], data),
	})

	if (credential.isPending || models.isPending) return <Card title="AI provider"><Loading /></Card>
	if (credential.error || models.error) return <Card title="AI provider"><ErrorBox error={credential.error ?? models.error} /></Card>
	const c = credential.data.credential
	const skip = credential.data.programmeSkip ?? null
	const modelList = models.data.models

	return (
		<Card title="AI provider" action={statusBadge(c, freePeriod, skip)}>
			{freeBlocked(freePeriod, skip) && (
				<div className="mb-3"><Notice tone="warn">
					{skip?.reason == 'programme_budget_reached'
						? `Your report for the week of ${formatDate(skip.week)} was not run: the programme's monthly AI allowance was used up. Runs resume next month.`
						: "Weekly runs are paused while the programme's AI key is fixed. Nothing is needed from you."}
				</Notice></div>
			)}
			{freeUntil && !freeBlocked(freePeriod, skip) && (
				<div className="mb-3"><Notice tone="good">
					Until {formatDate(freeUntil)} the programme pays for the AI work behind your weekly reports, so you do not need a key. A key you add now is kept and used from then on{c.configured && c.status != 'valid' ? ', so please replace the one below' : ''}.
				</Notice></div>
			)}
			<p className="text-sm text-muted">{freeUntil ? 'After the free period, the weekly search' : 'The weekly search'} runs on your own AI provider account, so its cost (typically about {modelList[0]?.typicalCostUsd != null ? `US$${modelList[0].typicalCostUsd.toFixed(2)}` : 'a few dollars'} a week) is billed to you. Your key is stored in a secure key vault. It is never shown again, and only its last four characters are kept here.</p>
			{c.configured && (
				<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
					<dt className="text-muted">Model</dt><dd>{modelList.find((m) => m.model == c.model)?.label ?? c.model}</dd>
					{c.lastFour && <><dt className="text-muted">Key</dt><dd className="font-mono">••••{c.lastFour}</dd></>}
					{c.checkedAt && <><dt className="text-muted">Last checked</dt><dd>{formatDate(c.checkedAt)}</dd></>}
					{c.addedBy && <><dt className="text-muted">Added by</dt><dd>{c.addedBy}</dd></>}
				</dl>
			)}
			{isAdmin && !editing && (
				<div className="mt-4 flex gap-2">
					<Button onClick={() => setEditing(true)}>{c.configured ? 'Replace key' : 'Add key'}</Button>
					{c.configured && <Button variant="danger" busy={remove.isPending} onClick={() => { if (confirm('Remove the key? Weekly runs stop until a new key is added.')) remove.mutate() }}>Remove key</Button>}
				</div>
			)}
			{isAdmin && editing && (
				<form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
					<Field label="Model" hint="Recall is how many of the 36 reference opportunities the model found in our benchmark run.">
						{(id, d) => (
							<Select id={id} aria-describedby={d} value={choice} onChange={(e) => setChoice(e.target.value)}>
								{modelList.map((m) => (
									<option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>
										{m.label}{m.benchmarkCoverage != null ? ` (recall ${m.benchmarkCoverage}/${m.benchmarkOutOf}, about US$${m.typicalCostUsd?.toFixed(2)} a week)` : ''}
									</option>
								))}
							</Select>
						)}
					</Field>
					<Field label="API key" hint="We check it with the provider (a free call) before saving.">
						{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
					</Field>
					{save.error && <ErrorBox error={save.error} />}
					<div className="flex gap-2">
						<Button type="submit" busy={save.isPending} disabled={apiKey.trim().length < 20}>Check and save key</Button>
						<Button type="button" variant="secondary" onClick={() => { setEditing(false); setApiKey('') }}>Cancel</Button>
					</div>
				</form>
			)}
			{remove.error && <div className="mt-3"><ErrorBox error={remove.error} /></div>}
		</Card>
	)
}

// --- Colleagues (INF-002) -----------------------------------------------------------------

const Members = ({companyId, isAdmin, myId}: {companyId: string, isAdmin: boolean, myId: string}) => {
	const queryClient = useQueryClient()
	const members = useQuery({queryKey: ['members', companyId], queryFn: () => api.get<Responses['GET /companies/:companyId/members']>(`/companies/${companyId}/members`)})
	const [email, setEmail] = useState('')
	const [role, setRole] = useState<Role>('company_member')
	const [invited, setInvited] = useState<string | null>(null)
	const refresh = () => queryClient.invalidateQueries({queryKey: ['members', companyId]})
	const invite = useMutation({
		mutationFn: () => api.post(`/companies/${companyId}/members`, {email, role}),
		onSuccess: () => { setInvited(email); setEmail(''); refresh() },
	})
	const remove = useMutation({mutationFn: (userId: string) => api.delete(`/companies/${companyId}/members/${userId}`), onSuccess: refresh})

	return (
		<Card title="People">
			{members.isPending && <Loading />}
			{members.error && <ErrorBox error={members.error} />}
			{members.data && (
				<ul className="divide-y divide-line text-sm">
					{members.data.members.map((m) => (
						<li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
							<span>{m.email} <Badge>{m.role == 'company_admin' ? 'Admin' : 'Member'}</Badge> {!m.has_signed_in && <Badge tone="warn">Invited</Badge>}</span>
							{isAdmin && m.id != myId && (
								<button className="text-xs font-medium text-bad hover:underline" onClick={() => { if (confirm(`Remove ${m.email}?`)) remove.mutate(m.id) }}>Remove</button>
							)}
						</li>
					))}
				</ul>
			)}
			{remove.error && <div className="mt-2"><ErrorBox error={remove.error} /></div>}
			{isAdmin && (
				<form className="mt-4 grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); setInvited(null); invite.mutate() }}>
					<Field label="Invite a colleague">{(id) => <Input id={id} type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
					<Field label="Role">
						{(id) => (
							<Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
								<option value="company_member">Member (view)</option>
								<option value="company_admin">Admin (edit)</option>
							</Select>
						)}
					</Field>
					<Button type="submit" busy={invite.isPending} disabled={!email.includes('@')}>Send invitation</Button>
				</form>
			)}
			{invite.error && <div className="mt-2"><ErrorBox error={invite.error} /></div>}
			{invited && <div className="mt-2"><Notice tone="good">Invitation sent to {invited}.</Notice></div>}
		</Card>
	)
}
