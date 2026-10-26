import {Link} from '@tanstack/react-router'
import {Empty} from '../components/ui'

export const NotFound = () => (
	<Empty title="Page not found">
		<Link to="/" className="text-brand underline">Go to your reports</Link>
	</Empty>
)
