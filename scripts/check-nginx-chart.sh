#!/usr/bin/env bash
# scripts/check-nginx-chart.sh
#
# Renders the frontend's nginx config from charts/dietetyk and checks that nginx can start
# WITHOUT cluster DNS. After a node reboot on 2026-10-05 the frontend pod started before
# CoreDNS answered; `proxy_pass http://<release>-backend:3000;` was resolved while nginx
# loaded its config, the lookup failed, and nginx did not start. The backend is now resolved
# per request (`resolver` + a variable in proxy_pass, templates/nginx-configmap.yaml), and
# this script keeps it that way:
#   1. helm lint and helm template succeed,
#   2. `location /api` has a resolver given as an IP address and a proxy_pass whose host is
#      a variable,
#   3. `nginx -t` passes in the image docker/frontend.Dockerfile builds from, in a container
#      with NO network (--network none) - the old config fails exactly here with
#      `host not found in upstream`.
#
# Needs helm and docker. Run from anywhere; CI runs it in the test-chart job.
# Exit code: 0 = all checks passed, 1 = a check failed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHART="$ROOT/charts/dietetyk"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "ERROR: $*" >&2; exit 1; }

helm lint "$CHART" >/dev/null || fail "helm lint charts/dietetyk"
helm template dietetyk "$CHART" -n default >/dev/null || fail "helm template charts/dietetyk"

# The ConfigMap's default.conf, without the 4-space YAML indentation.
helm template dietetyk "$CHART" -n default -s templates/nginx-configmap.yaml \
    | awk '/default.conf: \|/ { f = 1; next } f { sub(/^    /, ""); print }' > "$WORK/default.conf"
[ -s "$WORK/default.conf" ] || fail "no default.conf in the rendered nginx ConfigMap"

# Only `location /api { ... }`.
awk '/^[[:space:]]*location \/api[[:space:]]*\{/ { f = 1 } f { print } f && /^[[:space:]]*\}/ { exit }' \
    "$WORK/default.conf" > "$WORK/api.conf"
[ -s "$WORK/api.conf" ] || fail "no location /api in the rendered config"

grep -Eq '^[[:space:]]*resolver[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+([[:space:]]|;)' "$WORK/api.conf" \
    || fail "location /api has no resolver with an IP address (a hostname there is resolved at start)"
grep -Eq '^[[:space:]]*proxy_pass[[:space:]]+http://\$[a-z_]+;' "$WORK/api.conf" \
    || fail "proxy_pass in location /api does not take its host from a variable"
grep -Eq '^[[:space:]]*set[[:space:]]+\$[a-z_]+[[:space:]]+"[^"]*\.svc\.[^"]*:3000";' "$WORK/api.conf" \
    || fail "the backend address is not a FQDN (<svc>.<ns>.svc.<domain>:3000)"
if grep -Eq '^[[:space:]]*proxy_pass[[:space:]]+http://[a-zA-Z0-9]' "$WORK/default.conf"; then
    fail "a proxy_pass with a literal host is back - nginx resolves it at start"
fi

IMAGE="$(sed -n -E 's/^FROM[[:space:]]+(nginxinc\/[^[:space:]]+).*/\1/p' "$ROOT/docker/frontend.Dockerfile" | head -1)"
[ -n "$IMAGE" ] || fail "no nginx base image in docker/frontend.Dockerfile"
# The pod's conditions: uid 101, read-only root filesystem, writable /tmp. No network at all,
# so not even Docker's embedded DNS can answer.
docker run --rm --network none --read-only --tmpfs /tmp --user 101:101 \
    -v "$WORK/default.conf:/etc/nginx/conf.d/default.conf:ro" \
    --entrypoint nginx "$IMAGE" -t \
    || fail "nginx -t without network failed on the rendered config"

echo "OK: nginx config from charts/dietetyk starts without DNS and resolves the backend per request"
