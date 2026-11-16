#!/usr/bin/env bash
# setup-station.sh — install this company's own StarNet station next to any other on the machine.
#
#   scripts/setup-station.sh            # clone StarNet, apply company/patches, write env + systemd user units (not started)
#   scripts/setup-station.sh --start    # ...and enable + start the station, the dispatcher and liveness timers, then wait
#                                       # (SETUP_WAIT_SEC, default 90) until GET /api/cron answers with the token
#   scripts/setup-station.sh --check    # show what is installed, change nothing
#
# Everything is per company: the checkout is ./starnet, the data is ./.starnet-data, the port and the service name come
# from company/company.json (station.port, station.serviceName). Two companies on one machine differ in those two
# values and nothing else. Secrets: secrets/station-token is created here (random, 0600) if missing.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STARNET_REPO="${STARNET_REPO:-https://github.com/androoAGI/starnet.git}"
STARNET_BRANCH="${STARNET_BRANCH:-feat/harness-backend}"
# The commit the patches in company/patches/ were written against. Override to try a newer StarNet.
STARNET_REF="${STARNET_REF:-e316231d70610aac7b181c4efd1a10b3fc833cdc}"

cfg() { node -e "const c=require('./company/company.json');const v=$1;process.stdout.write(String(v==null?'':v))"; }
PORT="$(cfg 'c.station&&c.station.port')"; PORT="${PORT:-8801}"
SVC="$(cfg 'c.station&&c.station.serviceName')"; SVC="${SVC:-capheos-station}"
NAME="$(cfg 'c.name')"
ZONE="$(cfg 'c.timezone')"; ZONE="${ZONE:-UTC}"
# Dispatcher tick (minutes): company/work/ops/cadence.json, else company/defaults/work/ops/cadence.json, else 10.
# company/tools/cadence.js apply rewrites the installed timer later; this only sets the first value.
TICK="$(node -e "const fs=require('fs');for(const f of ['company/work/ops/cadence.json','company/defaults/work/ops/cadence.json']){try{const n=Number(JSON.parse(fs.readFileSync(f,'utf8')).dispatcherTickMin);if(Number.isInteger(n)&&n>0){process.stdout.write(String(n));process.exit(0)}}catch(_){}}process.stdout.write('10')")"
ENVFILE="$HOME/.config/$SVC.env"
UNITDIR="$HOME/.config/systemd/user"

if [[ "${1:-}" == "--check" ]]; then
  echo "company:   $NAME"
  echo "port:      $PORT   service: $SVC   dispatcher tick: ${TICK}min"
  echo "starnet:   $( [[ -d starnet/.git ]] && git -C starnet rev-parse --short HEAD || echo 'not cloned')"
  echo "env file:  $( [[ -f $ENVFILE ]] && echo "$ENVFILE" || echo missing)"
  echo "token:     $( [[ -s secrets/station-token ]] && echo present || echo missing)"
  systemctl --user --no-pager status "$SVC.service" "$SVC-dispatch.timer" "$SVC-liveness.timer" 2>/dev/null | grep -E '●|Active:' || echo "units:     not installed"
  exit 0
fi

# Refuse to collide with another station already listening on this port.
if ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; then
  if ! systemctl --user is-active --quiet "$SVC.service"; then
    echo "port $PORT is already in use by something other than $SVC; set station.port in company/company.json" >&2; exit 1
  fi
fi

command -v node >/dev/null || { echo "node 22 is required" >&2; exit 1; }

# 1. StarNet checkout
if [[ ! -d starnet/.git ]]; then
  git clone --branch "$STARNET_BRANCH" "$STARNET_REPO" starnet
fi
git -C starnet fetch --quiet origin "$STARNET_BRANCH" || true
if [[ -z "$(git -C starnet status --porcelain)" ]]; then
  git -C starnet checkout --quiet "$STARNET_REF"
else
  echo "starnet/ has local changes; leaving the checkout where it is"
fi

# 2. Patches (records under company/patches/, applied once; a marker file records each)
for d in company/patches/[0-9][0-9][0-9][0-9]-*.diff; do
  [[ -e "$d" ]] || continue
  mark="$d.applied"
  [[ -e "$mark" ]] && continue
  if grep -q '^# Status: NOT APPLIED' "$d"; then echo "skip $(basename "$d") (opt-in; see its header)"; continue; fi
  if git -C starnet apply --3way --whitespace=nowarn "../$d"; then
    date -Is > "$mark"; echo "applied $(basename "$d")"
  else
    echo "FAILED to apply $(basename "$d"); fix by hand, then: date -Is > $mark" >&2
  fi
done

( cd starnet && npm install --no-audit --no-fund --loglevel=error )

# 3. Secrets and env
mkdir -p secrets .starnet-data/workspaces
chmod 700 secrets
if [[ ! -s secrets/station-token ]]; then
  ( umask 077; node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > secrets/station-token )
  echo "created secrets/station-token"
fi
mkdir -p "$(dirname "$ENVFILE")"
( umask 077; cat > "$ENVFILE" <<EOF
# $SVC — written by $ROOT/scripts/setup-station.sh. Holds the station token (mode 0600).
STARNET_WORKSPACES=$ROOT/.starnet-data/workspaces
XDG_DATA_HOME=$ROOT/.starnet-data
PORT=$PORT
STARNET_API_TOKEN=$(cat secrets/station-token)
STARNET_HOST=127.0.0.1
TZ=$ZONE
EOF
)

# 4. systemd user units from systemd/*.in
mkdir -p "$UNITDIR"
for t in systemd/*.in; do
  out="$UNITDIR/$(basename "$t" .in | sed -e "s/^capheos-station/$SVC/" -e "s/^capheos-liveness/$SVC-liveness/")"
  sed -e "s|@ROOT@|$ROOT|g" -e "s|@SVC@|$SVC|g" -e "s|@NAME@|$NAME|g" -e "s|@ENVFILE@|$ENVFILE|g" -e "s|@TICK@|$TICK|g" "$t" > "$out"
  echo "wrote $out"
done
systemctl --user daemon-reload

if [[ "${1:-}" == "--start" ]]; then
  systemctl --user enable --now "$SVC.service"
  systemctl --user enable --now "$SVC-dispatch.timer"
  # the liveness watcher (modules/liveness/watch.js) exits quietly until the liveness module is enabled
  systemctl --user enable --now "$SVC-liveness.timer" || echo "liveness timer not started (non-fatal)"
  # wait until the station answers GET /api/cron with the token (SETUP_WAIT_SEC, default 90), and record the step
  WAIT="${SETUP_WAIT_SEC:-90}"; UP=0
  for _ in $(seq 1 "$WAIT"); do
    if curl -fsS -m 3 -H "x-starnet-token: $(cat secrets/station-token)" "http://127.0.0.1:$PORT/api/cron" >/dev/null 2>&1; then UP=1; break; fi
    sleep 1
  done
  if [[ $UP -eq 1 ]]; then
    node company/tools/onboard.js --record station-answers ok --note "GET /api/cron answered on port $PORT" >/dev/null 2>&1 || true
    # the idempotent onboarding steps that need a live station (candidate default, ops registrations, first backup,
    # the owner-gate batch, guardrails apply); non-fatal: onboard.js --check shows what is left
    node company/tools/onboard.js --resume || echo "onboarding steps left: node company/tools/onboard.js --check"
    echo "station up on http://127.0.0.1:$PORT"
  else
    node company/tools/onboard.js --record station-answers failed --note "GET /api/cron did not answer within ${WAIT}s" >/dev/null 2>&1 || true
    echo "station did NOT answer GET /api/cron within ${WAIT}s; see .starnet-data/station.log" >&2; exit 1
  fi
else
  node company/tools/onboard.js --record station-installed ok >/dev/null 2>&1 || true
  echo "installed, not started. Start with: scripts/setup-station.sh --start"
fi
