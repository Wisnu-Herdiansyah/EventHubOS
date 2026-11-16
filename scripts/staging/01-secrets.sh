#!/usr/bin/env bash
# Step 1 of the staging deployment: service accounts, secrets and their permissions.
# Run after steps 1 to 4 of docs/operations/staging-setup.md. Safe to run again: existing
# secrets are kept, never regenerated.
#
#   scripts/staging/01-secrets.sh
#
# It asks for two values without showing them as you type:
#   - the Cloud SQL `postgres` password you set in the setup guide;
#   - the email provider's API key (press Enter to skip for now).
# Everything else is generated here and goes straight into Secret Manager. Nothing is printed.
source "$(dirname "$0")/lib.sh"

say "== APIs"
"${GCLOUD[@]}" services enable run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com >/dev/null

say "== service accounts (one per service, least privilege)"
for name in api worker jobs; do
  "${GCLOUD[@]}" iam service-accounts describe "$(sa "$name")" >/dev/null 2>&1 ||
    "${GCLOUD[@]}" iam service-accounts create "eventhub-$name" \
      --display-name="EventHub $name (staging)" >/dev/null
  # Connect to Cloud SQL through the socket Cloud Run mounts (ADR-0057).
  "${GCLOUD[@]}" projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$(sa "$name")" --role=roles/cloudsql.client --condition=None >/dev/null
done
# Images (ADR-0051): the API stores and reads them, the worker deletes them.
for name in api worker; do
  "${GCLOUD[@]}" storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:$(sa "$name")" --role=roles/storage.objectUser >/dev/null
done

say "== database role passwords and connection URLs"
# One random password per role. The URL uses the Cloud SQL socket form (ADR-0057).
for role in migrator app worker; do
  if ! secret_exists "db-${role}-password"; then
    openssl rand -hex 24 | tr -d '\n' | put_secret "db-${role}-password"
  fi
  {
    printf 'postgres://eventhub_%s:' "$role"
    read_secret "db-${role}-password" | urlencode
    printf '@localhost/%s?host=%s' "$DATABASE" "$SOCKET"
  } | put_secret "database-${role}-url"
done

if ! secret_exists database-admin-url; then
  say "The Cloud SQL 'postgres' password (typing is hidden):"
  IFS= read -rs admin_password
  [[ -n "$admin_password" ]] || die "no password entered"
  {
    printf 'postgres://postgres:'
    printf '%s' "$admin_password" | urlencode
    printf '@localhost/%s?host=%s' "$DATABASE" "$SOCKET"
  } | put_secret database-admin-url
  unset admin_password
fi

say "== application keys"
secret_exists mfa-encryption-key || openssl rand -base64 32 | tr -d '\n' | put_secret mfa-encryption-key
secret_exists email-token-secret || openssl rand -hex 32 | tr -d '\n' | put_secret email-token-secret
secret_exists visitor-address-key || openssl rand -hex 32 | tr -d '\n' | put_secret visitor-address-key

if ! secret_exists resend-api-key; then
  say "The email provider's API key (typing is hidden; Enter to skip for now):"
  IFS= read -rs resend_key
  if [[ -n "$resend_key" ]]; then
    printf '%s' "$resend_key" | put_secret resend-api-key
  else
    say "skipped: the worker cannot be deployed until this is set (run this script again)"
  fi
  unset resend_key
fi

say "== who may read which secret"
allow_secret database-admin-url jobs
allow_secret database-migrator-url jobs
for role in migrator app worker; do allow_secret "db-${role}-password" jobs; done
allow_secret database-app-url api
allow_secret mfa-encryption-key api
allow_secret visitor-address-key api
allow_secret database-worker-url worker
allow_secret email-token-secret worker
if secret_exists resend-api-key; then allow_secret resend-api-key worker; fi

say "DONE: secrets are in Secret Manager. Next: scripts/staging/02-images.sh"
