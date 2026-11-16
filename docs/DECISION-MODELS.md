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
| `inputs` | `{ field: { type: string\|number\|boolean\|array, required?, sensitive?, safety?, sources?, doc } }`. Unknown fields are ignored (and reported); a wrong type counts as missing; a missing `required` field returns the default. `safety: true` + `sources` (see *Fact provenance*) |
| `params` | owner-set thresholds `{ name: { type, default } }`. Defaults are **closed** (e.g. 0 = nothing passes) |
| `scoring` | optional `[{ id, when, weight }]`; the sum of weights whose predicate holds is `score`, also readable by rules as field `$score` |
| `rules` | evaluated in order, first match wins: `{ id, when, action, why }` |
| `default` | `{ action, why }` when no rule matches |
| `outcomes` | optional `{ windowDays (30), maxBad (0), proceedActions }`: the rolling window and bad-outcome limit for *Outcomes and health*; proceedActions defaults to every action but the default's |

Predicates: `{ field, op, value }` or `{ field, op, param }` with ops `eq ne lt lte gt gte in regex exists`;
combinators `{ all: [...] }`, `{ any: [...] }`, `{ not: p }`. Any comparison on a missing field is false (so write
"escalate unless X is known true" as `not: { field: X, op: eq, value: true }`). There is no code execution: an unknown
op or key makes the model invalid, and an invalid or missing model returns `action: null`, which every caller treats
as "do the safe thing".

Output: `{ action, rule, reason, score?, distrusted?, decisionId, mode, model: { id, version, sha } }`.

## Fact provenance

A rule that loosens the answer is only as good as the fact it tests. If the acting seat supplies `reversible: true`,
triage is self-certification. So every input may carry where it came from: `evaluate(id, facts, { actor })` takes
each fact plain or as `{ value, source, ref? }`. An input marked `safety: true` lists the `sources` allowed to vouch
for it (`ledger`, `external-gate-allowlist`, `external-gate-clearances`, `competence`, `performance`,
`registry:parties`, `owner-table`, `request`, `tool:<name>`, `owner`; a trailing `*` is a prefix). A safety fact
counts only as an envelope whose source is on its list and is not the actor: a plain value, a missing source, `actor`,
`agent`, `self`, `seat`, or the actor's own name (`sam`, `seat:sam`) is **treated as absent**, so the model takes its
conservative path (escalate). The output lists such fields under `distrusted`. `validate` refuses a safety input
whose sources include the actor. The log row keeps `provenance` per field (source, ref, or why it was rejected),
the rejected `claimed` values and the `actor`; `replay` re-applies provenance, so a new version sees what the old one saw.

## Outcomes and health

Every logged evaluation has a `decisionId` (`d-` + 12 hex). How it turned out is a row in
`company/work/decision-outcomes.jsonl`:

```
node company/tools/decide.js outcome d-1a2b3c4d5e6f --result bad --by owner --note "cost more than it said"
node company/tools/decide.js join                     # outcomes later records already answer
node company/tools/decide.js health [--id gate-triage] [--json]
```

- **By hand**: any seat or the owner; the actor of a decision cannot grade it good; an agent run cannot write as the owner.
- **Joined automatically** (`join`, also run by `health` and before every triage): an owner message that names the
  decisionId and undoes it ("undo d-…", "revert", "no"), a ledger `credit-note` or `refund` row that names it, a
  commitment in state `breached` that names it. Each is recorded once as `bad`, with its source and ref.
- **Health**: per model and version, the proceed decisions in the model's rolling window, how many were judged, good,
  bad, and precision = good / judged. A **live** version whose bad outcomes exceed `outcomes.maxBad` (closed default
  0: any bad outcome on a proceed demotes) is set back to **shadow** in `company/state/decision-models.json`
  (by `decide.js (automatic)`, logged in `decision-models-log.jsonl` and `decisions.md`) and the owner gets one
  sentence via `owner-inbox.js send`. The owner re-promotes when satisfied.

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

`company/decision-models/gate-triage/` serves the self-governance level **triage** (company/DECISION_RIGHTS.md).
`proceed-notify` behaves like notify (the owner sentence names the model, version, rule and decisionId, and says
"reply undo d-…"), `escalate` like approve (the owner question says why). Shadow mode, a missing model or missing
facts all escalate. Fixed owner gates never reach it; hiring, release, budget and packs always escalate.

- **v1** takes plain facts on the caller's word. It stays on disk, valid and replayable (its cases carry
  `versions: ["1"]`), but `lib/governance` never lets it proceed: a triage model with no safety inputs escalates.
- **v2** (the active version on disk; ships in shadow) has the same rules with every loosening fact a safety input.
  `lib/governance.triageFacts` builds them from records, not from the actor:

| Fact | Built from (source) |
|---|---|
| `reversible` | the owner's table: param `reversibleCategories` (comma list, default empty) — `owner-table` |
| `recurring` | the owner's table: param `oneOffCategories` (default empty, so everything counts as recurring) — `owner-table` |
| `amountUsd` | the request: `decide(category, { amountUsd })`, the amount the tool is about to commit — `request` |
| `vendorKnown` | `decide(..., { vendor })` on `company/state/external-allowlist.txt`, a party folder, or a ledger payout/receipt/invoice — `external-gate-allowlist` / `registry:parties` / `ledger` |
| `externalRecipientKnown` | `decide(..., { recipient })` with a live, unclosed row in `external-clearances.jsonl`, the allowlist, or a party — `external-gate-clearances` / … |
| `seatHistoryOk` | `company/work/people/competence.json`: the seat has a record and no serious or waiting flaw — `competence` |

  The caller's `facts` pass only for non-safety fields; a safety claim goes in as source `actor`, is rejected and is
  logged under `claimed`. The owner sets the tables: `decide.js set-param gate-triage reversibleCategories
  tools,schedules --by owner`. `outcomes`: 30 days, `maxBad` 0.

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
