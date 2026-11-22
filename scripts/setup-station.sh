#!/usr/bin/env bash
# setup-station.sh — install this company's own StarNet station next to any other on the machine.
#
#   scripts/setup-station.sh            # clone StarNet, apply company/patches, write env + systemd user units (not started)
#   scripts/setup-station.sh --start    # ...and enable + start the station, the dispatcher loop and the liveness timer, then wait
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
# Dispatcher tick (minutes), shown by --check: company/work/ops/cadence.json, else its default, else 10. The dispatcher
# is a self-paced loop (company/tools/dispatcher-loop.js) that re-reads the tick every iteration: no timer to rewrite.
TICK="$(node -e "const fs=require('fs');for(const f of ['company/work/ops/cadence.json','company/defaults/work/ops/cadence.json']){try{const n=Number(JSON.parse(fs.readFileSync(f,'utf8')).dispatcherTickMin);if(Number.isInteger(n)&&n>0){process.stdout.write(String(n));process.exit(0)}}catch(_){}}process.stdout.write('10')")"
# the company's own systemd slice (company/tools/lib/memory.js sliceOf: capheos-<svc>.slice, outside app.slice); every unit
# template says Slice=@SLICE@, and memory.js apply below writes the slice with systemd-oomd's pressure kill off. A running
# unit moves into it at its next restart.
SLICE="$(node -e "process.stdout.write(require('./company/tools/lib/memory.js').sliceOf(require('./company/company.json')))")"
ENVFILE="$HOME/.config/$SVC.env"
UNITDIR="$HOME/.config/systemd/user"

if [[ "${1:-}" == "--check" ]]; then
  echo "company:   $NAME"
  echo "port:      $PORT   service: $SVC   slice: $SLICE   dispatcher tick: ${TICK}min"
  echo "starnet:   $( [[ -d starnet/.git ]] && git -C starnet rev-parse --short HEAD || echo 'not cloned')"
  echo "env file:  $( [[ -f $ENVFILE ]] && echo "$ENVFILE" || echo missing)"
  echo "token:     $( [[ -s secrets/station-token ]] && echo present || echo missing)"
  echo "linger:    $(node company/tools/lib/host.js --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const l=JSON.parse(d).linger;console.log(l.state+(l.state==="off"?"  (the units stop when your last login ends; fix: "+l.fix+")":""))}catch(_){console.log("unknown")}})')"
  systemctl --user --no-pager status "$SVC.service" "$SVC-dispatch.service" "$SVC-liveness.timer" "$SVC-liveness-heartbeat.timer" 2>/dev/null | grep -E '●|Active:' || echo "units:     not installed"
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
NEW_PATCHES=()
for d in company/patches/[0-9][0-9][0-9][0-9]-*.diff; do
  [[ -e "$d" ]] || continue
  mark="$d.applied"
  [[ -e "$mark" ]] && continue
  if grep -q '^# Status: NOT APPLIED' "$d"; then echo "skip $(basename "$d") (opt-in; see its header)"; continue; fi
  # In a company (founded) checkout only the framework's own patches apply. A patch the crew wrote here (not tracked in
  # git) changes the shared engine, so it becomes a framework request instead and reaches every company through an update.
  if [[ -e company/work/.founded ]] && ! git ls-files --error-unmatch -- "$d" >/dev/null 2>&1; then
    mkdir -p company/work/framework-requests
    req="company/work/framework-requests/patch-$(basename "$d" .diff).md"
    [[ -e "$req" ]] || printf '# Framework change request: StarNet patch %s\n\nThe crew wrote this StarNet patch inside the company. Patches change the shared engine, so they are applied only from the framework. Forward it to the framework; it reaches this company with the next update.\n\nFile: `%s`\n' "$(basename "$d")" "$d" > "$req"
    echo "skip $(basename "$d") (written in this company, not by the framework: see $req)"; continue
  fi
  # --3way needs the checkout's index to match its files; a record applied earlier without it (git's "falling back to
  # direct application") leaves them apart, so a later record on the same file is retried as a plain apply
  if git -C starnet apply --3way --whitespace=nowarn "../$d" || git -C starnet apply --whitespace=nowarn "../$d"; then
    date -Is > "$mark"; echo "applied $(basename "$d")"; NEW_PATCHES+=("$(basename "$d" .diff)")
  else
    echo "FAILED to apply $(basename "$d"); fix by hand, then: date -Is > $mark" >&2
  fi
done

( cd starnet && npm install --no-audit --no-fund --loglevel=error )

# 3. Secrets and env
mkdir -p secrets .starnet-data/workspaces
# the company's own temp dir, on disk: the station, the dispatcher and the console run with TMPDIR here, so what agents,
# their builds and tests leave behind is not held in RAM (/tmp is a tmpfs on most hosts) and company/tools/tmp-sweep.js
# can clear it without judging anyone else's files. Its presence is also what turns that hourly sweep on.
mkdir -p .starnet-data/tmp && chmod 700 .starnet-data/tmp
chmod 700 secrets
if [[ ! -s secrets/station-token ]]; then
  ( umask 077; node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > secrets/station-token )
  echo "created secrets/station-token"
fi
mkdir -p "$(dirname "$ENVFILE")"
# Guardrail localComputer: the company's systemctl / systemd-run shims (company/tools/shims, company/tools/service.js) go
# first on the station's PATH, so an agent's `systemctl --user enable/start/daemon-reload` is refused while the guardrail
# is on. Then company/env/bin: the CLIs the crew installed through company/tools/deps.js (links into the company's own
# venv and node_modules; docs/DEPS.md). The rest is the user manager's own PATH, so the station finds exactly the
# programs it found before.
# STARNET_OVERRIDE_ALLOW (StarNet patch 0017): the one-run model override allowlist the dispatcher rewrites every tick
# (company/tools/lib/override-allow.js); without it, or once it is 30 minutes old, the station refuses every override.
# STARNET_CRON_HEARTBEAT_STALE_MS: how long a routine run may go without progress before the station reclaims it. StarNet's
# default is 8 min, but one shell command may run 10 min (shell.exec's cap), so a quiet long command had a healthy run
# reclaimed mid-command; 13 min is the command cap plus a model turn.
# STARNET_DELEGATE_ALLOW (StarNet patch 0018): the delegation allowlist the dispatcher rewrites every tick
# (company/tools/lib/delegate-allow.js); without it, or once it is 30 minutes old, no routine run gets team.dispatch.
# StarNet patch 0022 (docs/FREE-MODELS.md): every OpenRouter request is scrubbed of the exact values in secrets/
# (STARNET_SCRUB_SECRETS_DIR) and of the secret formats in company/tools/lib/secret-patterns.json (STARNET_SCRUB_PATTERNS),
# with counts, never values, in .starnet-data/outbound-scrub.jsonl (STARNET_SCRUB_LOG); a free model carries a zero max
# price, with failover inside the request to the free list (STARNET_OPENROUTER_FREE_POOL). STARNET_OPENROUTER_FREE_ONLY=1
# (every OpenRouter request has a zero max price; a paid model is refused) unless model-policy.json allowed.openrouter.paid
# is true. STARNET_OPENROUTER_FREE_ALTERNATES is model-policy.json freeFallback.maxAlternates (0 to 2, default 2).
FREE_ALTS="$(node -e "let p={};try{p=require('./company/model-policy.json')}catch(_){};const n=Number((p.freeFallback||{}).maxAlternates);process.stdout.write(String(Number.isInteger(n)&&n>=0?Math.min(2,n):2))")"
FREE_ONLY="$(node -e "let p={};try{p=require('./company/model-policy.json')}catch(_){};process.stdout.write(((p.allowed||{}).openrouter||{}).paid===true?'0':'1')")"
UPATH="$(systemctl --user show-environment 2>/dev/null | sed -n 's/^PATH=//p')"; UPATH="${UPATH:-/usr/local/bin:/usr/bin:/bin}"
( umask 077; cat > "$ENVFILE" <<EOF
# $SVC — written by $ROOT/scripts/setup-station.sh. Holds the station token (mode 0600).
PATH=$ROOT/company/tools/shims:$ROOT/company/env/bin:$UPATH
STARNET_WORKSPACES=$ROOT/.starnet-data/workspaces
XDG_DATA_HOME=$ROOT/.starnet-data
PORT=$PORT
STARNET_API_TOKEN=$(cat secrets/station-token)
STARNET_HOST=127.0.0.1
STARNET_HEADLESS=1
STARNET_OVERRIDE_ALLOW=$ROOT/company/state/override-allow.json
STARNET_DELEGATE_ALLOW=$ROOT/company/state/delegate-allow.json
STARNET_CRON_HEARTBEAT_STALE_MS=780000
STARNET_SCRUB_SECRETS_DIR=$ROOT/secrets
STARNET_SCRUB_PATTERNS=$ROOT/company/tools/lib/secret-patterns.json
STARNET_SCRUB_LOG=$ROOT/.starnet-data/outbound-scrub.jsonl
STARNET_OPENROUTER_FREE_POOL=$ROOT/company/state/free-models.json
STARNET_OPENROUTER_FREE_ALTERNATES=$FREE_ALTS
STARNET_SLIM_AUTONOMOUS_TOOLS=1
STARNET_OPENROUTER_FREE_ONLY=$FREE_ONLY
TMPDIR=$ROOT/.starnet-data/tmp
TZ=$ZONE
EOF
)

# 3a. the runtime's one dependency (Cordis, pinned in runtime/package-lock.json): the unit system's compat host
# (runtime/src/compat-host.mjs) runs units' plugins with it. Installed from the lockfile, no install scripts.
if [[ -f runtime/package-lock.json ]] && command -v npm >/dev/null 2>&1; then
  ( cd runtime && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --silent ) && echo "runtime: dependencies installed (Cordis)" || echo "runtime: npm ci failed (non-fatal); units with code wait until it runs"
fi
# 3b. the merge gate's pre-push hook in every checkout the crew pushes from (company/repos/*): no push to the default
# branch, no force push, no deleting main (company/tools/capheos-merge.js hook; idempotent, an older hook is chained)
for d in "$ROOT"/company/repos/*/; do
  [ -e "$d/.git" ] && node "$ROOT/company/tools/capheos-merge.js" hook "$d" >/dev/null 2>&1 && echo "merge-gate pre-push hook: $d" || true
done

# 4. systemd user units from systemd/*.in
mkdir -p "$UNITDIR"
for t in systemd/*.in; do
  out="$UNITDIR/$(basename "$t" .in | sed -e "s/^capheos-station/$SVC/" -e "s/^capheos-liveness/$SVC-liveness/")"
  sed -e "s|@ROOT@|$ROOT|g" -e "s|@SVC@|$SVC|g" -e "s|@NAME@|$NAME|g" -e "s|@ENVFILE@|$ENVFILE|g" -e "s|@TICK@|$TICK|g" -e "s|@SLICE@|$SLICE|g" "$t" > "$out"
  echo "wrote $out"
done
# Migration: the dispatcher used to be a oneshot service fired by $SVC-dispatch.timer. It is now a long-lived loop
# (Type=simple, Restart=always); retire the old timer so the two never run ticks side by side.
DISPATCH_WAS_ON=0
if [[ -f "$UNITDIR/$SVC-dispatch.timer" ]]; then
  systemctl --user is-enabled --quiet "$SVC-dispatch.timer" 2>/dev/null && DISPATCH_WAS_ON=1
  systemctl --user disable --now "$SVC-dispatch.timer" 2>/dev/null || true
  rm -f "$UNITDIR/$SVC-dispatch.timer"
  echo "retired $SVC-dispatch.timer (the dispatcher is now the self-paced $SVC-dispatch.service)"
fi
systemctl --user daemon-reload
# memory limits from company.json runtime.memory (company/tools/memory.js): a drop-in per unit and .starnet-data/memory.env,
# applied live to running units, never a restart; the first line says what was chosen for this machine
node company/tools/memory.js apply || echo "memory.js apply did not run (see above); the units keep their built-in defaults"
# registered background services (company/tools/service.js): units an older template wrote are written again from the
# current one, so a template fix (e.g. the start limit of a fast timer) reaches what is already installed
[[ -f company/state/services.json ]] && { node company/tools/service.js rerender --by owner || echo "service.js rerender did not run (see above)"; }
# these writes are the owner's own setup, not drift: record them with the change watcher so nobody is flagged
if [[ -f company/tools/locked-watch.js && -e company/state/locked/baseline.json ]]; then
  OWNER_NAME="$(cfg 'c.owner&&c.owner.name')"
  for f in "$ENVFILE" "$UNITDIR/$SVC".service "$UNITDIR/$SVC"-*.service "$UNITDIR/$SVC"-*.timer company/work/ops/cadence.json; do
    [[ -e "$f" ]] || continue
    rel="${f/#$HOME/\~}"; [[ "$f" == "$ROOT"/* ]] && rel="${f#$ROOT/}"
    node company/tools/locked-watch.js accept "$rel" --by owner --why "owner ran scripts/setup-station.sh" >/dev/null 2>&1 || true
  done
fi
# Migration: the off-box heartbeat ping moved out of the liveness watcher into its own unit ($SVC-liveness-heartbeat.timer),
# so the owner's outside-alarm test pauses only the ping and never the dispatcher-silence check. Wherever the watcher
# timer is on, switch the heartbeat timer on beside it (until then the watcher keeps pinging, so nothing goes quiet).
if [[ "${1:-}" != "--start" ]] && systemctl --user is-enabled --quiet "$SVC-liveness.timer" 2>/dev/null; then
  systemctl --user enable --now "$SVC-liveness-heartbeat.timer" && echo "started $SVC-liveness-heartbeat.timer (the outside heartbeat, now its own unit)" || echo "heartbeat timer not started (non-fatal; the watcher keeps pinging)"
fi
if [[ $DISPATCH_WAS_ON -eq 1 && "${1:-}" != "--start" ]]; then
  systemctl --user enable "$SVC-dispatch.service" && systemctl --user restart "$SVC-dispatch.service" && echo "started the dispatcher loop in place of the old timer"
fi

# 5. systemd user lingering. Without it the user manager — and with it the station, the dispatcher and the console —
# is stopped when this account's last login session ends (an SSH session closing). On a desktop that is rarely noticed;
# on a server it takes the company down. Turn it on when allowed (polkit lets a user do it on many distributions),
# else say plainly that the server's admin must, once. Not applicable in a container (company/tools/lib/host.js).
LINGER_STATE="$(node company/tools/lib/host.js --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).linger.state)}catch(_){console.log("unknown")}})')"
if [[ "$LINGER_STATE" == off || "$LINGER_STATE" == unknown ]]; then
  if "${LOGINCTL:-loginctl}" enable-linger "$USER" >/dev/null 2>&1 && [[ "$("${LOGINCTL:-loginctl}" show-user "$USER" --property=Linger --value 2>/dev/null)" == yes ]]; then
    echo "turned on systemd user lingering for $USER (the company keeps running after you log out)"
  else
    echo
    echo "WARNING: systemd user lingering is OFF for $USER, and this account may not turn it on itself."
    echo "  Without it the station, the dispatcher and the console stop when $USER's last login session ends."
    echo "  Whoever administers this server runs this once:  sudo loginctl enable-linger $USER"
    echo
  fi
fi

# A patch applied to a RUNNING station is on disk but not live until the station restarts. Never restart here: a restart
# cuts off every run in flight. Print the one command that restarts it safely (it waits until nothing runs).
if [[ ${#NEW_PATCHES[@]} -gt 0 ]] && systemctl --user is-active --quiet "$SVC.service" 2>/dev/null; then
  echo
  echo "The station is running the old code: ${NEW_PATCHES[*]} load at its next restart. Not restarted (that would cut off running work)."
  echo "Restart it safely, when nothing is running (it holds new starts meanwhile and gives up after 90 min):"
  echo "  nohup setsid $ROOT/scripts/restart-station.sh --when-idle --max-wait-min 90 --reason \"patch ${NEW_PATCHES[*]}\" >/dev/null 2>&1 &"
  echo "Follow it: tail -f $ROOT/company/work/restart-station.log"
  echo
fi

if [[ "${1:-}" == "--start" ]]; then
  systemctl --user enable --now "$SVC.service"
  systemctl --user enable "$SVC-dispatch.service"
  systemctl --user restart "$SVC-dispatch.service"   # restart: an older unit (oneshot) may still be loaded
  # the liveness watcher (modules/liveness/watch.js) exits quietly until the liveness module is enabled
  systemctl --user enable --now "$SVC-liveness.timer" || echo "liveness timer not started (non-fatal)"
  systemctl --user enable --now "$SVC-liveness-heartbeat.timer" || echo "heartbeat timer not started (non-fatal; the watcher keeps pinging)"
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
    # the console is the UI (the station runs headless): start it as its own unit and print where it is
    systemctl --user enable --now "$SVC-console.service" || echo "console not started (non-fatal): scripts/console.sh"
    echo "station up on http://127.0.0.1:$PORT (headless engine; the UI is the console)"
    echo "console: http://127.0.0.1:$((PORT + 100))/login  (sign in with the token in secrets/console-token; never put it in an address)"
  else
    node company/tools/onboard.js --record station-answers failed --note "GET /api/cron did not answer within ${WAIT}s" >/dev/null 2>&1 || true
    echo "station did NOT answer GET /api/cron within ${WAIT}s; see .starnet-data/station.log" >&2; exit 1
  fi
else
  node company/tools/onboard.js --record station-installed ok >/dev/null 2>&1 || true
  echo "installed, not started. Start with: scripts/setup-station.sh --start"
fi
# company skills on every seat: whenever the station is running after setup (a new company's first start, or any
# framework update), every seat gets every company skill, changed ones refreshed (skills.js install-all). The
# dispatcher's 30-minute reconcile repairs anything missing later. Non-fatal: no AI is used, and a station that is not
# up yet is covered by that reconcile.
if curl -fsS -m 3 -H "x-starnet-token: $(cat secrets/station-token 2>/dev/null)" "http://127.0.0.1:$PORT/api/cron" >/dev/null 2>&1; then
  node company/tools/skills.js install-all --by owner >/dev/null 2>&1 && echo "company skills: installed on every seat" || echo "company skills: not all installed now (the dispatcher's reconcile retries every 30 min)"
fi
