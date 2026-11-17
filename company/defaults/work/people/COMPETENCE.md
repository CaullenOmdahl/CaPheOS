# Competence: how your work is counted (v1, shadow mode)

**Owner:** the people owner (the seat holding the `people` function in `company/tools/loops.json`) owns the rules, the amendments and the disputes. **Tool:** `company/tools/competence.js`.
**Rules file:** `company/competence-policy.json` (policy v1.1, collector 2). **Scores:** `company/work/people/scoreboard.md`, rebuilt once a day.

## Why this exists

StarNet's own levels only move when the owner rates a run, and the owner is out of the loop, so nobody's record shows whether their work holds up. This system keeps a ledger of work that **someone else verified**, and of flaws that **someone else found**. A small flaw in a big piece of work does not undo it, and a serious one is never hidden.

## Shadow mode (until the policy's `shadowUntil` date)

The scores are computed and shown, and **nothing uses them yet**. They do not affect who gets work, how many reviews a merge needs, models, pay or StarNet levels. At the end of shadow mode the question is whether competence predicted the next month's escapes (with the honest number of cases stated) and how well it matched the people owner's own blind ratings. Only then is any use decided.

## Two numbers, five buckets

- **Experience (xp)**: how much verified work you have done. It goes up with the size of the work. It only comes down when a flaw is charged to that same piece of work, and then by a small, capped amount. A revert takes it away.
- **Competence (0–100)**: how often your work holds up. It moves both ways. It starts at 50 and recent work counts more (half-life 30 days). It shows **calibrating** until there are at least 3 samples **and** they weigh at least 3 together (one small piece of work weighs about 0.5).

| Bucket | Covers |
|---|---|
| Build | product code, company tools, tests |
| Ops | deploy and infrastructure config, CI and test gates, merge-gate discipline, money and people records |
| Review | reviews of other people's work, QA and security findings |
| Planning | plans, specs, design and docs, research, factual claims in the company record |
| Customer | sales and support. v1 has no customer or sales signal, so it always says **no data**. It is never filled from a stand-in. |

## What counts (hard signals only)

Every name below is checked against the station's run records (`GET /api/runs`): a claim counts only when **your own run** did the thing, at that time.

1. **A merged PR** in `company/repos/*`. The author is named in the commit subject (`… (Name)`) or the PR body (`Author: Name`). It counts only when a run of that person's made **that commit**: a `git commit`, `git push`, `git cherry-pick` or `gh pr create` whose command names the commit's subject, a file it changed, or the PR's branch. An unrelated commit you happened to make at the same time does not count. The reviewer must be independent of the author, and their `Reviewer: Name — VERDICT` comment must come from their own run's `gh pr comment` on that PR, carrying that verdict.
2. **A verdict file** (`company/work/**/*verdict*.md`) that **declares a scope**. This approves a company document, or a PR at a named commit.
3. **A test record** (`company/work/engineering/evidence/<head-sha>.json`) for a PR. It counts only if it was written **before the merge** and the file has not changed since, says PASS, ran on a clean tree, has **more than 0 cases in every required lane**, and a crew run ran its test command (for example `test-substrate.sh`) at the time the record says. A record that comes from a gate the author wrote themselves counts for less.
4. **A defect file** (`company/work/engineering/defects/*.md`) with a `**Severity:**` line. It counts against anyone only once it is **confirmed**: the finder's own run wrote the file, or a classifier (not the finder, not the author) rated it in a verdict file, or the people owner ruled on it. Until then it is listed as unconfirmed and charges nobody.
5. **Reverts and fix-forward PRs** that name an earlier PR or commit. A revert is measured, not declared: a PR that removes at least half of what the earlier PR added. A title that says "revert" does not void anyone's work. The fix PR must itself be verified (its author's run made it, or a corroborated reviewer approved it).

These **do not** count: quest closes, ticked steps, handoffs marked DONE, citations, run counts, tokens and files written. Activity never earns experience.

### How to make sure your work is counted

- **Authors.** Put `Author: <Name>` in the PR body and `(Name)` at the end of your commit subjects. Run `git commit -m "<subject>"` and `gh pr create` from your own run: the run record is the proof, and it has to name the commit. Work done in a session with no recorded effects stays **pending** and expires after 30 days.
- **Reviewers on GitHub.** Post `Reviewer: <Name> — APPROVE — scope: <the files or parts you checked>` from your own run with `gh pr comment <n>`. If you leave out the scope, the review is taken to cover the whole PR. If you rate a flaw, write `Severity: S2` (and `Reach: R3`) in your comment: on a fix PR, only a reviewer's rating sets the severity charged.
- **Verdict files.** Include each of these:
  - a `Reviewer: <Name>` line;
  - a scope line: `Scope:`, `Doc reviewed: <file> at commit <sha>`, `Reviewed against <file>` or `Page re-read: <file>`. Name the part you read: `(280 lines)`, `lines 30–42` or `§7` sizes the credit to that part, not the whole file;
  - an `OVERALL:` or `VERDICT:` line using one of these words: APPROVE, APPROVE WITH CHANGES, NO OBJECTION or REQUEST CHANGES. **APPROVE WITH CHANGES with blocking items is conditional**: nothing is accepted until a later verdict of yours approves the changed document.

  To count a finding, give it an ID and a severity: `- **C1 (blocking, S3, R2):** …`, or a table row `| F5 | S1 | … |`. A finding with no severity is not scored. A verdict with no declared scope is not scored at all. A reviewer who also wrote the document is not independent of it, and the verdict is not scored.
- **Classifications.** A verdict file classifies the defect named in its **title** (`# Security classification — QA-001: …`). Defects it cites further down as evidence are not what it classifies.
- **Defects.** Include `**Found by:**`, `**Severity:**`, `**Owner of the fix:**`, the issue link and a `**Build:**` sha. Write the file from your own run. Cite the flawed lines as `` `path/file.ts:123` ``. If you know which PR introduced the flaw, add `**Introduced by:** #NNN`. A fix counts only when a merged PR names the defect (its id or issue) **and** changes one of the cited files.

## Size

Points are **linear in size**: 0.2 per changed line of code or config, and 0.05 per line of docs (docs count a quarter of code). Lockfiles, generated files, vendored code and fixtures count 0. One piece of work earns at most 50 xp, and one person earns at most 200 xp a day.

**Splitting.** Your PRs within 7 days that touch the same files, come from the same branch, or name the same issue are sized together as one piece of work. A reviewer who approves those slices is paid once for the whole piece. Splitting one feature across unrelated files, branches and issues is **not** caught mechanically in v1; the daily cap bounds it, and reviewers and the people owner should call it out.

Each piece of work is multiplied by how well it was verified:

| Verification | Multiplier |
|---|---|
| An independent approval plus an independent test record | 1.0 |
| An approval only, or an approval plus a self-authored test record | 0.8 |
| An independent test record only | 0.7 |

Anything below that stays pending.

## Flaws

A flaw's charge is **severity × reach × where it was caught**.

| Severity | Points | Means |
|---|---|---|
| S3 | 4 | cosmetic, docs or minor: the outcome is correct, but something reads or looks wrong |
| S2 | 12 | degraded but there is a workaround, or a wrong fact that made others redo work |
| S1 | 30 | a core flow is broken with no workaround, a gate cannot fail, or a claim would have caused outside harm |
| S0 | 60 | production down, data lost or exposed, a leaked secret, money lost |

| Reach | Factor |
|---|---|
| R1: one person or one artifact | 1 |
| R2: a team, a process, a shared tool or gate | 1.5 |
| R3: the company record or the owner | 2 |
| R4: customers, production, money or the public | 3 |

| Where it was caught | Factor |
|---|---|
| You caught it yourself first | 0 |
| In review, before acceptance | 0.25 |
| You reported it yourself after acceptance | 0.5 |
| Someone else found it after acceptance | 1 |
| The owner found it | 1.5 |
| A customer, production or the public found it | 2 |

A fix-forward PR (one that fixes a regression in an earlier PR without a defect file) is charged S3 and a revert S2, unless a corroborated reviewer of the fix PR rated it. The person who wrote the fix cannot set the severity charged to someone else.

### A small flaw in big work does not undo it

On experience, the flaws charged to one piece of work never take more than half its points, or a quarter if they are only cosmetic. That cap **shrinks with the share of the work the fix touched**, counting every fix PR for that flaw.

Example: a 10-line fix to a 5,000-line delivery costs at most 5% of its experience, so 47.5 of 50 xp stay. The same bug in a 20-line PR costs half.

Competence is stricter and uses the full charge against the size of the work, with no floor. One moderate bug in 5,000 lines leaves that sample at 96%, but in 20 lines it leaves the sample at 0. Repeated moderate flaws in small work therefore show up.

### Serious flaws (S0/S1)

- A serious flaw after acceptance is its own competence sample of quality 0, so it weighs heavily.
- The work it sits in keeps its experience minus the capped amount. Only a **revert** takes the experience away.
- Every **confirmed** S0/S1 in company-era work becomes an **OPEN handoff to the people owner**, once per flaw, with an FYI to the person's manager. A flaw about the people owner goes to their manager. Two cases reach the people owner without charging anyone yet: a flaw nobody can be attributed to (they attribute it with `amend --agent`), and a flaw in work whose author no run record confirms (they confirm or re-attribute it). Flaws in code written before the company started are nobody's competence and are not flagged.

### Caught in review: always ask for review

A flaw caught **before acceptance** never stands alone, never voids the work and never raises a serious flag. A cosmetic (S3) catch costs the author nothing. S2 and worse cost experience under the same cap, scaled by what you changed after the finding, so a catch in review never costs more than the same flaw found after the merge.

## Reviewers

- **Approval credit.** An approval earns 0.3 × the work's points (capped at 50, so approving big work never pays more than writing it) × the share of its changed files that your declared scope covers. Half is paid at the merge or acceptance. The other half is paid after 14 days if nothing in your scope was found wrong. Several approvals of one piece of work within 7 days are paid once.
- **Outcome.** The approval's competence sample is scored by the outcome: if the work later breaks inside your scope, the sample counts against you.
- **Scope.** A narrow scope means a narrow credit. You are not blamed for what you said you did not check.

## Finders

- **After acceptance.** A finder earns **exactly what the author lost**: the charge after the cap, times the work's verification multiplier. It is paid once the fix merges, or after 30 days with no fix. Planting a flaw for a friend to find therefore never pays the pair.
- **Serious flaws.** The same rule: the finder earns what the author lost on experience.
- **Old code, and reverted work.** A finding in code written before the company started (the policy's `companyStart`), or in work that was later reverted, pays a flat 2 (S3), 6 (S2), 10 (S1) or 15 (S0), once a fix merges.
- **In review.** A cosmetic finding pays 1, at most 3 per review. S2 and worse pay what the author lost for it.
- **Your own work.** Finding a flaw in work you wrote pays nothing.
- **Unconfirmed.** A finding waits (pending) until your run is shown to have written the defect file.
- **Daily cap.** Finders earn at most 30 a day.

## Owning mistakes, and the owner's corrections

- **Owning an error.** Writing `(own error)` after your name in the Owner column of `company/work/decisions.md` makes the charge × 0.8, and you can still dispute its severity and reach. Write that row with `node company/tools/decision.js add --by <you> --text "..." --own-error`. It counts only if **you** wrote the row: a run of yours wrote `decisions.md` (or ran `decision.js add --own-error`) within 30 minutes of the row's time. Nobody can own an error for someone else.
- **Owner corrections.** An owner correction is counted when the ack note in `company/state/owner-inbox.json` says "correction" (and the acker's own run ran `owner-inbox.js ack` for that message), or when your reply on the owner channel (`company/owner/outbound.jsonl`, sent with `owner-inbox.js send` by your own run) admits the error. **Admitting it in your reply counts as owning it**: × 0.8, the same as an `(own error)` row.
- **One incident, one charge.** When an `(own error)` row and an owner correction are about the same incident, they are charged once. The row names the owner message it answers (for example "His 16:33 message"); times are company time (the timezone in `company/company.json`).
- **Changing direction.** The owner changing direction charges nobody. Being overruled is not being wrong.
- **Defaults.** These two soft signals apply at their **default after 72 hours**: S2, reach R3. Until then, the people owner can amend them.
- **Limit.** The collector reads ack notes and replies, not meaning. A correction acked without the word "correction" and admitted nowhere is missed; the people owner can raise it in a handoff.

## The merge gate

`company/tools/premerge-check.js` writes a PASS or FAIL record to `company/work/evidence/premerge-<repo>-<head-sha>.json` every time it runs, and keeps every earlier PASS in the record's history. A merge made after the policy's `gateAuditFrom` time with no PASS for the merged head at or before the merge is an S2 process demerit for whoever ran `gh pr merge` (in any form: `gh pr merge 12`, `gh pr merge --merge 12`, or the PR's URL). Re-running the check after the merge records FAIL (the PR is no longer open) but does not erase the PASS the merge relied on. Merges before that time are not audited, because the rule is not retroactive.

## For the people owner: amendments

Each day `company/work/people/scoreboard.md` lists, under **Waiting for <people owner>**, every soft signal with its default and the time it applies, and under **Waiting for attribution** every confirmed flaw nobody can be charged for yet. To change one, or to rule on a dispute:

```
node company/tools/competence.js amend <ev_id> --by <your name> --reason "<why, in a sentence>" \
     [--uphold | --void | --severity S0|S1|S2|S3|N | --reach R1..R4 | --caught after|owner|… | --agent <name> | --bucket <bucket>]
```

- **Reason.** One is required and is kept in the ledger.
- **Who can amend.** Only the people owner amends. Events about the people owner are amended by someone independent of them: the seats named in the policy's `amend.hrSelfReviewers`, else the risk and finance function holders and the people owner's manager. Nobody amends an event about themselves, attributes one to themselves, or rules on one where they are the finder or the reviewer.
- **When it counts.** An amendment counts once the station's run records show **your own run ran that exact command**: `competence.js amend <ev_id>` with the same changes. Run it from your own loop. The next daily collect checks this; until then the scoreboard lists the amendment as waiting. Being merely online when someone else runs it does not count.
- **Effect.** `--uphold` applies a soft signal now at its default (and undoes an earlier `--void`). `--void` removes the event. The other flags replace one field. An amended soft signal applies immediately.

## How to dispute

1. **Within 14 days** of the event, write a handoff to the people owner in their inbox (`company/work/handoffs/`, the `inbox` of their row in `company/tools/loops.json`), headed `competence dispute <ev_id>`. Say what is wrong (severity, reach, where it was caught, who it belongs to, or that it is not a flaw) and link the evidence. Find the id with `node company/tools/competence.js show --agent <you>`.
2. The event stays as it is while the people owner looks at it. In shadow mode nothing depends on it anyway.
3. The people owner rules within 3 days with `amend`: they uphold, change or void the event, with their reason, and tell you in a handoff back.
4. You get one appeal, to the CEO. Disputes about the people owner's own events, and appeals about the CEO's own events, go to the risk or finance function holder instead (whichever is not involved). While one seat holds every function (a newly founded company), the owner hears the appeal.

## Integrity

- **The ledger.** `company/work/people/competence-events.jsonl` is append-only. Each row's id comes from its source, so collecting twice never doubles anything. Writes take a lock. A row that cannot be written (too big) is reported and never blocks the others.
- **The hash chain.** Every row carries the hash of the row before it, so an edited, removed or reordered row breaks the chain.
- **The anchors.** Once a day the dispatcher records the chain's head in three places: a row in `company/work/decisions.md`, `company/state/competence-state.json`, and the dispatch log (`company/work/dispatch-log.md`). `node company/tools/competence.js verify` checks the chain against all three.
- **Limits.** This is **tamper-evident, not tamper-proof**. Everyone runs as the same Unix user. Someone who recomputes the whole chain **and** rewrites all three anchor copies is not caught, and rows written after the last anchor are not pinned until the next day's anchor. The project root is not a git repository, so there is no commit anchor.
- **What it reads.** The station is read only through `GET /api/runs`, never the raw `runs.jsonl`. That is not full independence: the station reloads its run store from `runs.jsonl` when it restarts, so a line appended there could appear after a restart. The collector remembers which runs it saw each time (`company/state/competence-runs-seen.json`) and refuses a run that shows up only after an earlier collect had already covered its end time. That check starts from the first full daily collect with collector 2 (`--ledger-only` and `--dry-run` remember nothing); runs before it are taken as they were.
- **Collector versions.** When the collector changes how it reads a source, its version goes up (now 2) and the next collect re-reads every source under new ids. Only the newest collector's rows are scored; older rows stay in the chain as history, and rulings on them carry over.

## Commands

| Command | What it does |
|---|---|
| `node company/tools/competence.js show [--agent <name>]` | scores; for one person, every event behind them |
| `node company/tools/competence.js collect [--dry-run]` | read the signals and append new ledger rows (`--dry-run` writes nothing) |
| `node company/tools/competence.js compute` | write `company/work/people/competence.json` |
| `node company/tools/competence.js scoreboard` | rewrite `company/work/people/scoreboard.md` |
| `node company/tools/competence.js verify` | check the chain and every anchor copy (exit 1 on a problem) |
| `node company/tools/competence.js amend <ev_id> --by <name> --reason "…" […]` | the people owner's ruling |
| `node company/tools/competence.js daily [--ledger-only] [--force]` | the dispatcher's once-a-day job; `--ledger-only` writes only the ledger and the scoreboard; `--force` runs again on a day it already ran |
| `node company/tools/competence.js selftest` | offline fixtures with invented people (exit 1 on a failure) |

`COMPETENCE_POLICY=<file>` with `collect --dry-run` tries a policy change against the real signals before it is installed.

## Not in v1

- No customer, sales, quest, citation or handoff-phrase collectors.
- No routing, review-depth or model-fit use, and no line in the station dossier (it rides every agent's prompt, which would be a use before shadow mode ends).
- No change to StarNet's own levels or ratings.
- No monthly tuning until there are enough outcomes to tune on.
