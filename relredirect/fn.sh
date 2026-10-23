vulcan_release_redirect_setup() {
  local root="$1" url="$2" preload="$1/opt/vulcan/release-redirect.cjs" cfg="$1/etc/vulcan/release-redirect.json"
  local list repo repos="" bin real n=0
  [ -f "$preload" ] || return 0
  list="$(curl -fsS --max-time 2 "$url/releases/v1/repos" 2>/dev/null)" || list="oven-sh/bun"
  while read -r repo; do
    [[ "$repo" =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ ]] || continue
    repos="$repos${repos:+,}\"$repo\""
  done <<< "$list"
  [ -n "$repos" ] || return 0
  mkdir -p "${cfg%/*}" || return 0
  printf '{"url":"%s","repos":[%s]}\n' "$url" "$repos" > "$cfg.tmp" && chmod 0644 "$cfg.tmp" && mv -f "$cfg.tmp" "$cfg" || return 0
  for bin in "$root"/home/runner/actions-runner/externals/node*/bin/node; do
    real="$bin.real"
    [ -f "$bin" ] && [ ! -L "$bin" ] && [ ! -e "$real" ] || continue
    mv -f "$bin" "$real" || continue
    # Absolute paths in single quotes (no quote in any of them: fixed names).
    if ! printf '%s\n' '#!/bin/sh' \
      '# Release downloads from JavaScript actions via the cache (/opt/vulcan/run-job.actions.sh).' \
      '# VULCAN_RELEASE_REDIRECT=0 in a step env: plain Node.' \
      "[ \"\${VULCAN_RELEASE_REDIRECT:-}\" = 0 ] && exec '$real' \"\$@\"" \
      "VULCAN_RELEASE_REDIRECT_CONFIG='$cfg' exec '$real' --require '$preload' \"\$@\"" > "$bin" \
      || ! chmod 0755 "$bin"; then
      mv -f "$real" "$bin"
      continue
    fi
    n=$((n + 1))
  done
  echo "run-job: release downloads from JavaScript actions go through the cache ($n Node wrappers)" >&2
  return 0
}
