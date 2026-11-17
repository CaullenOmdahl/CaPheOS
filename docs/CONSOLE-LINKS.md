# Console links

Agents point the owner at places in the owner console with ordinary markdown links in the `console:` scheme:

```
[finish the charter in Setup](console:#/setup/charter)
[the hiring round](console:#/crew/hiring)
```

The console renders every agent-written text (live chat, owner-channel replies, questions on Today, activity lines,
the charter) as safe markdown (`console/ui/js/md.js`): a `console:#/…` or plain `#/…` link opens that place inside the
console, an `http(s)://` link opens in a new tab with `rel="noopener noreferrer"`, and any other scheme
(`javascript:`, `data:`, `file:` …) is dropped and only its text shown. Nothing an agent writes becomes markup.
The skill `company/skills/console-links/SKILL.md` teaches every agent this map.

## Route map

Stable: these paths keep working. A moved screen keeps its old address: `console/ui/js/routes.js` redirects every old
route to its new home (table below), and the safe markdown rewrites an old `console:` link before the owner sees it.

| Link | Place |
|---|---|
| `console:#/today` | Today: Now (who is running), Needs you (open questions), crew, usage, recent activity |
| `console:#/setup` · `/setup/<step>` | the first-run Setup wizard, until the company is certified; afterwards each step's Settings place (below) |
| `console:#/chat/owner` | the owner channel (asynchronous messages, each with its state) |
| `console:#/chat/<seat id>` (or `agent:<seat id>`) | a live chat with that crew member, e.g. `console:#/chat/agent` for the Founder |
| `console:#/crew` · `/crew/<seat id>` · `/crew/<seat id>/model` | the crew, one seat's dossier, its model chain |
| `console:#/crew/hiring` | hiring rounds and seat templates |
| `console:#/crew/floor` | the floor plan (only when the station has one) |
| `console:#/work/quests` · `/handoffs` · `/decisions` · `/projects` | Work tabs (singular aliases work) |
| `console:#/spend` | today's spend against the cap, by seat and provider, subscription use this week (read-only) |
| `console:#/settings/company` · `/company/charter` · `/company/certify` | Settings › Company and charter |
| `console:#/settings/autonomy` · `/presets` · `/guardrails` · `/gates` · `/gate` | Settings › Autonomy and guardrails |
| `console:#/settings/tempo` · `/ticks` · `/seats` · `/routines` | Settings › Tempo and routines |
| `console:#/settings/models` · `/chains` · `/cutoffs` · `/providers` · `/budget` | Settings › Models and subscriptions |
| `console:#/settings/connections` · `/keys` · `/connected` · `/skills` · `/channels` | Settings › Connections and keys |
| `console:#/settings/pages` | Settings › Console pages (company panels and pages) |
| `console:#/settings/system` · `/health` · `/certification` · `/backups` · `/map` | Settings › System; `/map` is "Where did it go?" |
| `console:#/halt` · `console:#/halt?mode=soft` | stop the company |
| `console:#/p/<panel id>` | a company page |

### Old routes

| Old | Now |
|---|---|
| `#/comms/…` | `#/chat/…` |
| `#/controls` · `/gov` · `/guard` · `/ticks` · `/panels` | `#/settings/autonomy` · `/autonomy/presets` · `/autonomy/guardrails` · `/tempo/ticks` · `/pages` |
| `#/governance` | `#/settings/autonomy/gate` |
| `#/automate` | `#/settings/tempo/routines` |
| `#/usage` (`/usage/cutoffs`) | `#/spend` (`#/settings/models/cutoffs`) |
| `#/abilities/<tab>` | `#/settings/connections/<tab>` |
| `#/system` · `#/map` | `#/settings/system` · `#/settings/system/map` |
| `#/hiring` · `#/floor` | `#/crew/hiring` · `#/crew/floor` |
| `#/setup/<step>` once certified | company, charter, certify → `#/settings/company/<step>`; provider, budget → `#/settings/models/…`; governance, guardrails → `#/settings/autonomy/…` |

## Writing links well

- Link the place where the owner acts, not a file path: "[approve the hire](console:#/today)", not "company/pm-inbox.jsonl".
- One or two links per message. The link text says what the owner will do there.
- After writing or changing the charter: "[Review it in Setup](console:#/setup/charter)".
