#!/usr/bin/env bash
# test-sh-hygiene.sh — scripts/test.sh itself leaves nothing running, even after a step that passed.
#
#   bash tests/test-sh-hygiene.sh
#
# Runs test.sh twice in fixture mode (CAPHEOS_TEST_FIXTURE, TEST_TIMEOUT=20), each time with one step that exits 0:
#   1. the step leaves a background process (and a headless Chrome when one is installed) in its own process group:
#      test.sh's per-step group kill ends them, so its last step "no processes left behind" passes and the run exits 0;
#   2. the step leaves a process in a session of its own (setsid), out of the group's reach: the last step lists it,
#      ends it, and the run exits 1.
# Either way nothing of the fixtures runs afterwards. Every fixture process carries a unique tag on its command line.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/test-sh-hygiene-XXXXXX")"
trap 'pkill -KILL -f -- "$TAG" 2>/dev/null; rm -rf "$T"' EXIT
TAG="cap-hygiene-$$-$RANDOM"
fail=0
say() { printf '%s\n' "$*"; }
left() { pgrep -f -- "$1" | grep -v "^$$\$" || true; }

CHROME=""
for c in "${STARNET_CHROME:-}" /opt/google/chrome/chrome /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
  [ -n "$c" ] && [ -x "$c" ] && { CHROME="$c"; break; }
done

cat > "$T/leak-group.sh" <<EOF
node -e 'setInterval(() => {}, 1000)' $TAG-group >/dev/null 2>&1 &
if [ -n "$CHROME" ]; then
  mkdir -p "$T/prof-$TAG/.tmp"
  TMPDIR="$T/prof-$TAG/.tmp" DBUS_SESSION_BUS_ADDRESS=disabled: "$CHROME" --headless=new --no-first-run --user-data-dir="$T/prof-$TAG" about:blank >/dev/null 2>&1 &
fi
sleep 1
exit 0
EOF
cat > "$T/leak-session.sh" <<EOF
setsid node -e 'setInterval(() => {}, 1000)' $TAG-session >/dev/null 2>&1 < /dev/null &
sleep 1
exit 0
EOF

out="$(TEST_TIMEOUT=20 CAPHEOS_TEST_FIXTURE="$T/leak-group.sh" bash "$REPO/scripts/test.sh" 2>&1)"; rc=$?
if [ "$rc" = 0 ] && grep -q 'PASS  no processes left behind' <<<"$out"; then say "ok   a step's own process group is ended when it passes (exit 0)"
else say "FAIL the group fixture: exit $rc"; sed 's/^/     | /' <<<"$out"; fail=1; fi
if [ -n "$(left "$TAG-group")" ] || [ -n "$(left "prof-$TAG")" ]; then say "FAIL processes of the group fixture still run: $(left "$TAG")"; fail=1
else say "ok   nothing of the group fixture runs afterwards${CHROME:+ (Chrome included)}"; fi

out="$(TEST_TIMEOUT=20 CAPHEOS_TEST_FIXTURE="$T/leak-session.sh" bash "$REPO/scripts/test.sh" 2>&1)"; rc=$?
if [ "$rc" = 1 ] && grep -q "left behind: pid [0-9]*  node -e .*$TAG-session" <<<"$out"; then say "ok   a process that escaped the group is listed and fails the run (exit 1)"
else say "FAIL the session fixture: exit $rc"; sed 's/^/     | /' <<<"$out"; fail=1; fi
sleep 0.5
if [ -n "$(left "$TAG-session")" ]; then say "FAIL the escaped process still runs"; fail=1
else say "ok   and it was ended"; fi

[ "$fail" = 0 ] && say "test-sh-hygiene: OK" || say "test-sh-hygiene: FAILED"
exit "$fail"
