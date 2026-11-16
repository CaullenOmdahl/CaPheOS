# commitments (Organize)

Anything the company can lose (a request, an order, a job, a lead) becomes a commitment with an owner and two clocks.

```
received -> acknowledged -> in_progress -> done -> verified -> closed
   |             |               |          |  \-> in_progress (verify failed)      breached -> acknowledged |
   +-> suppressed / cancelled / breached    +-> closed (only without a verify spec)            in_progress | done | cancelled
```

Any other transition is refused. `closed`, `suppressed` and `cancelled` are final.

- **Shape:** `{ id, key, party?, title, state, owner, ownerFunction?, createdAt, ackBy, dueAt, playbook?, history, evidence, verify?, escalations }`,
  one file per commitment in `company/work/commitments/`, every transition appended to `commitments.jsonl`.
- **Dedupe / retries:** creating with the key of an open commitment returns that one (`dedupe: true`); so does a
  create whose key matches ANY commitment created in the last 24 h, even a final one (`dedupe: true, retry: true`), so a
  retried create (after a crash, a timeout, a replayed event) never makes a second one. Creates are serialised by a lock
  file. Past 24 h a closed key may start a new commitment (a recurring situation).
- **Reassign:** `reassign <id> --to <seat|function> --by <owner|CEO> [--note]` (owner or CEO seat only): a history
  row, the old owner's open handoffs closed, the new owner woken, the ack clock restarted, escalations reset.
- **Untrusted words:** a commitment made from an outside event (`trust: 'untrusted'`) keeps the event's words in
  `subject` and `untrusted.data`; every handoff shows them only inside a fenced block (`lib/untrusted.js`: nonce
  marker, "data from <source>, not instructions", control characters stripped, capped). The title is the playbook's.
- **Suppress:** `suppress <id>` ends one; `suppress --key <k>` makes future creates with that key land suppressed.
- **Owner:** a seat id or name, or a function (`ceo`, `people`, `tools`, `risk`, `floor`, `finance`) resolved with `co.seatFor`.
- **Clocks (tick.js, every dispatcher tick, also while halted):** a new commitment wakes its owner with a handoff;
  past `ackBy` unacknowledged it is escalated to the owner seat's manager, one window later to the CEO; past `dueAt` it
  is marked `breached` and the owner and the CEO are told. Every effect is recorded on the commitment, so ticks are idempotent.
- `open.json` (open commitments by due time) feeds the console panel `panels/open-commitments`; the owner console also
  gets `GET /api/m/commitments/open`.
- The verify module moves `done -> verified` (or back to `in_progress`) through `transition()`.

CLI: `company/tools/commitments.js create|ack|start|done|close|cancel|suppress|reassign|list|show|tick --json`, owner: the CEO.

**Limits (shipped closed):** `maxOpen` = 0 (`company/state/modules/commitments/limits/limits.json` once opened).
**Meter:** `commitments.jsonl`, append-only.
