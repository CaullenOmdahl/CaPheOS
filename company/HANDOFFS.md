# Handoff Protocol

Work moves between people by **handoff files**, not by waiting for the CEO.

## Write a handoff
Append a block to `company/work/handoffs/to-<name>.md` (the `inbox` field of the seat in `company/tools/loops.json`):
```
## <ISO date> from <YourName> — <one-line ask>
**Need:** what exactly you need back
**Why:** why it matters now
**Deadline:** 2026-11-18            (when it must be DONE: a plain YYYY-MM-DD first, or the word today)
**Not before:** 2026-11-20 09:00    (optional, rare: the earliest it may START, company time)
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

**Not before:** is the one line that sets an OPEN block aside: the dispatcher does not wake the holder for it, does not
count it toward STALLED, and nobody counts as blocked by it, until that date (`YYYY-MM-DD`, or `YYYY-MM-DD HH:MM`,
company time). Use it only when the work truly cannot start earlier (a result that lands on a given day, a market that
opens then). The date must come first on the line and be no more than 14 days ahead; prose, a past or a farther date
counts as workable now. The first date the dispatcher sees for a block is the one that counts: moving it later never
extends the wait, moving it earlier takes effect at once. The seat's own schedule may still run it; leave it until its
day. Waiting on someone is different and keeps its own form: say it in the Status (`**Status:** OPEN — waiting on
Ingrid's review`), and the holder is not woken for it until that seat or decision moves.

`node company/tools/handoff-status.js --due` lists the open set by Deadline and marks Not-before items; the lint warns
when a Deadline line reads like a start date ("wait until", "no earlier than" next to it) with no Not before line.

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
