import {useState} from 'react'
import {Link} from '@tanstack/react-router'
import {api, REQUEST_COHORT_LABELS, type RequestCohort, type Responses} from '../api'
import {Button, Card, ErrorBox, Field, Input, Notice, Textarea} from '../components/ui'

const empty = {companyName: '', contactName: '', email: '', cohort: '' as RequestCohort | '', message: '', website: ''}

// BEH-019: a company not on the platform asks for access. The request goes to
// the programme admins, who set the company up and invite this contact.
export const RequestAccess = () => {
	const [form, setForm] = useState(empty)
	const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
	const [error, setError] = useState<unknown>(null)
	const set = (field: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({...form, [field]: e.target.value})
	const ready = form.companyName.trim() && form.contactName.trim() && form.email.includes('@') && form.cohort

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		setError(null)
		setState('sending')
		try {
			await api.post<Responses['POST /access-requests']>('/access-requests', form)
			setState('sent')
		} catch (e) {
			setError(e)
			setState('idle')
		}
	}

	return (
		<div className="mx-auto max-w-xl py-6">
			<Card title="Request access">
				{state == 'sent' ? (
					<div className="space-y-4">
						<Notice tone="good">Thank you. The programme team has your request and will email <strong>{form.email}</strong> once your company is set up.</Notice>
						<p className="text-sm"><Link to="/" className="font-medium text-brand hover:underline">Back to the home page</Link></p>
					</div>
				) : (
					<form onSubmit={submit} className="space-y-4" noValidate>
						<p className="text-sm text-muted">Tell us about your company. The programme team sets up each company and invites its first user; there is no password.</p>
						{error != null && <ErrorBox error={error} />}
						<Field label="Company name">
							{(id) => <Input id={id} autoComplete="organization" required maxLength={200} value={form.companyName} onChange={set('companyName')} />}
						</Field>
						<Field label="Your name">
							{(id) => <Input id={id} autoComplete="name" required maxLength={200} value={form.contactName} onChange={set('contactName')} />}
						</Field>
						<Field label="Work email" hint="We send the invitation here.">
							{(id, describedBy) => <Input id={id} type="email" autoComplete="email" required aria-describedby={describedBy} value={form.email} onChange={set('email')} />}
						</Field>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">Which group is your company in?</legend>
							{(Object.entries(REQUEST_COHORT_LABELS) as [RequestCohort, string][]).map(([value, label]) => (
								<label key={value} className="flex items-center gap-2 text-sm">
									<input type="radio" name="cohort" value={value} required checked={form.cohort == value} onChange={() => setForm({...form, cohort: value})} /> {label}
								</label>
							))}
						</fieldset>
						<Field label="Anything we should know? (optional)" hint="For example what you make, or the funding you are looking for.">
							{(id, describedBy) => <Textarea id={id} rows={4} maxLength={2000} aria-describedby={describedBy} value={form.message} onChange={set('message')} />}
						</Field>
						{/* Hidden from people; a bot that fills it in is ignored. */}
						<div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
							<label>Website <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} /></label>
						</div>
						<p className="text-xs text-muted">We use these details only to reply to your request, and delete them after 180 days.</p>
						<div className="flex flex-wrap items-center gap-4">
							<Button type="submit" busy={state == 'sending'} disabled={!ready}>Send request</Button>
							<span className="text-sm text-muted">Already have an account? <Link to="/sign-in" className="font-medium text-brand hover:underline">Sign in</Link></span>
						</div>
					</form>
				)}
			</Card>
		</div>
	)
}
