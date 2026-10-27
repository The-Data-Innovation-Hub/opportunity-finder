# DEC-014: subscription pricing (27 Oct 2026)

From 1 Feb 2027, when the free period ends, each company either subscribes, so the programme keeps paying for the AI and the company pays the programme, or adds its own AI key and pays a platform fee.

## Decided (Brendan, 27 Oct 2026)

| | Decision |
|---|---|
| Subscription | £30 a month or £300 a year |
| Own-key platform fee | £10 a month or £100 a year |
| AI overage | No per-company cap: the programme absorbs it. The programme-wide monthly cap (DEC-011, US$100 today) must rise with the number of subscribers, about US$30 each |
| Payment | Stripe card checkout, bought by a company admin; opens with the notice on 3 Jan 2027, charges from 1 Feb 2027 |
| Sponsors | No sponsor-bought places to start |
| VAT | The Data Innovation Hub is UK VAT registered: prices exclude VAT; 20% added for UK customers; Irish business customers reverse-charged on their VAT number (confirm with the accountant) |
| Neither | Runs pause, as for a missing key today; past reports stay readable |
| Still open | The Stripe account (Brendan) |

The options considered are kept below.

## What one company costs us

Measured costs, not list prices. US dollars are converted at **$1 = £0.75**, an assumption to check before setting a price.

| Cost | Basis | Per company per month |
|---|---|---|
| AI model (Claude Sonnet 5.5) | Weekly runs measured at $3.09 (Azure, 26 Oct), $3.97 and $4.32 (trials); EU calls add about $0.30. Range $3.10–$4.60 a week × 4.35 weeks | **£10–£15** |
| Web searches (Brave) | About 35 queries a run at $5 per 1,000 | £0.60 |
| Email, storage | Measured on Azure | under £0.10 |
| **Direct cost per company** | | **£11–£16** |

The platform itself also costs **about £33 a month**, whether there are 0 companies or 50. That covers Container Apps, Postgres, the container registry and Key Vault, at about £1.08 a day measured on Azure for 25–26 Oct. Its share per subscriber is about £6.60 with 5 subscribers, £3.30 with 10 and £1.65 with 20.

A company on its own key costs us only its share of that £33. It pays its AI provider about $14–$20 (£10–£15) a month directly.

## Options

All prices exclude VAT.

### A. Cost recovery: £20 a month
- **Margin:** about £1 per subscriber in the worst case at 10 subscribers. A price rise or a heavier profile turns that into a loss.
- **Best for:** a programme that wants no margin at all.
- **Risk:** it doesn't cover the platform cost if few companies subscribe.

### B. Standard: £30 a month, or £300 a year (two months free)
- **AI spend cap:** $30 (about £22.50) a month per company, about 50% above a typical month. If a company reaches it, the rest of its runs that month are skipped and it gets an email; runs start again on the 1st. That's the same behaviour as the programme cap today.
- **Margin:** about £11 per subscriber in the worst case at 10 subscribers (37%). Even a company at its cap still covers its costs: about £26.40.
- **Best for:** a simple single price that pays for the platform once there are about 3 subscribers.

### C. Priced by region scope
- **Prices:** £25 a month for UK only, or for Ireland and NI only (two search passes); £35 a month for UK and Ireland (three passes). Same cap rule as B: $25 and $35.
- **Fairer:** companies pay for what they use.
- **Downsides:**
  - the cost per pass is an estimate, not measured;
  - a company that changes its scope changes price;
  - more to explain and to build.

### D. The programme or a sponsor buys places
- **How it works:** an annual invoice for a group of companies, for example £300 per company per year at B's price. The companies themselves pay nothing and see no paywall.
- **Answers "who buys":** a funder or accelerator can cover a cohort.
- **Can be combined:** it works alongside B, as the same subscription with a different payer.

## How companies pay

| | Invoice (first) | Card checkout (later) |
|---|---|---|
| **How it works** | You invoice the company or sponsor. An admin then sets "Subscribed until" on the company in the Admin page | The company admin pays by card on a hosted checkout page (e.g. Stripe). Renewals and failed payments are automatic |
| **Build** | Small. It reuses the free-period machinery: a date and a cap per company instead of one for everyone | Larger: checkout, payment webhooks, a billing page, VAT numbers, failed-payment handling |
| **Fees** | None from us | About 1.5% + 20p per payment, plus about 0.7% for subscription billing (Stripe UK; check current rates): about £0.90 on £30 |
| **Suits** | Up to about 15 subscribers, and annual or sponsored places | Many subscribers paying monthly |

**VAT** depends on whether The Data Innovation Hub is VAT registered. If it is, UK customers would pay 20% on top. Irish business customers would usually be reverse-charged and need to give their VAT number. Confirm with your accountant before publishing prices.

## A company that does neither

Its weekly runs pause, as they do today for a company with no working key. It can still sign in, read past reports and download them. The Admin page shows it as paused for want of a subscription or key. It restarts the week after it subscribes or adds a key.

## Recommendation

- **Price:** option B, £30 a month or £300 a year, with a $30 monthly AI cap per company.
- **Payment:** start with invoices, since that's the smallest build and works for both monthly and annual. Allow option D (a sponsor buys places) through the same invoice route.
- **Card checkout:** add it only if more than about 15 companies subscribe.
- **Own-key companies:** they stay free.

## Decisions needed from Brendan

1. Price, and whether to offer an annual option (B, or another figure).
2. The per-company AI cap, and whether reaching it skips runs (as proposed) or you absorb the overage.
3. Invoice first, or card checkout from the start.
4. Whether sponsors can buy places (D).
5. VAT registration status.
6. Whether own-key companies stay free or pay a small platform fee towards the £33 a month.

Once these are settled, the next steps are:
- wording for the 3 Jan 2027 notice and email, which must offer both choices;
- the build, on the requirements dashboard.
