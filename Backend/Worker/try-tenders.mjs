// Free check: fetch a week of tender notices and show the shortlist (no Claude call).
import fs from 'node:fs'
import {fetchTenderNotices, shortlistTenders} from './Sources/ocds.js'
const profile = JSON.parse(fs.readFileSync(new URL('./Profiles/trial-care-routing.json', import.meta.url)))
const to = new Date(); const from = new Date(to.getTime() - 7 * 864e5)
const iso = (d) => d.toISOString().slice(0, 19)
const notices = await fetchTenderNotices({from: iso(from), to: iso(to), log: console.log})
const shortlist = shortlistTenders(notices, profile, {today: to.toISOString().slice(0, 10)})
console.log(`${notices.length} notices, ${shortlist.length} shortlisted`)
for (const n of shortlist.slice(0, 25)) console.log(`- [${n.portal}] ${n.title.slice(0, 80)} | ${n.buyer?.slice(0, 40)} | closes ${n.closing_date}`)
