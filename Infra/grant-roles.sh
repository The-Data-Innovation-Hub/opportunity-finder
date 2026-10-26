#!/usr/bin/env bash
# Grants the managed identities exactly what they need (phase 2 of
# Infra/DEPLOYMENT.md). Run from your own terminal, signed in with `az login`
# as someone who can assign roles on the resource group. Idempotent.
#
#   Infra/grant-roles.sh <subscription-id> <resource-group> [deployment-name]
set -euo pipefail
SUBSCRIPTION=${1:?subscription id}
RG=${2:?resource group}
DEPLOYMENT=${3:-main}
ROLE_SEND="Opportunity Finder email sender"
ROLE_KEY_WRITER="Opportunity Finder key writer"

out() { az deployment group show --subscription "$SUBSCRIPTION" -g "$RG" -n "$DEPLOYMENT" --query "properties.outputs.$1.value" -o tsv; }
API=$(out apiPrincipalId); WORKER=$(out workerPrincipalId); MIGRATE=$(out migratePrincipalId)
APP_VAULT=$(az keyvault show --subscription "$SUBSCRIPTION" -n "$(out appVaultName)" --query id -o tsv)
KEYS_VAULT=$(az keyvault show --subscription "$SUBSCRIPTION" -n "$(out keysVaultName)" --query id -o tsv)
STORAGE=$(az storage account show --subscription "$SUBSCRIPTION" -g "$RG" -n "$(out storageAccountName)" --query id -o tsv)
ACS=$(az communication show --subscription "$SUBSCRIPTION" -g "$RG" -n "$(out communicationName)" --query id -o tsv)
ACR=$(az acr list --subscription "$SUBSCRIPTION" -g "$RG" --query "[0].id" -o tsv)
RG_ID="/subscriptions/$SUBSCRIPTION/resourceGroups/$RG"

grant() { # principal role scope
	# Matched by principal id rather than --assignee, which needs a directory
	# lookup that can fail for a managed identity created minutes earlier.
	if [ -z "$(az role assignment list --subscription "$SUBSCRIPTION" --role "$2" --scope "$3" --query "[?principalId=='$1'] | [0].id" -o tsv)" ]; then
		# A custom role or new identity can take a few minutes to become assignable.
		for attempt in 1 2 3 4 5 6 7 8 9 10; do
			az role assignment create --subscription "$SUBSCRIPTION" --assignee-object-id "$1" --assignee-principal-type ServicePrincipal \
				--role "$2" --scope "$3" -o none && break
			if [ "$attempt" = 10 ]; then echo "FAILED  $2 -> ${3##*/}: re-run this script in a few minutes" >&2; exit 1; fi
			echo "   not assignable yet, retrying in 30s"; sleep 30
		done
	fi
	echo "ok  $2 -> ${3##*/}"
}

# Secrets must exist before a role can be scoped to one of them.
for secret in database-url worker-database-url migrate-database-url brave-search-api-key scraper-shared-secret; do
	if ! az keyvault secret show --subscription "$SUBSCRIPTION" --vault-name "$(out appVaultName)" -n "$secret" --query id -o tsv >/dev/null 2>&1; then
		echo "Missing secret '$secret' in the app vault. Set it first (see Infra/DEPLOYMENT.md, step 4), then re-run." >&2
		exit 1
	fi
done

echo "== images"
for p in "$API" "$WORKER" "$MIGRATE"; do grant "$p" AcrPull "$ACR"; done

echo "== platform secrets, one secret per identity"
grant "$API" "Key Vault Secrets User" "$APP_VAULT/secrets/database-url"
grant "$WORKER" "Key Vault Secrets User" "$APP_VAULT/secrets/worker-database-url"
grant "$WORKER" "Key Vault Secrets User" "$APP_VAULT/secrets/brave-search-api-key"
grant "$WORKER" "Key Vault Secrets User" "$APP_VAULT/secrets/scraper-shared-secret"
grant "$MIGRATE" "Key Vault Secrets User" "$APP_VAULT/secrets/migrate-database-url"

echo "== company LLM keys (SEC-002): the API can write but not read; the worker reads"
if [ -z "$(az role definition list --subscription "$SUBSCRIPTION" --name "$ROLE_KEY_WRITER" --custom-role-only true --query "[0].id" -o tsv)" ]; then
	az role definition create --subscription "$SUBSCRIPTION" --role-definition "{
		\"Name\": \"$ROLE_KEY_WRITER\",
		\"Description\": \"Save, replace and remove company LLM keys without reading them. Opportunity Finder API only.\",
		\"Actions\": [],
		\"DataActions\": [\"Microsoft.KeyVault/vaults/secrets/setSecret/action\", \"Microsoft.KeyVault/vaults/secrets/delete\", \"Microsoft.KeyVault/vaults/secrets/recover/action\"],
		\"AssignableScopes\": [\"$RG_ID\"]
	}" -o none
fi
grant "$API" "$ROLE_KEY_WRITER" "$KEYS_VAULT"
grant "$WORKER" "Key Vault Secrets User" "$KEYS_VAULT"

echo "== reports"
grant "$WORKER" "Storage Blob Data Contributor" "$STORAGE/blobServices/default/containers/reports"
grant "$API" "Storage Blob Data Reader" "$STORAGE/blobServices/default/containers/reports"
grant "$API" "Storage Blob Delegator" "$STORAGE"

echo "== hosting cost for the admin card (BEH-012)"
grant "$WORKER" "Cost Management Reader" "$RG_ID"

echo "== email: send only"
if [ -z "$(az role definition list --subscription "$SUBSCRIPTION" --name "$ROLE_SEND" --custom-role-only true --query "[0].id" -o tsv)" ]; then
	az role definition create --subscription "$SUBSCRIPTION" --role-definition "{
		\"Name\": \"$ROLE_SEND\",
		\"Description\": \"Send email through Azure Communication Services. Opportunity Finder only.\",
		\"Actions\": [\"Microsoft.Communication/CommunicationServices/Read\", \"Microsoft.Communication/CommunicationServices/Write\", \"Microsoft.Communication/EmailServices/write\"],
		\"AssignableScopes\": [\"$RG_ID\"]
	}" -o none
fi
grant "$API" "$ROLE_SEND" "$ACS"
grant "$WORKER" "$ROLE_SEND" "$ACS"
echo "done"
