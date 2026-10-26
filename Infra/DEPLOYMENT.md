# Deploying Opportunity Finder to Azure

First deployed 24 to 26 Oct 2026 by following these steps. Each step changes Azure, so run them from your own terminal, signed in with `az login`, in order. Every step can be run again safely.

- Run every step in the **same terminal tab**: later steps use `POSTGRES_ADMIN_PASSWORD` and the role passwords set in it. Commands sent from elsewhere run in a fresh shell without them.
- If you have more than one subscription, check `az account show` before each sitting, or add `--subscription <id>` to commands: the CLI default is shared by every terminal and can change under you.
- A redeploy needs `POSTGRES_ADMIN_PASSWORD` set to the **same** password; a different value changes the server's admin password. Test it first: `PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" psql "host=<postgresHost> dbname=opportunity_finder user=ofadmin sslmode=verify-full sslrootcert=system" -Atc "SELECT 1"`.

## What gets created

| Resource | Purpose |
|---|---|
| Container App `ca-oppfinder-api` | API and the built frontend, one replica, public HTTPS at `opportunities.thedatainnovationhub.com` (step 9) |
| Container App `ca-oppfinder-scraper` | Funder-page and listing scraper, internal only, scales to zero |
| Container Apps jobs `weekly`, `emails`, `cleanup`, `azure-cost` | Scheduled work (times below) |
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
| emails | `0 7 * * 1` | Monday 07:00 GMT, 08:00 BST |
| cleanup | `0 3 * * *` | daily |
| azure-cost | `0 5 * * *` | daily |

## 1. Infrastructure (no apps yet)

```bash
az group create -n rg-opportunity-finder -l uksouth
```

```bash
cp Infra/main.bicepparam.example Infra/main.bicepparam
```

Choose a strong Postgres admin password and export it in the same shell (it is never written to a file):

```bash
read -s POSTGRES_ADMIN_PASSWORD && export POSTGRES_ADMIN_PASSWORD
```

```bash
az deployment group create -g rg-opportunity-finder -n main -f Infra/main.bicep -p Infra/main.bicepparam
```

## 2. Email domain

The deploy creates the email domain; add the records it needs at your DNS provider (GoDaddy for thedatainnovationhub.com). Read them with:

```bash
az communication email domain show -g rg-opportunity-finder --email-service-name email-oppfinder -n thedatainnovationhub.com --query verificationRecords -o json
```

Add the `Domain` TXT record (as a new TXT record at `@`, alongside the others) and both DKIM CNAMEs (`selector1-…` and `selector2-…`). Azure checks SPF for `include:spf.protection.outlook.com`, which the domain's Microsoft 365 SPF record already has, so the SPF record usually needs no change. If it ever does, **merge** into the one existing record rather than adding a second; two SPF records make both fail.

Add the step 9 records (`opportunities` CNAME and `asuid.opportunities` TXT) at the same time, so DNS is done in one sitting. GoDaddy can take several minutes to publish a saved record.

When the records resolve, start the checks:

```bash
for t in Domain SPF DKIM DKIM2; do az communication email domain initiate-verification -g rg-opportunity-finder --email-service-name email-oppfinder --domain-name thedatainnovationhub.com --verification-type $t; done
```

When all four show **Verified** (`--query verificationStates` on the show command above), set `linkEmailDomain = true` in `Infra/main.bicepparam` and deploy again. Azure refuses to link the domain until every check, DKIM2 included, has passed.

## 3. Database

From the repo root, in the same terminal as step 1 (it holds `POSTGRES_ADMIN_PASSWORD`). Keep this terminal open until step 4 is done: the runtime role passwords below exist only in it.

Let your machine through the server firewall:

```bash
MYIP=$(curl -s https://api.ipify.org) && az postgres flexible-server firewall-rule create -g rg-opportunity-finder --name <postgresServerName> --rule-name admin-laptop --start-ip-address $MYIP --end-ip-address $MYIP -o table
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
az role assignment create --assignee-object-id $(az ad signed-in-user show --query id -o tsv) --assignee-principal-type User --role "Key Vault Secrets Officer" --scope $(az keyvault show -n <appVaultName> --query id -o tsv) -o none && echo ok
```

Then, in the step 3 terminal, store the database URLs from the passwords already in the shell:

```bash
PGH=<postgresHost>; V=<appVaultName>; az keyvault secret set --vault-name $V -n database-url --value "postgresql://of_api:${API_DB_PASSWORD}@${PGH}:5432/opportunity_finder?sslmode=verify-full" -o none && az keyvault secret set --vault-name $V -n worker-database-url --value "postgresql://of_worker:${WORKER_DB_PASSWORD}@${PGH}:5432/opportunity_finder?sslmode=verify-full" -o none && az keyvault secret set --vault-name $V -n migrate-database-url --value "$ADMIN_URL" -o none && echo ok
```

```bash
az keyvault secret set --vault-name <appVaultName> -n scraper-shared-secret --value "$(openssl rand -hex 32)" -o none && echo ok
```

The Brave key is pasted at a hidden prompt. Paste it in one go and press Enter once (a line break in the paste stores a cut-off key); a Brave key is 31 characters:

```bash
read -s BRAVE && az keyvault secret set --vault-name <appVaultName> -n brave-search-api-key --value "$BRAVE" -o none && unset BRAVE && echo ok
```

## 5. Roles

```bash
Infra/grant-roles.sh <subscription-id> rg-opportunity-finder
```

It creates two custom roles; a new custom role can take a few minutes to become assignable, so the script retries and stops with `FAILED` if it runs out. Re-running is safe.

## 6. Images and apps

`az acr build` uploads the build context; `.dockerignore` keeps out every `.env`, `node_modules`, `Backend/Output`, trial profiles, `Infra` and `Requirements`. Use one tag for both images:

```bash
TAG=$(date +%Y%m%d%H%M) && az acr build -r <registryName> -t opportunity-finder:$TAG . && az acr build -r <registryName> -t scraper:$TAG scraper && echo $TAG
```

Set `deployApps = true`, and `appImage` and `scraperImage` to the full references (`<registryServer>/opportunity-finder:<tag>`, `<registryServer>/scraper:<tag>`) in `Infra/main.bicepparam`, then deploy again (step 1 terminal):

```bash
az deployment group create -g rg-opportunity-finder -n main -f Infra/main.bicep -p Infra/main.bicepparam
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

Companies are told from four weeks before the end. After the end date, runs use each company's own key again. Clearing **Free until** ends the free period from the next company run (a run already under way finishes on the programme key).

When the workspace's spend limit is reached, runs are meant to be marked "programme key not working" rather than retried. The worker recognises Anthropic's "credit balance" message for certain; the spend-limit wording it matches ("usage limits") has not been checked against a real limit, so watch the first time the limit is hit.

## 9. Custom domain: opportunities.thedatainnovationhub.com (DEC-012)

Until this step the app answers on its Container Apps address (`appUrl` output), and sign-in links use that address. They keep working afterwards.

1. Read the two values the DNS records need:

```bash
az deployment group show -g rg-opportunity-finder -n main --query "{host: properties.outputs.appDefaultHost.value, verification: properties.outputs.customDomainVerificationId.value}" -o table
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
az containerapp env certificate list -g rg-opportunity-finder -n cae-oppfinder --managed-certificates-only -o table
```

5. Set `bindCustomDomain = true` and deploy again. The app is now served at https://opportunities.thedatainnovationhub.com, and sign-in links and report emails use it.

## Each release

1. Build and push the new image (step 6), and set `appImage` to it.
2. Deploy. This also points the migration job at the new image.
3. Start the migration job and wait for it to succeed: `az containerapp job start --subscription <id> -g rg-opportunity-finder -n job-oppfinder-migrate` (no `--image`: that flag replaces the job's container for the run, dropping its migrate command and settings, so the run fails with "missing configuration").
   If the release adds tables or columns the runtime roles use, its migration grants them when the roles exist (as 0003 and 0005 do); re-running `Infra/database-roles.sql` (step 3) is also safe.

Deploying before migrating is safe only when the new code works on the old schema. When it does not, ship the code that needs the schema in a later release than the migration.

Migrations are forward-only; a fix is a new numbered migration (`Requirements/MigrationPlan.md`).

A migration that tightens a check the old code could still break must run after the deploy, as above. `Requirements/MigrationPlan.md` says when; `0004_RegionScopes.sql` is one.

## Known risks

- **Postgres is reachable from any Azure address** (the `AllowAzureServices` rule), because consumption Container Apps have no fixed outbound IP. TLS with certificate checking and strong per-role passwords are the controls. A VNet-integrated environment with private access removes this; it adds about US$10–20 a month.
- **One API replica**: sign-in rate limits are kept in memory per replica. Scaling out needs a shared limiter.
- **Email**: until the domain's DNS records are verified, no mail is sent and nobody can sign in.
