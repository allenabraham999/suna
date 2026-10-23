# Bench-only setup, excluded from the measured time (job time minus this step).
# warm:   stand-in for a warm template (pnpm fetch from the lockfile into /opt/vulcan/warm/pnpm-store), caches dropped.
# warmrc: warm + a primed pull-through cache for GitHub release assets (stand-in for a host-local one),
#         with ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR pointed at it.
set -eu
v=$1; repo=$2; sha=$3
raw=https://raw.githubusercontent.com/$repo/$sha
d=$(mktemp -d /var/tmp/pb.XXXX)
for f in pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc; do curl -fsSL "$raw/$f" -o "$d/$f" || true; done
for f in $(python3 -c 'import json,sys;print(" ".join(json.load(open(sys.argv[1])).get("pnpm",{}).get("patchedDependencies",{}).values()))' "$d/package.json"); do
  mkdir -p "$d/$(dirname "$f")"; curl -fsSL "$raw/$f" -o "$d/$f"; done
sudo install -d -o runner -g runner /opt/vulcan/warm/pnpm-store
(cd "$d" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm fetch --frozen-lockfile --store-dir /opt/vulcan/warm/pnpm-store --reporter=append-only > /var/tmp/fetch.log 2>&1) && rc=0 || rc=$?
tail -2 /var/tmp/fetch.log; echo "fetch rc=$rc"; du -sh /opt/vulcan/warm/pnpm-store
rm -rf "$d" ~/.cache/pnpm ~/.local/share/pnpm
echo "npm_config_store_dir=/opt/vulcan/warm/pnpm-store" >> "$GITHUB_ENV"
if [ "$v" = warmrc ]; then
  BUN=$(command -v bun || ls /usr/local/bin/bun ~/.bun/bin/bun 2>/dev/null | head -1)
  curl -fsSL "$raw/.github/bs/artproxy.ts" -o /var/tmp/artproxy.ts
  mkdir -p /var/tmp/ap
  (HOST=127.0.0.1 PORT=7471 DIR=/var/tmp/ap nohup "$BUN" /var/tmp/artproxy.ts > /tmp/ap.log 2>&1 &)
  for i in $(seq 50); do curl -sf http://127.0.0.1:7471/stats >/dev/null && break; sleep 0.1; done
  P=http://127.0.0.1:7471/gh
  for u in electron/electron/releases/download/v39.8.10/electron-v39.8.10-linux-x64.zip \
           electron/electron/releases/download/v39.8.10/SHASUMS256.txt \
           electron-userland/electron-builder-binaries/releases/download/appimage-12.0.1/appimage-12.0.1.7z; do
    curl -fsS -o /dev/null -w "prime %{http_code} %{size_download} %{time_total}s $u\n" "$P/$u"; done
  echo "ELECTRON_MIRROR=$P/electron/electron/releases/download/" >> "$GITHUB_ENV"
  echo "ELECTRON_BUILDER_BINARIES_MIRROR=$P/electron-userland/electron-builder-binaries/releases/download/" >> "$GITHUB_ENV"
fi
sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
