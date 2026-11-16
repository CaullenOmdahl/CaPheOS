#!/usr/bin/env bash
# e2e-first-light.sh — found a company in a temp copy and walk its first day against a mock station.
#
#   scripts/e2e-first-light.sh            # PASS/FAIL per step; exit 1 on any failure
#   KEEP=1 scripts/e2e-first-light.sh     # keep the temp company (path printed at the end)
#
# Never touches this checkout's company state or any live station: the repo is copied to a temp dir (without .git,
# starnet/ and .starnet-data/), tests/mock-station.js plays the station on a free port, and the console API
# (console/server.js) runs on another free port with CAPHEOS_ROOT pointing at the copy. StarNet's page modules that
# hire.js needs come from tests/fixtures/starnet-stub/. Every station call is logged to $T/mock-requests.jsonl.
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/capheos-first-light-XXXXXX")"
LOG="$T/mock-requests.jsonl"
PIDS=()
FAILS=0
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  if [[ "${KEEP:-0}" == "1" ]]; then echo "kept: $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILS=$((FAILS + 1)); }
# check "<step>" <command...>: PASS when the command exits 0, else FAIL with the last lines of its output
check() {
  local name="$1"; shift
  local out; out="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then pass "$name"; else fail "$name" "$(printf '%s' "$out" | tail -n 4 | tr '\n' ' ' | cut -c1-400)"; fi
  return $rc
}
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
wait_port() { for _ in $(seq 1 50); do (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 0.1; done; return 1; }

# ---------- setup: a temp copy of the framework ----------
mkdir -p "$T/co"
tar -C "$SRC" --exclude=./.git --exclude=./starnet --exclude=./.starnet-data --exclude=./scratch \
  --exclude='./company/state/*' --exclude='./company/work/*' --exclude='./company/owner/*' --exclude='./secrets/*' -cf - . | tar -C "$T/co" -xf -
R="$T/co"
cp -r "$SRC/tests/fixtures/starnet-stub" "$R/starnet"
mkdir -p "$R/secrets" "$R/company/state" "$R/company/work" "$R/company/owner"
SPORT="$(free_port)"; CPORT="$(free_port)"
[[ "$SPORT" != 8800 && "$CPORT" != 8800 ]] || { echo "refusing port 8800"; exit 1; }
export CAPHEOS_ROOT="$R" STARNET_URL="http://127.0.0.1:$SPORT"
TOOLS="$R/company/tools"
cd "$R"

# ---------- 1. found the company ----------
check "found-company" bash -c '
  scripts/found-company.sh --name "First Light" --owner "Pat" --tz UTC --port '"$SPORT"' >/dev/null &&
  node -e "const c=require(\"./company/company.json\"); if (c.name!==\"First Light\"||c.owner.name!==\"Pat\"||c.station.port!=='"$SPORT"') process.exit(1)" &&
  test -e company/work/.founded && test -e company/owner/inbound.jsonl && test -e company/roles/agent.md'

# ---------- 2. the mock station ----------
TOKEN="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
printf '%s\n' "$TOKEN" > "$R/secrets/station-token"; chmod 600 "$R/secrets/station-token"
node "$SRC/tests/mock-station.js" --port "$SPORT" --token "$TOKEN" --log "$LOG" --root "$R" > "$T/mock.out" 2>&1 &
PIDS+=($!)
check "mock station up on $SPORT" wait_port "$SPORT"
st() { curl -s -H "x-starnet-token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
# mocklog '<js filter on row r>' prints the matching rows (one JSON per line)
mocklog() { node -e 'const f=process.argv[1];const fn=new Function("r","return ("+process.argv[2]+")");for(const l of require("fs").readFileSync(f,"utf8").split("\n")){if(!l)continue;const r=JSON.parse(l);if(fn(r))console.log(l)}' "$LOG" "$1"; }
logmark() { wc -l < "$LOG" | tr -d ' '; }

# ---------- 3. charter mandate ----------
check "charter mandate written" bash -c '
  node -e "
    const fs=require(\"fs\"); const f=\"company/CHARTER.md\"; let t=fs.readFileSync(f,\"utf8\");
    t=t.replace(/(## Mandate\n\n)<[^>]*>/, \"\$1First Light writes plain-language field guides for night-sky observers and sells them as monthly issues.\");
    fs.writeFileSync(f,t);" &&
  grep -q "^First Light writes plain-language field guides" company/CHARTER.md && grep -q "\*\*First Light\*\* is an autonomous company" company/CHARTER.md'

# ---------- 4. the Founder loop routine ----------
PROMPT='You are the Founder of First Light. Work company/work/handoffs/to-founder.md, then your open quests: curl -s -H "x-starnet-token: $(cat secrets/station-token)" '"$STARNET_URL"'/api/quests'
check "Founder loop routine created" bash -c '
  body=$(node -e "console.log(JSON.stringify({name:\"Founder loop\",agentId:\"agent\",schedule:\"0 */2 * * *\",tz:\"UTC\",prompt:process.argv[1],workdir:process.argv[2],deliver:\"local\",enabled:true}))" "$0" "'"$R"'")
  r=$(curl -s -H "x-starnet-token: '"$TOKEN"'" -H "Content-Type: application/json" -X POST '"$STARNET_URL"'/api/cron -d "$body")
  echo "$r" | grep -q "\"ok\":true" && curl -s -H "x-starnet-token: '"$TOKEN"'" '"$STARNET_URL"'/api/cron | grep -q "Founder loop"' "$PROMPT"
FOUNDER_JOB="$(st "$STARNET_URL/api/cron" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).jobs.find(j=>j.name==="Founder loop").id))')"

# ---------- 5. owner message -> dispatcher wakes the Founder ----------
printf '%s\n' "{\"id\":\"in-first-1\",\"at\":\"$(date -u +%FT%TZ)\",\"from\":\"Pat\",\"text\":\"Welcome aboard. What do you need from me this week?\"}" >> company/owner/inbound.jsonl
M=$(logmark)
node "$TOOLS/dispatch.js" > "$T/dispatch-1.out" 2>&1; DRC=$?
check "dispatch tick exits 0" test "$DRC" -eq 0
check "dispatch woke the Founder for the owner message" bash -c '
  [[ -n "$(tail -n +'"$((M + 1))"' "'"$LOG"'" | grep "\"path\":\"/api/cron/run\"" | grep "\"id\":\"'"$FOUNDER_JOB"'\"")" ]] &&
  grep -q "RUN Founder loop for agent (.*owner message" company/work/dispatch-log.md'
UNKNOWN="$(mocklog 'r.status===404' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=new Set(d.split("\n").filter(Boolean).map(l=>{const r=JSON.parse(l);return r.method+" "+r.path}));console.log([...s].join(", "))})')"
check "dispatch used no route the mock lacks" test -z "$UNKNOWN" || echo "  unknown routes: $UNKNOWN"

# ---------- 6. console API + a gate question ----------
node "$R/console/server.js" --port "$CPORT" > "$T/console.out" 2>&1 &
PIDS+=($!)
check "console API up on $CPORT" wait_port "$CPORT"
CTOKEN="$(cat "$R/secrets/console-token" 2>/dev/null)"
con() { local m="$1" p="$2"; shift 2; curl -s -X "$m" -H "x-console-token: $CTOKEN" -H 'content-type: application/json' "http://127.0.0.1:$CPORT$p" "$@"; }
jget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);const v=new Function("o","return ("+process.argv[1]+")")(o);console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }

QID="$(node -e '
  const gov=require(process.argv[1]+"/company/tools/lib/governance");
  const d=gov.decide("hiring",{by:"Founder",ref:"hiring:open:people-1",summary:"open a hiring round (people-1) for a People Manager",recommendation:"open it: the Founder holds every function",default:"no round is opened"});
  if (d.allowed||!d.questionId) { console.error(JSON.stringify(d)); process.exit(1); } console.log(d.questionId);' "$R")"
check "governance decide(hiring) filed an owner question" test -n "$QID"
check "gate question visible in GET /api/questions" bash -c '
  con_out=$(curl -s -H "x-console-token: '"$CTOKEN"'" http://127.0.0.1:'"$CPORT"'/api/questions)
  node -e "const o=JSON.parse(process.argv[1]); const q=o.questions.find(x=>x.id===process.argv[2]); if(!q||!q.gate||q.gate.category!==\"hiring\") process.exit(1)" "$con_out" "'"$QID"'"'
check "owner answers yes via POST /api/questions/:id/answer" bash -c '
  r=$(curl -s -X POST -H "x-console-token: '"$CTOKEN"'" -H "content-type: application/json" http://127.0.0.1:'"$CPORT"'/api/questions/'"$QID"'/answer -d "{\"verdict\":\"yes\",\"text\":\"go ahead\"}")
  echo "$r" | grep -q "\"ok\":true" &&
  node -e "const g=require(process.argv[1]+\"/company/tools/lib/governance\"); if (g.approved(\"hiring:open:people-1\")!==true) process.exit(1)" "'"$R"'"'

# ---------- 7. hiring round: people-manager takes the people function ----------
H="company/hiring/people-1"
check "hire.js open (approved gate)" bash -c "node '$TOOLS/hire.js' open --round people-1 --role 'People Manager' --by Founder --request 'the Founder wants the people function off its desk' | grep -q '\"ok\": true'"
mkdir -p "$H/profiles"
cat > "$H/research.md" <<'EOF'
# Research
People operations leads in small firms run hiring, onboarding and reviews (https://example.org/people-ops-posting).
EOF
cat > "$H/role-spec.md" <<'EOF'
# People Manager
## Scope
Hiring rounds, charters, performance and model choices for the crew.
## Out of scope
Strategy and the owner channel (the CEO's).
## KPIs
Rounds closed on time; every seat has a current charter.
EOF
printf '# Model fit\nDeepSeek Flash: cheap, steady, good at structured writing.\n' > "$H/model-fit.md"
printf '# Interview\n\n## How do you run a hiring round end to end?\n\n## What do you do when a seat keeps missing deadlines?\n' > "$H/interview.md"
printf '# Profile\n\n## Personality\nCalm, exact, kind.\n\n## Voice\nShort sentences.\n\n## Persona preset\ncomposed\n' > "$H/profiles/quinn.md"
CAND="$(node "$TOOLS/hire.js" candidate --round people-1 --name Quinn --profile "$H/profiles/quinn.md" --by Founder 2> "$T/cand.err" | jget 'o.agentId' 2>/dev/null)"
check "hire.js candidate created on the station" bash -c "[[ -n '$CAND' && '$CAND' != undefined ]] && grep -q '$CAND' '$R/.starnet-data/workspaces/agent.roster.json'" || cat "$T/cand.err" | tail -3
# --force: a new company's metered cap is $0 until the finance owner sets one (dispatch-budget.json), and candidates default to a metered model
check "hire.js interview (mock /api/run answers)" bash -c "node '$TOOLS/hire.js' interview --round people-1 --questions $H/interview.md --force > '$T/interview.out' 2>&1; grep -q 'Finished ' '$H/interviews/$CAND.md' && grep -q 'I would start by reading the charter' '$H/interviews/$CAND.md'"
printf '# Scorecard\n| Candidate | Score |\n|---|---|\n| Quinn | 4/5 |\n' > "$H/scorecard.md"
HIRE=(node "$TOOLS/hire.js" hire --round people-1 --agent "$CAND" --title "People Manager" --by Founder --approved "Founder, company/work/decisions.md $(date -u +%F)" --template people-manager --functions people)
"${HIRE[@]}" > "$T/hire-1.out" 2>&1; HRC=$?
HQ="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((o.governance||{}).questionId||"")' "$T/hire-1.out" 2>/dev/null)"
check "hire.js hire waits for the owner (exit 3, question filed)" bash -c "[[ $HRC -eq 3 && -n '$HQ' ]]"
con POST "/api/questions/$HQ/answer" -d '{"verdict":"yes"}' > /dev/null
"${HIRE[@]}" > "$T/hire-2.out" 2>&1; HRC=$?
check "hire.js hire after the owner's yes" bash -c "[[ $HRC -eq 0 ]] && grep -q '\"ok\": true' '$T/hire-2.out'" || tail -5 "$T/hire-2.out"
check "loops.json has two seats and people moved" node -e '
  const L=require(process.argv[1]+"/company/tools/loops.json").agents; const ids=Object.keys(L);
  const hire=L[process.argv[2]];
  if (ids.length!==2||!hire||!hire.functions.includes("people")||L.agent.functions.includes("people")||!L.agent.functions.includes("tools")) { console.error(JSON.stringify(L)); process.exit(1); }' "$R" "$CAND"
check "hire created the new seat's loop routine" bash -c "st_out=\$(curl -s -H 'x-starnet-token: $TOKEN' $STARNET_URL/api/cron); echo \"\$st_out\" | grep -q 'Quinn loop'"
check "lib/company routes people to the hire" bash -c "[[ \"\$(node -e 'console.log(require(\"$TOOLS/lib/company\").seatFor(\"people\"))')\" == '$CAND' ]]"
HNAME="$(node -e 'console.log(require(process.argv[1]+"/company/tools/loops.json").agents[process.argv[2]].name)' "$R" "$CAND")"

# ---------- 8. harness change: proposed by the hire, reviewed and applied by the tools holder ----------
cp company/standards/autonomy.md "$T/autonomy.new.md"
printf '\n## Added on first light\nEvery seat writes its log entry before ending a session.\n' >> "$T/autonomy.new.md"
mkdir -p company/work/changes-in && cp "$T/autonomy.new.md" company/work/changes-in/autonomy.md
HCID="$(node "$TOOLS/harness-change.js" propose --kind tool --target company/standards/autonomy.md --why "make the session-log rule explicit" --change company/work/changes-in/autonomy.md --by "$HNAME" 2> "$T/hc.err" | sed -nE 's/^proposed (hc-[0-9]+).*/\1/p')"
check "harness-change propose by $HNAME" test -n "$HCID" || tail -3 "$T/hc.err"
check "harness-change: proposer cannot review own change" bash -c "! node '$TOOLS/harness-change.js' approve $HCID --by '$HNAME' >/dev/null 2>&1"
check "harness-change approve by Founder (tools holder)" bash -c "node '$TOOLS/harness-change.js' approve $HCID --by Founder | grep -q 'now approved'"
check "harness-change apply by Founder" bash -c "node '$TOOLS/harness-change.js' apply $HCID --by Founder >/dev/null && grep -q 'Added on first light' company/standards/autonomy.md && test -e company/work/changes/$HCID/before/autonomy.md"

# ---------- 9. owner controls: a guardrail and a governance preset ----------
check "owner turns a guardrail off and on" bash -c '
  c() { curl -s -X POST -H "x-console-token: '"$CTOKEN"'" -H "content-type: application/json" http://127.0.0.1:'"$CPORT"'$1 -d "$2"; }
  c /api/guardrails/set "{\"name\":\"externalActions\",\"on\":false,\"why\":\"first light\"}" >/dev/null &&
  node -e "if (require(\"'"$R"'/company/state/guardrails.json\").guards.externalActions!==false) process.exit(1)" &&
  c /api/guardrails/set "{\"name\":\"externalActions\",\"on\":true}" >/dev/null &&
  node -e "if (require(\"'"$R"'/company/state/guardrails.json\").guards.externalActions!==true) process.exit(1)"'
check "owner applies the gate-money governance preset" bash -c '
  curl -s -X POST -H "x-console-token: '"$CTOKEN"'" -H "content-type: application/json" http://127.0.0.1:'"$CPORT"'/api/governance/preset -d "{\"preset\":\"gate-money\"}" | grep -q "\"ok\":true" &&
  node -e "const g=require(\"'"$R"'/company/state/governance.json\"); if (g.preset!==\"gate-money\"||g.categories.hiring!==\"notify\") process.exit(1)"'

# ---------- 10. soft halt -> tick -> settle -> resume ----------
M=$(logmark)
check "soft halt via console" bash -c "curl -s -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/halt/soft -d '{\"why\":\"first light drill\"}' | grep -q '\"mode\": *\"soft\"'"
node "$TOOLS/dispatch.js" > "$T/dispatch-2.out" 2>&1
check "tick settles the soft halt and wakes nobody" bash -c "node -e 'const h=require(\"$R/company/state/halt.json\"); if (h.mode!==\"soft\"||!h.settledAt) process.exit(1)' && grep -q 'HALTED (soft' '$T/dispatch-2.out' && [[ -z \"\$(tail -n +$((M + 1)) '$LOG' | grep '\"path\":\"/api/cron/run\"')\" ]]"
check "resume via console" bash -c "curl -s -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/halt/resume -d '{}' | grep -q '\"mode\": *\"running\"'"
check "station saw cron/arm false then true and no /api/halt" node -e '
  const rows=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).slice(Number(process.argv[2])).map(JSON.parse);
  const arms=rows.filter(r=>r.path==="/api/cron/arm").map(r=>r.body&&r.body.enabled);
  const halts=rows.filter(r=>r.path==="/api/halt"&&r.method==="POST");
  if (JSON.stringify(arms)!=="[false,true]"||halts.length) { console.error(JSON.stringify({arms,halts:halts.length})); process.exit(1); }' "$LOG" "$M"

# ---------- 11. hard halt ----------
M=$(logmark)
check "hard halt via console reaches POST /api/halt" bash -c "curl -s -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/halt/hard -d '{\"why\":\"drill\"}' | grep -q '\"mode\": *\"hard\"' && [[ -n \"\$(tail -n +$((M + 1)) '$LOG' | grep '\"method\":\"POST\",\"path\":\"/api/halt\"')\" ]]"
check "resume from hard halt lifts the E-STOP" bash -c "curl -s -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/halt/resume -d '{}' | grep -q '\"mode\": *\"running\"' && [[ -n \"\$(tail -n +$((M + 1)) '$LOG' | grep '/api/halt/resume')\" ]]"

# ---------- 12. a console panel ----------
check "console-panel add open-handoffs" bash -c "node '$TOOLS/console-panel.js' add company/console/examples/open-handoffs --by Founder > '$T/panel.out' 2>&1 && test -e company/console/panels/open-handoffs/panel.json"
check "panel renders via the console API" bash -c "r=\$(curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/panels/open-handoffs/data); echo \"\$r\" | grep -q '\"ok\":true' && echo \"\$r\" | grep -qi 'handoff'"

check "tool-written handoffs carry a dated deadline (console due list)" bash -c "r=\$(curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/handoffs); node -e 'const o=JSON.parse(process.argv[1]); const h=o.items.find(x=>/from hire.js/.test(x.heading)); if(!h||!h.due) { console.error(JSON.stringify(h)); process.exit(1); }' \"\$r\""

# ---------- summary ----------
UNKNOWN="$(mocklog 'r.status===404' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=new Set(d.split("\n").filter(Boolean).map(l=>{const r=JSON.parse(l);return r.method+" "+r.path}));console.log([...s].join(", "))})')"
[[ -n "$UNKNOWN" ]] && echo "note: routes the mock answered 404: $UNKNOWN"
if [[ $FAILS -eq 0 ]]; then echo "FIRST LIGHT: PASS"; exit 0; else echo "FIRST LIGHT: FAIL ($FAILS)"; exit 1; fi
