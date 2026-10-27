import {Link, Navigate, Outlet, useLocation, useNavigate} from '@tanstack/react-router'
import {useQueryClient} from '@tanstack/react-query'
import {api, ApiError, daysUntil, formatDate, FREE_PERIOD_NOTICE_DAYS} from '../api'
import {useMe} from '../useMe'
import {ErrorBox, Loading, Notice} from './ui'

export const Layout = () => {
	const location = useLocation()
	const onSignIn = location.pathname == '/sign-in'
	// Not on the sign-in page: a stale cookie's 401 could land after the new
	// session is set and send the user straight back here.
	const me = useMe({enabled: !onSignIn})
	const queryClient = useQueryClient()
	const navigate = useNavigate()

	if (onSignIn) return <Shell><Outlet /></Shell>
	if (me.isPending) return <Shell><Loading /></Shell>
	if (me.error instanceof ApiError && me.error.status == 401) return <Navigate to="/sign-in" />
	if (me.error) return <Shell><ErrorBox error={me.error} onRetry={() => me.refetch()} /></Shell>

	const signOut = async () => {
		await api.post('/auth/sign-out').catch(() => {})
		queryClient.clear()
		navigate({to: '/sign-in'})
	}

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
			{me.data.freePeriod && me.data.companies.length > 0 && daysUntil(me.data.freePeriod.until) <= FREE_PERIOD_NOTICE_DAYS && (
				<div className="mb-6"><Notice tone="warn">
					The programme covers the AI cost of your weekly reports until {formatDate(me.data.freePeriod.until)}. To keep them after that, a company admin chooses a plan under Settings: a subscription at £30 a month, or your own AI provider key with a £10 a month platform fee (prices exclude VAT). Choosing now costs nothing until then.
				</Notice></div>
			)}
			<Outlet />
		</Shell>
	)
}

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
		<footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted">The Data Innovation Hub · Funding and tenders for NI, Ireland and the UK, refreshed every Monday.</footer>
	</div>
)
