# Security watch — design and build (2026-11-19)

Owner's ask: the security seats must actively check open CVEs against everything in the environment, treat an
affected part as **P0** and fix it as soon as possible; when the fix belongs to a core, upstream or synced part, also
raise it as a **P0 issue on our own repository**. Users are average non-technical people: everything they see is
explained like they're five.

Built on branch `security-watch` in the worktree
`<scratch>/wt-secwatch`
(not pushed). Operational doc for the framework: `docs/SECURITY-WATCH.md`.

---

## 0. What the hand check found, corrected

The brief said the sharp/librsvg hole has no fix. **It has one.** `GHSA-wq5f-xc86-pv6w` (OSV record, recorded
2026-11-19): affected `sharp <0.35.5`, **fixed in 0.35.5** (published 2026-09-27, 53 days old, librsvg 2.63.2). `npm audit`
says `fixAvailable: false` only because the station's `package.json` pins it with `"overrides": { "sharp": "0.35.4" }`, so
npm cannot move it by itself. So this is a **P0 with a fix**: change the override (and the dependency) to 0.35.5.

- The `@huggingface/transformers` and `kokoro-js` "high" lines in npm audit are the same hole reached through sharp
  (`via: ["sharp"]`), not separate advisories; OSV reports only sharp. Bumping sharp clears all three.
- The station already hardens sharp in `sidecar/local-voice.js` (blocks GIF/TIFF/VIPS loaders) but **not SVG**, and
  `sidecar/tools/builtin/image.js fitToSize` decodes image bytes from an outside image service with sharp (format sniffed
  from the bytes). That path is where untrusted SVG could reach librsvg. The mitigation, until the bump lands, is
  `sharp.block({ operation: ["VipsForeignLoadSvg"] })` in both places.
- The moderate one is `fast-uri 3.1.7` (five advisories, LOW/MODERATE, fixed 3.1.8/3.1.9): P2.

Live check (OSV only, on a throwaway copy that symlinked the station read-only): 131 station parts → 1 P0 (sharp), 5 P2
(fast-uri), matching the hand check.

---

## 1. Shape

One plain-code tool, `company/tools/security-watch.js`, in two halves that respect the duty contract (duties open no
socket):

```
dispatcher tick ──► security-watch refresh      (network via the external gate; time-boxed; real work only when due)
                      inventory → OSV match (npm audit fallback) → KEV / Node / Chrome → findings
                      → company/state/security/watch.json + company/work/security/security-watch.md
                      → P0 issue upstream (gh, gated, deduped)   → plain owner notice   → host-fix owner question
duty runner     ──► security-watch --duty       (read-only, no network) → {due, priority:"P0", items, evidence}
dispatcher      ──► P0 wake: the risk seat, at once, past its rest, first in line; handoff with **Priority:** P0
```

It is "core distribution": registered in `company/tools/duties.js` (enabled by default), called by `dispatch.js`, so
every company on the framework has it without enabling a module. Security seats today: Phil (auditor, ca-phe-digital)
and Ingrid Halvorsen (risk, sandbox) both hold `risk`, which is the route.

Cost: **no AI to scan.** One OSV batch call per check (≤1000 parts each), cached records, small daily feeds. AI runs only
when the woken seat fixes something.

RAM / potato: the inventory is a lockfile parse plus a `package.json` read per station part (~130 small files); the
fingerprint is computed every tick, the network only when due; the check is capped at 25 s; nothing stays resident.
Caches and temp files are small and under the company root (container-ready, one volume); `npm audit` fallback uses a
temp dir that is removed (this machine's /tmp is RAM: a few hundred KB).

Push wakes: this is a plain-code generator in the sense of the push-wakes plan — the scan produces items and the
P0 wake is pushed by the dispatcher in the same tick; the duty is the item carrier. If the push-wakes spec lands with an
inbox-item writer, `refresh` can write the item directly and keep the same ids (`sec-<8 hex>`), and the duty becomes the
safety net.

---

## 2. Inventory (`inventory()`)

| source | how | where.kind | reachable here |
|---|---|---|---|
| framework lockfiles | `git ls-files '*package-lock.json' '*requirements*.txt'` in the company root | `framework` | yes |
| station | `starnet/package-lock.json` (v1/v2/v3), each entry confirmed in `starnet/node_modules/<path>/package.json`; the version on disk wins; `STARNET_REF` read from `scripts/setup-station.sh` | `station` | installed: yes; other OS/CPU optional: no (P3) |
| crew packages | `company/state/deps/node/package-lock.json`, `company/state/deps/python.lock` | `company-deps` | yes when `company/env/*` is built |
| projects | `company/projects.json` roots (approved/active; the framework and the station skipped) and `company/repos/*` clones; `package-lock.json`, `requirements*.txt` to depth 3 | `project` (+ its GitHub remote) | yes ("ships in the project") |
| runtimes | Node = this process; Chrome / Python by `--version` (cached 24 h; never in the duty) | `runtime` | yes |
| system packages | `/etc/os-release` → Debian/Ubuntu (`/var/lib/dpkg/status`, by source package) or Alpine (`/lib/apk/db/installed`) | `os`, or `container` inside the container (that is the image) | yes |

Anything with `dev: true` is "only used while building or testing" (P2 at most). Not covered, and said so in the view:
the host's own packages on a distribution OSV does not index (this machine: CachyOS), Python itself (packages are
checked), the container base image from outside the container (checked from inside).

**Fingerprint** = hash of every source's (path, version, installed) list plus runtime versions. Not file times: an
`npm install` that changes `node_modules` but not the lockfile is a change; a touched file with the same content is not.

## 3. Matching

- **OSV** `POST https://api.osv.dev/v1/querybatch` (`{package:{ecosystem,name},version}`; npm, PyPI, Debian:N, Ubuntu:N,
  Alpine:vN), then `GET /v1/vulns/<id>` only for records not cached or with a newer `modified`. Cache:
  `company/state/security/osv/<id>.json`.
- **npm audit** fallback when OSV fails: `npm audit --json --package-lock-only` per npm lockfile in a temp copy (scrubbed
  env, gate host `registry.npmjs.org`, which deps.js already uses); advisories converted to the same record shape
  (fixed from the `<X` range).
- **Exploit known**: the CISA KEV catalog (daily, `www.cisa.gov`), matched on CVE aliases.
- **Node**: `nodejs.org/dist/index.json` — a newer release in the same major line with `security: true`.
- **Chrome**: `versionhistory.googleapis.com` stable channel — a newer stable build than the installed one.
- Every host passes the **external gate** (`network`); a refused host is asked of the CEO once as a standing row
  (`company/work/security/security-watch-egress.md` is the justification), exactly the deps.js registry pattern.
- **Offline-tolerant**: a failed check keeps the last results (nothing is ever marked fixed by a failed check), records
  the error, retries in 30 min; after 2 × `rescanHours` with no good check the duty raises `sec-stale-<date>`, so the
  watch going blind is never silent.

Severity: GHSA `database_specific.severity` (MODERATE = MEDIUM), else ecosystem severity, else a computed CVSS v3 base
score; CVSS v4-only records without a label are UNKNOWN (never P0 on their own). Fixed release: the `fixed` event of
the range the installed version is in (not a fix for another major line).

## 4. What counts as P0, and dedupe

| level | rule | action |
|---|---|---|
| **P0 fix** | CRITICAL/HIGH (policy `p0Severities`) **and** in a part really in use here **and** a fixed release exists | wake now; fix |
| **P0 mitigate** | CRITICAL/HIGH, in use, exploited in the wild (KEV) with no fix; or CRITICAL with no fix | wake now; workaround |
| **P1** | HIGH, in use, no fix, not exploited | workaround item (normal wake); becomes P0 the check a fix appears |
| **P2** | MEDIUM/LOW in use, or anything only used while building/testing | one weekly item `sec-p2-<isoweek>` |
| **P3** | not installed on this machine | listed only |

Dedupe: one finding per (canonical advisory, ecosystem, package) — canonical = first GHSA id among id+aliases, else CVE;
every place it occurs is a location (station + project = one finding). Finding id `sec-<8 hex>` is stable across checks,
so the duty item, the handoff, the decisions and the issue all key on it. A finding that disappears from a good check is
`fixed` (kept 30 days).

## 5. The P0 item and the wake

The duty (`--duty`, read-only) returns
`{due, reason, route:"risk", key, items:[{id:"sec-…"}], priority:"P0", evidence:"company/work/security/security-watch.md"}`;
reason e.g. `P0 sharp 0.35.4 in station — GHSA-wq5f-xc86-pv6w high, fixed in 0.35.5; 5 smaller known hole(s) (P2): …`.

Framework changes for P0 (small, general — any duty may use them):

- `lib/duty-runner.js parseDue` keeps `priority` (only `"P0"`) and `evidence` (only a path under `company/work/`).
- `dispatch.js`: a P0 duty item puts its seat in `p0Wake` → rest 0 (like a met dependency), ordered right after owner
  messages and before hiring/other wakes, reason prefixed `P0`; the handoff heading starts `P0 duty …` and carries
  `**Priority:** P0 — work this before anything else; the owner is told it is being fixed` and `**Evidence:**` the report.
  The daily money cap, halt, admit and the stall rule still apply (an owner rule, not ours to lift).
- `company/HANDOFFS.md` documents the optional `**Priority:** P0` line.

The report (`company/work/security/security-watch.md`, rewritten after each check) holds per finding: what, severity,
ids, fixed release, every place (path, version → fixed, through which parent), why it is reachable, the mitigation, the
fast-track steps for each place, the issue link, decisions, references, and when it counts as done. Advisory text is
labelled outside data.

## 6. The fast-track fix path

Per place, from the report:

- **Station** — bump the package in `starnet/package.json` (dependency + any `overrides` entry), `npm install` in
  `starnet/` as `setup-station.sh` does, restart with `restart-station.js` (waits for idle). Permanent: the framework
  issue (a `company/patches/` diff + `STARNET_REF`). For sharp: override `0.35.4 → 0.35.5`, and add `VipsForeignLoadSvg` to
  the blocked loaders in `local-voice.js` and before `fitToSize`.
- **Crew packages** — `deps.js add … ==<fixed> --why "security <advisory>"`. **New in deps.js:** the age guard is waived
  for the exact first fixed release of an open P0 here (`security-watch.js fastTrack`), logged `age-waived`; a newer,
  unreviewed release still waits; licence, install scripts, typo and integrity checks are unchanged.
- **Projects** — branch, pre-merge check, merge gate (the one standing rule: no push to a default branch).
- **Framework files** — a framework request (`harness-change.js propose`), tracked by the issue.
- **This machine** (Chrome/Node/system packages on the host) — the crew cannot install; the owner is asked once (below).
- `mitigate <id> --by <risk> --how …` records a workaround (clears P1 and P0-mitigate; a P0 with a fix stays due).
  `hold <id> --why … --until …`: a P0 only with a workaround and ≤ 7 days, others ≤ 90; expires by itself. `reopen`.
  Only the risk seat, the CEO or the owner record these.

## 7. The P0 issue on our repository

When a P0 sits in a part the framework **ships or pins** (station, framework files, container image) the watch files
ONE issue on the repository the company root's `origin` points at (both companies: `CaullenOmdahl/CaPheOS`). A P0 in a
company **project** goes to that project's GitHub repository. Crew packages and host runtimes are company-local: no
issue.

- Gate: `publish`, target `github:<owner>/<repo>#issues`, act `issue_create`. No row → nothing filed, the CEO gets one
  handoff (Priority P0) with the exact `external-gate.js clear … --acts issue_create --agent any` command; retried every
  30 min.
- Dedupe across companies: token `secwatch-<16 hex>` = hash(advisory, ecosystem, package, repo) in the body; before
  filing, `gh issue list -R repo --state all --search "<token> in:body"`. Found → link recorded, nothing filed. The
  second company to see the same hole files nothing. (A sub-second race between two companies' ticks could double-file;
  accepted — the second is closable as a duplicate.)
- Title: `P0 security: sharp below 0.35.5 — GHSA-wq5f-xc86-pv6w (high)`; labels `P0`, `security` (created if missing).
- Body: advisory + aliases, severity/KEV, package, the framework place (e.g. "the station checkout the framework pins
  (scripts/setup-station.sh STARNET_REF), package-lock path `node_modules/sharp`"), installed → fixed versions, the
  workaround, references, token. **Never** the company name, owner or seat names, absolute paths, hostnames. Advisory
  text is cleaned and `@mentions` defused (no pings from outside text).
- gh runs with a fixed minimal env; tests use a fake gh (no real issue was created).

## 8. The owner (plain words)

Through `lib/owner-notice.js` (passes the strict plain check in tests):

- found (one line per check, digest): **"Phil found a known security hole in a part we use (the program the crew works
  in) and is fixing it now. Nothing is needed from you."** — several: "…found 2 known security holes in parts we use (…)
  and is fixing them now."
- fixed: **"The security hole Phil found in the program the crew works in is fixed."**
- still open after 72 h with no workaround: one urgent line, still "Nothing is needed from you."
- the one ask: a fix only the machine's administrator can install (Chrome, Node, system packages on the host) —
  "The Chrome web browser on this machine is missing a security update. The crew cannot install it, because installing
  programs on the machine needs its administrator. Please update it, or pass this to whoever looks after the machine."
  (`inbox.js ask`, once per finding; the deps.js system-package precedent). This is not a fixed gate; see open question 2.

Part names in plain words: "the program the crew works in" (station), "the company's own software" (framework), "the box
the company runs in on its server" (container), "a tool the crew added for its own work", "one of the company's
projects", "the Chrome web browser on this machine", "the engine the company's programs run on" (Node), "this machine's
system software". Package names, ids and versions only under technical.

## 9. Console: Settings › Security

New section `#/settings/security` (`console/ui/js/screens/settings/security.js`, `GET /api/security` =
`security-watch.js view --json`, `POST /api/security/check` = Check now as the owner):

- headline: "No known security holes that need fixing in the parts we use." / "One known security hole in a part we use
  is being handled by Phil." + status tag (All clear / Being fixed / Check overdue / Not checked yet);
- what it is: "Software sometimes has mistakes that could let a stranger in. When one is found, a public warning is
  published. Every 6 hours, and whenever a part changes, the company checks every part it uses against those warnings.
  A serious one goes straight to Phil, who fixes it the same day. You are only asked when something needs you.";
- last checked, offline note, **Check now**;
- one card per hole: the part in everyday words, Fixing now / Workaround / Small / Fixed, who and since when; "Technical
  details (for the crew)" collapsed: advisory, package, versions, fixed in, severity, where, workaround, issue link;
- what is checked, and what the public warnings do not cover (collapsed).

## 10. Schedule and triggers

- every dispatcher tick: inventory fingerprint (no network);
- full check: every `rescanHours` (6), at once on a fingerprint change (a lockfile, `node_modules`, runtime or system
  package change), at once on Check now; failed → retry after `retryMin` (30);
- KEV, Node, Chrome feeds: at most daily; runtime probes: at most daily;
- duty: every 15 min (re-checked within 30 min while due);
- not while halted or under a restart hold (the dispatcher returns before it).

Policy: `company/defaults/work/security/security-watch.json` (company copy at `company/work/security/`, the risk seat's):
rescanHours, retryMin, p0Severities, ownerUrgentHours, p0HoldMaxDays, holdMaxDays, issues on/off, issueLabels, hosts.

## 11. Parts (what changed)

New:
- `company/tools/security-watch.js` — refresh / --duty / inventory / list / show / view / mitigate / hold / reopen /
  fasttrack / check-now / selftest.
- `company/defaults/work/security/security-watch.json` — policy defaults.
- `console/ui/js/screens/settings/security.js` — Settings › Security.
- `docs/SECURITY-WATCH.md`.
- `company/tools/tests/security-watch.test.js` (15 tests), `company/tools/tests/fixtures/security-watch/` (real station
  lockfile trimmed, real OSV records incl. GHSA-wq5f-xc86-pv6w, real npm audit answer, synthetic KEV/Node/Chrome feeds).
- `tests/security-walk.js` — headless Chrome on the mock: Settings › Security, desktop + phone.

Changed:
- `company/tools/duties.js` — duty `security-watch` (route risk, 15 min, enabled by default).
- `company/tools/lib/duty-runner.js` — `priority` / `evidence` in the duty contract, kept on state and view.
- `company/tools/dispatch.js` — `security-watch refresh` before the duties; P0 wake (rest 0, first after owner), Priority
  and Evidence lines.
- `company/tools/deps.js` — the security fast track on the age guard.
- `console/server.js` — `GET /api/security`, `POST /api/security/check`; `console/ui/js/routes.js`, `settings.js` — the
  section; `console/ui/dev/mock-api.js` — serves the real view over the fixture company (temp dir, removed on exit).
- `company/tools/tests/duties.test.js` — registry list; a dispatcher test that a P0 duty wakes past rest with Priority and
  Evidence while a plain one waits.
- `tests/console-routes-walk.js` — eight Settings sections.
- `company/tools/INVENTORY.md`, `company/runbooks/tool-management.md` §7b, `docs/DUTIES.md` (§1 contract, §5 row),
  `company/HANDOFFS.md` (Priority line), `scripts/test.sh` (the walk).

## 12. Tests

- `node company/tools/security-watch.js selftest` — 14 checks end to end on the fixture (P0 sharp with the SVG mitigation,
  one issue, one plain notice, host ask, duty, no repeats, fast track, bump → fixed + one fixed notice).
- `node --test company/tools/tests/security-watch.test.js` — 15: parsers (npm v3 dev/platform, requirements, dpkg by
  source, apk, os-release); severity/fixed/canonical (range-correct fixed, CVSS v3); the P0/P1/P2/P3 table incl. KEV and
  critical-no-fix; alias + two-place dedupe; first fixture end to end with report steps; issue body has no company data
  and defuses mentions; cross-company issue dedupe; gate refusal → CEO asked once, retry; OSV down → npm audit (recorded)
  finds the same P0, then fully offline keeps results and goes stale; due logic (rescan / fingerprint / Check now);
  mitigate/hold/reopen rules and who may; the duty is read-only with no socket (guarded child) and parseDue's
  priority/evidence validation; owner notices through the real owner-notice in strict mode; plain console view; deps
  fast track exactness.
- `node --test company/tools/tests/duties.test.js` — 16 (incl. the new P0 wake test, the read-only/no-network registry
  checks with security-watch in them).
- `node tests/security-walk.js` — 11 checks; Chrome is killed by process group and its profile removed.
- Live (once, by hand, OSV only, throwaway copy): the real station lockfile → sharp P0 + 5 fast-uri P2.

## 13. Open questions

1. **The station fix needs a framework patch.** sharp 0.35.5 and `VipsForeignLoadSvg` are changes in `starnet/`
   (an override bump + two block lists) carried as a `company/patches/` diff. The watch files the issue; someone
   (Nadia, tools) writes the patch — a P0 for the framework today.
2. **Host updates ask the owner.** The owner said "nothing needed from you unless a fixed gate"; a Chrome/Node/system
   update on the host cannot be done by the crew (no admin). I followed the deps.js system-package precedent (one plain
   question). Alternative: route only to the risk seat and let the CEO fold it into the daily message. Owner's call.
3. Container image: its system packages are checked only from inside a running container; a scheduled `docker scout`/
   image rebuild is out of scope until Docker is the deploy path.
4. Python runtime itself has no wired feed (packages are covered). Arch/CachyOS host packages are not in OSV: shown as
   not covered.
5. The P0 wake does not bypass the owner's daily money cap. If the owner wants security fixes to run even at the cap,
   that is an owner rule to add.
