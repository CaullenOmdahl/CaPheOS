# Console API (v0)

`console/server.js` — a dependency-free Node server, run by the owner on this machine:

```
node console/server.js            # http://127.0.0.1:<console.port, default station port + 100>
node console/server.js --port N   # or env CONSOLE_PORT; --host H
node console/server.js --selftest # temp copy of company/ (env CAPHEOS_ROOT), dead station (env STARNET_URL)
scripts/console.sh                # same as the first line
```

- `CAPHEOS_ROOT` (honoured by company/tools/lib/company.js) points the server and every tool it runs at another root.
- Unknown path: 404; known path, wrong method: 405; a POST must be `content-type: application/json` (415 otherwise).
  Tool exit 2 → 400, exit 3 (refused, not the owner) → 403, timeout → 504.
- If `console/ui/index.html` does not exist yet, `/` serves a one-line placeholder page.

- Binds 127.0.0.1 only (config `console.host`/`console.port` in company/company.json may change it).
- Auth: every `/api/*` request needs the owner token from `secrets/console-token` (created on first start, 0600),
  sent as header `x-console-token` or cookie `console_token`. `GET /login?token=…` sets the cookie and redirects to `/`.
  The server prints the login URL on start.
- The browser never sees the station token: station calls go through `/api/station/*`.
- Every write acts **as the owner** (`--by <owner name>`), through the same tools an owner would run in a shell.
- Responses are JSON. Errors: `{ ok:false, error }` with a 4xx/5xx status. Tool output that is not JSON comes back as
  `{ ok:true, text }`.
- Static UI is served from `console/ui/` (`/` → `console/ui/index.html`).
- `GET /api/events` is a Server-Sent Events stream: `event: change` with `{ topic }` whenever a watched file changes
  (topics: `questions` (company/pm-inbox.jsonl, asks.jsonl), `owner` (company/owner/*), `handoffs`, `halt`,
  `governance`, `guardrails`, `cadence`, `panels`, `dispatch` (dispatch-log.md), `crew` (loops.json), `charter`
  (company/CHARTER.md), `now` (a run started, took a step or ended: the observer feed below), `activity`
  (decisions.md, dispatch-log.md, the owner channel)). The UI refetches the matching endpoint. Poll fallback: every 15 s.
- Agent-written text (live chat, owner-channel replies, question bodies, activity lines, the charter) is rendered as
  safe markdown (console/ui/js/md.js): `console:#/…` and `#/…` links stay in the console, http(s) links open a new tab
  with `rel="noopener noreferrer"`, any other scheme is dropped; nothing becomes markup. The route map agents link to
  is docs/CONSOLE-LINKS.md.

## Company

| Method | Path | Does | Backed by |
|---|---|---|---|
| GET | /api/company | company.json (name, owner, timezone, station, ownerChannel), `ceo: {id, name}`, `onboarding: {certified, kickoff: {status, at, planOpen}}` | lib/company.js, onboarding-state.json |
| GET | /api/today | `{ company, needsYou, crew, usage, overnight, halt, panels: [ids placed on today] }` in one call | below |
| GET | /api/questions | open owner questions `[{id, from, about, q, blocking, askedAt, batch, gate?}]` | inbox.js openQuestions() + lib/governance pendingGates() |
| POST | /api/questions/:id/answer | `{ verdict: "yes"\|"no"\|"reply", text? }` records the owner's answer | inbox.js answer (CLI) |
| GET | /api/questions/answered?since=ISO | answered today | inbox.js state |
| GET | /api/owner/messages | `{ messages, channel }`: the owner channel both ways, newest last; every owner message carries `state` (below), `channel` = `{ ok, problems: [{code, msg, fix, link}], ceo, nextCheckMin, working, tickMin, loop }` | owner-inbox.js, console/chat.js |
| POST | /api/owner/messages | `{ text, to? }` owner writes to the company (appends company/owner/inbound.jsonl; `to` = a crew name prefixes the text so owner-addressing routes it); answers the row with its `state` | owner-inbox |
| GET | /api/crew | `{ seats:[{id, ...seat, station?, hire?, firstRun?}], station:'up'\|'down' }`: loops.json seats merged with the station roster (`/api/roster`, 2.5 s timeout); a hired seat carries `hire {round, at, pickedBy}` and `firstRun {runId, at, outcome}` (its first run since the hire, from runs.jsonl; null while still to come) | loops.json, station, hiring/, runs.jsonl |
| GET | /api/handoffs | open handoffs by deadline | `handoff-status.js --due --json` |
| GET | /api/decisions | last 100 lines of company/work/decisions.md as `{ entries:[{text}] }` | file |
| GET | /api/dispatch | last tick, recent log lines | work/dispatch-state.json, dispatch-log.md |
| GET | /api/hiring | rounds under company/hiring/*/round.json + templates in company/roles/templates; each round carries `stage {key, label, at, waitingOn, counts, timeline[{step, at}]}` from hire.js roundStage. Keys: `needs-files`, `candidates`, `interviewing` (label "interviewing 2/3"), `interviews-failed`, `waiting-pick` ("waiting for pick by X"), `picked`, `waiting-owner`, `declined`, `hired`, `closed` | files |
| GET | /api/usage | pacer status | `pacer.js status --json` (or `report`) |

## Controls

| Method | Path | Body | Backed by |
|---|---|---|---|
| GET | /api/governance | — | `governance.js show --json` |
| POST | /api/governance/preset | `{ preset }` | `governance.js preset <id> --by <owner>` |
| POST | /api/governance/set | `{ category, level }` (level auto, notify, triage or approve) | `governance.js set …` |
| GET | /api/decision-models | — | `decide.js list --json` → `{ ok, models: [{id, title, versions, active, mode, params, cases, evaluations, lastAt, valid}] }` (Controls › Self-governance) |
| GET | /api/onboarding | — | `onboard.js --check --json` → `{ ok, provisioned, certified, certifiedAt, lastCertify, steps: [{id, what, status, at, note}], checks: [{id, what, status: ok\|failed\|unchecked, missing}], missing: [..], gates }` (System › Provisioning; Today banner while not certified). `GET /api/today` carries `onboarding: {certified, failed}` |
| POST | /api/onboarding/certify | {} | re-runs `onboard.js --certify --json` (the 11 checks) → `{ ok: true, certified, results: {<check>: {ok, missing}} }` |
| any | /api/m/&lt;module&gt;/&lt;path&gt; | module-defined | an enabled core module's `http.js` route with `auth: 'owner'` (docs/CORE-MODULES.md "The module mechanism"); raw body capped at 256 KB |
| any | /hooks/&lt;module&gt;/&lt;path&gt; | module-defined | an enabled module's `auth: 'source'` route: **no owner token**, the module authenticates the caller (HMAC/token); 404 when the module is not enabled; 413 over 256 KB |
| GET | /api/guardrails | — | `guardrails.js show --json` |
| POST | /api/guardrails/set | `{ name, on, why? }` | `guardrails.js set <name> on\|off --by <owner>` |
| POST | /api/guardrails/all | `{ on, confirm? }` | `on-all` / `off-all --confirm` |
| POST | /api/guardrails/sandbox | `{ on }` | `guardrails.js sandbox on\|off` |
| GET | /api/halt | — | `halt.js status --json` |
| POST | /api/halt/soft | `{ why?, deadlineMin?, escalate? }` | `halt.js soft --by <owner>` |
| POST | /api/halt/hard | `{ why? }` | `halt.js hard --by <owner>` |
| POST | /api/halt/resume | — | `halt.js resume --by <owner>` |
| GET | /api/cadence | — | `cadence.js show --json` |
| POST | /api/cadence/default | `{ minutes }` | `cadence.js set-default` |
| POST | /api/cadence/seat | `{ seat, loopEvery?, cooldown?, priority?, wakeOnInbox?, wakeOnOwner? }` | `cadence.js set` then `apply`; returns `{ set, apply }` (apply may refuse at the `schedules` approve level) |
| GET | /api/panels | panels with placement and state | `console-panel.js list --json` |
| GET | /api/panels/:id/data | resolved data for a panel | console-panel.js `render()` (required as a module) |
| GET | /api/panels/:id/view | the panel's custom view.html (served for a sandboxed iframe srcdoc) | file |
| POST | /api/panels/:id/hide \| unhide \| approve \| reject \| remove | — | console-panel.js |
| GET | /api/governance-log, /api/locked, /api/external | read-only reports | governance-log.jsonl (last 200 rows as `{entries}`), `locked-watch.js status` (no JSON mode: `{ ok, text }`), `external-gate.js list` (JSON) |

## Live chat

Talking to a crew member from the console is a live run on the station (console/chat.js, UI console/ui/js/chat.js).

| Method | Path | Body | Does |
|---|---|---|---|
| GET | /api/chat/:seat | — | `{ agent: {id, name, title}, model, provider, modelFrom, streamId: "console-<seat>", turns: [{role, content, at}], problems: [{code, message, fix, link}] }`. The model is the seat's loop routine pair, else its roster row, else model-policy.json `candidateDefault`. The turns are the station transcript (`/api/transcript?stream=console-<seat>`), so the conversation reloads when the owner comes back |
| POST | /api/chat/:seat/send | `{ text }` or `{ brief: "charter"\|"charter-change", notes? }` | streams NDJSON `{name, payload}`: first `console.user {text}` (a brief is expanded server side: the charter brief asks a few short questions, then has the seat write company/CHARTER.md with every template heading and no placeholder, and end with `[Review it in Setup](console:#/setup/charter)`), then `console.run {model, provider, from}`, then the station run's own events (`agent.run.start`, `agent.token` `{delta}`, `agent.tool_call` `{name, argsSummary}`, `agent.tool_result`, `permission.prompt`, `agent.run.error`, `agent.run.end` `{reason, outcome, usd}`). A refusal is one `console.error {code, message, fix, link}` line, never silence: `halted` (hard halt), `station-down`, `no-model`, `budget-hold` (a metered model with a $0 daily cap while the spendCap guardrail is on), `station-refused` (the station's own 4xx, e.g. a missing key), `cut-off` (the stream ended before `agent.run.end`) |

The run goes to the station's `POST /api/run` with `rosterSystem: true`, `streamId: console-<seat>`, the last 40 turns,
`projectRoot` = the company root and `placed` = files, terminal, memory and web, so the seat can do what the owner asks
(write the charter). The company folder is blessed as a project first (`founder-loop.js blessRoot`, idempotent).
Stop = `POST /api/station/cancel {runId}` (and the browser closing the stream, which the station also treats as a stop).
Approvals the run asks for are answered with `POST /api/station/consent {runId, promptId, decision}`.

## Owner channel

The asynchronous channel (company/owner/inbound.jsonl → the dispatcher wakes the CEO's loop) stays for messages the
crew picks up while the owner is away, and every owner message shows its state (`state.status`):
`waiting` ("waiting for the Founder — next check within N min": the dispatcher tick, the 10-minute owner cooldown and
the loop's last run), `working` (the loop is running now), `read` (acknowledged, with the note), `answered` (an
outbound message names it with `re`; the reply is threaded under it), `stuck` (nobody will pick it up, with the fix and
a link): no seat wakes on owner messages, no Founder loop / no terminal grant / company folder not blessed /
scheduler off (founder-loop.js status), the company halted, the dispatcher not ticking, the fast wake stalled after 3
runs, or the CEO held in "ask" approval mode.

## Now and activity

The crew's work, visible (console/activity.js). The console keeps one connection to the station's observer feed
(`GET /api/observe`, SSE `data: {name, payload}` for every non-internal run) and merges it with
`GET /api/state/snapshot` (the runs the station holds).

| Method | Path | Does |
|---|---|---|
| GET | /api/now | `{ station: {up, feed}, runs: [{runId, agentId, name, kind: routine\|chat\|…, label, href, step ("reading company/CHARTER.md", "running hire.js open…"), steps, elapsedSec, usd, stoppable, watched}], seats: [{id, name, running, loop, enabled, nextRunAt, schedule, soonerBecause: ["2 open handoffs", "1 unread message from you"], wakesOnMessage, schedulerOn}] }` |
| GET | /api/now/run/:runId?after=N | the run's events after `N` (`start`, `tool {text}`, `result {ok}`, `token {delta}`, `error`, `end`) for the Watch view, `done`, `outcome`, `usd` |
| GET | /api/activity | recent activity (48 h), newest first: finished runs from runs.jsonl (outcome, cost, the first sentence of the reply), hiring-round log lines with the hiring governance level, one `kind:'hiring-stage'` item per open round with its live stage and timeline times ("Crew decides: done without asking you"), owner-channel replies and decisions, each with `links: [{label, href}]` into the console |

Today shows "Now" (each run with Watch and Stop, then each idle seat's next run and why it would wake sooner),
"Recent activity", and while the post-certification kickoff handoff is open, "Founder is drafting the first plan…".

## Setup

The guided Setup screen (`#/setup`, console/ui/js/screens/setup.js; server side console/setup.js). It is the landing
page until `onboard.js --certify` is green (`GET /api/company` carries `onboarding: {certified, ...}`), then Today is;
System links back to it. Seven steps, each `{ id, title, status: done|needs|optional, why }`, computed from the files and
the station on every call. Onboarding questions (from `onboard.js` or about `onboarding`) never render as
Approve/Decline on Today: Today shows "Finish setup — N of 7 done" and Setup lists any onboarding ask its steps do not
cover, with a reply box. Every write acts as the owner; locked files are recorded with provenance.js and each change
gets one line in company/work/decisions.md.

| Method | Path | Body | Does |
|---|---|---|---|
| GET | /api/setup | — | `{ certified, done, total: 7, steps, company, station: {up, error, url, claude}, providers: [{id, name, how: signin\|key, unmetered, ready, present, isDefault, metered}], candidateDefault, budget, governance, charter: {placeholders, mandate, forWhom, outOfScope, firstGoal}, guardrails, checks, lastCertify, onboardingQuestions }` |
| POST | /api/setup/company | `{ name?, ownerName?, timezone? }` | writes company/company.json; timezone must be a valid IANA zone (400 otherwise). Later owner writes use the new name |
| POST | /api/setup/provider/validate | `{ provider, key, baseUrl? }` | station `providers/validate` → `{ valid, reachable, error, modelCount }`; the key is never echoed |
| POST | /api/setup/provider | `{ provider: claude-cli\|custom\|deepseek\|openrouter\|anthropic, key?, baseUrl?, model?, subscription? }` | key providers: station `providers/validate`, then `providers/connect` (a headless station answers `no-page`: then `providers/engine-key`). claude-cli: requires the station's `auth/claude-cli/status` signed in. Then sets model-policy.json `candidateDefault` (adds the provider to `allowed` if new), marks `custom` (MiniMax plan) subscription-billed when `subscription` is not false, and, once a candidate can actually run, answers the onboard.js candidate-default question and records the `candidate-default` step ok. Station down: 502 |
| POST | /api/setup/budget | `{ dailyUsd, perAgentUsd? }` | company/work/finance/dispatch-budget.json (0–10000; share ≤ cap), `setBy` = the owner (the owner's direct edit, recorded for locked-watch) |
| POST | /api/setup/charter | `{ mandate, forWhom?, outOfScope, firstGoal? }` or `{ text }` | the form fills company/CHARTER.md from its template (Mandate, What is out of scope, First goal; 400 if any `{{…}}`/`<…>` placeholder would remain); `text` saves the owner's own edit of the whole file as written and answers the blanks left |
| GET | /api/setup/charter | — | `{ text, at, placeholders, fields }`: the charter as it stands (Setup renders it; the step flips to Done on the `charter` SSE topic once no placeholder is left) |

Deep links: `#/setup/<step>` opens that step and scrolls to it (`company`, `provider`, `budget`, `governance`,
`charter`, `guardrails`, `certify`). The provider step also moves the Founder loop to the provider picked
(`founder-loop.js ensure --provider --model`, which creates the loop if onboarding has not), and answers
`founderLoop: {ok, text}`. "Draft it with the Founder" opens the live chat with the Founder and sends the charter brief.

Governance, guardrails and certification use the endpoints above (`/api/governance/preset`, `/api/guardrails/*`,
`/api/onboarding/certify`). The Claude subscription sign-in runs through the station proxy (`auth/claude-cli/start`,
`poll`, `code`, `cancel` are on the POST allowlist): start returns a sign-in URL, the owner pastes the code the page
shows, the UI polls until `connected`; the terminal alternative is `claude auth login` on the station machine.

## Station proxy

`/api/station/<path>` → `<station url>/api/<path>` with the station token added. GET is passed through. POST is passed
through only for an allowlist the owner UI needs (403 otherwise): `run`, `run/steer`, `run/stream`, `cancel`, `groups` (send, create, control incl.
delete), `cron/run`, `cron/update`, `cron/arm`, `loops/control`, `consent`, `consent/answer`, `permissions/*`, `autonomy/*`,
`connectors/*`, `servicekeys/*`, `skills/toggle`, `providers/*`, `halt`, `halt/resume`, `transcript/redact`, `session`,
`auth/claude-cli/start`, `auth/claude-cli/poll`, `auth/claude-cli/code`, `auth/claude-cli/cancel`.
Streaming responses (`run/stream`, SSE) are piped through unchanged. Station down or no `secrets/station-token`: 502
`{ ok:false, error }`. Paths with `..`, `.` or empty segments: 400.
