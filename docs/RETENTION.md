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
node company/tools/retention.js selftest
```

The dispatcher runs `apply` once a company day (`retention.daily()`, one fail-safe hook in `dispatch.js`, right after
`handoff-archive.js`), then `audit`, and writes one `RETENTION:` line to the dispatch log (what moved, any error, any
file over its bound).

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

Entry formats: `jsonl` (one row per line, time from `at`/`ts`/...), `lines` (a leading ISO time), `md-entries` (a line
starting `- YYYY-MM-DD` or `| YYYY-MM-DD`, with its continuation lines; `entry` overrides the pattern, `single` makes
each entry one line), `md-sections` (a `## ` section dated in its heading). A line with no time is never moved.
`keepIf: "clearance-live"` keeps every external-gate clearance that still clears something (not closed, `until` in the
future), whatever its age. A file whose last line has no newline yet is left for the next run.

The archive of a file that already lives in an `archive/` folder (the handoff archives) is `<that folder>/<name>/YYYY-MM.md`.

## The artifacts (defaults)

| artifact | live window | readers |
|---|---|---|
| `company/work/decisions.md` | 30 days | agents (in full), competence.js verify (anchors), console (paged) |
| `company/work/dispatch-log.md` | 3 days | corrections.js (performance flags), competence.js verify (anchors), console (paged), health-check (mtime) |
| `company/work/incidents.md` | 180 days, newest 20 always | agents, incident-open.py (today's ids) |
| `company/work/merge-gate.log` | 90 days | default-branch-watch.js (ALLOWED lines of recent merges) |
| `company/work/external-actions.jsonl` | 90 days | evidence.js |
| `company/state/external-clearances.jsonl` | 90 days + every live clearance | external-gate.js check |
| `company/work/handoffs/archive/*.md` | 30 days | agents looking for an older thread |
| `company/state/model-moves.jsonl`, `company/state/pacer-log.jsonl`, `company/work/security/locked-changes.jsonl` | 90 / 30 / 90 days | their tools |
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
5. The live file is replaced through a temp file and a rename, only if it still holds what was read; a pure append
   since then is carried over; any other change leaves the live file whole (the archive then holds a second copy of
   those entries, which the next run moves again; nothing is lost).
6. The roll is recorded in the provenance log: `prov.rolled(file, { before, after, ops, chunks }, 'retention.js')`.

Archives are append-only. Rolls are idempotent: a second `apply` the same day moves nothing.

## Locked files and the provenance log

`company/tools/locked-watch.js` treats `decisions.md` as grow-only and the other logs as append-only: a shorter file
would be "history rewritten". A retention roll is the one exception, and it is checked, not trusted: for a file with a
trusted `retention.js` roll row since the last check, the watcher **rebuilds the file as it was** from the live file
and the archived chunks named in the row (each read back at its offset with its sha256; the result must hash to the
row's `beforeSha`), then runs its usual check on the whole history (appends tiled for tool-only logs, prefix unchanged,
grow-only). A roll that does not rebuild byte for byte is reported, never accepted and never "repaired".
The whole `apply` runs under the watcher's lock (`withWatchLock`), so a tick never sees a roll half done.

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
| performance.js, hire.js, cap-numerator.js, model-stats.js, routine-length.js | their own window (hours or days), from the end |
| locked-watch.js | the last 3000 lines (32 MB at most); transcripts: the segments whose manifest range reaches the window |
| default-branch-watch.js | a 6 MB tail |
| provenance.js | the newest two transcript segments, 3 MB each |
| console (server, activity, chat) | a tail or the window since a hire |

Still reading runs.jsonl in full (follow-ups, not yet changed): `dispatch.js` (the daily spend sums, two loops over the
file), `pacer.js` and `models.js`. locked-watch.js also hashes runs.jsonl on every tick to prove it only grew
(an integrity check, not a parse) and keeps a last-known-good copy of it.

## Adding an artifact

Add a row to `company/defaults/work/ops/retention.json` (framework) or `company/work/ops/retention.json` (one company:
a row with the same `id` replaces the default). Give it a `bound` (`bytes`, `rows`, `days`), the `readers`, and run
`retention.js apply --dry-run` then `status`.
