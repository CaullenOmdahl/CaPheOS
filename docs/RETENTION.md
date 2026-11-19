# Retention: every file the company reads has a bound

**The invariant: any file an agent or a per-tick tool reads in full must have a bound.**

A company runs for months. A log that one dispatcher tick, or one agent's loop, reads from the first byte costs that
read on every later tick and every later run, and the cost only grows. So every such file is one of:

1. **bounded by policy**: `company/tools/retention.js` keeps it inside a bound written in
   `company/work/ops/retention.json` (defaults: `company/defaults/work/ops/retention.json`), or
2. **read bounded**: the reader takes a tail, a time window or a byte offset, never the whole file
   (`company/tools/lib/bounded.js`), or
3. **owned elsewhere**: StarNet's own files (below). CaPheOS never shortens them; every CaPheOS reader is case 2.

A new log, register or folder that something reads in full gets a row in `retention.json` in the same change. A new
reader of a file that is not bounded reads it with `lib/bounded.js`.

## Commands

```
node company/tools/retention.js status [--json]   # each artifact: size, rows, age of its oldest live entry, bound, over/under
node company/tools/retention.js apply [--dry-run] # roll, rotate and archive by the policy
node company/tools/retention.js audit             # exit 1 if any bounded artifact is over its bound
node company/tools/retention.js find <artifact> <text> [--limit N] [--json]
                                                  # lines with <text> in the live file and every archive month
node company/tools/retention.js selftest
```

`find` takes an artifact id (`decisions`, `dispatch-log`, `incidents`, ...), a live path, or a handoff archive's stem
(`to-founder`), and searches the live file first, then the archive months newest first (case-insensitive). The pointer
line a roll leaves in the live file names the archive files and this command, so an agent that reads only the live file
still knows where history went and how to reach it.

The dispatcher runs `apply` once a company day (`retention.daily()`, one fail-safe hook in `dispatch.js`, right after
`handoff-archive.js`), then `audit`, and writes one `RETENTION:` line to the dispatch log (what moved, any error, any
file over its bound). On every other tick the same hook only stats the files that have a `maxLiveBytes`; one past it is
rolled then and there (`RETENTION (size bound): ...`), so a busy day cannot grow a live file past its byte bound.

## Policies

| policy | what happens |
|---|---|
| `roll-monthly` | entries older than `keepDays` move into `<dir>/archive/<name>/YYYY-MM.<ext>` by the entry's own month; one pointer line stays in the live file. `keepLast` keeps that many newest entries anyway. |
| `keep-N-days` | the same selection, by `keepDays` (kept as a separate name so a policy file reads plainly) |
| `keep-last-N` | all but the newest `keepLast` entries move the same way |
| `size-rotate` | past `maxBytes`: copied to `<file>.1.gz` (older copies shift up, `keep` are kept) and cut back in place (copytruncate) |
| `archive-dir` | finished records in a folder (commitments in `states`, quiet for `keepDays`) move to `<dir>/archive/YYYY-MM/` |
| `run-journal` | StarNet's `.run-journal/`: a journal with a resolution record, quiet for `resolvedAfterDays`, is removed; an unresolved one quiet for `keepDays` is gzipped to `.starnet-data/run-journal-archive/` (kept `archiveKeepDays`) |
| `never` | not touched; `reason` says who bounds it |

**Whichever bound is hit first.** A row policy may also carry `maxLiveBytes`: once the live file is past it, the oldest
entries move as well (by the time in each entry: `- YYYY-MM-DD HH:MM`, a section's date, a row's `at`), until the file
is back to `rollToFraction` (default 0.75) of the bound, so it is not rolled again on the very next entry. The newest
entry, the `keepLast` newest and every still-live clearance always stay; the pointer line stays at the top. Entries of
the same minute go by file order (which end is newest is read off the file: `decisions.md` is newest first, a handoff
archive oldest first). They go to the archive month of their own date, like any other roll.

Entry formats: `jsonl` (one row per line, time from `at`/`ts`/...), `lines` (a leading ISO time), `md-entries` (a line
starting `- YYYY-MM-DD` or `| YYYY-MM-DD`, with its continuation lines; `entry` overrides the pattern, `single` makes
each entry one line), `md-sections` (a `## ` section dated in its heading). A line with no time is never moved.
`keepIf: "clearance-live"` keeps every external-gate clearance that still clears something (not closed, `until` in the
future), whatever its age. A file whose last line has no newline yet is left for the next run.

The archive of a file that already lives in an `archive/` folder (the handoff archives) is `<that folder>/<name>/YYYY-MM.md`.

## The artifacts (defaults)

| artifact | live window | readers |
|---|---|---|
| `company/work/decisions.md` | 30 days or 48 KB | agents (in full; older: `retention.js find decisions`), competence.js verify (anchors), console (paged) |
| `company/work/dispatch-log.md` | 3 days or 32 KB | corrections.js (performance flags), competence.js verify (anchors), console (paged), health-check (mtime) |
| `company/work/incidents.md` | 180 days, newest 20 always | agents, incident-open.py (today's ids) |
| `company/work/merge-gate.log` | 90 days | default-branch-watch.js (ALLOWED lines of recent merges) |
| `company/work/external-actions.jsonl` | 90 days | evidence.js |
| `company/state/external-clearances.jsonl` | 90 days + every live clearance | external-gate.js check |
| `company/work/handoffs/archive/*.md` | 30 days (monthly) or 200 KB per file | agents looking for an older thread (`retention.js find to-<name>`) |
| `company/state/wakes.jsonl` | 30 days (monthly) | dispatch.js --wake-links (the window plus 7 days, from the end) |
| `company/work/models/house-ranking-history.jsonl`, `company/work/models/routing-proposals.jsonl` | 90 / 180 days (monthly) | model-rank.js verify (the live file; the chain restarts after a roll), refresh and --duty (the last 4 MB) |
| `company/owner/digest.jsonl` | 30 days (monthly) or 4 MB | lib/owner-notice.js (the crew's FYIs not yet folded into the day's one message, read from the end; folded rows are never read again); `company/state/owner-digest.json` (the last folded row, the last 60 days' message ids) is a small file rewritten whole |
| `company/work/models/routing-log.jsonl` | 180 days (monthly) or 2 MB | routing.js status and the console's Routing section (the last 400 rows, from the end): changes and events only, the audit of the owner's routing changes (routing.js) and the pacer's trial holds (lib/routing.js, op trial-held / trial-unheld); `company/state/routing-state.json` (the trials' hold state) and `company/work/models/routing-policy.json` are small files rewritten whole |
| `company/work/models/routing-decisions.jsonl` | 90 days (monthly) or 16 MB | people (why a wake ran on a model; lib/routing.js writes one row per routed wake, the same route as on its wakes.jsonl row) |
| `company/work/models/routing-evaluation.json`, `company/work/models/trials/<id>.md` | replaced whole when the numbers change, no history; one file per trial | model-rank.js refresh, --duty, trials |
| `company/state/model-moves.jsonl`, `company/state/pacer-log.jsonl`, `company/work/security/locked-changes.jsonl` | 90 / 30 / 90 days | their tools |
| `company/state/override-allow.json` | rewritten whole every dispatcher tick, no history (only the current list counts; the station refuses it once 30 minutes old) | the station (StarNet patch 0017) |
| `company/state/locked/provenance.jsonl` | 14 days | locked-watch.js (from its byte offset), default-branch-watch.js (4 MB tail) |
| `.starnet-data/station.log` | 50 MB, 5 gzipped copies | people |
| `.starnet-data/workspaces/.run-journal/` | resolved: 1 day; unresolved: 30 days | StarNet recovery, external-gate.js (15-minute window) |
| `company/work/commitments/` | finished + quiet 30 days | commitments tick (open only), verify tick (done only); `get()` falls back to the archive |
| `company/work/ledger/ledger.jsonl` | never rolled | the tick verifies the hash chain from its last anchor (`company/state/ledger-anchor.json`); `ledger.js verify --full` checks it all |
| `company/work/external-idempotency.jsonl`, `company/work/people/competence-events.jsonl` | never | a removed row would let an act repeat / the hash-chained ledger |

## Never losing a byte

A roll of one file, in order:

1. The file is read and split into units whose texts concatenate to the file **exactly** (else it is left alone).
2. Each archive it will append to is checked against the size and sha256 recorded after its last append
   (`company/state/retention-state.json`). An archive edited by hand is refused, never extended; the live file is not
   touched and `audit` keeps reporting it over its bound until a person looks.
3. Each moved chunk is appended, read back, and its sha256 and line count compared with what was meant.
4. Index lines (an artifact's `index` patterns) are copied to `<archive dir>/index.<ext>`.
5. The pointer line is written (first roll) or replaced, when this roll adds an archive file it does not name yet; the
   old pointer text goes into the roll's provenance row inline (`{inline, bytes, sha256}`), so the rebuild below still
   has every byte of the file as it was.
6. The live file is replaced through a temp file and a rename, only if it still holds what was read; a pure append
   since then is carried over; any other change leaves the live file whole (the archive then holds a second copy of
   those entries, which the next run moves again; nothing is lost).
7. The roll is recorded in the provenance log: `prov.rolled(file, { before, after, ops, chunks }, 'retention.js')`.

Archives are append-only. Rolls are idempotent: a second `apply` the same day moves nothing.

## Locked files and the provenance log

`company/tools/locked-watch.js` treats `decisions.md` as grow-only and the other logs as append-only: a shorter file
would be "history rewritten". A retention roll is the one exception, and it is checked, not trusted: for a file with a
trusted `retention.js` roll row since the last check, the watcher **rebuilds the file as it was** from the live file
and the archived chunks named in the row (each read back at its offset with its sha256; the result must hash to the
row's `beforeSha`), then runs its usual check on the whole history (appends tiled for tool-only logs, prefix unchanged,
grow-only). A roll that does not rebuild byte for byte is reported, never accepted and never "repaired".
The whole `apply` runs under the watcher's lock (`withWatchLock`), so a tick never sees a roll half done.

New `decisions.md` entries go in at the top (newest first) through `company/tools/decision.js` (add, amend, withdraw),
also under the watcher's lock, each recorded as `prov.inserted(file, { before, after, offset }, 'decision.js')`. The
watcher takes recorded rolls and inserts back out in the order they happened (each must leave exactly the recorded
bytes), so a roll and a decision.js write in the same tick are checked as a whole and stay quiet; an entry edited in
place is still "history rewritten".

The provenance log itself (`company/state/locked/provenance.jsonl`) is rolled last, inside
`locked-watch.rebaseProvenance()`: only rows before the watcher's byte offset (already read) may move, and the stored
offset and the log's baseline entry are updated in the same operation. A shrunk log with no rebase still reads from 0
(`provenance.readFrom`) and is reported as rewritten.

Readers skip the pointer a roll leaves in a JSONL file (`{"_retention": "rolled", ...}`): `modkit.readJsonl`,
`external-gate.js`, `lib/bounded.js`, the console.

## Competence anchors across a roll

The competence ledger's anchor rows live in `decisions.md` and in the dispatch log's daily line. When they roll out,
their lines are copied to `company/work/archive/decisions/index.md` and `company/work/archive/dispatch-log/index.md`;
`competence.js verify` reads each file as live + index (`anchorText()`), so every anchor ever written is still checked
without reading every month of the archive.

## StarNet owns runs.jsonl and the transcripts

`.starnet-data/workspaces/runs.jsonl` and `.starnet-data/workspaces/transcript-history-v2/` are StarNet's. CaPheOS does
not prune them; StarNet owns their retention. Every CaPheOS reader takes a bounded part:

| reader | what it reads |
|---|---|
| external-gate.js | the last 72 h from the end (cached per process while the file is unchanged); a clearance written earlier is matched by a binary search for the runs that ended around its moment (8 MB at most) |
| competence.js | the station's paged `/api/runs` |
| corrections.js, harness-change.js | the last 60 days, from the end |
| performance.js, hire.js, cap-numerator.js, model-stats.js, routine-length.js, model-rank.js | their own window (hours or days), from the end (model-rank.js: windowDays plus 8 days, at most readBounds.runsMaxBytes) |
| locked-watch.js | runs: the last 3000 lines (32 MB at most); integrity: incremental (below); transcripts: the segments whose manifest range reaches the window |
| dispatch.js (spend sums), pacer.js (24 h spend, 48 h refusals and limits, 7 days of DeepSeek runs), models.js (72 h per seat) | that window, from the end (`lib/bounded.js jsonlWindow`) |
| default-branch-watch.js | a 6 MB tail |
| provenance.js | the newest two transcript segments, 3 MB each |
| console (server, activity, chat) | a tail or the window since a hire |

No CaPheOS reader takes runs.jsonl whole. locked-watch.js proves it only grew without hashing it: the manifest marks it
`bigAppend`, and the baseline keeps `{bytes, headSha, tailSha}` (the size at the last check and the sha256 of its first
64 KB and of the 64 KB before that end). A tick reads those 128 KB: both unchanged and the file no shorter is "appended";
anything else is "history before the last check was rewritten" (flagged, never restored). No copy of it is kept (an
older last-known-good copy is deleted at the next accept). A baseline from before this format is checked once in full,
then kept in the new one. The selftests run each reader over a 48–96 MB file and fail if it is read whole or is slow.

## Adding an artifact

Add a row to `company/defaults/work/ops/retention.json` (framework) or `company/work/ops/retention.json` (one company:
a row with the same `id` replaces the default). Give it a `bound` (`bytes`, `rows`, `days`), the `readers`, and run
`retention.js apply --dry-run` then `status`.

## Temp files, headless browsers and RAM

Files are not the only thing that grows. On most Linux hosts `/tmp` is a tmpfs, so every byte left there is memory (and
swap once memory is full), and a headless browser nobody closes holds 0.8-1 GB. Three parts keep a long-running company
lean enough to share a small machine with a local model:

- **The company's own temp dir.** `scripts/setup-station.sh` makes `.starnet-data/tmp` (mode 0700) and runs the station,
  the dispatcher and the console with `TMPDIR` there. Agents' Python tempfiles, Flutter / web build trees, the station's
  browser profiles and Claude CLI prompt files land on disk, under the company, not in RAM. The container does the same
  (`TMPDIR=/data/tmp`, a 64 MB `/tmp`).
- **The sweeper.** `company/tools/tmp-sweep.js` removes temp entries that are old enough and that no running process
  uses (an open file, a working directory, a mapped file, a socket, or a command line naming it). Each class has a scope:
  **own** (everything in the company's private temp dir; in a shared temp dir only the framework's own test names and
  station leftovers of one of THIS company's recorded station pids) or **host** (Python tempfile dirs, build trees,
  Chrome's temp entries, station leftovers of an unknown pid: names the owner's own programs and another company make
  too). The automatic sweep (the reaper, below) takes the own scope only; the host scope is the owner's button
  (`reaper.js host-sweep --apply --by owner`). `status` shows what would go.
- **Tests clean up however they end.** `company/tools/lib/temp-life.js` registers a test's temp dirs and helper
  processes (Chrome, the mock station, a console) and removes / ends them on exit, on an error and on SIGINT / SIGTERM
  (the signal `scripts/test.sh`'s per-step timeout sends). Chrome is started with `TMPDIR` inside its profile, so its own
  `com.google.Chrome.*` entries go with the profile. `scripts/test.sh` sweeps the test class once more when it ends.

## The reaper (company/tools/reaper.js)

The one **chore** among the duties (docs/DUTIES.md): it acts, not only reports. The dispatcher runs it every 15 minutes
(10 under the low memory profile), **also while the company is halted**, and it wakes the crew (the tools function) only
for something they must fix, so routine clean-up never costs an agent run. Each action is one plain line in
`company/state/reaper.jsonl` (kept 30 days) and the run's summary one line in the dispatch log. `reaper.js status`
shows what it would do now, touching nothing.

**Only what it can prove is this company's** (`company/tools/lib/owned.js`): a browser profile, working folder (also a
deleted one) or `TMPDIR` inside the company root (realpath, path + separator: `/x/co` never claims `/x/co-2`); a process
inside one of its units; one of its recorded station pids (`company/state/reaper.json`, the last 50); a receipt in the
station's process ledger matched by pid and identity. **Never**: the owner's own Chrome (not driven, or a profile under
`~/.config`), another user's process, a process in a unit or scope the company does not own, the live station, console
or dispatcher, a registered background service, anything matched by name only, a local AI model.

| Step | What | Halted |
|---|---|---|
| browsers | a driven Chrome of the company whose parent is gone, with no client on its debugging port, older than 30 min (10 under low): ended (TERM to its group, 3 s, KILL to all naming its profile), a temp profile removed. The station's own browser is never killed (StarNet patch 0020 closes it when idle); idle past 3 x the idle time it is reported | runs |
| strays | the company's processes handed to init, outside its units, older than 6 h (3 under low): flutter_tester, dart frontend/analysis servers, Gradle / Kotlin daemons, esbuild --service, a mock station or test walk, an orphaned test station, pytest are ended; any other kind is reported once a week | runs |
| temp | tmp-sweep own scope: the private temp dir (older than 24 h and unused; 6 h under memory pressure), the framework's test names and the company's station leftovers in `/tmp`. A name pattern leaking 200 entries or 1 GB a day for 2 days is reported once a week | runs |
| retention | the folder rules below, once a company day | skipped |
| sample | `memory.js sample` into `company/state/memory-samples.jsonl` (kept 14 days); a unit growing for 48 h without a restart (+50 % and +150 MB, same pid) is reported once a week. Nothing is ever restarted | runs |
| pressure | free memory under keep-free + 256 MB (under low also under 300 MB): the station's browser is closed when no run drives it, temp ages are halved, `company/state/memory-pressure.json` is written; still short after 3 runs: reported | runs |

**Growing folders** (`retention.js dirPolicies`, rows in `company/defaults/work/ops/retention.json`): `keep-newest-dirs`
(old workspace backups: the newest 3 kept), `age-dir` (old simulation output), `merged-worktrees` (a git worktree under
`scratch/` merged into its repo's default branch, clean, quiet 14 days: `git worktree remove`, never `rm`), `report-only`
(the station's own checkpoints and recovery records; the migration rehearsal copy). Deleting company data is the owner's
decision: every row ships `"enforce": false` and is only measured. Past its `warnBytes` the owner gets **one** card per row
("Old copies of the workspace backups take 9 GB of disk. Remove them automatically from now on, always keeping the
newest 3?"). Their yes is recorded in `company/state/reaper.json` and the row is enforced from then on (or set
`"enforce": true` on the row); a no is not asked again. `workspaces-rehearsal` is asked about only after the migration
cutover is recorded (`company/state/migration-cutover.json`).

## Memory (company/tools/memory.js)

`company.json` `runtime.memory` (unset = automatic): `profile` `auto` | `low` | `normal` (auto: low on 4.5 GB or less),
`keepFreeMB` (memory the company never plans to use: for a local AI model, its size plus 1 GB), `visibleBrowser` (off:
the station's browser is headless and closes itself when unused; a window never does). `memory.js plan` shows the numbers
(`--total MB` for another machine); every value is rounded down to 64 MB:

| Machine | profile | keep free | station High / Max | console | dispatcher | private browsers / idle close |
|---|---|---|---|---|---|---|
| 2 GB | low | 0 | 896 / 1152 MB | 160 / 300 | 128 / 640 | 1 / 5 min |
| 4 GB | low | 0 | 1984 / 2560 | 160 / 300 | 128 / 640 | 1 / 5 min |
| 8 GB | normal | 0 | 3584 / 4992 | 256 / 512 | 256 / 1024 | 3 / 15 min |
| 16 GB | normal | 6 GB | 4608 / 6400 | 256 / 512 | 256 / 1024 | 3 / 15 min |
| 62 GB | normal | 16 GB | 23040 / 32256 | 256 / 512 | 256 / 1024 | 3 / 15 min |

Under low also: Node heaps 384 / 128 / 160 MB, at most 2 agents at once, background services 256M by default and 1G at
most (512M / 4G otherwise), Chrome's low-memory flags. `memory.js apply` (run by `scripts/setup-station.sh`; by the owner
with `memory.js set ... --by owner`) writes only its own files: a drop-in `<unit>.service.d/50-capheos-memory.conf` per
unit (MemoryHigh, MemoryMax, MemorySwapMax, and the template's own ExecStart with `--max-old-space-size`: never in
`NODE_OPTIONS`, which every agent's node build would inherit) and `.starnet-data/memory.env` (0600; the station's browser
and shell settings for StarNet patch 0020, ignored by a station without it). It applies the limits live with
`systemctl --user set-property --runtime` and never restarts anything; a changed heap or memory.env is printed with the
safe restart that waits until nothing runs. The station unit has no `ManagedOOMMemoryPressure=kill` on purpose
(systemd-oomd would kill every run in it): the kernel picks inside the unit, the sidecar at `OOMScoreAdjust=100`, agent
commands at 500 (patch 0020), console and dispatcher at 200 with oomd's kill (they restart by themselves). The console's
Settings › System › Health shows a Memory row (Fine, Tight, Short) and the plain line from `memory.js status`.
