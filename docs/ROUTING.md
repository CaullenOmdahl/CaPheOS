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
