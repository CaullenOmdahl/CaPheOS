#!/usr/bin/env bash
# check-clean-tree.sh — the framework repository holds no company. Fails if anything a running company writes is
# TRACKED (committed), whatever route it took. Run by scripts/test.sh and therefore by CI on every push.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git checkout; skipped"; exit 0; }
fail=0; bad() { echo "FAIL  $*"; fail=1; }
show() { git show "HEAD:$1" 2>/dev/null || cat "$1"; }   # the committed version, not a local (possibly founded) copy
tracked="$(git ls-files)"

# 1. identity files are the unfounded templates
node -e 'const c=JSON.parse(process.argv[1]); if (c.name!=="Unfounded Company"||(c.owner&&c.owner.name)!=="Owner") process.exit(1)' "$(show company/company.json)" \
  || bad "company/company.json is not the unfounded template (a company name or owner was committed)"
show company/CHARTER.md | grep -q '{{COMPANY}}' || bad "company/CHARTER.md has no {{COMPANY}} placeholder (a founded charter was committed)"
node -e 'const p=JSON.parse(process.argv[1]); if (!String(p.companyStart||"").startsWith("1970")) process.exit(1)' "$(show company/competence-policy.json)" \
  || bad "company/competence-policy.json carries a founding date"
node -e 'const a=JSON.parse(process.argv[1]).agents||{}; const k=Object.keys(a); if (k.length!==1||k[0]!=="agent"||a.agent.name!=="Founder") process.exit(1)' "$(show company/tools/loops.json)" \
  || bad "company/tools/loops.json lists more than the template Founder (a running company's crew was committed)"
# 2. runtime folders hold nothing but .gitkeep
for d in company/work company/state company/owner company/hiring; do
  extra="$(grep "^$d/" <<<"$tracked" | grep -v "/.gitkeep$" || true)"; [[ -z "$extra" ]] || bad "runtime files tracked under $d: $(echo $extra | head -c 200)"
done
extra="$(grep -E '^company/roles/[^/]+\.md$' <<<"$tracked" || true)"; [[ -z "$extra" ]] || bad "role charters tracked: $extra"
extra="$(grep -E '^company/console/(panels|proposed)/|^company/console/(state\.json|changes\.jsonl)$' <<<"$tracked" || true)"; [[ -z "$extra" ]] || bad "crew console panels tracked: $extra"
# 3. secrets, station, data
extra="$(grep -E '^secrets/' <<<"$tracked" | grep -v '^secrets/README.md$' || true)"; [[ -z "$extra" ]] || bad "secrets tracked: $extra"
extra="$(grep -E '^(starnet|\.starnet-data|scratch)/' <<<"$tracked" || true)"; [[ -z "$extra" ]] || bad "station checkout/data tracked: $(echo $extra | head -c 200)"
# 4. module tools copied into company/tools by an enable, and their inventory rows
for f in modules/*/tools/*; do
  b="$(basename "$f")"; grep -qx "company/tools/$b" <<<"$tracked" && bad "an enabled module's tool is tracked: company/tools/$b"
done
show company/tools/INVENTORY.md | grep -q '(module [a-z]' && bad "company/tools/INVENTORY.md carries rows added by a module enable"
# 5. nothing that looks like a key (selftest fixtures use obvious fakes: test, placeholder, example, abcdef…)
keys="$(git grep -nIoE '(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' -- . ':!scripts/check-clean-tree.sh' 2>/dev/null \
  | grep -viE 'test|placeholder|example|fake|dummy|abcdef|xxxx|0123456789' || true)"
[[ -z "$keys" ]] || bad "something shaped like a key is tracked: $(echo "$keys" | cut -d: -f1,2 | head -3 | tr '\n' ' ')"
[[ $fail = 0 ]] && echo "clean tree: the repository holds the framework and no company" || exit 1
