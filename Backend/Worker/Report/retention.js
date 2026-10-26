// Closed rows stay in the report for four weeks after they close, then drop
// out, so the sheet keeps recent reference rows without growing forever.
// A row closes on its closing date when it has one; otherwise on the first
// week it was reported Closed (carried forward as closed_since).
export const CLOSED_KEEP_DAYS = 28

const daysBefore = (isoDay, days) => new Date(Date.parse(isoDay) - days * 864e5).toISOString().slice(0, 10)

export const applyClosedRetention = (rows, {today, previousClosedSince = () => null, days = CLOSED_KEEP_DAYS}) => {
	const cutoff = daysBefore(today, days)
	return rows
		.map((row) => {
			if (row.status != 'Closed') return {...row, closed_since: null}
			const closedOn = row.closing_date && row.closing_date <= today ? row.closing_date : null
			return {...row, closed_since: closedOn ?? previousClosedSince(row) ?? today}
		})
		.filter((row) => row.status != 'Closed' || row.closed_since >= cutoff)
}
