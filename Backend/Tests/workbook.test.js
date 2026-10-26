// BEH-004: the generated workbook keeps the sample report's layout.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ExcelJS from 'exceljs'
import {buildWorkbook, sortRows} from '../Worker/Report/workbook.js'

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/sample-report.json', import.meta.url)))

const roundTrip = async (data) => {
	const book = new ExcelJS.Workbook()
	await book.xlsx.load(await buildWorkbook(data).xlsx.writeBuffer())
	return book
}

test('BEH-004 sheets and Funding columns match the sample', async () => {
	const book = await roundTrip(sample)
	assert.deepEqual(book.worksheets.map((s) => s.name), ['Funding', 'Tenders', 'Top 5 this week', 'Also checked', 'Sources'])
	const header = book.getWorksheet('Funding').getRow(1).values.slice(1)
	assert.deepEqual(header, ['Fund', 'Funder', 'Source group', 'Type', 'Amount', 'Match funding / intervention rate',
		'Closing date', 'Days left', 'Status', 'New this week', 'Why it fits', 'Eligibility notes', 'Website', 'Email', 'Phone', 'Next step'])
})

test('BEH-004 Days left is a live formula and dates use dd mmm yyyy', async () => {
	const sheet = (await roundTrip(sample)).getWorksheet('Funding')
	assert.equal(sheet.getCell('H2').formula, 'IF(I2="Closed","Closed",IF(G2="","",IF(G2<TODAY(),"Closed",G2-TODAY())))')
	assert.equal(sheet.getCell('G2').numFmt.replaceAll('\\', ''), 'dd mmm yyyy')
	assert.equal(sheet.getCell('A1').fill.fgColor.argb, 'FF1F4E78')
})

test('BEH-004 rows follow the sample order: Open by date, Rolling, Opening soon, Closed newest first', () => {
	const rows = sortRows([
		{status: 'Closed', closing_date: '2026-01-01'}, {status: 'Rolling', closing_date: null},
		{status: 'Open', closing_date: '2026-12-01'}, {status: 'Closed', closing_date: '2026-09-01'},
		{status: 'Opening soon', closing_date: null}, {status: 'Open', closing_date: '2026-11-01'},
		{status: 'Closed', closing_date: null},
	])
	assert.deepEqual(rows.map((r) => `${r.status} ${r.closing_date}`), [
		'Open 2026-11-01', 'Open 2026-12-01', 'Rolling null', 'Opening soon null',
		'Closed 2026-09-01', 'Closed 2026-01-01', 'Closed null',
	])
})

test('BEH-004 Sources sheet lists only web addresses', async () => {
	const sheet = (await roundTrip({...sample, sources: ['https://a.example/x', 'Notes: not a URL']})).getWorksheet('Sources')
	assert.equal(sheet.getCell('B2').text, 'https://a.example/x')
	assert.equal(sheet.getCell('B3').value, null)
})

test('BEH-014 Also checked lists each left-out scheme with its region and reason', async () => {
	const book = await roundTrip({...sample, notIncluded: [
		{name: 'Seedcorn Investor Readiness Competition', region: 'NI', reason: 'Closed this year; reopens 2027'},
		{name: 'Battery Innovation: Feasibility Studies Rd 3', region: 'UK', reason: 'Battery technology only'},
	]})
	const sheet = book.getWorksheet('Also checked')
	assert.deepEqual(sheet.getRow(1).values.slice(1), ['Scheme or competition', 'Region', 'Why it is not in the report'])
	assert.deepEqual(sheet.getRow(2).values.slice(1), ['Seedcorn Investor Readiness Competition', 'Northern Ireland', 'Closed this year; reopens 2027'])
	assert.equal(sheet.getRow(3).getCell(2).value, 'United Kingdom')
})

test('BEH-004 a website that is not http(s) is shown as text, never a hyperlink', async () => {
	const funding = [{...sample.funding[0], website: 'file:///C:/Windows/System32/calc.exe'}, ...sample.funding.slice(1)]
	const sheet = (await roundTrip({...sample, funding})).getWorksheet('Funding')
	const cells = []
	sheet.eachRow((row, n) => { if (n > 1) cells.push(row.getCell(13).value) })
	assert.ok(cells.includes('file:///C:/Windows/System32/calc.exe'))
	assert.ok(cells.every((v) => typeof v != 'object' || v == null || /^https?:/.test(v.hyperlink)))
})
