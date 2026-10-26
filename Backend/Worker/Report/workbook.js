// Builds the weekly report workbook. The layout copies the sample report
// Care_Software_Funding_2026-10-21.xlsx (BEH-004): sheet names, column order
// and widths, the dark-blue header, 10pt Arial wrapped body, dd mmm yyyy dates,
// the live Days-left formula, frozen header, autofilter and the four
// conditional-formatting rules. A Tenders sheet follows the same conventions.
import ExcelJS from 'exceljs'

const HEADER_FILL = 'FF1F4E78'
const AMBER = 'FFFFC000'
const GREY = 'FFD9D9D9'
const GREEN = 'FFC6EFCE'
const YELLOW = 'FFFFEB9C'
const LINK = 'FF0563C1'
const DATE_FORMAT = 'dd\\ mmm\\ yyyy'
const THIN = {style: 'thin'}
const BORDER = {top: THIN, left: THIN, bottom: THIN, right: THIN}

const FUNDING_COLUMNS = [
	['Fund', 34], ['Funder', 24], ['Source group', 15], ['Type', 16], ['Amount', 30],
	['Match funding / intervention rate', 26], ['Closing date', 13], ['Days left', 10],
	['Status', 13], ['New this week', 10], ['Why it fits', 45], ['Eligibility notes', 50],
	['Website', 40], ['Email', 28], ['Phone', 22], ['Next step', 40],
]

// Same shape as Funding so the Days-left formula and highlighting rules carry
// over unchanged: G closing date, H days left, I status, J new this week.
const TENDER_COLUMNS = [
	['Tender', 34], ['Buyer', 24], ['Portal', 15], ['Notice type', 16], ['Contract value', 30],
	['Location / lots', 26], ['Closing date', 13], ['Days left', 10],
	['Status', 13], ['New this week', 10], ['Why it fits', 45], ['Requirements and eligibility', 50],
	['Notice link', 40], ['Contact email', 28], ['Reference', 22], ['Next step', 40],
]

const TOP5_COLUMNS = [
	['Rank', 6], ['Fund', 38], ["Why it's a top pick", 55], ['Amount', 28], ['Deadline', 14],
	['Practical steps to apply', 70],
]

const STATUS_ORDER = {'Open': 0, 'Rolling': 1, 'Opening soon': 2, 'Closed': 3}

// Sample order: Open by closing date (soonest first), then Rolling, then
// Opening soon, then Closed with the most recently closed first and undated last.
export const sortRows = (rows) => [...rows].sort((a, b) => {
	const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
	if (byStatus != 0) return byStatus
	const da = a.closing_date ?? null
	const db = b.closing_date ?? null
	if (da == db) return 0
	if (da == null) return 1
	if (db == null) return -1
	return a.status == 'Closed' ? db.localeCompare(da) : da.localeCompare(db)
})

const toDate = (iso) => {
	if (!iso) return null
	const [y, m, d] = iso.split('-').map(Number)
	return new Date(Date.UTC(y, m - 1, d))
}

const styleHeader = (sheet, columns, {wrap}) => {
	sheet.columns = columns.map(([header, width]) => ({header, width}))
	const row = sheet.getRow(1)
	row.eachCell((cell) => {
		cell.font = {bold: true, color: {argb: 'FFFFFFFF'}, size: 11, name: 'Arial'}
		cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: HEADER_FILL}}
		cell.alignment = wrap ? {wrapText: true, vertical: 'middle'} : {vertical: 'bottom'}
		if (wrap) cell.border = BORDER
	})
}

const styleBody = (row, {wrap}) => {
	row.eachCell({includeEmpty: true}, (cell) => {
		cell.font = {...(cell.font ?? {}), size: 10, name: 'Arial'}
		cell.alignment = wrap ? {wrapText: true, vertical: 'top'} : {vertical: 'bottom'}
		if (wrap) cell.border = BORDER
	})
}

// Model output: only http(s) URLs become hyperlinks (no file:, UNC or
// javascript: links in a spreadsheet someone will click).
const setLink = (cell, url) => {
	if (!url) return
	if (!/^https?:\/\//i.test(url)) {
		cell.value = String(url)
		return
	}
	cell.value = {text: url, hyperlink: url}
	cell.font = {underline: true, color: {argb: LINK}, size: 10, name: 'Arial'}
}

const daysLeftFormula = (r) => `IF(I${r}="Closed","Closed",IF(G${r}="","",IF(G${r}<TODAY(),"Closed",G${r}-TODAY())))`

const addOpportunitySheet = (workbook, name, columns, rows, toCells, footNote) => {
	const sheet = workbook.addWorksheet(name, {views: [{state: 'frozen', ySplit: 1}]})
	styleHeader(sheet, columns, {wrap: true})
	sheet.getRow(1).height = 39.55
	const sorted = sortRows(rows)
	sorted.forEach((item, i) => {
		const r = i + 2
		const cells = toCells(item)
		const row = sheet.getRow(r)
		cells.forEach((value, c) => { row.getCell(c + 1).value = value ?? null })
		row.getCell(7).value = toDate(item.closing_date)
		row.getCell(7).numFmt = DATE_FORMAT
		row.getCell(8).value = {formula: daysLeftFormula(r)}
		row.getCell(8).numFmt = '0'
		row.getCell(10).value = item.new_this_week ? 'Yes' : 'No'
		styleBody(row, {wrap: true})
		row.getCell(8).alignment = {vertical: 'top'}
		setLink(row.getCell(13), item.website)
		const email = row.getCell(14).value
		if (typeof email == 'string' && /^[^\s@]+@[^\s@]+$/.test(email)) {
			row.getCell(14).value = {text: email, hyperlink: `mailto:${email}`}
			row.getCell(14).font = {underline: true, color: {argb: LINK}, size: 10, name: 'Arial'}
		}
	})
	const last = sorted.length + 1
	if (sorted.length > 0) {
		sheet.autoFilter = {from: 'A1', to: {row: last, column: columns.length}}
		const all = `A2:P${last}`
		const status = `I2:I${last}`
		const fill = (argb) => ({fill: {type: 'pattern', pattern: 'solid', bgColor: {argb}}})
		sheet.addConditionalFormatting({ref: all, rules: [
			{type: 'expression', priority: 1, formulae: ['AND(ISNUMBER($H2),$H2<=30)'], style: fill(AMBER)},
			{type: 'expression', priority: 2, formulae: ['$I2="Closed"'], style: fill(GREY)},
		]})
		sheet.addConditionalFormatting({ref: status, rules: [
			{type: 'expression', priority: 3, formulae: ['OR($I2="Open",$I2="Rolling")'], style: fill(GREEN)},
			{type: 'expression', priority: 4, formulae: ['$I2="Opening soon"'], style: fill(YELLOW)},
		]})
	}
	if (footNote) {
		const note = sheet.getRow(last + 2)
		note.getCell(1).value = footNote
		note.getCell(1).font = {italic: true, size: 10, name: 'Arial'}
	}
	return sheet
}

const REGION_LABEL = {NI: 'Northern Ireland', IE: 'Ireland', UK: 'United Kingdom'}

// notIncluded: every named scheme and Innovate UK competition that was
// checked this week but has no row, with the reason (BEH-014).
export const buildWorkbook = ({preparedOn, funding, tenders, topFive, sources, note, notIncluded = []}) => {
	const workbook = new ExcelJS.Workbook()
	workbook.created = new Date(`${preparedOn}T00:00:00Z`)

	addOpportunitySheet(workbook, 'Funding', FUNDING_COLUMNS, funding, (f) => [
		f.fund, f.funder, f.source_group, f.type, f.amount, f.match_funding, null, null,
		f.status, null, f.why_it_fits, f.eligibility_notes, null, f.email, f.phone, f.next_step,
	], note)

	addOpportunitySheet(workbook, 'Tenders', TENDER_COLUMNS, tenders, (t) => [
		t.title, t.buyer, t.portal, t.notice_type, t.value, t.location, null, null,
		t.status, null, t.why_it_fits, t.requirements, null, t.contact_email, t.reference, t.next_step,
	], tenders.length == 0 ? 'No open tenders matched this profile this week.' : null)

	const top = workbook.addWorksheet('Top 5 this week', {views: [{state: 'frozen', ySplit: 1}]})
	styleHeader(top, TOP5_COLUMNS, {wrap: true})
	topFive.forEach((t, i) => {
		const row = top.getRow(i + 2)
		row.values = [t.rank, t.name, t.why_top_pick, t.amount, t.deadline ? toDate(t.deadline) : 'Rolling', t.practical_steps]
		row.getCell(5).numFmt = DATE_FORMAT
		styleBody(row, {wrap: true})
	})

	const also = workbook.addWorksheet('Also checked', {views: [{state: 'frozen', ySplit: 1}]})
	styleHeader(also, [['Scheme or competition', 50], ['Region', 18], ['Why it is not in the report', 70]], {wrap: true})
	const sortedAlso = [...notIncluded].sort((a, b) => (a.region ?? '').localeCompare(b.region ?? '') || a.name.localeCompare(b.name))
	sortedAlso.forEach((n, i) => {
		const row = also.getRow(i + 2)
		row.values = [n.name, REGION_LABEL[n.region] ?? n.region ?? '', n.reason]
		styleBody(row, {wrap: true})
	})
	if (sortedAlso.length) also.autoFilter = {from: 'A1', to: 'C1'}
	const alsoNote = also.getRow(sortedAlso.length + 3).getCell(1)
	alsoNote.value = 'Named schemes and Innovate UK competitions reviewed this week that were left out, with the reason. If you think one applies to you, check its page or contact the funder.'
	alsoNote.font = {italic: true, size: 10, name: 'Arial'}

	const src = workbook.addWorksheet('Sources')
	styleHeader(src, [['#', 5], ['URL', 120]], {wrap: false})
	sources.filter((url) => /^https?:\/\//i.test(url)).forEach((url, i) => {
		const row = src.getRow(i + 2)
		row.getCell(1).value = i + 1
		setLink(row.getCell(2), url)
		styleBody(row, {wrap: false})
	})

	return workbook
}
