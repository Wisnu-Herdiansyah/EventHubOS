#!/usr/bin/env bash
# Smoke test for the four container images (ADR-0053). Runs each image the way Cloud Run will:
# no source tree, configuration from the environment, port 8080 style HTTP, SIGTERM to stop.
#
#   DATABASE_ADMIN_URL=postgres://postgres:...@127.0.0.1:5432/postgres scripts/container-smoke.sh
#
# Needs: docker, a PostgreSQL 16 server reachable from the host network, and the images built
# with tags ${IMAGE_PREFIX}api, ...worker, ...admin, ...site (default prefix "eventhub-", tag
# ":test"). Creates a throwaway database with random passwords; prints neither.
set -euo pipefail

: "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL to a PostgreSQL superuser URL}"
PREFIX="${IMAGE_PREFIX:-eventhub-}"
TAG="${IMAGE_TAG:-test}"
img() { echo "${PREFIX}$1:${TAG}"; }

API_PORT=18080 ADMIN_PORT=18081 SITE_PORT=18082
DB="eventhub_smoke_$(date +%s)_$RANDOM"
rand() { openssl rand -hex 24; }
MIGRATOR_PW=$(rand) APP_PW=$(rand) WORKER_PW=$(rand)
SERVER_URL="${DATABASE_ADMIN_URL%/*}"
HOSTPORT="${SERVER_URL#*@}"
url() { echo "postgres://$1:$2@${HOSTPORT}/${DB}"; }
RUN=(docker run --rm --network host)
CONTAINERS=()

cleanup() {
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  "${RUN[@]}" -w /app/packages/db -e URL="$DATABASE_ADMIN_URL" -e DB="$DB" "$(img api)" \
    node --input-type=module -e "
      import pg from 'pg';
      const c = new pg.Client({ connectionString: process.env.URL }); await c.connect();
      await c.query('DROP DATABASE IF EXISTS ' + process.env.DB + ' WITH (FORCE)'); await c.end();
    " >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; for c in "${CONTAINERS[@]}"; do echo "--- logs: $c" >&2; docker logs "$c" 2>&1 | tail -20 >&2 || true; done; exit 1; }
wait_http() { # url, expected-status-test, label
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${4:-localhost}" "$1" || true)
    if [[ "$code" =~ $2 ]]; then echo "ok: $3 ($code)"; return 0; fi
    sleep 1
  done
  fail "$3: last status ${code:-none} from $1"
}

echo "== images run as an unprivileged user"
for s in api worker admin site; do
  uid=$(docker run --rm --entrypoint id "$(img "$s")" -u)
  [[ "$uid" != "0" ]] || fail "$s runs as root"
  echo "ok: $s uid $uid"
done

echo "== database: create, bootstrap and migrate from the api image"
"${RUN[@]}" -w /app/packages/db -e URL="$DATABASE_ADMIN_URL" -e DB="$DB" "$(img api)" \
  node --input-type=module -e "
    import pg from 'pg';
    const c = new pg.Client({ connectionString: process.env.URL }); await c.connect();
    await c.query('CREATE DATABASE ' + process.env.DB); await c.end();
  "
"${RUN[@]}" -e DATABASE_ADMIN_URL="${SERVER_URL}/${DB}" -e EVENTHUB_MIGRATOR_PASSWORD="$MIGRATOR_PW" \
  -e EVENTHUB_APP_PASSWORD="$APP_PW" -e EVENTHUB_WORKER_PASSWORD="$WORKER_PW" \
  "$(img api)" node packages/db/src/cli/bootstrap.ts
"${RUN[@]}" -e EVENTHUB_ENV=ci -e DATABASE_MIGRATOR_URL="$(url eventhub_migrator "$MIGRATOR_PW")" \
  "$(img api)" node packages/db/src/cli/migrate.ts

echo "== api"
CONTAINERS+=(smoke-api)
docker run -d --name smoke-api --network host -e EVENTHUB_ENV=ci -e HTTP_PORT=$API_PORT \
  -e DATABASE_APP_URL="$(url eventhub_app "$APP_PW")" "$(img api)" >/dev/null
wait_http "http://127.0.0.1:$API_PORT/health/live" '^200$' 'api live'
wait_http "http://127.0.0.1:$API_PORT/health/ready" '^200$' 'api ready (database reachable)'

echo "== worker"
CONTAINERS+=(smoke-worker)
docker run -d --name smoke-worker --network host -e EVENTHUB_ENV=ci \
  -e DATABASE_WORKER_URL="$(url eventhub_worker "$WORKER_PW")" -e EVENT_PUBLISHER=postgres_outbox \
  -e EMAIL_SENDER=in_memory -e APP_BASE_URL=http://localhost:$ADMIN_PORT \
  -e EMAIL_TOKEN_SECRET="$(rand)" "$(img worker)" >/dev/null
sleep 8
[[ "$(docker inspect -f '{{.State.Running}}' smoke-worker)" == "true" ]] || fail "worker exited"
docker stop -t 20 smoke-worker >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' smoke-worker)
[[ "$code" == "0" ]] || fail "worker did not stop cleanly on SIGTERM (exit $code)"
echo "ok: worker ran and stopped cleanly on SIGTERM"

echo "== HTTP images listen on their default port 8080 on all interfaces (as on Cloud Run)"
for s in api admin site; do
  CONTAINERS+=("smoke-port-$s")
  host_port=$((18090 + ${#CONTAINERS[@]}))
  # Bridge network and a published port: reachable only if the server binds 0.0.0.0:8080.
  docker run -d --name "smoke-port-$s" -p "127.0.0.1:${host_port}:8080" -e EVENTHUB_ENV=ci \
    -e DATABASE_APP_URL=postgres://nobody:none@127.0.0.1:1/none \
    -e ADMIN_API_URL=http://127.0.0.1:1 -e SITE_API_URL=http://127.0.0.1:1 \
    -e SITE_DOMAIN=events.test -e SITE_HTTPS=0 "$(img "$s")" >/dev/null
  case "$s" in
    api) wait_http "http://127.0.0.1:${host_port}/health/live" '^200$' "api on 0.0.0.0:8080" ;;
    admin) wait_http "http://127.0.0.1:${host_port}/login" '^200$' "admin on 0.0.0.0:8080" ;;
    # A host outside the platform domain is refused before any API call.
    site) wait_http "http://127.0.0.1:${host_port}/" '^404$' "site on 0.0.0.0:8080" 'example.org' ;;
  esac
done

echo "== admin"
CONTAINERS+=(smoke-admin)
docker run -d --name smoke-admin --network host -e PORT=$ADMIN_PORT \
  -e ADMIN_API_URL="http://127.0.0.1:$API_PORT" "$(img admin)" >/dev/null
wait_http "http://127.0.0.1:$ADMIN_PORT/login" '^200$' 'admin sign-in page'
curl -s "http://127.0.0.1:$ADMIN_PORT/login" | grep -q 'Sign in' || fail "admin sign-in page content"
curl -sI "http://127.0.0.1:$ADMIN_PORT/login" | grep -qi '^content-security-policy:' \
  || fail "admin CSP header missing"
echo "ok: admin page content and CSP"
asset=$(curl -s "http://127.0.0.1:$ADMIN_PORT/login" | grep -o '/_next/static/[^"]*\.\(css\|js\)' | head -1)
[[ -n "$asset" ]] || fail "admin page references no static asset"
wait_http "http://127.0.0.1:$ADMIN_PORT$asset" '^200$' 'admin static asset'

echo "== site"
CONTAINERS+=(smoke-site)
docker run -d --name smoke-site --network host -e PORT=$SITE_PORT \
  -e SITE_API_URL="http://127.0.0.1:$API_PORT" -e SITE_DOMAIN=events.test -e SITE_HTTPS=0 \
  "$(img site)" >/dev/null
# An unknown organization is a plain 404 page, served without errors.
wait_http "http://127.0.0.1:$SITE_PORT/" '^404$' 'site unknown handle' 'nobody.events.test'
asset=$(curl -s -H 'Host: nobody.events.test' "http://127.0.0.1:$SITE_PORT/" | grep -o '/_next/static/[^"]*\.\(css\|js\)' | head -1)
[[ -n "$asset" ]] || fail "site page references no static asset"
wait_http "http://127.0.0.1:$SITE_PORT$asset" '^200$' 'site static asset' 'nobody.events.test'

echo "== api stops cleanly on SIGTERM"
docker stop -t 20 smoke-api >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' smoke-api)
[[ "$code" == "0" ]] || fail "api did not stop cleanly on SIGTERM (exit $code)"
echo "ok: api stopped cleanly"

echo "PASS: all four images"
