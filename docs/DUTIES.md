# Duties: deterministic wake reasons

A company used to find its own work by waking a model on a schedule and letting it look around. Most of those wakes
found nothing (the sandbox measured about one idle wake in three). A **duty** is the cheap half of that job done in
code: a read-only check, run by the dispatcher on every tick, that says "nothing is due" or "this is due, here is why,
send it to that seat". The model is woken only when a duty (or a handoff, a quest, an owner message, a hiring pick, an
artifact) says there is something to do, and it is handed the reason.

Code: `company/tools/duties.js` (the company tools' registry), `modules/<id>/module.json` `duties` (a module's),
`company/tools/lib/duty-runner.js` (runs them, keeps state), `company/tools/lib/duty-env.js` (their environment),
`company/tools/duty-status.js` (the board), the duty block in `company/tools/dispatch.js`. Tests:
`company/tools/tests/duties.test.js`.

## 1. The `--duty` contract

A tool with a duty mode is invoked exactly as `node company/tools/<tool> --duty` (a module's: `node modules/<id>/<tool>
--duty`), with no other argument.

| Exit | Meaning | stdout |
|---|---|---|
| 0 | nothing is due | nothing needed |
| 1 | work is due | one JSON object `{due: true, reason, route?, key, items?}` |
| anything else, a timeout, more than 16 KB of output, exit 1 without that object | the check is **broken** | ignored |

- `reason`: at most 300 characters, plain text, **counts and ids only**, never file contents (no headings, no titles,
  no interpreter output). It is sanitized again by the runner (control and bidi characters, markup and backticks
  removed, length capped) before it reaches a prompt or a log line.
- `route`: a function (`ceo`, `people`, `tools`, `risk`, `floor`, `finance`) or a seat id. Optional: the registry entry
  has one. `items[].route` routes one item on its own (a commitment to its owner seat).
- `key`: a stable digest of what is failing. The same failure gives the same key; the stall rule counts against it.
- `items`: optional `[{id, route?}]` (up to 50 kept). Ids are what dedup looks for in open handoffs and quests.
- **Read only, no network.** A duty writes no file and opens no socket. Its environment says so
  (`CAPHEOS_READONLY=1`, `CAPHEOS_NO_NETWORK=1`), and the tests run every registered duty against a fixture tree and
  assert that no file changed and that no `http`/`https`/`net`/`tls` module was loaded and `fetch` was never called.
  **A tool that can mutate does not get a duty mode that mutates**: where the tool's normal path writes (module.js
  doctor refreshes and runs conformance code), its `--duty` path is a separate, read-only one.

## 2. The registry is code; the policy is the only data

Each entry: `{id, tool, route, everyMin, timeoutMs, whileHalted, enabledByDefault}` (plus an optional `why`).

- Company tools: `company/tools/duties.js`, a reviewed tool file (a change is a `harness-change.js` change; locked-watch
  watches it like the dispatcher).
- Modules: a `duties` array in `modules/<id>/module.json` (schema in `module.js`); only ENABLED modules' duties run, and
  the tool path is relative to the module folder.
- Policy: `company/work/ops/duty-policy.json` (copied at founding from `company/defaults/work/ops/duty-policy.json`):
  `{tickCapMs, duties: {<id>: {enabled, everyMin}}}`. `everyMin` is clamped to 5–1440, `tickCapMs` to 2000–60000
  (default 20000). What runs, where it routes and `whileHalted` cannot be set here. It is a policy-tier file in
  locked-watch (class F, like `pacing-policy.json`): an edit with no reviewed change is reported, and **while that
  report is open the runner uses locked-watch's last-known-good copy** (digest-checked), else the defaults. A company
  with no policy file and no defaults runs no duties and says so once (`DUTIES off`); the board then shows every duty
  stale, never ok.
- Console: the `duties` entry under `tool` in `company/console/sources.json` (`duty-status.js --json`; fixed argv, no
  shell, timeout, the panel's data cap, read-only).

## 3. Execution (one block in the dispatcher tick)

The block runs right after `locked-watch.js tick` and `harness-change.js tick`, so a tampered policy is reported (and
not obeyed) before anything runs. Each duty that is due by its cadence (never run, or `lastRun` older than `everyMin`)
runs in turn, longest-waiting first:

- `execFile(process.execPath, [tool, '--duty'])`: no shell, cwd = the company root, output capped at 16 KB, killed at
  its `timeoutMs`;
- environment: an allowlist only — `PATH`, `HOME`, `TZ`, `LANG`, `CAPHEOS_TZ`, `CAPHEOS_BACKUP_DIR` from the dispatcher,
  plus `CAPHEOS_ROOT`, `CAPHEOS_READONLY=1`, `CAPHEOS_NO_NETWORK=1`. No station token, no key, no `NODE_OPTIONS`. When
  StarNet is installed next to the company (`starnet/sidecar/environment.js` `sanitizeChildEnv`) it is applied on top
  and can only remove names; without it `lib/duty-env.js` applies the same secret-name rule;
- a per-tick cap (`tickCapMs`): a duty that would run past it is stopped and **waits** for the next tick (counted in
  `waits`; it is not "broken"), and the ones after it wait too.

State: `company/state/duties.json`, per duty `{lastRun, lastResult ok|due|broken, ms, dueSince, key, reason, items,
brokenSince, error, lastFlaggedKey, waits, history}` (last 12 results).

## 4. What a result does

- **Due**: the result is the sixth source of work (the seventh is a watched job's end, company/tools/notify-when.js; docs/TEMPO.md) in the dispatcher's `work` map (`{id: 'duty:<id>', why}`) for the
  seat it routes to (items split by their own routes). It inherits the stall rule (the stall key is the duty id plus its
  `key` and item ids: the same failure after 3 wakes is flagged once and stops waking), `RUN … (duty:<id> (<reason>))`
  logging, the cooldown, the wake caps, the spend caps, the halt and Sprint (a new key is new work). When the seat is
  woken, the dispatcher hands it the reason as one OPEN handoff in its inbox (`duty <id>: <reason>`, with a `**Duty:**`
  line carrying the key and item ids). When the check passes again, the dispatcher closes its own duty handoffs.
- **Dedup**: a due duty wakes nobody when every item id (or, without items, its key) already appears in an OPEN handoff
  to that seat or in that seat's open quest — including the handoff the dispatcher wrote for it.
- **Broken**: flagged once to the tools owner as an OPEN handoff (`duty <id> is broken`, the error as Evidence) — quiet
  while the same error persists, flagged again when it changes.
- **Stale**: a duty that has not run inside 2 × `everyMin` (it never completes, keeps waiting for the cap, or the
  dispatcher is not ticking) is shown **stale** and flagged once per episode.
- **Absence never renders green.** A duty is `ok` only if it ran inside 2 × its cadence and its last result was ok.
  Never run, too old, waiting, no policy: stale. This rule is computed in `lib/duty-runner.js` (`stateOf`) and tested in
  `duty-status.js --selftest` and `duties.test.js`; no view decides it.
- **Halt**: while halted only `whileHalted: true` duties run (liveness). They record their state; nobody is woken and
  nothing is flagged until the company runs again.

## 5. The duties that ship

| id | tool | route | every | finds | read-only path |
|---|---|---|---|---|---|
| `handoff-status` | `handoff-status.js` | the inbox owner's manager, else the CEO (per item) | 30 min | OPEN handoffs past their deadline; sections with no Status line | the existing classifier; item id = `<inbox>#<6 hex of the heading>` |
| `tool-parse` | `tool-parse.js` | tools | 60 min | a tool in the folder the tool lives in that does not parse | `node --check` / `bash -n` only; an empty folder is broken, never ok |
| `connector-scope` | `connector-scope.js` | risk | 30 min | the saved policy header of a policy connector is not "true", or a drift locked-watch flagged is still open | **no station call** (the normal check reads `/api/connectors` with the token; a duty may not): the saved config and locked-watch's baseline only |
| `backup-freshness` | `backup-freshness.js` (new) | risk | 60 min | no `scripts/backup.sh` snapshot younger than 26 h, or none at all | reads the backup folder listing |
| `module-doctor` | `module.js` | tools | 6 h | an enabled module failing its static and enabled-state checks | **without** the framework refresh (copies files) and **without** conformance tests (they run module code): `doctor` remains the full check |
| `commitments-due` | `modules/commitments/tools/commitments.js` | each commitment's owner seat | 10 min | an open commitment past its due time | `list()` only; replaces agents scheduling their own wakes for a deadline |
| `unregistered-services` | `service.js` | risk | 30 min | a systemd user unit (unit file or transient) whose ExecStart or WorkingDirectory is inside this company folder but is not in `company/state/services.json`; a registered unit not named `<slug>-svc-<name>`; a registered unit file edited by hand | unit-file reads only (`~/.config/systemd/user`, `$XDG_RUNTIME_DIR/systemd/transient`): **no systemctl call**; item ids `unregistered:<unit>`, `unscoped:<unit>`, `edited:<file>` |
| `budget-drift` | `budget.js` | finance (scheduler items: tools) | 30 min | the station's spending caps differ from the company settings (`perDay` vs today's daily budget, `perAgent` vs no cap), naming both numbers; with `runtime.scheduler=dispatcher`, a crew loop armed on the station, no watchdog routine, or a run the station's own schedule started (docs/BUDGET.md) | **no station call**: the snapshot the dispatcher tick writes (`company/state/station-caps.json`), `dispatch-budget.json`, runs.jsonl and the admit log, read from their ends; item ids `cap:perDay`, `schedule:<seat>`, `watchdog:station`, `schedule-runs` |
| `departments` | `departments.js` | people (proposals: ceo) | 60 min | `company/departments.json`, `loops.json` and `FLOOR_PLAN.md` disagree, a department brief is missing or over `limits.briefMaxChars`; a department change the people function proposed waits for the CEO | the same report `departments.js check` prints, no write; item ids `departments:<code>:<dept or seat id or a 6-hex digest of a name only FLOOR_PLAN.md has>`, `departments-proposal:<id>`; quiet while the company has no departments |
| `house-ranking` | `model-rank.js` | people | 60 min | a routing proposal is open: a model cell with enough data beats a department's current route for its task class (shadow; docs/RANKING.md) | the ranking computed in memory from bounded reads; item ids = the proposal ids; quiet once each is decided (`model-rank.js decide`) |
| `liveness-watcher` | `modules/liveness/tools/liveness.js` | risk | 10 min, **whileHalted** | the watcher's own heartbeat missing or older than 3 of its intervals (the dead-man's switch is blind) | `watch.js status()` |

## 6. Slower routine loops

With duties finding the work, a seat's own loop routine only has to catch what no duty sees, so it can run every 6–12
hours. `company/work/ops/cadence.json` `bounds.loopFloorMin` (default `[360, 720]`; a seat may set
`seats.<id>.loopFloorMin` inside it) records that floor. **Existing schedules are never changed automatically**:
`node company/tools/cadence.js duties-floor [--json]` lists the seats that loop faster than the floor and prints the two
ways to apply it (the owner's `cadence.js set <seat> --loop-every <min> --by owner` + `apply`, or a reviewed
`harness-change.js propose --kind schedule` change). The CEO seat keeps its loop. Who starts that loop when it is due,
the dispatcher (through `admit()`, the default for new companies) or the station's own schedule, is
`company.json` `runtime.scheduler` (docs/BUDGET.md).

Measure it with the Sprint numbers: `node company/tools/cadence.js sprint status --json` → `idleWakeRatio` (wakes that
changed nothing ÷ wakes resolved). Read it before turning duties on and before applying a floor, and again a day
after; the sandbox baseline was about 1 in 3.

## 7. Board and logging

- `node company/tools/duty-status.js [--json]`: per duty `{id, route, owner, state ok|due|broken|stale|off, checkedAt,
  reason, history, everyMin, source, …}`. The tool computes the state; the view only colours it.
- The console page scaffold `company/console/scaffolds/duties/` (a `status-grid` on the `duties` source; due and broken
  are bad, stale is warn): `node company/tools/console-panel.js scaffold duties --as duties --by <tools seat>`.
- The dispatch log gets one compact line per tick, only when something changed:
  `DUTIES 3 run in 1.2 s — 4 ok, 1 due (handoff-status), 0 broken, 2 stale (x, y); waiting for the cap: y`.

## 8. Adding a duty

1. Give the tool a `--duty` mode that only reads, prints counts and ids, and keeps the exit codes above. Prove it in the
   tool's own selftest (due, not due, and that no content leaks into the reason).
2. Register it: a line in `company/tools/duties.js` (reviewed like any tool), or the module's `module.json` `duties`.
3. `node company/tools/duties.js --selftest` and `node --test company/tools/tests/duties.test.js` (the no-mutation and
   no-network tests run every registered duty).
