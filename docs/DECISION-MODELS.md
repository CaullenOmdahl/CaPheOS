# Decision models

A **decision model** is a deterministic function from observed state to a recommended action, written as data. It is
what the company uses instead of an LLM when the question is small, frequent and checkable: faster, free, versioned,
logged, replayable and testable. Library `company/tools/lib/decision.js`, CLI `company/tools/decide.js`.

## When to write one

- The same judgement is made over and over from a handful of facts (a triage, a routing choice, a priority).
- You can write the cases down: "given these facts, the right answer is X".
- Being wrong in a known direction is acceptable: the model's default should be the safe answer, and every rule that
  loosens it should name the fact that makes it safe.

Not for: anything that needs reading prose, weighing novel situations, or facts the caller cannot supply. Keep that
with a person or an LLM, and let the model escalate to them.

## Shape

`company/decision-models/<id>/<version>.json` (tracked defaults), next to `cases.json`:

| Field | Meaning |
|---|---|
| `id`, `version` | must match the folder and file name (`1`, `2`, `1.1`) |
| `mode` | `shadow` or `live` as declared; see *Effective mode* below |
| `actions` | the closed list of actions the model may return |
| `inputs` | `{ field: { type: string\|number\|boolean\|array, required?, sensitive?, doc } }`. Unknown fields are ignored (and reported); a wrong type counts as missing; a missing `required` field returns the default |
| `params` | owner-set thresholds `{ name: { type, default } }`. Defaults are **closed** (e.g. 0 = nothing passes) |
| `scoring` | optional `[{ id, when, weight }]`; the sum of weights whose predicate holds is `score`, also readable by rules as field `$score` |
| `rules` | evaluated in order, first match wins: `{ id, when, action, why }` |
| `default` | `{ action, why }` when no rule matches |

Predicates: `{ field, op, value }` or `{ field, op, param }` with ops `eq ne lt lte gt gte in regex exists`;
combinators `{ all: [...] }`, `{ any: [...] }`, `{ not: p }`. Any comparison on a missing field is false (so write
"escalate unless X is known true" as `not: { field: X, op: eq, value: true }`). There is no code execution: an unknown
op or key makes the model invalid, and an invalid or missing model returns `action: null`, which every caller treats
as "do the safe thing".

Output: `{ action, rule, reason, score?, mode, model: { id, version, sha } }`.

## Effective mode

A version runs **live** only when the owner promoted it (`company/state/decision-models.json`), the file still has the
sha it had at promotion, and the promotion (or the model) says live. Everything else runs in **shadow**: the caller
logs the answer and must not act on it. The active version is the promoted one, else the highest on disk (in shadow).

## The loop: registry, log, replay, test, promote

```
node company/tools/decide.js list [--json]                          what exists, what is active, live or shadow
node company/tools/decide.js show gate-triage                       the model as data, its sha
node company/tools/decide.js eval gate-triage --input '{"category":"tools","reversible":true,"recurring":false,"seatHistoryOk":true}'
node company/tools/decide.js test gate-triage [--all]               cases.json; exit 1 on a miss
node company/tools/decide.js replay gate-triage --version 2 [--from 2026-11-01]   logged inputs through v2: agreements, disagreements
node company/tools/decide.js promote gate-triage 2 --mode live --by owner          owner only; refused while a case misses
node company/tools/decide.js set-param gate-triage maxSpendUsd 20 --by owner
```

1. **Write** `N+1.json` next to the live version and add cases for what changed. A new version is shadow until promoted.
2. **Test**: `decide.js test <id> --version N+1`. Cases see the closed param defaults unless a case sets `params`.
3. **Replay**: every evaluation is a row in `company/work/decisions/<id>.jsonl` (input digest, the input with
   `sensitive` fields left out and listed in `redacted`, the params used, the output, the caller). `replay` re-runs
   those inputs through the new version and lists every disagreement, so you know exactly what the change would have
   done to real traffic.
4. **Promote**: the owner runs `promote`. It reruns the cases, writes `company/state/decision-models.json`, adds a row
   to `company/state/decision-models-log.jsonl` and a line to `company/work/decisions.md`.

Locked: `decide.js register` (also run by every promote and set-param) writes the model folder, the promotion state
and its log, and the evaluation logs into `company/state/locked-extra.json` `.entries` (tagged `source: "decide.js"`,
locked-watch MANIFEST shape) so `locked-watch.js` reports or undoes an edit nobody recorded.

## First model: gate-triage

`company/decision-models/gate-triage/1.json` serves the self-governance level **triage** (company/DECISION_RIGHTS.md).
`lib/governance.decide(category, { ..., facts })` evaluates it with `{ category, ...facts }`; facts are
`amountUsd, recurring, vendorKnown, seatHistoryOk, reversible, externalRecipientKnown`. `proceed-notify` behaves like
notify (the owner sentence says the model let it through, with the rule and version), `escalate` like approve (the
owner question says why it escalated). Shadow mode, a missing model or no facts all escalate. The model ships in shadow
with `maxSpendUsd` 0; fixed owner gates never reach it, and hiring, release, budget and packs always escalate.
Callers that want triage to be useful must pass facts; a caller that passes none simply gets approve.

## How a pack ships models

A capability pack may carry `decision-models/<id>/<version>.json` (+ `cases.json`). Once installed under
`company/state/packs/installed/<pack>/decision-models/`, the registry finds it (after the company's own folder, so a
pack cannot shadow a core model of the same id). It still runs in shadow until the owner promotes it. The pack's tools
call `require('company/tools/lib/decision').evaluate(id, input)`. (pack.js does not yet copy or lock that folder
separately; it is part of the installed pack tree.)

## Candidates to migrate (not migrated yet)

- **Pacer routing** (`pacer.js`): which provider and model a run goes to under the subscription stops.
- **Competence scoring** (`competence.js`): the shadow-mode score rules.
- **Dispatcher priority** (`dispatch.js`): which seat to wake first.

Each is already rule-shaped; moving it onto this primitive buys logs, replay and owner promotion for free. Do it one
at a time, starting in shadow next to the existing code, and promote when replay shows no surprises.
