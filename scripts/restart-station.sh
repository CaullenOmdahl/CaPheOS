#!/usr/bin/env bash
# restart-station.sh — restart this company's station only when no run is in flight, and say so.
#
#   scripts/restart-station.sh --when-idle [--max-wait-min N] [--hold-max-min M] [--reason "patch 0013"] [--by <Name>]
#   scripts/restart-station.sh [--reason "..."]     restart only if it is idle right now; else exit 1 and say what runs
#   scripts/restart-station.sh --status             what is in flight now, and any restart hold
#   scripts/restart-station.sh --release --by <Name>   drop a restart hold whose script died
#
# Idle comes from the station itself (its run table, cron leases, goal loops) plus the dispatcher's own state, on 3
# polls in a row; a quiet station.log proves nothing. While it waits, a restart hold stops new starts (the dispatcher
# wakes nobody, the scheduler is disarmed); running work is never stopped. The hold has its own cap (--hold-max-min,
# default 15): after it, with work still in flight, the hold is lifted so the crew works again, and the script keeps
# watching; the next time the station is idle by itself it holds again briefly and restarts. Then it restarts the unit, waits for
# /api/health and for the providers that were ready before to be ready again, re-arms, releases the hold and writes one line to the dispatch log and the owner channel. With
# --max-wait-min (default 120) it gives up cleanly. Details: company/tools/restart-station.js.
#
# It waits as long as runs take, so start it detached when you will not watch it, e.g.
#   nohup setsid scripts/restart-station.sh --when-idle --max-wait-min 90 --reason "patch 0013" >/dev/null 2>&1 &
# (an agent must not wait on it from inside its own run: its own run is in flight until it ends).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/company/tools/restart-station.js" "$@"
