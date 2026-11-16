#!/usr/bin/env bash
# Step 4: deploy the API (a Cloud Run service) and the worker (a Cloud Run worker pool).
# Run it once to get the API's address, create the Vercel projects, then run it again with the
# admin address so passkeys work (see docs/operations/staging-deploy.md).
#
#   ADMIN_ORIGIN=https://admin.example.com SITE_DOMAIN=events.example.com \
#   EMAIL_FROM='EventHub <no-reply@mail.example.com>' scripts/staging/04-services.sh
#
# None of these three values is a secret.
source "$(dirname "$0")/lib.sh"

: "${ADMIN_ORIGIN:?set ADMIN_ORIGIN to the https address of the admin app, e.g. https://admin.example.com}"
: "${SITE_DOMAIN:?set SITE_DOMAIN to the domain public sites live under, e.g. events.example.com}"
: "${EMAIL_FROM:?set EMAIL_FROM to a sender on your verified email domain}"
[[ "$ADMIN_ORIGIN" == https://* && "$ADMIN_ORIGIN" != */ ]] || die "ADMIN_ORIGIN must be https and have no trailing slash"
[[ "$SITE_DOMAIN" =~ ^[a-z0-9.-]+$ ]] || die "SITE_DOMAIN must be a bare domain"
secret_exists resend-api-key || die "the email provider's API key is not set: run 01-secrets.sh again"

# Values may contain commas and spaces, so gcloud is told to split on another character.
join() { local IFS='|'; echo "^|^$*"; }

say "== API"
"${GCLOUD[@]}" run deploy eventhub-api --region="$REGION" --image="$(image api)" \
  --service-account="$(sa api)" --add-cloudsql-instances="$CONNECTION" \
  --allow-unauthenticated --port=8080 --min-instances=0 --max-instances=2 \
  --set-env-vars="$(join EVENTHUB_ENV=staging OBJECT_STORE=gcs "GCS_BUCKET=${BUCKET}" \
    "PASSKEY_ORIGIN=${ADMIN_ORIGIN}")" \
  --set-secrets="DATABASE_APP_URL=database-app-url:latest,MFA_ENCRYPTION_KEY=mfa-encryption-key:latest,VISITOR_ADDRESS_KEY=visitor-address-key:latest" >/dev/null

say "== worker"
# One instance, always running: it polls the outbox and sends email.
"${GCLOUD[@]}" run worker-pools deploy eventhub-worker --region="$REGION" --image="$(image worker)" \
  --service-account="$(sa worker)" --add-cloudsql-instances="$CONNECTION" --instances=1 \
  --set-env-vars="$(join EVENTHUB_ENV=staging EVENT_PUBLISHER=postgres_outbox EMAIL_SENDER=resend \
    "EMAIL_FROM=${EMAIL_FROM}" "APP_BASE_URL=${ADMIN_ORIGIN}" \
    "PUBLIC_SITE_URL=https://{handle}.${SITE_DOMAIN}" OBJECT_STORE=gcs "GCS_BUCKET=${BUCKET}")" \
  --set-secrets="DATABASE_WORKER_URL=database-worker-url:latest,EMAIL_TOKEN_SECRET=email-token-secret:latest,RESEND_API_KEY=resend-api-key:latest" >/dev/null

say "DONE. The API's address (not a secret; use it for ADMIN_API_URL and SITE_API_URL on Vercel):"
"${GCLOUD[@]}" run services describe eventhub-api --region="$REGION" --format='value(status.url)'
