# Departments

A department is a group of seats with one lead. The lead is who the members go to when an item is stuck, who reviews
their plans, and who keeps the department's brief. This page covers the data, the tool, the checks and the console view.
What a lead actually does (consults, brief updates, routing by task class) is a later step. It will read what is
described here and ship in shadow first.

Code: `company/departments.json` (the data), `company/tools/lib/departments.js` (reading and checks),
`company/tools/lib/company.js` (`co.deptOf`, `co.leadOf`, `co.departmentsOf`), `company/tools/departments.js` (the only
writer), `console/departments.js` and `console/ui/js/screens/crew-departments.js` (the owner's view). Tests:
`node company/tools/departments.js --selftest` and `node --test company/tools/tests/departments.test.js`.

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
      "consult": { "maxPerDay": 12, "stuckAfterFailedRuns": 2, "stuckAfterRevise": 2, "stuckAfterIdleWakes": 2 } }
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
| `consult` | when a member's item goes to the lead: at most `maxPerDay` consults a day; an item is stuck after `stuckAfterFailedRuns` failed runs, `stuckAfterRevise` REVISE rounds or `stuckAfterIdleWakes` wakes without progress |

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

## 5. What is not here yet

- What a lead does: consult packets, the advise routine, stuck triggers, brief updates and routing by `routes`. That
  comes in a later step. Anything that changes routing records what it would do (shadow) behind an owner switch first.
- Hiring into a department. `hire.js` seats a new hire in no department, and the people function or the owner adds
  them with `add-member`.
- Editing `routes`, `consult` or `limits` with a command or from the console. For now they are config in the file.
  A hand edit is reported by locked-watch, and the owner takes it as the new version under Settings › System › change
  flags (`locked-watch.js accept company/departments.json --by owner --why "..."`).
