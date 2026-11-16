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
| `console:#/setup/charter` | the charter (also `/company`, `/provider`, `/budget`, `/governance`, `/guardrails`, `/certify`) |
| `console:#/comms/owner` | the owner channel |
| `console:#/comms/<seat id>` | a live chat with that crew member (`console:#/comms/agent` is the Founder) |
| `console:#/crew/<seat id>` | a seat's dossier |
| `console:#/work/quests` · `/handoffs` · `/decisions` · `/deliverables` · `/projects` | Work |
| `console:#/hiring` | hiring rounds |
| `console:#/controls/gov` · `/guard` · `/ticks` · `/panels` | Controls: self-governance, guardrails, cadence, panels |
| `console:#/automate` | routines and the dispatcher |
| `console:#/usage` | AI usage and models |
| `console:#/halt` | stop the company |

Full map: `docs/CONSOLE-LINKS.md`.

## Rules

1. Link the place where the owner acts, not a file path.
2. One or two links per message; the link text says what they will do there.
3. After writing or changing the charter, end with `[Review it in Setup](console:#/setup/charter)`.
