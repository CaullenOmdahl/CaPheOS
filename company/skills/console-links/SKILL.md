---
name: console-links
description: Link the owner to the right place in the owner console from any message, answer, handoff or report, with ordinary markdown links in the console: scheme. Use whenever you tell the owner about something they can see, approve or change in the console.
license: MIT
metadata:
  owner: company
  version: "1.0"
---

# Console links

The owner reads what you write in the owner console. When you point at something they can see or act on, link it
with an ordinary markdown link whose target starts with `console:#/`:

```
[finish the charter in Setup](console:#/setup/charter)
[approve the hire on Today](console:#/today)
```

The console turns these into in-app links. `http(s)` links open in a new tab. Any other scheme is dropped, so never
use `javascript:`, `data:` or `file:` links.

## Where things are

| Link | Place |
|---|---|
| `console:#/today` | Today: who is running now, open questions, recent activity |
| `console:#/setup/charter` | the charter (the Setup wizard before certification, Settings › Company after; also `/company`, `/provider`, `/budget`, `/certify`) |
| `console:#/chat/owner` | the owner channel |
| `console:#/chat/<seat id>` | a live chat with that crew member (`console:#/chat/agent` is the Founder) |
| `console:#/crew/<seat id>` · `/crew/<seat id>/model` | a seat's dossier, its model chain |
| `console:#/crew/hiring` | hiring rounds |
| `console:#/work/quests` · `/handoffs` · `/decisions` · `/projects` | Work |
| `console:#/spend` | today's AI spend and subscription use |
| `console:#/settings/autonomy` · `/autonomy/guardrails` | self-governance, guardrails, owner gates, the external gate |
| `console:#/settings/tempo` · `/tempo/routines` | ticks and cadence, routines |
| `console:#/settings/models` · `/models/cutoffs` | model chains, subscription cutoffs, providers, the pay-per-token cap |
| `console:#/settings/connections/keys` · `console:#/settings/pages` · `console:#/settings/system` | keys and connectors, console pages, health |
| `console:#/halt` | stop the company |

Old links (`#/comms`, `#/controls`, `#/usage`, `#/hiring`, `#/automate`, …) still work: they redirect. Write the new ones.

Full map: `docs/CONSOLE-LINKS.md`.

## Rules

1. Link the place where the owner acts, not a file path.
2. One or two links per message; the link text says what they will do there.
3. After writing or changing the charter, end with `[Review it in Setup](console:#/setup/charter)`.

## Chat actions (buttons, choices and fields inside a chat message)

In a live chat or an owner-channel message you may add controls for a quick choice the owner makes **now, in the
conversation**: write a fenced block whose language is `actions` and whose body is one JSON object.

````
```actions
{"id": "launch-plan", "prompt": "How should we launch?", "items": [
  {"type": "button", "label": "Launch Monday", "value": "monday", "tone": "primary"},
  {"type": "button", "label": "Wait a week", "value": "wait"},
  {"type": "choice", "id": "region", "label": "Region", "options": [{"id": "eu", "label": "Europe"}, {"id": "us", "label": "United States", "recommended": true}]},
  {"type": "slider", "id": "share", "label": "Budget share", "min": 0, "max": 100, "step": 5, "value": 80, "unit": "%"},
  {"type": "link", "label": "See the budget", "href": "console:#/spend"}
]}
```
````

Items: `button` {label, value, tone?: primary|danger} · `choice` {id, label, options} · `text` / `url` {id, label,
placeholder?} · `slider` {id, label, min, max, step?, value?, unit?} · `link` {label, href: `console:#/…` or `https://…`}
· `secret` {id, label, name: the file under secrets/} (alone in its block, links allowed) · `approval` {ref: an
existing approval's question id} (alone in its block, links allowed). At most 12 items; `id` letters, digits, `. _ : -`.
A malformed block shows as plain text with "Couldn't show these buttons", so check the JSON.

What the owner's click does, and nothing else: a button or field sends their next message into the same chat, e.g.

```
Chose: Launch Monday · Region Europe, Budget share 80%
[actionReply {"id":"launch-plan","value":"monday","fields":{"region":"eu","share":80}}]
```

Read the last line: `value` is the button, `fields` the fields, `stored: {name, chars}` a key the console stored at
`secrets/<name>` (read it with `co.secret('<name>')` in a tool; never print it; the key is never in the message). A
link only navigates. A click never runs a command or a tool. The block locks once answered; one older than 24 hours,
or followed by a newer block with the same `id`, shows as expired, so reuse the `id` to replace a stale one.

**When to use it:** quick choices while the owner is in the conversation. **When not:** a decision that needs the
owner's attention later, or that must not be lost, is an owner question on Today (`inbox.js ask`, skill
`owner-questions`). Something that needs owner **approval** is asked with `node company/tools/approvals.js ask`
(governance decides first: at `auto`/`notify` nothing is minted; at `approve` or a fixed gate it becomes a record on
Today › Needs you). A chat block may then show it, `{"type": "approval", "ref": "q-123456"}`, with Approve / Deny when
the record allows it in chat (never a fixed owner gate: access, ownership, commitment, spend beyond the cap; those
link to Needs you). A block never creates an approval: a ref with no record shows as inert text.
Full reference: `docs/CHAT-ACTIONS.md`.
