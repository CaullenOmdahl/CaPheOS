# Handoff Protocol

Work moves between people by **handoff files**, not by waiting for the CEO.

## Write a handoff
Append a block to `company/work/handoffs/to-<name>.md` (the `inbox` field of the seat in `company/tools/loops.json`):
```
## <ISO date> from <YourName> — <one-line ask>
**Need:** what exactly you need back
**Why:** why it matters now
**Deadline:** 2026-11-18            (when it must be DONE: a plain YYYY-MM-DD first, or the word today)
**Waiting on:** to-nadia-farrell.md#gold backfill   (optional: what it waits for; see below)
**Not before:** 2026-11-20 09:00 — the exchange opens   (optional, rare: a real clock time, with its reason)
**Quest:** q:N step <key> (optional)
**Status:** OPEN
**Evidence:** link the work, command output or file
**Touches:** src/intake/, docs/intake.md (optional: the paths or areas this work changes)
**Effort:** mechanical | reasoning (optional)
```
**A Deadline is when the work must be done, never when it may start.** It defers nothing: an OPEN block with a Deadline
next week is work now. The dispatcher reads the line only to order the work (a seat with an item due sooner is woken
first, and each wake names the next due date) and to mark the overdue ones. Start the line with a plain `YYYY-MM-DD` (or
`today`) and put any detail after it; prose, `none` or a date buried in a sentence is undated, so the item is worked
after the dated ones and never flagged late.

**Use Waiting on for anything that waits on other work. Use Not before only for a real clock time, with a reason.
Never park work to look busy-free or to avoid stall checks.** The owner's ruling: get work done as soon as possible.

**Waiting on:** names what the block waits for, one or more dependencies separated by `;`, with optional plain words
in brackets at the end (the console shows them: "waiting for: gold history download to finish"):
```
**Waiting on:** to-nadia-farrell.md#gold backfill          that handoff closes (heading words or its **Id:**)
**Waiting on:** seat: Nadia — gold backfill                  that seat's item closes
**Waiting on:** q:13 step rank                               that quest step is ticked (q:13 alone: the quest closes)
**Waiting on:** file: company/work/strategies/RANKING.md     the file appears (add `changed` to wait for a change)
**Waiting on:** service: bank-day                            the background service's next successful run
**Waiting on:** job: gold-backfill (gold history download to finish)   a job started with notify-when.js --id gold-backfill ends
```
The dispatcher resolves every dependency on every tick: until all are met the holder is not woken for it, it is not
counted toward STALLED, and the seats it names count as blocking it; the tick they are all met the holder is woken at
once, past its cooldown ("Rohan: gold history download to finish — done; starting the recompute"). A reference the
dispatcher cannot resolve (an inbox, item, seat, service or job that does not exist) is a lint warning, and the item is
treated as work now: a typo never parks work. `**Waiting on:** nothing` says it is your own work. Waiting on a person's
decision can still be said in the Status (`**Status:** OPEN — waiting on Ingrid's review`); a Waiting on line, when
present, governs instead of the Status prose.

**A long job: start it, hand off, and you'll be woken when it ends.** Start it through
`node company/tools/notify-when.js --seat <you> --why "gold backfill" --id gold-backfill -- <command…>` (it returns at
once; `--pid` or `--service` watches one already running), write the next step as a handoff with
`**Waiting on:** job: gold-backfill`, and end the run. When the job ends (a failure too, labelled as one) the dispatcher
wakes the seats it names with its exit code, duration and output tail (`notify-when.js show <id>`). A timer service
proposed with `service.js propose … --wake <seat>` does the same for every run. Never a bare background shell and a
polling loop, and never a guessed Not before.

**A background job that needs a website.** A job proposed with `service.js propose` has no network unless you ask. Name
each website it needs with `--hosts api.example.com,hermes.example.net` (not `--network on`, which opens every website
and asks the owner). A website the company already uses (on `company/state/external-allowlist.txt`) is fine; a new one
follows the owner's `external` level, so at auto it is your call. Say what the job does for the owner with
`--plain "It downloads tomorrow's prices every night"` and what happens without it with `--if-no "prices are updated by
hand"`; those are the words on their card or in their daily message.

**Not before:** is for a genuine wall-clock reason only: a market opens, a provider's daily data release, a time
someone outside the company named. Put the date first (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, company time) and a short
reason after it. Caps, counted from when the dispatcher first saw the line: at most 24 h ahead without such a reason,
at most 72 h with one, and during Sprint at most 12 h unless the reason is an external time. A line beyond its cap is
ignored (the item is work now; the dispatcher logs it once: "released: a 7-day Not before with no external reason"):
use Waiting on, or ask the CEO. A reason that reads like a dependency ("after", "needs", "waits on", "once X", "when X
lands", "comes after") is not a clock time: the lint flags it and suggests the matching Waiting on. The first date seen
for a block counts: moving it later never extends the wait, moving it earlier takes effect at once.

The owner sees every parked item in Work › Handoffs in plain words with what it waits for, and can release one with
**Start now**: the gate is removed (recorded in company/state/gate-releases.jsonl) and the holder is woken at once.

`node company/tools/handoff-status.js --due` lists the open set by Deadline and marks Not-before items; the lint warns
when a Deadline line reads like a start date ("wait until", "no earlier than" next to it) with no Not before line, when
a Waiting on names something that does not exist, and when a Not before has no reason, reads like a dependency, or is
past its cap.

`Touches:` says which files or folders the work changes, so two items with disjoint paths can be worked at the same time
in Sprint (docs/TEMPO.md "Sprint"); an item without it is treated as touching everything and is worked on its own.
Prefer one owner per new file: parallel work that targets new files never waits on another. `Effort: mechanical`
(renames, scaffolding, formatting, copying a pattern) lets the dispatcher run a seat whose items are all mechanical on
a cheaper model of its own chain and keep Claude for reasoning work; no tag means the seat's default chain.

## Read your handoffs
At the start of every session read your own inbox. Open handoffs outrank your own backlog; one due today outranks
everything except a live incident. Work them soonest Deadline first (overdue ones before anything else
but a live incident), and do not hold a dated item back for its due day: start it now. Work every OPEN item in the session, reviews included (`harness-change.js` reviews
arrive as handoffs: approve or reject each one in this run): one wake, all the queued items, rather than one wake each.
An item with a `**Lane:** n, run <id>, since <time>` line is owned by a parallel lane, another run of you working it in
its own folder right now (Sprint, `company/tools/lanes.js`): skip it, and do not edit that section. When the lane ends, its
result lands in the item as `**Lane result (…):**` (a branch to review and merge, or what is left) and the item is yours
again. Review a lane's branch like any other change; never push it.

## Close a handoff
Change that block's own `**Status:** OPEN` line to `**Status:** DONE` and add `**Resolved <date> by <you>:**` with the
evidence. Do not append a separate "DONE" section and leave the original OPEN: the dispatcher counts open handoffs by
each section's Status line, so a stale OPEN keeps waking the recipient. Never delete a thread. The dispatcher moves
finished threads older than three hours to `company/work/handoffs/archive/` (`tools/handoff-archive.js`).
`node company/tools/handoff-status.js` lints the inboxes; `--due` lists open handoffs by deadline.

## Record on a quest
`POST <station>/api/quests/update` with header `x-starnet-token` (from `secrets/station-token`):
- `{"id":"q:N","op":"tick","stepKey":"<key>","note":"<what was concluded>"}`: tick a step with its conclusion.
- `{"id":"q:N","op":"attest","agentId":"<agent>","evidence":"<files, commits>"}`: propose the quest closed. The
  dispatcher closes it once the cited evidence checks out.
- A tick cannot be undone through the API, and **there is no `note` op**: `op:"progress"` *is* a tick (it sets the
  step's `done` flag, whatever its description says; the quest ops are `start, progress, attest_complete, mint`). Tick
  only what is done. A conclusion or a caveat about a step you have not finished goes in your handoff or
  `company/work/improvements.md`, never through `progress`.

## Escalation
Only unresolved cross-team conflict, a missed deadline that blocks the mandate, or an owner gate goes up the chain
(`CHAIN_OF_COMMAND.md`). Everything else is settled between the two people.
