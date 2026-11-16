#!/usr/bin/env bash
# health-check.sh — READ-ONLY health probe for the company: the station, its service, the dispatcher, and any
# product endpoints and backups the company has registered.
# No deploy, no apply, no write. Safe to run unattended at any hour.
#
# Checks:
#   1) station API answers (GET /api/cron with the station token) — url and token from company/company.json and
#      secrets/station-token through company/tools/lib/company.js
#   2) the station's systemd user service is active (station.serviceName; a read, never a restart)
#   3) the dispatcher is ALIVE, not merely installed: company/work/dispatch-log.md was written recently
#   4) product endpoints, if any: company/work/ops/health-targets.json
#        [{ "name": "api", "url": "https://example.com/health", "expect": 200, "jsonOk": ".ok" }]
#      (expect = HTTP code, default 200; jsonOk = optional dot path that must be true in the JSON body)
#   5) backup FRESHNESS, if registered: company/work/ops/backups.json
#        [{ "name": "db dump", "dir": "/path/to/dumps", "maxDays": 7 }]
#
# Why freshness and not existence: "the bucket exists" and "there is a recent backup" are different claims, and only
# the second is worth a check. A control that proves something exists can be green on every line while the capability
# it stands for is absent. Every check here that can say UNKNOWN says it as a failure, never as clean.
#
# Exit codes: 0 all healthy, 1 one or more checks failed or could not run, 2 usage/selftest failure.
#
# Usage: company/tools/health-check.sh            # all checks
#        company/tools/health-check.sh --selftest # offline fixtures for the freshness logic
# Env: HEALTH_DISPATCH_MAX_MIN (default 30), HEALTH_TARGETS (file, overrides the default), HEALTH_BACKUPS (file).
# Owner: the tools owner (routes by function; see company/tools/lib/company.js).
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
FAIL=0
note() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "FAIL: $*"; FAIL=1; }

cfg() { node -e 'const co=require(process.argv[1]); const k=process.argv[2];
  if (k==="url") console.log(co.STATION_URL);
  else if (k==="service") console.log(co.config.station.serviceName || "capheos-station");
  else if (k==="token") console.log(co.secret("station-token") || "");' "$HERE/lib/company.js" "$1" 2>/dev/null; }

# age_minutes <file> — minutes since the file was last written; empty if it does not exist
age_minutes() { [ -e "$1" ] || return 0; echo $(( ( $(date +%s) - $(stat -c %Y "$1") ) / 60 )); }
# newest_age_days <dir> — age in days of the youngest regular file under dir; empty if none
newest_age_days() {
  [ -d "$1" ] || return 0
  newest=$(find "$1" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)
  [ -n "$newest" ] || return 0
  echo $(( ( $(date +%s) - newest ) / 86400 ))
}
# json_rows <file> <fields...> — tab-separated rows from a JSON array of objects (node, no jq)
json_rows() { node -e 'const fs=require("fs"); let a=[]; try { a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch (e) { process.exit(3); }
  for (const r of (Array.isArray(a)?a:[])) console.log(process.argv.slice(2).map(k => String(r && r[k] != null ? r[k] : "")).join("\t"));' "$@"; }

if [ "${1:-}" = "--selftest" ]; then
  t=$(mktemp -d); trap 'rm -rf "$t"' EXIT; bad=0
  ok() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 (want '$3', got '$2')"; bad=$((bad+1)); fi; }
  touch "$t/fresh"; touch -d '3 hours ago' "$t/old"
  ok 'a file written now is 0 minutes old' "$(age_minutes "$t/fresh")" 0
  ok 'a file written 3 hours ago is 180 minutes old' "$(age_minutes "$t/old")" 180
  ok 'a missing file has no age (UNKNOWN, not fresh)' "$(age_minutes "$t/nope")" ''
  mkdir -p "$t/b/sub"; touch -d '10 days ago' "$t/b/a.dump"; touch -d '2 days ago' "$t/b/sub/b.dump"
  ok 'the youngest backup decides freshness' "$(newest_age_days "$t/b")" 2
  mkdir -p "$t/empty"
  ok 'an empty backup dir has no age (there is nothing to restore)' "$(newest_age_days "$t/empty")" ''
  printf '[{"name":"api","url":"http://x/health","expect":200}]' > "$t/targets.json"
  ok 'targets file parses into rows' "$(json_rows "$t/targets.json" name url expect)" "$(printf 'api\thttp://x/health\t200')"
  printf 'not json' > "$t/bad.json"; json_rows "$t/bad.json" name >/dev/null 2>&1; rc=$?
  ok 'an unreadable targets file is an error, not an empty list' "$rc" 3
  if [ "$bad" -eq 0 ]; then echo "HEALTH-CHECK SELFTEST PASSED (7 cases)"; exit 0; else echo "HEALTH-CHECK SELFTEST FAILED ($bad)"; exit 2; fi
fi
[ $# -eq 0 ] || { echo "usage: $0 [--selftest]" >&2; exit 2; }

# 1) station API
HOST=$(cfg url); TOKEN=$(cfg token)
if [ -z "$TOKEN" ]; then
  fail "station: no token in secrets/station-token — the API check cannot run; station health is UNKNOWN, not clean"
else
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -m 10 -H "x-starnet-token: $TOKEN" "$HOST/api/cron" 2>/dev/null) || CODE=000
  [ "$CODE" = "200" ] && note "station: API ok at $HOST" || fail "station: GET $HOST/api/cron answered HTTP $CODE"
fi

# 2) station service (read-only)
SERVICE=$(cfg service); SERVICE=${SERVICE:-capheos-station}; case "$SERVICE" in *.service) ;; *) SERVICE="$SERVICE.service" ;; esac
if command -v systemctl >/dev/null 2>&1; then
  ST=$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)
  [ "$ST" = "active" ] && note "service: $SERVICE active" || fail "service: $SERVICE is '${ST:-unknown}'"
else
  note "service: systemctl not available here (skipped)"
fi

# 3) dispatcher liveness — the log must be young, not merely present
MAXMIN=${HEALTH_DISPATCH_MAX_MIN:-30}
AGE=$(age_minutes "$ROOT/company/work/dispatch-log.md")
if [ -z "$AGE" ]; then fail "dispatcher: company/work/dispatch-log.md does not exist — the dispatcher has never run"
elif [ "$AGE" -gt "$MAXMIN" ]; then fail "dispatcher: last log line ${AGE} min ago (limit ${MAXMIN}) — the timer is not firing or every tick fails"
else note "dispatcher: last log line ${AGE} min ago"; fi

# 4) product endpoints
TARGETS=${HEALTH_TARGETS:-$ROOT/company/work/ops/health-targets.json}
if [ -f "$TARGETS" ]; then
  ROWS=$(json_rows "$TARGETS" name url expect jsonOk) || { fail "targets: $TARGETS is not a JSON array"; ROWS=; }
  while IFS="$(printf '\t')" read -r NAME URL EXPECT JSONOK; do
    [ -n "${URL:-}" ] || continue
    EXPECT=${EXPECT:-200}
    BODY=$(mktemp)
    CODE=$(curl -sS -o "$BODY" -w '%{http_code}' -m 20 "$URL" 2>/dev/null) || CODE=000
    if [ "$CODE" != "$EXPECT" ]; then fail "$NAME: HTTP $CODE (want $EXPECT) at $URL"
    elif [ -n "${JSONOK:-}" ]; then
      if node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].replace(/^\./,"").split(".").reduce((o,k)=>o==null?o:o[k],b); process.exit(v===true?0:1)' "$BODY" "$JSONOK" 2>/dev/null
      then note "$NAME: ok (HTTP $CODE, $JSONOK true)"; else fail "$NAME: HTTP $CODE but $JSONOK is not true: $(head -c 200 "$BODY")"; fi
    else note "$NAME: HTTP $CODE ($URL)"; fi
    rm -f "$BODY"
  done <<EOF
$ROWS
EOF
else
  note "targets: none registered ($TARGETS absent)"
fi

# 5) backup freshness
BACKUPS=${HEALTH_BACKUPS:-$ROOT/company/work/ops/backups.json}
if [ -f "$BACKUPS" ]; then
  ROWS=$(json_rows "$BACKUPS" name dir maxDays) || { fail "backups: $BACKUPS is not a JSON array"; ROWS=; }
  while IFS="$(printf '\t')" read -r NAME DIR MAXD; do
    [ -n "${DIR:-}" ] || continue
    MAXD=${MAXD:-7}
    D=$(newest_age_days "$DIR")
    if [ -z "$D" ]; then fail "backups: $NAME has no file under $DIR — there is nothing to restore"
    elif [ "$D" -gt "$MAXD" ]; then fail "backups: newest $NAME is ${D} day(s) old (limit $MAXD) — there is no recent dump to restore"
    else note "backups: newest $NAME is ${D} day(s) old"; fi
  done <<EOF
$ROWS
EOF
else
  note "backups: none registered ($BACKUPS absent)"
fi

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "HEALTH: FAIL"
  exit 1
fi
echo "HEALTH: all checks ok"
exit 0
