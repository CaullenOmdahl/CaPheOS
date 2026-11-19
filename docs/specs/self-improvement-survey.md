Ca Phe Digital: readiness report for taking over CaPheOS development (read-only survey, 2026-11-19 about 18:40 ICT)

**Verdict: not ready.** The crew can already find and fix framework bugs: 21 commits on 8 branches inside the CaPheOS repo, some with tests and independent reviews. But none of that work can reach main by itself. Nine blockers stand in the way, listed most serious first. Separately, the company has been frozen since about 14:26 today by its own wake limit.

## Blockers

**B1. The company has been frozen since about 14:26 and will not recover by itself.**
- `company/tools/dispatch.js:1343` calls `cadence.tempoAllows(..., {record:true})`, which records a wake before the model check. Wakes then held at `dispatch.js:1358-1360` (no model, quota, refusal) still count.
- `cadence.js:399-417`: the count `n.day = wakes.length` is company-wide, but the cap is 120 a day.
- `company/state/tempo-wakes.json` holds 1,525 wakes in the last 24 hours against about 370 real runs a day. Vy alone shows 194 wakes for about 13 runs a day.
- Sprint lifted the caps until about 14:15. After that, every seat got TEMPO HOLD (`company/work/dispatch-log.md`, 81 lines: "1527 wakes in the last 24 h, cap 120").
- Model gates block every seat at the same time ("MODELS NOTHING CAN RUN", 27 lines since 14:00):
  - DeepSeek has no credit.
  - MiniMax is at its usage limit.
  - One Claude refusal blocks that seat on Claude for 24 hours (`lib/admit.js:88`, `models.js:221`). Phil is blocked until 02:11 and Vy until 22:23.
- Last real run started at 18:00. This is the same bug class the owner called the "cannon".

**B2. No agent can get a change onto CaPheOS main.**
- The project scope (`company/projects.json:79-83`) allows "open pull requests" but excludes "pushing with the owner's credentials". Dave's brief (`company/work/handoffs/to-nadia.md:2158`) repeats this as "if a pull request cannot be opened without them, stop".
- The only GitHub login is the owner's account (`gh auth status`: CaullenOmdahl, token scopes `repo` and `workflow`). So no pull request can ever be opened.
- Result: CaPheOS has never had a pull request (`gh pr list --state all` is empty), and the remote has only `main`.
- Crew branches sit only in the local repo, behind main:

| Branch | Ahead | Behind main |
|---|---|---|
| `fix/gate-carrier-not-authority` | 1 | 74 |
| `fix/inbox-list-withdrawn-and-pipe` | 3 | 74 |
| `fix/service-propose-changed-spec` | 2 | 74 |
| `fix/selftest-fixture-marker` | 2 | 74 |
| `fix/merge-gate-seat-binding` | 10 | 105 |
| `fix/gate-edit-base-act` | 1 | 12 |
| `fix/health-transport-grade` | 1 | 12 |
| `fix/premerge-stacked-base` | 1 | 12 |

- Their worktrees are in `~/Companies/ca-phe-digital/scratch/{nadia,omar,vy}/`.
- `feat/console-upload` (backlog item 1) is the branch currently checked out in `~/Projects/CaPheOS`. Nadia's log says "Not pushed, no PR yet" (`agents/engineering loop.md:2081-2082`).
- Needed: a separate identity for the company (a machine user or a GitHub App) that can push branches and open pull requests but cannot write to main, or an explicit owner ruling that the crew may push branches.

**B3. The CaPheOS checkout has no client-side gate, and the wrappers still point at the old company.**
- `~/Projects/CaPheOS/.git/hooks` has no pre-push hook and no `core.hooksPath`, and the crew's worktrees share that `.git`. Its push URL is the real GitHub URL, so an agent's `git push origin HEAD:main` meets no client-side check. Only the hourly tripwire would notice afterwards; it does watch CaPheOS through discovery (`company/work/security/default-branch-watch.json` with `discover:true`; the state file lists `CaullenOmdahl/CaPheOS`).
- The station's PATH (`~/.config/ca-phe-digital-station.env`) is `company/tools/shims:company/env/bin:/usr/...`. It does not include `~/.local/bin`, so the git and gh wrappers never run for Ca Phe Digital agents. `company/tools/shims` holds only `caphe-memory`, `sleep`, `systemctl` and `systemd-run`.
- The wrappers themselves (`~/.local/bin/git:9`, `~/.local/bin/gh:11`) and the BlackSheepApp pre-push hook (`company/repos/black-sheep-app/.git/hooks/pre-push:7`) still use `GATE=~/Projects/StarnetOS/company/tools/merge-gate.js`, the old company. That gate reads StarnetOS evidence and the run journal (`StarnetOS merge-gate.js:23-30`). The StarnetOS `merge-gate.log` was last written 2026-11-16, and Ca Phe Digital has no `merge-gate.log` at all.
  - Consequence: the 6 BlackSheepApp merges since the move were not gated client-side (#543, #545, #547 and #559 on 2026-11-18 UTC; #560 and #563 on 2026-11-19 03:30 ICT). They relied on agents running premerge-check and merge-train.sh voluntarily.
- Framework gap: `scripts/setup-station.sh:104-107` builds PATH without gate shims, and nothing installs per-instance git/gh shims or hooks on the framework checkout. The memory note in capheos-framework.md ("a second company needs its own wiring") was never done.

**B4. The framework test suite and CI have been red since 2026-11-17, so nothing can be gated on green.**
- `gh run list` for CaPheOS: 59 of the last 60 runs failed. The last success was 2026-11-17T10:44Z.
- Current failures (run 44504225377):
  - `instance-update-test.sh`
  - `locked-watch.js` selftest (2)
  - `module.js` selftest (11 of 16). Cause: `"--by owner" is accepted only from the owner's own interactive shell or the console` (`lib/owner.js:6-12`), and a CI or agent process is not an owner shell.
- Nadia already built the fix on an unmerged branch: `b06ab63` "selftests: a throwaway company answers owner checks when an agent runs the suite" (`fix/selftest-fixture-marker`).
- Nadia also lists red tests on main: pacer 4, sprint-dispatch 1, routing-e2e 1, routing-controls 1, budget-gate 1, meeting-ui-walk (`to-nadia.md:2316-2327`).
- `premerge-check.js:3-13` checks review, title, linked issue and deletion shape. It does not check CI or test.sh status.

**B5. The framework-request loop goes nowhere.**
- `harness-change.js:715-727` (main) writes `fr-NNNN.md` and tells the owner "It is kept for them to collect; nothing changes in your company" (today's digest: `company/owner/outbound.jsonl`, last row).
- `lib/framework-edits.js` and `locked-watch.js:1009` file in-place edits the same way.
- Ca Phe Digital has 45 requests (`company/work/framework-requests/fr-0001…fr-0045`). None has a status field, there is no VERDICTS file, and only 3 commits on any branch cite an fr id (fr-0013, fr-0018).
- Known stall causes sit uncollected. Example: DeepSeek `spend_history_unavailable` (fr-0008, fr-0024; `budget.js:20,141`, `starnet/sidecar/billing-class.js:253`) failed 43 runs in the last 48 hours.
- Crew-made files exist only in the instance (untracked in `git status`), not upstream: `tools/jobs.js`, `quest-tick.js`, `fiverr-inbox.js`, `prod-logs.sh`, `flutter-sdk.sh`, `lib/sse-watch.js`, `patches/0018-browser-editing-keys.diff`, `patches/0019-attach-shared-input-slot.diff`, `standards/release-workflow.md`, `standards/scheduling.md`, `tools/tests/health-probe.test.js`. None is on main or wave3.
- Harness faults have no filing tool. Nadia filed fr-0041 and fr-0042 "by hand: no tool files a harness-tool fault".
- The sandbox has 106 requests, and its only verdict file is `VERDICTS-2026-11-17.md`.

**B6. Applying an update to an instance is owner-only, and there is no staging step.**
- `framework-update.js:9,121` refuses anyone but the owner (`lib/owner.js`).
- It rolls back only when a step of the apply itself fails. There is no health window or automatic rollback after a deploy (no canary or watch-window logic).
- The sandbox and Ca Phe Digital both sit at `8dde227` (origin/main), applied by hand.

**B7. No seat's job includes developing CaPheOS.**
- `grep -i capheos|framework` over `company/roles/*.md`: Nadia, Vy, Marcus and Omar have 0 mentions (only agent.md has 3 and phil.md 2).
- None of the 30 routines in `.starnet-data/workspaces/cron.jobs.json` is a framework health check, upstream review, UI check at small window sizes, or competitor research.
- `company/work/ops/duty-policy.json` has empty `duties: {}`.
- The only standing improvement routine is "Improvement roundtable prep (weekly)" (hiring seat).

**B8. Model rules are broken, and the roster file is stale.**
- Code seats have MiniMax as a fallback (`company/model-policy.json`):

| Seat | Line | Chain |
|---|---|---|
| engineer (Nadia) | 186 | Sonnet → DeepSeek → MiniMax |
| deployer (Omar) | 280 | DeepSeek → Sonnet → MiniMax |
| Vy | 361 | Opus → Sonnet → DeepSeek → MiniMax |
| Bao | 383 | DeepSeek → Sonnet → MiniMax |

- These chains go against the code scope ("no MiniMax") and the owner's 2026-11-16 ruling. Bao, who writes code, has DeepSeek first.
- In the last 48 hours MiniMax ran code seats 21 times, including after the 2026-11-18 17:16 chain change:
  - Omar `health-probe.sh` (11-19 04:01)
  - Nadia `listing-redact.js` and `pacer.js`
  - Bao's BlackSheepApp `menu-loader.js` and `option-group-labels.ts`
  - 13 Vy review runs
- Vy's primary is Opus, which `model-policy.json` says "never run routines". In the last 48 hours Vy ran Opus once (content-policy blocked) and MiniMax 11 times.
- `company/ORG.md:10-22` model column does not match `model-policy.json` seats: Nadia is listed DeepSeek-first, Marcus MiniMax-first (actually haiku/xhigh), Vy Opus is missing.

**B9. Owner directions are not in the repo.**
- `docs/VISION.md` (119 lines) has nothing on self-improvement, push wakes, the RAM lifecycle or autonomous mode, and there is no ROADMAP. The crew cannot read these directions; they live only in private memory and scratchpad specs.

## Spend and model use, last 48 hours (`.starnet-data/workspaces/runs.jsonl{,.1}`)

- 738 runs, about 1,301M tokens, $2.69 metered (all DeepSeek).

| Model | Runs | Tokens | Avg per run | Median turns | Avg minutes |
|---|---|---|---|---|---|
| MiniMax | 61 | 540M | 8.9M | 111 | 31 |
| DeepSeek | 82 | 344M | — | 0 | — |
| Sonnet | 409 | 299M | 0.7M | 7 | 1 |
| Fable (all) | 112 | 92M | 0.8M | — | — |

- MiniMax costs about 12 times more context per run than Sonnet. DeepSeek's median of 0 turns means most of its runs failed at the start.
- By seat: Nadia 112 runs / 249M, Dave 143 / 174M, Vy 26 / 157M, Phil 62 / 156M, Omar 69 / 118M, Sharon 52 / 95M, Tuan 43 / 77M, Rachel 38 / 73M, Priya 52 / 70M, Bao 56 / 48M, Marcus 24 / 44M, Rosa 21 / 28M, Leo 16 / 13M.
- Failures: 87 errored runs (`spend_history_unavailable` 43, `quota_exhausted` 32, `billing` 10, `content_policy_blocked` 4).
- Tool errors: `fs_edit` 138, `shell_exec` 111, `fs_patch` 59.
- 219 runs finished with 6 turns or fewer and produced nothing (Dave 37, Bao 32, Sharon 30, Phil 23): wasted wakes, the push-wakes problem.
- For comparison, the sandbox used 485M tokens over 516 runs in 24 hours (Fable 1M-context 312M). A full crew is too expensive to use as a smoke test.

## Communication and stalls

- Inboxes are very large:

| Inbox | Lines | OPEN | BLOCKED |
|---|---|---|---|
| `to-nadia.md` | 2,527 | 95 | 22 |
| `to-omar.md` | — | 31 | 2 |
| `to-phil.md` | — | 23 | 0 |
| `to-vy.md` | — | 12 | 1 |

- Handoffs are long-form, path-heavy prose. Nadia's last queue pass found "nothing new buildable; each remaining item waits on a named holder" (`to-nadia.md:2500`).
- The 2026-11-16 table: `table-2026-11-16-record-check.md` found 13 items not recorded, 65 partly recorded, 2 recorded differently and 25 recorded. Rulings 1-3 and Rachel's decisions row were "not written" (`table-2026-11-16-actions.md`). Action follow-through is weak.

## Research and creativity

- 34 files in `company/work/research/`. They are thorough and well sourced (persona echoing, GitHub idea inventory of 53 repos, CaPheOS resale), but every one was written on request.
- None covers competing agent frameworks: a grep for crewai, autogen, langgraph, openhands, metagpt, devin or swe-agent finds only the two persona files.
- No recurring market or competitor research routine exists for CaPheOS. Marcus's only weekly routine is "Revenue: portfolio to offers".

## What already works (worth reusing)

- **Bug-fix quality:** Omar's and Nadia's commits carry selftests and mutant checks (e.g. `4c39890` "selftest 53 -> 63; mutant without the reader hunk fails"). Vy gives independent verdicts (`company/work/engineering/verdicts/`). Phil runs adversarial probes (`company/work/security/probes/sr18-carrier-authority.js`: branch 12 of 12, live gate 11 of 12 wrong).
- **Backlog:** Nadia's ranked backlog (`company/work/engineering/harness-backlog.md`, 7 items with proof criteria) and `product-fit.md` (318 lines, with Priya and Phil sign-offs) are the right intake.
- **BlackSheepApp pipeline:** PR → `premerge-check.js` (named independent reviewer, no CI) → CEO clearance rows (`company/work/decisions/clearance-merge-*.md`) → `merge-train.sh` (`--match-head-commit`, 23:00-05:30 window). GitHub CI there is only the Claude Code workflows; local CI is `company/tools/ci-local.sh`.
- **Monitoring:** `health-check.sh` and `health-probe.sh` (read-only, opens incidents), `locked-watch.js`, `default-branch-watch.js` (hourly, attributes pushes), `framework-update.js check` (dry run).
- **Instance guard:** Ca Phe Digital's push URL is `no-push://capheos-instance`, with pre-commit and pre-push hooks from `scripts/instance-guard.sh`.

## The sandbox as staging (`~/Companies/capheos-sandbox`)

- **Already suitable:** it is a founded instance at the same main commit (`8dde227`), with a no-push URL and its own units (station 8810, console 8910, dispatch service active). Its crew does a different kind of work (trading), which exercises general paths rather than Ca Phe Digital-specific ones.
- **Missing pieces:**
  - an apply step that is not owner-only, behind a governance level (B6);
  - a health window after the apply with automatic rollback;
  - a cheaper smoke mode: the mock station plus first-light e2e, or 1-2 seats on Haiku, rather than the full Fable/Sonnet crew at 485M tokens a day;
  - a promotion rule ("Ca Phe Digital after N clean hours");
  - collection of its 106 framework requests (B5).
- It also has a forward-order file worth keeping (`company/work/framework-requests/ORDER.md`: diffs first, whole-file replacements only after regeneration).

## Smallest path to self-improvement (in order)

1. Fix B1: count a wake only when a run actually starts, and make the cap per seat or scale it to the crew. Reconsider the 24-hour Claude block after a single refusal.
2. Make CI green: merge `fix/selftest-fixture-marker` and fix `instance-update-test.sh`. Add a CI-green or test.sh check to `premerge-check.js`.
3. Get a GitHub identity for the company that can push branches and open pull requests but cannot write to main. Fix the project scope wording.
4. Install a framework pre-push hook and per-instance git/gh shims through `setup-station.sh`. Repoint the wrappers and the BlackSheepApp hook to the Ca Phe Digital gate.
5. Collect framework requests automatically: give each fr a state and verdict, and route it to Nadia as a branch and PR. Add a harness-fault filing tool.
6. Assign the duties: Nadia owns the framework 30-minute health check and upstream review, Vy the review gate, Phil adversarial review, Leo UI checks at small windows, Marcus a weekly competitor scan. Put these in role files and duties, as generators feeding inboxes rather than ticks.
7. Pipeline: sandbox apply with a health window and rollback, then Ca Phe Digital after a clean window.
8. Remove MiniMax from code-seat chains, put Bao on Claude first, and sync ORG.md.
9. Move the owner directions into `docs/VISION.md` or a new `docs/ROADMAP.md`.

No files were written; the one temporary script was deleted.