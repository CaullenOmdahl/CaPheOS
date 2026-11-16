#!/usr/bin/env bash
# restart-station-idle.sh — restart the station service only when no agent loop is mid-run.
#
# Why: the station's systemd EnvironmentFile (PATH, provider settings) is read once at service start, so a config
# change needs a restart. Restarting while a loop runs kills in-progress work, so this waits for a quiet window first.
# The station URL, the service name and the token come from company/company.json and secrets/ through
# company/tools/lib/company.js (station.url / station.port, station.serviceName, secrets/station-token).
#
#   nohup setsid bash company/tools/restart-station-idle.sh >/dev/null 2>&1 &
#   bash company/tools/restart-station-idle.sh --status     # what it would decide right now
#   bash company/tools/restart-station-idle.sh --selftest    # fixtures only, nothing live
#
# IT MUST NOT BE SILENT. Cron jobs can read `inFlight: true` from leases whose runs finished hours earlier, so
# `busy()` never returns 0 and the restart is unreachable. The stall is not the defect — the SILENCE is: every agent
# that armed a restart believes its fix is live while the process serving the station is an old build. This script
# names what is holding it, and repeats a STALLED line while it is held, so a stuck restart looks different from a
# quiet station.
#
# What it deliberately does NOT do: it does not treat an old `inFlight` flag as idle. /api/cron exposes
# no lease age, so a two-hour run and an eight-hour stale lease look identical from here; guessing is
# how a restart kills a live run. The flag's lifecycle is a harness question (starnet/sidecar).
#
# Env: RESTART_IDLE_NEED (seconds of continuous idle, default 120), RESTART_IDLE_POLL (default 15)
#      RESTART_IDLE_LOG (default company/work/restart-idle.log)
#      RESTART_IDLE_STALL (seconds an unchanged inFlight set may persist before it is reported, default 600)
# Exit: 0 restarted or idle (--status), 1 still busy (--status), 2 usage/selftest failure.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# station url, service name, token: one node call through lib/company.js (env STARNET_URL still wins there)
cfg() { node -e 'const co=require(process.argv[1]); const k=process.argv[2];
  if (k==="url") console.log(co.STATION_URL);
  else if (k==="service") console.log(co.config.station.serviceName || "capheos-station");
  else if (k==="token") console.log(co.secret("station-token") || "");' "$HERE/lib/company.js" "$1" 2>/dev/null; }
HOST="$(cfg url)"
SERVICE="$(cfg service)"; SERVICE="${SERVICE:-capheos-station}"; case "$SERVICE" in *.service) ;; *) SERVICE="$SERVICE.service" ;; esac
TOKEN=""
LOG="${RESTART_IDLE_LOG:-$ROOT/company/work/restart-idle.log}"
POLL="${RESTART_IDLE_POLL:-15}"
NEED="${RESTART_IDLE_NEED:-120}"
STALL="${RESTART_IDLE_STALL:-600}"
ts() { date '+%F %T'; }

# decide — reads the /api/cron payload on stdin, prints "<1|0> <what holds it>".
# 1 = busy (do not restart). The names are for the log, never for the decision.
decide() {
  python3 -c '
import sys, json
try:
    jobs = json.load(sys.stdin).get("jobs", [])
except Exception:
    print("1 api-unreadable"); sys.exit(0)
live = [j for j in jobs if j.get("inFlight") or j.get("state") == "running"]
print(("1 " if live else "0 ") + (",".join("%s[%s]" % (j.get("name") or j.get("id"), j.get("inFlightRunId") or "-") for j in live) or "-"))
'
}

fetch() { [ -n "$TOKEN" ] || TOKEN="$(cfg token)"; curl -s --max-time 8 -H "x-starnet-token: $TOKEN" "$HOST/api/cron"; }

case "${1:-}" in
  --decide)   # fixture mode: --decide <file> runs the same decision without a network call
    [ $# -ge 2 ] || { echo "usage: $0 --decide <json-file>" >&2; exit 2; }
    decide < "$2"; exit 0 ;;
  --status)
    out="$(fetch | decide)"; rc="${out%% *}"
    echo "busy:  $out"
    [ "$rc" = "0" ] && exit 0 || exit 1 ;;
  --selftest)
    fail=0
    t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
    check() { # label, fixture, want
      printf '%s' "$2" > "$t/j.json"
      got="$(decide < "$t/j.json")"; got="${got%% *}"
      if [ "$got" = "$3" ]; then echo "  ok   $1 [busy=$got]"; else echo "  FAIL $1 (want busy=$3, got busy=$got)"; fail=$((fail+1)); fi
    }
    check 'an empty station is idle' '{"jobs":[]}' 0
    check 'a job mid-run holds it' '{"jobs":[{"name":"Engineering loop","inFlight":true,"inFlightRunId":"abc"}]}' 1
    check 'a job in state running holds it' '{"jobs":[{"name":"Deploy loop","state":"running"}]}' 1
    check 'a settled job does not hold it' '{"jobs":[{"name":"Design loop","state":"scheduled","lastStatus":"ok"}]}' 0
    check 'an unreadable payload is BUSY, never idle' 'not json at all' 1
    # the naming half: the log must be able to say WHAT holds it, or the next reader re-derives it by hand
    printf '%s' '{"jobs":[{"name":"Deploy loop","inFlight":true,"inFlightRunId":"6afc401b"}]}' > "$t/j.json"
    if decide < "$t/j.json" | grep -q 'Deploy loop\[6afc401b\]'; then echo "  ok   the holding job and its run id are named"; else echo "  FAIL the holding job and its run id are named"; fail=$((fail+1)); fi
    printf '%s' 'not json at all' > "$t/j.json"
    if decide < "$t/j.json" | grep -q 'api-unreadable'; then echo "  ok   an unreadable payload says so"; else echo "  FAIL an unreadable payload says so"; fail=$((fail+1)); fi
    if [ "$fail" -eq 0 ]; then echo "SELFTEST PASSED (7 cases)"; exit 0; else echo "SELFTEST FAILED ($fail)"; exit 2; fi ;;
  '') ;;
  *) echo "usage: $0 [--status|--decide <json>|--selftest]" >&2; exit 2 ;;
esac

echo "$(ts) ARMED: will restart $SERVICE after ${NEED}s continuous idle (poll ${POLL}s); stall report after ${STALL}s unchanged" >> "$LOG"
idle=0
prev_sig=""
sig_since=0
reported=""
while true; do
  out="$(fetch | decide)"; b="${out%% *}"; sig="${out#* }"
  b="${b:-1}"                                   # API down => treat as busy, wait
  now=$(date +%s)
  if [ "$sig" != "$prev_sig" ]; then prev_sig="$sig"; sig_since="$now"; reported=""; fi
  if [ "$b" = "0" ]; then idle=$((idle + POLL)); else idle=0; fi
  if [ "$idle" -ge "$NEED" ]; then
    echo "$(ts) idle ${idle}s — restarting $SERVICE" >> "$LOG"
    systemctl --user restart "$SERVICE"
    exit 0
  fi
  # A station that is busy the same way for STALL seconds is a station this script cannot restart.
  # Say it, and say what to look at, rather than polling quietly forever.
  held=$((now - sig_since))
  if [ "$b" = "1" ] && [ "$held" -ge "$STALL" ] && [ "$reported" != "$sig" ]; then
    echo "$(ts) STALLED ${held}s: the restart cannot fire — inFlight has not changed and these hold it: ${sig}" >> "$LOG"
    echo "$(ts) STALLED -> if those runs finished hours ago the lease is stale, not live: check the station's cron lease records before forcing a restart" >> "$LOG"
    reported="$sig"
  fi
  sleep "$POLL"
done
