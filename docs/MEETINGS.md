# Meetings: the crew at one table (Chat › Meeting)

The crew group in the console has two modes. **Group chat** is the station's group: an unaddressed message goes to
the lead, `@name` to that person, a handoff is queued. **Meeting** (`#/chat/meeting`, `console/meeting.js`) seats
people at one table: a message goes to everyone seated, in turn, the leader first, each seeing everything said before
them. It works the way the owner's terminal table did (`~/.local/lib/cpd/table.js`): turns flow one after another
with nothing to press, each one streams as it is written, people check facts with their tools, and a seat with nothing
to add passes, shown as one dim line. The meeting carries on (the last one resumes) until **New meeting**, which keeps
the seats.

## Seats

Anyone on the crew (`company/tools/loops.json`) can be seated. Each turn uses the seat's model at that moment, never a
snapshot from the meeting's start: the entry of its own model-policy chain that `models.js` and the pacer have put on its
loop routine, else its roster row, else the company default (a seat with no chain of its own, or no HR scope, gets
its roster model). A seat with no usable model, or one held by a $0 cap on a metered model, sits the turn out with one
plain line. The leader persists across meetings (default: the CEO seat); seats the owner adds or removes are the
standing seats, an agent's INVITE or DISMISS lasts for that meeting only.

## The controls

In view while they talk: the seat strip, **Round**, **Raise hand / Continue**, **Stop**, **Observe (− N +) / Take
part** and **More**. Everything else is in the **More** panel (it stays open across live updates).

| Control | What it does | API (POST unless noted) |
|---|---|---|
| Composer | your message to everyone; start it with `@name` (autocompleted) for those seats only, `@all` for everyone | `/api/meeting/say {text}` |
| Round | an open round: they answer each other, no new message from you | `/api/meeting/round` |
| Raise hand / Esc | the floor is yours after the current speaker; a message typed during a round does the same, and starts a new round on your words | `/api/meeting/hand` |
| Esc again / Stop | stops now: the turn in flight is cancelled (the table's second Ctrl-C) | `/api/meeting/stop` |
| Continue | (when you have the floor) let them carry on | `/api/meeting/continue` |
| Observe (− N +) / Take part | you get no turn; they are told not to ask you anything and carry on by themselves for up to N rounds (default 6, 1-30) until the leader writes `END:` or a round passes with nothing said | `/api/meeting/observe {on, rounds}` |
| More › Tools: on / off | tools are on by default, as at the table; off is **talk only** for the whole meeting (no tools on any turn) | `/api/meeting/talkonly {on}` |
| More › Pause / Carry on | the current turn finishes and is shown; nothing new starts, so nothing is spent | `/api/meeting/hold {on}` |
| More › Agenda | items, the one under discussion now, and tools per item (an item follows the meeting's switch until you set it) | `/api/meeting/agenda {op: add\|tools\|current\|done\|remove}` |
| More › Pace | Flowing (the default, as at the table), fast, normal, slow (a reading pause between turns), or Next (you advance) | `/api/meeting/pace {speed}` |
| More › Catch me up | one talk-only turn by the leader for you only: five bullets, what was decided, what is still asked | `/api/meeting/catchup {since}` |
| More › Register, Open minutes | the action register; the day's minutes (with search) | GET `/api/meeting/register`, `/api/meeting/minutes?date=` |
| More › New meeting (type), Close meeting | a fresh meeting, same seats and leader (decision, incident, planning or review: the type adds one sentence to each turn, not the protocol; one at a time, an incident meeting may interrupt an open one); Close ends it with or without an END | `/api/meeting/new {type, title?}`, `/api/meeting/close {why?}` |
| Resume | carries on an `interrupted` meeting | `/api/meeting/resume {id?}` |
| ♛ / No leader | the leader (kept across meetings; default the CEO seat) speaks first, runs the meeting, proposes rulings, cannot be dismissed | `/api/meeting/lead {seat\|null}` |
| × / + Add | the standing seats: anyone on the crew; a new seat sees the meeting so far. Hovering the strip lists who is seated, in order, on what model (the table's `/who`) | `/api/meeting/seats {add, remove}` |

## What the page shows (as at the table)

- **The turn in flight streams** under the speaker's name (`GET /api/meeting/attach?runId=&from=N`, NDJSON: the run's
  journal from line N, then live; `console.gone` for a run this meeting did not start). Text is held back while it
  could still turn out to be PASS, at the start and after each tool step. A reload or a console restart re-attaches.
- **One colour per person**: their avatar, their name and their turns (from the seat id, on the chart palette).
- **Dim lines between turns, in order**: "(Phil passes)", "(Nadia answers Dave)", "(hands? Sharon, Phil…)" while the
  hand check runs, "(Sharon raises a hand: …)", "(Rachel calls on Nadia)", "(Omar joins, invited by Dave: why)",
  "(Dave asks Sharon: …)", "(Dave proposes a ruling for you to confirm: …)", "(Dave closes the discussion: …)".
- **Tool steps** as "· Sharon: reading CHARTER.md" lines, in plain words. Each turn's steps are kept on its entry
  (`tools`), so they stay after the turn; they are not in the minutes, which keep every word said.
- Nothing scrolls by itself unless you are already at the latest; a pill counts what is new below, and the meeting
  opens where you left off ("You left off here").
- **Your turn**: an `ASK:` of you or the leader's `CALL:` of you gives you the floor after the current speaker; the page
  says so (a toast, the tab title, a browser notice when the tab is hidden).
- Reading modes: Everything, By speaker (each reply collapsed), Skim (decisions, asks, hands, rulings, closes); the
  **Timeline** (`GET /api/meeting/timeline`) jumps to a moment. **Explain for the room** on a reply is one cheap
  talk-only turn of that speaker, in plain words (`/api/meeting/explain {i}`).

## Pace

Turns flow (`instant`) by default: no Next to press, no reading pause, as at the table. A `seats.json` still on the old
default (`manual`) is moved to `instant` once (`speedMigrated`); a pace you pick after that is kept. With **Next**
picked, each turn waits for Next while you are present (the page says so every 20 s: `/api/meeting/presence`); when you
are away it advances at the meeting type's speed (incident fast, decision and planning normal, review slow).

## What each seat is sent

The table's rules (`[THE TABLE]`), short: speak as yourself, from your own area, a few sentences unless the owner asks
for more; answer what was put to you; agree, disagree or build on others **by name**; do not repeat; exactly `PASS`
with nothing to add; check the facts you state but do no long work in the meeting (write it where your own loop picks it
up); the owner is not technical (crew matters are settled or routed, never put to the owner); the leader's role; the
lines below; observe rules; invite only when needed. Then the seat's own point of view, when the console has one
(`deps.seatVoice(seat)`, for the per-seat profiles), then who they are. Each turn ends with the table's turn note:
whose turn and why, who leads, hands up, who is at the table and who is not (may be invited), talk only when it is, the
company's language. **Seat frames** (each other seat's function and what it needs, from `loops.json` functions and
`company/defaults/work/meetings/frames.json`) are off by default; `/api/meeting/frames {on}` switches them on. A seat
in the middle of a routine run still speaks, talk only for that turn, told so ("you have no tools this turn: say what
you know"), with one dim line in the minutes.

The glossary and term check stay: `company/work/meetings/glossary.md` (`- **TERM**: what it means`), a deterministic
check (no model) of short capitalised terms used without a definition (`GET /api/meeting/terms`), run when the meeting
closes; Register › Terms defines one (`/api/meeting/glossary`).

`GET /api/meeting` is the state (seats in speaking order with each one's model, the roster, the speaking-now / next up /
hands line with the turn's runId, the cost so far); `GET /api/meeting/entries?limit=&before=|from=` pages the messages,
passes included. Live updates arrive as the `meeting` topic on `/api/events`.

## The agents' lines

An agent ends a reply with lines of their own; the page shows them as dim lines, not text. A line that starts like one
but cannot be read (no colon, an ASK with no question, an unknown name) is shown as a "could not read" line and the
writer is told on their next turn; it is never silently taken as plain text.

- `ASK: <name> — <question>`: that seat answers next and may ask back; at most 6 direct questions a round; asking
  someone not seated calls them in. After each answer the others are asked in parallel, talk only, whether to come in
  (`HAND — <point>` or `NO`); at most 3 hands a round. With a leader, the leader answers `CALL` (now), `LATER` (after
  the exchange) or `LOWER`; with no leader a raised hand speaks next.
- `CALL: <name>` (the leader): that seat has the floor next.
- `INVITE: <name> — <why>`: joins at once and speaks after the others that round; at most 3 a round.
- `DISMISS: <name> — <why>`: leaves this meeting (an agent may dismiss itself; the leader cannot be dismissed).
- `END: <summary>` (the leader; anyone with no leader) closes the discussion; it is the register's summary.
  `RULING: <decision>` (the leader) proposes an owner ruling.
- `ACTION: <what> — by <date>`, `QUESTION: <it>`, `KILL: <it>`: the speaker's own line in the register.
- `— plain: <one sentence anyone can read>` (and `— affects: <who>` on an ACTION) is welcome on any of these, not
  required: a line without it is kept as written, and the writer is told once on its next turn (a note the page does
  not show).

## The action register

The meeting's output (`company/tools/lib/meeting-register.js`): owner rulings, actions (each with an owner, a date, a
status, a plain-language line and "affects"), open questions, kill conditions and "Not recorded here", rendered to
`company/work/meetings/<date>-<id>-register.md` in the shape of the table registers. No model writes a row for anyone:
a row is its owner's line from the meeting, or the owner's own (Register › Add your ruling, Not recorded here). Each
owner updates only their own lines, and only through the register (`node company/tools/meeting-register.js update <id>
actions <n> --by <name> --status "…"`, or the console for the owner): the markdown file is rendered from it, so a hand
edit there is overwritten; an action without owner, date or status fails validation and is shown so (a row a seat wrote
at the table without a plain line does not: `plainOptional`). **Only an owner ruling the owner confirms goes to `decisions.md`** (`decision.js add`, by the owner); the rest stays
in the register. API: `GET /api/meeting/register`, `POST /api/meeting/register {op: ruling|confirm|not-recorded|question|kill|update}`.

Searchable: `company/state/meetings/index.json` (one row per meeting: id, type, agenda, participants, decisions,
actions, links to quests `q:N` and handoffs `to-<name>.md`), `GET /api/meeting/search?q=` (Open minutes › Search).

What agents change lasts for that meeting; your add and remove set the standing seats and override it. The house rules
carry a short meeting-etiquette line, and every turn carries the table's rules.

## Runs, safety, records

- Each turn is a station run (`POST /api/run`, `isTask` true with the tools placed by default; false under Talk only,
  for an agenda item set to talk only, and for a seat mid-routine; always false for the hand and leader checks) on
  the seat's current model: the entry of its model-policy chain that `models.js` has
  applied (its loop routine's pair, else its roster row; `console/chat.js modelFor`). A metered model under a $0 cap is
  held, as in the chat. A refused turn is retried once on the seat's next chain entry with one plain line
  (`lib/refusal.js`, door `meeting`).
- **Cost is information, never a gate**: no meeting budget, no estimate, no per-turn dollar check. The cost line says
  "This meeting so far: N turns" and, per provider, dollars for a metered model (DeepSeek, OpenRouter), the share of a
  subscription's windows since the meeting began (Claude 5-hour and week, MiniMax; from the pacer's readings and
  `company/work/finance/subscriptions.json`), never "$0.00", and "unknown" for anything unmetered with no meter.
- Every run passes `lib/admit.js` as kind `meeting-turn` (door `meeting`, `company/state/admit-log.jsonl`): a zero-token
  permission and routing check, refused unless the owner opened the meeting, held under a hard halt or a refusal
  block. There is no meeting budget, estimate or per-turn dollar gate: cost is information.
- Meeting states: `open`, `interrupted`, `closed`.
- Runs are tracked by `console/chat-runs.js` (detached, followed on the observer feed), and the meeting saves its queue
  after every step, so a console restart re-attaches to the turn in flight and carries on; `GET /api/console/busy`
  lists it (`scripts/restart-console.sh --when-idle`).
- **Halts.** A soft halt lets the turn in progress finish, writes the minutes and marks the meeting `interrupted`; a
  hard halt aborts the turn and marks it `interrupted` too. Resume it once the halt is lifted; no round starts under a
  halt. The halt lists the meeting as live work (`lib/meetings.js liveWork`), and Today and the floor show it in progress.
- **Approvals inside a turn.** A station permission prompt in a turn becomes an owner question on Today › Needs you
  (`inbox.js ask`, kind approve) and **pauses** the meeting; your answer goes back to the station as the consent, then it
  carries on.
- **The dispatcher.** While a round runs, the seated seats are neither idle nor wakable (`dispatch.js`: no wake, lane or
  re-fire; MEETING HOLD in the log). A seat already in the middle of a routine run speaks talk only, so its turn makes no
  change in the company folder and cannot clash with the routine's hold on it; if a routine takes the folder mid-turn,
  the station answers the write with `workspace-busy` and the meeting adds one dim line ("Nadia's routine is using the
  company folder; Nadia answers without changing files"). The meeting is the owner's:
  every route is behind the console sign-in, and a console inside an agent's run refuses it (`lib/owner.js`).
- The chat's owner-scope lint (`console/command-ask.js`) runs on every reply: crew work or a command put to the owner is
  flagged under the reply and the agent is told on its next turn; while you observe, any question to you is.
- Minutes: `company/work/meetings/meeting-<date>.md`, every word by speaker with the time and the model, written as it
  happens (rendered from the structured events: `events/<id>.jsonl`). State: `company/state/meetings/` (mode 600, folders 700): `seats.json`, `current.json`, `m/<id>.json` (one
  per meeting), `events/<id>.jsonl` (each meeting's events, read from the end, rolled by `retention.js`, artifact
  `meeting-events`).

Tests: `company/tools/tests/meeting.test.js` (the protocol, with a scripted runner), `tests/meeting-walk.js` (the real
console and the mock station), `tests/meeting-ui-walk.js` (headless Chrome).

## One engine, other rooms

`console/meeting.js` is a factory; the same engine runs a colleague brought into a live chat. Options: `stateDir`,
`topic` (the live-update topic), `streamPrefix`, `minutesPrefix`, `routePrefix`, `door` (admit), and a `profile`:
`noun` ("chat"), `preface(owner)`, `fixedLeader` (the host: cannot be changed or removed), `standing` (the host only),
`wrapHost` (after a round the host started by bringing someone in, the host closes the loop if something new was said;
`'always'` for every round), `maxGuests`, `maxInvites`, `maxTurnsPerRound` ("The chat paused after N replies; write to
carry on."), `noRegister`. `pullIn({by, seed, text|directives})` records the recent conversation (`src: 'chat'`) and
runs the seat's ASK / INVITE lines as a round.

