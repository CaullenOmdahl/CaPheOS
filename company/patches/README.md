# StarNet patch records

CaPheOS runs on an unmodified StarNet checkout at `./starnet` plus the small, recorded changes in this folder. Each
`.diff` is a plain `git diff` against StarNet, with `#` comment lines at the top saying what it does and how to apply
and revert it. A change to StarNet's own code that is not recorded here is lost on the next StarNet update, so every
change gets a record.

`scripts/setup-station.sh` applies the records in number order with `git -C starnet apply --3way <record>`, skipping
any that are optional. After applying, restart the station.

| Record | What it does | Applied by default |
|---|---|---|
| `0001-bind-lan-host-allowlist.diff` | lets the station bind to a LAN address, with a host allowlist so only named hosts are accepted | yes |
| `0002-department-body-placement.diff` | places each agent's body at its department's desk on the floor plan | yes |
| `0004-cron-update-missing-patch-400.diff` | `POST /api/cron/update` answers 400 when the body carries no patch, instead of a silent `ok:true` | yes |
| `0005-package-allowscripts-node-pty.diff` | `allowScripts` lets node-pty run its install script (the terminal tool needs it) | yes |
| `0007-minimax-reasoning-replay.diff` | replays MiniMax `reasoning_content` on a custom OpenAI-compatible endpoint (api.minimax.io / api.minimaxi.com only) | yes |
| `0008-viewer-mode.diff` | `/?viewer=1` opens a read-only StarNet page (GET/HEAD only, no saves, not counted as an open page) | **no**, apply by hand when wanted |

Numbers 0003 and 0006 are missing on purpose: they were art overlays specific to the company CaPheOS was extracted
from, and were not carried over. Keep the gaps; new records take the next free number.

## Rules

- The tools function owns these records; the risk function reviews any record that changes network exposure,
  authentication or what a page may write.
- Revert one record with `git -C starnet apply -R company/patches/<record>`.
- After a StarNet update, re-run `scripts/setup-station.sh`; a record that no longer applies is fixed and re-recorded,
  never dropped silently.
