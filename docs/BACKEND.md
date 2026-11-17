# The CaPheOS backend

**Status:** design, for approval. Nothing here is implemented.
**Replaces:** the StarNetOS sidecar as CaPheOS's runtime.
**Related:** `docs/CONSOLE-API.md` (the frozen frontend contract), `docs/FEATURES.md` (what we are *not* rebuilding),
`docs/MODULE-SYSTEM.md` (how tools and integrations are added), `docs/PORTING.md` (house rules for ported code).

---

## 1. Why this exists

CaPheOS is a business layer that currently borrows a game-shaped agent runtime. It reaches StarNet over HTTP
(`co.STATION_URL`, header `x-starnet-token`), keeps its agent state under `.starnet-data/workspaces/`, and borrows two
of StarNet's subsystems for business work:

- **quests** as the work model (`_station.quests.json`, `/api/quests*`);
- **cron routines** as the schedule (`/api/cron*`, 71 mentions across `company/tools/` and `console/`).

That borrowing is why the game vocabulary is in our business code, not only in StarNet's UI. Measured in this repo:

| Word | References | Where |
|---|---|---|
| `station` | 3,373 | tools, console, docs, roles, secrets (`station-token`) |
| `quest` | 1,687 | `inbox.js`, `console/server.js`, `hire.js`, `dispatch.js`, `quest-audit.js` … |
| `floor` / `desk` | 634 / 383 | dispatcher, floor-manager role, station floor plan |
| `commander` | 96 | an alias for the owner in approvals and inbox |
| `level` / `xp` | 334 / 108 | mostly governance levels; StarNet's XP elsewhere |

The backend we want is the same business system in business words, owned by us, with no second runtime to keep alive.

**One sentence:** the backend runs a seat's turn with the right tools and budget, routes what needs the owner, keeps the
record, and wakes whoever owns open work — in company terms, with no game layer and no second process to trust.

---

## 2. What the backend is measured to do today

The StarNet API surface CaPheOS actually calls (literal `/api/*` paths in `company/tools/` and `console/`):

| Family | Refs | What CaPheOS needs from it | Verdict |
|---|---|---|---|
| `/api/run`, `/api/observe` (SSE, replay, detach) | 8 + observer feed | start a seat's run; stream it; survive a console restart or browser reload | **keep, rewrite** — this is the core |
| `/api/cron*` (`cron`, `update`, `arm`, `run`, `remove`, `preview`, `history`) | 71 + 41 + 16 + 12 | schedule a seat's wake | **drop** — the dispatcher already exists and owns this |
| `/api/quests*` | 7 + 4 | work items with steps, artifact contracts, evidence, closure | **keep, renamed `task`** |
| `/api/save`, `/api/agent/personality`, `/api/roster` | 15 + 7 | seat identity and system prompt | **drop** — seats are files here (`loops.json`, roles) |
| `/api/providers*`, `/api/budget/status`, `/api/agent/model` | 13 + 8 + 7 | model access, keys, spend | **keep, rewrite** |
| `/api/questions*`, `/api/approvals/*` | 42 + 8 | owner questions, consent | **keep** — already CaPheOS's own model |
| `/api/service-keys`, `/api/setup/*` | 10 + 11 | connections and keys | **keep, rewrite** |
| floor, props, apps, channels, voice, browser, CUA, skill market, XP, trophies | — | nothing a business UI needs | **drop** |

State it keeps for us: `.starnet-data/workspaces/` — quests, roster, agent saves, run transcripts. All of it is replaced
by `company/state/` and `company/work/`, which is where the rest of CaPheOS already lives.

---

## 3. The shape

**One process.** The console server and the runtime are the same Node program: no proxy, no second port, no second
token, no `.starnet-data`. The console's existing 70 routes keep their paths; the runtime adds its own.

```
┌──────────────────────────── server (one process) ───────────────────────────┐
│ HTTP face: console API (frozen contract) · runtime API · SSE events          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Cordis composition — services, each one a plugin:                            │
│  company · seats · tasks · runs · models · tools · approvals · budget ·      │
│  schedule (the dispatcher) · transcripts · units                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Storage: company/state (state), company/work (work), per-run JSONL           │
└──────────────────────────────────────────────────────────────────────────────┘
```

Why one process: the current two-process design exists because StarNet is the agent runtime and the console is a thin
client of it. Once we own the runtime, the split buys nothing and costs a proxy, a token, a restart dance and two
sources of truth for "what is running". A run belongs to the backend, not to an HTTP connection — that is a property of
the code, not of a second process.

Cordis is the extension standard (§ `docs/MODULE-SYSTEM.md`): every service is a plugin, and every capability a
company adds (a tool, an integration, a seat) is a unit mounted into this composition. It is not the subject of the
backend — it is how the backend grows.

---

## 4. What the backend does

1. **Runs.** Start a seat's turn: its charter, function, skills, model policy, tool grants and budget. Stream events.
   Cancel. Re-attach after a console restart. Persist the transcript.
2. **Tools.** Expose the company's CLI tools and MCP servers to a run, with the capability and consent gates the
   company already enforces.
3. **Owner questions.** Any approval, refusal, spend hold or consent inside a run becomes an owner question on Today;
   the answer goes back into the run.
4. **Work.** Tasks with steps and evidence. A task closes on evidence, not on a click. The dispatcher wakes the seat
   that owns an open task, on a cadence — no cron API.
5. **Money.** Per-run usage rows, caps, holds, provider balances. No dollar figure is shown until a provider prices it.
6. **Providers.** Sign-in and API keys, model routing, subscriptions and prepaid balances.
7. **Record.** Transcripts, run journals, decisions, dispatch log — all in `company/`, all in business terms.

---

## 5. Vocabulary — the rename is part of the work

| Today | New | Note |
|---|---|---|
| station | **backend** / the runtime | no "station" in code, routes, docs or errors |
| `.starnet-data/` | `company/state/`, `company/work/` | one state tree |
| commander | **owner** | delete the alias in approvals/inbox |
| quest | **task** | keep the semantics: steps, evidence, closure on proof |
| quest step | **step** | |
| quest artifact / contract | **evidence** | what proves a step is done |
| floor, desk | **workspace** (or drop) | the floor plan is game UI; a seat has a working directory |
| XP, levels | **competence** | CaPheOS already measures competence; no numeric levels |
| battle pass, trophies | — | drop |
| roster | **seats** | already `loops.json` |
| save | **seat config** | already files |
| cron, routine | **schedule** | the dispatcher's cadence |
| station token | **none** (same process) or a backend token | |

Rule: no business document, tool, route, log line or error message uses a game word. A vocabulary lint over
`company/`, `console/`, `modules/` and the routes runs in CI, with an explicit allow-list for words like "level" that
are genuinely about governance.

---

## 6. The contract with the frontend

- **Frozen:** `docs/CONSOLE-API.md` keeps its paths and shapes. The frontend does not change for this rewrite.
- **New, under `/api/runtime/`:** start a run, attach to a run's stream, cancel, list running runs, list a seat's
  runs. These replace `/api/station/*` and the StarNet-specific chat proxy.
- **Runs are addressable and replayable:** every run writes a JSONL transcript plus a journal; the console re-attaches
  with the line count it already has. This is what `console/chat-runs.js` does today against StarNet's observer feed —
  the same guarantee, one implementation.
- **Tool results and approvals are structured**, not scraped from text: a run step is
  `{type: text|tool|approval|usage|end, ...}` and the console renders it.
- **Failure is explicit:** a provider refusal, a budget hold, a missing tool and a timeout each end the run with a
  distinct status the console already knows how to show.

---

## 7. Keep, port, rewrite, drop

| Disposition | What |
|---|---|
| **Keep as-is** | the console UI and its 70 routes; the company tools; the dispatcher; approvals; budgets; governance; meetings; commitments; intake; ledger; core modules; skills |
| **Port with attribution** | StarNet's provider adapters (`anthropic`, `openai-compatible`, `openrouter`, `gemini`, `ollama-native`, `claude-cli`, `codex`), the MCP client and transports, the streaming event vocabulary. MIT/BSD with `NOTICE`; no StarNet branding |
| **Rewrite** | the run loop (today it lives inside StarNet and CaPheOS only drives it); run/transcript storage; schedules (→ the dispatcher); seat identity (→ files) |
| **Rewrite small** | the chat run system (`console/chat-runs.js`) against our own runs instead of StarNet's observer feed |
| **Drop** | every game system (floor, props, XP, levels, trophies, battle pass, quests as a StarNet concept), the app builder, channels, voice, browser step-in, computer control, skill market, community maps, the station proxy, `lib/station.js`, `station-crew.js`, `station-view.js`, `.starnet-data` |

Quests are the one concept that is dropped as a *word* and kept as a *thing*: CaPheOS's dispatch, handoffs,
competence and evidence all depend on "a unit of work with steps that closes on proof". That is a task.

---

## 8. Migration, with an exit test per phase

| Phase | Work | Exit test |
|---|---|---|
| **P0** | Freeze the contract; write the run, task and transcript formats; add the vocabulary lint | lint fails on today's tree with a known list; the formats are reviewed |
| **P1** | The runtime runs one seat's turn with one tool and streams to the console; chat works with StarNet stopped | a chat message gets a streamed reply and a stored transcript, with `STATION_URL` dead |
| **P2** | Tasks replace quests in dispatch, inbox, hire and the console; `quest-audit` becomes `task-audit` | no business tool reads `_station.quests.json`; the console's work views read tasks |
| **P3** | Schedules become the dispatcher; delete the station proxy and the station tools | the dispatcher wakes seats with the station uninstalled |
| **P4** | Providers and spend reach parity; meetings run on the new runtime | a meeting and a routine both run; spend rows match the old ones |
| **P5** | Delete the last `.starnet-data` reference; uninstall StarNet | `grep -r starnet` is empty; `STATION_URL` is gone from the code |

During P1–P2 the old station remains available and the console can talk to either — a switch, not a fork. From P3 it
cannot come back.

---

## 9. Non-goals

We are not rebuilding StarNet. No app builder, no channels, no voice, no browser/computer control, no skill market, no
games, no second UI. Multi-tenant hosting is out of scope for v1. The unit standard is how new capabilities arrive, but
the backend must be useful with zero units installed.

---

## 10. Decisions for the owner

1. **One process or two?** Recommendation: one (console + runtime). The two-process split only existed because StarNet
   was a separate product.
2. **Is a task the old quest, or a thin layer over commitments?** Recommendation: a task is the work item (steps,
   evidence, closer). Commitments stay obligations (ack/due/escalate). A task may raise a commitment; a commitment may
   name the task that satisfies it.
3. **Provider adapters: vendor StarNet's, or write fresh?** Recommendation: vendor with attribution — they carry years
   of provider quirks, and they are the highest-value reuse in the whole backend.
4. **Names.** `server/` (the process), `runtime/` (the services and run loop), `company/` (business data and tools).
   Open to other names.
5. **How much of StarNet's tool suite do we port for runs?** Recommendation: shell, filesystem, web, MCP, skills,
   notebook. Not browser/computer control — that is game-adjacent surface we do not need yet.
