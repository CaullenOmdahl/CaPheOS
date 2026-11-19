# RAM lifecycle: build spec

**Owner's ask (2026-11-19):** everything that uses RAM gets a lifecycle. A long-running company must not grow its memory use: left-open headless browsers and temp files piling up are the examples. Keep as much RAM free as possible for a future local AI model (failover, low-intensity work). The company should run on a potato.

**Base:** worktree `<scratch>/wt-ram`, branch `ram-lifecycle`. The base commit is **7c8dec9** (on top of origin/main 8dde227; not pushed; `scripts/test.sh` 119/119 pass). That commit already contains:
- `company/tools/lib/temp-life.js`, adopted by 18 walks and console tests;
- `company/tools/tmp-sweep.js`, which the dispatcher runs hourly through a direct call at `dispatch.js:894`;
- `TMPDIR=<root>/.starnet-data/tmp` in the station env file and in the dispatcher and console units;
- a container `/tmp` of 64 MB with `TMPDIR=/data/tmp`;
- the end-of-run sweep in test.sh.

Every part below builds on 7c8dec9. None of them redoes it.

StarNet line numbers refer to `~/Companies/capheos-sandbox/starnet` (StarNet v0.15.0 `e316231d` plus the CaPheOS patches).

**Patch numbers:** origin has patch records up to 0017. ca-phe-digital already carries local records `0018-browser-editing-keys` and `0019-attach-shared-input-slot`, so the new record takes **0020**. Before writing it, the builder re-checks every company's `company/patches/` for a collision.

**House rules that apply to every part:**
- Commit only the paths you name. Run `git log origin/main..HEAD` before any push.
- Plain words to the owner. No owner question about anything the crew is already allowed to do.
- New work must be container-ready: no hard dependency on systemd, and state lives under the company root.
- Never touch the live ports 8800, 8810, 8900 or 8910, and never restart a live unit from a test.
- Every new tool gets a `selftest` that runs against a temporary company (`CAPHEOS_ROOT`) with a fake `systemctl`, `ps` and `/proc` where needed. The selftest is added as a step in `scripts/test.sh`, gets an `INVENTORY.md` row, and passes `tool-parse` and `tool-inventory-check`.

---

## Decisions this spec makes (and why)

1. **The reaper acts. It does not just report.** The duty contract (`duties.js`, `lib/duty-runner.js`) only allows read-only checks today. Part 4 adds one explicit exception, a **chore** (`acts: true`). The chore cleans up quietly and exits 0. It exits 1, which wakes the crew, only for something the crew must fix, so routine cleanup never costs an agent run.

2. **"Never another company's or the owner's own files" narrows tmp-sweep.** Today `tmp-sweep tick` removes the `pytmp`, `build` and `chrome` classes from the shared `/tmp`. Those entries cannot be traced to any company: the owner's own Python and Chrome create the same names, and so does the other company. After Part 4:
   - The automatic sweep removes anything old and unused in the company's own private temp dir, which is where everything now lands because of TMPDIR.
   - In the shared `/tmp` it removes only entries it can prove are its own:
     - CaPheOS test-walk names, which are framework-unique;
     - `starnet-browser-<pid>-*` and `starnet-claude-cli-<pid>-*` whose pid is one of this company's recorded station pids.
   - Clearing the rest of the shared `/tmp` becomes an owner action, with one button and one command. It is never automatic.

3. **No `ManagedOOMMemoryPressure=kill` on the station.** systemd-oomd kills a whole unit cgroup, which would take the sidecar and every run with it. The station instead gets the following, and the kernel's in-unit out-of-memory killer then picks the build first:
   - `MemoryHigh`, which throttles and reclaims before the hard limit;
   - `MemoryMax`;
   - agent shell commands at `oom_score_adj` 500, set by the patch.

   Console and dispatcher may use `ManagedOOMMemoryPressure=kill`, since `Restart=` brings them back. It only takes effect where systemd-oomd runs, and is harmless where it does not.

4. **The Node heap cap goes in ExecStart, not `NODE_OPTIONS`.** A value in `NODE_OPTIONS` would be inherited by every agent's `node` build and break it.

5. **Memory settings live in their own two files, which `company/tools/memory.js` writes:**
   - a systemd drop-in, `~/.config/systemd/user/<unit>.d/50-capheos-memory.conf`, for each unit;
   - `<root>/.starnet-data/memory.env` for the station (the station unit gains `EnvironmentFile=-…/memory.env`).

   Changing the profile from the console then never rewrites the main unit or the env file that holds the token. The container reads the same `memory.env`.

6. **The station browser is headless on every installed company by default.** The owner runs it from a browser over the network, so a visible window on the server is never seen. A visible window also never idles out (`browser-view.js:24-25`, `:149-150`). An owner who wants the window at the desk sets `runtime.memory.visibleBrowser: true`.

7. **Deleting company data on disk is the owner's decision.** It is not RAM, but potatoes have small disks too. Every growing-folder rule ships as `report-only`. It starts deleting only after one plain owner card per rule ("Old backup copies of the workspace: keep the newest 3 and remove the rest automatically?").

---

## Memory profiles and the numbers (used by every part)

`company.json` gains `runtime.memory`. `found-company.sh` and the defaults leave it unset, which means `auto`.

```json
"memory": { "profile": "auto", "keepFreeMB": 0, "visibleBrowser": false }
```

- `profile`:
  - `auto` means `low` when MemTotal is 4.5 GB or less, otherwise `normal`;
  - `low` and `normal` can also be set explicitly.
- `keepFreeMB`: memory the company never plans to use, kept for other programs. This is the local-AI reserve. A model of 4-8 GB is typical, so the console suggests `size of the model + 1 GB`. The company itself plans for **0.6 GB at rest** on a potato.

`plan({ totalMB, profile, keepFreeMB })` in `lib/memory.js` is pure. Every value is rounded down to 64 MB:

```
osReserve = low ? 400 : 1024
budget    = max(1024, totalMB - keepFreeMB - osReserve)
station   heap   low 384 | normal 1024        (sidecar --max-old-space-size; peaks seen 1.11-1.26 GB RSS, heap ~0.3)
          High   max(700,  0.55*budget) low | 0.50*budget normal
          Max    max(900,  0.70*budget) low | 0.70*budget normal      (the station's cgroup also holds agent builds)
          SwapMax = 0.5*Max
console   heap 128 | 192; High 160M | 256M; Max 300M | 512M
dispatcher heap 160 | 192; High 128M | 256M; Max 640M | 1G   (its per-tick child tools peaked ~600 MB)
services  default MemoryMax 256M | 512M; proposal ceiling 1G | 4G   (service.js)
browsers  private per-run browsers max 1 | 3; station browser idle close 5 | 15 min; low-memory Chrome flags on | off
agents    STARNET_MAX_CONCURRENT_AGENTS 2 | unset (0 = no limit)
reaper    every 10 | 15 min; orphan browser min age 10 | 30 min; temp ages halved under pressure
```

Worked rows. The selftest asserts these exactly; values are MemoryHigh/MemoryMax in MB.

| Machine | profile | keepFree | station | console | dispatcher | browsers private / idle |
|---|---|---|---|---|---|---|
| 2 GB | low | 0 | 896 / 1152 | 160 / 300 | 128 / 640 | 1 / 5 min |
| 4 GB | low | 0 | 1984 / 2560 | 160 / 300 | 128 / 640 | 1 / 5 min |
| 8 GB | normal | 0 | 3584 / 4992 | 256 / 512 | 256 / 1024 | 3 / 15 min |
| 16 GB | normal | 6144 | 4608 / 6400 | 256 / 512 | 256 / 1024 | 3 / 15 min |
| 62 GB (here) | normal | 16384 | 23040 / 32256 | 256 / 512 | 256 / 1024 | 3 / 15 min |

(62 GB = 63488 MB. Each value is the formula rounded down to a multiple of 64 MB.)

**Flutter builds** (27 GB peak here) will not fit a potato. Under `low`, the reaper's report says so in plain words the first time a build is killed by the memory limit, instead of the crew retrying in a loop.

---

## Part 1: `lib/memory.js` and `company/tools/memory.js` (facts, plan, samples)

**Files:**
- new `company/tools/lib/memory.js`
- new `company/tools/memory.js`
- new `company/tools/tests/memory.test.js`
- `company/defaults/work/ops/retention.json`: add a row for `company/state/memory-samples.jsonl` with `keep-N-days` 14
- `docs/RETENTION.md`
- `INVENTORY.md`

**`lib/memory.js` (pure apart from reading `/proc`; every reader is injectable):**
- `host()` returns `{ totalMB, availableMB, swapTotalMB, swapUsedMB, zram: bool, tmpfsTmp: { sizeMB, usedMB } | null, oomd: bool }`. The values come from `/proc/meminfo`, `/proc/swaps`, `statfs('/tmp')` and the mount type, and `systemctl --user is-active systemd-oomd`. Only when systemd is the supervisor (`lib/host.js`).
- `settings(company)` returns `runtime.memory` with its defaults. `profileOf(settings, host)` resolves `auto`.
- `plan(...)` is described above.
- `units(company)` returns the unit names `<svc>`, `<svc>-console`, `<svc>-dispatch`, plus registered services from `company/state/services.json`.
- `usage(company)` returns, per unit, `MemoryCurrent`, `MemoryPeak` (when present), `MemoryHigh`, `MemoryMax` and `MainPID`, taken from a single `systemctl --user show -p … <units>` call.
  - The station's browsers are counted separately, because Chrome may sit in its own `app-com.google.Chrome-*.scope` until Part 3 lands. They are found with Part 4's `ownedBrowsers()` and summed as Proportional Set Size from `/proc/<pid>/smaps_rollup`.
  - Private temp dir size uses a bounded `du`-style walk with a cap and a "more than" flag.
  - In a container, with no systemd, it uses `/sys/fs/cgroup/memory.current` for the whole container.
- `sample(company)` appends one line `{at, host:{availableMB, swapUsedMB}, units:{name:{currentMB, pid}}, browsers:{count, mb}, tmpMB}` to `company/state/memory-samples.jsonl`.
- `growth(samples)`: for each unit with an unchanged pid (no restart), compares the median of the first 6 hours of the last 48 hours with the median of the last 6 hours. A rise of more than 50% and more than 150 MB counts as `growing`. This is the 48-hour sampler the process audit asked for.

**`memory.js` commands:**

| Command | What it does |
|---|---|
| `status [--json]` | Host, profile, plan, usage, keep-free and what the reaper freed in the last 24 h and 7 d (read from Part 4's `company/state/reaper.jsonl`). One plain summary line on top. |
| `plan [--total MB] [--profile p] [--keep-free MB] [--json]` | What would be set. |
| `set [--profile auto\|low\|normal] [--keep-free MB] [--visible-browser on\|off] --by owner` | Owner only (`lib/owner.js`). Writes `company.json` through the same path the console uses for `company.json` edits, then runs `apply`. |
| `apply [--dry-run]` | Part 2's writer. |
| `sample` | Called by the reaper chore. |
| `selftest` | |

**Tests (`selftest` plus `memory.test.js`):**
- the plan table rows above;
- `auto` at 4.5 GB and 4.6 GB;
- `keepFree` larger than the machine gives `budget` floored at 1024 and a `warning`;
- the `/proc/meminfo` and `/proc/swaps` parsers on fixtures, including zram;
- `growth()` on synthetic samples: flat, growing, and a restart in the middle, which must not count as growing;
- a container fixture.

---

## Part 2: caps and low-memory settings on every unit the framework installs

Depends on Part 1.

**Files:**
- `company/tools/memory.js`, the `apply` command
- `systemd/capheos-station.service.in`, `capheos-station-console.service.in`, `capheos-station-dispatch.service.in`, `capheos-liveness*.service.in`
- `scripts/setup-station.sh`
- `company/tools/service.js`
- `capheos.yml`
- `container/s6/*/run`
- `docs/DEPLOY.md`, `docs/DEPLOY-SERVER.md`

**Templates (static, safe defaults even before `apply` runs):**
- Station:
  - adds `EnvironmentFile=-@ROOT@/.starnet-data/memory.env` after `@ENVFILE@`;
  - adds `MemoryAccounting=yes` and `OOMScoreAdjust=100`. The sidecar is preferred over desktop apps, but loses to agent commands at 500.
- Console and dispatcher: add `OOMScoreAdjust=200` and `ManagedOOMMemoryPressure=kill` with `ManagedOOMMemoryPressureLimit=80%`.
- Liveness units: `MemoryMax=128M`.

**`memory.js apply`:**
1. Computes `plan`.
2. Writes `~/.config/systemd/user/<unit>.service.d/50-capheos-memory.conf` for station, console and dispatcher:

   ```ini
   # written by company/tools/memory.js apply (profile low, 2 GB machine, keep free 0 MB). Edit runtime.memory, not this file.
   [Service]
   MemoryHigh=896M
   MemoryMax=1152M
   MemorySwapMax=576M
   ExecStart=
   ExecStart=/usr/bin/env node --max-old-space-size=384 sidecar/index.js
   ```

   The ExecStart override repeats the template's exact command line. The selftest checks it against the rendered template, so a template change cannot drift.
3. Writes `<root>/.starnet-data/memory.env` (mode 0600):
   - `STARNET_BROWSER_HEADLESS=1`, unless `visibleBrowser`;
   - `STARNET_BROWSER_IDLE_MIN`, `STARNET_BROWSER_LOWMEM=0|1`, `STARNET_PRIVATE_BROWSERS_MAX`, `STARNET_SHELL_OOM_ADJ=500`, `STARNET_SHELL_REAP_GROUP=1`;
   - `STARNET_MAX_CONCURRENT_AGENTS=2` under `low` only.
   - The `STARNET_*` keys from Part 3 are harmless on a station without patch 0020: they are ignored.
4. Runs `systemctl --user daemon-reload`. Then, for each running unit, `systemctl --user set-property --runtime <unit> MemoryHigh=… MemoryMax=… MemorySwapMax=…` so the caps apply live without a restart.
5. A changed heap or a changed `memory.env` needs a restart. `apply` never restarts the station. It prints, and returns in `--json`, the safe command `scripts/restart-station.sh --when-idle --reason "memory profile"`. The console then offers it (Part 7). Console and dispatcher restart through their existing safe paths (`/api/ops/restart/console`; the dispatcher finishes its tick on SIGTERM).
6. Records every file it wrote with `locked-watch.js accept <path> --by owner --why "memory settings (memory.js apply)"`, the same way `setup-station.sh` does, so no drift flag appears.
7. Writes nothing unless the owner (or setup) asked. The reaper chore never calls `apply`.

**`setup-station.sh`:** after writing the units (step 4), it runs `node company/tools/memory.js apply` and prints the plan in one line: "Memory: low profile for this 2 GB machine; the station may use up to 1.1 GB; 0 MB kept free for other programs."

**`service.js`:**
- The default `--memory` comes from `plan().services.defaultMax` instead of the fixed `512M`. The ceiling comes from `plan().services.ceiling` instead of `4G`.
- `render()` adds `MemoryHigh` at 80% of `MemoryMax`, `OOMScoreAdjust=300` and `MemorySwapMax` at 50%.
- The "raised limits" owner reason (`service.js:404`) compares against the plan's default.
- `rerender` already reaches installed units.
- Selftest: under a fake `low` host a proposal gets 256M; 2G is refused as over the 1G ceiling; the rendered unit carries `MemoryHigh`.

**Container (`capheos.yml`, s6 run scripts):**
- `mem_limit` is commented, with the plan's container row.
- The s6 run scripts source `/data/.starnet-data/memory.env` when present, and pass `--max-old-space-size` from it: `CAPHEOS_STATION_HEAP`, `CAPHEOS_CONSOLE_HEAP` and `CAPHEOS_DISPATCH_HEAP` are written into `memory.env` by `apply` when the supervisor is `container`.

**Tests:**
- `memory.js selftest` renders the drop-ins for the 2 GB and 62 GB rows into a temp `XDG_CONFIG_HOME`, with a fake `systemctl` that logs its arguments. It checks:
  - `daemon-reload` and `set-property` are called with the right values;
  - the ExecStart override equals the template's;
  - `memory.env` is mode 0600;
  - `--dry-run` writes nothing;
  - a container supervisor writes only `memory.env`.
- `setup-station.sh` is covered by `scripts/instance-update-test.sh`, extended to assert that the drop-in and `memory.env` exist after setup.

---

## Part 3: StarNet patch `0020-memory-lifecycle.diff` (station browser and shell lifecycle)

Independent of Parts 1 and 2. It reads only env vars, each defaulting to today's behaviour.

**Files:**
- `company/patches/0020-memory-lifecycle.diff`, with the standard `#` header (what, status, why, apply, revert)
- `company/patches/README.md` row
- `company/patches/tests/0020.test.js`

Keep it minimal. Each hunk is gated by its env var.

**a. Kill the finished command's process group.** In `sidecar/tools/builtin/shell.js`, inside `finish()` (around `:1541`):
- When `group && process.env.STARNET_SHELL_REAP_GROUP === '1'` and the call is a foreground command (`opts.ledger` kind `shell.fg`; **not** the background manager's tail, `shellbg.js`), send `process.kill(-child.pid, 'SIGTERM')`, then `SIGKILL` 1.5 s later if `kill(-pid, 0)` still succeeds.
- This is what leaves a probe's Chrome behind today. `shell.js:1512` puts the command in its own group, but only timeout and abort kill it (`:1538-1539`).
- The builder confirms that `shellbg.js` does not finish through this path with a live child. If it does, the hunk is limited to the `shell.fg` receipt kind.
- A command that really needs a long-lived process uses the background shell tool, which StarNet already provides. The tool description gains one sentence saying so.

**b. Raise each agent command's out-of-memory score.** With `STARNET_SHELL_OOM_ADJ` set (a number from 0 to 1000), the spawned shell command is prefixed with `echo <n> > /proc/self/oom_score_adj 2>/dev/null;` on Linux. This is a raise only, which an unprivileged process is allowed to do. Builds are then killed before the sidecar.

**c. Chrome stays in the station's control group and takes its temp files with it.** In `sidecar/tools/builtin/browser.js` at the launch (`:1402`), spawn with:
- `env: Object.assign({}, process.env, { DBUS_SESSION_BUS_ADDRESS: 'disabled:', TMPDIR: path.join(profileDir, '.tmp') })`, with the `.tmp` directory created first;
- `detached: true` on POSIX, so the browser leads its own group.

`close()` (`:2892`) then kills `-owned.pid`, the whole group, instead of the main pid only.

Without the DBus setting, Chrome 157 moves its main process into `app-com.google.Chrome-<pid>.scope`, outside the unit, so neither the unit's `MemoryMax` nor stopping the unit reaches it. The process audit confirmed this on this machine.

**d. Low-memory Chrome flags.** With `STARNET_BROWSER_LOWMEM=1`, add the following unless already present:

```
--enable-low-end-device-mode
--js-flags=--max-old-space-size=256
--disk-cache-size=33554432
--disable-extensions
--disable-background-networking
--disable-component-update
--disable-sync
--disable-default-apps
--no-first-run
--disable-features=Translate,MediaRouter,OptimizationHints
```

The last one is merged with any existing `--disable-features` (the headed branch already passes one at `:1395`).

`--renderer-process-limit` is **not** included. It weakens site isolation. It sits behind its own `STARNET_BROWSER_RENDERER_LIMIT`, unset by default, and the risk function reviews it before any profile sets it.

**e. Configurable idle close.** `index.js` around `:6138` (`makeBrowserViews({...})`) passes `stationIdleMs: Number(process.env.STARNET_BROWSER_IDLE_MIN) * 60000 || undefined`. `browser-view.js:109` already honours `deps.stationIdleMs`. A visible window keeps today's never-idle rule.

**f. A cap on private per-run browsers.**
- With `STARNET_PRIVATE_BROWSERS_MAX=N` (N > 0), the `makePrivate` path (`index.js:23508`) acquires a slot from a small counting semaphore before Chrome launches, and releases it on close. The builder finds the lazy launch point inside `makeBrowserSession`.
- A run that cannot get a slot within 10 minutes gets a plain tool error: "No browser is free on this station right now (N in use). Try again later or work without the browser." It does not hang.
- Runs without a browser are unaffected.
- Today every concurrent run gets its own Chrome, about 105 MB idle and 200-500 MB in use.

**g. Close every browser when the sidecar exits.** Add a synchronous `process.on('exit')` in `index.js` that sends `SIGKILL` to the process group of every browser receipt still in the proc ledger (`procLedger.list()` entries with kind `browser`). `gracefulShutdown` (`index.js:~14167`) already closes them on SIGTERM. This covers the paths that end in `process.exit` (`index.js:795`). The proc ledger's boot sweep (`index.js:6191-6205`) already covers a force-kill.

**Tests (`company/patches/tests/0020.test.js`):**
- It applies the patch to a temporary copy of `./starnet`, or skips with a reason when no checkout is present. In `scripts/test.sh` it goes under "optional suites".
- It then runs StarNet's own `test/shell.test.js`, `shell.process-tree.test.js`, `shell.fg-ledger.test.js`, `browser-close-cleanup.test.js`, `browser-view.test.js`, `procledger.test.js` and `concurrency.test.js`.
- It adds these cases:

| Area | Case |
|---|---|
| shell | `sleep 300 & echo done` leaves no `sleep` behind when `STARNET_SHELL_REAP_GROUP=1`, and does with it unset |
| shell | `oom_score_adj` of the child reads 500 |
| shell | a background-tool process survives |
| browser | a launched headless Chrome has no `app-com.google.Chrome` line in `/proc/<pid>/cgroup` |
| browser | its `com.google.Chrome.*` temp entries are inside the profile |
| browser | close leaves 0 processes naming the profile |
| browser | with `LOWMEM`, the arguments include the flags exactly once |
| idle | with `STARNET_BROWSER_IDLE_MIN=1` and a fake clock, a headless station browser closes after 1 minute |
| private cap | with a max of 1, a second private session waits, and gets its slot when the first closes |
| exit | a child sidecar with a fake browser receipt calls `process.exit(0)`, and the browser group is gone |

---

## Part 4: the reaper chore (`company/tools/reaper.js`)

Depends on Part 1 for `sample`. It uses `tmp-sweep.js` as a library.

**Files:**
- new `company/tools/reaper.js`
- `company/tools/tmp-sweep.js` (exports, plus the shared-`/tmp` narrowing)
- `company/tools/duties.js`, `company/tools/lib/duty-runner.js`
- `company/tools/dispatch.js` (remove the direct `tmp-sweep` call at `:893-894`)
- `docs/DUTIES.md`, `docs/RETENTION.md`
- `company/tools/tests/reaper.test.js`

**The duty contract gains chores.** A `duties.js` entry may carry `acts: true`.
- `check()` accepts `acts` only for ids on a code-level list, `CHORES = ['reaper']`. The selftest asserts that no other entry acts.
- Registry entry:

  ```js
  { id: 'reaper', tool: 'reaper.js', route: 'tools', everyMin: 15, timeoutMs: 60000, whileHalted: true, enabledByDefault: true, acts: true,
    why: 'closes this company\'s left-behind browsers and stray test or build processes, clears its old unused temp files, keeps growing folders inside their rules, and records memory use; due only when the crew must fix something (a test that keeps leaking, a stray it may not end, memory still short after cleanup, a part of the company whose memory keeps growing)' }
  ```

- The `everyMin` policy may move it within 5-1440. Under `low` it defaults to 10 minutes through `duty-policy` defaults. The selftest "no company duty runs while halted" becomes "only liveness and chores".
- **During a halt:** both kinds of halt still close orphans and clear temp, because that is pure cleanup and frees memory. Retention deletes are skipped, and so is anything that touches a run in flight.

**`reaper.js --duty` (no other argument, per the contract), and by hand:**

| Command | What it does |
|---|---|
| `status [--json]` | What it would do now and why. Touches nothing. |
| `run [--dry-run] [--only browsers,strays,temp,retention,sample]` | Acts; this is what `--duty` does. |
| `host-sweep [--apply] --by owner` | The shared `/tmp` classes it cannot trace to a company (pytmp, build, chrome, and starnet entries of unknown pids). Lists them; removes them on `--apply`. Owner only. |
| `selftest` | |

**What "this company's" means.** Proof is required; when in doubt, the reaper leaves it alone. A process or entry is this company's only if at least one of these holds:
1. Its `--user-data-dir`, its cwd (including a deleted cwd, shown by `readlink` as `<path> (deleted)` when the path was inside the root), or `TMPDIR` in `/proc/<pid>/environ` (same uid, so readable) is inside this company root. The company root is `realpath`'d; another company's root is never a prefix of this one, and the check uses `path + sep`.
2. Its `/proc/<pid>/cgroup` names one of this company's units (`<svc>.service`, `<svc>-*.service`, `<slug>-svc-*`).
3. Its pid, or the pid tagged in a temp-entry name, is in this company's station pid history. That history is `company/state/reaper.json` `stationPids`: the last 50 `MainPID`s of `<svc>.service` with first-seen and last-seen, recorded on every run.
4. It is a receipt in `<root>/.starnet-data/workspaces/proc-ledger.json`, matched by pid **and** command line. The ledger's own identity rule applies: a reused pid never matches.

**Never touched:**
- the owner's own Chrome (no `--remote-debugging-port`/`--remote-debugging-pipe`/`--headless`, or a profile under `~/.config`);
- any process of another uid;
- any process in a unit or scope this company does not own;
- the live station sidecar, console or dispatcher, or their `MainPID`;
- a registered service (`services.json`);
- anything matched only by name.

**What it does each run, in order.** Each action that happened becomes one plain line in `company/state/reaper.jsonl` (`{at, kind, what, plain, freedMB, pid?, path?, seat?}`) and one summary line in the dispatch log. Nothing is logged when nothing happened.

1. **Browsers.** These are Chrome or Chromium main processes that belong to this company and are driven (remote debugging or headless).
   - **Orphaned:** the parent is pid 1, the user's `systemd --user`, or a process that is not this company's live station sidecar.
   - **Idle:** no established TCP connection to its debugging port from any other process (`ss -Htnp`, or `/proc/net/tcp` with the inode-to-pid mapping when `ss` is missing), and no `--remote-debugging-pipe` reader alive.
   - **Old:** older than the plan's minimum age, 30 minutes under `normal` and 10 under `low`.
   - When all three hold: `SIGTERM` to the process group, a wait of up to 3 s, then `SIGKILL` to every process still naming the profile. If the profile sits in a temp dir, it is removed once nothing names it.
   - Log line: "Closed a browser left running by Phil's test (4 h old, 835 MB)." The seat comes from the cwd or profile path (`scratch/<seat>-…`, `workspaces/<agentId>/`, otherwise "a test").
   - A browser whose parent is the live station sidecar is the station's own. The reaper never kills it, because patch 0020 handles its idle close. Exception: a station browser that has been idle by the same proof for more than 3 times the plan's idle time is logged and made due as broken idle-close, routed to tools. It is still not killed.
   - This replaces `tmp-sweep browsers` inside the reaper. `tmp-sweep browsers` stays as a CLI.

2. **Strays.** These are processes of this company (by the proof above) that were handed to `systemd --user` or pid 1, are not in any of this company's unit cgroups, are not a registered service, and are older than 6 hours (3 under `low`).
   - Known kinds are ended (TERM, wait, KILL to the group): `flutter_tester`, `dart … frontend_server`, `dart … analysis_server`, `gradle … GradleDaemon` and `kotlin-daemon` (idle more than 3 h; `--stop` first when the CLI is found), `esbuild --service`, a node `mock-api.js` or `*-walk.js`, a sidecar `index.js` started from a deleted folder or a scratch folder (an orphaned test station), and `pytest`.
   - Any other kind is listed only. It becomes due to tools, once per pid, with its command line shortened and sanitized (`R.sanitize`).
   - Today's examples: the 7 `flutter_tester` in deleted `whx-ui-int` (about 800 MB), the orphaned `sn-fresh` sidecar (pid 66455), and the 8 `starnet-0018-*` browsers.
     - These match only if the proof holds. The 0018 browsers' cwd is `ca-phe-digital/scratch/phil-0018`, so they are ca-phe-digital's and only that company's reaper ends them.
     - The `mock-api.js` processes from Claude worktrees are not any company's, so nobody's reaper touches them. They need a `host-sweep`-style owner action or nothing.

3. **Temp.**
   - **Private dir** (`<root>/.starnet-data/tmp`): everything older than 24 h and not in use goes, using tmp-sweep's existing in-use test (open fds, cwd/root, mappings, unix sockets, command line).
     - Under pressure (step 6) the age is 6 h.
     - Before removal, each top-level entry is attributed to a seat where its name or contents allow (pytest `tmpXXXXXXXX` dirs containing `events.jsonl` map to the test that wrote them, when the crew's test file names it). The counts go to `reaper.json` `leaks{pattern: {perDay}}`.
   - **Shared `/tmp`:** only the `test` class (framework walk names) and `starnet-browser-<pid>*` / `starnet-claude-cli-<pid>*` with `<pid>` in this company's station pid history and not alive.
     - **tmp-sweep's `tick` changes to match:** in the shared dir, the classes `pytmp`, `build`, `chrome` and `starnet` (unknown pid) are skipped by `tick` and kept for `host-sweep`. A new `scope: 'own' | 'host'` field on each class enforces this, and the selftest asserts the split.
   - **Leak report:** a single file pattern leaking more than 200 entries or 1 GB a day for 2 days becomes due, routed to the tools seat: "Crew tests keep leaving temp folders: test_record_ws.py made 3,700 in 2 days. They are cleared automatically, but the test should clean up after itself (tempfile.TemporaryDirectory)." It is due once per pattern per week (the key holds pattern and ISO week).

4. **Retention on growing company folders.**
   - `retention.js` gains a directory policy family, which reuses its logging and state:

     | Policy | What it does |
     |---|---|
     | `keep-newest-dirs` | Siblings matching a glob, e.g. `.starnet-data/workspaces.backup-*` and `.starnet-data/*.generations`: keep the newest N and anything younger than `keepDays`. |
     | `age-dir` | Entries inside a folder older than `keepDays`, e.g. `company/work/sim/out/*` and `company/work/research/*`. Opt-in per company. |
     | `merged-worktrees` | Under `scratch/`: a git worktree whose branch is merged into its repo's default branch, with a clean tree and no file changed for `keepDays` (14). Removed with `git worktree remove`, never `rm`. |
     | `report-only` | Size and age only. Used for `.starnet-data/workspaces/.checkpoints` (StarNet's own) and `workspaces.rehearsal`. |

   - Every new row ships with `"enforce": false`. The reaper reports a folder's size once it passes its `warnBytes`. It deletes only after the owner says yes to that row.
     - The owner is asked through one owner card per row, via `lib/owner-card.js`, ref `retention:<id>`: "Old copies of the workspace backups take 9 GB. Keep the newest 3 and remove older ones automatically from now on?" Yes sets `enforce: true` in `company/work/ops/retention.json`; no sets `ask: false`.
     - `workspaces.rehearsal` asks with its own wording once the migration cutover is recorded, and not before.
   - Each removal is logged ("Removed 2 old workspace backups from before 15 Nov (6.1 GB on disk)"). Never during a halt.
   - The dispatcher's existing daily `retention.daily` keeps file rotation. The reaper runs the directory policies at most once a company day (`reaper.json` `retentionDay`).

5. **Sample.** Runs `memory.js sample`. Then `growth()`: a unit growing for 48 h without a restart becomes due to tools once per unit per week, with the numbers. The company never restarts a unit on its own initiative.

6. **Pressure** (the local-AI headroom; this is where `keepFreeMB` is enforced).
   - Pressure means `availableMB < keepFreeMB + 256`, or under `low` `availableMB < 300`.
   - Under pressure the reaper also:
     - asks the station to close its browser when no run is driving it: `POST /api/browser/view/close` with the station token. The route exists (`browser-view.js:547`). The reaper checks the view list first (`GET /api/browser/view`) and skips a browser that has a `driver`;
     - halves the temp ages;
     - writes `company/state/memory-pressure.json` `{since, availableMB, keepFreeMB}`. Part 8 reads it.
   - Pressure that remains after cleanup for 3 consecutive runs becomes due to tools, and one owner digest line is written per day: "The company had to hold back work for 40 minutes today because the computer was short of memory (kept free: 8 GB for other programs)."

**Exit codes:** 0 when nothing is due, even if it acted. 1 with `{due, reason, route:'tools', key, items}` for the due cases above. Any other code means broken.

**Tests (`reaper.js selftest` plus `company/tools/tests/reaper.test.js`), real but sandboxed:**
- A temp company root and a second "other company" root next to it, whose name shares the prefix (`/x/co` vs `/x/co-2`).
- A real headless Chrome (when one is found; otherwise skip that case with a reason) started:
  - with a profile in the company's private temp dir, a dead parent and nothing connected. With the minimum age set to 0 by a test-only `--min-age`, it is ended, its profile removed, and the plain line written;
  - the same with a live parent, which is kept;
  - with a client connected to its port, which is kept;
  - in the other company's root, which is kept;
  - with a `--user-data-dir` under a fake `~/.config`, which is kept.
- A stray `sleep` with its cwd in the company, re-parented by a double fork: listed, not ended (unknown kind). A fake `flutter_tester` (a copied `sleep` binary) is ended.
- Temp:
  - the private dir with an old entry (removed), an entry held open by a child process (kept) and a young entry (kept);
  - the shared dir with `tmpabcdefgh` (kept by `run`, listed by `host-sweep`);
  - `starnet-browser-<deadpid>-x` with the pid in this company's history (removed) and another (kept).
- Retention:
  - `keep-newest-dirs` with `enforce:false` deletes nothing and files one owner card; with `enforce:true` it keeps 3;
  - a merged and clean worktree is removed with `git worktree remove`; a dirty one is kept.
- Pressure: a fake `/proc/meminfo` triggers the browser-close request against a mock station (no real port; Unix socket or an ephemeral port) and halved ages.
- Contract: `--duty` prints valid JSON only when due; the duty runner's `acts` gate refuses `acts:true` on another id.
- Everything uses Part 6's `temp-life` for its own dirs and Chrome.

---

## Part 5: idle close and queued browser use from the company side (no patch)

Depends on Parts 2 and 3. A small part.

- `memory.js apply` already writes the env (Part 2). This part checks that the station actually behaves.
- `company/tools/memory.js status` gains `station.browser: { open, driver, lastUseAt }` from `GET /api/browser/view`. Reaper step 1 compares it with the idle rule.
- `docs/DEPLOY-SERVER.md`: a "Memory" section covering:
  - profiles and keep-free;
  - why the station browser is headless on a server;
  - the browser-per-company rule: one station browser, at most N private ones, queued beyond N;
  - why Flutter-size builds need a bigger machine;
  - the owner's two optional cleanup buttons.
- **Test:** an end-to-end check in `tests/memory-walk.js` that is skipped without a patched StarNet checkout. It starts a scratch station (never a live port; an ephemeral port in a temp company), with `STARNET_BROWSER_IDLE_MIN=1`, opens the station browser through the API, waits 70 s with a fake-clock override where available (otherwise real time, marked slow and optional), and asserts the browser is closed and no Chrome names the profile.

---

## Part 6: test hygiene (one temp helper, cleanup on exit and on signals, test.sh sweeps before and after)

Independent.

**Files:**
- `company/tools/lib/temp-life.js`
- every test, walk and selftest that makes a temp dir or starts a helper (114 files at the time of writing: `grep -rl "mkdtemp\|os.tmpdir()" tests company/tools console scripts modules | xargs grep -L temp-life`)
- `company/tools/tests/helpers/*`
- new `scripts/check-temp-hygiene.js`
- `scripts/test.sh`

**Work:**

1. **`temp-life.js`:**
   - `chromeEnv()` / `chrome()` add `DBUS_SESSION_BUS_ADDRESS=disabled:`, so a killed walk's Chrome stays in the walk's process group and control group;
   - Chrome is spawned `detached` and tracked as a group;
   - new `life.tmpDirSync(prefix)` for selftests that need a shallow path. Same as `tmpDir`, but it guarantees `os.tmpdir()` plus a prefix of at most 32 characters, because some selftests size text by fixture path.
   - For Python tests in modules there is a `lib/temp_life.py` twin (a `TemporaryDirectory` registry plus `atexit` and signal handlers), or a rule that they use `tempfile.TemporaryDirectory()`/`addCleanup`. Pick the rule if no Python test exists in the framework today, and let the check enforce it.

2. **Migrate every file** that makes a temp dir or a child process for a test to `temp-life`, including tools' `selftest` sections. Runtime uses that are not tests stay as they are, but each is listed in the check's allowlist with a reason (for example `retention.js` writes beside the target and renames; `page-preview.js` cleans up itself). This is mechanical; one builder can split it by folder.

3. **`scripts/check-temp-hygiene.js`:**
   - A static scan. It fails when a file in `tests/`, `company/tools/tests/`, `modules/*/tests/` or a tool's selftest section calls `mkdtemp`, `os.tmpdir()`, `tempfile.mkdtemp` or `spawn` of a Chrome binary without `temp-life` (or `temp_life`/`TemporaryDirectory` in Python), and the file is not on the allowlist.
   - The allowlist is `scripts/temp-hygiene-allow.json`, in which each entry needs a reason.
   - Added to `test.sh` under "parse and inventory".

4. **`scripts/test.sh`:**
   - **Sweep at the start too.** Before the copy, it runs the same `tmp-sweep apply --dir "$SYS_TMP" --class test --min-age 120` that the end runs. A parallel run's live leftovers are in use or younger than 2 minutes, so they stay.
   - **Kill each step's strays.** Each `step` runs under `setsid` (`timeout --kill-after=10 "$TIMEOUT" setsid --wait "$@"`, or `setsid` around the whole subshell; the builder picks the form that keeps `timeout`'s exit 124). After the step ends, passed or failed, it sends `kill -TERM -- -<pgid>`, sleeps 1, then `kill -KILL -- -<pgid>`.
   - **End report.** It counts processes naming `$WORK` or `capheos-test-`/`-walk-` profiles, and fails a final step "no processes left behind" if any remain, listing them. Today a passing walk can still leak.
   - The comment at the top is updated.

5. **A test for the test runner:** a fixture step that starts `sleep 300 &` and Chrome, if available, and exits 0, followed by the final-step assertion that nothing is left. This is `tests/test-sh-hygiene.sh`, run by test.sh itself in a nested temp copy with `TEST_TIMEOUT=20`.

---

## Part 7: console, Settings › System › Memory

Depends on Parts 1 and 4.

**Files:**
- `console/owner-ops.js`: routes and doc block
- `console/ui/js/screens/settings/system.js`: Health row
- `console/ui/js/screens/settings/system-ops.js`: new block
- `docs/CONSOLE-API.md`
- the console tests in `console/server.js`'s selftest section

**Routes** (behind owner sign-in and CSRF like every `/api/ops/*`; each write is one row in `owner-ops.jsonl`):

| Route | What it does |
|---|---|
| `GET /api/ops/memory` | `memory.js status --json` |
| `POST /api/ops/memory {profile, keepFreeMB, visibleBrowser}` | `memory.js set … --by owner`; answers `{ok, restartNeeded}` |
| `POST /api/ops/memory/clean {what: 'shared-temp'}` | `reaper.js host-sweep --apply --by owner`, detached, with its log shown |
| `POST /api/ops/memory/clean {what: 'now'}` | `reaper.js run`, now rather than at the next tick |

**Health row** (`system.js`): `row('Memory', <verdict>, tone, '#/settings/system/memory')`.
- The verdicts are "Fine", "Tight" (pressure in the last hour) and "Short" (pressure now).
- The detail line in plain words: "The company uses 1.2 GB (station 0.9 GB, 1 browser 210 MB, console 90 MB, dispatcher 60 MB). 38 GB free; 8 GB kept for other programs."

**Memory block** (`system-ops.js`, id `memory`):
- Title "Memory". Lede: "What the company uses on this computer, what it cleaned up, and how much it leaves for other programs, like a local AI model."
- It shows:
  - the usage line;
  - "Freed in the last day: 2.3 GB (3 left-behind browsers, 1.1 GB of old temp files)", plus a 7-day line, both from `reaper.jsonl`;
  - the last 5 reaper lines, verbatim plain text;
  - the size of the shared temp folder this company cannot vouch for ("Other leftovers in the shared temp folder: 7.3 GB. Clear them" as a button, with a confirm that names what goes and what never does).
- Controls:
  - **Profile**, a segmented choice:
    - Automatic: "low memory on 4 GB or less";
    - Normal;
    - Low memory: "fewer browsers at once, browsers close sooner, smaller limits; work may be slower".
  - **Keep free for other programs**, a number in GB with the hint "For a local AI model, its size plus 1 GB." It warns, without refusing, when the setting leaves the company under 1 GB.
  - **Show the station's browser as a window on this computer**, a toggle, off by default. Help text: "Only useful when you sit at this computer. A window never closes by itself."
- Saving shows what changed in plain words. When `restartNeeded`, it offers the existing safe "Restart the station when nothing is running" action (reusing `/api/ops/restart/station`).
- Nothing in the block needs a terminal.

**Tests:** the console selftest, with a temp company and a fake `memory.js`/`reaper.js` through the tool runner seam already used for other ops routes, checks:
- GET shape;
- POST refused without CSRF and refused for a non-owner;
- POST records an `owner-ops.jsonl` row;
- `restartNeeded` passes through;
- the clean route runs detached.

`tests/console-routes-walk.js` gains the `#/settings/system/memory` route rendering without console errors, using `temp-life`.

---

## Part 8: headroom for the local AI (admission under pressure)

Depends on Parts 1 and 4.

**Files:**
- `company/tools/lib/admit.js`
- `company/tools/dispatch.js`
- `docs/TEMPO.md` or `docs/BUDGET.md`, wherever admission is documented
- `company/tools/tests/admit-memory.test.js`

**Admission:**
- `admit()` gains a memory gate. When `memory-pressure.json` is younger than 20 minutes, or a fresh `/proc/meminfo` read (cheap, every call) shows `available < keepFreeMB + 256`, it refuses new **non-urgent** starts with `{ok:false, reason:'memory', plain:'Holding new work: the computer is short of memory'}`.
  - The `door` and `kind` categories the gate already knows decide what is urgent: an owner chat, a health check and the liveness door always pass. A dispatcher wake, a crew loop or a scheduled routine waits.
  - Runs already going are never stopped.
- The dispatcher logs one line when the hold starts and one when it lifts.
- **Hysteresis:** the hold lifts when `available > keepFreeMB + 768`.

**Local model detection, for the status line only:** processes named `ollama`, `llama-server`, `llama.cpp`, `vllm` or `lmstudio` (same uid or any uid, read-only) are summed and shown as "Local AI model: 6.2 GB" in Part 7's line. They are never counted as company use, and the reaper never touches them.

**Tests:**
- fake meminfo: below the line holds a dispatcher wake, passes an owner chat, and lifts only past the upper line;
- a stale pressure file older than 20 minutes is ignored;
- `keepFreeMB` 0 under `normal` never holds unless the machine is out of memory: `available` under 256 MB holds.

---

## Part 9: small fixes and docs

Independent.

- `console/chat-runs.js:41`: the `counts` map is never pruned. Add `counts.delete(runId)` where the run ends (`:105`). Test: 1,000 synthetic runs leave the map empty.
- `scripts/backup.sh:40`: the temp dir is left behind when tar fails. Add `trap 'rm -rf "$T"' EXIT`.
- `docs/RETENTION.md`:
  - the reaper (who, what, how often, the never-list);
  - the directory policies and the owner card per row;
  - `memory-samples.jsonl` and `reaper.jsonl` bounds (`keep-N-days` 14 and 30, added to the default `retention.json`).
- `company/tools/INVENTORY.md`: rows for `memory.js` and `reaper.js`; update the `tmp-sweep.js` row to "library and owner CLI; the reaper runs it".
- `company/patches/README.md`: the 0020 row.
- **Company-side hygiene is not edited by the framework.** The reaper's leak report (Part 4, step 3) routes it to the crew:
  - capheos-sandbox `company/work/sim/tests/test_record_ws.py:186,751,846,898,902,1125`;
  - ca-phe-digital `api/src/lib/build-info.test.ts:9,28`, `apps/web/test/build-info.test.mjs:9,24,43`, `scripts/release-bump.test.mjs:14`.

---

## Build order and hand-off

| Order | Part | Depends on | Size |
|---|---|---|---|
| 1 | Part 1, memory lib and tool | none | M |
| 1 | Part 3, patch 0020 | none | M |
| 1 | Part 6, test hygiene | none | L (mechanical) |
| 1 | Part 9, small fixes | none | S |
| 2 | Part 2, unit caps | 1 | M |
| 2 | Part 4, reaper | 1, and Part 6's `temp-life` for its tests | L |
| 3 | Part 7, console | 1, 4 | M |
| 3 | Part 8, admission | 1, 4 | S |
| 3 | Part 5, browser lifecycle check and docs | 2, 3 | S |

Each builder:
- works on its own branch from `ram-lifecycle` (7c8dec9);
- commits only its named paths;
- runs `scripts/test.sh` to exit 0, plus StarNet's listed tests for Part 3;
- does not push to a default branch.

Merging is in the table's order, onto `ram-lifecycle`, then one PR.

**Owner steps after merge.** These are the only ones; the console can do the rest:
1. Re-run `scripts/setup-station.sh` per company. It applies patch 0020, writes the memory drop-ins and `memory.env`, and prints the safe restart.
2. Restart each station through Settings › System › Restarts. It waits until nothing runs.
3. Optionally, use Settings › System › Memory: set "Keep free" for the local model, and press "Clear other leftovers" once. That is about 7 GB of shared `/tmp` today.

**Acceptance on this machine after rollout (measured, not assumed):**
- No Chrome of either company outlives its run by more than the idle time.
- `/tmp` holds no new company entries.
- The private temp dirs stay under 1 GB.
- The sidecars' 48-hour samples are flat.
- The Memory line shows the company total.
- With `keepFreeMB` set, `available` stays above it, or the hold line appears in the dispatch log.
