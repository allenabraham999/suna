# Package archive steering for image/run-job.sh: sourced at boot, the probe
# runs in the background, never fatal.
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
# What it does:
#   1. in the background, a 256 KiB ranged GET from each IPv4 address of
#      those names, all in parallel, a few seconds at most;
#   2. each address is then one of
#        fast    delivered every byte, at >= 1/4 of the best address's rate;
#        dead    did not deliver every byte, at < 1/10 of the best one's rate;
#        unsure  anything in between: left alone, neither steered nor a target
#      (the margins keep a host under load, where every address is a little
#      slow, from steering healthy addresses);
#   3. with at least one fast and one dead address, one nft table sends plain
#      HTTP for the dead ones to a random fast one per connection (nft
#      numgen), so a host's VMs do not all land on the same upstream address.
#      The HTTP Host header is unchanged and every address serves the same
#      archive, so apt (in the VM, in containers, in docker build) sees no
#      difference but speed;
#   4. ACTIONS_RUNNER_HOOK_JOB_STARTED waits (bounded) for the probe, so the
#      table is in place before the job's first step opens a connection, and
#      prints the decision into the job's log ("Ubuntu archive: ...").
#
# Not covered: IPv6 (only IPv4 addresses are probed and steered), https://
# mirrors, and other archive hosts.
#
# Inputs (the controller's .env, taken out by run-job.sh):
#   VULCAN_ARCHIVE_STEER=0   turn it off for this VM
# Tunables (environment, for tests): VULCAN_ARCHIVE_HOSTS, VULCAN_ARCHIVE_PATH,
#   VULCAN_ARCHIVE_PROBE_BYTES, VULCAN_ARCHIVE_PROBE_S, VULCAN_ARCHIVE_WAIT_S.
# RUN_JOB_ROOT prefixes every absolute path (empty in a VM).

# The nft ruleset for: $1 the target addresses (space separated), then each
# address to steer.
vulcan_archive_ruleset() {
  local to="$1"; shift
  [ -n "$to" ] && [ "$#" -gt 0 ] || return 1
  local set ip i=0 map="" target
  set="$(printf '%s, ' "$@")"
  set="${set%, }"
  for ip in $to; do map="$map$i : $ip, "; i=$((i + 1)); done
  map="${map%, }"
  if [ "$i" -eq 1 ]; then target="${to// /}"; else target="numgen random mod $i map { $map }"; fi
  cat <<NFT
table ip vulcan_archive
delete table ip vulcan_archive
table ip vulcan_archive {
  chain pre {
    type nat hook prerouting priority -101; policy accept;
    ip daddr { $set } tcp dport 80 dnat to $target
  }
  chain out {
    type nat hook output priority -101; policy accept;
    ip daddr { $set } tcp dport 80 dnat to $target
  }
}
NFT
}

# "ip bytes seconds" lines on stdin; prints three lines, "fast ...",
# "dead ..." and "unsure ...", the addresses after the word. $1: the bytes
# a probe asks for.
vulcan_archive_classify() {
  awk -v want="$1" '
    { ip[NR] = $1; n[NR] = $2 + 0; t = $3 + 0; if (t < 0.001) t = 0.001; r[NR] = n[NR] / t
      if (n[NR] >= want && r[NR] > best) best = r[NR] }
    END {
      f = "fast"; d = "dead"; u = "unsure"
      for (i = 1; i <= NR; i++) {
        if (best > 0 && n[i] >= want && r[i] * 4 >= best) f = f " " ip[i]
        else if (best > 0 && n[i] < want && r[i] * 10 < best) d = d " " ip[i]
        else u = u " " ip[i]
      }
      print f; print d; print u
    }'
}

# Probe every address; load the table when some are fast and some dead.
# One summary line to stdout and to $root/var/lib/vulcan/archive/done.
# $1: the root.
vulcan_archive_probe() {
  local root="$1" hosts="${VULCAN_ARCHIVE_HOSTS:-archive.ubuntu.com security.ubuntu.com}"
  local path="${VULCAN_ARCHIVE_PATH:-/ubuntu/ls-lR.gz}" bytes="${VULCAN_ARCHIVE_PROBE_BYTES:-262144}" secs="${VULCAN_ARCHIVE_PROBE_S:-3}"
  local base="$root/var/lib/vulcan/archive" dir h ip addrs="" probe_host="" line t0 n t f d u total tail
  local fast=() dead=() unsure=()
  t0="$(date +%s.%N 2>/dev/null || date +%s)"
  [[ "$bytes" =~ ^[0-9]{1,9}$ ]] || bytes=262144
  [[ "$secs" =~ ^[0-9]{1,2}$ ]] || secs=3
  dir="$base/probe"
  mkdir -p "$dir" "$root/run/vulcan" || return 1
  for h in $hosts; do
    [[ "$h" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || continue
    [ -n "$probe_host" ] || probe_host="$h"
    for ip in $(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}'); do
      [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || continue
      case " $addrs " in *" $ip "*) ;; *) addrs="$addrs $ip" ;; esac
    done
  done
  if [ -z "$addrs" ]; then
    line="no addresses resolved; nothing steered"
  else
    # Each address: the bytes it delivered and how long it took. All at once.
    for ip in $addrs; do
      curl -s -o /dev/null -r "0-$((bytes - 1))" --connect-timeout 2 --max-time "$secs" \
        --resolve "$probe_host:80:$ip" -w '%{size_download} %{time_total}\n' \
        "http://$probe_host$path" > "$dir/$ip" 2>/dev/null &
    done
    wait
    for ip in $addrs; do
      n=0 t=0
      read -r n t < "$dir/$ip" 2>/dev/null || true
      [[ "$n" =~ ^[0-9]+$ ]] || n=0
      [[ "$t" =~ ^[0-9]+([.][0-9]+)?$ ]] || t=0
      echo "$ip $n $t"
    done | vulcan_archive_classify "$bytes" > "$dir/classes"
    { read -r f; read -r d; read -r u; } < "$dir/classes"
    read -ra fast <<< "${f#fast}"; read -ra dead <<< "${d#dead}"; read -ra unsure <<< "${u#unsure}"
    total=$((${#fast[@]} + ${#dead[@]} + ${#unsure[@]}))
    tail=""
    [ "${#unsure[@]}" -eq 0 ] || tail="; unsure, left alone: ${unsure[*]}"
    if [ "${#dead[@]}" -eq 0 ]; then
      line="${#fast[@]} of $total addresses fast, none dead; nothing steered$tail"
    elif [ "${#fast[@]}" -eq 0 ]; then
      line="no address fast (dead: ${dead[*]}); nothing steered$tail"
    elif [ -n "$root" ]; then
      # Under a test root: the ruleset, written down only.
      vulcan_archive_ruleset "${fast[*]}" "${dead[@]}" > "$root/run/vulcan/archive.nft"
      line="${dead[*]} -> ${fast[*]} (${#fast[@]} of $total addresses fast)$tail"
    elif ! command -v nft >/dev/null 2>&1; then
      line="no nft; nothing steered (dead: ${dead[*]})"
    elif vulcan_archive_ruleset "${fast[*]}" "${dead[@]}" | nft -f -; then
      line="${dead[*]} -> ${fast[*]} (${#fast[@]} of $total addresses fast)$tail"
    else
      line="nft failed; nothing steered (dead: ${dead[*]})"
    fi
  fi
  rm -rf "$dir"
  line="$line; probe $(awk -v a="$t0" -v b="$(date +%s.%N 2>/dev/null || date +%s)" 'BEGIN { printf "%.1f", b - a }')s"
  echo "archive steer: $line"
  printf '%s\n' "$line" > "$base/done.tmp" && chmod 0644 "$base/done.tmp" && mv -f "$base/done.tmp" "$base/done"
  return 0
}

# The runner's ACTIONS_RUNNER_HOOK_JOB_STARTED: waits for the probe (bounded),
# prints its decision into the job's log, then runs the hook it replaced (the
# git warm cache's), if any. $1: the root, $2: the runner's .env.
vulcan_archive_hook() {
  local root="$1" envf="$2" base="$1/var/lib/vulcan/archive" prev="" wait="${VULCAN_ARCHIVE_WAIT_S:-8}"
  [[ "$wait" =~ ^[0-9]{1,2}$ ]] || wait=8
  # The hook it replaces: the last one set, .env winning over the base.
  prev="$(cat "$root/opt/ci/runner-base.env" "$envf" 2>/dev/null | sed -n 's/^ACTIONS_RUNNER_HOOK_JOB_STARTED=//p' | tail -n 1)"
  [ "$prev" != "$base/job-started.sh" ] || prev=""
  cat > "$base/job-started.sh" <<HOOK || return 1
#!/bin/bash
# Vulcan package archive steering: up to ${wait}s for the probe, so its table
# is in place before the first step. Never fails the job.
for _ in \$(seq $((wait * 10))); do [ -e '$base/done' ] && break; sleep 0.1; done
if [ -s '$base/done' ]; then echo "Ubuntu archive: \$(cat '$base/done')"
else echo "Ubuntu archive: probe not finished after ${wait}s; nothing steered yet"; fi
prev='$prev'
if [ -n "\$prev" ] && [ -f "\$prev" ]; then exec bash "\$prev"; fi
exit 0
HOOK
  chmod 0755 "$base/job-started.sh"
  { grep -v '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' "$envf" 2>/dev/null || true; } > "$envf.archive" && mv -f "$envf.archive" "$envf" || return 1
  printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$base/job-started.sh" >> "$envf"
}

vulcan_archive_setup() {
  local root="${RUN_JOB_ROOT:-}"
  [ "${VULCAN_ARCHIVE_STEER:-1}" != 0 ] || return 0
  command -v curl >/dev/null 2>&1 && command -v getent >/dev/null 2>&1 || return 0
  local base="$root/var/lib/vulcan/archive"
  rm -rf "$base"
  mkdir -p "$base" "$root/run/vulcan" "$root/var/log" || return 1
  chmod 0755 "$base"
  # Its own shell (no set -e) and session, so the job's process-group cleanup never takes it down.
  local sess=()
  command -v setsid >/dev/null 2>&1 && sess=(setsid)
  ${sess[@]+"${sess[@]}"} bash -c "$(declare -f vulcan_archive_ruleset vulcan_archive_classify vulcan_archive_probe); vulcan_archive_probe \"\$1\"" _ "$root" \
    </dev/null >>"$root/var/log/vulcan-archive.log" 2>&1 &
  echo $! > "$base/probe.pid"
  vulcan_archive_hook "$root" "$root/home/runner/actions-runner/.env" \
    || echo "run-job: warn: archive steering hook not installed; a job may start before the table" >&2
  return 0
}

vulcan_archive_setup || echo "run-job: warn: archive steering not started" >&2
unset VULCAN_ARCHIVE_STEER
