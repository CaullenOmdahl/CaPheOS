# console: the owner console

- `server.js`: the API and static server (see `docs/CONSOLE-API.md`).
- `ui/`: the web UI. It has no build step: `index.html`, `app.css`, and `app.js` (shell, sidebar, hash router), plus
  `js/` (`api.js` fetch wrapper, `events.js` SSE with a 15 s poll fallback, `ui.js` DOM helpers and design-system
  stand-ins, `panels.js` company panels, `routes.js` the route map and old-route redirects, `screens/*.js` with one module per
  screen and `screens/settings/*.js` with one module per Settings se## UI conventions

"Good UI doesn't need docs." The sidebar is Today · Chat · Crew · Work · Spend, then the Company group (pages the crew
added), then Settings pinned at the bottom; Setup shows only until the company is certified. Halt stays in the sidebar's
station box on every screen (at the top on a phone).

- Routes (the full map agents link to is `docs/CONSOLE-LINKS.md`): `#/today`, `#/setup[/<step>]` (first run only),
  `#/chat[/owner|<id>|agent:<id>|group:<id>]`, `#/crew[/<id>[/model]|/hiring|/floor]`, `#/work/<tab>`, `#/spend`,
  `#/settings/<section>[/<anchor>]` (company, autonomy, tempo, models, connections, pages, system), `#/halt[?mode=soft|hard]`
  and `#/p/<panel id>`. Old routes (`#/comms`, `#/controls`, `#/governance`, `#/automate`, `#/usage`, `#/abilities`,
  `#/system`, `#/hiring`, `#/floor`, `#/setup` once certified, `#/map`) redirect through `js/routes.js`.
- Every setting shows its current value, a sentence on what it does and what changes if you flip it (`ui.js`
  `Setting`). Risky options (no guardrails, hard halt, Autonomous, switching off harness review) say what they unlock
  and ask first.
- No file paths, tool names, API routes or raw errors in the main text: they go behind a "Details" disclosure
  (`ui.js` `Details`), and errors are said in plain words (`ui.js` `humanError`, `errLine`).
  `tests/console-routes-walk.js` checks every screen at desktop and phone width.
- Empty or unsupported sections are hidden, or show one line with a next step. Never invented data.
- Agent-written text is rendered by `js/md.js` (safe markdown, `console:#/…` links stay in the app). A crew member's
  conversation is a live chat (`js/chat.js`); Today's Now strip and the Crew pulse come from `/api/now` (console/activity.js).
- Company panels follow `docs/CONSOLE-PANELS.md`. A `custom` view runs in an `<iframe sandbox="allow-scripts" srcdoc>`
  that has the CSP and the `--cap-*` tokens prepended.

view runs in an `<iframe sandbox="allow-scripts" srcdoc>`
  that has the CSP and the `--cap-*` tokens prepended.

## Developing against the mock

```bash
node console/ui/dev/mock-api.js 8931                       # http://127.0.0.1:8931, fixture API plus a fake station
MOCK_STATION_DOWN=1 node console/ui/dev/mock-api.js 8932   # the same, with /api/station/* answering 502
MOCK_HEADLESS=1 node console/ui/dev/mock-api.js 8933       # a station with no floor plan (no Crew › Floor tab)
```

The mock keeps its state in memory. Answers, halts and governance changes stick until the mock restarts. About 8 s
after the first SSE client connects, a new owner question arrives, which tests the "Just now" highlight. The mock never
contacts a real station.
