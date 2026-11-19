# Routing: which model one wake runs on, and the owner's switches for it

A seat runs on its own model chain (`company/model-policy.json` seats.<id>.chain, `company/tools/models.js`). Routing
decides, for **one wake**, whether it should run on something else for that run only: an arm of a trial that compares
models on real work, its department's route for the kind of work, or a cheaper entry of its own chain under the
executor tier cap. Scoring happens in production and will change both the framework and the method, so **every rule,
threshold and switch is in the policy file**, and anything that changes which model runs starts in **shadow**: decided
and recorded, never applied, until the owner switches it live in the console.

| Part | What it does |
|---|---|
| `company/tools/lib/routing.js` | the router: `decide()` for each wake, called by `dispatch.js`, `lanes.js` (Sprint lanes) and `lib/override-allow.js`. It only reads the policy. |
| `company/tools/routing.js` | the owner's switches and the trials; the only writer of the policy. |
| `console/routing.js`, `console/ui/js/screens/settings/routing.js` | Settings › Models › Routing (the same commands, as the owner). |
| `company/work/models/routing-policy.json` | the policy (§2). |
| `company/work/models/routing-log.jsonl` | changes and events (§6). |
| `company/work/models/routing-decisions.jsonl` | one decision row per routed wake (§6). |

Tests: `node company/tools/routing.js --selftest`; `node --test company/tools/tests/routing.test.js` (the router),
`routing-controls.test.js` (the switches, the trials and the console route), `routing-dispatch.test.js` (the router
through the real dispatcher), `routing-e2e.test.js` (the switches, the router, locked-watch and model-rank together), plus
the routed-lane case in `lanes-dispatch.test.js` and the allowlist cases in `override-allow.test.js`. Owner: the `people`
function (the model manager); the mode switches and trial starts are the owner's. Related: docs/RANKING.md (the house
ranking that proposes routes and reads trials), docs/DEPARTMENTS.md (routes per class).

## 1. For the owner: what to switch and when

Settings › Models › **Routing and trials** (`#/settings/models/routing`) shows:

- the two modes, **Department routes and trials** (`mode`) and **Cheaper models for routine work** (`tierCaps.mode`),
  each as Off / Recording only / Live buttons; switching to Live asks you to confirm;
- each trial as a card with its arms, items so far against the target, its status and why it is paused or held, and
  your buttons (Start for a draft, Pause or Stop while running, Resume or Stop while paused);
- finished trials and the recent routing changes (yours, and the usage pacer's trial pauses), folded away.

Both modes ship as **Recording only** (`shadow`): every wake records what routing would have done (`wouldApply`) and
runs on its chain. Before you switch one to **Live**, read what it would have done (`routing.js status`, or the wakes'
`route.wouldApply` in `company/work/models/routing-decisions.jsonl`). Live changes a run's model only where the seat's
override allowlist opens the chosen model (§5); everything else still runs on its chain.

The console offers no "create": drafting a trial is the people function's work (§4). API (docs/CONSOLE-API.md):
`GET /api/routing`, `POST /api/routing/mode`, `POST /api/routing/tiercaps`, and
`POST /api/routing/trials/<id>/<start|pause|resume|stop>`. Each runs `routing.js` with `--by <owner>`; a refusal comes
back as 400. All of /api sits behind the console's owner sign-in and CSRF check.

### Who may change what

| Change | Who | How |
|---|---|---|
| `mode` off / shadow / live | the owner only | `routing.js mode <m> --by owner`, or the console |
| `tierCaps.mode` | the owner only | `routing.js tiercaps <m> --by owner`, or the console |
| draft a trial | the people function or the owner | `routing.js trial create …` |
| start, pause, resume or stop a trial | the owner only | `routing.js trial <op> <id> --by owner`, or the console |
| class rules, tier-cap allow list, trial limits, the order | a reviewed harness change | `harness-change.js` (there is no command) |
| read everything | anyone; agents through the `routing` page source (`company/console/sources.json`, read only) | `routing.js status [--json]`, `trial show <id> [--json]`, `node company/tools/lib/routing.js show` |

"Owner only" goes through `company/tools/lib/owner.js`: `--by owner` (or the owner's name) is accepted only from the
owner's own interactive shell or from the console. A seat that names itself is refused with "the owner's decision".
Inside an agent's run, `--by` must name that run's own seat.

Every change is one read-modify-write under an exclusive lock, `routing-policy.json.lock` (lib/file-lock.js: created
with O_EXCL, broken after 30 s as stale). The policy is replaced atomically and its bytes recorded (`provenance.js
wrote`); then, still under the lock, one row is appended to the routing log (recorded with `provenance.js appended`) and
one line added to `company/work/decisions.md` (`decision.js add`, "Model routing: …"). A writer that cannot get the lock
within a few seconds is refused (exit 2) and records nothing. Repeating the current state changes nothing.

## 2. The policy: company/work/models/routing-policy.json

The framework default is `company/defaults/work/models/routing-policy.json`, and it documents every key in place (one
`_<key>` note each). **A missing company file reads the default**, exactly as `model-rank.js` reads
`ranking-policy.json`; the first change made through `routing.js` creates the company copy from the default with that
change applied. With neither file there is no routing: every wake behaves exactly as before (the POST /api/cron/run body
is `{id, detach}`, no `route` on the wake row, no log row). A key left out reads as off / empty, never as a hidden
default; the two log paths are the exception and fall back to the files named below.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off` \| `shadow` \| `live`, for department routes and trials. `off`: not computed. `shadow`: decided and recorded (`applied: false`, `wouldApply`), the seat runs on its chain. `live`: passed as the one-run override on POST /api/cron/run (StarNet patch 0017), only when the override allowlist opens the pair. |
| `classRules` | `{ code: { denyProviders: ["custom"] } }` | Owner rulings per task class (`denyProviders`, `denyModels`), in every mode, on every step (§3). Code is never written by the MiniMax plan (provider `custom`). |
| `classRulesApply` | `always` | Whether the class rules' chain fix is a step of the walk: `always` (live in every mode), `mode` (follows `mode`), `off` (not a step). Whatever the value, the class rules always hold after the walk (§3). |
| `order` | `classRules, trial, route, tierCap, chain` | The order of the router's steps (§3). |
| `tierCaps` | mode `shadow`; allow Haiku (both ids), Sonnet 5.5 (both ids), DeepSeek; `heavyEscape: heavy`; `exemptFunctions: ["ceo"]`; `exemptLeads: true`; `itemlessWakes: true` | The executor tier caps (§5), with their own mode switch. |
| `trialLimits` | `minArms 2, maxArms 4, maxEntryShare 0.5, defaultEntryShare 0.1, defaultMinItemsPerArm 30, defaultPauseWhenHeld ["claude-cli"]` | What `trial create` accepts, and its defaults (§4). |
| `trials` | `[]` | The framework defines no trial (§4). |
| `allowMaxAgeMin` | `30` | An override allowlist older than this counts as none (the station refuses it from 30 minutes). |
| `history` | `company/work/models/routing-log.jsonl` | The routing log: changes and events (§6). A `.jsonl` under `company/work/`; anything else reads the default. |
| `decisions` | `company/work/models/routing-decisions.jsonl` | The per-wake decisions (§6). Same rule for the path. |

The file is **locked** (`company/tools/locked-watch.js`: class F, owned by the people function, writer `routing.js`). A
hand edit is flagged to the people seat with the revert (`locked-watch.js revert company/work/models/routing-policy.json
--by <name>`); change it only through `routing.js`, or through a reviewed harness change for the keys that have no
command. A company copy that does not parse is an error: `status` says so and nothing is changed on top of it.

## 3. The decision walk

`order`, first choice wins:

| Step | What it chooses | Its switch |
|---|---|---|
| classRules | nothing: a filter on every step. A pair a rule denies for a class in the wake is never chosen | always on |
| trial | the arm a running trial assigns this wake (§4) | `mode` |
| route | the seat's department route for the wake's class (`company/departments.json` routes.<class>, docs/DEPARTMENTS.md) | `mode` |
| tierCap | the seat's first chain entry on the cap's allow list (§5) | `tierCaps.mode` |
| chain | the seat's own pair; changed only when the class rules deny it (then its first allowed chain entry) | `classRulesApply` |

One walk over the steps, in `order`: **wouldApply** is the first choice of a step whose mode is `shadow` or `live`;
**applied** is the first choice of a `live` step that the station's override allowlist
(`company/state/override-allow.json`, written each tick by `lib/override-allow.js`, current for `allowMaxAgeMin`) opens
for the seat now (provider, model). A `live` choice that is not open is recorded (`not open: … is not in the override
allowlist`, `not open: no current override allowlist`) and the walk goes on to the next step. A `live` choice that is the
seat's own pair runs without an override. Nothing applied: the wake runs on its chain and the decision says why
(`shadow`, `not open …`). If the station's gate still refuses (HTTP 403), the dispatcher runs the wake again without the
override and records that.

**The class rules always hold**, whatever the modes and `classRulesApply`: when nothing earlier applied and the seat's
own pair is denied for the wake's class (code on `custom`), the router applies the first chain entry the rules allow and
the allowlist opens. When none is open the decision has `hold: true` (`holdWhy`: `… no allowed entry open …`): the
dispatcher logs `ROUTE HOLD`, records the decision (status `held`) and does not start the wake this tick (a Sprint lane
is not started either); it is tried again next tick. A 403 on such a wake's override is a hold too, never a run on the
denied pair (`chainDenied` on the decision names the rule). So even in a fresh checkout (the framework default present,
everything in shadow) a code item on a seat whose chain is only the MiniMax plan is held, not started.

The wake's class: each item's `lib/taskclass.js classOf` (a `**Class:**` line, `**Effort:** mechanical`, the department
`defaultClass`, else `general`); the wake's class is the majority (a tie: the first item's). A wake with no item (a
scheduled loop, an owner message) has its department's default class. Class rules check every class in the wake.

The decision (on the wake's `company/state/wakes.jsonl` row as `route`, and in the decisions log):

    { v, class, classes, source: trial|route|tierCap|chain, trial?, arm?, department?, provider, model, effort?,
      applied, mode, capMode, wouldApply?: { source, provider, model, effort?, trial?, arm?, department? }, chain?,
      chainDenied?, hold?, holdWhy?, reasons: [...] }

`provider/model/effort` is what the run was started on; top-level `source`/`trial`/`arm` say which step that was (a
trial's control arm, the seat's own pair, has `source: "trial"` with `applied: false`). Sprint lanes (`lanes.js`) are
routed and recorded the same way (door `lane`, one item per lane). The dispatch log says `ROUTE <seat>: …` only when the
decision differs from the chain.

## 4. Trials

The framework defines none: a trial runs only where a company's own policy lists one, drafted by the people function
and started by the owner:

```bash
node company/tools/routing.js trial create code-cmp --class code \
  --arm claude-cli/claude-sonnet-5-5@high --arm claude-cli/claude-opus-5-5@medium \
  --scope-dept eng [--scope-seat <seat>] [--entry-share 0.1] [--min-items 30] [--pause-when-held claude-cli] --by <people seat> --why "…"
node company/tools/routing.js trial start code-cmp --by owner
```

It is written into `trials` as:

    { "id": "code-cmp", "class": "code",
      "arms": [ {"provider":"claude-cli","model":"claude-sonnet-5-5","effort":"high"},
                {"provider":"claude-cli","model":"claude-opus-5-5","effort":"medium"} ],
      "scope": { "departments": ["eng"], "seats": [] }, "entryShare": 0.1, "status": "running",
      "pauseWhenHeld": ["claude-cli"], "minItemsPerArm": 30, "createdAt": "…", "createdBy": "Hal",
      "startedAt": "…", "startedBy": "owner" }

`create` refuses, all problems in one refusal and nothing written:
- an id that is badly formed or was already used (ids are never reused, finished trials included);
- an unknown class (lib/taskclass.js);
- no arms, or a number of arms outside `trialLimits`; an arm that is not `provider/model[@effort]`;
- a provider or model missing from `company/model-policy.json` `allowed`; an unknown effort; the same arm twice;
- an arm a class rule denies (a **code trial with a `custom` arm**);
- no scope, an unknown department or seat; an entry share outside (0, `maxEntryShare`];
- a `pauseWhenHeld` provider that is not allowed, or a `--pause-when-held` that leaves out an arm's provider which the
  pacer meters as a subscription (`claude-cli`, `custom`: lib/pacing-ask.js `SUBS`, the same table pacer.js uses).
  Without `--pause-when-held`, those providers are added to `trialLimits.defaultPauseWhenHeld` on their own.
  `status --json` gives each trial a `heldGuard` `{providers, subscriptions, missing}`, and the console's trial card and
  Start dialog say which plans pause the trial (and warn about a `missing` one in an older trial).

Statuses: `draft` →(start) `running` ⇄(pause / resume) `paused`, and stop (from any of them) → `done`. A trial cannot
start or resume while another running or paused trial tests the same class in an overlapping scope, so a wake is never
in two trials.

How the router uses a running trial:
- **Deterministic**: sha256(trial id + "\n" + wakeId): the first 8 hex digits against `entryShare` decide entry, the
  next 8 pick the arm by even split. The same wake always gets the same answer.
- **In scope**: the seat is listed in `scope.seats` or its department in `scope.departments` (both empty: nobody). Only
  `status: running` assigns; a trial assigns in `shadow` (recorded as `route.wouldApply.source = "trial"`) and `live`
  (applied when the seat's override allowlist opens the arm), never while `mode` is `off`.
- **Held, never switched**: while the pacer holds any provider in `pauseWhenHeld`, the trial assigns nothing. The router
  records the hold and its end as one routing-log row each, `{op: "trial-held" | "trial-unheld", by: "dispatcher",
  trial, providers, why}` (and a line in the dispatch log); `company/state/routing-state.json` keeps the state. With no
  pacer measurement the trial is held (fail closed). An assigned arm that is not open runs the chain and records why; the
  wake is never moved to another arm. The owner's own pause is a status (`paused`), the pacer's hold is not.
- A trial with an arm the class rules deny is skipped whole (and its arms are never listed in the allowlist).
- `minItemsPerArm` is the sample the trial is read at (`model-rank.js`, docs/RANKING.md); nothing here acts on it.

### Status and counts

`routing.js status [--json]` prints the two modes and whether the policy is the company's copy or the default; every
trial with its arms and counts; why a trial is paused (the owner's pause with who, when and why) or held (the newest
`trial-held` row in the routing log with no later `trial-unheld`, with the pacer's reason); and the last 20 routing-log
rows, newest first: changes and holds, never a decision row.

Arm counts come from `company/state/wakes.jsonl` rows written since the trial started, through the `route` field:
- a route whose own `source` is `"trial"` counts as **run on that arm** (`wakes`, `items`): applied as the override, or
  the control arm (the seat's own pair, `applied: false`);
- a route whose `wouldApply.source` is `"trial"` counts as **shadow** (`shadowWakes`, `shadowItems`): recorded only, or
  live but not open;
- the trial is named by `route.trial`, `route.trialId`, or `arm` given as `{trial, index}` or `"<trial>:<index>"`; the
  arm is `route.arm` (an index), or without an index the arm whose provider and model match.

Each arm shows its wakes and its distinct items (the `items[].id` of those wakes). `progress.enough` is true once every
arm has `minItemsPerArm` items. `wakes.jsonl` keeps 30 days (docs/RETENTION.md), so a trial older than that counts only
its last 30 days; `countedSince` says where the count starts. `model-rank.js` reads the same route fields.

## 5. Executor tier caps and the allowlist

**Tier caps.** For a seat that holds none of `tierCaps.exemptFunctions` (default `ceo`) and, with `exemptLeads`, leads
no department, a wake with no item marked `**Effort:** heavy` (`heavyEscape`) may only run on an `allow` entry
(`{provider}` alone matches every model of that provider; model aliases are listed one by one, so both `haiku` and
`claude-haiku-4-5-20251001`, both `sonnet` and `claude-sonnet-5-5`). When the seat's current pair is not one, the cap
picks the seat's first chain entry that is; with none it records `no capped entry` and leaves the chain.
`itemlessWakes` says whether a wake with no item is capped too. Its mode is `tierCaps.mode`, separate from `mode`.

**The allowlist.** `lib/override-allow.js` lists, per seat, its chain entries, its department's routes, and with a
routing policy the arms of every running trial it is in scope of (mode not off) and its capped chain entries while
`tierCaps.mode` is live. A route or arm the class rules deny for its own class is never listed. Every entry still has to
pass models.js `evaluate()` (pacer gates, the owner's subscription stops, quota, refusal blocks) to be listed, so a live
decision can never run a model the failover tick would not.

## 6. The two logs

The routing log and the decision rows are split by purpose:

| File | What | Rows | Retention | Locked |
|---|---|---|---|---|
| `company/work/models/routing-log.jsonl` (`history`) | changes and events only: the audit of the owner's routing changes and of the pacer's trial holds | `{at, ts, op, by, …}`, `op` one of `mode`, `tiercaps`, `trial-create`, `trial-start`, `trial-pause`, `trial-resume`, `trial-stop` (routing.js: `trial?`, `from?`, `to?`, `why?`, `digest`) or `trial-held`, `trial-unheld` (lib/routing.js: `by: "dispatcher"`, `trial`, `providers`, `why`) | monthly roll, 180 days or 2 MB (retention id `routing-log`) | class A: appended only by `routing.js` and `lib/routing.js`, each row recorded with `provenance.js appended`; a line anyone else appends is stripped |
| `company/work/models/routing-decisions.jsonl` (`decisions`) | one row per routed wake: why it ran on that model | `{at, ts, wakeId, seat, door, jobId, runId, status, route}` (`route` as in §3; a hold has `status: "held"` and `runId: null`) | monthly roll, 90 days or 16 MB (retention id `routing-decisions`) | no: a per-wake record like `wakes.jsonl` |

`digest` is the first 12 hex characters of the sha256 of the policy as written. `routing.js status` and the console read
the routing log (the last 400 rows from the end) and never show a row without one of those ops. The same `route` is on
the wake's `wakes.jsonl` row, which is what the trial counts and `model-rank.js` read; nothing reads the decisions log
back. `company/state/routing-state.json` (the trials' hold state) is one small file rewritten whole.

`company/tools/lib/routing.js` is a protected tool (locked-watch.js class F, area tool).

## 7. Weekly suggestions

The middle-management plan's P5: once a week the house ranking's routing proposals become owner cards that apply unless
the owner stops them. `company/tools/routing.js proposals` (policy key `proposals` in `routing-policy.json`):

| Key | Default | What |
|---|---|---|
| `mode` | `shadow` | off: nothing. shadow: each suggestion is recorded (kind `skip`, why `mode shadow`), no card, nothing applied. live: one veto card per suggestion |
| `weekday`, `hourLocal` | 1, 9 | when the week's look happens (company time), at most once per ISO week |
| `vetoDays` | 3 | how long the owner has to keep things as they are |
| `maxPerWeek`, `maxTierStep` | 3, 1 | suggestions per week; the most tiers one move jumps (light, standard, heavy, top in `model-policy.json`; a model with no tier reads as light) |
| `topTierNeedsCeo` | `claude-opus-5-5`, `fable` | a move onto such a model asks the CEO before the owner |
| `minItems` | 20 | the suggested setup's items |

**The look.** The hourly tick (the dispatcher runs `routing.js proposals tick` in its own process when `proposalsDue()`)
takes the open `kind: proposal` rows `model-rank.js` wrote that are still in today's ranking, best gain first, and skips
any whose route changed, that the class rules deny (code is never on the MiniMax plan), that jump too many tiers or have
too few items, keeping one per department and class and at most `maxPerWeek`.

**The card.** In live mode each suggestion becomes one owner card (`lib/owner-card.js` veto card, category `models`,
filed whatever the governance level for models: the owner sees every routing move):

> Each week the crew checks which setup does each kind of work best for the money. This week they want Engineering's
> coding work on a cheaper setup that did just as well on the last 40 jobs.
> If you do nothing, it changes on Thursday and the crew keeps measuring; if you keep it as it is, nothing changes.

Buttons: **Fine, go ahead** (the default, named first: it records the answer and changes nothing now) and **Keep it as it
is** (the veto: its effect `{routeVeto: {proposalId}}`, filed only by `routing.js`, runs `routing.js proposals veto <id>
--by owner`). The card never expires to a deny. The pairs, the cells' numbers and the id are in its technical fold.

**The CEO first for the top tier.** A move onto a `topTierNeedsCeo` model files one handoff in the CEO's inbox (kind
`ceo-ask`); only `routing.js proposals ceo <id> yes|no --by <CEO>` answers it (seat-checked like every crew `--by`; the
owner card follows a yes; a no records skip `ceo declined`). An ask the CEO did not answer by the next week's look is
`superseded`. (approvals.js records are the owner's Needs-you cards and refuse crew answers from the command line, so
the CEO's step is this one command instead.)

**Applying.** At the veto deadline with no veto, the tick runs `departments.js set-route <dept> <class> <to> --by
routing-proposal --proposal <id>` (accepted only outside an agent's run, for an offered suggestion whose window passed
unvetoed, whose owner card really was filed), records kind `apply` (with the departments file's digest) and a
`proposal-apply` routing-log row, writes the decisions.md line, and withdraws the card as answered by default. The new
route then follows the routing `mode` (shadow until the owner switches routing live). A route that changed in the
meantime is skipped (`route changed`).

**Where to see it.** `routing.js proposals status [--json]`; Settings › Models › Routing › Weekly suggestions (Off ·
Recording only · On, and the last 8 weeks with what happened to each). Rows (`company/work/models/routing-proposals.jsonl`,
appended by `routing.js` with provenance): `offer`, `ceo-ask`, `ceo-answer`, `veto`, `apply`, `skip`, `week`.

Not part of this: applying a suggestion straight to live routing, suggestions that change tier caps, trials or class
rules, and a lead changing its own department's routes. Tests: `company/tools/tests/routing-proposals.test.js`.
