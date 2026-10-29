import {Link} from '@tanstack/react-router'

// BEH-019: what a signed-out visitor sees at /. Companies do not register
// themselves (INF-001): a new company asks for access, an existing user signs in.
export const Landing = () => (
	<div className="space-y-12 py-4">
		<section className="max-w-3xl space-y-5">
			<h1 className="text-3xl font-semibold leading-tight text-brand-dark sm:text-4xl">Funding and tenders that fit your company, every Monday</h1>
			<p className="text-lg text-muted">
				Opportunity Finder checks funders, tender portals and EU programmes for Northern Ireland, Ireland and the UK each week, and sends your
				company a short report: the best matches, why they fit, and the practical steps to apply.
			</p>
			<div className="flex flex-wrap gap-3">
				<Link to="/request-access" className="rounded-md bg-brand px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-dark">Request access</Link>
				<Link to="/sign-in" className="rounded-md border border-line bg-white px-5 py-2.5 text-sm font-medium text-ink hover:bg-surface">Sign in</Link>
			</div>
		</section>

		<section aria-labelledby="how" className="space-y-4">
			<h2 id="how" className="text-xl font-semibold">How it works</h2>
			<ol className="grid gap-4 sm:grid-cols-3">
				{[
					['Tell us about your company', 'What you make, your stage and sectors, and where you can work: Northern Ireland, Ireland, the UK, or all three.'],
					['We search every week', 'Each Sunday night the platform reads grant schemes, public tender notices and EU Funding & Tenders calls, and matches them to your profile.'],
					['Your report arrives on Monday', 'Your top five picks with deadlines and next steps, plus a spreadsheet of everything checked, emailed to your team.'],
				].map(([title, text], i) => (
					<li key={title} className="rounded-lg border border-line bg-white p-5 shadow-sm">
						<p className="text-sm font-semibold text-brand">Step {i + 1}</p>
						<h3 className="mt-1 font-semibold">{title}</h3>
						<p className="mt-2 text-sm text-muted">{text}</p>
					</li>
				))}
			</ol>
		</section>

		<section aria-labelledby="who" className="space-y-4">
			<h2 id="who" className="text-xl font-semibold">Who it is for</h2>
			<div className="grid gap-4 md:grid-cols-2">
				<div className="rounded-lg border border-line bg-white p-5 shadow-sm">
					<h3 className="font-semibold">AI in Healthcare programme members</h3>
					<p className="mt-2 text-sm text-muted">
						Weekly reports are free until 31 January 2027: the programme pays for the AI. After that, keep them with one of the plans below.
					</p>
				</div>
				<div className="rounded-lg border border-line bg-white p-5 shadow-sm">
					<h3 className="font-semibold">Connected Health Cluster members</h3>
					<p className="mt-2 text-sm text-muted">Your first report is free. For a report every week, choose one of the plans below.</p>
				</div>
			</div>
			<div className="rounded-lg bg-brand-soft p-5 text-sm text-brand-dark">
				<p className="font-semibold">Plans</p>
				<ul className="mt-2 list-disc space-y-1 pl-5">
					<li>Subscription: £30 a month or £300 a year, AI included.</li>
					<li>Your own AI provider key: £10 a month or £100 a year platform fee, and your provider bills you for the AI.</li>
				</ul>
				<p className="mt-2">Prices exclude VAT. Cancel any time from your company settings.</p>
			</div>
		</section>

		<section className="rounded-lg border border-line bg-white p-6 shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-6">
			<div>
				<h2 className="text-lg font-semibold">New to Opportunity Finder?</h2>
				<p className="mt-1 text-sm text-muted">Tell us about your company and the programme team will set you up. Already have an account? Sign in with your work email.</p>
			</div>
			<div className="mt-4 flex shrink-0 flex-wrap gap-3 sm:mt-0">
				<Link to="/request-access" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">Request access</Link>
				<Link to="/sign-in" className="rounded-md border border-line bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-surface">Sign in</Link>
			</div>
		</section>
	</div>
)
