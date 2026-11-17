#!/usr/bin/env bash
# found-company.sh — turn this framework checkout into one specific company.
#
#   scripts/found-company.sh --name "Example Law" --owner "Alex" [--industry "legal services"] \
#       [--tz America/Chicago] [--port 8802] [--slug example-law] [--force]
#   scripts/found-company.sh --check [--name .. --owner ..]    # preflight + what is founded already; writes nothing
#
# Writes company/company.json, copies the framework defaults (company/defaults/) into company/work and company/state,
# seats the Founder (company/roles/agent.md from the founder template), and creates the empty inboxes and logs the
# tools expect. It never touches the station; run scripts/setup-station.sh after. Re-running with the same name and owner
# resumes (fills in what is missing, never overwrites a file); a different name or owner needs --force. The step is
# recorded in company/state/onboarding-state.json (company/tools/onboard.js); company/work/.founded is still written for
# older tools. Provisioned is not certified: node company/tools/onboard.js --certify proves the company can run.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAME="" OWNER="" INDUSTRY="" TZ_="" PORT="" SLUG="" FORCE=0 CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --owner) OWNER="$2"; shift 2;;
    --industry) INDUSTRY="$2"; shift 2;;
    --tz) TZ_="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --slug) SLUG="$2"; shift 2;;
    --force) FORCE=1; shift;;
    --check) CHECK=1; shift;;
    -h|--help) sed -n 2,10p "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
# ---------- preflight (also the whole of --check) ----------
PRE=0
pre() { if [[ "$1" == ok ]]; then echo "  ok    $2"; else echo "  FAIL  $2"; PRE=1; fi; }
CUR_NAME="$(node -e 'try{const c=require("./company/company.json");process.stdout.write(String(c.name||""))}catch(_){}' 2>/dev/null || true)"
CUR_OWNER="$(node -e 'try{const c=require("./company/company.json");process.stdout.write(String((c.owner&&c.owner.name)||""))}catch(_){}' 2>/dev/null || true)"
FOUNDED=0; [[ -e company/work/.founded ]] && FOUNDED=1
node -e 'try{const s=require("./company/state/onboarding-state.json");process.exit(s.steps&&s.steps.founded&&s.steps.founded.status==="ok"?0:1)}catch(_){process.exit(1)}' 2>/dev/null && FOUNDED=1
echo "preflight:"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[[ "$NODE_MAJOR" -ge 22 ]] && pre ok "node $NODE_MAJOR" || pre fail "node 22+ is required (found ${NODE_MAJOR})"
[[ -f company/company.json ]] && pre ok "company/company.json present" || pre fail "company/company.json missing (not a CaPheOS checkout?)"
[[ -d company/defaults && -f company/CHARTER.md && -f company/roles/templates/founder.md ]] && pre ok "framework defaults, charter and founder template present" || pre fail "company/defaults, company/CHARTER.md or company/roles/templates/founder.md missing"
[[ -w company ]] && pre ok "company/ writable" || pre fail "company/ not writable"
if [[ -n "$TZ_" ]]; then node -e 'new Intl.DateTimeFormat("en",{timeZone:process.argv[1]})' "$TZ_" 2>/dev/null && pre ok "timezone $TZ_" || pre fail "bad timezone $TZ_"; fi
[[ -z "$PORT" || "$PORT" =~ ^[0-9]+$ ]] && pre ok "station port ${PORT:-8801 (default)}" || pre fail "port must be a number"
if [[ $FOUNDED -eq 1 ]]; then
  echo "  note  already founded as \"$CUR_NAME\" for $CUR_OWNER"
  if [[ -n "$NAME" && ( "$NAME" != "$CUR_NAME" || "$OWNER" != "$CUR_OWNER" ) && $FORCE -eq 0 ]]; then pre fail "founded as \"$CUR_NAME\"/$CUR_OWNER; a different name or owner needs --force"; fi
fi
if [[ $CHECK -eq 1 ]]; then
  [[ -f company/tools/onboard.js ]] && node company/tools/onboard.js --check 2>/dev/null | sed 's/^/  /' || true
  exit $PRE
fi
if [[ -e .framework-checkout ]]; then
  echo "refused: this is a framework checkout (.framework-checkout). Clone the repository into a new folder for each" >&2
  echo "company and found it there; see README, 'One rule'." >&2; exit 1
fi
[[ -n "$NAME" && -n "$OWNER" ]] || { echo "need --name and --owner" >&2; exit 2; }
[[ $PRE -eq 0 ]] || { echo "preflight failed; nothing was written" >&2; exit 1; }
[[ $FOUNDED -eq 1 ]] && echo "resuming: filling in whatever is missing (existing files are kept)"
TZ_="${TZ_:-$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)}"
SLUG="${SLUG:-$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g')}"
PORT="${PORT:-8801}"

NAME="$NAME" OWNER="$OWNER" INDUSTRY="$INDUSTRY" TZ_="$TZ_" PORT="$PORT" SLUG="$SLUG" node -e '
const fs = require("fs"); const f = "company/company.json";
const c = JSON.parse(fs.readFileSync(f, "utf8")); const e = process.env;
try { new Intl.DateTimeFormat("en", { timeZone: e.TZ_ }); } catch (_) { console.error("bad timezone " + e.TZ_); process.exit(2); }
c.name = e.NAME; c.shortName = e.NAME; c.slug = e.SLUG; c.industry = e.INDUSTRY; c.timezone = e.TZ_;
c.owner = Object.assign({}, c.owner, { name: e.OWNER, addressAs: e.OWNER });
c.station = Object.assign({}, c.station, { port: Number(e.PORT), url: "http://127.0.0.1:" + e.PORT, serviceName: e.SLUG + "-station" });
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
// Competence scoring starts at founding and stays in shadow (measure, change nothing) for its first 30 days.
const cp = "company/competence-policy.json"; const p = JSON.parse(fs.readFileSync(cp, "utf8")); const now = new Date();
if (!p.companyStart || p.companyStart.startsWith("1970")) {
  p.companyStart = now.toISOString(); p.gateAuditFrom = now.toISOString();
  p.shadowUntil = new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync(cp, JSON.stringify(p, null, 2) + "\n");
}'

copy_default() { # src under company/defaults -> same path under company/, never overwriting
  local rel dst
  rel="${1#company/defaults/}"; dst="company/$rel"
  mkdir -p "$(dirname "$dst")"
  [[ -e "$dst" ]] || cp "$1" "$dst"
}
while IFS= read -r -d '' f; do copy_default "$f"; done < <(find company/defaults -type f -print0)

fill() { sed -e "s/{{COMPANY}}/$(printf '%s' "$NAME" | sed 's/[&/\]/\\&/g')/g" -e "s/{{OWNER}}/$(printf '%s' "$OWNER" | sed 's/[&/\]/\\&/g')/g" "$1"; }
mkdir -p company/roles company/work/handoffs/archive company/owner company/hiring company/state
[[ -e company/roles/agent.md ]] || fill company/roles/templates/founder.md | sed 's/^# <Name> — /# Founder — /' > company/roles/agent.md
for doc in CHARTER.md; do
  grep -q '{{COMPANY}}' "company/$doc" && { fill "company/$doc" > "company/$doc.tmp" && mv "company/$doc.tmp" "company/$doc"; }
done

touch company/owner/inbound.jsonl company/owner/outbound.jsonl company/escalations.jsonl
[[ -e company/work/handoffs/to-founder.md ]] || printf '# Handoffs to the Founder\n\n' > company/work/handoffs/to-founder.md
[[ -e company/work/decisions.md ]] || printf '# Decisions\n\nNewest first. Who decided, what, why.\n\n' > company/work/decisions.md
[[ -e company/work/improvements.md ]] || printf '# Improvements\n\nIdeas to make the company work better. One line each: who, what, why, and the seat whose scope it is in. Close one by changing it to DONE with the evidence.\n\n' > company/work/improvements.md
[[ -e company/projects.json ]] || printf '{ "projects": {} }\n' > company/projects.json
[[ -e company/mandates.json ]] || printf '{ "mandates": [] }\n' > company/mandates.json
[[ -e company/work/.founded ]] || date -Is > company/work/.founded   # kept for older tools; onboarding state is the record
node company/tools/onboard.js --record founded ok --note "$NAME for $OWNER (tz $TZ_, port $PORT)" >/dev/null 2>&1 || echo "note: could not record the founding step (company/tools/onboard.js)" >&2
"$ROOT/scripts/instance-guard.sh" >/dev/null 2>&1 || echo "warning: instance guard did not apply; run scripts/instance-guard.sh"
echo "$NAME founded for $OWNER (tz $TZ_, station port $PORT)."
echo "Next: write the charter with the Founder (company/CHARTER.md), then scripts/setup-station.sh --start,"
echo "then node company/tools/onboard.js --certify (provisioned is not certified)."
