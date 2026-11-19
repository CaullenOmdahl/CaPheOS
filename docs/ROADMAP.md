# Roadmap

What is planned for CaPheOS, in order, owned by the crew that develops it (the platform department). Each item says
what and why, where its spec is, and a **Done when** line that can be checked. Update the **State** when an item moves;
add rows for new work. The owner's decisions behind these items are in `docs/OWNER-RULES.md` and are not reopened
here. Specs live in the developing company's own records (`company/work/platform/specs/`), not in this repo: they describe that company's seats and incidents.

## Where things stand (owner asks of 2026-11-19, by tracker number)

| # | Item | State |
|---|---|---|
| 1 | Owner asks: plain words, only real owner matters | live |
| 2 | Meetings as the table, colleagues in chat, thinking/model pin, no hard stop, stay-in-room note | live |
| 3 | Chat and meeting layout (folds, icon sidebar, floating composer, Skim notice) | live |
| 4 | Pacer stale-meter deadlock fix | live |
| 5 | Sandbox creative crew and profiles | live in the sandbox |
| 6 | Wave 3 (profiles, talk level, accountable leads recording-only) | live, off by default; see R4 |
| 7 | Accountable leads | recording-only path live; live mode open (R4) |
| 8 | RAM lifecycle (reaper, caps, browser lifecycle) | live; follow-ups R7 |
| 9 | Push wakes | designed (R5) |
| 10 | Automatic model choice | designed and critiqued (R6) |
| 11 | Self-improvement: the crew develops CaPheOS | building (R1, R2) |
| 12 | Owner-experience lens: persona, plain-words gate, walkthroughs, UX markers | `docs/USER.md` and the words check live; rest in R2 |
| 13 | Security watch (known holes as P0) | live; follow-ups R8 |
| 14 | Image library security hole in the station (sharp/librsvg) | open; R8 |
| 15 | Model downshift off the top Claude model | on hold until the membership ends (R9) |
| 16 | Full "stay in the room" persistent runs | parked (R13) |
| 19 | The crew merges and deploys its own changes; on-machine update with watchdog and rollback | approved; R1 |
| 20 | DeepSeek rests; find out what went wrong with its key | parked; R10 |
| 21 | Scout logins for X, Instagram, TikTok | approved; needs the container desktop (R11) |
| 22 | Main company frozen by the wake cap counting held wakes | done |
| 23 | Selftests wrote fake rows into live logs | done |
| 24 | Code seats had non-Claude fallbacks | done |
| 25 | Self-improvement blockers (no gates wired, CI red, request loop going nowhere, owner-only update, no CaPheOS roles, directions not in the repo) | in R1 |
| 26 | Station patch numbering clash (two companies' patches with the same number) | open; R12 |
| 27 | RAM: agent-started Chrome and interview scopes escape the company's memory slice | open; R7 |

## R1. The pipeline: from a found problem to a deployed fix without the owner

Spec: `company/work/platform/specs/self-improvement-final.md` Part F (as changed by its "OWNER DECISION 2026-11-19" section: no GitHub
Pro, no app, gates only), `company/work/platform/specs/self-improvement-survey.md` (blockers B2-B9). The pieces, smallest first:
(a) per-company git/gh wrappers and a pre-push hook on every CaPheOS checkout that refuse pushes to main, force pushes
and ungated merges; (b) CI green again and `scripts/test.sh` as the merge gate; (c) one merge tool (premerge check,
local CI record, lead ACCEPT, risk sign-off for gate changes) and a 5-minute check on main that reverts anything that
did not come through it; (d) every framework request ends in a merged PR or a recorded "no" (the `improve-fr` duty
files them; old inboxes swept); (e) staged update: keep the previous good version, test, switch in place, a plain-code
watchdog on its own timer that rolls back by itself if health fails, sandbox first, the main company after a clean
24 h; (f) a pause switch for the owner and a platform share of Claude use (about a quarter) that is held first near
the owner's stop.

**State:** (d) started: `improve-fr` duty and the platform department (`platform-setup.js`). The rest open.
**Done when:** for 3 days running at least one item goes generator → PR → CI → lead ACCEPT → merge → sandbox clean →
main company clean with no orchestrator or owner action, and nothing reached main any other way.

## R2. The improvement engine (generators, backlog, scorecard)

Spec: `company/work/platform/specs/self-improvement-final.md` Part G, `docs/IMPROVE.md` (what is built). Built: six read-only duties
(health, efficiency, owner experience, framework requests, weekly research, weekly retro) that file items to the right
seat. Next: one backlog file with ranking by outcome (re-measure 7 days after release; generators that over-guess
lose weight), WIP limits, a CI generator (bisect a red main, flakes, slow steps), upstream review of every instance's
local branches and in-place edits, a "Getting better" page with seven plain rows, persona walkthroughs at 1000x500 and
390 wide with screenshots attached to the PR, the plain-words check as a blocking CI step on owner-facing PRs, and a
people miner for the people function (watch-only).

**State:** generators built (off by default; switched on per company by `platform-setup.js apply`).
**Done when:** after 2 weeks at least 10 items have an outcome measured, every screen passes at 1000x500 and 390 wide,
and the owner saw zero jargon for a week.

## R3. Handover: the crew owns this roadmap

Spec: `company/work/platform/specs/self-improvement-final.md` Part H. The crew updates this file, `docs/OWNER-RULES.md` and
`docs/USER.md` stay the owner's words, and the orchestrator steps back to a weekly read.
**Done when:** over 5 consecutive days: planted-fault detection ≥ 80% within 24 h, ≥ 15 PRs merged through the
pipeline, 0 problems that reached the main company, ≥ 1 automatic rollback drill in the sandbox, main green every day,
owner asks ≤ 3 a week with 0 jargon, idle wakes < 10%.

## R4. Accountable leads: live mode

Spec: `company/work/platform/specs/accountable-leads.md`. Wave 3 shipped the recording-only path. Left: the binding audit holding the
onward handoff, merge and DONE until the lead ACCEPTs; audit packets (diff + acceptance check + self-check note);
mid-tier audits for routine items; the department scorecard on the lead (on time, sent back, cost per accepted item,
escapes) on the console's department card; the measured saving against the lead working alone; the sandbox naming its
engineering lead. The live-mode edge cases found in review are tightened before it is switched on.
**Done when:** one department runs in live mode for a week with the scorecard filled and the measured cost per
accepted item shown next to the lead-alone figure; if the saving is not there, the department falls back to advisor
mode and the owner is told plainly.

## R5. Push wakes: a seat runs only when it has work

Spec: `company/work/platform/specs/push-wakes-spec.md`. Remove the standing-queue wake, the seat crons and the idle check-in; an
event-driven dispatcher (inbox and state file watches plus a timer wheel) wakes a seat only for an unhandled item, and
the wake carries exactly those items with a per-run budget. Scheduled work comes from generators, watching from
monitors (the improvement duties are the first). Stalls by item age.
**Done when:** idle wake rate < 5%, recorded wakes ÷ started runs ≤ 1.1, and 0 missed owner answers over a shadow week.

## R6. Automatic model choice

Spec: `company/work/platform/specs/autonomous-mode-spec.md` with the required amendments in `company/work/platform/specs/autonomous-mode-critique.md`.
Plain-code job grading, a scoreboard module fed by the leads' audits, a tokenless router (Manual / Suggest /
Automatic; manual pins always win), free OpenRouter models by owner opt-in, an opt-in shared score registry. Must fix
first: cost as real spend (subscriptions are already paid up to the stop), a quality bar that is fair for thin and long
records, a comparison group so audit drift is caught, rubber-stamp detection, an auditor loop, scores keyed by risk,
and checks of what data is actually sent. Code stays on Claude.
**Done when:** Suggest mode runs a week in the sandbox and its picks would have cut real spend without a rise in
sent-back work; Automatic is offered to the owner only after that.

## R7. Memory (RAM) follow-ups

Spec: `company/work/platform/specs/ram-spec.md`. Left: browsers started by agents and the hiring interview runs escape the company's
memory slice and must be started inside it; when the local AI model is installed, keep its memory free (a setting the
owner sees in plain words, shared by every company on the machine).
**Done when:** every Chrome and interview process on the machine is inside its company's slice, and the reaper reports
no stray for 3 days.

## R8. Security follow-ups

Spec: `company/work/platform/specs/security-watch-spec.md`. Left: the CEO records the standing gate rows for checking the public
vulnerability lists and for filing issues on the CaPheOS repository; the station's image library hole: move to the
fixed sharp release (0.35.5, the station pins 0.35.4) and block the SVG loader in the station's local voice and image
tools until then, as a station patch; the issue on the repository filed once; the owner told in plain words.
**Done when:** the security watch shows no open P0 and the image-library finding is closed by the patched station in
both companies.

## R9. Model downshift after the Claude membership

When the current Claude membership ends, move seats off the top model to the cheapest model that does each job
(chains stay 1-2-3, code stays on Claude, the CEO seat stays on Claude). Until then the heavy use is on purpose.
**Done when:** the membership has ended and every seat's primary is the model the ranking (or R6) picks for its work,
with no rise in sent-back work over a week.

## R10. DeepSeek: find out what went wrong

Read-only investigation: where the key lives and who reads it, why runs started without credit, the
`spend_history_unavailable` failures, holds and top-up wakes. Output: one plain note to the owner with one
recommendation. DeepSeek stays off until the owner lifts it.
**Done when:** the note is delivered and the owner has answered it.

## R11. Container desktop, scout logins, container deploy

A sandboxed desktop with a persistent logged-in browser for the scouts (dedicated company accounts, read-only,
rate-limited, session health checks that re-login or file an item), then the X, Instagram and TikTok logins (the
owner creates the accounts). Later the container deploy: one image and compose file running the station, console,
dispatcher and watchdog under one supervisor.
**Done when:** session health ≥ 95% over a week for each scout login, and a company runs from the container with all
its state on one volume.

## R12. Station patch numbering

Two companies' station patches use the same numbers (a crew's local 0018/0019 and the framework's 0018). Renumber the
company-local ones or upstream them, and make the patch tool refuse a clash.
**Done when:** every station patch number is unique and the tool refuses a duplicate.

## R13. Parked

- Full "stay in the room" persistent runs for meetings (spec: `company/work/platform/specs/table-followups.md` §3); the turn note shipped.
- Console upload and the old harness backlog: through R1 as ordinary items.
