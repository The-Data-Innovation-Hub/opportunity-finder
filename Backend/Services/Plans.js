// DEC-014: the paid plans a company chooses from when the free period ends.
// Prices are in pence, excluding VAT; Stripe holds the prices charged, and
// these must match them (Infra/DEPLOYMENT.md, "Billing"), as must the
// notice wording in Services/Mail.js and src/components/Layout.tsx.
export const PLAN_PRICES = {
	subscription: {month: 3000, year: 30000},
	own_key: {month: 1000, year: 10000},
}
export const PLANS = Object.keys(PLAN_PRICES)
export const INTERVALS = ['month', 'year']

// Stripe subscription statuses that keep a company's runs going. past_due
// covers the days Stripe retries a failed card payment.
export const LIVE_PLAN_STATUSES = ['trialing', 'active', 'past_due']

// The end-of-free-period notice starts this many days before the end, and
// checkout opens with it.
export const FREE_PERIOD_NOTICE_DAYS = 28
