import {Link, Navigate} from '@tanstack/react-router'
import {useMe} from '../useMe'
import {Card, Empty} from '../components/ui'

export const Home = () => {
	const me = useMe()
	if (!me.data) return null
	const {companies, isProgrammeAdmin} = me.data
	if (companies.length == 1 && !isProgrammeAdmin) return <Navigate to="/companies/$companyId" params={{companyId: companies[0].id}} />
	if (!companies.length && isProgrammeAdmin) return <Navigate to="/admin" />
	if (!companies.length) return <Empty title="You are not part of a company yet">Ask your programme contact to invite you.</Empty>
	return (
		<Card title="Choose a company">
			<ul className="divide-y divide-line">
				{companies.map((c) => (
					<li key={c.id} className="py-2">
						<Link to="/companies/$companyId" params={{companyId: c.id}} className="font-medium text-brand hover:underline">{c.name}</Link>
						<span className="ml-2 text-xs text-muted">{c.role == 'company_admin' ? 'Admin' : 'Member'}</span>
					</li>
				))}
			</ul>
		</Card>
	)
}
