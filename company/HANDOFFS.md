# Handoff Protocol

Work moves between people by **handoff files**, not by waiting for the CEO.

## Write a handoff
Append a block to `company/work/handoffs/to-<name>.md` (the `inbox` field of the seat in `company/tools/loops.json`):
```
## <ISO date> from <YourName> — <one-line ask>
**Need:** what exactly you need back
**Why:** why it matters now
**Deadline:** date or "today"
**Quest:** q:N step <key> (optional)
**Status:** OPEN
**Evidence:** link the work, command output or file
```

## Read your handoffs
At the start of every session read your own inbox. Open handoffs outrank your own backlog; one due today outranks
everything except a live incident.

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
