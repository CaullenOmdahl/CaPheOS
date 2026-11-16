#!/usr/bin/env bash
# instance-update-test.sh — a founded company takes a framework update with a clean `git pull`.
#
#   bash scripts/instance-update-test.sh     # offline; temp dirs only; run by scripts/test.sh
#
# Builds an "upstream" repo from this checkout's files, clones it, founds the clone, enables a core module, then
# commits a framework change to INVENTORY.md and tool-management.md upstream and pulls it into the company: the pull
# must apply without "Your local changes would be overwritten". Also checks that an owner write to model-policy.json
# never shows in git status, that module rows an older module.js left in the tracked files are migrated by
# instance-guard.sh, and that the README's update commands for the four owner files work.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/instance-update-selftest-XXXXXX")"
trap 'rm -rf "$T"' EXIT
unset CAPHEOS_ROOT                      # every tool must act on the clone it runs in, not the test copy
export STARNET_URL="http://127.0.0.1:1" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
G=(git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c advice.detachedHead=false)
fails=0
ok()   { echo "ok   $1"; }
bad()  { echo "FAIL $1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
clean() { [[ -z "$(git -C "$I" status --porcelain)" ]]; }

# upstream = the framework as it stands in this checkout (tracked + untracked-not-ignored files)
U="$T/upstream"; I="$T/company"
mkdir -p "$U"
if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  ( cd "$SRC" && git ls-files -z -co --exclude-standard | tar --null --ignore-failed-read -T - -cf - 2>/dev/null ) | tar -xf - -C "$U"
else   # scripts/test.sh runs us in a plain copy of the tracked files
  ( cd "$SRC" && tar --exclude=./.git -cf - . ) | tar -xf - -C "$U"
fi
rm -f "$U/.framework-checkout"
( cd "$U" && "${G[@]}" init -q && "${G[@]}" add -A && "${G[@]}" commit -qm framework )
"${G[@]}" clone -q "$U" "$I"
cd "$I"

bash scripts/found-company.sh --name "Update Test Co" --owner "Alex" --tz UTC --port 18871 >/dev/null
check "founded checkout is clean in git status" clean
check "the four company-owned files are hidden up front" bash -c '[[ $(git ls-files -v company/company.json company/CHARTER.md company/competence-policy.json company/model-policy.json | grep -c "^S") = 4 ]]'

# what console Setup does: the owner picks a provider (model-policy.json); nothing may show in git status
node -e 'const f="company/model-policy.json",fs=require("fs");const p=JSON.parse(fs.readFileSync(f,"utf8"));p.candidateDefault.setBy="Alex";fs.writeFileSync(f,JSON.stringify(p,null,1)+"\n")'
check "an owner write to model-policy.json does not leak" bash -c 'clean() { [[ -z "$(git status --porcelain)" ]]; }; clean && scripts/instance-guard.sh --check >/dev/null'

out="$(node company/tools/module.js enable liveness --by Alex --json 2>&1)" || true
check "module enable liveness: conformant" grep -q '"status": "conformant"' <<<"$out"
check "enable leaves the tracked INVENTORY.md and runbook untouched" bash -c '! git ls-files -v company/tools/INVENTORY.md company/runbooks/tool-management.md | grep -q "^S" && git diff --quiet HEAD -- company/tools/INVENTORY.md company/runbooks/tool-management.md'
check "module rows are in company/state/inventory-local.md" grep -q 'company/tools/liveness.js' company/state/inventory-local.md
check "tool-inventory-check passes in the instance" bash -c 'node company/tools/tool-inventory-check.js >/dev/null'
check "git status clean after enable" clean
check "instance-guard --check clean" bash -c 'scripts/instance-guard.sh --check >/dev/null'

# a framework update touching INVENTORY.md and the runbook
upstream_change() { ( cd "$U" && printf '\n<!-- framework update %s -->\n' "$1" >> company/tools/INVENTORY.md && printf '\n<!-- framework update %s -->\n' "$1" >> company/runbooks/tool-management.md && "${G[@]}" commit -qam "update $1" ); }
upstream_change 1
check "git pull of an update to INVENTORY.md / runbook applies cleanly" bash -c 'git pull -q --ff-only >/dev/null 2>&1 && grep -q "framework update 1" company/tools/INVENTORY.md'
check "doctor still conformant after the pull" bash -c 'node company/tools/module.js doctor liveness >/dev/null'

# an instance enabled by an older module.js: rows in the tracked files, hidden with skip-worktree
row='| `company/tools/liveness.js` | the dead-man'"'"'s switch (module liveness) | risk | `--selftest` | see header | — |'
printf '%s\n' "$row" >> company/tools/INVENTORY.md
printf '%s\n' '| company/tools/liveness.js | risk | `--selftest` |' >> company/runbooks/tool-management.md
git update-index --skip-worktree company/tools/INVENTORY.md company/runbooks/tool-management.md
check "guard --check reports legacy module rows" bash -c '! scripts/instance-guard.sh --check >/dev/null'
scripts/instance-guard.sh >/dev/null
check "guard migrated them: tracked files back to HEAD, not skip-worktree" bash -c '! git ls-files -v company/tools/INVENTORY.md company/runbooks/tool-management.md | grep -q "^S" && git diff --quiet HEAD -- company/tools/INVENTORY.md company/runbooks/tool-management.md'
upstream_change 2
check "git pull applies cleanly after the migration" bash -c 'git pull -q --ff-only >/dev/null 2>&1 && grep -q "framework update 2" company/runbooks/tool-management.md'

# the README's commands for an update that touches one of the four owner files
( cd "$U" && node -e 'const f="company/model-policy.json",fs=require("fs");const p=JSON.parse(fs.readFileSync(f,"utf8"));p._docUpdate="framework 3";fs.writeFileSync(f,JSON.stringify(p,null,1)+"\n")' && "${G[@]}" commit -qam "update 3" )
check "a pull touching an owner file stops (owner copy protected)" bash -c '! git pull -q --ff-only >/dev/null 2>&1'
OWNED="company/company.json company/CHARTER.md company/competence-policy.json company/model-policy.json"
git update-index --no-skip-worktree $OWNED
"${G[@]}" stash push -q -- $OWNED
git pull -q --ff-only >/dev/null 2>&1 || bad "pull after stash"
"${G[@]}" stash pop -q >/dev/null 2>&1 || true
scripts/instance-guard.sh >/dev/null
check "README update commands: update taken, owner choice kept, clean again" bash -c 'node -e "const p=require(\"./company/model-policy.json\");process.exit(p._docUpdate===\"framework 3\"&&p.candidateDefault.setBy===\"Alex\"?0:1)" && [[ -z "$(git status --porcelain)" ]] && scripts/instance-guard.sh --check >/dev/null'

[[ $fails = 0 ]] && echo "PASS" || { echo "FAIL $fails"; exit 1; }
