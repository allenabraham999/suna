vulcan_release_redirect_setup() {
  local root="$1" url="$2" wrapper="$1/opt/vulcan/release-redirect-node" cfg="$1/etc/vulcan/release-redirect.json"
  local list repo repos="" bin n=0
  [ -x "$wrapper" ] && [ -f "$root/opt/vulcan/release-redirect.cjs" ] || return 0
  list="$(curl -fsS --max-time 2 "$url/releases/v1/repos" 2>/dev/null)" || list="oven-sh/bun"
  while read -r repo; do
    [[ "$repo" =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ ]] || continue
    repos="$repos${repos:+,}\"$repo\""
  done <<< "$list"
  [ -n "$repos" ] || return 0
  mkdir -p "${cfg%/*}" || return 0
  printf '{"url":"%s","repos":[%s]}\n' "$url" "$repos" > "$cfg.tmp" && chmod 0644 "$cfg.tmp" && mv -f "$cfg.tmp" "$cfg" || return 0
  for bin in "$root"/home/runner/actions-runner/externals/node*/bin/node; do
    [ -f "$bin" ] && [ ! -L "$bin" ] && [ ! -e "$bin.real" ] || continue
    mv -f "$bin" "$bin.real" || continue
    if cp "$wrapper" "$bin" && chmod 0755 "$bin"; then n=$((n + 1)); else mv -f "$bin.real" "$bin"; fi
  done
  echo "run-job: release downloads from JavaScript actions go through the cache ($n Node wrappers)" >&2
  return 0
}
