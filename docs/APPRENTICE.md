# The apprentice

The apprentice is an experimental self-learning model server run by the owner on their own hardware. It learns by
**shadowing** the crew's real work. The crew keeps working on the production models, and the apprentice gets the same
jobs afterwards, once their results have been validated. Its answers are scored and sent back to it as lessons. On a
schedule it studies those lessons, and CaPheOS decides from the model bench whether what it learned is better.

The tool is `company/tools/apprentice.js`. Its library is in `company/tools/lib/apprentice/`:
- `adapter.js` holds the wire shapes.
- `client.js` is the HTTP client and the bench driver.
- `lessons.js` makes the lessons and scores them.

## The rules (owner rulings, 2026-11-21)

- **It is an untrusted intern.** It never runs as one of our agents: no seat, no station run, no tools, no shell, no
  writes. The client talks only to the configured apprentice host, offers no tools (the chat body never has a `tools`,
  `tool_choice` or `functions` key) and asks for a single answer.
- **Its output is never used for company work.** What it returns is only an input to scoring and to the lesson sent
  back to it. Nothing it says is written to a handoff, a prompt, a company file or a seat. The logs under
  `company/state/apprentice/` hold scores, counts and reasons only, never its words.
- **Sandbox company only.** It runs only when `lib/selfimprove.js isSandbox(root)` is true. That is the company that
  `company/state/selfimprove.json` names as `sandboxRoot`. In production it is always off.
- **Every request is scrubbed** by the same outbound secret scrub used for OpenRouter (`lib/outbound-scrub.js` with
  `lib/secret-patterns.json` and every value in `secrets/`). If the scrub fails, nothing is sent. Replies are scrubbed
  too. The key travels only in the `Authorization: Bearer` header.
- **It never approves its own learning.** This tool is the external approver. A candidate is promoted only when the
  model bench, run by us through a direct client, shows a gain with no level worse. If the server refuses a promote
  (403), the refusal is logged as `refused-by-server` and never retried.
- **Off by default.** It stays non-routable until the owner switches it on, and the routing switch is a separate one
  (see "Scores and routing").
- **What leaves the machine:** each lesson carries the job's text and a snapshot of the files the production run read.
  That is company content, not only secrets (secrets are scrubbed out), and it goes to the owner's own machine. The owner
  approved this for the sandbox company.

## How it works

1. **The crew works as normal** on its production models. The apprentice adds no production model calls and reuses
   outputs that already exist.
2. **Picking validated jobs.** Each shadow pass reads the house ranking's per-item analysis (`model-rank.js` `load` +
   `analyze`, the same signals the ranking uses). A finished item qualifies when all of these hold:
   - it is **settled**: closed more than `oneShotWindowDays` ago (default 7), so the undo window has passed;
   - it was **done in one shot**: `oneShot === 1`, meaning no REVISE, reopen, revert or fix-forward
     (`ranking-policy.json oneShot.failOn`);
   - it is **hard**: never reopened or reverted;
   - it was **not delegated** (no child runs, no split lanes): its answer is one run's, not a stitch of several;
   - it has a primary run;
   - it was not shadowed before. An item skipped only for its kind, its facts or a missing transcript is looked at
     again when the shadow scope (kinds, depths, the fact rules) changes; a scored item never is.

   `shadow.requirePassVerdict` (default off) also requires a passing review verdict. It is off because lookups are rarely
   reviewed.
3. **Building the task.**
   - **The instructions** are the item's handoff block, cut at the first `**Resolved`, `**Status`, `**Verdict`,
     `**Result`… line. Any remaining line that contains one of the answer's values is also dropped, so the prompt never
     leaks the answer.
   - **The read snapshot** is taken from the run's StarNet transcript (`.starnet-data/workspaces/transcript-history-v2`).
     It holds the results of the run's `fs_read`, `fs_list`, `fs_search` and `notebook_read` calls, plus `shell_exec`
     commands on a read-only allowlist (`cat`, `sed -n`, `head`, `tail`, `grep`, `rg`, `jq`, `ls`, `wc`, with no
     chaining, redirects or substitutions). Each file is capped at `maxFileBytes` and the whole snapshot at
     `maxReadBytes`.
   - **Several runs:** when the item's seat ran it more than once, the **last** own run is the one that finished the job,
     so its answer is the teacher's; what all the seat's runs read is the snapshot.
   - **Never sent, whatever the scrub would do:** a read whose path or command names `secrets/`, a `.env` file, a key or
     certificate file (`.pem`, `.key`, `.p12`, …), `id_*` SSH keys, `.ssh/`, `.netrc`/`.npmrc`/`.git-credentials`,
     anything with "credential" in it, or StarNet's own data outside the transcripts (`shadow.denyPaths` overrides the
     list, as regular expressions). Everything else is scrubbed by the outbound secret scrub.
   - **Choosing segments:** only the segments whose index lists the run's stream are read. If none lists it, the
     segments whose time range covers the run are read instead, oldest first, all of them up to `maxSegments` and
     `maxTranscriptBytes`. A pass reads at most `maxPassReadBytes` (256 MB) of segments from disk; the rest waits for
     the next pass.
   - **Late transcripts:** transcripts are written late, in batches. If no segment reaches the run's end yet, or the
     covering segments hold no row of the run yet, the item waits (`waiting-transcript`). After `maxWaitDays` it is
     dropped as `no-transcript`. Neither is ever a failure.
4. **The teacher answer** is the production run's last assistant message without tool calls. If that is empty, the
   block's `**Resolved…**` text is used, then the run's `deliveryText`. It is parsed into labelled facts from
   `Label: value` lines, `**Label:** value`, two-column table rows and `label — value` bullets. Fenced code and headings
   are ignored.

   **Only grounded facts count.** A fact is kept only when its value appears (normalised: case, markdown, thousands
   commas, whole words) in what the run read. Production answers are often status lines ("Blocked: five items, none on
   me") that no input contains; grading the apprentice on those would measure nothing. An item with no grounded fact is
   skipped as `teacher-ungrounded`, and the shadow log counts the facts dropped per item (`ungrounded`).
5. **Kind and depth.** The first of these that applies wins:
   1. a `**Kind:**` / `**Depth:**` line in the block;
   2. the wake's `route.scoped` (written by scoped routing);
   3. the class maps `shadow.kinds` and `shadow.classDepth`, which mirror routing-policy `scoped`.

   Mechanical work is capped at simple. A content check then refines the kind: facts that are mostly numbers with a unit
   or currency become kind 5, and kind 2 with fewer than two facts becomes kind 1. Only `allowKinds` (1 lookup,
   2 extract, 5 numbers) at `allowDepths` (lookup, simple) are shadowed. Anything else is logged as `kind-out-of-scope`.
   Writing (kind 3, which needs a judge) and code come later.
6. **The apprentice answers.** The prompt is built from the bench's own template (`B.prompt` with `sandbox: none`, no
   tools, "answer in one message"). The answer is scored with the bench's own scorer for that kind:
   - kind 1: `scorers/exact.js`;
   - kind 2: `scorers/fields-f1.js`;
   - kind 5: `scorers/exact-number.js`.
7. **The lesson** goes to the trajectories endpoint. It carries the task, the teacher answer and model, the apprentice's
   answer, the score, pass, kind, depth and source item. Its example answer (`teacher.target`, the assistant message) is
   the grounded facts **in the bench's own answer shape**, a fenced json block (kind 1 `{answers:[{id, value}]}`, kind 2
   `{fields}`, kind 5 `{values, unit}`), so it teaches the answer and the format the bench grades. The teacher's prose
   is kept only as context (`teacher.answer`).
8. **Study, bench, decide.**
   - **When:** in the quiet hours (`study.hourLocal`, default 03:00 company time, for `quietHours` hours), at most every
     `everyHours` (24).
   - The tool asks the apprentice to study, then lists its units. Each new candidate that is **ready** (a candidate
     status: candidate, pending, trained, ready, staged, proposed; at most `maxCandidates`) is benched against the live
     version through the direct client, with kinds `study.kinds` at `study.depths`. A unit still training or queued is
     not benched and not rolled back: it waits for a later cycle (`not-ready`).
   - Both runs use the same fresh random seed (a new seed each cycle, so it cannot memorise instances) and the same
     `repeat` (2).
   - **Promote** only when the total passed count rises and no (kind, depth) level loses more than `tolerance` passes
     (default 0). A level the live version proved and the candidate could not be scored at counts as worse. Otherwise
     **roll back**.
   - **A server fault decides nothing.** If either bench has an instance that failed as crash, timeout, refused or
     sandbox (an HTTP error, a reset, a deadline), nothing is promoted or rolled back and the decision is logged as
     `incomplete`. Otherwise a live model id that errors would score 0 and let any candidate through. After
     `maxIncomplete` (3) such cycles the unit is left alone (`undecided-server-faults`), never rolled back for it.
   - If the study budget (`study.wallBudgetMin`) runs out mid-bench, nothing is decided and the next cycle tries again.
   - Every decision goes to `company/state/apprentice/decisions.jsonl` with both results, the seed and the reason.
   - A unit that was decided or refused is never tried again.
   - The bench runs only from the installed model-bench unit (`unit.js install packs/model-bench --by owner`), as for
     any real model.

## Scores and routing

- `company/state/model-bench/apprentice_<namespace>_<tenant>.json` is a normal `model-bench/1` result for the live
  version, plus `source: "bench"`, `routable: false` and the promoted `unit`. It is written through model-bench.js
  `writeResult` (writer `apprentice.js`) and keeps the `.prev.json` and `history.jsonl` line.
- `company/state/model-bench/apprentice_<namespace>_<tenant>.shadow.json` (`schema: model-bench-shadow/1`, so a reader
  of `model-bench/1` files skips it) holds the shadow scores: `kinds.<k>.levels.<depth>` with
  `{ n, passed, passRate, scoreMean, timeSecP50 }`. Its `live` array is
  `[{ model, kind, depth, n, oneShot, timeSecP50 }]`, the shape a capability table takes, marked `source: "shadow"`.
- The apprentice stays non-routable. It is not on the model-policy allowlist and the station has no apprentice
  provider. The shipped default is `routable: { "apprentice/*": false }`. Making it routable is the owner's own switch,
  later.

## Turning it on and off

The owner switches it on from the owner's own shell or the console. Agents cannot do this.

```
node company/tools/apprentice.js configure --by owner --base-url http://<host>:8420 --namespace <ns> --tenant <tenant> --key-secret <file name in secrets/>
node company/tools/apprentice.js enable --by owner
node company/tools/apprentice.js status
node company/tools/apprentice.js shadow --once --dry-run      # what would go, nothing sent
node company/tools/apprentice.js disable --by <anyone>        # the kill switch
```

How the switch works:
- **The file:** `company/state/apprentice.json` counts only as the owner's own recorded write: its newest provenance
  record must match the file, come from outside an agent's run, and be by `apprentice.js` or the console. It is
  locked-watched (class A).
- **When it is off:** a hand edit, a seat's write or a missing file all mean off and defaults only. Settings from an
  untrusted file are not carried over.
- **The kill switch:** anyone may turn it off. It is checked between items too.
- **Running:** once on, the dispatcher's tick checks `apprentice.js due()`, which is cheap and fail-safe, and starts
  `apprentice.js tick` detached, so a slow server never holds the tick. One pass runs at a time, under the lock in
  `company/state/apprentice/lock`.
- **Bounded in time:** every request has a hard total deadline (`requestTimeoutSec`, and never past the pass's own
  deadline), so a server that trickles a byte now and then is cut off too. The tick process ends itself at its wall
  budget plus 30 s whatever happens. A lock is never taken over while its holder is alive and within budget; a holder
  still alive past its budget (its self-exit failed) is ended by the next taker. A pass that throws still records its
  try, so a fault waits its normal interval instead of respawning every dispatcher tick.

Example settings for the owner's server, as a provider example (the name is the server's, not a company's):

```json
{ "baseUrl": "http://<the owner's machine>:8420", "namespace": "slaingi", "tenant": "sandbox", "keySecret": "slaingi-key" }
```

Defaults are in `company/defaults/state/apprentice.json`:

| Setting | Default |
|---|---|
| daily cap | 20 shadow jobs |
| per tick | 5 |
| shadow pass | every 60 min |
| request deadline (total) | 120 s |
| reply cap | 2 MB |
| shadow wall budget | 10 min |
| study wall budget | 120 min |
| each log | 4 MB |

The logs are `company/state/apprentice/shadow.jsonl`, `decisions.jsonl` and `log.jsonl`. They are rolled monthly by
retention with keepDays 30 (`company/defaults/work/ops/retention.json`). State is in
`company/state/apprentice/state.json`: per-day counts, the set of shadowed items, items waiting for a transcript, and
decided and refused units, and the running shadow record per (kind, depth) (`agg`), which the `.shadow.json` summary is built
from, so its counts keep building up across log rolls.

## Assumed API shapes (verify against the live server)

The server is OpenAI-compatible, with a governed learning API. **The exact bodies are not known**. Every shape below is
a guess, and all of them live in `lib/apprentice/adapter.js`, the only file to change if the server differs. The readers
are tolerant.

| Call | We send | We read |
|---|---|---|
| `GET /healthz`, `GET /readyz` | nothing | the status |
| `GET /v1/models` | nothing | the status |
| `POST /v1/chat/completions` | `{ model, messages, stream: false, temperature: 0, max_tokens, metadata: { purpose: "shadow"\|"bench", learn: false } }` | `choices[0].message.content` (or `.text`, `output_text`), `usage.prompt_tokens\|input_tokens`, `model`. An SSE reply (`data:` lines with `choices[0].delta.content`) is read too. |
| `POST /v1/<ns>/tenants/<t>/trajectories` | `{ trajectories: [ lesson + { messages: [user: the prompt, assistant: teacher.target (the right answer as a fenced json block)], reward: score } ] }` | the status |
| `POST /v1/<ns>/tenants/<t>/study` | `{ reason, requested_by: "external-gate" }` | the unit id from `unit_id \| unitId \| id \| unit.id \| candidate.id`, the status from `status \| state` |
| `GET /v1/<ns>/tenants/<t>/units` | nothing | the list from `units \| data \| items \| results` or a bare array. Each unit: id from `unit_id \| unitId \| id`, status from `status \| state`. Candidate statuses: candidate, pending, trained, ready, staged, proposed. Live: live, promoted, active, current, serving, or `live: true`. |
| `POST …/units/<id>/promote` | `{ approved_by: "external-gate", approver_kind: "external", reason, evidence }` | 2xx is promoted; 403 is refused-by-server, never retried |
| `POST …/units/<id>/rollback` | `{ approved_by, approver_kind, reason }` | 2xx is rolled back |
| `POST …/units/<id>/export-capheos` | `{}` | (adapter only; not called automatically) |

The model id is `<namespace>/<tenant>` for the live version. A candidate is targeted as `<namespace>/<tenant>@<unit id>`
(`candidateTarget: "model-suffix"`), or as the live id plus a `unit_id` body field (`"body-field"`). The lesson is:

```
{ kind: 'lesson', task: { instructions, files, prompt }, teacher: { answer, target, model }, student: { answer },
  score, pass, benchKind, depth, source: { item, runId }, at }
```

### Verify-live checklist

1. `GET /healthz` and `/readyz` answer with the key; `GET /v1/models` lists `<ns>/<tenant>`.
2. A chat call returns text in `choices[0].message.content`. Check whether the server honours `metadata.learn: false`,
   or which field turns learning off for bench calls. Without one, the apprentice may learn from bench prompts (the
   fresh seed per cycle limits this).
3. Trajectories accept our body, or note the server's field names and change `trajectoryBody`.
4. Study returns a unit id and status. Units lists candidates with a status we recognise.
5. How a candidate is called before promotion: the `@<unit id>` suffix or a body field.
6. Promote from our tool succeeds. Check that the server's 403 is for self-approval only.
7. Run `apprentice.js shadow --once --dry-run` on the sandbox, then one real `shadow --once`, and read `status`.

## Risks

- **The server grades itself in part.** The same server answers for the live version and the candidate and can tell
  them apart (the `@unit` suffix or `unit_id`), so a self-interested server could always make a candidate look better.
  The gate measures what the server returns; it has no independent truth. This is accepted because a promotion changes
  only the apprentice's own live unit, which is non-routable and never used for company work: the company is not at
  risk from a wrong promotion, only the apprentice's own scores are.
- **Company content goes to the owner's machine.** The read snapshots carry sandbox company text (not secrets: those
  are scrubbed, and denied paths are never read). This is owner-approved and limited to the sandbox. Tool results that
  StarNet marked tainted (external content) are included and counted (`tainted` in the shadow log).
- **Server errors are logged by status only.** The server's words never land in a company file, errors included.

- **The teacher parser decides what "correct" means.** Production answers that are not labelled facts are skipped as
  `teacher-unstructured`, and facts not found in the run's reads as `teacher-ungrounded`, which is intended. Watch the skip counts per reason in `log.jsonl` and `status`.
- **Six tasks per level is noisy.** Repeat 2 and tolerance 0 make the gate strict, so a noisy candidate is rolled back
  rather than promoted.
- **The apprentice may learn from the bench prompts** it is sent. A fresh seed each cycle helps; a no-learn flag on the
  server would close it.
