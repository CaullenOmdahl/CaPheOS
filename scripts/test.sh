#!/usr/bin/env bash
# test.sh — the framework's whole offline test suite, in one command. Used locally and by .github/workflows/ci.yml.
#
#   scripts/test.sh            run everything, print a summary table, exit 1 if any step failed
#
# Nothing here reaches a station: STARNET_URL points at a closed port, and every selftest runs against a temp copy of
# the repo (CAPHEOS_ROOT, honoured by company/tools/lib/company.js), so no test can dirty the checkout. TMPDIR is left
# alone on purpose: some selftests size text by their fixture path, and a deep private temp dir makes them fail. Every step runs even after a failure, so one run reports all of them.
# Nothing is left behind either (/tmp is RAM on most Linux hosts):
#   - before the copy and again at the end, the test walks' leftovers nobody uses any more are swept
#     (company/tools/tmp-sweep.js, class test, older than 2 minutes: a parallel run's live ones stay);
#   - each step runs in a session of its own (setsid), and when it ends, passed or failed, whatever is left in its
#     process group gets SIGTERM, then SIGKILL a second later;
#   - every process of this run carries CAPHEOS_TEST_RUN=<work dir>; the last step, "no processes left behind", lists
#     any that are still running (scripts/test-leftovers.js), ends them, and fails the run if there were any.
# Env: TEST_TIMEOUT (seconds per step, default 180); TEST_TRACKED_ONLY=1 copies only tracked files (what CI sees),
# leaving out untracked work in progress; CAPHEOS_TEST_FIXTURE=<script> runs only that script as one step, then the
# leftover check (tests/test-sh-hygiene.sh tests the runner itself this way); CAPHEOS_STARNET_SRC=<starnet checkout>
# for company/patches/tests/*.test.js (default: ./starnet when this is a company's checkout).
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TIMEOUT="${TEST_TIMEOUT:-180}"
SYS_TMP="${TMPDIR:-/tmp}"
FIXTURE="${CAPHEOS_TEST_FIXTURE:-}"
# every test walk's leftover nobody uses any more (Chrome profiles, per-run dirs; a parallel run's live ones are in use or
# younger than two minutes, so they stay): company/tools/tmp-sweep.js, class test. Before this run starts, and at its end.
sweep_walks() { CAPHEOS_TMP_SWEEP=1 node "$REPO/company/tools/tmp-sweep.js" apply --dir "$SYS_TMP" --class test --min-age 120 >/dev/null 2>&1; }
sweep_walks
START_MARK="$(mktemp "$SYS_TMP/capheos-test-start.XXXXXX")"   # its mtime is the run start
WORK="$(mktemp -d "$SYS_TMP/capheos-test-XXXXXX")"
COPY="$WORK/repo"; LOGS="$WORK/logs"
mkdir -p "$COPY" "$LOGS"

# end what is left of a finished step's process group (its id is the pid the step's session started with)
reap_group() {
  local pg; pg="$(cat "$1" 2>/dev/null)"; [[ "$pg" =~ ^[0-9]+$ ]] && [ "$pg" -gt 1 ] || return 0
  kill -0 -- "-$pg" 2>/dev/null || return 0
  kill -TERM -- "-$pg" 2>/dev/null; sleep 1; kill -KILL -- "-$pg" 2>/dev/null
  return 0
}
CUR_PGF=""
cleanup() {
  # an interrupted run (Ctrl-C, a CI cancel): the step that was running goes, and anything else of this run
  [ -n "$CUR_PGF" ] && reap_group "$CUR_PGF"
  node "$REPO/scripts/test-leftovers.js" "$WORK" --kill >/dev/null 2>&1
  # leftovers of earlier runs' selftests in the system temp dir (only ones older than this run, so a parallel run's
  # live fixtures are never touched), then this run's own work dir
  [ -n "$FIXTURE" ] || find "$SYS_TMP" -maxdepth 1 -name '*-selftest-*' -user "$(id -u)" ! -newer "$START_MARK" -exec rm -rf {} + 2>/dev/null
  sweep_walks
  rm -rf "$WORK" "$START_MARK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP   # through the EXIT trap above

# The copy: tracked files plus untracked-but-not-ignored ones (work in progress), or tracked only. A fixture run needs none.
LS_OPTS=(-co --exclude-standard); [ "${TEST_TRACKED_ONLY:-}" = 1 ] && LS_OPTS=(-c)
[ -n "$FIXTURE" ] || ( cd "$REPO" && git ls-files -z "${LS_OPTS[@]}" | tar --null --ignore-failed-read -T - -cf - 2>/dev/null ) | tar -xf - -C "$COPY"
# the runtime's one dependency (Cordis) is not tracked: the copy uses the checkout's installed copy, offline
[ -d "$REPO/runtime/node_modules" ] && [ -d "$COPY/runtime" ] && ln -s "$REPO/runtime/node_modules" "$COPY/runtime/node_modules"

# CAPHEOS_SECWATCH_OFFLINE: the security watch (company/tools/security-watch.js) makes no live advisory lookup from any test
# CAPHEOS_TEST_RUN: every process this run starts inherits it, which is how the last step finds what was left behind
export STARNET_URL="http://127.0.0.1:1" CAPHEOS_ROOT="$COPY" PYTHONDONTWRITEBYTECODE=1 CAPHEOS_SECWATCH_OFFLINE=1 CAPHEOS_TMP_SWEEP=0 CAPHEOS_TEST_RUN="$WORK"

NAMES=(); RESULTS=(); TIMES=(); FAILED=0
# step <label> <cmd...> — run in the copy, with a timeout, in a session of its own; output goes to a log, shown on
# failure. timeout still answers 124 when the step ran out of time (it signals the step's leader; reap_group the rest).
step() {
  local label="$1"; shift
  local n; n="$(printf '%03d' "${#NAMES[@]}")"
  local log="$LOGS/$n.log" pgf="$LOGS/$n.pgid" t0=$SECONDS rc
  CUR_PGF="$pgf"
  ( cd "$COPY" && exec timeout --kill-after=10 "$TIMEOUT" setsid --wait bash -c 'echo $$ > "$0"; exec "$@"' "$pgf" "$@" ) >"$log" 2>&1; rc=$?
  reap_group "$pgf"; CUR_PGF=""
  NAMES+=("$label"); TIMES+=("$((SECONDS - t0))s")
  if [ "$rc" = 0 ]; then RESULTS+=("PASS"); printf '  PASS  %s\n' "$label"
  else
    [ "$rc" = 124 ] && RESULTS+=("TIMEOUT") || RESULTS+=("FAIL($rc)")
    FAILED=$((FAILED + 1)); printf '  FAIL  %s (exit %s)\n' "$label" "$rc"
    grep -nE '^(not ok |FAIL |✖ )' "$log" | head -n 20 | sed 's/^/        ! /'
    tail -n 25 "$log" | sed 's/^/        | /'
  fi
}
skip() { NAMES+=("$1"); RESULTS+=("SKIP"); TIMES+=("-"); printf '  SKIP  %s — %s\n' "$1" "$2"; }

# the end: anything of this run still running is listed, ended, and fails the run; then the summary
finish() {
  echo "== leftovers"
  step "no processes left behind (scripts/test-leftovers.js)" node "$REPO/scripts/test-leftovers.js" "$WORK" --kill
  echo
  printf '%-62s %-10s %s\n' "STEP" "RESULT" "TIME"
  for i in "${!NAMES[@]}"; do printf '%-62s %-10s %s\n' "${NAMES[$i]:0:62}" "${RESULTS[$i]}" "${TIMES[$i]}"; done
  echo
  if [ "$FAILED" -gt 0 ]; then echo "FAILED: $FAILED of ${#NAMES[@]} steps"; exit 1; fi
  echo "ALL PASSED (${#NAMES[@]} steps)"
  exit 0
}

if [ -n "$FIXTURE" ]; then
  echo "CaPheOS test runner, fixture $FIXTURE (timeout ${TIMEOUT}s/step)"
  step "fixture $(basename "$FIXTURE")" bash "$FIXTURE"
  finish
fi

echo "CaPheOS tests (copy: $COPY, station: $STARNET_URL, timeout ${TIMEOUT}s/step)"

echo "== parse and inventory"
step "tool-parse.js" node company/tools/tool-parse.js
step "tool-inventory-check.js" node company/tools/tool-inventory-check.js
step "check-deployment-leaks.js (no company's own names in what this checkout adds; docs/PORTING.md rule 1)" node scripts/check-deployment-leaks.js
step "check-temp-hygiene.js (every test cleans up its temp files and helpers)" node scripts/check-temp-hygiene.js
step "check-temp-hygiene.js --selftest" node scripts/check-temp-hygiene.js --selftest
step "tests/test-sh-hygiene.sh (this runner leaves no process behind)" bash tests/test-sh-hygiene.sh
step "check-clean-tree.sh (no company data tracked)" bash scripts/check-clean-tree.sh
step "instance-update-test.sh (founded clone + module enable, then a clean framework pull)" bash scripts/instance-update-test.sh

echo "== tool selftests"
# The tools differ: some take a `selftest` subcommand, some a `--selftest` flag (some both; the subcommand wins).
selftest_arg() {
  if grep -qE "===? ?['\"]selftest['\"]" "$1"; then echo selftest
  elif grep -qE -- "--selftest|\b(a|A|args|opts)\.selftest\b" "$1"; then echo --selftest
  fi
}
for f in "$COPY"/company/tools/*.js "$COPY"/company/tools/*.sh "$COPY"/company/tools/*.py; do
  [ -f "$f" ] || continue
  rel="${f#"$COPY"/}"; arg="$(selftest_arg "$f")"; [ -n "$arg" ] || continue
  case "$f" in *.js) run=node ;; *.sh) run=bash ;; *.py) run="python3 -I" ;; esac
  step "$rel $arg" $run "$rel" "$arg"
done
# core modules: every module file that carries a selftest (tools/, watch.js, ...), run in place
for f in "$COPY"/modules/*/*.js "$COPY"/modules/*/tools/*.js "$COPY"/modules/*/tools/*.sh; do
  [ -f "$f" ] || continue
  rel="${f#"$COPY"/}"; arg="$(selftest_arg "$f")"; [ -n "$arg" ] || continue
  case "$f" in *.js) run=node ;; *.sh) run=bash ;; esac
  step "$rel $arg" $run "$rel" "$arg"
done
[ -f "$COPY/company/tools/sudo-gate/selftest.py" ] && step "company/tools/sudo-gate/selftest.py" python3 -I company/tools/sudo-gate/selftest.py

echo "== unit tests"
mapfile -t UNIT < <(cd "$COPY" && ls company/tools/tests/*.test.js 2>/dev/null)
if [ "${#UNIT[@]}" -gt 0 ]; then
  BATCH=15; TOTAL="${#UNIT[@]}"; I=0; PART=1; PARTS=$(( (TOTAL + BATCH - 1) / BATCH ))
  while [ "$I" -lt "$TOTAL" ]; do
    CHUNK=("${UNIT[@]:I:BATCH}")
    step "node --test company/tools/tests/*.test.js (part $PART/$PARTS, ${#CHUNK[@]} files)" node --test "${CHUNK[@]}"
    I=$((I + BATCH)); PART=$((PART + 1))
  done
fi
for e in "$COPY"/company/tools/tests/*.e2e.js; do
  [ -f "$e" ] && skip "${e#"$COPY"/}" "needs a scratch StarNet checkout"
done

echo "== console"
step "console/server.js --selftest" node console/server.js --selftest
step "console/models.js --selftest" node console/models.js --selftest
step "console/command-ask.js --selftest (chat lint: a reply that tells the owner to run a command)" node console/command-ask.js --selftest
step "tests/remote-access-test.js (login form, sessions, CSRF, rate limit, proxy + SSE, owner ops recorded, break-glass, crash restart, linger)" node tests/remote-access-test.js
step "tests/today-questions-walk.js (headless Chrome: Today renders each question kind; SKIP without Chrome)" node tests/today-questions-walk.js
step "tests/chat-actions-walk.js (headless Chrome: chat actions and approvals in chat on the mock; SKIP without Chrome)" node tests/chat-actions-walk.js
step "tests/chat-resilience-walk.js (console + mock station: a chat run survives a console restart and a reload; busy + restart-console.sh; leaked tool calls; page checks SKIP without Chrome)" node tests/chat-resilience-walk.js
step "tests/chat-command-check-test.js (console + mock station: a reply that hands the owner a command goes back once; the second is delivered)" node tests/chat-command-check-test.js
step "tests/chat-talk-check-test.js (console + mock station: the combined pre-delivery check at the owner's level: one recheck, masking at Plain, recording only, today's behaviour with no choice)" node tests/chat-talk-check-test.js
step "tests/chat-refusal-test.js (console + mock station: a chat turn the first model refuses is answered by the next model, said in one plain line; every model refusing is reported plainly)" node tests/chat-refusal-test.js
step "tests/meeting-walk.js (console + mock station: the meeting's turns as station runs, isTask/talk only, admit, refusal fallback, END to decisions, restart re-attach, halt, owner-only)" node tests/meeting-walk.js
step "tests/huddle-walk.js (console + mock station: a live chat reply that asks a colleague brings them in, their turns as station runs, attach, owner messages to everyone, the owner's × closes it, the recap, live.json)" node tests/huddle-walk.js
step "tests/meeting-ui-walk.js (headless Chrome: Chat › Meeting controls map to their API actions, chips, END card, @name, the dropdown held during live events; SKIP without Chrome)" node tests/meeting-ui-walk.js
step "tests/chat-window-walk.js (headless Chrome: Chat is a rolling window with backscroll; SKIP without Chrome)" node tests/chat-window-walk.js
step "tests/page-kit-walk.js (headless Chrome: every scaffold page light/dark, desktop/phone; SKIP without Chrome)" node tests/page-kit-walk.js
step "tests/minimax-endpoint-walk.js (headless Chrome: MiniMax endpoint picker in Setup, Settings and Today; SKIP without Chrome)" node tests/minimax-endpoint-walk.js
step "tests/console-routes-walk.js (headless Chrome: old routes redirect, no paths outside Details; SKIP without Chrome)" node tests/console-routes-walk.js
step "tests/services-walk.js (headless Chrome: Settings › System › Background services; SKIP without Chrome)" node tests/services-walk.js
step "tests/security-walk.js (headless Chrome: Settings › Security in plain words, details collapsed, Check now; SKIP without Chrome)" node tests/security-walk.js
step "tests/alarm-walk.js (headless Chrome: the chat command notice, Settings › System › Test the outside alarm; SKIP without Chrome)" node tests/alarm-walk.js
step "tests/connect-walk.js (headless Chrome: Settings › Connections and keys › Sign-ins, the Connect dialog; SKIP without Chrome)" node tests/connect-walk.js
step "tests/service-keys-walk.js (headless Chrome: Settings › Connections and keys › Service keys, Today's Already saved; SKIP without Chrome)" node tests/service-keys-walk.js

echo "== syntax and data files"
py_check() { local bad=0 f; while IFS= read -r -d '' f; do python3 -m py_compile "$f" || { echo "py_compile: $f"; bad=1; }; done < <(git -C "$REPO" ls-files -z '*.py'); return $bad; }
sh_check() { local bad=0 f; while IFS= read -r -d '' f; do bash -n "$f" || { echo "bash -n: $f"; bad=1; }; done < <(git -C "$REPO" ls-files -z '*.sh'); return $bad; }
json_check() { git -C "$REPO" ls-files -z '*.json' | node -e '
  const fs = require("fs"); let bad = 0, n = 0;
  for (const f of fs.readFileSync(0, "utf8").split("\0").filter(Boolean)) {
    if (!fs.existsSync(f)) continue; n++;
    try { JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { bad++; console.log("bad JSON: " + f + ": " + e.message); }
  }
  console.log(n + " JSON files, " + bad + " bad"); process.exit(bad ? 1 : 0);'; }
export REPO; export -f py_check sh_check json_check   # timeout runs programs, not functions
step "python3 -m py_compile (tracked *.py)" bash -c py_check
step "bash -n (tracked *.sh)" bash -c sh_check
step "JSON parse (tracked *.json)" bash -c json_check

echo "== optional suites"
if [ -f "$COPY/scripts/e2e-first-light.sh" ]; then step "scripts/e2e-first-light.sh" bash scripts/e2e-first-light.sh
else skip "scripts/e2e-first-light.sh" "not present"; fi
if [ -f "$COPY/company/tools/pack.js" ]; then step "pack.js doctor --all" node company/tools/pack.js doctor --all
else skip "company/tools/pack.js doctor --all" "not present"; fi
if [ -f "$COPY/company/tools/module.js" ]; then step "module.js doctor --all" node company/tools/module.js doctor --all
else skip "company/tools/module.js doctor --all" "not present"; fi
# StarNet patch tests: they copy the StarNet checkout into a temp dir and apply the record there (never to ./starnet)
STARNET_SRC="${CAPHEOS_STARNET_SRC:-$REPO/starnet}"
for t in "$COPY"/company/patches/tests/*.test.js; do
  [ -f "$t" ] || continue
  if [ -f "$STARNET_SRC/sidecar/index.js" ] && [ -d "$STARNET_SRC/node_modules" ]; then
    step "${t#"$COPY"/}" env CAPHEOS_STARNET_SRC="$STARNET_SRC" node "${t#"$COPY"/}"
  else skip "${t#"$COPY"/}" "no StarNet checkout (set CAPHEOS_STARNET_SRC)"; fi
done
if [ -f "$STARNET_SRC/sidecar/index.js" ] && [ -d "$STARNET_SRC/node_modules" ]; then
  step "tests/memory-walk.js (scratch station: its browser closes after the idle minute; slow, real time)" env CAPHEOS_STARNET_SRC="$STARNET_SRC" node tests/memory-walk.js
else skip "tests/memory-walk.js" "no StarNet checkout (set CAPHEOS_STARNET_SRC)"; fi

finish
