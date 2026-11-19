#!/usr/bin/env bash
# fix-local-gate-wrappers.sh [company root] — point ~/.local/bin/git and ~/.local/bin/gh (the machine-wide merge-gate
# wrappers) at a live company's merge gate instead of the retired StarnetOS checkout. The wrapper then uses the
# company in $CAPHEOS_ROOT when one is set, else the company given here (default ~/Companies/ca-phe-digital).
# Stations do not depend on this (company/tools/shims/{git,gh} come first on their PATH); it covers everything else.
# Keeps a .bak of each file. Run it from the owner's shell.
set -euo pipefail
DEF="${1:-$HOME/Companies/ca-phe-digital}"
[ -f "$DEF/company/tools/merge-gate.js" ] || { echo "no merge gate at $DEF/company/tools/merge-gate.js" >&2; exit 1; }
for w in "$HOME/.local/bin/git" "$HOME/.local/bin/gh"; do
  [ -f "$w" ] || { echo "skip $w (absent)"; continue; }
  grep -q '^GATE=' "$w" || { echo "skip $w (no GATE= line)"; continue; }
  cp -p "$w" "$w.bak"
  sed -i "s|^GATE=.*|GATE=\"\${CAPHEOS_ROOT:-$DEF}/company/tools/merge-gate.js\"|" "$w"
  echo "fixed $w: $(grep '^GATE=' "$w")"
done
