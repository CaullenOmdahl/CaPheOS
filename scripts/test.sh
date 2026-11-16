#!/usr/bin/env bash
# test.sh — the framework's whole offline test suite, in one command. Used locally and by .github/workflows/ci.yml.
#
#   scripts/test.sh            run everything, print a summary table, exit 1 if any step failed
#
# Nothing here reaches a station: STARNET_URL points at a closed port, and every selftest runs against a temp copy of
# the repo (CAPHEOS_ROOT, honoured by company/tools/lib/company.js), so no test can dirty the checkout. TMPDIR is left
# alone on purpose: some selftests size text by their fixture path, and a deep private temp dir makes them fail. Every step runs even after a failure, so one run reports all of them.
# Env: TEST_TIMEOUT (seconds per step, default 180); TEST_TRACKED_ONLY=1 copies only tracked files (what CI sees),
# leaving out untracked work in progress.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TIMEOUT="${TEST_TIMEOUT:-180}"
SYS_TMP="${TMPDIR:-/tmp}"
START_MARK="$(mktemp "$SYS_TMP/capheos-test-start.XXXXXX")"   # its mtime is the run start
WORK="$(mktemp -d "$SYS_TMP/capheos-test-XXXXXX")"
COPY="$WORK/repo"; LOGS="$WORK/logs"
mkdir -p "$COPY" "$LOGS"

cleanup() {
  # leftovers of earlier runs' selftests in the system temp dir (only ones older than this run, so a parallel run's
  # live fixtures are never touched), then this run's own work dir
  find "$SYS_TMP" -maxdepth 1 -name '*-selftest-*' -user "$(id -u)" ! -newer "$START_MARK" -exec rm -rf {} + 2>/dev/null
  rm -rf "$WORK" "$START_MARK"
}
trap cleanup EXIT

# The copy: tracked files plus untracked-but-not-ignored ones (work in progress), or tracked only.
LS_OPTS=(-co --exclude-standard); [ "${TEST_TRACKED_ONLY:-}" = 1 ] && LS_OPTS=(-c)
( cd "$REPO" && git ls-files -z "${LS_OPTS[@]}" | tar --null --ignore-failed-read -T - -cf - 2>/dev/null ) | tar -xf - -C "$COPY"

export STARNET_URL="http://127.0.0.1:1" CAPHEOS_ROOT="$COPY" PYTHONDONTWRITEBYTECODE=1

NAMES=(); RESULTS=(); TIMES=(); FAILED=0
# step <label> <cmd...> — run in the copy, with a timeout; output goes to a log, shown on failure
step() {
  local label="$1"; shift
  local log="$LOGS/$(printf '%03d' "${#NAMES[@]}").log" t0=$SECONDS rc
  ( cd "$COPY" && timeout --kill-after=10 "$TIMEOUT" "$@" ) >"$log" 2>&1; rc=$?
  NAMES+=("$label"); TIMES+=("$((SECONDS - t0))s")
  if [ "$rc" = 0 ]; then RESULTS+=("PASS"); printf '  PASS  %s\n' "$label"
  else
    [ "$rc" = 124 ] && RESULTS+=("TIMEOUT") || RESULTS+=("FAIL($rc)")
    FAILED=$((FAILED + 1)); printf '  FAIL  %s (exit %s)\n' "$label" "$rc"
    tail -n 25 "$log" | sed 's/^/        | /'
  fi
}
skip() { NAMES+=("$1"); RESULTS+=("SKIP"); TIMES+=("-"); printf '  SKIP  %s — %s\n' "$1" "$2"; }

echo "CaPheOS tests (copy: $COPY, station: $STARNET_URL, timeout ${TIMEOUT}s/step)"

echo "== parse and inventory"
step "tool-parse.js" node company/tools/tool-parse.js
step "tool-inventory-check.js" node company/tools/tool-inventory-check.js

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
if [ "${#UNIT[@]}" -gt 0 ]; then step "node --test company/tools/tests/*.test.js (${#UNIT[@]} files)" node --test "${UNIT[@]}"; fi
for e in "$COPY"/company/tools/tests/*.e2e.js; do
  [ -f "$e" ] && skip "${e#"$COPY"/}" "needs a scratch StarNet checkout"
done

echo "== console"
step "console/server.js --selftest" node console/server.js --selftest

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

echo
printf '%-62s %-10s %s\n' "STEP" "RESULT" "TIME"
for i in "${!NAMES[@]}"; do printf '%-62s %-10s %s\n' "${NAMES[$i]:0:62}" "${RESULTS[$i]}" "${TIMES[$i]}"; done
echo
if [ "$FAILED" -gt 0 ]; then echo "FAILED: $FAILED of ${#NAMES[@]} steps"; exit 1; fi
echo "ALL PASSED (${#NAMES[@]} steps)"
