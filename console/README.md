# console: the owner console

- `server.js`: the API and static server (see `docs/CONSOLE-API.md`).
- `ui/`: the web UI. It has no build step: `index.html`, `app.css`, and `app.js` (shell, sidebar, hash router), plus
  `js/` (`api.js` fetch wrapper, `events.js` SSE with a 15 s poll fallback, `ui.js` DOM helpers and design-system
  stand-ins, `panels.js` company panels, and `screens/*.js` with one module per screen). Tokens and fonts are in `ui/ds/`.
- `design/*.dc.html`: the approved designs that the screens reproduce.

## UI conventions

- Routes (the full map agents link to is `docs/CONSOLE-LINKS.md`) are `#/today`, `#/setup[/<step>]`, `#/comms[/owner|<id>|agent:<id>|group:<id>]`, `#/crew[/<id>]`, `#/work/<tab>`, `#/hiring`,
  `#/controls/<gov|guard|ticks|panels>`, `#/automate`, `#/governance`, `#/usage`, `#/floor`, `#/abilities/<tab>`,
  `#/system`, `#/map`, `#/halt[?mode=soft|hard]` and `#/p/<panel id>` (company screens).
- Agent-written text is rendered by `js/md.js` (safe markdown, `console:#/…` links stay in the app). A crew member's
  conversation is a live chat (`js/chat.js`); Today's Now strip and the Crew pulse come from `/api/now` (console/activity.js).
- Every fetch shows an inline error line when it fails. A failing `/api/station/*` call shows "Station not running".
- Where no endpoint exists yet, the screen keeps the designed layout and says "Not connected yet." It never shows
  invented data.
- Company panels follow `docs/CONSOLE-PANELS.md`. A `custom` view runs in an `<iframe sandbox="allow-scripts" srcdoc>`
  that has the CSP and the `--cap-*` tokens prepended.

## Developing against the mock

```bash
node console/ui/dev/mock-api.js 8931                       # http://127.0.0.1:8931, fixture API plus a fake station
MOCK_STATION_DOWN=1 node console/ui/dev/mock-api.js 8932   # the same, with /api/station/* answering 502
```

The mock keeps its state in memory. Answers, halts and governance changes stick until the mock restarts. About 8 s
after the first SSE client connects, a new owner question arrives, which tests the "Just now" highlight. The mock never
contacts a real station.
