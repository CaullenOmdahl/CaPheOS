#!/usr/bin/env bash
# workspace-modes.sh — the station's own files must not be readable by anyone but the user the station runs as.
#
# Why: `.starnet-data/workspaces/` holds run transcripts (prompts, pasted credentials, customer
# data), the quest ledger, the run journal and the secrets dir. A station service running under
# umask 0022 writes transcript directories at 0755 and segment files at 0644, readable by every
# local user. The durable fix is a systemd drop-in on the station unit (UMask=0077), which only
# takes effect on the next service restart. This script is the belt: it makes today's files
# 0600/0700 and reports drift, so the gap between a config change and a restart is visible
# instead of assumed.
#
#   company/tools/workspace-modes.sh --check      # exit 1 and list offenders; changes nothing
#   company/tools/workspace-modes.sh --fix        # tighten what --check would report
#   company/tools/workspace-modes.sh --selftest   # prove --check fails on a loose file and passes
#                                                 # on a tight one (exit 1 if the check is blind)
#
# Scope: every regular file and directory under .starnet-data/workspaces, except
# `.checkpoints/` — those are git object stores (0444 inside a repo on purpose) and every
# checkpoint root is already covered by the station's own backup path.
#
# Guardrail localComputer (company/tools/guardrails.js, the owner's switch): OFF = --check still lists drift but exits 0
# ("reported, not enforced"), and --fix tightens nothing (it says so). ON is the default, and anything but a clear "off"
# from co.guard (node missing, an unreadable state file) counts as ON.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${WORKSPACE_MODES_ROOT:-$ROOT/.starnet-data/workspaces}"
EXCLUDE='*/.checkpoints/*'

# one line per offender: "<mode> <path> <want>"  (want = 600 for files, 700 for dirs)
offenders() {
  local base="${1:-$WS}"
  find "$base" -path "$EXCLUDE" -prune -o \( -type f -o -type d \) -print 2>/dev/null |
    while IFS= read -r p; do
      [ "$p" = "$base" ] && continue
      local mode
      mode=$(stat -c '%a' "$p" 2>/dev/null) || continue
      if [ -d "$p" ]; then
        # any group/other bit set on a directory is drift
        [ $(( 0${mode} & 077 )) -eq 0 ] || printf '%s\t%s\t700\n' "$mode" "$p"
      else
        [ $(( 0${mode} & 077 )) -eq 0 ] || printf '%s\t%s\t600\n' "$mode" "$p"
      fi
    done
}

# on|off for the localComputer guardrail of a project root (default: this one)
guard_state() {
  local root="${1:-$ROOT}" v
  v="$(node -e 'try { process.stdout.write(require(process.argv[1]).guard("localComputer") ? "on" : "off"); } catch (e) { process.stdout.write("on"); }' \
    "$root/company/tools/lib/company.js" 2>/dev/null)"
  if [ "$v" = off ]; then echo off; else echo on; fi
}

# --check under the guardrail: drift fails only while it is ON
guarded_check() {
  local root="${1:-$ROOT}" base="${2:-$WS}"
  if [ "$(guard_state "$root")" = off ]; then
    check "$base" || echo "workspace-modes: guardrail localComputer is OFF: drift reported, not enforced"
    return 0
  fi
  check "$base"
}
guarded_fix() {
  local root="${1:-$ROOT}" base="${2:-$WS}"
  if [ "$(guard_state "$root")" = off ]; then
    echo "workspace-modes: guardrail localComputer is OFF: not tightening anything (turn it on with guardrails.js to enforce)"
    check "$base" >/dev/null || true
    return 0
  fi
  fix "$base"
}

check() {
  local base="${1:-$WS}" list
  list="$(offenders "$base")"
  if [ -z "$list" ]; then
    echo "workspace-modes: OK — nothing under $base is group- or world-readable"
    return 0
  fi
  echo "workspace-modes: DRIFT — these are readable by group/other:"
  echo "$list" | awk -F'\t' '{printf "  %s %s (want %s)\n", $1, $2, $3}'
  echo "workspace-modes: run '$0 --fix' to tighten them."
  return 1
}

fix() {
  local base="${1:-$WS}"
  offenders "$base" | while IFS=$'\t' read -r _mode p want; do
    chmod "$want" "$p" 2>/dev/null || echo "workspace-modes: could not chmod $p" >&2
  done
  check "$base"
}

selftest() {
  local tmp pass=0 fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/loose" "$tmp/tight"
  : > "$tmp/loose/segment.jsonl"; chmod 0644 "$tmp/loose/segment.jsonl"; chmod 0755 "$tmp/loose"
  : > "$tmp/tight/segment.jsonl"; chmod 0600 "$tmp/tight/segment.jsonl"; chmod 0700 "$tmp/tight"

  if check "$tmp/loose" >/dev/null; then
    fail=$((fail + 1)); echo "FAIL  --check passed a 0644 file in a 0755 dir (it is blind)"
  else
    pass=$((pass + 1)); echo "ok    --check fails on 0644 file / 0755 dir"
  fi
  if check "$tmp/tight" >/dev/null; then
    pass=$((pass + 1)); echo "ok    --check passes on 0600 file / 0700 dir"
  else
    fail=$((fail + 1)); echo "FAIL  --check failed a 0600 file in a 0700 dir"
  fi
  # the fix path must actually fix, and then be clean
  fix "$tmp/loose" >/dev/null 2>&1
  if check "$tmp/loose" >/dev/null; then
    pass=$((pass + 1)); echo "ok    --fix tightens a loose tree"
  else
    fail=$((fail + 1)); echo "FAIL  --fix left a loose tree loose"
  fi

  # guardrail localComputer: read from a temp project copy (lib/company.js + company/state/guardrails.json)
  mkdir -p "$tmp/proj/company/tools/lib" "$tmp/proj/company/state" "$tmp/g"
  cp "$ROOT/company/tools/lib/company.js" "$tmp/proj/company/tools/lib/company.js"
  : > "$tmp/g/f"; chmod 0644 "$tmp/g/f"
  if [ "$(guard_state "$tmp/proj")" = on ]; then
    pass=$((pass + 1)); echo "ok    guardrail: no state file -> ON"
  else
    fail=$((fail + 1)); echo "FAIL  guardrail: no state file did not read as ON"
  fi
  if ! guarded_check "$tmp/proj" "$tmp/g" >/dev/null; then
    pass=$((pass + 1)); echo "ok    guardrail ON: drift fails --check"
  else
    fail=$((fail + 1)); echo "FAIL  guardrail ON: drift passed --check"
  fi
  printf '{"guards":{"localComputer":false}}' > "$tmp/proj/company/state/guardrails.json"
  if guarded_check "$tmp/proj" "$tmp/g" | grep -q 'not enforced' && guarded_check "$tmp/proj" "$tmp/g" >/dev/null; then
    pass=$((pass + 1)); echo "ok    guardrail OFF: drift is reported, --check exits 0"
  else
    fail=$((fail + 1)); echo "FAIL  guardrail OFF: --check did not report-and-pass"
  fi
  guarded_fix "$tmp/proj" "$tmp/g" >/dev/null 2>&1
  if [ "$(stat -c '%a' "$tmp/g/f")" = 644 ]; then
    pass=$((pass + 1)); echo "ok    guardrail OFF: --fix tightens nothing"
  else
    fail=$((fail + 1)); echo "FAIL  guardrail OFF: --fix changed a mode"
  fi
  printf '{ not json' > "$tmp/proj/company/state/guardrails.json"
  if [ "$(guard_state "$tmp/proj")" = on ]; then
    pass=$((pass + 1)); echo "ok    guardrail: unreadable state -> ON (fail closed)"
  else
    fail=$((fail + 1)); echo "FAIL  guardrail: unreadable state did not read as ON"
  fi

  printf '\nWORKSPACE-MODES SELFTEST: %s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" = "0" ] || return 1
}

case "${1:---check}" in
  --check) guarded_check ;;
  --fix) guarded_fix ;;
  --selftest) selftest ;;
  *) echo "usage: $0 [--check|--fix|--selftest]" >&2; exit 2 ;;
esac
