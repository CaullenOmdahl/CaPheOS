# Security watch: known holes in the parts we run

`company/tools/security-watch.js` checks every part the company runs against the public lists of known security holes
(CVEs and advisories). A serious hole in a part that is really in use here becomes a **P0**: the security seat (the
`risk` function) is woken at once. When the part is one the framework ships or pins, one P0 issue goes to the framework's
GitHub repository so the fix reaches every company. It is plain code: no AI scans anything. AI is used only by the seat
that fixes the hole.

## How it runs

| step | where | network | writes |
|---|---|---|---|
| **refresh**: inventory, match, record, report, issues, owner notices | `dispatch.js`, every tick, before the duties (real work only when due) | through the external gate only | `company/state/security/`, `company/work/security/` |
| **duty** `security-watch` | the duty runner, every 15 min | none (`CAPHEOS_NO_NETWORK`) | nothing |
| **wake** | the dispatcher, from the duty's `priority: "P0"` | — | one handoff with **Priority:** P0 |

A new P0 the crew can act on asks the duty runner to run `security-watch` in the same tick (`duty-runner.js requestRun`,
`company/state/duty-run-now.json`): it runs first, past its 15-minute cadence and ahead of the per-tick cap, so the seat
is woken in the tick the hole is found.

Due means: `rescanHours` (6) since the last good check, a part changed (the fingerprint is the list of installed
parts and versions, so an `npm install` is seen on the next tick), or the owner pressed **Check now** (Settings ›
Security). A failed check is retried after `retryMin` (30). The check is time-boxed (`timeBudgetMs`, 25 s) and caches
every advisory record, so a tick on a slow machine stays short.

## What is checked

- the framework's tracked lockfiles (`git ls-files`);
- the station checkout: `starnet/package-lock.json`, each entry confirmed in `starnet/node_modules` (the version on disk
  wins; another platform's optional package is "not installed here");
- the crew's own packages (`deps.js` locks);
- the company's projects: `company/projects.json` roots (approved, active) and `company/repos/*` clones, 5 folders deep —
  `package-lock.json`, `pnpm-lock.yaml` (v5, v6, v9), `go.sum` (modules actually built in, not `/go.mod`-only lines),
  `pubspec.lock` (pub.dev packages), `requirements*.txt` (exact `==` pins);
- **not covered, and listed as such** (Settings › Security › "Not covered", and the headline says some parts could not
  be checked): any other lockfile it finds (`yarn.lock`, `Podfile.lock`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`,
  ...), a requirements line not pinned to one version (`foo>=1.2`), and packages from a private source (npm `resolved`
  not on the public registry, a pnpm tarball/git resolution, a pub git/path/private-host package): their names are never
  sent to the public database, since a private package name can identify the company;
- Node (this process), Chrome and Python on the machine (probed at most daily);
- system packages when they are in the advisory database: Debian/Ubuntu (dpkg) and Alpine (apk). Inside the container
  that is the container image. Other systems (Arch, CachyOS) are listed as not covered.

## Matching

1. **OSV** `POST api.osv.dev/v1/querybatch` (one ecosystem at a time, 1000 parts a call), then `GET /v1/vulns/<id>` for
   each new or changed record (cached under `company/state/security/osv/`). A record with no severity label (CVSS v4
   only, most PyPI and distro records) takes the label of its CVE alias's record when that has one.
2. **npm audit** (`registry.npmjs.org`) for every npm lockfile when OSV cannot answer for npm. It can add findings, never
   clear one.
3. **CISA known-exploited** list (daily) marks "exploited in the wild".
4. **Node**: nodejs.org's release index — a newer release in the same major line marked `security`. **Chrome**: Google's
   version history — a newer stable build. One finding per runtime (`RUNTIME-NODE`, `RUNTIME-CHROME`): a new upstream
   release moves the target on the same finding; it is fixed when the installed version reaches the target.

**Fixed means checked.** A finding missing from a scan is marked fixed only when every place it was found was really
checked in that scan: its ecosystem answered OSV in full, its runtime's feed answered, and its advisory record could be
read (or the lockfile or runtime is gone). A feed that fails, a time budget that runs out, an OSV ecosystem that fails
(npm audit or not) or a record that cannot be read keeps the finding open, and the check counts as **partial**: the
results it has are kept, it is retried after `retryMin`, and it is not a good check (after 2 × `rescanHours` without one
the duty says so, item `sec-stale-<date>`). Fully offline: the last results stand. A hole that comes back after it was
fixed is told to the owner again.

## Levels

| level | rule | what happens |
|---|---|---|
| **P0** | in a part really in use here: exploited in the wild (CISA KEV, whatever the severity label); or critical or high **and** a fixed release exists; or critical with no fix (mitigate now) | the security seat is woken at once, past its rest, ahead of other work; owner told in one plain line; a P0 issue upstream when the part is the framework's |
| **P1** | high, in use, no fix yet | a workaround item; watched, and it becomes P0 the check a fix appears |
| **P2** | medium or low, or only used while building or testing | listed; one item a week while one has a fixed release (none with no fix: nothing to do yet) |
| **P3** | not installed on this machine | listed only |

One finding per (advisory, package): the same hole in the station and in a project is one finding with two places;
advisory aliases (GHSA, CVE, PYSEC) are one advisory.

## The fast track (P0)

The P0 handoff links `company/work/security/security-watch.md`, which says per place what to do:

- **station** — bump the package (its dependency and any npm `overrides` entry) in `starnet/package.json`, `npm install` in
  `starnet/`, restart with `restart-station.js` (it waits for idle). The permanent fix is the framework issue (a
  `company/patches/` diff and the `STARNET_REF` pin in `scripts/setup-station.sh`).
- **crew packages** — `deps.js add … ==<fixed>`; the age guard is waived for **that exact fixed release only** while the
  P0 is open (logged `age-waived`); licence, scripts, typo and integrity checks still apply.
- **projects** — a branch, the pre-merge check, the merge gate (never a push to a default branch).
- **this machine** (Chrome, Node, system packages) — the owner is asked once, in plain words, because installing needs
  the machine's administrator (the `deps.js` system-package precedent). Once asked, a P0 whose every place is on the
  machine is the owner's, not the seat's: the duty stops waking the seat for it (no empty AI runs, no STALLED flag), and
  Settings › Security says it waits for the machine update.

`security-watch.js mitigate <id> --by <risk seat> --how "…"` records a workaround (it clears a P1, not a P0 with a fix).
`hold <id> --why … --until …` sets one aside: a P0 only with a workaround recorded and for at most 7 days.

## The framework issue

For a P0 in a part the framework ships or pins (station, framework files, container image) the watch files ONE issue on
the repository the company root's `origin` points at (`github:<owner>/<repo>#issues`, gate category `publish`, act
`issue_create`; the CEO is asked once for the standing row). A P0 in a company project goes to that project's repository.
Labels `P0` and `security` (created when missing). Dedupe across companies: the body carries `secwatch-<16 hex>` (from
advisory + package + repository) and the watch searches for it first, so the second company to see it records the link
and files nothing. GitHub's search index lags by seconds to minutes, so when the search finds nothing the watch also
lists the newest 100 issues with the `P0` label (a plain listing, not a search) and matches the token or the exact title
before it files. The issue names the advisory, severity, package, versions, fixed release, the framework place and the
workaround: never the company's name, people, paths or hosts. Advisory text is cleaned and `@mentions` are defused.

## The owner

- found: one line per check, from the security seat: "Riley found a known security hole in a part we use (the program the
  crew works in) and is fixing it now. Nothing is needed from you." (the day's digest);
- fixed: "The security hole Riley found in the program the crew works in is fixed.";
- still open after `ownerUrgentHours` (72) with no workaround: one urgent line, still nothing to do (for a machine update:
  one reminder of the question);
- a fix only the machine's administrator can install: one plain question on Today, and the "found" line then says "a
  separate message asks you for it" instead of "Nothing is needed from you".

Settings › Security shows the same in plain words, with every id and version inside "Technical details".

## Files

`company/state/security/{watch.json,inventory.json,runtimes.json,kev.json,osv/}`, `company/work/security/`
`{security-watch.md,security-watch-decisions.jsonl,security-watch-log.jsonl,security-watch-egress.md}`. Policy:
`company/work/security/security-watch.json` over `company/defaults/work/security/security-watch.json`.
