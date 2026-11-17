#!/usr/bin/env bash
# restart-console.sh — restart the owner console (the <station service>-console unit) without cutting a live chat reply.
#
#   scripts/restart-console.sh --when-idle [--timeout SEC] [--force]   wait until no chat is streaming, then restart
#   scripts/restart-console.sh                                          restart now only if no chat is streaming, else exit 1
#   scripts/restart-console.sh --status                                 print the chats in flight (GET /api/console/busy)
#
# Busy comes from the console itself: GET /api/console/busy -> {chats: [runIds in flight]} (console/chat-runs.js), polled
# every 2 s; idle is two empty answers in a row. --timeout (default 600 s) gives up with exit 1 and restarts nothing,
# unless --force, which restarts anyway: with StarNet patch 0014 (capability "run-detach") the station keeps a chat run
# going through a console restart and the page re-attaches to it, so --force costs the owner a few seconds of live view,
# never the reply. A console that does not answer counts as idle (nothing can be streaming through it).
# Env: CONSOLE_URL (default http://127.0.0.1:<console port>), CONSOLE_UNIT (default <serviceName>-console.service),
# CONSOLE_RESTART_CMD (default: systemctl --user restart "$CONSOLE_UNIT"; the tests put a stand-in here).
# Exit: 0 restarted (or --status), 1 still busy (timeout, or busy without --when-idle), 2 usage, 3 the restart failed.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHEN_IDLE=0; TIMEOUT=600; FORCE=0; STATUS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --when-idle) WHEN_IDLE=1 ;;
    --timeout) TIMEOUT="${2:-}"; shift ;;
    --force) FORCE=1 ;;
    --status) STATUS=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || { echo "--timeout takes seconds" >&2; exit 2; }

# the console's URL, its token and its unit, from company.json the way console/server.js reads them
read -r DEF_URL DEF_UNIT < <(cd "$ROOT" && node -e '
  const co = require("./company/tools/lib/company");
  const cc = co.config.console || {}; let sp = 0; try { sp = Number(new URL(co.STATION_URL).port) || 0; } catch (_) {}
  const port = process.env.CONSOLE_PORT || cc.port || (sp ? sp + 100 : 8901);
  const host = !cc.host || cc.host === "0.0.0.0" || cc.host === "::" ? "127.0.0.1" : cc.host;
  const svc = (co.config.station && co.config.station.serviceName) || "capheos-station";
  process.stdout.write("http://" + host + ":" + port + " " + svc + "-console.service\n");')
URL="${CONSOLE_URL:-$DEF_URL}"; UNIT="${CONSOLE_UNIT:-$DEF_UNIT}"
TOKEN_FILE="${CAPHEOS_ROOT:-$ROOT}/secrets/console-token"

# prints the runIds in flight, one per line; exit 2 when the console does not answer
busy() {
  node -e '
    const [url, tf] = process.argv.slice(1); let tok = ""; try { tok = require("fs").readFileSync(tf, "utf8").trim(); } catch (_) {}
    fetch(url.replace(/\/+$/, "") + "/api/console/busy", { headers: { "x-console-token": tok }, signal: AbortSignal.timeout(4000) })
      .then(r => r.json()).then(j => { if (!j || !Array.isArray(j.chats)) process.exit(2); for (const c of j.chats) console.log(c); })
      .catch(() => process.exit(2));' "$URL" "$TOKEN_FILE"
}

if [ "$STATUS" = 1 ]; then
  out="$(busy)"; rc=$?
  if [ $rc = 2 ]; then echo "the console at $URL does not answer"; exit 0; fi
  if [ -z "$out" ]; then echo "no chat in flight"; else echo "chats in flight:"; echo "$out" | sed 's/^/  /'; fi
  exit 0
fi

start=$SECONDS; quiet=0; said=0
while :; do
  out="$(busy)"; rc=$?
  if [ $rc = 2 ] || [ -z "$out" ]; then quiet=$((quiet + 1)); else quiet=0; fi
  [ "$quiet" -ge 2 ] && break
  if [ $rc != 2 ] && [ -n "$out" ]; then
    if [ "$WHEN_IDLE" = 0 ]; then echo "a chat reply is streaming ($(echo $out | tr '\n' ' ')); not restarting. Use --when-idle to wait." >&2; exit 1; fi
    [ "$said" = 0 ] && { echo "waiting for the chat in flight to finish: $(echo $out | tr '\n' ' ')"; said=1; }
    if [ $((SECONDS - start)) -ge "$TIMEOUT" ]; then
      if [ "$FORCE" = 1 ]; then echo "still busy after ${TIMEOUT}s; restarting anyway (--force): the reply continues at the station and the page re-attaches"; break; fi
      echo "still busy after ${TIMEOUT}s; not restarting (add --force to restart anyway)" >&2; exit 1
    fi
  fi
  [ "$WHEN_IDLE" = 0 ] && [ "$quiet" -ge 1 ] && break
  sleep 2
done

echo "restarting $UNIT"
if [ -n "${CONSOLE_RESTART_CMD:-}" ]; then bash -c "$CONSOLE_RESTART_CMD" || exit 3
else systemctl --user restart "$UNIT" || exit 3; fi
echo "restarted $UNIT"
