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
check "a new company talks to the owner in plain words, the check on (company/owner/talk.json, docs/TALK.md)" node -e 'const t=require("./company/owner/talk.json"); process.exit(t.level==="plain"&&t.check==="live"&&t.length==="short"?0:1)'
check "the example messages are not copied into the company" test ! -e company/owner/talk-examples.json
check "the company-owned files are hidden up front" bash -c '[[ $(git ls-files -v company/company.json company/CHARTER.md company/ORG.md company/competence-policy.json company/model-policy.json | grep -c "^S") = 5 ]]'

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
OWNED="company/company.json company/CHARTER.md company/ORG.md company/competence-policy.json company/model-policy.json"
git update-index --no-skip-worktree $OWNED
"${G[@]}" stash push -q -- $OWNED
git pull -q --ff-only >/dev/null 2>&1 || bad "pull after stash"
"${G[@]}" stash pop -q >/dev/null 2>&1 || true
scripts/instance-guard.sh >/dev/null
check "README update commands: update taken, owner choice kept, clean again" bash -c 'node -e "const p=require(\"./company/model-policy.json\");process.exit(p._docUpdate===\"framework 3\"&&p.candidateDefault.setBy===\"Alex\"?0:1)" && [[ -z "$(git status --porcelain)" ]] && scripts/instance-guard.sh --check >/dev/null'

# a crew edit of a framework doc in place, hidden with skip-worktree (the old instance-guard step 4 did that): the guard
# files it as a framework request with its diff and puts the file back, so the next pull is clean; owner files untouched
printf '%s\n' '- a rule the crew wrote in place' >> company/HANDOFFS.md
git update-index --skip-worktree company/HANDOFFS.md
cp company/CHARTER.md "$T/charter.before"
( cd "$U" && printf '%s\n' '- framework update 4' >> company/HANDOFFS.md && "${G[@]}" commit -qam "update 4" )
scripts/instance-guard.sh >/dev/null
check "a hidden crew edit of a framework doc is filed with its diff" bash -c 'grep -l "\`company/HANDOFFS.md\`" company/work/framework-requests/fr-*.md >/dev/null && grep -q "^+- a rule the crew wrote in place" $(grep -l "\`company/HANDOFFS.md\`" company/work/framework-requests/fr-*.md | head -1)'
check "...and the file is back to the framework's version, not hidden" bash -c '! git ls-files -v company/HANDOFFS.md | grep -q "^S" && git diff --quiet HEAD -- company/HANDOFFS.md'
check "the next pull is clean" bash -c 'git pull -q --ff-only >/dev/null 2>&1 && grep -q "framework update 4" company/HANDOFFS.md'
check "company-owned files are untouched" cmp -s company/CHARTER.md "$T/charter.before"
n0=$(ls company/work/framework-requests/fr-*.md | wc -l); scripts/instance-guard.sh >/dev/null
check "no request for a file that matches HEAD (a second guard run files nothing)" bash -c "[[ \$(ls company/work/framework-requests/fr-*.md | wc -l) == $n0 ]]"

# the memory step setup-station.sh runs (company/tools/memory.js apply) on the founded instance, with a stand-in user
# manager: its drop-ins and memory.env exist afterwards, the ExecStart override is the template's own, git stays clean
mkdir -p "$T/xdg-run/systemd" "$T/units"
printf '#!/bin/sh\necho "$*" >> %s/systemctl.log\n[ "$2" = is-active ] && echo active\nexit 0\n' "$T" > "$T/fake-systemctl"; chmod +x "$T/fake-systemctl"
XDG_RUNTIME_DIR="$T/xdg-run" MEMORY_SYSTEMCTL="$T/fake-systemctl" MEMORY_UNIT_DIR="$T/units" CAPHEOS_SUPERVISOR= node company/tools/memory.js apply >/dev/null
SVCN="$(node -e 'process.stdout.write(require("./company/company.json").station.serviceName)')"
check "memory apply after setup: a drop-in per unit and memory.env (0600)" bash -c "[[ -f '$T/units/$SVCN.service.d/50-capheos-memory.conf' && -f '$T/units/$SVCN-console.service.d/50-capheos-memory.conf' && -f '$T/units/$SVCN-dispatch.service.d/50-capheos-memory.conf' ]] && [[ \$(stat -c %a .starnet-data/memory.env) = 600 ]]"
check "...its ExecStart override is the template's own command with the heap cap" bash -c "grep -qx 'ExecStart=/usr/bin/env node --max-old-space-size=[0-9]* sidecar/index.js' '$T/units/$SVCN.service.d/50-capheos-memory.conf' && grep -q '^ExecStart=/usr/bin/env node sidecar/index.js$' systemd/capheos-station.service.in"
SLICEN="$(node -e 'process.stdout.write(require("./company/tools/lib/memory.js").sliceOf(require("./company/company.json")))')"
check "...the company's own slice, outside app.slice, with systemd-oomd's pressure kill off on it and on capheos.slice" bash -c "[[ -f '$T/units/$SLICEN' ]] && grep -qx 'ManagedOOMMemoryPressure=auto' '$T/units/$SLICEN.d/50-capheos-memory.conf' && grep -qx 'ManagedOOMMemoryPressure=auto' '$T/units/capheos.slice.d/50-capheos-memory.conf' && [[ '$SLICEN' != app.slice ]]"
check "...the limits were set live, never a restart" bash -c "grep -q '^--user set-property --runtime $SVCN.service MemoryHigh=' '$T/systemctl.log' && ! grep -q 'restart' '$T/systemctl.log'"
check "...and git status stays clean" clean

[[ $fails = 0 ]] && echo "PASS" || { echo "FAIL $fails"; exit 1; }
