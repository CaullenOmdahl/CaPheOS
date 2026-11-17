#!/usr/bin/env bash
# Start the owner console (console/server.js). Extra args pass through (--port N, --host H, --selftest).
# The console prints its sign-in page address, never the token (docs/DEPLOY-SERVER.md). `scripts/console.sh --url`
# prints the address and the token, to an interactive terminal only (never to a pipe or the journal).
# `scripts/console.sh --rotate-token` (the owner's shell; the console has Sign out everywhere) writes a new token and ends
# every session. `scripts/console.sh --reset-login` is the server admin's break-glass: new token, passphrase and
# recovery code removed (the owner then signs in with the new token).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node console/server.js "$@"
