# verify: independent outcome checks (Verify)

Enable when the company is paid or blamed on claims. Needs `commitments`.

## Contract

- A commitment's `verify` spec (one check, an array, or `{ checks: [...] }`) is checked when the commitment is in
  `done`, by `tick.js`: the dispatcher's process, not an agent's run, and never the seat that did the work.
- Checks: `http` (`url`, `status` default 200, `contains`), `json` (`url` or `file`, `path`, `equals` / `exists` /
  `min` / `max`), `file` (`path`, `sha256`), `judge` (`rubric`, `family`): a second model family's judgement with a fixed
  rubric. A judge is queued to `company/work/verify/judge-queue.jsonl`; with no reachable station it is recorded
  `pending-human` / `needs-station`, and the commitment stays in `done` until another seat runs `verify.js mark`.
- Every `http`/`json url` request goes through `external-gate.js` (category `network`: the allowlist, or a clearance
  row). Port 8800 is never contacted. Files must be inside the root and not under `secrets/`.
- Outcome: all pass -> `verified` (by `verify`); any fail -> `in_progress` with the failure in the note; otherwise
  pending. The move goes through `commitments.js transition()` when the module is enabled; every result is appended to
  `company/work/verify/results.jsonl` either way. One result per done-transition: a re-done commitment is checked again.
- Separation: `verify.js mark` refuses the commitment's owner and anyone who moved it to `in_progress` or `done`;
  `mayVerify(c, by)` is exported for other tools to apply the same rule.

## Tools

| Tool | Purpose |
|---|---|
| `tools/verify.js` | `run [--id] [--dry]`, `mark --id --outcome pass\|fail --by`, `failures`, `--selftest` |

## External acts, limits, meters, panels, halt

- External acts: `network` reads only, through the gate.
- Limits: none to open (`limits/limits.json` is a note).
- Meters: `company/work/verify/results.jsonl` (append-only, writers `verify.js`, the dispatcher).
- Panel: `panels/verify-failures` (Work screen side column) from `company/work/verify/failures.json`.
- Halt: the dispatcher does not run module ticks while halted, so nothing is verified during a halt.
