# StarNet patch records

CaPheOS runs on an unmodified StarNet checkout at `./starnet` plus the small, recorded changes in this folder. Each
`.diff` is a plain `git diff` against StarNet, with `#` comment lines at the top saying what it does and how to apply
and revert it. A change to StarNet's own code that is not recorded here is lost on the next StarNet update, so every
change gets a record.

`scripts/setup-station.sh` applies the records in number order with `git -C starnet apply --3way <record>` (a plain
`git apply` when the checkout's index no longer matches its files), skipping any that are optional. After applying, restart the station when nothing is running: setup-station.sh never
restarts a running station itself; it prints the command, `scripts/restart-station.sh --when-idle --reason "patch NNNN"`,
which holds new starts, waits until no run is in flight and never cuts one off.

| Record | What it does | Applied by default |
|---|---|---|
| `0001-bind-lan-host-allowlist.diff` | lets the station bind to a LAN address, with a host allowlist so only named hosts are accepted | yes |
| `0002-department-body-placement.diff` | places each agent's body at its department's desk on the floor plan | yes |
| `0004-cron-update-missing-patch-400.diff` | `POST /api/cron/update` answers 400 when the body carries no patch, instead of a silent `ok:true` | yes |
| `0005-package-allowscripts-node-pty.diff` | `allowScripts` lets node-pty run its install script (the terminal tool needs it) | yes |
| `0007-minimax-reasoning-replay.diff` | replays MiniMax `reasoning_content` on a custom OpenAI-compatible endpoint (api.minimax.io / api.minimaxi.com only) | yes |
| `0008-viewer-mode.diff` | `/?viewer=1` opens a read-only StarNet page (GET/HEAD only, no saves, not counted as an open page) | **no**, apply by hand when wanted |
| `0009-runtime-time-and-zone.diff` | the per-run runtime line gives agents date, time, IANA zone and UTC offset at run start (not just the date), and says to run `date` for the time now; zone = station TZ from company.json | yes |
| `0010-headless-station.diff` | with `STARNET_HEADLESS=1` (written by setup-station.sh) the engine serves no station page (410 on every non-API path); the CaPheOS console is the UI and every `/api` route is unchanged | yes |
| `0011-artifact-needs-steps.diff` | an artifact-contract quest closes on its file only once every step is ticked (a README written on day one no longer closes the whole quest) | yes |
| `0012-workspace-lease-per-workdir.diff` | two runs of one agent may write in two different project folders at once (the workspace lease is keyed by agent + the run's resolved project folder; the same folder stays one writer at a time; agent-wide operations still wait for every run); `GET /api/version` lists `capabilities: ["workspace-lease-per-folder"]`. The StarNet half of Sprint lanes (docs/TEMPO.md, company/tools/lanes.js) | yes |
| `0013-quest-note-and-untick.diff` | `quest.update` (the agent tool only; no REST route) gains `note` (a note on a step without ticking it) and `untick` (put back a step ticked in error: reason required, open quests only, never reopens a closed quest); the tool description says progress ticks | **no**, opt-in: risk review, then change its Status line (and the `note` line in company/HANDOFFS.md) |
| `0014-run-detach.diff` | `POST /api/run` with `detach: true` keeps running when the caller's connection closes (the console's live chat survives a console restart; Run Now has had the same opt-in); stoppable with `POST /api/cancel`, events still on `GET /api/observe`; `GET /api/version` lists `run-detach` | yes |
| `0015-minimax-anthropic-wire.diff` | a custom endpoint on MiniMax's Anthropic-compatible API (api.minimax.io / api.minimaxi.com at `/anthropic`) runs on StarNet's Anthropic adapter: MiniMax's recommended wire for tools, with signed thinking blocks replayed verbatim; every other custom endpoint and a MiniMax `/v1` address is unchanged. `lib/minimax-endpoint.js` uses the `/anthropic` address only when the station carries this record | yes |
| `0016-served-model.diff` | the run row says which model SERVED the run: each adapter reads the model its provider's response names (the Claude CLI's stream-json: message_start / assistant `message.model`, else the result line's `modelUsage`, else the init line; Anthropic `message_start`; an OpenAI-compatible or OpenRouter chunk's `model`) and the run row in `runs.jsonl` gains `servedModel` (and `servedModels` when it changed mid-run). `model` stays the model asked for; a row without `servedModel` is "claimed" (unverified), as a Fable request the CLI served on another model would otherwise read as Fable | yes |
| `0017-per-run-model.diff` | a model for ONE run only: `POST /api/cron/run` and each `team.dispatch` worker spec take optional `{model, provider, effort}` for that run (checked against the station's registry, `sidecar/run-override.js`; a bad one is a 400 / that worker's error row); the routine's saved pair and the agent's roster pin are never written; the run row says `requestedBy: "override"` and `override`. **Gated by the override allowlist** (`sidecar/override-allow.js`): the station reads the file named by env `STARNET_OVERRIDE_ALLOW` (`company/state/override-allow.json`, rewritten every dispatcher tick by `company/tools/lib/override-allow.js` from what each seat can run now) and runs an override only when its resolved `(provider, model)` is listed for the run's own agent; env unset, file missing/broken or older than 30 minutes = every override refused (403 / worker error row "no current override allowlist: overrides are off"), not listed = "model p/m is not open for <agentId> now"; effort alone is free. Absent override = today's behaviour exactly. Needs 0016; needs `STARNET_OVERRIDE_ALLOW` in the station env (`scripts/setup-station.sh`) | yes |
| `0018-team-dispatch-limits.diff` | a ROUTINE lead delegates only under the company's delegation allowlist (`sidecar/delegate-allow.js`, env `STARNET_DELEGATE_ALLOW` = `company/state/delegate-allow.json`, rewritten every dispatcher tick by `company/tools/lib/delegate-allow.js`): a routine run gets `team.dispatch` only while its agent is listed (unset, missing, stale over 30 minutes or broken = no routine run delegates; console, owner-DM and group-lead runs unchanged); a worker not on that lead's list for the item gets an error row "<id> is not on this lead's team for this item" and does not run; `maxWorkers` is passed into orchestration at last (env `DISPATCH_MAX_WORKERS`) and capped by the list's; each worker gets its OWN wall clock (`workerTimeoutMin`, reason `worker-timeout`; a fast worker is never cut for a slow one) while the tool's deadline is held; each child run row carries `itemId`. Test: `test/team-dispatch-limits.test.js`, mirroring `test/orchestration.test.js`. Needs 0017; needs `STARNET_DELEGATE_ALLOW` in the station env (`scripts/setup-station.sh`) | yes |

Numbers 0003 and 0006 are missing on purpose: they were art overlays specific to the company CaPheOS was extracted
from, and were not carried over. Keep the gaps; new records take the next free number.

## Rules

- The tools function owns these records; the risk function reviews any record that changes network exposure,
  authentication or what a page may write.
- Revert one record with `git -C starnet apply -R company/patches/<record>`.
- After a StarNet update, re-run `scripts/setup-station.sh`; a record that no longer applies is fixed and re-recorded,
  never dropped silently.
