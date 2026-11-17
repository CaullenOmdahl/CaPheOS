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
