# Chat actions and approvals in chat

An agent can put controls inside a chat message: buttons, a choice, a short text or URL field, a slider, a link, a key
field, and an existing owner approval. The agent-facing format and when to use it are in
`company/skills/console-links/SKILL.md` ("Chat actions"); this page is the reference.

## Where they work

| Surface | Blocks | A reply goes |
|---|---|---|
| Live chat (`#/chat/<seat>`) | interactive | `POST /api/chat/<seat>/send`, the owner's next message in that chat |
| Owner channel (`#/chat/owner`, outbound messages) | interactive (shares md.js) | `POST /api/owner/messages`, the owner's next owner-channel message |
| Group chats, Today, handoffs, anything else md.js renders | read-only: the prompt, the choices as words, links that work | — |

## The block

A fenced block with language `actions`, one JSON object: `{"id", "prompt"?, "items": [...]}`, validated by
`console/ui/js/actions-schema.js` (the browser, console/chat.js and the tests share it). Unknown keys are dropped;
an unknown item type, a bad id, a secret name the console may not write (`station-token`, `..`) or a block that mixes
a secret or an approval with other answers makes the block invalid, and it renders as its text with "Couldn't show
these buttons (reason)". A link whose scheme is not `console:#/…`, `#/…` or `https://…` keeps only its label (the md.js
rule). The controls are Today's own (`screens/today.js` fieldControl, sliderControl).

## What a click does (and nothing else)

- **Reply buttons and fields**: one message, `Chose: <button> · <field> <value>, …` (or `Set: …`), then the machine
  line `[actionReply {"id","value"?,"fields"?}]`. The chat bubble hides the machine line; console/chat.js also tells the
  agent in its context note that the message answers block `<id>`.
- **Links**: `console:#/…` navigates in the console; `https://…` opens a new tab (`rel="noopener noreferrer"`).
- **Key fields**: `POST /api/chat-actions/secret {name, value, replace?}` writes `secrets/<name>` (0600, never over an
  existing file without replace) with the same writer as Today's key field; the response and the chat message carry
  only `Stored <name> (N chars)` / `{stored: {name, chars}}`.
- **Approvals**: `GET /api/approvals/<id>`, `POST /api/approvals/<id>/answer {verdict, shownDigest, surface: "chat"}`.
- No click runs a command, calls a tool or changes a setting. `tests/chat-actions-walk.js` records every request the
  page makes during each click and fails on anything but these four.

State: an answered block locks and shows the answer; on reload a block with a reply after it (the transcript's
`[actionReply]` with its id) renders locked; a block older than 24 hours (`MAX_AGE_HOURS`) or followed by a newer
block with the same id renders expired.

## Approvals in chat

Approvals are owner-question records in `company/pm-inbox.jsonl` (no other store), managed by
`company/tools/approvals.js`:

- **Minting** (`approvals.js ask`): governance first (`lib/governance.js` level, with triage). `auto` acts and writes a
  decisions.md line; `notify` acts, logs and tells the owner one sentence (no record, not in the badge, never reminded);
  `approve` or a fixed owner gate mints an inbox.js ask with `approval {category, params, actionDigest, expiresAt,
  default: deny, blocking, dependsOn}` and writes "Approval requested" via `company/tools/decision.js add`. Caps per seat
  and per window: `company/defaults/state/approvals-policy.json`; an identical actionDigest returns the pending record.
- **actionDigest**: sha256 over the canonical `{category, from, params}` (sorted keys, NFC strings with collapsed
  whitespace, numbers to 15 significant digits), computed at creation; `amend` replaces it. An answer is refused as
  stale unless its `shownDigest` (what was displayed) equals the current actionDigest.
- **Authority**: a fixed gate, an older record, and any category governance has at `approve`: the **owner only** (an
  `approve` level means the company waits for the owner). A category governance *triages* (at `triage` when minted and
  now): the owner or the CEO. Never the asking seat. `--by owner` (or the owner's name) is the shared owner rule,
  `lib/owner.js`: the owner's own shell or the console process; an agent's run or a detached process is refused, in the
  CLI and in process alike. A crew `--by` must be an exact crew seat and must be verified as the caller; a CLI cannot
  verify that (the transcript check proves only "not in someone else's run", and the transcript lands after the
  command), so crew answers are refused from the CLI.
- **Surface**: set by the route that received the answer, never by a request body: `POST /api/approvals/<id>/answer` is
  `chat`, Today's `POST /api/questions/<id>/answer` is `needs-you`, the CLI is `cli`. A fixed gate is answered only on
  `needs-you` or `cli`; an older record only on `needs-you`. `inbox.js answer`/`close` refuse any approval record
  (exit 5), and the console's plain answer path refuses a reply to one: approvals.answer is the only way in.
- **Answer** (CAS under a lock beside pm-inbox.jsonl): the record must be pending and the answerer must have the
  authority above. The winner writes a journal row, then one answer row `{surface, shownDigest, by}`, then one
  decisions.md line naming the surface, then wakes the asker through the owner-message path (inbox.js deliver: `re`
  the id, opening with its name) and closes the handoff the record names (`--handoff`). Each step is journalled
  (`approval-journal` rows); `tick()` repairs an answered record with no audit line or no wake. The loser is told who
  answered, how and when, and nothing is written.
- **The lock**: a directory with `owner.json {pid, host, token, at}`. Waiting is an async retry, never a blocking sleep
  (the console server's event loop does not stall). A lock whose owner pid is dead, one with no owner file after 2 s,
  or one older than 10 min is taken over by an atomic rename (one taker wins) and re-checked. Ask, amend, answer,
  expiry, reminders and withdraw all take it.
- **Expiry**: no `expiresAt`, no expiry. Past it, the server (the dispatcher's tick, the console's one-minute tick, and
  every approval API call) answers `no` with `surface: expiry` and `appliedBy` (who ran it), writes the audit line
  naming that actor, and tells the asker. The card shows "expires 20:40 · default: deny" from its first render.
- **Reminders**: 15 minutes after a record was created (not first shown), once per record, batched: one
  `approval-reminder` row and one owner-channel line per 15-minute window, a burst minted together as one batch, with the
  pending count; the Today card is highlighted.
- **Dependents and the dispatcher**: a record whose `dependsOn` names a pending blocking record is suppressed (not
  reminded, not answerable) until that one is answered, expires or is withdrawn. dispatch.js reads
  `approvals.blockingSeats()` each tick: the asker's OPEN work that depends on a pending blocking record (the handoff it
  names, items naming its id, or with neither all of the asker's OPEN items) waits on the owner, wakes nobody and counts
  toward no stall; seats waiting on the asker stay waiting. The hold ends with the answer, expiry or withdrawal, and the
  asker is woken (company/tools/tests/approvals-dispatch.test.js).
- **Withdrawal** (`approvals.js withdraw`): inbox.js withdraw (gone from Needs you; the block shows "withdrawn") and a
  decision.js withdraw of the request line, so the audit shows both events.
- **Archive**: the record does not live in the chat; archiving the chat leaves it pending on Needs you.

## Two approval queues, not merged

| | Company approval | Tool permission |
|---|---|---|
| What | may the company do this act (governance) | may this run call this tool now (the seat's approval mode) |
| Where it lives | `company/pm-inbox.jsonl` (approvals.js / inbox.js) | the station: StarNet's consent prompts (`/api/state/snapshot` `prompts`, `POST /api/consent`) and run recoveries |
| Where the owner answers | Today › Needs you, and in chat when allowed | inline in the live chat that raised it; recoveries in the station's own UI (off in headless mode) |
| Label in chat | "Company approval · recorded in decisions" (accent bar) | "Tool permission · station" |
| Counted in the Needs you badge | yes, once per record | never |
| Audit | decisions.md via decision.js | the station's run log |

An act can need both: the approval first (the company may), then, in `ask` mode, each tool call's consent (this run may).
