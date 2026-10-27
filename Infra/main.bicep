// Opportunity Finder on Azure (Requirements/ArchitectureProposal.md).
//
// Two phases, because the apps read secrets and pull images through managed
// identities whose roles must exist first, and (as in Parentalk) this
// template grants no roles itself:
//   1. deployApps=false  - identities, vaults, storage, Postgres, email, registry, environment
//   2. Infra/grant-roles.sh, then set the secrets (Infra/DEPLOYMENT.md)
//   3. deployApps=true   - API, scraper, and the scheduled jobs
//
// Container Apps job schedules are UTC; see each job for the UK time.

targetScope = 'resourceGroup'

@description('Short name used in every resource name, e.g. "oppfinder".')
@minLength(3)
@maxLength(12)
param prefix string = 'oppfinder'

param location string = resourceGroup().location

@description('Deploy the API, scraper and jobs (phase 3). Leave false for the first deployment.')
param deployApps bool = false

@description('Full image reference for the API and worker, e.g. myacr.azurecr.io/opportunity-finder:2026-10-23.')
param appImage string = ''

@description('Full image reference for the scraper.')
param scraperImage string = ''

@description('Public URL of the app before the custom domain is bound. Empty uses the Container App\'s own address.')
param appUrl string = ''

@description('The app\'s own domain (DEC-012). Its DNS records come first: Infra/DEPLOYMENT.md, step 9.')
param customDomain string = 'opportunities.thedatainnovationhub.com'

@description('Step 9: add the custom domain to the API app and request its free managed certificate. Only once its CNAME and TXT records resolve.')
param addCustomDomain bool = false

@description('Step 9: serve the custom domain over HTTPS with that certificate and make it the app\'s address. Only once the certificate shows Succeeded.')
param bindCustomDomain bool = false

@description('Email domain verified for sending (DEC-010).')
param emailDomainName string = 'thedatainnovationhub.com'

@description('Link the email domain to Communication Services. Azure only allows this once the domain\'s DNS records are verified (Infra/DEPLOYMENT.md, step 2).')
param linkEmailDomain bool = false

@description('DEC-014: turn on Stripe billing. Needs the stripe-secret-key and stripe-webhook-secret secrets in the app vault first (DEPLOYMENT.md, "Billing").')
param enableBilling bool = false

@description('Stripe price ids (price_...) for the four plans; not secret.')
param stripePriceSubscriptionMonth string = ''
param stripePriceSubscriptionYear string = ''
param stripePriceOwnKeyMonth string = ''
param stripePriceOwnKeyYear string = ''

@description('Who is emailed when a job or a company\'s run fails, and at the budget thresholds. Empty creates no alerts or budget.')
param alertEmail string = ''

@description('Monthly Azure budget for this resource group, in the billing currency. Warnings at 80% and 100% of actual spend, and at 100% forecast.')
param monthlyBudget int = 50

@description('First month the budget counts from (the first of a month). Keep it unchanged on later deploys.')
param budgetStartDate string = '2026-10-01'

@description('Postgres administrator login (used only by the migration job and grant scripts).')
param postgresAdminLogin string = 'ofadmin'

@secure()
@description('Postgres administrator password. Store it in the app vault as well (Infra/DEPLOYMENT.md).')
param postgresAdminPassword string

var tags = {project: 'opportunity-finder', owner: 'the-data-innovation-hub'}
var suffix = uniqueString(resourceGroup().id)

// --- Monitoring -------------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
	name: 'log-${prefix}'
	location: location
	tags: tags
	properties: {sku: {name: 'PerGB2018'}, retentionInDays: 30}
}

// --- Identities: the API and the worker are separate (least privilege) ---------------

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
	name: 'id-${prefix}-api'
	location: location
	tags: tags
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
	name: 'id-${prefix}-worker'
	location: location
	tags: tags
}

// Migrations run as the schema owner; only this identity can read that URL.
resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
	name: 'id-${prefix}-migrate'
	location: location
	tags: tags
}

// --- Key Vaults -------------------------------------------------------------------------
// Two vaults: platform secrets (database URLs, Brave key) and company LLM
// keys (SEC-002). The API can write company keys but cannot read platform
// secrets it does not need, and nothing that reads platform secrets can
// write company keys.

resource appVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
	name: 'kv-${prefix}-app-${take(suffix, 5)}'
	location: location
	tags: tags
	properties: {
		tenantId: subscription().tenantId
		sku: {family: 'A', name: 'standard'}
		enableRbacAuthorization: true
		enableSoftDelete: true
		softDeleteRetentionInDays: 90
		enablePurgeProtection: true
		publicNetworkAccess: 'Enabled'
	}
}

resource keysVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
	name: 'kv-${prefix}-keys-${take(suffix, 4)}'
	location: location
	tags: union(tags, {dataClass: 'customer-secrets'})
	properties: {
		tenantId: subscription().tenantId
		sku: {family: 'A', name: 'standard'}
		enableRbacAuthorization: true
		enableSoftDelete: true
		softDeleteRetentionInDays: 90
		enablePurgeProtection: true
		publicNetworkAccess: 'Enabled'
	}
}

resource vaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
	scope: keysVault
	name: 'diag-to-log'
	properties: {workspaceId: logs.id, logs: [{categoryGroup: 'audit', enabled: true}]}
}

// --- Storage: private reports and weekly gathers ---------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
	name: take('st${prefix}${suffix}', 24)
	location: location
	tags: tags
	kind: 'StorageV2'
	sku: {name: 'Standard_LRS'}
	properties: {
		allowBlobPublicAccess: false
		// Identity only: downloads use user-delegation SAS, not account keys.
		allowSharedKeyAccess: false
		minimumTlsVersion: 'TLS1_2'
		supportsHttpsTrafficOnly: true
	}
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
	parent: storage
	name: 'default'
	properties: {deleteRetentionPolicy: {enabled: true, days: 14}}
}

resource reportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
	parent: blobService
	name: 'reports'
	properties: {publicAccess: 'None'}
}

// --- Postgres ------------------------------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
	name: 'psql-${prefix}-${take(suffix, 6)}'
	location: location
	tags: tags
	sku: {name: 'Standard_B1ms', tier: 'Burstable'}
	properties: {
		version: '16'
		administratorLogin: postgresAdminLogin
		administratorLoginPassword: postgresAdminPassword
		storage: {storageSizeGB: 32, autoGrow: 'Enabled'}
		backup: {backupRetentionDays: 14, geoRedundantBackup: 'Disabled'}
		highAvailability: {mode: 'Disabled'}
		network: {publicNetworkAccess: 'Enabled'}
	}
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
	parent: postgres
	name: 'opportunity_finder'
	properties: {charset: 'UTF8', collation: 'en_US.utf8'}
}

// Consumption Container Apps have no fixed outbound address, so access is
// limited to Azure services plus TLS and passwords (risk recorded in
// DEPLOYMENT.md; a VNet-integrated environment removes it).
resource postgresAzureAccess 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
	parent: postgres
	name: 'AllowAzureServices'
	properties: {startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0'}
}

// --- Email (DEC-010) --------------------------------------------------------------------------

resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
	name: 'email-${prefix}'
	location: 'global'
	tags: tags
	properties: {dataLocation: 'UK'}
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
	parent: emailService
	name: emailDomainName
	location: 'global'
	tags: tags
	properties: {domainManagement: 'CustomerManaged', userEngagementTracking: 'Disabled'}
}

resource emailSender 'Microsoft.Communication/emailServices/domains/senderUsernames@2023-04-01' = {
	parent: emailDomain
	name: 'no-reply'
	properties: {username: 'no-reply', displayName: 'Opportunity Finder'}
}

resource communication 'Microsoft.Communication/communicationServices@2025-05-01' = {
	name: 'acs-${prefix}-${take(suffix, 6)}'
	location: 'global'
	tags: tags
	properties: {
		dataLocation: 'UK'
		// Sent by managed identity only; no access keys.
		disableLocalAuth: true
		linkedDomains: linkEmailDomain ? [emailDomain.id] : []
	}
}

// --- Registry and environment ------------------------------------------------------------------

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
	name: take('acr${prefix}${suffix}', 50)
	location: location
	tags: tags
	sku: {name: 'Basic'}
	properties: {adminUserEnabled: false}
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
	name: 'cae-${prefix}'
	location: location
	tags: tags
	properties: {
		appLogsConfiguration: {
			destination: 'log-analytics'
			logAnalyticsConfiguration: {customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey}
		}
	}
}

// --- Apps and jobs (phase 3) ----------------------------------------------------------------

var apiName = 'ca-${prefix}-api'
var scraperName = 'ca-${prefix}-scraper'
var defaultHost = '${apiName}.${environment.properties.defaultDomain}'
var defaultUrl = empty(appUrl) ? 'https://${defaultHost}' : appUrl
// Sign-in links and report emails use the custom domain once it is bound.
var publicUrl = addCustomDomain && bindCustomDomain ? 'https://${customDomain}' : defaultUrl
// The Container App's own address keeps working beside the custom domain.
var allowedOrigins = publicUrl == defaultUrl ? publicUrl : '${publicUrl},${defaultUrl}'
var certificateName = 'mc-${prefix}-app'
var senderAddress = 'no-reply@${emailDomainName}'

// A Container Apps secret read from the app vault by the given identity.
func appSecret(name string, identityId string, vaultUri string) object => {name: name, keyVaultUrl: '${vaultUri}secrets/${name}', identity: identityId}

// DEC-014: the API's Stripe settings, only when billing is on (the vault
// secrets must exist before a deployment can reference them).
var billingSecrets = enableBilling ? [
	appSecret('stripe-secret-key', apiIdentity.id, appVault.properties.vaultUri)
	appSecret('stripe-webhook-secret', apiIdentity.id, appVault.properties.vaultUri)
] : []
var billingEnv = enableBilling ? [
	{name: 'STRIPE_SECRET_KEY', secretRef: 'stripe-secret-key'}
	{name: 'STRIPE_WEBHOOK_SECRET', secretRef: 'stripe-webhook-secret'}
	{name: 'STRIPE_PRICE_SUBSCRIPTION_MONTH', value: stripePriceSubscriptionMonth}
	{name: 'STRIPE_PRICE_SUBSCRIPTION_YEAR', value: stripePriceSubscriptionYear}
	{name: 'STRIPE_PRICE_OWN_KEY_MONTH', value: stripePriceOwnKeyMonth}
	{name: 'STRIPE_PRICE_OWN_KEY_YEAR', value: stripePriceOwnKeyYear}
] : []

var commonEnv = [
	{name: 'NODE_ENV', value: 'production'}
	{name: 'APP_URL', value: publicUrl}
	{name: 'KEY_VAULT_URL', value: keysVault.properties.vaultUri}
	{name: 'BLOB_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob}
	{name: 'BLOB_CONTAINER', value: reportsContainer.name}
	{name: 'ACS_EMAIL_ENDPOINT', value: 'https://${communication.properties.hostName}'}
	{name: 'MAIL_SENDER', value: senderAddress}
]

resource api 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
	name: apiName
	location: location
	tags: tags
	identity: {type: 'UserAssigned', userAssignedIdentities: {'${apiIdentity.id}': {}}}
	properties: {
		managedEnvironmentId: environment.id
		configuration: {
			ingress: {
				external: true
				targetPort: 3001
				transport: 'http'
				allowInsecure: false
				// Added unbound first, so the managed certificate can be validated
				// against it; bound to the certificate in a second deployment.
				customDomains: !addCustomDomain ? [] : [bindCustomDomain
					? {name: customDomain, bindingType: 'SniEnabled', certificateId: '${environment.id}/managedCertificates/${certificateName}'}
					: {name: customDomain, bindingType: 'Disabled'}]
			}
			registries: [{server: registry.properties.loginServer, identity: apiIdentity.id}]
			secrets: concat([appSecret('database-url', apiIdentity.id, appVault.properties.vaultUri)], billingSecrets)
		}
		template: {
			containers: [{
				name: 'api'
				image: appImage
				resources: {cpu: json('0.5'), memory: '1Gi'}
				env: union(commonEnv, [
					{name: 'AZURE_CLIENT_ID', value: apiIdentity.properties.clientId}
					{name: 'OPPORTUNITY_FINDER_DATABASE_URL', secretRef: 'database-url'}
					{name: 'TRUST_PROXY', value: '1'}
					{name: 'ALLOWED_ORIGINS', value: allowedOrigins}
				], billingEnv)
				probes: [
					{type: 'Liveness', httpGet: {path: '/health', port: 3001}, periodSeconds: 30}
					{type: 'Readiness', httpGet: {path: '/ready', port: 3001}, periodSeconds: 15}
				]
			}]
			// One replica keeps the per-process sign-in rate limits whole.
			scale: {minReplicas: 1, maxReplicas: 1}
		}
	}
}

// Free, auto-renewing certificate for the custom domain, validated by its
// CNAME record. Needs the hostname on the API app first.
resource certificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (deployApps && addCustomDomain) {
	parent: environment
	name: certificateName
	location: location
	tags: tags
	properties: {subjectName: customDomain, domainControlValidation: 'CNAME'}
	dependsOn: [api]
}

resource scraper 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
	name: scraperName
	location: location
	tags: tags
	identity: {type: 'UserAssigned', userAssignedIdentities: {'${workerIdentity.id}': {}}}
	properties: {
		managedEnvironmentId: environment.id
		configuration: {
			// Internal only: reachable by the worker inside the environment.
			ingress: {external: false, targetPort: 8080, transport: 'http'}
			registries: [{server: registry.properties.loginServer, identity: workerIdentity.id}]
			// Defence in depth beside internal ingress: only the worker knows it.
			secrets: [appSecret('scraper-shared-secret', workerIdentity.id, appVault.properties.vaultUri)]
		}
		template: {
			containers: [{
				name: 'scraper'
				image: scraperImage
				resources: {cpu: json('0.5'), memory: '1Gi'}
				env: [{name: 'SCRAPER_SHARED_SECRET', secretRef: 'scraper-shared-secret'}]
			}]
			// Scales to zero between Sunday runs.
			scale: {minReplicas: 0, maxReplicas: 1}
		}
	}
}

var workerEnv = union(commonEnv, [
	{name: 'AZURE_CLIENT_ID', value: workerIdentity.properties.clientId}
	{name: 'OPPORTUNITY_FINDER_DATABASE_URL', secretRef: 'worker-database-url'}
	{name: 'BRAVE_SEARCH_API_KEY', secretRef: 'brave-search-api-key'}
	{name: 'SCRAPER_URL', value: 'http://${scraperName}'}
	{name: 'SCRAPER_SHARED_SECRET', secretRef: 'scraper-shared-secret'}
	{name: 'AZURE_COST_SCOPE', value: resourceGroup().id}
])

var jobs = [
	// Sunday 22:00 UTC (22:00 GMT, 23:00 BST): gather, then every company.
	{name: 'weekly', cron: '0 22 * * 0', command: 'weekly', timeout: 21600}
	// Every 15 minutes: a new company's first report (exits at once when none is due).
	{name: 'first-reports', cron: '*/15 * * * *', command: 'first-reports', timeout: 7200}
	// Monday 07:00 UTC (07:00 GMT, 08:00 BST): the weekly email.
	{name: 'emails', cron: '0 7 * * 1', command: 'emails', timeout: 1800}
	{name: 'cleanup', cron: '0 3 * * *', command: 'cleanup', timeout: 1800}
	{name: 'azure-cost', cron: '0 5 * * *', command: 'azure-cost', timeout: 900}
]

resource scheduledJobs 'Microsoft.App/jobs@2024-03-01' = [for job in jobs: if (deployApps) {
	name: 'job-${prefix}-${job.name}'
	location: location
	tags: tags
	identity: {type: 'UserAssigned', userAssignedIdentities: {'${workerIdentity.id}': {}}}
	properties: {
		environmentId: environment.id
		configuration: {
			triggerType: 'Schedule'
			scheduleTriggerConfig: {cronExpression: job.cron, parallelism: 1, replicaCompletionCount: 1}
			replicaTimeout: job.timeout
			// Safe to retry: every step is idempotent per company and week.
			replicaRetryLimit: 1
			registries: [{server: registry.properties.loginServer, identity: workerIdentity.id}]
			secrets: [
				appSecret('worker-database-url', workerIdentity.id, appVault.properties.vaultUri)
				appSecret('brave-search-api-key', workerIdentity.id, appVault.properties.vaultUri)
				appSecret('scraper-shared-secret', workerIdentity.id, appVault.properties.vaultUri)
			]
		}
		template: {
			containers: [{
				name: job.name
				image: appImage
				command: ['node', 'Worker/Job.js', job.command]
				resources: {cpu: json('1.0'), memory: '2Gi'}
				env: workerEnv
			}]
		}
	}
}]

// Started by hand (or by the release pipeline) before each new image goes live.
resource migrateJob 'Microsoft.App/jobs@2024-03-01' = if (deployApps) {
	name: 'job-${prefix}-migrate'
	location: location
	tags: tags
	identity: {type: 'UserAssigned', userAssignedIdentities: {'${migrateIdentity.id}': {}}}
	properties: {
		environmentId: environment.id
		configuration: {
			triggerType: 'Manual'
			manualTriggerConfig: {parallelism: 1, replicaCompletionCount: 1}
			replicaTimeout: 900
			replicaRetryLimit: 0
			registries: [{server: registry.properties.loginServer, identity: migrateIdentity.id}]
			secrets: [appSecret('migrate-database-url', migrateIdentity.id, appVault.properties.vaultUri)]
		}
		template: {
			containers: [{
				name: 'migrate'
				image: appImage
				command: ['sh', '-c', 'node Database/Migrate.js && node Database/Seeds/approvedModels.js']
				resources: {cpu: json('0.5'), memory: '1Gi'}
				env: [{name: 'OPPORTUNITY_FINDER_DATABASE_URL', secretRef: 'migrate-database-url'}]
			}]
		}
	}
}

// --- Alerts and budget ---------------------------------------------------------------

resource alertGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(alertEmail)) {
	name: 'ag-${prefix}'
	location: 'global'
	tags: tags
	properties: {
		groupShortName: take(prefix, 12)
		enabled: true
		emailReceivers: [{name: 'programme-admin', emailAddress: alertEmail, useCommonAlertSchema: true}]
	}
}

// One email when a job's execution fails for good (a retried attempt that then
// succeeds does not count), a company's weekly run fails, a weekly or sign-in
// email cannot be sent, the programme key is rejected, or the API returns a
// 500. The 30-minute window, checked every 15, allows for log ingestion delay;
// an event near a window edge can be emailed twice.
resource failureAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (!empty(alertEmail)) {
	name: 'alert-${prefix}-failures'
	location: location
	tags: tags
	properties: {
		displayName: 'Opportunity Finder: job or run failed'
		description: 'A job execution failed, a company run failed, an email could not be sent, the programme key was rejected, or the API returned a 500. Logs: ContainerAppSystemLogs_CL and ContainerAppConsoleLogs_CL in ${logs.name}.'
		severity: 2
		enabled: true
		scopes: [logs.id]
		evaluationFrequency: 'PT15M'
		windowSize: 'PT30M'
		autoMitigate: false
		criteria: {
			allOf: [{
				query: '''
let failedJobs = ContainerAppSystemLogs_CL
	| where Reason_s in ('BackoffLimitExceeded', 'DeadlineExceeded')
	| project TimeGenerated, source = JobName_s, problem = Reason_s;
let appProblems = ContainerAppConsoleLogs_CL
	| extend entry = parse_json(Log_s)
	| extend event = tostring(entry.event)
	| where event in ('run_failed', 'company_run_error', 'weekly_mail_failed', 'sign_in_mail_failed', 'invitation_mail_failed', 'programme_key_rejected', 'rollback_failed', 'pool_error',
		'billing_duplicate_subscription', 'billing_unknown_customer', 'billing_unknown_price', 'billing_dispute', 'billing_fraud_warning')
		or (event == 'error' and toint(entry.status) >= 500)
	| project TimeGenerated, source = ContainerAppName_s, problem = event;
union failedJobs, appProblems
'''
				timeAggregation: 'Count'
				operator: 'GreaterThan'
				threshold: 0
				failingPeriods: {numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1}
			}]
		}
		actions: {actionGroups: [alertGroup.id]}
	}
}

// Azure spend for this resource group only. The AI spend is capped separately
// in the app (DEC-011), and Brave search by the monthly query cap (BEH-013).
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (!empty(alertEmail)) {
	name: 'budget-${prefix}-monthly'
	properties: {
		category: 'Cost'
		amount: monthlyBudget
		timeGrain: 'Monthly'
		timePeriod: {startDate: budgetStartDate}
		notifications: {
			actual80: {enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: [alertEmail]}
			actual100: {enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: [alertEmail]}
			forecast100: {enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: [alertEmail]}
		}
	}
}

output appUrl string = publicUrl
// For the custom domain's DNS records (DEPLOYMENT.md, step 9).
output appDefaultHost string = defaultHost
output customDomainVerificationId string = environment.properties.customDomainConfiguration.customDomainVerificationId
output registryServer string = registry.properties.loginServer
output appVaultName string = appVault.name
output keysVaultName string = keysVault.name
output storageAccountName string = storage.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output communicationName string = communication.name
output apiPrincipalId string = apiIdentity.properties.principalId
output workerPrincipalId string = workerIdentity.properties.principalId
output migratePrincipalId string = migrateIdentity.properties.principalId
