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

Numbers 0003 and 0006 are missing on purpose: they were art overlays specific to the company CaPheOS was extracted
from, and were not carried over. Keep the gaps; new records take the next free number.

## Rules

- The tools function owns these records; the risk function reviews any record that changes network exposure,
  authentication or what a page may write.
- Revert one record with `git -C starnet apply -R company/patches/<record>`.
- After a StarNet update, re-run `scripts/setup-station.sh`; a record that no longer applies is fixed and re-recorded,
  never dropped silently.
