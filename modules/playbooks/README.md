# playbooks (Organize)

Situation to procedure. Enable for repeatable work where quality matters. Requires `intake` and `commitments`.

- A playbook is `company/work/playbooks/<id>.json` (rules) plus `<id>.md` (the procedure the owner seat follows).
  JSON: `{ id, title (may use {{source}} {{type}} {{key}} {{data.x}}), priority?, match: { source?, type?, where?: [{path, op, value}] },
  owner (function or seat), clocks: { ackMinutes, dueMinutes }, steps?, verify? }`.
- **Match:** `source` and `type` are exact or a trailing `*` prefix; `where` ops `eq ne gt gte lt lte exists missing
  contains matches` over dot paths of the event. All must hold. Best match: highest priority, then most conditions, then id.
- **tick.js** (not while halted) reads new events past a byte cursor, matches each, and creates the commitment with the
  playbook's owner and clocks, key `<source>:<event key>` (a replay dedupes), the playbook's `.md` as its first evidence
  ref. An untrusted event's words never reach the title (it is `<playbook>: <type> from <source>`): the filled title and
  the event data travel as `subject` / `untrusted` and are fenced in every handoff. A `silence` event (intake's silence
  watch, source `silence`) matches like any other. Matches are logged to `matches.jsonl`. If a limit holds, the remaining events wait for the next tick.
- `playbooks.js check` fails on a malformed playbook or a missing `.md`.

**Limits (shipped closed):** `maxCommitmentsPerTick` = 0 (`company/state/modules/playbooks/limits/limits.json` once opened).
**Tool:** `company/tools/playbooks.js` (`list`, `check`, `match`, `run`, `--selftest`), owner: the CEO.
