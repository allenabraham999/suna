#!/bin/bash
# In-job stand-in for run-job.actions.sh's vulcan_release_redirect_setup (the
# template does not ship it yet). The live cache predates /releases/v1/repos,
# so the list falls back to oven-sh/bun.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
URL=http://10.42.0.1:7470
mkdir -p /opt/vulcan && cp "$HERE/release-redirect.cjs" /opt/vulcan/release-redirect.cjs && chmod 0644 /opt/vulcan/release-redirect.cjs
cc -O2 -static -o /opt/vulcan/release-redirect-node "$HERE/release-redirect-node.c" && chmod 0755 /opt/vulcan/release-redirect-node
curl -fsS --max-time 2 "$URL/releases/v1/ping" || { echo "cache ping failed"; exit 0; }
. "$HERE/fn.sh"
vulcan_release_redirect_setup "" "$URL"
cat /etc/vulcan/release-redirect.json
ls -la /home/runner/actions-runner/externals/node*/bin/
