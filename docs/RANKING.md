# The house ranking: which model does our work best for the money

Public benchmarks say how a model scores on someone else's tests. The house ranking says how it does on **this
company's finished work**, per kind of work, for what it cost. It is the data the department routes (company/
departments.json `routes.<class>`) are meant to follow. It is measured in production, so both the framework and the
scoring method are expected to change as real numbers come in: **every rule, threshold and weight is in a policy
file, not in code**, and anything that would change routing runs in **shadow** first.

Code: `company/tools/model-rank.js` (the ranking), `company/tools/lib/taskclass.js` (task classes, departments),
`company/tools/check-benchmarks.py` (the public book). Policy: `company/work/models/ranking-policy.json` (copied at
founding from `company/defaults/work/models/ranking-policy.json`). Tests: `node company/tools/model-rank.js --selftest`,
`node --test company/tools/tests/model-rank.test.js`, `node --test company/tools/tests/model-rank-trials.test.js` (§10), `python3 company/tools/check-benchmarks.py --selftest`.
Owner: the `people` function (the model manager).

## 1. What is measured

**The unit is the handoff item**, not the run. A run is the wrong unit: one run may work several items, one item may
take several runs (rework, a consult, delegated children), and a run that "finished" may have produced work that was
sent back. The dispatcher records which items each run it starts is for (`company/state/wakes.jsonl`, `lib/wakes.js`);
the ranking reads DONE items closed in the last `windowDays` and the runs linked to them.

- **Cost of an item**: the sum over every run linked to it: its own runs, consults by other seats that listed it,
  rework, and every delegated child under those runs (`lib/family.js`). A run that worked several items splits its cost
  evenly between them; a child run is split like its lead's run.
- **Cell** = (task class, model, effort). The model is the one the provider **served** (`servedModel` on the run row)
  when the row says so; otherwise the model requested, and the cell is marked **claimed** (`… (claimed)`): a provider may
  serve another model than the one asked for, and an unconfirmed model never mixes with a confirmed one. The cell's
  model is the one of the item's first own run (the seat whose inbox it is), else its first run.
- **Task class** (`lib/taskclass.js classOf`): an explicit `**Class:** <class>` line in the block wins; else
  `**Effort:** mechanical` gives `mechanical`; else the seat's department `defaultClass`; else `general`. Classes:
  `code`, `review`, `research`, `writing`, `design`, `ops`, `mechanical`, `general`.

## 2. Signals per item

| Signal | Where it comes from | Policy |
|---|---|---|
| one-shot | accepted (DONE) and none of `oneShot.failOn` happened within `oneShotWindowDays` of the close | `oneShot.failOn` (default revise, reopen, revert, fixForward) |
| REVISE rounds | `**Verdict:**` / `**Review:**` lines in the item's block, or in any block whose `**Item:**` line names it (a consult) | `verdicts`, `weights` |
| reopen | a wake listing the item after it closed (10 min slack), or a `**Reopened**` line | `signals.reopen` |
| revert, fix-forward | competence ledger rows (`pr.reverted`, `pr.fix-forward`) that trace to the item's runs or PR | `rework` |
| defects | competence ledger demerits (`defect.confirmed`, `flaw.in-review`) that trace to the item's runs (a credit's author run, or the row's own) or PR, weighted by severity; a row a corroborated ruling voided is left out | `defects` |
| premerge first pass | `company/work/evidence/premerge-*.json` for the item's PR (`**PR:**` line or a pull-request URL): the first verdict ever recorded | `signals.premerge` |
| owner corrections | competence ledger rows of `ownerCorrections.ledgerSignals` or corrections-log rows naming one of its runs or its id, or a `**Owner correction:**` line | `ownerCorrections` |
| cost | metered runs: the usd the station recorded; subscription runs (usd 0, `unmetered`): priced from `cost.listPrices`; subscription window share as its own column (estimated window tokens = uncached + `cachedWeight` x cached) until the pacer gives real readings | `cost` |
| tail cost | the cost at `tail.percentile`, and the mean of the most expensive `tail.hardestShare` of items | `tail` |
| items per change | items / distinct changes (a PR, else the item): shown so that splitting work into small items to look like one-shots does not pay | `score.per` can score per change |

A verdict line: `**Verdict:** REVISE by <seat id or name> — check: <the acceptance check that was run> — <findings>`.
Words that fail an item: `verdicts.fail` (REVISE, CHANGES-REQUESTED, REQUEST-CHANGES, REJECT, TAKE-OVER); words that pass:
`verdicts.pass`. ESCALATE and ESCALATE-TIER neither pass nor fail.

## 3. The score

    score = lower bound of the interval on the one-shot rate / cost per item

The interval is the Wilson score interval at `interval.confidence` (default 80%), so a small lucky sample does not
outrank a large steady one. A half-weight verdict makes an item half a one-shot. Cost is `score.cost`: `listUsd`
(default: metered usd and subscription runs at list price, one scale for both), `usd` (metered only) or `windowTokens`.
**A cell needs `minItems` (default 20) scored items before it can steer anything**: below that its status is
`not enough data`, it has no score and no rank, and it can be neither proposed nor beaten.

An item closed less than `oneShotWindowDays` ago is **settling**: it is counted apart and not scored until nothing had
the time to undo it (`countUnsettled: true` scores it anyway).

## 4. Guards against noise and gaming

- **An author never grades its own work.** A verdict by the item's seat, or by any seat with a run linked to it (a
  delegated worker included), is ignored and counted (`totals.selfGradesIgnored`).
- **A lead's verdicts on its own reports count half** (`weights.leadOnOwnReport`, default 0.5): the department lead
  (`company/departments.json`), or the seat's manager when there is no other lead.
- **A verdict that cites no acceptance check is ignored** (`verdicts.requireCheck`; `totals.uncitedIgnored`); so is one
  whose grader is not a seat (`totals.unattributedIgnored`).
- **Not the model's fault is not a failure**: provider errors and delegated children cut by the dispatch wall-clock slice
  (`exclude.runKinds`) are left out of the score and of rework; their cost is shown apart (`excludedListUsd`); an item
  whose every run was excluded is not scored (`excludedItems`).
- **Items per accepted change** is reported per cell, and `score.per: "change"` scores per change instead.
- **Graders are calibrated**: each grader's approval rate is compared with the hard one-shot rate (no reopen, revert or
  fix-forward) of the items it graded; past `graders.driftPoints` (default 25) with `graders.minVerdicts`, it is flagged.
- **The history is hash-chained**: `company/work/models/house-ranking-history.jsonl` gets one row per change of the
  ranking, each carrying the hash of the row before it (`prev`) and its own (`rowHash`). `model-rank.js verify` reports a
  removed or edited row. After a retention roll the pointer line the roll leaves records it, and the chain restarts from
  the first live row.

## 5. Output

| File | What | Written |
|---|---|---|
| `company/work/models/house-ranking.json` | `{computedAt, hash, …body}`: cells, proposals, graders, totals. `hash` is the sha256 of the canonical body; `computedAt` is outside it | replaced whole, only when the body changed |
| `company/work/models/house-ranking.md` | the same in words, one table per class | with the JSON |
| `company/work/models/house-ranking-history.jsonl` | one hash-chained row per change | appended; rolled monthly, 90 days live (retention) |
| `company/work/models/routing-proposals.jsonl` | `{kind: proposal}` rows (each proposal once) and `{kind: decision}` rows | appended; rolled monthly, 180 days |
| `company/state/model-rank.json` | when it last checked, the hash, the policy digest | each refresh |
| `company/work/models/routing-evaluation.json`, `company/work/models/trials/<id>.md` | the trial and tier-cap evaluation (§10) | each refresh, only when its text changed |

**Deterministic**: the same inputs give byte-identical files. Keys are sorted, numbers rounded, lists sorted, and the
body holds no clock time (the window is stated in days). A rerun that computes the same body writes nothing.
A policy change shows as a new ranking even when no work changed (the body carries the policy's digest).

## 6. Refresh, the duty, routing proposals

- **Refresh**: the dispatcher runs `model-rank.js refresh` in its own process when `refreshMinutes` (clamped 60–1440:
  at most hourly) have passed, or the policy changed. It logs one `HOUSE RANKING:` line only when the ranking changed.
- **Routing proposals (shadow)**: when a cell with enough data beats a department's current route for that class
  (`departments[].routes.<class>`: `{provider, model, effort}`) by more than `proposals.margin`, a proposal row is written.
  It is never applied: applying is a later step behind an owner switch in the console. No proposal while the route's own
  cell has no data (`requireRouteData`); a claimed cell is not proposed (`allowClaimed: false`).
- **The duty** `house-ranking` (`company/tools/duties.js`, every 60 min, routes to `people`): `model-rank.js --duty`
  computes the ranking in memory (read only, no socket) and is due while a proposal is open, with the proposal ids as
  items. It is quiet when there is none. The people seat looks and records what it did:
  `node company/tools/model-rank.js decide <id> --verdict noted|declined --by <seat> [--reason "…"]`.

- **The life of a proposal** (docs/ROUTING.md §7): a `proposal` row is looked at once a week by `routing.js proposals`.
  It is then `skip`ped (with why: shadow mode, a route that changed, the class rules, a tier jump, too few items, one per
  department and class), sent to the CEO first (`ceo-ask`, for a move onto the top tier), or `offer`ed to the owner on a
  veto card; an offer is `veto`ed by the owner or, at the deadline, `apply`ed through `departments.js set-route --by
  routing-proposal`. A proposal in any of those states no longer makes the duty due.
- **Fan-out** (docs/DEPARTMENTS.md §6): an item is delegated when a delegated child run is under its runs or piece lanes
  of a recorded split worked it (`wakes.jsonl` `split`). Its cost is its whole family's. `fanoutEvaluation` (§10) reads
  those items.

No departments file: nothing is proposed, the ranking is still computed. No policy file: nothing is ranked.

## 7. The console

The scaffold `company/console/scaffolds/model-ranking/` is a company screen (“Ranking”): the headline numbers, every
cell with its status, the open proposals (a row action asks the people seat about one), and the ranking in words.
`node company/tools/console-panel.js scaffold model-ranking --as model-ranking --by <people seat>`, point its two
sources at `company/work/models/house-ranking.json` and `.md`, then `add` (docs/CONSOLE-PANELS.md §12).

## 8. The public benchmark book

`company/work/models/model-benchmarks.json` (default `company/defaults/work/models/model-benchmarks.json`) holds the
public scores of every model `company/model-policy.json` allows, each with its source URL, date and who measured it
(independent, vendor, house). It is a **prior** shown beside the ranking, never part of its score: before a cell has
enough data, it is the best guess; after, the company's own data wins. `python3 company/tools/check-benchmarks.py`
checks the contract (provenance on every row, no duplicates, every allowed model covered, aliases pointing where the
Claude CLI really resolves them) and that each rule can fail (broken copies in memory; `--selftest` also runs the
negative fixtures in `company/tools/tests/fixtures/benchmarks/`).

## 9. Tuning it

Change `company/work/models/ranking-policy.json` (the people function; bump `version`). Things expected to move once
real numbers come in: `minItems`, `interval.confidence`, `weights.leadOnOwnReport`, `oneShot.failOn` (adding `defect`
or `premergeFail`), `score.cost`, `cost.outputShare`, `cost.window.cachedWeight`, `proposals.margin`. The golden fixture
(`company/tools/tests/fixtures/ranking/`) carries its own copy of the policy, so tuning the shipped default does not
move it; changing the method does: rebuild it with `node company/tools/tests/fixtures/ranking/build.js --expected`
and check the new numbers by hand before committing them.

## 10. Trials and tier caps: did the routing change pay?

The router (`lib/routing.js`) records its decision on each wake's row in `company/state/wakes.jsonl` as `route`:
`{class, source: trial|route|tierCap|chain, trial, arm, provider, model, effort, applied, wouldApply, reasons}`. A
model trial and the executor tier caps are defined in `company/work/models/routing-policy.json` (the framework default
defines no trial). This section is how their results are read; it routes nothing. Settings: `trials` and
`tierCapEvaluation` in the ranking policy (delete a section to switch that report off).

**Items.** The same scored items as the ranking (DONE, settled, not excluded; §1-§4), each joined to the routes on the
wakes that listed it.

- An item is an **arm item** when a wake ran it on a trial arm: `route.source: trial` with that `trial` and `arm`,
  whether `applied` is `true` (the arm was a one-run override) or `false` (the seat's chain already is the assigned arm,
  so it ran there with no override: typically the control arm). A trial assignment that appears only in `wouldApply`
  (`route.source: chain`: trials in shadow, or the arm not in the override allowlist) ran on the chain and is counted
  apart (`shadowItems`), never as an arm result. An item whose run was served a different model than the arm's
  (`servedModel` in runs.jsonl) is counted apart too (`mismatches.served`), not scored for the arm. An item worked on two arms (two wakes, each assigned by hash) counts for neither
  (`mixedItems`). Assignment is per wake (hash of trial id + wake id), so an item that takes several wakes can
  land on two arms: watch this count; a high one means the trial measures little.
- The arm is the route's `arm` (an index into the trial's `arms`, or an arm id), else the arm whose model matches.

**Per arm** (`company/work/models/routing-evaluation.json` `trials[].arms[]`, `model-rank.js trials`):

| Field | What |
|---|---|
| items, settling, excluded, shadowItems | scored arm items; items still settling; items whose every run was excluded; shadow-only items |
| oneShotRate, lower, upper | the one-shot rate and its two-sided Wilson interval at `trials.interval.confidence` (default: the ranking's 80%) |
| extraRunsPerItem, revisePerItem, reopened | rework (§2) |
| defects, defectPoints | confirmed defects, severity-weighted (§2) |
| costPerItem, medianCost, p90Cost, hardestCost | `trials.cost` (default `listUsd`) per accepted item: mean, median, the `tail.percentile` cost and the mean of the most expensive `tail.hardestShare` |
| windowTokensPerItem | estimated subscription window tokens per item (§2 cost) |
| mismatches | `served`: items whose run was served another model than the arm's (`servedModel`): not scored; of the scored items, `requested`: the run asked for another model than the arm's and its served model is unknown; `unconfirmed`: no `servedModel` |

**The decision rule** (`trials`): with every arm at `minItemsPerArm` (the trial's own, else the policy's, default 30)
items, an arm **wins** when the lower bound of its one-shot range is not below the best other arm's point estimate
**and** its cost per accepted item (`costStat`: mean, or median) is lower than every other arm's (`decision.cheaperThan:
"every"`, the default) or than that best other arm's (`"bestOther"`). Otherwise the state is **no decision yet**, with
what is missing: the arms short of items (`arm 2 (…): 12 of 30 items`), an arm with no cost recorded, "no arm is clearly
better" (the best lower bound is below another arm's point estimate), or "clears the quality bar but does not cost
less". There is never a winner without the data.

**The decision file** `company/work/models/trials/<id>.md`: the trial's status, scope and entry share, the per-arm table
with ranges, and the decision. It carries no clock time and is replaced only when its text changes, so it changes when
the numbers do. A winning arm is not applied by this: moving a department route is a routing proposal the people
function and the owner decide (§6).

**Tier caps** (`tierCapEvaluation`, the plan's P3 acceptance), per task class (the item's own class, §1: a class's
verdict reads only that class's items, whatever class the wake was routed under):

- **Capped**: scored items whose wake had a tier cap applied (`route.source: tierCap`, `applied: true`).
- **Baseline** (`baseline`): `wouldApply` (default) = items whose wake the cap would have changed but did not: the router
  records those as `route.source: chain`, `applied: false`, `wouldApply.source: tierCap` (caps in shadow, or live but
  the capped entry not in the override allowlist: the same work, uncapped); `uncapped` = every scored item of the class
  no tier cap touched either way. An item with both capped and would-apply wakes counts for neither.
- **Verdict**: **keep** when estimated claude window tokens per accepted item fell by at least `windowCut` (default 0.3)
  **and** each rate in `rates` (`revise`: share of items with a counted REVISE; `reopen`: share reopened) is within
  `reworkMaxRatio` (default 1.25) of the baseline; **roll back** (that class) otherwise, with the reason; **not enough
  data** while either side has fewer than `minItems` (default 20). A baseline rate of 0 allows only 0.

**Advisor leads** (`advisorEvaluation`, the plan's P4 bars; docs/DEPARTMENTS.md §5), per department whose advisor
mode is live: its members' scored items closed since `advisor.since` against its items closed in as many days before.

| Field | What |
|---|---|
| consultRate | the share of items since with at least one consult (`company/state/consults.jsonl`, recorded-only ones aside) |
| cachedShare, adviseRuns | the lead's advise runs (wakes of door `consult`): input tokens read from cache over all input tokens |
| after, before | items, one-shot rate with its Wilson range, cost per item (`score.cost`; advise runs are in the consulted items' cost), rework per item (extra runs + REVISE rounds) |
| oneShotPoints, reworkCut | the change in one-shot points, and the share rework fell |
| leadCalibration | the lead's grader drift (§4) |
| verdict | `keep`, `pause` (with `failed`: the bars that failed) or `not enough data` (under `minItems` items on either side, or `minDays` days) |
| hash | of the rest of the entry: the dispatcher pauses once per hash |

Bars: the consult rate inside `consultRate` (10-40%), the cached share at least `cachedShareMin` (85%, checked once advise
runs have token counts), and cost per item not higher with one-shot up `oneShotGainPoints` (10) points or rework down
`reworkCutShare` (20%). A department's `advisor.autoPause` numbers win over the policy's. The report is in
`routing-evaluation.json` (`advisor`) and `company/work/models/advisor-<dept>.md`; with no live advisor department
there is no advisor report at all. With `autoPause.enabled`, a `pause` makes the dispatcher pause the advice
(`departments.js advisor <id> pause --by dispatcher --auto`) and tell the owner in one plain line; only the owner
resumes.

**Duty.** The `house-ranking` duty (§6) is also due when a running or paused trial reached a decision (item
`trial:<id>:decided:<arm>`), when a running trial has had no routed wake for `trials.stuckDays` (default 3; item
`trial:<id>:stuck:<since>`; a pacer hold that pauses the trial shows here too), and when the tier caps are in one of
`tierCapEvaluation.dutyWhenModes` (default `live`) and a class says roll back (`tiercap:<class>`). In shadow the
verdict is reported, not due.

**Limits.** The evaluation sees what the ranking sees: items closed in `windowDays` and wakes inside
`company/state/wakes.jsonl` retention (30 days). A trial longer than that keeps only its last month in the numbers; the
decision file of the moment is the record.

### Fan-out: does splitting big jobs pay?

`fanoutEvaluation` (policy key `fanoutEvaluation: { minItems: 10 }`; delete it to switch the report off), per department
whose delegation is not off: its members' delegated items against its single-seat items of the same class. Cost per
accepted item = the items' `score.cost` over their one-shot sum, compared class by class and weighted by the delegated
items of each class. `keep` when splitting is cheaper, `withdraw` when it is not over at least `minItems` delegated items,
`not enough data` below that or with nothing of the same class to compare. Each entry carries a `hash`; the dispatcher
withdraws the department's splitting once per hash (`lib/delegate-allow.js withdrawStep`), only the owner resumes. It is
written to `routing-evaluation.json` under `fanout`.
