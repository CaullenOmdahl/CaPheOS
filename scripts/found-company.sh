#!/usr/bin/env bash
# found-company.sh — turn this framework checkout into one specific company.
#
#   scripts/found-company.sh --name "Example Law" --owner "Alex" [--industry "legal services"] \
#       [--tz America/Chicago] [--port 8802] [--slug example-law] [--force]
#
# Writes company/company.json, copies the framework defaults (company/defaults/) into company/work and company/state,
# seats the Founder (company/roles/agent.md from the founder template), and creates the empty inboxes and logs the
# tools expect. It never touches the station; run scripts/setup-station.sh after. Refuses to run twice unless --force
# (a second run would overwrite policy files the company may already have tuned; with --force existing files are kept).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAME="" OWNER="" INDUSTRY="" TZ_="" PORT="" SLUG="" FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --owner) OWNER="$2"; shift 2;;
    --industry) INDUSTRY="$2"; shift 2;;
    --tz) TZ_="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --slug) SLUG="$2"; shift 2;;
    --force) FORCE=1; shift;;
    -h|--help) sed -n 2,10p "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
[[ -n "$NAME" && -n "$OWNER" ]] || { echo "need --name and --owner" >&2; exit 2; }
if [[ -e company/work/.founded && $FORCE -eq 0 ]]; then
  echo "already founded ($(cat company/work/.founded)); use --force to fill in missing files" >&2; exit 1
fi
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
[[ -e company/projects.json ]] || printf '{ "projects": {} }\n' > company/projects.json
[[ -e company/mandates.json ]] || printf '{ "mandates": [] }\n' > company/mandates.json
date -Is > company/work/.founded
echo "$NAME founded for $OWNER (tz $TZ_, station port $PORT)."
echo "Next: write the charter with the Founder (company/CHARTER.md), then scripts/setup-station.sh"
