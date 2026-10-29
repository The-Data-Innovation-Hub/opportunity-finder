import {Link, Navigate, Outlet, useLocation, useNavigate} from '@tanstack/react-router'
import {useQueryClient} from '@tanstack/react-query'
import {api, ApiError, daysUntil, formatDate, FREE_PERIOD_NOTICE_DAYS} from '../api'
import {useMe} from '../useMe'
import {Landing} from '../pages/Landing'
import {ErrorBox, Loading, Notice} from './ui'

// Pages anyone can open (BEH-019). The account is not looked up on them: on
// the sign-in page a stale cookie's 401 could land after the new session is
// set and send the user straight back.
const PUBLIC_PATHS = ['/sign-in', '/request-access']

export const Layout = () => {
	const location = useLocation()
	const onPublicPage = PUBLIC_PATHS.includes(location.pathname)
	const me = useMe({enabled: !onPublicPage})
	const queryClient = useQueryClient()
	const navigate = useNavigate()

	if (onPublicPage) return <Shell nav={<PublicNav />}><Outlet /></Shell>
	if (me.isPending) return <Shell><Loading /></Shell>
	if (me.error instanceof ApiError && me.error.status == 401) {
		// Signed out at the home page: the landing page; anywhere else, sign in.
		return location.pathname == '/' ? <Shell nav={<PublicNav />}><Landing /></Shell> : <Navigate to="/sign-in" />
	}
	if (me.error) return <Shell><ErrorBox error={me.error} onRetry={() => me.refetch()} /></Shell>

	const signOut = async () => {
		await api.post('/auth/sign-out').catch(() => {})
		queryClient.clear()
		navigate({to: '/sign-in'})
	}
	// DEC-014: companies with a plan for after the free period need no notice.
	// DEC-015: the free period is for AI in Healthcare programme members; a
	// Connected Health Cluster company needs a plan after its first report.
	const needPlan = me.data.companies.filter((c) => !c.hasPlan && c.cohort == 'ai_in_healthcare')
	const clusterNeedPlan = me.data.companies.filter((c) => !c.hasPlan && c.cohort == 'connected_health_cluster')
	const forNames = (list: typeof needPlan) => me.data.companies.length > 1 && <> for {list.map((c) => c.name).join(' and ')}</>

	return (
		<Shell
			nav={
				<nav aria-label="Main" className="flex flex-wrap items-center gap-4 text-sm">
					{me.data.companies.map((c) => (
						<Link key={c.id} to="/companies/$companyId" params={{companyId: c.id}} className="text-muted hover:text-ink [&.active]:font-semibold [&.active]:text-ink">{c.name}</Link>
					))}
					{me.data.isProgrammeAdmin && <Link to="/admin" className="text-muted hover:text-ink [&.active]:font-semibold [&.active]:text-ink">Programme admin</Link>}
					<span className="hidden text-muted sm:inline"><span className="sr-only">Signed in as </span>{me.data.user.email}</span>
					<button onClick={signOut} className="font-medium text-brand hover:underline">Sign out</button>
				</nav>
			}
		>
			{me.data.freePeriod && needPlan.length > 0 && daysUntil(me.data.freePeriod.until) <= FREE_PERIOD_NOTICE_DAYS && (
				<div className="mb-6"><Notice tone="warn">
					The programme covers the AI cost of your weekly reports until {formatDate(me.data.freePeriod.until)}. To keep them after that, a company admin chooses a plan under Settings{forNames(needPlan)}: a subscription at £30 a month, or your own AI provider key with a £10 a month platform fee (prices exclude VAT). Choosing now costs nothing until then.
				</Notice></div>
			)}
			{clusterNeedPlan.length > 0 && (
				<div className="mb-6"><Notice tone="warn">
					Connected Health Cluster members get their first report free. To receive a report every week, a company admin chooses a plan under Settings{forNames(clusterNeedPlan)}: a subscription at £30 a month, or your own AI provider key with a £10 a month platform fee (prices exclude VAT).
				</Notice></div>
			)}
			<Outlet />
		</Shell>
	)
}

const PublicNav = () => (
	<nav aria-label="Main" className="flex flex-wrap items-center gap-4 text-sm">
		<Link to="/sign-in" className="font-medium text-brand hover:underline [&.active]:text-ink">Sign in</Link>
		<Link to="/request-access" className="rounded-md bg-brand px-3 py-1.5 font-medium text-white hover:bg-brand-dark">Request access</Link>
	</nav>
)

const Shell = ({nav, children}: {nav?: React.ReactNode, children: React.ReactNode}) => (
	<div className="min-h-screen">
		<a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
		<header className="border-b border-line bg-white">
			<div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
				<Link to="/" className="text-lg font-semibold text-brand-dark">Opportunity Finder</Link>
				{nav}
			</div>
		</header>
		<main id="main" className="mx-auto max-w-6xl px-4 py-6">{children}</main>
		<footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted">The Data Innovation Hub · Funding and tenders for NI, Ireland, the UK and EU programmes, refreshed every Monday.</footer>
	</div>
)
