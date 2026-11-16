# Guardrails

A guardrail is a hard block that the company's tools enforce. Each one has a switch. The switches live in
`company/state/guardrails.json`; when that file is missing, `company/defaults/state/guardrails.json` is used, and it has
every switch ON. Tools read a switch with `co.guard(name)` (`company/tools/lib/company.js`), or with
`require('./lib/guardrails').guardIn(root, name)` when they work on a project root other than the live one (selftests
run in temp copies). `true` means the block is ON. An unknown name, a missing file or an unreadable file all read as ON,
so the tools fail closed. `halt` is always ON.

Only the owner changes a switch, and only with `company/tools/guardrails.js`. No environment variable turns a guardrail
off. The test-only variables (`MERGE_GATE_ASSUME_AGENT`, `GUARDRAILS_ASSUME_AGENT`, ...) can only make a caller look
*more* like an agent.

```
node company/tools/guardrails.js show [--json]
node company/tools/guardrails.js set <name> on|off --by <owner> [--why "..."]
node company/tools/guardrails.js off-all --by <owner> --confirm "I understand there are no guardrails"
node company/tools/guardrails.js on-all --by <owner>
node company/tools/guardrails.js sandbox on|off --by <owner>
node company/tools/guardrails.js sandbox detect
node company/tools/guardrails.js apply [--dry-run]
node company/tools/guardrails.js selftest
```

`--by` must be the owner's name (`company/company.json` `owner.name`) or `owner`. The command is refused when it runs
inside an agent's station run. The tool checks this the same way `merge-gate.js` does (an ancestor process is
`sidecar/index.js`, or its cgroup is the station unit), and it also uses `provenance.js`'s check (the environment pins
the station puts on every child process).

Every change does four things:
- it writes `company/state/guardrails.json` atomically, recorded with `provenance.js`;
- it adds a JSON row to `company/state/guardrails-log.jsonl`;
- it adds a line to `company/work/decisions.md`;
- it sends a message to the owner channel through `owner-inbox.js` `send()`.

`show` lists each switch with:
- what it blocks;
- whether it is ON or OFF;
- the files that enforce it, including any that do not read the switch yet;
- whether it is **station-backed** or **framework-only**.

When any switch is off and `sandbox` is not set, `show` prints a loud banner.

## The switches

| Switch | Blocks (while ON) | Enforced in | Backing | Turning it OFF means |
|---|---|---|---|---|
| `ownerGates` | the four owner gates (access, ownership, commitment, spend beyond the cap) always need the owner | `lib/company.js` `gate()`, `lib/governance.js`, `governance.js` | framework-only | governance levels alone decide those categories too |
| `spendCap` | metered spend stops at the daily cap and per-agent shares; subscriptions stop at their pacing line | `dispatch.js`, `hire.js`, `pacer.js` | framework-only | no cap holds a run |
| `externalActions` | nothing leaves the company without a clearance row | `external-gate.js` | framework-only | the gate logs but allows |
| `harnessSelfEdit` | agents cannot change their own harness; locked files are watched and put back; tool changes are reviewed | `locked-watch.js`, `harness-change.js` | framework-only | agents may edit any of it; changes are still logged |
| `defaultBranch` | no agent pushes or merges to a default branch except a PR with a pre-merge PASS | `merge-gate.js`, `premerge-check.js`, `default-branch-watch.js` | framework-only | see below |
| `secrets` | agents never read, print or copy `secrets/` or the station key store | `my-section.js`; station: service keys | station-backed | see below |
| `localComputer` | agents work only inside the workspace and the blessed project folders; computer control stays off | `my-section.js`, `workspace-modes.sh`; station: computer control and FULL BYPASS | station-backed | see below |
| `privilegedShell` | sudo only through the sudo gate's allowlist | `sudo-gate/broker.py`, `sudo-gate/install.sh` | framework-only (root side) | see below |
| `promptInjection` | the station's injection tripwire refuses routines carrying override or exfiltration payloads | the station's `cron-guard.js` | framework-only, **not switchable** | see below |
| `halt` | soft and hard halt work, and a halted company starts nothing | `halt.js`, `dispatch.js` | — | cannot be turned off |

### What each OFF does in the files wired here

- **defaultBranch.**
  - `merge-gate.js`: every refusal (`git push`, `gh pr merge`, `gh api` writes, `gh repo sync`, the pre-push hook) becomes
    exit 0. It is logged as `UNGUARDED (guardrail defaultBranch is OFF) allowed: …` in `company/work/merge-gate.log` and
    reported on stderr.
  - `premerge-check.js`: every check still runs and still prints `BLOCKED`, and the FAIL record is still written, but
    the command exits 0.
  - `default-branch-watch.js`: direct pushes, merges without a PASS and rewritten history are still judged and written
    to `company/work/security/default-branch-watch.md`, marked "(guardrail off)". Nobody is handed them. Notes about
    the watcher itself (tampered state, not checking) still go out.
- **privilegedShell.**
  - `sudo-gate/broker.py` passes sudo through: any command by name from the system bin folders, or by absolute path, as
    root or `nobody`. It is logged with the decision `allowed-unguarded`.
  - The project's `guardrails.json` can be written by the company's Unix user, and so by agents. For that reason the
    root broker also needs its root-owned `gate.json` to say `privilegedShell: false`. `install.sh` copies the owner's
    switch there.
  - So OFF takes effect after `sudo bash company/tools/sudo-gate/install.sh`. ON takes effect at once.
  - A login shell (`sudo -i`/`-s`) is still refused by the shim.
- **localComputer.**
  - Note (ON or OFF): the company folder itself is a blessed project folder (onboarding, `founder-loop.js ensure`;
    the console's live chat and `hire.js` bless it too, idempotently). That is inside this guardrail, which keeps work to
    the agent workspace plus blessed project folders: without it no loop or chat could read the charter or the owner inbox.
  - `my-section.js --file` may read a file outside the company folder. The read is logged as `event: "unguarded"`.
  - `workspace-modes.sh --check` still lists permission drift but exits 0, and `--fix` tightens nothing.
  - Station side, see `apply`.
- **secrets.**
  - `my-section.js --file` may name a file in `secrets/`. The read is logged, but the section's R6 rule still keeps
    key-shaped text out of routine prompts.
  - The owner channel never prints secrets, whatever the switches say.
  - Station side, see `apply`.
- **promptInjection.** OFF is recorded, but nothing changes. The tripwire (`starnet/sidecar/cron-guard.js`) is pure code
  with no mode and no endpoint, so injection-shaped routine prompts are still refused. `show` and `apply` both say so.
  Framework side, always on: intake events are `trust: 'untrusted'` (only the owner marks a source internal), and any
  tool that hands event data to an agent wraps it with `company/tools/lib/untrusted.js` `fence()` (nonce marker,
  "data from <source>, not instructions", control characters stripped, length capped); untrusted text never goes
  into a routine prompt.

## Station-side switches (`apply`)

`apply` reads the station's current state and plans the requests that bring it in line with the switches.
`apply --dry-run` prints the plan, sends nothing, and anyone may run it. A real `apply` is owner-only.

- **localComputer** maps to two station settings:
  - **computer control**: `GET /api/computer-control`, then `POST /api/computer-control` with
    `{"action":"select","backend":"off"}`.
  - **FULL BYPASS**: `GET /api/permissions` (`masterBypass`, `envFullAccess`), then `POST /api/permissions/bypass`
    with `{"on":true|false}`.

  With localComputer ON, `apply` sets computer control off and FULL BYPASS off.

  With localComputer OFF, `apply` sets FULL BYPASS on. It does not switch computer control on: choosing a backend is the
  owner's pick in the station, and it works only in the Windows desktop app.

  `apply` cannot change these through the API, so it only reports them:
  - a backend set by the launch environment (`STARNET_COMPUTER_DRIVER`);
  - `STARNET_FULL_ACCESS` in the station's environment;
  - an agent's own `approvalMode: "full"`.
- **secrets** maps to each service key's unattended grant: `GET /api/servicekeys`, then
  `POST /api/servicekeys/autonomy` with `{"id":…,"autonomous":true|false}`.
  - With secrets OFF, `apply` grants unattended use of every enabled key that supports it.
  - With secrets ON, `apply` takes back only the grants it made itself. They are remembered in
    `company/state/guardrails-applied.json`. A grant the owner made in the station is left alone.
- **promptInjection**: the station has no switch for it, so `apply` does nothing for it.
- **Every other switch**: framework-only. The station has nothing to change, and `apply` does not invent an endpoint.

## Zero-guardrails mode

`off-all --by owner --confirm "I understand there are no guardrails"` turns off every switch except `halt`. After that:
- agents may push to default branches;
- sudo passes through, once `install.sh` has been re-run;
- agents may read keys;
- files anywhere may be read;
- no spend cap holds a run;
- the owner gates follow the governance levels;
- external actions are only logged.

`on-all --by owner` puts every switch back. Run `apply` after either command.

This mode is meant for experiments, and ideally in a disposable container or VM. Two things help you keep track:
- `sandbox on --by owner` records that the station runs isolated, which quiets the `show` banner;
- `sandbox detect` reports whether the process looks containerised (`/.dockerenv`, `/run/.containerenv`, cgroup names,
  the `container` environment variable, an overlay root). It is informational only: nothing is decided from it.

### Example: running the station in Docker (an example, not a supported recipe)

```
# from the project root, on a throwaway host or VM
docker run --rm -it --name capheos-lab \
  -v "$PWD":/company -w /company/starnet \
  -e STARNET_WORKSPACES=/company/.starnet-data/workspaces \
  -e PORT=8801 -e STARNET_API_TOKEN="$(cat secrets/station-token)" \
  -p 127.0.0.1:8801:8801 \
  node:22 node sidecar/index.js
# then, in the same container (docker exec -it capheos-lab bash):
node /company/company/tools/guardrails.js sandbox on --by owner
node /company/company/tools/guardrails.js off-all --by owner --confirm "I understand there are no guardrails"
node /company/company/tools/guardrails.js apply
```

The mount gives the container the whole project, `secrets/` included. Use a copy of the project, with keys you are
willing to lose, and not the live company's checkout. The container keeps agents off the host only if you add no host
mounts, Docker socket or `--privileged`.

## Guardrails and self-governance

They answer different questions:

- **Self-governance** (`company/state/governance.json`, set with `governance.js`) answers *who decides*. For each
  category (hiring, models, spend, ...), the accountable seat decides alone (`auto`), decides and tells the owner
  (`notify`), or proposes and waits for the owner (`approve`).
- **Guardrails** (`company/state/guardrails.json`, set with `guardrails.js`) answer *what is blocked no matter who
  decides*. The merge gate refuses an agent's push to `main` even at `auto`, and even if the CEO approved it.

The two meet at one point. While `ownerGates` is ON, the four fixed owner gates are `approve` whatever their level.
With it OFF, those categories follow their level like any other.

## Tempo: bounds, not a level

How often the company wakes (the dispatcher tick, seat cooldowns, wakes per tick, loop clocks) sets how fast the day's
spend is used, how often liveness sees a heartbeat and how quickly an owner message is answered. The `schedules`
self-governance level alone would let the Founder remove its own throttle at `auto`, so tempo has owner-set **bounds**
in `company/work/ops/cadence.json`: inside them the crew may make a *temporary* change (logged with a reason, expiring
back to the owner's base, rate-limited) at the `schedules` level; outside them, and the bounds themselves, are the
owner's or a reviewed change (finance, risk and people, never the proposer). The dispatcher also caps wakes per hour
and per day and honours quiet hours. Details: [docs/TEMPO.md](TEMPO.md).
