import {Link} from '@tanstack/react-router'
import type {Me} from '../api'

export const CompanyTabs = ({company}: {company: Me['companies'][number]}) => (
	<div className="flex flex-wrap items-end justify-between gap-3 border-b border-line">
		<h1 className="pb-2 text-xl font-semibold">{company.name}</h1>
		<nav aria-label="Company" className="flex gap-4 text-sm">
			<Link to="/companies/$companyId" params={{companyId: company.id}} activeOptions={{exact: true}}
				className="border-b-2 border-transparent pb-2 text-muted hover:text-ink [&.active]:border-brand [&.active]:text-ink">Reports</Link>
			<Link to="/companies/$companyId/settings" params={{companyId: company.id}}
				className="border-b-2 border-transparent pb-2 text-muted hover:text-ink [&.active]:border-brand [&.active]:text-ink">Settings</Link>
		</nav>
	</div>
)
