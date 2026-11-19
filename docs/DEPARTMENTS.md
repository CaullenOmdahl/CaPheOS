# Departments

A department is a group of seats with one lead. The lead is who the members go to when an item is stuck, who reviews
their plans, and who keeps the department's brief. This page covers the data, the tool, the checks, the console view and
(§5) what a lead does when its department's advice is on.

Code: `company/departments.json` (the data), `company/tools/lib/departments.js` (reading and checks),
`company/tools/lib/company.js` (`co.deptOf`, `co.leadOf`, `co.departmentsOf`), `company/tools/departments.js` (the only
writer), `console/departments.js` and `console/ui/js/screens/crew-departments.js` (the owner's view). Advisor leads:
`company/tools/lib/consult.js` and `company/tools/consult.js`. Tests: `node company/tools/departments.js --selftest`,
`node company/tools/consult.js --selftest` and `node --test company/tools/tests/departments.test.js
company/tools/tests/consult.test.js company/tools/tests/consult-dispatch.test.js company/tools/tests/advisor-eval.test.js`.

## 1. The data: company/departments.json

The file is copied at founding from `company/defaults/departments.json` (`scripts/found-company.sh` copies every
default). That default has **no departments**. **A missing file means no departments**: `deptOf` and `leadOf` are
`null`, and every tool behaves as it did before departments existed.

```json
{
  "_doc": "...",
  "version": 1,
  "leadModelDefault": { "provider": "claude-cli", "model": "claude-opus-5-5", "effort": "medium" },
  "newDepartment": { "defaultClass": "general", "routes": {},
                     "consult": { "maxPerDay": 12, "stuckAfterFailedRuns": 2, "stuckAfterRevise": 2, "stuckAfterIdleWakes": 2 } },
  "limits": { "briefMaxChars": 8000, "digestMaxChars": 8000, "proposalsKeep": 50 },
  "departments": [
    { "id": "eng", "name": "Engineering", "lead": "<seat id>", "members": ["<seat id>", "..."],
      "defaultClass": "code", "brief": "company/work/departments/eng/BRIEF.md",
      "routes": { "code": { "provider": "...", "model": "...", "effort": "..." } },
      "consult": { "maxPerDay": 12, "stuckAfterFailedRuns": 2, "stuckAfterRevise": 2, "stuckAfterIdleWakes": 2,
                   "stuckOnReopen": true },
      "advisor": { "mode": "live", "since": "2026-11-20T09:00:00.000Z", "by": "owner", "paused": null } }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | lowercase letters, digits and dashes, 2 to 32 characters, starting with a letter; unique |
| `name` | unique, case-insensitive; this is the name `FLOOR_PLAN.md` uses for the department |
| `lead` | a seat id from `company/tools/loops.json`, and one of the members; or `null` |
| `members` | seat ids from `loops.json`. **A seat belongs to at most one department.** The CEO may be in none. |
| `defaultClass` | the task class of a member's item when the item names none: `code`, `review`, `research`, `writing`, `design`, `ops`, `mechanical`, `general` (`lib/taskclass.js` owns this list) |
| `brief` | the path of the department's brief, written by `create` |
| `routes` | per task class, the model a member's item of that class should run on. Only routing code reads it, and that code ships in shadow first. |
| `consult` | when a member's item goes to the lead: at most `maxPerDay` consults a day; an item is stuck after `stuckAfterFailedRuns` failed runs, `stuckAfterRevise` REVISE rounds or `stuckAfterIdleWakes` wakes without progress, or when it is reopened (`stuckOnReopen`, default true); 0 switches a trigger off |
| `advisor` | whether the lead gives advice (§5): `mode` `off` / `shadow` / `live`, `since` (when it went live: the measurement starts there), `by`, `paused` (`null` or `{at, by: owner\|auto, why, evaluationHash}`). Absent = `advisorDefaults` (mode `off`). Written only by `departments.js advisor`. |
| `advisorDefaults` (top level) | what every department's advisor reads unless its own `advisor` says otherwise: `batch { minGapMin, maxWaitMin, startAt }`, `packetMaxChars` (4000), `premerge` (`advisory`), `autoPause { enabled, minItems, minDays, consultRate, cachedShareMin, oneShotGainPoints, reworkCutShare }` |

**Every number is config, not code.** The scoring is done in production, so these numbers will move:
`newDepartment` (what `create` gives a new department), `limits` and each department's `consult` and `routes`.
`lib/departments.js settings()` lays the company file over the framework default one field at a time. A company that
leaves out a key gets the framework value.

**Lead resolution** (`co.leadOf(seat)`):

1. The seat is in no department: `null`.
2. The department has a lead who is on the crew and is not the seat itself: that lead.
3. Otherwise (no lead, the lead has left the crew, or the seat *is* the lead): the seat's `loops.json` `manager`, or
   `null` for the CEO.

A lead is a seat that holds the role, never a name. When the seat is re-hired, the department follows the seat id.

## 2. Changing it: company/tools/departments.js

```
node company/tools/departments.js list [--json]
node company/tools/departments.js show <id> [--json]
node company/tools/departments.js check [--json]                    # exit 1 on a mismatch
node company/tools/departments.js create <id> --name "<Name>" [--class <class>] [--lead <seat>] --by <name> [--why ".."]
node company/tools/departments.js set-lead <id> <seat|none> --by <name> [--why ".."]
node company/tools/departments.js add-member <id> <seat> --by <name> [--why ".."]
node company/tools/departments.js remove-member <id> <seat> --by <name> [--why ".."]
node company/tools/departments.js move <seat> <id|none> --by <name> [--why ".."]
node company/tools/departments.js proposals [--json]
node company/tools/departments.js apply <proposal id> --by <CEO|owner>
node company/tools/departments.js reject <proposal id> --by <CEO|owner> [--why ".."]
# advisor leads (§5): not structure, so not a governance decision
node company/tools/departments.js advisor <id> off|shadow|live --by owner
node company/tools/departments.js advisor <id> pause --by owner --why ".."      # or --by dispatcher --auto (the dispatcher)
node company/tools/departments.js advisor <id> resume --by owner
node company/tools/departments.js brief <id> --file <path> --by <lead>
node company/tools/departments.js digest <id> --file <path> --by <lead>
node company/tools/departments.js note <id> --text ".." --by <lead>
node company/tools/departments.js show <id> --json --brief
# narrow fan-out (§6)
node company/tools/departments.js delegation <id> off|shadow|live --by owner
node company/tools/departments.js delegation <id> workers <seat,seat> --by <CEO|owner>      # governance org for the CEO
node company/tools/departments.js delegation <id> withdraw --by dispatcher --auto --why ".." [--hash h]   # or --by owner
node company/tools/departments.js delegation <id> resume --by owner
# the one writer of routes (the class rules first, for everyone)
node company/tools/departments.js set-route <id> <class> <provider/model[@effort]|none> --by <owner|CEO|routing-proposal> [--proposal <rp-id>]
```

A change to the structure is a **governance decision** in category `org` (`company/state/governance.json`; the
defaults are approve in *Approve everything* and *Gate money and people*, notify in *Gate money* and auto in
*Autonomous*). A company founded before the category existed reads the framework default.

| Who (`--by`) | What happens |
|---|---|
| the owner (`owner` or the owner's name, from the owner's shell or the console: `lib/owner.js`) | applied at once |
| the CEO seat | at `auto` it is applied; at `notify` it is applied and the owner gets one sentence; at `approve` it files one owner question and exits 3, and the same command run again after the owner says yes goes ahead (`lib/governance.js decide`) |
| the people function (when it is not the CEO) | **proposes**: the change goes into `company/state/departments-proposals.json`, and the departments duty hands it to the CEO, who runs `apply <id>` (at the CEO's governance level) or `reject <id>` |
| anyone else | refused (exit 2) |

Inside an agent's run, `--by` must name the seat running the command (`STARNET_AGENT_ID` and the transcript check
`provenance.callerConflict`). A change that would make the file inconsistent is refused for everyone, the owner
included: an unknown seat, a seat already in another department (use `move`), a lead who is not on the crew, a
duplicate id or name, or an unknown task class. Problems the file already had never block a change that fixes them.

Every applied change:
- replaces `company/departments.json` atomically and records its bytes (`provenance.wrote(..., 'departments.js')`).
  `company/tools/locked-watch.js` lists the file as class F, owned by the people function, with `departments.js` as
  its only writer, so any other edit is reported to the people and risk seats;
- adds one line to `company/work/decisions.md` (`decision.js add`), naming the proposal and the owner's approval
  when there was one;
- adds one line at the top of each touched department's `DECISIONS.md`.

`create` also writes the department's folder `company/work/departments/<id>/`. It never overwrites a file that is
already there:

| File | What |
|---|---|
| `BRIEF.md` | a short template (Purpose, Current priorities, Standing rules, Open questions). The lead keeps it at most `limits.briefMaxChars` (8000) characters. The lead's prompt carries a pointer to it, never its text, so the prompt prefix and its cache stay the same between wakes. |
| `DECISIONS.md` | the department's decisions, append-only and newest first. Rolled monthly after 90 days or 32 KB (`retention.json` `department-decisions`). |
| `INBOX-DIGEST.md` | the lead's summary of the members' inboxes, at most `limits.digestMaxChars` |

`departments.js` never rewrites `FLOOR_PLAN.md` or `loops.json`. Those belong to the floor and people owners.

## 3. Keeping three files in step

`company/departments.json` is the source of truth. `FLOOR_PLAN.md` (rooms and who sits where) and `loops.json`
(managers, an optional `department` field per seat) are checked against it. **Mismatches are reported, never fixed
automatically.**

| Code | Meaning |
|---|---|
| `UNKNOWN_SEAT`, `DOUBLE_MEMBER`, `DUPLICATE_MEMBER`, `LEAD_NOT_MEMBER`, `BAD_ID`, `DUPLICATE_ID`, `DUPLICATE_NAME`, `NO_NAME`, `BAD_CLASS`, `BAD_ROUTE`, `BAD_CONSULT`, `BAD_FILE` | the file itself is inconsistent |
| `LOOPS_MISMATCH` | a seat's `loops.json` `department` field names a different department (or one the seat is not in) |
| `PLAN_UNKNOWN_DEPT` | `FLOOR_PLAN.md` (section 1 rooms or the section 2 Department column) names a department that `departments.json` lacks |
| `PLAN_SEAT_MISMATCH` | section 2 puts a crew member in a different department, or in one when `departments.json` has them in none |
| `DEPT_NOT_ON_PLAN` | a department `FLOOR_PLAN.md` never mentions |
| `BRIEF_MISSING`, `BRIEF_TOO_LONG`, `DIGEST_TOO_LONG` | a department's own files |

A crew member in no department is a note, not a mismatch (the CEO is never listed). A section 2 row whose Department
is `—` is skipped.

The check runs in three places:
- `departments.js check` prints it and exits 1 on a mismatch;
- the `departments` duty (`company/tools/duties.js`, every 60 min, docs/DUTIES.md) sends mismatches to the people
  function and open proposals to the CEO. It uses ids only and writes nothing, and it is quiet while the company has
  no departments;
- `station-floor.js audit` check **A12** (warn only, so it never blocks a floor apply) reads `FLOOR_PLAN.md` with its
  own parsers and reports the plan's drift against `departments.json`.

## 4. The owner's view

Crew › People shows a **Departments** section once the company has a department. It lists each department with its
lead and members, the seats in no department, and whether the floor plan agrees. The owner can set or clear a lead and
move a seat to another department (or out of all of them). Each button calls `console/departments.js`, which runs
`departments.js` with `--by <owner>`. The tool accepts the console as the owner, applies its own checks and records
the change. A refused change shows the tool's reason. The crew can also put the same data on a console page through
the `departments` tool source in `company/console/sources.json`.

## 5. What a lead does (advisor leads)

The middle-management plan's P4: a lead **advises**; it rarely does a member's work. One department at a time, starting
in the sandbox's Engineering department. Per department `advisor.mode`:

| Mode | What happens |
|---|---|
| `off` (the default everywhere) | nothing is computed; no consult file, no routine, no log line |
| `shadow` ("Recording only") | consults are accepted and recorded in the ledger; stuck triggers are evaluated and recorded; the advise run that would start is logged (`WOULD ADVISE`). No packet is delivered, no run starts, nobody waits. |
| `live` ("On") | all of it |

A **paused** department (`advisor.paused`) acts as `shadow`. The owner switches the mode (`departments.js advisor <id>
off|shadow|live --by owner`, or the department card). On needs a lead, and the lead is never the CEO; `departments.js
check` reports `ADVISOR_NO_LEAD` and `ADVISOR_CEO_LEAD` for a hand edit. The dispatcher pauses the advice by itself
when the house ranking says it does not pay (below); **only the owner resumes** (`advisor <id> resume --by owner`), and
the measurement starts again from that day.

**Consults.** A member asks with `consult.js ask --item <id> --question ".." [--kind ask|plan|premerge] [--check ".."]
[--pr <url>] --by <seat>` (plan and premerge need the acceptance check). The consult is one block in the lead's inbox,
at most `packetMaxChars` (4000) characters with its heading: `## Consult: <title> (<date>)`, `**Id:** cs-…`, `**Item:**`,
`**From:**`, `**Kind:**`, `**Trigger:**`, `**Class:**`, `**PR:**` (premerge), `**Status:** OPEN`, then Question, What was
tried, Acceptance check. A longer one is refused; a second open consult on the same item and kind is dropped as a
duplicate; past `consult.maxPerDay` in a company day it is dropped and the member's manager gets one FYI line. Nothing is
lost silently: every open, drop, advise run and verdict is a row in `company/state/consults.jsonl` (written only by
`lib/consult.js`, locked-watched). While a consult is open the dispatcher does not wake the member for that item (it
waits for the lead, as with `Waiting on`); its other items are work as usual.

**Stuck triggers.** Each tick the dispatcher (`lib/consult.js consultStep`) opens a consult on a member's behalf
(`**From:** dispatcher on behalf of <seat>`, its last runs under What was tried, clipped to fit) when an item crosses
`stuckAfterFailedRuns` failed runs (provider errors and dispatch time-limit cuts are not failures: the ranking's
`exclude.runKinds`), `stuckAfterRevise` REVISE rounds, `stuckAfterIdleWakes` runs that finished and changed nothing, or
is reopened. One trigger opens exactly one consult: a counter stays quiet until progress (the block's text changed,
verdict lines aside) or the lead's answer resets it. The counters are in `company/state/consult-state.json`.

**The advise run.** One station routine per live lead, `<Lead name> advise`, created and removed by the dispatcher and
never scheduled by the station. Its prompt is `company/defaults/work/departments/advise-prompt.md` (a company copy at
`company/work/departments/advise-prompt.md` wins): it points at BRIEF.md, DECISIONS.md and INBOX-DIGEST.md and never
copies their text, so the prompt is byte-identical between runs up to its last line, `Open consults for you: cs-…, cs-…
(in your inbox).` (the cache). The dispatcher starts it when `batch.startAt` (3) consults are open, or the oldest has
waited `batch.maxWaitMin` (10) minutes, and the last advise run was at least `batch.minGapMin` (5) minutes ago; never
while the lead's own loop runs, and the lead's loop is not woken while an advise run is in flight. It goes through
`admit()` (door `consult`, docs/BUDGET.md) on the department's `leadModelDefault` as a one-run override (patch 0017;
`lib/override-allow.js` opens that pair for a live lead), and its `wakes.jsonl` row (door `consult`) lists the consulted
items, so the ranking books its cost to them. It passes the same checks as any wake, for the model it will really use:
the lead's approval mode ("ask" cannot save unattended), the money check (the daily metered cap, the per-agent share,
the Sprint budget and spread, with the dispatcher's numbers) and the pacer (the pair open in this tick's override list).
When the lead model is shut, or the station answers 403, it runs on the routine's own model only when that passes the
same checks; otherwise it waits for a later tick (`ADVISE HOLD`).

**Verdicts.** The lead answers each consult with `consult.js answer <cs-id> --verdict APPROVE|REVISE|ESCALATE-TIER|
TAKE-OVER|ESCALATE --check ".." [--finding ".."]... [--tier p/m@e] --by <lead>`. Only the department's lead may answer
(anyone else: exit 2). The line `**Verdict:** REVISE by <lead> — check: <check> — 1. <finding> …` goes into the consult
(which becomes DONE) and into the member's item block, where model-rank.js reads it like any verdict: once, at half
weight (`weights.leadOnOwnReport`), and the advise run is not counted as authorship. ESCALATE-TIER records a proposal;
the lead never changes a model chain or a route.

**The lead's files.** `departments.js brief <id> --file f --by <lead>` replaces BRIEF.md (inside `limits.briefMaxChars`);
`digest <id> --file f` replaces INBOX-DIGEST.md (`digestMaxChars`); `note <id> --text ".."` puts one line at the top of
DECISIONS.md. The owner reads the brief on the department card, so it is written in plain words.

**Before a merge.** When a PR's author is in a live advisor department, `premerge-check.js` opens a premerge consult once
per PR head and shows the lead's latest verdict as one row, "Lead's advice (advisory)", and writes it as `lead` in the
evidence record. **The row never changes pass, fail or the exit code**; it stays advisory until the lead's calibration
data shows its approvals predict fewer defects (a later decision).

**Does it pay?** `model-rank.js` `advisorEvaluation` (docs/RANKING.md §10) compares the department's items since
`advisor.since` with as many days before it: the consult rate (10-40%), the advise runs' cached share (at least 85%),
cost per accepted item (no higher) with one-shot up at least 10 points or rework down at least 20%. Under 20 items a side
or 14 days it says `not enough data`. With `advisor.autoPause.enabled`, a `pause` verdict makes the dispatcher pause the
advice once per evaluation (`--by dispatcher --auto`), record why, and tell the owner in one plain line of the day's
message. The `consults` duty (`consult.js --duty`) is due when a live department's consult has waited three times the
batch wait (an advise run that never came).

**Rollout.** Every other company: no `advisor` key, so `off`. The sandbox: the owner (or the CEO, with `set-lead`)
names the lead first; the recommendation is the tools seat, on `leadModelDefault`. Then the owner turns it on from the
Engineering card, with `autoPause.enabled` on.

**The console.** Each department card with a lead shows the lead's line, the switch "Lead gives advice: Off · Recording
only · On" (On asks first), Pause or Resume, "Asked the lead today: n of 12 allowed.", the last advice, and the brief,
folded, under "What the team is working on" (`GET /api/departments/<id>/lead-desk`, `POST /api/departments/<id>/advisor`,
docs/CONSOLE-API.md).

Not part of this: the premerge verdict as a gate; a lead for more than one department or for the CEO's seat; a lead
changing routes or chains (it writes a proposal line in DECISIONS.md); live calls between runs (consults are file
handoffs); replaying earlier conversation into the lead; any change to how a member's own loop is scheduled.

## 6. Splitting big jobs (narrow fan-out)

The middle-management plan's P5. A lead may hand the pieces of ONE item to people on its own team, and only when the item
really splits: 3 or more pieces (`delegation.minPieces`), each touching its own files and each with a written acceptance
check. Everything else stays one seat's work.

**The data.** Per department, `delegation` (absent = `delegationDefaults`, mode `off`):

```json
"delegation": { "mode": "off|shadow|live", "workers": ["<seat>"], "maxWorkers": 3, "workerTimeoutMin": 20, "minPieces": 3,
                "prefer": "lanes", "since": null, "by": null, "withdrawn": null }
```

`workers` is the allowlist; a seat outside the lead's reports in `loops.json` (its manager chain) is refused by
`delegation <id> workers` and reported by `check` (`DELEGATE_OUTSIDE_SUBTREE`). Splitting on with no lead or the CEO as
lead is `DELEGATE_NO_LEAD`; a malformed key is `BAD_DELEGATION`. `withdrawn` is `null` or `{at, by: auto|owner, why,
evaluationHash}`; while set, the department acts as recording only.

**Splitting.** The lead writes the pieces in two ways, and both are recorded as a `split` row in the consult ledger
(`company/state/consults.jsonl`):

- answering a member's consult with `consult.js answer <cs-id> --verdict SPLIT --check ".." --piece "<title> — files: a, b —
  check: <check>" ... [--fanout lanes|dispatch] --by <lead>`;
- on an item in its own inbox: `consult.js split <item id> --piece ".." ... [--fanout lanes|dispatch] --by <lead>`.

`lib/consult.js splitOk` checks the pieces (pure): at least `minPieces`, each with `files:` and `check:`, no file (or
folder above it) in two pieces. While splitting is live the item's block gets

```markdown
**Pieces:**
1. <title> — files: api/a.ts, api/b.ts — check: <acceptance check>
**Fan-out:** lanes | dispatch
```

While it is recording only (`shadow`, or withdrawn), the split is recorded (`WOULD DELEGATE` in the dispatch log), the
item is not touched and stays with its holder. Splitting off refuses SPLIT. SPLIT neither passes nor fails in the house
ranking. Only a recorded split is delegated: a Pieces list someone wrote by hand, or one edited after the split, is not
(`splitCandidates` compares the recorded hash).

**Fan-out: lanes (preferred).** `lanes.js` offers each piece to a free worker on the lead's allowlist as its own lane
(one piece per lane, at most `maxWorkers` at once): the worker's own agent and model, only the piece's files, its own
time limit (`workerTimeoutMin`), the same money, tempo, class-rule and pacer checks as any lane, Sprint on or not. The
item gets `**Piece n lane:**` while it runs and `**Piece n result (...):**` after; a piece never closes the item.

**Fan-out: dispatch.** For a lead whose split says `dispatch`, `lib/delegate-allow.js` lists that lead, that item and its
free workers in `company/state/delegate-allow.json` every tick, and StarNet patch 0018 gives the lead's routine run
`team.dispatch` only then: listed workers only, at most `maxWorkers`, each worker on its own clock, the item id on each
child run. A lead is listed only when the money check and the pacer are open for every listed worker's provider, and a
code item never lists a worker on the MiniMax plan.

**Withdrawn when it does not pay.** `model-rank.js fanoutEvaluation` compares the department's delegated items with its
single-seat items of the same class, by the cost per accepted item (a child run's cost is its lead's family's). Over at
least 10 delegated items, a cost that is not lower is `withdraw`: the dispatcher runs `delegation <id> withdraw --auto`
once per evaluation hash and tells the owner in one line ("The crew stopped splitting Engineering's bigger jobs between
several people: doing them in one go was cheaper."). Only the owner resumes.

**Defaults.** Every company: absent (`off`). The sandbox: `eng` in recording only, workers set by the CEO, for one week;
then the owner may switch it on from the department card ("Splitting big jobs: Off · Recording only · On").

Not part of this: more than one item at a time per lead, nested delegation (workers delegating), delegation across
departments, a lead changing its own department's routes.

**What the station enforces under the list (StarNet patch 0018).** A listed worker runs only on a model the list names
for it, each allowed for the item's class: the lead's one-run model must be one of them, a worker dispatched with no
model runs on the list's first (its own pair when that is allowed), and a worker the list names no model for does not
run. So code never reaches the MiniMax plan through a worker's own model or the station default. The item is code work
when the split says so or any piece lists a code file (`.js`, `.ts`, `.py`, …), whatever its words. The whole lead run
starts at most the split's piece count of workers over all its `team.dispatch` calls, and once a split's workers have
started (a live child run, or a run row with the item's id) the split is used and not listed again; a new split is. A
halted company empties the list at once, and a worker on a live child run counts as busy.

**What the list does not bind (a known gap).** The list names the lead, the item, the workers and the models, but not
the words of the lead's prompt to each worker: a listed lead could hand a worker a prompt about something other than
the listed item, within the same team, models, limits and time. The worker's run row carries the item's id, the lead's
run is in the transcript, and the house ranking's fan-out evaluation counts only accepted items, so such a run shows up
as cost without an accepted result; nothing stops it at the station. Keep splitting on recording only (shadow) wherever
this matters.

## 7. What is not here yet

- Hiring into a department. `hire.js` seats a new hire in no department, and the people function or the owner adds
  them with `add-member`.
- Editing `consult`, `advisorDefaults`, `delegationDefaults` or `limits` with a command or from the console. For now they are config in the file
  (`routes` have one writer, `departments.js set-route`, §6 and docs/ROUTING.md §7).
  A hand edit is reported by locked-watch, and the owner takes it as the new version under Settings › System › change
  flags (`locked-watch.js accept company/departments.json --by owner --why "..."`).
