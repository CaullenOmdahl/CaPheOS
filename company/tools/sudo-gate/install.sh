#!/usr/bin/env bash
# install.sh — install (or --uninstall) the CaPheOS root-command broker for agents. Run as root (sudo).
# Additive: nothing routes to the broker until the ~/.local/bin/sudo shim exists AND the caller is a station
# descendant. The owner's own sudo is never touched. Reversible with: sudo bash install.sh --uninstall
# The gate's owner (the only uid allowed to connect) is the user who ran sudo, or GATE_USER=<name>; the project
# root is the checkout this script sits in, or GATE_PROJECT=<dir>. Both are written root-owned to gate.json.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
NAME=capheos-sudo-gate
LIBDIR=/usr/local/lib/$NAME
UNITDIR=/etc/systemd/system

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now "$NAME.socket" 2>/dev/null || true
  systemctl stop "$NAME@*.service" 2>/dev/null || true
  rm -f "$UNITDIR/$NAME.socket" "$UNITDIR/$NAME@.service"
  rm -rf "$LIBDIR"
  systemctl daemon-reload
  rm -f "/run/$NAME.sock"
  echo "$NAME uninstalled. (The ~/.local/bin/sudo shim, if present, belongs to the company's user — remove it separately.)"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0"; exit 1; }
OWNER="${GATE_USER:-${SUDO_USER:-}}"
[ -n "$OWNER" ] && [ "$OWNER" != root ] || { echo "say whose gate this is: run with sudo from the company's user, or set GATE_USER=<name>"; exit 1; }
OWNER_UID="$(id -u "$OWNER")"; OWNER_GID="$(id -g "$OWNER")"; OWNER_GROUP="$(id -gn "$OWNER")"
PROJECT="$(cd "${GATE_PROJECT:-$SRC/../../..}" && pwd)"
[ -d "$PROJECT/company" ] || { echo "$PROJECT does not look like a CaPheOS project (no company/ folder)"; exit 1; }

install -d -m 0755 -o root -g root "$LIBDIR"
install -m 0755 -o root -g root "$SRC/broker.py" "$LIBDIR/broker.py"
python3 -I -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$LIBDIR/broker.py" || { echo "broker.py failed syntax check"; exit 1; }
# Guardrail privilegedShell: the owner's switch in company/state/guardrails.json is copied here, root-owned. The broker
# passes sudo through only when BOTH say off, so an agent editing the project file alone never opens root. Re-run this
# script after `guardrails.js set privilegedShell off`; turning it back on in the project file works at once.
PRIV="$(python3 -I -c "import json,sys
try: g = json.load(open(sys.argv[1]))
except Exception: g = {}
print('off' if isinstance(g, dict) and isinstance(g.get('guards'), dict) and g['guards'].get('privilegedShell') is False else 'on')" "$PROJECT/company/state/guardrails.json")"
python3 -I -c "import json,sys; print(json.dumps({'project': sys.argv[1], 'uid': int(sys.argv[2]), 'gid': int(sys.argv[3]), 'privilegedShell': sys.argv[4] != 'off'}))" \
  "$PROJECT" "$OWNER_UID" "$OWNER_GID" "$PRIV" > "$LIBDIR/gate.json"
if [ "$PRIV" = off ]; then echo "WARNING: guardrail privilegedShell is OFF: the gate passes every sudo request through (still logged)."; fi
chown root:root "$LIBDIR/gate.json"; chmod 0644 "$LIBDIR/gate.json"
sed -e "s|@OWNER_USER@|$OWNER|g" -e "s|@OWNER_GROUP@|$OWNER_GROUP|g" "$SRC/$NAME.socket" > "$UNITDIR/$NAME.socket"
install -m 0644 -o root -g root "$SRC/$NAME@.service" "$UNITDIR/$NAME@.service"
chown root:root "$UNITDIR/$NAME.socket"; chmod 0644 "$UNITDIR/$NAME.socket"
systemctl daemon-reload
systemctl enable --now "$NAME.socket"
echo "$NAME installed for $OWNER (uid $OWNER_UID), project $PROJECT, listening on /run/$NAME.sock:"
ls -l "/run/$NAME.sock"
