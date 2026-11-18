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
      applied, mode, capMode, wouldApply?: { source, provider, model, effort?, trial?, arm? }, chain?, chainDenied?,
      hold?, holdWhy?, reasons: [...] }

`provider/model/effort` is what the run was started on. Sprint lanes (`lanes.js`) are routed and recorded the same way
(door `lane`, one item per lane). The dispatch log says `ROUTE <seat>: …` only when the decision differs from the chain.

Locked (`company/tools/locked-watch.js`): `company/work/models/routing-policy.json` is class F, owned by the people
function and changed only through `company/tools/routing.js` (a hand edit is flagged to the people seat with the revert);
`company/tools/lib/routing.js` is a protected tool; the history file is class A, appended only by `lib/routing.js` (each
row recorded with `provenance.js`; a line anyone else appends is stripped).

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

<!-- SCRATCH MERGE: the controls branch ROUTING.md follows; needs a hand merge -->

# Routing: which model runs one wake, and the owner's switches for it

A seat normally runs on its own model chain (`company/model-policy.json` seats, `company/tools/models.js`). Routing
lets the company choose a different model for one piece of work. It can use a department's preferred model for that
task class, a cheaper tier for routine work, or one arm of a trial that compares models on real work. Every rule is
**config**, and anything that changes which model runs ships in **shadow**: the choice is recorded, not applied, until
the owner switches it live in the console.

Code: `company/tools/lib/routing.js` (the router: `decide()`, called by `dispatch.js` for each wake),
`company/tools/routing.js` (the owner's switches and the trials; the only writer of the policy),
`console/routing.js` and `console/ui/js/screens/settings/routing.js` (Settings › Models › Routing). Tests:
`node company/tools/routing.js --selftest`, `node --test company/tools/tests/routing.test.js`.
Related: docs/RANKING.md (the house ranking that proposes routes), docs/DEPARTMENTS.md (routes per class).

## 1. The policy: company/work/models/routing-policy.json

The framework default is `company/defaults/work/models/routing-policy.json`. **A missing company file reads the
default**, exactly as `model-rank.js` reads `ranking-policy.json`. The first change made through `routing.js` creates
the company copy from the default, with that change applied.

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` \| `shadow` \| `live`, for class routes and trials. `off`: no route is computed. `shadow`: the decision is recorded on the wake's `wakes.jsonl` row as `route` (`applied: false`, `wouldApply`), and the seat runs on its chain. `live`: the decision is passed as the one-run override on `POST /api/cron/run` (StarNet patch 0017), but **only** when the chosen pair is in the seat's `company/state/override-allow.json` list. Otherwise the seat runs on its chain exactly as before. |
| `classRules` | `{ code: { denyProviders: ["custom"] } }` | Owner rulings per task class. They apply in every mode, to every step and to the chain fallbacks the router picks. Code is never written by the MiniMax plan (provider `custom`). `denyModels` is accepted too. |
| `order` | `classRules, trial, route, tierCap, chain` | The order of the router's steps. |
| `tierCaps.mode` | `shadow` | `off` \| `shadow` \| `live`, for executor tier caps. This switch is separate from `mode`. |
| `tierCaps.allow` | Haiku, Sonnet 5.5, DeepSeek | The entries a capped seat may run on. An entry without `model` allows every model of that provider. |
| `tierCaps.heavyEscape` | `heavy` | An item marked `**Effort:** heavy` is not capped. |
| `tierCaps.exemptFunctions` / `exemptLeads` | `["ceo"]` / `true` | Seats the cap never applies to. |
| `trialLimits` | `minArms 2, maxArms 4, maxEntryShare 0.5, defaultEntryShare 0.1, defaultMinItemsPerArm 30, defaultPauseWhenHeld ["claude-cli"]` | What `trial create` accepts, and its defaults. |
| `trials` | `[]` | The framework defines no trial. A trial runs only where a company's own policy defines one and the owner has started it. |
| `history` | `company/work/models/routing-log.jsonl` | The routing log (§4). It must be a `.jsonl` file under `company/work/`; anything else falls back to the default. |

The file is **locked** (class F, owned by the people function, writer `routing.js`, `company/tools/locked-watch.js`).
A hand edit is flagged; change it only through `routing.js`. To tune a rule that has no command (classRules,
tierCaps.allow, trialLimits), make a reviewed harness change (`harness-change.js`).

## 2. Who may change what

| Change | Who | How |
|---|---|---|
| `mode` off / shadow / live | the owner only | `routing.js mode <m> --by owner`, or Settings › Models › Routing |
| `tierCaps.mode` | the owner only | `routing.js tiercaps <m> --by owner`, or the console |
| draft a trial | the people function (the model manager) or the owner | `routing.js trial create …` |
| start, pause, resume or stop a trial | the owner only | `routing.js trial <op> <id> --by owner`, or the console |
| read everything | anyone; agents through the `routing` page source (`company/console/sources.json`, read only) | `routing.js status [--json]`, `trial show <id>` |

"Owner only" goes through `company/tools/lib/owner.js`: `--by owner` (or the owner's name) is accepted only from the
owner's own interactive shell or from the console. A seat that names itself is refused with "the owner's decision".
Inside an agent's run, `--by` must name that run's own seat.

Every change replaces the policy atomically and records its bytes (`provenance.js wrote`). It also adds one line to
`company/work/decisions.md` (`decision.js add`, "Model routing: …") and one row to the routing log.

## 3. Trials

```bash
node company/tools/routing.js trial create code-cmp --class code \
  --arm claude-cli/claude-sonnet-5-5@high --arm claude-cli/claude-opus-5-5@medium \
  --scope-dept eng [--scope-seat <seat>] [--entry-share 0.1] [--min-items 30] [--pause-when-held claude-cli] --by <people seat> --why "…"
node company/tools/routing.js trial start code-cmp --by owner
```

`create` refuses all of the following:
- an id that is badly formed or was already used (ids are never reused, finished trials included);
- an unknown class (lib/taskclass.js);
- no arms, or a number of arms outside `trialLimits`;
- an arm that is not `provider/model[@effort]`;
- a provider or model missing from `company/model-policy.json` `allowed`;
- an unknown effort, or the same arm listed twice;
- an arm a class rule denies (a **code trial with a `custom` arm**);
- no scope, an unknown department or seat;
- an entry share outside (0, `maxEntryShare`];
- a `pauseWhenHeld` provider that is not allowed;
- a `--pause-when-held` that leaves out an arm's provider which the pacer meters as a subscription (`claude-cli`,
  `custom`: lib/pacing-ask.js `SUBS`, the same table pacer.js uses). Without `--pause-when-held`, those providers are
  added to `trialLimits.defaultPauseWhenHeld` on their own. `status --json` gives each trial a `heldGuard`
  `{providers, subscriptions, missing}`, and the console's trial card and Start dialog say which plans pause the trial
  (and warn about a `missing` one in an older trial).

All the problems are reported in one refusal, and nothing is written.

Every change is one read-modify-write under an exclusive lock, `routing-policy.json.lock` (lib/file-lock.js: created
with O_EXCL, broken after 30 s as stale). The routing-log row and the decisions.md line are written only after the
policy write succeeded, still under the lock. A writer that cannot get the lock within a few seconds is refused (exit 2)
and records nothing.

Statuses: `draft` →(start) `running` ⇄(pause / resume) `paused`, and stop (from any of them) → `done`. A trial cannot
start or resume while another running or paused trial tests the same class in an overlapping scope, so a wake is never
in two trials. Repeating the current state changes nothing.

How the router uses a running trial (lib/routing.js; recorded here so both sides agree):
- `hash(trial id + wakeId)` decides whether a wake in scope enters (`entryShare`), and which arm it gets (an even split).
  It is deterministic.
- In `shadow` the arm is only recorded (`route.wouldApply.source = "trial"`). In `live` it is applied, and only when
  the seat's override list opens it.
- While a provider in `pauseWhenHeld` is held by the pacer, the trial **pauses itself** and records why. It never
  switches arms silently. The router records a hold as a routing-log row `{op: "trial-held", trial, why, by:
  "dispatcher"}` and its end as `{op: "trial-unheld", trial}`. It may also name the hold on the wake's route as
  `trialPaused: [{trial, why}]`.

## 4. Status and counts

`routing.js status [--json]` prints:
- the two modes, and whether the policy is the company's copy or the default;
- every trial with its arms;
- why a trial is paused: the owner's pause with who, when and why, or the router's hold;
- the last 20 routing-log rows, newest first.

Arm counts come from `company/state/wakes.jsonl` rows written since the trial started, through the `route` field:

- a route with `source: "trial"` and `applied: true` counts as **applied**;
- a route whose `wouldApply.source` is `"trial"` counts as **shadow**;
- the trial is named by `route.trial`, `route.trialId`, or `arm` given as `{trial, index}` or `"<trial>:<index>"`;
- the arm is `route.arm` (an index); without an index, it is the arm whose provider and model match.

Each arm shows its wakes and its distinct items (the `items[].id` of those wakes), applied and shadow separately.
`progress.enough` is true once every arm has `minItemsPerArm` items. `wakes.jsonl` keeps 30 days (docs/RETENTION.md),
so a trial older than that counts only its last 30 days. `countedSince` says where the count starts.

Routing log rows: `{at, ts, op: mode|tiercaps|trial-create|trial-start|trial-pause|trial-resume|trial-stop|trial-held|trial-unheld, by, trial?, from?, to?, why?, digest}`.
`digest` is the first 12 hex characters of the sha256 of the policy as written. The log rolls monthly and keeps 180
days (retention id `routing-log`).

## 5. The console

Settings › Models › **Routing and trials** (`#/settings/models/routing`) shows:
- the two modes as Off / Recording only / Live buttons; switching to Live asks the owner to confirm;
- each trial as a card with its arms, items so far against the target, its status and why it is paused, and the
  owner's buttons (Start for a draft, Pause or Stop while running, Resume or Stop while paused);
- finished trials and the recent routing changes, folded away.

The console offers no "create": drafting a trial is the people function's work. API (docs/CONSOLE-API.md):
`GET /api/routing`, `POST /api/routing/mode`, `POST /api/routing/tiercaps`, and
`POST /api/routing/trials/<id>/<start|pause|resume|stop>`. Each runs `routing.js` with `--by <owner>`, and a refusal
comes back as 400.
