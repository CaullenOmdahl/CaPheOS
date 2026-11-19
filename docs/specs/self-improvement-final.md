# Self-improvement: the final plan for Ca Phe Digital to develop CaPheOS on its own

Date 2026-11-19 (Thursday). Day 1 below is Friday 2026-11-20.

This plan replaces `self-improvement-spec.md` as the build document. It keeps that spec's shape: generators find work,
a pipeline ships it, a scorecard says whether things got better, and no model run decides when anything happens. It
changes what the critic showed was unsafe or unrealistic, adds the owner's amendments A-C, and reverses one decision:
the company now gets **its own GitHub identity, set up by the owner, and main is protected on GitHub** (spec decision 3,
"keep the existing login", is withdrawn).

Inputs: `self-improvement-spec.md` (called "the spec" below; section numbers like §2.3 refer to it), `self-improvement-survey.md`
(blockers B1-B9), `self-improvement-critique.md` (amendments C1-C15), `self-improvement-amendments.md` (A, B, C),
`accountable-leads.md`, `push-wakes-spec.md`, `autonomous-mode-spec.md` with its critique, `ram-spec.md` and
`MASTER-TRACKER.md`, all in this scratchpad. Facts checked read-only today: CaPheOS main is at `78008c8` (the tempo fix);
the last 5 GitHub Actions runs on main all failed, so CI is still red; the only workflow is `ci.yml` with one job named
`test` that runs `scripts/test.sh`, on every push and pull request; Settings › Connections and keys › Service keys
(`console/service-keys.js`) already accepts pasted multi-line private keys (the Kalshi pattern) through the console's one
secret writer; a global git credential helper is configured for this user.

---

## 0. What changed since the spec, in one place

### 0.1 Blocker status

| Blocker | Status 2026-11-19 | Removed by |
|---|---|---|
| B1 tempo freeze | **Fixed by the orchestrator** (`78008c8`): a wake counts only when a run starts; CPD bounds 100/h, 1000/day like the sandbox. Left over: one Claude refusal still blocks a seat for 24 h. | F7 (refusal backoff) |
| B2 no agent can get a change onto main | open | F1 (owner sets up the identity and protection; code side wires it) |
| B3 no client-side gate; wrappers point at StarnetOS | open | F3 |
| B4 CI red since 2026-11-17 | open (still red at `78008c8`) | F2 |
| B5 framework-request loop goes nowhere | open | F5 |
| B6 update owner-only, no watch window | open | F6 |
| B7 no seat's job includes CaPheOS | open | F7 |
| B8 MiniMax on code seats | **Fixed by the orchestrator**: CPD code seats are Claude-only. Left over: ORG.md drift and no framework-level check that stops it coming back. | F7 (ORG.md generated, `models.js check`), F4 (non-Claude author refused at merge) |
| B9 owner directions not in the repo | open | F8 (first cut), H1-H3 (finished and handed to the crew) |

### 0.2 Owner decisions this plan follows (not reopened)

- CPD merges and deploys its own CaPheOS changes. Only changes that touch the **four fixed owner gates** (access,
  ownership, outside commitments, spending beyond the cap) or the **owner channel** go to the owner.
- No external system for deploys: on-machine staged update, a local plain-code watchdog, automatic rollback; A/B
  checkouts only as the fallback; sandbox first, CPD after a clean window; container-ready.
- DeepSeek rests until the efficiency work lands; the crew finds out what went wrong with its key and credit handling.
- Scout logins for X, Instagram and TikTok approved, through dedicated company accounts in the containerized desktop
  (not built yet); no-login sources until then. The sandbox site list stays as it is.
- Amendment A (target user, plain words as a gate, persona walkthroughs, UX markers) and amendment B (security watch,
  CVEs as P0, a P0 issue on the CaPheOS repo; being built separately on branch `security-watch`) are part of this program.
- Standing rulings kept: Claude writes code, never MiniMax; subscription stops and money are the owner's; the owner never
  needs a terminal; no watcher or judge agent; owner asks only for real owner matters, in plain words; push wakes, never
  ticks; RAM bounded; company data never reaches GitHub; agents keep full GitHub access for other repos, and the one rule
  is no commit on a default branch except by merging a reviewed pull request.

### 0.3 The critic's amendments and how each is handled

All fifteen are applied. None contradicts an owner decision; two are adjusted to fit one.

| # | Amendment | Handled in | How |
|---|---|---|---|
| C1 | Rail tests run from the previous-good copy | F4 | `tests/invariants/` suite; merge check and release run the **previous-good** copy of the suite against the new code. A PR may add invariants, never edit or remove one. |
| C2 | Watchdog runs outside the release; hard deadline; state snapshot | F6 | Watchdog and rollback are a frozen single-file copy from previous-good, on their own timer; rollback waits for idle at most 10 min, then restarts anyway; declared state-format changes get a snapshot restored on rollback. |
| C3 | Planted faults measure detection | F9 | `fault-plant.js` plants one realistic fault a week in the sandbox at a random time; detection rate and time to fix are markers and the handover test. Adjusted: on one Unix user the catalogue cannot be hidden from the crew, so faults are replays of real past failure classes with randomised parameters, and the plant log is salted-hash only until scored. |
| C4 | Hard limits on the shared Claude subscription | F9 | Platform work counted in Claude usage per day and per 5-hour window at the share the owner picks; platform waits first near the owner's stop; at most 3 promoted P0/P1 per generator a day; P0/P1 only from fixed rules. |
| C5 | Close the inbox backlog first | F5 | `inbox-sweep.js`: all 95 open Nadia items (and Omar's 31, Phil's 23, Vy's 12) into the ranked backlog, duplicates merged, untouched 14 days closed with a note, the 22 blocked resolved in one sweep, before any WIP limit applies. |
| C6 | Protect main on GitHub | F1 + owner checklist | Adjusted to the owner's direction: a **GitHub App** for the crew instead of a fine-grained token (narrower, short-lived, no extra account), GitHub Pro so protection works on the private repo, a ruleset on main with no bypass requiring a PR and the `test` check, tripwire every 5 min with an automatic revert PR. If the owner says no to Pro, the plan records that main is guarded by detection only. |
| C7 | Score by outcome, not guesses | G1 | 7 days after release the filer re-measures the item's signature and marker; "no effect" lowers that generator's future impact guesses; effort defaults by class; merged work ≥ 60% real fixes or owner-visible results, measuring tools ≤ 1/3, cosmetic PRs ≤ 2 a week. |
| C8 | Class by reach; host class; apply rule inside framework-update.js; `.github/**` | F4, F6 | Protected-by-import-graph; new `host` class (setup-station, units, wrappers, `~/.config`, Node/Claude CLI) not merged by the crew in the first month; `framework-update.js apply` without the owner checks the sandbox `clean` record for that exact sha itself; `.github/**` is `gate` (and the App has no Workflows permission, so the crew cannot push workflow changes at all). |
| C9 | Fair rollback signal; CPD 24 h; CPD-only smoke | F6 | Provider failures left out, rates per started run; CPD window 24 h with rollback allowed throughout and every daily job seen once; mock smoke adds owner channel, merge train and Baarista paths. |
| C10 | Remove single points of failure | F7 | Omar deputy lead for CI and release; framework requests grouped by code, Nadia approves batches; Phil's probes fall back to Sonnet after an Opus refusal; a backup risk reviewer for `gate` (not `protected`) named by Rachel in F7. |
| C11 | No owner cards for non-owner-gate changes | F4 | Matches owner decision C exactly. Merge rules, scorecard and release tooling are protected by the invariant suite, Phil plus probe, and a 72-hour sandbox wait, with a plain "Undo" notice to the owner. Owner cards only for the four fixed gates and the owner channel. |
| C12 | Watch personality markers, don't rank by them | G4 | Personality and communication markers are watch-only for 4 weeks and their targets are kept out of prompts; ranking uses measured counts only; new marker "messages per accepted item". |
| C13 | Guaranteed research slot | G7 | One experiment always in progress; target "≥ 2 cards a week that pass triage"; F7 checks Marcus's station can browse before the first research item. |
| C14 | Budgets from data; CI on ready; red-then-green once | G1, F2 | Start S 3M / M 8M / L 20M tokens including reviewers, reset to the 75th percentile after week 1; CI runs when a PR is marked ready and on main; the must-fail-first check once per PR. |
| C15 | Re-cut the timeline; handover in weeks 4-5 on planted faults, escapes and real marker moves | §2, H4 | Section 2 is the critic's timeline; H4 is the new handover test. |

---

## 1. The build plan

Each part is buildable by one builder on its own branch, commits only its named paths, ships with the tests listed,
and is done when its **acceptance marker** is met. "Orchestrator" parts are the rails: the crew must not be able to
loosen them, so they are built first and by the orchestrator, landed through the new pipeline as soon as F1-F2 exist
(the orchestrator opens PRs too; nobody pushes to main after the owner's ruleset is on). "CPD platform" parts are built
by the crew through the pipeline.

House rules for every part: tests against a temporary company root, never `~/Companies`; never touch ports 8800, 8810,
8900, 8910; one Chrome at a time and cleaned up (ram-spec Part 6 helper); every new tool has a selftest step in
`scripts/test.sh`, an `INVENTORY.md` row, and passes `tool-parse` and `tool-inventory-check`; owner-facing strings pass
`owner-scope.wordsProblems` at Plain; container-ready (no hard systemd dependency, state under the company root).

### Part F: the pipeline foundation (removes B2-B7 and B9)

Order: F1 (owner part runs in parallel) → F2 → F3 → F4 → F5 → F6 → F7 → F8 → F9. F5 and F7 can run in parallel with F4.

---

#### F1. The company's own GitHub identity and a protected main (B2)

**Owner part:** the checklist in §1.4 (about 20 minutes on the GitHub website and the console). It is the owner's
because it spends money (GitHub Pro) and creates an access credential (a fixed access gate).

**Why a GitHub App, not a machine user.** An App needs no second account, email, phone or password; it cannot sign in to
the website; it gets exactly the permissions ticked (no admin, no workflow edits), and its tokens last one hour. A
machine user needs its own email and two-factor login, and as a collaborator on a personal repository it always gets full
write. The App is the recommendation; a machine user is the fallback if the App cannot be installed.

**Why GitHub Pro.** CaPheOS is private, and GitHub refuses branch protection and rulesets on private repositories of a
free personal account (checked by the critic: "Upgrade to GitHub Pro"). Pro is about $4 a month. Without it, main can be
pushed by anyone holding the owner's login, and the plan falls back to detection (the 5-minute tripwire and revert PR).

**Code side (orchestrator):**
- `company/tools/lib/gh-app.js`: makes an installation token from the App ID and private key in `secrets/`
  (`co.secret('github-crew-app-id')`, `co.secret('github-crew-app-key')`): an RS256 JWT with Node's `crypto`, then
  `POST /app/installations/<id>/access_tokens`; token cached in memory only for its hour; never written, logged or
  printed (a selftest greps the tool's output and log for token shapes).
- `console/service-keys.js` gains two KNOWN entries, "GitHub crew app number" and "GitHub crew app private key"
  (multiline, the Kalshi pattern), with plain `where` text matching the checklist.
- `company/tools/git-credential-crew`: a git credential helper that answers only for `github.com/CaullenOmdahl/CaPheOS`
  with the App token. The dev clone (F3) sets `credential.helper=` (empty, which clears the global helper) and then this
  helper, so pushes from the dev clone authenticate as the App and never with the owner's stored login.
- The `gh` shim (F3) sets `GH_TOKEN` from `gh-app.js` for commands aimed at the CaPheOS repository; other repositories
  keep the existing login (2026-11-16 ruling).
- `default-branch-watch.js` extensions: run every 5 minutes for CaPheOS (a plain-code monitor, push-wakes §9 kind
  `duty`); for each new main commit check that it came from a merged PR **merged by the App** and that a fresh
  `premerge-check` PASS record exists for that head; read the repository's rulesets through the API and compare with a
  stored fingerprint. Any miss: open a revert PR automatically (through the App), file a P0 to Phil and Nadia, trip the
  pause switch (F9), and tell the owner in one plain line.
- Security watch hook-up (amendment B): the watch's "P0 issue on the CaPheOS repo" uses the App's Issues permission,
  deduplicated by advisory id across companies.

**Tests:** token maker against a local fake GitHub (ephemeral port) with a throwaway key; token never on disk or in
output; credential helper answers only for the CaPheOS URL; tripwire fixtures: a direct push to main, a merge by a
non-App user, a merge without a PASS record, a changed ruleset fingerprint: each opens one revert PR and one P0, once.

**Acceptance marker:** the first CaPheOS pull request exists, opened by the App; a test push of a throwaway commit
straight to main from the App is refused by GitHub (the commit never lands); the ruleset fingerprint is recorded.

---

#### F2. CI green again, and CI as a real gate (B4)

- Rebase and merge `fix/selftest-fixture-marker` (`b06ab63`, Nadia's fix for the 11 module selftests that need an owner
  shell) as the first PR.
- Fix the remaining reds on main: `instance-update-test.sh`, the locked-watch selftest (2), pacer (4), sprint-dispatch,
  routing-e2e, routing-controls, budget-gate, meeting-ui-walk. One PR per suite where they are independent, each with
  the red run named in its body.
- `ci.yml`: run on `pull_request` (opened, ready_for_review, synchronize) and on `push` to `main` only, not on every
  branch push (saves Actions minutes; Pro includes 3,000 a month). The job keeps the name `test`, which the owner's
  ruleset requires. This PR is opened by the orchestrator (the App has no Workflows permission by design).
- `company/tools/ci-run.js` (local CI, the spec's §1.4.2): runs `TEST_TRACKED_ONLY=1 scripts/test.sh` for an exact sha in
  a throwaway worktree, one at a time, `nice -n 10`, temp helper cleanup; writes `company/state/ci/<sha>.json`. Runs
  when a PR is marked ready and on each main commit (C14), not on every push. `--new-tests` runs the PR's added or
  changed tests against the base once per PR: a change classed as a fix (from the diff: touches code and matches an
  open item's signature, C14 and the critic's gaming table) must have at least one test that fails on the base and
  passes on the head.
- No ratchet: the spec's ratchet existed because main stayed red; with a required green check on GitHub a red main
  blocks every PR, so F2 makes main green outright and the ratchet is dropped.
- `premerge-check.js` gains: GitHub's `test` check green **and** a local CI record `ok` for the same head sha.

**Tests:** each fixed suite fails before its fix; `ci-run.js` record matches a planted failing step; red-then-green
refuses a fix PR whose new test passes on the base; temp dirs and Chrome gone after the run.

**Acceptance marker:** GitHub Actions `test` green on main for 3 days in a row; local CI record `ok` on the same shas.

---

#### F3. Per-instance git and gh gate wiring, and the dev clone (B3)

- `scripts/setup-station.sh`: builds each instance's PATH as `company/tools/shims:company/env/bin:…` with **`git` and
  `gh` shims** in `company/tools/shims` that call that instance's own `company/tools/merge-gate.js` (never another
  company's). It also repoints `~/.local/bin/git` and `~/.local/bin/gh` (now dispatching to the gate of the company
  whose root the caller is in, and refusing when none matches) and every company repo's pre-push hook, including
  BlackSheepApp's (`company/repos/black-sheep-app/.git/hooks/pre-push`), away from `~/Projects/StarnetOS`.
  This is a `host`-class change: built and applied by the orchestrator, per company, with the owner told in one line.
- Each company's `merge-gate.js` writes its own `merge-gate.log`; `instance-guard.sh --check` fails if a company repo's
  hook or the shims point outside the company root.
- **Dev clone** `~/Companies/ca-phe-digital/company/repos/capheos/` (already gitignored), marked `.framework-checkout`,
  `core.hooksPath=scripts/dev-hooks/`: `pre-push` refuses the default branch (resolved with `git ls-remote --symref`),
  dirty trees, and refs outside `imp/* fix/* feat/* wave* rel/*`; `pre-commit` runs `scripts/check-clean-tree.sh` (no
  company data, no secret shapes; names only in its message). Credentials as in F1.
- `company/tools/devtree.js new|pr|done <item>`: per-item worktrees under `company/repos/capheos-wt/`, at most 4, on
  `imp/<item>-<slug>` from `origin/main`; the reaper removes worktrees older than 7 days with no commits; `pr` writes the
  PR body (item id, fr ids, change class, self-check note, CI summary; paths outside the repo stripped).
- The crew's existing worktrees in `ca-phe-digital/scratch/{nadia,omar,vy}/` and `feat/console-upload` (checked out in
  `~/Projects/CaPheOS`) move to the dev clone; after that the shared tree is the orchestrator's only, and the
  orchestrator also works by branch and PR.

**Tests:** setup-station selftest: shims first on PATH and resolving to the instance's own gate, for two fixture
companies; `git push origin HEAD:main` from an agent-shaped environment refused by the shim and by the hook; BlackSheepApp
hook fixture names the CPD gate; `instance-guard.sh --check` fails on a planted StarnetOS path.

**Acceptance marker:** a week of CPD's `merge-gate.log` covering every BlackSheepApp merge and every CaPheOS push (zero
pushes or merges missing from the log when compared with GitHub's list), and no file anywhere in either company that
names the StarnetOS gate.

---

#### F4. Merge rules: change classes by reach, invariants from the old copy, the crew merges (B2, C1, C8, C11)

- `company/tools/lib/change-class.js` and `company/defaults/policy/change-classes.json` (the spec's §1.5 classes) with
  three changes:
  1. **By reach:** a file is `protected` when a protected module requires it (static `require` graph, computed on the
     base); gate logic moved into a new helper is still caught.
  2. **New `host` class:** `scripts/setup-station.sh`, unit templates, the `~/.local/bin` wrappers, anything written to
     `~/.config`, Node or Claude CLI versions. First month: the crew does not merge these (the orchestrator does, through
     PRs). After that: Phil sign-off, per-instance names, and a sandbox window.
  3. **`.github/**` is `gate`.** **`state-format`** class: writers of `company/state/*` files whose shape changes; such a
     PR must carry a `State-Change:` line (used by F6's snapshot).
- **Owner route only for owner matters (C11 = owner decision C):** a diff classed `fixed-gate` (the four fixed owner
  gates' code: `lib/owner.js`, the access, ownership, commitment and spend-cap paths) or `owner-channel` is not merged
  by the crew; `framework-merge.js` files one plain owner card and merges on yes, closes on no. Everything else that the
  spec sent to the owner (merge rules, scorecard formulas, release tooling, the kill switch's code) is `protected`:
  Phil sign-off + Phil probe + the invariant suite + **a 72-hour sandbox wait** before CPD, and the owner gets a plain
  "Undo" notice (§3).
- **Invariant suite `tests/invariants/`** (C1): no push to main; sandbox before CPD; Claude-only authors; protected and
  fixed-gate class detection on fixture diffs; rollback runs with the pause switch on; WIP and P0/P1 limits; App-only
  merges; no owner card for a non-owner matter. `framework-merge.js` and `release.js` run the **previous-good** copy of
  the suite (from the last `clean` release, extracted with `git archive`) against the PR head. A PR that edits or
  deletes an existing invariant file is refused by the merge check; adding one is allowed.
- `premerge-check.js` (protected) gains: base = default branch, head ≤ 30 commits behind; GitHub `test` green and local CI
  `ok` for the head; red-then-green for fix-shaped diffs; reviewer ≠ author and reviewer = the department lead (or a
  member when the lead authored); every sign-off its classes need, each naming the head sha; authoring runs on Claude
  (run journal; autonomous-mode P0); no company data or secret shapes; deletion shape declared.
- `company/tools/framework-merge.js <pr>`: the lead (Nadia; Omar for CI and release items) merges through the App with
  `gh pr merge --merge --match-head-commit <sha>` only after a fresh PASS. Limits: at most 6 merges a day; 22:00-06:00
  only for security P0 during the first month; refuses while the pause switch is on.

**Tests:** each class from fixture diffs including a protected-by-import helper; `host` and `.github` detected;
invariant-edit refused, invariant-add allowed; an invariant broken by the PR's own code fails from the old copy even when
the PR also edits the new copy's test; author = reviewer refused; stale sha sign-off refused; non-Claude author refused;
owner-channel PR files a card and does not merge; non-owner-matter PR files no card; daily cap.

**Acceptance marker:** one ordinary crew fix (`fix/inbox-list-withdrawn-and-pipe`) merged end to end by Nadia through
`framework-merge.js` with no orchestrator hand, and one deliberately bad PR (weakens an invariant) refused.

---

#### F5. The framework-request loop ends in a PR or a recorded "no", and the old inboxes are cleared (B5, C5)

- `improve.js fr` writes a `**State:**` line on every `fr-NNNN.md`, forward only: `new → triaged (accept | adapt | reject
  | duplicate of fr-…) → pr #n → merged <sha> → released <sha> → verified` (the asking instance runs the release and the
  symptom's signature has not recurred for 72 h). **Every request ends in either a merged PR or a recorded "no"**:
  `reject` needs a one-paragraph reason, goes to `VERDICTS-<date>.md`, and a one-line handoff goes to the asking
  company's CEO. A request with no state after 48 h is filed as a stall to the lead (errors-gen, G2).
- `harness-change.js` tells the asker "the CaPheOS team will answer this within two days" instead of "kept for them to
  collect", and gains `fault "<what>" --tool <name>` (kind `fault`).
- One-time import of the 151 requests (45 CPD, 106 sandbox) through the declared `instances.json`, grouped by code first
  (same file and function, same signature), so Nadia approves batches of up to 10, never single items (C10).
- In-place edits and crew-made tools (CPD: `tools/jobs.js`, `quest-tick.js`, `fiverr-inbox.js`, `prod-logs.sh`,
  `flutter-sdk.sh`, `lib/sse-watch.js`, patches 0018-0019, two standards files, a test) become upstream candidates with
  the same three-way end: upstream by PR, keep company-local (moved under the company's own folder), or reject.
- `company/tools/inbox-sweep.js` (C5): dry run first, then on Nadia's ACCEPT of the dry-run report: every OPEN item in
  `to-nadia.md`, `to-omar.md`, `to-phil.md`, `to-vy.md` moves into the ranked backlog (duplicates merged by signature);
  items untouched for 14 days are closed with a note; the 22 BLOCKED items are resolved in one sweep (holder named, or
  closed); the inbox files keep only what the WIP limit allows. A backup of each inbox first.

**Tests:** states only move forward; reject without a reason refused; an fr untouched 48 h files one stall; import
collapses duplicates on a fixture set of 30 requests; sweep dry run changes nothing; sweep is idempotent.

**Acceptance marker:** every one of the 151 requests has a state; at least 20 have ended (merged or recorded "no"); no
request without a state for more than 48 h; Nadia's inbox ≤ 15 OPEN.

---

#### F6. On-machine staged update, watchdog and automatic rollback; owner-only lifted for the approved pipeline (B6, C2, C8, C9)

- **Governance:** new category `frameworkUpdate` (auto / notify / approve; new companies default approve). Sandbox and
  CPD set to `notify` by the owner's handover confirm (§3). `framework-update.js apply --by platform` is allowed only
  when the level is `notify` or `auto` **and**, checked inside `framework-update.js` itself: for CPD, the sandbox has a
  `clean` release record for that exact sha; for any instance, the CI record is `ok` and the pause switch is off. The
  owner's own `--by owner` path stays as it is.
- **`company/tools/release.js promote <sha> --to sandbox|cpd`**:
  1. *Preconditions:* CPD only after a `clean` sandbox record for the sha (12 h with ≥ 20 started runs, or the smoke plus
     24 h when the sandbox was quiet; `protected` changes need 72 h); no CPD release on the day of a CPD rollback; at
     most 2 sandbox releases and 1 CPD release a day; security P0 may shorten the sandbox wait to the smoke plus 2 h.
  2. *Stage, nothing live:* temp worktree of the sha with owned files laid over it; test.sh, console selftest,
     `dispatch.js --dry`, `onboard.js certify --dry`, `framework-update.js check --json`, and the previous-good invariant
     suite. Any failure: `aborted`, an item to the lead.
  3. *Before the switch:* copy the previous-good `release-watch.js` (built as one file with no requires into the new
     tree) and its timer or supervisor entry into `company/state/release/watch/<prev-sha>/`; when the release carries a
     `State-Change:` line, snapshot the named `company/state/` files.
  4. *Switch in place:* `framework-update.js apply --by platform --expect <sha>` (backup, owned files, `merge --ff-only`,
     setup only when needed, restart when idle).
- **Watchdog (from the old copy, plain code, every 5 min, behind the service adapter so a container supervisor can run
  it):** window **sandbox 12 h, CPD 24 h**, rollback allowed the whole time; CPD's window stays open until every daily
  job and duty has run once (max 48 h). Health fails on: a previously active unit inactive for 2 ticks; dispatcher or
  wake planner silent 15 min; console health route failing twice; a new error signature ≥ 3 times; **run failure rate,
  counting only framework-caused failures** (provider classes `quota_exhausted`, `billing`, no credit,
  `content_policy_blocked` and usage limits are left out) per **started** run above `max(2 × baseline, baseline + 10
  points)` with ≥ 5 runs, baseline from the same hours of the previous 7 days; tool errors per run above 2 × baseline; a
  new locked-watch flag; RSS above the ram-spec cap.
- **Rollback:** previous sha checked out, owned files restored, declared state snapshot restored, a StarNet patch the
  release added reverted, units restarted: waits for idle at most 10 minutes, then restarts anyway (a broken company
  is worse than an interrupted run; push wakes re-wake the seat). Needs no approval; runs with the pause switch on.
  Verdict `rolled-back`, a P1 item to the lead with the reasons, one plain line to the owner.
- **Smoke** (`release.js smoke`, no model runs): `scripts/e2e-first-light.sh` on the mock station plus **CPD-only paths**
  (C9): an owner message through the Telegram owner channel adapter in mock mode, a merge-train dry run on a fixture repo,
  a Baarista service health call against its fixture.
- **A/B fallback** (designed, built only after two in-place rollbacks in a month fail to restore health): `framework-a/`,
  `framework-b/` under the company root with a `current` link; the same release record.

**Tests:** fixture instance with a fake service adapter: injected unit death, new error signature, framework failure
spike each roll back with owned files intact; a provider-quota spike does **not** roll back; a release that deletes its
own `release-watch.js` is still rolled back by the old copy; a never-idle instance restarts after the 10-min deadline;
`--to cpd` and `framework-update.js apply --by platform` both refused without the sandbox `clean` record; rollback with
the pause switch on; no systemd needed under the test backend.

**Acceptance marker:** a planned fault drill in the sandbox (a release that kills the dispatcher) rolls back by itself
within 15 minutes; then one ordinary fix goes sandbox (clean) → CPD (clean after 24 h) with no human step.

---

#### F7. CaPheOS roles in CPD, models and single points of failure (B7, B8 leftovers, C10, B1 leftover)

- `company/departments.json` in CPD: department **`platform`, "Platform (CaPheOS)"**, lead Nadia; members Omar (CI and
  release, **deputy lead**), Vy (tests and quality), Bao part-time (framework code). Independent reviewers outside it:
  Phil (risk sign-off and probes), **a backup risk reviewer for `gate` changes, named by Rachel from seats outside
  the department** (not for `protected` or `fixed-gate`), Leo with Priya (owner experience, persona in `docs/USER.md`), Marcus (research), Dave (retro chair),
  Rachel (people). Models as the spec's §1.1, all Claude for code.
- Each seat's role file (`company/roles/nadia.md`, `omar.md`, `vy.md`, `bao.md`, `phil.md`, the backup reviewer's file, `leo.md`,
  `priya.md`, `marcus.md`, `agent.md`) gets a `## CaPheOS` section written by Rachel: what the seat does in the pipeline,
  which reviews it owes, its counterpart. These are CPD's own files, written by CPD's people function.
- CPD duties in `company/work/ops/duty-policy.json` and push-wakes generators/monitors (not crons): the generators of
  part G route to `platform`.
- `project capheos` scope in `company/projects.json` rewritten to the rulings (the spec's §4.2 text, with "through the
  crew's own GitHub identity" added), recorded by the owner's handover confirm.
- Model leftovers: Vy's primary Sonnet (Opus never runs routines); `company/ORG.md`'s model column generated from
  `model-policy.json` by `models.js`; `models.js check` fails any code seat whose chain contains a non-Claude model
  (framework-level, every company).
- **Refusal backoff (B1 leftover):** one Claude refusal blocks that seat on that model for that routine for 2 hours,
  doubling up to 24 h, instead of 24 h at once (`lib/admit.js:88`, `models.js:221`); Phil's probes fall back from Opus to
  Sonnet after a refusal.
- **Before the first research item:** a check that Marcus's station can browse the web (C13), filed as a P2 to Omar.
- **First items through the pipeline (week 1), CPD crew:** the three ordinary fix branches, `feat/console-upload`
  (`owner-facing`), the four gate fixes (`protected`/`gate`, Phil's probes re-run on rebased heads), and the **DeepSeek
  key investigation** (read-only, Omar with Phil: where the key lives and who reads it, why runs started without
  credit, the `spend_history_unavailable` failures in `budget.js:20,141` and `starnet/sidecar/billing-class.js:253`,
  holds and top-up wakes; output a plain owner note with one recommendation; no key is printed or moved).

**Tests:** `models.js check` fails a fixture with MiniMax on a code seat; ORG.md vs model-policy selftest; refusal
backoff opens after 2 h and doubles; department routing sends a `platform` item to Nadia with a copy rule for members.

**Acceptance marker:** every seat in the table has a `## CaPheOS` section; `models.js check` green on both companies;
the DeepSeek note delivered to the owner; the platform department has accepted its first 3 items.

---

#### F8. Owner directions in the repo, first cut (B9)

- `docs/ROADMAP.md` (first cut, every MASTER-TRACKER row with its state and spec), `docs/OWNER-RULES.md` (the spec's
  §4.2 list, one dated plain line each, locked-watched, class `protected`; the rows that are owner matters are
  `fixed-gate`), `docs/USER.md` (persona, first cut, §H2), a "A company that improves itself" section in
  `docs/VISION.md`. Specs copied into `docs/specs/` after a scrub (check-clean-tree plus a full read by the orchestrator:
  no company data, no secrets, no owner name, no private chat content).
- The crew's prompts reference these files (the injected profile adds "read docs/OWNER-RULES.md and docs/USER.md before
  owner-facing work").

**Tests:** check-clean-tree on the docs; every MASTER-TRACKER row present in ROADMAP (a selftest compares ids);
OWNER-RULES registered in locked-watch.

**Acceptance marker:** the four docs on main; a CPD seat quotes OWNER-RULES in a review within the first week.

---

#### F9. Safety extras: pause switch, Claude-usage limits, planted faults (C3, C4)

- **Pause switch** "Pause the crew's work on CaPheOS" on the Getting better page (until G4, on Settings › Company): stops
  promotions, holds platform items, refuses `framework-merge.js` and `release.js promote`; leaves rollback and the
  security watch's P0 *reporting* on. Trips by itself (one plain line to the owner) on: two rollbacks in 7 days in one
  instance; an escape that reached CPD and needed a rollback; platform Claude use above 150% of its share; a locked-watch
  flag on a protected file; any tripwire hit (F1). Only the owner turns it off.
- **Claude-usage limits (C4):** platform runs are counted in the Claude subscription meter the pacer already reads, per
  day and per 5-hour window, against the share the owner picks (§3). Above it: `PLATFORM SHARE HOLD` on non-P0 platform
  items. When the pacer would hold anyone near the owner's stop, platform work is held first; Dave's chain is never held
  for platform work. P0/P1 only from fixed rules (security P0, freezes like B1, a main red step, a rollback); at most 3
  promoted P0/P1 per generator a day.
- **Per-item budgets** (C14): S 3M, M 8M, L 20M tokens including reviewers at start; after week 1, the 75th percentile
  of real tokens per accepted item by class; a run that would start past it is held for the lead to split or close;
  never cut mid-turn.
- **Planted faults (C3):** `company/tools/fault-plant.js` (protected, sandbox only) plants one fault a week at a random
  time from a catalogue built from real past failures with randomised parameters: a held-wake count bug, a broken
  tool's error, a jargon string in an owner template, a 1000x500 overflow, a stalled sign-off, an unanswered fr. The
  plant log holds a salted hash until the 72 h scoring window ends; then it records detected (by which generator, how
  long) and fixed (how long), and removes the fault if nobody did. It never plants in CPD and never touches company data.

**Tests:** each trip condition trips; only the owner un-trips; share hold holds platform items only and never Dave;
P0/P1 cap; a plant is detected by a fixture generator and scored; an undetected plant is removed after 72 h.

**Acceptance marker:** the first planted fault is detected and fixed through the pipeline; the share hold has held
platform work at least once in a test window without holding anything else.

---

### Part G: generators and scorecard (CPD platform builds, through the pipeline)

All plain code, read-only `--duty` mode under docs/DUTIES.md, registered as push-wakes generators or monitors (an item
is the wake; until push wakes is live, the dispatcher's existing OPEN-item wake). If push wakes lands later, nothing here
waits on it.

Critic's order: **G1 and G2 first, as one loop that must run untouched for 3 days by day 14**, then the rest.

#### G1. Item filer and backlog with outcome scoring (`company/tools/improve.js`)

The spec's §2.0 shape, dedup, routing by origin and caps, plus:
- **Rank** `score = Σ (gap weight × impact) / effort × (1 + days open / 14)`, but impact is the generator's guess
  multiplied by that generator's **measured hit rate**: 7 days after an item's release the filer re-measures its
  signature and marker; "moved" or "no effect" is recorded, and the rolling hit rate per generator scales its future
  impact. Effort defaults by class (ordinary S, owner-facing M, gate L), not by intake.
- **Mix rules per rolling 2 weeks:** merged work ≥ 60% fixes to real failures or owner-visible results; measuring and
  tooling changes (generators, scorecard, miners) ≤ 1/3; cosmetic owner-facing PRs (no walker failure, no owner
  complaint) ≤ 2 a week. The promoter skips items that would break a rule.
- WIP: 3 open items per worker plus 2 for the lead's audit queue, applied only after F5's sweep.
- Manual `RANK:` moves logged with a reason and counted.

**Tests:** same key twice = one item; WIP respected; hit rate lowers a generator that always over-guesses; mix rule
skips a fourth tooling item; wontfix suppressed 30 days unless the count doubles.
**Acceptance marker:** after 2 weeks, at least 10 items have an outcome measured; hit rates shown per generator.

#### G2. Health check, error miner and CI generator: the first loop (`health-gen`, `errors-gen`, `ci-gen`)

The spec's §2.1, §2.2 and §2.9, with: a held-seat check that catches the B1 class (every seat held > 30 min = P1);
recorded wakes ÷ started runs > 1.5 = P1; provider failures counted separately from framework failures; `ci-gen` starts
`ci-run.js` on ready PRs and main commits, bisects a main red from existing records, finds flakes and slow steps.
Shadow 2 days (backlog only), then live.
**Tests:** duties contract on a fixture tree; the 2026-11-19 dispatch log replay files one P1; the 43
`spend_history_unavailable` runs give one signature.
**Acceptance marker (the day-14 loop):** for 3 days running, at least one item went generator → filer → PR → CI →
Nadia ACCEPT → merge → sandbox clean → CPD clean, with no orchestrator or owner action.

#### G3. Upstream review (`upstream-gen`)

The spec's §2.6 on top of F5: daily `git status` of each instance in `instances.json`, every local branch with commits not
on main (`table-huddle`, `alarm-test`, `chat-*`, `connect-flow`, `creative-crew`, `meeting*`, …) triaged within 2 weeks
to land, fold or archive as a tag.
**Tests:** a planted untracked tool becomes one candidate; a merged branch is not listed.
**Acceptance marker:** zero untriaged local branches or in-place edits older than 7 days.

#### G4. Scorecard and the "Getting better" page (`company/tools/scorecard.js`)

The spec's §3 with §4 of this plan as the marker list. Formulas and `scorecard-targets.json` are `protected` (Phil +
invariants + 72 h, no owner card); the owner sees and can change targets in plain words. Personality and communication
markers are **watch-only** for 4 weeks and their targets never appear in any prompt (C12). Every marker starts in a
"measuring" state for its first full week; no gap weight until a baseline exists. The page: seven plain rows, "What the
crew is working on next" (top 5 plain titles), the pause switch, the platform share, technical details folded.
**Tests:** numbers match a hand count on a 50-run sample; page passes owner-scope at Plain; a watch-only marker never
changes a rank.
**Acceptance marker:** baseline week recorded; the owner's weekly note is generated from it.

#### G5. Owner experience: persona walkthroughs, the plain-words gate, UX markers (amendment A) (`owner-gen`, `ui-gen`)

- **Plain-words gate:** a CI step `owner-words-check` runs `owner-scope.wordsProblems` at Plain over every owner-facing
  string a PR adds or changes (console UI text, owner messages, setup text, cards, digests). Banned without a "what this
  means for you" line: ingress, egress, API, endpoint, CVE, token, model id, file path, and the owner-scope list. It is
  part of `premerge-check` for `owner-facing` PRs (blocking, not a review).
- **Persona walkthroughs (ui-gen):** a console from the PR's worktree against a fixture company and the mock station on
  a spare port; headless Chrome walks first setup, Today, Needs you, chat, meetings, settings and a security alert at
  **1000x500** and **390x844**, as the `docs/USER.md` persona would (the walk script follows the persona's goals, not the
  menu order); plain checks for horizontal scroll, off-screen and overlapping elements, text under 12 px, contrast under
  4.5:1, jargon. Screenshots attached to the PR for Leo and Priya.
- **owner-gen:** jargon in last day's outbound owner rows; asks the crew was already allowed to decide; card answer
  time; setup step count from first-light.
**Tests:** a planted overflow at 1000x500 found; no Chrome left; a jargon string fails the CI step; an already-permitted
ask counted.
**Acceptance marker:** zero screens failing at 1000x500 or 390 wide; zero jargon hits at Plain for a week.

#### G6. Efficiency miner (`efficiency-gen`)

The spec's §2.3 (cost per accepted item, idle wakes, wake accounting, big runs, wasted retries, metered money, RAM), with
"idle" defined as a run that produced nothing the item's acceptance check asked for (not merely no file write), and a
"messages per accepted item" count (C12). Any metered spend while DeepSeek rests is P1 and feeds the DeepSeek note.
**Tests:** idle-wake count matches the survey's 219 on the same 48 h data; a padded one-line note still counts as idle.
**Acceptance marker:** the top idle-wake cause each week is an item with a measured saving.

#### G7. Weekly market and competition research (`research-gen`)

The spec's §2.7, with: one experiment always in progress (a TEST card is promoted whenever none is open, outside the
ranking); target ≥ 2 cards a week that pass Priya's and Vy's triage (not ≥ 5 filed); the fixed question "how do they
explain things to a non-technical owner" (amendment A); no-login sources (Reddit, Hacker News, Product Hunt, GitHub
trending, YouTube, Telegram, RSS bridges for public pages) until the container desktop exists; then the scout logins
(§2, owner step later). Budget one run a week, 2M tokens; MiniMax allowed for research only.
**Tests:** one research item a week only; a card without a numeric test refused by the triage form.
**Acceptance marker:** 4 weeks with an experiment in progress every day; ≥ 1 adopted idea still in use 30 days later.

#### G8. Retro and people miners (`retro-gen`, `people-gen`)

The spec's §2.8 and §2.11. Retro actions must each have a yes/no check. people-gen files to Rachel only; never edits a
profile; watch-only for 4 weeks.
**Tests:** retro packet under one page; voice similarity flags a fixture where two seats share text.
**Acceptance marker:** retro action follow-through measured for 2 retros.

#### Security watch (amendment B), joining the pipeline

Built separately on `security-watch`. Joins here: its P0 enters the filer as P0 (a fixed-rule P0, so it passes the P0
cap), wakes Phil (CPD) or Ingrid (sandbox) at once, uses the `security` fast lane (merge outside the window, sandbox
smoke + 2 h), and files the P0 issue on the CaPheOS repo through the App (F1). The known station `sharp`/librsvg finding
(CVE-2026-96889, no fix yet) is its first proven path: mitigation item, issue filed once, owner told in plain words.

---

### Part H: handover

#### H1. `docs/ROADMAP.md` owned by the crew

The F8 first cut becomes the crew's: one ordered table and one section per item (what and why in the owner's words,
without names; spec in `docs/specs/`; state; acceptance markers; dependencies; owner steps). Order after this program:

| # | Item | Who builds | Acceptance |
|---|---|---|---|
| 1 | Wave 3 | orchestrator lands (in review) | its tests; sandbox rollout steps |
| 2 | Accountable leads (being built on `wave3`) | orchestrator, landed through the pipeline | cost per accepted item vs lead-alone; sent-back and escapes on the lead's card |
| 3 | RAM lifecycle (building) | orchestrator's workflow; Vy runs its test-hygiene acceptance | ram-spec acceptance on this machine |
| 4 | Security watch (building) | orchestrator; Phil owns the duty after | first P0 path proven on the sharp/librsvg finding |
| 5 | This plan, F1-F9 | orchestrator | each part's marker |
| 6 | This plan, G1-G8 | CPD platform | each part's marker |
| 7 | Push wakes (Parts 0-15) | CPD platform from Part 1 (Part 0 test isolation is done) | idle wake rate < 5%, wake accounting ≤ 1.1, 0 missed answers in shadow |
| 8 | Autonomous mode P0-P7 with its critique's amendments | P0 in F4 (non-Claude author refused); P1-P7 CPD platform | its own bars |
| 9 | Console upload and Nadia's harness backlog | CPD platform | its proof criteria |
| 10 | Container desktop, then scout logins; container deploy | CPD platform; owner creates the scout accounts | session health ≥ 95% a week |
| Parked | Model downshift off Fable (until the membership ends); DeepSeek (rests until G6 lands and the owner lifts it); full stay-in-the-room runs | — | — |

The ROADMAP is a `protected`-class file for rows that state owner decisions; the crew updates states and adds rows.

#### H2. `docs/USER.md`: the target user (amendment A)

Written in plain words, read on every owner-facing change, and the script for ui-gen's walkthroughs. Contents:
- **Who:** someone running a small business or side project who has heard AI can do work for them and buys CaPheOS to
  run on a spare computer or a small rented server. Comfortable with a web browser, email, online banking and a phone
  app; has never used a terminal; does not know what a port, an API, a token, a CVE or a container is, and should never
  need to.
- **What they want:** to see what the company did today, answer the few things only they can answer, and trust that it
  is safe and not spending money behind their back.
- **What they fear:** a bill they did not expect, a message they do not understand, something broken they cannot fix.
- **Their window:** a laptop browser often in a half-screen window (1000x500) or a phone (390 wide).
- **The rule for every word they see:** a five-year-old could follow it, or it comes with a "what this means for you"
  line. Every alert says what happened, whether anything is needed from them, and what the crew is doing.
- **Five walkthrough goals** (ui-gen's script): set up the company for the first time; see what happened today; answer
  a card; talk to a seat; understand a security alert and know nothing is needed.

#### H3. Owner directions as repo docs

`docs/OWNER-RULES.md` finished and locked; `docs/VISION.md` links the roadmap; CPD-only rulings (Dave on Claude,
Baarista as a company service, the tell-Dave note, subscription details) go into CPD's own `company/work/decisions.md`
by Dave and Rachel, never into the framework repo. The orchestrator's private memory is no longer needed by the crew:
anything in it that the crew acts on is in one of these files (a one-time comparison by the orchestrator, recorded).

#### H4. Handover measured (weeks 4-5, 5 consecutive days)

- Planted-fault detection ≥ 80% within 24 h over the last 4 plants, and every detected plant fixed through the pipeline
  within 72 h (replaces "90% of what the orchestrator finds", which is guaranteed by copying its checklist);
- ≥ 15 PRs merged through the pipeline since F4, none without its sign-offs; 0 escapes that reached CPD;
- ≥ 1 automatic rollback in the sandbox (the drill counts), 0 in CPD;
- main green every day;
- at least 3 markers moved toward target by measured outcome (G1), not by new tooling;
- owner asks ≤ 3 that week, 0 jargon hits at Plain, 0 asks the crew could already decide;
- idle wake rate < 10% and falling; no seat held by tempo for more than 30 minutes.

Then the orchestrator steps down to a weekly read of the scorecard and release records and contributes only by PR. A
failed criterion becomes a P1 for the lead, not an orchestrator fix, unless it is in a rail part (F).

### 1.4 The owner's GitHub checklist (plain words)

> **Setting up a separate GitHub login for the crew (about 20 minutes, on the GitHub website and the console)**
>
> This gives Ca Phe Digital its own GitHub identity, so the crew can suggest changes to CaPheOS without using your
> login, and it locks the main copy of CaPheOS so that nobody, not the crew, not you by accident, can change it without
> a reviewed suggestion that passed all its tests. You do not need a terminal.
>
> **1. Upgrade GitHub to Pro (about $4 a month).** This is the only cost. GitHub only allows locking a private project
> on a paid plan.
> - Go to github.com and sign in.
> - Click your picture (top right) › **Settings** › **Billing and licensing** (or **Billing and plans**) › **Plans**.
> - Under **Pro**, click **Upgrade** and pay.
> - If you would rather not pay: tell the crew "no Pro". Everything below still works except step 4, and the crew will
>   note that the main copy is watched instead of locked.
>
> **2. Create the crew's app.**
> - Click your picture › **Settings** › **Developer settings** (bottom of the left menu) › **GitHub Apps** › **New GitHub
>   App**.
> - **GitHub App name:** `ca-phe-digital-crew` (if it is taken, add a number at the end).
> - **Homepage URL:** `https://github.com/CaullenOmdahl/CaPheOS`
> - **Webhook:** untick **Active**.
> - **Permissions › Repository permissions**, set exactly these and leave everything else on "No access":
>   - **Contents:** Read and write
>   - **Pull requests:** Read and write
>   - **Issues:** Read and write
>   - **Commit statuses:** Read-only
>   - **Checks:** Read-only
>   - **Actions:** Read-only
>   - (**Metadata: Read-only** is set by itself.)
>   - Do **not** give **Administration** or **Workflows**. That is what stops the crew from unlocking the main copy or
>     changing the test machinery.
> - **Where can this GitHub App be installed?** Choose **Only on this account**.
> - Click **Create GitHub App**.
> - On the page that opens, note the **App ID** number near the top.
> - Scroll to **Private keys** › **Generate a private key**. A file ending in `.pem` downloads. Keep it for step 5.
>
> **3. Let the app use the CaPheOS project only.**
> - On the same app page, click **Install App** in the left menu › **Install** next to your account.
> - Choose **Only select repositories**, pick **CaPheOS**, click **Install**.
>
> **4. Lock the main copy.** (Needs step 1.)
> - Go to github.com/CaullenOmdahl/CaPheOS › **Settings** › **Rules** › **Rulesets** › **New ruleset** › **New branch
>   ruleset**.
> - **Ruleset name:** `main`. **Enforcement status:** **Active**.
> - **Bypass list:** leave it empty (nobody may skip the rules, including you).
> - **Target branches:** **Add target** › **Include default branch**.
> - Tick:
>   - **Restrict deletions**
>   - **Require a pull request before merging** (leave "Required approvals" at 0; the crew's own checks do the review)
>   - **Require status checks to pass** › **Add checks** › type `test` and pick it
>   - **Block force pushes**
> - Click **Create**.
> - Optional, same Settings page › **General** › **Pull Requests**: tick **Automatically delete head branches**.
> - Until the crew's first fix makes the tests pass again, changes simply wait. Nothing breaks.
>
> **5. Give the app's key to the company.**
> - Open the Ca Phe Digital console › **Settings** › **Connections and keys** › **Service keys** › **Add**.
> - Choose **GitHub crew app number** and type the App ID from step 2.
> - Choose **GitHub crew app private key**, open the `.pem` file from step 2 in a text editor, and paste all of it,
>   the BEGIN and END lines included.
> - Then delete the `.pem` file from your Downloads folder (and empty the bin). The company keeps the only copy, locked
>   away like its other keys.
>
> **6. Tell the crew it is done** by answering the card "GitHub for the crew" with **Done** (or "no Pro" if you skipped
> step 1).
>
> What you will notice afterwards: suggestions on GitHub now show "ca-phe-digital-crew" as the author, and the crew
> sends you a line when its first change goes live. Your own GitHub login keeps working as before.

(The Service keys entries in step 5 and the card in step 6 are built in F1; the orchestrator sends the card when they
are live, so the owner can do steps 1-4 any time and step 5 when the card appears.)

---

## 2. Timeline (the critic's, made concrete)

| When | Dates | Milestone | Parts |
|---|---|---|---|
| Days 1-3 | Fri 11-20 to Sun 11-22 | Owner checklist sent; F1 code side; F2 first PRs (b06ab63, the red suites, ci.yml); F7 roles and models leftovers; F8 docs first cut; DeepSeek investigation started | F1, F2, F7, F8 |
| Days 4-7 | Mon 11-23 to Thu 11-26 | CI green (3-day clock starts); F3 wiring per instance; F5 inbox sweep and fr import; first crew PRs through the pipeline with the orchestrator checking each by hand | F2, F3, F5 |
| Days 8-10 | Fri 11-27 to Sun 11-29 | **Rails done:** F4 merge rules and invariants; F6 release, watchdog, fault drill; F9 pause switch, share limits, first planted fault | F4, F6, F9 |
| Days 11-14 | Mon 11-30 to Thu 12-03 | **One loop running untouched for 3 days** (G2's marker): G1 filer and G2 generators built by CPD, shadow 2 days then live | G1, G2 |
| Weeks 3-4 | Fri 12-04 to Thu 12-17 | Scorecard and Getting better page, UI walker and plain-words gate, owner-experience and efficiency miners, research; upstream review | G3, G4, G5, G6, G7 |
| Week 4+ | from Fri 12-11 | Retro and people miners; push wakes and autonomous-mode builds by CPD; accountable leads live in CPD after its sandbox rollout | G8, roadmap 7-8 |
| Weeks 4-5 | Fri 12-11 to Thu 12-24 | Handover measured over 5 consecutive days (H4); H1-H3 finished | H1-H4 |

Risks to the dates: the red suites may hide more than the listed reds (F2 is the likeliest slip; the plan does not move
on until main is green); the owner's checklist sets the date for F1's marker (everything else proceeds, PRs wait to
merge); Phil's sign-off time (the backup reviewer covers `gate`); the holiday period in weeks 4-5 lowers owner availability, but the
plan needs the owner only for the checklist and the handover confirm.

---

## 3. What the owner sees and decides (plain words)

**Decisions, all at the start:**
1. **The GitHub checklist** (§1.4): pay for GitHub Pro or not, and set up the crew's own login.
2. **One handover card, three choices:**
   - "Ca Phe Digital will now improve CaPheOS by itself, using its own GitHub login. Every change is tried on the
     practice company first, watched, and undone automatically if anything gets worse. Only then does it reach Ca Phe
     Digital, where it is watched for a full day. You already said yes to this on 19 November; press **Confirm** to
     record it."
   - "How much of the crew's AI time may go to improving CaPheOS? **A quarter (recommended)** / Half / A tenth." (When
     your AI plan gets close to the stop you set, this work is the first to wait.)
   - "Send me a short weekly note about what got better? **Yes, on Fridays (recommended)** / Only when something needs
     me."
3. **Later, only when it is ready:** creating the scout accounts for X, Instagram and TikTok once the crew's separate
   desktop exists (each site asks for a phone number or email, which only you can give). And when to let DeepSeek back
   in, after you read the crew's note about what went wrong with it.

**What the owner gets:**
- A weekly note of at most 5 lines: "This week the crew fixed 9 problems and tried 2 new ideas (one kept: shorter
  hand-overs between people). They used about a third fewer AI credits for the same work. Nothing needs you."
- A line when an update goes live: "Ca Phe Digital got this week's improvements. Everything looks normal."
- A line when an update was undone: "An update made the practice company slower, so it was undone automatically.
  Nothing reached Ca Phe Digital. Nothing is needed from you."
- An "Undo" notice when the crew changes its own checking tools: "The crew changed how it checks its own work. It was
  tested on the practice company for three days first. **Undo** if you want it back the old way." Nothing to do
  otherwise.
- A plain security line from the security watch: "A known security hole was found in a part we use (the web browser
  engine). Phil is updating it now; nothing is needed from you."
- The DeepSeek note: what went wrong with its key and credit, and one recommendation.
- A card only for a real owner matter (the four fixed decisions or how the company talks to you), at most one a day
  unless urgent: "The crew wants to change how the company asks you for spending approval. Phil tested it. What it
  means for you: the question will come as one card instead of two. **Allow** / **Not now**."
- The **Getting better** page: seven plain green/amber/red rows, what the crew works on next, its AI-time share, and the
  pause switch "Pause the crew's work on CaPheOS". If the switch ever turns on by itself, you get one line saying why;
  only you turn it back off.

**What the owner is never asked:** merges, releases, rollbacks, technical choices, research picks, which model does
what within your limits, ranking, or anything the crew is already allowed to do.

---

## 4. The markers and their targets

Targets are for 4 weeks after handover unless marked. Baselines come from the first full week after F2 (the week of
2026-11-19 is distorted by the freeze). Every marker is computed from logs by plain code (G4). **W** = watch-only (never
ranks, target not in prompts) for the first 4 weeks.

### 4.1 Pipeline and safety (new; measured from F4)

| Marker | Formula | Target |
|---|---|---|
| Main green | main commits with green `test` and local CI ÷ main commits | 100% from F2's marker |
| Gated pushes and merges | pushes/merges in GitHub's list that appear in the instance's `merge-gate.log` | 100% |
| Tripwire hits | direct main changes, non-App merges, ruleset changes | 0 |
| Framework requests ended | requests merged or recorded "no" ÷ requests older than 7 days | ≥ 90%; none without a state > 48 h |
| Planted-fault detection | plants detected within 24 h ÷ plants (rolling 4) | ≥ 80%; time to fix median < 72 h |
| Rollbacks | per week per instance | sandbox ≤ 1; CPD 0 |
| False rollbacks | rollbacks whose cause was a provider failure | 0 |
| Escapes | merged changes later reverted, rolled back, traced to a main red step, or whose error signature recurs ÷ merged (charged to the auditing lead) | ≤ 1 in 20 |

### 4.2 Efficiency

| Marker | Formula | Target | Guard |
|---|---|---|---|
| Cost per closed problem | tokens of runs linked to items ÷ signatures closed or markers moved (not ACCEPT count) | −50% vs baseline | first-time accept not down > 3 points; items per signature not up |
| Idle wake rate | runs that produced nothing the item's acceptance check asked for ÷ runs | < 5% (today about 30%) | stalls not up |
| Wake accounting | recorded wakes ÷ started runs | ≤ 1.1 | — |
| Big-run share | runs > 5M tokens ÷ runs | < 3% | — |
| Platform Claude use | platform share of Claude usage per day and per 5-h window | within the owner's share every day | — |
| Cycle time | P1 filed → clean in CPD, median | < 72 h (12 h sandbox + 24 h CPD window) | escapes |
| Messages per accepted item | handoff, consult and chat messages ÷ accepted items | falling | — |
| Memory | company peak RSS and temp size | within ram-spec caps | — |

### 4.3 Quality

| Marker | Formula | Target |
|---|---|---|
| Tests per fix | fix-shaped diffs (classified from the diff) with red-then-green ÷ fix-shaped diffs | 100% |
| Generator hit rate | released items whose marker or signature moved 7 days later ÷ released items | ≥ 60% |
| Work mix | real fixes or owner-visible results ÷ merged (rolling 2 weeks) | ≥ 60%; tooling ≤ 1/3; cosmetic ≤ 2 a week |
| Flakes | flaky steps open | 0 |
| test.sh duration | median minutes | not rising |

### 4.4 Owner experience (amendment A)

| Marker | Formula | Target |
|---|---|---|
| Owner asks a week | cards and questions | ≤ 3 |
| Asks the crew could already decide | classed by owner-scope | 0 |
| Jargon hits at Plain | per 100 owner messages, and the `owner-words-check` CI step | 0 |
| Screens failing at 1000x500 or 390 wide | ui-gen failures | 0 |
| Steps to finish setup | first-light count | falling month on month |
| Time to answer a card | median | tracked only (the owner's time; no target) |

### 4.5 Creativity and research

| Marker | Formula | Target |
|---|---|---|
| Cards passing triage | TEST cards a week | ≥ 2 |
| Experiment in progress | days with one open ÷ days | 100% |
| Adopted ideas | adopted, still in use and marker improved 30 days later, a month | ≥ 1, then ≥ 2 from month 2 |
| Weekly scan on time | done within 2 days | 100% |
| Source spread / watch-list coverage | source types a week / entries seen in 30 days | ≥ 4 / 100% |
| Horizontal share | cards from outside agent frameworks | ≥ 30% (W) |
| Textbook drift | cards citing only papers or textbooks | < 10% |

### 4.6 Communication and personality (W for 4 weeks)

| Marker | Formula | Band / target |
|---|---|---|
| Handoff latency | filed → first action | P1 median < 2 h; P2 < 12 h |
| Stalls | items past age limit | 0 P0/P1; < 5 total |
| Sign-off holds | open > 12 h | 0 |
| Inbox size | OPEN items per seat | ≤ 15 (Nadia 95 before F5) |
| Follow-through | meeting and retro actions with a yes/no check done by due date | ≥ 80% |
| Distinct voices | pairwise similarity of each seat's week of messages | no pair above 0.8 (W) |
| Echo rate | turns repeating the previous turn without a new point | < 15% (W) |
| Stance spread | decisions with a recorded dissent, REVISE or caveat | 20-60% (W) |
| Counterpart gate health | sign-off holds that ended in a change; overrides | ≥ 20%; 0 overrides |
| Profile check | `profile.js check --all` failures | 0 |

---

## 5. Open points and risks

- **The owner's login remains on the machine.** Agents keep the existing login for other repositories (2026-11-16
  ruling), and one Unix user means an agent could reach it. The ruleset with an empty bypass list stops a direct push
  to main even with that login; an admin could still edit the ruleset, so the tripwire checks the ruleset fingerprint
  every 5 minutes and a merge not made by the App is reverted automatically. Residual risk: detected within 5 minutes,
  not prevented.
- **Planted faults are not secret** on one Unix user (C3 adjusted). They are replays of real failure classes with random
  parameters, so a generator that catches them catches the real thing; the plant log stays hashed until scored.
- **GitHub Actions minutes.** CI only on ready PRs and main keeps use well under Pro's 3,000 minutes a month at the
  6-merges-a-day cap; `ci-gen` reports minutes used weekly.
- **Sandbox staging depends on its crew running.** Quiet or halted sandbox: smoke plus a 24 h wait, recorded on the
  release.
- **Phil remains the main risk reviewer** for `protected` and `fixed-gate`; the backup reviewer covers `gate`. If Phil's median sign-off
  passes 12 h for two weeks, a people item proposes a second risk seat, never a rule relaxation.
- **Push wakes and accountable leads land during this program.** G-parts use only the generator interface; accountable
  leads' binding audit replaces the pre-merge reviewer rule when live, with the same records.
- **The orchestrator's unpushed local commits and other sessions' work** in `~/Projects/CaPheOS` must be
  pushed by PR or parked on named branches before the ruleset goes on; after it, nothing reaches main any other way.

## OWNER DECISION 2026-11-19 (overrides F1 and the owner checklist §1.4)
Owner, verbatim: "you said upgrade to GitHub Pro about $4 a month. We're not going to do that. We already have an integration that allows CafeOS to use our GitHub account. We're just going to use that integration, and then we're just going to have gates. I'm not creating a new GitHub app or a new GitHub profile. It can just use the standard integration. It works fine as is, and it has been using it."
- No GitHub Pro, no GitHub App, no machine user. The crew uses the existing GitHub integration (the machine's `gh` login) to push branches and open PRs on CaPheOS.
- The scope line that forbade "pushing with the owner's credentials" (CPD company/projects.json) is lifted for branches and PRs. Pushing to `main` stays forbidden.
- Protection without server-side rules is all **gates**:
  1. Client-side: per-company git/gh wrappers on the station PATH and a pre-push hook on every CaPheOS checkout and worktree (F3). They refuse any push to main/default, force pushes, branch deletion of main, and merges without green tests, the lead's audit and the risk sign-off.
  2. Merge only through the crew's merge tool (premerge-check plus a local CI record plus the gates). The PR merge is done by the tool, never by a raw `gh pr merge`.
  3. Server-side tripwire: default-branch-watch checks CaPheOS main every 5 minutes. A commit on main that did not come through the merge tool's record gets an automatic revert PR and a P0 to the risk seat, plus a plain line to the owner.
  4. The watchdog plus staged update still guard what reaches the companies (sandbox first, automatic rollback).
- F1 shrinks to: wiring the existing integration into the gates, and recording the owner's ruling in CPD.
