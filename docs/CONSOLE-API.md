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
  `governance`, `guardrails`, `cadence`, `panels`, `dispatch` (dispatch-log.md), `crew` (loops.json)). The UI refetches
  the matching endpoint. Poll fallback: every 15 s.

## Company

| Method | Path | Does | Backed by |
|---|---|---|---|
| GET | /api/company | company.json (name, owner, timezone, station, ownerChannel) | lib/company.js |
| GET | /api/today | `{ company, needsYou, crew, usage, overnight, halt, panels: [ids placed on today] }` in one call | below |
| GET | /api/questions | open owner questions `[{id, from, about, q, blocking, askedAt, batch, gate?}]` | inbox.js openQuestions() + lib/governance pendingGates() |
| POST | /api/questions/:id/answer | `{ verdict: "yes"\|"no"\|"reply", text? }` records the owner's answer | inbox.js answer (CLI) |
| GET | /api/questions/answered?since=ISO | answered today | inbox.js state |
| GET | /api/owner/messages | owner channel both ways, newest last | owner-inbox.js messages()/sent() |
| POST | /api/owner/messages | `{ text, to? }` owner writes to the company (appends company/owner/inbound.jsonl; `to` = a crew name prefixes the text so owner-addressing routes it) | owner-inbox |
| GET | /api/crew | `{ seats:[{id, ...seat, station?}], station:'up'\|'down' }`: loops.json seats merged with the station roster (`/api/roster`, 2.5 s timeout) | loops.json, station |
| GET | /api/handoffs | open handoffs by deadline | `handoff-status.js --due --json` |
| GET | /api/decisions | last 100 lines of company/work/decisions.md as `{ entries:[{text}] }` | file |
| GET | /api/dispatch | last tick, recent log lines | work/dispatch-state.json, dispatch-log.md |
| GET | /api/hiring | rounds under company/hiring/*/round.json + templates in company/roles/templates | files |
| GET | /api/usage | pacer status | `pacer.js status --json` (or `report`) |

## Controls

| Method | Path | Body | Backed by |
|---|---|---|---|
| GET | /api/governance | — | `governance.js show --json` |
| POST | /api/governance/preset | `{ preset }` | `governance.js preset <id> --by <owner>` |
| POST | /api/governance/set | `{ category, level }` (level auto, notify, triage or approve) | `governance.js set …` |
| GET | /api/decision-models | — | `decide.js list --json` → `{ ok, models: [{id, title, versions, active, mode, params, cases, evaluations, lastAt, valid}] }` (Controls › Self-governance; **not wired in console/server.js yet**: one `runApi('decide.js', ['list', '--json'])` route) |
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

## Station proxy

`/api/station/<path>` → `<station url>/api/<path>` with the station token added. GET is passed through. POST is passed
through only for an allowlist the owner UI needs (403 otherwise): `run`, `run/steer`, `run/stream`, `cancel`, `groups` (send, create, control incl.
delete), `cron/run`, `cron/update`, `cron/arm`, `loops/control`, `consent/answer`, `permissions/*`, `autonomy/*`,
`connectors/*`, `servicekeys/*`, `skills/toggle`, `providers/*`, `halt`, `halt/resume`, `transcript/redact`, `session`.
Streaming responses (`run/stream`, SSE) are piped through unchanged. Station down or no `secrets/station-token`: 502
`{ ok:false, error }`. Paths with `..`, `.` or empty segments: 400.
