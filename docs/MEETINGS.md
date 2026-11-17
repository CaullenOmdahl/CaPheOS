# Meetings: the crew at one table (Chat › Meeting)

The crew group in the console has two modes. **Group chat** is the station's group: an unaddressed message goes to
the lead, `@name` to that person, a handoff is queued. **Meeting** (`#/chat/meeting`, `console/meeting.js`) seats
people at one table: a message goes to everyone seated, in turn, the leader first, each seeing everything said before
them. A seat with nothing to add passes, and passes are not shown. The meeting carries on (the last one resumes) until
**New meeting**, which keeps the seats.

## The controls

| Control | What it does | API (POST unless noted) |
|---|---|---|
| Composer | your message to everyone; start it with `@name` (autocompleted) for those seats only, `@all` for everyone | `/api/meeting/say {text}` |
| Round | an open round: they answer each other, no new message from you | `/api/meeting/round` |
| Raise hand / Esc | the floor is yours after the current speaker; a message typed during a round does the same | `/api/meeting/hand` |
| Continue | (when you have the floor) let them carry on | `/api/meeting/continue` |
| Stop round | stops now: the turn in flight is cancelled | `/api/meeting/stop` |
| Observe (− N +) / Take part | you get no turn; they are told not to ask you anything and carry on by themselves for up to N rounds (default 6, 1-30) until the leader writes `END:` or a round passes with nothing said | `/api/meeting/observe {on, rounds}` |
| Agenda | items, the one under discussion now, and **tools per item**: talk only is the default (no tools on any run); switch tools on for the item that needs checking | `/api/meeting/agenda {op: add\|tools\|current\|done\|remove}` |
| Close meeting | ends it with or without an END; records `closed` and who closed it | `/api/meeting/close {why?}` |
| Resume | carries on an `interrupted` meeting | `/api/meeting/resume {id?}` |
| ♛ / No leader | the leader (kept across meetings; default the CEO seat) speaks first, runs the meeting, records rulings, cannot be dismissed | `/api/meeting/lead {seat\|null}` |
| × / + Add | the standing seats: anyone on the crew; a new seat sees the meeting so far | `/api/meeting/seats {add, remove}` |
| New meeting (type) | a fresh meeting, same seats and leader: decision, incident, planning or review (the type picks the prompt block and the pacing default, not the protocol). One at a time: close the current one first; an incident meeting may interrupt an open one, which resumes when the incident meeting closes | `/api/meeting/new {type, title?}` |
| Open minutes | the day's minutes | GET `/api/meeting/minutes?date=` |

## Pacing, built for a reader

- **Pace** (`/api/meeting/pace {speed}`): Next (you advance; the default while you are present), instant, fast,
  normal, slow. You count as present while the tab is visible and was used in the last 2 minutes (the page says so
  every 20 s: `/api/meeting/presence`); when you are away the meeting advances by itself at the meeting type's speed
  (incident fast, decision and planning normal, review slow). **Next** (`/api/meeting/next`) lets the next person speak.
- **Pause** (`/api/meeting/hold {on}`): the current turn finishes and is shown; nothing new starts, so nothing is spent,
  until Carry on.
- The page shows **completed turns**, not words as they stream; nothing scrolls or jumps by itself (a pill counts
  what is new below), and the meeting opens where you left off ("You left off here").
- **Your turn**: an `ASK:` of you or the leader's `CALL:` of you gives you the floor after the current speaker; the
  page says so (a toast, the tab title, a browser notice when the tab is hidden), whatever the pace.
- **Catch me up** (`/api/meeting/catchup {since}`): one talk-only turn by the leader for you only: five bullets,
  what was decided, what is still asked. The seats never see it.
- Reading modes: Everything, By speaker (each reply collapsed), Skim (decisions, asks, hands, rulings, closes); the
  **Timeline** (`GET /api/meeting/timeline`) jumps to a moment.

`GET /api/meeting` is the state (seats in speaking order with each one's model, the roster, the speaking-now / next up /
hands line, the cost so far); `GET /api/meeting/entries?limit=&before=|from=` pages the messages (backscroll, the timeline). Live updates arrive as the `meeting` topic on
`/api/events`.

## The agents' lines

An agent ends a reply with lines of their own; the page shows them as chips, not text. A line that starts like one but
cannot be read (no colon, an ASK with no question, an unknown name) is shown as **COULD NOT READ** and the writer is
told on their next turn; it is never silently taken as plain text.

- `ASK: <name> — <question>`: that seat answers next and may ask back; at most 6 direct questions a round; asking
  someone not seated calls them in. After each answer the others are asked in parallel, talk only, whether to come in
  (`HAND — <point>` or `NO`); at most 3 hands a round. With a leader, the leader answers `CALL` (now), `LATER` (after
  the exchange) or `LOWER`; with no leader a raised hand speaks next.
- `CALL: <name>` (the leader): that seat has the floor next.
- `INVITE: <name> — <why>`: joins at once and speaks after the others that round; at most 3 a round.
- `DISMISS: <name> — <why>`: leaves this meeting (an agent may dismiss itself; the leader cannot be dismissed).
- `END: <summary>` (the leader; anyone with no leader) closes the discussion; `RULING: <decision>` records one.
  Both go to `company/work/decisions.md` through `decision.js add`.

What agents change lasts for that meeting; your add and remove set the standing seats and override it. The house rules
(v13) carry a short meeting-etiquette line, and every turn carries the meeting's own preamble.

## Runs, safety, records

- Each turn is a station run (`POST /api/run`, `isTask` false by default; true with the tools placed only for an
  agenda item with tools on; always false for the hand and leader checks) on the seat's current model: the entry of its model-policy chain that `models.js` has
  applied (its loop routine's pair, else its roster row; `console/chat.js modelFor`). A metered model under a $0 cap is
  held, as in the chat. A refused turn is retried once on the seat's next chain entry with one plain line
  (`lib/refusal.js`, door `meeting`).
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
  re-fire; MEETING HOLD in the log). A seat already in the middle of a routine run sits its turn out with one plain line,
  so the meeting never stalls on it. The meeting is the owner's:
  every route is behind the console sign-in, and a console inside an agent's run refuses it (`lib/owner.js`).
- The chat's owner-scope lint (`console/command-ask.js`) runs on every reply: crew work or a command put to the owner is
  flagged under the reply and the agent is told on its next turn; while you observe, any question to you is.
- Minutes: `company/work/meetings/meeting-<date>.md`, every word by speaker with the time and the model, written as it
  happens. State: `company/state/meetings/` (mode 600, folders 700): `seats.json`, `current.json`, `m/<id>.json` (one
  per meeting), `events/<id>.jsonl` (each meeting's events, read from the end, rolled by `retention.js`, artifact
  `meeting-events`).

Tests: `company/tools/tests/meeting.test.js` (the protocol, with a scripted runner), `tests/meeting-walk.js` (the real
console and the mock station), `tests/meeting-ui-walk.js` (headless Chrome).
