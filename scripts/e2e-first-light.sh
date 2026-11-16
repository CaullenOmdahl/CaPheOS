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
tar -C "$SRC" --exclude=./.git --exclude=./.framework-checkout --exclude=./starnet --exclude=./.starnet-data --exclude=./scratch \
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
check "founding recorded in onboarding state (not certified)" node -e '
  const s=require("./company/state/onboarding-state.json"); if (s.steps.founded.status!=="ok"||s.certified) process.exit(1)'
check "found-company.sh --check passes preflight on a founded company" bash -c 'scripts/found-company.sh --check >/dev/null'
check "re-running found-company.sh with the same name resumes (idempotent)" bash -c 'scripts/found-company.sh --name "First Light" --owner "Pat" --tz UTC --port '"$SPORT"' >/dev/null'
check "found-company.sh refuses a different name without --force" bash -c '! scripts/found-company.sh --name "Other Co" --owner "Pat" >/dev/null 2>&1'

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

# ---------- 4. onboarding creates the Founder loop (no hand-made routine) ----------
# (station-seed runs with --resume in step 14: on this mock the save already exists, and seeding now would put the
# Founder in "ask" mode under the default self-governance, which the dispatcher holds; step 5 needs the wake)
check "onboarding step founder-loop" bash -c "node '$TOOLS/onboard.js' --step founder-loop --json > '$T/founder-loop.out' 2>&1 && grep -q '\"status\": \"ok\"' '$T/founder-loop.out'" || tail -5 "$T/founder-loop.out"
check "the Founder loop runs in the company folder with the terminal grant, every 2 hours, on the candidate default" node -e '
  const S=JSON.parse(require("child_process").execSync("curl -s -H \"x-starnet-token: "+process.argv[2]+"\" "+process.argv[3]+"/__state"));
  const j=S.cron.jobs.filter(x=>x.name.startsWith("Founder loop"));
  const ok=j.length===1&&j[0].agentId==="agent"&&j[0].workdir===process.argv[1]&&j[0].unattendedGrants.includes("workbench")&&j[0].schedule.minutes===120&&j[0].model&&j[0].provider&&/owner-inbox\.js new/.test(j[0].prompt)&&/CHARTER\.md/.test(j[0].prompt);
  if(!ok){console.error(JSON.stringify(j));process.exit(1)}' "$R" "$TOKEN" "$STARNET_URL"
check "onboarding blessed the company folder and armed the scheduler" node -e '
  const S=JSON.parse(require("child_process").execSync("curl -s -H \"x-starnet-token: "+process.argv[2]+"\" "+process.argv[3]+"/__state"));
  if(!S.projects.some(p=>p.root===process.argv[1]&&p.blessed)||S.cron.enabled!==true){console.error(JSON.stringify({p:S.projects,en:S.cron.enabled}));process.exit(1)}' "$R" "$TOKEN" "$STARNET_URL"
node "$TOOLS/onboard.js" --step founder-loop --json > "$T/founder-loop-2.out" 2>&1
check "founder-loop again: idempotent (one routine, nothing changed)" node -e '
  const S=JSON.parse(require("child_process").execSync("curl -s -H \"x-starnet-token: "+process.argv[1]+"\" "+process.argv[2]+"/__state"));
  const n=S.cron.jobs.filter(x=>x.name.startsWith("Founder loop")).length; const o=require("fs").readFileSync(process.argv[3],"utf8");
  if(n!==1||!/already in place/.test(o)){console.error(n+" "+o);process.exit(1)}' "$TOKEN" "$STARNET_URL" "$T/founder-loop-2.out"
check "founder-loop.js status: green" node "$TOOLS/founder-loop.js" status
FOUNDER_JOB="$(st "$STARNET_URL/api/cron" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).jobs.find(j=>j.name.startsWith("Founder loop")).id))')"

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

# ---------- 13. core module: liveness -> tick -> heartbeat ----------
check "module.js enable liveness" bash -c "node '$TOOLS/module.js' enable liveness --by owner --json > '$T/liveness-enable.out' 2>&1 && grep -q '\"status\": \"conformant\"' '$T/liveness-enable.out'" || tail -5 "$T/liveness-enable.out"
check "liveness tool documented on enable (inventory check green)" node "$TOOLS/tool-inventory-check.js"
node "$TOOLS/dispatch.js" > "$T/dispatch-3.out" 2>&1
check "dispatch tick writes the heartbeat (liveness tick hook)" bash -c "node -e 'const h=require(\"$R/company/state/heartbeat.json\"); if (!h.at||!(h.ticks>=1)) process.exit(1)' && ! grep -q 'TICK ERROR' '$T/dispatch-3.out'"
check "liveness watcher sees a fresh heartbeat" node "$R/modules/liveness/watch.js"

# ---------- 14. certification against the mock station ----------
export CAPHEOS_BACKUP_DIR="$T/backups" CONSOLE_URL="http://127.0.0.1:$CPORT"
node "$TOOLS/onboard.js" --certify --json > "$T/certify-1.out" 2>&1; CRC=$?
check "certify fails before onboarding is finished" test "$CRC" -eq 1
check "certify names the missing pieces (ops, liveness ping, charter) and passes station/console/dispatcher" node -e '
  const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).results;
  const bad=Object.keys(r).filter(k=>!r[k].ok);
  for (const k of ["ops","liveness","charter"]) if (!bad.includes(k)) { console.error("expected "+k+" to fail: "+JSON.stringify(r)); process.exit(1); }
  for (const k of ["station","console","dispatcher","secrets"]) if (bad.includes(k)) { console.error(k+" failed: "+JSON.stringify(r[k])); process.exit(1); }
  if (!/never pinged/.test(r.liveness.missing)||!/backup/.test(r.ops.missing)) { console.error(JSON.stringify(r)); process.exit(1); }' "$T/certify-1.out"
node "$TOOLS/onboard.js" --resume --json > "$T/resume.out" 2>&1
check "onboard --resume: ops registered, first backup verified" node -e '
  const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).steps;
  if (s["ops-registered"].status!=="ok"||s["first-backup"].status!=="ok") { console.error(JSON.stringify(s)); process.exit(1); }' "$T/resume.out"
check "first-light finding: metered candidate default with a \$0 cap becomes an owner gate on Today" bash -c "
  node -e 'const s=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).steps; if (s[\"candidate-default\"].status!==\"pending\") process.exit(1)' '$T/resume.out' &&
  curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/questions | grep -q 'Hiring candidates default to the metered model'"
check "liveness ping" node "$TOOLS/liveness.js" ping

# ---------- 15. Setup -> Draft it with the Founder: a live chat whose reply streams in ----------
# a run in flight on the station (a routine of the Founder's), for the "Now" strip
curl -s -X POST -H "x-station-test: 1" -H "x-starnet-token: $TOKEN" -H 'Content-Type: application/json' "$STARNET_URL/__live" -d '{"agentId":"agent","routine":"Founder loop","ageSec":95,"usd":0.0042,"steps":[["fs_read","company/CHARTER.md"]]}' > "$T/live.out"
LIVE_RUN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).run.runId)' "$T/live.out")"
sleep 1
printf '%s' '{"text":"hello"}' > "$T/hello.json"
check "with a \$0 cap, a metered Founder's live chat is refused with the fix (budget hold)" bash -c "curl -s -N -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/chat/agent/send -d @'$T/hello.json' | grep -q 'budget-hold'"
curl -s -X POST -H "x-console-token: $CTOKEN" -H 'content-type: application/json' "http://127.0.0.1:$CPORT/api/setup/budget" -d '{"dailyUsd":2,"perAgentUsd":1}' > "$T/budget.out"
if [[ "${E2E_NO_BROWSER:-0}" != "1" ]]; then
  check "headless Chrome: every route, Setup -> draft with the Founder -> streamed reply, Now strip" node "$R/tests/console-walk.js" --url "http://127.0.0.1:$CPORT" --token "$CTOKEN" --shots "$T/shots"
fi
check "GET /api/chat/agent: the Founder's model comes from its loop routine" bash -c "curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/chat/agent | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const o=JSON.parse(d);if(!o.ok||!o.model||!/loop routine/.test(o.modelFrom)){console.error(d.slice(0,300));process.exit(1)}})'"
curl -s -N -X POST -H "x-console-token: $CTOKEN" -H 'content-type: application/json' "http://127.0.0.1:$CPORT/api/chat/agent/send" -d '{"brief":"charter","notes":{"mandate":"Field guides for night-sky observers"}}' > "$T/chat.ndjson"
check "the charter brief streams: console.run, a tool step, tokens, then the end" node -e '
  const ev=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse); const n=ev.map(e=>e.name);
  const toks=ev.filter(e=>e.name==="agent.token").length;
  if(!(n[0]==="console.user"&&/CHARTER\.md/.test(ev[0].payload.text)&&n.includes("console.run")&&n.includes("agent.tool_call")&&toks>3&&n[n.length-1]==="agent.run.end")){console.error(n.join(","));process.exit(1)}' "$T/chat.ndjson"
check "the station run carried the seat model, the console stream and the company folder as project root" node -e '
  const rows=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse).filter(r=>r.path==="/api/run"&&r.body&&r.body.streamId==="console-agent");
  const b=rows.length&&rows[rows.length-1].body;
  if(!b||b.projectRoot!==process.argv[2]||!b.model||!b.provider||!b.rosterSystem||!b.placed.some(p=>p.objectType==="cabinet")){console.error(JSON.stringify(b).slice(0,400));process.exit(1)}' "$LOG" "$R"
check "the Founder wrote company/CHARTER.md: no blanks left (GET /api/setup/charter)" bash -c "curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/setup/charter | grep -q '\"placeholders\":\[\]'"
check "the conversation persists: GET /api/chat/agent has the turns" bash -c "curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/chat/agent | grep -q 'Three quick questions'"
check "a station refusal is a console.error line, not silence" bash -c "curl -s -N -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/chat/agent/send -d '{\"text\":\"please [fail] now\"}' | grep -q 'agent.run.error'"

# ---------- 16. the crew's work, visible: Now, Watch, Stop, activity, owner-message state ----------
check "GET /api/now: the run in flight with its step, elapsed time and cost" bash -c "curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/now | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const o=JSON.parse(d);const r=o.runs.find(x=>x.runId===\"$LIVE_RUN\");if(!r||r.name!==\"Founder\"||!/reading company\/CHARTER\.md/.test(r.step)||!(r.elapsedSec>=90)||!(r.usd>0)||!/Founder loop/.test(r.label)){console.error(d.slice(0,600));process.exit(1)}})'"
check "GET /api/now/run/:id: the Watch view's events" bash -c "curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/now/run/$LIVE_RUN | grep -q 'reading company/CHARTER.md'"
check "Stop via the station proxy ends the run" bash -c "curl -s -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/station/cancel -d '{\"runId\":\"$LIVE_RUN\"}' >/dev/null; sleep 1; ! curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/now | grep -q '$LIVE_RUN'"
check "GET /api/activity answers with linked items" bash -c "curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/activity | grep -q '\"links\"'"
check "an owner message shows what it waits on (next check within N min)" bash -c "curl -s -X POST -H 'x-console-token: $CTOKEN' -H 'content-type: application/json' http://127.0.0.1:$CPORT/api/owner/messages -d '{\"text\":\"status please\"}' | grep -Eq 'next check within [0-9]+ min|\"status\":\"working\"'"
node "$TOOLS/onboard.js" --certify --json > "$T/certify-2.out" 2>&1; CRC=$?
check "certify green once every piece is in place" bash -c "[[ $CRC -eq 0 ]]" || node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).results; for (const k in r) if (!r[k].ok) console.log("  still failing: "+k+" — "+r[k].missing)' "$T/certify-2.out"
check "GET /api/onboarding reports certified" bash -c "curl -s -H 'x-console-token: $CTOKEN' http://127.0.0.1:$CPORT/api/onboarding | grep -q '\"certified\":true'"
check "certification kicked off the Founder's first plan once (handoff + one loop run)" bash -c "
  grep -q 'turn the charter into the first plan' company/work/handoffs/to-founder.md &&
  node -e 'const s=require(\"$R/company/state/onboarding-state.json\"); if (s.steps.kickoff.status!==\"ok\") { console.error(JSON.stringify(s.steps.kickoff)); process.exit(1); }' &&
  [[ \$(grep -c 'turn the charter into the first plan' company/work/handoffs/to-founder.md) -eq 1 ]]"
node "$TOOLS/onboard.js" --certify --json > /dev/null 2>&1
check "a second certify does not kick off again" bash -c "[[ \$(grep -c 'turn the charter into the first plan' company/work/handoffs/to-founder.md) -eq 1 ]]"

# ---------- summary ----------
UNKNOWN="$(mocklog 'r.status===404' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=new Set(d.split("\n").filter(Boolean).map(l=>{const r=JSON.parse(l);return r.method+" "+r.path}));console.log([...s].join(", "))})')"
[[ -n "$UNKNOWN" ]] && echo "note: routes the mock answered 404: $UNKNOWN"
if [[ $FAILS -eq 0 ]]; then echo "FIRST LIGHT: PASS"; exit 0; else echo "FIRST LIGHT: FAIL ($FAILS)"; exit 1; fi
