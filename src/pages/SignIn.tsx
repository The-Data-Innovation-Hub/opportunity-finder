import {useEffect, useRef, useState} from 'react'
import {Link, useNavigate} from '@tanstack/react-router'
import {useQueryClient} from '@tanstack/react-query'
import {api} from '../api'
import {Button, Card, ErrorBox, Field, Input, Loading, Notice} from '../components/ui'

// The link in the email carries its token in the URL fragment (never sent to
// a server). It is read once, removed from the address bar, and exchanged
// for a session cookie.
export const SignIn = () => {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [email, setEmail] = useState('')
	const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'verifying'>(() => location.hash.includes('token=') ? 'verifying' : 'idle')
	const [error, setError] = useState<unknown>(null)
	const verified = useRef<string | null>(null)

	useEffect(() => {
		const verify = () => {
			const token = new URLSearchParams(location.hash.slice(1)).get('token')
			if (!token || verified.current == token) return
			verified.current = token
			setState('verifying')
			history.replaceState(null, '', location.pathname)
			api.post('/auth/verify', {token})
				.then(() => {
					queryClient.removeQueries()
					navigate({to: '/'})
				})
				.catch((e) => { setError(e); setState('idle') })
		}
		verify()
		// A second link opened in the same tab changes only the fragment.
		window.addEventListener('hashchange', verify)
		return () => window.removeEventListener('hashchange', verify)
	}, [navigate, queryClient])

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		setError(null)
		setState('sending')
		try {
			await api.post('/auth/request-link', {email})
			setState('sent')
		} catch (e) {
			setError(e)
			setState('idle')
		}
	}

	return (
		<div className="mx-auto max-w-md py-10">
			<Card title="Sign in">
				{state == 'verifying' && <Loading label="Signing you in" />}
				{state == 'sent' && (
					<Notice tone="good">If <strong>{email}</strong> has an Opportunity Finder account, a sign-in link is on its way. It works once and expires in 15 minutes.</Notice>
				)}
				{(state == 'idle' || state == 'sending') && (
					<form onSubmit={submit} className="space-y-4" noValidate>
						<p className="text-sm text-muted">Enter the email address your programme invited. We will email you a one-time sign-in link; there is no password.</p>
						{error != null && <ErrorBox error={error} />}
						<Field label="Email address">
							{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
						</Field>
						<Button type="submit" busy={state == 'sending'} disabled={!email.includes('@')}>Email me a sign-in link</Button>
					</form>
				)}
				{state != 'verifying' && (
					<p className="mt-6 border-t border-line pt-4 text-sm text-muted">New here? <Link to="/request-access" className="font-medium text-brand hover:underline">Request access</Link> for your company.</p>
				)}
			</Card>
		</div>
	)
}
