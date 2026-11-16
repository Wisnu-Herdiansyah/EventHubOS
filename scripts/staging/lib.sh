#!/usr/bin/env bash
# Shared settings and helpers for the staging deployment scripts (ADR-0056, ADR-0059).
# Sourced by the numbered scripts; not run on its own.
#
# Rules these scripts keep:
#   - a secret value is only ever written to gcloud's standard input, never placed on a command
#     line, in a file, or printed;
#   - every step can be run again safely.
set -euo pipefail

PROJECT="${EVENTHUB_PROJECT:-event-hub-2b58e}"
REGION="${EVENTHUB_REGION:-asia-southeast1}"
SQL_INSTANCE="${EVENTHUB_SQL_INSTANCE:-eventhub-staging}"
DATABASE="${EVENTHUB_DATABASE:-eventhub}"
BUCKET="${EVENTHUB_BUCKET:-${PROJECT}-images-staging}"
REGISTRY_REPO="${EVENTHUB_REGISTRY_REPO:-eventhub}"

CONNECTION="${PROJECT}:${REGION}:${SQL_INSTANCE}"
SOCKET="/cloudsql/${CONNECTION}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/${REGISTRY_REPO}"
sa() { echo "eventhub-$1@${PROJECT}.iam.gserviceaccount.com"; }

GCLOUD=(gcloud --project "$PROJECT" --quiet)
say() { printf '%s\n' "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }

# Percent-encodes standard input for use inside a URL (passwords may hold any character).
urlencode() {
  local LC_ALL=C s c i
  s=$(cat)
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) printf '%s' "$c" ;;
      *) printf '%%%02X' "'$c" ;;
    esac
  done
}

secret_exists() { "${GCLOUD[@]}" secrets describe "$1" >/dev/null 2>&1; }

# put_secret NAME: stores standard input as the secret's newest version, creating it if needed.
put_secret() {
  local name="$1"
  if secret_exists "$name"; then
    "${GCLOUD[@]}" secrets versions add "$name" --data-file=- >/dev/null
  else
    "${GCLOUD[@]}" secrets create "$name" --replication-policy=user-managed \
      --locations="$REGION" --data-file=- >/dev/null
  fi
}

# read_secret NAME: writes the newest version to standard output. Only ever piped, never shown.
read_secret() { "${GCLOUD[@]}" secrets versions access latest --secret="$1"; }

# allow_secret NAME SERVICE...: lets those service accounts read that one secret.
allow_secret() {
  local name="$1" who
  shift
  for who in "$@"; do
    "${GCLOUD[@]}" secrets add-iam-policy-binding "$name" \
      --member="serviceAccount:$(sa "$who")" --role=roles/secretmanager.secretAccessor >/dev/null
  done
}

# The image tag to deploy: the commit the images were built from.
image_tag() { echo "${EVENTHUB_IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"; }
image() { echo "${REGISTRY}/$1:$(image_tag)"; }
