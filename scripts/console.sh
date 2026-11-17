#!/usr/bin/env bash
# Start the owner console (console/server.js). Extra args pass through (--port N, --host H, --selftest).
# The login URL with its token is printed only to an interactive terminal; under systemd (the journal) the line names
# secrets/console-token instead. `scripts/console.sh --url` prints the full login address to a terminal (never to a pipe);
# `scripts/console.sh --rotate-token` (the owner's shell) writes a new token: restart the console after it.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node console/server.js "$@"
