# Deploying Opportunity Finder to Azure

First deployed 24 to 26 Oct 2026 by following these steps. Each step changes Azure, so run them from your own terminal, signed in with `az login`, in order. Every step can be run again safely.

- Run every step in the **same terminal tab**: later steps use `POSTGRES_ADMIN_PASSWORD` and the role passwords set in it. Commands sent from elsewhere run in a fresh shell without them.
- Every `az` command below names the Data Innovation Hub subscription (`7f4b2261-9d3d-454a-97b8-132f44da56f2`) with `--subscription`. Keep it on any command you add: there are two subscriptions with the same name, and the CLI default is shared by every terminal and has changed mid-session.
- A redeploy needs `POSTGRES_ADMIN_PASSWORD` set to the **same** password; a different value changes the server's admin password. Test it first: `PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" psql "host=<postgresHost> dbname=opportunity_finder user=ofadmin sslmode=verify-full sslrootcert=system" -Atc "SELECT 1"`.

## What gets created

| Resource | Purpose |
|---|---|
| Container App `ca-oppfinder-api` | API and the built frontend, one replica, public HTTPS at `opportunities.thedatainnovationhub.com` (step 9) |
| Container App `ca-oppfinder-scraper` | Funder-page and listing scraper, internal only, scales to zero |
| Container Apps jobs `weekly`, `first-reports`, `emails`, `cleanup`, `azure-cost` | Scheduled work (times below) |
| Container Apps job `migrate` | Run by hand before a new image goes live |
| PostgreSQL Flexible Server (B1ms, PG 16) | Database `opportunity_finder`, 14-day backups |
| Key Vault `kv-…-app-…` | Platform secrets: database URLs, Brave key |
| Key Vault `kv-…-keys-…` | Company LLM keys only (SEC-002), audit-logged |
| Storage account, container `reports` | Private xlsx reports and weekly gathers; no public access, no account keys |
| Communication Services + Email | Mail from `no-reply@thedatainnovationhub.com` (DEC-010) |
| Container registry (Basic) | Images |
| Three managed identities | `api`, `worker`, `migrate`; each has only its own roles |

Schedules are in UTC because Container Apps jobs have no time zone:

| Job | Cron (UTC) | UK time |
|---|---|---|
| weekly | `0 22 * * 0` | Sunday 22:00 GMT, 23:00 BST |
| first-reports | `*/15 * * * *` | every 15 minutes; a new company's first report and email (Monday to Saturday), otherwise exits at once |
| emails | `0 7 * * 1` | Monday 07:00 GMT, 08:00 BST |
| cleanup | `0 3 * * *` | daily |
| azure-cost | `0 5 * * *` | daily |

## 1. Infrastructure (no apps yet)

```bash
az group create --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -n rg-opportunity-finder -l uksouth
```

```bash
cp Infra/main.bicepparam.example Infra/main.bicepparam
```

Choose a strong Postgres admin password and export it in the same shell (it is never written to a file):

```bash
read -s POSTGRES_ADMIN_PASSWORD && export POSTGRES_ADMIN_PASSWORD
```

```bash
az deployment group create --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder -n main -f Infra/main.bicep -p Infra/main.bicepparam
```

## 2. Email domain

The deploy creates the email domain; add the records it needs at your DNS provider (GoDaddy for thedatainnovationhub.com). Read them with:

```bash
az communication email domain show --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder --email-service-name email-oppfinder -n thedatainnovationhub.com --query verificationRecords -o json
```

Add the `Domain` TXT record (as a new TXT record at `@`, alongside the others) and both DKIM CNAMEs (`selector1-…` and `selector2-…`). Azure checks SPF for `include:spf.protection.outlook.com`, which the domain's Microsoft 365 SPF record already has, so the SPF record usually needs no change. If it ever does, **merge** into the one existing record rather than adding a second; two SPF records make both fail.

Add the step 9 records (`opportunities` CNAME and `asuid.opportunities` TXT) at the same time, so DNS is done in one sitting. GoDaddy can take several minutes to publish a saved record.

When the records resolve, start the checks:

```bash
for t in Domain SPF DKIM DKIM2; do az communication email domain initiate-verification --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder --email-service-name email-oppfinder --domain-name thedatainnovationhub.com --verification-type $t; done
```

When all four show **Verified** (`--query verificationStates` on the show command above), set `linkEmailDomain = true` in `Infra/main.bicepparam` and deploy again. Azure refuses to link the domain until every check, DKIM2 included, has passed.

## 3. Database

From the repo root, in the same terminal as step 1 (it holds `POSTGRES_ADMIN_PASSWORD`). Keep this terminal open until step 4 is done: the runtime role passwords below exist only in it.

Let your machine through the server firewall:

```bash
MYIP=$(curl -s https://api.ipify.org) && az postgres flexible-server firewall-rule create --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder --name <postgresServerName> --rule-name admin-laptop --start-ip-address $MYIP --end-ip-address $MYIP -o table
```

Two forms of the admin URL, both verifying the server certificate: Node's driver reads `sslrootcert` as a file path, so it gets plain `verify-full` (checked against Node's built-in roots); psql gets `sslrootcert=system`.

```bash
export ADMIN_URL="postgresql://ofadmin:${POSTGRES_ADMIN_PASSWORD}@<postgresHost>:5432/opportunity_finder?sslmode=verify-full" && export ADMIN_PSQL_URL="${ADMIN_URL}&sslrootcert=system"
```

```bash
cd Backend && OPPORTUNITY_FINDER_DATABASE_URL="$ADMIN_URL" node Database/Migrate.js && OPPORTUNITY_FINDER_DATABASE_URL="$ADMIN_URL" node Database/Seeds/approvedModels.js; cd ..
```

Generate the runtime role passwords in the shell (never shown or typed), then create the roles. Do not regenerate them before step 4: `database-roles.sql` only sets a password when it creates the role.

```bash
API_DB_PASSWORD=$(openssl rand -hex 24) && WORKER_DB_PASSWORD=$(openssl rand -hex 24) && echo ok
```

```bash
psql "$ADMIN_PSQL_URL" -v api_password="$API_DB_PASSWORD" -v worker_password="$WORKER_DB_PASSWORD" -f Infra/database-roles.sql
```

## 4. Secrets

The vaults use Azure RBAC, and subscription Owner does not include secret access. Give yourself write access to the app vault only:

```bash
az role assignment create --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --assignee-object-id $(az ad signed-in-user show --query id -o tsv) --assignee-principal-type User --role "Key Vault Secrets Officer" --scope $(az keyvault show --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -n <appVaultName> --query id -o tsv) -o none && echo ok
```

Then, in the step 3 terminal, store the database URLs from the passwords already in the shell:

```bash
PGH=<postgresHost>; V=<appVaultName>; az keyvault secret set --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --vault-name $V -n database-url --value "postgresql://of_api:${API_DB_PASSWORD}@${PGH}:5432/opportunity_finder?sslmode=verify-full" -o none && az keyvault secret set --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --vault-name $V -n worker-database-url --value "postgresql://of_worker:${WORKER_DB_PASSWORD}@${PGH}:5432/opportunity_finder?sslmode=verify-full" -o none && az keyvault secret set --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --vault-name $V -n migrate-database-url --value "$ADMIN_URL" -o none && echo ok
```

```bash
az keyvault secret set --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --vault-name <appVaultName> -n scraper-shared-secret --value "$(openssl rand -hex 32)" -o none && echo ok
```

The Brave key is pasted at a hidden prompt. Paste it in one go and press Enter once (a line break in the paste stores a cut-off key); a Brave key is 31 characters:

```bash
read -s BRAVE && az keyvault secret set --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --vault-name <appVaultName> -n brave-search-api-key --value "$BRAVE" -o none && unset BRAVE && echo ok
```

## 5. Roles

```bash
Infra/grant-roles.sh 7f4b2261-9d3d-454a-97b8-132f44da56f2 rg-opportunity-finder
```

It creates two custom roles; a new custom role can take a few minutes to become assignable, so the script retries and stops with `FAILED` if it runs out. Re-running is safe.

## 6. Images and apps

`az acr build` uploads the build context; `.dockerignore` keeps out every `.env`, `node_modules`, `Backend/Output`, trial profiles, `Infra` and `Requirements`. Use one tag for both images:

```bash
TAG=$(date +%Y%m%d%H%M) && az acr build --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -r <registryName> -t opportunity-finder:$TAG . && az acr build --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -r <registryName> -t scraper:$TAG scraper && echo $TAG
```

Set `deployApps = true`, and `appImage` and `scraperImage` to the full references (`<registryServer>/opportunity-finder:<tag>`, `<registryServer>/scraper:<tag>`) in `Infra/main.bicepparam`, then deploy again (step 1 terminal):

```bash
az deployment group create --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder -n main -f Infra/main.bicep -p Infra/main.bicepparam
```

Check `https://<appDefaultHost>/ready` returns `{"ok":true}` (the API reaches the database).

## 7. First programme admin

```bash
psql "$ADMIN_PSQL_URL" -c "WITH u AS (INSERT INTO app_user (email) VALUES ('you@thedatainnovationhub.com') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id) INSERT INTO programme_admin (user_id) SELECT id FROM u ON CONFLICT DO NOTHING"
```

Then sign in at the app URL (needs step 2's email link). Companies and their users are added from the Programme admin page.

## 8. Free period (DEC-011)

1. In the Anthropic console, create a workspace just for Opportunity Finder, set its monthly spend limit, and create an API key in it. Do not reuse the Parentalk key.
2. Sign in as a programme admin. Under **Free period**, choose **Add key** and paste it. It is checked with a free call, stored in the keys vault, and never shown again.
3. Set **Free until** (for three months from launch, the last Sunday you want covered) and the **Monthly AI spend cap**. About US$4 per company per week at today's usage.

Companies are told from four weeks before the end. After the end date, each company's runs follow its plan (step 11, DEC-014): a subscriber stays on the programme key, an own-key company uses its key, and a company with neither is paused. Clearing **Free until** ends the free period from the next company run (a run already under way finishes on the programme key).

When the workspace's spend limit is reached, runs are meant to be marked "programme key not working" rather than retried. The worker recognises Anthropic's "credit balance" message for certain; the spend-limit wording it matches ("usage limits") has not been checked against a real limit, so watch the first time the limit is hit.

## 9. Custom domain: opportunities.thedatainnovationhub.com (DEC-012)

Until this step the app answers on its Container Apps address (`appUrl` output), and sign-in links use that address. They keep working afterwards.

1. Read the two values the DNS records need:

```bash
az deployment group show --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder -n main --query "{host: properties.outputs.appDefaultHost.value, verification: properties.outputs.customDomainVerificationId.value}" -o table
```

2. Wherever DNS for thedatainnovationhub.com is managed, add:

| Type | Name | Value |
|---|---|---|
| CNAME | `opportunities` | the `host` value (`ca-oppfinder-api.<region-id>.uksouth.azurecontainerapps.io`) |
| TXT | `asuid.opportunities` | the `verification` value |

Check both resolve before going on:

```bash
dig +short CNAME opportunities.thedatainnovationhub.com
```

```bash
dig +short TXT asuid.opportunities.thedatainnovationhub.com
```

3. Set `addCustomDomain = true` in `Infra/main.bicepparam` and deploy again. This adds the hostname to the app and requests a free managed certificate, which renews itself.
4. Wait until the certificate shows `Succeeded` (usually a few minutes):

```bash
az containerapp env certificate list --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder -n cae-oppfinder --managed-certificates-only -o table
```

5. Set `bindCustomDomain = true` and deploy again. The app is now served at https://opportunities.thedatainnovationhub.com, and sign-in links and report emails use it.

## 10. Alerts and budget

Set `alertEmail` (and `monthlyBudget`, default 50) in `Infra/main.bicepparam` and deploy. This creates:

- `ag-oppfinder`: the action group that emails `alertEmail`. Azure sends a confirmation email to that address when it is added.
- `alert-oppfinder-failures`: checks the logs every 15 minutes and emails when a job execution fails for good, a company's run fails, a weekly, sign-in or invitation email cannot be sent, the programme key is rejected, or the API returns a 500. A job attempt that fails and then succeeds on retry does not alert (the daily Azure cost job sometimes gets a 429 from Cost Management and recovers). Costs about US$1 a month.
- `budget-oppfinder-monthly`: Azure spend for the resource group, with emails at 80% and 100% of actual spend and at 100% of forecast. Free. Covers Azure only: AI spend has its own cap on the admin page, and Brave its monthly query cap.

To see what fired: Azure portal, Monitor, Alerts; or run the rule's query in `log-oppfinder`.

## 11. Billing (DEC-014)

From 1 Feb 2027 each company needs a plan: a subscription (£30 a month or £300 a year) or the own-key platform fee (£10 a month or £100 a year), all excluding VAT. Billing stays off until the six Stripe settings are in place; until then the Plan card says plans cannot be bought yet. Do everything in Stripe's **test mode** first, then repeat it in live mode before 3 Jan 2027, when checkout opens.

1. **Account.** Create the Stripe account for The Data Innovation Hub with the UK as its country, and complete activation.
2. **Tax.** Under Tax, turn on Stripe Tax, add the UK VAT registration, and set prices to exclude tax. Leave **Managed Payments** (Settings → Managed Payments) off: The Data Innovation Hub is the seller and charges VAT under its own registration, not Stripe. The app also turns it off on every checkout session.
3. **Products and prices.** Create two products, each with two recurring GBP prices, tax behaviour **exclusive**:
   - "Opportunity Finder subscription": £30.00 monthly and £300.00 yearly;
   - "Opportunity Finder platform fee (own AI key)": £10.00 monthly and £100.00 yearly.

   Note the four price ids (`price_...`). They must match `Backend/Services/Plans.js`, and the notice wording in `Backend/Services/Mail.js` and `src/components/Layout.tsx`.
4. **Customer portal.** Under Settings → Billing → Customer portal, allow:
   - updating the payment method;
   - viewing invoices;
   - cancelling at the end of the period;
   - switching between the four prices.

   Set the return link to `https://opportunities.thedatainnovationhub.com`.
5. **Webhook.** Under Developers → Webhooks, add the endpoint `https://opportunities.thedatainnovationhub.com/api/stripe/webhook`, with API version `2026-09-30.endive` (the version pinned in `Backend/Services/Billing.js`) and these events:
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`;
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`;
   - `invoice.paid` and `invoice.payment_failed`;
   - `charge.dispute.created`, `radar.early_fraud_warning.created` and `charge.refunded`.

   Copy its signing secret (`whsec_...`).
6. **Restricted key.** Under Developers → API keys, create a restricted key with these permissions:

   | Resource | Permission |
   |---|---|
   | Customers | Write |
   | Checkout Sessions | Write |
   | Customer portal | Write |
   | Subscriptions | Read |
   | Prices | Read |
   | Charges | Read |

   Use a separate key for test mode and for live mode.

7. **Secrets.** Store the key and the signing secret in the app vault. Each is pasted at a hidden prompt, in one go:

```bash
read -s STRIPE_KEY && az keyvault secret set --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --vault-name <appVaultName> -n stripe-secret-key --value "$STRIPE_KEY" -o none && unset STRIPE_KEY && echo ok
```

```bash
read -s STRIPE_WHSEC && az keyvault secret set --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 --vault-name <appVaultName> -n stripe-webhook-secret --value "$STRIPE_WHSEC" -o none && unset STRIPE_WHSEC && echo ok
```

   Then let the API read just these two secrets. Re-running `Infra/grant-roles.sh` (step 5) does it, or grant them directly. Without this the API's new revision fails to start (`Unable to get value using Managed identity ... for secret stripe-secret-key`) and the deploy fails:

```bash
S=7f4b2261-9d3d-454a-97b8-132f44da56f2; V=$(az keyvault show --subscription $S -n <appVaultName> --query id -o tsv); API=$(az identity show --subscription $S -g rg-opportunity-finder -n id-oppfinder-api --query principalId -o tsv); for sec in stripe-secret-key stripe-webhook-secret; do az role assignment create --subscription $S --assignee-object-id $API --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope "$V/secrets/$sec" -o none && echo "ok $sec"; done
```

   A new role grant can take a few minutes to take effect; if the deploy still fails the same way, wait and deploy again.

8. **Turn it on.** In `Infra/main.bicepparam`, set `enableBilling = true` and the four `stripePrice...` ids, then deploy as in step 6.
9. **Raise the programme cap.** Raise the monthly AI cap on the Admin page before 1 Feb 2027. Subscribers run on the programme key with no cap of their own, so allow about US$30 per subscriber. The Free period card warns when the cap is lower than that.

**Test-mode check before going live.** With test keys deployed:
1. Sign in as a test company admin and choose a plan. Pay with Stripe's test card `4242 4242 4242 4242`.
2. Check that the Plan card shows the plan.
3. Check that the Admin page shows it in the company's row.
4. Check that the webhook endpoint in Stripe shows 200 responses.
5. Cancel the plan in the portal and check the card follows.

Then replace both secrets and the price ids with the live ones and deploy again.

Billing changes are logged without amounts or card details. The failures alert also fires on these events:
- `billing_duplicate_subscription`: a company has two live subscriptions; refund one in Stripe;
- `billing_unknown_customer`;
- `billing_unknown_price`;
- `billing_dispute`: a customer disputed a payment. Respond to it in Stripe (Payments → Disputes) before its deadline;
- `billing_fraud_warning`: the card network reported a payment as likely fraud. Consider refunding it and cancelling the plan in Stripe before a dispute arrives.

Refunds are recorded in the company's audit log (`billing.refund`) without an alert.

**Release with migrations 0006 and 0007.** The new code needs both (0007 adds `company.cohort`, DEC-015), so migrate before switching the API and the other jobs:
1. Run `az containerapp job update --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder -n job-oppfinder-migrate --image <new image>`.
2. Start the migration job.
3. Once it has succeeded, update the API and the other jobs.

## Each release

1. Check the **Tests** run on GitHub (Actions tab) passed for the commit you are about to ship. It runs every suite on each push to `main` (`.github/workflows/tests.yml`).
2. Build and push the new image (step 6), and set `appImage` to it.
3. Deploy. This also points the migration job at the new image.
4. Start the migration job and wait for it to succeed: `az containerapp job start --subscription 7f4b2261-9d3d-454a-97b8-132f44da56f2 -g rg-opportunity-finder -n job-oppfinder-migrate` (no `--image`: that flag replaces the job's container for the run, dropping its migrate command and settings, so the run fails with "missing configuration").
   If the release adds tables or columns the runtime roles use, its migration grants them when the roles exist (as 0003 and 0005 do); re-running `Infra/database-roles.sql` (step 3) is also safe.

Deploying before migrating is safe only when the new code works on the old schema. When it does not, ship the code that needs the schema in a later release than the migration.

Migrations are forward-only; a fix is a new numbered migration (`Requirements/MigrationPlan.md`).

A migration that tightens a check the old code could still break must run after the deploy, as above (step 4). `Requirements/MigrationPlan.md` says when; `0004_RegionScopes.sql` is one.

## Known risks

- **Postgres is reachable from any Azure address** (the `AllowAzureServices` rule), because consumption Container Apps have no fixed outbound IP. TLS with certificate checking and strong per-role passwords are the controls. A VNet-integrated environment with private access removes this; it adds about US$10–20 a month.
- **One API replica**: sign-in rate limits are kept in memory per replica. Scaling out needs a shared limiter.
- **Email**: until the domain's DNS records are verified, no mail is sent and nobody can sign in.
