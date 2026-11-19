# Push wakes: an AI seat runs only when it has work (spec, 2026-11-19)

Owner, verbatim: "When a worker has work, then they should wake. So there should be like a way for the inbox to wake the
worker itself. ... Whether that's a cron job that creates work every 6 hours or 20 minutes, or it's an API endpoint that's
being monitored that comes back with an error that wakes one of the models. I really can't think of a good reason to ever
operate in ticks."

Base: CaPheOS main plus the wave3 branch (advisor consults, sign-off holds, delegation allowlist), and the planned
accountable-leads flow (work enters through the department lead's inbox). Measurements and the estimator are in
`push-wakes/` (analyze.py, estimate.py, runs-*.json).

---

## 1. The rule

1. **An AI seat runs only when its inbox holds an item it has not handled.** An item is unhandled when any of these is true:
   - it is new;
   - someone else changed it since the seat last handled it;
   - something it was waiting on happened: a dependency was met, a consult or sign-off was answered, an approval was answered, a watched job ended, or the owner said Start now;
   - its `Not before` time arrived;
   - its due time arrived. A due date fires one wake, at the start of the due day or at a set lead time, not one wake every tick;
   - the seat's own last run asked to carry on with it (`**Next:**`, section 5.4).
2. **Nothing wakes a seat to look at an unchanged queue.** The standing-queue rule (dispatch.js:1086, "N OPEN in inbox") is removed, along with the seat cron, the Sprint "changed" signature that counts its own closes, and the idle check-in.
3. **Scheduled work comes from generators.** A generator is a cron entry run by plain code, not by an AI. It appends one item to an inbox.
4. **Watching comes from monitors.** A monitor is a plain-code check: an API endpoint, service health, a price feed, error logs, or a duty. It appends one item only when something is wrong or new.
5. **The dispatcher is event-driven.** It reacts to inotify on inboxes and state files, plus a timer wheel for generators, monitors, due dates and `Not before`. There is no fixed tick. A slow safety sweep, every 30 minutes, is only a backstop and never wakes anyone on its own judgement.
6. **A wake carries exactly the items that caused it.** The run handles those items and ends. It has a per-run turn and context budget. When it hits the budget, it writes where it got to, and the next piece starts as a fresh, small run.
7. **Stalls are measured by item age, not by repeated wakes.**

## 2. What the measurement says this fixes (24 h)

| Current wake class | Sandbox runs / tokens | cpd runs / tokens | Under push |
|---|---|---|---|
| New handoff block (non-FYI) | 150 / 233M | 178 / 247M | Kept. The wake carries only the new blocks, not "work the whole queue". An acknowledgement or FYI block never wakes anyone (section 6). |
| Standing queue (same OPEN items, rest elapsed) | 165 / 120M | 44 / 46M | **Removed.** The items were already handled. They come back only by a due date, an answer or age escalation (to the lead, not the holder). |
| Sprint "changed" with nothing arrived (own close, quest moved) | (Sprint only) | 74 / 66M | **Removed.** The seat's own writes are not news to it. |
| Scheduled loop on its cron | 19 / 27M | 6 / 2M | **Removed.** Seat crons are deleted. Real periodic work becomes a generator item (section 7). |
| Watched job ended | 14 / 31M | 5 / 4M | Kept, as an event. The notify-when end writes the item, and the item is the wake. A success is a DONE note and does not wake anyone unless the item was `Waiting on: job:`. |
| Dependency met / Start now | 18 / 28M | 10 / 17M | Kept, as events (gates release → the released item only). |
| Duty finding | 10 / 18M | 33 / 31M | Becomes a monitor finding: one item per new finding key, and none while that item is OPEN. Owner-only findings, such as the provider top-up, go to the owner's Today and never to an AI seat. |
| Owner message | 2 / 1M | 4 / 3M | Kept. Highest priority, coalescing window 5 s. |
| Meeting, chat, huddle, hiring turns | 137 / 9M | 43 / 36M | Unchanged (other doors). Only their follow-up handoffs are events. |
| Delegated child runs, lanes | 0 | 21 / 28M | Unchanged. The lead's brief names the items it may delegate (section 10). |
| Pacer catch-up re-fire | 2 / 17M | 1 / 0 | Becomes "the queued event is retried when the model opens". There is no separate re-fire. |
| Station-scheduled AI routine (cpd "Fiverr inbox check every 2 h") | n/a | small | Becomes a monitor (plain code reads the Fiverr inbox and appends an item per new message) or a generator. The AI routine is switched off. |

### Estimated saving

`push-wakes/estimate.py` replays the measured runs as a counterfactual.

- **What it removes:** every no-news wake (standing queue, seat cron, Sprint changed-only, owner-only duty) and acknowledgement-only blocks.
- **What it rescopes:** every retained inbox run that held more than 2 OPEN items is priced as `newBlocks × median cost of a 1–2-item run` (0.43–0.71M), capped at its actual cost.

| Window | Measured | No-news wakes removed | Scoping to the causing items | Left | Cut |
|---|---|---|---|---|---|
| Sandbox 24 h | 484M | 147M (30%) | 155M (32%) | 177M | **63%** |
| cpd 24 h | 482M | 116M (24%) | 160M (33%) | 195M | **60%** |
| Sandbox 48 h | 1,770M | 476M (27%) | 506M (29%) | 776M | **56%** |
| cpd 48 h | 1,017M | 281M (28%) | 243M (24%) | 477M | **53%** |

- **Realistic range: a 45–60% token cut** before any model change.
  - The scoping half is optimistic, because a hard item costs more than a median item.
  - Removing no-news wakes (24–30%) is close to certain. The data already shows those runs had nothing new to do.
- **Runs:** about 30–36% fewer. A seat's run count drops from 50–67 a day to about the number of items it is sent plus their continuations. Quiet seats drop to zero.
- **The local model on top of this:** small scoped briefs are what make it usable at all. A 32k-context local model cannot run "work the whole queue", but it can handle one mechanical item with a 12k brief.
- **The 1M-context Fable runs** (65% of sandbox tokens) shrink because runs are short, not because of a model switch. Model choice stays with routing and Nadia.

## 3. Architecture

```
 producers (plain code, no AI)                        the wake planner (one Node process)            the station
 ─────────────────────────────                        ─────────────────────────────────              ───────────
 crew writes a handoff  ─┐                            event journal  ──► per-seat queue ──►  gates  ──► POST /api/cron/run
 owner channel           ├─ inotify ─►  events  ──►   (events.jsonl)     (coalesce, prio,    (admit,     {id, detach,
 approvals / signoffs /  │                              item index        quiet hours)       money,      override?, brief?}
   consults answered     │                              handled ledger                       pacer,
 notify-when job end     │                                                                   routing,
 runs.jsonl run end     ─┘                            timer wheel ──► generators (append)    tempo caps,
 generators / monitors  ◄──── timer wheel                         ──► monitors (append on    meetings,
                                                                     finding)               family, lanes,
                                                                  ──► due / Not before       consult, signoff)
                                                      safety sweep (30 min): re-index, log MISSED EVENT
```

- **One long-lived process:** `company/tools/wake-planner.js`, which replaces `dispatcher-loop.js`.
  - It keeps a small in-memory index: per inbox, item id → {heading, status, sig, waiting, notBefore, due, holder}. That is a few hundred items and well under 1 MB.
  - It re-parses only the file that changed.
- **The gate pipeline is reused, not rewritten.** dispatch.js keeps admit, money, pacer, routing, tempo caps, meeting and chat holds, family busy, consultStep, lanes, the signoff scan, approvals and the scheduler pause.
  - Its wake-source block (dispatch.js:854–1231) is replaced by an input: `dispatch.js --wakes <file>`, a JSON of seat → [{item, cause}].
  - The planner calls it as a child process only when a seat's coalescing window closes. Events are sparse, so a 50 ms Node start per decision costs less than one resident process doing everything.
  - A later part can move it in-process.
- **Run ends are events.** The planner watches the station's `runs.jsonl` (append-only; the planner tracks its byte offset).
  - A run end frees the seat, settles its items (section 5.4), and flushes anything queued for it while it ran.
  - This replaces polling `GET /api/state/snapshot` every tick. The snapshot is read only right before a start, to confirm the seat is free.

## 4. Events

### 4.1 The journal

`company/state/events.jsonl` is append-only and rolls monthly (retention.json `events`, 30 days). One row per event:

```json
{"at": 1795001995149, "id": "ev-…", "kind": "item.new|item.changed|answer|dep.met|startnow|due|notbefore|continue|job.ended|owner.msg|generator|monitor|run.ended|consult.answered|signoff.answered|audit.accept|audit.revise|hiring|sweep.missed",
 "seat": "nadia", "item": "to-nadia.md#a1b2c3", "by": "kwame | generator:weekly-report | monitor:bao-api | owner | dispatcher",
 "prio": 0, "words": "Kwame sent Nadia \"Check the backtest numbers\""}
```

`words` is the plain sentence the owner's Today shows. It is written once by the producer, never by an AI.

### 4.2 Producers

| Producer | Watched / scheduled | Emits |
|---|---|---|
| Inbox watcher | inotify on `company/work/handoffs/` (debounce 2 s per file) | `item.new` for a new block id. `item.changed` when a block's body sig changed and the writer is not the holder (5.3). An OPEN→DONE close by the holder emits nothing. |
| Owner channel | `company/owner/` | `owner.msg` (prio 0), routed as today: owner-addressing.js, then the CEO. |
| Gates | approvals.jsonl, signoffs.jsonl, consult records, `company/state/releases` (Start now), completions | `answer`, `signoff.answered`, `consult.answered`, `startnow`, `dep.met`, each for the one item that waited. The planner re-resolves `Waiting on:` only for items whose dependency names the thing that changed. It keeps a reverse index dep → items. |
| notify-when | its job-end write (notify-when.js already appends the completion record) | `job.ended`. The FAILED item written into the inbox becomes the wake. |
| Run-end watcher | station `runs.jsonl` | `run.ended` (internal: settle and flush). |
| Timer wheel | next fire of every generator and monitor, every `Not before`, every due trigger, every coalescing window and quiet-hours end | `generator`, `monitor`, `notbefore`, `due`. |
| Hiring | hire.js round stage changes (a file write in company/hiring) | `hiring` to the deciding seat (as hiringWakes today). |
| Safety sweep | every 30 min, plus once at start-up | Re-indexes every inbox and compares with the index. Any unhandled item with no event is emitted as `sweep.missed` and logged `MISSED EVENT`, a bug signal with a counter on the console. It never wakes for unchanged items. |

### 4.3 The timer wheel

The wheel is one sorted list of `{at, kind, ref}` with a single `setTimeout` set to the earliest entry. There is no polling.

- On start-up, and when any config file changes (generators.json, monitors.json, quiet hours, an inbox's `Not before` or `Deadline` lines), the affected entries are recomputed.
- Clock jumps, from suspend or NTP, are handled by re-arming the wheel on `run.ended` and on every sweep.

## 5. Handled, scoped runs

### 5.1 The handled ledger

`company/state/handled.json` keeps, per seat and per item id, `{sig, at, runId, outcome}`. It records the item's body sig at the end of the last run that was given that item.

- An item is unhandled when its current sig differs from the recorded one, the item is new, or an event of kind answer, due, notbefore or continue names it.
- Item ids come from `W.itemId` (lib/wakes.js): the `**Id:**` line, or `<inbox>#sha6(heading)`.
  - Generators and monitors always write an `**Id:**` line, so re-dating a heading never makes a new item.
  - The handoff writer (handoff.js) gets an `--id` default, a slug plus a date, so crew blocks carry ids too. A block without one still works through the derived id.

### 5.2 The wake brief

Every wake carries exactly its items. The brief is delivered two ways, the first now and the second later:

1. **A file, for now.** The planner writes the brief to `company/state/briefs/<seat>/<wakeId>.md` before the start, and the loop prompt points the run at the newest unconsumed brief. One run per seat at a time makes this safe. Sprint lanes get one brief per lane. The brief contains:
   - wakeId and budget;
   - per item: the file, the id, the heading, the cause in plain words ("new from Kwame", "Ingrid answered your consult", "due today", "your last run said Next: run the backtest again");
   - a line count of FYIs since the last run (not their text).
2. **A StarNet patch, later.** `0019-per-run-brief.diff` lets `POST /api/cron/run` take `{brief, maxTurns}` for one run, the way 0017 takes a model. The brief is appended to the routine prompt, and `maxTurns` becomes a hard turn cap. Without the patch, the file brief and a soft budget line in the prompt are used.

The loop prompts change in hire.js:855, founder-loop.js:91 and dossier.js:140.

**Before:**

> WORK THE QUEUE. Keep taking items until your queue is empty... Do not stop after one item.

**After:**

> Read your wake brief (company/state/briefs/<you>/, the newest one). Handle only the items it names, in its order. For each item, end in exactly one of these:
> - DONE with Resolved;
> - `**Waiting on:**` naming what you wait for;
> - `**Not before:**` naming a time;
> - `**Next:**` with the one next step, when you ran out of budget;
> - a handoff to your lead saying why you are blocked.
>
> Do not open other inbox items. If you see something else that needs doing, write it as a handoff or an improvement line. Stop when the brief's items are settled or when you reach your budget (about N tool steps).

The charter reads stay, but the run reads only the role file. HANDOFFS.md, DECISION_RIGHTS.md and CHAIN_OF_COMMAND.md move into the seat's injected profile, so they are not re-read every run. That saves about 10–25k tokens on every turn after the reads.

### 5.3 Whose write is it

A change only counts as news when someone other than the holder made it.

- **Main source:** writer attribution from provenance (lib/signoff.js already uses `provenance.recentCalls`).
- **Fallback:** a change to an item in seat S's inbox made while S had a run live, inside S's workdir lease, is S's own.
- The cost of a wrong guess is one missed wake, and the safety sweep does not catch it. The rule is therefore: when the writer is unknown, it counts as news. One extra small wake is cheaper than a silently lost answer.

### 5.4 Settle at run end

On `run.ended`, for each item in the brief:

| What the item shows | What the planner does |
|---|---|
| DONE, `Waiting on`, `Not before` | Records it as handled. Done. |
| `**Next:**` added or changed by this run | Queues a `continue` event, a fresh run with only this item, after a gap of 1 min. A cap of 3 continuations per item per day applies. Past the cap, the item goes to the lead as "has taken N runs" (7). |
| Still OPEN and unchanged, no state line | Records it as handled at this sig, with outcome `unsettled`, and adds one count to the item's no-move counter (7). The seat is **not** re-woken. |
| The run failed to start or work (quota, refusal, outage; failure codes as in dispatch.js:1062) | The event is put back in the queue, and the pacer or model-open signal retries it. It does not count as a run. |

Events that arrived while the run was live, for any item, form the next wake, which starts at once, without a rest.

### 5.5 Budgets

Budgets are set per run, in `company/work/ops/wake-policy.json`, per model class:

```json
{ "budget": { "default": {"turns": 25, "contextK": 900},
              "fable":   {"turns": 20, "contextK": 700},
              "flash":   {"turns": 40, "contextK": 400},
              "local":   {"turns": 15, "contextK": 24} },
  "maxItemsPerWake": 3 }
```

- **`maxItemsPerWake`:** when more items are queued, the rest wait for the next wake, which starts at once after the first run ends. This also stops Vy-sized runs (4–15 items, 77–215 turns). Several small runs cost less than one long one, because context grows on every turn.
- **Turns:** with 0019, a hard cap. Without it, the prompt asks the run to write `**Next:**` and stop at about N steps. The station's 90-minute stop stays as the outer limit.
- **contextK:** a routing input, so an item whose brief and files exceed a model's context is never sent to it (the local model). It is not a hard cap.

## 6. Dedupe, coalescing, priorities, quiet hours

### Coalescing

Each seat has a window: the first event opens it and later events join it. It closes after a quiet period or a maximum, set per priority:

| Priority | Quiet / max | Examples |
|---|---|---|
| P0 | 5 s / 15 s | owner message; monitor `severity: high` (production down, money at risk) |
| P1 | 20 s / 90 s | someone is waiting on this seat (blockersOf); due today; an answer to the seat's own consult or sign-off |
| P2 | 2 min / 10 min | a normal new or changed item, a generator item |
| P3 | never wakes | FYI. It goes into the next real brief as a count. |

A lead's audit items use 10 min / 30 min (section 10), so several audits share one lead run.

### Dedupe

- Several events for the same item collapse into one, keeping the strongest cause.
- **No acknowledgement ping-pong.** A block wakes its receiver only when it is OPEN, has a `**Need:**` line, and is not FYI. That means no `Status: DONE — FYI`, no heading starting "FYI", and no block whose only content is a reply to a block the receiver sent.
  - handoff-status.js already lints blocks. A block that fails the rule is P3 and gets a lint note to its writer in that writer's next brief.
- **Generators:** a generator does not append while its previous item is still OPEN. It logs "skipped: last week's report is still open" and adds one to the generator's skip count shown on the owner page.
- **Monitors:** one OPEN item per finding key. Repeats update the monitor's own state file, not the item, so the item's sig does not move and nobody is woken. A new key, or a severity going up, is a new event.

### Priorities across seats

The current order is kept: owner, then hiring, then urgent, then revenue priority, then soonest due (dispatch.js:1236). The order now applies to queued wakes when slots or money are short.

### Quiet hours

`wake-policy.json` sets `quiet: {from: "22:00", to: "07:00", allow: ["P0"]}`, owner-editable.

- P1 and P2 events wait in the queue, and the wheel holds an entry for quiet-hours end.
- Generators fire on time. Their item waits like any other.
- P0 always goes through. The owner can widen `allow` to include P1, for example during a launch week.

The tempo caps (cadence.js:406–416, wakes per hour and per day) stay as a safety net. The per-tick limit `maxPerTick` becomes `maxConcurrentStarts` (default 4).

## 7. Stalls by item age

The seat-level stall rule (`STALL_AFTER` = 3 wakes with no progress, dispatch.js:92, lib/stall.js) is replaced. Under push, repeated wakes no longer happen, so they cannot be the signal. The planner tracks, per item:

| Measure | Rule (wake-policy.json `stall`) | Who is told |
|---|---|---|
| **No-move runs:** runs given the item that ended unsettled (5.4) | ≥ 2 | The holder's lead, as one item in the lead's inbox (accountable-leads: one level up). Never the holder again. |
| **Age since it became work**, with the clock stopped while waiting, in Not before, or held by money or a meeting | > `ageHours` per priority (P1 8 h, P2 48 h) | The lead |
| **Past its Deadline and OPEN** | At the due trigger + 1 working day | The lead. The CEO only for cross-department items. |
| **Held for a slot or money** for > 4 h | | Owner Today, plain words: "3 jobs are waiting because today's budget is spent". Not an AI seat. |
| **Continuations over the cap** (5.4) | > 3 per day | The lead |

- The SLOW note (dispatch.js:1065–1076) becomes the "past Deadline" row.
- STALLED lines are kept for the log, with item wording: "Nadia's item 'Backtest v3' has had 2 runs without moving".

## 8. Generators

### File

`company/work/ops/generators.json` is class B, with provenance. The owner edits it through the console, and agents propose changes through `changes/`.

```json
{ "id": "weekly-revenue-report", "name": "Weekly revenue report", "on": true,
  "when": { "every": "week", "day": "mon", "at": "09:00" },
  "to": { "department": "finance" },
  "item": { "heading": "Weekly revenue report for the week ending {weekEnd}", "need": "…", "why": "…",
            "deadline": "+1d", "effort": "mechanical", "prio": "P2", "tier": "local" },
  "ifStillOpen": "skip", "createdBy": "owner", "createdAt": "…" }
```

- **`when`:** plain fields (`every: hour|day|week|month`, `at`, `day`, or `everyMinutes`). Cron syntax is never shown to the owner, though a `cron` string is accepted from tools.
- **`to`:** a department, which resolves to its lead (accountable-leads, intake through the lead), or a seat id.
- **`tier`:** a routing hint, so mechanical generated work can go to the local model.
- **The runner** is plain code in the planner's timer wheel. It appends the block through `appendHandoff` with `**Id:** gen:<id>:<period>` and `**From:** generator <name>`.
- **Where a generator comes from:** the owner, or a seat that proposes one ("I need to re-check the price feed every morning"). A seat's proposal becomes a generator only after its lead accepts it, or the owner does, when it is the CEO's. This replaces seats asking for faster tempo.

## 9. Monitors

### Contract

Monitors generalise the existing duty contract (lib/duty-runner.js): `node <tool> --duty` exits 0 when nothing is due, or exits 1 and prints `{due, reason, route, key, items}`. Every duty is a monitor already. New kinds are declared in `company/work/ops/monitors.json` and run in-process by the planner (no AI, no shell):

| Kind | Config | Finding when |
|---|---|---|
| `http` | url, method, expect status / body regex / max latency, timeout | it fails `failAfter` checks in a row (default 2), and when it recovers |
| `service` | systemd unit or docker container name | not active, or restart count went up |
| `log` | file path or journal unit, regex, byte offset kept in state | a new matching line (key = normalised message) |
| `feed` | url + JSON path, threshold or change % | the threshold is crossed (with hysteresis) |
| `file-age` | path, max age | the file is stale |
| `inbox` | an external inbox the company reads (the Fiverr API or an IMAP folder) | a new message id |
| `duty` | the existing duties | as today |

### Rules

- **Cadence:** each monitor has an `every` (default 5 min for http and service, 15 min for others), jittered, run one at a time. Two at a time is allowed for http with a 5 s timeout.
  - Polling by plain code is cheap and fine: an HTTP check costs a few kB and milliseconds. The rule is that no AI polls.
- **Routing:** `route: department | seat | owner`. A route of `owner` (the provider top-up, a card to renew) goes to the owner's Today and Notices and never wakes an AI seat. This fixes the 12 Founder wakes (26M tokens) and 15 cpd wakes (18M tokens) for the DeepSeek top-up.
- **Severity:** `low | normal | high`. High is P0.
- **`autoClose`:** on recovery, the monitor appends "cleared at …" and sets the item DONE itself, when nobody has touched it. Nobody is woken.
- **Converting the current AI pollers:**
  - "Fiverr inbox check (every 2 hours)" on the cpd station becomes an `inbox` monitor when an API or mail feed exists. Otherwise it becomes a generator at the same cadence that the cpd owner can slow down.
  - "Bao API log watch" (already off) becomes a `log` or `http` monitor.

## 10. Fit with wave3 and accountable leads

| Wave3 / leads piece | Under push |
|---|---|
| **Consult hold** (`CONSULT_HOLD`, dispatch.js:977) | The item is `waitingOn: consult` and is not news. The consult is an item in the lead's inbox: an event for the lead's **advise** routine (door consult), coalesced by consultStep's batching. The answer is `consult.answered`, an event for the holder with only that item. consultStep runs on consult events and on a wheel entry for its own timers (holdMaxHours, stuck consults), not every tick. |
| **Consult trigger `stuckAfterIdleWakes`** (lib/consult.js:229–256) | Renamed `stuckAfterNoMoveRuns`. It counts runs given the item (wakes.jsonl items are now exactly the brief) that ended with the item unmoved, the same counter as section 7. Add `stuckAfterHours` (item age). `stuckAfterFailedRuns`, `stuckAfterRevise` and `stuckOnReopen` are unchanged. The order of escalation is a consult first (cheap advice), then the lead stall (7). |
| **Sign-off hold** (`SIGNOFF_HOLD`, dispatch.js:978) | The held block is not news for its receiver. scanTick's "open one sign-off item in the counterpart's inbox" is an `item.new` for the counterpart. The yes or no is a `signoff.answered` event, and only then is the block an `item.new` for its receiver. scanTick runs on inbox events (it scans changed files only) and on a wheel entry for holdMaxHours. |
| **Delegation allowlist** (0018, delegate-allow.json is refused when **older than 30 min**) | **Must change with push:** with no tick, the file goes stale and fails closed. The planner rewrites it on every start decision for a routine lead (before `fireRun`) and on a 15-min wheel entry. That is plain code and cheap. Keep the station's 30-min refusal. |
| **Family busy** (live child runs, lib/family.js) | Child-run starts and ends come from runs.jsonl. A worker on a live child run is busy, and its queued items wait for its `run.ended`. |
| **Sprint lanes** (lanes.js) | A lane is a wake with its own brief (its subset of independent items). Lane planning uses the brief's items instead of the whole inbox. |
| **Accountable leads: intake through the lead** | Generators and monitors route `to: {department}` → the lead. The lead's brief carries the new intake. The lead assigns by writing a block to a member, which is an event for the member with that one item. A block sent straight to a member is copied to the lead as P3 (FYI count, no wake), as the leads spec says. |
| **Worker self-check → lead audit** | When the worker sets an item to "ready for audit", the audit packet (the diff, the acceptance check and the self-check note) is appended to the lead's inbox as an `audit` item, P2 with the 10-min window, so several audits share one lead run. ACCEPT is `audit.accept`, which releases the onward handoff, the merge and DONE: a new hold kind `AUDIT_HOLD` beside the consult and sign-off holds. REVISE is `audit.revise`, an event for the member with that item only. |
| **Escalation one level at a time** | Section 7 always tells the holder's lead, never the CEO directly, except for cross-department items and the four owner matters. |
| **Lead scorecard** | Gets `time-to-handle` (event → settled) and `runs per accepted item` from events.jsonl and handled.json. No new measurement code is needed in seats. |

## 11. Migrating the current loop routines

1. **Seat crons are removed.** The scheduler mode `dispatcher` (lib/scheduler.js plan) already pauses crew loop routines on the station. Push adds:
   - `scheduleOf()` returns null for every crew loop;
   - `cadence.json` `seats[*].schedule` is ignored (the console shows it as "retired: work now comes from generators");
   - hire.js and onboard.js stop writing a schedule for new hires.
   - The routine itself stays, because it is the thing `POST /api/cron/run` starts, with `enabled: false` on the station.
2. **Scheduled work that was real becomes a generator.**
   - A one-off migration tool, `push-migrate.js` (dry run by default), lists every seat cron and every station-scheduled AI routine with what its runs did over 7 days, from runs.jsonl and wakes.jsonl. It proposes a generator only where the runs produced a recurring deliverable, such as a daily report, a weekly review, the Founder's hourly look or a market open check.
   - The rest are listed as "check-in, removed". The owner approves the list once, on the generators page, in plain words.
3. **The Founder's 60-min loop** is replaced by a generator for the owner's daily brief (`at 08:00`) and by events. The CEO still gets owner messages, escalations and cross-department items.
4. **The station's own cron for AI routines is turned off.**
   - Any enabled routine with an agent and a schedule is paused by the planner at start-up, logged, and listed on the generators page as "moved here".
   - Only `noAgent` script routines stay on the station cron: the watchdog. The watchdog now checks the planner's heartbeat (written on each sweep and each event, at least every 30 min) instead of tick times.
5. **Tempo settings** (`dispatcherTickMin`, `defaultCooldownMin`, maxPerTick, Sprint floor and unchanged rest) are retired, with their console tiles kept read-only for one release.
   - Sprint keeps its meaning only as "shorter coalescing windows and more concurrent starts". Its fs.watch path in dispatcher-loop.js:50, :99–111 is the seed of the planner's watcher.
6. **Rollout by company:** shadow, then live.
   - **Shadow:** the planner runs beside the tick dispatcher and writes `would-wake` rows. The comparison report (Part 9) shows, per tick wake, whether push would have woken it, and every item push would have missed. The target is zero missed answers or owner messages over 48 h.
   - **Live:** in the sandbox first. CPD only after the CPD → CaPheOS migration is settled, and after asking the owner.

## 12. The owner's view

### Today › "Who worked and why"

Plain sentences from events.jsonl and the run end, newest first, grouped by hour:

> - 10:42 Ingrid started: Kwame sent her "Check the backtest numbers". Done in 6 minutes.
> - 10:15 The website check found the API answering with errors (3 checks in a row). Omar is looking at it.
> - 09:00 The weekly revenue report was made for Finance. Halima is on it.
> - 08:30 Nobody woke between 01:12 and 08:30: no work came in.
> - Held: 2 jobs are waiting for 07:00 (quiet hours). 1 job is waiting because today's budget is spent.

A "Quiet" tile counts the hours with no runs and the wakes avoided: "Today: 41 runs, every one had new work".

### Work generators page (`console`, Work › Generators)

- **Each generator** shows its name, when it runs ("every Monday at 9:00"), who it goes to (a department name), when it last made work, how long that work took, and when it runs next. There is an on/off switch, a time picker, a "Make one now" button, and a skip note when the last one was still open.
- **Watchers** (monitors) show what is checked in plain words ("the website answers", "Bao's error log"), how often, the cost ("free: no AI"), the last finding and a link to its item. The owner can pause one, change how often it runs, or change who gets it.
- **Proposals:** generators that seats or migration suggested, waiting for a yes. One button each. These are owner matters only when the CEO proposed them; otherwise the lead decides, and the page shows the decision.
- No cron strings, unit names or file paths are shown (feedback-nontechnical-owner).

### Seat card

Replace "rests until 10:52" with "asleep: no work". When the seat is working, the card shows "working on: <item>", and when items are waiting, "next: 2 items queued".

## 13. Low-RAM, low-CPU machines

- **No polling by AI, and no periodic process spawns.** Today a Node process starts every 7–10 min per company and re-reads every inbox, runs.jsonl, the station snapshot, quests and the cron list.
  - Under push, idle CPU is about 0. The planner waits on inotify and one timer.
  - Monitors are the only periodic work, and they make a few HTTP calls.
- **Memory:** one Node process (~45–60 MB RSS) holds the item index (< 1 MB), the wheel and its watchers.
  - inotify uses about 1 kB per watch, on 8–12 directories (no recursive watch on the company root).
  - The dispatch.js child (~60 MB) runs only during a decision, a few seconds.
- **Bounded reads:** runs.jsonl is read from a kept byte offset (lib/bounded.js). Inboxes are re-parsed one file at a time on change.
- **Fallback when inotify is unavailable** (some container bind mounts, network filesystems): `wake-policy.json` `watch: "poll"` uses `fs.watchFile` at 10 s on the handful of files that matter, still plain code. The console shows "file watching unavailable; checking every 10 s" once.
- **Container-ready** (capheos-container-deploy): no systemd timer is needed. The planner is one long-running process with `Restart=always` or a container restart policy. All state lives under `company/state/`.
- **The local model** becomes practical, because briefs are small, scoped and budgeted (`contextK: 24`). Generator items with `tier: local`, and monitor triage items, go to it through routing classes. Code still never goes to MiniMax.

## 14. Build order

Each part can be built by one builder, behind a flag (`wake-policy.json mode: off | shadow | live`), with tests.

Tests run against a temporary company root (`co.ROOT` from env and a fake station). Never against ~/Companies: the measurement found self-test rows (seats alex, sam, desk, j-prod) in both live admit-logs. **Part 0** fixes that first.

| # | Part | What | Tests |
|---|---|---|---|
| 0 | **Test isolation** | Find which self-tests write to the live admit-log and wakes.jsonl, and make lib/admit.js and lib/wakes.js refuse a live root when `NODE_ENV=test` or `CAPHEOS_SELFTEST=1`. Remove the existing test rows from the live files (a backup first, with the owner told). | A test that runs every selftest with a read-only live root fixture. Zero writes. |
| 1 | **Item index + handled ledger** (`lib/items.js`, `lib/handled.js`) | Parse one inbox into id → {sig, status, waiting, notBefore, due, need, fyi}. The handled ledger with read, record and unhandled(seat). Writer attribution (5.3). The FYI and acknowledgement rule (6). | Fixtures: a new block; an edit by the holder (not news); an edit by another seat (news); FYI; acknowledgement only; re-dated heading with `Id:`; malformed blocks. |
| 2 | **Event journal + producers** (`lib/events.js`, watchers) | events.jsonl append and read (bounded), inotify watchers with per-file debounce, the reverse dependency index, run-end tail of runs.jsonl, gate events (approvals, signoffs, consults, releases, completions). | Temp root. Write files and assert the events. Watcher overflow simulation (the sweep catches it). runs.jsonl rotation. |
| 3 | **Timer wheel** (`lib/wheel.js`) | Min-heap, a single timeout, re-arm on config change and clock jump. Due, Not before, quiet-hours end. | A fake clock (`WHEEL_NOW`). Due at the start of day, a Not before in the past, a DST change in co.TZ, 10k entries under 5 ms. |
| 4 | **Wake queue: coalesce, priority, quiet hours** (`lib/wakeq.js`) | Per-seat windows by priority, dedupe per item, `maxItemsPerWake`, flush on run end, quiet hours. | A fake clock. An owner message within 5 s; 3 blocks in 20 s = one wake; FYI never; quiet-hours hold and release; P0 through quiet hours. |
| 5 | **dispatch.js `--wakes` input** | Replace the wake-source block (dispatch.js:854–1231) with the given set when `mode` is shadow or live. Keep every gate. The standing-queue rule is gone in push mode. wakes.jsonl `items` = the brief. In shadow, log `WOULD` only. Rebase on wave3: keep CONSULT_HOLD and SIGNOFF_HOLD as item filters, and keep the consultStep and delegate-allow steps. | The existing dispatch selftests pass in tick mode. New: a `--wakes` fixture starts only the given seats; holds (meeting, family, money, route, quota) still hold; a delegate-allow refresh before a lead start. |
| 6 | **Wake brief + prompts** | Brief writer (5.2). New loop prompt text in hire.js, founder-loop.js and dossier.js (behind the mode, because the old text is still needed in tick mode). Move the HANDOFFS, DECISION_RIGHTS and CHAIN_OF_COMMAND essentials into the injected profile. | A snapshot test of the prompts. The brief lists exactly the queued items, with plain cause words, and the newest-brief pick. |
| 7 | **Settle + continuations + item-age stalls** (`lib/settle-items.js`) | Run-end settle (5.4), the continuation cap, the stall table (7) to the lead, the rename in consult.js (`stuckAfterNoMoveRuns`, `stuckAfterHours`). Retire the seat-level stall counter in push mode. | Fixtures of runs.jsonl ends with each item outcome. A provider refusal is not counted. 2 no-move runs → one lead item, once. |
| 8 | **The planner process** (`wake-planner.js`) | Ties parts 1–7 together. Lock file, state file, heartbeat for the watchdog, safety sweep, SIGTERM behaviour as in dispatcher-loop.js. The systemd unit and container entry replace `<station>-dispatch.service`. | An end-to-end test on a temp root with a fake station: a handoff written → one `POST /api/cron/run` with the brief; nothing else for 1 h of fake time; a run end flushes the next. RSS under 80 MB with 500 items. |
| 9 | **Shadow comparison report** (`push-compare.js`) | Over N hours, the tick wakes against the push would-wakes. Items push would have missed (must be 0 for answers, owner messages and job failures), tokens avoided (estimate.py logic over live data). | Fixtures from the measured runs. The report prints the plain summary for the owner. |
| 10 | **Generators** (`lib/generators.js` + console API) | generators.json schema, the runner on the wheel, skip-if-open, routing to the department lead, provenance, proposals. | A fake clock. Weekly, monthly and every-20-minutes schedules; skip when still open; a department → lead; a proposal needs a yes. |
| 11 | **Monitors** (`lib/monitors.js`) | http, service, log, feed, file-age and inbox kinds. Duties wrapped. Finding keys, repeats without item churn, autoClose, the `owner` route to Today. Convert the provider-balance duty's route to `owner`. | A local http fixture server (an ephemeral port, never 8800, 8810, 8900 or 8910); log offset across rotation; hysteresis; owner route never wakes a seat. |
| 12 | **Migration tool** (`push-migrate.js`) | Lists seat crons and station AI routines with 7-day effect, proposes generators, and on approval pauses the routines and writes generators.json. Dry run by default. | Fixture cron lists, including the cpd Fiverr-style routine → monitor or generator proposal. Idempotent re-run. |
| 13 | **Owner views** | Today "Who worked and why", the Quiet tile, the Work › Generators page (generators, watchers, proposals) and seat card states. Ca Phe Design System. Plain words only. | A console render test and a copy check (no cron strings, paths or unit names). |
| 14 | **Accountable-leads hooks** | `AUDIT_HOLD`, audit items with the 10-min window, the member → lead FYI copy, `to: department` routing shared by generators, monitors and intake. | Fixtures: member done → audit item → ACCEPT releases the onward handoff; REVISE → member event with one item. |
| 15 | **StarNet 0019 per-run brief + maxTurns** (optional, after part 8) | `POST /api/cron/run {brief, maxTurns}` for one run, like 0017. When 0019 is present, the planner uses it instead of the file brief. | The patch's own sidecar test: a bad maxTurns is a 400, and the routine's saved prompt is never written. |

**Order:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 (shadow in the sandbox for 48 h) → 10 → 11 → 12 → 13 → live in the sandbox → 14 (with the accountable-leads build) → 15.

Parts 10 and 11 can be built in parallel with 5–7. Part 5 must be rebased on wave3, because wave3 changes the same block of dispatch.js.

## 15. Open questions, for the builders, not the owner

- **Writer attribution:** how reliable is provenance in practice? If it is weak, the planner falls back to "a change during the holder's own run is its own", and an unknown writer counts as news (5.3).
- **Due trigger time:** the start of the due day, or the earlier of that and `Deadline − lead time` per priority. The default is 09:00 local on the due day, or at once for an item that is already overdue when first seen.
- **The local model's brief size:** it needs a test on the planned local model before `tier: local` is on by default.
