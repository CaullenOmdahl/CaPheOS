#!/usr/bin/env bash
# restart-station-idle.sh — RETIRED: kept so older instructions still work; it now runs scripts/restart-station.sh.
#
# The old rule here (wait for GET /api/cron to show no inFlight job) missed runs the scheduler does not lease: chat
# turns, hub runs, background workers, a turn queued behind its conversation. scripts/restart-station.sh reads the
# station's run table too, holds new starts while it waits, and never restarts over a live run.
#
#   bash company/tools/restart-station-idle.sh             == scripts/restart-station.sh --when-idle --reason "a restart (restart-station-idle.sh)"
#   bash company/tools/restart-station-idle.sh --status    == scripts/restart-station.sh --status
#   bash company/tools/restart-station-idle.sh --selftest  == node company/tools/restart-station.js selftest
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  --selftest) exec node "$HERE/restart-station.js" selftest ;;
  --status)   exec node "$HERE/restart-station.js" --status ;;
  '')         exec node "$HERE/restart-station.js" --when-idle --reason "a restart (restart-station-idle.sh)" ;;
  *) echo "usage: $0 [--status|--selftest]  (retired: use scripts/restart-station.sh)" >&2; exit 2 ;;
esac
