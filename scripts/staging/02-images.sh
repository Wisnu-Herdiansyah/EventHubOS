#!/usr/bin/env bash
# Step 2: build the four images with Cloud Build and push them to Artifact Registry, tagged with
# the current commit. Run from a clean checkout of the commit you want to deploy.
#
#   scripts/staging/02-images.sh
source "$(dirname "$0")/lib.sh"

[[ -z "$(git status --porcelain)" ]] || die "commit or stash local changes first: images are tagged by commit"
say "== building images for commit $(image_tag) (about 10 minutes)"
"${GCLOUD[@]}" builds submit . --region="$REGION" --config=cloudbuild.yaml \
  --substitutions="_REGISTRY=${REGISTRY},_TAG=$(image_tag)"
say "DONE: images pushed to ${REGISTRY}. Next: scripts/staging/03-database.sh"
