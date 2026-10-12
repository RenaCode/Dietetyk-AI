#!/usr/bin/env bash
# scripts/check-nginx-chart.sh
#
# Renders the frontend's nginx config from charts/dietetyk and checks that nginx can start
# WITHOUT cluster DNS. After a node reboot on 2026-10-05 the frontend pod started before
# CoreDNS answered; `proxy_pass http://<release>-backend:3000;` was resolved while nginx
# loaded its config, the lookup failed, and nginx did not start. The backend is now an
# `upstream` whose server is re-resolved at run time (`server ... resolve` with a `resolver`,
# templates/nginx-configmap.yaml), and this script keeps it that way:
#   1. helm lint and helm template succeed,
#   2. every proxy_pass names an upstream block, and that block has a zone, a resolver given
#      as an IP address and only `resolve` servers with a FQDN,
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

# Every proxy_pass must name an upstream block (a literal host:port is resolved at start).
grep -Eq '^[[:space:]]*proxy_pass[[:space:]]' "$WORK/default.conf" || fail "no proxy_pass in the rendered config"
for target in $(sed -n -E 's/^[[:space:]]*proxy_pass[[:space:]]+http:\/\/([^;[:space:]]*);.*/\1/p' "$WORK/default.conf"); do
    # Only that upstream's block.
    awk -v name="$target" '$1 == "upstream" && $2 == name { f = 1 } f { print } f && /^[[:space:]]*\}/ { exit }' \
        "$WORK/default.conf" > "$WORK/upstream.conf"
    [ -s "$WORK/upstream.conf" ] || fail "proxy_pass http://$target is not an upstream block - nginx resolves it at start"
    grep -Eq '^[[:space:]]*zone[[:space:]]' "$WORK/upstream.conf" \
        || fail "upstream $target has no zone (required by resolve)"
    grep -Eq '^[[:space:]]*resolver[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]' "$WORK/upstream.conf" \
        || fail "upstream $target has no resolver with an IP address (a hostname there is resolved at start)"
    grep -Eq '^[[:space:]]*server[[:space:]]' "$WORK/upstream.conf" || fail "upstream $target has no server"
    if grep -E '^[[:space:]]*server[[:space:]]' "$WORK/upstream.conf" | grep -Evq '^[[:space:]]*server[[:space:]]+[^[:space:]]+\.svc\.[^[:space:]]+:[0-9]+[[:space:]]+resolve;'; then
        fail "upstream $target has a server that is not <svc>.<ns>.svc.<domain>:<port> resolve"
    fi
done

IMAGE="$(sed -n -E 's/^FROM[[:space:]]+(nginxinc\/[^[:space:]]+).*/\1/p' "$ROOT/docker/frontend.Dockerfile" | head -1)"
[ -n "$IMAGE" ] || fail "no nginx base image in docker/frontend.Dockerfile"
# The pod's conditions: uid 101, read-only root filesystem, writable /tmp. No network at all,
# so not even Docker's embedded DNS can answer.
docker run --rm --network none --read-only --tmpfs /tmp --user 101:101 \
    -v "$WORK/default.conf:/etc/nginx/conf.d/default.conf:ro" \
    --entrypoint nginx "$IMAGE" -t \
    || fail "nginx -t without network failed on the rendered config"

echo "OK: nginx config from charts/dietetyk starts without DNS and resolves the backend at run time"
