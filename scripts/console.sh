#!/usr/bin/env bash
# Start the owner console (console/server.js). Prints the login URL. Extra args pass through (--port N, --host H, --selftest).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node console/server.js "$@"
