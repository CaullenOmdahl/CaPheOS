#!/usr/bin/env bash
# new-company.sh — start a new company in one command. Run it from any CaPheOS checkout (the framework one is fine:
# it never founds the checkout it runs from).
#
#   scripts/new-company.sh --name "Example Law" --owner "Alex" [--dir ~/Companies/example-law] [--tz Area/City]
#                          [--port <station port>] [--no-start] [--no-open]
#
# It: picks a free station port (and the console port beside it, +100) unless --port is given; clones this framework
# into a NEW folder; founds the company there (which makes that folder an instance that cannot push); installs and
# starts the headless station, the dispatcher, the liveness watch and the console; and opens the console, where the
# Setup screen walks the owner through the rest (AI provider, budget, charter, how much the company decides alone,
# certification). Safe to re-run with the same --dir: every step it reaches is idempotent.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="" OWNER="" DIR="" TZ_="" PORT="" START=1 OPEN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2;; --owner) OWNER="$2"; shift 2;; --dir) DIR="$2"; shift 2;;
    --tz) TZ_="$2"; shift 2;; --port) PORT="$2"; shift 2;;
    --no-start) START=0; shift;; --no-open) OPEN=0; shift;;
    -h|--help) sed -n 2,13p "$0"; exit 0;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2;;
  esac
done
[[ -n "$NAME" && -n "$OWNER" ]] || { echo "need --name \"Company name\" and --owner \"Your name\" (see --help)" >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js 22 is required" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
SLUG="$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g')"
DIR="${DIR:-$HOME/Companies/$SLUG}"
DIR="$(mkdir -p "$(dirname "$DIR")" && cd "$(dirname "$DIR")" && pwd)/$(basename "$DIR")"
[[ "$DIR" == "$SRC" ]] && { echo "refused: --dir is this checkout; a company gets its own folder" >&2; exit 1; }

free() { ! ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
taken_by_unit() { grep -rlqs "^PORT=$1\$" "$HOME/.config/"*-station.env 2>/dev/null; }
if [[ -z "$PORT" ]]; then
  if [[ -f "$DIR/company/company.json" ]]; then PORT="$(node -e "process.stdout.write(String(require('$DIR/company/company.json').station.port||''))")"; fi
  if [[ -z "$PORT" || "$PORT" == 8801 && ! -e "$DIR/company/work/.founded" ]]; then
    PORT=""; for p in $(seq 8810 8899); do free "$p" && free $((p + 100)) && ! taken_by_unit "$p" && { PORT=$p; break; }; done
    [[ -n "$PORT" ]] || { echo "no free port pair in 8810-8899 (+100 for the console); pass --port" >&2; exit 1; }
  fi
fi
echo "company:  $NAME (owner $OWNER)"
echo "folder:   $DIR"
echo "ports:    station $PORT, console $((PORT + 100))"

# 1. the company's own checkout
if [[ ! -d "$DIR/.git" ]]; then
  URL="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"
  [[ -n "$URL" && "$URL" != no-push://* ]] || URL="$SRC"
  git clone -q "$URL" "$DIR"
  echo "cloned:   $URL"
fi
cd "$DIR"
# 2. found (idempotent; it makes this folder an instance: no push, hooks, hidden company files)
if [[ -e company/work/.founded ]]; then echo "founded:  already"; else
  args=(--name "$NAME" --owner "$OWNER" --port "$PORT"); [[ -n "$TZ_" ]] && args+=(--tz "$TZ_")
  scripts/found-company.sh "${args[@]}" | tail -2
fi
# 3. station, dispatcher, liveness, console
if [[ $START -eq 1 ]]; then
  scripts/setup-station.sh --start | tail -4
  URL="http://127.0.0.1:$((PORT + 100))/login?token=$(cat secrets/console-token 2>/dev/null)"
  for _ in $(seq 1 20); do curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$((PORT + 100))/" 2>/dev/null && break; sleep 1; done
  echo
  echo "Open the console to finish setup:"
  echo "  $URL"
  if [[ $OPEN -eq 1 && -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
else
  echo "not started (--no-start). Next: cd $DIR && scripts/setup-station.sh --start"
fi
