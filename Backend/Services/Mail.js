// Email through Azure Communication Services from thedatainnovationhub.com
// (DEC-010), signed in with the managed identity, so there is no mail key.
// Without ACS_EMAIL_ENDPOINT (local development) messages are logged by
// subject only and never sent. Addresses never appear in logs.
import {DefaultAzureCredential} from '@azure/identity'
import {EmailClient} from '@azure/communication-email'
import {logLine} from '../API/Library.js'

export const createAcsMailer = ({endpoint, sender, client = new EmailClient(endpoint, new DefaultAzureCredential())}) => ({
	kind: 'acs',
	send: async ({to, subject, text, html}) => {
		const poller = await client.beginSend({senderAddress: sender, content: {subject, plainText: text, html}, recipients: {to: [{address: to}]}})
		const result = await poller.pollUntilDone()
		if (result?.status != 'Succeeded') throw Object.assign(new Error('Email send failed'), {code: `ACS_${String(result?.status ?? 'unknown').toUpperCase()}`})
		logLine({event: 'mail_sent', subject})
		return {messageId: result.id}
	},
})

// Keeps what would have been sent, for local development and tests.
// DEV_PRINT_MAIL=1 prints each message's text (sign-in links included) to the
// console, so local sign-in works without an email service. Development only.
export const createOutboxMailer = ({environment = process.env.NODE_ENV, print = process.env.DEV_PRINT_MAIL == '1'} = {}) => {
	if (environment == 'production') throw new Error('The outbox mailer cannot be used in production')
	const outbox = []
	return {
		kind: 'outbox',
		outbox,
		send: async (message) => {
			outbox.push(message)
			logLine({event: 'mail_not_sent_dev', subject: message.subject})
			if (print) console.log(`\n--- dev mail (not sent) ---\n${message.subject}\n${message.text}\n---------------------------\n`)
			return {messageId: `dev-${outbox.length}`}
		},
	}
}

export const createMailer = (env = process.env) => env.ACS_EMAIL_ENDPOINT
	? createAcsMailer({endpoint: env.ACS_EMAIL_ENDPOINT, sender: env.MAIL_SENDER ?? 'DoNotReply@thedatainnovationhub.com'})
	: createOutboxMailer({environment: env.NODE_ENV})

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c])

export const signInEmail = ({link, minutes}) => ({
	subject: 'Your Opportunity Finder sign-in link',
	text: `Use this link to sign in to Opportunity Finder. It works once and expires in ${minutes} minutes.\n\n${link}\n\nIf you did not ask to sign in, you can ignore this email.`,
	html: `<p>Use this link to sign in to Opportunity Finder. It works once and expires in ${minutes} minutes.</p><p><a href="${escapeHtml(link)}">Sign in</a></p><p>If you did not ask to sign in, you can ignore this email.</p>`,
})

export const invitationEmail = ({link, companyName, days}) => ({
	subject: `You have been invited to Opportunity Finder for ${companyName}`,
	text: `You have been invited to see ${companyName}'s weekly funding and tender reports in Opportunity Finder.\n\nAccept the invitation (the link works once and expires in ${days} days):\n\n${link}`,
	html: `<p>You have been invited to see ${escapeHtml(companyName)}'s weekly funding and tender reports in Opportunity Finder.</p><p><a href="${escapeHtml(link)}">Accept the invitation</a> (the link works once and expires in ${days} days).</p>`,
})

const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'})
const freePeriodNotice = (until) => `The programme is covering the AI cost of these reports until ${longDate(until)}. To keep receiving them after that, a company admin chooses a plan in Settings: a subscription at £30 a month, or your own AI provider key with a £10 a month platform fee (prices exclude VAT). Choosing now costs nothing until then.`

// DEC-015: a Connected Health Cluster company's first report is free; later ones need a plan.
const planNeededNotice = 'Connected Health Cluster members get their first report free. To keep receiving a report every week, a company admin chooses a plan in Settings: a subscription at £30 a month, or your own AI provider key with a £10 a month platform fee (prices exclude VAT).'

export const weeklyReportEmail = ({companyName, link, fundingRows, tenderRows, newThisWeek, topFive, freePeriodEnds = null, planNeeded = false, settingsLink}) => {
	const notice = freePeriodEnds ? freePeriodNotice(freePeriodEnds) : planNeeded ? planNeededNotice : null
	return {
		subject: `${companyName}: this week's funding and tenders (${newThisWeek} new)`,
		text: [`This week's report for ${companyName} is ready: ${fundingRows} funding opportunities and ${tenderRows} tenders, ${newThisWeek} new this week.`,
			'', 'Top 5:', ...topFive.map((t, i) => `${i + 1}. ${t.name}`), '', `View and download it here: ${link}`,
			...(notice ? ['', notice, `Settings: ${settingsLink}`] : [])].join('\n'),
		html: `<p>This week's report for ${escapeHtml(companyName)} is ready: ${fundingRows} funding opportunities and ${tenderRows} tenders, <strong>${newThisWeek} new this week</strong>.</p>`
			+ `<p>Top 5:</p><ol>${topFive.map((t) => `<li>${escapeHtml(t.name)}</li>`).join('')}</ol><p><a href="${escapeHtml(link)}">View and download the report</a></p>`
			+ (notice ? `<p>${escapeHtml(notice)} <a href="${escapeHtml(settingsLink)}">Open Settings</a></p>` : ''),
	}
}
