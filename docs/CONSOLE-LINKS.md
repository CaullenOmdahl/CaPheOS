# Console links

Agents point the owner at places in the owner console with ordinary markdown links in the `console:` scheme:

```
[finish the charter in Setup](console:#/setup/charter)
[the hiring round](console:#/hiring)
```

The console renders every agent-written text (live chat, owner-channel replies, questions on Today, activity lines,
the charter) as safe markdown (`console/ui/js/md.js`): a `console:#/…` or plain `#/…` link opens that place inside the
console, an `http(s)://` link opens in a new tab with `rel="noopener noreferrer"`, and any other scheme
(`javascript:`, `data:`, `file:` …) is dropped and only its text shown. Nothing an agent writes becomes markup.
The skill `company/skills/console-links/SKILL.md` teaches every agent this map.

## Route map

Stable: these paths keep working; a renamed tab keeps its old name as an alias (`console/ui/app.js` `ALIASES`).

| Link | Place |
|---|---|
| `console:#/today` | Today: Now (who is running), Needs you (open questions), crew, usage, recent activity |
| `console:#/setup` | Setup, the guided first run |
| `console:#/setup/company` · `/provider` · `/budget` · `/governance` · `/charter` · `/guardrails` · `/certify` | one Setup step, opened and scrolled to (aliases: `ai`, `money`, `gov`, `guard`, `checks`) |
| `console:#/comms/owner` | the owner channel (asynchronous messages, each with its state) |
| `console:#/comms/<seat id>` (or `agent:<seat id>`) | a live chat with that crew member, e.g. `console:#/comms/agent` for the Founder |
| `console:#/crew` · `console:#/crew/<seat id>` | the crew, one seat's dossier |
| `console:#/work/quests` · `/handoffs` · `/tasks` · `/deliverables` · `/review` · `/decisions` · `/projects` | Work tabs (singular aliases work) |
| `console:#/hiring` | hiring rounds |
| `console:#/controls/gov` · `/guard` · `/ticks` · `/panels` | Controls tabs (aliases: `governance`, `guardrails`, `cadence`, `tempo`, `sprint`; `/ticks` is the Tempo tab with the Sprint switch) |
| `console:#/automate` | routines and the dispatcher |
| `console:#/governance` | what may leave the company, locked files, decision models |
| `console:#/usage` | AI usage and models |
| `console:#/floor` · `console:#/abilities/<tab>` · `console:#/system` · `console:#/map` | station places |
| `console:#/halt` · `console:#/halt?mode=soft` | stop the company |
| `console:#/p/<panel id>` | a company panel screen |

## Writing links well

- Link the place where the owner acts, not a file path: "[approve the hire](console:#/today)", not "company/pm-inbox.jsonl".
- One or two links per message. The link text says what the owner will do there.
- After writing or changing the charter: "[Review it in Setup](console:#/setup/charter)".
