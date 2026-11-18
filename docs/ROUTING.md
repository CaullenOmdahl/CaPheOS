# The router: which model one wake runs on

A seat runs on its own model chain (`company/model-policy.json` seats.<id>.chain, `company/tools/models.js`). The
router decides, for **one wake**, whether it should run on something else for that run only: a trial arm, its
department's route for the kind of work, or a cheaper entry of its own chain under the executor tier cap. Scoring
happens in production and will change both the framework and the method, so **every rule, threshold and switch is in
the policy file**, and anything that changes which model runs starts in **shadow**: decided and recorded, never applied,
until the owner switches it live.

Code: `company/tools/lib/routing.js` (used by `dispatch.js`, `lanes.js` and `lib/override-allow.js`). Policy:
`company/work/models/routing-policy.json`, copied at founding from `company/defaults/work/models/routing-policy.json`; a
missing company file reads the default; with neither there is no routing and every wake behaves exactly as before (the
POST /api/cron/run body is `{id, detach}`, no `route` on the wake row, no log row). Tests:
`node --test company/tools/tests/routing.test.js company/tools/tests/routing-dispatch.test.js`, plus the routed-lane case
in `lanes-dispatch.test.js` and the allowlist cases in `override-allow.test.js`. Owner: the `people` function (the model
manager); the mode switches are the owner's.

## 1. The steps

`order` (default `classRules, trial, route, tierCap, chain`), first choice wins:

| Step | What it chooses | Its switch |
|---|---|---|
| classRules | nothing: a filter on every step. A pair a rule denies for a class in the wake is never chosen (default: `code` denies provider `custom`, the owner's ruling that code is never written on the MiniMax plan) | always on |
| trial | the arm a running trial assigns this wake (section 3) | `mode` |
| route | the seat's department route for the wake's class (`company/departments.json` routes.<class>, docs/DEPARTMENTS.md) | `mode` |
| tierCap | the seat's first chain entry on the cap's allow list (section 4) | `tierCaps.mode` |
| chain | the seat's own pair; changed only when the class rules deny it (then its first allowed chain entry) | `classRulesApply` (`always`: in every mode) |

One walk over the steps, in `order`: **wouldApply** is the first choice of a step whose mode is `shadow` or `live`;
**applied** is the first choice of a `live` step that the station's override allowlist
(`company/state/override-allow.json`, written each tick by `lib/override-allow.js`, current for 30 minutes) opens for the
seat now (provider, model). A `live` choice that is not open is recorded (`not open: … is not in the override allowlist`,
`not open: no current override allowlist`) and the walk goes on to the next step. Nothing applied: the wake runs on its
chain and the decision says why (`shadow`, `not open …`). If the station's gate still refuses (HTTP 403), the dispatcher
runs the wake again without the override and records that.

The class rules always hold, whatever the modes and `classRulesApply`: when nothing earlier applied and the seat's own
pair is denied for the wake's class (code on `custom`), the router applies the first chain entry the rules allow and the
allowlist opens. When none is open the decision has `hold: true` (`holdWhy`: `… no allowed entry open …`): the
dispatcher logs `ROUTE HOLD`, records the decision (status `held`) and does not start the wake this tick (a Sprint lane is
not started either); it is tried again next tick. A 403 on such a wake's override is a hold too, never a run on the
denied pair (`chainDenied` on the decision names the rule).

The wake's class: each item's `lib/taskclass.js classOf` (a `**Class:**` line, `**Effort:** mechanical`, the department
`defaultClass`, else `general`); the wake's class is the majority (a tie: the first item's). A wake with no item (a
scheduled loop, an owner message) has its department's default class. Class rules check every class in the wake.

## 2. The record

Every decision is written on the wake's `company/state/wakes.jsonl` row as `route` and as one row of the history file
(`history`, default `company/work/models/routing-log.jsonl`, rolled monthly, 90 days):

    { v, class, classes, source: trial|route|tierCap|chain, trial?, arm?, department?, provider, model, effort?,
      applied, mode, capMode, wouldApply?: { source, provider, model, effort?, trial?, arm? }, chain?, reasons: [...] }

`provider/model/effort` is what the run was started on. Sprint lanes (`lanes.js`) are routed and recorded the same way
(door `lane`, one item per lane). The dispatch log says `ROUTE <seat>: …` only when the decision differs from the chain.

## 3. Trials

The framework defines none: a trial runs only where a company's own policy lists one in `trials`:

    { "id": "bigger-lower-effort", "class": "code",
      "arms": [ {"provider":"claude-cli","model":"claude-sonnet-5-5","effort":"high"},
                {"provider":"claude-cli","model":"claude-opus-5-5","effort":"medium"} ],
      "scope": { "departments": ["eng"], "seats": [] }, "entryShare": 0.1, "status": "running",
      "pauseWhenHeld": ["claude-cli"], "minItemsPerArm": 30, "startedAt": "2026-11-20", "startedBy": "owner" }

- **Deterministic**: sha256(trial id + "\n" + wakeId): the first 8 hex digits against `entryShare` decide entry, the
  next 8 pick the arm by even split. The same wake always gets the same answer.
- **In scope**: the seat is listed in `scope.seats` or its department in `scope.departments` (both empty: nobody). Only
  `status: running` assigns.
- **Paused, never switched**: while the pacer holds any provider in `pauseWhenHeld`, the trial assigns nothing; the pause
  and the resume are one row each in the routing log (`company/state/routing-state.json` keeps the state) and the dispatch
  log. An assigned arm that is not open runs the chain and records why; the wake is never moved to another arm.
- A trial with an arm the class rules deny is skipped whole (and its arms are never listed in the allowlist).
- `minItemsPerArm` is the sample the trial is read at (model-rank.js); nothing here acts on it.

## 4. Executor tier caps

For a seat that holds none of `tierCaps.exemptFunctions` (default `ceo`) and, with `exemptLeads`, leads no department, a
wake with no item marked `**Effort:** heavy` (`heavyEscape`) may only run on an `allow` entry (`{provider}` alone matches
every model of that provider; model aliases are listed one by one). When the seat's current pair is not one, the cap
picks the seat's first chain entry that is; with none it records `no capped entry` and leaves the chain.
`itemlessWakes` says whether a wake with no item is capped too.

## 5. The allowlist

`lib/override-allow.js` lists, per seat, its chain entries, its department's routes, and with a routing policy the arms
of every running trial it is in scope of (mode not off) and its capped chain entries while `tierCaps.mode` is live. A route
or arm the class rules deny for its own class is never listed. Every entry still has to pass models.js `evaluate()`
(pacer gates, the owner's subscription stops, quota, refusal blocks) to be listed, so a live decision can never run a
model the failover tick would not.

## 6. Switching it on

The owner flips `mode` (routes and trials) and `tierCaps.mode` from `shadow` to `live` in the company's copy; read the
routing log first: `wouldApply` rows show what live would have done. `node company/tools/lib/routing.js show` prints the
policy in force.
