# observe (Sense)

Watches targets over time. Enable when something outside must be watched.

- **Targets:** `company/work/observe/targets.json` `{ "targets": [ ... ] }`, each `{ id, kind, every (minutes), onChange?, party?, expect? }`:
  - `http` `{ url }`: value = status, plus latency; `expect: { status, maxMs }` (default ok = 2xx/3xx).
  - `json` `{ url, path }`: value = the dot path's value; `expect: { equals | min | max }`.
  - `file` `{ file }`: value = sha256 of a file inside the company root (never `secrets/`, never outside).
  - `command` `{ argv }`: value = exit code, no shell; `expect: { exit }`. **Off while the `localComputer` guardrail is on.**
- **History:** `company/work/observe/<id>.jsonl` (`{at, ok, value, ms?, error?}`), state in `state.json`.
- **Events into intake** (source `observe`): `observe.threshold` when a target starts failing, `observe.recovered`
  when it passes again, `observe.change` when its value changes (`onChange: true`). Playbooks turn them into commitments.
- Every URL fetch is an external-gate `network` check.
- `tick.js` probes the due targets each dispatcher tick (not while halted).

**Limits (shipped closed):** `maxTargets` = 0, so nothing is probed until the owner opens it
(`company/state/modules/observe/limits/limits.json`, through `harness-change.js` kind `policy`).
**Meters:** the per-target history files, append-only. **Requires:** the `intake` module.
**Tool:** `company/tools/observe.js` (`run`, `list`, `history`, `--selftest`), owner: tools.
