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

- Binds 127.0.0.1 by default. `console.host`/`console.port` in company/company.json, or env `CONSOLE_HOST`/
  `CONSOLE_PORT` (env wins), change it; a non-loopback address prints a warning at start. Settings › System ›
  Sign-in and access sets it from the browser (`POST /api/ops/access`, restart needed).
- Auth (console/auth.js; docs/DEPLOY-SERVER.md): a browser signs in on the login page (`GET /login`, a form that
  `POST /login`s `secret` = the owner token from `secrets/console-token`, a passphrase, or a one-time recovery code)
  and gets a signed session cookie `capheos_session` (HttpOnly, SameSite=Lax, Secure over HTTPS, expiry
  `console.sessionHours`, default 168) plus `capheos_csrf`. **A token in an address is never accepted** (`GET
  /login?token=…` answers 400 and sets nothing). Every write signed in by the cookie needs header `x-csrf-token`
  (console/ui/js/csrf.js adds it) and a same-site `Origin`; else 403 `{csrf:true}`. Scripts send header
  `x-console-token` instead (no CSRF token needed: a browser cannot send it cross-site without a preflight). Failed
  sign-ins: 5 per client per 15 min, 30 overall, then 429 + Retry-After. `X-Forwarded-Proto/-For/-Host` are believed
  only from `console.trustProxy` (false | true = this machine | [addresses]; env `CONSOLE_TRUST_PROXY`).
  `GET /api/health` answers `{ok:true}` with no auth and no detail (a container health check).
  `GET /api/auth/session`; `POST /api/auth/logout`; `POST /api/auth/rotate` (sign out everywhere: new token, shown once,
  this browser re-signed); `POST /api/auth/passphrase {passphrase, current?}` or `{clear:true}`;
  `POST /api/auth/recovery-code` (a new one-time code, shown once). Server admin: `node console/server.js --reset-login`.
- The owner's server chores (console/owner-ops.js, every write recorded in company/state/owner-ops.jsonl):
  `/api/ops/flags` (+ `/accept`, `/revert` `{key, why}`), `/api/ops/scheduler` (dry runs; POST `{to, confirm}`,
  `/seat`), `/api/ops/services/unregistered` and `/adopt`, `/api/ops/modules` and `/<id>/enable|disable`,
  `/api/ops/guardrails/apply`, `/api/ops/restart` and `/station`, `/console`, `/api/ops/update` (the dry run) and
  `/apply {expect}`, `/api/ops/access`, `/api/ops/jobs[/<id>]`, `/api/ops/log`. Streams (`/api/events`, chat, the
  station proxy) carry `x-accel-buffering: no`; SSE pings every 25 s and the chat stream sends a blank line every 20 s.
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
| GET | /api/questions | open owner questions `[{id, from, about, q, message, details, messageDerived, blocking, askedAt, batch, kind, form: {fields, actions}, snoozedUntil?, secretHint?, askerSeat, gate?}]` (see "Typed owner questions") | inbox.js openQuestions() + lib/governance pendingGates() |
| POST | /api/questions/:id/answer | `{ action, values: {<fieldId>: value}, note?, replace?: {<secretFieldId>: true}, secretNames?: {<hinted field>: name}, endpoints?: {<MiniMax secret field>: {region, baseUrl?, other?}} }`, or the old `{ verdict: "yes"\|"no"\|"reply", text? }`; answers `{ok, id, a (plain words), answer, stored: [{stored, chars, validated}]}`. A request with `questions`: `{ parts: {<questionId>: {action, values, note?, replace?, secretNames?}}, closeRest? }` answers some of them (`state` stays `open` until every required one is answered or `closeRest`; the final `answer` is `{verdict: "parts", parts}`). `{ store: <secretFieldId>, values }` on a form that asks for more than the key stores it and keeps the question open (`state: "open"`) | secrets written here (0600). A MiniMax key field (`validate: custom`, or a name containing minimax with no validate) is checked on the picked endpoint (`endpoints`, else the stored one; a bad custom URL is a 400 before any file is written) and, once it verifies, that endpoint is saved in company.json `providers.minimax`. Then inbox.js answer() / answerParts() / recordStored(); every row is recorded in the provenance log before it is written (lib/pm-inbox-guard.js), and readers trust an answer row only from the console or the owner's own tools |
| POST | /api/questions/:id/snooze | `{ until: ISO }` (within 30 days): hidden from Today until then; `inbox.js list` shows the asker "snoozed until …" | inbox.js snooze() |
| GET | /api/questions/answered?since=ISO | answered today | inbox.js state |
| GET | /api/owner/messages | `{ messages, channel }`: the owner channel both ways, newest last; every owner message carries `state` (below), `channel` = `{ ok, problems: [{code, msg, fix, link}], ceo, nextCheckMin, working, tickMin, loop }` | owner-inbox.js, console/chat.js |
| POST | /api/owner/messages | `{ text, to? }` owner writes to the company (appends company/owner/inbound.jsonl, recorded in the provenance log first so readers trust it: lib/owner-channel.js; `to` = a crew name prefixes the text so owner-addressing routes it); answers the row with its `state` | owner-inbox |
| GET | /api/crew | `{ seats:[{id, ...seat, station?, hire?, firstRun?}], station:'up'\|'down' }`: loops.json seats merged with the station roster (`/api/roster`, 2.5 s timeout); a hired seat carries `hire {round, at, pickedBy}` and `firstRun {runId, at, outcome}` (its first run since the hire, from runs.jsonl; null while still to come) | loops.json, station, hiring/, runs.jsonl |
| GET | /api/handoffs | open handoffs by deadline | `handoff-status.js --due --json` |
| GET | /api/handoffs/parked | `{items:[{seat, name, inbox, heading, kind: waiting\|notBefore\|status, words, until}], running:[{id, job, why, since, wakes}], completions:[{id, job, words, failed, at, wakes}]}`: the parked items in plain words and the watched jobs (Work › Handoffs) | company/state/parked.json (dispatch.js), lib/completions.js |
| POST | /api/handoffs/start-now | `{inbox, heading}`: the owner's Start now; the gate is removed on the next tick and the holder woken at once | lib/gates.js release → company/state/gate-releases.jsonl |
| GET | /api/decisions | last 100 lines of company/work/decisions.md as `{ entries:[{text}] }` | file |
| GET | /api/dispatch | last tick, recent log lines | work/dispatch-state.json, dispatch-log.md |
| GET | /api/hiring | rounds under company/hiring/*/round.json + templates in company/roles/templates; each round carries `stage {key, label, at, waitingOn, counts, timeline[{step, at}]}` from hire.js roundStage. Keys: `needs-files`, `candidates`, `interviewing` (label "interviewing 2/3"), `interviews-failed`, `waiting-pick` ("waiting for pick by X"), `picked`, `waiting-owner`, `declined`, `hired`, `closed` | files |
| GET | /api/usage | pacer status | `pacer.js status --json` (or `report`) |
| GET | /api/spend | the Spend screen, read-only: `{ today: {usd, ownerPaidUsd, capUsd, perSeatCapUsd, inFlightRuns}, bySeat: [{id, name, usd, candidate, round?}] (an interview candidate not in the crew has `candidate: true` and its name from its round), byProvider: [{id, usd, capped}], subscriptions: [{id, name, usedPct, weekStop, line, resetsAt, open, paceBy, why}], pacer: {mode, live, emergency, boost, rail, problems}, known, error }` over the last 24 h | `cap-numerator.js compute()` (the cap's own numerator, with `byProvider`), dispatch-budget.json, `pacer.js limits --json` |

## Settings (Autonomy and guardrails, Tempo and routines, Console pages)

| Method | Path | Body | Backed by |
|---|---|---|---|
| GET | /api/governance | — | `governance.js show --json` |
| POST | /api/governance/preset | `{ preset }` | `governance.js preset <id> --by <owner>` |
| POST | /api/governance/set | `{ category, level }` (level auto, notify, triage or approve) | `governance.js set …` |
| GET | /api/decision-models | — | `decide.js list --json` → `{ ok, models: [{id, title, versions, active, mode, params, cases, evaluations, lastAt, valid}] }` (Settings › Autonomy and guardrails) |
| GET | /api/onboarding | — | `onboard.js --check --json` → `{ ok, provisioned, certified, certifiedAt, lastCertify, steps: [{id, what, status, at, note}], checks: [{id, what, status: ok\|failed\|unchecked, missing}], missing: [..], gates }` (Settings › System › Certification; Today banner while not certified). `GET /api/today` carries `onboarding: {certified, failed}` |
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
| POST | /api/cadence/default | `{ minutes?, cooldown?, maxPerTick? }` | `cadence.js set-default --by <owner>`: the owner's base values |
| POST | /api/cadence/bounds | `{ tickMin?: [lo,hi], cooldownMin?: [lo,hi], maxWakesPerHour?, maxWakesPerDay?, quietHours?: "HH:MM-HH:MM"\|null, mode?: "fixed"\|"bounded-auto", autoExpireMin?, minChangeIntervalMin? }` | `cadence.js bounds --by <owner>` (docs/TEMPO.md) |
| POST | /api/cadence/end-temporary | — | `cadence.js end-temporary`: back to the base values now |
| GET | /api/cadence/sprint | — | `cadence.js sprint status --json`: Sprint (start-up) on/off, until when, wakes, idle-wake ratio, items done, spend vs budget, proposals/h vs reviews/h |
| POST | /api/cadence/sprint | `{ on: true\|false, hours?, budgetUsd? }` | `cadence.js sprint on\|off --by <owner>` (docs/TEMPO.md "Sprint") |
| POST | /api/cadence/seat | `{ seat, loopEvery?, cooldown?, priority?, wakeOnInbox?, wakeOnOwner? }` | `cadence.js set` then `apply`; returns `{ set, apply }` (apply may refuse at the `schedules` approve level) |
| GET | /api/panels | panels with placement and state | `console-panel.js list --json` |
| GET | /api/panels/:id/data | resolved data for a panel | console-panel.js `render()` (required as a module) |
| GET | /api/panels/:id/view | the panel's custom view.html (served for a sandboxed iframe srcdoc) | file |
| POST | /api/panels/:id/hide \| unhide \| approve \| reject \| remove | — | console-panel.js |
| GET | /api/preview/:id[?dir=company/work/...] | render() of an installed/proposed panel or page, or of a working folder named :id under company/work/; `{ valid, findings }` when it does not validate | console-panel.js `render()` |
| GET | /preview/:id[?dir=...&theme=dark] | the preview page (console/ui/preview.html) that draws it like its company screen; owner token (cookie or header), actions never sent | static |
| GET | /api/governance-log, /api/locked, /api/external | read-only reports | governance-log.jsonl (last 200 rows as `{entries}`), `locked-watch.js status` (no JSON mode: `{ ok, text }`), `external-gate.js list` (JSON) |

## Live chat

Talking to a crew member from the console is a live run on the station (console/chat.js, UI console/ui/js/chat.js).

| Method | Path | Body | Does |
|---|---|---|---|
| GET | /api/chat/:seat | — | `{ agent: {id, name, title}, model, provider, modelFrom, streamId: "console-<seat>", turns: [{role, content, at, runId?, cut?}], problems: [{code, message, fix, link}], inflight: {runId, startedAt, shownText, gap} \| null }`. The model is the seat's loop routine pair, else its roster row, else model-policy.json `candidateDefault`. The turns are the station transcript (`/api/transcript?stream=console-<seat>`), so the conversation reloads when the owner comes back. A reply whose run did not finish (cancelled, stopped, failed: the station's run log, or the console's own record) carries `cut: "<reason>"` and the page says it was cut off. `inflight` is a reply still being written: its own turns are left out of `turns`, and the page re-attaches to it |
| POST | /api/chat/:seat/send | `{ text }` or `{ brief: "charter"\|"charter-change", notes? }` | streams NDJSON `{name, payload}`: first `console.user {text}` (a brief is expanded server side: the charter brief asks a few short questions, then has the seat write company/CHARTER.md with every template heading and no placeholder, and end with `[Review it in Setup](console:#/setup/charter)`), then `console.run {model, provider, from}`, then `console.attached {runId}`, then the run's journal from its first line: the opening lines again, the station run's own events (`agent.run.start`, `agent.token` `{delta}`, `agent.tool_call` `{name, argsSummary}`, `agent.tool_result`, `permission.prompt`, `agent.run.error`, `agent.run.end` `{reason, outcome, usd}`), `console.gap` when a console restart lost part of the live view, and last `console.final {text, complete, reason, gap}` (the reply as the transcript recorded it; `complete` only when the run ended on its own and nothing was lost) and `console.end`. A refusal before the run exists is one `console.error {code, message, fix, link}` line, never silence: `halted` (hard halt), `station-down`, `no-model`, `budget-hold` (a metered model with a $0 daily cap while the spendCap guardrail is on), `station-refused` (the station's own 4xx, e.g. a missing key), `cut-off` |
| GET | /api/chat/:seat/attach?runId=&from=N | — | the same journal lines from line N (0 = the first after `console.attached`), then live, ending `console.final` + `console.end`; `console.gone` for a run the console does not know. The page re-attaches with the count it already has after a dropped stream (a console restart), and from 0 after a reload |
| GET | /api/console/busy | — | `{ chats: [runIds in flight] }`: what `scripts/restart-console.sh --when-idle` waits on |

The run goes to the station's `POST /api/run` with `rosterSystem: true`, `isTask: true` (the station puts the seat's tools
on the wire only for a task run: with `isTask:false` the model gets NO tool definitions, and a model told about its tools
writes the calls out as text), `streamId: console-<seat>`, the last 40 turns, `projectRoot` = the company root and
`placed` = files, terminal, memory and web, so the seat can do what the owner asks (write the charter). The company folder
is blessed as a project first (`founder-loop.js blessRoot`, idempotent).

**The run outlives the connection (console/chat-runs.js).** When the station lists the capability `run-detach`
(`GET /api/version`, StarNet patch 0014) the run is started with `detach: true`: the station keeps it running when the
console's request closes. The console follows it on the observer feed (`GET /api/observe`) and appends each event to
`company/state/chat-runs/<runId>.ndjson` (rows in `company/state/chat-runs.json`). After a console restart it reopens the
feed from the last cursor it journaled, so what the station's replay ring still holds (512 events) comes back in order;
past that the run is marked gap and the page waits for `console.final`. A run that goes quiet is checked against the
station's run record (`GET /api/runs?runId=`). Without `run-detach` the console reads the `/api/run` stream itself: a
browser reload still re-attaches, a console restart ends the run and the reply is marked cut off.
Stop = `POST /api/station/cancel {runId}`; the browser leaving (a reload, a closed tab) never stops a run.
Approvals the run asks for are answered with `POST /api/station/consent {runId, promptId, decision}`.

**Tool calls written as text.** A reply that holds tool-call markup (`<run_command>`, `<invoke name=`, `<parameter name=`,
`<tool_call>`, two or more `<function=…>`, a fenced JSON call; console/ui/js/leaked-tools.js) is not rendered as
markdown: the page shows "<name> wrote N commands as text instead of running them", an Ask again button, the prose as
plain text and the raw reply under Details.

### Chat actions and approvals

`docs/CHAT-ACTIONS.md`. A reply to an ```actions block is an ordinary `send` whose text ends in `[actionReply {...}]`.

| Method | Path | Body | Does |
|---|---|---|---|
| POST | /api/chat-actions/secret | `{ name, value, replace? }` | writes `secrets/<name>` (0600; 409 if it exists without replace); returns `{ stored, name, chars }`, never the value |
| GET | /api/service-keys | | Settings › Connections and keys › Service keys (console/service-keys.js): `{ keys: [{ name, label, kind: key\|address, set, changedAt, usedBy, files, where, url }], services }`: every file in `secrets/` but the station and console tokens and the README, plus keys a company script or module reads (`co.secret('<name>')`) that are not there yet; never a value |
| GET | /api/connectors | | Settings › Connections and keys › Sign-ins (console/connectors.js, docs/CONNECTORS.md): `{ connectors: [{ id, label, style, state: connected\|expired\|not-connected, connectedAt, artefacts: [{path, exists, mode}], storage: company\|home, crewEnv, isolation, crewCanRead, promise, knownIssues, signingIn }], errors }`; never a credential |
| GET | /api/connectors/:id | | one connector's status, verified now |
| POST | /api/connectors/:id/connect | `{}` | runs the connector's login on the station (409 while one runs); returns `{ session }` |
| GET | /api/connectors/:id/session | | `{ session: { phase: starting\|sign-in\|finishing\|verifying\|connected\|failed\|timed-out\|cancelled, url, code, needs: loopback\|enter-code-there\|paste-code, sameMachine, port, error, knownIssue, endsAt, output (redacted) } }`; `url` and `code` only while signing in, to the owner only |
| POST | /api/connectors/:id/callback | `{ address }` | loopback fallback: the address the owner's browser landed on; refused unless http, 127.0.0.1/localhost/[::1], the expected port and path and the same state; then its path and query are replayed to 127.0.0.1:port on the station |
| POST | /api/connectors/:id/code | `{ code }` | paste-code: written to the CLI's stdin |
| POST | /api/connectors/:id/cancel | | stops the sign-in (the CLI's whole process group) |
| POST | /api/connectors/:id/disconnect | `{ confirm: true }` | runs its logout, removes the credential files, records the owner's change, tells the CEO (400 without confirm) |
| POST | /api/service-keys | `{ service? \| name, value, replace? }` | writes `secrets/<name>` through the same writer as Today's key field (validated name, 0600, atomic; 409 if it exists without replace; the framework's files and any path refused with 400; an address must be a web address), records the write with provenance.js as the owner's (writer `console`, which locked-watch.js accepts for `secrets/*`), and leaves the CEO an OPEN handoff "The owner saved <label> (secrets/<name>)"; returns `{ name, label, kind, stored, chars, replaced, told }`, never the value. Open questions mark each secret field whose file exists `saved: { at }` (Today: "Already saved — replace?") |
| GET | /api/approvals | — | the pending approval records (approvals.js list), after the server-side expiry and reminder tick |
| GET | /api/approvals/:id | — | one record: `{ status, category, fixed, params, actionDigest, expiresAt, default, authority, chatAnswerable, suppressed, answer }`; 404 when there is none |
| POST | /api/approvals/:id/answer | `{ verdict: yes\|no, shownDigest }` | the approval API answer from chat (CAS). The surface is always `chat` (a body `surface` is ignored), so a fixed gate is refused here (409 route): it is answered on Today (`POST /api/questions/:id/answer`, surface `needs-you`). 409 closed / stale / route / held, 403 authority, 404 missing |

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
| GET | /api/now | `{ station: {up, feed}, runs: [{runId, agentId, name, kind: routine\|chat\|…, label, href, step ("reading company/CHARTER.md", "running hire.js open…"), steps, elapsedSec, usd, stoppable, watched}], seats: [{id, name, running, loop, enabled, nextRunAt, schedule, soonerBecause: ["2 open handoffs", "1 unread message from you"], wakesOnMessage, schedulerOn, sprint?: "working"\|"waiting for work", lanes?: {running, max, possible, why}}], sprint: null \| {on, since, until, untilWhy, by, floorMin, wakes, idleWakes, idleWakeRatio, itemsDone, spentUsd, budgetUsd, usdPerItem, proposalsPerHour, reviewsPerHour} }` (sprint and the seat fields only while Sprint is on) |
| GET | /api/now/run/:runId?after=N | the run's events after `N` (`start`, `tool {text}`, `result {ok}`, `token {delta}`, `error`, `end`) for the Watch view, `done`, `outcome`, `usd` |
| GET | /api/activity | recent activity (48 h), newest first: finished runs from runs.jsonl (outcome, cost, the first sentence of the reply with any tool-call markup cut out; output that was only a command says what ran in plain words, e.g. "Restarted a service.", with the command in `detail`), hiring-round log lines with the hiring governance level, one `kind:'hiring-stage'` item per open round with its live stage and timeline times ("Crew decides: done without asking you"), owner-channel replies and decisions, each with `links: [{label, href}]` into the console |

Today shows "Now" (each run with Watch and Stop, then each idle seat's next run and why it would wake sooner),
"Recent activity", and while the post-certification kickoff handoff is open, "Founder is drafting the first plan…".

## Setup

The guided Setup screen (`#/setup`, console/ui/js/screens/setup.js; server side console/setup.js). It is the landing
page until `onboard.js --certify` is green (`GET /api/company` carries `onboarding: {certified, ...}`), then Today is;
after that `#/setup` redirects to Settings, where the same steps live on (company, charter, certify in Settings › Company and charter; provider and budget in Settings › Models and subscriptions). Seven steps, each `{ id, title, status: done|needs|optional, why }`, computed from the files and
the station on every call. Onboarding questions (from `onboard.js` or about `onboarding`) never render as
Approve/Decline on Today: Today shows "Finish setup — N of 7 done" and Setup lists any onboarding ask its steps do not
cover, with a reply box. Every write acts as the owner; locked files are recorded with provenance.js and each change
gets one line in company/work/decisions.md.

| Method | Path | Body | Does |
|---|---|---|---|
| GET | /api/setup | — | `{ certified, done, total: 7, steps, company, station: {up, error, url, claude}, providers: [{id, name, how: signin\|key, unmetered, ready, present, isDefault, metered, keyUrl, endpoint?}], candidateDefault, budget, governance, charter: {placeholders, mandate, forWhom, outOfScope, firstGoal}, guardrails, checks, lastCertify, onboardingQuestions }`. MiniMax (`custom`) only: `endpoint: {region: global\|cn\|custom, label, plain, baseUrl, keyUrl, usageUrl, warnings, problem, stored, choices}` from company.json `providers.minimax` (nothing stored = Global); its `keyUrl`/`baseUrl` follow it |
| POST | /api/setup/company | `{ name?, ownerName?, timezone? }` | writes company/company.json; timezone must be a valid IANA zone (400 otherwise). Later owner writes use the new name |
| POST | /api/setup/provider/validate | `{ provider, key, baseUrl?, region? }` | station `providers/validate` → `{ valid, reachable, error, modelCount, endpoint? }`; the key is never echoed. MiniMax (`custom`): checked against `region` (+ `baseUrl`, `other` for custom), else the stored endpoint |
| POST | /api/setup/provider/detect | `{ provider: custom, key? }` | "Find my endpoint": tries the key (or, with none, the key on file) on Global then Mainland China through station `providers/validate`, stops at the first that verifies → `{ found: global\|cn\|null, why: found\|bad-key\|network\|mixed, tried: [{region, label, valid, reachable, error}], text }` (plain words). Saves nothing; never echoes or logs the key |
| GET | /api/setup/minimax-endpoint | — | `{ endpoint }`: the stored MiniMax endpoint (as in `providers[].endpoint`); Today's MiniMax key questions read it |
| POST | /api/setup/provider | `{ provider: claude-cli\|custom\|deepseek\|openrouter\|anthropic, key?, baseUrl?, region?, other?, model?, subscription?, keepDefault? }` (`keepDefault: true`: only set or replace the key, Settings › Connections and keys; who new hires run on is unchanged) | key providers: station `providers/validate`, then `providers/connect` (a headless station answers `no-page`: then `providers/engine-key`). claude-cli: requires the station's `auth/claude-cli/status` signed in. MiniMax: `region` global\|cn\|custom (custom: `baseUrl` https only, a MiniMax host unless `other: true`; 400 otherwise) picks the endpoint whose `/v1` base URL the station gets; once the key verifies there it is saved in company.json `providers.minimax` (one decisions.md line). A changed region with no key re-checks the key on file (secrets/minimax-key, else the station's store) on the new endpoint first and changes nothing if it is refused. Then sets model-policy.json `candidateDefault` (adds the provider to `allowed` if new), marks `custom` (MiniMax plan) subscription-billed when `subscription` is not false, and, once a candidate can actually run, answers the onboard.js candidate-default question and records the `candidate-default` step ok. Station down: 502 |
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

## Seat models (console/models.js)

Per-seat model chains (company/tools/models.js; every write runs it as the owner).
- `GET /api/models` → every seat: `{ id, name, hasChain, primary, chain: [{ provider, model, effort, ok, why, connected }],
  now: { model, index, why, roster, routines, running }, history }`, plus `failover`, `providers`, `pacer`, `backstop`.
- `GET /api/models/seat/<id>` → the same for one seat, with up to 50 moves of history.
- `GET /api/models/providers` → the allowed providers, `connected` true/false (null when the station is down).
- `GET /api/models/catalog/<provider>` → that provider's allowed models with the station's `efforts` (404 off the list).
- `POST /api/models/seat/<id>/primary` `{ provider, model, effort? }` → the new primary, the rest of the chain behind it.
- `POST /api/models/seat/<id>/chain` `{ chain: [{ provider, model, effort? }, …] }` (1–8) → the whole ordered chain.
  A changed primary (or a current model that left the chain) is applied at once to the roster and the routines.

## Station proxy

`/api/station/<path>` → `<station url>/api/<path>` with the station token added. GET is passed through. POST is passed
through only for an allowlist the owner UI needs (403 otherwise): `run`, `run/steer`, `run/stream`, `cancel`, `groups` (send, create, control incl.
delete), `cron/run`, `cron/update`, `cron/arm`, `loops/control`, `consent`, `consent/answer`, `permissions/*`, `autonomy/*`,
`connectors/*`, `servicekeys/*`, `skills/toggle`, `providers/*`, `halt`, `halt/resume`, `transcript/redact`, `session`,
`auth/claude-cli/start`, `auth/claude-cli/poll`, `auth/claude-cli/code`, `auth/claude-cli/cancel`.
Streaming responses (`run/stream`, SSE) are piped through unchanged. Station down or no `secrets/station-token`: 502
`{ ok:false, error }`. Paths with `..`, `.` or empty segments: 400.

## Typed owner questions

A question is a form its asker composed (`company/tools/inbox.js ask --form`, or a `--kind` shortcut: approve, choice,
text, secret, link, account, number, date). `form.fields[]` is `{id, type, label, help?, required?, ...}` with type
`info` (text), `text` (multiline, minLength, maxLength, placeholder), `secret` (name, provider, validate, multiline,
hinted), `choice` (options [{id,label,recommended}], multi, allowOther), `link` (url, action; value `done`/`couldnt`),
`number` (unit, min, max), `date` (min, max), `checkbox`. `form.actions[]` is `{id, label, verdict, primary?, needs}`;
verdict is yes, no, submit, done, couldnt or declined. Today renders each field and action, plus Reply (a long-form
textarea), Snooze (an hour, tomorrow 09:00, next week) and Discuss (`#/chat/agent:<askerSeat>?draft=` with the message
quoted). The `message` (2-4 plain sentences) shows first; `details` sits collapsed under "More detail"; a row without a
message shows its first two sentences. Question text is rendered with js/md.js (safe markdown, links open with
rel=noopener).

**Secrets.** A secret field's value is only ever in the POST body. The server writes `secrets/<name>` with mode 0600
(409 `{detail:{code:"exists"}}` unless `replace` is ticked), a PEM key whose line breaks were lost is reflowed, the
station checks it when the field names `validate` (POST station `providers/validate`), and the answer records only
`{stored: "secrets/<name>", chars, validated}`, in words "stored at secrets/<name> (N chars, validated: yes/no)". The
value never reaches pm-inbox.jsonl, the owner channel, a response body, SSE or a log. A reply, note or text field that
looks like a key (a private key block, a known key shape, or the value of a stored secret) is refused with a pointer to
the secure field. An old question whose text asks for a key gets `secretHint: {name}`: an optional secret field `key`
and a "Store the key securely" action (the owner may change the file name: `secretNames`).

**Delivery.** `inbox.js answer` writes `{type:"answer", a: <plain words>, answer: {verdict, action, values, note}}` and
an owner message (`company/owner/inbound.jsonl`, `re` the question id, opening with the asker's name), so the
dispatcher's owner-message wake brings the answer to the asker. `lib/governance approved()` reads `answer.verdict`
(yes/no, or a single choice of yes/no) and falls back to the text.
