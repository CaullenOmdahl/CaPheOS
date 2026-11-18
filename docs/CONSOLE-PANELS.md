# Console panels: how the crew shapes the owner console

The owner console has fixed screens (Today, Chat, Crew with Hiring and Floor, Work, Spend, and Settings). Every company is different, so the crew may add **panels** that fit the company's
work: a trading firm puts positions and P&L on Today, a law firm puts matters by deadline there, a library shows its
loans due. A whole company screen can be a **page** of units (§12): a trading desk, a NOC health board, a production
kanban, a calendar. A panel or page is a small declaration, not code that runs in the console. It is checked by a tool, gated by
governance, recorded, and can always be hidden by the owner.

This guide is the contract. The console must honour it; `company/tools/console-panel.js` enforces the parts that can be
checked before install. Shape: `company/schemas/console-panel.schema.json`. Allowlists and limits:
`company/console/sources.json`. Agent skill: `company/skills/console-panels/SKILL.md`. Design rules for agents (tokens,
tones, spans, charts, copy): `docs/CONSOLE-DESIGN.md`.

## 1. What a panel is

A folder:

```
company/console/panels/<id>/
  panel.json      required: what it shows, from where, where, who owns it, why
  view.html       only for view kind `custom`
  README.md       optional notes for the next maintainer
```

Nothing else is installed. `<id>` is lowercase kebab-case, 2 to 40 characters, equal to the folder name, and not one of
the console's reserved ids (`needs-you`, `halt`, `governance`, `system`, the screen names; see `sources.json`).

Panels are never edited in place. A seat writes the panel in a working folder (for example
`company/work/<seat>/panels/<id>/`), validates it, and runs `add`; the tool copies it in.

## 2. panel.json

```json
{
  "version": 1,
  "id": "matters-by-deadline",
  "title": "Matters by deadline",
  "owner": "ceo",
  "why": "The owner opens the console to see which client matters are due this week; the docket file already has it.",
  "placement": { "area": "today", "order": 2 },
  "refresh": 300,
  "sources": { "docket": { "type": "file", "glob": "company/work/docket/matters.json", "select": "open" } },
  "view": {
    "kind": "table", "source": "docket",
    "columns": [ { "key": "due", "label": "Due", "format": "date", "flag": "late" },
                 { "key": "client", "label": "Client" }, { "key": "matter", "label": "Matter", "width": "wide" } ],
    "sort": { "key": "due", "dir": "asc" }, "limit": 12, "empty": "Nothing due."
  },
  "actions": [ { "id": "ask", "label": "Ask about this matter", "kind": "handoff", "to": "ceo", "scope": "row",
                 "text": "Owner asks about {{row.client}} / {{row.matter}}, due {{row.due}}: where does it stand?" } ]
}
```

| Field | Rule |
|---|---|
| `owner` | The accountable seat: a function (`ceo`, `people`, `tools`, `risk`, `floor`, `finance`) or a seat id/name from `loops.json`. Prefer a function; it survives a re-hire. The owner seat keeps the panel's data honest and answers for it. |
| `why` | 20 to 400 characters: why the owner would look at this often. The console shows it on the panel's info popover. |
| `refresh` | Seconds, 30 to 86400, default 300. The console never refreshes faster than 30 s, whatever the file says. |
| `description` | Optional, shown under the title in the panel list. |

## 3. Placements

| `placement` | Where | Limit |
|---|---|---|
| `{ "area": "today" }` | the Today screen, below Needs you and the halt controls | 6 company panels |
| `{ "area": "side", "screen": "<screen>" }` | a screen's side column: `today`, `comms`, `crew`, `work`, `hiring`, `automate`, `usage`, `floor`, `abilities` | 3 per screen |
| `{ "area": "screen", "nav": "<label>" }` | its own screen, listed under a **Company** nav group | 8 company screens |

`order` (1 to 99) orders company panels within one placement only. Built-in content always comes first. Limits count
installed panels, hidden ones included (remove a panel to free its slot). A company screen's `nav` label may not reuse
a built-in label (`Today`, `Chat`, `Spend`, `Settings`, ...) or another company screen's label.

## 4. View kinds

The console draws every kind except `custom` itself, with its own components and styles. Dot paths (`a.b.0.c`) pick
values out of the source data; `length` on an array counts it.

| `kind` | Fields | Draws |
|---|---|---|
| `stat` | `source`, `value`, `label`, `format?`, `unit?`, `goodWhen?` (`up`/`down`/`zero`/`nonzero`) | one number |
| `stat-row` | `items`: 2 to 6 stats | a row of numbers |
| `table` | `source`, `rows?`, `columns` (1 to 12: `key`, `label`, `format?`, `width?`, `flag?`), `sort?`, `limit?` (max 200), `empty?` | a table; `flag` names a boolean key that gives the cell the warn tone |
| `list` | `source`, `items?`, `title`, `subtitle?`, `badge?`, `limit?`, `empty?` | a list |
| `timeline` | `source`, `items?`, `at`, `text`, `who?`, `limit?`, `empty?` | events by time, newest first |
| `chart` | `source`, `chart` (`line`/`bar`/`area`/`stacked-bar`/`candlestick`/`scatter`), `rows?`, `x` (`key`, `label?`, `format?`, `time?`), `series` (1 to 6, explicit `key` + `label`; candlestick takes `ohlc: {open, high, low, close}` instead), `y?` (`label`, `zero`, `format`), `refs?` (up to 4 reference lines: `label` + `value` or `from` a dot path, `tone`), `legend?`, `height?`, `empty?` | an SVG chart in the series palette with a time axis in the company timezone, legend, hover tooltip, an `aria-label` summary and a "Show as a table" view; no guessing series from the data |
| `kanban` | `source`, `rows?`, `column` (field), `columns?` (`id`, `label`, `limit?`; default: distinct values in data order), `title`, `subtitle?`, `badges?`, `assignee?`, `due?`, `steps?` (`done`, `total`), `tone?` + `toneMap?`, `key?`, `move?` (an action id with scope `move`), `limit?`, `empty?` | cards in columns; overdue and WIP-over-limit in the warn tone; Move opens the named action (§7), never a write |
| `calendar` | `source`, `rows?`, `start`, `end?`, `title`, `allDay?`, `tone?` + `toneMap?`, `view?` and `views?` (`month`/`week`/`agenda`), `limit?`, `empty?` | month, week and agenda views in the company timezone |
| `status-grid` | `source`, `rows?`, `name`, `state` (+ `stateMap` to `ok`/`warn`/`bad`/`unknown`), `checked?`, `history?` (array of states or numbers), `historyN?` (3 to 60), `group?`, `detail?`, `limit?`, `empty?` | health tiles, worst first, grouped, with a sparkline of the last N checks and a summary line |
| `positions` | `source`, `rows?`, `symbol`, `side?`, `size`, `entry`, `mark`, `pnl?` (else computed), `format?` (default money), `totals?`, `sort?`, `limit?`, `empty?` | a positions table: unrealised P&L signed and coloured by sign, gross and P&L totals |
| `gauge` / `progress` | `source`, `items` (1 to 6 / 8): `label`, `value`, `max` (a number or a dot path), `source?`, `format?`, `unit?`, `warnAt?` (0.8), `badAt?` (1), `goodWhen?` (`low`: a limit; `high`: a target) | arc gauges / bars against a limit or target, with the state in words |
| `pipeline` | `source`, `rows?`, either `by` (count items per stage, `stages?` for order, `stuck?` a flag) or `label` + `count` (+ `stuck?`) when rows are stages, `empty?` | steps with counts and stuck flags |
| `feed` | `source`, `rows?`, `at`, `title`, `text?`, `severity?` (+ `severityMap?`), `origin?`, `acked?`, `ack?` (a row action id), `limit?`, `empty?` | alerts newest first; Acknowledge opens the named row action |
| `markdown` | `source` (a `.md` file source) | sanitised markdown: no raw HTML, no images from URLs, links shown as text |
| `custom` | `html: "view.html"`, `height?` (120 to 1200), `sources?` (subset to pass in) | the panel's own sandboxed view (section 6) |

Every built-in kind has a loading state, an empty state (`empty`, or a plain default) and an error state (the source
that failed and why). The console's Page kit gallery (`#/kit`, linked from System) draws every kind with sample data.

Formats: `text`, `number`, `integer`, `percent`, `money` (in `company.json` currency), `date`, `datetime`, `relative`,
`duration`, `bool`. Dates are shown in the company timezone.

## 5. Data sources: allowlist only

A panel has 1 to 4 named sources. Each is one of three types, and each type is closed by `company/console/sources.json`.
A panel can never name a command, a URL or an arbitrary path.

**`file`**: `{ "type": "file", "glob": "...", "pick?": "single|latest|all", "select?": "dot.path" }`
- The glob is relative to the project root and must start with `company/work/` or `company/state/`.
- Extensions: `.json`, `.jsonl` (an array of lines), `.csv` (an array of objects, header row, numbers parsed), `.md`
  (text, for `markdown` views).
- Refused: `..`, `.` or empty segments, absolute paths, `~`, backslashes, any `secrets` segment, dotfiles, `[]{}!`
  patterns, and the deny globs in `sources.json` (`*token*`, `*secret*`, `*.key`, `*credential*`, ...).
- Symlinks are never followed, and every resolved path must still be inside the project root.
- `pick`: `single` (the default) fails if more than one file matches; `latest` takes the newest by mtime; `all` gives
  `[{file, data}]` (at most 50 files). Each file is at most 2 MB; arrays are cut to 500 rows (`truncated: true`).

**`tool`**: `{ "type": "tool", "id": "<allowlist id>", "select?": "..." }`
- Runs `node company/tools/<argv>` exactly as listed under `tool` in `sources.json`: no shell, no extra arguments, a
  timeout, `CAPHEOS_READONLY=1` in the environment. Output must be JSON.
- Shipped ids: `handoffs-due` (`handoff-status.js --due --json`), `owner-messages-new`, `owner-questions`,
  `ask-owners`, `routing` (`routing.js status --json`, docs/ROUTING.md). A company adds one by proposing a `sources.json` change through `harness-change.js` (category `tools`,
  owned by the tools function, reviewed by risk). Only read-only commands that print JSON may be listed.

**`station`**: `{ "type": "station", "id": "<allowlist id>", "select?": "..." }`
- A `GET` of a station path listed under `station` in `sources.json` (`health`, `roster`, `usage-providers`, `cron`),
  called by the console backend with the station token. The browser never holds the token.
- Offline (`render` without `--live`) a station source is reported as not resolved, not as a failure.

## 6. Custom views: the sandbox

A `custom` view is the escape hatch for a picture the built-in kinds cannot draw (an order book, a floor of desks, a
matter's procedural tree). It is untrusted content, and the console treats it as such.

**The console must:**
- load `view.html` as `<iframe sandbox="allow-scripts" srcdoc="...">`, never `allow-same-origin`, `allow-forms`,
  `allow-popups`, `allow-top-navigation` or `allow-modals`; serve it from no URL of its own;
- prepend a CSP meta tag: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;
  font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'`;
- prepend a `<style>` defining the tokens in `sources.json` `styleTokens` (`--cap-bg`, `--cap-surface`, `--cap-text`,
  `--cap-muted`, `--cap-accent`, `--cap-good`, `--cap-warn`, `--cap-bad`, `--cap-font`, `--cap-mono`, sizes, radius,
  spacing) for the current light/dark theme, and resend them when the theme changes;
- size the frame to `height` (clamped 120 to 1200), honour `capheos:panel-resize` inside the same clamp;
- accept from the frame only messages whose `event.source` is that frame.

**Messages**

| Direction | Message |
|---|---|
| console → view | `{ type: "capheos:panel-data", version: 1, id, at, data: { <source>: <data or null> }, sources: { <source>: {ok, error?, truncated?} } }`: exactly what `console-panel.js render <id> --json` prints |
| view → console | `{ type: "capheos:panel-ready" }`: send data now |
| view → console | `{ type: "capheos:panel-resize", height }` |
| view → console | `{ type: "capheos:panel-action", action: "<declared action id>", row?: {...} }`: the console looks the id up in `panel.json`, fills the template, shows it to the owner, and opens the door only on confirm. An undeclared id is ignored and logged. |

**`console-panel.js validate` refuses a view.html that** has a URL (`http(s)://` or protocol-relative), an external
script, `<link>`, a nested frame, form, `<base>`, `<object>`/`<embed>`, `<meta http-equiv>`, `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, workers, beacons, module imports, `eval`/`new Function`, `javascript:`,
reaches `window.top`/`opener`/`parent.location`, touches cookies or storage, or never listens for `message`. In
`<style>`, `style=""` and `.style.x = '...'` it refuses colour literals and functions (`#hex`, `rgb()`, `hsl()`, ...),
named colours, `url()`, `@import`, `@font-face`, a `font-family` that is not a token, `position: fixed`, and any
`var(--x)` that is not a listed token or the view's own `--local-*`. Size limit 256 KB. The lint is a first fence;
the sandbox and CSP are the wall.

`company/console/examples/trading-positions/` is the worked example.

## 7. Actions: existing doors only

A panel may offer up to 4 actions. Each opens one of three doors the company already has; none writes company data,
moves money, or leaves the company. The owner always confirms the filled-in text before anything happens.

| `kind` | Door | Fields |
|---|---|---|
| `handoff` | a handoff block (HANDOFFS.md format, `**Status:** OPEN`, from the owner via the console) appended to the inbox of the seat holding `to` | `to` (a function or seat) |
| `ask-ceo` | an owner message in `company/owner/inbound.jsonl`, which the CEO reads and acknowledges (`owner-inbox.js`) | |
| `owner-question-draft` | the owner's Chat composer (owner channel), prefilled; nothing is sent until the owner presses send | |

`text` is a template of at most 600 characters. Placeholders: `{{panel.title}}` and, with `"scope": "row"`,
`{{row.<key>}}`. A kanban `move` names an action with `"scope": "move"`, which may also use `{{move.from}}` and
`{{move.to}}` (the column labels): moving a card asks the owning seat to move it; the console never writes the board's
file. A feed's `ack` names a row action the same way. The console HTML-escapes values and cuts the result to 2000 characters. Anything that follows from
the message (a trade, a payment, a filing, an email) still goes through the seat's own work, the external gate
(`external-gate.js`) and the owner gates; a panel never short-circuits them.

## 8. The "within reason" limits

1. A panel cannot hide, cover, reorder or restyle **Needs you**, the **halt controls** or **Settings**.
   Needs you and halt always render above company panels; Settings takes no panels at all (a side panel declared for an old screen shows on its new home: `usage` on Spend, `hiring` and `floor` on Crew, `automate` and `abilities` in Settings).
2. A panel cannot restyle the console. Built-in kinds use console styles; custom views get tokens only, inside their
   own frame. panel.json has no style fields.
3. At most 6 company panels on Today, 3 per side column, 8 company screens; at most 4 sources and 4 actions per panel;
   refresh no faster than 30 s.
4. Data only from the allowlists; never `secrets/`, never outside `company/work` and `company/state`.
5. Actions only through the three doors; never a direct write, never money, never anything external.
6. Every panel names its owner seat and its why.
7. The owner can hide any panel (`console-panel.js hide <id> --by owner`, or the panel menu in the console). A hidden
   panel stays hidden when it is re-added or changed; only the owner unhides it.

## 9. Governance, provenance, review

`add` reads `co.gate('dashboard')` (`company/state/governance.json`):

| Gate | `add` does |
|---|---|
| `auto` | installs into `company/console/panels/<id>/` |
| `notify` | installs and tells the owner the same day (`owner-inbox.js send`) |
| `approve` | copies into `company/console/proposed/<id>/` and files an owner question (`inbox.js ask`) with recommendation and default (not installed); the owner runs `approve <id> --by owner` or `reject <id> --by owner` |

The owner adding a panel themselves is never gated. Changing an installed panel is the same `add`, allowed to the
panel's owner seat, the tools or CEO seat, or the owner. `remove` is allowed to the same people and tells the owner
unless the gate is `auto`.

Every change is a line in `company/console/changes.jsonl`:
`{at, op: add|change|propose|approve|reject|remove|hide|unhide, id, by, gate, from, digest}` where `digest` is a
sha256 prefix of panel.json + view.html. The console's panel menu shows the latest line for a panel ("added by ...
on ..., why ..."). The tools owner reviews new and changed panels from this log as part of harness review; risk
reviews any `sources.json` change.

## 10. Commands

```bash
node company/tools/console-panel.js list [--json]                 # installed + proposed, hidden flag, validity
node company/tools/console-panel.js validate <id|dir|panel.json>  # findings as file:field: message, exit 1 if any
node company/tools/console-panel.js add <dir> --by <seat>
node company/tools/console-panel.js approve|reject <id> --by owner
node company/tools/console-panel.js remove <id> --by <seat>
node company/tools/console-panel.js hide|unhide <id> --by owner
node company/tools/console-panel.js render <id> --json [--live]   # the data the console passes in
node company/tools/console-panel.js scaffolds                     # the ready pages (§12)
node company/tools/console-panel.js scaffold <name> --as <id> --by <seat> [--nav <label>] [--force]
node company/tools/console-panel.js render --page <id|dir> --png <out.png> [--theme dark] [--width 390] [--height N] | --serve
node company/tools/console-panel.js tokens [--write]              # docs/CONSOLE-DESIGN.md token table in sync with the CSS
node company/tools/console-panel.js selftest
```

`render` is exported (`require('company/tools/console-panel.js').render(id, { live })`); the console backend calls it
for every panel refresh, so what an agent checks offline is what the owner sees. It only reads.

## 11. What the console must honour (checklist)

- Render company panels only from `company/console/panels/`, never from `proposed/` or `examples/`; skip any panel
  that does not validate and show it in System as broken, with its findings.
- Re-run `validatePanel` at load: files can change on disk without `add`.
- Read `company/console/state.json` `hidden` and never show a hidden panel; give the owner a hide control on every
  panel and an unhide list in System.
- Needs you and halt first on Today; nothing in Settings.
- Enforce the per-placement limit at render too (first by `order`, then id) in case files were copied by hand.
- Data comes only from `render()`; the browser never reads files, runs tools or calls the station for a panel.
- Refresh no faster than `max(refresh, 30)` seconds, and pause while the tab is hidden.
- Custom views: section 6 exactly.
- Actions: only declared ids, only the three doors, owner confirms the filled text.
- Show `why`, `owner` and the latest `changes.jsonl` line in each panel's info popover.

## 12. Pages: a company screen made of units

A page is a folder `company/console/pages/<id>/` holding `page.json` (and an optional `README.md`): a company screen
laid out as a responsive grid of **units**, each one built-in view kind from §4 (not `custom`) with a span. It is
governed exactly like a panel: same validation, `add` through the `dashboard` gate, `approve`/`reject`, `remove`,
owner-only `hide`, `owner`, `why`, `changes.jsonl` (with `type: "page"`), and it counts toward the 8 company screens.
Panel and page ids share one namespace. Shape: `$defs.page` in `company/schemas/console-panel.schema.json`.

```json
{
  "version": 1, "kind": "page", "id": "desk", "title": "Trading desk", "owner": "finance",
  "why": "The owner checks positions, P&L and the distance to each risk limit many times a day.",
  "placement": { "area": "screen", "nav": "Desk", "order": 1 }, "refresh": 60,
  "sources": { "book": { "type": "file", "glob": "company/work/desk/positions.json" } },
  "units": [
    { "id": "headline", "span": 12, "view": { "kind": "stat-row", "items": [ ... ] } },
    { "id": "positions", "title": "Open positions", "span": 8, "rows": 2, "actions": ["ask"],
      "view": { "kind": "positions", "source": "book", "rows": "positions", "symbol": "symbol", "size": "qty", "entry": "entry", "mark": "mark" } },
    { "id": "limits", "title": "Exposure against limits", "span": 4, "view": { "kind": "gauge", "source": "book", "items": [ ... ] } }
  ],
  "actions": [ { "id": "ask", "label": "Ask about this", "kind": "handoff", "to": "finance", "scope": "row", "text": "..." } ]
}
```

| Field | Rule |
|---|---|
| `placement` | `{ "area": "screen", "nav", "order?" }` only: a page is a company screen |
| `sources` | 1 to 8 (`limits.page.maxSources`), the same three allowlisted types as a panel |
| `units` | 1 to 12: `id` (unique), `view` (a §4 kind other than `custom`), `title?`, `note?`, `span?` (1 to 12, default 12), `rows?` (1 to 4 height hint), `actions?` (row action ids offered in that unit) |
| `actions` | up to 6. Panel-wide ones show in the page header; row ones in the units that list them; `move`/`ack` ones in the kanban/feed that names them |

The grid is 12 columns; below about 760 px of content width short units go half width and long ones full width; on
a phone every unit is full width, and wide content scrolls inside its unit, never the page.

**Scaffolds** (`company/console/scaffolds/<name>/`: page.json, README.md, sample/) are ready pages to copy and
customise: `trading-desk`, `noc-health`, `production-board`, `calendar`, `client-portfolio`, and the framework's own `duties` (docs/DUTIES.md) and `model-ranking` (docs/RANKING.md). `scaffold <name> --as <id>
--by <seat>` writes the page into `company/work/<seat>/pages/<id>/` and its sample data (times made current, in the
company timezone) into `company/work/<seat>/page-data/<id>/`, with the source globs pointing there; then the normal
validate, preview, add path.

**Preview** before `add`: `render --page <dir> --png out.png [--theme dark] [--width 390]` draws the page with the
console's own code on a private port and screenshots it with headless Chrome (`--serve` prints a URL instead). The
console serves the same at `/preview/<id>` (owner token; `?dir=company/work/...` for a working folder, `?theme=dark`).
A preview never sends an action.

The console must also honour, for pages: render only from `company/console/pages/`; re-validate at load; never show a
hidden page; draw each unit with its loading, empty and error state, so one broken source never blanks the page.
