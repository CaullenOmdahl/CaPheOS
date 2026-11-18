#!/usr/bin/env bash
# instance-guard.sh — keep a running company's data out of the framework's git history.
#
#   scripts/instance-guard.sh            # apply (idempotent; found-company.sh and module.js enable run it for you)
#   scripts/instance-guard.sh --check    # report, change nothing; exit 1 if this founded checkout could leak
#
# A checkout is an INSTANCE once it is founded (company/work/.founded). An instance is where a company runs; the
# framework is developed in a separate, unfounded checkout. In an instance this script:
#   1. disables pushing: every remote's push URL becomes "no-push://capheos-instance" (fetch/pull still work);
#   2. installs .git/hooks/pre-commit and pre-push that refuse in a founded checkout;
#   3. moves module rows an older module.js wrote into the tracked INVENTORY.md / tool-management.md into the
#      instance-local company/state/inventory-local.md and restores those two files to HEAD (module.js migrate-rows),
#      so a framework `git pull` stays clean;
#   4. hides, up front, the tracked files a company owns (OWNED below: company.json, CHARTER.md, competence-policy.json,
#      model-policy.json, tools/loops.json) with `git update-index --skip-worktree`, so they never show as changes to commit
#      (console Setup reruns this after each write to a tracked file). Any OTHER tracked file the company changed is a
#      framework file: it is saved as a framework request and put back (lib/framework-edits.js), never hidden;
#   5. lists files a running company adds next to framework files (module tools copied into company/tools/)
#      in .git/info/exclude — local only, never committed.
# Everything else a company creates (company/work, state, owner, hiring, roles, console panels, secrets, the station
# and its data) is already in .gitignore. CI's clean-tree check (scripts/test.sh) is the last line: it fails if
# instance data ever reaches the repository by any route.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CHECK=0; [[ "${1:-}" == "--check" ]] && CHECK=1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git checkout; nothing to guard"; exit 0; }
GITDIR="$(git rev-parse --git-dir)"
if [[ ! -e company/work/.founded ]]; then echo "framework checkout (not founded): no instance guard needed"; exit 0; fi

leaks=0
# 1. push disabled
for r in $(git remote); do
  cur="$(git remote get-url --push "$r" 2>/dev/null || true)"
  if [[ "$cur" != "no-push://capheos-instance" ]]; then
    if [[ $CHECK = 1 ]]; then echo "LEAK  remote '$r' can push ($cur)"; leaks=1; else git remote set-url --push "$r" no-push://capheos-instance; echo "push disabled for remote '$r'"; fi
  fi
done
# 2. hooks
HOOK='#!/bin/sh
# installed by scripts/instance-guard.sh: this checkout runs a company; its data must not reach the framework repo
if [ -e "$(git rev-parse --show-toplevel)/company/work/.founded" ]; then
  echo "refused: this checkout is a running CaPheOS company (company/work/.founded)." >&2
  echo "Develop the framework in a separate, unfounded checkout and pull it here." >&2
  exit 1
fi'
for h in pre-commit pre-push; do
  f="$GITDIR/hooks/$h"
  if ! grep -q "instance-guard.sh" "$f" 2>/dev/null; then
    if [[ $CHECK = 1 ]]; then echo "LEAK  no $h hook"; leaks=1; else mkdir -p "$GITDIR/hooks"; printf '%s\n' "$HOOK" > "$f"; chmod +x "$f"; echo "installed $h hook"; fi
  fi
done
# 3. module rows in the tracked inventory/runbook → the instance-local file; tracked files back to HEAD
if command -v node >/dev/null 2>&1 && [[ -f company/tools/module.js ]]; then
  if [[ $CHECK = 1 ]]; then
    node company/tools/module.js migrate-rows --check --json >/dev/null 2>&1 || { echo "LEAK  module rows in the tracked INVENTORY.md / tool-management.md (module.js migrate-rows moves them)"; leaks=1; }
  else
    mig="$(node company/tools/module.js migrate-rows --json 2>/dev/null || true)"
    n="$(printf '%s' "$mig" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.moved||0)}catch(_){console.log(0)}})')"
    [[ "$n" != 0 ]] && echo "moved $n module row(s) to company/state/inventory-local.md; tracked inventory/runbook restored"
  fi
fi
# 4. the tracked files a company owns, hidden up front, then any other tracked file the company changed → skip-worktree
# the one list lives in company/tools/lib/framework-edits.js (OWNED); the fallback below is only for a checkout without node
mapfile -t OWNED < <(cd "$ROOT" && node -e 'for (const f of require("./company/tools/lib/framework-edits").OWNED) console.log(f)' 2>/dev/null)
[[ ${#OWNED[@]} -gt 0 ]] || OWNED=(company/company.json company/CHARTER.md company/ORG.md company/competence-policy.json company/model-policy.json company/tools/loops.json)
for f in "${OWNED[@]}"; do
  [[ -n "$(git ls-files -- "$f")" ]] || continue
  [[ "$(git ls-files -v -- "$f" | cut -c1)" == "S" ]] && continue
  if [[ $CHECK = 1 ]]; then echo "LEAK  company-owned tracked file not hidden: $f"; leaks=1; else git update-index --skip-worktree -- "$f" && echo "hidden from git: $f"; fi
done
# any other tracked file the company changed is a FRAMEWORK file: never hidden (that blocked every later git pull). It is
# saved as a framework request and put back to the framework's version (company/tools/lib/framework-edits.js).
FE=company/tools/lib/framework-edits.js
if [[ $CHECK = 1 ]]; then
  while IFS= read -r f; do [[ -z "$f" ]] && continue; echo "LEAK  framework file changed in this company: $f (instance-guard.sh files it as a framework request and restores it)"; leaks=1; done < <(
    if command -v node >/dev/null 2>&1 && [[ -f $FE ]]; then CAPHEOS_ROOT="$ROOT" node "$FE" list 2>/dev/null | grep -v '^no framework file'; else git diff --name-only; fi)
elif command -v node >/dev/null 2>&1 && [[ -f $FE ]]; then
  out="$(CAPHEOS_ROOT="$ROOT" node "$FE" sweep --by "the crew (found by instance-guard.sh)" 2>/dev/null || true)"
  [[ -n "$out" && "$out" != no\ framework* ]] && echo "$out" || true
else
  while IFS= read -r f; do [[ -z "$f" ]] && continue; git update-index --skip-worktree -- "$f" && echo "hidden from git: $f"; done < <(git diff --name-only)
fi
# 5. untracked, not ignored → .git/info/exclude
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ $CHECK = 1 ]]; then echo "LEAK  untracked file not ignored: $f"; leaks=1; else echo "/$f" >> "$GITDIR/info/exclude"; echo "excluded locally: $f"; fi
done < <(git ls-files --others --exclude-standard)

if [[ $CHECK = 1 ]]; then
  [[ $leaks = 0 ]] && echo "instance guard: clean (push disabled, hooks in place, nothing to commit)" || { echo "instance guard: run scripts/instance-guard.sh to fix"; exit 1; }
fi
