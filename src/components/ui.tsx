import type {ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes} from 'react'
import {useEffect, useId, useRef} from 'react'
import {ApiError} from '../api'

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {variant?: 'primary' | 'secondary' | 'danger', busy?: boolean}
export const Button = ({variant = 'primary', busy, disabled, className, children, ...rest}: ButtonProps) => (
	<button
		{...rest}
		disabled={disabled || busy}
		aria-busy={busy || undefined}
		className={cx('inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
			variant == 'primary' && 'bg-brand text-white hover:bg-brand-dark',
			variant == 'secondary' && 'border border-line bg-white text-ink hover:bg-surface',
			variant == 'danger' && 'border border-bad/30 bg-white text-bad hover:bg-bad/5',
			className)}
	>
		{busy && <Spinner small />}
		{children}
	</button>
)

export const Card = ({title, action, children, className}: {title?: ReactNode, action?: ReactNode, children: ReactNode, className?: string}) => (
	<section className={cx('rounded-lg border border-line bg-white p-5 shadow-sm', className)}>
		{(title || action) && (
			<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
				{title && <h2 className="text-base font-semibold">{title}</h2>}
				{action}
			</div>
		)}
		{children}
	</section>
)

type FieldProps = {label: string, hint?: ReactNode, error?: string, children: (id: string, describedBy?: string) => ReactNode}
export const Field = ({label, hint, error, children}: FieldProps) => {
	const id = useId()
	const hintId = hint ? `${id}-hint` : undefined
	const errorId = error ? `${id}-error` : undefined
	return (
		<div className="space-y-1">
			<label htmlFor={id} className="block text-sm font-medium">{label}</label>
			{children(id, [hintId, errorId].filter(Boolean).join(' ') || undefined)}
			{hint && <p id={hintId} className="text-xs text-muted">{hint}</p>}
			{error && <p id={errorId} className="text-xs text-bad">{error}</p>}
		</div>
	)
}

const inputClass = 'block w-full rounded-md border border-line bg-white px-3 py-2 text-sm disabled:bg-surface disabled:text-muted'
export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={cx(inputClass, props.className)} />
export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} className={cx(inputClass, props.className)} />
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={cx(inputClass, props.className)} />

// A dropdown of checkboxes for picking several values. Values not in
// `options` (from older free-text entries) are kept and listed first.
type MultiSelectProps = {id?: string, label: string, options: string[], value: string[], onChange: (value: string[]) => void, disabled?: boolean, max?: number, describedBy?: string}
export const MultiSelect = ({id, label, options, value, onChange, disabled, max, describedBy}: MultiSelectProps) => {
	const all = [...value.filter((v) => !options.includes(v)), ...options]
	const toggle = (option: string) => onChange(value.includes(option) ? value.filter((v) => v != option) : [...value, option])
	const ref = useRef<HTMLDetailsElement>(null)
	useEffect(() => {
		const close = (e: Event) => {
			const el = ref.current
			if (!el?.open) return
			if (e instanceof KeyboardEvent ? e.key == 'Escape' : !el.contains(e.target as Node)) el.open = false
		}
		document.addEventListener('mousedown', close)
		document.addEventListener('keydown', close)
		return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
	}, [])
	return (
		<details ref={ref} className="group relative">
			<summary id={id} aria-label={`${label}: ${value.length ? value.join(', ') : 'none chosen'}`} aria-describedby={describedBy} aria-disabled={disabled}
				className={cx(inputClass, 'cursor-pointer list-none truncate pr-8', disabled && 'pointer-events-none bg-surface text-muted')}>
				{value.length ? value.join(', ') : <span className="text-muted">Choose…</span>}
				<span aria-hidden className="absolute right-3 top-2 text-muted group-open:rotate-180">▾</span>
			</summary>
			<fieldset className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-white p-2 shadow-lg">
				<legend className="sr-only">{label}</legend>
				{all.map((option) => {
					const checked = value.includes(option)
					return (
						<label key={option} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface">
							<input type="checkbox" checked={checked} disabled={disabled || (!checked && max != null && value.length >= max)} onChange={() => toggle(option)} /> {option}
						</label>
					)
				})}
			</fieldset>
		</details>
	)
}

const tones = {
	neutral: 'bg-neutral-soft text-neutral-ink',
	good: 'bg-good-soft text-good',
	warn: 'bg-warn-soft text-warn',
	bad: 'bg-bad-soft text-bad',
	brand: 'bg-brand-soft text-brand',
}
export const Badge = ({tone = 'neutral', children}: {tone?: keyof typeof tones, children: ReactNode}) => (
	<span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>
)

export const Spinner = ({small}: {small?: boolean}) => (
	<span className={cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', small ? 'h-3.5 w-3.5' : 'h-6 w-6')} aria-hidden="true" />
)

export const Loading = ({label = 'Loading'}: {label?: string}) => (
	<div className="flex items-center gap-3 py-10 text-muted" role="status"><Spinner /> <span>{label}…</span></div>
)

export const ErrorBox = ({error, onRetry}: {error: unknown, onRetry?: () => void}) => {
	const message = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
	return (
		<div role="alert" className="rounded-md border border-bad/30 bg-bad-soft p-4 text-sm text-bad">
			<p>{message}</p>
			{onRetry && <button className="mt-2 font-medium underline" onClick={onRetry}>Try again</button>}
		</div>
	)
}

export const Notice = ({tone = 'brand', children}: {tone?: 'brand' | 'good' | 'warn', children: ReactNode}) => (
	<div role="status" className={cx('rounded-md p-3 text-sm', tone == 'good' && 'bg-good-soft text-good', tone == 'warn' && 'bg-warn-soft text-warn', tone == 'brand' && 'bg-brand-soft text-brand-dark')}>
		{children}
	</div>
)

export const Empty = ({title, children}: {title: string, children?: ReactNode}) => (
	<div className="rounded-lg border border-dashed border-line p-8 text-center">
		<p className="font-medium">{title}</p>
		{children && <div className="mt-1 text-sm text-muted">{children}</div>}
	</div>
)

export const Stat = ({label, value, sub}: {label: string, value: ReactNode, sub?: ReactNode}) => (
	<div className="rounded-md border border-line p-3">
		<p className="text-xs uppercase tracking-wide text-muted">{label}</p>
		<p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
		{sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
	</div>
)
