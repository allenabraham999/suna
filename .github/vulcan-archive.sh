# Package archive steering for image/run-job.sh: sourced at boot, runs in
# the background, never fatal.
#
#   . /opt/vulcan/run-job.archive.sh
#
# Why: archive.ubuntu.com and security.ubuntu.com resolve, round robin, to a
# handful of addresses. From some hosts a few of those addresses are nearly
# dead (tens of KB/s, or no bytes at all) while the rest serve at line rate.
# apt sticks to the address it connected to, so a job whose `apt-get update`
# lands on a bad one waits minutes (measured: 432 s and 492 s for a step that
# takes 9 s on a good address), and which one it gets is luck.
#
# What it does: in the background, a 256 KiB ranged GET from each address
# (in parallel, a few seconds at most), then one nft table that sends plain
# HTTP for the addresses that failed to the fastest one that passed. The
# HTTP Host header is unchanged, and every address serves the same archive,
# so apt (in the VM, in containers, in docker build) sees no difference but
# speed. Nothing is steered when every address passes, when none does, or
# without nft.
#
# Inputs (the controller's .env, taken out by run-job.sh):
#   VULCAN_ARCHIVE_STEER=0   turn it off for this VM
# Tunables (environment, for tests): VULCAN_ARCHIVE_HOSTS, VULCAN_ARCHIVE_PATH,
#   VULCAN_ARCHIVE_PROBE_BYTES, VULCAN_ARCHIVE_PROBE_S.
# RUN_JOB_ROOT prefixes every absolute path (empty in a VM).

# The nft ruleset for: $1 the target address, then each address to steer.
vulcan_archive_ruleset() {
  local to="$1"; shift
  [ -n "$to" ] && [ "$#" -gt 0 ] || return 1
  local set
  set="$(printf '%s, ' "$@")"
  set="${set%, }"
  cat <<NFT
table ip vulcan_archive
delete table ip vulcan_archive
table ip vulcan_archive {
  chain pre {
    type nat hook prerouting priority -101; policy accept;
    ip daddr { $set } tcp dport 80 dnat to $to
  }
  chain out {
    type nat hook output priority -101; policy accept;
    ip daddr { $set } tcp dport 80 dnat to $to
  }
}
NFT
}

# Probe every address, write the ruleset when some pass and some fail.
# Prints one summary line. $1: the root.
vulcan_archive_probe() {
  local root="$1" hosts="${VULCAN_ARCHIVE_HOSTS:-archive.ubuntu.com security.ubuntu.com}"
  local path="${VULCAN_ARCHIVE_PATH:-/ubuntu/ls-lR.gz}" bytes="${VULCAN_ARCHIVE_PROBE_BYTES:-262144}" secs="${VULCAN_ARCHIVE_PROBE_S:-3}"
  local dir="$root/run/vulcan/archive" h ip addrs="" probe_host=""
  [[ "$bytes" =~ ^[0-9]{1,9}$ ]] || bytes=262144
  [[ "$secs" =~ ^[0-9]{1,2}$ ]] || secs=3
  mkdir -p "$dir" || return 1
  for h in $hosts; do
    [[ "$h" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || continue
    [ -n "$probe_host" ] || probe_host="$h"
    for ip in $(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}'); do
      [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || continue
      case " $addrs " in *" $ip "*) ;; *) addrs="$addrs $ip" ;; esac
    done
  done
  [ -n "$addrs" ] || { echo "archive steer: no addresses"; return 0; }
  # Each address: the bytes it delivered and how long it took. All at once.
  for ip in $addrs; do
    curl -s -o /dev/null -r "0-$((bytes - 1))" --connect-timeout 2 --max-time "$secs" \
      --resolve "$probe_host:80:$ip" -w '%{size_download} %{time_total}\n' \
      "http://$probe_host$path" > "$dir/$ip" 2>/dev/null &
  done
  wait
  local good=() bad=() best="" best_t="" n t
  for ip in $addrs; do
    read -r n t < "$dir/$ip" 2>/dev/null || { n=0; t=""; }
    if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge "$bytes" ]; then
      good+=("$ip")
      if [ -z "$best" ] || awk -v a="$t" -v b="$best_t" 'BEGIN { exit !(a < b) }'; then best="$ip"; best_t="$t"; fi
    else
      bad+=("$ip")
    fi
  done
  rm -rf "$dir"
  if [ "${#bad[@]}" -eq 0 ]; then echo "archive steer: all ${#good[@]} addresses fast; nothing steered"; return 0; fi
  if [ "${#good[@]}" -eq 0 ]; then echo "archive steer: no address passed (${bad[*]}); nothing steered"; return 0; fi
  if [ -n "$root" ] || ! command -v nft >/dev/null 2>&1; then
    vulcan_archive_ruleset "$best" "${bad[@]}" > "$root/run/vulcan/archive.nft"
  else
    vulcan_archive_ruleset "$best" "${bad[@]}" | nft -f - || { echo "archive steer: nft failed"; return 1; }
  fi
  echo "archive steer: ${bad[*]} -> $best (${#good[@]} of $((${#good[@]} + ${#bad[@]})) addresses fast)"
}

vulcan_archive_setup() {
  local root="${RUN_JOB_ROOT:-}"
  [ "${VULCAN_ARCHIVE_STEER:-1}" != 0 ] || return 0
  command -v curl >/dev/null 2>&1 && command -v getent >/dev/null 2>&1 || return 0
  mkdir -p "$root/run/vulcan" "$root/var/log" || return 1
  # Its own shell (no set -e) and session, so the job's process-group cleanup never takes it down.
  local sess=()
  command -v setsid >/dev/null 2>&1 && sess=(setsid)
  ${sess[@]+"${sess[@]}"} bash -c "$(declare -f vulcan_archive_ruleset vulcan_archive_probe); vulcan_archive_probe \"\$1\"" _ "$root" \
    </dev/null >>"$root/var/log/vulcan-archive.log" 2>&1 &
  echo $! > "$root/run/vulcan/archive.pid"
  return 0
}

vulcan_archive_setup || echo "run-job: warn: archive steering not started" >&2
unset VULCAN_ARCHIVE_STEER
