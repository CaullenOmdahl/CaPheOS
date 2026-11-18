# The house ranking: which model does our work best for the money

Public benchmarks say how a model scores on someone else's tests. The house ranking says how it does on **this
company's finished work**, per kind of work, for what it cost. It is the data the department routes (company/
departments.json `routes.<class>`) are meant to follow. It is measured in production, so both the framework and the
scoring method are expected to change as real numbers come in: **every rule, threshold and weight is in a policy
file, not in code**, and anything that would change routing runs in **shadow** first.

Code: `company/tools/model-rank.js` (the ranking), `company/tools/lib/taskclass.js` (task classes, departments),
`company/tools/check-benchmarks.py` (the public book). Policy: `company/work/models/ranking-policy.json` (copied at
founding from `company/defaults/work/models/ranking-policy.json`). Tests: `node company/tools/model-rank.js --selftest`,
`node --test company/tools/tests/model-rank.test.js`, `python3 company/tools/check-benchmarks.py --selftest`.
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
