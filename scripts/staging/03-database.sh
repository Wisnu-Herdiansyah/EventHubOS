#!/usr/bin/env bash
# Step 3: create the three database roles and apply the migrations, as Cloud Run jobs that reach
# Cloud SQL through its socket. Safe to run again (the roles are updated in place, and applied
# migrations are skipped).
#
#   scripts/staging/03-database.sh
source "$(dirname "$0")/lib.sh"

say "== roles (bootstrap job)"
"${GCLOUD[@]}" run jobs deploy eventhub-bootstrap --region="$REGION" --image="$(image api)" \
  --service-account="$(sa jobs)" --set-cloudsql-instances="$CONNECTION" \
  --max-retries=0 --task-timeout=300s \
  --command=node --args=packages/db/src/cli/bootstrap.ts \
  --set-secrets="DATABASE_ADMIN_URL=database-admin-url:latest,EVENTHUB_MIGRATOR_PASSWORD=db-migrator-password:latest,EVENTHUB_APP_PASSWORD=db-app-password:latest,EVENTHUB_WORKER_PASSWORD=db-worker-password:latest" >/dev/null
"${GCLOUD[@]}" run jobs execute eventhub-bootstrap --region="$REGION" --wait

say "== migrations (migrate job)"
"${GCLOUD[@]}" run jobs deploy eventhub-migrate --region="$REGION" --image="$(image api)" \
  --service-account="$(sa jobs)" --set-cloudsql-instances="$CONNECTION" \
  --max-retries=0 --task-timeout=600s \
  --command=node --args=packages/db/src/cli/migrate.ts \
  --set-env-vars="EVENTHUB_ENV=staging" \
  --set-secrets="DATABASE_MIGRATOR_URL=database-migrator-url:latest" >/dev/null
"${GCLOUD[@]}" run jobs execute eventhub-migrate --region="$REGION" --wait

say "DONE: roles and migrations applied. Next: scripts/staging/04-services.sh"
