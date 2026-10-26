import {useState} from 'react'
import {daysUntil, formatDate, money, type ServiceCost} from '../api'
import {Badge, Card, Stat} from './ui'

// BEH-012: what the programme pays to run the service. Brave and Azure can
// be billed in different currencies, so each gets its own chart (small
// multiples) rather than one stacked chart that would add unlike units.
export const CostCard = ({cost}: {cost: ServiceCost}) => {
	const azure = cost.azure && 'currency' in cost.azure ? cost.azure : null
	const model = cost.programmeModel
	// Shown while a free period is set, and afterwards while it has a cost to report.
	const showModel = model.freePeriodUntil != null || model.total > 0
	const daysToReview = daysUntil(cost.reviewDate)
	return (
		<Card
			title="Service cost (paid by the programme)"
			action={<span className="flex flex-wrap gap-2">
				<Badge tone={cost.searchEnabled ? 'good' : 'warn'}>{cost.searchEnabled ? '✓ Web search on' : '⏸ Web search off'}</Badge>
				<Badge tone={daysToReview <= 14 ? 'warn' : 'neutral'}>Review {formatDate(cost.reviewDate)}{daysToReview >= 0 ? ` (${daysToReview} days)` : ' (due)'}</Badge>
			</span>}
		>
			<div className={`grid gap-3 sm:grid-cols-2 ${showModel ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
				<Stat label="This week, combined" value={cost.combined ? money(cost.combined.week) : '—'}
					sub={cost.combined ? `${money(cost.combined.total)} since launch` : 'Shown when both are in the same currency'} />
				<Stat label="Brave search, latest week" value={money(cost.brave.week)}
					sub={[`${cost.brave.weekQueries} queries`,
						// An average only says something once more than one company ran.
						...(cost.brave.weekCompanies > 1 ? [`average ${cost.brave.averageQueriesPerCompany} (${money(cost.brave.averagePerCompany)}) per company`] : []),
						`${money(cost.brave.total)} since launch`].join(' · ')} />
				{showModel && <Stat label="AI model (free period), latest week" value={money(model.week)}
					sub={`${money(model.month)} of ${money(model.monthlyCapUsd)} this month · ${money(model.total)} since launch`} />}
				<Stat label="Azure hosting, last 7 days" value={azure ? money(azure.lastSevenDays, azure.currency) : '—'}
					sub={azure ? `${money(azure.total, azure.currency)} total · billed to ${formatDate(azure.collectedTo)}` : 'Not collected yet'} />
			</div>
			<p className="mt-3 text-xs text-muted">
				Brave queries this month: {cost.brave.monthQueries.toLocaleString('en-GB')} of {cost.brave.monthlyQueryCap.toLocaleString('en-GB')} cap.
				{model.freePeriodUntil
					? `The programme pays the AI model for every company until ${formatDate(model.freePeriodUntil)}; after that each company's own key is its own bill.`
					: "Model costs are each company's own bill and are not included."}
			</p>
			<div className={`mt-5 grid gap-6 sm:grid-cols-2 ${showModel ? 'lg:grid-cols-3' : ''}`}>
				<WeeklyBars title="Brave search per week" currency="USD" values={cost.weekly.map((w) => ({week: w.weekStart, value: w.braveUsd}))} />
				{showModel && <WeeklyBars title="AI model (free period) per week" currency="USD" values={cost.weekly.map((w) => ({week: w.weekStart, value: w.programmeModelUsd}))} />}
				<WeeklyBars title="Azure hosting per week" currency={azure?.currency ?? 'USD'} values={cost.weekly.map((w) => ({week: w.weekStart, value: w.azure}))} />
			</div>
			<details className="mt-4 text-sm">
				<summary className="cursor-pointer text-brand">Show as a table</summary>
				<table className="mt-2 w-full text-left tabular-nums">
					<thead className="text-xs uppercase text-muted"><tr><th scope="col" className="py-1">Week of</th><th scope="col">Brave</th>{showModel && <th scope="col">AI model</th>}<th scope="col">Azure</th></tr></thead>
					<tbody className="divide-y divide-line">
						{cost.weekly.map((w) => <tr key={w.weekStart}><td className="py-1">{formatDate(w.weekStart)}</td><td>{money(w.braveUsd)}</td>{showModel && <td>{money(w.programmeModelUsd)}</td>}<td>{money(w.azure, azure?.currency ?? 'USD')}</td></tr>)}
					</tbody>
				</table>
			</details>
		</Card>
	)
}

// One series, one hue; thin bars with 4px rounded tops anchored to the
// baseline, a 2px gap, and a hover tooltip with a hit target wider than the bar.
const WeeklyBars = ({title, currency, values}: {title: string, currency: string, values: {week: string, value: number}[]}) => {
	const [hover, setHover] = useState<number | null>(null)
	const width = 320, height = 110, pad = 18
	const max = Math.max(...values.map((v) => v.value), 0.01)
	const slot = width / values.length
	const bar = Math.max(4, slot - 2 - 8)
	return (
		<figure>
			<figcaption className="mb-1 text-xs font-medium text-muted">{title}</figcaption>
			<div className="relative">
				<svg viewBox={`0 0 ${width} ${height + pad}`} className="w-full" role="img" aria-label={`${title}, last ${values.length} weeks. Use the table for values.`}>
					<line x1="0" x2={width} y1={height} y2={height} stroke="var(--color-line)" strokeWidth="1" />
					{values.map((v, i) => {
						const h = v.value > 0 ? Math.max(2, (v.value / max) * (height - 8)) : 0
						const x = i * slot + (slot - bar) / 2
						const r = Math.min(4, bar / 2, h)
						return (
							<g key={v.week} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
								<rect x={i * slot} y="0" width={slot} height={height} fill="transparent" />
								{h > 0 && <path d={`M${x},${height} V${height - h + r} Q${x},${height - h} ${x + r},${height - h} H${x + bar - r} Q${x + bar},${height - h} ${x + bar},${height - h + r} V${height} Z`}
									fill="var(--color-brand)" opacity={hover == null || hover == i ? 1 : 0.45} />}
							</g>
						)
					})}
					<text x="0" y={height + 13} fontSize="10" fill="var(--color-muted)">{formatDate(values[0]?.week)}</text>
					<text x={width} y={height + 13} fontSize="10" fill="var(--color-muted)" textAnchor="end">{formatDate(values.at(-1)?.week)}</text>
				</svg>
				{hover != null && (
					<div className="pointer-events-none absolute -top-2 rounded border border-line bg-white px-2 py-1 text-xs shadow"
						style={{left: `${Math.min(75, (hover / values.length) * 100)}%`}}>
						<p className="text-muted">Week of {formatDate(values[hover].week)}</p>
						<p className="font-semibold tabular-nums">{money(values[hover].value, currency)}</p>
					</div>
				)}
			</div>
		</figure>
	)
}
